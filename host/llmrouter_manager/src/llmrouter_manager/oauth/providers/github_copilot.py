"""GitHub Copilot OAuth dispatch via LiteLLM's ``github_copilot/`` provider.

SuperClaw owns only the device-flow login; LiteLLM derives + refreshes the
short-lived Copilot API key itself. ``ensure_ready`` projects a fresh
``access-token`` then derives that key via ``asyncio.to_thread`` under a lock,
because LiteLLM's ``Authenticator`` is synchronous and would otherwise block the
event loop and let concurrent first requests race the projected token file.
"""

from __future__ import annotations

import asyncio
import json
import re
import time
from typing import Any, AsyncIterator

import httpx
import litellm
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
from .. import copilot_bridge
from ..constants import COPILOT_MODELS_URL, REFRESH_SKEW_SECONDS
from ..errors import RefreshRequired, RefreshTransient, SessionNotFound
from ..observability import start_oauth_trace

_MODEL_PREFIX = "github_copilot/"
_ready_lock = asyncio.Lock()
_MODEL_ENDPOINTS: dict[str, frozenset[str]] = {}
_RESPONSES_REGISTERED: set[str] = set()

# `drop_params` only covers models in LiteLLM's model map; a newer Copilot model
# that refuses one of these is told so by the upstream, once per process.
_DROPPABLE_PARAMS = frozenset({"temperature", "top_p", "max_tokens", "reasoning_effort"})
_UNSUPPORTED_PARAM = re.compile(r"Unsupported parameter: '([a-z_]+)'")
_UNSUPPORTED_PARAMS: dict[str, set[str]] = {}

# LiteLLM Authenticator (sync) defaults to ~5s per HTTP call; corporate
# proxies push api.github.com to ~10.6s. 30s covers real-world latency
# without holding the UI's model-list dropdown open too long.
_DERIVE_TIMEOUT_SECONDS = 30.0

# LiteLLM builds the Authenticator's httpx client from
# custom_httpx.http_handler._DEFAULT_TIMEOUT, whose connect=5.0s is
# hardcoded (not env-configurable). Corporate-proxy TLS handshakes to
# api.github.com routinely exceed 5s, tripping httpx.ConnectTimeout
# inside our outer asyncio.wait_for wrapper before it can help.
# Override _DEFAULT_TIMEOUT at import time (before Authenticator
# instantiates its client) so the connect budget matches the outer
# wrapper. The outer wait_for stays as a hard cap against a truly
# hung derive thread.
from litellm.llms.custom_httpx import http_handler as _litellm_http_handler
_litellm_http_handler._DEFAULT_TIMEOUT = httpx.Timeout(
    timeout=600.0, connect=_DERIVE_TIMEOUT_SECONDS
)

# LiteLLM's github_copilot chat transform rewrites every system message to an
# assistant message unless this flag is set, so the model never receives its
# instructions (an agent prompt or the HDR sidecar's output contract arrives as
# something the model "said"). The Copilot API accepts system messages for all
# models it serves.
litellm.disable_copilot_system_to_assistant = True


def _strip_prefix(model_id: str) -> str:
    return model_id[len(_MODEL_PREFIX):] if model_id.startswith(_MODEL_PREFIX) else model_id


def _derive_api_key_sync() -> str:
    from litellm.llms.github_copilot.authenticator import Authenticator

    return Authenticator().get_api_key()


def _api_key_fresh() -> bool:
    """True when LiteLLM's derived ``api-key.json`` exists and is unexpired.

    Hot path: when the derived key is still good, LiteLLM uses it directly, so we
    can skip the lock + projection + off-loop derivation entirely.
    """
    try:
        with open(copilot_bridge.token_dir() / "api-key.json", encoding="utf-8") as f:
            info = json.load(f)
    except (OSError, ValueError):
        return False
    exp = info.get("expires_at")
    return isinstance(exp, (int, float)) and exp > time.time() + REFRESH_SKEW_SECONDS


