"""Data-plane proxy: /v1/chat/completions, /v1/models, /v1/pii/level.

Routes cloud requests through LiteLLM (cloud/dispatch.py); local + edge
requests through direct httpx passthrough. Resolves the model alias
(auto / local-model / cloud-model) to the right (kind, cfg) pair, then
dispatches. Fires the record_usage hook after each request (cloud path in
dispatch.py, local + edge path here).

PII sanitize/restore hook is reserved per #681 — currently inert (no
upstream sanitization wired).
"""

from __future__ import annotations

import asyncio
import copy
import json
import os
import secrets
import time
from dataclasses import dataclass
from typing import Any, Callable, Optional, cast

import httpx
from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from loguru import logger
from opentelemetry.trace import Tracer, Span

from ..cloud.dispatch import _call_via_litellm
from ..common.env_resolve import _read_float_env
from ..common.errors import error_response
from ..common.events import (
    EventContext,
    EventType,
    record_event,
    set_event_context,
    should_write,
)
from ..common.http_client import build_async_client_for_url
from ..common.model_prefix import (
    format_model_prefix,
    inject_into_non_streaming_result,
    inject_into_sse_bytes,
    sanitize_assistant_history,
)
from ..common.state import default_state_root, read_encrypted_json, read_json
from ..common.store import Store, default_db_path
from ..local import mock_bundle
from ..common.tools import (
    harden_tool_call_stream,
    sanitize_tool_schemas_for_local_grammar,
    set_repeat_locked_tools,
    should_harden_kind,
)
from ..common.telemetry_metrics import emit_llm_request_metrics as _emit_llm_request_metrics
from ..common.usage import Source, record_usage
from ..langfuse_observability.client import (
    build_trace_and_generation,
    finalize_generation_and_trace,
)
from ..local.llama_auth import llama_api_key
from ..local.selections import get_local_provider
from ..telemetry import tracing
from .policy.compaction_tracker import CompactionTracker
from .policy.config import RoutingPolicyConfig
from .policy.context_cap import _probe_server_n_ctx
from .policy.middleware import (
    COMPACT,
    ESCALATE,
    PROCEED,
    decide_over_limit,
    resolve_cap_from_probe,
)
from .policy.prompt_transform import (
    HYBRID_DR_AGENT,
    apply_model_policy,
    apply_qwen_system_compat,
    hybrid_dr_terminal_reply,
    strip_leading_agent_mention,
)
from .policy.tokens import request_token_len
from .policy.tool_retry import harden_with_retries, resolve_hardening_max_retries
from .context_ledger import (
    build_context_ledger,
    read_budget_headers,
    safe_ledger_attrs,
)
from .local_admission import LocalRequestLease
from .primary_bundle import resolve_primary
from .upstream_errors import upstream_error_object


# `/v1/chat/completions` accepts only these aliases; anything else is a client
# error and MUST fail closed (not silently misroute to cloud via the
# `_resolve_alias` wildcard fallthrough).
_KNOWN_MODEL_ALIASES = frozenset(("auto", "local-model", "cloud-model"))


# ── Serving-policy state (ported from routing_service; see policy/) ──────────
# Single process-local tracker for per-session compaction budget / stickiness.
# Correct only single-worker (plan §5d). Lazily created so the module imports
# without side effects and tests can reset it.
_compaction_tracker: Optional[CompactionTracker] = None
# Cache of probed server n_ctx keyed by local base_url, so we probe once per
# distinct local slot rather than per request. Value shape:
#   (n_ctx, cached_at_monotonic)
# n_ctx is an int on success or None on probe failure. BOTH are TTL-bounded:
# although llama-server's -c doesn't change per-request, it DOES change when the
# ctx-size override is applied (GUI slider → PUT /local/ctx-size → supervisor
# restart with a new -c; also the boot override and the booster's hardware
# shrink). A success cached "forever" would pin the OLD n_ctx, so the derived
# context cap (and the read guard's derived threshold, which reads the same
# endpoint) would keep using the stale window. The ctx-PUT invalidates this
# cache explicitly (invalidate_local_n_ctx_cache) for instant effect; the
# positive TTL is the safety net for the paths that don't call it.
_probed_n_ctx_cache: dict[str, tuple[Optional[int], float]] = {}

# TTL for negative n_ctx probe results. Long enough to shield a bench run from
# repeatedly eating a ~2s connect timeout per turn when local is down; short
# enough that operator restart of llama-server recovers on the next request.
# 30s matches the ready_timeout_s ServiceHub uses for llmrouter_manager, so a
# co-restart of the whole host will be past this window by the time the first
# real chat request arrives.
_PROBE_FAILURE_TTL_S: float = 30.0

# TTL for a SUCCESSFUL n_ctx probe. -c is stable between restarts, so a cheap
# local /v1/models re-probe once per minute is negligible, and it bounds how
# long a ctx change can go unnoticed if the explicit invalidation is ever missed.
_PROBE_SUCCESS_TTL_S: float = 60.0


def invalidate_local_n_ctx_cache() -> None:
    """Drop the cached local n_ctx probe so the next request re-probes the live
    llama-server. Call this right after the local -c changes (ctx-size override
    applied + supervisor restarted) so the derived context cap reflects the new
    window immediately instead of waiting out the positive TTL."""
    _probed_n_ctx_cache.clear()


def _get_compaction_tracker(policy: RoutingPolicyConfig) -> CompactionTracker:
    """Return the process-wide tracker, (re)building it if the budget knob
    changed (e.g. an experiment env flip between requests in dev)."""
    global _compaction_tracker
    t = _compaction_tracker
    if (t is None
            or t.max_local_compaction != policy.max_local_compaction
            or t.fresh_read_jump_tokens != policy.fresh_read_jump_tokens):
        t = CompactionTracker(
            max_local_compaction=policy.max_local_compaction,
            fresh_read_jump_tokens=policy.fresh_read_jump_tokens,
        )
        _compaction_tracker = t
    return t


def _probe_local_n_ctx_cached(cfg: "LLMConfig") -> Optional[int]:
    """Probe (and cache) the local slot's live context length. One network
    probe per distinct base_url. Semantics:

      * **Success (int result)** — cached for ``_PROBE_SUCCESS_TTL_S`` seconds,
        then re-probed. llama-server's ``-c`` is stable between restarts, so a
        cheap re-probe once per TTL is negligible; the bound exists so a
        ctx-size change (new ``-c`` after a ctx-size PUT / booster shrink) is
        picked up even if the explicit ``invalidate_local_n_ctx_cache()`` was
        missed. The ctx-size PUT invalidates this cache directly for instant
        effect.
      * **Failure (None result)** — cached for ``_PROBE_FAILURE_TTL_S`` seconds
        so a transiently-down server recovers automatically once it comes
        back up, without an llmrouter_manager restart. Without the TTL a
        single startup-race failure would pin the negative cache forever
        and force operators to restart the whole host to recover.
      * **Empty ``base_url``** — short-circuits to ``None`` without probing
        (misconfigured local slot; a subsequent config change with a real
        base_url probes fresh).

    Shields the hot path from re-eating a ~2s connect timeout + WARNING log
    line on every request when local is unreachable."""
    key = (cfg.base_url or "").strip()
    if not key:
        return None
    now = time.monotonic()
    cached = _probed_n_ctx_cache.get(key)
    if cached is not None:
        value, cached_at = cached
        if value is not None:
            # Success — honor the positive TTL, then fall through to re-probe so
            # a ctx-size change (new -c) is picked up even if the explicit
            # invalidation was missed.
            if now - cached_at < _PROBE_SUCCESS_TTL_S:
                return value
        else:
            # Failure — honor the failure TTL, then fall through to re-probe.
            if now - cached_at < _PROBE_FAILURE_TTL_S:
                return None
    n_ctx = _probe_server_n_ctx(key, api_key=cfg.api_key, model=cfg.model_id)
    _probed_n_ctx_cache[key] = (n_ctx, now)
    return n_ctx


def _current_bundle_id(app_state: Any) -> str | None:
    """Committed chat Bundle id, for ``context.overflow`` attribution.

    The cap is load-bearing and so is the Bundle behind it: the SAME workload
    overflows at 90,784 (``local-35b``) and sails through at 252,928
    (discrete-B70 ``local-27b``). A row without its Bundle is unreadable six
    weeks later. Best-effort — this is only reached on the overflow path, and a
    store hiccup must not turn an error row into an exception.
    """
    try:
        primary = resolve_primary(app_state, role="chat")
    except Exception:  # noqa: BLE001
        return None
    return primary.bundle_id if primary is not None else None


def _compact_locally_response(model_id: str, req_tokens: int, cap: int) -> JSONResponse:
    """Synthetic error opencode classifies as a context overflow
    (provider/error.ts: body.error.code === "context_length_exceeded"),
    triggering its compaction-and-retry path."""
    return JSONResponse(
        status_code=400,
        content={"error": {
            "code": "context_length_exceeded",
            "type": "invalid_request_error",
            "message": (
                f"Input ({req_tokens} tokens) exceeds the context window "
                f"of {model_id!r} ({cap}). Compact and retry."
            ),
        }},
        headers={
            "x-latentfactor-routed-to": model_id,
            "x-latentfactor-compact-locally": "1",
        },
    )


def _hybrid_dr_shortcircuit_response(model_id: str, line: str, req_stream: bool) -> Any:
    """Synthesize the mandated one-line Hybrid-DR terminal reply as a normal
    OpenAI chat completion (stream or non-stream), WITHOUT calling the model.

    On a turn that already carries a terminal DR result the driver's only correct
    output is this line; the weak local model instead loops re-calling the tool
    until MAXIMUM STEPS, or (when the tool is merely dropped) emits residual
    ``<tool_call>`` text. Emitting the line here removes the model from a turn
    whose output is fully determined, so there is nothing to loop on and no
    tool-call text for opencode to re-parse. Prefixed like every other local
    reply via ``format_model_prefix`` so it is indistinguishable downstream."""
    prefix = format_model_prefix(model_id) or ""
    content = f"{prefix}{line}"
    created = int(time.time())
    cid = f"chatcmpl-hdrlock-{secrets.token_hex(8)}"
    usage = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
    if not req_stream:
        return JSONResponse(
            status_code=200,
            content={
                "id": cid, "object": "chat.completion", "created": created, "model": model_id,
                "choices": [{
                    "index": 0,
                    "message": {"role": "assistant", "content": content},
                    "finish_reason": "stop",
                }],
                "usage": usage,
            },
            headers={"x-latentfactor-routed-to": model_id, "x-hybrid-dr-terminal-lock": "1"},
        )

    def _chunk(delta: dict, finish: Any = None) -> dict:
        return {
            "id": cid, "object": "chat.completion.chunk", "created": created, "model": model_id,
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
        }

    async def _stream() -> Any:
        yield f"data: {json.dumps(_chunk({'role': 'assistant'}))}\n\n".encode("utf-8")
        yield f"data: {json.dumps(_chunk({'content': content}))}\n\n".encode("utf-8")
        final = _chunk({}, finish="stop")
        final["usage"] = usage
        yield f"data: {json.dumps(final)}\n\n".encode("utf-8")
        yield b"data: [DONE]\n\n"
    return StreamingResponse(
        _stream(), media_type="text/event-stream",
        headers={"x-hybrid-dr-terminal-lock": "1"},
    )




def _reset_policy_state_for_tests() -> None:
    """Test hook: clear the process-wide tracker + probe cache."""
    global _compaction_tracker
    _compaction_tracker = None
    _probed_n_ctx_cache.clear()
    _lrm_trigger_pending.clear()


# ── Compaction authority attribution ─────────────────────────────────────────
# A compaction-summary request reaches LRM with ``Superclaw-Agent: compaction``
# (plugin 91 forwards opencode's agent name; the fork's session/compaction.ts
# runs the summary as the `compaction` agent). That request is OBSERVED, not
# inferred, so it is honest to record it as ``context.compaction_triggered``.
# Whose decision it was: if LRM sent this session a synthetic 400 moments
# earlier, the summary is the consequence of LRM's own trigger (already
# recorded with ``authority: lrm``) and must not be counted twice; otherwise
# opencode decided on its own (post-step ``isOverflow``, or a manual
# ``/compact``) and the row says ``authority: opencode``. The *why* is wave 2's
# ``x-opencode-request-kind`` header; wave 1 records only what LRM saw.
#
# Keyed by the event session id (``X-Opencode-Session-Id``). The pending mark
# is consumed by the next summary request and expires on its own: opencode
# issues the summary within seconds of the 400, so a mark older than the TTL
# belongs to a client that never compacted, and must not attribute a later,
# unrelated compaction to LRM. Process-local like the tracker (single worker).
_lrm_trigger_pending: dict[str, tuple[float, str]] = {}  # session -> (when, chat_req_id)
_LRM_TRIGGER_PENDING_TTL_S: float = 300.0
_LRM_TRIGGER_PENDING_MAX = 4096
COMPACTION_AGENT = "compaction"


def _note_lrm_trigger(session_id: Optional[str], now: float, chat_req_id: str) -> None:
    if not session_id:
        return
    if len(_lrm_trigger_pending) >= _LRM_TRIGGER_PENDING_MAX:
        stale = [s for s, (t, _) in _lrm_trigger_pending.items() if now - t > _LRM_TRIGGER_PENDING_TTL_S]
        for s in stale:
            _lrm_trigger_pending.pop(s, None)
        if len(_lrm_trigger_pending) >= _LRM_TRIGGER_PENDING_MAX:
            _lrm_trigger_pending.clear()
    _lrm_trigger_pending[session_id] = (now, chat_req_id)


def _consume_lrm_trigger(session_id: Optional[str], now: float, chat_req_id: str) -> bool:
    """True iff an EARLIER request in this session got LRM's synthetic 400
    within the TTL. Consumes the mark (an expired mark is dropped, not
    honoured). A mark set by ``chat_req_id`` itself — a summary request that
    was over the cap and got 400'd in the same call — is left in place for the
    summary that follows it, and does not count as "preceded"."""
    if not session_id:
        return False
    marked = _lrm_trigger_pending.get(session_id)
    if marked is None:
        return False
    when, by = marked
    if by == chat_req_id:
        return False
    _lrm_trigger_pending.pop(session_id, None)
    return (now - when) <= _LRM_TRIGGER_PENDING_TTL_S


# Relative difference above which the fork engine's D2 next-request estimate
# and LRM's own tokenizer-based count are considered to have drifted enough to
# warrant a log line. Both numbers are always computed now (the larger one
# governs admission, see chat_completions), so the line is unconditional at
# this threshold; the former LRM_TOKEN_ESTIMATE_CROSSCHECK opt-in is gone.
# Measured on the real 4B (2026-09-17): opencode's chars/4 header reads
# 0.45–0.56x the server's count on log/CSV bodies and ~1.05x on prose.
_TOKEN_ESTIMATE_DRIFT_WARN_RATIO = 0.3


# Loose chars/token floor used to sanity-check x-opencode-next-request-estimate
# before letting it govern req_tokens (see chat_completions). Real tokenizers
# rarely compress text below this ratio — policy/tokens.py's own worked example
# (~1120 chars of Chinese -> 520 tokens, ~2.15 chars/token) is well above it —
# so a genuine estimate should always clear this floor. Since admission is
# max(header, LRM count) the floor only decides whether the header may be
# NAMED as the governing side; a spoofed near-zero header can no longer lower
# req_tokens below the LRM count either way.
_MIN_CHARS_PER_TOKEN = 6


def _cheap_token_floor(body: dict) -> int:
    """Cheap (no-tokenizer) lower bound on this request's real token count.

    The header is client-supplied and, per ``_read_int_header``'s own
    docstring, untrusted at this boundary: a spoofed near-zero (or otherwise
    implausibly small) estimate must not be reported as the governing
    estimate. Only messages are counted
    (tools/tool_calls are extra content the real count also includes, so this
    stays a lower, never an over-, bound).
    """
    try:
        raw = json.dumps(body.get("messages", []), default=str, ensure_ascii=False)
    except Exception:  # noqa: BLE001
        raw = str(body.get("messages", ""))
    return len(raw) // _MIN_CHARS_PER_TOKEN



