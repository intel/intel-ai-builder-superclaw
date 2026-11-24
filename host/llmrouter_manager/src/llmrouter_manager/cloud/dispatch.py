"""Cloud upstream dispatch via LiteLLM (C8 simplification).

LiteLLM-only for all cloud providers regardless of native protocol, driven by
``catalog.get_litellm_provider(cfg.provider)`` instead of URL-hint inference.
PII restoration, observability tool-call hardening, and the openai-compat
httpx fallback were removed in C8 -- routing/proxy.py uses httpx only for
local + edge now, and PII / observability hooks were dead code (inert by
default per #681, no callers). Model-prefix injection (also removed in C8)
has since been restored via ``common.model_prefix`` so the frontend's
``resolveAutoModelID()`` can display the underlying model name in place of
the ``cloud-model`` alias in token-usage aggregation.

Unsupported-param handling: ``drop_params=True`` is passed on every dispatch
call so LiteLLM strips params the upstream provider does not declare in its
``supported_openai_params`` whitelist (notably ``tools`` / ``tool_choice`` on
providers without function-calling). Replaces the previous string-match
``_is_tool_rejection`` + ``_no_tools_models`` retry cache: the drop is
proactive at build-kwargs time, so no round-trip is wasted and no per-model
cache is needed.
"""

from __future__ import annotations

import asyncio
import json
import os
import random
import time
from typing import Any

import litellm
from fastapi.responses import JSONResponse, StreamingResponse
from loguru import logger
from opentelemetry.trace import Tracer, Span

from ..common.model_prefix import (
    format_model_prefix,
    inject_into_non_streaming_result,
    inject_into_streaming_chunk,
)
from ..common.telemetry_metrics import emit_llm_request_metrics as _emit_llm_request_metrics
from ..common.usage import record_usage
from ..routing.policy.retry import (
    RetryPolicy,
    parse_retry_after,
    resolve_max_upstream_retries,
)
from ..telemetry import tracing
from .catalog import get_litellm_provider, get_provider_extra_headers

from ..langfuse_observability.client import (
    build_trace_and_generation,
    finalize_generation_and_trace,
)


def _extract_upstream_status(exc: BaseException) -> tuple[int | None, str | None]:
    """Extract ``(status_code, Retry-After header)`` from a LiteLLM
    exception. Returns ``(None, None)`` when the exception carries no
    HTTP status — the retry loop treats that as non-retryable.
    """
    status = getattr(exc, "status_code", None)
    if not isinstance(status, int):
        status = None
    retry_after_raw: str | None = None
    response = getattr(exc, "response", None)
    if response is not None:
        headers = getattr(response, "headers", None)
        if headers is not None:
            try:
                retry_after_raw = headers.get("retry-after") or headers.get("Retry-After")
            except Exception:
                retry_after_raw = None
    return status, retry_after_raw


def _parse_vendor_error_body(exc: BaseException) -> dict[str, str]:
    """Extract vendor-native error fields from a LiteLLM exception's
    ``httpx.Response`` body. Two shapes observed in the wild:

    * Anthropic-compat (MiniMax-M3, Claude): ``{"type": "error",
      "error": {"type": "overloaded_error", "message": "..."},
      "request_id": "..."}``.
    * OpenAI-compat: ``{"error": {"message": "...", "type": "...",
      "code": "..."}}``.

    Both nest the semantic error under ``body["error"]``. Accepts either
    object or bare string; unrecognized shapes return ``{}`` so the
    caller falls back to ``str(exc)`` (LiteLLM's wrapper message).
    """
    out: dict[str, str] = {}
    response = getattr(exc, "response", None)
    if response is None:
        return out
    try:
        body = response.json()
    except Exception:
        return out
    if not isinstance(body, dict):
        return out
    err = body.get("error")
    if isinstance(err, dict):
        msg = err.get("message")
        if isinstance(msg, str):
            out["message"] = msg
        etype = err.get("type")
        if isinstance(etype, str):
            out["type"] = etype
    elif isinstance(err, str):
        out["message"] = err
    return out