async def ensure_ready(provider_id: str = "github_copilot") -> None:
    """Ensure LiteLLM can dispatch: project the ``access-token`` and derive the
    Copilot key off the event loop, unless the derived key is already fresh.

    Fast path skips the lock when ``api-key.json`` is unexpired. Otherwise a
    double-checked lock serializes concurrent first requests so only one derives.
    Raises ``SessionNotFound`` (no/partial session), ``RefreshRequired`` (access
    token dead → re-login), or ``RefreshTransient`` (network/other, retryable).
    """
    if _api_key_fresh():
        return

    from litellm.exceptions import AuthenticationError
    from litellm.llms.github_copilot.common_utils import GetAPIKeyError

    async with _ready_lock:
        if _api_key_fresh():
            return
        copilot_bridge.project_access_token(provider_id)
        try:
            await asyncio.wait_for(
                asyncio.to_thread(_derive_api_key_sync),
                timeout=_DERIVE_TIMEOUT_SECONDS,
            )
        except (GetAPIKeyError, AuthenticationError) as exc:
            raise RefreshRequired(
                f"copilot api-key derivation rejected for {provider_id!r}: {str(exc)[:200]}"
            ) from exc
        except asyncio.TimeoutError as exc:
            raise RefreshTransient(
                f"copilot api-key derivation exceeded {_DERIVE_TIMEOUT_SECONDS}s "
                f"for {provider_id!r}"
            ) from exc
        except Exception as exc:
            raise RefreshTransient(
                f"copilot api-key derivation failed transiently for {provider_id!r}: {str(exc)[:200]}"
            ) from exc


async def clear_ready() -> None:
    """Delete the projected plaintext caches under the readiness lock.

    Serializing against ``ensure_ready`` prevents a logout from deleting
    ``access-token`` mid-derivation, which would re-arm LiteLLM's headless
    device-code ``_login`` on the racing request.
    """
    async with _ready_lock:
        copilot_bridge.clear_projected()
        _MODEL_ENDPOINTS.clear()
        _UNSUPPORTED_PARAMS.clear()


def _readiness_error_response(exc: Exception) -> JSONResponse:
    if isinstance(exc, SessionNotFound):
        return error_response(
            "oauth_session_missing",
            "OAuth session for 'github_copilot' is missing or incomplete. Re-run login.",
            status_code=401,
            details={"provider": "github_copilot"},
        )
    if isinstance(exc, RefreshTransient):
        return error_response(
            "oauth_refresh_unavailable",
            "Copilot token derivation failed transiently; retry shortly",
            status_code=502,
            details={"provider": "github_copilot", "reason": str(exc)},
        )
    return error_response(
        "oauth_reauth_required",
        "Copilot access token is no longer valid; re-run login",
        status_code=401,
        details={"provider": "github_copilot", "reason": str(exc)},
    )


def _build_kwargs(model_id: str, body: dict[str, Any]) -> dict[str, Any]:
    kwargs: dict[str, Any] = {
        "model": f"{_MODEL_PREFIX}{model_id}",
        "messages": body.get("messages", []),
        "drop_params": True,
    }
    for opt in ("tools", "tool_choice", "temperature", "top_p", "max_tokens", "reasoning_effort"):
        if opt in body and body[opt] is not None:
            kwargs[opt] = body[opt]
    return kwargs


def _normalized_endpoints(entry: dict[str, Any]) -> frozenset[str]:
    raw = entry.get("supported_endpoints")
    if not isinstance(raw, list):
        capabilities = entry.get("capabilities")
        raw = capabilities.get("supported_endpoints") if isinstance(capabilities, dict) else None
    if not isinstance(raw, list):
        return frozenset()
    return frozenset(
        endpoint.removeprefix("v1/")
        for value in raw
        if isinstance(value, str) and (endpoint := value.strip().strip("/"))
    )


def _cache_model_endpoints(entries: Any) -> list[str]:
    if not isinstance(entries, list):
        return []
    models = [
        entry
        for entry in entries
        if isinstance(entry, dict) and isinstance(entry.get("id"), str)
    ]
    if not models:
        return []
    _MODEL_ENDPOINTS.clear()
    _MODEL_ENDPOINTS.update(
        {entry["id"]: _normalized_endpoints(entry) for entry in models}
    )
    return [entry["id"] for entry in models]


def _ensure_responses_route(model_id: str) -> None:
    if model_id in _RESPONSES_REGISTERED:
        return
    litellm.register_model(
        {
            f"{_MODEL_PREFIX}{model_id}": {
                "mode": "responses",
                "litellm_provider": "github_copilot",
            }
        }
    )
    _RESPONSES_REGISTERED.add(model_id)


def _is_responses_only(model_id: str) -> bool:
    endpoints = _MODEL_ENDPOINTS.get(model_id, frozenset())
    return "responses" in endpoints and "chat/completions" not in endpoints


