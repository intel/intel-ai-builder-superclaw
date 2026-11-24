"""Post-masking review: list masked entities and mask user-supplied extra terms.

The masking pipeline can miss values (e.g. a vendor name). Before the masked
file is handed to a cloud model, the user reviews what was masked and may add
words that must also be masked. Original values returned here go only to the
local user-facing caller; they never travel through model context.
"""

from __future__ import annotations

import logging
import re
import threading
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, ConfigDict, Field

from llm_pipeline.utils.registry_io import write_registry_json

from protection_service.app_state import ProtectionAppState
from protection_service.io.registry_delivery import load_placeholder_registry
from protection_service.io.review_files import SUPPORTED_EXTENSIONS, render_preview, transform_strings
from protection_service.io.session_utils import scope_session_id
from protection_service.io.workspace_paths import resolve_workspace_path_to_host
from protection_service.masking_summary import MaskingSummary, summarize_masking_registry
from protection_service.pii_registry_store import OperationRecord

logger = logging.getLogger(__name__)

EXTRA_TERM_CATEGORY = "CUSTOM_TERM"
MAX_EXTRA_TERMS = 50
MIN_TERM_CHARS = 2
MAX_TERM_CHARS = 200
MAX_PREVIEW_CHARS = 400_000
# Mirrors the batch namespace stride so a batched file keeps its numeric range.
_NAMESPACE_STRIDE = 1_000_000

_PLACEHOLDER_RE = re.compile(r"^<([A-Za-z][A-Za-z0-9_]*)_(\d+)>$")

# Also matches a placeholder typed without its angle brackets, as the "Masked:" list shows it.
_LOOSE_PLACEHOLDER_RE = re.compile(r"^<*([A-Za-z][A-Za-z0-9_]*)_(\d+)>*$")

_locks_guard = threading.Lock()
_operation_locks: dict[tuple[str, str], threading.Lock] = {}


def _operation_lock(registry_path: str, operation_id: str) -> threading.Lock:
    with _locks_guard:
        return _operation_locks.setdefault((registry_path, operation_id), threading.Lock())


class ReviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    session_id: str = Field(max_length=256)
    operation_id: str = Field(min_length=1, max_length=64)


class MaskedEntity(BaseModel):
    placeholder: str
    category: str
    value: str


class ReviewResponse(BaseModel):
    entities: list[MaskedEntity]
    supports_extra_terms: bool
    masked_text: str | None = None
    masked_text_truncated: bool = False
    file_extension: str = ""
    preview_format: str = "text"


class ExtraTermsRequest(ReviewRequest):
    terms: list[str] = Field(min_length=1, max_length=MAX_EXTRA_TERMS)


class SummaryResponse(BaseModel):
    masking_summary: MaskingSummary | None = None


class ExtraTermsResponse(BaseModel):
    added: list[MaskedEntity]
    not_found: list[str]


def _is_valid_term(term: str) -> bool:
    return MIN_TERM_CHARS <= len(term) <= MAX_TERM_CHARS and not _LOOSE_PLACEHOLDER_RE.fullmatch(term)


def clean_terms(terms: list[str]) -> list[str]:
    """Trim, drop placeholders and out-of-range entries, and dedupe case-insensitively."""
    seen: set[str] = set()
    cleaned: list[str] = []
    for raw in terms:
        term = raw.strip()
        if not _is_valid_term(term) or term.casefold() in seen:
            continue
        seen.add(term.casefold())
        cleaned.append(term)
    return cleaned


def rejected_terms(terms: list[str]) -> list[str]:
    """Non-blank terms that cannot be masked, so the caller can report them instead of dropping."""
    rejected: list[str] = []
    for raw in terms:
        term = raw.strip()
        if term and not _is_valid_term(term) and term not in rejected:
            rejected.append(term)
    return rejected


def _term_pattern(term: str) -> re.Pattern[str]:
    # Word boundaries only where the term edge is a word char, so "Co." still matches.
    prefix = r"(?<!\w)" if re.match(r"\w", term) else ""
    suffix = r"(?!\w)" if re.search(r"\w$", term) else ""
    return re.compile(f"{prefix}{re.escape(term)}{suffix}", re.IGNORECASE)


def _entities(registry: dict[str, str]) -> list[MaskedEntity]:
    entities: list[MaskedEntity] = []
    for placeholder, value in registry.items():
        match = _PLACEHOLDER_RE.fullmatch(placeholder)
        if match is not None:
            entities.append(
                MaskedEntity(
                    placeholder=placeholder,
                    category=match.group(1).upper(),
                    value=value,
                )
            )
    return entities


