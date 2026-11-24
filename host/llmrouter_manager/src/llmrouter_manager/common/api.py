"""Cross-cutting endpoints: liveness + ServiceHub per-service template + operations.

Endpoint layout (all under `/llm-router/v1/`; shutdown and the private inference-key
handoff use the ServiceHub process credential while other endpoints retain their
existing boundary):

REAL:
  GET  /llm-router/v1/health     — {service, status, pid, instance_id, version, uptime_seconds}
  GET  /llm-router/v1/version    — {version}
  GET  /llm-router/v1/internal/inference-key — loopback process-authenticated handoff
  POST /llm-router/v1/shutdown   — flips `app.state.server.should_exit`,
                                    returns {"state": "stopping"} (contract §7)
  GET  /llm-router/v1/status     — {state, version, summary:{}}
  GET  /llm-router/v1/config     — {version} — read-only surface; mutable
                                    config lives at the domain endpoints
                                    (`/cloud/*`, `/edge/*`, env vars). See
                                    the handler docstring for the policy.
  GET  /llm-router/v1/events     — SSE: one service.status event, then 15s keepalives

STUBS:
  POST  /llm-router/v1/restart            — 202 operation DTO
  GET   /llm-router/v1/operations/{id}    — operation DTO or 404
  POST  /llm-router/v1/operations/{id}/cancellations — operation DTO or 404

No `PUT` / `PATCH /llm-router/v1/config`: LRM has no writable config surface.
Every mutable knob is owned by a domain endpoint (see README §7.2.1 for the
full ownership table). Both methods return stdlib 405.
"""

from __future__ import annotations

import asyncio
import ipaddress
import json
import os
import secrets
import time

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse

from .. import __version__
from .errors import error_response
from .operations import OperationPool
from .store import Store, default_db_path
from ..local.inference_servers import list_servers as _list_servers
from ..local.models import models_status as _models_status
from ..local.selections import get_model_selections as _get_model_selections
from ..local.system import (
    get_hardware_eligibility as _get_hardware_eligibility,
    get_hardware_info as _get_hardware_info,
    get_preflight_info as _get_preflight_info,
    get_tier_selection as _get_tier_selection,
)
from ..routing.proxy import resolve_active_provider as _resolve_active_provider


_BOOT_AT = time.monotonic()


# ── SSE fan-out (used by /events endpoint below, and by common/usage.py) ──
#
# Callers publish via publish_sse_event(name, data). Each active /events
# connection creates its own asyncio.Queue and appends to _subscribers; the
# stream generator drains its own queue and removes itself on cancel.
#
# Single-threaded: all callers (record_usage from FastAPI handlers,
# _events_stream from the SSE endpoint) run in the same asyncio event loop,
# so no lock is required around _subscribers or queue puts.
_subscribers: list[asyncio.Queue] = []


def publish_sse_event(name: str, data: dict) -> None:
    """Best-effort synchronous fan-out to all live SSE subscribers.

    Uses ``asyncio.Queue.put_nowait()`` which is non-blocking; slow
    subscribers drop the event rather than block the caller. Callable from
    both sync and async contexts as long as we are inside the FastAPI event
    loop, which every ``record_usage`` call site is.
    """
    line = f"event: {name}\ndata: {json.dumps(data)}\n\n"
    for q in list(_subscribers):
        try:
            q.put_nowait(line)
        except asyncio.QueueFull:
            pass  # slow subscriber; drop this event


# ── Liveness (ServiceHub-facing; contract §5). No auth — see module docstring. ──
meta_router = APIRouter(prefix="/llm-router/v1", tags=["meta"])


@meta_router.get("/health")
async def health(request: Request) -> dict[str, object]:
    """Health readiness endpoint per ServiceHub sub-service contract §5.

    Required fields: ``service``, ``status``, ``pid``, ``instance_id``.
    Extras (``version``, ``uptime_seconds``) are explicitly allowed by
    the contract and useful for operators.

    ``service`` and ``instance_id`` are the values ServiceHub injected via
    ``SERVICEHUB_SERVICE_NAME`` / ``SERVICEHUB_INSTANCE_ID`` at spawn time
    (contract §4). ``pid`` is diagnostic only — ServiceHub uses
    ``instance_id`` as the authoritative per-spawn identity because the
    parent-observed process PID can drift on Windows/Python launch paths.
    """
    return {
        "service": request.app.state.service_name,
        "status": "ok",
        "pid": os.getpid(),
        "instance_id": request.app.state.instance_id,
        "version": __version__,
        "uptime_seconds": round(time.monotonic() - _BOOT_AT, 3),
    }