def _is_chat_endpoint_rejection(exc: Exception) -> bool:
    detail = str(exc).lower()
    return "not accessible via the /chat/completions endpoint" in detail


def _rejected_param(exc: Exception, kwargs: dict[str, Any]) -> str | None:
    if getattr(exc, "status_code", None) != 400:
        return None
    match = _UNSUPPORTED_PARAM.search(str(exc))
    if match is None:
        return None
    param = match.group(1)
    return param if param in _DROPPABLE_PARAMS and param in kwargs else None


async def _acompletion(model_id: str, kwargs: dict[str, Any]) -> Any:
    if _is_responses_only(model_id):
        _ensure_responses_route(model_id)
    while True:
        unsupported = _UNSUPPORTED_PARAMS.get(model_id, set())
        kwargs = {key: value for key, value in kwargs.items() if key not in unsupported}
        try:
            return await litellm.acompletion(**kwargs)
        except Exception as exc:
            param = _rejected_param(exc, kwargs)
            if param is not None:
                _UNSUPPORTED_PARAMS.setdefault(model_id, set()).add(param)
                logger.warning("[OAuth] copilot param_dropped={} upstream={}", param, model_id)
                continue
            if model_id in _RESPONSES_REGISTERED or not _is_chat_endpoint_rejection(exc):
                raise
            _ensure_responses_route(model_id)
            _MODEL_ENDPOINTS[model_id] = frozenset({"responses"})


def _clean_upstream_detail(exc: Exception) -> str:
    text = str(exc)
    idx = text.lower().find("<html")
    if idx != -1:
        text = text[:idx].rstrip().rstrip("-").strip() or "upstream returned an HTML error page"
    return text[:300]


def _upstream_error_response(exc: Exception, model_id: str) -> JSONResponse:
    status = getattr(exc, "status_code", None)
    detail = _clean_upstream_detail(exc)
    if status == 401:
        return error_response(
            "oauth_reauth_required",
            "Copilot rejected the request as unauthenticated; re-run login",
            status_code=401,
            details={"provider": "github_copilot", "model": model_id, "upstream_detail": detail},
        )
    if status == 403:
        return error_response(
            "oauth_model_forbidden",
            f"The model '{model_id}' is not available for this Copilot plan. Select a different model.",
            status_code=403,
            details={"provider": "github_copilot", "model": model_id, "upstream_detail": detail},
        )
    return error_response(
        "oauth_upstream_error",
        f"GitHub Copilot upstream error: {detail}",
        status_code=502,
        details={"provider": "github_copilot", "model": model_id},
    )


def _upstream_error_sse_stream(exc: Exception, model_id: str) -> StreamingResponse:
    """Return an OpenAI-shaped in-band SSE error for streaming chat clients.

    A bare HTTP 502 JSON body on a ``stream=true`` request leaves OpenCode waiting
    for ``text/event-stream`` chunks — the turn looks hung and no assistant
    ``error`` field is persisted (#1805).
    """
    envelope = json.loads(bytes(_upstream_error_response(exc, model_id).body))
    lrm_err = envelope["error"]
    status = getattr(exc, "status_code", None)
    if status in (401, 403):
        error_type = "invalid_request_error"
    elif status == 429:
        error_type = "rate_limit_error"
    else:
        error_type = "server_error"
    openai_err = {
        "error": {
            "message": lrm_err["message"],
            "type": error_type,
            "code": lrm_err["code"],
        }
    }

    async def _gen() -> AsyncIterator[bytes]:
        yield f"data: {json.dumps(openai_err)}\n\n".encode("utf-8")

    return StreamingResponse(_gen(), media_type="text/event-stream")


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
    """Dispatch an OpenAI-shaped chat completion via the Copilot OAuth path."""
    bare = _strip_prefix(model_id)
    try:
        await ensure_ready("github_copilot")
    except (SessionNotFound, RefreshTransient, RefreshRequired) as exc:
        return _readiness_error_response(exc)

    kwargs = _build_kwargs(bare, body)
    req_stream = bool(body.get("stream", False))
    lf_trace, lf_generation, gen_name = start_oauth_trace(
        provider="github_copilot",
        model_id=bare,
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
            bare,
            body,
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
        bare,
        lf_trace=lf_trace,
        lf_generation=lf_generation,
        gen_name=gen_name,
        alias=alias,
        session_id=session_id,
        message_id=message_id,
        trace_id=trace_id,
    )


