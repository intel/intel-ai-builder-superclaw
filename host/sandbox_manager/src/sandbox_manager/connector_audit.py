"""What the Connector writes into its audit (design 6.2): one line per request it serves or refuses.

The writer is `egress_audit.AuditLog`, shared with the egress proxy; this is the Connector's record.
Standard library only: it ships in the Connector's payload.
"""

from __future__ import annotations

from datetime import datetime, timezone
import time
from typing import Any
from urllib.parse import urlsplit


def audit_record(
    *,
    received: float,
    started: float,
    http_status: int,
    request_bytes: int | None,
    request: dict[str, Any] | None = None,
    response: dict[str, Any] | None = None,
    response_bytes: int | None = None,
    approval_id: str | None = None,
    reason: str | None = None,
    admitted_by: str | None = None,
) -> dict[str, Any]:
    """One audit line. Never the query, a result, a failure message or any key material.

    `request` and `response` are given only for a request that authenticated; a rejected request's
    claims about itself are recorded as nothing rather than as fact.
    """
    body = response["body"] if response is not None else {}
    error = body.get("error")
    return {
        "time": datetime.fromtimestamp(received, timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z"),
        "request_id": request["request_id"] if request is not None else None,
        "operation": request["operation"] if request is not None else None,
        "result": "rejected" if response is None else error["code"] if error else "ok",
        "http_status": http_status,
        # The search module picks its provider's endpoints, and DDGS fans one query out across several
        # engines, so a search has no single host the Connector saw; `provider` says where it went. A
        # fetch is recorded by the host it named, never by its path or query.
        "target_host": _audited_host(request),
        "request_bytes": request_bytes,
        "response_bytes": response_bytes,
        "elapsed_ms": round((time.monotonic() - started) * 1000),
        "approval_id": approval_id,
        # Why an approval was not asked for or not held (approval_required, a remembered denial, no time left).
        "reason": reason,
        "provider": body.get("provider"),
        # What let a fetch_result through: `search_result`, `approval` (once) or `all_for_chat` (its chat's
        # grant, or the grant that released it); null for a request that was not let through.
        "admitted_by": admitted_by,
    }


def _audited_host(request: dict[str, Any] | None) -> str | None:
    if request is None:
        return None
    if request["operation"] == "fetch_result":
        # A URL such as `https://[invalid]/` passes the request shape and is refused, but
        # `hostname` raises on it. The refusal must still be answered and audited.
        try:
            return urlsplit(request["body"]["url"]).hostname
        except ValueError:
            return None
    return None
