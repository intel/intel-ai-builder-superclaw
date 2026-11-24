"""FastAPI routes under ``/llm-router/v1/oauth/*``.

Unauthenticated on LRM itself (same posture as ``/cloud/*``, ``/edge/*`` per the
ServiceHub sub-service contract §8). Never returns token material — only
``expires_at``, ``scope``, ``account_hint``.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from loguru import logger

from ..common.errors import error_response
from . import flow, litellm_bridge, refresh, state as oauth_state
from .constants import OAUTH_PROVIDER_IDS
from .errors import NoCallbackPort, OAuthProviderUnsupported, ProviderRejected, RefreshRequired, RefreshTransient, SessionNotFound


oauth_router = APIRouter(prefix="/llm-router/v1/oauth", tags=["oauth"])


def _validate_provider_or_error(provider_id: str) -> JSONResponse | None:
    if provider_id not in OAUTH_PROVIDER_IDS:
        return error_response(
            "oauth_provider_unsupported",
            f"provider {provider_id!r} is not a supported oauth provider",
            status_code=422,
            details={"provider": provider_id, "supported": list(OAUTH_PROVIDER_IDS)},
        )
    return None


def _session_view(provider_id: str, session: dict[str, Any]) -> dict[str, Any]:
    """Token-free view of an on-disk session for HTTP responses."""
    return {
        "provider": provider_id,
        "expires_at": session.get("expires_at"),
        "scope": session.get("scope"),
        "account_hint": session.get("account_hint"),
        "stored_at": session.get("stored_at"),
    }


@oauth_router.get("/providers")
async def list_providers() -> JSONResponse:
    items = []
    for provider_id in oauth_state.list_configured():
        session = oauth_state.get(provider_id)
        if session is None:
            continue
        items.append(_session_view(provider_id, session))
    return JSONResponse(items)


@oauth_router.get("/providers/{provider_id}")
async def get_provider_status(provider_id: str) -> JSONResponse:
    err = _validate_provider_or_error(provider_id)
    if err is not None:
        return err
    session = oauth_state.get(provider_id)
    if session is None:
        return error_response(
            "oauth_not_configured",
            f"no oauth session stored for {provider_id!r}",
            status_code=404,
        )
    return JSONResponse(_session_view(provider_id, session))


@oauth_router.post("/providers/{provider_id}/login")
async def start_login(provider_id: str, request: Request) -> JSONResponse:
    """Kick off a PKCE flow. Returns authorize_url — caller opens the browser."""
    err = _validate_provider_or_error(provider_id)
    if err is not None:
        return err

    options: dict[str, Any] = {}
    raw = await request.body()
    if raw:
        try:
            parsed = await request.json()
        except Exception:
            return error_response("invalid_json", "request body is not valid JSON", status_code=400)
        if isinstance(parsed, dict):
            options = parsed
        else:
            return error_response("invalid_body", "request body must be a JSON object", status_code=400)

    try:
        result = await flow.start_login(provider_id, options=options)
    except OAuthProviderUnsupported as exc:
        return error_response("oauth_provider_unsupported", str(exc), status_code=422)
    except ProviderRejected as exc:
        return error_response(
            "oauth_login_unavailable",
            f"oauth login could not be started for {provider_id!r}",
            status_code=502,
            details={"http_status": exc.http_status, "reason": exc.detail},
        )
    except NoCallbackPort as exc:
        return error_response("no_callback_port", str(exc), status_code=503)
    logger.info(
        "oauth.login.start provider={} flow_kind={} callback_port={}",
        provider_id, result.get("flow_kind", "pkce"), result.get("callback_port"),
    )
    return JSONResponse(result)


@oauth_router.get("/providers/{provider_id}/status")
async def poll_status(provider_id: str) -> JSONResponse:
    err = _validate_provider_or_error(provider_id)
    if err is not None:
        return err
    try:
        snapshot = await flow.get_status(provider_id)
    except OAuthProviderUnsupported as exc:
        return error_response("oauth_provider_unsupported", str(exc), status_code=422)
    return JSONResponse(snapshot)


@oauth_router.post("/providers/{provider_id}/cancel")
async def cancel_flow(provider_id: str) -> JSONResponse:
    err = _validate_provider_or_error(provider_id)
    if err is not None:
        return err
    try:
        await flow.cancel(provider_id)
    except OAuthProviderUnsupported as exc:
        return error_response("oauth_provider_unsupported", str(exc), status_code=422)
    return JSONResponse({"ok": True})


@oauth_router.delete("/providers/{provider_id}")
async def delete_session(provider_id: str) -> JSONResponse:
    """Remove the stored OAuth session locally + the derived plaintext cache.

    Does NOT invalidate the token upstream. Idempotent.
    """
    err = _validate_provider_or_error(provider_id)
    if err is not None:
        return err
    removed = oauth_state.delete(provider_id)
    if provider_id == "github_copilot":
        from .providers import github_copilot

        await github_copilot.clear_ready()
    else:
        litellm_bridge.clear_projected()
    logger.info(
        "config.change kind=oauth.session action=delete provider={} removed={}",
        provider_id, removed,
    )
    return JSONResponse({"ok": True})


@oauth_router.post("/providers/{provider_id}/refresh")
async def force_refresh(provider_id: str) -> JSONResponse:
    """Force a token refresh (mostly for testing). Reports new expiry or error."""
    err = _validate_provider_or_error(provider_id)
    if err is not None:
        return err
    if provider_id == "github_copilot":
        return error_response(
            "not_supported",
            "github_copilot uses a device-grant access token with no refresh_token; "
            "the short-lived Copilot key is derived on demand by LiteLLM. Re-run login to replace a dead token.",
            status_code=422,
            details={"provider": provider_id},
        )
    try:
        await refresh.ensure_fresh_token(provider_id)
    except SessionNotFound:
        return error_response(
            "oauth_not_configured",
            f"no oauth session stored for {provider_id!r}",
            status_code=404,
        )
    except RefreshTransient as exc:
        return error_response(
            "oauth_refresh_unavailable",
            f"refresh failed transiently for {provider_id!r}; retry shortly",
            status_code=502,
            details={"reason": str(exc)},
        )
    except RefreshRequired as exc:
        return error_response(
            "oauth_reauth_required",
            f"refresh failed for {provider_id!r}; re-run login",
            status_code=401,
            details={"reason": str(exc)},
        )
    session = oauth_state.get(provider_id) or {}
    return JSONResponse({"ok": True, "expires_at": session.get("expires_at")})
