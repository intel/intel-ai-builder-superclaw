"""``/sandbox-manager/v1/agent/sandbox/*`` endpoints.

Replaces legacy ``/sandbox/*``.

Key differences from legacy:
- URLs all under ``/sandbox-manager/v1/agent/sandbox``
- ``last_5_runs`` → ``recent_operations`` in diagnostics
- New endpoints: logs, tokens (POST)
- ``GET /sandbox-manager/v1/agent/sandbox/tokens/current`` 503 error uses standard shape
- ``POST /sandbox-manager/v1/agent/sandbox/provisions`` returns ``{ operation_id, state }``
  (not ``run_id``)
- ``POST /sandbox-manager/v1/agent/sandbox/actions`` returns ``{ operation_id, state }``
"""

from __future__ import annotations

import asyncio
import os
import time
from typing import Any, Literal

import httpx
from contracts.runtime_deployment_spec import RuntimeDeploymentSpec
from contracts.runtime_provision_failure_data import RUNTIME_PROVISION_FAILURE_COPY
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from loguru import logger
from pydantic import BaseModel, ValidationError

from ...native_egress_status import diagnostics_block, published_isolation_report
from ...native_isolation_report import current_isolation_report
from ...payload_archive import extracting
from ...runs import (
    KIND_RUNTIME_DEPLOYMENT_ENSURE,
    KIND_RUNTIME_INFRASTRUCTURE_PREPARE,
    RunManager,
)
from ...store import RUNTIME_DEPLOYMENT_CONFIG_KEY, Store
from ..errors import http_error
from ..process_auth import reject_managed_public_mutation, require_process_credential
from ._utils import tail_lines, to_operation_id


__all__ = ["router"]

router = APIRouter()

_PROBE_LOG_INTERVAL_SECONDS = 30.0
_probe_log_times: dict[str, float] = {}
# The status reads running about one start-up health pass (0.4-1.2 s measured, #3928) before the
# start issues its OWT. The wait plus the /whoami of the issued token must stay well under the
# callers' timeouts: Tauri boot 5 s, UI 8 s.
_OWT_ISSUE_WAIT_S = 2.0
_OWT_ISSUE_BUDGET_S = 3.5


def _log_probe_info(key: str, message: str, *args: object) -> None:
    now = time.monotonic()
    if now - _probe_log_times.get(key, 0.0) < _PROBE_LOG_INTERVAL_SECONDS:
        return
    _probe_log_times[key] = now
    logger.info(message, *args)


# ------------------------------------------------------------------ helpers


def _lifecycle(request: Request):
    lc = getattr(request.app.state, "lifecycle", None)
    if lc is None:
        raise http_error(
            503, "lifecycle_unavailable", "sandbox lifecycle not initialized"
        )
    return lc


def _owt(request: Request):
    oc = getattr(request.app.state, "owt_cache", None)
    if oc is None:
        raise http_error(503, "owt_cache_unavailable", "owt cache not initialized")
    return oc


def _rm(request: Request) -> RunManager:
    return request.app.state.run_manager


def _store(request: Request) -> Store:
    return request.app.state.store


# ------------------------------------------------------------------ GET /sandbox-manager/v1/agent/sandbox


@router.get("/agent/sandbox")
async def get_status(request: Request) -> dict[str, Any]:
    # Status comes from the supervised process tree; the supervisor IS the
    # parent of the backend.
    lifecycle = _lifecycle(request)
    store = _store(request)
    result = lifecycle.status()
    if store.find_active_run(kind=KIND_RUNTIME_DEPLOYMENT_ENSURE):
        result["phase"] = "starting"
    elif store.find_active_run(kind=KIND_RUNTIME_INFRASTRUCTURE_PREPARE):
        result["phase"] = "installing"
    return result


# ------------------------------------------------------------------ GET /sandbox-manager/v1/agent/sandbox/config


@router.get("/agent/sandbox/config")
async def sandbox_config(request: Request) -> dict[str, Any]:
    """Static sandbox configuration.

    Stable across the lifetime of the sandbox-manager process; safe to cache
    aggressively on the client. The response is a dict (not a Pydantic model)
    to match the convention of sibling endpoints in this module.
    """
    cfg = request.app.state.config
    return {"workspace_container_path": cfg.sandbox_workspace_container_path}


# ------------------------------------------------------------------ POST /sandbox-manager/v1/agent/sandbox/provisions


@router.post("/agent/sandbox/provisions")
async def provisions(request: Request) -> Any:
    reject_managed_public_mutation(request)
    return await _provisions(request)


