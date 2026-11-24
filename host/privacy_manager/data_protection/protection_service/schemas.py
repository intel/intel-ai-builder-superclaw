"""
Pydantic request and response models for the protection service.
The service exposes two PII pipelines:
1. File redaction masks files and returns masked output plus a registry.
2. Text sanitization masks free-form text and returns replacement records.
Shared endpoints provide health checks and placeholder restoration.
"""
from __future__ import annotations
from typing import Any, Literal
from pydantic import BaseModel, ConfigDict, Field

from protection_service.masking_summary import MaskingSummary

# Post-install download state of the privacy models (see model_delivery).
ModelsState = Literal[
    "ready", "downloading", "verifying", "activating", "failed", "disabled", "pending",
    "unsupported",
]

# Reject oversized text at Pydantic parse time before NER can buffer it.
_MAX_TEXT_CHARS: int = 10 * 1024 * 1024
# Restore can receive full LLM responses, so it uses the same text cap.
_MAX_RESTORE_TEXT_CHARS: int = 10 * 1024 * 1024

# --------------------------------------------------------------------------
# File redact pipeline
# --------------------------------------------------------------------------

NerScope = Literal["ambiguous", "all"]

class DetectRequest(BaseModel):
    """Request body for detecting sensitive columns in a file."""
    model_config = ConfigDict(extra="forbid")
    source: str = Field(description="Path to a CSV / XLSX / Parquet file readable by the server.")
    sample_size: int = Field(default=200, ge=1, le=10_000)
    # Minimum confidence required for a detected column to be reported.
    min_confidence: float = Field(default=0.5, ge=0.0, le=1.0)
    # Optional NER column detection. None uses the server default; false disables it.
    use_ner: bool | None = None
    # "ambiguous" checks uncertain columns only; "all" checks every string column.
    ner_scope: NerScope = "ambiguous"

class ColumnSuggestion(BaseModel):
    """Detected column candidate with category, confidence, and reasons."""
    column: str
    category: str | None
    confidence: float
    sources: list[str] = []
    reasons: list[str] = []

class DetectResponse(BaseModel):
    """Response body for file-column detection results."""
    suggestions: list[ColumnSuggestion]
    sensitive_columns: dict[str, str]

ReturnMode = Literal["inline", "path"]
# How the placeholder registry is returned: inline, as a file path, or auto.
RegistryReturnMode = Literal["auto", "inline", "path"]

class RedactRequest(BaseModel):
    """Body for ``POST /v1/file/redact``."""
    model_config = ConfigDict(extra="forbid")
    source: str = Field(description="Path to a CSV / XLSX / Parquet file readable by the server.")
    query: str | None = None
    sensitive_columns: dict[str, str] | None = None
    auto_pii: bool = False
    suspected_sensitive_columns: list[str] | None = None
    min_confidence: float = Field(default=0.5, ge=0.0, le=1.0)
    sample_size: int = Field(default=200, ge=1, le=10_000)
    # Used only when auto_pii is true. None uses the server default; false disables NER.
    use_ner: bool | None = None
    ner_scope: NerScope = "ambiguous"
    columns: list[str] | None = None
    filter_col: str | None = None
    filter_val: str | None = None
    sheet: int | str = 0
    # When true, scan prose cells for PII spans instead of masking whole cells.
    scan_free_text: bool = False
    # Optional prose-column list for scan_free_text; None lets the server detect them.
    free_text_columns: list[str] | None = None
    # NER for prose text. None uses the server default; false keeps regex-only masking.
    free_text_use_ner: bool | None = None
    # Bucketize financial amounts into magnitude placeholders; restore still uses exact values.
    bucketize_financial: bool | None = None
    return_mode: ReturnMode = "inline"
    ttl_seconds: int | None = None
    # "auto" keeps small registries inline and writes large ones to a file.
    registry_return_mode: RegistryReturnMode = "auto"

