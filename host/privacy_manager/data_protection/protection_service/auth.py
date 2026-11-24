"""Bearer authentication for the Privacy Manager data plane."""

from __future__ import annotations

import secrets
from typing import Callable

from fastapi import HTTPException, Request, status

from protection_service.config import AppConfig


AuthDependency = Callable[[Request], None]


def make_auth_dependency(
    config: AppConfig, data_plane_key: str | None = None
) -> AuthDependency:
    """Return the configured bearer check, or a no-op for legacy app construction."""

    expected_token = data_plane_key or config.auth.token
    if not expected_token:
        # No-op dependency when auth is disabled.
        def _noop(_request: Request) -> None:
            return None

        return _noop

    def _check(request: Request) -> None:
        header = request.headers.get("authorization", "")
        scheme, _, token = header.partition(" ")
        if scheme.lower() != "bearer" or not token:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail={"error": "unauthorized", "message": "Bearer token required."},
                headers={"WWW-Authenticate": "Bearer"},
            )
        if not secrets.compare_digest(token, expected_token):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail={"error": "unauthorized", "message": "Invalid token."},
                headers={"WWW-Authenticate": "Bearer"},
            )

    return _check
