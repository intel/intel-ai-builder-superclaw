"""Workspace cleanup endpoints.

POST /sandbox-manager/v1/workspace/cleanup/run-now   – immediate cleanup pass
POST /sandbox-manager/v1/workspace/cleanup/preview   – dry-run
GET  /sandbox-manager/v1/workspace/cleanup/status    – last run time, next run time, folder size

If an agent task is currently active the mutation endpoints are rejected with
409 Conflict, the same guard used by the loop.
"""

from __future__ import annotations
import asyncio
import functools
import os
from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse
from loguru import logger

from ...workspace_cleanup_job import WorkspaceCleanupJob, _resolve_superclaw_root
from ..process_auth import reject_managed_public_mutation, require_process_credential

router = APIRouter()

_RUN_NOW_MIN_AGE_DAYS = 1 / 24
_MIN_RETENTION_DAYS = 1
_MAX_RETENTION_DAYS = 30


@router.get("/workspace/cleanup/settings")
async def get_workspace_cleanup_settings(request: Request) -> JSONResponse:
    from ...workspace_cleanup import load_cleanup_settings

    settings = load_cleanup_settings(getattr(request.app.state, "store", None))
    return JSONResponse(status_code=200, content=settings)


@router.post("/workspace/cleanup/settings")
async def set_workspace_cleanup_settings(request: Request) -> JSONResponse:
    reject_managed_public_mutation(request)
    require_process_credential(request)
    return await _set_workspace_cleanup_settings(request)


async def _set_workspace_cleanup_settings(request: Request) -> JSONResponse:
    from ...workspace_cleanup import (
        WORKSPACE_CLEANUP_CONFIG_KEY,
        load_cleanup_settings,
    )

    try:
        payload = await request.json()
    except Exception:
        payload = None
    if not isinstance(payload, dict):
        return JSONResponse(status_code=400, content={"error": "invalid_payload"})
    if "enabled" in payload and not isinstance(payload["enabled"], bool):
        return JSONResponse(status_code=400, content={"error": "invalid_enabled"})
    retention = payload.get("retentionDays")
    if retention is not None and (
        not isinstance(retention, int)
        or isinstance(retention, bool)
        or retention < _MIN_RETENTION_DAYS
        or retention > _MAX_RETENTION_DAYS
    ):
        return JSONResponse(status_code=400, content={"error": "invalid_retention_days"})

    store = getattr(request.app.state, "store", None)
    if store is None:
        return JSONResponse(status_code=503, content={"error": "store_unavailable"})
    current = load_cleanup_settings(store)
    updated = {
        "enabled": payload.get("enabled", current["enabled"]),
        "retentionDays": payload.get("retentionDays", current["retentionDays"]),
    }
    store.set_config(WORKSPACE_CLEANUP_CONFIG_KEY, updated)
    logger.info(
        "Cleanup settings updated: enabled={}->{} retentionDays={}->{}",
        current["enabled"],
        updated["enabled"],
        current["retentionDays"],
        updated["retentionDays"],
    )
    return JSONResponse(status_code=200, content=updated)

async def _read_retention_days(request: Request) -> float | JSONResponse:
    """Parse the retention window (in days) shared by preview and run-now.

    Both endpoints MUST use this so a confirmed preview and the actual
    deletion select identical candidates.

    Returns retention window
    """
    try:
        payload = await request.json()
    except Exception:
        return _RUN_NOW_MIN_AGE_DAYS
    if not isinstance(payload, dict):
        return JSONResponse(status_code=400, content={"error": "invalid_payload"})

    value = payload.get("retention_days")
    if value is None:
        return _RUN_NOW_MIN_AGE_DAYS
    if (
        not isinstance(value, int)
        or isinstance(value, bool)
        or value < _MIN_RETENTION_DAYS
        or value > _MAX_RETENTION_DAYS
    ):
        logger.warning(
            "Cleanup request rejected: invalid retention_days={!r}", value
        )
        return JSONResponse(
            status_code=400,
            content={
                "error": "invalid_retention_days",
                "message": (
                    "retention_days must be an integer between "
                    f"{_MIN_RETENTION_DAYS} and {_MAX_RETENTION_DAYS}."
                ),
            },
        )
    return float(value)


