"""LLM client — calls llmrouter at `:18321` (PII sanitize + restore).

LangGraph nodes call this client to ask the cloud/local LLM for text. The
sidecar never bypasses llmrouter: PII contract enforcement stays at the
llmrouter boundary, exactly as today.

Two implementations:

  - `HTTPLLMClient` — production: async httpx → llmrouter
  - `MockLLMClient` — tests: pre-canned responses, no network

Both satisfy the `LLMClient` protocol so nodes can be tested by
injecting the mock; production code wires the HTTP one.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import secrets
from dataclasses import dataclass
from typing import Any, Protocol, runtime_checkable

import httpx

logger = logging.getLogger("uvicorn.error")

_RETRYABLE_STATUS = {429, 500, 502, 503, 504}
_RETRY_BACKOFF_S = (3.0, 8.0, 20.0, 45.0)

# Stop-loss cap on a single cloud call. The upstream cloud account slows
# down under load (calls that normally finish in tens of seconds can stretch
# to a few minutes when several sessions contend), so a generous ceiling is
# kept for genuinely-slow-but-progressing calls while a stuck call is failed
# fast enough to retry instead of blocking a phase for the full old 900s.
# Set above observed contended-but-legit call times and well below 900s;
# tunable via env for deployments with a slower/faster upstream.
_DEFAULT_TIMEOUT_S = float(os.environ.get("HYBRID_DR_LLM_TIMEOUT_S", "420"))
# TCP connect ceiling. A reachable endpoint connects in well under a second, so
# the old 30s only ever delayed giving up on an UNREACHABLE endpoint — and with
# the connect-error retry ladder (5 attempts) that is 5x30s of dead waiting per
# call before a phase even fails. 8s fails an unreachable backend far faster
# while staying generous for a slow-DNS / congested-but-reachable connect.
_CONNECT_TIMEOUT_S = float(os.environ.get("HYBRID_DR_LLM_CONNECT_TIMEOUT_S", "8"))

# Phase names nodes pass as CompletionRequest.phase (see its docstring below).
# Centralized here so the string literals live in one place instead of being
# duplicated as inline strings across the node files. Distinct from (and more
# granular than) state.Phase, which tracks pipeline/orchestration progression
# rather than naming individual LLM calls for Langfuse.
PHASE_PLAN = "plan"
PHASE_FILL = "fill"
PHASE_POLISH = "polish"
PHASE_INPUT_WEB_DERIVE = "input-web-derive"
PHASE_INPUT_WEB_SYNTHESIZE = "input-web-synthesize"
PHASE_SECTION_WRITE_WRITER = "section-write-writer"
PHASE_SECTION_WRITE_REVIEWER = "section-write-reviewer"
PHASE_CONCLUSION_WRITER = "conclusion-writer"
PHASE_CONCLUSION_SCORER = "conclusion-scorer"


# ───── data types ───────────────────────────────────────────────────────


@dataclass(frozen=True)
class Message:
    """A single OpenAI chat-completion message."""

    role: str  # "system" | "user" | "assistant"
    content: str


@dataclass(frozen=True)
class LLMEndpointConfig:
    """OpenAI-compatible endpoint configuration for a single model slot."""

    base_url: str
    model: str
    api_key: str | None = None
    legacy_pii_nonce_bypass: bool = False


@dataclass(frozen=True)
class CompletionRequest:
    """One LLM call. Token / temperature / model knobs only — tools are
    intentionally out of scope at this layer; the sidecar nodes do their
    own tool dispatch via Python functions instead of OpenAI tools."""

    messages: list[Message]
    model: str  # "cloud-model" | "local-model" | concrete name
    max_tokens: int = 4096
    temperature: float | None = None
    # Per-request PII-bypass marker. llmrouter looks for this exact env on
    # the request via the OPENWORK_PII_BYPASS_AGENTS allowlist; the sidecar
    # passes through that signal so the llmrouter still owns the decision.
    bypass_agent: str | None = None
    endpoint: LLMEndpointConfig | None = None
    # Optional forced tool call for structured output. llmrouter's cloud
    # dispatch whitelists tools/tool_choice (cloud/dispatch.py) and LiteLLM
    # translates them to each vendor's native format (Anthropic tool_use,
    # OpenAI/openrouter function calling); drop_params=True degrades safely on
    # providers without function calling. This forces a schema-valid plan out
    # of reasoning-first models (e.g. Opus 4.8) that otherwise return prose.
    # NOTE: response_format is intentionally NOT used -- llmrouter drops it
    # (not in the dispatch whitelist), so it never reaches the upstream.
    tools: list[dict[str, Any]] | None = None
    tool_choice: dict[str, Any] | str | None = None
    # Pipeline phase name (see the PHASE_* constants above) sent as the
    # X-Hybrid-DR-Phase header so llmrouter's Langfuse naming can tell HDR's
    # phases apart -- this layer never sends tool_calls/tool-role messages,
    # the only other signals that naming logic can key off.
    phase: str | None = None
    # HDR nodes never want thinking output -- see the max_tokens/tool_choice
    # workarounds throughout nodes/plan.py and nodes/polish.py, which exist
    # purely to cope with reasoning-model side effects. llmrouter's cloud
    # dispatch (cloud/dispatch.py) translates this into the target
    # provider's native disable knob (currently only OpenRouter); providers
    # without a translation just ignore the signal.
    disable_thinking: bool = True


@dataclass(frozen=True)
class CompletionResponse:
    content: str
    model_returned: str  # what the upstream advertised back
    finish_reason: str | None
    usage_prompt_tokens: int | None = None
    usage_completion_tokens: int | None = None


# ───── protocol ─────────────────────────────────────────────────────────


@runtime_checkable
class LLMClient(Protocol):
    """Stable interface across production / test."""

    async def complete(self, req: CompletionRequest) -> CompletionResponse: ...

    async def aclose(self) -> None: ...


# ───── production: HTTP client ──────────────────────────────────────────


class HTTPLLMClient:
    """Async httpx client that talks to llmrouter."""

    def __init__(
        self,
        *,
        base_url: str | None = None,
        timeout_s: float | None = None,
        opencode_session_id: str | None = None,
        opencode_message_id: str | None = None,
        hdr_run_id: str | None = None,
    ) -> None:
        timeout_s = _DEFAULT_TIMEOUT_S if timeout_s is None else timeout_s
        self._base_url = (
            base_url
            or os.environ.get("HYBRID_DR_LLMROUTER_URL", "").strip()
            or "http://127.0.0.1:18321"
        ).rstrip("/")
        # egress-surface: hdr_lrm_chat
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(connect=_CONNECT_TIMEOUT_S, read=timeout_s, write=30.0, pool=30.0),
        )
        self._opencode_session_id = opencode_session_id
        # The dispatching turn's real OpenCode message id, only set when the
        # caller actually forwarded one (see api/serve.py). Sent verbatim as
        # X-Opencode-Message-Id -- the same header the OpenCode plugin sends
        # for normal chat -- so llmrouter's message_id handling needs no
        # HDR-specific knowledge (no id-shape guessing) to trust it.
        self._opencode_message_id = opencode_message_id
        # Stable identifier for this HDR pipeline run (real message id when
        # available, else the sidecar's own session id), sent as
        # X-Hybrid-DR-Run-Id on every call so llmrouter can collapse all ~9
        # phases x multiple calls of one run onto a single Langfuse trace
        # instead of ~27 unrelated ones (see proxy.py/dispatch.py). Kept
        # separate from opencode_message_id above: this one is always set
        # (falls back to the session id) since it only drives trace
        # grouping, whereas opencode_message_id must stay unset unless real.
        self._hdr_run_id = hdr_run_id


    async def complete(self, req: CompletionRequest) -> CompletionResponse:
        endpoint = req.endpoint
        base_url = (endpoint.base_url if endpoint else f"{self._base_url}/v1").rstrip("/")
        model = endpoint.model if endpoint else req.model
        nonce: str | None = None
        if endpoint and endpoint.legacy_pii_nonce_bypass:
            # Legacy in-container llmrouter used this nonce registration to
            # bypass PII masking for sidecar calls. New llmrouter-manager keeps
            # /v1/pii/level inert, so this is opt-in for old deployments only.
            nonce = secrets.token_hex(16)
            try:
                # egress-surface: hdr_lrm_chat
                await self._client.post(
                    f"{base_url}/pii/level",
                    json={
                        "nonce": nonce,
                        "pii_level": "none",
                        "agent": "hybrid-deep-research-l0",
                    },
                )
            except httpx.HTTPError:
                pass

        messages_payload = [{"role": m.role, "content": m.content} for m in req.messages]
        if nonce:
            # Embed the nonce in the last user message so legacy pii_serve can
            # match it back to the registered state.
            for entry in reversed(messages_payload):
                if entry.get("role") == "user":
                    entry["content"] = f"<!--owk-pii:{nonce}-->\n" + str(entry["content"])
                    break

        body: dict[str, Any] = {
            "model": model,
            "messages": messages_payload,
            "max_tokens": req.max_tokens,
        }
        if req.temperature is not None:
            body["temperature"] = req.temperature
        if req.tools is not None:
            body["tools"] = req.tools
        if req.tool_choice is not None:
            body["tool_choice"] = req.tool_choice
        # disable_thinking is a non-OpenAI-compatible field llmrouter's cloud
        # dispatch understands (cloud/dispatch.py translates it for
        # OpenRouter). The local/edge dispatch path forwards the request body
        # to the upstream verbatim (no field whitelist), so gate this to the
        # cloud-model case only -- sending it to a local llama-server or an
        # arbitrary user-configured edge endpoint risks a 400 on an unknown
        # top-level key.
        if req.disable_thinking and model == "cloud-model":
            body["disable_thinking"] = True

        headers: dict[str, str] = {"Content-Type": "application/json"}
        if self._opencode_session_id:
            headers["X-Opencode-Session-Id"] = self._opencode_session_id
        if self._opencode_message_id:
            headers["X-Opencode-Message-Id"] = self._opencode_message_id
        if self._hdr_run_id:
            headers["X-Hybrid-DR-Run-Id"] = self._hdr_run_id
        if endpoint and endpoint.api_key:
            headers["Authorization"] = f"Bearer {endpoint.api_key}"
        elif endpoint is None or endpoint.base_url.rstrip("/") == f"{self._base_url}/v1":
            lrm_api_key = os.environ.get("LRM_API_KEY", "").strip()
            if lrm_api_key:
                headers["Authorization"] = f"Bearer {lrm_api_key}"
        if req.bypass_agent:
            headers["x-openwork-pii-bypass-agent"] = req.bypass_agent
        if req.phase:
            headers["X-Hybrid-DR-Phase"] = req.phase

        url = f"{base_url}/chat/completions"
        # Retry on transient pii_serve / openrouter failures: connect/read
        # timeouts and upstream-overload status codes. Sidecar pipeline runs
        # ~40 LLM calls per session; without this any single network blip
        # kills the whole run.
        last_exc: Exception | None = None
        resp = None
        for attempt in range(len(_RETRY_BACKOFF_S) + 1):
            try:
                # egress-surface: hdr_lrm_chat
                resp = await self._client.post(url, headers=headers, json=body)
                if resp.status_code in _RETRYABLE_STATUS and attempt < len(_RETRY_BACKOFF_S):
                    await asyncio.sleep(_RETRY_BACKOFF_S[attempt])
                    continue
                resp.raise_for_status()
                break
            except (
                httpx.ConnectError,
                httpx.ConnectTimeout,
                httpx.ReadError,
                httpx.ReadTimeout,
                httpx.WriteError,
                httpx.RemoteProtocolError,
            ) as exc:
                last_exc = exc
                if attempt < len(_RETRY_BACKOFF_S):
                    await asyncio.sleep(_RETRY_BACKOFF_S[attempt])
                    continue
                raise
        if resp is None:
            raise last_exc or RuntimeError("LLM call failed without response")
        data = resp.json()

        choice = (data.get("choices") or [{}])[0]
        msg = choice.get("message") or {}
        raw_content = str(msg.get("content") or "")
        # Forced tool call (planner structured output): when the model returns
        # the plan via a tool call, the JSON lives in the tool-call arguments,
        # not in content. Prefer it so downstream parsers get clean JSON. Falls
        # through to content when the upstream dropped tools (drop_params) or
        # answered in prose.
        _tool_calls = msg.get("tool_calls") or []
        if _tool_calls:
            _args = (_tool_calls[0].get("function") or {}).get("arguments")
            if isinstance(_args, str) and _args.strip():
                raw_content = _args
        # llmrouter prepends `[provider/model]` when show_model_prefix=true.
        # Strip it once at the boundary so phase nodes see clean content.
        clean_content = re.sub(r"^\[[\w./:-]+\]\s*", "", raw_content).strip()
        # Some models ship the substantive answer in the OpenRouter `reasoning` /
        # `reasoning_content` / `reasoning_details` fields and leave `content`
        # blank. Fall back to those only for a finished response: with
        # finish_reason=length the reasoning is unfinished deliberation, and
        # parsing it as the answer turned the prompt's own examples into search
        # queries and raw thinking into published web insights.
        if not clean_content and choice.get("finish_reason") == "length":
            logger.warning(
                "hybrid_dr.llm.truncated_without_answer phase=%s model=%s max_tokens=%s "
                "completion_tokens=%s",
                req.phase,
                data.get("model"),
                req.max_tokens,
                (data.get("usage") or {}).get("completion_tokens"),
            )
        elif not clean_content:
            reasoning = msg.get("reasoning")
            reasoning_content = msg.get("reasoning_content")
            if isinstance(reasoning, str) and reasoning.strip():
                clean_content = reasoning.strip()
            elif isinstance(reasoning_content, str) and reasoning_content.strip():
                clean_content = reasoning_content.strip()
            else:
                details = msg.get("reasoning_details") or []
                if isinstance(details, list):
                    chunks: list[str] = []
                    for d in details:
                        if isinstance(d, dict):
                            t = d.get("text") or d.get("content") or ""
                            if isinstance(t, str) and t.strip():
                                chunks.append(t.strip())
                    if chunks:
                        clean_content = "\n".join(chunks).strip()
        return CompletionResponse(
            content=clean_content,
            model_returned=str(data.get("model") or req.model),
            finish_reason=choice.get("finish_reason"),
            usage_prompt_tokens=(data.get("usage") or {}).get("prompt_tokens"),
            usage_completion_tokens=(data.get("usage") or {}).get("completion_tokens"),
        )

    async def aclose(self) -> None:
        await self._client.aclose()


# ───── test double: in-memory client ────────────────────────────────────


class MockLLMClient:
    """Replay-from-memory LLM client. Tests pre-queue responses; calls drain
    the queue. Asserts that the queue ran dry exactly when the test ends so
    a node accidentally making an extra LLM call is caught."""

    def __init__(self, *, responses: list[CompletionResponse] | None = None) -> None:
        self._responses: list[CompletionResponse] = list(responses or [])
        self.calls: list[CompletionRequest] = []

    def queue(self, response: CompletionResponse) -> None:
        self._responses.append(response)

    async def complete(self, req: CompletionRequest) -> CompletionResponse:
        self.calls.append(req)
        if not self._responses:
            raise RuntimeError(
                f"MockLLMClient: no canned response queued for "
                f"call #{len(self.calls)} (model={req.model!r})"
            )
        return self._responses.pop(0)

    async def aclose(self) -> None:
        return None

    def assert_drained(self) -> None:
        if self._responses:
            raise AssertionError(
                f"MockLLMClient still has {len(self._responses)} responses "
                "queued after test — node made fewer calls than expected"
            )


__all__ = [
    "CompletionRequest",
    "CompletionResponse",
    "HTTPLLMClient",
    "LLMClient",
    "Message",
    "MockLLMClient",
]
