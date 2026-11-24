"""Tool-call hardening helpers for the LLMRouter proxy.

Pure, model-agnostic repairs applied to a weak model's tool-call output
after the upstream LLM responds and before opencode's schema validation sees
it. Restored from the legacy in-container router's ``tool_call_hardening.py``,
which was deleted together with ``model/llmrouter/`` in commit ``f1690e9b6``;
the ``common/tools.py`` home the redesign planned was never created at the
time (see ``docs/design/2026-06-25_llmrouter_manager_redesign.md`` section 3.1).

Layers, each a pure function (data in, data out):

* M1, hallucinated tool name: flag any ``function.name`` not in the catalog
  the caller sent in ``tools=[...]`` and build a structured retry message
  (``validate_tool_call_names``, ``invalid_tool_call_names``,messages_have_prior_tool
  ``format_tool_name_retry_message``).
* M3, no-tool-call recovery: when the model emits prose instead of a tool
  call, lift a text-embedded call or steer a retry, gated so genuine answers
  and clarifying questions pass through (``decide_no_tool_action`` + helpers).
* JSON arg repair: smart quotes, trailing commas, unbalanced brackets
  (``repair_json_args``, ``parse_or_repair_args``, ``normalise_tool_call_args``).
* Numeric coercion (#744): integer-valued floats / numeric strings, plus
  offset/limit clamping (``coerce_numeric_tool_args``).
* Arg value / key validation against the tool schema
  (``validate_tool_call_arg_values``, ``validate_tool_call_arg_keys``).

These are the pure helpers only. The wiring (buffer the non-streaming
response, choose which layers run per routing ``kind``, and re-dispatch
upstream under a bounded retry budget) lives in ``routing/proxy.py``;
streaming tool-name detection lives in the dispatch layer.
"""
from __future__ import annotations

import json
import logging
import os
import re
from collections.abc import Awaitable, Callable, Iterable
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any, AsyncIterator, Final

from llmrouter_manager.common.events import EventType, record_event

logger = logging.getLogger("llmrouter_manager.common.tools")


_SMART_QUOTE_MAP = str.maketrans(
    {
        "“": '"',
        "”": '"',
        "‘": "'",
        "’": "'",
        "„": '"',
        "‚": "'",
    }
)


# ───── Catalog extraction ──────────────────────────────────────────────────

def extract_catalog(tools: list | None) -> set[str]:
    """Pull the set of valid tool names out of an OpenAI-style ``tools``
    array. Missing / non-list / malformed entries are skipped silently;
    an empty catalog disables M1 (back to passthrough)."""
    if not isinstance(tools, list):
        return set()
    names: set[str] = set()
    for entry in tools:
        if not isinstance(entry, dict):
            continue
        fn = entry.get("function") or {}
        name = fn.get("name")
        if isinstance(name, str) and name:
            names.add(name)
    return names


# ───── M1 — Name validation ────────────────────────────────────────────────

# Tools the repeat lock removed from THIS request. A ContextVar, like the event context,
# because the repair layers are pure and the streaming path has no request in hand. It is
# set inside the request's own task, so it cannot leak into another request.
_repeat_locked_tools: ContextVar[frozenset[str]] = ContextVar(
    "repeat_locked_tools", default=frozenset()
)


def set_repeat_locked_tools(names: Iterable[str]) -> None:
    _repeat_locked_tools.set(frozenset(names))


def current_repeat_locked_tools() -> frozenset[str]:
    return _repeat_locked_tools.get()


def _repeat_lock_note(invalid: list[str], catalog: set[str]) -> str:
    locked = [n for n in invalid if n in _repeat_locked_tools.get()]
    if not locked:
        return ""
    names = ", ".join(repr(n) for n in locked)
    if "write" in locked:
        # The deliverable still has to reach disk, so say bash can produce it.
        steps = []
        if "bash" in catalog:
            steps.append(
                "Check which file the task asks you to produce, then write it with `bash` "
                "(a python script or a heredoc)."
            )
        if "edit" in catalog:
            steps.append("Use `edit` to change an existing file.")
        use = " ".join(steps) or "Continue with a different approach."
    elif "bash" in locked and "write" in catalog:
        use = (
            "Commands cannot run for the rest of this turn. If you already have the results, "
            "write the requested file directly with `write` instead of running a script."
        )
    else:
        use = "Continue with a different approach or tool from the available list."
    return (
        f" {names} was removed for the rest of this turn because the identical call was repeated, "
        f"not for the whole task; its earlier calls already ran, so retrying it cannot help. "
        f"{use} Reply in prose if the task is done."
    )


def _format_structured_error(invalid: list[str], catalog: set[str]) -> str:
    bad = ", ".join(repr(n) for n in invalid)
    good = ", ".join(repr(n) for n in sorted(catalog)) or "(none)"
    return (
        f"Tool call rejected: name(s) {bad} not in the catalog. "
        f"Available tools: [{good}]. "
        f"Reply with a tool call from this list, or with prose if no tool fits."
        f"{_repeat_lock_note(invalid, catalog)}"
    )


def validate_tool_call_names(choices: list, catalog: set[str]) -> dict:
    """Walk ``choices`` in place. For each ``message.tool_calls`` entry,
    drop the ones whose name is not in the catalog and append a
    structured error string. Empty catalog disables the check.

    Returns a stats dict for logging / metrics.
    """
    stats = {"invalid_names": [], "calls_dropped": 0, "calls_kept": 0, "choices_touched": 0}
    if not catalog or not choices:
        return stats

    for choice in choices:
        msg = choice.get("message") or {}
        tcs = msg.get("tool_calls") or []
        if not tcs:
            continue
        kept: list = []
        dropped_names: list[str] = []
        for tc in tcs:
            fn = tc.get("function") or {}
            name = fn.get("name")
            if isinstance(name, str) and name in catalog:
                kept.append(tc)
                stats["calls_kept"] += 1
            else:
                dropped_names.append(str(name))
                stats["calls_dropped"] += 1
        if dropped_names:
            stats["invalid_names"].extend(dropped_names)
            stats["choices_touched"] += 1
            existing_content = msg.get("content") or ""
            error_text = _format_structured_error(dropped_names, catalog)
            msg["content"] = (existing_content + "\n\n" + error_text).strip()
            msg["tool_calls"] = kept if kept else None
            if not kept:
                choice["finish_reason"] = "stop"
            logger.info(
                "[tool-call-hardening] M1 dropped %d hallucinated tool call(s): %s",
                len(dropped_names),
                dropped_names,
            )
    return stats


def invalid_tool_call_names(choices: list, catalog: set[str]) -> list[str]:
    """Return hallucinated tool names without mutating ``choices``.

    This is used by same-turn retry paths, where the router must detect an
    invalid tool call before the response is forwarded to OpenCode.
    """
    if not catalog or not choices:
        return []
    invalid: list[str] = []
    for choice in choices:
        msg = choice.get("message") or {}
        for tc in msg.get("tool_calls") or []:
            fn = tc.get("function") or {}
            name = fn.get("name")
            if not isinstance(name, str) or name not in catalog:
                invalid.append(str(name))
    return invalid


def format_tool_name_retry_message(invalid: list[str], catalog: set[str]) -> str:
    """Build the correction prompt used for same-turn invalid-name retry."""
    message = _format_structured_error(invalid, catalog)
    lowered = {name.lower() for name in invalid}
    if {"websearch", "websearch-agent"} & lowered and "task" in catalog:
        message += (
            "\n\nIf the intended action is web search, do not call `websearch` "
            "or `websearch-agent` directly. Retry by calling the `task` tool "
            "with `subagent_type` set to `websearch-agent`, plus a short "
            "`description` and a self-contained `prompt`."
        )
    return message


def should_force_task_for_websearch_retry(invalid: list[str], catalog: set[str]) -> bool:
    lowered = {name.lower() for name in invalid}
    return bool("task" in catalog and ({"websearch", "websearch-agent"} & lowered))


# ───── M3 — no-tool-call recovery (NOTOOL) ─────────────────────────────────
#
# When the model returns ZERO tool calls but the request needed one, it shows
# up two ways (observed on weak + production models):
#   Type B: the model wrote a tool call as TEXT in the content, e.g.
#           `function=websearch-agent>{"query": ...}` / `功能=skill name=...>{...}`.
#           -> M3a lifts it into a real structured tool_call; the existing M1/#990
#              name validation then runs on the lifted call.
#   Type A: the model refused / described / answered from memory, no call at all.
#           -> M3b asks the chat loop to retry once with a steering message.
#
# greeting / ambiguous never reach here: a separate intent classifier
# (services/intent_classifier, gated at the UI) short-circuits them before the
# agent ever runs. So a first-turn no-tool response on a tool-using agent is a
# genuine NOTOOL bug, not small-talk.

# Matches `function=NAME` or Chinese `功能=NAME`, optionally wrapped in `<...>`,
# with optional trailing attributes (e.g. skill `name="pdf"`) up to `>`.
_TEXTUAL_TOOLCALL_RE = re.compile(
    r"(?:<\s*)?(?:function|功能)\s*=\s*([A-Za-z0-9_\-]+)[^>\n]*>",
    re.IGNORECASE,
)

# Web-search aliases the model may emit that are not real tools but are handled
# by the #990 steer-to-task path once lifted.
_KNOWN_TOOLISH = {"websearch", "websearch-agent", "task"}


