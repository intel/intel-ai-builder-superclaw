"""Model-aware + agent-aware request transforms applied on the LOCAL path.

opencode binds prompt + tools statically per agent and only ever sends the
alias (``auto`` / ``local-model``) — it cannot know the concrete SKU a request
resolves to. The sidecar is the ONLY component that knows ``cfg.model_id`` after
``_resolve_alias``, so per-SKU tuning lives here (see
routing_service_integration_plan.md §11):

  * ``system_prompt`` (per MODEL, ``model_profiles.json``) — REPLACE the
    request's system message with a short, task-hardened prompt for weak locals
    (the pinchbench 4B win). A long agent prompt dilutes the delivery rules small
    models most need; a compact "one script writes the report / exact filename /
    no placeholders" prompt lifts their L2.

    This is a REPLACEMENT, not an overlay: whatever the swapped-out prompt was
    carrying is gone for that turn. So the swap is NOT capability-neutral, and
    every prompt under ``prompts/`` must itself restate the rules its target
    agents depend on. Three consequences already paid for:
      - specialist sub-agents keep their own prompt (``_SPECIALIST_SUBAGENTS``
        below) — the swap was erasing their stopping rule;
      - ``local-short.txt`` must carry the protected-file routing table, because
        on the ``minimal`` grade it replaces ``superclaw.minimal.txt`` (which owns
        that table) and that grade does not project the 90 tool-guard plugin;
      - the ``<available_skills>`` catalog is CARRIED OVER from the replaced run
        (``_carry_over_skills``) rather than restated, because it is per-install:
        without it, local models denied that skills exist at all while cloud
        listed them.
    Adding a model here means re-checking its grade's opencode config for rules
    the replacement would drop.

    * task-tool disable (per AGENT, env ``LATENTFACTOR_DISABLE_TASK_AGENTS``) —
    strip the ``task`` (sub-agent delegation) tool for NAMED agents only.
    IMPORTANT: task is NOT dropped by model. The primary agent
    (``superclaw-default``) reaches its subagents (email / local-file /
    websearch) ONLY via ``task``; dropping it by model would silently cut the
    default agent off from every other agent on any 4B/9B turn. Per-agent
    ``task`` permission is owned by ``opencode.jsonc``; this env var only lets us
    OVERRIDE it to force-disable ``task`` for a specific agent during
    experiments (e.g. running a single build agent through pinchbench with no
    delegation). Empty/unset => no override (honor opencode.jsonc).

    * repeated-tool terminal lock (per SUPERCLAW AGENT TURN, env
        ``SUPERCLAW_REPEAT_TOOL_TERMINAL_LOCK``) — after the same guarded tool call
        ignores the repeat plugin's first blocked attempt, remove that tool from the
        next local model request. This is the hard boundary the plugin API cannot
        provide without aborting the session. ``SC_REPEAT_MAX`` controls the shared
        allowed-attempt threshold; unset/invalid => 2.

Prompt swap is keyed on the SERVED model id; task disable is keyed on the
requesting agent. Both apply on the LOCAL/edge path only; cloud requests are
never touched. Missing caller identity does not trigger agent-bound transforms,
so direct LRM clients retain standard OpenAI-compatible behavior.
All functions mutate ``body`` in place and never raise.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
from functools import lru_cache
from pathlib import Path
from typing import Any, Optional

from loguru import logger

_POLICY_DIR = Path(__file__).parent
_PROFILES_FILE = _POLICY_DIR / "model_profiles.json"
_PROMPTS_DIR = _POLICY_DIR / "prompts"

# Env var: comma-separated agent names whose `task` tool the sidecar strips on
# the local path, OVERRIDING opencode.jsonc. For benchmarking an agent without
# sub-agent delegation. Empty/unset => honor opencode.jsonc (no override).
_ENV_DISABLE_TASK_AGENTS = "LATENTFACTOR_DISABLE_TASK_AGENTS"
_ENV_SYSTEM_PROMPT_AGENTS = "LATENTFACTOR_SYSTEM_PROMPT_AGENTS"
_ENV_REPEAT_TOOL_TERMINAL_LOCK = "SUPERCLAW_REPEAT_TOOL_TERMINAL_LOCK"
_ENV_REPEAT_MAX = "SC_REPEAT_MAX"
_QWEN_SINGLE_SYSTEM_MODELS = frozenset({"qwen3.8-27b", "bonsai-2.5-27b", "Qwen3.8-Flash-Next"})
_MENTION_BOUNDARY_RE = re.compile(r"[\s,.:;!?)}\]]")

# Local short-prompt override is intended for product-managed built-in agents.
# Custom/user agents should keep their authored system prompt by default.
_DEFAULT_SYSTEM_PROMPT_AGENTS = {
    "superclaw-default",
    "build",
    "local-deep-research",
    "email-agent",
    "local-file-agent",
    "websearch-agent",
    "local-dr-math",
    "protected-file-agent",
    "protected-pipeline-agent",
    "hybrid-deep-research",
}


# opencode's built-in infrastructure agents — small-model meta-calls that
# title, summarize, and compact the conversation. They must NOT receive the
# per-model task-hardening system prompt (see apply_model_policy).
_INFRA_AGENTS: frozenset[str] = frozenset({"title", "summary", "compaction"})

# Specialist SUB-agents whose entire contract lives in their own prompt: what to
# return, how to cite, and — critically — when to stop. local-short.txt is a
# task-hardening prompt for a PRIMARY agent delivering a report file; it says
# nothing about searching or about accepting "this data does not exist", so
# swapping it in strips the specialist's stopping rule. Observed: the local
# websearch-agent, handed local-short.txt, burned its whole 10-step budget
# re-phrasing one query for a benchmark figure the vendor never published, then
# returned the max-steps boilerplate with none of its findings. These agents keep
# the prompt opencode bound to them.
_SPECIALIST_SUBAGENTS: frozenset[str] = frozenset({
    "websearch-agent",
    "local-file-agent",
    "protected-file-agent",
    "local-dr-math",
    "email-agent",
    "hybrid-deep-research",
})

_PROMPT_SWAP_EXEMPT_AGENTS: frozenset[str] = _INFRA_AGENTS | _SPECIALIST_SUBAGENTS


def _task_disabled_agents() -> set[str]:
    """Parse ``LATENTFACTOR_DISABLE_TASK_AGENTS`` into a set of agent names.

    Comma/space separated, case-preserved to match the ``superclaw-agent``
    header the plugin sends. Empty/unset => empty set (no override)."""
    raw = (os.environ.get(_ENV_DISABLE_TASK_AGENTS) or "").strip()
    if not raw:
        return set()
    return {a.strip() for a in raw.replace(",", " ").split() if a.strip()}


def _system_prompt_agents() -> set[str]:
    """Resolve allowlisted agents for local short-prompt replacement.

    Empty/unset env => use the built-in defaults. Non-empty env overrides the
    default set fully.
    """
    raw = (os.environ.get(_ENV_SYSTEM_PROMPT_AGENTS) or "").strip()
    if not raw:
        return set(_DEFAULT_SYSTEM_PROMPT_AGENTS)
    return {a.strip() for a in raw.replace(",", " ").split() if a.strip()}


def _should_apply_system_prompt(requesting_agent: Optional[str]) -> bool:
    """Whether local short-prompt replacement should run for this request.

    Apply only to allowlisted built-ins.
    Missing caller identity is treated as unknown and does not trigger
    replacement, so custom/user agent prompts are preserved by default.
    """
    agent = (requesting_agent or "").strip()
    if not agent:
        return False
    return agent in _system_prompt_agents()


@lru_cache(maxsize=1)
def _load_profiles() -> dict[str, dict[str, Any]]:
    """Load model_profiles.json → {served_id: profile}. Cached; empty on error."""
    try:
        data = json.loads(_PROFILES_FILE.read_text(encoding="utf-8"))
        profiles = data.get("profiles", {})
        return profiles if isinstance(profiles, dict) else {}
    except Exception as exc:  # noqa: BLE001
        logger.warning("[policy] could not load model_profiles.json: {}", exc)
        return {}


@lru_cache(maxsize=8)
def _load_prompt(filename: str) -> Optional[str]:
    """Load a system-prompt fragment from routing/policy/prompts/. Cached.

    Returns None (transform skipped) on any failure. Rejects path separators so
    a malformed profile can't read outside the prompts dir."""
    if not filename or "/" in filename or "\\" in filename or ".." in filename:
        logger.warning("[policy] rejecting suspicious prompt filename: {!r}", filename)
        return None
    try:
        return (_PROMPTS_DIR / filename).read_text(encoding="utf-8")
    except Exception as exc:  # noqa: BLE001
        logger.warning("[policy] could not read prompt {!r}: {}", filename, exc)
        return None