# Digit-length cap for _read_int_header. Real token counts never approach this
# many digits, and rejecting up front avoids handing int() an attacker-sized
# digit string (int(str) is O(n^2) and CPython additionally hard-errors past
# sys.get_int_max_str_digits(), which _read_int_header must not raise on).
_MAX_INT_HEADER_DIGITS = 15


def _read_int_header(request: Request, name: str) -> Optional[int]:
    """Parse a non-negative integer header, tolerating absence or garbage.

    Headers are client-supplied (the fork engine, but still untrusted input at
    this boundary) — a missing, non-numeric, negative, or oversized value must
    fall back to the caller's own computation rather than raise or silently
    coerce to 0.
    """
    raw = (request.headers.get(name) or "").strip()
    if not raw.isdigit() or len(raw) > _MAX_INT_HEADER_DIGITS:
        return None
    return int(raw)


def _sanitize_session_id(raw: str) -> str:
    """Return a URL-safe ASCII subset of *raw* for use as a session id.

    ``superclaw-session`` is a client-supplied HTTP header, so its content
    reaches logs, dict keys, and per-session policy state without any
    guarantee it's benign. Two failure modes we protect against:

      * **Log injection.** Control characters (``\\n``, ``\\r``, ``\\t``) or
        ANSI escapes in a session id would fragment log lines and confuse
        log-processing pipelines. Every non-``[A-Za-z0-9_-]`` character
        collapses to ``-`` so a raw header can never break the log format.
      * **Dict-key surprises.** The tracker uses the id as a dict key; a
        session id containing NUL or unpaired surrogates would still be a
        valid Python string but a headache for anyone dumping the state.

    Collapsing to ``-`` is asymmetric — ``ses_foo\\nbar`` and ``ses_foo-bar``
    map to the same value — but real opencode session ids are already
    ``ses_<hex>`` (URL-safe), so collisions on well-formed input don't
    happen. ``.strip("-")`` removes leading/trailing markers so the sanitized
    form matches what a legitimate client would send verbatim. Length is
    capped at 64 to match the previous behaviour.
    """
    stripped = raw.strip()
    if not stripped:
        return ""
    return "".join(
        c if (c.isascii() and (c.isalnum() or c in "_-")) else "-"
        for c in stripped
    ).strip("-")[:64]


def _sanitize_agent_name(raw: str) -> str:
    """Return the header-safe agent name for *raw* — the SAME rule plugin 91
    (``sandbox/agent_config/profiles/*/plugins/91_agent_context_header.ts``,
    ``sanitizeAgentName``) applies before sending ``Superclaw-Agent``:
    lowercase, every non-``[a-z0-9_-]`` character collapses to ``-``, runs of
    ``-`` collapse, leading/trailing ``-`` are stripped, 64 chars max.

    Defence in depth: the plugin already sanitises, but the header is
    client-supplied and the value reaches the event ``agent`` column, the
    span name and every ``chat.*`` log line, so a control character, ANSI
    escape or NUL from any other client must not get that far. Applying the
    plugin's exact rule keeps a well-formed header byte-identical, so agent
    comparisons (``HYBRID_DR_AGENT``, ``COMPACTION_AGENT``) are unaffected.
    """
    stripped = raw.strip().lower()
    if not stripped:
        return ""
    collapsed = "".join(
        c if (c.isascii() and (c.isalnum() or c in "_-")) else "-"
        for c in stripped
    )
    while "--" in collapsed:
        collapsed = collapsed.replace("--", "-")
    return collapsed.strip("-")[:64]


def _last_user_msg_text(messages: Any) -> str:
    """Return concatenated text of the LAST ``role="user"`` message (reverse walk).

    Handles string content and OpenAI content-block lists (only ``type="text"``
    blocks contribute). Returns empty string when no user message is present or
    when content is non-textual (image-only, tool_call, etc.).
    """
    if not isinstance(messages, list):
        return ""
    for msg in reversed(messages):
        if not isinstance(msg, dict) or msg.get("role") != "user":
            continue
        content = msg.get("content")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            parts: list[str] = []
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text":
                    text_val = block.get("text")
                    if isinstance(text_val, str):
                        parts.append(text_val)
            return " ".join(parts)
        return ""
    return ""


def _fmt_user_msg_for_log(raw: str) -> str:
    """Mask user content; emit only the character length so the log line carries
    no PII while still being useful for debugging message-size issues.
    """
    return f"[masked {len(raw)} chars]"


@dataclass
class LLMConfig:
    """Upstream LLM configuration. Used by dispatch (cloud via LiteLLM, local/edge via httpx).

    ``auth_mode`` (default ``"api_key"``) selects the cloud dispatch path:
    ``"api_key"`` → ``cloud.dispatch._call_via_litellm``; ``"oauth"`` →
    ``oauth.dispatch.call`` (token loaded fresh per request from
    ``state/oauth/<provider>.bin``, so ``api_key`` / ``base_url`` are empty here).
    """

    name: str = ""
    provider: str = ""
    model_id: str = ""
    base_url: str = ""
    api_key: str = ""
    max_tokens: int = 4096
    context_limit: int = 196608
    auth_mode: str = "api_key"
    bundle_revision: int | None = None
    binding_revision: int | None = None
    # Wire id, when the upstream knows the model by another name than the one
    # we serve it as. Empty for every real upstream; set only by the dev-only
    # Bundle mock. Read it through ``wire_model_id`` — never substitute it for
    # ``model_id``, which is the served id the record_usage invariant below
    # depends on.
    upstream_model_id: str = ""

    @property
    def wire_model_id(self) -> str:
        """The id to send upstream: the wire override when set, else the served id."""
        return self.upstream_model_id or self.model_id


def _load_cloud_model_config() -> Optional[LLMConfig]:
    """Read ``state/cloud-model.json`` + credential store → LLMConfig.

    Branches on the ``auth_mode`` field (default ``"api_key"`` for records
    written before OAuth support): ``api_key`` reads ``state/providers/<id>.bin``;
    ``oauth`` reads ``state/oauth/<provider>.bin`` (token loaded per request by
    ``oauth.refresh.ensure_fresh_token``). Returns None when unset or the
    referenced credential is missing.
    """
    state_root = default_state_root()
    cloud_data = read_json(state_root / "cloud-model.json")
    if not isinstance(cloud_data, dict):
        return None
    provider_id = cloud_data.get("provider")
    if not provider_id:
        return None

    auth_mode = cloud_data.get("auth_mode", "api_key")
    if auth_mode not in ("api_key", "oauth"):
        logger.warning(
            "[proxy] cloud-model has invalid auth_mode={!r}; treating as no-provider",
            auth_mode,
        )
        return None

    if auth_mode == "oauth":
        # Route provider_id through oauth_state.get so it passes PROVIDER_ID_PATTERN
        # (path-traversal defense — cloud-model.json is plaintext and tamperable).
        from ..oauth import state as oauth_state
        try:
            oauth_session = oauth_state.get(provider_id)
        except ValueError:
            return None
        if oauth_session is None:
            return None
        return LLMConfig(
            name="cloud-model",
            provider=str(provider_id),
            model_id=str(cloud_data.get("model", "")),
            base_url="",
            api_key="",
            max_tokens=int(cloud_data.get("max_tokens", 4096)),
            context_limit=int(cloud_data.get("context_limit", 196608)),
            auth_mode="oauth",
        )

    from ..cloud.catalog import get_provider_base_url, is_catalog_provider

    if not is_catalog_provider(str(provider_id)):
        return None
    provider_data = read_encrypted_json(state_root / "providers" / f"{provider_id}.bin")
    if not isinstance(provider_data, dict):
        return None
    return LLMConfig(
        name="cloud-model",
        provider=str(provider_id),
        model_id=str(cloud_data.get("model", "")),
        base_url=get_provider_base_url(str(provider_id)) or "",
        api_key=str(provider_data.get("api_key", "")),
        max_tokens=int(cloud_data.get("max_tokens", 4096)),
        context_limit=int(cloud_data.get("context_limit", 196608)),
        auth_mode="api_key",
    )


def _load_local_model_config() -> Optional[LLMConfig]:
    """Read SQLite ``config.active_chat_model_id`` + ``LLAMA_ROUTER_PORT`` env.

    Returns None when no local chat model is active. The shared llama-server
    port defaults to 18103 (matches agent_manager's ``LLAMA_ROUTER_PORT``).
    """
    try:
        store = Store(default_db_path())
    except Exception as exc:
        logger.warning("[Local] failed to open store: {}", exc)
        return None
    try:
        active = store.get_config("active_chat_model_id")
        if not active:
            return None
        port = int(os.environ.get("LLAMA_ROUTER_PORT", "18103"))
        return LLMConfig(
            name="local-model",
            provider="local",
            model_id=str(active),
            base_url=f"http://127.0.0.1:{port}/v1",
            api_key=llama_api_key(),
        )
    finally:
        store.close()


# Fallback per-step output-token cap for the LOCAL llama-server path, used only
# when the running server's own limit cannot be read (see below). The in-sandbox
# output-token-cap plugin (95_superclaw_output_token_cap) sets max_tokens for the
# edge 140k window (16384); on the local path that OVERRIDES the model's own
# configured limit and lets a single step decode for ~9 min on a ~30 tok/s box.
# Clamping here makes local honor its configured limit; edge/cloud are untouched.
# Env override: ``LRM_LOCAL_MAX_OUTPUT_TOKENS`` (a lower value bounds per-step
# latency further, e.g. 4096 ≈ 2.3 min; set 0 to disable the clamp entirely).
LOCAL_DEFAULT_MAX_OUTPUT_TOKENS = 8192

# Bounds for the headroom-aware per-turn ceiling (see resolve_output_ceiling).
#
# MAX tracks the in-sandbox plugin's request cap (95_superclaw_output_token_cap
# DEFAULT_CAP): the clamp below is down-only, so any value above what the plugin
# actually sends is unreachable on the product path and the two must be raised
# together. The lower bound remains evidence-backed: anything at/below 12288
# reproduces the arm that measured WORSE than the pure headroom ceiling on the
# source branch's task suite (min(8192, headroom) 0.5903 vs headroom 0.6036).
# Because the ceiling is headroom-derived, a large MAX is only ever granted when
# the prompt is small enough to fund it.
#
# MIN keeps a nearly-full window from being handed a non-positive or absurdly
# small budget, so the model still emits something instead of an empty completion.
# It does NOT make the turn safe: when req_tokens already exceeds the window,
# prompt + 256 still overflows and the upstream returns its own genuine
# context_length_exceeded — which is the documented behaviour of the over-cap
# PROCEED branch (see decide_over_limit's "over-cap-no-cloud"). What MIN does
# guarantee is that this path never falls BACK to the flat 8192, which would add
# 8192 tokens of output to a window that has nothing left.
LOCAL_OUTPUT_CEILING_MAX = 32768
LOCAL_OUTPUT_CEILING_MIN = 256

_ACTIVE_TUNING_FILENAME = "active-llm-tuning.json"


def _load_edge_config() -> Optional[LLMConfig]:
    """Compatibility shim for tests and older call sites."""
    return _load_local_model_config()


def _llama_is_live() -> bool:
    """Compatibility shim for tests and older call sites."""
    return _load_local_model_config() is not None


def _applied_n_predict() -> Optional[int]:
    """Read ``n_predict`` from ``active-llm-tuning.json`` — the value the
    supervisor actually launched llama-server with (registry ``default_n_predict``
    after any ctx clamp). Returns None when unpublished or unreadable.
    """
    path = default_state_root().parent / _ACTIVE_TUNING_FILENAME
    if not path.is_file():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        value = int(payload.get("n_predict"))
    except Exception:  # noqa: BLE001
        return None
    return value if value > 0 else None


def resolve_output_ceiling(
    cap: Optional[int], output_reserve: int, req_tokens: int
) -> Optional[int]:
    """Room actually left for THIS turn's output, or None when it can't be derived.

    ``cap`` is the prompt-side limit the context guard derived from the LIVE server
    (``eff_n_ctx - output_reserve - safety``), so adding ``output_reserve`` back and
    subtracting the prompt gives ``eff_n_ctx - safety - req_tokens`` — the whole
    remaining window rather than a fixed constant. The flat per-model clamp
    truncated legitimate one-turn deliverables mid-write, after which a weak model
    re-emitted the whole block on the next turn and burned the step budget.

    Bounded to [:data:`LOCAL_OUTPUT_CEILING_MIN`, :data:`LOCAL_OUTPUT_CEILING_MAX`].
    On the under-cap PROCEED path ``req_tokens <= cap``, so the raw value is always
    ``>= output_reserve`` and the result never dips below today's flat clamp; the
    MIN floor only engages on the over-cap-PROCEED path (over the cap, no cloud,
    compaction budget spent), where the window genuinely has nothing left — see the
    note on :data:`LOCAL_OUTPUT_CEILING_MIN`.

    KNOWN LIMIT of inverting ``cap``: the identity above holds only while ``cap``
    came from ``resolve_policy_token_cap``'s auto tier. That function has two more
    (``routing.max_input_tokens``, a static ``upstream_cap``), and under the static
    tier on a window too small to fund the reserve the inverse OVER-states the
    window and would grant more output room than the server has. Neither tier is
    reachable from this proxy today — it calls ``resolve_cap_from_probe`` with no
    ``upstream_cap`` and ``RoutingPolicyConfig.resolve()`` with no config — so the
    identity holds on every reachable path. Deriving the headroom forward from the
    probe instead (rather than relying on that) is a follow-up; see the port plan.

    ``None`` (no live probe → no cap) means "no headroom signal": the caller must
    keep using the flat per-model value.
    """
    if cap is None or cap <= 0:
        return None
    ceiling = int(cap) + int(output_reserve) - int(req_tokens)
    return max(LOCAL_OUTPUT_CEILING_MIN, min(LOCAL_OUTPUT_CEILING_MAX, ceiling))


def _local_output_token_cap(ceiling: Optional[int] = None) -> int:
    """Resolve the local per-step output cap.

    Precedence: ``LRM_LOCAL_MAX_OUTPUT_TOKENS`` env → ``ceiling`` (the caller's
    headroom-aware room for this turn, see :func:`resolve_output_ceiling`) → the
    running server's own ``n_predict`` → :data:`LOCAL_DEFAULT_MAX_OUTPUT_TOKENS`.
    Deriving the cap from the served model keeps this proxy-side clamp from
    silently overriding the registry: raising ``default_n_predict`` used to have no
    effect because this layer pinned a second, lower limit of its own.

    Returns 0 to mean "no clamp" (an explicit ``LRM_LOCAL_MAX_OUTPUT_TOKENS=0``).
    A malformed/negative env value is ignored in favour of the resolved default.
    """
    raw = os.environ.get("LRM_LOCAL_MAX_OUTPUT_TOKENS")
    if raw is not None:
        try:
            value = int(raw)
            if value >= 0:
                return value
        except ValueError:
            pass
    if ceiling is not None and ceiling > 0:
        return ceiling
    applied = _applied_n_predict()
    if applied is not None:
        return applied
    return LOCAL_DEFAULT_MAX_OUTPUT_TOKENS


