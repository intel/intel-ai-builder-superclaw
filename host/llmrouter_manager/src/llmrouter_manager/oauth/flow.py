"""OAuth PKCE flow orchestration — start / status / cancel + callback handling.

Public API used by ``api.py``:

- ``start_login(provider_id, options)`` → dict with ``authorize_url`` etc.
- ``get_status(provider_id)`` → status snapshot (never returns token material)
- ``cancel(provider_id)`` → idempotent

Background token exchange runs as an asyncio task launched at ``start_login``:
it polls the callback ``threading.Event``, validates state, exchanges the code,
and persists tokens via ``state.put``.
"""

from __future__ import annotations

import asyncio
import base64
import json
import time
from typing import Any, Literal, Optional
from urllib.parse import urlencode

import httpx
from loguru import logger

from ..common.http_client import build_async_client_for_url
from . import callback_server, pkce, state as oauth_state
from .constants import (
    COPILOT_POLL_MAX_INTERVAL,
    COPILOT_POLL_MIN_INTERVAL,
    FLOW_EXPIRY_SECONDS,
    OAUTH_PROVIDER_IDS,
    OPENAI_ID_TOKEN_AUTH_NAMESPACE,
    ProviderOAuthConfig,
    get_provider,
)
from .errors import OAuthProviderUnsupported, ProviderRejected
from .state import SCHEMA_VERSION


FlowStatus = Literal[
    "awaiting_callback", "exchanging", "complete", "cancelled", "error"
]


class FlowContext:
    """In-memory state for one in-progress login flow. Created inside
    ``start_login``; not constructed directly by callers."""

    __slots__ = (
        "provider_id", "status", "verifier", "state", "callback_port",
        "callback_holder", "authorize_url", "started_at", "expires_at",
        "error_code", "error_message", "task",
    )

    def __init__(
        self,
        *,
        provider_id: str,
        verifier: str,
        state: str,
        callback_port: int,
        callback_holder: dict,
        authorize_url: str,
    ) -> None:
        self.provider_id = provider_id
        self.status: FlowStatus = "awaiting_callback"
        self.verifier = verifier
        self.state = state
        self.callback_port = callback_port
        self.callback_holder = callback_holder
        self.authorize_url = authorize_url
        self.started_at = time.time()
        self.expires_at = self.started_at + FLOW_EXPIRY_SECONDS
        self.error_code: Optional[str] = None
        self.error_message: Optional[str] = None
        self.task: Optional[asyncio.Task[None]] = None


class DeviceFlowContext:
    """In-memory state for one in-progress RFC 8628 device flow.

    Parallel to ``FlowContext`` but with no PKCE/callback fields — the device
    grant has no redirect and no callback server. Exposes the same
    ``status`` / ``expires_at`` / ``error_code`` / ``error_message`` / ``task``
    surface ``get_status`` reads generically.
    """

    __slots__ = (
        "provider_id", "status", "device_code", "user_code", "verification_uri",
        "interval", "started_at", "expires_at", "error_code", "error_message", "task",
    )

    def __init__(
        self,
        *,
        provider_id: str,
        device_code: str,
        user_code: str,
        verification_uri: str,
        interval: int,
        expires_at: float,
    ) -> None:
        self.provider_id = provider_id
        self.status: str = "awaiting_authorization"
        self.device_code = device_code
        self.user_code = user_code
        self.verification_uri = verification_uri
        self.interval = interval
        self.started_at = time.time()
        self.expires_at = expires_at
        self.error_code: Optional[str] = None
        self.error_message: Optional[str] = None
        self.task: Optional[asyncio.Task[None]] = None


# Module-level flow registry. One flow at a time per provider. Guarded by
# ``_registry_lock`` for atomic check-and-set on start_login.
_flows: dict[str, "FlowContext | DeviceFlowContext"] = {}
_registry_lock = asyncio.Lock()
_provider_locks = {provider_id: asyncio.Lock() for provider_id in OAUTH_PROVIDER_IDS}


def _validate_provider(provider_id: str) -> None:
    if provider_id not in OAUTH_PROVIDER_IDS:
        raise OAuthProviderUnsupported(
            f"provider {provider_id!r} is not a supported oauth provider"
        )