@router.post("/workspace/cleanup/run-now")
async def run_workspace_cleanup_now(request: Request) -> JSONResponse:
    """Trigger an immediate workspace cleanup pass.

    Returns 409 if an agent task is currently active.
    Returns 200 with a summary dict on success.
    """
    reject_managed_public_mutation(request)
    require_process_credential(request)
    return await _run_workspace_cleanup_now(request)


async def _run_workspace_cleanup_now(request: Request) -> JSONResponse:
    logger.info("Workspace cleanup run-now requested")
    app_state = request.app.state
    store = getattr(app_state, "store", None)

    if store is not None and store.find_active_operations():
        logger.warning("Cleanup run-now rejected: agent task is active")
        return JSONResponse(
            status_code=409,
            content={
                "error": "agent_task_active",
                "message": "Cannot run cleanup while an agent task is active.",
            },
        )

    cfg = getattr(app_state, "config", None)
    data_dir = cfg.data_dir if cfg is not None else None

    parsed = await _read_retention_days(request)
    if isinstance(parsed, JSONResponse):
        return parsed
    retention_days = parsed

    job = WorkspaceCleanupJob(
        data_dir=data_dir,
        store=store,
    )

    loop = asyncio.get_running_loop()
    try:
        summary = await loop.run_in_executor(
            None, functools.partial(job.run_once, retention_days=retention_days)
        )
    except Exception:
        logger.exception("Cleanup run-now failed unexpectedly")
        raise
    if summary.get("skipped"):
        logger.warning("Cleanup run-now rejected: a cleanup pass is already running")
        return JSONResponse(
            status_code=409,
            content={
                "error": "cleanup_already_running",
                "message": "A cleanup pass is already running. Try again shortly.",
            },
        )
    logger.info(
        "Cleanup run-now complete: dirs={} files={} errors={} freed={} bytes",
        summary.get("dirs_removed"),
        summary.get("files_removed"),
        summary.get("errors"),
        summary.get("bytes_freed"),
    )
    return JSONResponse(status_code=200, content=summary)


internal_router = APIRouter(
    prefix="/internal",
    dependencies=[Depends(require_process_credential)],
)


@internal_router.post("/workspace/cleanup/settings")
async def set_workspace_cleanup_settings_internal(request: Request) -> JSONResponse:
    return await _set_workspace_cleanup_settings(request)


@internal_router.post("/workspace/cleanup/run-now")
async def run_workspace_cleanup_now_internal(request: Request) -> JSONResponse:
    return await _run_workspace_cleanup_now(request)


@router.post("/workspace/cleanup/preview")
async def preview_workspace_cleanup(request: Request) -> JSONResponse:
    """Dry-run workspace cleanup pass, returns what would be deleted.
    Never deletes anything. 
    """
    logger.info("Workspace cleanup preview requested")
    app_state = request.app.state
    store = getattr(app_state, "store", None)

    if store is not None and store.find_active_operations():
        logger.warning("Cleanup preview rejected: agent task is active")
        return JSONResponse(
            status_code=409,
            content={
                "error": "agent_task_active",
                "message": "Cannot preview cleanup while an agent task is active.",
            },
        )

    parsed = await _read_retention_days(request)
    if isinstance(parsed, JSONResponse):
        return parsed
    retention_days = parsed

    cfg = getattr(app_state, "config", None)
    data_dir = cfg.data_dir if cfg is not None else None

    job = WorkspaceCleanupJob(
        data_dir=data_dir,
        store=store,
    )

    loop = asyncio.get_running_loop()
    try:
        summary = await loop.run_in_executor(
            None, functools.partial(job.run_once, dry_run=True, retention_days=retention_days)
        )
    except Exception:
        logger.exception("Cleanup preview failed unexpectedly")
        raise
    if summary.get("skipped"):
        logger.warning("Cleanup preview rejected: a cleanup pass is already running")
        return JSONResponse(
            status_code=409,
            content={
                "error": "cleanup_already_running",
                "message": "A cleanup pass is already running. Try again shortly.",
            },
        )
    logger.info(
        "Cleanup preview done: dirs={} files={} freed={} bytes",
        summary.get("dirs_removed"),
        summary.get("files_removed"),
        summary.get("bytes_freed"),
    )
    return JSONResponse(status_code=200, content=summary)