def get_profile(model_id: Optional[str]) -> Optional[dict[str, Any]]:
    """Return the per-model profile for ``model_id`` (served id), or None."""
    if not model_id:
        return None
    return _load_profiles().get(model_id)


# opencode injects the skill CATALOG (<available_skills>: name/description/
# location per skill) into the SYSTEM prompt; only a skill's BODY comes from the
# `skill` tool. So the leading-system-run replacement below also deleted the
# catalog: on the local path the model had no idea any skill existed, while cloud
# (prompt untouched, see the kind != "cloud" guard in proxy.py) listed them fine.
# The catalog comes from the active Product Profile plus user-added SKILL.md, so
# it is CARRIED OVER verbatim from the request — never
# restated in prompts/, which would go stale on the first added skill.
#
# The two-line header opencode renders IMMEDIATELY BEFORE the block, in the same
# string entry. Product Profile skill permissions provide the first enforcement
# layer, while this parser handles either an empty block or no block.
# is carried along with it, so the "how to use a skill" wording is upstream's and
# tracks upstream. Both header lines are OPTIONAL in the pattern: if opencode
# rewords them the group simply misses and we carry the bare block, which is still
# correct — the `skill` tool's own description in tools[] states how to call it.
_SKILLS_BLOCK_RE = re.compile(
    r"(?:Skills provide[^\n]*\n(?:Use the `?skill`? tool[^\n]*\n)?)?"
    r"<available_skills>(?P<inner>.*?)</available_skills>",
    re.DOTALL,
)