def _first_json_object(s: str) -> str | None:
    """Return the first balanced ``{...}`` substring of ``s`` that json-parses,
    else None. Used to recover the args of a text-emitted tool call."""
    start = s.find("{")
    while start != -1:
        depth = 0
        in_str = False
        esc = False
        for i in range(start, len(s)):
            c = s[i]
            if in_str:
                if esc:
                    esc = False
                elif c == "\\":
                    esc = True
                elif c == '"':
                    in_str = False
            elif c == '"':
                in_str = True
            elif c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    cand = s[start : i + 1]
                    try:
                        json.loads(cand)
                        return cand
                    except Exception:
                        break  # try next '{'
        start = s.find("{", start + 1)
    return None


def extract_textual_tool_call(content: str, catalog: set[str]) -> dict | None:
    """M3a: detect a tool call the model emitted as plain TEXT in ``content``
    and lift it into a structured tool_call dict, else None.

    Conservative: requires (1) a ``function=NAME`` / ``功能=NAME`` marker,
    (2) a name that is in the catalog or a known web-search alias, and (3) a
    parseable JSON arg object after the marker. This keeps prose that merely
    mentions ``function=...`` from being misread as a call.
    """
    if not content or ("function=" not in content and "功能=" not in content):
        return None
    m = _TEXTUAL_TOOLCALL_RE.search(content)
    if not m:
        return None
    name = m.group(1)
    if name not in (set(catalog or ()) | _KNOWN_TOOLISH):
        return None
    args_str = _first_json_object(content[m.end():])
    if args_str is None:
        return None
    return {"id": "", "type": "function",
            "function": {"name": name, "arguments": args_str}}


def messages_have_prior_tool(messages: list | None) -> bool:
    """M3 gate: has any tool already run in this conversation? If so, a no-tool
    assistant response is a legitimate final answer — M3 must NOT fire."""
    for m in messages or []:
        if not isinstance(m, dict):
            continue
        if m.get("role") == "tool":
            return True
        if m.get("role") == "assistant" and m.get("tool_calls"):
            return True
    return False


_CLARIFY_HINTS = (
    "could you clarify", "can you clarify", "please clarify", "which one",
    "do you mean", "what do you mean", "请问", "您是指", "你是指", "需要我帮你",
)


def looks_like_clarifying_question(content: str) -> bool:
    """M3 gate: the model asked the user a clarifying question. Leave it alone
    (a safety net in case an ambiguous request slipped past the upstream gate)."""
    if not content:
        return False
    low = content.lower()
    if any(h in low for h in _CLARIFY_HINTS):
        return True
    stripped = content.strip()
    return len(stripped) < 200 and (stripped.endswith("?") or stripped.endswith("？"))


_DEFLECTION_HINTS = (
    "i don't have access", "i do not have access", "don't have access to",
    "do not have access to", "i can't", "i cannot", "i can not", "i'm unable",
    "i am unable", "i'm not able", "i am not able", "no access to", "real-time",
    "real time", "you can check", "you could check", "you should check",
    "you can look", "you may want to", "i don't have the ability",
    "i don't have real-time", "as an ai", "i'm just an ai", "unable to retrieve",
    "unable to access", "cannot browse", "can't browse", "don't have the capability",
    "没有实时", "无法获取", "无法访问", "我不能", "我无法", "你可以查", "你可以去",
    "建议你", "我没有权限", "没有联网", "无法联网", "请自行",
)


def looks_like_tool_deflection(content: str) -> bool:
    """M3b gate: does the no-tool prose look like the model SHOULD have used a
    tool but deflected/refused (e.g. "I don't have access to real-time data,
    you can check a website")? Only such responses are NOTOOL bugs worth a
    retry. A plain knowledge answer ("2+2 = 4", "Paris") has none of these, so
    M3b leaves it alone — this is the precision gate that stops M3 from forcing
    a tool on simple questions (误伤)."""
    if not content:
        return False
    low = content.lower()
    return any(h in low for h in _DEFLECTION_HINTS)


def format_notool_retry_message(catalog: set[str]) -> str:
    """M3b steering: the model produced no tool call when one was needed."""
    return (
        "You did not call any tool, but this request requires one. Do not answer "
        "from memory, do not refuse, and do not tell the user to do it themselves. "
        "Call the appropriate tool now. For web search, email, or a local file, "
        "delegate by calling the `task` tool with the matching `subagent_type` "
        "(`websearch-agent`, `email-agent`, or `local-file-agent`), plus a short "
        "`description` and a self-contained `prompt`."
    )


def decide_no_tool_action(content: str, tool_calls: list | None,
                          messages: list | None, catalog: set[str],
                          requesting_agent: str | None = None) -> tuple[str, Any]:
    """M3 dispatcher for a response with no structured tool_calls. Returns:
      ("lift", tool_call)   — Type B: a text-emitted call was recovered; caller
                              lifts it (then runs M1/#990 name validation on it).
      ("retry", message)    — Type A: retry once with the steering message.
      ("pass", None)        — leave as-is (has tool calls / no tools / later turn
                              / clarification).
    
    ``requesting_agent`` enables agent-specific M3 behavior. The
    protected-file-agent workflow requires multiple sequential tool calls
    (pipeline → task(build)), so a no-tool response even after a prior tool is
    suspicious and warrants a retry rather than accepting it as a final answer.
    """
    if tool_calls:
        return ("pass", None)
    if not catalog:
        return ("pass", None)
    lifted = extract_textual_tool_call(content or "", catalog)
    if lifted is not None:
        return ("lift", lifted)
    
    # Agent-specific M3: protected-file-agent workflow requires multiple tools
    # in sequence (run_protected_file_pipeline → task(build) → present result).
    # Any no-tool response in this workflow is wrong, even after prior tools.
    if requesting_agent == "protected-file-agent":
        # Unconditionally retry - the agent should ALWAYS be calling tools
        # until the build delegation completes. The terminal guard enforces
        # when the session is truly done.
        logger.info(
            "[tool-call-hardening] M3 protected-file-agent: unconditional retry "
            "(multi-tool workflow requires task delegation after pipeline)"
        )
        return ("retry", format_notool_retry_message(catalog))
    
    # Standard M3 gate for other agents: if a tool already ran, a prose
    # response is likely a legitimate final answer.
    if messages_have_prior_tool(messages):
        return ("pass", None)
    if looks_like_clarifying_question(content or ""):
        return ("pass", None)
    # Precision gate (误伤 fix): only retry when the prose looks like a
    # tool-deflection/refusal. A plain knowledge answer is left untouched so M3
    # doesn't force a tool on "what is 2+2?".
    if not looks_like_tool_deflection(content or ""):
        return ("pass", None)
    return ("retry", format_notool_retry_message(catalog))


# ───── M2 — JSON-arg lenient repair (in-place) ─────────────────────────────

def _coerce_smart_quotes(s: str) -> str:
    return s.translate(_SMART_QUOTE_MAP)


def _strip_trailing_commas(s: str) -> str:
    return re.sub(r",\s*([}\]])", r"\1", s)


def _try_close_brackets(s: str) -> str | None:
    """Best-effort: if the string is short by closing brackets, append
    them. Returns the patched string or None if no patch attempted."""
    open_curly = s.count("{")
    close_curly = s.count("}")
    open_square = s.count("[")
    close_square = s.count("]")
    if open_curly == close_curly and open_square == close_square:
        return None
    patched = s
    if patched.rstrip().endswith(","):
        patched = patched.rstrip().rstrip(",")
    if open_square > close_square:
        # Strip any trailing partial string (unterminated "..." at the end).
        patched = re.sub(r',\s*"[^"]*$', "", patched)
        patched += "]" * (open_square - close_square)
    if open_curly > close_curly:
        patched += "}" * (open_curly - close_curly)
    return patched


def repair_json_args(raw: str) -> tuple[str, bool]:
    """Return ``(repaired, repaired_changed)``. Apply smart-quote
    normalisation, trailing-comma removal, and best-effort bracket
    completion. Validation is the caller's responsibility — this only
    cleans common shapes."""
    if not isinstance(raw, str) or not raw:
        return raw, False
    repaired = raw
    if any(ch in repaired for ch in "“”‘’„‚"):
        repaired = _coerce_smart_quotes(repaired)
    if "," in repaired:
        repaired = _strip_trailing_commas(repaired)
    patched = _try_close_brackets(repaired)
    if patched is not None:
        repaired = patched
    return repaired, repaired != raw


def parse_or_repair_args(raw: str) -> tuple[Any, bool, str | None]:
    """Try ``json.loads`` on raw. On failure, run :func:`repair_json_args`
    and try again. Returns ``(parsed_or_None, was_repaired, error_or_None)``."""
    if not isinstance(raw, str):
        return None, False, "arguments not a string"
    try:
        return json.loads(raw), False, None
    except json.JSONDecodeError:
        pass
    repaired, changed = repair_json_args(raw)
    if not changed:
        return None, False, "arguments not parseable, no repair applied"
    try:
        return json.loads(repaired), True, None
    except json.JSONDecodeError as exc:
        return None, True, f"arguments still not parseable after repair: {exc}"