@meta_router.get("/version")
async def version() -> dict[str, str]:
    """Cheaper variant of /health — just the version string."""
    return {"version": __version__}


@meta_router.get("/internal/inference-key")
async def get_inference_key(request: Request) -> JSONResponse:
    client_host = request.client.host if request.client is not None else ""
    try:
        is_loopback = ipaddress.ip_address(client_host).is_loopback
    except ValueError:
        is_loopback = client_host == "testclient"
    expected = getattr(request.app.state, "process_credential", "")
    supplied = request.headers.get("X-SuperClaw-Process-Credential", "")
    if (
        not is_loopback
        or not expected
        or not secrets.compare_digest(expected, supplied)
    ):
        raise HTTPException(status_code=403, detail="inference_key_forbidden")
    inference_key = getattr(request.app.state, "inference_key", "")
    if not inference_key:
        raise HTTPException(status_code=503, detail="inference_key_unavailable")
    # `host_api_key` is additive: a ServiceHub that predates the split ignores
    # the extra member and keeps distributing `api_key` to everything, which is
    # the previous behaviour rather than a failure.
    #
    # Reported EMPTY when there is no host key -- deliberately not falling back
    # to the shared one. Advertising the shared key here would make ServiceHub
    # grant it as `LRM_HOST_API_KEY`, `asr_manager` would then attempt pinned
    # completions with a credential `require_host_inference_key` rejects, and
    # the user would get an opaque 401 instead of the legible
    # `424 refine_not_configured` the missing grant is supposed to produce.
    # Standalone mode needs no fallback either: `__main__.py` already mirrors
    # the shared key into `host_inference_key` explicitly, because there a
    # single key legitimately serves both planes.
    host_key = getattr(request.app.state, "host_inference_key", "")
    return JSONResponse(
        {"api_key": inference_key, "host_api_key": host_key},
        headers={"Cache-Control": "no-store"},
    )


@meta_router.post("/shutdown")
async def shutdown(request: Request) -> JSONResponse:
    """Graceful shutdown per ServiceHub sub-service contract §7.

    Flips ``uvicorn.Server.should_exit = True`` so the server drains
    in-flight requests and exits voluntarily. ServiceHub will force kill
    the process if it does not exit within ``shutdown_grace_s``.

    Returns 200 with ``{"state": "stopping"}`` so the caller (ServiceHub or
    a direct debugger) gets an ack before the socket closes.
    """
    expected = getattr(request.app.state, "process_credential", "")
    supplied = request.headers.get("X-SuperClaw-Process-Credential", "")
    if not expected or not secrets.compare_digest(expected, supplied):
        raise HTTPException(status_code=403, detail="shutdown_forbidden")
    server = getattr(request.app.state, "server", None)
    if server is None:
        # Under TestClient / uv run --just-app-build there is no live
        # uvicorn.Server on app.state. Report the ack anyway so the
        # contract-shape test can assert against the endpoint independently
        # of process supervision.
        return JSONResponse({"state": "stopping", "detail": "no supervisor attached"})
    server.should_exit = True
    return JSONResponse({"state": "stopping"})


# ── ServiceHub per-service template ──
hub_template_router = APIRouter(prefix="/llm-router/v1", tags=["hub-template"])


@hub_template_router.get("/status")
async def get_status(request: Request) -> dict[str, object]:
    """Typed lifecycle status with a live local-subsystem snapshot.

    Store-derived slices (preflight / models / selections) use a short-lived
    Store per request, matching the local endpoint pattern. Hardware +
    eligibility come from the lazy WMI probe cached on ``app.state``: the
    first ``/status`` call after boot triggers the one-shot probe (cached
    thereafter). Read-only — it never starts a process, downloads a model,
    or launches a llama-server.
    """
    app_state = request.app.state
    # `active_provider` derives from the committed primary bundle via the SAME
    # resolver the data plane uses (`_resolve_alias` → local-model), so /status
    # and /v1/chat/completions never disagree. It deliberately ignores
    # `local_provider` (the raw user selection, None until an explicit pick): an
    # auto-committed first-launch bundle reports active just like a manual one.
    local_provider, active_provider = _resolve_active_provider(app_state)
    store = Store(default_db_path())
    try:
        tier_selection = await _get_tier_selection(app_state, store)
        summary: dict[str, object] = {
            "system": await _get_preflight_info(store, app_state),
            "hardware": await _get_hardware_info(app_state),
            "eligibility": await _get_hardware_eligibility(app_state),
            "models": _models_status(store),
            "model_selections": _get_model_selections(store),
            "local_provider": local_provider,
            "active_provider": active_provider,
            "inference_servers": _list_servers(app_state),
            "available_tiers": tier_selection["available_tiers"],
            "selected_tier": tier_selection["selected_tier"],
        }
    finally:
        store.close()
    return {
        "state": "running",
        "version": __version__,
        "summary": summary,
    }


