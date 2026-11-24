"""Standard error envelope for llmrouter_manager.

Canonical shape per backend API design (`docs/design/
2026-06-30_backend_refactor_api_design.md` §Error envelope):

    {"error": {"code": "<machine_code>", "message": "<human_text>", "details": {...}?}}

ServiceHub's proxy normalizer (`servicehub.proxy.error_normalizer`) forwards
an upstream error verbatim ONLY when `error` is an object with string `code`
and `message`; otherwise it collapses the body to a generic `upstream_error`,
discarding the service's own diagnostics. Routing every error through
`error_response` keeps the whole service on that shape so control-plane errors
survive the proxy and data-plane errors stay consistent with them.
"""

from __future__ import annotations

from typing import Any

from fastapi.responses import JSONResponse


def error_body(
    code: str, message: str, *, details: dict[str, Any] | None = None
) -> dict[str, Any]:
    """Build the `{"error": {...}}` envelope dict.

    `details` is included only when non-empty so simple errors stay terse.
    """
    error: dict[str, Any] = {"code": code, "message": message}
    if details:
        error["details"] = details
    return {"error": error}


def error_response(
    code: str,
    message: str,
    *,
    status_code: int,
    details: dict[str, Any] | None = None,
    extra: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
) -> JSONResponse:
    """Return a `JSONResponse` carrying the standard error envelope.

    `extra` merges sibling keys alongside `error` for the few composite
    responses that also carry status flags (e.g. `{"ok": false, ...}` /
    `{"status": "error", ...}`); it never overwrites the `error` key.
    """
    body = error_body(code, message, details=details)
    if extra:
        body = {**extra, **body}
    return JSONResponse(body, status_code=status_code, headers=headers)