def _carry_over_skills(msgs: list[Any], lead: int) -> str:
    """The ``<available_skills>`` catalog (+ its header) from the leading system
    run, or ``""`` when the run offers no skills.

    Returns text to APPEND to the replacement prompt so the swap stops being
    capability-destroying for skills. Reads ``msgs[:lead]`` only — the messages
    about to be dropped."""
    blocks: list[str] = []
    for i in range(lead):
        msg = msgs[i]
        if not isinstance(msg, dict):
            continue
        for m in _SKILLS_BLOCK_RE.finditer(_content_as_text(msg.get("content"))):
            # A HOLLOW block carries no capability, and pairing the header's "use
            # the skill tool" with an empty list is worse than saying nothing.
            # It also covers `"skill": {"*": "deny"}` agents. Whether opencode emits an
            # empty block or none at all for them is NOT verifiable from this
            # repo (opencode ships as a binary), so handle both.
            if not m.group("inner").strip():
                continue
            blocks.append(m.group(0).rstrip())
    return "\n\n" + "\n\n".join(blocks) if blocks else ""


# Rendered per backend by the Profile's 03_strip_model_id_prompt plugin; the
# router cannot know which backend the agent runs on, so it carries the block.
_ENVIRONMENT_BLOCK_RE = re.compile(
    r"<superclaw_environment>.*?</superclaw_environment>", re.DOTALL
)


def _carry_over_environment(msgs: list[Any], lead: int) -> str:
    """The first ``<superclaw_environment>`` block in ``msgs[:lead]``, or ``""``."""
    for i in range(lead):
        msg = msgs[i]
        if not isinstance(msg, dict):
            continue
        m = _ENVIRONMENT_BLOCK_RE.search(_content_as_text(msg.get("content")))
        if m:
            return "\n" + m.group(0)
    return ""


def apply_system_prompt(body: dict[str, Any], prompt_text: str) -> bool:
    """REPLACE the request's leading system message(s) with ``prompt_text``.

    opencode sends the agent prompt as one or more leading ``role="system"``
    messages. We replace the FIRST system message's content with the short
    prompt and drop any additional leading system messages, so the model gets
    exactly the short prompt (not short + the 10KB original) — except for the
    skill catalog that run was carrying, which is carried over (see
    ``_carry_over_skills``). Non-system messages (the user task, tool results)
    are preserved in order. Returns True if a change was made. Mutates ``body``
    in place.
    """
    msgs = body.get("messages")
    if not isinstance(msgs, list) or not msgs:
        # No messages to anchor to — prepend a system message.
        tail: list[Any] = msgs if isinstance(msgs, list) else []
        body["messages"] = [{"role": "system", "content": prompt_text}] + tail
        return True
    # Find the contiguous leading run of system messages.
    lead = 0
    while lead < len(msgs) and isinstance(msgs[lead], dict) and msgs[lead].get("role") == "system":
        lead += 1
    if lead == 0:
        # No leading system message — inject one at the front.
        body["messages"] = [{"role": "system", "content": prompt_text}] + msgs
    else:
        # Replace the whole leading system run with the single short prompt,
        # plus whatever skill catalog that run was carrying.
        new_content = (
            prompt_text
            + _carry_over_environment(msgs, lead)
            + _carry_over_skills(msgs, lead)
        )
        body["messages"] = [{"role": "system", "content": new_content}] + msgs[lead:]
    return True


def normalize_qwen_system_messages(body: dict[str, Any]) -> bool:
    """Consolidate system messages into the first message for strict Qwen templates.

    Qwen3.8's llama.cpp template rejects every system message that is not
    the first message. Preserve all non-system messages in their original order
    and retain structured content parts verbatim. Returns False for unsupported
    content shapes instead of applying a lossy conversion.
    """
    messages = body.get("messages")
    if not isinstance(messages, list):
        return False

    system_indexes = [
        index
        for index, message in enumerate(messages)
        if isinstance(message, dict) and message.get("role") == "system"
    ]
    if not system_indexes or system_indexes == [0]:
        return False

    system_messages = [messages[index] for index in system_indexes]
    contents = [message.get("content", "") for message in system_messages]
    if all(isinstance(content, str) for content in contents):
        merged_content: Any = "\n\n".join(
            content for content in contents if content
        )
    else:
        merged_parts: list[Any] = []
        for content in contents:
            if isinstance(content, str):
                if content:
                    merged_parts.append({"type": "text", "text": content})
            elif isinstance(content, list):
                merged_parts.extend(content)
            else:
                return False
        merged_content = merged_parts

    merged_system = dict(system_messages[0])
    merged_system["content"] = merged_content
    system_index_set = set(system_indexes)
    body["messages"] = [merged_system] + [
        message
        for index, message in enumerate(messages)
        if index not in system_index_set
    ]
    return True


def apply_qwen_system_compat(
    body: dict[str, Any],
    model_id: Optional[str],
) -> bool:
    """Normalize system messages only for models with a strict Qwen template."""
    return model_id in _QWEN_SINGLE_SYSTEM_MODELS and normalize_qwen_system_messages(body)


