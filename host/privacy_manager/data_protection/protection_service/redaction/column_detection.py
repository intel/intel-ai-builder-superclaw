"""Offline sensitive-column detection for tabular files."""

from __future__ import annotations

import logging
from pathlib import Path

from fastapi import HTTPException, status

from file_protection.detect import suggest_sensitive_columns, to_sensitive_columns
from file_protection.documents import is_document
from file_protection.io import load_table

from protection_service.config import AppConfig
from protection_service.sanitize_state import SanitizeManager
from protection_service.schemas import ColumnSuggestion, DetectResponse

logger = logging.getLogger(__name__)


def _ner_ready(sanitize_mgr: SanitizeManager, fallback: str) -> bool:
    """Fail closed unless NER is loaded; wait out a warm-up first.

    Returns False (heuristics only, logged) only when sanitize is disabled in
    config.

    Raises:
        PiiModelNotReady: The PII model is not installed, or NER did not load.
    """
    sanitize_mgr.require_pii_model()
    if sanitize_mgr.wait_ready() or sanitize_mgr.sanitize_enabled:
        sanitize_mgr.require_ner_loaded()
        return True
    logger.warning(
        "File NER skipped: sanitize.enabled is false in config; %s",
        fallback,
    )
    return False


def resolve_column_entity_classifier(
    use_ner: bool | None,
    config: AppConfig,
    sanitize_mgr: SanitizeManager,
) -> object | None:
    """Resolve the optional NER column classifier.

    Waits for a sanitizer warm-up still in progress, so call it from a worker
    thread, never the event loop.

    Args:
        use_ner: Request-level NER override, or None to use config default.
        config: Service configuration.
        sanitize_mgr: Sanitizer state and model provider.

    Returns:
        object | None: NER column classifier when enabled and ready; None otherwise.
    """
    enabled = config.sanitize.detect_use_ner if use_ner is None else use_ner
    if not enabled or not _ner_ready(sanitize_mgr, "column detection runs heuristics-only"):
        return None
    return sanitize_mgr.entity_column_classifier()


def resolve_document_span_provider(
    free_text_use_ner: bool | None,
    config: AppConfig,
    sanitize_mgr: SanitizeManager,
) -> object | None:
    """Resolve the span provider used for free-form text and document masking.

    Composes an optional geo/gazetteer provider with an optional NER provider.
    The geo provider is composed first so specific gazetteer matches win over
    broader NER spans on overlap (first-seen-wins dedup rule). Waits for a
    sanitizer warm-up still in progress, so call it from a worker thread.

    Args:
        free_text_use_ner: Request-level NER override, or None to use config default.
        config: Service configuration.
        sanitize_mgr: Sanitizer state and model provider.

    Returns:
        object | None: Composed span provider, or None when both are disabled.
    """
    enabled = config.sanitize.redact_use_ner if free_text_use_ner is None else free_text_use_ner
    ner_provider = None
    if enabled and _ner_ready(sanitize_mgr, "free-text masking runs regex-only"):
        ner_provider = sanitize_mgr.person_org_span_provider()

    geo_provider = None
    if config.sanitize.redact_geo_gazetteer:
        from file_protection.masker import make_geo_span_provider
        geo_provider = make_geo_span_provider()

    from file_protection.masker import compose_span_providers
    return compose_span_providers(geo_provider, ner_provider)


def detect_sensitive_columns_sync(
    source: Path,
    sample_size: int,
    min_confidence: float,
    entity_classifier: object = None,
    ner_scope: str = "ambiguous",
) -> DetectResponse:
    """Detect sensitive columns in a tabular file.

    Runs offline heuristic and optional NER-based column detection against a
    sampled subset of the table. Rejects document formats because column
    detection does not apply to prose.

    Args:
        source: Validated path to the source tabular file.
        sample_size: Number of rows to sample per column.
        min_confidence: Minimum confidence score to include in the response.
        entity_classifier: Optional NER-based column classifier. When None,
            detection uses header-keyword and value-regex heuristics only.
        ner_scope: Scope hint for the NER classifier. Defaults to
            ``"ambiguous"``, targeting columns whose category is not obvious
            from the header name alone.

    Returns:
        DetectResponse: Per-column suggestions and a ``sensitive_columns`` map.

    Raises:
        HTTPException: HTTP 400 if ``source`` is a document format.
    """
    if is_document(source):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "error": "detect_not_supported_for_documents",
                "message": (
                    f"{source.suffix} is a free-form document, not a tabular file. "
                    "Column detection does not apply; call /v1/file/redact directly."
                ),
            },
        )
    df = load_table(source)
    suggestions = suggest_sensitive_columns(
        df,
        sample_size=sample_size,
        min_confidence=min_confidence,
        entity_classifier=entity_classifier,
        ner_scope=ner_scope,
    )
    return DetectResponse(
        suggestions=[
            ColumnSuggestion(
                column=s.column,
                category=s.category,
                confidence=round(s.confidence, 3),
                sources=list(s.sources),
                reasons=list(s.reasons),
            )
            for s in suggestions
        ],
        sensitive_columns=to_sensitive_columns(suggestions),
    )
