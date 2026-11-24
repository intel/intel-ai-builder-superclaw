"""File redaction dispatcher and combined detect-and-redact worker."""

from __future__ import annotations

import logging
from pathlib import Path

from file_protection.documents import is_document

from protection_service.config import AppConfig
from protection_service.io.session_utils import new_operation_id
from protection_service.io.workspace_paths import summarize_source_for_logs
from protection_service.redacts_store import RedactsStore
from protection_service.sanitize_state import SanitizeManager
from protection_service.schemas import (
    ColumnSuggestion,
    DetectAndRedactResponse,
    RedactRequest,
    RedactResponse,
)
from protection_service.redaction.document_redaction import redact_document_file_sync
from protection_service.redaction.tabular_redaction import redact_tabular_file_sync

logger = logging.getLogger(__name__)


def redact_file_sync(
    source: Path,
    req: RedactRequest,
    config: AppConfig,
    redacts_store: RedactsStore,
    sanitize_mgr: SanitizeManager,
    *,
    owns_source: bool,
    capture_suggestions: list | None = None,
    operation_id: str | None = None,
) -> RedactResponse:
    """Route a file to the appropriate redaction worker based on file type.

    Document files (TXT/MD/HTML/DOCX) are handled by
    ``redact_document_file_sync``. Tabular files (CSV/XLSX/Parquet) are
    handled by ``redact_tabular_file_sync``.

    Args:
        source: Validated source file path.
        req: Redaction options and output delivery modes.
        config: Service configuration.
        redacts_store: Store for file-backed registry files.
        sanitize_mgr: Sanitizer state and model provider.
        owns_source: Whether this request owns and may clean up the source file.
        capture_suggestions: Optional list filled with detected tabular column
            suggestions when tabular auto-detection runs. Ignored for documents.
        operation_id: Existing operation id, or None to create one.

    Returns:
        RedactResponse: Masked output, registry data, and masking stats.
    """
    operation_id = operation_id or new_operation_id()
    source_ext, source_size, workspace_path = summarize_source_for_logs(source)

    logger.info(
        "data_protection operation_id=%s endpoint=file.redact step=started "
        "source_ext=%s source_size_bytes=%s workspace_path=%s auto_pii=%s "
        "return_mode=%s registry_return_mode=%s",
        operation_id, source_ext, source_size, workspace_path, req.auto_pii,
        req.return_mode, req.registry_return_mode,
    )

    if is_document(source):
        return redact_document_file_sync(
            source, req, config, redacts_store, sanitize_mgr,
            operation_id=operation_id,
        )

    return redact_tabular_file_sync(
        source, req, config, redacts_store, sanitize_mgr,
        capture_suggestions=capture_suggestions,
        operation_id=operation_id,
    )


def detect_and_redact_file_sync(
    source: Path,
    req: RedactRequest,
    config: AppConfig,
    redacts_store: RedactsStore,
    sanitize_mgr: SanitizeManager,
    *,
    owns_source: bool,
    operation_id: str | None = None,
) -> DetectAndRedactResponse:
    """Detect sensitive columns and redact a file in one synchronous pass.

    Wraps ``redact_file_sync`` with ``capture_suggestions`` so the caller
    receives both the masked output and the detection suggestions without
    running detection a second time.

    Args:
        source: Validated source file path.
        req: Redaction request. Should include ``auto_pii=True`` for tabular files.
        config: Service configuration.
        redacts_store: Store for registry files.
        sanitize_mgr: Sanitizer state and model provider.
        owns_source: Whether this request owns and may clean up the source file.
        operation_id: Existing operation id, or None to create one.

    Returns:
        DetectAndRedactResponse: Redaction output plus detection suggestions.
    """
    operation_id = operation_id or new_operation_id()
    logger.info(
        "data_protection operation_id=%s endpoint=file.detect_and_redact step=started "
        "auto_pii=%s return_mode=%s registry_return_mode=%s",
        operation_id, req.auto_pii, req.return_mode, req.registry_return_mode,
    )

    suggestions: list = []
    base = redact_file_sync(
        source, req, config, redacts_store, sanitize_mgr,
        owns_source=owns_source,
        capture_suggestions=suggestions,
        operation_id=operation_id,
    )

    suggestion_models = [
        ColumnSuggestion(
            column=s.column,
            category=s.category,
            confidence=round(s.confidence, 3),
            sources=list(s.sources),
            reasons=list(s.reasons),
        )
        for s in suggestions
    ]
    detected = {s.column: s.category for s in suggestions if s.category}

    logger.info(
        "data_protection operation_id=%s endpoint=file.detect_and_redact step=completed "
        "suggestions=%s detected_sensitive_columns=%s rows_masked=%s",
        operation_id, len(suggestion_models), len(detected), base.rows_masked,
    )
    return DetectAndRedactResponse(
        **base.model_dump(),
        suggestions=suggestion_models,
        detected_sensitive_columns=detected,
    )
