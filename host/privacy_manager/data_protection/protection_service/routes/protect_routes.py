"""File protect and LLM-pipeline route registration (requires llm_pipeline)."""

from __future__ import annotations

import asyncio
import json
import logging
import time
import os
import re
import shutil
from pathlib import Path

import httpx
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool

from llm_pipeline.api.server import run_protected_file_pipeline as _llm_pipeline
from llm_pipeline.src.clients.llm_client import LLMClient as _LLMClient, NoLocalProviderError
from llm_pipeline.src.schemas.api import (
    PipelineApiRequest as _AutoPipelineRequest,
    PipelineApiRequest as _LlmRequest,
    PipelineApiResponse as _LlmResponse,
)
from llm_pipeline.utils.paths import (
    FileIdentity,
    capture_file_identity,
    reject_reparse_components,
)

from common.errors import SanitizerUnavailable
from protection_service.app_state import ProtectionAppState
from protection_service.constants import (
    DEFAULT_HYBRID_THRESHOLD,
    DEFAULT_MIN_CONFIDENCE,
    DEFAULT_PROTECTION_MODE,
    DOCUMENT_EXTENSIONS,
    LLMROUTER_DEFAULT_BASE_URL,
    LLMROUTER_FETCH_TIMEOUT_SECONDS,
    LLM_SUPPORTED_EXTENSIONS,
)
from protection_service.io.registry_delivery import (
    load_placeholder_registry,
    restore_text_from_registry,
)
from protection_service.io.source_validation import validate_source_path
from protection_service.io.run_trace import (
    current_operation_id,
    traced_pipeline_run,
)
from protection_service.io.session_utils import new_operation_id, scope_session_id
from protection_service.io.workspace_paths import (
    mirror_masked_output_to_registry_path,
    resolve_workspace_path_to_host,
    summarize_source_for_logs,
)
from protection_service.masking_summary import MaskingSummary, summarize_masking_registry
from protection_service.routes.review_routes import record_batch_namespace
from protection_service.redaction.file_redaction import (
    detect_and_redact_file_sync,
    redact_file_sync,
)
from protection_service.schemas import (
    ProtectFileBatchItem,
    ProtectFileBatchRequest,
    ProtectFileBatchResponse,
    ProtectFileResponse,
    RedactRequest,
)

logger = logging.getLogger(__name__)

# Matches a canonical <CATEGORY_N> placeholder, e.g. <PERSON_1>, <CUSTOMER_NAME_4>.
_CATEGORY_PLACEHOLDER_RE = re.compile(r"<([A-Za-z_]+)_(\d+)>")
# Per-file multiplier folded into the trailing counter so a namespaced token
# still matches the <CATEGORY_N> shape restore/rewrite already expect — large
# enough that no realistic single file produces this many placeholders in one
# category, so two files' ranges can never overlap.
_BATCH_NAMESPACE_MULTIPLIER = 1_000_000

LLMROUTER_WARN_INTERVAL_SECONDS = 300.0
_last_llmrouter_warning: float | None = None

class _ProtectedFileRequest(_AutoPipelineRequest):
    # Only cap masking at DPS; never lower the protection to "none"
    deterministic_only: bool = False


async def _summarize_registry_path(
    registry_path: str | None,
    *,
    operation_id: str,
) -> MaskingSummary | None:
    """Build a PII-free summary from a persisted placeholder registry."""
    if not registry_path:
        return None
    try:
        registry = await run_in_threadpool(load_placeholder_registry, registry_path)
    except (OSError, ValueError, UnicodeError) as exc:
        logger.warning(
            "data_protection operation_id=%s endpoint=file.protect "
            "step=masking_summary_unavailable exc_type=%s",
            operation_id, exc.__class__.__name__,
        )
        return None
    return summarize_masking_registry(registry)


def _capture_authorized_source_identity(
    source_file_path: str, max_source_bytes: int
) -> FileIdentity:
    """Capture the validated source identity or report a safe client error."""
    try:
        identity = capture_file_identity(source_file_path)
    except (OSError, RuntimeError, ValueError) as exc:
        raise HTTPException(
            status_code=400,
            detail={
                "error": "source_changed",
                "message": "Source file changed after validation.",
            },
        ) from exc

    if max_source_bytes > 0 and identity.size > max_source_bytes:
        raise HTTPException(
            status_code=413,
            detail={
                "error": "source_too_large",
                "message": "Source file exceeds configured redact.max_source_bytes.",
            },
        )
    return identity