def apply_drop_tools(body: dict[str, Any], drop: list[str]) -> int:
    """Remove tools named in ``drop`` from the request's ``tools[]`` array.

    Handles the OpenAI ``tools`` shape (``[{"type":"function","function":
    {"name": ...}}]``) and the flat ``[{"name": ...}]`` shape. Also clears a
    ``tool_choice`` that names a dropped tool (so the model isn't forced to call
    a tool that no longer exists). Returns the number of tools removed. Mutates
    ``body`` in place; no-op when there are no tools or nothing matches.
    """
    if not drop:
        return 0
    dropset = set(drop)
    tools = body.get("tools")
    if not isinstance(tools, list):
        return 0

    def _name(t: Any) -> Optional[str]:
        if not isinstance(t, dict):
            return None
        if isinstance(t.get("function"), dict):
            return t["function"].get("name")
        return t.get("name")

    kept = [t for t in tools if _name(t) not in dropset]
    removed = len(tools) - len(kept)
    if removed:
        body["tools"] = kept
        # If tool_choice forces a dropped tool, relax it to "auto".
        tc = body.get("tool_choice")
        if isinstance(tc, dict):
            forced = (tc.get("function") or {}).get("name") if isinstance(tc.get("function"), dict) else tc.get("name")
            if forced in dropset:
                body["tool_choice"] = "auto"
    return removed


# ── Repeated tool terminal lock ────────────────────────────────────────────────
_REPEAT_DEFAULT_MAX = 2
_REPEAT_SCHEDULER_TOOLS = frozenset({"run_job", "schedule_job", "cancel_job", "update_job"})
# ``write`` is guarded because it is where a locked-out ``edit`` goes to die. Observed on
# task_log_hdfs_failures: once edit was locked the model rewrote the same 4 KB script four
# times with a byte-identical payload and burned the rest of its step budget, so the report
# it was asked for was never written (L2 0.50 on an empty deliverable).
_REPEAT_GUARDED_TOOLS = (
    frozenset({"bash", "invalid", "edit", "write", "get_mcp_status"}) | _REPEAT_SCHEDULER_TOOLS
)
_REPEAT_LOCK_DISABLED_VALUES = frozenset({"0", "false", "no", "off"})


def _repeat_tool_terminal_lock_enabled() -> bool:
    raw = (os.environ.get(_ENV_REPEAT_TOOL_TERMINAL_LOCK) or "").strip().lower()
    return raw not in _REPEAT_LOCK_DISABLED_VALUES


def _repeat_lock_guidance_enabled() -> bool:
    raw = (os.environ.get("SUPERCLAW_REPEAT_LOCK_GUIDANCE") or "").strip().lower()
    return raw not in _REPEAT_LOCK_DISABLED_VALUES


def _repeat_lock_attempts() -> int:
    raw = (os.environ.get(_ENV_REPEAT_MAX) or "").strip()
    try:
        allowed = int(raw) if raw else _REPEAT_DEFAULT_MAX
    except ValueError:
        allowed = _REPEAT_DEFAULT_MAX
    if allowed < 1:
        allowed = _REPEAT_DEFAULT_MAX
    return allowed + 2


def _normalize_repeat_value(value: Any) -> str:
    return " ".join(str(value or "").strip().split())


def _repeat_action_key(tool: str, args: dict[str, Any]) -> Optional[str]:
    if tool == "bash":
        command = _normalize_repeat_value(args.get("command"))
        return f"bash:{command}" if command else None
    if tool == "invalid":
        intended = _normalize_repeat_value(args.get("tool"))
        error = _normalize_repeat_value(args.get("error"))[:120]
        return f"invalid:{intended}|{error}"
    if tool == "edit":
        file_path = _normalize_repeat_value(args.get("filePath") or args.get("file") or args.get("path"))
        old_string = _normalize_repeat_value(args.get("oldString") or args.get("old_string"))[:200]
        new_string = _normalize_repeat_value(args.get("newString") or args.get("new_string"))[:200]
        # An edit whose two strings are equal is a no-op whatever the anchor is, and greedy
        # decoding produces it in bulk: generating newString right after oldString puts the
        # model under maximum pressure to copy the span it just emitted, and at temp 0 it
        # never diverges at the one token that would have carried the change.
        #
        # Keying those by (file, old, new) lets the model reset the counter for free, because
        # its recovery heuristic is to SHORTEN the anchor and retry. Measured on
        # task_log_hdfs_failures: steps 19-21 shared a key and reached 3 of the 4 needed, step
        # 22 dropped 'A(f"' from the anchor and restarted the count at 1, so the lock only
        # fired at step 26 after 8 wasted steps. Collapsing every no-op edit on a file to one
        # key makes the existing threshold do what it was meant to do; it would have fired at
        # step 22 on that trace.
        if old_string == new_string:
            return f"edit-noop:{file_path}"
        return f"edit:{file_path}|{old_string}|{new_string}"
    if tool == "write":
        file_path = _normalize_repeat_value(args.get("filePath") or args.get("file") or args.get("path"))
        content = args.get("content")
        digest = hashlib.sha256(str(content or "").encode("utf-8", "replace")).hexdigest()[:16]
        return f"write:{file_path}|{digest}"
    if tool in _REPEAT_SCHEDULER_TOOLS:
        job = _normalize_repeat_value(
            args.get("name") or args.get("job") or args.get("id") or args.get("job_name")
        )
        return f"{tool}:{job}"
    if tool == "get_mcp_status":
        return tool
    return None