async def _provisions(request: Request, *, rearm: bool = False) -> Any:
    lifecycle = _lifecycle(request)
    rm = _rm(request)
    payload = _store(request).get_config(RUNTIME_DEPLOYMENT_CONFIG_KEY)
    if payload is None:
        raise http_error(
            409,
            "runtime_deployment_required",
            "A Runtime Deployment must be stored before the Runtime can start.",
        )
    try:
        RuntimeDeploymentSpec.model_validate(payload)
    except ValidationError:
        raise http_error(
            409,
            "runtime_deployment_invalid",
            "The stored Runtime Deployment is invalid.",
        ) from None
    if rearm:
        await lifecycle.rearm_after_provision_refusal()
    run_id, _, _, _, _ = await lifecycle.ensure_runtime_deployment()
    row = rm.get(run_id)
    state = row["state"] if row else "running"
    if state == "done":
        return JSONResponse(status_code=200, content={"state": "ready"})
    # Work is in progress — return 202 with operation_id per api.md contract.
    return JSONResponse(
        status_code=202,
        content={"operation_id": to_operation_id(run_id), "state": state},
    )


# ------------------------------------------------------------------ POST /sandbox-manager/v1/agent/sandbox/actions


class ActionBody(BaseModel):
    action: Literal["start", "stop", "restart", "reset"]


# The guards are route dependencies, not calls in the body: FastAPI validates the request body before
# it runs the body, so a check written there is reached only by a well-formed request (#3665).
@router.post("/agent/sandbox/actions", dependencies=[Depends(reject_managed_public_mutation), Depends(require_process_credential)])
async def control(body: ActionBody, request: Request) -> dict[str, Any]:
    return await _control(body, request)


async def _control(body: ActionBody, request: Request) -> dict[str, Any]:
    lifecycle = _lifecycle(request)
    run_id = await lifecycle.control(body.action)
    return {"operation_id": to_operation_id(run_id), "state": "running"}


# ------------------------------------------------------------------ OWT verification helpers


async def _verify_owt(sandbox_url: str, token: str) -> bool:
    """Check whether *token* is accepted by the running backend.

    Uses ``GET /whoami`` which requires a valid Bearer token.
    Returns True if the backend responds 200, False otherwise.
    Intentionally swallows all errors — verification is best-effort.
    """
    url = f"{sandbox_url.rstrip('/')}/whoami"
    try:
        # trust_env=False: loopback backend (127.0.0.1); a corporate
        # HTTP_PROXY must not intercept it, and httpx does not honor NO_PROXY
        # CIDR entries such as 127.0.0.0/8.
        async with httpx.AsyncClient(timeout=5.0, trust_env=False) as client:
            resp = await client.get(url, headers={"Authorization": f"Bearer {token}"})
        return resp.status_code == 200
    except httpx.HTTPError:
        return False


def _native_not_ready(status: dict[str, Any]) -> HTTPException:
    """Why the native backend has no token yet: extracting, payload in use or failed, or starting."""
    if extracting():
        return http_error(
            503,
            "payload_preparing",
            "preparing the installed backend payload",
            retry_after_seconds=2,
        )
    provision = status.get("provision_failure") if status.get("phase") == "error" else None
    if isinstance(provision, dict) and provision.get("reason") in RUNTIME_PROVISION_FAILURE_COPY:
        # A refused provision does not clear by waiting. The closed word travels as a field, the
        # sentence is the contract's curated text for it, and neither carries the refusal's detail.
        reason = provision["reason"]
        return http_error(
            500,
            "runtime_provision_failed",
            RUNTIME_PROVISION_FAILURE_COPY[reason],
            details={"reason": reason},
        )
    failure = status.get("payload_failure") if status.get("phase") == "error" else None
    if isinstance(failure, dict):
        reason, remedy = failure["reason"], failure["remedy"]
        if failure["retryable"]:
            return http_error(
                503,
                "payload_in_use",
                f"SuperClaw is waiting for its previous backend to stop. {remedy}",
                retry_after_seconds=5,
                details={"reason": reason, "remedy": remedy},
            )
        return http_error(
            500,
            "payload_failed",
            f"SuperClaw could not prepare its backend ({reason}). {remedy}",
            details={"reason": reason, "remedy": remedy},
        )
    return http_error(
        503,
        "sandbox_not_ready",
        "native backend not ready",
        retry_after_seconds=5,
    )


def _owt_unavailable(reason: str = "cache_empty") -> HTTPException:
    _log_probe_info(
        f"owt_{reason}",
        "OWT readiness pending reason={}",
        reason,
    )
    return http_error(
        404,
        "owt_unavailable",
        "no cached OWT available",
        details={"hint": "POST /sandbox-manager/v1/agent/sandbox/tokens to reissue"},
    )