def _extract_request_id(exc: BaseException) -> str | None:
    """Pull the upstream provider's request id from headers or body.

    * OpenAI-compat / most vendors: ``x-request-id`` response header.
    * Anthropic-compat (MiniMax, Claude): ``request_id`` inside body.
    * LiteLLM: ``x-litellm-call-id`` for its own tracing.
    """
    response = getattr(exc, "response", None)
    if response is None:
        return None
    headers = getattr(response, "headers", None)
    if headers is not None:
        for key in ("x-request-id", "x-litellm-call-id", "request-id"):
            try:
                value = headers.get(key)
            except Exception:
                continue
            if value:
                return str(value)
    try:
        body = response.json()
    except Exception:
        body = None
    if isinstance(body, dict):
        raw_rid = body.get("request_id")
        if isinstance(raw_rid, str):
            return raw_rid
    return None


def _upstream_error_envelope(
    exc: BaseException, *, provider: str, model_id: str
) -> dict[str, Any]:
    """Build an OpenAI-compatible error envelope (issue #1173).

    Matches ``@ai-sdk/openai-compatible``'s Zod schema
    ``{error: {message: string, type?: string, code?: string|number}}``.
    Only ``message`` reaches the UI (Zod strips unknown keys), so vendor
    text, ``upstream_status``, ``upstream_error_type``, ``request_id``,
    provider/model all fold into ``message``. ``type`` is the OpenAI-
    compat category; ``code`` is our stable sub-classification;
    ``details`` stays for server logs and tests only.
    """
    status, _retry_after = _extract_upstream_status(exc)
    vendor = _parse_vendor_error_body(exc)
    request_id = _extract_request_id(exc)

    vendor_type = vendor.get("type")
    is_rate_limited = status == 429 or vendor_type in (
        "rate_limit_error",
        "rate_limit_exceeded",
    )
    is_overloaded = status in (503, 529) or vendor_type == "overloaded_error"
    if is_rate_limited:
        error_type = "rate_limit_error"
        code = "rate_limited"
    elif is_overloaded:
        error_type = "server_error"
        code = "upstream_overloaded"
    elif status is not None and 500 <= status < 600:
        error_type = "server_error"
        code = "upstream_error"
    elif status is not None and 400 <= status < 500:
        error_type = "invalid_request_error"
        code = "upstream_client_error"
    else:
        error_type = "server_error"
        code = "upstream_error"

    parts: list[str] = []
    vendor_message = vendor.get("message")
    if vendor_message:
        parts.append(vendor_message)
    else:
        raw = str(exc)
        if raw:
            parts.append(raw[:200])
    parts.append(f"provider={provider}")
    parts.append(f"model={model_id}")
    if status is not None:
        parts.append(f"upstream_status={status}")
    if vendor_type:
        parts.append(f"upstream_error_type={vendor_type}")
    if request_id:
        parts.append(f"request_id={request_id}")
    message = " | ".join(parts)[:500]

    details: dict[str, Any] = {
        "type": type(exc).__name__,
        "provider": provider,
        "model": model_id,
    }
    if status is not None:
        details["upstream_status"] = status
    if vendor_type:
        details["upstream_error_type"] = vendor_type
    if vendor_message:
        details["upstream_message"] = vendor_message[:500]
    if request_id:
        details["request_id"] = request_id

    return {
        "error": {
            "message": message,
            "type": error_type,
            "code": code,
            "details": details,
        }
    }


# Substrings observed (or reasonably expected) in OpenRouter's 400 body when a
# model refuses ``reasoning.effort=none`` because reasoning is mandatory for
# that endpoint. Matching stays conservative -- the "reasoning" gate below is
# unconditional (AND, not OR), so widening this list can only ever pick up
# more of *that same* rejection wording, never unrelated 400s.
_MANDATORY_REASONING_MARKERS = (
    "mandatory",
    "cannot be disabled",
    "cannot disable",
    "must be enabled",
    "required for this model",
    "required for this endpoint",
)


