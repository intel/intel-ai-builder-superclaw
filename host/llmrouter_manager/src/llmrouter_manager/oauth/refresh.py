"""Token refresh — authoritative, synchronous on the dispatch call path.

We (NOT LiteLLM) own refresh. Refresh happens when within skew of expiry,
guarded by a per-provider ``asyncio.Lock`` so two concurrent dispatches don't
double-consume the single-use refresh_token. Failure surfaces as
``RefreshRequired`` → HTTP 401 ``oauth_reauth_required``.

Keeping refresh here is what lets us hand LiteLLM a always-fresh ``auth.json``
so LiteLLM never triggers its own refresh (plaintext writeback) or its
device-code login flow (the headless hang).
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

import httpx
from loguru import logger

from ..common.http_client import build_async_client_for_url
from . import state as oauth_state
from .constants import REFRESH_SKEW_SECONDS, get_provider
from .errors import RefreshRequired, RefreshTransient, SessionNotFound


# Per-provider async lock — prevents concurrent dispatches from both rotating
# the same refresh_token in parallel and invalidating one.
_locks: dict[str, asyncio.Lock] = {}


def _lock_for(provider_id: str) -> asyncio.Lock:
    lock = _locks.get(provider_id)
    if lock is None:
        lock = asyncio.Lock()
        _locks[provider_id] = lock
    return lock


def _needs_refresh(session: dict[str, Any]) -> bool:
    expires_at = session.get("expires_at")
    if not isinstance(expires_at, (int, float)):
        return True  # missing/malformed expiry — force refresh rather than risk a dead token
    return (expires_at - time.time()) < REFRESH_SKEW_SECONDS


def _extract_access_token(provider_id: str, session: dict[str, Any]) -> str:
    token = session.get("access_token")
    if not isinstance(token, str) or not token:
        raise SessionNotFound(f"oauth session for {provider_id!r} is missing access_token")
    return token


async def ensure_fresh_token(provider_id: str) -> str:
    """Return an access_token fresh for >= ``REFRESH_SKEW_SECONDS``.

    Refreshes on disk if needed. Raises ``SessionNotFound`` (no session) or
    ``RefreshRequired`` (refresh_token dead) — caller surfaces HTTP 401.
    """
    session = oauth_state.get(provider_id)
    if session is None:
        raise SessionNotFound(f"no oauth session for {provider_id!r}")

    if not _needs_refresh(session):
        return _extract_access_token(provider_id, session)

    async with _lock_for(provider_id):
        # Re-read after acquiring the lock: another coroutine may have already
        # refreshed while we waited.
        session = oauth_state.get(provider_id)
        if session is None:
            raise SessionNotFound(f"no oauth session for {provider_id!r}")
        if not _needs_refresh(session):
            return _extract_access_token(provider_id, session)
        return await _refresh_and_persist(provider_id, session)


async def _refresh_and_persist(provider_id: str, session: dict[str, Any]) -> str:
    provider = get_provider(provider_id)
    refresh_token = str(session.get("refresh_token", ""))
    if not refresh_token:
        raise RefreshRequired(f"no refresh_token in session for {provider_id!r}")

    request_body: dict[str, Any] = {
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "client_id": provider.client_id,
    }

    timeout = httpx.Timeout(connect=10.0, read=30.0, write=10.0, pool=10.0)
    try:
        async with build_async_client_for_url(provider.token_url, timeout=timeout) as client:
            if provider.refresh_content_type == "form":
                resp = await client.post(
                    provider.token_url,
                    data=request_body,
                    headers={"Content-Type": "application/x-www-form-urlencoded"},
                )
            else:
                resp = await client.post(
                    provider.token_url,
                    json=request_body,
                    headers={"Content-Type": "application/json"},
                )
    except httpx.HTTPError as exc:
        # Network-level failure — do NOT wipe the on-disk session; a retry may
        # succeed. Transient, so callers surface 502 (not a 401 re-login prompt).
        logger.warning("[OAuth] refresh network error provider={}: {}", provider_id, exc)
        raise RefreshTransient(f"refresh network error for {provider_id!r}: {exc}") from exc

    if resp.status_code != 200:
        logger.warning(
            "[OAuth] refresh rejected provider={} http={} body={}",
            provider_id,
            resp.status_code,
            resp.text[:500],
        )
        # 5xx is a provider-side transient outage (retryable); 4xx (invalid_grant)
        # means the refresh_token is genuinely dead and the user must re-login.
        if resp.status_code >= 500:
            raise RefreshTransient(
                f"provider {provider_id!r} refresh transient (http {resp.status_code})"
            )
        raise RefreshRequired(f"provider {provider_id!r} rejected refresh (http {resp.status_code})")

    try:
        payload = resp.json()
    except ValueError as exc:
        raise RefreshRequired(f"provider {provider_id!r} refresh returned non-JSON body") from exc

    new_access = payload.get("access_token")
    if not isinstance(new_access, str) or not new_access:
        raise RefreshRequired(f"provider {provider_id!r} refresh response missing access_token")

    # Refresh token rotates on both providers; if the response omits it, keep the
    # existing one (Codex CLI behavior).
    new_refresh = payload.get("refresh_token")
    if not isinstance(new_refresh, str) or not new_refresh:
        new_refresh = refresh_token

    expires_in = payload.get("expires_in")
    if not isinstance(expires_in, (int, float)) or expires_in <= 0:
        expires_in = 3600
    expires_at = int(time.time()) + int(expires_in)

    new_session = dict(session)
    new_session["access_token"] = new_access
    new_session["refresh_token"] = new_refresh
    new_session["expires_at"] = expires_at
    if "id_token" in payload and isinstance(payload["id_token"], str):
        new_session["id_token"] = payload["id_token"]
    if "scope" in payload:
        new_session["scope"] = str(payload["scope"])
    new_session["stored_at"] = int(time.time())

    oauth_state.put(provider_id, new_session)
    logger.info(
        "config.change kind=oauth.session action=refresh provider={} expires_in={}s",
        provider_id,
        int(expires_in),
    )
    return new_access
