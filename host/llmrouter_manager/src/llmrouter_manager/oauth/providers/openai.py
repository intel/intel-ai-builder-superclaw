"""OpenAI (ChatGPT/Codex) OAuth dispatch via LiteLLM's ``chatgpt/`` provider.

Single chokepoint for OpenAI-OAuth dispatch (plan §5): refresh → project
auth.json → litellm.acompletion, in that order.

Streaming policy: LiteLLM's chatgpt provider streams correctly, but its
non-streaming assembly is broken across all tested versions, so we ALWAYS call
it with ``stream=True`` and fold the stream ourselves for non-stream callers.
"""

from __future__ import annotations

import json
import secrets
import time
from typing import Any, AsyncIterator

import litellm
import httpx
from fastapi.responses import JSONResponse, StreamingResponse
from loguru import logger

from ...common.errors import error_response
from ...common.http_client import build_async_client_for_url
from ...common.model_prefix import (
    format_model_prefix,
    inject_into_non_streaming_result,
    inject_into_streaming_chunk,
)
from ...common.stream_accumulate import accumulate_stream_delta, merged_tool_calls
from ...common.usage import record_usage
from ...langfuse_observability.client import finalize_generation_and_trace
from .. import litellm_bridge, refresh
from ..errors import RefreshRequired, RefreshTransient, SessionNotFound
from ..observability import start_oauth_trace


async def list_models(access_token: str, account_hint: str | None = None) -> list[str]:
    """Codex models this ChatGPT account can run, from the live codex/models endpoint.

    The endpoint is authoritative and plan-tier aware; response is
    ``{"models": [{"slug", "visibility", ...}]}`` (``visibility == "none"`` marks
    internal fallbacks we drop). Returns ``[]`` on any probe failure — there is
    no static fallback list to maintain.
    """
    from ..constants import OPENAI_CODEX_MODELS_URL

    url = f"{OPENAI_CODEX_MODELS_URL}?client_version=1.0.0"
    headers = {
        "Authorization": f"Bearer {access_token}",
        "originator": "codex_cli_rs",
        "User-Agent": "codex_cli_rs/0.0.0",
    }
    if account_hint:
        headers["ChatGPT-Account-Id"] = account_hint
    try:
        timeout = httpx.Timeout(connect=10.0, read=15.0, write=10.0, pool=10.0)
        async with build_async_client_for_url(url, timeout=timeout) as client:
            resp = await client.get(url, headers=headers)
        if resp.status_code == 200:
            payload = resp.json()
            entries = payload.get("models") if isinstance(payload, dict) else None
            return [
                entry["slug"]
                for entry in (entries or [])
                if isinstance(entry, dict)
                and entry.get("slug")
                and entry.get("visibility") != "none"
            ]
        logger.warning("[OAuth] codex models probe http={}", resp.status_code)
    except Exception as exc:
        logger.warning("[OAuth] codex models probe failed: {}", str(exc)[:200])
    return []


_RESPONSES_REGISTERED: set[str] = set()


def _ensure_responses_route(model_id: str) -> None:
    """Force LiteLLM to bridge this Codex model through the Responses API.

    LiteLLM only auto-bridges chatgpt models its bundled registry tags with
    ``mode="responses"`` (e.g. ``gpt-5.4``). Newer Codex models (``gpt-5.5``,
    ``gpt-5.4-mini``, ``gpt-5.6-*``) are unknown to that registry, so LiteLLM
    falls back to ``/codex/chat/completions`` -- an endpoint Codex does not serve
    (403 HTML page). Registering ``mode="responses"`` routes every model to
    ``/codex/responses``, the only chat surface Codex actually exposes.

    Registration is idempotent and cached per process (single-threaded asyncio
    event loop, so the ``set`` needs no lock) to avoid re-registering on every
    request and unbounded growth of LiteLLM's in-process registry.
    """
    if model_id in _RESPONSES_REGISTERED:
        return
    try:
        litellm.register_model(
            {model_id: {"mode": "responses", "litellm_provider": "chatgpt"}}
        )
        _RESPONSES_REGISTERED.add(model_id)
    except Exception as exc:
        logger.warning(
            "[OAuth] could not register responses mode for {}: {}",
            model_id, str(exc)[:200],
        )


