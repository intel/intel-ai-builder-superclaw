"""Restore endpoint registration."""

from __future__ import annotations

from fastapi import Depends, FastAPI, HTTPException
from fastapi.concurrency import run_in_threadpool

from protection_service.app_state import ProtectionAppState
from protection_service.redaction.restore_handlers import (
    restore_from_file_registry,
    restore_from_text_replacements,
)
from protection_service.schemas import RestoreRequest, RestoreResponse


def register_restore_routes(app: FastAPI, state: ProtectionAppState) -> None:
    """Register the ``/v1/restore`` endpoint.

    Args:
        app: FastAPI application instance.
        state: App-scoped state.
    """
    sanitize_mgr = state.sanitize_mgr
    auth_dep = state.auth_dep

    @app.post(
        "/v1/restore",
        response_model=RestoreResponse,
        dependencies=[Depends(auth_dep)],
        tags=["restore"],
    )
    async def restore(req: RestoreRequest) -> RestoreResponse:
        """Restore placeholders using either file or text redaction payloads.

        Exactly one of ``registry`` (file redaction) or ``replacements``
        (text redaction) must be supplied; providing both or neither returns
        HTTP 400.

        Args:
            req: Restore request with exactly one payload type.

        Returns:
            RestoreResponse: Restored text and replacement counts.

        Raises:
            HTTPException: If both or neither restore payloads are provided.
        """
        # File registries and text replacements use independent placeholder
        # counters — merging them can restore wrong values.
        if req.replacements is not None and req.registry is not None:
            raise HTTPException(
                status_code=400,
                detail={
                    "error": "conflicting_payload",
                    "message": (
                        "Provide either 'registry' (from /v1/file/redact) OR "
                        "'replacements' (from /v1/text/redact), not both. "
                        "The two payloads use independent placeholder "
                        "numbering; merging them can restore wrong values."
                    ),
                },
            )
        if req.replacements is not None:
            return await run_in_threadpool(restore_from_text_replacements, req, sanitize_mgr)
        if req.registry is not None:
            return await run_in_threadpool(restore_from_file_registry, req)
        raise HTTPException(
            status_code=400,
            detail={
                "error": "missing_payload",
                "message": (
                    "Provide either 'registry' (from /v1/file/redact) or "
                    "'replacements' (from /v1/text/redact)."
                ),
            },
        )