def clamp_local_output_tokens(body: dict, ceiling: Optional[int] = None) -> Optional[int]:
    """Clamp ``body['max_tokens']`` to the local per-step cap, in place.

    Pure + local-path only (callers scope it to ``kind == "local"``). Returns the
    new value when it clamped, else ``None`` (cap disabled, or the request is
    already at/under the cap). A missing/non-int ``max_tokens`` is treated as
    "unbounded" and set to the cap so an uncapped local request can't decode to
    the model's full context.

    ``ceiling`` is only honoured for a request that asked for a bounded
    ``max_tokens``. An unbounded request must keep the flat per-model value: the
    ceiling is the whole remaining window, so granting it here would turn "the
    client forgot to ask for a budget" into a decode of tens of thousands of tokens.

    CONSEQUENCE, because it decides where the ceiling is live at all: the only
    caller that sets ``max_tokens`` on the product path is the in-sandbox
    output-token-cap plugin, which every packaged Product Profile ships (see
    ``sandbox/agent_config/profiles/*/plugins/95_superclaw_output_token_cap.ts``).
    So the ceiling is live on every Profile, and any behavioural claim about it
    has to state the served model, not the Profile.
    """
    current = body.get("max_tokens")
    bounded_request = isinstance(current, int) and current > 0
    cap = _local_output_token_cap(ceiling=ceiling if bounded_request else None)
    if cap <= 0:
        return None
    if isinstance(current, int) and current <= cap:
        return None
    body["max_tokens"] = cap
    return cap


def _current_local_provider() -> Optional[str]:
    """Read the persisted local provider selection (``"llamacpp"`` | ``"edge"`` | None).

    ``None`` means the user has not selected a local backend — local is "not
    configured", which the data plane surfaces as ``503 local_not_configured``.
    """
    try:
        store = Store(default_db_path())
    except Exception as exc:
        logger.warning("[Local] failed to open store for provider read: {}", exc)
        return None
    try:
        return get_local_provider(store)
    finally:
        store.close()


def resolve_active_provider(app_state: Any) -> tuple[Optional[str], Optional[str]]:
    """Return ``(local_provider, active_provider)`` for the ``/status`` summary.

    ``local_provider`` is the raw persisted USER selection (what the user chose
    via ``PUT /model-selections/local-provider``); it is ``None`` until the user
    explicitly picks a backend and is a routing-preference / edge-resource
    arbitration switch — NOT a "local is usable" flag.

    ``active_provider`` is which backend would actually serve a ``local-model``
    request right now. It is derived from the committed **primary bundle** via
    ``resolve_primary`` — the SAME resolver the data plane uses
    (``_resolve_alias`` → ``local-model``), so ``/status`` and
    ``/v1/chat/completions`` never disagree. This intentionally ignores
    ``local_provider``: an auto-committed first-launch llama bundle (which never
    writes ``local_provider``) and a manually selected one are treated
    identically — a ``ready`` committed local bundle is reported as active
    regardless of who triggered the commit. ``None`` only when no local bundle
    is committed-and-ready (llama not up, or edge config fingerprint mismatch).
    """
    local_provider = _current_local_provider()
    if app_state is None:
        if _load_local_model_config() is not None and _llama_is_live():
            return local_provider, "llamacpp"
        if _load_edge_config() is not None:
            return local_provider, "edge"
        return local_provider, None
    primary = resolve_primary(app_state, role="chat")
    if primary is None:
        return local_provider, None
    return local_provider, ("edge" if primary.backend == "edge" else "llamacpp")


def _resolve_alias(
    model_alias: str, *, app_state: Any = None
) -> tuple[str, Optional[LLMConfig], str]:
    """Resolve a model alias to ``(kind, llm_cfg, reason)``.

    Two-family routing model:

    - **cloud-model slot**: explicitly selected via ``PUT /llm-router/v1/cloud/model``.
    - **local slot**: resolved from the committed primary bundle via
      ``resolve_primary`` (llama or edge). ``local-model`` maps to whichever
      backend the primary bundle commits. Unset ⇒ local not
      configured.

    ``kind`` ∈ {``cloud``, ``local``, ``edge``} is the routing/dispatch tag
    (``local`` and ``edge`` share the httpx passthrough path but use distinct
    ``source`` labels per §11). ``llm_cfg`` is None when nothing is serveable;
    ``reason`` (only meaningful then) is the 424 code — ``local_not_configured``
    when no local provider is selected, else ``no_provider_available``.

    Alias semantics:

    - ``cloud-model`` → cloud-model slot only.
    - ``local-model`` → the committed primary bundle's backend (see ``resolve_primary``).
    - ``auto`` → **only invoked from ``chat_completions`` when the latency router
      did NOT run** (single-slot or neither-configured cases). When BOTH
      cloud-model AND a serveable local slot exist, ``chat_completions``
      intercepts ``model="auto"`` first and rewrites it to the router's decision,
      so this branch never sees ``auto`` in the both-configured case. Fallback
      order here: cloud slot first; else the local slot. ``auto`` never reports
      ``local_not_configured`` — with nothing configured at all the contract is a
      single ``no_provider_available``.
    """
    if model_alias == "cloud-model":
        return "cloud", _load_cloud_model_config(), "no_provider_available"
    if model_alias == "local-model":
        if app_state is None:
            return "local", None, "local_model_not_configured"
        primary = resolve_primary(app_state, role="chat")
        if primary is None:
            return "local", None, "local_model_not_configured"
        return (
            "edge" if primary.backend == "edge" else "local",
            LLMConfig(
                name="local-model",
                provider=primary.backend,
                model_id=primary.model_id,
                upstream_model_id=primary.upstream_model_id,
                base_url=primary.base_url,
                api_key=primary.api_key,
                bundle_revision=primary.bundle_revision,
                binding_revision=primary.binding_revision,
            ),
            "",
        )
    if model_alias == "auto":
        cloud = _load_cloud_model_config()
        local_kind, local_cfg, _ = _resolve_alias("local-model", app_state=app_state)
        # Dev Bundle mock: pin `auto` to the local slot so a mocked box exercises
        # the LOCAL path deterministically. Without this the latency router still
        # sends a share of traffic to the real cloud slot, so a developer testing
        # "the local model" silently measures a mix -- and the mocked slot, which
        # is the thing under test, is the half that does not get exercised.
        #
        # Deliberately ahead of the cloud check below: `auto` normally needs both
        # slots, but under the mock "always local" is the whole point, so whether
        # a cloud slot happens to be configured must not change the answer. That
        # also keeps the behaviour identical on a dev box with cloud credentials
        # and on CI without them.
        #
        # Dev-only by construction: `is_armed()` is false for every real install,
        # and the mock itself refuses to arm outside the `dev` build channel.
        if local_cfg is not None and mock_bundle.is_armed():
            return local_kind, local_cfg, ""
        if cloud is None or local_cfg is None:
            return local_kind, None, "auto_route_not_configured"
        return "local", None, "auto_route_requires_classification"
    return "cloud", _load_cloud_model_config(), "no_provider_available"


# Non-streaming dispatch returns nothing until the WHOLE completion is decoded, so
# httpx's ``read`` timeout is a hard ceiling on single-step decode time, not just a
# liveness check.
#
# Measured on the installed app (2026-07-30, B390 iGPU / 64 GB, qwen3.6-35b-a3b at
# n_ctx 100096, non-streaming, ignore_eos): a 16384-token step took 304 s at a 44.8k
# prompt and 374 s at a 69.7k prompt — i.e. 43.8 tok/s at depth, not the ~25 tok/s
# this comment first assumed. Two consequences, both worth stating plainly:
#
#   * at the FLAT 8192 clamp a full step is ~187 s on that box, so the old flat
#     300 s did NOT fail there. This is therefore not an independent pre-existing
#     defect: it becomes reachable only once the headroom ceiling restores 16384
#     (374 s > 300 s), which makes it A3's required companion. Ship the two
#     together or neither — see resolve_output_ceiling and the port plan §7.3;
#   * 20 tok/s below is ~2x more conservative than the measurement. Kept there on
#     purpose: it has to hold on a slower iGPU and at deeper context, and being
#     generous costs nothing (the timeout is a failure detector, never a
#     truncation source) while being tight costs a 500 on legitimate work.
#
# Reachability: in-product the only non-streaming caller of this dispatch is the
# tool-call repair re-dispatch further down, and that is itself gated on
# ``not req_stream`` — so it only fires for a caller that was already
# non-streaming (intent classifier, email pipeline, direct data-plane clients).
# opencode streams, so the product chat path does not consume the derived value.
#
# Streaming deliberately keeps the flat value: there ``read`` measures the gap
# BETWEEN chunks, so a long generation never accumulates against it and raising it
# would only delay detection of a stalled stream.
_MIN_DECODE_TOKENS_PER_S = 20.0
_BASE_READ_TIMEOUT_S = 300.0


def resolve_read_timeout_s(body: dict, req_stream: bool) -> float:
    """Read-timeout ceiling for one upstream dispatch, in seconds.

    ``max(300, max_tokens / 20)`` for a non-streaming request with a bounded
    ``max_tokens``; a flat 300 s when streaming or when the output budget is
    unknown (nothing to derive from). 20 tok/s is deliberately below the ~25 tok/s
    measured at depth, so the timeout stays a failure detector instead of becoming
    a truncation source.
    """
    if req_stream:
        return _BASE_READ_TIMEOUT_S
    max_tokens = body.get("max_tokens")
    if not isinstance(max_tokens, int) or max_tokens <= 0:
        return _BASE_READ_TIMEOUT_S
    return max(_BASE_READ_TIMEOUT_S, max_tokens / _MIN_DECODE_TOKENS_PER_S)