def _build_kwargs(model_id: str, body: dict[str, Any]) -> dict[str, Any]:
    """Translate the incoming Chat-Completions body to litellm.acompletion kwargs.

    ``model`` is prefixed ``chatgpt/`` so LiteLLM routes to the Codex Responses
    endpoint via its bridge. We ALWAYS request ``stream=True`` upstream, and
    force ``stream_options.include_usage`` so LiteLLM emits a terminal usage
    chunk (token counts) that downstream session accounting depends on.
    ``drop_params`` is passed per-call (never via global ``litellm.drop_params``)
    so the Codex backend's unsupported Chat-Completions params are dropped
    without leaking that behavior into unrelated LiteLLM call paths.
    """
    stream_options = dict(body.get("stream_options") or {})
    stream_options["include_usage"] = True
    kwargs: dict[str, Any] = {
        "model": f"chatgpt/{model_id}",
        "messages": body.get("messages", []),
        "stream": True,
        "stream_options": stream_options,
        "drop_params": True,
    }
    for opt in ("tools", "tool_choice", "temperature", "top_p", "max_tokens", "reasoning_effort"):
        if opt in body and body[opt] is not None:
            kwargs[opt] = body[opt]
    return kwargs


async def call(
    model_id: str,
    body: dict[str, Any],
    *,
    alias: str | None = None,
    session_id: str | None = None,
    message_id: str | None = None,
    trace_id: str | None = None,
    langfuse_trace_id: str | None = None,
    langfuse_session_id: str | None = None,
    hdr_phase: str | None = None,
    call_kind: str | None = None,
) -> JSONResponse | StreamingResponse:
    """Dispatch an OpenAI-shaped chat completion via the OAuth (Codex) path.

    Returns a standard error envelope for user-facing failures (missing/expired
    session → 401; upstream → 502). Success returns a ``StreamingResponse`` (SSE)
    for stream requests, or a Chat-Completions ``JSONResponse`` for non-stream.
    """
    # --- chokepoint steps 1 + 2: authoritative refresh, then project auth.json ---
    try:
        await refresh.ensure_fresh_token("openai")
    except SessionNotFound:
        return error_response(
            "oauth_session_missing",
            "OAuth session for 'openai' was removed. Re-run login.",
            status_code=401,
            details={"provider": "openai"},
        )
    except RefreshTransient as exc:
        return error_response(
            "oauth_refresh_unavailable",
            "OAuth token refresh failed transiently for 'openai'; retry shortly",
            status_code=502,
            details={"provider": "openai", "reason": str(exc)},
        )
    except RefreshRequired as exc:
        return error_response(
            "oauth_reauth_required",
            "OAuth refresh failed for 'openai'; re-run login",
            status_code=401,
            details={"provider": "openai", "reason": str(exc)},
        )
    try:
        litellm_bridge.project_auth_json("openai")
    except SessionNotFound:
        return error_response(
            "oauth_session_missing",
            "OAuth session for 'openai' was removed. Re-run login.",
            status_code=401,
            details={"provider": "openai"},
        )
    _ensure_responses_route(model_id)

    # --- chokepoint step 3: dispatch via LiteLLM (always stream=True upstream) ---
    req_stream = bool(body.get("stream", False))
    kwargs = _build_kwargs(model_id, body)
    lf_trace, lf_generation, gen_name = start_oauth_trace(
        provider="openai",
        model_id=model_id,
        body=body,
        upstream_kwargs=kwargs,
        req_stream=req_stream,
        session_id=session_id,
        trace_id=trace_id,
        langfuse_trace_id=langfuse_trace_id,
        langfuse_session_id=langfuse_session_id,
        hdr_phase=hdr_phase,
        call_kind=call_kind,
    )

    if req_stream:
        return await _streaming_response(
            kwargs,
            model_id,
            lf_trace=lf_trace,
            lf_generation=lf_generation,
            gen_name=gen_name,
            alias=alias,
            session_id=session_id,
            message_id=message_id,
            trace_id=trace_id,
        )
    return await _collected_response(
        kwargs,
        model_id,
        lf_trace=lf_trace,
        lf_generation=lf_generation,
        gen_name=gen_name,
        alias=alias,
        session_id=session_id,
        message_id=message_id,
        trace_id=trace_id,
    )


