"""The one error envelope this service emits, with the contract's status and fixed sentence per code.

ServiceHub's ``normalize_upstream_error`` passes ``{"error": {"code", "message"}}`` through and replaces
any other error body, FastAPI's own 422 included, with ``upstream_error``.
"""

from __future__ import annotations

from typing import Any

from contracts.host_mcp_api_data import HOST_MCP_ERRORS, HOST_MCP_RULES
from fastapi.responses import JSONResponse

RULES: dict[str, Any] = HOST_MCP_RULES
NO_STORE_HEADERS = {"Cache-Control": "no-store"}


def error_body(code: str) -> dict[str, dict[str, str]]:
    return {"error": {"code": code, "message": HOST_MCP_ERRORS[code]["message"]}}


def refusal(code: str) -> JSONResponse:
    return JSONResponse(
        status_code=HOST_MCP_ERRORS[code]["status"],
        content=error_body(code),
        headers=NO_STORE_HEADERS,
    )