def normalise_tool_call_args(choices: list) -> dict:
    """Walk choices in place; for each tool call, attempt to parse the
    arguments string. If repair was needed, write the repaired string
    back. If unrepairable, drop the tool call and append a structured
    error.

    Returns stats for logging.
    """
    stats = {"repaired": 0, "unrepairable": 0, "calls_dropped": 0, "calls_kept": 0}
    if not choices:
        return stats
    for choice in choices:
        msg = choice.get("message") or {}
        tcs = msg.get("tool_calls") or []
        if not tcs:
            continue
        # An output-cap stop means the arguments are truncated, not malformed —
        # a distinction the model cannot make from a generic parse error, so the
        # note below has to spell it out and point at a different strategy.
        hit_output_cap = choice.get("finish_reason") == "length"
        kept = []
        unrepairable: list[str] = []
        for tc in tcs:
            fn = tc.get("function") or {}
            raw = fn.get("arguments")
            name = fn.get("name") or "(unknown)"
            parsed, was_repaired, err = parse_or_repair_args(raw)
            if parsed is None:
                stats["unrepairable"] += 1
                stats["calls_dropped"] += 1
                unrepairable.append(name)
                continue
            if was_repaired:
                fn["arguments"] = json.dumps(parsed)
                stats["repaired"] += 1
            kept.append(tc)
            stats["calls_kept"] += 1
        if unrepairable:
            existing = msg.get("content") or ""
            if hit_output_cap:
                note = (
                    f"Your output hit the max output-token limit before the "
                    f"arguments to {unrepairable} were complete — they were "
                    f"truncated, not malformed, and could not be recovered. Do NOT "
                    f"retry the same call: it will be cut off again. Produce the "
                    f"content in smaller steps instead (write a first part, then "
                    f"append the rest with bash `cat >> <file> <<'EOF' ... EOF`)."
                )
            else:
                note = (
                    f"Tool call rejected: arguments not parseable as JSON "
                    f"for tool(s) {unrepairable}. Reply with valid JSON arguments."
                )
            msg["content"] = (existing + "\n\n" + note).strip()
            msg["tool_calls"] = kept if kept else None
            # Only claim a clean stop when the model actually finished. Keeping
            # "length" lets the caller (and any retry logic) see that the turn
            # was cut short rather than completed.
            if not kept and not hit_output_cap:
                choice["finish_reason"] = "stop"
            logger.info(
                "[tool-call-hardening] M2 dropped %d unrepairable tool call(s): %s "
                "(output_cap_hit=%s)",
                len(unrepairable),
                unrepairable,
                hit_output_cap,
            )
            # A dropped call is a tool invocation that never happened. The turn
            # continues and scores as a degradation, not a failure — precisely
            # the silent class §3.3 of the design says is unexplainable today.
            # Reached from BOTH hardening paths (non-streaming via
            # repair_nonstreaming_result_in_place, streaming via
            # harden_streaming_tool_calls), so no `stream` attr is claimed here.
            # Correlation ids come from the per-request contextvar the proxy set.
            for tool_name in unrepairable:
                record_event(
                    EventType.TOOL_ERROR,
                    attrs={
                        "tool": tool_name,
                        "stage": "M2",
                        "reason": "output_cap_truncated"
                        if hit_output_cap
                        else "unrepairable_arguments",
                        "calls_dropped": len(unrepairable),
                        "calls_kept": len(kept),
                    },
                )
    return stats


# ───── M6 — numeric arg coercion (in-place) ───────────────────────────────
# M1/M2/M4/M5 are defined in PR #790. M3 is intentionally reserved (optional,
# unimplemented) for the "model should call a tool but instead emits prose /
# a clarifying question / a refusal" case — it overlaps the intent classifier's
# greeting / ambiguous-question handling, is hard to disambiguate, and is low
# frequency. Numeric coercion is unrelated, so it takes the next free number M6.
# See #744.

# Args that are conventionally 1-indexed / positive integers but whose schema
# may declare them as plain ``number`` with no ``minimum`` (e.g. opencode's
# ``read`` offset/limit). Clamp these to >= 1 when the schema omits a minimum.
# See #744.
_DEFAULT_MIN_ONE_ARGS = {"offset", "limit"}


def coerce_numeric_tool_args(choices: list, arg_schemas: dict) -> dict:
    """Walk ``choices`` in place. For tool-call args the schema types as
    ``number``/``integer``: coerce integer-valued floats and numeric strings to
    ``int`` (e.g. ``715.0`` / ``"715"`` -> ``715``), and clamp values below the
    arg's minimum (schema ``minimum``, or 1 for known pagination args such as
    ``offset``/``limit`` whose schema omits it).

    Must run AFTER ``normalise_tool_call_args`` (arguments must already be
    parseable JSON). Only numeric-typed args are touched, so genuine fractional
    values (e.g. a ``number`` threshold of 0.7) are left alone. See #744.
    """
    stats = {"coerced": 0}
    if not choices or not arg_schemas:
        return stats
    for choice in choices:
        msg = choice.get("message") or {}
        for tc in (msg.get("tool_calls") or []):
            fn = tc.get("function") or {}
            name = fn.get("name")
            props = ((arg_schemas.get(name) or {}).get("properties")) or {}
            if not props:
                continue
            raw = fn.get("arguments")
            try:
                args = json.loads(raw) if isinstance(raw, str) else None
            except (json.JSONDecodeError, TypeError):
                args = None
            if not isinstance(args, dict):
                continue
            changed = False
            for k, v in list(args.items()):
                spec = props.get(k)
                if not isinstance(spec, dict) or spec.get("type") not in ("number", "integer"):
                    continue
                if isinstance(v, bool):
                    continue
                nv = v
                if isinstance(nv, str):
                    try:
                        nv = float(nv.strip())
                    except (ValueError, AttributeError):
                        continue
                if isinstance(nv, float) and nv.is_integer():
                    nv = int(nv)
                if isinstance(nv, (int, float)):
                    mn = spec.get("minimum")
                    if mn is None and k in _DEFAULT_MIN_ONE_ARGS:
                        mn = 1
                    if isinstance(mn, (int, float)) and not isinstance(mn, bool) and nv < mn:
                        nv = int(mn) if float(mn).is_integer() else mn
                if nv != v or type(nv) is not type(v):
                    args[k] = nv
                    changed = True
            if changed:
                fn["arguments"] = json.dumps(args)
                stats["coerced"] += 1
                logger.info("[tool-call-hardening] M6 coerced numeric args for tool %r", name)
    return stats


# ───── M4 — Arg-value constraint validation ────────────────────────────────


def extract_arg_constraints_from_tools(tools: list | None) -> dict:
    """Walk the caller's ``tools=[...]`` and pull out per-field ``enum``
    constraints. Returns ``{tool_name: {arg_name: {"enum": [...]}}}``.

    Only ``enum`` is extracted in this iteration — other JSON Schema
    constraints (``pattern``, ``minimum``, etc.) are not validated.
    """
    result: dict[str, dict[str, dict]] = {}
    if not isinstance(tools, list):
        return result
    for entry in tools:
        if not isinstance(entry, dict):
            continue
        fn = entry.get("function") or {}
        name = fn.get("name")
        if not isinstance(name, str) or not name:
            continue
        params = fn.get("parameters") or {}
        props = params.get("properties") or {}
        per_tool: dict[str, dict] = {}
        for arg_name, spec in props.items():
            if isinstance(spec, dict):
                enum = spec.get("enum")
                if isinstance(enum, list) and enum:
                    per_tool[arg_name] = {"enum": list(enum)}
        if per_tool:
            result[name] = per_tool
    return result


def merge_arg_constraints(from_schema: dict, from_extra_body: Any) -> dict:
    """Caller-supplied constraints (via ``extra_body.hardening.arg_constraints``)
    overlay schema-extracted constraints. Per ``(tool, arg)`` the
    extra_body value wins.

    Accepted shapes:
      * ``{tool: {arg: [v1, v2, ...]}}`` (list shorthand for an enum)
      * ``{tool: {arg: {"enum": [...]}}}`` (long-form)
    """
    result: dict[str, dict[str, dict]] = {
        t: {a: dict(s) for a, s in by_arg.items()} for t, by_arg in from_schema.items()
    }
    if not isinstance(from_extra_body, dict):
        return result
    for tool, args in from_extra_body.items():
        if not isinstance(args, dict):
            continue
        result.setdefault(tool, {})
        for arg, spec in args.items():
            if isinstance(spec, list):
                result[tool][arg] = {"enum": list(spec)}
            elif isinstance(spec, dict):
                if "enum" in spec and isinstance(spec["enum"], list):
                    result[tool][arg] = {"enum": list(spec["enum"])}
    return result


def get_arg_constraints(extra_body: dict | None) -> dict:
    if not isinstance(extra_body, dict):
        return {}
    h = extra_body.get("hardening")
    if not isinstance(h, dict):
        return {}
    out = h.get("arg_constraints")
    return out if isinstance(out, dict) else {}


def _format_value_error(violations: list[dict]) -> str:
    lines = []
    for v in violations:
        good = ", ".join(repr(x) for x in v["enum"]) or "(none)"
        lines.append(
            f"Tool call rejected: tool {v['tool']!r} argument {v['arg']!r} "
            f"value {v['value']!r} not in allowed set [{good}]."
        )
        # #1876: a bare rejection gives a weak model nothing to correct with —
        # it re-emits the identical call and then gives up. Mirror the
        # invalid-name hint (format_tool_name_retry_message): say what to do
        # instead of only what went wrong.
        if v["tool"] == "task" and v["arg"] == "subagent_type":
            if str(v["value"]).lower() in ("websearch-agent", "websearch"):
                lines.append(
                    "Do not retry the same value. For web search in this "
                    "session, call the `sc_search_web` tool directly instead "
                    "of delegating via `task`. Otherwise pick a "
                    "`subagent_type` from the allowed set above."
                )
            else:
                lines.append(
                    "Do not retry the same value. Pick a `subagent_type` "
                    "from the allowed set above and re-emit the task call."
                )
    return "\n".join(lines)


