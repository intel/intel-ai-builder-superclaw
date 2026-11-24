"""Bearer-token authentication for ServiceHub control-plane routes."""

from __future__ import annotations

import hmac
import re
from typing import Any

import httpx
from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from loguru import logger

from servicehub.common.errors import auth_error


_bearer = HTTPBearer(auto_error=False)
_WHITELIST_EXACT = frozenset({"/health", "/version"})
# A service's own probe: one prefix segment, then /v1/health or /v1/version. A longer path that
# merely ends that way is a path inside the service, and needs the token.
_WHITELIST_SERVICE_PROBE = re.compile(r"/[^/]+/v1/(?:health|version)")


def _request_audit_fields(request: Request) -> dict[str, Any]:
    client = request.client
    return {
        "method": request.method,
        "path": request.url.path,
        "client": client.host if client is not None else "unknown",
    }


def is_whitelisted(path: str) -> bool:
    # Test the path the child will be asked for: httpx collapses dot segments, so a path that
    # spells ".../x%2F..%2Fv1/health" is not a probe to the child (same rule as
    # servicehub.proxy.forwarder.normalized_upstream_path).
    path = httpx.URL(f"http://service.invalid{path}").path
    return path in _WHITELIST_EXACT or _WHITELIST_SERVICE_PROBE.fullmatch(path) is not None


async def require_hub_token(
    request: Request,
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> None:
    if is_whitelisted(request.url.path):
        return

    if request.url.path == "/app/events" and "ticket" in request.query_params:
        return

    if creds is None or creds.scheme.lower() != "bearer":
        fields = _request_audit_fields(request)
        logger.warning(
            "auth failure code=missing_bearer_token method={} path={} client={}",
            fields["method"],
            fields["path"],
            fields["client"],
        )
        raise auth_error("missing_bearer_token", "Missing bearer token")

    expected: str = request.app.state.config.hub_token
    if not hmac.compare_digest(creds.credentials, expected):
        fields = _request_audit_fields(request)
        logger.warning(
            "auth failure code=invalid_bearer_token method={} path={} client={}",
            fields["method"],
            fields["path"],
            fields["client"],
        )
        raise auth_error("invalid_bearer_token", "Invalid bearer token")


async def require_hub_token_for_request(request: Request) -> None:
    await require_hub_token(request, await _bearer(request))