# ------------------------------------------------------------------ GET /sandbox-manager/v1/agent/sandbox/tokens/current


@router.get("/agent/sandbox/tokens/current", dependencies=[Depends(reject_managed_public_mutation), Depends(require_process_credential)])
async def get_owt_token(request: Request) -> dict[str, Any]:
    return await _get_owt_token(request)


async def _get_owt_token(request: Request) -> dict[str, Any]:
    cfg = request.app.state.config
    owt_cache = _owt(request)
    sandbox_url = f"http://127.0.0.1:{cfg.sandbox_port}"

    # An authenticated /whoami proves BOTH that the backend is running and that
    # the cached token is valid, so it subsumes the process-tree gate below.
    fast_cached = owt_cache.get()
    if fast_cached and await _verify_owt(sandbox_url, fast_cached["token"]):
        return {
            "token": fast_cached["token"],
            "scope": fast_cached["scope"],
            "created_at": fast_cached["created_at"],
        }

    # Readiness comes from the supervised process tree.
    status = _lifecycle(request).status()
    if status.get("phase") != "running":
        raise _native_not_ready(status)

    cached = owt_cache.get()
    deadline: float | None = None
    waited_ms = 0
    if not cached and _store(request).find_active_run(kind=KIND_RUNTIME_DEPLOYMENT_ENSURE):
        # The start in flight issues the OWT itself; hand it over as it lands rather than on
        # the caller's next poll.
        wait_started = time.monotonic()
        deadline = wait_started + _OWT_ISSUE_BUDGET_S
        cached = await owt_cache.wait(_OWT_ISSUE_WAIT_S)
        waited_ms = round((time.monotonic() - wait_started) * 1000)
    if not cached:
        # No cached OWT.  Do NOT try to issue one here — a concurrent
        # ensure_ready background task may still be bringing the backend up
        # and will issue the OWT itself. The Rust boot sequence retries this
        # endpoint, so returning 404 lets it poll until the background task
        # populates the cache.
        raise _owt_unavailable()

    # Verify the cached token against the running backend. This guards against
    # a stale token cached for a backend tree that has since been replaced.
    if deadline is None:
        verified = await _verify_owt(sandbox_url, cached["token"])
    else:
        try:
            async with asyncio.timeout(deadline - time.monotonic()):
                verified = await _verify_owt(sandbox_url, cached["token"])
        except TimeoutError:
            # Out of budget is no proof the new token is stale: keep it for the next poll.
            raise _owt_unavailable("verification_budget_exceeded") from None
    if verified:
        if deadline is not None:
            logger.info("native-backend: owt phase=handover event=waited waited_ms={}", waited_ms)
        return {
            "token": cached["token"],
            "scope": cached["scope"],
            "created_at": cached["created_at"],
        }

    # Cached token is stale — clear it. Re-issue is owned by the
    # lockfile-adoption flow in NativeBackendLifecycle.
    logger.warning("get_owt_token: cached OWT failed verification")
    await owt_cache.clear()
    raise http_error(
        503,
        "owt_stale",
        "cached OWT is invalid and re-issue failed",
        retry_after_seconds=5,
        details={
            "hint": "backend may have been replaced; restart via POST /sandbox-manager/v1/agent/sandbox/actions"
        },
    )


# ------------------------------------------------------------------ POST /sandbox-manager/v1/agent/sandbox/tokens


class TokenRefreshBody(BaseModel):
    force: bool = False


@router.post("/agent/sandbox/tokens", dependencies=[Depends(reject_managed_public_mutation), Depends(require_process_credential)])
async def refresh_token(
    request: Request, body: TokenRefreshBody | None = None
) -> dict[str, Any]:
    """Trigger a new OWT token by restarting the sandbox.

    .. note::
        This endpoint re-issues a token by restarting the backend tree via
        ``lifecycle.control("restart")``, which causes a brief sandbox downtime
        while the roles come back up.

    Only callable when the sandbox phase is ``running``.
    """
    return await _refresh_token(request, body)


async def _refresh_token(
    request: Request, body: TokenRefreshBody | None = None
) -> dict[str, Any]:
    lifecycle = _lifecycle(request)

    # Gate: sandbox must be running
    if lifecycle.status().get("phase") != "running":
        raise http_error(
            409,
            "sandbox_not_ready",
            "sandbox is not running; cannot refresh token",
        )

    # Delegate to lifecycle control "restart" which re-issues OWT.
    run_id = await lifecycle.control("restart")
    return {"operation_id": to_operation_id(run_id), "state": "running"}


internal_router = APIRouter(
    prefix="/internal",
    dependencies=[Depends(require_process_credential)],
)