def detect_task_subagent_violations(choices: list, constraints: dict) -> list[dict]:
    """Detection-only pass (#1876): find ``task(subagent_type=...)`` calls whose
    value violates the enum constraint. Unlike ``validate_tool_call_arg_values``
    this does NOT mutate choices — the caller retries the turn with a hint
    instead of dropping the call."""
    spec = (constraints.get("task") or {}).get("subagent_type") or {}
    enum = spec.get("enum")
    if not isinstance(enum, list) or not enum:
        return []
    out: list[dict] = []
    for choice in choices or []:
        msg = choice.get("message") or {}
        for tc in msg.get("tool_calls") or []:
            fn = tc.get("function") or {}
            if fn.get("name") != "task":
                continue
            raw = fn.get("arguments")
            try:
                args = json.loads(raw) if isinstance(raw, str) else None
            except json.JSONDecodeError:
                continue  # unparseable args are M2/B-stage territory
            if (isinstance(args, dict) and "subagent_type" in args
                    and args["subagent_type"] not in enum):
                out.append({"tool": "task", "arg": "subagent_type",
                            "value": args["subagent_type"], "enum": list(enum)})
    return out


def rewrite_unavailable_websearch_task_calls(choices: list, tools: list | None) -> int:
    """Rewrite unavailable web-search delegation to the direct search tool (#1876).

    The live ``task.subagent_type`` enum is the capability authority. A
    ``task(subagent_type="websearch-agent", prompt=...)`` call is converted to
    ``sc_search_web(query=...)`` in place ONLY when that non-empty enum excludes
    the agent and the same request actually exposes ``sc_search_web``. Missing
    schema evidence, an available agent, or an unusable prompt is a no-op.

    This is a deterministic, in-place repair — same class as M4 (no re-dispatch,
    no whole-response buffering), so it is safe on the streaming path and does
    not touch time-to-first-token. Preserves each call's id/type. Returns the
    number rewritten.
    """
    catalog = extract_catalog(tools)
    if "sc_search_web" not in catalog:
        return 0
    constraints = extract_arg_constraints_from_tools(tools)
    enum = ((constraints.get("task") or {}).get("subagent_type") or {}).get("enum")
    if not isinstance(enum, list) or not enum or "websearch-agent" in enum:
        return 0
    rewritten = 0
    for choice in choices or []:
        msg = choice.get("message") or {}
        for tc in msg.get("tool_calls") or []:
            fn = tc.get("function") or {}
            if fn.get("name") != "task":
                continue
            raw = fn.get("arguments")
            try:
                args = json.loads(raw) if isinstance(raw, str) else None
            except json.JSONDecodeError:
                continue
            if not isinstance(args, dict) or args.get("subagent_type") != "websearch-agent":
                continue
            prompt = args.get("prompt")
            if not isinstance(prompt, str) or not prompt.strip():
                continue
            fn["name"] = "sc_search_web"
            fn["arguments"] = json.dumps({"query": prompt})
            rewritten += 1
    if rewritten:
        logger.info(
            "[tool-call-hardening] rewrote %d unavailable websearch-agent "
            "delegation(s) to sc_search_web",
            rewritten,
        )
    return rewritten


def _subagent_value_retry(violations: list[dict], catalog: set[str]) -> tuple[str, dict | None]:
    """(message, forced tool_choice) for a task-subagent enum retry (#1876).
    The message reuses the B-stage error + hint; web-search intent on a grade
    without websearch-agent is steered to ``sc_search_web`` when that tool
    exists in the catalog."""
    message = _format_value_error(violations) + (
        "\n\nRe-emit the corrected tool call now."
    )
    wants_web = any(str(v["value"]).lower() in ("websearch-agent", "websearch")
                    for v in violations)
    force = (
        {"type": "function", "function": {"name": "sc_search_web"}}
        if wants_web and "sc_search_web" in catalog else None
    )
    return message, force


def validate_tool_call_arg_values(choices: list, constraints: dict) -> dict:
    """Walk choices in place. For each tool call whose name has
    constraints, parse args (must already be JSON-clean post-M2) and
    check each constrained arg against its enum. Drop calls that violate;
    append a structured error.
    """
    stats = {"calls_dropped": 0, "calls_kept": 0, "violations": []}
    if not constraints or not choices:
        return stats
    for choice in choices:
        msg = choice.get("message") or {}
        tcs = msg.get("tool_calls") or []
        if not tcs:
            continue
        kept = []
        per_choice_violations: list[dict] = []
        for tc in tcs:
            fn = tc.get("function") or {}
            name = fn.get("name")
            tool_constraints = constraints.get(name) or {}
            if not tool_constraints:
                kept.append(tc)
                stats["calls_kept"] += 1
                continue
            raw = fn.get("arguments")
            try:
                args = json.loads(raw) if isinstance(raw, str) else None
            except json.JSONDecodeError:
                args = None
            if not isinstance(args, dict):
                # Args not parseable after M2 ran — drop defensively.
                stats["calls_dropped"] += 1
                per_choice_violations.append(
                    {"tool": name, "arg": "(args)", "value": raw, "enum": []}
                )
                continue
            bad = None
            for arg_name, arg_spec in tool_constraints.items():
                enum = arg_spec.get("enum")
                if not isinstance(enum, list) or arg_name not in args:
                    continue
                if args[arg_name] not in enum:
                    bad = {
                        "tool": name,
                        "arg": arg_name,
                        "value": args[arg_name],
                        "enum": list(enum),
                    }
                    break
            if bad is None:
                kept.append(tc)
                stats["calls_kept"] += 1
            else:
                stats["calls_dropped"] += 1
                stats["violations"].append(bad)
                per_choice_violations.append(bad)
        if per_choice_violations:
            existing = msg.get("content") or ""
            note = _format_value_error(per_choice_violations)
            msg["content"] = (existing + "\n\n" + note).strip()
            msg["tool_calls"] = kept if kept else None
            if not kept:
                choice["finish_reason"] = "stop"
            logger.info(
                "[tool-call-hardening] M4 dropped %d tool call(s) with bad arg values",
                len(per_choice_violations),
            )
    return stats


# ───── M5 — Arg-key existence validation ───────────────────────────────────


def extract_arg_schemas_from_tools(tools: list | None) -> dict:
    """Pull ``{tool_name: {"properties": {...}, "required": [...]}}`` from
    the ``tools=[...]`` catalog so M5 can check argument-key presence
    against the declared schema. Missing fields are tolerated silently;
    callers that did not specify ``properties`` or ``required`` simply
    opt out of M5 for that tool.
    """
    result: dict[str, dict] = {}
    if not isinstance(tools, list):
        return result
    for entry in tools:
        if not isinstance(entry, dict):
            continue
        fn = entry.get("function") or {}
        name = fn.get("name")
        if not isinstance(name, str) or not name:
            continue
        params = fn.get("parameters") or {}
        if not isinstance(params, dict):
            continue
        props = params.get("properties") or {}
        required = params.get("required") or []
        if not isinstance(props, dict):
            continue
        req_list = [k for k in required if isinstance(k, str)]
        # Skip tools whose schema declares neither a property list nor a
        # required list — M5 has nothing to validate against and forcing
        # "no args allowed" on every tool that omits both fields would
        # reject every call out of an abundance of caution.
        if not props and not req_list:
            continue
        result[name] = {"properties": dict(props), "required": req_list}
    return result


def _format_key_error(violations: list[dict]) -> str:
    lines: list[str] = []
    for v in violations:
        parts = [f"Tool call rejected: tool {v['tool']!r} argument keys do not match schema."]
        if v["missing"]:
            missing = ", ".join(repr(k) for k in v["missing"])
            parts.append(f"Missing required key(s): [{missing}].")
        if v["unknown"]:
            unknown = ", ".join(repr(k) for k in v["unknown"])
            parts.append(f"Unexpected key(s): [{unknown}].")
        if v["missing"] and v["unknown"]:
            parts.append(
                "Check the spelling / casing — the schema uses one specific style "
                "and the call must match it exactly."
            )
        wrapper = next((k for k in v["unknown"] if k in _ARG_WRAPPER_KEYS), None)
        if v["missing"] and wrapper:
            keys = ", ".join(repr(k) for k in v["missing"])
            parts.append(f"Pass the required key(s) directly, not inside {wrapper!r}: {keys}.")
        lines.append(" ".join(parts))
    return "\n".join(lines)


# Wrapper names a weak model nests the real arguments under, e.g. {"arguments": "ls"} for bash.
_ARG_WRAPPER_KEYS = ("arguments", "args", "input", "parameters", "params")