def _clean_upstream_detail(exc: Exception) -> str:
    text = str(exc)
    idx = text.lower().find("<html")
    if idx != -1:
        text = text[:idx].rstrip().rstrip("-").strip() or "upstream returned an HTML error page"
    return text[:300]


def _upstream_error_response(exc: Exception, model_id: str) -> JSONResponse:
    status = getattr(exc, "status_code", None)
    detail = _clean_upstream_detail(exc)
    if status == 403:
        return error_response(
            "oauth_model_forbidden",
            f"The model '{model_id}' is not available for this ChatGPT/Codex "
            f"account or plan. Select a different model.",
            status_code=403,
            details={"provider": "openai", "model": model_id, "upstream_detail": detail},
        )
    return error_response(
        "oauth_upstream_error",
        f"OpenAI OAuth upstream error: {detail}",
        status_code=502,
        details={"provider": "openai", "model": model_id},
    )


async def _streaming_response(
    kwargs: dict[str, Any],
    model_id: str,
    *,
    lf_trace: Any,
    lf_generation: Any,
    gen_name: str,
    alias: str | None = None,
    session_id: str | None = None,
    message_id: str | None = None,
    trace_id: str | None = None,
) -> JSONResponse | StreamingResponse:
    """Re-emit LiteLLM's incremental chunks as OpenAI SSE, terminated by [DONE].

    The upstream call is awaited HERE (not inside the generator) so an upstream
    rejection (e.g. Codex 403 HTML page for a plan-gated model) surfaces as a
    clean HTTP error envelope the client can parse, not a malformed in-band SSE
    chunk that fails the caller's chat-completion schema validation.
    """
    try:
        stream = await litellm.acompletion(**kwargs)
    except Exception as exc:
        logger.warning("[OAuth] openai stream dispatch failed: {}", _clean_upstream_detail(exc))
        lf_generation.end(output=None, level="ERROR", status_message=str(exc))
        record_usage(
            None,
            source="cloud",
            model_id=model_id,
            provider="openai",
            alias=alias,
            session_id=session_id,
            message_id=message_id,
            trace_id=trace_id,
        )
        return _upstream_error_response(exc, model_id)

    async def _gen() -> AsyncIterator[bytes]:
        captured_usage: dict | None = None
        captured_model = model_id
        answer_parts: list[str] = []
        tool_call_parts: dict[int, dict] = {}
        captured_finish_reason: str | None = None
        prefix_pending = format_model_prefix(model_id)
        async for chunk in stream:
            try:
                d = chunk.model_dump()
            except Exception:
                continue
            if d.get("usage"):
                captured_usage = d["usage"]
            if d.get("model"):
                captured_model = d["model"]
            finish_reason_chunk = accumulate_stream_delta(
                d, answer_parts=answer_parts, tool_call_parts=tool_call_parts
            )
            if finish_reason_chunk:
                captured_finish_reason = finish_reason_chunk
            if prefix_pending and inject_into_streaming_chunk(d, prefix_pending):
                prefix_pending = None
            yield f"data: {json.dumps(d)}\n\n".encode("utf-8")
        yield b"data: [DONE]\n\n"
        stream_final_output = (
            "".join(answer_parts) if answer_parts else merged_tool_calls(tool_call_parts)
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
            {"usage": captured_usage, "model": captured_model} if captured_usage else None,
            source="cloud",
            model_id=captured_model,
            provider="openai",
            alias=alias,
            session_id=session_id,
            message_id=message_id,
            trace_id=trace_id,
            tool_calls=merged_tool_calls(tool_call_parts) or [],
        )

    return StreamingResponse(_gen(), media_type="text/event-stream")


