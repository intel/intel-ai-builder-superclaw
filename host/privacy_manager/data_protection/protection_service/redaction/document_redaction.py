"""Free-form document (TXT/MD/HTML/DOCX) redaction worker."""

from __future__ import annotations

import logging
import shutil
import tempfile
from pathlib import Path

from fastapi import HTTPException, status

from file_protection.documents import is_binary_document, mask_document
from file_protection.registry import invert_registry
from file_protection.rewrite import rewrite_query

from protection_service.config import AppConfig
from protection_service.constants import RECOMMENDED_SYSTEM_PROMPT
from protection_service.io.registry_delivery import deliver_redaction_registry
from protection_service.io.session_utils import new_operation_id
from protection_service.io.workspace_paths import (
    build_workspace_masked_output_path,
    summarize_source_for_logs,
)
from protection_service.redacts_store import RedactsStore
from protection_service.sanitize_state import SanitizeManager
from protection_service.schemas import RedactRequest, RedactResponse
from protection_service.redaction.column_detection import resolve_document_span_provider

logger = logging.getLogger(__name__)


def redact_document_file_sync(
    source: Path,
    req: RedactRequest,
    config: AppConfig,
    redacts_store: RedactsStore,
    sanitize_mgr: SanitizeManager,
    *,
    operation_id: str | None = None,
) -> RedactResponse:
    """Redact PII from a free-form document (TXT/MD/HTML/DOCX).

    Uses the sub-cell free-text engine (regex spans + optional NER span
    provider) and emits the same flat ``{placeholder: original}`` registry as
    the tabular pipeline so ``/v1/restore`` works identically for documents.

    Column-oriented request fields (``sensitive_columns``, ``auto_pii``,
    ``columns``, ``filter_*``, ``sheet``, ``bucketize_financial``,
    ``scan_free_text``) do not apply to prose and are ignored.

    ``.docx`` is a binary container and is only available with
    ``return_mode="path"``; an inline request for a binary document returns
    HTTP 400.

    Args:
        source: Validated document source file path.
        req: Redaction options (only free-text span options apply).
        config: Service configuration.
        redacts_store: Store for file-backed registry files.
        sanitize_mgr: Sanitizer state and model provider.
        operation_id: Existing operation id, or None to create one.

    Returns:
        RedactResponse: Masked document output and registry details.

    Raises:
        HTTPException: 400 for binary inline requests, 413 for oversized inline
            output, 500 for unexpected masking errors.
    """
    operation_id = operation_id or new_operation_id()
    binary = is_binary_document(source)
    source_ext, source_size, workspace_path = summarize_source_for_logs(source)
    logger.info(
        "data_protection operation_id=%s endpoint=file.redact step=document_started "
        "source_ext=%s source_size_bytes=%s workspace_path=%s binary=%s return_mode=%s",
        operation_id, source_ext, source_size, workspace_path, binary, req.return_mode,
    )

    if req.return_mode == "inline" and binary:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "error": "binary_document_requires_path",
                "message": (
                    f"{source.suffix} is a binary document and cannot be returned "
                    "inline. Set 'return_mode': 'path'."
                ),
            },
        )

    span_provider = resolve_document_span_provider(req.free_text_use_ner, config, sanitize_mgr)

    with tempfile.TemporaryDirectory(prefix="pii_doc_") as workspace:
        dest = Path(workspace) / f"masked{source.suffix.lower()}"
        try:
            result = mask_document(
                source, dest,
                span_provider=span_provider,
                phone_anchor_boost=config.sanitize.redact_phone_anchor_boost,
            )
        except Exception as exc:
            logger.warning(
                "data_protection operation_id=%s endpoint=file.redact "
                "step=document_mask_failed exc_type=%s",
                operation_id, exc.__class__.__name__,
            )
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail={"error": "mask_failed", "message": str(exc)},
            ) from exc

        registry = result.registry

        rewritten: str | None = None
        substitutions = 0
        if req.query:
            inverted = invert_registry(registry)
            rewrite = rewrite_query(req.query, registry, inverted=inverted)
            rewritten = rewrite.rewritten
            substitutions = rewrite.substitutions

        registry_inline, registry_path, registry_expires_at = deliver_redaction_registry(
            registry, req, config, redacts_store
        )
        logger.info(
            "data_protection operation_id=%s endpoint=file.redact step=document_mask_completed "
            "segments_masked=%s registry_entries=%s registry_delivery=%s expires_at=%s",
            operation_id, result.segments_masked, len(registry),
            "path" if registry_path else "inline", registry_expires_at,
        )

        masked_size = result.masked_file.stat().st_size

        if req.return_mode == "inline":
            if masked_size > config.redact.max_inline_bytes:
                raise HTTPException(
                    status_code=413,
                    detail={
                        "error": "masked_too_large",
                        "message": (
                            f"Masked document is {masked_size:,} bytes, above the inline "
                            f"cap of {config.redact.max_inline_bytes:,}. "
                            "Set 'return_mode': 'path'."
                        ),
                        "size_bytes": masked_size,
                        "cap_bytes": config.redact.max_inline_bytes,
                    },
                )
            return RedactResponse(
                masked_csv=result.masked_file.read_text(encoding="utf-8"),
                masked_file_path=None,
                expires_at=None, ttl_seconds=None,
                registry=registry_inline,
                registry_file_path=registry_path,
                registry_expires_at=registry_expires_at,
                rewritten_query=rewritten,
                substitutions=substitutions,
                columns_masked=[], extra_pii_found=[],
                safety_net_columns={}, free_text_columns=[],
                rows_extracted=result.segments_masked,
                rows_masked=result.segments_masked,
                recommended_system_prompt=RECOMMENDED_SYSTEM_PROMPT,
            )

        dest, container_path = build_workspace_masked_output_path(
            source, result.masked_file.suffix
        )
        shutil.copyfile(result.masked_file, dest)
        logger.info(
            "data_protection operation_id=%s endpoint=file.redact step=completed "
            "masked_delivery=path masked_size_bytes=%s rows_masked=%s",
            operation_id, masked_size, result.segments_masked,
        )
        return RedactResponse(
            masked_csv=None,
            masked_file_path=container_path,
            expires_at=None, ttl_seconds=None,
            registry=registry_inline,
            registry_file_path=registry_path,
            registry_expires_at=registry_expires_at,
            rewritten_query=rewritten,
            substitutions=substitutions,
            columns_masked=[], extra_pii_found=[],
            safety_net_columns={}, free_text_columns=[],
            rows_extracted=result.segments_masked,
            rows_masked=result.segments_masked,
            recommended_system_prompt=RECOMMENDED_SYSTEM_PROMPT,
        )
