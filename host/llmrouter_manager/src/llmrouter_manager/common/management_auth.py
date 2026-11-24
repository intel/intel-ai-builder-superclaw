"""Process-credential gate for LLM Router management routes.

Only ServiceHub holds this child's process credential. It attaches it when proxying an
App request that passed the hub token, and when its own adapters call LRM.
"""

from __future__ import annotations
import secrets

from loguru import logger
from starlette.datastructures import Headers
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

PROCESS_CREDENTIAL_HEADER = "X-SuperClaw-Process-Credential"
# servicehub.proxy.forwarder mirrors the tuple
MANAGEMENT_PREFIXES: tuple[str, ...] = (
    "/llm-router/v1/cloud/",
    "/llm-router/v1/capability/",
    "/llm-router/v1/edge/",
    "/llm-router/v1/telemetry/",
    "/llm-router/v1/oauth/",
)

# Sandbox roles read /mode over loopback without a credential (AGENTS.md's
# "Sandbox-reachable paths" table, confirm_file_protection.ts). privacy_manager's
# own settings fetch reads /hybrid-threshold the same way, unauthenticated
# (protect_routes.py fetch_file_protection_settings) -- gating it would make
# a configured threshold silently fall back to the 0.75 default with no error.
# Every other data-protection route -- including the PUTs that change these
# values -- is gated.
_DATA_PROTECTION_PREFIX = "/llm-router/v1/data-protection/"
_DATA_PROTECTION_OPEN_GET = frozenset({
    "/llm-router/v1/data-protection/mode",
    "/llm-router/v1/data-protection/hybrid-threshold",
})

# Control-plane routes whose GETs stay open (sandbox plugins read /local/ctx-size and channels read
# /usage/events over loopback; see AGENTS.md "Sandbox-reachable paths") but whose writes change
# host state - models, the serving engine, routing knobs, usage records - so a write needs the
# process credential (#3665). servicehub.proxy.forwarder mirrors the tuple.
MUTATION_GATED_PREFIXES: tuple[str, ...] = (
    "/llm-router/v1/local",
    "/llm-router/v1/perf-weight",
    "/llm-router/v1/models",
    "/llm-router/v1/model-selections",
    "/llm-router/v1/inference-servers",
    "/llm-router/v1/usage",
    "/llm-router/v1/operations",
)
_READ_METHODS = frozenset({"GET", "HEAD"})


def _under(path: str, prefix: str) -> bool:
    return path == prefix or path.startswith(prefix + "/")


def is_management_path(path: str, method: str) -> bool:
    if path.startswith(_DATA_PROTECTION_PREFIX) or path == _DATA_PROTECTION_PREFIX.rstrip("/"):
        return not (method == "GET" and path in _DATA_PROTECTION_OPEN_GET)
    if method not in _READ_METHODS and any(_under(path, prefix) for prefix in MUTATION_GATED_PREFIXES):
        return True
    return any(
        path.startswith(prefix) or path == prefix.rstrip("/")
        for prefix in MANAGEMENT_PREFIXES
    )

class ManagementAuthMiddleware:
    def __init__(self, app: ASGIApp, *, process_credential: str) -> None:
        self._app = app
        self._process_credential = process_credential

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None: 
        if (
            scope["type"] != "http"
            or scope["method"] == "OPTIONS"
            or not is_management_path(scope["path"], scope["method"])
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
                        "message": "This route is available only through ServiceHub."
                    }
                },
            )
            await response(scope, receive, send)
            return
        await self._app(scope, receive, send)