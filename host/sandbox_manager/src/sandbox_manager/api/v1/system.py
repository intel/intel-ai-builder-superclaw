"""``/sandbox-manager/v1/system/*`` endpoints.

Endpoints:
- ``GET /sandbox-manager/v1/system/status``     — boot/reconnect snapshot (api.md #23)
- ``GET /sandbox-manager/v1/system/preflight``  — non-mutating environment checks (api.md #24)
- ``POST /sandbox-manager/v1/system/provisions`` — sandbox ensure-ready (api.md #22)

LLM / model-server status and provisioning live in the LLMRouter Manager
(LRM); this surface covers only the native sandbox backend.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request
from loguru import logger
from contracts.runtime_deployment_spec import RuntimeDeploymentSpec
from pydantic import ValidationError

from ...store import RUNTIME_DEPLOYMENT_CONFIG_KEY
from ...version import get_app_version
from ...runs import KIND_RUNTIME_DEPLOYMENT_ENSURE, KIND_RUNTIME_INFRASTRUCTURE_PREPARE
from ._utils import to_operation_id
from ..errors import http_error
from ..process_auth import reject_managed_public_mutation


router = APIRouter()


# ------------------------------------------------------------------ helpers


def compute_sandbox_flow(store) -> dict[str, Any]:
    """Compute ``flows.sandbox`` from the active deployment run.

    Store-only, so it is cheap enough for the Hub's
    per-service status rollup.  Shared with the ``/sandbox-manager/v1/status``
    ``summary`` projection (:mod:`sandbox_manager.api.v1.servicehub`) so that
    surface and this endpoint's ``flows.sandbox`` are computed from a single
    source and cannot drift.
    """
    active = (store.find_active_run(kind=KIND_RUNTIME_DEPLOYMENT_ENSURE)
              or store.find_active_run(kind=KIND_RUNTIME_INFRASTRUCTURE_PREPARE))
    if active:
        return {
            "state": active["state"],
            "pct": round(active.get("pct", 0.0), 2),
            "active_operation_id": to_operation_id(active["run_id"]),
        }
    return {"state": "pending", "pct": 0.0}


# ------------------------------------------------------------------ GET /sandbox-manager/v1/system/status


@router.get("/system/status")
async def system_status(request: Request) -> dict[str, Any]:
    app_state = request.app.state
    store = app_state.store

    # Sandbox flow
    sb_flow = compute_sandbox_flow(store)

    # Sandbox phase (mirrors GET /sandbox-manager/v1/agent/sandbox): the
    # supervised process tree, overridden while a deployment run is active.
    sandbox_phase = "stopped"
    sandbox_last_error: str | None = None
    try:
        native_status = app_state.lifecycle.status()
        if store.find_active_run(kind=KIND_RUNTIME_INFRASTRUCTURE_PREPARE):
            sandbox_phase = "installing"
        elif store.find_active_run(kind=KIND_RUNTIME_DEPLOYMENT_ENSURE):
            sandbox_phase = "starting"
        else:
            sandbox_phase = native_status.get("phase", "stopped")
        if sandbox_phase in ("error", "missing"):
            sandbox_last_error = native_status.get("message")
    except Exception as exc:
        logger.warning("system_status: sandbox phase computation failed: {}", exc)

    # Active operations (top-level, non-terminal)
    active_ops_raw = store.find_active_operations()
    active_ops = [
        {
            "operation_id": to_operation_id(row["run_id"]),
            "kind": row["kind"],
            "state": row["state"],
            "pct": round(row.get("pct", 0.0), 2),
            **({"message": row["message"]} if row.get("message") else {}),
        }
        for row in active_ops_raw
    ]

    # Build flows — omit active_operation_id when absent
    sb_flow_out: dict[str, Any] = {"state": sb_flow["state"], "pct": sb_flow["pct"]}
    if "active_operation_id" in sb_flow:
        sb_flow_out["active_operation_id"] = sb_flow["active_operation_id"]

    return {
        "status": "ok",
        "version": get_app_version(),
        "flows": {
            "sandbox": sb_flow_out,
        },
        "sandbox": {
            "phase": sandbox_phase,
            **({"last_error": sandbox_last_error} if sandbox_last_error else {}),
        },
        "active_operations": active_ops,
    }


# ------------------------------------------------------------------ GET /sandbox-manager/v1/system/preflight


@router.get("/system/preflight")
async def system_preflight(request: Request) -> dict[str, Any]:
    app_state = request.app.state

    checks: list[dict[str, Any]] = []

    def _check(
        name: str,
        state: str,
        severity: str,
        message: str | None = None,
        details: Any = None,
    ) -> None:
        entry: dict[str, Any] = {"name": name, "state": state, "severity": severity}
        if message:
            entry["message"] = message
        if details:
            entry["details"] = details
        checks.append(entry)

    # 1. Native backend payload: the supervised tree reports `missing` when its
    # binaries cannot be found.
    native_status = app_state.lifecycle.status()
    native_ok = native_status.get("phase") != "missing"
    _check(
        "native_backend_payload",
        "pass" if native_ok else "fail",
        "info" if native_ok else "error",
        None if native_ok else native_status.get("message", "native backend binaries not found"),
    )

    # 2. OWT cache
    owt = getattr(app_state, "owt_cache", None)
    if owt and owt.get():
        _check("owt_cache", "pass", "info")
    else:
        _check(
            "owt_cache",
            "skipped",
            "info",
            "no cached OWT token (normal before first sandbox start)",
        )

    ready = all(c["state"] != "fail" or c["severity"] != "error" for c in checks)

    # `missing_resources` stays in the shape for ServiceHub's preflight fan-out;
    # the native backend ships everything it needs in its payload.
    return {
        "ready": ready,
        "missing_resources": [],
        "checks": checks,
    }


# ------------------------------------------------------------------ POST /sandbox-manager/v1/system/provisions


@router.post("/system/provisions")
async def system_provisions(request: Request) -> dict[str, Any]:
    """Ensure the native sandbox backend is ready."""
    reject_managed_public_mutation(request)
    app_state = request.app.state
    lifecycle = getattr(app_state, "lifecycle", None)

    async def _sandbox_ensure() -> dict[str, Any]:
        if lifecycle is None:
            return {"state": "unavailable"}
        store = getattr(app_state, "store", None)
        payload = (
            store.get_config(RUNTIME_DEPLOYMENT_CONFIG_KEY)
            if store is not None
            else None
        )
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
        run_id, _, _, _, _ = await lifecycle.ensure_runtime_deployment()
        rm = app_state.run_manager
        row = rm.get(run_id)
        state = row["state"] if row else "running"
        # Run states are pending|running|done|error|cancelled. Map the terminal
        # success state ``done`` to the API-level ``ready`` (matching
        # ``POST /agent/sandbox/provisions``); otherwise the work is still in
        # progress, so surface the operation_id for polling.
        if state == "done":
            return {"state": "ready"}
        out: dict[str, Any] = {"state": state}
        if run_id:
            out["operation_id"] = to_operation_id(run_id)
        return out

    sb_result = await _sandbox_ensure()

    # Flattened envelope for the ServiceHub fan-out aggregator
    # (servicehub operations/fanout.py:_provision_service), which reads
    # ``operation_id`` / ``state`` / ``pct`` from the TOP LEVEL of this reply and
    # then polls ``GET /v1/operations/{operation_id}`` for real progress. The
    # nested ``sandbox`` object is retained for back-compat with direct callers
    # (frontend / Rust relay). See ``host/sandbox_manager/doc/api.md``
    # (``POST /system/provisions``).
    response: dict[str, Any] = {
        "state": sb_result.get("state"),
        "sandbox": sb_result,
    }
    operation_id = sb_result.get("operation_id")
    if operation_id is not None:
        # Work is in flight: expose the handle and a starting pct; the fan-out
        # poll loop supplies live pct from the operations endpoint thereafter.
        response["operation_id"] = operation_id
        response["pct"] = 0
    else:
        # Terminal (``ready``) or no-op (``unavailable``): nothing to poll.
        response["pct"] = 100
    return response
