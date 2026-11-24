"""Standard error response helpers."""

from __future__ import annotations

from fastapi import HTTPException, status


def error_body(code: str, message: str) -> dict[str, dict[str, str]]:
    return {"error": {"code": code, "message": message}}


def auth_error(code: str, message: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=error_body(code, message),
        headers={"WWW-Authenticate": "Bearer"},
    )