def _drop_reasoning_override(kwargs: dict, exc: BaseException) -> dict | None:
    """Some OpenRouter models make reasoning mandatory and reject the
    ``reasoning.effort=none`` disable override injected by
    ``_build_litellm_kwargs`` with a 400 (e.g. "Reasoning is mandatory for
    this endpoint and cannot be disabled"). Returns kwargs with the override
    stripped so the caller can retry once, or ``None`` if this isn't that
    error / there's nothing to strip.
    """
    extra_body = kwargs.get("extra_body")
    if not isinstance(extra_body, dict) or "reasoning" not in extra_body:
        return None
    status, _ = _extract_upstream_status(exc)
    if status != 400:
        return None
    message = str(exc).lower()
    if "reasoning" not in message or not any(
        marker in message for marker in _MANDATORY_REASONING_MARKERS
    ):
        return None
    stripped_extra_body = {k: v for k, v in extra_body.items() if k != "reasoning"}
    stripped = dict(kwargs)
    if stripped_extra_body:
        stripped["extra_body"] = stripped_extra_body
    else:
        stripped.pop("extra_body", None)
    return stripped


async def _acompletion_with_retry(
    kwargs: dict, *, provider: str, model_id: str
) -> Any:
    """``litellm.acompletion(**kwargs)`` with bounded retry on 429 /
    503 / 529 (see ``RETRYABLE_STATUS``). Non-retryable errors raise
    immediately. Budget defaults to ``max_retries=2`` with jittered
    backoff per ``routing.policy.retry.RetryPolicy``; opencode's own
    SDK also retries, so we stay bounded to avoid storm multiplication.
    """
    max_retries = resolve_max_upstream_retries(
        arg_value=None,
        env_value=os.environ.get("LATENTFACTOR_MAX_UPSTREAM_RETRIES"),
    )
    policy = RetryPolicy(max_retries=max_retries)
    if not policy.enabled:
        try:
            return await litellm.acompletion(**kwargs)
        except Exception as exc:
            fallback_kwargs = _drop_reasoning_override(kwargs, exc)
            if fallback_kwargs is None:
                raise
            logger.warning(
                "[Cloud] model rejected reasoning-disable override, retrying "
                "without it: provider={} model={}",
                provider,
                model_id,
            )
            # Re-enter (not a bare call) so a transient error on the fallback
            # attempt still gets this function's normal handling -- here that's
            # "none" since retry is disabled, but it keeps both branches
            # symmetric and safe against a second mandatory-reasoning 400 (the
            # stripped extra_body no longer has "reasoning", so
            # _drop_reasoning_override can't match again -- no infinite loop).
            return await _acompletion_with_retry(
                fallback_kwargs, provider=provider, model_id=model_id
            )
    attempt = 0
    elapsed_total = 0.0
    while True:
        try:
            return await litellm.acompletion(**kwargs)
        except Exception as exc:
            fallback_kwargs = _drop_reasoning_override(kwargs, exc)
            if fallback_kwargs is not None:
                logger.warning(
                    "[Cloud] model rejected reasoning-disable override, "
                    "retrying without it: provider={} model={}",
                    provider,
                    model_id,
                )
                # Re-enter with a fresh retry budget so a transient 429/503/529
                # on the fallback attempt still gets RetryPolicy's backoff
                # instead of bubbling up uncaught. Can't loop forever: the
                # stripped extra_body no longer has "reasoning", so a repeat
                # 400 here won't match _drop_reasoning_override again.
                return await _acompletion_with_retry(
                    fallback_kwargs, provider=provider, model_id=model_id
                )
            status, retry_after_raw = _extract_upstream_status(exc)
            if status is None or not RetryPolicy.is_retryable(status):
                raise
            retry_after = parse_retry_after(retry_after_raw)
            delay = policy.delay_for(
                attempt,
                retry_after=retry_after,
                jitter_frac=random.uniform(0.0, 0.25),
                elapsed_total=elapsed_total,
            )
            if delay is None:
                raise
            logger.warning(
                "[Cloud] litellm transient error status={} attempt={} sleeping={:.2f}s "
                "provider={} model={}",
                status,
                attempt + 1,
                delay,
                provider,
                model_id,
            )
            await asyncio.sleep(delay)
            elapsed_total += delay
            attempt += 1


