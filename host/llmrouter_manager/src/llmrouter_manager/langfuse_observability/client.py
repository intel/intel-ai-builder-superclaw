from __future__ import annotations
import json
from functools import lru_cache
from typing import Any
from langfuse import Langfuse

from llmrouter_manager.telemetry import (
    is_debug_observability_enabled,
    observability_payloads_withheld,
)

# Generation/trace names produced by generation_name_for_messages() and
# trace_name_for_messages() below. Named so dispatch.py/proxy.py can compare
# against them instead of re-typing the literal at each call site.
GENERATION_NAME_CHAT_COMPLETION = "chat-completion"
GENERATION_NAME_TITLE_GENERATION = "title-generation"
GENERATION_NAME_TOOL_RESULT = "chat-completion-tool-result"


@lru_cache(maxsize=1)
def get_langfuse_client() -> Langfuse:
    """
    Helper function to get a Langfuse client instance.
    Cache to only keep one client instance.

    Gated by SUPERCLAW_DEBUG_OBSERVABILITY (the same dev/debug-build flag
    ServiceHub already threads down for other debug-only surfaces): off in
    installer/release builds, on in `pnpm dev`/debug builds. When disabled,
    the Langfuse SDK's own `enabled=False` makes every trace()/generation()
    call downstream a safe no-op (no network calls) -- callers in this
    module don't need to branch on it themselves.
    """
    return Langfuse(enabled=is_debug_observability_enabled())


def _text_from_content(content: Any) -> str:
    """Flatten an OpenAI-style message ``content`` field to plain text.

    OpenCode's main-agent requests send user ``content`` as a list of typed
    parts (``[{"type": "text", "text": ...}, ...]``) rather than a plain
    string -- only subagent/scripted callers send bare strings. Anything that
    names or previews a message must accept both shapes, otherwise every
    main-agent trace falls back to a generic name (the original "every trace
    is called chat-completion" bug).
    """
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                text_val = block.get("text")
                if isinstance(text_val, str) and text_val:
                    parts.append(text_val)
        return "\n".join(parts)
    return ""


TRACE_NAME_WITHHELD = "on-device (content withheld)"
"""Trace name for a request whose content must not be exported.

Names the REASON rather than falling back to something generic: a reviewer
looking at a nameless trace would reasonably file a bug against the naming
code, where this says the export was declined on purpose.
"""


def generation_name_for_messages(
    messages: list[dict] | None,
    hdr_phase: str | None = None,
    call_kind: str | None = None,
) -> str:
    """Human-readable Langfuse generation name inferred from the request's
    message list.

    Multiple LLM calls now share one Langfuse trace per OpenCode turn (see
    ``trace_id`` wiring in proxy.py/dispatch.py), so without this every call
    in that trace showed up as an identical, indistinguishable "llm-model"
    node -- callers had to open each observation to tell a title-generation
    call apart from the agent's actual tool/response turns.

    ``hdr_phase``: the Hybrid Deep Research sidecar (hdr-sidecar) drives its
    own tool dispatch as plain Python function calls instead of OpenAI
    tool_calls/tool-role messages, and never sends a "title generator"
    system prompt either -- so every one of its ~9 pipeline-phase LLM calls
    (plan/fill/polish/etc, a mix of cloud-model and local-model) has neither
    signal below and used to collapse into the same generic
    "chat-completion" name. The sidecar now sends its phase name in the
    ``X-Hybrid-DR-Phase`` request header (see proxy.py/dispatch.py), which
    takes priority over the message-shape heuristics below.

    ``call_kind``: non-OpenCode host services (e.g. the intent classifier)
    also call the router without any of the message-shape signals below;
    they self-describe via the ``X-Superclaw-Call-Kind`` request header
    (e.g. "intent-classification") so their generations stop collapsing
    into anonymous "chat-completion" nodes.
    """
    if hdr_phase:
        return f"hdr-{hdr_phase}"
    if call_kind:
        return call_kind
    msgs = messages or []
    for m in msgs:
        if isinstance(m, dict) and m.get("role") == "system":
            content = m.get("content")
            if isinstance(content, str) and "title generator" in content.lower():
                return GENERATION_NAME_TITLE_GENERATION
            break  # only the leading system message carries this signal
    # Only the LAST message decides this -- once a conversation has used a
    # tool even once, every later message list still carries those old tool
    # messages earlier in the array. Checking "any" tool message anywhere in
    # history (the original implementation) therefore misclassified every
    # later call in the conversation as a tool-result followup forever,
    # including genuinely fresh user turns -- which in turn meant the
    # trace-level input seeded in proxy.py/dispatch.py (gated on gen_name ==
    # "chat-completion") never fired for those traces either.
    if msgs and isinstance(msgs[-1], dict) and msgs[-1].get("role") == "tool":
        return GENERATION_NAME_TOOL_RESULT
    return GENERATION_NAME_CHAT_COMPLETION


_MAX_TRACE_NAME_LEN = 80