async def _httpx_chat_completions(
    cfg: LLMConfig,
    body: dict,
    req_stream: bool,
    source: Source,
    *,
    telemetry_tracer: Tracer | None = None,
    telemetry_parent_span: Span | None = None,
    telemetry_runtime: Any | None = None,
    request_started_at: float | None = None,
    alias: str | None = None,
    session_id: str | None = None,
    message_id: str | None = None,
    trace_id: str | None = None,
    langfuse_trace_id: str | None = None,
    hdr_phase: str | None = None,
    call_kind: str | None = None,
    langfuse_session_id: str | None = None,
    on_stream_success: Callable[[], None] | None = None,
) -> Any:
    """OpenAI-compat / local / edge dispatch via direct httpx.

    ``on_stream_success`` runs once, after the streamed response has fully
    completed (``data: [DONE]`` received) — i.e. the original agent's turn
    demonstrably finished, not merely started. Used to clear the reactive
    ``upstream_overflows`` budget (see CompactionTracker).

    Replaces the alias model name in the request body with the concrete
    upstream model id before forwarding. Streaming variant returns a
    ``StreamingResponse``; non-streaming returns the parsed JSON body.
    Both variants fire the ``record_usage`` hook with ``source`` ∈ {local, edge}.

    ``trace_id`` is the per-request event-ledger id (chat_req_id) recorded
    on ``token_events`` / ``record_usage`` / ``record_event`` so per-request
    rows join by it. ``langfuse_trace_id`` is the Langfuse *grouping* id
    (may be shared across many requests -- e.g. an OpenCode message id
    spanning title-gen + response + tool loops); it drives the Langfuse
    trace only, never the event ledger. When callers omit
    ``langfuse_trace_id`` we fall back to ``trace_id`` so single-caller
    unit tests keep the pre-split behavior.
    """
    headers = {"Content-Type": "application/json"}
    if cfg.api_key:
        headers["Authorization"] = f"Bearer {cfg.api_key}"

    llm_body = dict(body)
    # The WIRE id (usually identical to the served id; different only under the
    # dev-only Bundle mock, whose remote endpoint knows the model by another
    # name). Everything downstream — record_usage, the response body — keeps
    # using cfg.model_id.
    llm_body["model"] = cfg.wire_model_id
    # Bundle mock only: mirror the real supervisor's thinking-off launch flags.
    # A real local chat slot is started with ``--reasoning off``,
    # ``--reasoning-budget 0`` and ``--chat-template-kwargs
    # {"enable_thinking":false}`` (local/supervisor.py). Under the mock no
    # llama-server is launched for chat (``_LaunchPlan(chat_rerouted=True)``), so
    # none of those flags exist and the remote model reasons by default -- which
    # is NOT the shipping configuration for the 32GB B70 target, where reasoning
    # must be off. Measured on qwen3.8-27b over 35 pinchbench tasks, leaving it on
    # spent 20.9% of generated tokens on reasoning and, worse, fired on only 15 of
    # 35 tasks (941..26752 tokens) depending on which upstream provider served the
    # call -- noise that makes before/after runs incomparable.
    #
    # ``reasoning: {"enabled": false}`` is the only one of the four candidates that
    # actually suppresses generation on this route. ``exclude: true`` merely hides
    # the reasoning from the response while still paying for it; ``max_tokens: 0``
    # and ``chat_template_kwargs`` are ignored.
    #
    # ``upstream_model_id`` is set by the Bundle mock and empty for every real
    # upstream, so this can never reach a production slot. An explicit caller
    # ``reasoning`` wins, so a deliberate experiment is still possible.
    if cfg.upstream_model_id and "reasoning" not in llm_body:
        llm_body["reasoning"] = {"enabled": False}
    if req_stream:
        # Force include_usage so the upstream emits a final SSE chunk with token counts.
        so = dict(llm_body.get("stream_options") or {})
        so["include_usage"] = True
        llm_body["stream_options"] = so

    timeout = httpx.Timeout(
        connect=10.0,
        read=resolve_read_timeout_s(llm_body, req_stream),
        write=30.0,
        pool=10.0,
    )
    url = f"{cfg.base_url.rstrip('/')}/chat/completions"
    request_started = request_started_at if request_started_at is not None else time.monotonic()
    dispatch_span = tracing.start_span(
        telemetry_tracer,
        f"llmrouter.dispatch.{source}",
        context=tracing.child_context(telemetry_parent_span),
        attributes={
            "llmrouter.dispatch.kind": source,
            "llmrouter.dispatch.stream": req_stream,
            "llmrouter.upstream.model": cfg.model_id,
            "server.address": cfg.base_url,
        },
    )
    # Langfuse v2 trace, created once for both the streaming
    # and non-streaming branches below (moved above the req_stream check so
    # the streaming closure can also close it once the stream ends).
    messages = body.get("messages")
    lf_trace, lf_generation, gen_name = build_trace_and_generation(
        messages=messages,
        hdr_phase=hdr_phase,
        call_kind=call_kind,
        trace_id=langfuse_trace_id or trace_id,
        session_id=session_id,
        langfuse_session_id=langfuse_session_id,
        kind=source,
        req_stream=req_stream,
        provider=cfg.provider,
        model_id=cfg.model_id,
        tools_present="tools" in body,
        upstream_payload=llm_body,
    )
    if req_stream:
        async def _stream() -> Any:
            stream_span = tracing.start_span(
                telemetry_tracer,
                "llmrouter.upstream.stream",
                context=tracing.child_context(dispatch_span),
                attributes={
                    "llmrouter.dispatch.kind": source,
                    "llmrouter.upstream.model": cfg.model_id,
                },
            )
            captured_usage: dict | None = None
            captured_model = cfg.model_id
            answer_parts: list[str] = []  # Accumulated content to join for final answer of the Langfuse generation
            captured_finish_reason: str | None = None  # finish_reason from the last streamed chunk, recorded on the Langfuse generation
            # TO REVIEW (Brad): merge fragmented tool_calls deltas by index,
            # same reasoning as dispatch.py's streaming path.
            tool_call_parts: dict[int, dict] = {}
            # Frontend reads a leading ``[model-id] `` off the first text
            # part to display the underlying model; consumed on the first
            # non-empty ``delta.content`` chunk. Malformed id -> None -> no-op.
            prefix_pending = format_model_prefix(cfg.model_id)
            # Buffer raw bytes until we have a complete SSE event (terminated
            # by ``\n\n`` or ``\r\n\r\n``). ``aiter_bytes()`` yields arbitrary
            # transport chunks; a ``data:`` line -- or a UTF-8 codepoint inside
            # it -- can straddle a chunk boundary. Rewriting per-chunk would
            # either miss the first content delta or (worse) leak the prefix
            # into a later delta where stripModelPrefix cannot remove it.
            buffer = b""
            first_chunk_ms: int | None = None
            chunk_count = 0
            done_received = False
            async with build_async_client_for_url(url, timeout=timeout) as client:
                async with client.stream(
                    "POST", url, json=llm_body, headers=headers
                ) as resp:
                    if resp.status_code != 200:
                        tracing.add_event(
                            dispatch_span,
                            "upstream_non_200",
                            {"http.response.status_code": resp.status_code},
                        )
                        tracing.mark_error(stream_span, f"upstream status {resp.status_code}")
                        tracing.mark_error(dispatch_span, f"upstream status {resp.status_code}")
                        lf_generation.end(
                            output=None,
                            level="ERROR",
                            status_message=f"upstream status {resp.status_code}",
                        )
                        text = await resp.aread()
                        # OpenAI-compatible clients parse the SSE error event as
                        # ``{"error": {code, type, message}}`` -- an object, not a
                        # bare string. A string ``error`` fails their response-schema
                        # union (choices[] | error{}) and surfaces as a raw
                        # validation dump instead of a readable message.
                        error_payload = json.dumps(
                            {"error": upstream_error_object(
                                text.decode("utf-8", errors="replace"),
                                resp.status_code,
                                cfg.model_id,
                                source,
                            )}
                        )
                        yield f"data: {error_payload}\n\n".encode("utf-8")
                        record_event(
                            EventType.UPSTREAM_HTTP_ERROR,
                            session_id=session_id,
                            message_id=message_id,
                            trace_id=trace_id,
                            model=cfg.model_id,
                            attrs={
                                "status": resp.status_code,
                                "provider": cfg.provider or source,
                                "body_excerpt": text.decode(
                                    "utf-8", errors="replace"
                                )[:500],
                                "stream": True,
                                "source": source,
                            },
                        )
                        record_usage(
                            None,
                            source=source,
                            # Canonical served id — see the invariant note at the
                            # end-of-stream call site below.
                            model_id=cfg.model_id,
                            provider=cfg.provider,
                            alias=alias,
                            session_id=session_id,
                            message_id=message_id,
                            trace_id=trace_id,
                        )
                        tracing.set_attributes(
                            stream_span,
                            {
                                "llmrouter.stream.chunk_count": 0,
                                "llmrouter.stream.usage_captured": False,
                                "llmrouter.stream.done_received": False,
                            },
                        )
                        _emit_llm_request_metrics(
                            telemetry_runtime,
                            source=source,
                            model_id=cfg.model_id,
                            stream=True,
                            status_code=resp.status_code,
                            duration_ms=int((time.monotonic() - request_started) * 1000),
                        )
                        tracing.end_span(stream_span)
                        tracing.end_span(dispatch_span)
                        return
                    async for chunk_bytes in resp.aiter_bytes():
                        if not chunk_bytes:
                            continue
                        if first_chunk_ms is None:
                            first_chunk_ms = int((time.monotonic() - request_started) * 1000)
                            tracing.add_event(stream_span, "first_chunk")
                        buffer += chunk_bytes
                        while True:
                            lf_idx = buffer.find(b"\n\n")
                            crlf_idx = buffer.find(b"\r\n\r\n")
                            if lf_idx == -1 and crlf_idx == -1:
                                break
                            if lf_idx == -1:
                                end = crlf_idx + 4
                            elif crlf_idx == -1:
                                end = lf_idx + 2
                            else:
                                end = lf_idx + 2 if lf_idx < crlf_idx else crlf_idx + 4
                            event_bytes = buffer[:end]
                            buffer = buffer[end:]
                            for line in event_bytes.decode("utf-8", errors="replace").split("\n"):
                                if line.startswith("data: ") and not line.startswith(
                                    "data: [DONE]"
                                ):
                                    chunk_count += 1
                                    try:
                                        event_data = json.loads(line[6:])
                                    except Exception:
                                        continue
                                    if isinstance(event_data, dict):
                                        if event_data.get("usage"):
                                            captured_usage = event_data["usage"]
                                            tracing.add_event(stream_span, "usage_chunk")
                                        if event_data.get("model"):
                                            captured_model = event_data["model"]
                                        # accumulate delta content + finish_reason for the Langfuse generation output and metadata
                                        choices = event_data.get("choices") or [{}]
                                        delta = choices[0].get("delta") or {}
                                        delta_content = delta.get("content")
                                        if delta_content:
                                            answer_parts.append(delta_content)
                                        delta_tool_calls = delta.get("tool_calls")
                                        if delta_tool_calls:
                                            for tc in delta_tool_calls:
                                                idx = tc.get("index", 0)
                                                slot = tool_call_parts.setdefault(
                                                    idx, {"id": None, "name": None, "args": []}
                                                )
                                                if tc.get("id"):
                                                    slot["id"] = tc["id"]
                                                fn = tc.get("function") or {}
                                                if fn.get("name"):
                                                    slot["name"] = fn["name"]
                                                if fn.get("arguments"):
                                                    slot["args"].append(fn["arguments"])
                                        finish_reason_chunk = choices[0].get("finish_reason")
                                        if finish_reason_chunk:
                                            captured_finish_reason = finish_reason_chunk
                                elif line.startswith("data: [DONE]"):
                                    done_received = True
                                    tracing.add_event(stream_span, "done")
                            if prefix_pending:
                                modified = inject_into_sse_bytes(event_bytes, prefix_pending)
                                if modified is not None:
                                    prefix_pending = None
                                    yield modified
                                    continue
                            yield event_bytes
                    # Trailing bytes with no terminator: yield as-is; an
                    # incomplete event cannot be safely rewritten.
                    if buffer:
                        yield buffer
            total_ms = int((time.monotonic() - request_started) * 1000)
            if not done_received:
                # Clean EOF with no ``data: [DONE]``: the upstream closed the
                # stream without a terminal frame. No exception is raised, so
                # this is invisible everywhere else — the metrics layer below
                # quietly stamps it 502 and moves on.
                record_event(
                    EventType.UPSTREAM_STREAM_ABORT,
                    session_id=session_id,
                    message_id=message_id,
                    trace_id=trace_id,
                    model=cfg.model_id,
                    attrs={
                        "reason": "no_terminal_frame",
                        "chunk_count": chunk_count,
                        "first_chunk_ms": first_chunk_ms,
                        "waited_ms": total_ms,
                        "usage_captured": captured_usage is not None,
                        "source": source,
                    },
                )
            tool_calls_final = (
                [
                    {
                        "id": slot["id"] or "",
                        "type": "function",
                        "function": {
                            "name": slot["name"] or "",
                            "arguments": "".join(slot["args"]),
                        },
                    }
                    for _, slot in sorted(tool_call_parts.items())
                ]
                if tool_call_parts
                else None
            )
            stream_final_output = "".join(answer_parts) if answer_parts else tool_calls_final
            finalize_generation_and_trace(
                lf_generation,
                lf_trace,
                gen_name,
                output=stream_final_output,
                prompt_tokens=captured_usage.get("prompt_tokens") if captured_usage else None,
                completion_tokens=captured_usage.get("completion_tokens") if captured_usage else None,
                finish_reason=captured_finish_reason,
            )
            decode_window_ms = (
                max(0, total_ms - first_chunk_ms)
                if first_chunk_ms is not None
                else None
            )
            record_usage(
                {"usage": captured_usage, "model": captured_model}
                if captured_usage
                else None,
                source=source,
                # INVARIANT (all record_usage call sites in this function):
                # attribute to ``cfg.model_id``, the served id this dispatch
                # resolved to — never to the upstream echo (``captured_model``).
                # The echo is a wire value we do not control: a router-mode
                # llama-server may answer with a trained label or a filesystem
                # path (e.g. ``/models/x.gguf``) instead of the id we asked for,
                # which splits one model's usage across several unstable keys in
                # the aggregate (``underlying_model`` is part of its PK) and
                # makes per-model totals unreadable. The echo is still reported
                # on the span below, so "what did the server actually load"
                # remains observable without driving attribution.
                model_id=cfg.model_id,
                provider=cfg.provider,
                alias=alias,
                session_id=session_id,
                message_id=message_id,
                trace_id=trace_id,
                tool_calls=tool_calls_final or [],
            )
            _emit_llm_request_metrics(
                telemetry_runtime,
                source=source,
                model_id=captured_model,
                stream=True,
                status_code=200 if done_received else 502,
                duration_ms=total_ms,
                prompt_tokens=int(captured_usage["prompt_tokens"])
                if isinstance(captured_usage, dict)
                and isinstance(captured_usage.get("prompt_tokens"), int)
                else None,
                completion_tokens=int(captured_usage["completion_tokens"])
                if isinstance(captured_usage, dict)
                and isinstance(captured_usage.get("completion_tokens"), int)
                else None,
                ttft_ms=first_chunk_ms,
                decode_window_ms=decode_window_ms,
            )
            tracing.set_attributes(
                stream_span,
                {
                    "llmrouter.usage.prompt_tokens": int(captured_usage["prompt_tokens"])
                    if isinstance(captured_usage, dict)
                    and isinstance(captured_usage.get("prompt_tokens"), int)
                    else None,
                    "llmrouter.usage.completion_tokens": int(captured_usage["completion_tokens"])
                    if isinstance(captured_usage, dict)
                    and isinstance(captured_usage.get("completion_tokens"), int)
                    else None,
                    "llmrouter.usage.total_tokens": int(captured_usage["total_tokens"])
                    if isinstance(captured_usage, dict)
                    and isinstance(captured_usage.get("total_tokens"), int)
                    else None,
                    "llmrouter.stream.first_chunk_ms": first_chunk_ms,
                    "llmrouter.stream.chunk_count": chunk_count,
                    "llmrouter.stream.usage_captured": captured_usage is not None,
                    "llmrouter.stream.done_received": done_received,
                    "llmrouter.upstream.model": captured_model,
                },
            )
            tracing.set_attributes(dispatch_span, {"llmrouter.upstream.model": captured_model})
            tracing.end_span(stream_span)
            tracing.end_span(dispatch_span)
            if done_received and on_stream_success is not None:
                on_stream_success()

        return StreamingResponse(_stream(), media_type="text/event-stream")

    async with build_async_client_for_url(url, timeout=timeout) as client:
        resp = await client.post(url, json=llm_body, headers=headers)
        if resp.status_code != 200:
            tracing.add_event(
                dispatch_span,
                "upstream_non_200",
                {"http.response.status_code": resp.status_code},
            )
            tracing.mark_error(dispatch_span, f"upstream status {resp.status_code}")
            lf_generation.end(
                output=None,
                level="ERROR",
                status_message=f"upstream status {resp.status_code}",
            )
            _emit_llm_request_metrics(
                telemetry_runtime,
                source=source,
                model_id=cfg.model_id,
                stream=False,
                status_code=resp.status_code,
                duration_ms=int((time.monotonic() - request_started) * 1000),
            )
            tracing.end_span(dispatch_span)
            record_event(
                EventType.UPSTREAM_HTTP_ERROR,
                session_id=session_id,
                message_id=message_id,
                trace_id=trace_id,
                model=cfg.model_id,
                attrs={
                    "status": resp.status_code,
                    "provider": cfg.provider or source,
                    "body_excerpt": resp.text[:500],
                    "stream": False,
                    "source": source,
                },
            )
            error = upstream_error_object(
                resp.text, resp.status_code, cfg.model_id, source
            )
            if error["code"] == "edge_model_not_served":
                return JSONResponse(
                    status_code=resp.status_code,
                    content={"error": error},
                    headers={"x-latentfactor-routed-to": cfg.model_id},
                )
            if error["code"] == "context_overflow_unrecoverable":
                return JSONResponse(
                    status_code=resp.status_code,
                    content={"error": error},
                    headers={
                        "x-latentfactor-routed-to": cfg.model_id,
                        "x-latentfactor-context-overflow": "1",
                    },
                )
            status = 502 if 500 <= resp.status_code < 600 else resp.status_code
            raise HTTPException(
                status_code=status,
                detail=f"Upstream error: {resp.text[:500]}",
            )
        result = resp.json()
        if cfg.upstream_model_id and isinstance(result, dict) and result.get("model"):
            # Under the Bundle mock the upstream echoes its OWN name for the
            # model. Restore the served id so a caller reading the response
            # body sees what the real local path would have echoed. Streaming
            # chunks are forwarded raw and still carry the upstream echo -- a
            # known mock artifact, not worth re-serialising every SSE frame on
            # the hot path for.
            result["model"] = cfg.model_id
        prefix = format_model_prefix(cfg.model_id)
        if prefix:
            inject_into_non_streaming_result(result, prefix)
        usage = result.get("usage")
        if not isinstance(usage, dict):
            usage = {}

        # close langfuse generation span
        choices = result.get("choices") or [{}]
        message = choices[0].get("message") or {}
        # TO REVIEW (Brad): same tool-call fallback as dispatch.py's
        # non-streaming path — content is None on tool-call turns.
        answer_text = message.get("content") or message.get("tool_calls")
        finish_reason = choices[0].get("finish_reason")
        finalize_generation_and_trace(
            lf_generation,
            lf_trace,
            gen_name,
            output=answer_text,
            prompt_tokens=usage.get("prompt_tokens"),
            completion_tokens=usage.get("completion_tokens"),
            finish_reason=finish_reason,
        )
        record_usage(
            result,
            source=source,
            # Canonical served id, not the upstream echo (``result["model"]``) —
            # same invariant as the streaming call sites above.
            model_id=cfg.model_id,
            provider=cfg.provider,
            alias=alias,
            session_id=session_id,
            message_id=message_id,
            trace_id=trace_id,
        )
        tracing.set_attributes(
            dispatch_span,
            {
                "llmrouter.upstream.model": str(result.get("model", cfg.model_id)),
                "llmrouter.usage.present": result.get("usage") is not None,
            },
        )
        _emit_llm_request_metrics(
            telemetry_runtime,
            source=source,
            model_id=str(result.get("model", cfg.model_id)),
            stream=False,
            status_code=200,
            duration_ms=int((time.monotonic() - request_started) * 1000),
            prompt_tokens=int(usage["prompt_tokens"]) if isinstance(usage.get("prompt_tokens"), int) else None,
            completion_tokens=int(usage["completion_tokens"]) if isinstance(usage.get("completion_tokens"), int) else None,
        )
        tracing.end_span(dispatch_span)
        return result


def _extract_query_text(messages: Any) -> str:
    """Concatenate user-role message contents into one query string for the
    latency router's embedding call. Empty string when messages is malformed —
    caller treats empty query as "skip router, fall back to chain".

    Handles both string content (`"..."`) and OpenAI content-block lists
    (`[{type: "text", text: "..."}]`).
    """
    if not isinstance(messages, list):
        return ""
    parts: list[str] = []
    for msg in messages:
        if not isinstance(msg, dict):
            continue
        if msg.get("role") != "user":
            continue
        content = msg.get("content")
        if isinstance(content, str):
            parts.append(content)
        elif isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text":
                    text_val = block.get("text")
                    if isinstance(text_val, str):
                        parts.append(text_val)
    return " ".join(parts).strip()


@dataclass(frozen=True)
class _ChatObservabilityContext:
    """Resolved id/naming context for one /v1/chat/completions call.

    Centralizes the precedence rules (which header wins for trace_id vs
    langfuse_session_id, etc.) in one small, independently testable place
    instead of scattered inline in chat_completions().
    """

    usage_session_id: str | None
    message_id: str | None
    trace_id: str
    langfuse_trace_id: str
    requesting_agent: str
    hdr_phase: str | None
    call_kind: str | None
    opencode_session_id: str
    opencode_parent_session_id: str
    langfuse_session_id: str | None