def _current_turn_repeat_tools(messages: Any) -> list[str]:
    if not isinstance(messages, list) or not messages:
        return []
    start = 0
    for index in range(len(messages) - 1, -1, -1):
        message = messages[index]
        if isinstance(message, dict) and message.get("role") == "user":
            start = index + 1
            break

    counts: dict[str, int] = {}
    tools_by_key: dict[str, str] = {}
    for message in messages[start:]:
        if not isinstance(message, dict) or message.get("role") != "assistant":
            continue
        tool_calls = message.get("tool_calls")
        if not isinstance(tool_calls, list):
            continue
        for call in tool_calls:
            if not isinstance(call, dict):
                continue
            function = call.get("function")
            if not isinstance(function, dict):
                continue
            tool = function.get("name")
            if not isinstance(tool, str) or tool not in _REPEAT_GUARDED_TOOLS:
                continue
            raw_args = function.get("arguments")
            if isinstance(raw_args, dict):
                args = raw_args
            elif isinstance(raw_args, str):
                try:
                    parsed = json.loads(raw_args)
                except (ValueError, TypeError):
                    continue
                if not isinstance(parsed, dict):
                    continue
                args = parsed
            else:
                continue
            key = _repeat_action_key(tool, args)
            if key is None:
                continue
            counts[key] = counts.get(key, 0) + 1
            tools_by_key[key] = tool

    lock_attempts = _repeat_lock_attempts()
    return sorted({tools_by_key[key] for key, count in counts.items() if count >= lock_attempts})


# ── Unrun-script lock ────────────────────────────────────────────────────────
# local-short.txt already tells a data-analysis turn exactly what to do: write ONE script
# that computes and writes the report, "run it once with bash", then confirm the file. The
# weak local driver follows steps 1-2 and then never runs it.
#
# Measured on task_log_hdfs_failures, twice, identically (temp 0 makes it deterministic):
# read + 13 bash probes of the real log, then `write make_report.py` (14 KB), then five
# `edit` calls on that script, then four whole-file rewrites, then it wandered off into
# `skill` + parse_pdf x5 and hit the step cap. The 13 bash calls all came BEFORE the write,
# so the script it spent ten steps authoring was never executed. The graded workspace
# ended up holding the input log and make_report.py and no report at all, which is what
# L2 0.500 is scoring - an absent deliverable, not a poor one.
#
# The prompt cannot enforce this and the repeat lock cannot see it (each edit differs, so
# no key repeats). So make step 3 the only move available: once a script has been written
# this turn and no bash command has mentioned it since, drop `edit`. `bash` and `write`
# stay, so the model can still run it or replace it wholesale; the sha-keyed write entry in
# _REPEAT_GUARDED_TOOLS bounds the rewrite path.
_SCRIPT_SUFFIXES = (".py", ".sh", ".js", ".rb", ".pl")
_ENV_UNRUN_SCRIPT_LOCK = "SUPERCLAW_UNRUN_SCRIPT_LOCK"
_UNRUN_SCRIPT_EDIT_ATTEMPTS = 2


def _unrun_script_lock_enabled() -> bool:
    raw = (os.environ.get(_ENV_UNRUN_SCRIPT_LOCK) or "").strip().lower()
    return raw not in _REPEAT_LOCK_DISABLED_VALUES


def _basename(path: str) -> str:
    return re.split(r"[\\/]", path.strip())[-1]


def _tool_calls_this_turn(messages: Any) -> list[tuple[str, dict[str, Any]]]:
    """(tool, args) for every assistant tool call since the last user message."""
    if not isinstance(messages, list) or not messages:
        return []
    start = 0
    for index in range(len(messages) - 1, -1, -1):
        message = messages[index]
        if isinstance(message, dict) and message.get("role") == "user":
            start = index + 1
            break
    out: list[tuple[str, dict[str, Any]]] = []
    for message in messages[start:]:
        if not isinstance(message, dict) or message.get("role") != "assistant":
            continue
        calls = message.get("tool_calls")
        if not isinstance(calls, list):
            continue
        for call in calls:
            if not isinstance(call, dict):
                continue
            function = call.get("function")
            if not isinstance(function, dict):
                continue
            tool = function.get("name")
            if not isinstance(tool, str):
                continue
            raw_args = function.get("arguments")
            if isinstance(raw_args, dict):
                args = raw_args
            elif isinstance(raw_args, str):
                try:
                    parsed = json.loads(raw_args)
                except (ValueError, TypeError):
                    continue
                if not isinstance(parsed, dict):
                    continue
                args = parsed
            else:
                continue
            out.append((tool, args))
    return out


def _unrun_scripts(calls: list[tuple[str, dict[str, Any]]]) -> dict[str, int]:
    """Scripts written this turn that no later bash command names, by edit attempts."""
    pending: dict[str, int] = {}
    for tool, args in calls:
        if tool == "bash":
            command = str(args.get("command") or "")
            for name in list(pending):
                if name and name in command:
                    del pending[name]
            continue
        if tool not in ("write", "edit"):
            continue
        path = args.get("filePath") or args.get("file") or args.get("path")
        name = _basename(str(path or ""))
        if not name.endswith(_SCRIPT_SUFFIXES):
            continue
        # An edit registers the script too, not just a write: editing it proves it exists,
        # and the write that created it may sit in an earlier turn or arrive unparsable.
        # Requiring the write first made the lock miss the very trace it was built from.
        pending.setdefault(name, 0)
        if tool == "edit":
            pending[name] += 1
    return pending


