"""Tabular (CSV/XLSX/Parquet) file redaction worker."""

from __future__ import annotations

import logging
import shutil
import tempfile
from dataclasses import dataclass
from pathlib import Path

from fastapi import HTTPException, status

from file_protection.agents.data_prep_agent import prepare_dataframe, read_source
from file_protection.agents.redact_agent import redact_dataframe
from file_protection.detect import suggest_sensitive_columns, to_sensitive_columns
from file_protection.io import save_dataframe
from file_protection.registry import invert_registry
from file_protection.rewrite import rewrite_query

from protection_service.config import AppConfig
from protection_service.constants import DATA_PREP_USER_ERRORS, RECOMMENDED_SYSTEM_PROMPT
from protection_service.io.registry_delivery import deliver_redaction_registry
from protection_service.io.workspace_paths import build_workspace_masked_output_path
from protection_service.redacts_store import RedactsStore
from protection_service.sanitize_state import SanitizeManager
from protection_service.schemas import RedactRequest, RedactResponse
from protection_service.redaction.column_detection import (
    resolve_column_entity_classifier,
    resolve_document_span_provider,
)

logger = logging.getLogger(__name__)


@dataclass
class _PrepArtifacts:
    """Minimal stand-in for DataPrepResult on the in-memory redact path."""

    rows_extracted: int


@dataclass
class _RedactArtifacts:
    """Minimal stand-in for RedactAgentResult on the in-memory redact path."""

    masked_file: Path
    columns_masked: list
    extra_pii_found: list
    safety_net_columns: dict
    free_text_columns: list
    rows_masked: int


