"""File-based protection backend — model-free core, optional injected NER.

Detect, mask, and restore PII in tabular files (CSV / XLSX / Parquet).
The package itself is pure-Python (pandas + regex + checksums) and imports
nothing from the text backend or the FastAPI service, so it can be
vendored standalone. Its detection can OPTIONALLY be sharpened for soft
named-entity types (PERSON/ORG/CITY/…) by an ``EntityColumnClassifier``
injected by the service layer — but the ML model is never imported here;
it arrives as a plain callable, so "model-free package, model-assisted
detection" both hold.

  - detect:    3-signal heuristic detection + optional injected NER (Tier 4)
  - masker:    whole-cell + sub-cell free-text masking
  - registry:  load / save / invert the placeholder registry
  - restore:   restore_text + restore_file
  - rewrite:   rewrite a query using the inverted registry
  - io:        CSV / XLSX / Parquet reader-writer
  - documents: free-form document masking (txt / md / html / docx)
  - gazetteer: offline first-name set (PERSON precision)
  - agents:    data-prep / redact / restoration orchestration classes
"""

from file_protection.detect import (
    ColumnSuggestion,
    merge_suggestions,
    suggest_sensitive_columns,
    to_sensitive_columns,
)
from file_protection.documents import (
    SUPPORTED_DOCUMENT_SUFFIXES,
    DocumentMaskResult,
    DocumentRestoreResult,
    is_binary_document,
    is_document,
    mask_document,
    restore_document,
)
from file_protection.masker import mask_dataframe, mask_records
from file_protection.registry import (
    RegistryError,
    invert_registry,
    load_registry,
    save_registry,
)
from file_protection.restore import restore_file, restore_text
from file_protection.rewrite import rewrite_query

__version__ = "0.1.0"

__all__ = [
    "ColumnSuggestion",
    "suggest_sensitive_columns",
    "to_sensitive_columns",
    "merge_suggestions",
    "mask_dataframe",
    "mask_records",
    "load_registry",
    "save_registry",
    "invert_registry",
    "RegistryError",
    "restore_file",
    "restore_text",
    "rewrite_query",
    "mask_document",
    "restore_document",
    "is_document",
    "is_binary_document",
    "DocumentMaskResult",
    "DocumentRestoreResult",
    "SUPPORTED_DOCUMENT_SUFFIXES",
]
