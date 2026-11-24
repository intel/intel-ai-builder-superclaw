"""Standard error response helpers (api.md "Response conventions").

All API error bodies use the shape::

    {
      "error": {
        "code": "model_not_found",
        "message": "Model 'abc' is not in the registry.",
        "details": {},                 # optional
        "retry_after_seconds": 5       # optional
      }
    }

`code` is a stable machine-readable string the UI dispatches on; `message`
is safe to display to the end user. `details` and `retry_after_seconds`
are optional and only emitted when supplied by the caller.

Two entry points:

* :func:`api_error` builds the JSON body without raising — useful for
  `JSONResponse(...)` returns or unit-test assertions.
* :func:`http_error` raises ``HTTPException`` with the standard body in
  ``detail``. FastAPI renders ``HTTPException.detail`` as the response
  body verbatim, so callers can do::

      raise http_error(404, "model_not_found", "Model 'abc' is not in the registry.")

  and the wire response is exactly the documented shape.

Phase-1 scope: this module is added now so v1 routers (Phase 2) and the
`/sandbox/owt-token` 503 case (1.3 in the plan) can adopt it incrementally.
Legacy routes that still use bare ``HTTPException(status, "string")`` are
migrated in this same Phase 1 task.
"""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException


__all__ = ["api_error", "http_error"]


def api_error(
    code: str,
    message: str,
    *,
    details: dict[str, Any] | None = None,
    retry_after_seconds: int | None = None,
) -> dict[str, Any]:
    """Build the standard error JSON body (without raising).

    Optional fields are omitted from the output (never serialized as
    ``null``) so consumers can rely on field presence as a signal.
    """
    body: dict[str, Any] = {"code": code, "message": message}
    if details is not None:
        body["details"] = details
    if retry_after_seconds is not None:
        body["retry_after_seconds"] = retry_after_seconds
    return {"error": body}


def http_error(
    status_code: int,
    code: str,
    message: str,
    *,
    details: dict[str, Any] | None = None,
    retry_after_seconds: int | None = None,
    headers: dict[str, str] | None = None,
) -> HTTPException:
    """Build an ``HTTPException`` whose ``detail`` is the standard error body.

    FastAPI serializes ``HTTPException.detail`` as the response body, so
    raising the returned exception produces the exact shape documented in
    api.md. When ``retry_after_seconds`` is set, a matching ``Retry-After``
    header is added automatically (HTTP-standard signalling) in addition
    to the in-body field, unless ``headers`` already contains it.
    """
    detail = api_error(
        code,
        message,
        details=details,
        retry_after_seconds=retry_after_seconds,
    )
    final_headers: dict[str, str] | None = headers
    if retry_after_seconds is not None:
        final_headers = dict(headers or {})
        final_headers.setdefault("Retry-After", str(retry_after_seconds))
    return HTTPException(
        status_code=status_code,
        detail=detail,
        headers=final_headers,
    )