def _unwrap_wrapped_args(args: dict, schema: dict) -> dict | None:
    """Return args rebuilt from a wrapper key, but only if the result fits the schema exactly."""
    props = set(schema["properties"])
    required = set(schema["required"])

    def fits(candidate: dict) -> bool:
        return required <= set(candidate) and set(candidate) <= props

    for key in _ARG_WRAPPER_KEYS:
        if key in props or key not in args:
            continue
        inner = args[key]
        rest = {k: v for k, v in args.items() if k != key}
        if isinstance(inner, str):
            try:
                parsed = json.loads(inner)
            except (ValueError, TypeError):
                parsed = None
            if isinstance(parsed, dict):
                inner = parsed
        if isinstance(inner, dict):
            candidate = {**rest, **inner}
        elif isinstance(inner, str) and inner.strip() and len(required) == 1:
            (only,) = required
            if schema["properties"].get(only, {}).get("type") != "string" or only in rest:
                continue
            candidate = {**rest, only: inner}
        else:
            continue
        if fits(candidate):
            return candidate
    return None


def _arg_shape(args: dict) -> dict[str, str]:
    """Key -> type and length only; values can hold user data and are never logged."""
    return {
        k: f"{type(v).__name__}({len(v)})" if isinstance(v, (str, list, dict)) else type(v).__name__
        for k, v in args.items()
    }


def validate_tool_call_arg_keys(choices: list, arg_schemas: dict) -> dict:
    """Walk choices in place. For each tool call whose name has a known
    schema, parse args (must already be JSON-clean post-M2) and check
    every required key is present and no unknown key appears. Drop calls
    that fail; append a structured error.
    """
    stats = {"calls_dropped": 0, "calls_kept": 0, "calls_repaired": 0, "violations": []}
    if not arg_schemas or not choices:
        return stats
    for choice in choices:
        msg = choice.get("message") or {}
        tcs = msg.get("tool_calls") or []
        if not tcs:
            continue
        kept: list = []
        per_choice_violations: list[dict] = []
        for tc in tcs:
            fn = tc.get("function") or {}
            name = fn.get("name")
            schema = arg_schemas.get(name)
            if not schema:
                kept.append(tc)
                stats["calls_kept"] += 1
                continue
            raw = fn.get("arguments")
            try:
                args = json.loads(raw) if isinstance(raw, str) else None
            except json.JSONDecodeError:
                args = None
            if not isinstance(args, dict):
                stats["calls_dropped"] += 1
                per_choice_violations.append(
                    {"tool": name, "missing": list(schema["required"]), "unknown": []}
                )
                continue
            expected_keys = set(schema["properties"].keys())
            required_keys = set(schema["required"])
            actual_keys = set(args.keys())
            missing = sorted(required_keys - actual_keys)
            unknown = sorted(actual_keys - expected_keys)
            if missing or unknown:
                repaired = _unwrap_wrapped_args(args, schema)
                if repaired is not None:
                    fn["arguments"] = json.dumps(repaired, ensure_ascii=False)
                    kept.append(tc)
                    stats["calls_kept"] += 1
                    stats["calls_repaired"] += 1
                    logger.info(
                        "[tool-call-hardening] M5 repaired %s: unwrapped %s into schema keys %s",
                        name, _arg_shape(args), sorted(repaired),
                    )
                    continue
                stats["calls_dropped"] += 1
                violation = {"tool": name, "missing": missing, "unknown": unknown}
                stats["violations"].append(violation)
                per_choice_violations.append(violation)
                logger.info(
                    "[tool-call-hardening] M5 rejected %s: received %s, schema keys %s, required %s",
                    name, _arg_shape(args), sorted(expected_keys), sorted(required_keys),
                )
            else:
                kept.append(tc)
                stats["calls_kept"] += 1
        if per_choice_violations:
            existing = msg.get("content") or ""
            note = _format_key_error(per_choice_violations)
            msg["content"] = (existing + "\n\n" + note).strip()
            msg["tool_calls"] = kept if kept else None
            if not kept:
                choice["finish_reason"] = "stop"
            logger.info(
                "[tool-call-hardening] M5 dropped %d tool call(s) with arg-key mismatch",
                len(per_choice_violations),
            )
    return stats


def detect_arg_key_violations(choices: list, arg_schemas: dict) -> list[dict]:
    """Read-only M5: the calls ``validate_tool_call_arg_keys`` would drop and the wrapper repair cannot save.

    Output-cap cuts (``finish_reason == "length"``) are skipped: a retry would be cut off again.
    """
    found: list[dict] = []
    for choice in choices or []:
        if choice.get("finish_reason") == "length":
            continue
        for tc in (choice.get("message") or {}).get("tool_calls") or []:
            fn = tc.get("function") or {}
            name = fn.get("name")
            schema = arg_schemas.get(name)
            if not schema:
                continue
            args, _, _ = parse_or_repair_args(fn.get("arguments"))
            if not isinstance(args, dict):
                missing, unknown, received = list(schema["required"]), [], None
            else:
                missing = sorted(set(schema["required"]) - set(args))
                unknown = sorted(set(args) - set(schema["properties"]))
                if not (missing or unknown) or _unwrap_wrapped_args(args, schema) is not None:
                    continue
                received = sorted(args)
            found.append({
                "tool": name, "missing": missing, "unknown": unknown,
                "received": received, "allowed": sorted(schema["properties"]),
            })
    return found


def format_arg_key_retry_message(violations: list[dict]) -> str:
    """Correction appended to the request when a call is re-requested after an M5 violation."""
    lines: list[str] = []
    for v in violations:
        required = ", ".join(repr(k) for k in v["missing"]) or "its required arguments"
        if v["received"] is None:
            problem = "sent arguments that could not be read"
        elif not v["received"]:
            problem = "sent no arguments"
        else:
            problem = f"used the wrong argument names ({', '.join(repr(k) for k in v['received'])})"
        allowed = ", ".join(repr(k) for k in v["allowed"])
        lines.append(
            f"Your last call to {v['tool']!r} {problem}. Required: {required}. Allowed names: {allowed}. "
            "Call it again with exactly those argument names and every required value filled in."
        )
    return "\n".join(lines)


# ───── Proxy wiring — non-streaming response hardening orchestration ────────


@dataclass
class HardeningOutcome:
    """Result of hardening one non-streaming OpenAI response.

    ``result`` is the (possibly repaired-in-place) response dict. ``needs_retry``
    is True only when a layer could not repair locally and needs the model to
    try again; ``retry_message`` is the structured correction the proxy appends
    to ``messages`` before re-dispatching upstream. ``force_tool_choice``, when
    set, is an OpenAI ``tool_choice`` the retry should pin (e.g. force ``task``
    when a websearch-* name was hallucinated).
    """

    result: dict
    needs_retry: bool
    retry_message: str | None = None
    force_tool_choice: dict | None = None


def should_harden_kind(kind: str) -> bool:
    """Whether tool-call hardening should run for a given routing ``kind``.

    Hardening exists for weak local/edge models. Cloud models are strong enough
    not to need it, and cloud dispatch returns a ``JSONResponse`` rather than the
    plain result dict these repairs walk, so cloud is skipped.
    """
    return kind in ("local", "edge")


# ───── llama.cpp grammar sanitization (llamacpp path only) ─────────────────
# llama.cpp compiles each tool's JSON-Schema ``parameters`` into a GBNF grammar
# for constrained tool-calling. Its regex→GBNF converter (`_visit_pattern` in
# common/json-schema-to-grammar.cpp) copies unknown backslash escapes through
# LITERALLY: ``\d`` / ``\w`` / ``\s`` in a schema ``"pattern"`` land in the
# grammar unchanged, but the SAME build's GBNF PARSER rejects ``\d`` as an
# "unknown escape" → "failed to parse grammar" → sampler init fails → HTTP 400
# for the WHOLE request (every tool dies, not just the offending one — the
# grammar is the union of all tools). Confirmed against llama.cpp master: there
# is no upstream fix for ``\d``/``\w``/``\s`` in ``pattern``. ``format`` is the
# safer built-in (``[0-9]``), but some schemas still carry hand-written date
# ``pattern`` regexes (e.g. Notion's create-comment date field), so we strip it
# too as cheap insurance.
#
# This is llama.cpp-SPECIFIC. The edge path (vLLM/xgrammar) and cloud handle the
# full schemas fine, so this runs on the ``kind == "local"`` path ONLY.
#
# ``format`` and ``pattern`` are VALIDATION-ONLY annotations: dropping them
# leaves request STRUCTURE intact (a date field stays a plain ``string``) and
# keeps every tool callable. No other llmrouter code reads these keywords —
# the hardening validators extract only ``enum`` / ``properties`` / ``required``.
_GRAMMAR_UNSAFE_SCHEMA_KEYS = ("format", "pattern")


def _strip_grammar_unsafe_keys(node: Any) -> int:
    """Recursively delete grammar-unsafe validation keywords from a JSON-Schema
    subtree. Returns the count removed. Walks dict values and list items; ignores
    scalars. Never raises.

    Only a **string-valued** ``format`` / ``pattern`` is the JSON-Schema keyword.
    A property literally NAMED ``"format"`` / ``"pattern"`` (a key under
    ``properties`` / ``$defs`` / …) always maps to a schema OBJECT or boolean —
    never a bare string — so the ``isinstance(..., str)`` guard preserves such
    properties while still removing the real keyword.
    """
    removed = 0
    if isinstance(node, dict):
        for key in _GRAMMAR_UNSAFE_SCHEMA_KEYS:
            if isinstance(node.get(key), str):
                del node[key]
                removed += 1
        for value in node.values():
            removed += _strip_grammar_unsafe_keys(value)
    elif isinstance(node, list):
        for item in node:
            removed += _strip_grammar_unsafe_keys(item)
    return removed