def trace_name_for_messages(
    messages: list[dict] | None,
    hdr_phase: str | None = None,
    call_kind: str | None = None,
) -> str:
    """Human-readable Langfuse trace name.

    Every trace used to be named the fixed literal "chat-completion",
    making the traces list indistinguishable at a glance -- every row
    showed the same name regardless of what was actually asked. Instead,
    derive a short preview of the current turn's user message so different
    prompts are recognizable without opening each trace.

    ``hdr_phase``: truthy whenever this call is part of a Hybrid Deep
    Research run (see generation_name_for_messages docstring for why HDR
    calls can't be named from message shape). All of one HDR run's calls
    now share a single trace (see ``X-Hybrid-DR-Run-Id`` wiring in
    proxy.py/dispatch.py), so a single constant name identifies it as one
    research run; the per-phase detail lives on each generation instead.

    ``call_kind``: self-described non-OpenCode callers (see
    generation_name_for_messages) get ``"<call_kind>: <user preview>"`` so
    e.g. classifier traces read "intent-classification: <what was
    classified>" instead of an anonymous prompt-text row.
    """
    if hdr_phase:
        return "hybrid-deep-research"
    preview = ""
    for m in reversed(messages or []):
        if isinstance(m, dict) and m.get("role") == "user":
            # Accept both plain-string and content-parts user messages --
            # OpenCode main-agent turns send parts, so requiring a bare str
            # here made every main-agent trace fall back to the literal
            # "chat-completion" (the "trace names are unreadable" bug).
            preview = " ".join(_text_from_content(m.get("content")).split())
            break  # only the LAST user message counts; stop at first match
    if call_kind:
        name = f"{call_kind}: {preview}" if preview else call_kind
        return name[:_MAX_TRACE_NAME_LEN]
    return preview[:_MAX_TRACE_NAME_LEN] if preview else GENERATION_NAME_CHAT_COMPLETION


def scoped_input_for_generation(messages: list[dict] | None, gen_name: str) -> Any:
    """Trim the message list Langfuse displays as a generation's ``input``.

    ``chat-completion``/``title-generation`` calls get the full message list
    unchanged -- that's the meaningful context for those. A
    ``chat-completion-tool-result`` call, however, repeats the entire
    growing conversation (system prompt, skill listings, every earlier tool
    round) every time; across a long tool-calling loop this turns each
    generation's input into an indistinguishable wall of history instead of
    showing what's new for that node. Trim to the assistant tool-call that
    triggered this round plus its tool result(s) -- the part actually worth
    inspecting per node. The full history is still what's sent upstream to
    the model; this only affects what gets logged to Langfuse.
    """
    msgs = messages or []
    if gen_name != GENERATION_NAME_TOOL_RESULT or not msgs:
        return msgs
    for i in range(len(msgs) - 1, -1, -1):
        m = msgs[i]
        if isinstance(m, dict) and m.get("role") == "assistant" and m.get("tool_calls"):
            return msgs[i:]
    # Fallback: no assistant/tool_calls marker found (unexpected shape) --
    # show the last two messages rather than the entire history.
    return msgs[-2:]


def last_user_message_content(messages: list[dict] | None) -> Any:
    """Extract the most recent user-role message content.

    Used to seed the trace-level ``input`` with the actual user prompt
    (instead of leaving it ``null``) the first time a turn's trace is
    created. Content-parts messages (OpenCode main-agent turns) are
    flattened to their text so the trace input reads as prose instead of a
    JSON parts array; non-text-only parts fall back to the raw content.
    """
    for m in reversed(messages or []):
        if isinstance(m, dict) and m.get("role") == "user":
            content = m.get("content")
            if isinstance(content, list):
                flattened = _text_from_content(content)
                return flattened if flattened else content
            return content
    return None


_MODEL_PARAM_KEYS = (
    "temperature",
    "top_p",
    "top_k",
    "max_tokens",
    "max_completion_tokens",
    "frequency_penalty",
    "presence_penalty",
    "seed",
    "stop",
    "n",
    "reasoning_effort",
)


def model_parameters_from_body(body: dict | None) -> dict[str, Any]:
    """Extract the OpenAI sampling/limit params present in a request body.

    Returns only keys the caller actually sent (no defaults invented), so
    what lands in Langfuse is exactly what went upstream. Scalar values pass
    through; non-scalar ones (e.g. a ``stop`` list) are JSON-encoded because
    Langfuse ``model_parameters`` values must be scalars.
    """
    params: dict[str, Any] = {}
    if not isinstance(body, dict):
        return params
    for key in _MODEL_PARAM_KEYS:
        if key not in body:
            continue
        value = body.get(key)
        if value is None:
            continue
        if isinstance(value, (str, int, float, bool)):
            params[key] = value
        else:
            try:
                params[key] = json.dumps(value)
            except (TypeError, ValueError):
                params[key] = str(value)
    return params


