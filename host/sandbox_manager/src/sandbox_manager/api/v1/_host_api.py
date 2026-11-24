"""Refusals shared by the host API routes the app reaches through ServiceHub (#12, #16).

``shared/contracts/src/sandbox-manager-host-api.ts`` owns these shapes. A refusal is the contract's
``{"error": {"code", "message"}}`` with the status and the fixed message its table gives the code:
ServiceHub's ``normalize_upstream_error`` passes that shape through and replaces any other error
body, FastAPI's own 422 included, with ``upstream_error``. The message never carries what was sent.
"""

from __future__ import annotations

from contracts.sandbox_manager_host_api_data import SANDBOX_MANAGER_HOST_API_RULES
from fastapi import Request
from fastapi.responses import JSONResponse

_ERRORS = SANDBOX_MANAGER_HOST_API_RULES["errors"]
# An answer about a secret or an approval is never kept by a cache.
NO_STORE_HEADERS = {"Cache-Control": "no-store"}


def refusal(code: str, **detail: str | None) -> JSONResponse:
    """The contract's refusal for ``code``, with any ``detail`` the contract names for it that is set."""
    error = _ERRORS[code]
    named = {key: value for key, value in detail.items() if value is not None}
    return JSONResponse(
        status_code=error["status"],
        content={"error": {"code": code, "message": error["message"], **named}},
        headers=NO_STORE_HEADERS,
    )


async def bounded_body(request: Request, limit: int) -> bytes | None:
    """The request body, or None if it is larger than ``limit`` bytes (never read past it)."""
    declared = request.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > limit:
        return None
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > limit:
            return None
        chunks.append(chunk)
    return b"".join(chunks)