def _namespace_placeholders_for_batch_file(
    masked_file_path: str, registry_path: str, *, file_index: int,
) -> None:
    """Fold ``file_index`` into every placeholder's trailing counter.

    Every file's masking restarts each category's counter at 1, so two files
    in one batch routinely produce the identical token (e.g. ``<PERSON_1>``)
    for two different real values. Left alone, a single combined ``build``
    response mixing placeholders from multiple files cannot be restored
    correctly — sequential per-operation restore would apply whichever
    operation's registry runs first to every matching occurrence. Renumbering
    each file's placeholders (and its registry keys, identically) to a
    disjoint numeric range makes collisions structurally impossible.

    Best-effort and fails closed: on any error, this leaves the file's
    placeholders and registry exactly as they were (never a partial rename),
    matching the pre-batch single-file behavior for that one file. The
    registry is loaded and renamed in memory before the masked file is ever
    touched on disk, so a registry failure can never leave the two out of sync.

    Args:
        masked_file_path: Sandbox-visible masked output path from a single-file
            ``protect_file`` call.
        registry_path: Host path of that operation's registry JSON file.
        file_index: 1-based position of this file within the batch request.
    """

    record_batch_namespace(registry_path, file_index)

    def _renumber(match: "re.Match[str]") -> str:
        category, number = match.group(1), match.group(2)
        return f"<{category}_{file_index * _BATCH_NAMESPACE_MULTIPLIER + int(number)}>"

    try:
        reject_reparse_components(Path(registry_path))
        with open(registry_path, encoding="utf-8") as f:
            registry: dict[str, str] = json.load(f)
    except (OSError, ValueError, UnicodeDecodeError) as exc:
        logger.warning(
            "data_protection endpoint=file.protect_batch step=namespace_skip "
            "reason=registry_load_failed exc_type=%s", exc.__class__.__name__,
        )
        return
    renamed_registry = {
        _CATEGORY_PLACEHOLDER_RE.sub(_renumber, key)
        if _CATEGORY_PLACEHOLDER_RE.fullmatch(key)
        else key: value
        for key, value in registry.items()
    }

    host_masked_path = Path(resolve_workspace_path_to_host(masked_file_path))
    ext = host_masked_path.suffix.lower()
    try:
        reject_reparse_components(host_masked_path)
        if ext in (".csv", ".txt", ".md", ".html", ".htm"):
            text = host_masked_path.read_text(encoding="utf-8")
            renamed_text = _CATEGORY_PLACEHOLDER_RE.sub(_renumber, text)
            if renamed_text != text:
                host_masked_path.write_text(renamed_text, encoding="utf-8")
        elif ext == ".parquet":
            import pandas as pd

            df = pd.read_parquet(host_masked_path)
            for col in df.columns:
                if df[col].dtype == object:
                    df[col] = df[col].map(
                        lambda v: _CATEGORY_PLACEHOLDER_RE.sub(_renumber, v)
                        if isinstance(v, str) else v
                    )
            df.to_parquet(host_masked_path, index=False)
        elif ext == ".docx":
            import docx

            document = docx.Document(str(host_masked_path))

            def _rename_runs(paragraphs: object) -> None:
                for paragraph in paragraphs:
                    for run in paragraph.runs:
                        if run.text and "<" in run.text:
                            run.text = _CATEGORY_PLACEHOLDER_RE.sub(_renumber, run.text)

            _rename_runs(document.paragraphs)
            for table in document.tables:
                for row in table.rows:
                    for cell in row.cells:
                        _rename_runs(cell.paragraphs)
            document.save(str(host_masked_path))
        else:
            logger.warning(
                "data_protection endpoint=file.protect_batch step=namespace_skip "
                "reason=unsupported_extension ext=%s", ext,
            )
            return
    except Exception as exc:  # noqa: BLE001 — namespacing is best-effort, never fatal
        logger.warning(
            "data_protection endpoint=file.protect_batch step=namespace_failed "
            "exc_type=%s", exc.__class__.__name__,
        )
        return

    try:
        with open(registry_path, "w", encoding="utf-8") as f:
            json.dump(renamed_registry, f, ensure_ascii=False, indent=2)
    except OSError as exc:
        logger.warning(
            "data_protection endpoint=file.protect_batch step=namespace_registry_write_failed "
            "exc_type=%s", exc.__class__.__name__,
        )

def _warn_llmrouter_unreachable(base_url: str) -> None:
    """Log the LRM-unreachable fallback at WARNING at most once per interval."""
    global _last_llmrouter_warning
    now = time.monotonic()
    level = logging.DEBUG
    if (
        _last_llmrouter_warning is None
        or now - _last_llmrouter_warning >= LLMROUTER_WARN_INTERVAL_SECONDS
    ):
        _last_llmrouter_warning = now
        level = logging.WARNING
    logger.log(
        level,
        "file protect: llmrouter unreachable at %s or returned unexpected data; "
        "falling back to defaults (mode=%s threshold=%.2f)",
        base_url, DEFAULT_PROTECTION_MODE, DEFAULT_HYBRID_THRESHOLD,
    )