@router.get("/workspace/cleanup/status")
async def get_workspace_cleanup_status(
    request: Request,
    enabled: bool | None = Query(default=None, description="Optional: the toggle value the caller just wrote, used only to compute next_run_at."),
) -> JSONResponse:
    """Return lightweight cleanup status: last run timestamp, next scheduled run, and
    total SuperClawProjects folder size.

    Never deletes files. Folder size walk runs in a thread pool executor.
    Returns 200 always — individual fields are null if unavailable.
    """
    app_state = request.app.state
    cfg = getattr(app_state, "config", None)
    data_dir = cfg.data_dir if cfg is not None else None

    job = WorkspaceCleanupJob(data_dir=data_dir)
    last_run_at: float | None = job._read_last_run_at()
    last_cleaned_at: float | None = job._read_last_cleaned_at()
    last_emergency_cleanup_at: float | None = job._read_last_emergency_cleanup_at()

    env = dict(os.environ)
    from ...workspace_cleanup import load_cleanup_settings, load_cleanup_policy
    runtime_cfg = load_cleanup_settings(getattr(app_state, "store", None))
    policy = load_cleanup_policy()
    if enabled is None:
        enabled = runtime_cfg["enabled"]
    # Schedule is fixed daily — next run = last_run_at + 24h
    _DAILY = int(os.environ.get("SUPERCLAW_CLEANUP_INTERVAL_SECONDS", 86400))

    next_run_at: float | None = None
    if enabled:
        if last_run_at is not None:
            next_run_at = last_run_at + _DAILY

    loop = asyncio.get_running_loop()
    root = await loop.run_in_executor(None, _resolve_superclaw_root, env)
    intermediate_bytes: int = 0
    reclaimable_bytes: int = 0
    if root is not None:
        intermediate_bytes, reclaimable_bytes = await loop.run_in_executor(
            None,
            functools.partial(
                job._scan_intermediate_bytes,
                root,
                policy,
                retention_days=runtime_cfg["retentionDays"],
            ),
        )
        
    if intermediate_bytes >= policy.critical_bytes:
        disk_level = "critical"
    elif intermediate_bytes >= policy.warn_bytes:
        disk_level = "warn"
    else:
        disk_level = "ok"

    return JSONResponse(status_code=200, content={
        "last_run_at": last_run_at,
        "last_cleaned_at": last_cleaned_at,
        "last_emergency_cleanup_at": last_emergency_cleanup_at,
        "next_run_at": next_run_at,
        "intermediate_bytes": intermediate_bytes,
        "reclaimable_bytes": reclaimable_bytes,
        "warn_bytes": policy.warn_bytes,
        "critical_bytes": policy.critical_bytes,
        "disk_level": disk_level,
    })


@router.get("/workspace/cleanup/policy")
async def get_workspace_cleanup_policy(request: Request) -> JSONResponse:
    """Expose the cleanup policy the UI should describe to the user.

    Read-only — returns the same eligible_patterns/thresholds the backend
    actually enforces
    """
    from ...workspace_cleanup import load_cleanup_policy
    policy = load_cleanup_policy()

    return JSONResponse(status_code=200, content={
        "patterns": [
            {
                "pattern": p.pattern,
                "type": p.pattern_type,
                "description": p.description,
            }
            for p in policy.eligible_patterns
        ],
        "max_session_age_days": policy.max_session_age_days,
        "warn_bytes": policy.warn_bytes,
        "critical_bytes": policy.critical_bytes,
    })