def _build_litellm_kwargs(llm_cfg: Any, body: dict) -> dict:
    """Construct kwargs for ``litellm.acompletion`` from an LLMConfig + request body.

    Sets ``drop_params=True`` so LiteLLM strips openai-compat params the
    upstream provider does not support (e.g. ``tools`` / ``tool_choice`` on
    providers whose ``supported_openai_params`` doesn't include function
    calling), instead of raising and forcing a reactive retry.
    """
    litellm_provider = get_litellm_provider(llm_cfg.provider)
    api_base = (llm_cfg.base_url or "").rstrip("/") or None
    api_key = (llm_cfg.api_key or "").strip() or None
    # Fall back to the configured default when the body doesn't supply a
    # numeric max_tokens (missing, null, or a non-numeric string), so a
    # malformed field surfaces as our default instead of a 500 from int().
    max_tokens_raw = body.get("max_tokens")
    try:
        max_tokens = (
            int(max_tokens_raw)
            if max_tokens_raw is not None
            else int(llm_cfg.max_tokens)
        )
    except (TypeError, ValueError):
        max_tokens = int(llm_cfg.max_tokens)
    kwargs: dict = {
        "model": f"{litellm_provider}/{llm_cfg.model_id}",
        "messages": body.get("messages", []),
        "max_tokens": max_tokens,
        "api_base": api_base,
        "api_key": api_key,
        "drop_params": True,
    }
    for opt in ("temperature", "tools", "tool_choice", "stream_options"):
        if opt in body:
            kwargs[opt] = body[opt]
    extra_headers = get_provider_extra_headers(llm_cfg.provider)
    if extra_headers:
        kwargs["extra_headers"] = extra_headers
    # OpenRouter is the only catalog provider handled here today: the OAuth
    # (Codex / Copilot) cloud paths forward `reasoning_effort` themselves,
    # and Anthropic/OpenAI-direct via this generic dispatch don't opt into
    # thinking by default, so there's nothing to turn off for them yet.
    # `effort: "none"` is OpenRouter's documented full-disable value (vs. the
    # undocumented `enabled: false`); models where reasoning is mandatory
    # reject it with a 400 that `_drop_reasoning_override` retries without it.
    # Merged (not overwritten) into `extra_body` so a future caller that also
    # populates it doesn't get silently clobbered.
    if body.get("disable_thinking") and litellm_provider == "openrouter":
        kwargs.setdefault("extra_body", {})["reasoning"] = {"effort": "none"}
    # OpenRouter routes one model id to many upstream endpoints and takes the
    # preference as a top-level `provider` object (order / ignore /
    # allow_fallbacks). The body member is called `provider_routing` and not
    # `provider` because on the pinned-completion route (`routing/pinned.py`)
    # the body ALREADY has a `provider` member meaning the catalog provider id
    # -- one body cannot spell both, and silently reinterpreting that field
    # would be the worst kind of confusing. The rename happens here, the one
    # place that speaks OpenRouter's wire format.
    #
    # Only forwarded for openrouter: every other catalog provider is its own
    # single endpoint, so the block would name endpoints it has never heard of.
    # `setdefault` (like the reasoning line above) so the two OpenRouter-only
    # members merge instead of clobbering each other.
    provider_routing = body.get("provider_routing")
    if isinstance(provider_routing, dict) and litellm_provider == "openrouter":
        kwargs.setdefault("extra_body", {})["provider"] = provider_routing
    return kwargs