async def fetch_file_protection_settings() -> tuple[str, float]:
    """Fetch the current data-protection mode and hybrid threshold from llmrouter.

    Returns:
        tuple[str, float]: Active mode string and hybrid threshold clamped to [0, 1].
            Falls back to defaults when llmrouter is unreachable.
    """
    llmrouter_base_url = os.environ.get("LRM_BASE_URL", LLMROUTER_DEFAULT_BASE_URL).rstrip("/")
    try:
        # trust_env=False: llmrouter is a loopback sidecar (127.0.0.1); a
        # corporate HTTP_PROXY must not intercept it, and httpx does not honor
        # NO_PROXY CIDR entries such as 127.0.0.0/8. Pin a direct connection.
        async with httpx.AsyncClient(
            timeout=LLMROUTER_FETCH_TIMEOUT_SECONDS, trust_env=False
        ) as client:
            api_key = os.environ.get("LRM_API_KEY", "").strip()
            headers = {"Authorization": f"Bearer {api_key}"} if api_key else None
            mode_res, thr_res = await asyncio.gather(
                client.get(
                    f"{llmrouter_base_url}/llm-router/v1/data-protection/mode",
                    headers=headers,
                ),
                client.get(
                    f"{llmrouter_base_url}/llm-router/v1/data-protection/hybrid-threshold",
                    headers=headers,
                ),
            )
        mode = str(mode_res.json().get("applied", DEFAULT_PROTECTION_MODE)).strip().lower()
        if mode not in {"none", "deterministic", "hybrid", "llm"}:
            mode = DEFAULT_PROTECTION_MODE
        threshold = float(thr_res.json().get("applied", DEFAULT_HYBRID_THRESHOLD))
        threshold = max(0.0, min(1.0, threshold))
        return mode, threshold
    except (httpx.HTTPError, httpx.TimeoutException, ValueError, KeyError, AttributeError, json.JSONDecodeError):
        _warn_llmrouter_unreachable(
            llmrouter_base_url
        )
        return DEFAULT_PROTECTION_MODE, DEFAULT_HYBRID_THRESHOLD