async def _collected_response(
    kwargs: dict[str, Any],
    model_id: str,
    *,
    lf_trace: Any,
    lf_generation: Any,
    gen_name: str,
    alias: str | None = None,
    session_id: str | None = None,
    message_id: str | None = None,
    trace_id: str | None = None,
) -> JSONResponse:
    """Fold LiteLLM's stream into one Chat-Completions response (non-stream path).

    Sidesteps LiteLLM's broken non-stream assembly by collecting the (working)
    stream ourselves: concat text, accumulate tool_calls by index, keep the last
    finish_reason + usage.
    """
    content_parts: list[str] = []
    tool_calls: dict[int, dict[str, Any]] = {}
    finish_reason: str | None = None
    usage: dict[str, Any] | None = None
    captured_model = model_id
    completion_id = f"chatcmpl-{secrets.token_hex(12)}"

    try:
        stream = await litellm.acompletion(**kwargs)
    except Exception as exc:
        logger.warning("[OAuth] openai non-stream dispatch failed: {}", _clean_upstream_detail(exc))
        lf_generation.end(output=None, level="ERROR", status_message=str(exc))
        return _upstream_error_response(exc, model_id)

    async for chunk in stream:
        try:
            d = chunk.model_dump()
        except Exception:
            continue
        if d.get("model"):
            captured_model = d["model"]
        if d.get("usage"):
            usage = d["usage"]
        choices = d.get("choices") or []
        if not choices:
            continue
        ch0 = choices[0]
        if ch0.get("finish_reason"):
            finish_reason = ch0["finish_reason"]
        delta = ch0.get("delta") or {}
        if isinstance(delta.get("content"), str):
            content_parts.append(delta["content"])
        for tc in delta.get("tool_calls") or []:
            idx = tc.get("index", 0)
            slot = tool_calls.setdefault(
                idx, {"id": tc.get("id") or f"call_{idx}", "type": "function",
                       "function": {"name": "", "arguments": ""}}
            )
            if tc.get("id"):
                slot["id"] = tc["id"]
            fn = tc.get("function") or {}
            if fn.get("name"):
                slot["function"]["name"] = fn["name"]
            if fn.get("arguments"):
                slot["function"]["arguments"] += fn["arguments"]

    message: dict[str, Any] = {"role": "assistant", "content": "".join(content_parts)}
    if tool_calls:
        message["tool_calls"] = [tool_calls[i] for i in sorted(tool_calls)]
        finish_reason = finish_reason or "tool_calls"

    result: dict[str, Any] = {
        "id": completion_id,
        "object": "chat.completion",
        "created": int(time.time()),
        "model": captured_model,
        "choices": [{"index": 0, "message": message, "finish_reason": finish_reason or "stop"}],
    }
    if usage:
        result["usage"] = usage
    prefix = format_model_prefix(model_id)
    if prefix:
        inject_into_non_streaming_result(result, prefix)
    answer_text = message.get("content") or message.get("tool_calls")
    finalize_generation_and_trace(
        lf_generation,
        lf_trace,
        gen_name,
        output=answer_text,
        prompt_tokens=usage.get("prompt_tokens") if usage else None,
        completion_tokens=usage.get("completion_tokens") if usage else None,
        finish_reason=result["choices"][0]["finish_reason"],
    )
    record_usage(
        result,
        source="cloud",
        model_id=captured_model,
        provider="openai",
        alias=alias,
        session_id=session_id,
        message_id=message_id,
        trace_id=trace_id,
    )
    return JSONResponse(result)