def _resolve_chat_observability_context(
    request: Request, chat_req_id: str
) -> _ChatObservabilityContext:
    usage_session_id = request.headers.get("X-Opencode-Session-Id")
    # Populated by plugin 91_agent_context_header.ts for normal chat, and by
    # the HDR sidecar (llm.py) only when it has a real message id to
    # forward -- never a fallback value -- so this can always be trusted
    # as-is with no id-shape guessing.
    message_id = request.headers.get("X-Opencode-Message-Id")
    _message_id_stripped = (message_id or "").strip()
    # The Hybrid Deep Research sidecar drives ~9 pipeline phases x multiple
    # calls per run (plan/fill/polish/etc) as its own Python orchestrator.
    # It sends a stable per-run id in X-Hybrid-DR-Run-Id (the real message
    # id when available, else its own session id) so every call in one HDR
    # run collapses onto a single Langfuse trace instead of ~27 unrelated
    # ones. Merge same-turn normal-chat calls (e.g. title-gen + the real
    # response) the same way by keying the Langfuse trace off message_id when
    # no HDR run id is present, falling back to a fresh random id per call only
    # when neither is available.
    hdr_run_id = str(request.headers.get("X-Hybrid-DR-Run-Id", "")).strip()[:128] or None
    # Event-ledger correlation id stays per-request. Dev's contract is that a
    # request's chat.request/chat.completion rows join on the same random
    # chat_req_id (test_event_emission_ledger asserts trace_id == chat_req_id);
    # Langfuse grouping is a separate concern handled by langfuse_trace_id.
    trace_id = chat_req_id
    # Langfuse trace grouping id: prefer the HDR run id, then the real message
    # id (collapses same-turn calls onto one trace), else a fresh per-call id.
    langfuse_trace_id = hdr_run_id or (_message_id_stripped if _message_id_stripped else chat_req_id)

    # Read agent identity injected by OpenCode plugin 91_agent_context_header.ts.
    # Sanitized to [a-z0-9_-] ≤64 chars by the plugin; guard again here with
    # the same sanitizer the rest of the request path uses so a missing or
    # malformed header never affects log format or downstream comparisons.
    requesting_agent = _sanitize_agent_name(str(request.headers.get("superclaw-agent", "")))
    # Hybrid Deep Research sidecar sends its own pipeline-phase name here
    # (plan/fill/polish/etc, see hdr-sidecar's llm.py) since it never uses
    # OpenAI tool_calls/tool-role messages -- without this every HDR call
    # collapses into the generic "chat-completion" Langfuse name.
    hdr_phase = str(request.headers.get("X-Hybrid-DR-Phase", "")).strip()[:64] or None
    # Self-described call kind for non-OpenCode host services (e.g. the
    # intent classifier sends "intent-classification"): names the Langfuse
    # trace/generation for callers whose message shape carries no signal.
    call_kind = str(request.headers.get("X-Superclaw-Call-Kind", "")).strip()[:64] or None

    opencode_session_id = (request.headers.get("x-session-affinity") or "").strip()
    opencode_parent_session_id = (request.headers.get("x-parent-session-id") or "").strip()
    # Langfuse session grouping: subagents run in their own OpenCode child
    # session, so keying Langfuse sessions off the child id split one user
    # turn into several duplicate-looking session rows. Plugin
    # 91_agent_context_header.ts sends the parent id (x-parent-session-id)
    # for child sessions; prefer it so parent + subagent traces share one
    # Langfuse session. Token accounting keeps usage_session_id unchanged.
    langfuse_session_id = opencode_parent_session_id or usage_session_id

    return _ChatObservabilityContext(
        usage_session_id=usage_session_id,
        message_id=message_id,
        trace_id=trace_id,
        langfuse_trace_id=langfuse_trace_id,
        requesting_agent=requesting_agent,
        hdr_phase=hdr_phase,
        call_kind=call_kind,
        opencode_session_id=opencode_session_id,
        opencode_parent_session_id=opencode_parent_session_id,
        langfuse_session_id=langfuse_session_id,
    )
# ── agent.step_budget_exhausted detection (design §4.2 / issue #2414) ────────
#
# LRM does not own the step budget — the opencode plugins
# (`91_superclaw_step_horizon.ts`, `92_superclaw_lineage_budget.ts`) do, and
# opencode itself owns the hard `steps` cap. What LRM *can* see is the plugin's
# thrown Error coming back as a tool result inside the NEXT request's message
# history, which is exactly the string-matching #2414 says is the only way to
# observe this today. Turning it into a typed row here is the whole point: the
# bench harness can then join on session_id instead of regexing agent prose.
#
# LIMITATION, stated plainly: this observes the PLUGIN source reliably, because
# the plugin's throw becomes a tool result and the turn continues. opencode's
# own "Maximum steps ... reached" hard-stop usually ENDS the turn, so no further
# chat request carries it and LRM never sees it. That variant is matched here as
# a best-effort belt-and-braces, not as a dependable signal.
_STEP_BUDGET_SENTINELS: tuple[tuple[str, str], ...] = (
    ("STEP BUDGET EXHAUSTED", "plugin"),
    ("STEP BUDGET ALREADY EXHAUSTED", "plugin"),
    ("CROSS-SESSION BUDGET EXHAUSTED", "plugin"),
    ("LINEAGE BUDGET ALREADY EXHAUSTED", "plugin"),
    ("Maximum steps", "opencode"),
    ("MAXIMUM STEPS", "opencode"),
)

# Cheap pre-filter for the hot path. This scan runs on EVERY chat request, and a
# late-turn history can be ~300 KB of text; a plain substring test is C-speed and
# allocates nothing, where a ``.upper()`` per message would copy all of it. The
# producers emit fixed casings (TS template literals / opencode's own string), so
# matching literals costs nothing in recall.
_STEP_BUDGET_PREFILTER: tuple[str, ...] = (
    "EXHAUSTED",
    "aximum steps",
    "AXIMUM STEPS",
)

# Tool names whose successful invocation means a deliverable reached disk. The
# harness-vs-model classifier (design §6.1) turns on exactly this: a right
# answer with nothing written is a HARNESS loss wearing a model-quality costume.
_DELIVERABLE_TOOLS = frozenset(
    {"write", "edit", "patch", "multiedit", "multi_edit", "apply_patch"}
)

# Per-session dedupe: the sentinel stays in the history for the rest of the
# session, so a naive check would re-emit on every subsequent request. Keyed on
# (session, occurrence-count) so a SECOND exhaustion later in the same session
# still produces its own row. Bounded so a long-lived process cannot grow it
# without limit.
_step_budget_seen: set[tuple[str, int]] = set()
_STEP_BUDGET_SEEN_MAX = 4096


def _message_text(message: Any) -> str:
    """Flatten an OpenAI message's content to text. Tolerates the list-of-blocks
    shape as well as a plain string."""
    if not isinstance(message, dict):
        return ""
    content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = [
            block.get("text", "")
            for block in content
            if isinstance(block, dict) and isinstance(block.get("text"), str)
        ]
        return " ".join(parts)
    return ""


def _scan_step_budget(messages: Any) -> tuple[int, str, bool] | None:
    """Return ``(occurrences, source, deliverable_written)`` when the history
    carries at least one step-budget exhaustion, else ``None``.

    ``deliverable_written`` is the approximation LRM can actually make: did the
    assistant ISSUE a write/edit/patch call anywhere in this history? It is not
    a filesystem check and not proof the write succeeded — the bench harness
    still owns the artifact assertion. It is the cheap, always-available half of
    the §6.1 harness-vs-model classifier.
    """
    if not isinstance(messages, list):
        return None
    occurrences = 0
    source = "plugin"
    deliverable_written = False
    for message in messages:
        if not isinstance(message, dict):
            continue
        role = message.get("role")
        if role == "assistant":
            for call in message.get("tool_calls") or []:
                name = ((call or {}).get("function") or {}).get("name")
                if isinstance(name, str) and name.lower() in _DELIVERABLE_TOOLS:
                    deliverable_written = True
        if role not in ("tool", "assistant"):
            continue
        text = _message_text(message)
        if not text:
            continue
        if not any(needle in text for needle in _STEP_BUDGET_PREFILTER):
            continue
        for sentinel, sentinel_source in _STEP_BUDGET_SENTINELS:
            if sentinel in text:
                occurrences += 1
                source = sentinel_source
                break
    if occurrences == 0:
        return None
    return occurrences, source, deliverable_written


def _emit_step_budget_event(
    messages: Any, session_id: str | None, agent: str, model: str | None
) -> None:
    """Emit ``agent.step_budget_exhausted`` at most once per exhaustion.

    Never raises — a malformed history must cost a dropped event, not a turn.
    """
    try:
        scanned = _scan_step_budget(messages)
        if scanned is None:
            return
        occurrences, source, deliverable_written = scanned
        # Dedupe per (session, occurrence): the sentinel stays in the history
        # for the rest of the session, so without this every later request
        # would re-emit. With NO session id there is nothing to dedupe
        # against — a shared "-" key would collapse every sessionless
        # exhaustion at the same count onto one row and drop the rest — so a
        # sessionless exhaustion is always written.
        if session_id:
            key = (session_id, occurrences)
            if key in _step_budget_seen:
                return
            if len(_step_budget_seen) >= _STEP_BUDGET_SEEN_MAX:
                _step_budget_seen.clear()
            _step_budget_seen.add(key)
        record_event(
            EventType.AGENT_STEP_BUDGET_EXHAUSTED,
            session_id=session_id,
            model=model,
            attrs={
                "cap": _resolve_step_budget_cap(),
                "source": source,
                "deliverable_written": deliverable_written,
                "occurrence": occurrences,
                "agent": agent or None,
                "detected_via": "inbound_message_history",
            },
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "events: step-budget scan failed ({}: {})", exc.__class__.__name__, exc
        )


def _resolve_step_budget_cap() -> int | None:
    """The budget the SANDBOX plugin was configured with, when the host shares
    the env. Not authoritative — the plugin reads its own
    ``SUPERCLAW_STEP_BUDGET`` inside the sandbox — so ``None`` is an honest
    answer rather than a guess."""
    raw = (os.environ.get("SUPERCLAW_STEP_BUDGET") or "").strip()
    if not raw:
        return None
    try:
        return int(raw)
    except ValueError:
        return None