def register_protect_routes(app: FastAPI, state: ProtectionAppState) -> None:
    """Register protected-file endpoints.

    Source preflight remains available without the optional LLM pipeline;
    masking routes are registered only when that package is importable.

    Args:
        app: FastAPI application instance.
        state: App-scoped state.
    """
    config = state.config
    auth_dep = state.auth_dep

    @app.post(
        "/v1/file/preflight",
        dependencies=[Depends(auth_dep)],
        tags=["file"],
        summary="Validate a source file before protected-file approval.",
    )
    async def preflight_file(req: _AutoPipelineRequest) -> dict[str, bool]:
        """Validate a selected source path without reading or masking its content.

        Raises:
            HTTPException: 400 for an invalid source path; 413 when the file
                exceeds ``redact.max_source_bytes``.
        """
        if not req.source_file_path.strip():
            raise HTTPException(
                status_code=400,
                detail={
                    "error": "missing_source_file_path",
                    "message": "source_file_path must be non-empty.",
                },
            )
        validate_source_path(req.source_file_path, config.redact)
        # Protect follows an approved preflight; start loading the models now.
        state.sanitize_mgr.start_initialize()
        return {"success": True}

    if _llm_pipeline is None:
        return

    redacts_store = state.redacts_store
    sanitize_mgr = state.sanitize_mgr
    pii_registry_store = state.pii_registry_store

    @app.post(
        "/v1/file/protect",
        response_model=ProtectFileResponse,
        dependencies=[Depends(auth_dep)],
        tags=["file"],
        summary="Protect a file using the current data-protection mode.",
    )
    @traced_pipeline_run
    async def protect_file(req: _ProtectedFileRequest, http_req: Request) -> ProtectFileResponse:
        """Protect a file using the currently configured protection mode.

        Fetches mode and hybrid threshold from llmrouter, then dispatches to
        no-op (``none``), deterministic DPS, LLM pipeline, or hybrid
        DPS-first-with-LLM-fallback.

        Args:
            req: File protection request.
            http_req: HTTP request used to scope session ids.

        Returns:
            ProtectFileResponse: Selected pipeline result and operation id.

        Raises:
            HTTPException: 400 if ``source_file_path`` is empty, missing, or
                outside ``redact.source_roots``; 413 if it exceeds
                ``redact.max_source_bytes``.
        """
        operation_id = current_operation_id() or new_operation_id()
        if not req.source_file_path.strip():
            raise HTTPException(
                status_code=400,
                detail={
                    "error": "missing_source_file_path",
                    "message": "source_file_path must be non-empty.",
                },
            )

        # 1. Fetch current mode and threshold from llmrouter (falls back if unreachable).
        mode, threshold = await fetch_file_protection_settings()
        if req.deterministic_only and mode != "none":
            mode = "deterministic"

        # 2. Map sandbox /workspace/... path to Windows host path.
        resolved_path = resolve_workspace_path_to_host(req.source_file_path)
        ext = Path(resolved_path).suffix.lower()
        source_ext, source_size, workspace_path = summarize_source_for_logs(resolved_path)
        _, _, caller_workspace_path = summarize_source_for_logs(req.source_file_path)

        logger.info(
            "data_protection operation_id=%s endpoint=file.protect step=settings_resolved "
            "mode=%s threshold=%.3f source_ext=%s source_size_bytes=%s "
            "workspace_path=%s caller_workspace_path=%s",
            operation_id, mode, threshold, source_ext, source_size,
            workspace_path, caller_workspace_path,
        )

        # Mode = none: skip all protection.
        if mode == "none":
            logger.info(
                "data_protection operation_id=%s endpoint=file.protect step=completed "
                "resolved_by=none protection_applied=false",
                operation_id,
            )
            return ProtectFileResponse(
                success=True,
                masked_file_path=resolved_path,
                final_answer=None,
                error_message=None,
                operation_id=None,
                resolved_by="none",
            )
        resolved_path = str(validate_source_path(req.source_file_path, config.redact))
        max_source_bytes = int(getattr(config.redact, "max_source_bytes", 0) or 0)
        authorized_source_file_identity = _capture_authorized_source_identity(
            resolved_path, max_source_bytes
        )

        # ── per-request helpers ───────────────────────────────────────────────

        def mirror_dps_registry_to_workspace(
            masked_file_path: str | None, registry_file_path: str | None,
        ) -> str | None:
            """Copy a DPS registry into the visible ``mask_registries/`` folder.

            DPS registries are written to the private, TTL-managed redacts
            store by default. Copying into the workspace puts them next to
            their masked dataset, matching where the LLM pipeline already
            writes its registry. Best-effort: falls back to the private-store
            path if the masked path doesn't match the expected layout or the
            copy fails.
            """
            if not masked_file_path or not registry_file_path:
                return registry_file_path
            dest = mirror_masked_output_to_registry_path(masked_file_path)
            if dest is None:
                return registry_file_path
            try:
                shutil.copyfile(registry_file_path, dest)
            except OSError as exc:
                logger.warning(
                    "data_protection operation_id=%s endpoint=file.protect "
                    "step=dps_registry_mirror_failed exc_type=%s",
                    operation_id, exc.__class__.__name__,
                )
                return registry_file_path
            return str(dest)

        async def run_deterministic_file_protection() -> tuple[_LlmResponse, float | None, str | None]:
            """Run deterministic DPS masking for the current request.

            Returns:
                tuple: DPS result, minimum detected column confidence, registry path.
            """
            try:
                logger.info(
                    "data_protection operation_id=%s endpoint=file.protect step=dps_start "
                    "source_ext=%s document=%s",
                    operation_id, source_ext, ext in DOCUMENT_EXTENSIONS,
                )
                dps_req = RedactRequest(
                    source=resolved_path,
                    auto_pii=True,
                    min_confidence=DEFAULT_MIN_CONFIDENCE,
                    return_mode="path",
                    registry_return_mode="path",
                )

                # Document files use prose-span masking (no column detection).
                if ext in DOCUMENT_EXTENSIONS:
                    result = await run_in_threadpool(
                        redact_file_sync, Path(resolved_path), dps_req, config,
                        redacts_store, sanitize_mgr, owns_source=False,
                        operation_id=operation_id,
                    )
                    logger.info(
                        "data_protection operation_id=%s endpoint=file.protect "
                        "step=dps_completed document=true success=true masked_output=%s",
                        operation_id, result.masked_file_path is not None,
                    )
                    return _LlmResponse(
                        success=True,
                        masked_file_path=result.masked_file_path,
                        final_answer=None,
                        error_message=None,
                    ), None, mirror_dps_registry_to_workspace(
                        result.masked_file_path, result.registry_file_path,
                    )

                # Tabular files use detect + redact to get per-column confidence.
                result = await run_in_threadpool(
                    detect_and_redact_file_sync, Path(resolved_path), dps_req, config,
                    redacts_store, sanitize_mgr, owns_source=False,
                    operation_id=operation_id,
                )
                min_conf: float | None = None
                if result.suggestions:
                    confs = [
                        s.confidence for s in result.suggestions
                        if s.category is not None and isinstance(s.confidence, float)
                    ]
                    if confs:
                        min_conf = min(confs)

                logger.info(
                    "data_protection operation_id=%s endpoint=file.protect "
                    "step=dps_completed document=false success=true suggestions=%s "
                    "detected_columns=%s min_confidence=%s masked_output=%s",
                    operation_id, len(result.suggestions),
                    len(result.detected_sensitive_columns),
                    "n/a" if min_conf is None else f"{min_conf:.3f}",
                    result.masked_file_path is not None,
                )
                return (
                    _LlmResponse(
                        success=True,
                        masked_file_path=result.masked_file_path,
                        final_answer=None,
                        error_message=None,
                    ),
                    min_conf,
                    mirror_dps_registry_to_workspace(
                        result.masked_file_path, result.registry_file_path,
                    ),
                )
            except SanitizerUnavailable:
                # A 503 the caller can retry; never a DPS failure the LLM fallback answers.
                raise
            except Exception as exc:
                logger.warning(
                    "data_protection operation_id=%s endpoint=file.protect "
                    "step=dps_failed exc_type=%s",
                    operation_id, exc.__class__.__name__,
                )
                return _LlmResponse(
                    success=False, masked_file_path=None,
                    final_answer=None, error_message=str(exc),
                ), None, None

        async def run_llm_file_protection() -> tuple[_LlmResponse, str | None]:
            """Run the bundled LLM masking pipeline for the current request.

            Returns:
                tuple: LLM protection result and registry path.
            """
            if state.llm_client is None:
                state.llm_client = _LLMClient()
            try:
                logger.info(
                    "data_protection operation_id=%s endpoint=file.protect step=llm_start "
                    "source_ext=%s",
                    operation_id, source_ext,
                )
                result = await _llm_pipeline(
                    resolved_path,
                    state.llm_client,
                    session_id=req.session_id,
                    authorized_source_file_path=resolved_path,
                    authorized_source_file_identity=authorized_source_file_identity,
                )
                final = result.get("final_response")
                success = result.get("final_generation_result", {}).get("success", False)
                llm_reg: str | None = result.get("mask_registry_file_path")

                # The LLM analyzed the masked file, so its final_answer may
                # contain bare placeholders. Restore them before surfacing.
                raw_final_answer = final.final_answer if final else None
                final_answer: str | None = raw_final_answer
                if raw_final_answer and llm_reg:
                    logger.info(
                        "data_protection operation_id=%s endpoint=file.protect "
                        "step=llm_registry_load_start registry_path_set=true",
                        operation_id,
                    )
                    try:
                        reg = await run_in_threadpool(load_placeholder_registry, llm_reg)
                        logger.info(
                            "data_protection operation_id=%s endpoint=file.protect "
                            "step=llm_registry_loaded keys=%s",
                            operation_id, len(reg),
                        )
                        final_answer, _cnt, _unmatched = await run_in_threadpool(
                            restore_text_from_registry, raw_final_answer, reg
                        )
                        logger.info(
                            "data_protection operation_id=%s endpoint=file.protect "
                            "step=llm_final_answer_restored substitutions=%s unmatched=%s",
                            operation_id, _cnt, len(_unmatched),
                        )
                    except Exception as _exc:  # noqa: BLE001 — registry restore is best-effort
                        logger.warning(
                            "data_protection operation_id=%s endpoint=file.protect "
                            "step=llm_final_answer_restore_failed exc_type=%s exc=%s",
                            operation_id, _exc.__class__.__name__, str(_exc)[:200],
                        )
                else:
                    logger.info(
                        "data_protection operation_id=%s endpoint=file.protect "
                        "step=llm_registry_load_skipped reason=%s",
                        operation_id,
                        "no_final_answer" if not raw_final_answer else "no_registry_path",
                    )

                logger.info(
                    "data_protection operation_id=%s endpoint=file.protect step=llm_completed "
                    "success=%s masked_output=%s final_answer=%s registry=%s",
                    operation_id, success, bool(final and final.masked_file_path),
                    bool(final_answer), bool(llm_reg),
                )
                return _LlmResponse(
                    success=success,
                    masked_file_path=final.masked_file_path if final else None,
                    final_answer=final_answer,
                    error_message=result.get("error_message"),
                ), llm_reg
            except NoLocalProviderError:
                # Caller decides whether to fall back to deterministic-only
                # masking instead of surfacing this as an opaque LLM failure.
                raise
            except Exception as exc:  # noqa: BLE001 — llm_pipeline raises arbitrary types
                logger.warning(
                    "data_protection operation_id=%s endpoint=file.protect "
                    "step=llm_failed exc_type=%s",
                    operation_id, exc.__class__.__name__,
                )
                return _LlmResponse(
                    success=False, masked_file_path=None,
                    final_answer=None, error_message=str(exc),
                ), None

        def save_file_protection_operation(
            masked_path: str | None,
            registry_path: str | None,
        ) -> None:
            """Persist a successful protect operation for later session restore.

            Args:
                masked_path: Sandbox-visible masked output path.
                registry_path: Registry file path for later placeholder restore.
            """
            if req.session_id:
                pii_registry_store.save_operation(
                    session_id=scope_session_id(req.session_id, config, http_req),
                    operation_id=operation_id,
                    pipeline="file",
                    source_path=req.source_file_path,
                    masked_path=masked_path,
                    registry_path=registry_path,
                )
                logger.info(
                    "data_protection operation_id=%s endpoint=file.protect "
                    "step=session_op_saved masked_path_set=%s registry_path_set=%s",
                    operation_id, bool(masked_path), bool(registry_path),
                )
            else:
                logger.debug(
                    "data_protection operation_id=%s endpoint=file.protect "
                    "step=session_op_skipped reason=no_session_id",
                    operation_id,
                )

        async def build_protect_response(
            result: _LlmResponse,
            registry_path: str | None,
            resolved_by: str | None,
        ) -> ProtectFileResponse:
            """Build the public response, including safe masking aggregates."""
            masking_summary = None
            if result.success and result.masked_file_path:
                masking_summary = await _summarize_registry_path(
                    registry_path, operation_id=operation_id,
                )
            return ProtectFileResponse(
                operation_id=operation_id if result.success else None,
                success=result.success,
                masked_file_path=result.masked_file_path,
                final_answer=result.final_answer,
                error_message=result.error_message,
                resolved_by=resolved_by if result.success else None,
                masking_summary=masking_summary,
            )

        def cleanup_rejected_dps_output(masked_path: str | None, registry_path: str | None) -> None:
            """Delete a DPS masked file and registry that the hybrid dispatch rejected.

            Called when DPS ran successfully but hybrid mode fell back to the
            LLM (low confidence), so the DPS output is never returned or saved
            to ``pii_registry_store``. Without this, the masked file is an
            orphan on disk that nothing can restore once its registry's TTL
            expires, and its now-empty timestamped folder lingers alongside
            the LLM fallback's own folder.

            Args:
                masked_path: Sandbox-visible DPS masked output path, or None.
                registry_path: DPS registry file path (host path), or None.
            """
            if masked_path:
                try:
                    host_path = Path(resolve_workspace_path_to_host(masked_path))
                    reject_reparse_components(host_path)
                    host_path.unlink(missing_ok=True)
                except OSError as exc:
                    logger.warning(
                        "data_protection operation_id=%s endpoint=file.protect "
                        "step=dps_output_cleanup_failed target=masked_file exc_type=%s",
                        operation_id, exc.__class__.__name__,
                    )
                else:
                    # Prune the now-empty <stem>/<timestamp>/ folder
                    parent = host_path.parent
                    for _ in range(2):
                        try:
                            parent.rmdir()
                        except OSError:
                            break
                        parent = parent.parent
            if registry_path:
                try:
                    reg_path = Path(registry_path)
                    reject_reparse_components(reg_path)
                    reg_path.unlink(missing_ok=True)
                except OSError as exc:
                    logger.warning(
                        "data_protection operation_id=%s endpoint=file.protect "
                        "step=dps_output_cleanup_failed target=registry exc_type=%s",
                        operation_id, exc.__class__.__name__,
                    )
                else:
                    parent = reg_path.parent
                    for _ in range(2):
                        try:
                            parent.rmdir()
                        except OSError:
                            break
                        parent = parent.parent

        # ── mode dispatch ─────────────────────────────────────────────────────

        # Mode = deterministic: DPS only, no LLM fallback.
        if mode == "deterministic":
            dps_result, _, dps_reg = await run_deterministic_file_protection()
            logger.info(
                "data_protection operation_id=%s endpoint=file.protect step=completed "
                "resolved_by=dps mode=deterministic success=%s masked_output=%s",
                operation_id, dps_result.success, dps_result.masked_file_path is not None,
            )
            if dps_result.success:
                save_file_protection_operation(dps_result.masked_file_path, dps_reg)
            return await build_protect_response(dps_result, dps_reg, "dps")

        # Mode = llm: LLM pipeline, fallback to DPS for unsupported extensions.
        if mode == "llm":
            if ext not in LLM_SUPPORTED_EXTENSIONS:
                logger.info(
                    "data_protection operation_id=%s endpoint=file.protect "
                    "step=llm_extension_fallback source_ext=%s fallback=dps",
                    operation_id, ext,
                )
                dps_result, _, dps_reg = await run_deterministic_file_protection()
                if dps_result.success:
                    save_file_protection_operation(dps_result.masked_file_path, dps_reg)
                return await build_protect_response(dps_result, dps_reg, None)
            try:
                llm_result, llm_reg = await run_llm_file_protection()
            except NoLocalProviderError:
                logger.info(
                    "data_protection operation_id=%s endpoint=file.protect "
                    "step=llm_no_local_provider mode=llm fallback=dps",
                    operation_id,
                )
                dps_result, _, dps_reg = await run_deterministic_file_protection()
                if dps_result.success:
                    save_file_protection_operation(dps_result.masked_file_path, dps_reg)
                return await build_protect_response(dps_result, dps_reg, "dps")
            logger.info(
                "data_protection operation_id=%s endpoint=file.protect step=completed "
                "resolved_by=llm mode=llm success=%s masked_output=%s",
                operation_id, llm_result.success, llm_result.masked_file_path is not None,
            )
            if llm_result.success:
                save_file_protection_operation(llm_result.masked_file_path, llm_reg)
            return await build_protect_response(llm_result, llm_reg, "llm")

        # Mode = hybrid: DPS first, LLM fallback on failure or low confidence.
        dps_result, min_conf, dps_reg = await run_deterministic_file_protection()
        if not dps_result.success:
            logger.info(
                "data_protection operation_id=%s endpoint=file.protect "
                "step=hybrid_fallback reason=dps_failed fallback=llm",
                operation_id,
            )
            try:
                llm_result, llm_reg = await run_llm_file_protection()
            except NoLocalProviderError:
                # Nothing left to fall back to: DPS already failed and no
                # local model is configured either. Surface the DPS failure.
                logger.warning(
                    "data_protection operation_id=%s endpoint=file.protect "
                    "step=hybrid_no_fallback_available reason=no_local_provider "
                    "dps_failed=true",
                    operation_id,
                )
                return await build_protect_response(dps_result, dps_reg, "dps")
            if llm_result.success:
                save_file_protection_operation(llm_result.masked_file_path, llm_reg)
            return await build_protect_response(llm_result, llm_reg, "llm")
        if min_conf is None or min_conf >= threshold:
            logger.info(
                "data_protection operation_id=%s endpoint=file.protect step=completed "
                "resolved_by=dps mode=hybrid reason=confidence_accepted "
                "min_confidence=%s threshold=%.3f success=%s masked_output=%s",
                operation_id, "n/a" if min_conf is None else f"{min_conf:.3f}",
                threshold, dps_result.success, dps_result.masked_file_path is not None,
            )
            if dps_result.success:
                save_file_protection_operation(dps_result.masked_file_path, dps_reg)
            return await build_protect_response(dps_result, dps_reg, "dps")
        logger.info(
            "data_protection operation_id=%s endpoint=file.protect "
            "step=hybrid_fallback reason=low_confidence "
            "min_confidence=%.3f threshold=%.3f fallback=llm",
            operation_id, min_conf, threshold,
        )
        try:
            llm_result, llm_reg = await run_llm_file_protection()
        except NoLocalProviderError:
            # No local model to run the LLM fallback with: accept the DPS
            # result despite its low confidence rather than failing outright.
            logger.info(
                "data_protection operation_id=%s endpoint=file.protect "
                "step=hybrid_fallback reason=no_local_provider "
                "accepted_despite_low_confidence min_confidence=%.3f threshold=%.3f",
                operation_id, min_conf, threshold,
            )
            if dps_result.success:
                save_file_protection_operation(dps_result.masked_file_path, dps_reg)
            return await build_protect_response(dps_result, dps_reg, "dps")
        if llm_result.success:
            save_file_protection_operation(llm_result.masked_file_path, llm_reg)
        # DPS's masked file/registry were rejected for low confidence and are
        # never returned or saved above — delete them now instead of leaving
        # an unrestorable orphan behind once dps_reg's TTL expires.
        cleanup_rejected_dps_output(dps_result.masked_file_path, dps_reg)
        return await build_protect_response(llm_result, llm_reg, "llm")

    @app.post(
        "/v1/file/protect/batch",
        response_model=ProtectFileBatchResponse,
        dependencies=[Depends(auth_dep)],
        tags=["file"],
        summary="Protect multiple files in one request using the current data-protection mode.",
    )
    async def protect_files_batch(
        req: ProtectFileBatchRequest, http_req: Request
    ) -> ProtectFileBatchResponse:
        """Protect multiple files sequentially, one independent operation each.

        Each file is handed to the same ``protect_file`` handler used by
        ``/v1/file/protect`` — same mode dispatch, own ``operation_id``, own
        registry. Files are processed sequentially (not concurrently) so each
        gets its own ``@traced_pipeline_run`` trace folder without one file's
        context accidentally leaking into another's log capture.

        Args:
            req: Batch file protection request.
            http_req: HTTP request used to scope session ids.

        Returns:
            ProtectFileBatchResponse: One result per input path, same order.
        """
        results: list[ProtectFileBatchItem] = []
        scoped_session_id = (
            scope_session_id(req.session_id, config, http_req) if req.session_id else None
        )
        for idx, source_file_path in enumerate(req.source_file_paths, start=1):
            single_req = _ProtectedFileRequest(
                source_file_path=source_file_path,
                session_id=req.session_id,
                deterministic_only=req.deterministic_only,
            )
            single_result = await protect_file(single_req, http_req)
            if (
                len(req.source_file_paths) > 1
                and single_result.success
                and single_result.masked_file_path
                and single_result.operation_id
                and scoped_session_id
            ):
                operation_record = pii_registry_store.get_operation(
                    scoped_session_id, single_result.operation_id
                )
                if operation_record and operation_record.registry_path:
                    _namespace_placeholders_for_batch_file(
                        single_result.masked_file_path,
                        operation_record.registry_path,
                        file_index=idx,
                    )
            results.append(
                ProtectFileBatchItem(
                    source_file_path=source_file_path,
                    **single_result.model_dump(),
                )
            )
        logger.info(
            "data_protection endpoint=file.protect_batch step=completed "
            "file_count=%d success_count=%d",
            len(results),
            sum(1 for r in results if r.success),
        )
        return ProtectFileBatchResponse(results=results)

    @app.post(
        "/v1/file/llm-pipeline",
        response_model=_LlmResponse,
        dependencies=[Depends(auth_dep)],
        tags=["file"],
        summary="LLM-driven column detection + masking (legacy path).",
    )
    async def llm_pipeline(req: _LlmRequest) -> _LlmResponse:
        """Run the legacy LLM masking pipeline directly.

        Bypasses mode selection and always runs the bundled ``llm_pipeline``
        pipeline regardless of the current Security tab setting.

        Args:
            req: LLM pipeline request.

        Returns:
            _LlmResponse: LLM pipeline result.

        Raises:
            HTTPException: If ``source_file_path`` is empty.
        """
        operation_id = new_operation_id()
        if not req.source_file_path.strip():
            raise HTTPException(
                status_code=400,
                detail={
                    "error": "missing_source_file_path",
                    "message": "source_file_path must be non-empty.",
                },
            )
        resolved_path = str(validate_source_path(req.source_file_path, config.redact))
        max_source_bytes = int(getattr(config.redact, "max_source_bytes", 0) or 0)
        authorized_source_file_identity = _capture_authorized_source_identity(
            resolved_path, max_source_bytes
        )
        source_ext, source_size, workspace_path = summarize_source_for_logs(
            resolved_path
        )
        logger.info(
            "data_protection operation_id=%s endpoint=file.llm_pipeline step=started "
            "source_ext=%s source_size_bytes=%s workspace_path=%s",
            operation_id, source_ext, source_size, workspace_path,
        )
        if state.llm_client is None:
            state.llm_client = _LLMClient()
        try:
            result = await _llm_pipeline(
                resolved_path,
                state.llm_client,
                session_id=req.session_id,
                authorized_source_file_path=resolved_path,
                authorized_source_file_identity=authorized_source_file_identity,
            )
            final = result.get("final_response")
            success = result.get("final_generation_result", {}).get("success", False)
            masked_file_path = final.masked_file_path if final else None
            if success:
                logger.info(
                    "data_protection operation_id=%s endpoint=file.llm_pipeline "
                    "step=completed success=true masked_output=%s final_answer=%s",
                    operation_id, masked_file_path is not None,
                    bool(final and final.final_answer),
                )
            else:
                logger.warning(
                    "data_protection operation_id=%s endpoint=file.llm_pipeline "
                    "step=completed success=false error_present=%s",
                    operation_id, result.get("error_message") is not None,
                )
            return _LlmResponse(
                success=success,
                masked_file_path=masked_file_path,
                final_answer=final.final_answer if final else None,
                error_message=result.get("error_message"),
            )
        except Exception as exc:  
            logger.warning(
                "data_protection operation_id=%s endpoint=file.llm_pipeline "
                "step=failed exc_type=%s",
                operation_id, exc.__class__.__name__,
            )
            return _LlmResponse(
                success=False,
                masked_file_path=None,
                final_answer=None,
                error_message=str(exc),
            )