def _next_extra_number(registry: dict[str, str], namespace_base: int = 0) -> int:
    numbers = [
        int(m.group(2))
        for key in registry
        if (m := _PLACEHOLDER_RE.fullmatch(key)) is not None
    ]
    base = max((max(numbers, default=0) // _NAMESPACE_STRIDE) * _NAMESPACE_STRIDE, namespace_base)
    extra = [
        int(m.group(2))
        for key in registry
        if (m := _PLACEHOLDER_RE.fullmatch(key)) is not None
        and m.group(1).upper() == EXTRA_TERM_CATEGORY
    ]
    return max(max(extra, default=0), base) + 1


_batch_namespaces: dict[str, int] = {}


def record_batch_namespace(registry_path: str, file_index: int) -> None:
    """Remember a batched file's placeholder range so extra words stay unique when its registry is empty.

    Held in memory, not on disk: the range only matters while the review is open, and a
    restart falls back to the registry's own numbering instead of leaving files in the workspace.
    """
    with _locks_guard:
        _batch_namespaces[registry_path] = file_index


def namespace_base_for(registry_path: str) -> int:
    with _locks_guard:
        return max(_batch_namespaces.get(registry_path, 0), 0) * _NAMESPACE_STRIDE


def _term_patterns(terms: list[str]) -> list[tuple[str, re.Pattern[str]]]:
    # Longest first so "Acme Corp" wins over "Acme".
    return [(t, _term_pattern(t)) for t in sorted(clean_terms(terms), key=len, reverse=True)]


def plan_extra_terms(
    registry: dict[str, str],
    patterns: list[tuple[str, re.Pattern[str]]],
    found: set[str],
    namespace_base: int = 0,
) -> tuple[list[tuple[re.Pattern[str], str]], dict[str, str], list[MaskedEntity], list[str]]:
    """Assign placeholders to the terms in ``found``; pure, no I/O."""
    updated = dict(registry)
    substitutions: list[tuple[re.Pattern[str], str]] = []
    added: list[MaskedEntity] = []
    not_found: list[str] = []
    counter = _next_extra_number(registry, namespace_base)
    for term, pattern in patterns:
        if term not in found:
            not_found.append(term)
            continue
        placeholder = f"<{EXTRA_TERM_CATEGORY}_{counter}>"
        counter += 1
        substitutions.append((pattern, placeholder))
        updated[placeholder] = term
        added.append(
            MaskedEntity(placeholder=placeholder, category=EXTRA_TERM_CATEGORY, value=term)
        )
    return substitutions, updated, added, not_found


def substitute(text: str, substitutions: list[tuple[re.Pattern[str], str]]) -> str:
    for pattern, placeholder in substitutions:
        text = pattern.sub(lambda _m, p=placeholder: p, text)
    return text


def apply_extra_terms(
    text: str, registry: dict[str, str], terms: list[str]
) -> tuple[str, dict[str, str], list[MaskedEntity], list[str]]:
    """Mask ``terms`` in ``text`` and extend ``registry``; pure, no I/O."""
    patterns = _term_patterns(terms)
    found = {term for term, pattern in patterns if pattern.search(text)}
    substitutions, updated, added, not_found = plan_extra_terms(registry, patterns, found)
    return substitute(text, substitutions), updated, added, not_found


def register_review_routes(app: FastAPI, state: ProtectionAppState) -> None:
    """Register ``/v1/file/protect/review`` and ``/v1/file/protect/extra-terms``."""
    config = state.config
    pii_registry_store = state.pii_registry_store
    auth_dep = state.auth_dep

    def _record(req: ReviewRequest, http_req: Request) -> OperationRecord:
        scoped = scope_session_id(req.session_id, config, http_req)
        record = pii_registry_store.get_operation(scoped, req.operation_id) if scoped else None
        if record is None or not record.registry_path:
            raise HTTPException(
                status_code=404,
                detail={
                    "error": "operation_not_found",
                    "message": "No matching masking operation found for this session.",
                },
            )
        return record

    def _load(record: OperationRecord) -> dict[str, str]:
        try:
            return load_placeholder_registry(record.registry_path or "")
        except (FileNotFoundError, ValueError, OSError) as exc:
            raise HTTPException(
                status_code=404,
                detail={
                    "error": "registry_expired",
                    "message": "Registry file has expired or been removed.",
                },
            ) from exc

    def _masked_host_path(record: OperationRecord) -> Path:
        return Path(resolve_workspace_path_to_host(record.masked_path or ""))

    @app.post(
        "/v1/file/protect/review",
        response_model=ReviewResponse,
        dependencies=[Depends(auth_dep)],
        tags=["file"],
        summary="List what a protect operation masked, for user review.",
    )
    async def review_masked_entities(req: ReviewRequest, http_req: Request) -> ReviewResponse:
        record = _record(req, http_req)
        registry = await run_in_threadpool(_load, record)
        masked_path = _masked_host_path(record) if record.masked_path else None
        extension = masked_path.suffix.lower() if masked_path else ""
        supports = extension in SUPPORTED_EXTENSIONS
        text: str | None = None
        preview_format = "text"
        truncated = False
        if supports and masked_path is not None:
            try:
                text, preview_format, truncated = await run_in_threadpool(
                    render_preview, masked_path, MAX_PREVIEW_CHARS
                )
            except Exception as exc:  # noqa: BLE001 — a preview failure must not block the review
                logger.warning(
                    "data_protection endpoint=file.review step=preview_failed exc_type=%s",
                    exc.__class__.__name__,
                )
        return ReviewResponse(
            entities=_entities(registry),
            supports_extra_terms=supports,
            masked_text=text,
            masked_text_truncated=truncated,
            file_extension=extension,
            preview_format=preview_format,
        )

    @app.post(
        "/v1/file/protect/summary",
        response_model=SummaryResponse,
        dependencies=[Depends(auth_dep)],
        tags=["file"],
        summary="Aggregate masking counts for an operation, including user-added words.",
    )
    async def masking_summary(req: ReviewRequest, http_req: Request) -> SummaryResponse:
        record = _record(req, http_req)
        registry = await run_in_threadpool(_load, record)
        return SummaryResponse(masking_summary=summarize_masking_registry(registry))

    @app.post(
        "/v1/file/protect/extra-terms",
        response_model=ExtraTermsResponse,
        dependencies=[Depends(auth_dep)],
        tags=["file"],
        summary="Additionally mask user-supplied words in an already-masked file.",
    )
    async def mask_extra_terms(req: ExtraTermsRequest, http_req: Request) -> ExtraTermsResponse:
        record = _record(req, http_req)
        masked_path = _masked_host_path(record)
        if not record.masked_path or masked_path.suffix.lower() not in SUPPORTED_EXTENSIONS:
            raise HTTPException(
                status_code=415,
                detail={
                    "error": "unsupported_file_type",
                    "message": (
                        "Extra-term masking supports .csv, .txt, .md, .html, .htm, "
                        ".xlsx, .xlsm, .parquet and .docx files."
                    ),
                },
            )

        def _apply() -> ExtraTermsResponse:
            # Serialised per operation so a retry cannot allocate the same token twice.
            with _operation_lock(record.registry_path or "", req.operation_id):
                return _apply_locked()

        def _apply_locked() -> ExtraTermsResponse:
            registry = _load(record)
            patterns = _term_patterns(req.terms)
            found: set[str] = set()

            def detect(value: str) -> str:
                found.update(t for t, p in patterns if t not in found and p.search(value))
                return value

            try:
                transform_strings(masked_path, detect, write=False)
            except (OSError, ValueError, UnicodeDecodeError) as exc:
                raise HTTPException(
                    status_code=404,
                    detail={
                        "error": "masked_file_unreadable",
                        "message": "The masked file could not be read.",
                    },
                ) from exc
            substitutions, new_registry, added, not_found = plan_extra_terms(
                registry, patterns, found, namespace_base_for(record.registry_path or "")
            )
            not_found.extend(t for t in rejected_terms(req.terms) if t not in not_found)
            if added:
                # Registry first: a failed file write then leaves extra restorable keys, never a
                # masked file whose placeholders cannot be restored.
                write_registry_json(new_registry, Path(record.registry_path or ""), indent=2)
                transform_strings(
                    masked_path, lambda value: substitute(value, substitutions), write=True
                )
            logger.info(
                "data_protection endpoint=file.extra_terms operation_id=%s added=%d not_found=%d",
                req.operation_id, len(added), len(not_found),
            )
            return ExtraTermsResponse(added=added, not_found=not_found)

        return await run_in_threadpool(_apply)