async def chat_completions(request: Request) -> Any:
    """POST /v1/chat/completions — agent-facing, no auth, OpenAI-compatible."""
    chat_req_id = secrets.token_hex(8)
    obs = _resolve_chat_observability_context(request, chat_req_id)
    usage_session_id = obs.usage_session_id
    message_id = obs.message_id
    trace_id = obs.trace_id
    langfuse_trace_id = obs.langfuse_trace_id
    requesting_agent = obs.requesting_agent
    hdr_phase = obs.hdr_phase
    call_kind = obs.call_kind
    opencode_session_id = obs.opencode_session_id
    opencode_parent_session_id = obs.opencode_parent_session_id
    langfuse_session_id = obs.langfuse_session_id
    started = time.monotonic()
    model_alias_requested = "?"
    stream_flag = False
    source_kind = ""
    upstream_model = ""
    in_tokens: Any = None
    out_tokens: Any = None
    status_code = 200
    error_class: str | None = None

    # Per-request correlation defaults for typed diagnostic events. Set here so
    # the deep, pure repair layers in common/tools.py can emit correlated rows
    # without threading session_id through half a dozen signatures.
    #
    # Deliberately never reset: on the streaming path the response body is
    # produced AFTER this coroutine returns, so resetting in `finally:` would
    # strip the ids off exactly the events we care about most. Each request runs
    # in its own asyncio task with its own copied context, so a value set here
    # cannot leak into another request.
    set_event_context(
        EventContext(
            session_id=usage_session_id,
            message_id=message_id,
            trace_id=trace_id,
            agent=requesting_agent or None,
        )
    )

    # Get dev purpose tracer object and try to setup a agent session level span context.
    # All trace code will be no-op if telemetry feature is disabled or trace is disabled.
    routing_tracer = tracing.get_telemetry_tracer(request, "llmrouter_manager.routing")
    # Try to pop up llm call traces in delegated agent session (not support trace nested subagents)
    context_session_id = opencode_parent_session_id or opencode_session_id
    routing_trace_ctx = tracing.root_context_from_session(context_session_id)

    # ── Context ledger state (routing/context_ledger.py) ───────────────────
    # Everything the ledger reports is initialised here so the early-return
    # paths (bad alias, 424, short-circuits) still write a null-shaped ledger
    # from the `finally:` below. The five D2 budget headers are read up front
    # (cheap, no store access) so they are persisted on the cloud path too:
    # opencode sends them on every request regardless of alias.
    budget_headers = read_budget_headers(lambda name: _read_int_header(request, name))
    cap: Optional[int] = None
    req_tokens: Optional[int] = None
    ledger_alias_resolved: Optional[str] = None
    ledger_probed_n_ctx: Optional[int] = None
    ledger_probe_from_mock = False
    ledger_cap_from_header = False
    ledger_estimate_source: Optional[str] = None
    ledger_decision: Optional[str] = None
    ledger_decision_reason: Optional[str] = None
    ledger_tracker: Optional[CompactionTracker] = None
    ledger_session_id: Optional[str] = None
    ledger_policy: Optional[RoutingPolicyConfig] = None
    ledger_cache: dict[str, dict[str, Any]] = {}
    # Seeded null-shaped BEFORE the body is parsed, so a malformed body, a
    # non-object body or an unknown alias still gets its chat.request row
    # from the `finally:` (paired with chat.completion on the same trace_id).
    # Overwritten with the real facts once the body is known.
    chat_request_attrs: dict[str, Any] = {
        "msg_count": None,
        "stream": None,
        "model_alias": None,
        "has_tools": None,
        "user_msg_chars": None,
        "parse_ok": False,
    }
    chat_request_emitted = False
    opencode_compaction_emitted = False

    def _ledger() -> dict[str, Any]:
        """Ledger attrs for THIS request, built once (after the over-limit
        decision, at the first emission site that needs them) and memoised so
        every row of the request carries the same snapshot. Never raises."""
        cached = ledger_cache.get("attrs")
        if cached is None:
            cached = safe_ledger_attrs(
                lambda: build_context_ledger(
                    app_state=request.app.state,
                    chat_req_id=chat_req_id,
                    kind=source_kind or None,
                    alias_requested=(
                        model_alias_requested if model_alias_requested != "?" else None
                    ),
                    alias_resolved=ledger_alias_resolved,
                    bundle_id=(
                        _current_bundle_id(request.app.state)
                        if source_kind in ("local", "edge")
                        else None
                    ),
                    parent_session_id=opencode_parent_session_id or None,
                    budget_headers=budget_headers,
                    cap=cap,
                    probed_n_ctx=ledger_probed_n_ctx,
                    probe_from_mock=ledger_probe_from_mock,
                    cap_from_header=ledger_cap_from_header,
                    req_tokens=req_tokens,
                    estimate_source=ledger_estimate_source,
                    decision=ledger_decision,
                    decision_reason=ledger_decision_reason,
                    tracker=ledger_tracker,
                    session_id=ledger_session_id,
                    max_context=ledger_policy.max_context if ledger_policy else None,
                    max_input_tokens=(
                        ledger_policy.max_input_tokens if ledger_policy else None
                    ),
                )
            )
            ledger_cache["attrs"] = cached
        return cached

    def _emit_chat_request() -> None:
        """Write the chat.request row exactly once. Called after the
        over-limit block on the normal path (so the row carries the ledger)
        and from the `finally:` for the early-return paths."""
        nonlocal chat_request_emitted
        if chat_request_emitted:
            return
        chat_request_emitted = True
        attrs = dict(chat_request_attrs)
        # The ledger costs a file read + a Store read on the local path; only
        # pay it when the info row will actually be written.
        if should_write("info"):
            attrs.update(_ledger())
        record_event(EventType.CHAT_REQUEST, model=upstream_model or None, attrs=attrs)

    def _emit_opencode_compaction() -> None:
        """Record an OBSERVED opencode compaction: this request is the summary
        step (``Superclaw-Agent: compaction``) and no LRM synthetic 400
        preceded it in this session. Exactly one row per request; called after
        the over-limit block so the ledger is complete, and from the
        `finally:` in case this very request left early (e.g. it was itself
        over the cap and got LRM's 400)."""
        nonlocal opencode_compaction_emitted
        if opencode_compaction_emitted or requesting_agent != COMPACTION_AGENT:
            return
        opencode_compaction_emitted = True
        if _consume_lrm_trigger(usage_session_id, time.monotonic(), chat_req_id):
            # The summary that follows LRM's own trigger — already recorded
            # as authority=lrm on the request that got the 400.
            return
        ledger = _ledger()
        record_event(
            EventType.CONTEXT_COMPACTION_TRIGGERED,
            model=upstream_model or None,
            attrs={
                "authority": "opencode",
                "evidence": "superclaw-agent-header",
                "reason": "summary_request_observed",
                "usable_at_trigger": ledger.get("oc_usable"),
                "req_estimate": ledger.get("lrm_req_estimate"),
                "lrm_trigger_preceded": False,
                "stream": stream_flag,
                **ledger,
            },
        )

    span_chat_name = requesting_agent or "unknown-agent"
    root_span = tracing.start_span(
        routing_tracer,
        f"llmrouter.chat.{span_chat_name}",
        context=routing_trace_ctx,
        attributes={
            "llmrouter.request.session_id": opencode_session_id or None,
            "llmrouter.request.agent": requesting_agent or None,
            "llmrouter.request.session_trace_derived": bool(routing_trace_ctx is not None),
        },
    )
    root_ended_in_stream = False
    local_request_lease: LocalRequestLease | None = None
    try:
        try:
            body = await request.json()
        except Exception as exc:
            status_code = 400
            error_class = "InvalidJSON"
            tracing.record_exception(root_span, exc)
            raise HTTPException(status_code=400, detail=f"Invalid JSON body: {exc}")

        if not isinstance(body, dict):
            status_code = 400
            error_class = "InvalidBody"
            tracing.mark_error(root_span, "Request body must be a JSON object")
            raise HTTPException(status_code=400, detail="Request body must be a JSON object")

        model_alias = str(body.get("model", "auto"))
        model_alias_requested = model_alias
        # The body parsed and is an object: record that and the raw alias now,
        # so an unknown-alias 400 below still pairs a chat.request that names
        # what was asked for (chat.completion records the same string).
        chat_request_attrs["parse_ok"] = True
        chat_request_attrs["model_alias"] = model_alias
        tracing.set_attributes(
            root_span,
            {
                "llmrouter.request.model_alias": model_alias_requested
            },
        )
        if model_alias not in _KNOWN_MODEL_ALIASES:
            status_code = 400
            tracing.mark_error(root_span, "invalid model alias")
            return error_response(
                "invalid_model",
                f"model {model_alias!r} is not a known alias",
                status_code=400,
                details={
                    "model_requested": model_alias,
                    "hint": f"model must be one of {sorted(_KNOWN_MODEL_ALIASES)}",
                },
            )
        req_stream = bool(body.get("stream", False))
        stream_flag = req_stream

        # Break the compound-prefix feedback loop: strip prior LRM-injected
        # prefixes from assistant history before upstream sees them.
        sanitize_assistant_history(body.get("messages"))

        raw_messages = body.get("messages")
        msg_count = len(raw_messages) if isinstance(raw_messages, list) else 0
        # Scanned once and reused: `_last_user_msg_text` walks the whole history
        # and this is the hot path. The chat.request event below records only
        # the char count, which is what `_fmt_user_msg_for_log` masks down to.
        last_user_text = _last_user_msg_text(raw_messages)
        user_msg_chars = len(last_user_text)
        user_msg_render = _fmt_user_msg_for_log(last_user_text)
        tracing.set_attributes(
            root_span,
            {
                # Masked to a char-count only ([masked N chars]) — carries no PII.
                # Still keep it out of metric attributes; traces stay in the
                # approved internal collector.
                "llmrouter.request.user_msg": user_msg_render,
                "llmrouter.request.has_tools": "tools" in body,
                "llmrouter.request.stream": req_stream,
            },
        )
        logger.info(
            'chat.request chat_req_id={} model={} agent={} stream={} msg_count={} user_msg="{}"',
            chat_req_id,
            model_alias,
            requesting_agent or "?",
            1 if stream_flag else 0,
            msg_count,
            user_msg_render,
        )
        # Same facts as the line above, as a queryable row. Deliberately NOT the
        # message history: `msg_count` and the already-masked user-message LENGTH
        # are the whole signal, and serialising the bodies would put the prompt
        # (and its PII) in the store and cost a copy on every request.
        # Emitted AFTER the over-limit block (see _emit_chat_request) so the
        # row carries the context ledger — alias, locality, cap, the D2
        # headers and the decision. The `finally:` emits it for the
        # early-return paths with a null-shaped ledger.
        chat_request_attrs = {
            "msg_count": msg_count,
            "stream": stream_flag,
            "model_alias": model_alias,
            "has_tools": "tools" in body,
            "user_msg_chars": user_msg_chars,
            "parse_ok": True,
        }

        # Typed row for a step-budget exhaustion the sandbox plugins reported
        # in this history. See the module-level notes above _scan_step_budget.
        _emit_step_budget_event(
            raw_messages, usage_session_id, requesting_agent, None
        )

        # auto routing contract: invoke the latency router ONLY when both cloud and
        # local slots are configured (otherwise the router has nothing to decide).
        # On router failure, fall back to cloud-model — auto must produce a working
        # result whenever at least one slot exists. Falls through to `_resolve_alias`
        # for the single-slot and neither-configured cases (the latter returns 424).
        if model_alias == "auto":
            cloud_cfg = _load_cloud_model_config()
            # "local slot available" for auto = the SELECTED provider can serve
            # right now (live llama or configured edge, with fallback). Reuse the
            # exact same resolver the data plane uses so the router only runs when
            # auto genuinely has two slots to choose between.
            _probe_kind, local_probe_cfg, _probe_reason = _resolve_alias(
                "local-model", app_state=request.app.state
            )
            local_slot_available = local_probe_cfg is not None
            if cloud_cfg is not None and local_slot_available:
                from .auto_router.adapter import RouterFailure, get_adapter

                query = _extract_query_text(body.get("messages", []))
                decision: str | RouterFailure
                auto_span = tracing.start_span(
                    routing_tracer,
                    "llmrouter.auto.decide",
                    context=tracing.child_context(root_span, routing_trace_ctx),
                    attributes={
                        "llmrouter.auto.query_chars": len(query),
                        "llmrouter.auto.fallback_to_cloud": False,
                    },
                )

                if query:
                    prewarm_done = getattr(request.app.state, "prewarm_done", None)
                    if prewarm_done is not None:
                        prewarm_wait_s = _read_float_env(
                            "LRM_PREWARM_WAIT_S", default=2.0, minimum=0.0
                        )
                        if prewarm_wait_s > 0:
                            try:
                                await asyncio.wait_for(prewarm_done.wait(), timeout=prewarm_wait_s)
                            except asyncio.TimeoutError:
                                tracing.add_event(root_span, "prewarm_wait_timeout")
                                logger.warning(
                                    "[auto] prewarm still running after {:.1f}s; continuing with bounded router path",
                                    prewarm_wait_s,
                                )
                    # The latency router does blocking work (first-call pickle/joblib
                    # artefact load + a synchronous httpx POST to the edge embeddings
                    # endpoint). Running it inline would block the asyncio event loop,
                    # freezing this service's own /health endpoint long enough for the
                    # ServiceHub watchdog to kill and restart-exhaust us into
                    # state="error" ("LLMRouter Manager is not healthy"). Offload to a
                    # worker thread so the loop stays responsive, and bound it so a slow
                    # router degrades to the cloud-model fallback instead of stalling the
                    # request. A timed-out thread keeps running and warms the adapter
                    # cache for the next call.
                    route_timeout_s = _read_float_env(
                        "LRM_AUTO_ROUTE_TIMEOUT_S", default=8.0, minimum=1.0
                    )
                    tracing.set_attributes(
                        auto_span,
                        {"llmrouter.auto.timeout_budget_ms": int(route_timeout_s * 1000)},
                    )
                    try:
                        decision = await asyncio.wait_for(
                            asyncio.to_thread(get_adapter().resolve_auto, query),
                            timeout=route_timeout_s,
                        )
                    except asyncio.TimeoutError:
                        logger.warning(
                            "[auto] latency router exceeded {:.1f}s budget; falling back to cloud-model",
                            route_timeout_s,
                        )
                        tracing.set_attributes(
                            auto_span,
                            {
                                "llmrouter.auto.failure_code": "router_timeout",
                                "llmrouter.auto.fallback_to_cloud": True,
                            },
                        )
                        decision = RouterFailure(
                            error="router_timeout",
                            hint=f"latency router exceeded {route_timeout_s:.1f}s budget",
                        )
                    except Exception as exc:
                        logger.exception(
                            "[auto] latency router adapter raised; falling back to cloud-model"
                        )
                        tracing.record_exception(auto_span, exc)
                        tracing.set_attributes(auto_span, {"llmrouter.auto.fallback_to_cloud": True})
                        decision = RouterFailure(error="router_internal_error", hint=str(exc))
                else:
                    tracing.set_attributes(
                        auto_span,
                        {
                            "llmrouter.auto.failure_code": "empty_query",
                            "llmrouter.auto.fallback_to_cloud": False,
                        },
                    )
                    decision = RouterFailure(
                        error="empty_query",
                        hint="model=auto requires at least one non-empty user message",
                    )
                if isinstance(decision, str):
                    model_alias = decision
                    tracing.set_attributes(auto_span, {"llmrouter.auto.decision": decision})
                else:
                    logger.warning(
                        "[auto] latency router unavailable ({}): {} — falling back to cloud-model",
                        decision.error,
                        decision.hint,
                    )
                    tracing.set_attributes(
                        auto_span,
                        {
                            "llmrouter.auto.failure_code": decision.error,
                            "llmrouter.auto.fallback_to_cloud": True,
                        },
                    )
                    tracing.mark_error(auto_span, decision.error)
                    model_alias = "cloud-model"
                tracing.end_span(auto_span)

        kind, cfg, reason = _resolve_alias(
            model_alias,
            app_state=request.app.state,
        )
        source_kind = kind
        ledger_alias_resolved = model_alias
        tracing.set_attributes(
            root_span,
            {
                "llmrouter.decision": model_alias,
                "llmrouter.result_kind": kind,
                "llmrouter.upstream.model": cfg.model_id if cfg is not None else None,
                "llmrouter.bundle_revision": cfg.bundle_revision if cfg is not None else None,
                "llmrouter.binding_revision": cfg.binding_revision if cfg is not None else None,
            },
        )
        if cfg is None:
            # No backend configured for this slot is a CONFIG error, not a
            # transient server fault — retrying never makes a provider appear.
            # Return 424 (non-retryable) rather than 503: the OpenAI-compat AI
            # SDK retries 408/409/429 + all 5xx with exponential backoff, so a
            # 503 here wedges a caller (e.g. a `local-model`-pinned subagent on
            # a cloud-only box) in a 2→4→…→64s retry loop that the blocking
            # parent `task()` call — and thus the UI — freezes behind for
            # minutes. 424 fails fast so the error surfaces immediately. The
            # `no_provider_available` envelope is unchanged so ServiceHub's
            # normalizer and log/telemetry consumers are unaffected.
            status_code = 424
            if reason == "local_not_configured":
                message = f"no local provider is selected for model {model_alias!r}"
                hint = (
                    "Select a local backend via PUT "
                    "/llm-router/v1/model-selections/local-provider "
                    '("llamacpp" or "edge"), then configure it (download a local '
                    "model, or PUT /llm-router/v1/edge)."
                )
            else:
                message = f"no provider is configured for model {model_alias!r}"
                hint = (
                    "Configure via PUT /llm-router/v1/cloud/providers/{id} + "
                    "PUT /llm-router/v1/cloud/model (cloud), or PUT "
                    "/llm-router/v1/edge (edge)."
                )
            return error_response(
                reason,
                message,
                status_code=424,
                details={
                    "model_requested": model_alias,
                    "hint": hint,
                },
            )
        upstream_model = cfg.model_id

        _policy = RoutingPolicyConfig.resolve()

        # Strip the UI-only control prefix before deriving either the cloud body
        # or the final local body.
        _ = strip_leading_agent_mention(body, requesting_agent)

        # Build the exact local/edge request shape before counting it. Keep the
        # original body intact until routing is final so local-only transforms
        # can never leak into an auto request that escalates to cloud.
        local_body: dict[str, Any] | None = None
        local_policy_applied: dict[str, Any] | None = None
        local_grammar_stripped: int = 0  # count of stripped schema keys (the helper returns int)
        if kind != "cloud":
            local_body = copy.deepcopy(body)
            if _policy.enabled:
                local_policy_applied = apply_model_policy(
                    local_body, cfg.model_id, requesting_agent
                )
            if kind == "local" and isinstance(local_body.get("tools"), list):
                # The opencode plugin sends the grade's dispatchable sub-agents in
                # this comma-separated header. Pass that list to the local grammar
                # sanitizer so it can tighten `task.subagent_type` to the real
                # roster. The router does not keep its own agent list; if the header
                # is missing or empty, the sanitizer leaves `subagent_type` as-is.
                subagent_names = tuple(
                    name
                    for name in (
                        part.strip()
                        for part in str(
                            request.headers.get("superclaw-task-subagents", "")
                        ).split(",")
                    )
                    if name
                )
                if os.environ.get("LRM_SANITIZE_LOCAL_TOOL_GRAMMAR", "1") != "0":
                    local_grammar_stripped = sanitize_tool_schemas_for_local_grammar(
                        local_body, subagent_names
                    )
            if not _policy.enabled:
                body = local_body

        # ── Serving-policy: over-limit handling (COMPACT_LOCALLY vs escalate) ──
        # On by default (disable via LATENTFACTOR_ROUTING_POLICY=0). Applies only
        # to a LOCAL/edge-resolved request (kind != "cloud"): if it exceeds the local
        # context cap (auto-derived from the live server), either return a
        # synthetic context_length_exceeded 400 so opencode compacts + retries
        # (budget remaining), or escalate this request to the cloud slot
        # (budget spent / fresh-read / sticky-blob). See policy/middleware.py and
        # plan §5b/§9. NOTE (§9): escalation is NOT file-protection-gated in this
        # integration — a file-touched session still escalates; deferred follow-up.
        # Headroom-aware per-turn output ceiling for the LOCAL path. Initialised
        # BEFORE the block because the clamp site below is outside it; None means
        # "no headroom signal" and the clamp keeps the flat per-model value.
        local_output_ceiling: Optional[int] = None
        # Hoisted out of the policy block below so the context.overflow event on
        # the UPSTREAM-reject path can still report the cap the router resolved
        # (a row without its cap is unreadable: the same workload overflows at
        # 90,784 and sails through at 252,928). None means "policy never ran".
        cap = None
        req_tokens = None
        ledger_policy = _policy
        if _policy.enabled and kind != "cloud":
            session_id = _sanitize_session_id(
                str(request.headers.get("superclaw-session", ""))
            )
            tracker = _get_compaction_tracker(_policy)
            ledger_tracker = tracker
            ledger_session_id = session_id
            probed = _probe_local_n_ctx_cached(cfg)
            # Under the dev Bundle mock the probe cannot answer -- a remote
            # OpenAI-compatible endpoint publishes no per-model window -- so the
            # cap would resolve to None and the context guard would sit INERT.
            # The overlay declares the window (mirroring the shipped bundle), so
            # stand it in for the probe result. It must go in as a *probed n_ctx*,
            # not as upstream_cap: upstream_cap is a static already-computed input
            # cap returned raw, so using it would skip the output_reserve/safety
            # subtraction and leave the ceiling ~9.2k tokens too permissive --
            # admitting prompts a real B70 rejects, which is the opposite of what
            # this fallback is for. Feeding the probe slot yields the same
            # 100000 -> ~90,784 the hardware resolves.
            if probed is None:
                probed = mock_bundle.declared_chat_ctx()
                ledger_probe_from_mock = probed is not None
            ledger_probed_n_ctx = probed
            cap = resolve_cap_from_probe(_policy, probed)
            # OpenCode deliberately advertises a larger virtual window so LRM is
            # the sole compaction authority. Its estimate is useful evidence but
            # cannot be authoritative for the smaller concrete local model: on
            # the real 4B its chars/4 header read 0.45–0.56x the server's count
            # on log/CSV bodies (2026-09-17), which is how 90K-token reads were
            # admitted under a 56K cap and rejected by llama.cpp instead of
            # compacted. Both numbers are computed and the larger one governs.
            # Fall back to the engine's own usable window when our local-server
            # probe hasn't warmed up yet, so a cold probe doesn't mean "no cap".
            opencode_usable = _read_int_header(request, "x-opencode-context-usable")
            opencode_estimate = _read_int_header(request, "x-opencode-next-request-estimate")
            if cap is None and opencode_usable is not None and opencode_usable > 0:
                cap = opencode_usable
                ledger_cap_from_header = True
            # Count the body llama.cpp will actually see (after the local-only
            # prompt/tool transform above), not the one opencode estimated. The
            # cheap chars/6 floor still rejects an implausibly small header
            # (incl. a spoofed 0) from being NAMED as the governing side; the
            # max() means it could never lower req_tokens anyway.
            local_estimate = request_token_len(local_body or body)
            valid_opencode_estimate = (
                opencode_estimate
                if opencode_estimate is not None
                and opencode_estimate >= _cheap_token_floor(local_body or body)
                else None
            )
            req_tokens = max(local_estimate, valid_opencode_estimate or 0)
            estimate_source = (
                "opencode_header"
                if valid_opencode_estimate is not None
                and valid_opencode_estimate >= local_estimate
                else "lrm_tokenizer"
            )
            ledger_estimate_source = estimate_source
            # Both numbers are always in hand now, so the drift line costs
            # nothing extra: log whenever the two tokenizers disagree by more
            # than _TOKEN_ESTIMATE_DRIFT_WARN_RATIO. `effective` is the value
            # that governed admission.
            if valid_opencode_estimate is not None and local_estimate > 0:
                drift = abs(local_estimate - valid_opencode_estimate) / local_estimate
                if drift > _TOKEN_ESTIMATE_DRIFT_WARN_RATIO:
                    logger.warning(
                        "token_estimate_drift chat_req_id={} opencode={} lrm={} effective={} drift={:.0%}",
                        chat_req_id, valid_opencode_estimate, local_estimate,
                        req_tokens, drift,
                    )
            has_cloud = _load_cloud_model_config() is not None
            # Escalate to cloud only when the caller left the choice to the router
            # (an "auto" request). An explicit "local-model" pin (router-bypass)
            # means the caller demanded local: honor the local n_ctx and compact
            # locally, but never divert to cloud (else a force-local run leaks
            # cloud tokens). model_alias_requested is the original alias, captured
            # before any auto-routing mutation.
            allow_escalate = (model_alias_requested == "auto")
            # The compaction agent's summary request follows every synthetic
            # 400 on the SAME session and is always under cap; without this
            # flag it refunded the preventive budget on every cycle (every
            # COMPACT_LOCALLY line read 1/2). See decide_over_limit.
            is_compaction_request = (requesting_agent == COMPACTION_AGENT)
            over_limit_decision = decide_over_limit(
                tracker=tracker,
                session_id=session_id,
                req_tokens=req_tokens,
                cap=cap,
                has_cloud=has_cloud,
                now=time.monotonic(),
                allow_escalate=allow_escalate,
                is_compaction_request=is_compaction_request,
            )
            ledger_decision = over_limit_decision.action
            ledger_decision_reason = over_limit_decision.reason
            if over_limit_decision.action == COMPACT:
                tracker.note_tokens(session_id, req_tokens, time.monotonic())
                # Set observability state before returning — the `finally:` block reads
                # both to emit the chat.completion log line with the correct status/error.
                status_code = 400
                error_class = "ContextOverflowCompactLocally"
                # This is a RECOVERABLE, by-design 400: opencode compacts and
                # retries. It is therefore NOT `context.overflow` (decision
                # 2026-09-15 — that type keeps exactly one meaning, "the prompt
                # provably did not fit", i.e. the upstream reject below); an
                # error row for a healthy compaction would make
                # `GROUP BY event_type` lie, the one property the store
                # exists for. The warn row here is the whole record: it ships
                # in release builds (always written, never gated) and carries
                # `cap`, `bundle` (via the ledger) and the budget arithmetic.
                # `authority` is "lrm": this synthetic 400 is LRM's decision.
                # The summary request opencode sends next is attributed back
                # to it via _note_lrm_trigger, so it is not counted twice.
                _note_lrm_trigger(usage_session_id, time.monotonic(), chat_req_id)
                _budget_max = tracker.max_local_compaction
                _budget_used = over_limit_decision.local_n
                record_event(
                    EventType.CONTEXT_COMPACTION_TRIGGERED,
                    model=cfg.model_id,
                    attrs={
                        "authority": "lrm",
                        "evidence": "synthetic_400",
                        "reason": "over_cap_budget_left",
                        "has_cloud": has_cloud,
                        "allow_escalate": allow_escalate,
                        "usable_at_trigger": cap,
                        "req_estimate": req_tokens,
                        "budget_max": _budget_max,
                        "budget_used": _budget_used,
                        "budget_left_after": max(0, _budget_max - _budget_used),
                        "stream": stream_flag,
                        **_ledger(),
                    },
                )
                return _compact_locally_response(cfg.model_id, req_tokens, cap or 0)
            if over_limit_decision.action == ESCALATE:
                tracker.note_tokens(session_id, req_tokens, time.monotonic())
                tracker.mark_cloud_sticky(session_id, time.monotonic())
                logger.info(
                    "chat.escalate chat_req_id={} reason={} tokens={} cap={} → cloud-model",
                    chat_req_id, over_limit_decision.reason, req_tokens, cap,
                )
                kind, cfg, reason = _resolve_alias("cloud-model", app_state=request.app.state)
                if cfg is None:
                    # Should not happen (has_cloud checked), but fail safe.
                    return error_response(
                        "no_provider_available",
                        "escalation target cloud-model is not configured",
                        status_code=424,
                        details={"model_requested": "cloud-model"},
                    )
                source_kind = kind
                upstream_model = cfg.model_id
                ledger_alias_resolved = "cloud-model"
                local_body = None
            else:
                body = local_body or body
                # PROCEED — record tokens so the next turn can detect a jump.
                # Not for the compaction agent: its small summary request would
                # replace the original agent's baseline and make the retried
                # turn read as a fresh read.
                if not is_compaction_request:
                    tracker.note_tokens(session_id, req_tokens, time.monotonic())
                if over_limit_decision.reason == "over-cap-no-cloud":
                    # Over the cap with every recoverable option gone: the
                    # local budget is spent (or disabled, or the session is
                    # untracked) and escalation is impossible. The request is
                    # FORWARDED and the upstream's window is now the authority:
                    # it may fit (the estimate is conservative) or come back
                    # as context.overflow{source: upstream_reject}. Always
                    # written — this is the turn the user will report.
                    _budget_max = tracker.max_local_compaction
                    _budget_used = tracker.local_compactions(session_id)
                    if not session_id:
                        _exhausted_reason = "untracked_session"
                    elif _budget_max == 0:
                        _exhausted_reason = "compaction_disabled"
                    else:
                        _exhausted_reason = "budget_spent"
                    record_event(
                        EventType.CONTEXT_COMPACTION_EXHAUSTED,
                        model=cfg.model_id,
                        attrs={
                            "authority": "lrm",
                            "reason": _exhausted_reason,
                            "escalation_blocked_by": (
                                "no_cloud" if not has_cloud else "local_pin"
                            ),
                            "usable_at_trigger": cap,
                            "req_estimate": req_tokens,
                            "budget_max": _budget_max,
                            "budget_used": _budget_used,
                            "budget_left_after": max(0, _budget_max - _budget_used),
                            "has_cloud": has_cloud,
                            "allow_escalate": allow_escalate,
                            "stream": stream_flag,
                            **_ledger(),
                        },
                    )
                if kind == "local":
                    # Scoped to the llamacpp path because that is the only path the
                    # clamp below applies the ceiling to. Deriving it for `edge` as
                    # well would log an out_ceiling= that nothing acts on, which
                    # reads as a live limit in log-based evidence.
                    local_output_ceiling = resolve_output_ceiling(
                        cap, _policy.output_reserve, req_tokens
                    )
                # Log the forwarded estimate on the PROCEED path too (COMPACT and
                # ESCALATE already log). This is what lets us compare req_tokens
                # against the cap and against the server's real n_prompt_tokens
                # per turn — the signal needed to spot output accumulation (an
                # assistant turn's output stacking into the next prompt) or an
                # estimate/render gap. Without it the passing-request estimate was
                # never recorded, so the only observable turns were the ones
                # already in trouble.
                headroom = (cap - req_tokens) if cap is not None else None
                logger.info(
                    "chat.ctx_proceed chat_req_id={} agent={} model={} req_tokens={} "
                    "cap={} headroom={} out_ceiling={}",
                    chat_req_id, requesting_agent or "?", cfg.model_id, req_tokens, cap,
                    headroom,
                    local_output_ceiling,
                )
                # THE row of this batch: the effective cap, on every passing
                # turn. A run whose output records no cap cannot be read six
                # weeks later — the same workload overflows at 90,784 and sails
                # through at 252,928, and the failure mode under investigation
                # is structurally invisible at the larger window. `bundle` says
                # WHICH window that was, but it costs a store read, so it is
                # only resolved when the row will actually be written (info is
                # gated on SUPERCLAW_DEBUG_OBSERVABILITY).
                record_event(
                    EventType.CHAT_CTX_PROCEED,
                    model=cfg.model_id,
                    attrs={
                        "req_tokens": req_tokens,
                        "cap": cap,
                        "headroom": headroom,
                        "out_ceiling": local_output_ceiling,
                        "bundle": (
                            _current_bundle_id(request.app.state)
                            if should_write("info")
                            else None
                        ),
                        "estimate_source": estimate_source,
                        "stream": stream_flag,
                        **(_ledger() if should_write("info") else {}),
                    },
                )

        # The chat.request row, now that alias, locality, cap and the
        # over-limit decision are all known (see _emit_chat_request), and the
        # observed-opencode-compaction row if this is a summary request.
        _emit_chat_request()
        _emit_opencode_compaction()

        # ── Serving-policy: model-aware request transform (prompt + tools) ────
        # The local-only transforms (short task-hardened prompt for weak locals,
        # tool drops for tools the model loops on — keyed on model_profiles.json,
        # see plan §11) were applied to a COPY before context accounting, so the
        # body that was counted is the body that is dispatched. Reaching here
        # means the route stayed local/edge; an ESCALATED request (kind now
        # "cloud") discarded that copy and carries the untouched body.
        if _policy.enabled and kind != "cloud":
            if local_policy_applied:
                set_repeat_locked_tools(
                    local_policy_applied.get("repeat_tool_terminal_lock") or ()
                )
                logger.info(
                    "chat.model_policy chat_req_id={} model={} agent={} applied={}",
                    chat_req_id, cfg.model_id, requesting_agent or "?", local_policy_applied,
                )
                # `applied` is already a small summary dict built by
                # apply_model_policy (prompt-file name, bools, tool-name lists)
                # — not the transformed body — so it is safe to record whole.
                record_event(
                    EventType.CHAT_MODEL_POLICY,
                    model=cfg.model_id,
                    attrs={"applied": local_policy_applied},
                )

        # ── Hybrid Deep Research terminal short-circuit (local/edge only) ─────
        # On a turn that already carries a terminal DR result, the weak local
        # driver only loops (re-calling hybrid_dr_post_polish_processor until
        # opencode's MAXIMUM STEPS) or, when the tool is dropped, emits residual
        # <tool_call> text. The correct output is fully determined by the terminal
        # status, so emit that one line directly instead of calling the model —
        # nothing to loop on, no tool-call text for opencode to re-parse (issues
        # #1633 / #1576). Kill-switch: HYBRID_DR_TERMINAL_SHORTCIRCUIT=0.
        if (
            _policy.enabled
            and kind != "cloud"
            and requesting_agent == HYBRID_DR_AGENT
            and os.environ.get("HYBRID_DR_TERMINAL_SHORTCIRCUIT", "1") != "0"
        ):
            hdr_line = hybrid_dr_terminal_reply(body.get("messages"))
            if hdr_line is not None:
                logger.info(
                    "chat.hybrid_dr_terminal_lock chat_req_id={} model={} agent={} stream={} → short-circuit reply",
                    chat_req_id, cfg.model_id, requesting_agent, req_stream,
                )
                return _hybrid_dr_shortcircuit_response(cfg.model_id, hdr_line, req_stream)

    

        # ── llama.cpp grammar sanitization (llamacpp path only) ───────────────
        # Applied to the local copy above, before counting. Scoped to
        # kind == "local" (the llama-server backend): its regex→GBNF converter
        # emits `\d`/`\w`/`\s` from a schema `pattern` that its own parser then
        # rejects ("unknown escape" → "failed to parse grammar" → 400 for the
        # whole tools[] union). Strips validation-only `format`/`pattern` from
        # tool schemas so the grammar compiles. Edge (vLLM/xgrammar) and cloud
        # handle the full schemas, so they're untouched (an escalated request
        # dropped the copy). Kill-switch: LRM_SANITIZE_LOCAL_TOOL_GRAMMAR=0.
        # See common/tools.py.
        if local_grammar_stripped:
            logger.info(
                "chat.grammar_sanitize chat_req_id={} model={} stripped_keys={}",
                chat_req_id, cfg.model_id, local_grammar_stripped,
            )

        # ── Local per-step output-token clamp (llamacpp path only) ────────────
        # Same scoping as the grammar sanitize above (AFTER escalation, so a
        # request escalated to cloud is skipped). The output-token-cap plugin
        # caps max_tokens at 16384 for the edge window; the flat clamp below
        # brought that back to the local model's configured limit because 16384
        # on a slow local box reads as a hung turn. Edge/cloud untouched.
        # The single write point for max_tokens: local_output_ceiling (when the
        # context guard produced one) replaces the flat per-model value here
        # rather than adding a second clamp further down the dispatch.
        #
        # The ceiling can therefore restore the full 16384 whenever the window has
        # room, which partly undoes the latency argument the flat clamp was added
        # for (#1622). Measured 2026-07-30 on the installed app (B390 / 64 GB,
        # qwen3.6-35b-a3b): a 16384-token step is 304 s at a 44.8k prompt and 374 s
        # at 69.7k. The binding client-side deadline is opencode's provider
        # ``timeout: 600000`` (sandbox/agent_config/profiles/pro/opencode.jsonc), so
        # break-even is 16384/600 ≈ 27.3 tok/s and the measured 43.8 tok/s leaves
        # ~38% margin on that box. A slower iGPU, or a deeper context than 70k,
        # narrows it — if a full-length step ever starts tripping the provider
        # deadline, bound LOCAL_OUTPUT_CEILING_MAX by a wall-clock budget rather
        # than lowering it blindly.
        if kind == "local":
            clamped = clamp_local_output_tokens(body, ceiling=local_output_ceiling)
            if clamped is not None:
                logger.info(
                    "chat.local_output_clamp chat_req_id={} model={} -> max_tokens={}",
                    chat_req_id, cfg.model_id, clamped,
                )

        # ── Session-locality tracking for GET /v1/session/{id}/locality ──────
        # Store the final route after escalation so sandbox tools can tell if a
        # session stayed local/edge.
        if usage_session_id:
            try:
                locality_store = Store(default_db_path())
                try:
                    locality_store.set_config(
                        f"routing.session_locality.{_sanitize_session_id(usage_session_id)}",
                        kind,
                    )
                finally:
                    locality_store.close()
            except Exception:
                pass

        if kind == "local":
            local_request_lease = request.app.state.local_request_admission.try_admit()
            if local_request_lease is None:
                status_code = 503
                error_class = "ModelBindingTransitionInProgress"
                return error_response(
                    "model_binding_transition_in_progress",
                    "Local model binding transition is in progress; retry shortly.",
                    status_code=503,
                    headers={"Retry-After": "1"},
                )

        result: Any
        if kind == "cloud":
            if cfg.auth_mode == "oauth":
                from ..oauth import dispatch as oauth_dispatch

                result = await oauth_dispatch.call(
                    cfg.provider,
                    cfg.model_id,
                    body,
                    alias=model_alias_requested,
                    session_id=usage_session_id,
                    message_id=message_id,
                    trace_id=trace_id,
                    langfuse_trace_id=langfuse_trace_id,
                    hdr_phase=hdr_phase,
                    call_kind=call_kind,
                    langfuse_session_id=langfuse_session_id,
                )
            else:
                result = await _call_via_litellm(
                    cfg,
                    body,
                    req_stream=req_stream,
                    telemetry_tracer=routing_tracer,
                    telemetry_parent_span=root_span,
                    telemetry_runtime=getattr(request.app.state, "telemetry_runtime", None),
                    request_started_at=started,
                    alias=model_alias_requested,
                    session_id=usage_session_id,
                    message_id=message_id,
                    trace_id=trace_id,
                    langfuse_trace_id=langfuse_trace_id,
                    hdr_phase=hdr_phase,
                    call_kind=call_kind,
                    langfuse_session_id=langfuse_session_id,
                )
        else:
            result = await _httpx_chat_completions(
                cfg,
                body,
                req_stream,
                source=cast(Source, kind),
                telemetry_tracer=routing_tracer,
                telemetry_parent_span=root_span,
                telemetry_runtime=getattr(request.app.state, "telemetry_runtime", None),
                request_started_at=started,
                alias=model_alias_requested,
                session_id=usage_session_id,
                message_id=message_id,
                trace_id=trace_id,
                langfuse_trace_id=langfuse_trace_id,
                hdr_phase=hdr_phase,
                call_kind=call_kind,
                langfuse_session_id=langfuse_session_id,
                # Reactive budget (CompactionTracker.upstream_overflows) clears
                # only once the ORIGINAL agent's stream completes — the
                # compaction agent's summary finishing proves nothing.
                on_stream_success=(
                    lambda: _get_compaction_tracker(_policy).clear_upstream_overflows(
                        _sanitize_session_id(
                            str(request.headers.get("superclaw-session", ""))
                        )
                    )
                    if requesting_agent != COMPACTION_AGENT
                    else None
                ),
            )

        if (
            isinstance(result, JSONResponse)
            and result.headers.get("x-latentfactor-context-overflow") == "1"
        ):
            status_code = result.status_code
            error_class = "ContextOverflowUnrecoverable"
            # The upstream itself rejected the rendered prompt. Authoritative —
            # unlike the router's pre-check estimate this proves the prompt did
            # not fit, so it is the same event_type with a different `source`.
            record_event(
                EventType.CONTEXT_OVERFLOW,
                model=cfg.model_id,
                attrs={
                    "req_tokens": req_tokens,
                    "cap": cap,
                    "bundle": _current_bundle_id(request.app.state),
                    "source": "upstream_reject",
                    "status": result.status_code,
                    "stream": stream_flag,
                    **_ledger(),
                },
            )

        # ── Tool-call hardening (weak local/edge models, non-streaming) ───────
        # Repair a weak model's malformed tool calls (unparseable JSON args,
        # hallucinated tool names, non-int offset/limit) before opencode's schema
        # validator rejects them. Restored from the deleted in-container router;
        # pure layers live in common/tools.py. Cloud is skipped (strong models,
        # and cloud dispatch returns a JSONResponse rather than the dict these
        # repairs walk). NOTE (skeleton): the streaming path is not yet hardened
        # — harden_with_retries needs the complete non-stream OpenAI shape, so a
        # streaming response must first be buffered into one result and replayed
        # (see the TODO in harden_with_retries). Only non-streaming local/edge is
        # wired here.
        if (
            not req_stream
            and isinstance(result, dict)
            and should_harden_kind(kind)
            and isinstance(body.get("tools"), list)
        ):
            async def _redispatch(retry_body: dict) -> Any:
                if _policy.enabled:
                    apply_qwen_system_compat(retry_body, cfg.model_id)
                return await _httpx_chat_completions(
                    cfg,
                    retry_body,
                    False,
                    source=cast(Source, kind),
                    telemetry_tracer=routing_tracer,
                    telemetry_parent_span=root_span,
                    alias=model_alias_requested,
                    session_id=usage_session_id,
                    message_id=message_id,
                    trace_id=trace_id,
                    langfuse_trace_id=langfuse_trace_id,
                    hdr_phase=hdr_phase,
                    call_kind=call_kind,
                    langfuse_session_id=langfuse_session_id,
                )

            result = await harden_with_retries(
                result,
                body,
                body.get("tools"),
                _redispatch,
                max_retries=resolve_hardening_max_retries(
                    None, os.environ.get("LRM_TOOLCALL_HARDENING_MAX_RETRIES")
                ),
                requesting_agent=requesting_agent,
            )

        # ── Tool-call hardening (weak local/edge models, streaming) ───────────
        # Chunk-level: content deltas stream straight through; only the (short)
        # tool-call deltas are buffered, reconstructed, repaired in place (M1
        # drop / M2 JSON / M4 / M5 / M6), and re-emitted. This keeps streaming
        # (no time-to-first-token hit). M3 (prose that is actually a call) is NOT
        # done here — it would have to retract already-streamed prose, which
        # can't be un-streamed — and is surfaced in the UI instead. Opt out with
        # LRM_TOOLCALL_HARDENING_STREAM=0. Cloud never reaches here (it returns a
        # JSONResponse, not a StreamingResponse).
        if (
            req_stream
            and isinstance(result, StreamingResponse)
            and should_harden_kind(kind)
            and isinstance(body.get("tools"), list)
            and os.environ.get("LRM_TOOLCALL_HARDENING_STREAM", "1") != "0"
        ):
            async def _stream_retry(correction: str) -> Any:
                retry_body = {
                    **body,
                    "messages": [*(body.get("messages") or []), {"role": "system", "content": correction}],
                }
                if _policy.enabled:
                    apply_qwen_system_compat(retry_body, cfg.model_id)
                redispatched = await _httpx_chat_completions(
                    cfg,
                    retry_body,
                    True,
                    source=cast(Source, kind),
                    telemetry_tracer=routing_tracer,
                    telemetry_parent_span=root_span,
                    alias=model_alias_requested,
                    session_id=usage_session_id,
                    message_id=message_id,
                    trace_id=trace_id,
                    langfuse_trace_id=langfuse_trace_id,
                    hdr_phase=hdr_phase,
                    call_kind=call_kind,
                    langfuse_session_id=langfuse_session_id,
                )
                return redispatched.body_iterator if isinstance(redispatched, StreamingResponse) else None

            stream_retries = resolve_hardening_max_retries(
                None, os.environ.get("LRM_TOOLCALL_HARDENING_MAX_RETRIES")
            )
            result = StreamingResponse(
                harden_tool_call_stream(
                    result.body_iterator,
                    body.get("tools"),
                    body,
                    _stream_retry if stream_retries > 0 else None,
                ),
                media_type="text/event-stream",
            )

        if (
            kind != "cloud"
            and not req_stream
            and isinstance(result, dict)
            and requesting_agent != COMPACTION_AGENT
        ):
            # A non-streaming turn is successful only after any tool-call repair
            # redispatch finishes. Clearing earlier would refund the retry budget
            # even when hardening subsequently fails.
            _get_compaction_tracker(_policy).clear_upstream_overflows(
                _sanitize_session_id(str(request.headers.get("superclaw-session", "")))
            )

        # Cloud dispatch returns JSONResponse (openai-compat schema);
        # mirror status_code here since the HTTPException handler never sees it.
        if isinstance(result, JSONResponse) and result.status_code >= 400:
            if status_code == 200:
                status_code = result.status_code
            if error_class is None:
                error_class = "UpstreamError"

        # Streaming: dur_ms captures time-to-headers, not time-to-last-chunk; tokens stay "?" because usage is harvested mid-stream inside _httpx_chat_completions.
        if not req_stream and isinstance(result, dict):
            usage = result.get("usage")
            if not isinstance(usage, dict):
                usage = {}
            in_tokens = usage.get("prompt_tokens")
            out_tokens = usage.get("completion_tokens")
            upstream_model = str(result.get("model") or upstream_model)
            tracing.set_attributes(
                root_span,
                {
                    "llmrouter.usage.prompt_tokens": int(in_tokens)
                    if isinstance(in_tokens, int)
                    else None,
                    "llmrouter.usage.completion_tokens": int(out_tokens)
                    if isinstance(out_tokens, int)
                    else None,
                },
            )
        if req_stream and isinstance(result, StreamingResponse):
            streaming_result = cast(StreamingResponse, result)
            original_iterator = streaming_result.body_iterator
            stream_lease = local_request_lease

            async def _wrap_stream() -> Any:
                try:
                    async for chunk in original_iterator:
                        yield chunk
                except Exception as exc:
                    tracing.record_exception(root_span, exc)
                    # The 12-minute hole from the 2026-09-11 Arm A post-mortem
                    # lands here and, until now, wrote NOTHING: token_events
                    # only records completions, so the failure existed solely as
                    # a gap between two rows. Timeouts and hard aborts are split
                    # because they have different fixes (read timeout / upstream
                    # health vs a truncated or reset connection).
                    timed_out = isinstance(
                        exc, (httpx.TimeoutException, asyncio.TimeoutError)
                    )
                    record_event(
                        EventType.UPSTREAM_STREAM_TIMEOUT
                        if timed_out
                        else EventType.UPSTREAM_STREAM_ABORT,
                        model=upstream_model or None,
                        attrs={
                            "waited_ms": int((time.monotonic() - started) * 1000),
                            "error_class": type(exc).__name__,
                            "error": str(exc)[:300],
                            "source": source_kind or None,
                            "alias": model_alias_requested,
                        },
                    )
                    raise
                finally:
                    if stream_lease is not None:
                        stream_lease.release()
                    tracing.set_attributes(
                        root_span,
                        {
                            "http.response.status_code": status_code,
                            "llmrouter.error.class": error_class,
                        },
                    )
                    tracing.end_span(root_span)

            streaming_result.body_iterator = _wrap_stream()
            root_ended_in_stream = True
            local_request_lease = None
        return result
    except HTTPException as exc:
        if status_code == 200:
            status_code = exc.status_code
        if error_class is None:
            error_class = "HTTPException"
        tracing.record_exception(root_span, exc)
        raise
    except Exception as exc:
        status_code = 500
        error_class = type(exc).__name__
        tracing.record_exception(root_span, exc)
        logger.exception(
            "chat.completion.error chat_req_id={} dur_ms={} error={}",
            chat_req_id,
            int((time.monotonic() - started) * 1000),
            error_class,
        )
        raise
    finally:
        if local_request_lease is not None:
            local_request_lease.release()
        dur_ms = int((time.monotonic() - started) * 1000)
        log_fn = logger.warning if status_code >= 400 else logger.info
        log_fn(
            "chat.completion chat_req_id={} model={} agent={} source={} upstream={} stream={} in_tokens={} out_tokens={} dur_ms={} status={}{}",
            chat_req_id,
            model_alias_requested,
            requesting_agent or "?",
            source_kind or "?",
            upstream_model or "?",
            1 if stream_flag else 0,
            in_tokens if in_tokens is not None else "?",
            out_tokens if out_tokens is not None else "?",
            dur_ms,
            status_code,
            f" error={error_class}" if error_class else "",
        )
        # chat.request for the early-return paths (424, hybrid-DR short-circuit,
        # escalation target missing): emitted here so it still pairs with
        # chat.completion, carrying whatever ledger state was reached.
        _emit_chat_request()
        _emit_opencode_compaction()
        # One row per completed request, whatever the outcome — this `finally:`
        # also covers the early error_response returns, so `chat.request` and
        # `chat.completion` pair up. NOTE the streaming caveat, identical to the
        # log line above: on the stream path this runs when the coroutine
        # returns, BEFORE the body drains, so the token counts are usually None
        # and `status` is the header status, not the stream's fate. A stream
        # that dies later is its own upstream.* error row.
        record_event(
            EventType.CHAT_COMPLETION,
            model=upstream_model or None,
            attrs={
                "source": source_kind or None,
                "upstream": upstream_model or None,
                "model_alias": model_alias_requested,
                "in_tokens": in_tokens,
                "out_tokens": out_tokens,
                "dur_ms": dur_ms,
                "status": status_code,
                "stream": stream_flag,
                "error_class": error_class,
            },
        )
        if not root_ended_in_stream:
            tracing.set_attributes(
                root_span,
                {
                    "http.response.status_code": status_code,
                    "llmrouter.error.class": error_class,
                    "llmrouter.upstream.model": upstream_model or None,
                },
            )
            tracing.end_span(root_span)