# Argument names that carry the bulk of a tool call's payload. llama.cpp turns
# a tool's JSON Schema into a GBNF grammar that emits properties in DECLARED
# ORDER, so whichever key comes first is generated first. Putting the bulk field
# last means the small identifying keys (``filePath``) are emitted before the
# budget runs out, and — more importantly for the common case — the model states
# its target before committing thousands of tokens to the body.
_BULK_TEXT_PROPERTY_NAMES = frozenset(
    {"content", "newstring", "oldstring", "text", "body", "data", "patch", "diff"}
)


def _reorder_bulk_text_properties_last(node: Any) -> int:
    """Move bulk-text properties to the end of every object schema, in place.

    Key order is semantically irrelevant to the tool itself — it only steers
    the grammar's generation order. Relative order is otherwise preserved, and
    ``required`` is re-sorted to match so both orderings agree.
    """
    moved = 0
    if isinstance(node, dict):
        props = node.get("properties")
        if isinstance(props, dict) and len(props) > 1:
            names = list(props.keys())
            head = [n for n in names if str(n).lower() not in _BULK_TEXT_PROPERTY_NAMES]
            tail = [n for n in names if str(n).lower() in _BULK_TEXT_PROPERTY_NAMES]
            reordered = head + tail
            if reordered != names:
                node["properties"] = {name: props[name] for name in reordered}
                required = node.get("required")
                if isinstance(required, list):
                    rank = {name: i for i, name in enumerate(reordered)}
                    node["required"] = sorted(required, key=lambda r: rank.get(r, len(rank)))
                moved += 1
        for value in list(node.values()):
            moved += _reorder_bulk_text_properties_last(value)
    elif isinstance(node, list):
        for item in node:
            moved += _reorder_bulk_text_properties_last(item)
    return moved


# opencode's `task` tool describes valid sub-agents in prose, but leaves
# `subagent_type` as a plain string. On the local llama.cpp path we tighten that
# field to an enum before the schema is compiled into a grammar, so the model
# cannot generate near-miss names such as `web-search-agent`.
#
# The router does not own the agent list. The grade-materialized opencode
# sandbox owns it: plugin `91_agent_context_header.ts` reads the live agent
# registry and sends the dispatchable names in `Superclaw-Task-Subagents`.
# `proxy.py` parses that header and passes the names down here. If the header is
# absent or empty, this helper leaves the schema unchanged instead of inventing
# a fallback list.
_SUBAGENT_ARG_NAMES: Final[frozenset[str]] = frozenset({"subagent_type", "agent"})


def _constrain_subagent_enum(tool: dict, names: tuple[str, ...]) -> int:
    """Pin the `task` tool's sub-agent argument to the caller-supplied ``names``,
    in place. Pass-through (no-op) when ``names`` is empty.

    Returns 1 when an enum was added. Only touches a string-typed property that
    carries no enum yet, so an upstream schema that already constrains the field
    (or models it differently) is left alone.
    """
    if not names:
        return 0
    fn = tool.get("function") if isinstance(tool.get("function"), dict) else tool
    if not isinstance(fn, dict) or fn.get("name") != "task":
        return 0
    params = fn.get("parameters")
    props = params.get("properties") if isinstance(params, dict) else None
    if not isinstance(props, dict):
        return 0
    for arg in _SUBAGENT_ARG_NAMES:
        spec = props.get(arg)
        if not isinstance(spec, dict) or spec.get("enum") is not None:
            continue
        if spec.get("type") not in (None, "string"):
            continue
        spec["enum"] = list(names)
        return 1
    return 0


def sanitize_tool_schemas_for_local_grammar(
    body: dict, subagent_names: tuple[str, ...] = ()
) -> int:
    """Make every tool's parameter schema grammar-friendly, in place.

    Three edits, all aimed at the GBNF grammar llama.cpp compiles the schema
    into: strip ``format`` / ``pattern`` (unsupported keywords), move bulk-text
    properties last so a truncated call still carries its identifying keys, and
    pin ``task.subagent_type`` to ``subagent_names`` (the grade's dispatchable
    agents, supplied by the caller — pass-through when the tuple is empty).

    Call ONLY on the llamacpp (``kind == "local"``) path — edge/vLLM and cloud
    keep the full schemas. Handles the OpenAI
    ``[{"type":"function","function":{"parameters": …}}]`` shape and the flat
    ``[{"parameters": …}]`` shape. Mutates ``body["tools"]`` in place; returns the
    total keyword count removed — reordering and the enum are logged, not counted
    (0 when there are no tools or nothing matched). Never raises on malformed
    input.
    """
    tools = body.get("tools")
    if not isinstance(tools, list):
        return 0
    removed = 0
    reordered = 0
    constrained = 0
    for tool in tools:
        if not isinstance(tool, dict):
            continue
        fn = tool.get("function")
        params = fn.get("parameters") if isinstance(fn, dict) else tool.get("parameters")
        if isinstance(params, (dict, list)):
            removed += _strip_grammar_unsafe_keys(params)
            reordered += _reorder_bulk_text_properties_last(params)
        constrained += _constrain_subagent_enum(tool, subagent_names)
    if constrained:
        logger.info(
            "[tool-schema] constrained task.subagent_type to %d caller-supplied "
            "agent name(s) so an invented name cannot be generated",
            len(subagent_names),
        )
    if reordered:
        logger.info(
            "[tool-schema] moved bulk-text properties last in %d object schema(s) "
            "so a truncated call keeps its identifying keys",
            reordered,
        )
    return removed


def _m3_enabled() -> bool:
    """M3 (no-tool-call recovery) is on unless ``SUPERCLAW_M3_DISABLE=1``."""
    return os.environ.get("SUPERCLAW_M3_DISABLE", "") != "1"


def _lifted_choice(tool_call: dict) -> list:
    """Wrap a text-lifted tool call in the non-stream ``choices`` shape so the
    name validators can inspect it before it is committed to the result."""
    return [{
        "index": 0,
        "message": {"role": "assistant", "tool_calls": [tool_call]},
        "finish_reason": "tool_calls",
    }]


def _tool_name_retry(invalid: list[str], catalog: set[str]) -> tuple[str, dict | None]:
    """Build the (correction message, forced tool_choice) pair for an
    invalid-tool-name retry. Forces ``task`` when a websearch-* name was
    hallucinated and ``task`` is available (the real path for web search)."""
    message = format_tool_name_retry_message(invalid, catalog)
    force = (
        {"type": "function", "function": {"name": "task"}}
        if should_force_task_for_websearch_retry(invalid, catalog)
        else None
    )
    return message, force


def repair_nonstreaming_result_in_place(
    choices: list, tools: list | None, extra_body: dict | None
) -> None:
    """B-stage: final in-place hardening (never triggers a retry). Drops any
    leftover invalid tool names (M1), normalises JSON args, then runs M5 arg-key
    / #744 numeric coercion / M4 arg-value validation. Order matters: M5/#744/M4
    all assume arguments were normalised into parseable JSON first.
    """
    catalog = extract_catalog(tools)
    if catalog:
        validate_tool_call_names(choices, catalog)
    normalise_tool_call_args(choices)
    arg_schemas = extract_arg_schemas_from_tools(tools)
    if arg_schemas:
        validate_tool_call_arg_keys(choices, arg_schemas)
        coerce_numeric_tool_args(choices, arg_schemas)
    constraints = merge_arg_constraints(
        extract_arg_constraints_from_tools(tools), get_arg_constraints(extra_body)
    )
    if constraints:
        validate_tool_call_arg_values(choices, constraints)


def harden_nonstreaming_result(
    result: dict,
    tools: list | None,
    extra_body: dict | None,
    messages: list | None = None,
    requesting_agent: str | None = None,
) -> HardeningOutcome:
    """Run the full non-streaming hardening sequence on one OpenAI result.

    A-stage (corrective retry, checked before any in-place edit):
      * M1: a hallucinated tool name cannot be repaired locally, so it is
        reported via ``needs_retry`` + a structured ``retry_message`` (and
        ``force_tool_choice`` when a websearch-* name should be steered to
        ``task``).
      * M5: a call with missing or unknown argument keys that the wrapper
        repair cannot fix (e.g. ``bash`` with ``{}``) is re-requested once.
      * M3: when the model returned no tool call but one was needed, either lift
        a text-embedded call into a real structured call in place, or (a
        first-turn refusal) ask for a steered retry.

    B-stage (in-place, never a retry) runs once no retry is needed, via
    ``repair_nonstreaming_result_in_place``: drop leftover invalid names,
    normalise JSON, M5 arg-key / #744 numeric / M4 arg-value validation.

    ``messages`` is the request history M3 needs to tell a genuine answer from a
    missed tool call. ``requesting_agent`` enables agent-specific M3 behavior
    (e.g. protected-file-agent unconditionally retries no-tool responses).
    """
    choices = result.get("choices") if isinstance(result, dict) else None
    catalog = extract_catalog(tools)
    if not isinstance(choices, list) or not choices or not catalog:
        return HardeningOutcome(result=result, needs_retry=False)

    # ── A-stage: corrective-retry signals ──
    invalid = invalid_tool_call_names(choices, catalog)
    if invalid:
        message, force = _tool_name_retry(invalid, catalog)
        return HardeningOutcome(
            result=result, needs_retry=True, retry_message=message, force_tool_choice=force
        )

    # ── #1876: first adapt unavailable web-search delegation directly, in place,
    # when the live task enum + tool catalog prove the conversion is valid (no
    # re-dispatch). Any remaining task(subagent_type=<disallowed>) call then
    # retries with a hint instead of being silently dropped; B-stage remains the
    # drop+note fallback once the retry budget is exhausted.
    rewrite_unavailable_websearch_task_calls(choices, tools)
    constraints = merge_arg_constraints(
        extract_arg_constraints_from_tools(tools), get_arg_constraints(extra_body)
    )
    violations = detect_task_subagent_violations(choices, constraints)
    if violations:
        message, force = _subagent_value_retry(violations, catalog)
        return HardeningOutcome(
            result=result, needs_retry=True, retry_message=message,
            force_tool_choice=force,
        )

    arg_schemas = extract_arg_schemas_from_tools(tools)
    bad_args = detect_arg_key_violations(choices, arg_schemas) if arg_schemas else []
    if bad_args:
        return HardeningOutcome(
            result=result, needs_retry=True, retry_message=format_arg_key_retry_message(bad_args)
        )

    first_msg = choices[0].get("message") or {}
    if not first_msg.get("tool_calls") and _m3_enabled():
        action, data = decide_no_tool_action(
            first_msg.get("content") or "", None, messages or [], catalog,
            requesting_agent=requesting_agent
        )
        if action == "lift":
            lifted_invalid = invalid_tool_call_names(_lifted_choice(data), catalog)
            if lifted_invalid:
                message, force = _tool_name_retry(lifted_invalid, catalog)
                return HardeningOutcome(
                    result=result, needs_retry=True, retry_message=message,
                    force_tool_choice=force,
                )
            first_msg["tool_calls"] = [data]
            first_msg["content"] = ""
            choices[0]["finish_reason"] = "tool_calls"
        elif action == "retry":
            return HardeningOutcome(result=result, needs_retry=True, retry_message=data)

    # ── B-stage: final in-place repairs ──
    repair_nonstreaming_result_in_place(choices, tools, extra_body)
    return HardeningOutcome(result=result, needs_retry=False)