def apply_unrun_script_lock(body: dict[str, Any]) -> list[str]:
    """Drop ``edit`` while a script written this turn has still not been run.

    local-short.txt says write ONE script, "run it once with bash", then confirm the file.
    The weak local driver follows steps 1-2 and then edits the script instead of running it.
    Pushing it off ``edit`` is what turned four log_analysis tasks from 0.500 into 0.89-1.00.

    MEASURED DEAD END - do not re-add these three without new evidence. Each was added on top
    of this lock and each made things worse, confirmed by re-running ONE fixed task set:
    5/5 (mean 0.974) with this lock alone, 2/5 (mean 0.648) with all three.
      * a stage 2 that also dropped ``write`` once three unrun scripts existed;
      * a <system-reminder> appended to the last tool result restating "write the file, do
        not print" (instruction fade is real, but this rule sits at 91% of the system prompt
        and the model was not short of the instruction);
      * a floor that kept the last file-producing tool alive.
    The pattern across all of them: removing or adding text changes WHICH wrong thing the
    model does, and every extra constraint pushed it further from writing a real generator.

    Returns the tool names actually removed.
    """
    if not _unrun_script_lock_enabled():
        return []
    pending = _unrun_scripts(_tool_calls_this_turn(body.get("messages")))
    if not any(count >= _UNRUN_SCRIPT_EDIT_ATTEMPTS for count in pending.values()):
        return []
    removed = ["edit"] if apply_drop_tools(body, ["edit"]) else []
    if removed and not body.get("tools"):
        body.pop("tools", None)
        body.pop("tool_choice", None)
    return removed


def apply_repeat_tool_terminal_lock(body: dict[str, Any]) -> list[str]:
    """Drop guarded tools that reached their first blocked repeat this turn.

    With the default ``SC_REPEAT_MAX=2``, the third identical call is the repeat
    plugin's first soft block. If the model ignores it and makes a fourth
    identical call, remove that tool from the next local model request without
    cancelling the session or changing its terminal state to a user abort.
    Returns the tool names actually removed.
    """
    if not _repeat_tool_terminal_lock_enabled():
        return []
    repeated = _current_turn_repeat_tools(body.get("messages"))
    if not repeated or not apply_drop_tools(body, repeated):
        return []
    if not body.get("tools"):
        body.pop("tools", None)
        body.pop("tool_choice", None)
    return repeated


def _request_tool_names(body: dict[str, Any]) -> list[str]:
    names: list[str] = []
    for tool in body.get("tools") or []:
        if not isinstance(tool, dict):
            continue
        function = tool.get("function")
        name = function.get("name") if isinstance(function, dict) else tool.get("name")
        if isinstance(name, str) and name:
            names.append(name)
    return names


_REPEAT_GUIDANCE_MAX_TOOLS = 12


def repeat_lock_guidance(removed: list[str], remaining: list[str]) -> str:
    """Tell the model to switch tools after a lock, naming only tools this request still has."""
    locked = ", ".join(f"'{name}'" for name in removed)
    head = (
        f"The {locked} tool is disabled for the rest of this turn because the same call was repeated "
        "without new results. Do not call it again and do not repeat the previous action. "
    )
    if not remaining:
        return head + (
            "No other tool is available. Reply in plain text: say what you found, what could not be "
            "completed, and what the user can provide to continue."
        )
    ordered = sorted(remaining, key=lambda name: (name not in ("write", "edit"), name))
    shown = ", ".join(f"'{name}'" for name in ordered[:_REPEAT_GUIDANCE_MAX_TOOLS])
    more = ", ..." if len(ordered) > _REPEAT_GUIDANCE_MAX_TOOLS else ""
    text = (
        head
        + "Continue the task from where you are with a different tool. "
        + f"Available tools: [{shown}{more}]. "
    )
    if "write" in remaining:
        text += "If you already have enough, 'write' the best partial result and state what is missing. "
    text += (
        "Otherwise use a search or read tool to find the missing information. If it cannot be obtained "
        "with these tools, tell the user in plain text what you found, what could not be completed, and "
        "what they can provide to continue."
    )
    return text


def apply_repeat_lock_guidance(body: dict[str, Any], removed: list[str]) -> bool:
    """Append the switch-tool guidance as a system message on this request only.

    The message is not part of opencode's stored history, so it is rebuilt on every request while the
    lock holds and never accumulates in the context.
    """
    messages = body.get("messages")
    if not removed or not isinstance(messages, list):
        return False
    messages.append({"role": "system", "content": repeat_lock_guidance(removed, _request_tool_names(body))})
    return True