async def _streaming_response(
    kwargs: dict[str, Any],
    model_id: str,
    body: dict[str, Any],
    *,
    lf_trace: Any,
    lf_generation: Any,
    gen_name: str,
    alias: str | None = None,
    session_id: str | None = None,
    message_id: str | None = None,
    trace_id: str | None = None,
) -> JSONResponse | StreamingResponse:
    stream_options = dict(body.get("stream_options") or {})
    stream_options["include_usage"] = True
    kwargs = {**kwargs, "stream": True, "stream_options": stream_options}
    try:
        stream = await _acompletion(model_id, kwargs)
    except Exception as exc:
        logger.warning("[OAuth] copilot stream dispatch failed: {}", _clean_upstream_detail(exc))
        lf_generation.end(output=None, level="ERROR", status_message=str(exc))
        record_usage(
            None,
            source="cloud",
            model_id=model_id,
            provider="github_copilot",
            alias=alias,
            session_id=session_id,
            message_id=message_id,
            trace_id=trace_id,
        )
        return _upstream_error_sse_stream(exc, model_id)

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
            provider="github_copilot",
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
    try:
        response = await _acompletion(model_id, kwargs)
    except Exception as exc:
        logger.warning("[OAuth] copilot non-stream dispatch failed: {}", _clean_upstream_detail(exc))
        lf_generation.end(output=None, level="ERROR", status_message=str(exc))
        return _upstream_error_response(exc, model_id)
    try:
        result = response.model_dump()
    except Exception as exc:
        lf_generation.end(output=None, level="ERROR", status_message=str(exc))
        return _upstream_error_response(exc, model_id)
    prefix = format_model_prefix(model_id)
    if prefix:
        inject_into_non_streaming_result(result, prefix)
    usage = result.get("usage") or {}
    choices = result.get("choices") or [{}]
    message = choices[0].get("message") or {}
    answer_text = message.get("content") or message.get("tool_calls")
    finalize_generation_and_trace(
        lf_generation,
        lf_trace,
        gen_name,
        output=answer_text,
        prompt_tokens=usage.get("prompt_tokens"),
        completion_tokens=usage.get("completion_tokens"),
        finish_reason=choices[0].get("finish_reason"),
    )
    record_usage(
        result,
        source="cloud",
        model_id=str(result.get("model", model_id)),
        provider="github_copilot",
        alias=alias,
        session_id=session_id,
        message_id=message_id,
        trace_id=trace_id,
    )
    return JSONResponse(result)


def _api_key_and_base_sync() -> tuple[str, str | None]:
    from litellm.llms.github_copilot.authenticator import Authenticator

    auth = Authenticator()
    return auth.get_api_key(), auth.get_api_base()


def _registry_models() -> list[str]:
    models = getattr(litellm, "github_copilot_models", None)
    return sorted(_strip_prefix(str(m)) for m in models) if models else []


async def list_models(provider_id: str = "github_copilot") -> list[str]:
    """Live Copilot model ids (unprefixed). Falls back to LiteLLM's registry.

    Readiness failures (``SessionNotFound`` / ``RefreshRequired`` /
    ``RefreshTransient``) propagate up so the endpoint can surface a
    structured error instead of an empty list (issue: corporate-proxy
    latency triggered LiteLLM's ~5s timeout, and the swallowed exception
    made the UI dropdown appear empty with no signal).
    """
    if provider_id != "github_copilot":
        return []
    await ensure_ready(provider_id)
    try:
        api_key, api_base = await asyncio.to_thread(_api_key_and_base_sync)
        from litellm.llms.github_copilot.common_utils import get_copilot_default_headers

        url = (
            f"{api_base.rstrip('/')}/models"
            if api_base
            else COPILOT_MODELS_URL
        )
        timeout = httpx.Timeout(connect=10.0, read=15.0, write=10.0, pool=10.0)
        async with build_async_client_for_url(url, timeout=timeout) as client:
            resp = await client.get(url, headers=get_copilot_default_headers(api_key))
        if resp.status_code == 200:
            payload = resp.json()
            entries = payload.get("data") if isinstance(payload, dict) else None
            live = _cache_model_endpoints(entries)
            if live:
                return live
        logger.warning("[OAuth] copilot models probe http={}", resp.status_code)
    except Exception as exc:
        logger.warning("[OAuth] copilot models probe failed: {}", str(exc)[:200])
    return _registry_models()
