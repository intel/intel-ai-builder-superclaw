"""Process-scoped authentication for ServiceHub-owned control operations."""

from __future__ import annotations

import secrets

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse


PROCESS_CREDENTIAL_HEADER = "X-SuperClaw-Process-Credential"


class ManagedPublicMutationRejected(Exception):
    """Raised before managed public lifecycle mutations can cause side effects."""


async def managed_public_mutation_rejected(
    _request: Request,
    _exc: Exception,
) -> JSONResponse:
    return JSONResponse(
        status_code=409,
        content={
            "error": {
                "code": "restricted_lifecycle_required",
                "message": (
                    "This operation is available only through the ServiceHub control plane."
                ),
            }
        },
    )


def require_process_credential(request: Request) -> None:
    expected = getattr(request.app.state, "process_credential", "")
    supplied = request.headers.get(PROCESS_CREDENTIAL_HEADER, "")
    if not expected or not secrets.compare_digest(expected, supplied):
        raise HTTPException(status_code=403, detail="process_credential_forbidden")


def reject_managed_public_mutation(request: Request) -> None:
    config = getattr(request.app.state, "config", None)
    if getattr(config, "managed", False):
        raise ManagedPublicMutationRejected