# ───── Streaming — buffer / reconstruct / replay for hardening ─────────────
#
# Hardening validators expect the complete non-stream OpenAI shape, so a
# streamed response is buffered into one result, hardened, then replayed as SSE.
# This trades streaming's time-to-first-token for the ability to drop / retry /
# validate tool calls the same way the non-streaming path does.


def extract_finish_reason(event: Any) -> str | None:
    """Return the ``finish_reason`` an SSE chunk carries, if any.

    The terminal chunk has an empty delta, so a buffer that only keeps
    tool-call deltas never contains it. Callers pass it in explicitly to keep
    ``length`` (output cap) distinguishable from a normal stop.
    """
    for data in _iter_sse_data([event]):
        for choice in data.get("choices") or []:
            if choice.get("finish_reason"):
                return str(choice["finish_reason"])
    return None


def sse_carries_tool_call(events: list) -> bool:
    """Does this batch of SSE chunks contain an actual tool-call delta?

    Used to tell a hardened batch that still delivers a call from one where
    every call was dropped — the two need opposite ``finish_reason`` handling.
    """
    for data in _iter_sse_data(events):
        for choice in data.get("choices") or []:
            if (choice.get("delta") or {}).get("tool_calls"):
                return True
    return False


def rewrite_sse_finish_reason(event: Any, new_reason: str) -> Any:
    """Return ``event`` with any non-null ``finish_reason`` replaced.

    When hardening still hands the client a COMPLETE tool call, a trailing
    ``length`` must not survive: clients read it as "response cut off" and
    discard the call, losing work the turn actually finished. Events without a
    reason pass through untouched.
    """
    text = event.decode("utf-8", "replace") if isinstance(event, (bytes, bytearray)) else str(event)
    if '"finish_reason"' not in text:
        return event
    out_lines: list[str] = []
    changed = False
    for line in text.split("\n"):
        if not line.startswith("data: "):
            out_lines.append(line)
            continue
        payload = line[6:].strip()
        if not payload or payload == "[DONE]":
            out_lines.append(line)
            continue
        try:
            data = json.loads(payload)
        except Exception:  # noqa: BLE001
            out_lines.append(line)
            continue
        for choice in data.get("choices") or []:
            if choice.get("finish_reason"):
                choice["finish_reason"] = new_reason
                changed = True
        out_lines.append(f"data: {json.dumps(data)}")
    if not changed:
        return event
    rebuilt = "\n".join(out_lines)
    return rebuilt.encode("utf-8") if isinstance(event, (bytes, bytearray)) else rebuilt


def _reconstruct_streaming_tool_calls(
    tool_call_chunks: list, finish_reason: str | None = None
) -> list:
    """Assemble non-stream ``choices`` from buffered streaming tool_call chunks.

    Streamed tool calls arrive as fragmented SSE deltas (the name in one chunk,
    argument pieces across several). This merges them by ``index`` into the
    non-stream OpenAI shape the hardening validators expect. ``finish_reason``
    supplies the terminal chunk's reason when it was not part of the buffer.
    """
    if not tool_call_chunks:
        return []
    assembled: dict = {}
    upstream_finish: str | None = finish_reason
    for raw_chunk in tool_call_chunks:
        line = (
            raw_chunk.decode("utf-8", "replace")
            if isinstance(raw_chunk, (bytes, bytearray))
            else raw_chunk
        )
        if not line.startswith("data: "):
            continue
        try:
            data = json.loads(line[6:])
        except Exception:
            continue
        for choice in data.get("choices") or []:
            # The terminal chunk carries the real reason. Keeping it is what
            # lets the hardening layers tell a truncated turn (``length``, the
            # output cap cut the arguments mid-JSON) from a finished one.
            if choice.get("finish_reason"):
                upstream_finish = choice["finish_reason"]
            for tc in ((choice.get("delta") or {}).get("tool_calls") or []):
                idx = tc.get("index", 0)
                slot = assembled.setdefault(idx, {"id": None, "name": None, "args_parts": []})
                if tc.get("id"):
                    slot["id"] = tc["id"]
                fn = tc.get("function") or {}
                if fn.get("name"):
                    slot["name"] = fn["name"]
                args = fn.get("arguments", "")
                if args:
                    slot["args_parts"].append(args)
    tool_calls = []
    for idx in sorted(assembled.keys()):
        slot = assembled[idx]
        tool_calls.append({
            "id": slot["id"] or "",
            "type": "function",
            "function": {"name": slot["name"] or "", "arguments": "".join(slot["args_parts"])},
        })
    if not tool_calls:
        return []
    return [{
        "index": 0,
        "message": {"role": "assistant", "tool_calls": tool_calls},
        "finish_reason": upstream_finish or "tool_calls",
    }]


def invalid_tool_names_from_streaming_chunks(
    tool_call_chunks: list, tools: list | None
) -> list[str]:
    """Return hallucinated tool names in a buffered stream, without mutating it."""
    catalog = extract_catalog(tools)
    if not catalog or not tool_call_chunks:
        return []
    synth = _reconstruct_streaming_tool_calls(tool_call_chunks)
    return invalid_tool_call_names(synth, catalog)


def _iter_sse_data(raw_events: list) -> list[dict]:
    """Decode a buffered SSE stream into the JSON payloads of its data events
    (skips ``[DONE]`` and unparseable lines)."""
    out: list[dict] = []
    for event in raw_events:
        text = (
            event.decode("utf-8", "replace")
            if isinstance(event, (bytes, bytearray))
            else event
        )
        for line in text.split("\n"):
            if not line.startswith("data: "):
                continue
            payload = line[6:].strip()
            if not payload or payload == "[DONE]":
                continue
            try:
                data = json.loads(payload)
            except Exception:
                continue
            if isinstance(data, dict):
                out.append(data)
    return out


# ───── Streaming — chunk-level hardening (M1/M2/M4/M5/M6, no M3) ────────────
#
# Unlike buffer-and-replay, this keeps streaming: content deltas pass straight
# through, only the (short) tool-call deltas are buffered, reconstructed,
# repaired in place, and re-emitted. M3 (prose that is actually a call) is NOT
# handled here: it would need to retract already-streamed prose, which cannot be
# un-streamed, so the streaming path skips it (surfaced in the UI instead).


def event_has_tool_call_delta(raw_event) -> bool:
    """True if an SSE event carries a ``delta.tool_calls`` (so it must be
    buffered for chunk-level hardening rather than streamed straight through)."""
    for data in _iter_sse_data([raw_event]):
        for choice in data.get("choices") or []:
            if (choice.get("delta") or {}).get("tool_calls"):
                return True
    return False


def _message_delta_to_sse(message: dict) -> list[bytes]:
    """Encode a repaired assistant message as a single SSE delta chunk. When
    M1/M4/M5 dropped the call, ``tool_calls`` is None and the structured-error
    ``content`` is emitted instead.

    Both are emitted when both are present: when several calls were made and
    only some were dropped, the kept ones ride alongside the note explaining the
    rest, and dropping that note would leave the guidance unreachable.
    """
    delta: dict = {"role": "assistant"}
    if message.get("tool_calls"):
        delta["tool_calls"] = [
            {
                "index": i,
                "id": tc.get("id") or "",
                "type": "function",
                "function": {
                    "name": (tc.get("function") or {}).get("name") or "",
                    "arguments": (tc.get("function") or {}).get("arguments") or "",
                },
            }
            for i, tc in enumerate(message["tool_calls"])
        ]
    if message.get("content"):
        delta["content"] = message["content"]
    chunk = {
        "object": "chat.completion.chunk",
        "choices": [{"index": 0, "delta": delta, "finish_reason": None}],
    }
    return [f"data: {json.dumps(chunk)}\n\n".encode("utf-8")]


