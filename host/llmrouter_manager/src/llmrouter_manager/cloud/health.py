"""Cloud upstream probes — provider credentials, and the selected model.

``probe_provider`` answers "are these credentials and this endpoint reachable?".
It deliberately does *not* send a fake-model completion: unknown model ids are
rejected inconsistently across the ~30 catalogued providers (DeepSeek answers
``400 BadRequest`` where OpenAI answers ``404 NotFound``), so a completion probe
with a placeholder produced false ``probe_failed`` negatives and leaked the
placeholder model name into error details.

``probe_model`` answers the separate question "will chat work with the model the
user actually picked?" by sending a one-token completion down the same dispatch
path chat uses. Listing models is not enough on its own: GitHub Copilot lists
ids that its ``/chat/completions`` endpoint then rejects (#1805), so the picker
and provider probe both pass while every prompt fails.

``probe_provider`` reuses the model-discovery surface, which is model-agnostic:

The catalog resolves each provider's native model-list URL and authentication
protocol. A successful non-empty listing means auth + endpoint work and the
user just needs to pick a real model.

``401 / 403`` and provider-specific invalid-key responses map to
``authentication_failed``; timeouts and connection failures are surfaced
distinctly.
"""

from __future__ import annotations

import json
import time
from typing import Any

from . import model_discovery
from .catalog import get_litellm_provider, get_provider_extra_headers

# Sixteen tokens is the minimum accepted by Copilot's Responses API and remains
# small enough for a connectivity probe. A reasoning model can still spend the
# budget thinking, which is why truncation counts as success below.
_PROBE_MESSAGES = [{"role": "user", "content": "ping"}]
_PROBE_MAX_TOKENS = 16

# Vendor wording for "generation stopped at your token cap". Reaching the cap means
# the endpoint accepted the request and the model produced output, which is exactly
# what the probe set out to prove — so this is a PASS, not a failure. Copilot raises
# it as a 400 on reasoning models such as `gpt-5.4`, which the probe used to report
# as `model_unavailable` and tell the user to pick a different model.
_PROBE_TRUNCATION_MARKERS = (
    "could not finish the message",
    "output limit was reached",
    "higher max_tokens",
)

# Vendor wording for "this id is not usable on the chat endpoint". Matched on
# the error text because the HTTP status is not diagnostic: Copilot wraps its
# rejection of a listed-but-unsupported model in a 502.
_MODEL_UNAVAILABLE_MARKERS = (
    "not accessible",
    "not available",
    "no longer available",
    "does not exist",
    "unknown model",
    "invalid model",
    "model_not_found",
    "unsupported",
    "deprecated",
    "retired",
)
_MODEL_UNAVAILABLE_CODES = frozenset(
    {"oauth_model_forbidden", "model_unavailable", "model_not_found"}
)


def _map_error(status: int, body: dict[str, Any]) -> tuple[str, str]:
    """Map a model-discovery error ``(status, body)`` to ``(code, detail)``.

    Prefers the structured ``error`` code emitted by ``model_discovery`` and
    the HTTP status, then falls back to string heuristics on the detail so the
    LiteLLM fallback path (which collapses everything to
    ``model_list_unavailable``) still classifies auth / timeout / connection
    failures correctly.
    """
    err = str(body.get("error", "")).lower()
    detail = str(body.get("detail", body.get("error", "")))[:300]
    detail_l = detail.lower()

    if (
        err in ("invalid_api_key", "permission_denied")
        or status in (401, 403)
        or "401" in detail
        or "403" in detail
        or "invalid api key" in detail_l
        or "unauthor" in detail_l
        or "permission" in detail_l
    ):
        return "authentication_failed", detail
    if err == "timeout" or "timeout" in detail_l:
        return "timeout", detail
    if err == "connection_failed" or "connection" in detail_l or "connect" in detail_l:
        return "connection_failed", detail
    if err == "rate_limited" or body.get("http_status") == 429:
        return "rate_limited", detail
    return "probe_failed", detail


async def probe_provider(
    api_key: str,
    models_url: str,
    models_protocol: str,
) -> dict[str, Any]:
    """Probe upstream by listing models (model-agnostic health check).

    Returns ``{status, latency_ms, error?, detail?}`` where status is
    ``"ok" | "error"``. ``ok`` means credentials + endpoint are reachable;
    which model the user picks is a separate concern.
    """
    start = time.monotonic()

    def _latency() -> int:
        return int((time.monotonic() - start) * 1000)

    outcome, status, body = await model_discovery.list_models_from_provider_endpoint(
        models_url=models_url,
        api_key=api_key,
        protocol=models_protocol,
    )
    if outcome == "ok" and body.get("data"):
        return {"status": "ok", "latency_ms": _latency()}
    if outcome == "ok":
        status, body = 502, {"error": "empty_model_list", "detail": "provider returned no usable models"}
    code, detail = _map_error(status, body)
    return {
        "status": "error",
        "latency_ms": _latency(),
        "error": code,
        "detail": detail,
    }