def build_trace_and_generation(
    *,
    messages: list[dict] | None,
    hdr_phase: str | None,
    call_kind: str | None,
    trace_id: str | None,
    session_id: str | None,
    langfuse_session_id: str | None,
    kind: str,
    req_stream: bool,
    provider: str,
    model_id: str,
    tools_present: bool,
    upstream_payload: dict,
) -> tuple[Any, Any, str]:
    """Create the Langfuse trace + generation shared by cloud (LiteLLM,
    ``dispatch.py``) and local/edge (httpx, ``proxy.py``) dispatch, before
    either branches into its own streaming/non-streaming handling.

    ``id=trace_id`` merges every LLM call that shares the same OpenCode
    message id (e.g. a title-gen call + the real response, or multiple
    calls within one tool-call round trip) into a single Langfuse trace
    instead of each call getting its own flat trace. ``trace_id`` falls back
    to a per-request random id when no message id is available, preserving
    one-trace-per-call behavior for that case.

    Traces are grouped under the PARENT OpenCode session when the request
    comes from a subagent (child session): otherwise one user turn that
    fans out to subagents shows up as several near-duplicate rows on the
    Langfuse sessions page (same user text, different session ids). The
    child id is kept in metadata for drill-down. Token accounting
    (``record_usage``) keeps the child session id on purpose -- only
    Langfuse grouping changes.

    ``kind`` is the dispatch source recorded on the trace metadata
    ("cloud" / "local" / "edge"). ``upstream_payload`` is the exact request
    body sent to the provider (LiteLLM kwargs or the httpx JSON body) --
    used only to surface the sampling/limit params that were actually sent,
    both in trace metadata and as the generation's native
    ``model_parameters``.

    Returns ``(lf_trace, lf_generation, gen_name)``.
    """
    obs_client = get_langfuse_client()
    gen_name = generation_name_for_messages(messages, hdr_phase, call_kind)
    lf_session_id = langfuse_session_id or session_id
    lf_metadata: dict[str, Any] = {
        "kind": kind,
        "stream": req_stream,
        "provider": provider,
        "model": model_id,
        "tools": tools_present,
    }
    if session_id and lf_session_id != session_id:
        lf_metadata["subagent_session_id"] = session_id
    lf_model_params = model_parameters_from_body(upstream_payload)
    if lf_model_params:
        lf_metadata["model_parameters"] = lf_model_params
    # A caller that demanded an on-device guarantee gets its CONTENT withheld
    # from the export. All four transcript-derived values below are content: the
    # trace name is inferred from the messages, and the two inputs are the
    # messages. The trace itself still goes out -- model, latency, tokens,
    # metadata -- because none of that is derived from what the user said. See
    # `telemetry.withhold_observability_payloads_for_this_request`.
    withheld = observability_payloads_withheld()
    lf_trace = obs_client.trace(
        id=trace_id,
        name=(
            TRACE_NAME_WITHHELD
            if withheld
            else trace_name_for_messages(messages, hdr_phase, call_kind)
        ),
        session_id=lf_session_id,
        metadata=lf_metadata,
    )
    if not withheld and (
        gen_name == GENERATION_NAME_CHAT_COMPLETION or hdr_phase or call_kind
    ):
        # First (non-title-gen, non-tool-followup) call of the turn -- seed
        # the trace-level input with the real user prompt so the trace
        # itself is reviewable without opening a child observation.
        lf_trace.update(input=last_user_message_content(messages))
    lf_generation = lf_trace.generation(
        name=gen_name,
        model=model_id,
        input=None if withheld else scoped_input_for_generation(messages, gen_name),
        model_parameters=lf_model_params or None,
    )
    return lf_trace, lf_generation, gen_name


def finalize_generation_and_trace(
    lf_generation: Any,
    lf_trace: Any,
    gen_name: str,
    *,
    output: Any,
    prompt_tokens: int | None,
    completion_tokens: int | None,
    finish_reason: str | None,
) -> None:
    """End a Langfuse generation with its final output/usage, and -- for a
    real final answer, as opposed to a title-gen call or a tool-call turn
    awaiting another round trip -- mirror that output onto the trace level
    too, so the trace itself is reviewable without opening the child
    generation.

    The completion is content, so it is withheld for a caller that demanded an
    on-device guarantee -- a cleaned-up dictation is the user's own words with
    the filler removed, which is no safer to export than the raw transcript.
    Usage and ``finish_reason`` still go out: they are what makes the trace worth
    having and neither is derived from what was said. This runs AFTER the handler
    returned on the streaming path, which is why the flag it reads is set without
    a scope.
    """
    withheld = observability_payloads_withheld()
    lf_generation.end(
        output=None if withheld else output,
        usage={"promptTokens": prompt_tokens, "completionTokens": completion_tokens},
        metadata={"finish_reason": finish_reason},
    )
    if (
        not withheld
        and gen_name != GENERATION_NAME_TITLE_GENERATION
        and finish_reason == "stop"
    ):
        lf_trace.update(output=output)