def strip_leading_agent_mention(body: dict[str, Any], requesting_agent: Optional[str]) -> bool:
    """Strip leading ``@<agent>`` from the latest user message for model input.

    This is a control-plane cleanup only: UI/session history still stores the
    original text with mention, while the upstream model sees the content
    without the dispatch prefix.
    """
    agent = (requesting_agent or "").strip()
    if not agent:
        return False

    msgs = body.get("messages")
    if not isinstance(msgs, list) or not msgs:
        return False

    for idx in range(len(msgs) - 1, -1, -1):
        msg = msgs[idx]
        if not isinstance(msg, dict) or msg.get("role") != "user":
            continue
        content = msg.get("content")
        if not isinstance(content, str):
            return False

        trimmed = content.lstrip()
        prefix = f"@{agent}"
        if not trimmed.lower().startswith(prefix.lower()):
            return False

        boundary = trimmed[len(prefix):len(prefix) + 1]
        if boundary and not _MENTION_BOUNDARY_RE.match(boundary):
            return False

        remainder = re.sub(r"^[\s,.:;!?)}\]]+", "", trimmed[len(prefix):])
        if not remainder.strip():
            return False

        msg["content"] = remainder
        return True

    return False


# ── Hybrid Deep Research terminal lock ────────────────────────────────────────
# The hybrid-deep-research primary agent is a thin dispatcher whose ONLY tool is
# hybrid_dr_post_polish_processor: per turn it calls the tool once, emits one
# status line, and stops. On the LOCAL/edge path the weak on-device driver (the
# ~35B the cloud-model alias falls back to when no cloud is configured) ignores
# that contract and RE-CALLS the tool AFTER it already returned a terminal
# envelope. Each re-call burns one opencode `step`; once the budget is spent the
# turn ends as "MAXIMUM STEPS REACHED" — surfaced as a failure even though the
# FIRST call already published the report (issues #1633 / #1576).
#
# opencode cannot stop this from a plugin: it never sends tool_choice (feature
# requests anomalyco/opencode#14089/#14090 still open), has no runtime tool
# toggle (#15623, closed not-planned), and permission `deny` is ignored on the
# SDK path (#6396). The in-plugin guard can only SOFT-block — a throw surfaces as
# red TOOL_ERROR dots (rejected by #1633), so a re-call still resolves and still
# burns a step. llmrouter is the only component that rewrites the actual model
# request, so the hard stop lives here: once this turn already carries a terminal
# hybrid_dr_post_polish_processor result, drop that tool from the request so the
# weak driver PHYSICALLY cannot re-call it and is forced to answer in text. Same
# mechanism as the `task` drop; local-path + hybrid-dr-agent scoped only.
HYBRID_DR_AGENT = "hybrid-deep-research"
_HYBRID_DR_TOOL = "hybrid_dr_post_polish_processor"
# Terminal envelope statuses the tool RETURNS (not a throw). "running" is
# non-terminal — a legitimate same-turn poll — and must NOT trip the lock.
_HYBRID_DR_TERMINAL_STATUSES = frozenset({"ok", "error", "cancelled"})
# The exact one-line reply the agent prompt mandates per terminal status
# (hybrid-dr-sidecar-primary.txt). On a terminal turn this line is the ONLY
# correct output, so llmrouter emits it directly (proxy short-circuit) rather
# than let the weak driver loop or emit residual tool-call text.
_HYBRID_DR_REPLY = {
    "ok": "Research complete. See the report panel below.",
    "cancelled": "Hybrid Deep Research was cancelled.",
}
_HYBRID_DR_ERROR_FALLBACK = "Hybrid Deep Research could not complete. Please retry."


