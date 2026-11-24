"""Module-level constants for the data-protection service.

Groups:
* Workspace path mapping — container/host prefix translation.
* Request body limits — body-size cap components.
* File type classification — extension sets for routing decisions.
* LLMRouter settings — default URL and timeout.
* Protection defaults — fallback mode, threshold, and confidence.
* Downstream agent prompt — system prompt injected into redaction responses.
* Data preparation error types — user-input error categories that return 400.
"""

from __future__ import annotations

import os
from pathlib import Path

# ---------------------------------------------------------------------------
# Workspace path mapping
# ---------------------------------------------------------------------------

# Sandbox agents see /workspace/... paths; this service runs on the Windows host.
WORKSPACE_CONTAINER_PREFIX = "/workspace"
WORKSPACE_ROOT = Path(
    os.environ.get("WINDOWS_SUPERCLAW_PATH") or Path.home() / "SuperClawProjects"
)

# Shared output folder for DPS and llm_pipeline masked files.
DATA_PROTECTION_WORKSPACE = WORKSPACE_ROOT / "data_protection_workspace"

# ---------------------------------------------------------------------------
# Request body limits
# ---------------------------------------------------------------------------

# Raw request body cap = source-file limit + framing slack, with a 16 MiB floor
# so JSON text-redaction requests still fit when file limits are small.
FRAMING_SLACK_BYTES = 1 * 1024 * 1024
MIN_BODY_CAP_BYTES = 16 * 1024 * 1024

# ---------------------------------------------------------------------------
# File type classification
# ---------------------------------------------------------------------------

# LLM column detection only supports these tabular formats. Other files fall
# back to DPS even when mode=llm is configured.
LLM_SUPPORTED_EXTENSIONS: frozenset[str] = frozenset({".csv", ".xlsx", ".xls", ".xlsm"})

# Prose documents use span masking, not tabular column detection.
DOCUMENT_EXTENSIONS: frozenset[str] = frozenset({".txt", ".md", ".html", ".htm", ".docx"})

# ---------------------------------------------------------------------------
# LLMRouter settings
# ---------------------------------------------------------------------------

# Default base URL for the llmrouter data-protection API; overridden by LRM_BASE_URL env var.
LLMROUTER_DEFAULT_BASE_URL = "http://127.0.0.1:18321"
# Timeout for the llmrouter settings fetch — kept short so a slow service falls back quickly.
LLMROUTER_FETCH_TIMEOUT_SECONDS = 3.0

# ---------------------------------------------------------------------------
# Protection defaults
# ---------------------------------------------------------------------------

# Fallback values used when llmrouter is unreachable or returns unexpected data.
DEFAULT_PROTECTION_MODE = "none"
DEFAULT_HYBRID_THRESHOLD = 0.75
DEFAULT_MIN_CONFIDENCE = 0.5

# ---------------------------------------------------------------------------
# Downstream agent prompt
# ---------------------------------------------------------------------------

# System prompt injected by redaction responses to guide downstream LLM agents.
RECOMMENDED_SYSTEM_PROMPT = (
    "You are a careful data analyst. Use ONLY the masked CSV provided. "
    "Entity names appear as placeholders like <ORG_1>, <PERSON_1>, <EMAIL_1>. "
    "Keep these placeholders verbatim in your answer -- never invent or "
    "guess real values."
)

# ---------------------------------------------------------------------------
# Data preparation error types
# ---------------------------------------------------------------------------

# User-input failures from table loading/prep that should return 400. Other
# exceptions are treated as bugs and allowed to surface as 500s.
DATA_PREP_USER_ERRORS: tuple[type[BaseException], ...] = (
    ValueError,
    OSError,
    UnicodeDecodeError,
    KeyError,
)
