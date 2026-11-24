"""File detection and redaction route registration."""

from __future__ import annotations

import logging
from typing import Optional

from fastapi import Depends, FastAPI, File, Form, HTTPException, UploadFile, status
from fastapi.concurrency import run_in_threadpool

from protection_service.app_state import ProtectionAppState
from protection_service.io.session_utils import new_operation_id
from protection_service.io.source_validation import parse_kv_form_string, validate_source_path
from protection_service.io.upload_storage import temporary_uploaded_file
from protection_service.io.workspace_paths import summarize_source_for_logs
from protection_service.redaction.column_detection import (
    detect_sensitive_columns_sync,
    resolve_column_entity_classifier,
)
from protection_service.redaction.file_redaction import (
    detect_and_redact_file_sync,
    redact_file_sync,
)
from protection_service.schemas import (
    DetectAndRedactResponse,
    DetectRequest,
    DetectResponse,
    RedactRequest,
    RedactResponse,
)

logger = logging.getLogger(__name__)


def register_file_routes(app: FastAPI, state: ProtectionAppState) -> None:
    """Register all ``/v1/file/*`` detection and redaction endpoints.

    Args:
        app: FastAPI application instance.
        state: App-scoped state.
    """
    config = state.config
    redacts_store = state.redacts_store
    sanitize_mgr = state.sanitize_mgr
    auth_dep = state.auth_dep

    # ── /v1/file/detect ──────────────────────────────────────────────────────

    @app.post(
        "/v1/file/detect",
        response_model=DetectResponse,
        dependencies=[Depends(auth_dep)],
        tags=["file"],
    )
    async def detect(req: DetectRequest) -> DetectResponse:
        """Detect sensitive columns for a source file (e.g. CSV, XLSX, Parquet).

        Args:
            req: Detection request.

        Returns:
            DetectResponse: Suggested and selected sensitive columns.
        """
        operation_id = new_operation_id()
        source = validate_source_path(req.source, config.redact)
        source_ext, source_size, workspace_path = summarize_source_for_logs(source)
        logger.info(
            "data_protection operation_id=%s endpoint=file.detect step=validated "
            "source_ext=%s source_size_bytes=%s workspace_path=%s sample_size=%s "
            "min_confidence=%.3f use_ner=%s ner_scope=%s",
            operation_id, source_ext, source_size, workspace_path, req.sample_size,
            req.min_confidence, req.use_ner, req.ner_scope,
        )
        classifier = await run_in_threadpool(
            resolve_column_entity_classifier, req.use_ner, config, sanitize_mgr,
        )
        result = await run_in_threadpool(
            detect_sensitive_columns_sync,
            source, req.sample_size, req.min_confidence, classifier, req.ner_scope,
        )
        logger.info(
            "data_protection operation_id=%s endpoint=file.detect step=completed "
            "suggestions=%s sensitive_columns=%s",
            operation_id, len(result.suggestions), len(result.sensitive_columns),
        )
        return result

    @app.post(
        "/v1/file/detect/upload",
        response_model=DetectResponse,
        dependencies=[Depends(auth_dep)],
        tags=["file"],
    )
    async def detect_upload(
        file: UploadFile = File(...),
        sample_size: int = Form(default=200),
        min_confidence: float = Form(default=0.5),
        use_ner: Optional[bool] = Form(default=None),
        ner_scope: str = Form(default="ambiguous"),
    ) -> DetectResponse:
        """Detect sensitive columns for an uploaded file.

        Args:
            file: Uploaded source file.
            sample_size: Number of rows to sample.
            min_confidence: Minimum confidence for suggestions.
            use_ner: Request-level NER override.
            ner_scope: NER scope hint.

        Returns:
            DetectResponse: Suggested and selected sensitive columns.
        """
        classifier = await run_in_threadpool(
            resolve_column_entity_classifier, use_ner, config, sanitize_mgr,
        )
        async with temporary_uploaded_file(
            file,
            redacts_dir=config.redact.redacts_dir,
            max_bytes=config.redact.max_source_bytes,
        ) as tmp_path:
            return await run_in_threadpool(
                detect_sensitive_columns_sync,
                tmp_path, sample_size, min_confidence, classifier, ner_scope,
            )

    # ── /v1/file/redact ───────────────────────────────────────────────────────

    @app.post(
        "/v1/file/redact",
        response_model=RedactResponse,
        dependencies=[Depends(auth_dep)],
        tags=["file"],
    )
    async def redact(req: RedactRequest) -> RedactResponse:
        """Redact sensitive data from a source file.

        Args:
            req: File redaction request.

        Returns:
            RedactResponse: Masked output, registry data, and masking stats.
        """
        operation_id = new_operation_id()
        source = validate_source_path(req.source, config.redact)
        source_ext, source_size, workspace_path = summarize_source_for_logs(source)
        logger.info(
            "data_protection operation_id=%s endpoint=file.redact step=validated "
            "source_ext=%s source_size_bytes=%s workspace_path=%s return_mode=%s "
            "registry_return_mode=%s auto_pii=%s",
            operation_id, source_ext, source_size, workspace_path, req.return_mode,
            req.registry_return_mode, req.auto_pii,
        )
        return await run_in_threadpool(
            redact_file_sync, source, req, config, redacts_store, sanitize_mgr,
            owns_source=False, operation_id=operation_id,
        )

    @app.post(
        "/v1/file/redact/upload",
        response_model=RedactResponse,
        dependencies=[Depends(auth_dep)],
        tags=["file"],
    )
    async def redact_upload(
        file: UploadFile = File(...),
        query: Optional[str] = Form(default=None),
        auto_pii: bool = Form(default=False),
        sensitive_columns: Optional[str] = Form(default=None),
        suspected_sensitive_columns: Optional[str] = Form(default=None),
        min_confidence: float = Form(default=0.5),
        sample_size: int = Form(default=200),
        columns: Optional[str] = Form(default=None),
        filter_col: Optional[str] = Form(default=None),
        filter_val: Optional[str] = Form(default=None),
        sheet: str = Form(default="0"),
        return_mode: str = Form(default="inline"),
        registry_return_mode: str = Form(default="auto"),
        ttl_seconds: Optional[int] = Form(default=None),
        bucketize_financial: Optional[bool] = Form(default=None),
    ) -> RedactResponse:
        """Redact sensitive data from an uploaded file.

        Args:
            file: Uploaded source file.
            query: Optional query to rewrite against the registry.
            auto_pii: Whether to auto-detect sensitive columns.
            sensitive_columns: Form-encoded explicit column map.
            suspected_sensitive_columns: Comma-separated suspected columns.
            min_confidence: Minimum auto-detection confidence.
            sample_size: Number of rows to sample.
            columns: Optional comma-separated column subset.
            filter_col: Optional filter column.
            filter_val: Optional filter value.
            sheet: Spreadsheet sheet selector.
            return_mode: Inline or path output mode.
            registry_return_mode: Inline, path, or auto registry mode.
            ttl_seconds: Optional registry file TTL.
            bucketize_financial: Optional financial bucketization override.

        Returns:
            RedactResponse: Masked output, registry data, and masking stats.
        """
        try:
            req = RedactRequest(
                source="(uploaded)",
                query=query,
                sensitive_columns=parse_kv_form_string(sensitive_columns) if sensitive_columns else None,
                suspected_sensitive_columns=(
                    [c.strip() for c in suspected_sensitive_columns.split(",") if c.strip()]
                    if suspected_sensitive_columns else None
                ),
                auto_pii=auto_pii,
                min_confidence=min_confidence,
                sample_size=sample_size,
                columns=(
                    [c.strip() for c in columns.split(",") if c.strip()]
                    if columns else None
                ),
                filter_col=filter_col,
                filter_val=filter_val,
                sheet=int(sheet) if sheet.isdigit() else sheet,
                return_mode=return_mode,
                registry_return_mode=registry_return_mode,
                ttl_seconds=ttl_seconds,
                bucketize_financial=bucketize_financial,
            )
        except (ValueError, TypeError) as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={"error": "invalid_request", "message": str(exc)},
            ) from exc

        async with temporary_uploaded_file(
            file,
            redacts_dir=config.redact.redacts_dir,
            max_bytes=config.redact.max_source_bytes,
        ) as tmp_path:
            return await run_in_threadpool(
                redact_file_sync, tmp_path, req, config, redacts_store, sanitize_mgr,
                owns_source=True,
            )

    # ── /v1/file/detect_and_redact ───────────────────────────────────────────

    @app.post(
        "/v1/file/detect_and_redact",
        response_model=DetectAndRedactResponse,
        dependencies=[Depends(auth_dep)],
        tags=["file"],
    )
    async def detect_and_redact(req: RedactRequest) -> DetectAndRedactResponse:
        """Detect and redact a source file in one request.

        Args:
            req: File redaction request.

        Returns:
            DetectAndRedactResponse: Redaction output plus detection suggestions.
        """
        operation_id = new_operation_id()
        source = validate_source_path(req.source, config.redact)
        source_ext, source_size, workspace_path = summarize_source_for_logs(source)
        logger.info(
            "data_protection operation_id=%s endpoint=file.detect_and_redact step=validated "
            "source_ext=%s source_size_bytes=%s workspace_path=%s return_mode=%s "
            "registry_return_mode=%s auto_pii=%s min_confidence=%.3f",
            operation_id, source_ext, source_size, workspace_path, req.return_mode,
            req.registry_return_mode, req.auto_pii, req.min_confidence,
        )
        return await run_in_threadpool(
            detect_and_redact_file_sync, source, req, config, redacts_store, sanitize_mgr,
            owns_source=False, operation_id=operation_id,
        )

    @app.post(
        "/v1/file/detect_and_redact/upload",
        response_model=DetectAndRedactResponse,
        dependencies=[Depends(auth_dep)],
        tags=["file"],
    )
    async def detect_and_redact_upload(
        file: UploadFile = File(...),
        query: Optional[str] = Form(default=None),
        auto_pii: bool = Form(default=True),
        sensitive_columns: Optional[str] = Form(default=None),
        suspected_sensitive_columns: Optional[str] = Form(default=None),
        min_confidence: float = Form(default=0.5),
        sample_size: int = Form(default=200),
        use_ner: Optional[bool] = Form(default=None),
        ner_scope: str = Form(default="ambiguous"),
        columns: Optional[str] = Form(default=None),
        filter_col: Optional[str] = Form(default=None),
        filter_val: Optional[str] = Form(default=None),
        sheet: str = Form(default="0"),
        return_mode: str = Form(default="inline"),
        registry_return_mode: str = Form(default="auto"),
        ttl_seconds: Optional[int] = Form(default=None),
        bucketize_financial: Optional[bool] = Form(default=None),
    ) -> DetectAndRedactResponse:
        """Detect and redact an uploaded file in one request.

        Args:
            file: Uploaded source file.
            query: Optional query to rewrite against the registry.
            auto_pii: Whether to auto-detect sensitive columns (defaults True).
            sensitive_columns: Form-encoded explicit column map.
            suspected_sensitive_columns: Comma-separated suspected columns.
            min_confidence: Minimum auto-detection confidence.
            sample_size: Number of rows to sample.
            use_ner: Request-level NER override.
            ner_scope: NER scope hint.
            columns: Optional comma-separated column subset.
            filter_col: Optional filter column.
            filter_val: Optional filter value.
            sheet: Spreadsheet sheet selector.
            return_mode: Inline or path output mode.
            registry_return_mode: Inline, path, or auto registry mode.
            ttl_seconds: Optional registry file TTL.
            bucketize_financial: Optional financial bucketization override.

        Returns:
            DetectAndRedactResponse: Redaction output plus detection suggestions.
        """
        # auto_pii defaults True: the caller wants the server to find columns,
        # but explicit sensitive_columns in the form still win if provided.
        try:
            req = RedactRequest(
                source="(uploaded)",
                query=query,
                sensitive_columns=parse_kv_form_string(sensitive_columns) if sensitive_columns else None,
                suspected_sensitive_columns=(
                    [c.strip() for c in suspected_sensitive_columns.split(",") if c.strip()]
                    if suspected_sensitive_columns else None
                ),
                auto_pii=auto_pii,
                min_confidence=min_confidence,
                sample_size=sample_size,
                use_ner=use_ner,
                ner_scope=ner_scope,
                columns=(
                    [c.strip() for c in columns.split(",") if c.strip()]
                    if columns else None
                ),
                filter_col=filter_col,
                filter_val=filter_val,
                sheet=int(sheet) if sheet.isdigit() else sheet,
                return_mode=return_mode,
                registry_return_mode=registry_return_mode,
                ttl_seconds=ttl_seconds,
                bucketize_financial=bucketize_financial,
            )
        except (ValueError, TypeError) as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={"error": "invalid_request", "message": str(exc)},
            ) from exc

        async with temporary_uploaded_file(
            file,
            redacts_dir=config.redact.redacts_dir,
            max_bytes=config.redact.max_source_bytes,
        ) as tmp_path:
            return await run_in_threadpool(
                detect_and_redact_file_sync, tmp_path, req, config, redacts_store, sanitize_mgr,
                owns_source=True,
            )