def _build_redirect_uri(provider: ProviderOAuthConfig, callback_port: int) -> str:
    return f"http://localhost:{callback_port}{provider.callback_path}"


def _build_authorize_url(
    provider: ProviderOAuthConfig, *, verifier: str, state: str, redirect_uri: str
) -> str:
    challenge = pkce.generate_challenge(verifier)
    params: dict[str, str] = {
        "response_type": "code",
        "client_id": provider.client_id,
        "redirect_uri": redirect_uri,
        "scope": provider.scopes,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "state": state,
        **provider.extra_authorize_params,
    }
    return f"{provider.authorize_url}?{urlencode(params)}"


async def start_login(
    provider_id: str, *, options: Optional[dict[str, Any]] = None
) -> dict[str, Any]:
    """Begin a login flow. Replaces any prior flow for ``provider_id`` — a
    fresh call is an unambiguous restart signal.

    Raises ``OAuthProviderUnsupported``, ``ProviderRejected``, or ``NoCallbackPort``.
    """
    _validate_provider(provider_id)
    provider = get_provider(provider_id)

    async with _provider_locks[provider_id]:
        async with _registry_lock:
            existing = _flows.pop(provider_id, None)
        if existing is not None:
            await _teardown_flow(existing)

        if provider.flow_kind == "device":
            return await _start_device_login(provider_id, provider)

        verifier = pkce.generate_verifier()
        state = pkce.generate_state()
        callback_port, callback_holder = callback_server.start(provider.callback_port_range)

        redirect_uri = _build_redirect_uri(provider, callback_port)
        authorize_url = _build_authorize_url(
            provider, verifier=verifier, state=state, redirect_uri=redirect_uri
        )
        ctx = FlowContext(
            provider_id=provider_id,
            verifier=verifier,
            state=state,
            callback_port=callback_port,
            callback_holder=callback_holder,
            authorize_url=authorize_url,
        )
        async with _registry_lock:
            _flows[provider_id] = ctx
            ctx.task = asyncio.create_task(
                _await_callback_and_exchange(ctx, redirect_uri),
                name=f"oauth-exchange-{provider_id}",
            )

    logger.info(
        "config.change kind=oauth.flow action=start provider={} port={} expires_at={}",
        provider_id, callback_port, int(ctx.expires_at),
    )
    return {
        "authorize_url": authorize_url,
        "state": state,
        "callback_port": callback_port,
        "expires_at": int(ctx.expires_at),
    }


async def get_status(provider_id: str) -> dict[str, Any]:
    """Snapshot of the flow state (never returns token material)."""
    _validate_provider(provider_id)
    ctx = _flows.get(provider_id)
    if ctx is None:
        session = oauth_state.get(provider_id)
        if session is None:
            return {"status": "not_started"}
        return {
            "status": "complete",
            "account_hint": session.get("account_hint"),
            "expires_at": session.get("expires_at"),
            "scope": session.get("scope"),
        }
    body: dict[str, Any] = {"status": ctx.status, "expires_at": int(ctx.expires_at)}
    if ctx.error_code:
        body["error"] = {"code": ctx.error_code, "message": ctx.error_message or ""}
    if ctx.status == "complete":
        session = oauth_state.get(provider_id)
        if session is not None:
            body["account_hint"] = session.get("account_hint")
            body["scope"] = session.get("scope")
            # Report the persisted TOKEN expiry, not the flow's callback deadline
            # (started_at + FLOW_EXPIRY_SECONDS) which is already in the past once
            # the exchange completes -- otherwise clients treat a freshly
            # connected session as expired.
            if session.get("expires_at") is not None:
                body["expires_at"] = session.get("expires_at")
    return body


async def cancel(provider_id: str) -> None:
    """Cancel any in-flight flow. Idempotent; safe on 'no flow'."""
    _validate_provider(provider_id)
    async with _provider_locks[provider_id]:
        async with _registry_lock:
            ctx = _flows.pop(provider_id, None)
        if ctx is None:
            return
        await _teardown_flow(ctx)
    logger.info("config.change kind=oauth.flow action=cancel provider={}", provider_id)