class RedactResponse(BaseModel):
    """Body returned by ``POST /v1/file/redact``."""
    masked_csv: str | None = None
    masked_file_path: str | None = None
    expires_at: str | None = None
    ttl_seconds: int | None = None
    # Placeholder-to-original mapping when the registry is returned inline.
    registry: dict[str, str] | None = None
    # Registry file path when the registry was offloaded or requested as path.
    registry_file_path: str | None = None
    registry_expires_at: str | None = None
    rewritten_query: str | None
    substitutions: int = 0
    columns_masked: list[str]
    extra_pii_found: list[str] = []
    # Extra columns masked by the full-column safety net: {column: category}.
    safety_net_columns: dict[str, str] = {}
    # Columns masked with sub-cell prose scanning.
    free_text_columns: list[str] = []
    rows_extracted: int
    rows_masked: int
    recommended_system_prompt: str

class DetectAndRedactResponse(RedactResponse):
    """Body returned by ``POST /v1/file/detect_and_redact``.
    Extends :class:`RedactResponse` with detection results. ``suggestions`` is
    empty when the caller passed explicit ``sensitive_columns``.
    """
    suggestions: list[ColumnSuggestion] = []
    detected_sensitive_columns: dict[str, str] = {}

# --------------------------------------------------------------------------
# Text sanitize pipeline
# --------------------------------------------------------------------------

class SanitizeRequest(BaseModel):
    """Body for ``POST /v1/text/redact``."""
    # Keep text bounded so large payloads are rejected before NER processing.
    text: str = Field(max_length=_MAX_TEXT_CHARS)
    session_id: str | None = Field(default=None, max_length=256)
    custom_terms: dict[str, str] | None = None
    skip_categories: list[str] | None = None
    sensitivity_level: str | None = None
    custom_mask_categories: list[str] | None = None
    # Per-request financial bucketization override. None uses the server default.
    bucketize_financial: bool | None = None

class ReplacementInfo(BaseModel):
    """Metadata for one text-redaction placeholder."""
    original: str
    redacted: str
    type: str
    meta: dict[str, Any] = {}

class SanitizeResponse(BaseModel):
    """Response body containing redacted text and replacement metadata."""
    redacted: str
    replacements: dict[str, ReplacementInfo]

class CustomPiiLevelRequest(BaseModel):
    """Request body for setting custom PII categories to mask."""
    mask_categories: list[str]

class CustomPiiLevelResponse(BaseModel):
    """Response body for the applied custom PII category settings."""
    ok: bool
    mask_categories: list[str]
    skip_categories: list[str]

class CategoriesResponse(BaseModel):
    """Response body listing supported and custom PII categories."""
    all_categories: list[str]
    custom_skip_categories: list[str]
    custom_mask_categories: list[str]

# --------------------------------------------------------------------------
# Restore (polymorphic)
# --------------------------------------------------------------------------

class RestoreRequest(BaseModel):
    """Body for ``POST /v1/restore``.
    Accepts either a flat file registry or rich text-redaction replacements.
    Pass exactly one of ``registry`` or ``replacements``.
    """
    model_config = ConfigDict(extra="forbid")
    text: str = Field(max_length=_MAX_RESTORE_TEXT_CHARS)
    mode: Literal["original", "redacted"] = "original"
    registry: dict[str, str] | None = None
    replacements: dict[str, ReplacementInfo] | None = None

class RestoreResponse(BaseModel):
    """Response body containing restored text and replacement counts."""
    # Text after placeholders are substituted back to real values.
    final_text: str
    replacements: int = 0
    unmatched_placeholders: list[str] = []

# --------------------------------------------------------------------------
# Health
# --------------------------------------------------------------------------

class HealthResponse(BaseModel):
    """Response body for service health and pipeline readiness."""
    status: str = "ok"
    version: str
    auth_enabled: bool
    # File redaction is always ready; text sanitization depends on model loading.
    redact_ready: bool = True
    sanitize_ready: bool = False
    sanitize_degraded_reason: str | None = None
    # True while the models load after start-up: sanitize_ready is False then
    # without the sanitizer being degraded.
    sanitize_warming_up: bool = False
    # True until a warm-up has ever started: the models load on first use.
    sanitize_dormant: bool = False
    # NER status; regex/spaCy still work even if it is down.
    ner_backend: str = "none"
    # Download of the PII model. Requests that need NER return
    # 503 pii_model_not_ready until the PII model is active and loaded.
    models_state: ModelsState = "pending"
    models_done_bytes: int = 0
    models_total_bytes: int = 0
    models_error: str | None = None