def _classify_model_probe(status: int | None, code: str, detail: str) -> str:
    """Map a failed model probe to a ``{error}`` code.

    The envelope ``code`` is checked before the HTTP status because our own
    error codes are precise where the status is ambiguous — Copilot reports a
    plan-gated model as ``403`` and an endpoint-incompatible one as ``502``,
    neither of which means "bad credentials".

    ``model_unavailable`` is only returned on positive evidence (our own code, vendor
    wording, or the standard ``404`` no-such-model). An unrecognized ``400`` is
    reported as ``probe_failed`` instead: telling a user to pick a different model is
    a confident claim, and making it from a status code alone produced false
    negatives on models that work.
    """
    code_l = code.lower()
    detail_l = detail.lower()
    if code_l in _MODEL_UNAVAILABLE_CODES:
        return "model_unavailable"
    if any(marker in detail_l for marker in _MODEL_UNAVAILABLE_MARKERS):
        return "model_unavailable"
    if code_l in ("oauth_reauth_required", "oauth_session_missing") or status in (401, 403):
        return "authentication_failed"
    if status == 429:
        return "rate_limited"
    if status == 404:
        return "model_unavailable"
    return "probe_failed"


def _error_fields(body: Any) -> tuple[str, str]:
    """Pull ``(code, detail)`` out of a standard or OpenAI-shaped error body."""
    error = body.get("error") if isinstance(body, dict) else None
    if isinstance(error, dict):
        code = error.get("code")
        message = error.get("message") or error.get("detail")
        return (
            str(code) if isinstance(code, (str, int)) else "",
            str(message)[:300] if message else "",
        )
    if isinstance(error, str):
        return "", error[:300]
    return "", ""


async def probe_model(
    *,
    provider_id: str,
    model_id: str,
    auth_mode: str,
    api_key: str,
    base_url: str | None,
) -> dict[str, Any]:
    """Probe the *selected* model with a one-token chat completion.

    Returns the same ``{status, latency_ms, error?, detail?}`` envelope as
    ``probe_provider``, with ``error == "model_unavailable"`` when the model
    itself is the problem so the caller can tell the user to pick another one.
    """
    start = time.monotonic()

    def _latency() -> int:
        return int((time.monotonic() - start) * 1000)

    status: int | None = None
    code = ""
    detail = ""

    if auth_mode == "oauth":
        from ..oauth import dispatch as oauth_dispatch

        response = await oauth_dispatch.call(
            provider_id,
            model_id,
            {"messages": list(_PROBE_MESSAGES), "stream": False, "max_tokens": _PROBE_MAX_TOKENS},
        )
        status = int(getattr(response, "status_code", 200))
        if status < 400:
            return {"status": "ok", "latency_ms": _latency(), "model": model_id}
        try:
            code, detail = _error_fields(json.loads(bytes(getattr(response, "body", b"") or b"{}")))
        except (ValueError, TypeError):
            code, detail = "", ""
    else:
        import litellm

        try:
            await litellm.acompletion(
                model=f"{get_litellm_provider(provider_id)}/{model_id}",
                messages=list(_PROBE_MESSAGES),
                max_tokens=_PROBE_MAX_TOKENS,
                api_base=(base_url or "").rstrip("/") or None,
                api_key=api_key or None,
                drop_params=True,
                extra_headers=get_provider_extra_headers(provider_id) or None,
            )
        except Exception as exc:  # litellm raises a wide typed hierarchy
            raw_status = getattr(exc, "status_code", None)
            status = int(raw_status) if isinstance(raw_status, int) else None
            detail = str(exc)[:300]
        else:
            return {"status": "ok", "latency_ms": _latency(), "model": model_id}

    if any(marker in detail.lower() for marker in _PROBE_TRUNCATION_MARKERS):
        return {"status": "ok", "latency_ms": _latency(), "model": model_id}

    return {
        "status": "error",
        "latency_ms": _latency(),
        "error": _classify_model_probe(status, code, detail),
        "detail": detail or f"model {model_id!r} was rejected by {provider_id}",
        "model": model_id,
    }