async def _teardown_flow(ctx: "FlowContext | DeviceFlowContext") -> None:
    """Cancel a flow's background task and release its callback resources.
    Caller pops from ``_flows`` under the registry lock. Idempotent.
    """
    ctx.status = "cancelled"
    holder = getattr(ctx, "callback_holder", None)
    if holder is not None:
        try:
            holder["event"].set()
        except Exception:
            pass
    if ctx.task is not None and not ctx.task.done():
        ctx.task.cancel()
    await _stop_flow_resources(ctx)


async def _stop_flow_resources(ctx: "FlowContext | DeviceFlowContext") -> None:
    holder = getattr(ctx, "callback_holder", None)
    if holder is None:
        return
    try:
        await asyncio.to_thread(callback_server.stop, holder)
    except Exception:
        pass


async def _await_callback_and_exchange(ctx: FlowContext, redirect_uri: str) -> None:
    """Background task: wait for callback → validate → exchange → persist."""
    try:
        # Poll in short async sleeps so cancellation propagates immediately
        # (vs blocking a worker thread on event.wait for the full 10 min).
        signalled = False
        while time.time() < ctx.expires_at:
            if ctx.callback_holder["event"].is_set():
                signalled = True
                break
            await asyncio.sleep(0.25)
        if not signalled:
            ctx.status = "error"
            ctx.error_code = "callback_timeout"
            ctx.error_message = f"no callback received within {FLOW_EXPIRY_SECONDS}s"
            logger.warning("[OAuth] flow timed out provider={}", ctx.provider_id)
            return

        result = ctx.callback_holder.get("result")
        if not isinstance(result, tuple):
            ctx.status = "error"
            ctx.error_code = "callback_missing"
            ctx.error_message = "callback event set but no result recorded"
            return
        code, returned_state, error_param = result

        if error_param:
            ctx.status = "error"
            ctx.error_code = "user_cancelled" if error_param == "access_denied" else "callback_error"
            ctx.error_message = f"provider callback returned error={error_param}"
            logger.info("[OAuth] flow user-error provider={} error={}", ctx.provider_id, error_param)
            return
        if not code:
            ctx.status = "error"
            ctx.error_code = "callback_missing_code"
            ctx.error_message = "callback did not include ?code="
            return
        if returned_state != ctx.state:
            ctx.status = "error"
            ctx.error_code = "invalid_state"
            ctx.error_message = "callback state did not match; possible CSRF"
            logger.warning("[OAuth] flow state mismatch provider={}", ctx.provider_id)
            return

        ctx.status = "exchanging"
        try:
            token_payload = await _exchange_code(ctx, code=code, redirect_uri=redirect_uri)
        except ProviderRejected as exc:
            ctx.status = "error"
            ctx.error_code = "exchange_failed"
            ctx.error_message = f"provider returned http {exc.http_status}"
            logger.warning(
                "[OAuth] token exchange rejected provider={} http={}: {}",
                ctx.provider_id, exc.http_status, exc.detail,
            )
            return

        session = _build_session(ctx.provider_id, token_payload)
        oauth_state.put(ctx.provider_id, session)
        ctx.status = "complete"
        logger.info(
            "config.change kind=oauth.session action=create provider={} expires_at={}",
            ctx.provider_id, session.get("expires_at"),
        )
    except asyncio.CancelledError:
        ctx.status = "cancelled"
        raise
    except Exception as exc:
        ctx.status = "error"
        ctx.error_code = "internal_error"
        ctx.error_message = f"{type(exc).__name__}: {exc}"
        logger.exception("[OAuth] flow internal error provider={}", ctx.provider_id)
    finally:
        await _stop_flow_resources(ctx)