async def list_models(request: Request) -> JSONResponse:
    """GET /v1/models — OpenAI-compatible list, only the 3 aliases.

    ``auto`` is always advertised. ``local-model`` appears when the user has
    SELECTED a local provider via
    ``PUT /llm-router/v1/model-selections/local-provider``; its description names
    the selected backend's active model (``"llamacpp"`` → the local GGUF, ``"edge"``
    → the edge endpoint). An unset selection hides ``local-model`` even if a
    backend happens to be configured — the catalog reflects the user's declared
    selection, not incidental configuration. ``cloud-model`` appears when a
    cloud-model singleton has been selected.
    """
    cloud = _load_cloud_model_config()
    primary = resolve_primary(request.app.state, role="chat")

    data: list[dict[str, Any]] = [
        {
            "id": "auto",
            "object": "model",
            "description": "Auto-routed: latency router decides when both cloud-model and local slot are configured; falls back to whichever single slot is configured; 503 only when neither is configured",
        }
    ]
    if primary is not None:
        data.append(
            {
                "id": "local-model",
                "object": "model",
                "description": f"Primary {primary.backend}: {primary.model_id}",
            }
        )
    if cloud is not None:
        data.append(
            {
                "id": "cloud-model",
                "object": "model",
                "description": f"Cloud: {cloud.provider}/{cloud.model_id}",
            }
        )
    return JSONResponse({"object": "list", "data": data})