def redact_tabular_file_sync(
    source: Path,
    req: RedactRequest,
    config: AppConfig,
    redacts_store: RedactsStore,
    sanitize_mgr: SanitizeManager,
    *,
    capture_suggestions: list | None = None,
    operation_id: str,
) -> RedactResponse:
    """Redact PII from a CSV/XLSX/Parquet file.

    Loads the table, applies any requested row or column subset, detects
    sensitive columns when ``auto_pii`` is enabled, masks the dataframe, and
    delivers the masked output and registry according to the request modes.

    Args:
        source: Validated CSV/XLSX/Parquet source file path.
        req: Tabular redaction options.
        config: Service configuration.
        redacts_store: Store for file-backed registry files.
        sanitize_mgr: Sanitizer state and model provider.
        capture_suggestions: Optional list filled with detected column suggestions
            so callers can surface them without running detection twice.
        operation_id: Correlated log operation id.

    Returns:
        RedactResponse: Masked table output, registry data, and masking stats.

    Raises:
        HTTPException: 400 for data-prep errors or missing sensitivity columns,
            413 for oversized inline output, 422 when auto-detection finds no
            sensitive columns, 500 when masking fails.
    """
    sensitive_columns = req.sensitive_columns
    suspected = req.suspected_sensitive_columns or []

    try:
        df = read_source(source, sheet=req.sheet)
        df = prepare_dataframe(
            df,
            columns=req.columns,
            filter_col=req.filter_col,
            filter_val=req.filter_val,
        )
    except DATA_PREP_USER_ERRORS as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": "data_prep_failed", "message": str(exc)},
        ) from exc

    rows_extracted = len(df)
    logger.info(
        "data_protection operation_id=%s endpoint=file.redact step=data_prepared "
        "rows_extracted=%s columns=%s",
        operation_id, rows_extracted, len(df.columns),
    )

    if sensitive_columns is None:
        if not req.auto_pii:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={
                    "error": "no_sensitivity_spec",
                    "message": "Provide either sensitive_columns={col: CATEGORY} or auto_pii=true.",
                },
            )
        logger.info(
            "data_protection operation_id=%s endpoint=file.redact step=detect_columns_start "
            "sample_size=%s min_confidence=%.3f use_ner=%s ner_scope=%s",
            operation_id, req.sample_size, req.min_confidence, req.use_ner, req.ner_scope,
        )
        suggestions = suggest_sensitive_columns(
            df,
            sample_size=req.sample_size,
            min_confidence=req.min_confidence,
            entity_classifier=resolve_column_entity_classifier(req.use_ner, config, sanitize_mgr),
            ner_scope=req.ner_scope,
        )
        if capture_suggestions is not None:
            capture_suggestions.extend(suggestions)
        sensitive_columns = to_sensitive_columns(suggestions)
        if not sensitive_columns:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail={
                    "error": "no_sensitive_columns",
                    "message": (
                        "auto_pii found no columns above the confidence threshold. "
                        "Pass sensitive_columns explicitly or lower min_confidence."
                    ),
                    "suggestions": [
                        {
                            "column": s.column,
                            "category": s.category,
                            "confidence": round(s.confidence, 3),
                        }
                        for s in suggestions
                    ],
                },
            )
        if not suspected:
            suspected = list(sensitive_columns.keys())
        logger.info(
            "data_protection operation_id=%s endpoint=file.redact step=detect_columns_completed "
            "suggestions=%s sensitive_columns=%s",
            operation_id, len(suggestions), len(sensitive_columns),
        )
    else:
        logger.info(
            "data_protection operation_id=%s endpoint=file.redact step=explicit_columns "
            "sensitive_columns=%s",
            operation_id, len(sensitive_columns),
        )

    span_provider = None
    if req.scan_free_text:
        span_provider = resolve_document_span_provider(req.free_text_use_ner, config, sanitize_mgr)

    try:
        logger.info(
            "data_protection operation_id=%s endpoint=file.redact step=mask_start "
            "sensitive_columns=%s suspected_columns=%s scan_free_text=%s",
            operation_id, len(sensitive_columns), len(suspected), req.scan_free_text,
        )
        df_result = redact_dataframe(
            df,
            sensitive_columns,
            suspected_sensitive_columns=suspected,
            scan_all_columns=req.auto_pii,
            scan_free_text=req.scan_free_text,
            free_text_columns=req.free_text_columns,
            span_provider=span_provider,
            bucketize_financial=(
                config.sanitize.bucketize_financial
                if req.bucketize_financial is None
                else req.bucketize_financial
            ),
        )
    except Exception as exc:
        logger.warning(
            "data_protection operation_id=%s endpoint=file.redact step=mask_failed exc_type=%s",
            operation_id, exc.__class__.__name__,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"error": "mask_failed", "message": str(exc)},
        ) from exc

    logger.info(
        "data_protection operation_id=%s endpoint=file.redact step=mask_completed "
        "columns_masked=%s extra_pii_columns=%s free_text_columns=%s rows_masked=%s",
        operation_id, len(df_result.columns_masked), len(df_result.extra_pii_found),
        len(df_result.free_text_columns), df_result.rows_masked,
    )

    registry = df_result.registry

    with tempfile.TemporaryDirectory(prefix="pii_redact_") as workspace:
        mask_dir = Path(workspace) / "masked"
        mask_dir.mkdir(parents=True)

        # Path mode preserves Parquet; inline mode always returns CSV text.
        out_format = (
            "parquet"
            if source.suffix.lower() == ".parquet" and req.return_mode == "path"
            else "csv"
        )
        masked_file = save_dataframe(
            df_result.df, output_dir=mask_dir, prefix="masked", output_format=out_format
        )
        redact_result = _RedactArtifacts(
            masked_file=masked_file,
            columns_masked=df_result.columns_masked,
            extra_pii_found=df_result.extra_pii_found,
            safety_net_columns=df_result.safety_net_columns,
            free_text_columns=df_result.free_text_columns,
            rows_masked=df_result.rows_masked,
        )
        prep_result = _PrepArtifacts(rows_extracted=rows_extracted)

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
            "data_protection operation_id=%s endpoint=file.redact step=registry_delivered "
            "entries=%s delivery=%s expires_at=%s",
            operation_id, len(registry), "path" if registry_path else "inline", registry_expires_at,
        )

        masked_size = redact_result.masked_file.stat().st_size

        if req.return_mode == "inline":
            if masked_size > config.redact.max_inline_bytes:
                raise HTTPException(
                    status_code=413,
                    detail={
                        "error": "masked_too_large",
                        "message": (
                            f"Masked CSV is {masked_size:,} bytes, above the inline cap of "
                            f"{config.redact.max_inline_bytes:,}. Either subset the request "
                            "(use 'columns' / 'filter_col' / 'filter_val' to reduce rows or "
                            "columns), or set 'return_mode': 'path'."
                        ),
                        "size_bytes": masked_size,
                        "cap_bytes": config.redact.max_inline_bytes,
                    },
                )
            return RedactResponse(
                masked_csv=redact_result.masked_file.read_text(encoding="utf-8"),
                masked_file_path=None,
                expires_at=None, ttl_seconds=None,
                registry=registry_inline,
                registry_file_path=registry_path,
                registry_expires_at=registry_expires_at,
                rewritten_query=rewritten,
                substitutions=substitutions,
                columns_masked=list(redact_result.columns_masked),
                extra_pii_found=list(redact_result.extra_pii_found),
                safety_net_columns=dict(redact_result.safety_net_columns),
                free_text_columns=list(redact_result.free_text_columns),
                rows_extracted=prep_result.rows_extracted,
                rows_masked=redact_result.rows_masked,
                recommended_system_prompt=RECOMMENDED_SYSTEM_PROMPT,
            )

        dest, container_path = build_workspace_masked_output_path(
            source, redact_result.masked_file.suffix
        )
        shutil.copyfile(redact_result.masked_file, dest)
        logger.info(
            "data_protection operation_id=%s endpoint=file.redact step=completed "
            "masked_delivery=path masked_size_bytes=%s rows_masked=%s",
            operation_id, masked_size, redact_result.rows_masked,
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
            columns_masked=list(redact_result.columns_masked),
            extra_pii_found=list(redact_result.extra_pii_found),
            safety_net_columns=dict(redact_result.safety_net_columns),
            free_text_columns=list(redact_result.free_text_columns),
            rows_extracted=prep_result.rows_extracted,
            rows_masked=redact_result.rows_masked,
            recommended_system_prompt=RECOMMENDED_SYSTEM_PROMPT,
        )