async def _call_via_litellm(
    llm_cfg: Any,
    body: dict,
    *,
    req_stream: bool,
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
) -> Any:
    """Dispatch a cloud chat-completion request via LiteLLM.

    LiteLLM provider name comes from ``catalog.get_litellm_provider(cfg.provider)``;
    LiteLLM internally routes to the right vendor SDK (anthropic, gemini, openai,
    etc.) and handles request / response / streaming translation. Params the
    upstream doesn't support are dropped by LiteLLM at the ``drop_params=True``
    seam set in ``_build_litellm_kwargs`` -- no reactive retry needed.

    The ``[<model-id>] `` label that ``common/model_prefix.py`` prepends when
    ``SUPERCLAW_LRM_MODEL_PREFIX=1`` is suppressed per request by
    ``model_prefix.suppress_for_this_request()``, which every injection site
    honours through ``format_model_prefix`` -- including the streaming one below,
    which reads it from inside the response generator and so needs a suppression
    that outlives the handler. A caller whose completion is not chat text
    uses that; there is no parameter here, because the alias route's local branch
    needs the same opt-out and it lives in ``routing/proxy.py``, which is over
    the file-size ratchet's threshold and cannot grow.

    ``trace_id`` is the per-request event-ledger id (chat_req_id) recorded
    on ``token_events`` / ``record_usage`` so per-request rows join by it.
    ``langfuse_trace_id`` is the Langfuse *grouping* id (may be shared
    across many requests -- e.g. one OpenCode message id spanning
    title-gen + response + tool loops, or one HDR run id spanning ~27
    calls); it drives the Langfuse trace only, never the event ledger.
    When callers omit ``langfuse_trace_id`` we fall back to ``trace_id``
    so single-caller unit tests keep the pre-split behavior.
    """
    kwargs = _build_litellm_kwargs(llm_cfg, body)
    tracer = telemetry_tracer

    # Langfuse v2 trace + generation for this call; see
    # build_trace_and_generation()'s docstring for the trace-merging and
    # session-grouping rules applied here.
    messages = body.get("messages")
    lf_trace, lf_generation, gen_name = build_trace_and_generation(
        messages=messages,
        hdr_phase=hdr_phase,
        call_kind=call_kind,
        trace_id=langfuse_trace_id or trace_id,
        session_id=session_id,
        langfuse_session_id=langfuse_session_id,
        kind="cloud",
        req_stream=req_stream,
        provider=llm_cfg.provider,
        model_id=llm_cfg.model_id,
        tools_present="tools" in body,
        upstream_payload=kwargs,
    )

    dispatch_span = tracing.start_span(
        tracer,
        "llmrouter.dispatch.cloud",
        context=tracing.child_context(telemetry_parent_span),
        attributes={
            "llmrouter.dispatch.kind": "cloud",
            "llmrouter.dispatch.stream": req_stream,
            "llmrouter.provider": llm_cfg.provider,
            "llmrouter.upstream.model": llm_cfg.model_id,
            "llmrouter.tools.present": "tools" in body,
        },
    )
    request_started = request_started_at if request_started_at is not None else time.monotonic()

    # Request is streaming type
    if req_stream:
        kwargs["stream"] = True
        # Force include_usage so the final SSE chunk carries token counts.
        stream_options = dict(kwargs.get("stream_options") or {})
        stream_options["include_usage"] = True
        kwargs["stream_options"] = stream_options

        async def _generate():
            stream_span = tracing.start_span(
                tracer,
                "llmrouter.upstream.stream",
                context=tracing.child_context(dispatch_span),
                attributes={
                    "llmrouter.dispatch.kind": "cloud",
                    "llmrouter.provider": llm_cfg.provider,
                    "llmrouter.upstream.model": llm_cfg.model_id,
                },
            )
            captured_usage: dict | None = None
            captured_model = llm_cfg.model_id
            answer_parts: list[str] = []            # Accumulate streamed content for assembly of the full answer in Langfuse Tracing
            captured_finish_reason: str | None = None  # finish_reason from the last streamed chunk, recorded on the Langfuse generation
            # TO REVIEW (Brad): tool-call deltas arrive fragmented across many
            # chunks (name in one, argument pieces spread over several) keyed
            # by `index` — merge them the same way the non-streaming path
            # would see a finished `tool_calls` list, so tool-call turns don't
            # trace as empty output.
            tool_call_parts: dict[int, dict] = {}
            prefix_pending = format_model_prefix(llm_cfg.model_id)
            first_chunk_ms: int | None = None
            chunk_count = 0
            done_received = False
            stream_status_code = 502
            try:
                stream = await _acompletion_with_retry(
                    kwargs, provider=llm_cfg.provider, model_id=llm_cfg.model_id
                )
            except Exception as exc:
                logger.error("[Cloud] litellm streaming call failed: {}", exc)
                tracing.record_exception(stream_span, exc)
                tracing.record_exception(dispatch_span, exc)
                lf_generation.end(output=None, level="ERROR", status_message=str(exc))  
                error_payload = _upstream_error_envelope(
                    exc, provider=llm_cfg.provider, model_id=llm_cfg.model_id
                )
                yield f"data: {json.dumps(error_payload)}\n\n"
                _emit_llm_request_metrics(
                    telemetry_runtime,
                    source="cloud",
                    model_id=captured_model,
                    stream=True,
                    status_code=502,
                    duration_ms=int((time.monotonic() - request_started) * 1000),
                )
                record_usage(
                    None,
                    source="cloud",
                    model_id=captured_model,
                    provider=llm_cfg.provider,
                    alias=alias,
                    session_id=session_id,
                    message_id=message_id,
                    trace_id=trace_id,
                )
                tracing.set_attributes(
                    stream_span,
                    {
                        "llmrouter.stream.chunk_count": chunk_count,
                        "llmrouter.stream.usage_captured": False,
                        "llmrouter.stream.done_received": False,
                    },
                )
                tracing.set_attributes(dispatch_span, {"llmrouter.upstream.model": captured_model})
                tracing.end_span(stream_span)
                tracing.end_span(dispatch_span)
                return
            try:
                async for chunk in stream:
                    try:
                        chunk_dict = chunk.model_dump()
                    except Exception:
                        continue
                    chunk_count += 1
                    if first_chunk_ms is None:
                        first_chunk_ms = int((time.monotonic() - request_started) * 1000)
                        tracing.add_event(stream_span, "first_chunk")
                    if chunk_dict.get("usage"):
                        captured_usage = chunk_dict["usage"]
                        tracing.add_event(stream_span, "usage_chunk")
                    if chunk_dict.get("model"):
                        captured_model = chunk_dict["model"]
                    # accumulate delta content + finish_reason for the Langfuse generation output/metadata below.
                    choices = chunk_dict.get("choices") or [{}]
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
                    if prefix_pending and inject_into_streaming_chunk(
                        chunk_dict, prefix_pending
                    ):
                        prefix_pending = None
                    yield f"data: {json.dumps(chunk_dict)}\n\n"
                done_received = True
                stream_status_code = 200
                tracing.add_event(stream_span, "done")
                yield "data: [DONE]\n\n"
            except Exception as exc:
                tracing.record_exception(stream_span, exc)
                tracing.record_exception(dispatch_span, exc)
                raise
            finally:
                cost_usd = 0.0
                if captured_usage:
                    try:
                        from litellm import completion_cost

                        cost_usd = float(completion_cost(
                            model=f"{get_litellm_provider(llm_cfg.provider)}/{llm_cfg.model_id}",
                            prompt_tokens=int(captured_usage.get("prompt_tokens", 0)),
                            completion_tokens=int(captured_usage.get("completion_tokens", 0)),
                        ) or 0.0)
                    except Exception:
                        cost_usd = 0.0
                total_ms = int((time.monotonic() - request_started) * 1000)
                # TO REVIEW (Brad): build the merged tool_calls list (if any)
                # the same shape the non-streaming path records, so a
                # tool-call-only turn still traces useful output.
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
                stream_final_output = (
                    "".join(answer_parts) if answer_parts else tool_calls_final
                )
                finalize_generation_and_trace(
                    lf_generation,
                    lf_trace,
                    gen_name,
                    output=stream_final_output,
                    prompt_tokens=captured_usage.get("prompt_tokens") if captured_usage else None,
                    completion_tokens=captured_usage.get("completion_tokens") if captured_usage else None,
                    finish_reason=captured_finish_reason,
                )
                record_usage(
                    {"usage": captured_usage, "model": captured_model}
                    if captured_usage
                    else None,
                    source="cloud",
                    model_id=captured_model,
                    provider=llm_cfg.provider,
                    alias=alias,
                    session_id=session_id,
                    message_id=message_id,
                    trace_id=trace_id,
                    response_cost_usd=cost_usd,
                    tool_calls=tool_calls_final or [],
                )
                _emit_llm_request_metrics(
                    telemetry_runtime,
                    source="cloud",
                    model_id=captured_model,
                    stream=True,
                    status_code=stream_status_code if done_received else 502,
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
                    decode_window_ms=(
                        max(0, total_ms - first_chunk_ms) if first_chunk_ms is not None else None
                    ),
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

        return StreamingResponse(_generate(), media_type="text/event-stream")

    # Request is non-streaming type
    try:
        response = await _acompletion_with_retry(
            kwargs, provider=llm_cfg.provider, model_id=llm_cfg.model_id
        )
    except Exception as exc:
        logger.error("[Cloud] litellm call failed: {}", exc)
        tracing.record_exception(dispatch_span, exc)
        lf_generation.end(output=None, level="ERROR", status_message=str(exc))
        
        _emit_llm_request_metrics(
            telemetry_runtime,
            source="cloud",
            model_id=llm_cfg.model_id,
            stream=False,
            status_code=502,
            duration_ms=int((time.monotonic() - request_started) * 1000),
        )
        tracing.end_span(dispatch_span)
        envelope = _upstream_error_envelope(
            exc, provider=llm_cfg.provider, model_id=llm_cfg.model_id
        )
        return JSONResponse(envelope, status_code=502)
    _hidden = getattr(response, "_hidden_params", None) or {}
    cost_usd = float(_hidden.get("response_cost") or 0.0)
    try:
        result = response.model_dump()
    except Exception as exc:
        tracing.record_exception(dispatch_span, exc)
        lf_generation.end(output=None, level="ERROR", status_message=str(exc))
        tracing.end_span(dispatch_span)
        envelope = _upstream_error_envelope(
            exc, provider=llm_cfg.provider, model_id=llm_cfg.model_id
        )
        return JSONResponse(envelope, status_code=502)
    prefix = format_model_prefix(llm_cfg.model_id)
    if prefix:
        inject_into_non_streaming_result(result, prefix)
    usage = result.get("usage")
    if not isinstance(usage, dict):
        usage = {}
    record_usage(
        result,
        source="cloud",
        model_id=str(result.get("model", llm_cfg.model_id)),
        provider=llm_cfg.provider,
        alias=alias,
        session_id=session_id,
        message_id=message_id,
        trace_id=trace_id,
        response_cost_usd=cost_usd,
    )
    _emit_llm_request_metrics(
        telemetry_runtime,
        source="cloud",
        model_id=str(result.get("model", llm_cfg.model_id)),
        stream=False,
        status_code=200,
        duration_ms=int((time.monotonic() - request_started) * 1000),
        prompt_tokens=int(usage["prompt_tokens"]) if isinstance(usage.get("prompt_tokens"), int) else None,
        completion_tokens=int(usage["completion_tokens"]) if isinstance(usage.get("completion_tokens"), int) else None,
    )
    tracing.set_attributes(
        dispatch_span,
        {
            "llmrouter.upstream.model": str(result.get("model", llm_cfg.model_id)),
            "llmrouter.usage.present": result.get("usage") is not None,
        },
    )
    tracing.end_span(dispatch_span)
    
    choices = result.get("choices") or [{}]
    message = choices[0].get("message") or {}
    # TO REVIEW (Brad): tool-call turns carry no text `content` (it's None) —
    # fall back to `tool_calls` so the trace still shows what the model asked
    # to do, instead of recording an empty output.
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
    return result