@internal_router.post("/agent/sandbox/provisions")
async def provisions_internal(request: Request, rearm: bool = False) -> Any:
    # `rearm` is ServiceHub's user Retry: it asks again after a refused provision instead of
    # being told the deployment has failed.
    return await _provisions(request, rearm=rearm)


@internal_router.get("/agent/sandbox/tokens/current")
async def get_owt_token_internal(request: Request) -> dict[str, Any]:
    return await _get_owt_token(request)


# ------------------------------------------------------------------ GET /sandbox-manager/v1/agent/sandbox/logs


@router.get("/agent/sandbox/logs")
async def get_logs(
    request: Request,
    source: str = "container",
    tail: int = 200,
) -> dict[str, Any]:
    cfg = request.app.state.config
    if source not in {"container", "install"}:
        raise http_error(
            400, "invalid_param", "source must be 'container' or 'install'"
        )
    tail = min(tail, 1000)

    if source == "container":
        # Read from the latest runtime-*.log file in the runtime log dir. The
        # native backend writes its role logs under its own state dir instead,
        # so this is empty unless a runtime log was placed here.
        lines = ""
        try:
            log_files = sorted(
                cfg.sandbox_runtime_log_dir.glob("runtime-*.log"), key=os.path.getmtime
            )
            if log_files:
                all_lines = tail_lines(log_files[-1], tail)
                lines = "\n".join(all_lines)
        except Exception as exc:
            logger.debug("get_logs: runtime log file read failed: {}", exc)
    else:
        # Latest install log file
        lines = ""
        try:
            logs = sorted(
                cfg.sandbox_install_log_dir.glob("install-attempt*.log"), key=os.path.getmtime
            )
            if logs:
                all_lines = tail_lines(logs[-1], tail)
                lines = "\n".join(all_lines)
        except Exception as exc:
            logger.debug("get_logs: install log read failed: {}", exc)

    return {"source": source, "lines": lines}


# ------------------------------------------------------------------ GET /sandbox-manager/v1/agent/sandbox/diagnostics


@router.get("/agent/sandbox/diagnostics")
async def get_diagnostics(request: Request) -> dict[str, Any]:
    cfg = request.app.state.config
    store = _store(request)
    backend_status = _lifecycle(request).status()

    last_install_log = ""
    try:
        logs = sorted(
            cfg.sandbox_install_log_dir.glob("install-attempt*.log"), key=os.path.getmtime
        )
        if logs:
            last_install_log = logs[-1].read_text(encoding="utf-8", errors="replace")[
                -2000:
            ]
    except Exception as exc:
        logger.debug("get_diagnostics: install log read failed: {}", exc)

    # Use the public Store.recent_runs() API — never access _conn directly.
    recent_ops: list[dict[str, Any]] = []
    try:
        recent_ops = store.recent_runs(limit=10)
    except Exception as exc:
        logger.warning("get_diagnostics: recent_runs failed: {}", exc)

    # The isolation report belongs on the diagnostics surface because a
    # boundary claim belongs where an operator reads what the host is actually doing.
    # `current_isolation_report` assembles it from the evidence this Sandbox Manager holds: the
    # latest verified provision, the launcher's started line for each running tier role, and a
    # fresh read-only DACL readback of the current roots (cached for seconds, bounded by a
    # timeout, and `not_read` if it cannot run). It claims only what that evidence covers,
    # runs the result through the report validator, and falls back to the published
    # fail-closed report when there is no evidence or the validator refuses. No level is
    # established until the runtime attestation can pass. It carries a root count and a
    # policy class per member, never a path. It runs off the event loop because the readback
    # starts the launcher.
    # `GET .../sandbox/config` deliberately does not carry it. That response is the
    # aggressively cached static configuration the desktop app and the UI read, and its
    # documented job is connection guidance; the isolation report is per-run operator
    # evidence, and a cached copy of a boundary claim is worse than no copy. Placement is a
    # question of which contract owns the field and not of who may read it: both endpoints
    # sit behind the same ServiceHub token, so neither is a boundary against the sandboxed
    # side. The app-facing boundary keeps the app surface from learning Job, WFP, token,
    # account and payload-path internals, and that is why the app-facing contract gets
    # nothing here rather than a subset.
    # The one thing a start adds to the evidence-built report: the egress evidence and drift warning of
    # the latest unelevated WFP readback. The level stays the one the evidence supports; egress_wfp is the
    # operator's view of the install outcome and that readback.
    isolation_report = published_isolation_report(
        await asyncio.to_thread(current_isolation_report)
    )

    return {
        "backend_status": backend_status,
        "last_install_log_tail": last_install_log,
        "recent_operations": recent_ops,
        "isolation_report": isolation_report,
        "egress_wfp": diagnostics_block(),
    }