async def _exchange_code(ctx: FlowContext, *, code: str, redirect_uri: str) -> dict[str, Any]:
    """POST the authorization_code to the token endpoint. Raises ``ProviderRejected``."""
    provider = get_provider(ctx.provider_id)
    fields: dict[str, str] = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": redirect_uri,
        "client_id": provider.client_id,
        "code_verifier": ctx.verifier,
    }

    timeout = httpx.Timeout(connect=10.0, read=30.0, write=10.0, pool=10.0)
    async with build_async_client_for_url(provider.token_url, timeout=timeout) as client:
        if provider.exchange_content_type == "form":
            resp = await client.post(
                provider.token_url,
                data=fields,
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
        else:
            resp = await client.post(
                provider.token_url,
                json=fields,
                headers={"Content-Type": "application/json"},
            )

    if resp.status_code != 200:
        raise ProviderRejected(http_status=resp.status_code, detail=resp.text)
    try:
        payload = resp.json()
    except ValueError as exc:
        raise ProviderRejected(http_status=resp.status_code, detail=f"non-json body: {exc}") from exc
    if not isinstance(payload, dict) or "access_token" not in payload:
        raise ProviderRejected(http_status=resp.status_code, detail="response missing access_token")
    return payload


async def _start_device_login(
    provider_id: str, provider: ProviderOAuthConfig
) -> dict[str, Any]:
    """Request a device code, register the flow, launch the poll task.

    Runs inside ``_registry_lock`` (held by the caller) so the check-and-set on
    ``_flows`` stays atomic. Raises ``ProviderRejected`` if the device-code
    endpoint rejects the request.
    """
    timeout = httpx.Timeout(connect=10.0, read=30.0, write=10.0, pool=10.0)
    async with build_async_client_for_url(provider.device_code_url, timeout=timeout) as client:
        resp = await client.post(
            provider.device_code_url,
            data={"client_id": provider.client_id, "scope": provider.scopes},
            headers={"Accept": "application/json", "Content-Type": "application/x-www-form-urlencoded"},
        )
    if resp.status_code != 200:
        raise ProviderRejected(http_status=resp.status_code, detail=resp.text)
    try:
        payload = resp.json()
    except ValueError as exc:
        raise ProviderRejected(http_status=resp.status_code, detail=f"non-json body: {exc}") from exc
    device_code = payload.get("device_code")
    user_code = payload.get("user_code")
    verification_uri = payload.get("verification_uri") or payload.get("verification_url")
    if not device_code or not user_code or not verification_uri:
        raise ProviderRejected(
            http_status=resp.status_code, detail="device-code response missing required fields"
        )

    interval_raw = payload.get("interval")
    interval = interval_raw if isinstance(interval_raw, int) and interval_raw > 0 else COPILOT_POLL_MIN_INTERVAL
    interval = max(COPILOT_POLL_MIN_INTERVAL, min(interval, COPILOT_POLL_MAX_INTERVAL))
    expires_in = payload.get("expires_in")
    lifetime = expires_in if isinstance(expires_in, (int, float)) and expires_in > 0 else FLOW_EXPIRY_SECONDS
    expires_at = time.time() + float(lifetime)

    ctx = DeviceFlowContext(
        provider_id=provider_id,
        device_code=str(device_code),
        user_code=str(user_code),
        verification_uri=str(verification_uri),
        interval=interval,
        expires_at=expires_at,
    )
    _flows[provider_id] = ctx
    ctx.task = asyncio.create_task(
        _device_poll(ctx, provider), name=f"oauth-device-{provider_id}"
    )
    logger.info(
        "config.change kind=oauth.flow action=start provider={} flow=device expires_at={}",
        provider_id, int(expires_at),
    )
    return {
        "flow_kind": "device",
        "user_code": ctx.user_code,
        "verification_uri": ctx.verification_uri,
        "interval": ctx.interval,
        "expires_at": int(expires_at),
    }


async def _device_poll(ctx: DeviceFlowContext, provider: ProviderOAuthConfig) -> None:
    """Background task: poll the token endpoint until the user authorizes."""
    fields = {
        "client_id": provider.client_id,
        "device_code": ctx.device_code,
        "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
    }
    timeout = httpx.Timeout(connect=10.0, read=30.0, write=10.0, pool=10.0)
    try:
        while time.time() < ctx.expires_at:
            await asyncio.sleep(ctx.interval)
            try:
                async with build_async_client_for_url(provider.token_url, timeout=timeout) as client:
                    resp = await client.post(
                        provider.token_url,
                        data=fields,
                        headers={"Accept": "application/json", "Content-Type": "application/x-www-form-urlencoded"},
                    )
                payload = resp.json() if resp.content else {}
            except (httpx.HTTPError, ValueError) as exc:
                logger.warning("[OAuth] device poll transient error provider={}: {}", ctx.provider_id, exc)
                continue

            if isinstance(payload, dict) and payload.get("access_token"):
                session = _build_device_session(ctx.provider_id, payload)
                oauth_state.put(ctx.provider_id, session)
                ctx.status = "complete"
                logger.info(
                    "config.change kind=oauth.session action=create provider={} flow=device",
                    ctx.provider_id,
                )
                return

            error = payload.get("error") if isinstance(payload, dict) else None
            if error == "authorization_pending":
                continue
            if error == "slow_down":
                ctx.interval = min(ctx.interval + 5, COPILOT_POLL_MAX_INTERVAL)
                continue
            if error == "access_denied":
                ctx.status = "error"
                ctx.error_code = "user_cancelled"
                ctx.error_message = "user denied the device authorization"
                logger.info("[OAuth] device flow denied provider={}", ctx.provider_id)
                return
            if error == "expired_token":
                ctx.status = "error"
                ctx.error_code = "device_code_expired"
                ctx.error_message = "device code expired before authorization"
                return
            ctx.status = "error"
            ctx.error_code = "device_poll_error"
            ctx.error_message = f"unexpected device token response error={error}"
            logger.warning("[OAuth] device poll unexpected provider={} error={}", ctx.provider_id, error)
            return

        ctx.status = "error"
        ctx.error_code = "device_timeout"
        ctx.error_message = "no authorization received before device code expired"
    except asyncio.CancelledError:
        ctx.status = "cancelled"
        raise
    except Exception as exc:
        ctx.status = "error"
        ctx.error_code = "internal_error"
        ctx.error_message = f"{type(exc).__name__}: {exc}"
        logger.exception("[OAuth] device flow internal error provider={}", ctx.provider_id)


def _build_device_session(provider_id: str, token_payload: dict[str, Any]) -> dict[str, Any]:
    """Build the on-disk session for a device-grant token.

    The GitHub access token is long-lived and has no ``refresh_token`` /
    ``expires_in``; ``expires_at`` is left ``None`` so the readiness path never
    treats it as expired (freshness of the derived Copilot key is LiteLLM's job).
    """
    now = int(time.time())
    return {
        "schema_version": SCHEMA_VERSION,
        "provider": provider_id,
        "access_token": str(token_payload["access_token"]),
        "refresh_token": "",
        "id_token": "",
        "expires_at": None,
        "token_type": str(token_payload.get("token_type", "bearer")),
        "scope": str(token_payload.get("scope", "")),
        "account_hint": None,
        "stored_at": now,
    }


def _build_session(provider_id: str, token_payload: dict[str, Any]) -> dict[str, Any]:
    """Build the on-disk session dict from a token endpoint payload."""
    now = int(time.time())
    expires_in = token_payload.get("expires_in")
    if not isinstance(expires_in, (int, float)) or expires_in <= 0:
        expires_in = 3600
    session: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "provider": provider_id,
        "access_token": str(token_payload["access_token"]),
        "refresh_token": str(token_payload.get("refresh_token", "")),
        "id_token": str(token_payload.get("id_token", "")),
        "expires_at": now + int(expires_in),
        "token_type": str(token_payload.get("token_type", "Bearer")),
        "scope": str(token_payload.get("scope", "")),
        "account_hint": None,
        "stored_at": now,
    }
    id_token = token_payload.get("id_token")
    if isinstance(id_token, str):
        claims = _extract_openai_auth_claims(id_token)
        session["account_hint"] = claims.get("chatgpt_account_id")
    return session


def _extract_openai_auth_claims(id_token: str) -> dict[str, Any]:
    """Decode a JWT payload (no signature verify) and return the auth-namespace claims.

    Trust is transitive: this JWT arrived over TLS from the token endpoint we
    just called. We read only non-security-sensitive fields (account id).
    """
    try:
        _header, payload_b64, _sig = id_token.split(".", 2)
    except ValueError:
        return {}
    padding = "=" * (-len(payload_b64) % 4)
    try:
        payload = json.loads(base64.urlsafe_b64decode(payload_b64 + padding))
    except (ValueError, json.JSONDecodeError):
        return {}
    if not isinstance(payload, dict):
        return {}
    ns = payload.get(OPENAI_ID_TOKEN_AUTH_NAMESPACE)
    return ns if isinstance(ns, dict) else {}