def _content_as_text(content: Any) -> str:
    """Best-effort string out of an OpenAI message ``content`` that may be a
    plain string or a list of content parts."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for p in content:
            if isinstance(p, dict) and isinstance(p.get("text"), str):
                parts.append(p["text"])
            elif isinstance(p, str):
                parts.append(p)
        return "".join(parts)
    return ""

def _hybrid_dr_terminal_envelope(messages: Any) -> Optional[dict[str, Any]]:
    """Return the terminal DR tool-result envelope in the CURRENT turn, else None.

    "Current turn" = messages AFTER the last ``role="user"`` message, so a
    cross-turn resume (new user message) starts fresh and can re-invoke the tool,
    while a within-turn re-call is caught. The caller scopes this to the
    hybrid-deep-research agent, whose only tool is the DR tool, so any terminal
    tool-result status in the turn is unambiguously the DR tool — read directly
    (mirroring the in-plugin guard's status parse). The last terminal envelope in
    the turn wins (most recent)."""
    if not isinstance(messages, list) or not messages:
        return None
    start = 0
    for i in range(len(messages) - 1, -1, -1):
        m = messages[i]
        if isinstance(m, dict) and m.get("role") == "user":
            start = i + 1
            break
    found: Optional[dict[str, Any]] = None
    for m in messages[start:]:
        if not isinstance(m, dict) or m.get("role") != "tool":
            continue
        raw = _content_as_text(m.get("content")).strip()
        if not raw:
            continue
        try:
            env = json.loads(raw)
        except (ValueError, TypeError):
            continue
        if isinstance(env, dict) and env.get("status") in _HYBRID_DR_TERMINAL_STATUSES:
            found = env
    return found


def hybrid_dr_terminal_reply(messages: Any) -> Optional[str]:
    """The exact one-line reply mandated for a terminal DR turn, or None when the
    turn is not terminal. On a terminal turn the driver's ONLY correct output is
    this line, so llmrouter emits it directly (proxy short-circuit) instead of
    calling the weak model — which would only loop re-calling the tool until
    MAXIMUM STEPS, or emit residual tool-call text when merely denied the tool."""
    env = _hybrid_dr_terminal_envelope(messages)
    if env is None:
        return None
    status = env.get("status")
    if status == "error":
        msg = env.get("message")
        return msg.strip() if isinstance(msg, str) and msg.strip() else _HYBRID_DR_ERROR_FALLBACK
    return _HYBRID_DR_REPLY.get(status, _HYBRID_DR_ERROR_FALLBACK)


def apply_hybrid_dr_terminal_lock(body: dict[str, Any]) -> bool:
    """Fallback for the proxy short-circuit: drop ``hybrid_dr_post_polish_processor``
    from the request once this turn already reached a terminal DR result, so even
    if the short-circuit is disabled the weak local driver can't re-call it into
    MAXIMUM STEPS. Mutates ``body`` in place; returns True when the tool was
    dropped. Caller scopes to the hybrid-deep-research agent on the local path."""
    if _hybrid_dr_terminal_envelope(body.get("messages")) is None:
        return False
    if not apply_drop_tools(body, [_HYBRID_DR_TOOL]):
        return False
    # The DR tool was the agent's only tool, so tools[] is now empty. An empty
    # tools array with a lingering tool_choice confuses some upstreams; make it a
    # clean text completion so the model just replies.
    if not body.get("tools"):
        body.pop("tools", None)
        body.pop("tool_choice", None)
    return True


def apply_model_policy(
    body: dict[str, Any],
    model_id: Optional[str],
    requesting_agent: Optional[str] = None,
) -> dict[str, Any]:
    """Apply local-path transforms to ``body`` in place. Independent axes:

      1. per-MODEL system-prompt swap — keyed on the resolved served
         ``model_id`` via ``model_profiles.json``. Capability-neutral, so it
         runs for every local turn that has a profile.
      2. per-AGENT ``task`` disable — keyed on ``requesting_agent`` via the
         ``LATENTFACTOR_DISABLE_TASK_AGENTS`` env override. This is the ONLY
         way ``task`` is stripped: NEVER by model, so the default agent keeps
         delegation on 4B/9B. opencode.jsonc owns the normal per-agent
         permission; this only force-disables for named agents (benchmarking).
      3. per-SUPERCLAW AGENT TURN repeated-tool lock — removes a guarded tool
         once identical calls reach the repeat guard's first blocked attempt.

    Call ONLY on the local/edge path. Returns a dict describing what was applied
    (for logging); empty when nothing matched.
    """
    applied: dict[str, Any] = {}
    agent = (requesting_agent or "").strip()

    # Two classes of agent keep the prompt opencode gave them (see the module
    # constants): infrastructure agents, which do meta-work on the conversation
    # rather than the user's task, and specialist sub-agents, whose behavioural
    # contract — including when to stop — is encoded in their own prompt.
    profile = get_profile(model_id)
    if profile and agent not in _PROMPT_SWAP_EXEMPT_AGENTS:
        prompt_file = profile.get("system_prompt")
        if prompt_file and _should_apply_system_prompt(requesting_agent):
            text = _load_prompt(prompt_file)
            if text and apply_system_prompt(body, text):
                applied["system_prompt"] = prompt_file

    # Run after prompt replacement so late system instructions are merged into
    # the final prompt rather than being discarded by the replacement above.
    if apply_qwen_system_compat(body, model_id):
        applied["qwen_system_message_compat"] = True

    # task disable is agent-scoped + env-driven, independent of the model.
    if agent and agent in _task_disabled_agents():
        n = apply_drop_tools(body, ["task"])
        if n:
            applied["task_disabled_for_agent"] = agent

    # Hybrid Deep Research terminal lock — once this turn already produced a
    # terminal DR result, drop the DR tool so the weak local driver can't re-call
    # it into MAXIMUM STEPS (issues #1633 / #1576). Agent-scoped; independent of
    # model/profile (applies to whatever local SKU is driving).
    if agent == HYBRID_DR_AGENT and apply_hybrid_dr_terminal_lock(body):
        applied["hybrid_dr_terminal_lock"] = True


    if agent:
        repeated_tools = apply_repeat_tool_terminal_lock(body)
        if repeated_tools:
            applied["repeat_tool_terminal_lock"] = repeated_tools
            if _repeat_lock_guidance_enabled() and apply_repeat_lock_guidance(body, repeated_tools):
                apply_qwen_system_compat(body, model_id)
                applied["repeat_lock_guidance"] = True

    # Unrun-script lock — a data-analysis turn that authored a report generator and then
    # kept editing it instead of running it never produces a deliverable. Runs after the
    # repeat lock so a tool already dropped there is not counted twice.
    if agent:
        unrun_tools = apply_unrun_script_lock(body)
        if unrun_tools:
            applied["unrun_script_lock"] = unrun_tools


    return applied


def _reset_caches_for_tests() -> None:
    """Test hook: clear the profile + prompt caches."""
    _load_profiles.cache_clear()
    _load_prompt.cache_clear()
