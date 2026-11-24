"""Every route but health answers only ServiceHub (#16 decision 1, #3665 default-deny).

ServiceHub sends ``X-SuperClaw-Forwarded-Credential`` with every request it forwards: HMAC-SHA256
keyed with the process credential it gave this instance, over the label
``shared/contracts/src/servicehub-forwarding.ts`` owns. Its own direct calls to the internal routes
carry ``X-SuperClaw-Process-Credential`` instead. The middleware refuses a request - over HTTP or a
websocket - that carries neither value exactly, before routing, so no handler runs for a request
that reached this port directly - which a sandbox tier can do until the loopback block is on, and
which any other local user can do now. Only the liveness probe in ``_OPEN_PATHS`` is exempt.
Without a process credential, as when the Sandbox Manager runs on its own, every guarded request is
refused. The forwarded value is derived so that a forwarded request carries nothing that opens a
route checking the process credential itself. Neither value is ever logged.
"""

from __future__ import annotations

import hashlib
import hmac

from contracts.sandbox_manager_host_api_data import SANDBOX_MANAGER_HOST_API_RULES
from loguru import logger
from starlette._utils import get_route_path
from starlette.responses import Response
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .process_auth import PROCESS_CREDENTIAL_HEADER
from .v1._host_api import NO_STORE_HEADERS, refusal

_HEADER = SANDBOX_MANAGER_HOST_API_RULES["forwarded_credential_header"].lower().encode("ascii")
_PROCESS_HEADER = PROCESS_CREDENTIAL_HEADER.lower().encode("ascii")
_LABEL = SANDBOX_MANAGER_HOST_API_RULES["forwarded_credential_label"].encode()
_GUARDED_SCOPES = ("http", "websocket")
_POLICY_VIOLATION = 1008
# ServiceHub's watchdog and readiness probe call it directly, with no credential. The root
# ``/health`` is not exempt: it lists model-server and sandbox pids.
_OPEN_PATHS = frozenset({"/sandbox-manager/v1/health"})


def forwarded_credential(process_credential: str) -> str:
    """The value ServiceHub forwards to the instance it gave ``process_credential``."""
    return hmac.new(process_credential.encode(), _LABEL, hashlib.sha256).hexdigest()


class ForwardedCredentialMiddleware:
    """Answer every route but health with 401 unless the request came from ServiceHub."""

    def __init__(self, app: ASGIApp, *, process_credential: str) -> None:
        self._app = app
        self._expected = (
            forwarded_credential(process_credential).encode() if process_credential else None
        )
        self._process = process_credential.encode() if process_credential else None

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if self._must_refuse(scope):
            if scope["type"] == "websocket":
                await send({"type": "websocket.close", "code": _POLICY_VIOLATION})
            else:
                await refusal("servicehub_forwarding_required")(scope, receive, send)
            return
        if scope["type"] == "http" and _is_guarded(get_route_path(scope)):
            await self._serve_uncached(scope, receive, send)
            return
        await self._app(scope, receive, send)

    async def _serve_uncached(self, scope: Scope, receive: Receive, send: Send) -> None:
        """Serve a host API request so that no answer from it, a 405 or a 500 included, is cached."""
        started = False

        async def send_uncached(message: Message) -> None:
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
                headers = [
                    (name, value)
                    for name, value in message.get("headers", [])
                    if name.lower() != b"cache-control"
                ]
                headers.append((b"cache-control", b"no-store"))
                message = {**message, "headers": headers}
            await send(message)

        try:
            await self._app(scope, receive, send_uncached)
        except Exception as exc:
            # Only the type is logged: a message could carry what a request held.
            logger.error("host API handler failed error={}", type(exc).__name__)
            if started:
                raise
            await Response(status_code=500, headers=NO_STORE_HEADERS)(scope, receive, send)

    def _must_refuse(self, scope: Scope) -> bool:
        # The router matches on the path under root_path, so the guard reads the same one.
        return (
            scope["type"] in _GUARDED_SCOPES
            and _is_guarded(get_route_path(scope))
            and not self._forwarded(scope)
        )

    def _forwarded(self, scope: Scope) -> bool:
        return _exactly_one(scope, _HEADER, self._expected) or _exactly_one(
            scope, _PROCESS_HEADER, self._process
        )


def _exactly_one(scope: Scope, header: bytes, expected: bytes | None) -> bool:
    supplied = [value for name, value in scope["headers"] if name == header]
    return (
        expected is not None
        and len(supplied) == 1
        and hmac.compare_digest(supplied[0], expected)
    )


def _is_guarded(path: str) -> bool:
    return path not in _OPEN_PATHS