class PrivacyModelsStatusResponse(BaseModel):
    """Download and activation state exposed to the desktop settings UI."""

    models_state: ModelsState
    models_done_bytes: int = 0
    models_total_bytes: int = 0
    models_error: str | None = None
    models_present: bool = False

# --------------------------------------------------------------------------
# Protect file (mode-aware pipeline)
# --------------------------------------------------------------------------

class ProtectFileResponse(BaseModel):
    """Body returned by ``POST /v1/file/protect``.
    Includes an ``operation_id`` so session endpoints can rewrite queries and
    restore responses for the same masked file.
    """
    success: bool
    masked_file_path: str | None = None
    final_answer: Any | None = None
    error_message: str | None = None
    # Present when masking succeeded and the operation was saved for the session.
    operation_id: str | None = None
    # Which resolver produced this result: "dps", "llm", "none", or None on failure.
    resolved_by: str | None = None
    # Set when the result is a lower-confidence fallback (LLM leg failed so the
    # sub-threshold DPS result was returned instead of reporting total failure).
    degraded_reason: str | None = None
    # Aggregate-only metadata; never contains entity values or placeholders.
    masking_summary: MaskingSummary | None = None

class ProtectFileBatchRequest(BaseModel):
    """Body for ``POST /v1/file/protect/batch``.
    Protects multiple files in one request so a downstream agent can hand all
    of their masked outputs to a single analysis call. Each file is otherwise
    processed exactly as ``/v1/file/protect`` would process it alone — its own
    operation_id, its own registry, no cross-file placeholder merging.
    """
    model_config = ConfigDict(extra="forbid")
    source_file_paths: list[str] = Field(min_length=1)
    session_id: str | None = None
    deterministic_only: bool = False

class ProtectFileBatchItem(ProtectFileResponse):
    """One file's result within a batch protect response.
    Carries ``source_file_path`` so the caller can correlate each result back
    to the file that produced it (order in ``results`` also matches the
    request's ``source_file_paths`` order).
    """
    source_file_path: str

class ProtectFileBatchResponse(BaseModel):
    """Body returned by ``POST /v1/file/protect/batch``."""
    results: list[ProtectFileBatchItem]

# --------------------------------------------------------------------------
# Session query-rewrite / response-restore
# --------------------------------------------------------------------------

class QueryRewriteRequest(BaseModel):
    """Body for ``POST /v1/session/query/rewrite``.
    Replaces real entity values in a query with placeholders from a saved file
    masking operation.
    """
    model_config = ConfigDict(extra="forbid")
    session_id: str = Field(max_length=256)
    # If omitted, the latest non-expired file operation for the session is used.
    operation_id: str | None = Field(default=None, max_length=64)
    query: str = Field(max_length=_MAX_TEXT_CHARS)

class QueryRewriteResponse(BaseModel):
    """Response body containing the placeholder-aligned query."""
    rewritten_query: str
    substitutions: int = 0

class SessionRestoreRequest(BaseModel):
    """Body for ``POST /v1/session/response/restore``.
    Restores placeholders in an agent response using a saved file masking
    operation.
    """
    model_config = ConfigDict(extra="forbid")
    session_id: str = Field(max_length=256)
    # If omitted, the latest non-expired file operation for the session is used.
    operation_id: str | None = Field(default=None, max_length=64)
    text: str = Field(max_length=_MAX_RESTORE_TEXT_CHARS)

class SessionRestoreResponse(BaseModel):
    """Response body containing a restored agent response."""
    final_text: str
    replacements: int = 0
    unmatched_placeholders: list[str] = []
