"""The management plane answers only requests ServiceHub forwarded.

ServiceHub sends ``X-SuperClaw-Forwarded-Credential`` with every request it forwards: HMAC-SHA256 keyed
with the process credential it gave this instance, over the label ``servicehub-forwarding.ts`` owns.
The middleware refuses every ``/mcp-host/v1/*`` request, over HTTP or a websocket, that does not carry
exactly that value, before routing. The exceptions are ``health`` and ``summary`` (counts and booleans
only, read by the Sandbox Manager) and ``shutdown``, which ServiceHub calls directly with the process
credential itself and which checks that credential in its handler. Without a process credential, as
in a standalone run, every guarded request is refused. Neither value is ever logged.

The data plane (``/mcp-host/mcp/*``, ``/mcp-host/cdp/*``) is not under ``/v1`` and is authenticated by
its own tokens, so a tier process can reach it and nothing else.
"""

from __future__ import annotations

import hashlib
import hmac

from starlette._utils import get_route_path
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .errors import RULES, refusal

PROCESS_CREDENTIAL_HEADER = "X-SuperClaw-Process-Credential"
_HEADER = RULES["forwarded_credential_header"].lower().encode("ascii")
_LABEL = RULES["forwarded_credential_label"].encode()
_PREFIX = RULES["proxy_prefix"] + "/v1"
_OPEN_PATHS = frozenset([*RULES["unguarded_paths"], _PREFIX + "/shutdown"])
_POLICY_VIOLATION = 1008


def forwarded_credential(process_credential: str) -> str:
    """The value ServiceHub forwards to the instance it gave ``process_credential``."""
    return hmac.new(process_credential.encode(), _LABEL, hashlib.sha256).hexdigest()


class ForwardedCredentialMiddleware:
    def __init__(self, app: ASGIApp, *, process_credential: str) -> None:
        self._app = app
        self._expected = (
            forwarded_credential(process_credential).encode() if process_credential else None
        )

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in ("http", "websocket") or not _is_guarded(get_route_path(scope)):
            await self._app(scope, receive, send)
            return
        if not self._forwarded(scope):
            if scope["type"] == "websocket":
                await send({"type": "websocket.close", "code": _POLICY_VIOLATION})
            else:
                await refusal("servicehub_forwarding_required")(scope, receive, send)
            return
        if scope["type"] != "http":
            await self._app(scope, receive, send)
            return

        async def send_uncached(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = [
                    (name, value)
                    for name, value in message.get("headers", [])
                    if name.lower() != b"cache-control"
                ]
                headers.append((b"cache-control", b"no-store"))
                message = {**message, "headers": headers}
            await send(message)

        await self._app(scope, receive, send_uncached)

    def _forwarded(self, scope: Scope) -> bool:
        supplied = [value for name, value in scope["headers"] if name == _HEADER]
        return (
            self._expected is not None
            and len(supplied) == 1
            and hmac.compare_digest(supplied[0], self._expected)
        )


def _is_guarded(path: str) -> bool:
    return (path == _PREFIX or path.startswith(_PREFIX + "/")) and path not in _OPEN_PATHS