async def pii_level(request: Request) -> JSONResponse:
    """GET /v1/pii/level — inert per `#681`.

    The live PII layer today is the ``protected-file-*`` agent chain. This
    endpoint stays for future reactivation; for now it always reports ``off``
    so callers can branch on the level without crashing.
    """
    return JSONResponse({"level": "off"})


async def session_locality(session_id: str) -> JSONResponse:
    """GET /v1/session/{session_id}/locality — agent-facing, no auth.

    Returns the most recent locality (``cloud``, ``local``, or ``edge``)
    recorded for chat completions on this session (written by
    ``chat_completions`` above), so sandbox tools — e.g.
    ``confirm_file_protection.ts`` — can skip protection UI once a session is
    provably local/edge-only (data never left the device). Unknown or
    unreadable sessions fail safe to ``"unknown"`` so callers keep showing
    protection by default.
    """
    sanitized = _sanitize_session_id(session_id)
    value: Any = None
    try:
        store = Store(default_db_path())
        try:
            value = store.get_config(f"routing.session_locality.{sanitized}")
        finally:
            store.close()
    except Exception:  # noqa: BLE001
        value = None
    if value in ("cloud", "local", "edge"):
        return JSONResponse({"locality": value, "source": "store"})
    return JSONResponse({"locality": "unknown", "source": "default"})