def harden_streaming_tool_calls(
    tool_call_chunks: list,
    tools: list | None,
    extra_body: dict | None,
    finish_reason: str | None = None,
) -> list[bytes]:
    """Chunk-level hardening for a buffered streaming tool call.

    Reconstruct the tool call from its buffered SSE deltas, apply the in-place
    layers (M1 drop of hallucinated names, M2 JSON normalise, M5 arg-key, #744
    numeric coercion, M4 arg-value) plus the #1876 in-place rewrite of
    unavailable websearch-agent delegation to ``sc_search_web``, and re-encode
    the repaired message as SSE byte chunks. Everything here is in-place on the
    (short) buffered tool call — no M3, no corrective re-dispatch, no
    whole-response buffering — so the streaming structure and time-to-first-token
    are unchanged. If the chunks cannot be reconstructed, the originals are
    replayed unchanged.
    """
    synth = _reconstruct_streaming_tool_calls(tool_call_chunks, finish_reason)
    if not synth:
        # The buffered deltas could not be reassembled into one message — the
        # #2176 heartbeat class, where an SSE comment or a split frame leaves an
        # unterminated JSON fragment plus a nameless remainder. The originals are
        # replayed unchanged, so the CLIENT sees a malformed call and LRM,
        # until now, said nothing at all.
        record_event(
            EventType.UPSTREAM_SSE_REPAIR_FAILED,
            attrs={
                "buffered_chunks": len(tool_call_chunks),
                "finish_reason": finish_reason,
                "reason": "reconstruction_failed",
            },
        )
        return [
            c if isinstance(c, (bytes, bytearray)) else str(c).encode("utf-8")
            for c in tool_call_chunks
        ]
    rewrite_unavailable_websearch_task_calls(synth, tools)
    repair_nonstreaming_result_in_place(synth, tools, extra_body)
    message = (synth[0].get("message") or {}) if synth else {}
    return _message_delta_to_sse(message)


def is_sse_stream_terminator(raw_event: bytes | bytearray | str) -> bool:
    """True for the ``data: [DONE]`` chunk that closes an OpenAI-style stream.

    This is the flush DEADLINE, not a payload test: ``[DONE]`` carries no JSON
    (``_iter_sse_data`` skips it) yet it is the last thing a client reads.
    Anything emitted after it is discarded, so a buffered tool call must go out
    before this event is forwarded.
    """
    text = (
        raw_event.decode("utf-8", "replace")
        if isinstance(raw_event, (bytes, bytearray))
        else str(raw_event)
    )
    return any(line.strip() == "data: [DONE]" for line in text.splitlines())


StreamRetry = Callable[[str], Awaitable[AsyncIterator[bytes | bytearray | str] | None]]


async def _retry_stream_arg_keys(
    buffered: list,
    finish_reason: str | None,
    tools: list | None,
    retry: StreamRetry,
) -> list | None:
    """Re-request a call M5 would drop; return the retry's tool-call chunks only if they pass M5.

    Content in the retry is discarded: the client already has the original message's prose.
    """
    arg_schemas = extract_arg_schemas_from_tools(tools)
    synth = _reconstruct_streaming_tool_calls(buffered, finish_reason)
    bad = detect_arg_key_violations(synth, arg_schemas) if synth and arg_schemas else []
    if not bad:
        return None
    logger.info("[tool-call-hardening] M5 corrective re-dispatch (stream) for %s", [v["tool"] for v in bad])
    try:
        retried = await retry(format_arg_key_retry_message(bad))
        if retried is None:
            return None
        chunks = [ev async for ev in retried if event_has_tool_call_delta(ev)]
    except Exception:
        logger.exception("[tool-call-hardening] M5 stream retry failed; falling back to the rejection")
        return None
    again = _reconstruct_streaming_tool_calls(chunks, None) if chunks else []
    if not again or detect_arg_key_violations(again, arg_schemas):
        return None
    return chunks


async def _retry_stream_invalid_names(
    buffered: list,
    finish_reason: str | None,
    tools: list | None,
    retry: StreamRetry,
) -> list | None:
    """Re-request a call whose tool name M1 would drop (e.g. a repeat-locked ``bash``).

    Without this the rejection text is appended to the assistant's own content and
    lands in its history, where a weak model repeats it as its final answer. The
    correction goes out as a system message on the retry request instead. Only a retry
    whose calls are all in the catalog (and pass M5) replaces the original; content in
    the retry is discarded because the client already has the original message's prose.
    """
    catalog = extract_catalog(tools)
    synth = _reconstruct_streaming_tool_calls(buffered, finish_reason)
    invalid = invalid_tool_call_names(synth, catalog) if synth and catalog else []
    if not invalid:
        return None
    logger.info("[tool-call-hardening] M1 corrective re-dispatch (stream) for %s", invalid)
    try:
        retried = await retry(format_tool_name_retry_message(invalid, catalog))
        if retried is None:
            return None
        chunks = [ev async for ev in retried if event_has_tool_call_delta(ev)]
    except Exception:
        logger.exception("[tool-call-hardening] M1 stream retry failed; falling back to the rejection")
        return None
    again = _reconstruct_streaming_tool_calls(chunks, None) if chunks else []
    if not again or invalid_tool_call_names(again, catalog):
        return None
    arg_schemas = extract_arg_schemas_from_tools(tools)
    if arg_schemas and detect_arg_key_violations(again, arg_schemas):
        return None
    return chunks


async def harden_tool_call_stream(
    source: AsyncIterator[bytes | bytearray | str],
    tools: list | None,
    extra_body: dict | None,
    retry: StreamRetry | None = None,
) -> AsyncIterator[bytes | bytearray | str]:
    """Buffer a stream's tool-call deltas, repair them, and re-emit them whole.

    ``retry``, when given, is called once per stream with a correction message if M1 or M5 would drop a call; it
    returns a fresh upstream stream (or None). Only a retry whose call passes M1 and M5 replaces the original.


    Content deltas stream straight through; only the (short) tool-call deltas
    are held, so time-to-first-token is unchanged. The buffer is flushed at the
    end of the assistant MESSAGE -- the chunk carrying ``finish_reason``, or the
    ``[DONE]`` terminator if the upstream sends none -- with the post-loop flush
    left as a backstop for a stream that ends with neither.

    Flushing on that deadline, rather than on the first non-tool-call event, is
    what makes the reassembly correct. Two production failures came from
    flushing early (issue #2179, ~43% of agent tasks and a 15-minute CI hang):

      * An SSE comment (``: OPENROUTER PROCESSING``; 80 of 222 lines in one
        captured stream) arrives BETWEEN argument deltas. Read as "the call
        ended", it cut the call in two -- an unterminated-JSON fragment plus a
        nameless remainder, since the name only appears in the first delta.
        Those are exactly the two errors the model was shown.
      * When a message carries several calls with a non-tool event between
        them, only the FIRST group was flushed in-loop (the old ``flushed``
        latch never reset). The rest left the buffer after ``[DONE]`` had
        already been forwarded, so the call never reached the client: the agent
        waited on a tool result that never came and the turn hung until CI
        killed the job.

    Holding every delta to the deadline dissolves both: heartbeats and
    interleaved content are ordinary pass-through events, and the whole message
    reaches ``_reconstruct_streaming_tool_calls`` at once, which merges deltas
    by their UPSTREAM ``index``. That merge is also why per-group flushing
    cannot simply be unlatched: each flush re-bases indices from 0, so a second
    group would collide with the first call's index and be merged into it.
    """
    buffered_tool_calls: list = []
    last_finish: str | None = None
    delivered_tool_call = False
    retried = False

    async def _flush() -> list:
        nonlocal delivered_tool_call, retried
        chunks = buffered_tool_calls
        if retry is not None and not retried:
            retried = True
            chunks = await _retry_stream_invalid_names(chunks, last_finish, tools, retry) or chunks
            chunks = await _retry_stream_arg_keys(chunks, last_finish, tools, retry) or chunks
        hardened = harden_streaming_tool_calls(chunks, tools, extra_body, last_finish)
        # Latched: once any call is delivered the message is a valid tool-call
        # message, whatever a later group does.
        delivered_tool_call = sse_carries_tool_call(hardened) or delivered_tool_call
        return hardened

    async for chunk in source:
        if event_has_tool_call_delta(chunk):
            buffered_tool_calls.append(chunk)
            continue
        # The terminal chunk has an empty delta, so it never enters the buffer --
        # read its reason here, before the flush, or hardening cannot tell an
        # output-cap cut from a clean stop.
        last_finish = extract_finish_reason(chunk) or last_finish
        if buffered_tool_calls and (last_finish or is_sse_stream_terminator(chunk)):
            for out in await _flush():
                yield out
            buffered_tool_calls = []
        # A delivered call leaves the client a COMPLETE message, so a trailing
        # "length" would make it discard that call as truncated. Only an
        # undelivered call keeps the cut-off signal.
        if delivered_tool_call:
            chunk = rewrite_sse_finish_reason(chunk, "tool_calls")
        yield chunk

    # Backstop: a stream that ended with neither a finish_reason nor [DONE].
    if buffered_tool_calls:
        for out in await _flush():
            yield out
