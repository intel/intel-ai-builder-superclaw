"""Session scoping and operation ID utilities."""

from __future__ import annotations

import hashlib
import uuid

from fastapi import Request

from protection_service.config import AppConfig


def new_operation_id() -> str:
    """Create a short operation id for correlated log lines.

    Returns:
        str: A 12-character hexadecimal operation id.
    """
    return uuid.uuid4().hex[:12]


def scope_session_id(
    client_session_id: str | None,
    config: AppConfig,
    http_req: Request,
) -> str | None:
    """Namespace a caller session id by the authenticated principal.

    Prevents session id collisions when multiple authenticated callers use the
    same session id string. When auth is disabled the original id is returned
    unchanged.

    Args:
        client_session_id: Caller-provided session id.
        config: Service configuration with auth settings.
        http_req: HTTP request carrying the bearer token.

    Returns:
        str | None: Scoped session id, original id when auth is disabled, or None.
    """
    if client_session_id is None:
        return None
    if not config.auth.enabled:
        return client_session_id
    header = http_req.headers.get("authorization", "")
    _, _, token = header.partition(" ")
    if not token:
        # auth_dep would have already rejected this request; defensive fallback.
        return client_session_id
    # Short token hash is enough to isolate per-principal session ids.
    prefix = hashlib.sha256(token.encode("utf-8")).hexdigest()[:10]
    return f"p{prefix}:{client_session_id}"
