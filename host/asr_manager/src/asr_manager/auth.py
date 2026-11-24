"""Process-credential gate for every asr_manager route.

Only ServiceHub holds this child's process credential. It attaches it when proxying an App
request that passed the hub token, so a request that reached this port directly (any local
process) is refused before routing. `/health`, `/version` and CORS preflight stay open: the
hub's readiness and watchdog probes call them without a credential.
"""

from __future__ import annotations

import secrets

from loguru import logger
from starlette.datastructures import Headers
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

PROCESS_CREDENTIAL_HEADER = "X-SuperClaw-Process-Credential"
# servicehub.proxy.forwarder mirrors this prefix and the open paths
PREFIX = "/speech-to-text/v1/"
OPEN_PATHS: frozenset[str] = frozenset({PREFIX + "health", PREFIX + "version"})


class ManagementAuthMiddleware:
    def __init__(self, app: ASGIApp, *, process_credential: str) -> None:
        self._app = app
        self._process_credential = process_credential

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if (
            scope["type"] != "http"
            or scope["method"] == "OPTIONS"
            or (scope["method"] == "GET" and scope["path"] in OPEN_PATHS)
        ):
            await self._app(scope, receive, send)
            return
        supplied = Headers(scope=scope).get(PROCESS_CREDENTIAL_HEADER, "")
        # unset expected credential (standalone run) must deny, not match an empty header
        if not self._process_credential or not secrets.compare_digest(
            self._process_credential.encode(), supplied.encode()
        ):
            client = scope.get("client")
            logger.warning(
                "management auth rejected method={} path={} client={}",
                scope["method"],
                scope["path"],
                client[0] if client else "",
            )
            response = JSONResponse(
                status_code=401,
                content={
                    "error": {
                        "code": "management_credential_required",
                        "message": "This route is available only through ServiceHub.",
                    }
                },
            )
            await response(scope, receive, send)
            return
        await self._app(scope, receive, send)