@hub_template_router.get("/config")
async def get_config() -> dict[str, object]:
    """Effective config — read-only surface (NEVER includes secrets).

    This endpoint exposes only immutable process-scoped metadata (currently
    just ``version``). Mutable configuration is owned by domain endpoints:

    - ``/llm-router/v1/cloud/providers/{id}`` — cloud provider credentials
    - ``/llm-router/v1/cloud/model``          — active cloud-model singleton
    - ``/llm-router/v1/edge``                 — edge endpoint config
    - ``LRM_LOG_*`` / ``LRM_LOG_DIR`` / ``LRM_LOG_RETENTION`` env vars
    - ``SERVICEHUB_*`` env vars (echoed via ``/llm-router/v1/health``)

    ``PUT`` / ``PATCH /config`` are deliberately NOT registered — clients
    get a stdlib 405 from FastAPI, a truthful signal that this surface
    does not accept writes. See module docstring for rationale.
    """
    return {
        "version": __version__,
    }


@hub_template_router.post("/restart")
async def restart(request: Request) -> JSONResponse:
    operation_pool = _operation_pool(request)
    operation = await operation_pool.create("restart")
    operation_id = str(operation["operation_id"])
    updated = await operation_pool.transition(
        operation_id,
        "running",
        pct=0,
        message="restart requested",
    )
    return JSONResponse(updated or operation, status_code=202)


@hub_template_router.get("/events")
async def events() -> StreamingResponse:
    """SSE stream. Emits one `service.status` event then 15s keepalives.

    Once the operation pool wires in, this stream multiplexes
    ``operation.progress``, ``service.status``, and ``error`` events. For
    now it only proves the SSE transport works through the Hub proxy.
    """
    return StreamingResponse(_events_stream(), media_type="text/event-stream")


async def _events_stream():
    """SSE fan-out generator.

    Attaches a per-connection ``asyncio.Queue`` to ``_subscribers`` on entry,
    drains it in the main loop, and removes itself in ``finally``. Emits the
    initial ``service.status`` event once, then any events published via
    ``publish_sse_event()``. Keepalives every 15 s when the queue is idle.
    Cancellation (client disconnect) propagates via ``asyncio.CancelledError``.
    """
    q: asyncio.Queue = asyncio.Queue(maxsize=256)
    _subscribers.append(q)
    try:
        payload = json.dumps({"state": "running", "version": __version__})
        yield f"event: service.status\ndata: {payload}\n\n"
        while True:
            try:
                line = await asyncio.wait_for(q.get(), timeout=15.0)
                yield line
            except asyncio.TimeoutError:
                yield ": keepalive\n\n"
    finally:
        try:
            _subscribers.remove(q)
        except ValueError:
            pass


# ── Operations (Hub template) ──
operations_router = APIRouter(prefix="/llm-router/v1/operations", tags=["operations"])


@operations_router.get("/{op_id}", response_model=None)
async def get_operation(op_id: str, request: Request) -> dict[str, object] | JSONResponse:
    operation = await _operation_pool(request).get(op_id)
    if operation is None:
        operation = request.app.state.store.get_durable_preparation_operation(op_id)
    if operation is None:
        return _operation_not_found(op_id)
    return operation


@operations_router.post("/{op_id}/cancellations", response_model=None)
async def cancel_operation(op_id: str, request: Request) -> dict[str, object] | JSONResponse:
    operation = await _operation_pool(request).cancel(op_id)
    if operation is None:
        operation = request.app.state.store.get_durable_preparation_operation(op_id)
    if operation is None:
        return _operation_not_found(op_id)
    return operation


# ── shared ──
def _operation_pool(request: Request) -> OperationPool:
    operation_pool = getattr(request.app.state, "operation_pool", None)
    if not isinstance(operation_pool, OperationPool):
        operation_pool = OperationPool()
        request.app.state.operation_pool = operation_pool
    return operation_pool


def _operation_not_found(operation_id: str) -> JSONResponse:
    return error_response(
        "operation_not_found",
        f"No operation with id {operation_id}",
        status_code=404,
        details={"operation_id": operation_id},
    )
