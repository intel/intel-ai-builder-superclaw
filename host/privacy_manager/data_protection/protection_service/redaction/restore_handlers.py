"""Restore handler implementations for file and text redaction payloads."""

from __future__ import annotations

import logging

from fastapi import HTTPException, status

from file_protection.restore import restore_text
from text_protection._restore import restore as restore_replacements

from common.errors import RestoreFailed
from protection_service.io.registry_delivery import validate_registry_placeholder_keys
from protection_service.sanitize_state import SanitizeManager
from protection_service.schemas import RestoreRequest, RestoreResponse

logger = logging.getLogger(__name__)


def restore_from_file_registry(req: RestoreRequest) -> RestoreResponse:
    """Restore text using a flat file-redaction placeholder registry.

    Args:
        req: Restore request with the ``registry`` payload populated.

    Returns:
        RestoreResponse: Restored text and replacement counts.

    Raises:
        HTTPException: If the registry is empty or has invalid placeholder keys.
    """
    if not req.registry:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "error": "empty_registry",
                "message": "registry must contain at least one placeholder mapping.",
            },
        )
    validate_registry_placeholder_keys(req.registry)
    result = restore_text(req.text, req.registry)
    logger.info(
        "data_protection endpoint=restore step=completed replacements=%s unmatched=%s",
        result.replacements, len(result.unmatched),
    )
    return RestoreResponse(
        final_text=result.text,
        replacements=result.replacements,
        unmatched_placeholders=list(result.unmatched),
    )


def restore_from_text_replacements(
    req: RestoreRequest,
    sanitize_mgr: SanitizeManager,
) -> RestoreResponse:
    """Restore text using rich text-redaction replacement records.

    Args:
        req: Restore request with the ``replacements`` payload populated.
        sanitize_mgr: Not consulted: restore needs only the replacement
            records, so it never waits for or loads the sanitizer models.

    Returns:
        RestoreResponse: Restored text and replacement counts.

    Raises:
        HTTPException: If replacements are empty or placeholder keys are invalid.
        RestoreFailed: If restoration fails.
    """
    if not req.replacements:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "error": "empty_replacements",
                "message": "replacements must contain at least one placeholder mapping.",
            },
        )
    validate_registry_placeholder_keys({k: "" for k in req.replacements})

    flat = (
        {k: v.redacted for k, v in req.replacements.items()}
        if req.mode == "redacted"
        else {k: v.original for k, v in req.replacements.items()}
    )
    restore_metadata = restore_text(req.text, flat)
    try:
        restored = restore_replacements(req.text, dict(req.replacements), mode=req.mode)
    except Exception as exc:
        raise RestoreFailed(f"Restoration failed: {exc.__class__.__name__}") from exc
    # The rich helper preserves nested sentence/token semantics but does not
    # report unknown placeholders. Keep the prior flat-fallback signal without
    # using its less-capable restored text.
    return RestoreResponse(
        final_text=restored,
        replacements=sum(1 for k in req.replacements if k in req.text),
        unmatched_placeholders=list(restore_metadata.unmatched),
    )
