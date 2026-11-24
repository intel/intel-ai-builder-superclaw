"""Local subsystem routes for system, models, selections, and servers.

Unknown local paths return the standard LRM error envelope.
"""

from __future__ import annotations

import asyncio
from typing import cast

from fastapi import APIRouter, FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, ValidationError

from ..common.errors import error_response
from ..common.operations import TERMINAL_STATES, OperationPool
from ..common.store import Store, default_db_path
from . import inference_servers as _inference_servers
from . import models as _models
from . import selections as _selections
from . import system as _system
from .deps import get_eligibility, get_hardware
from .inference_logic import ensure_model_servers_ready
from .policy import available_chat_tiers
from .registry import ROLE_CHAT


def _route_not_found(namespace: str, path: str, method: str) -> JSONResponse:
    full_path = f"{namespace}/{path}" if path else namespace
    return error_response(
        "route_not_found",
        f"{method} {full_path} is not a local route",
        status_code=404,
        details={
            "namespace": namespace,
            "path": full_path,
            "method": method,
        },
    )


# `/llm-router/v1/system/*` — hardware probe + eligibility + LLM slice of preflight.
system_router = APIRouter(prefix="/llm-router/v1/system", tags=["local.system"])


@system_router.get("/hardware")
async def system_hardware(request: Request) -> JSONResponse:
    return JSONResponse(await _system.get_hardware_info(request.app.state))


@system_router.get("/hardware-eligibility")
async def system_hardware_eligibility(request: Request) -> JSONResponse:
    return JSONResponse(await _system.get_hardware_eligibility(request.app.state))


@system_router.get("/preflight")
async def system_preflight(request: Request) -> JSONResponse:
    # Optional ?bundle_id=<id>: size the resource checks against that specific
    # bundle (the frontend startup gate calls this between
    # /capability/primary-bundle and the switch). Omitted → legacy scoping.
    bundle_id = request.query_params.get("bundle_id")
    store = Store(default_db_path())
    try:
        return JSONResponse(
            await _system.get_preflight_info(
                store, request.app.state, bundle_id=bundle_id
            )
        )
    except _system.UnknownBundleError as exc:
        return error_response(
            "unknown_bundle",
            str(exc),
            status_code=404,
            details={"bundle_id": bundle_id},
        )
    finally:
        store.close()


@system_router.api_route(
    "/{path:path}",
    methods=["GET", "POST", "PUT", "DELETE", "PATCH"],
)
async def system_stub(path: str, request: Request) -> JSONResponse:
    return _route_not_found("/llm-router/v1/system", path, request.method)


# `/llm-router/v1/models/*` — GGUF registry + downloads.
models_router = APIRouter(prefix="/llm-router/v1/models", tags=["local.models"])


@models_router.get("")
async def models_list(_request: Request) -> JSONResponse:
    store = Store(default_db_path())
    try:
        model_list = _models.list_models(store)
        return JSONResponse({"models": model_list, "count": len(model_list)})
    finally:
        store.close()


@models_router.get("/status")
async def models_status(_request: Request) -> JSONResponse:
    store = Store(default_db_path())
    try:
        status = _models.models_status(store)
        return JSONResponse(status)
    finally:
        store.close()


@models_router.post("/{id}/downloads")
async def models_download(id: str, request: Request) -> JSONResponse:
    try:
        _ = _models.resolve_model_path(id)
    except ValueError:
        return error_response(
            "invalid_model_id",
            f"Invalid model id: {id!r}",
            status_code=422,
        )

    latest_downloads = _latest_model_downloads(request)
    operation_pool = _operation_pool(request)
    latest_operation_id = latest_downloads.get(id)
    if latest_operation_id is not None:
        latest_operation = await operation_pool.get(latest_operation_id)
        if latest_operation is not None and latest_operation["state"] not in TERMINAL_STATES:
            return JSONResponse(latest_operation, status_code=202)

    operation = await operation_pool.create("model_download", metadata={"model_id": id})
    operation_id = str(operation["operation_id"])
    latest_downloads[id] = operation_id
    running = await operation_pool.transition(
        operation_id,
        "running",
        pct=0,
        message="download requested",
    )
    if running is None:
        return error_response(
            "operation_not_found",
            f"Operation not found: {operation_id!r}",
            status_code=404,
        )
    return JSONResponse(running, status_code=202)


@models_router.get("/{id}/downloads/latest")
async def models_download_latest(id: str, request: Request) -> JSONResponse:
    try:
        _ = _models.resolve_model_path(id)
    except ValueError:
        return error_response(
            "invalid_model_id",
            f"Invalid model id: {id!r}",
            status_code=422,
        )

    operation_id = _latest_model_downloads(request).get(id)
    if operation_id is None:
        return error_response(
            "download_not_found",
            f"Download not found for model: {id!r}",
            status_code=404,
        )
    operation = await _operation_pool(request).get(operation_id)
    if operation is None:
        return error_response(
            "download_not_found",
            f"Download not found for model: {id!r}",
            status_code=404,
        )
    return JSONResponse(operation)


@models_router.api_route(
    "",
    methods=["POST", "PUT", "DELETE", "PATCH"],
)
async def models_root_stub(request: Request) -> JSONResponse:
    return _route_not_found("/llm-router/v1/models", "", request.method)


@models_router.post("/{id}/verifications")
async def models_verify(id: str, request: Request) -> JSONResponse:
    try:
        result = await asyncio.to_thread(
            _models.verify_model,
            id,
            request.app.state.registry,
            request.app.state.store,
        )
        return JSONResponse(result)
    except ValueError:
        return error_response(
            "invalid_model_id",
            f"Invalid model id: {id!r}",
            status_code=422,
        )
    except FileNotFoundError:
        return error_response(
            "model_not_found",
            f"Model not found: {id!r}",
            status_code=404,
        )


@models_router.delete("/{id}")
async def models_delete(id: str, _request: Request) -> JSONResponse:
    store = Store(default_db_path())
    try:
        try:
            result = await asyncio.to_thread(_models.delete_model, id, store)
            return JSONResponse(result)
        except ValueError:
            return error_response(
                "invalid_model_id",
                f"Invalid model id: {id!r}",
                status_code=422,
            )
        except FileNotFoundError:
            return error_response(
                "model_not_found",
                f"Model not found: {id!r}",
                status_code=404,
            )
        except RuntimeError as exc:
            return error_response(
                "model_in_use",
                str(exc),
                status_code=409,
            )
        except OSError as exc:
            return error_response(
                "cache_cleanup_failed",
                str(exc),
                status_code=500,
            )
    finally:
        store.close()


@models_router.api_route(
    "/{path:path}",
    methods=["GET", "POST", "PUT", "DELETE", "PATCH"],
)
async def models_stub(path: str, request: Request) -> JSONResponse:
    if path.endswith("/downloads") or path.endswith("/downloads/latest"):
        suffix = "/downloads/latest" if path.endswith("/downloads/latest") else "/downloads"
        model_id = path.removesuffix(suffix)
        try:
            _ = _models.resolve_model_path(model_id)
        except ValueError:
            return error_response(
                "invalid_model_id",
                f"Invalid model id: {model_id!r}",
                status_code=422,
            )
    return _route_not_found("/llm-router/v1/models", path, request.method)


def _operation_pool(request: Request) -> OperationPool:
    app = cast(FastAPI, request.app)
    return cast(OperationPool, app.state.operation_pool)


def _latest_model_downloads(request: Request) -> dict[str, str]:
    app = cast(FastAPI, request.app)
    state = app.state
    latest_model_downloads = getattr(state, "latest_model_downloads", None)
    if not isinstance(latest_model_downloads, dict):
        latest_model_downloads = {}
        state.latest_model_downloads = latest_model_downloads
    return cast(dict[str, str], latest_model_downloads)


# `/llm-router/v1/model-selections/*` — active local model per role.
model_selections_router = APIRouter(
    prefix="/llm-router/v1/model-selections",
    tags=["local.model-selections"],
)


@model_selections_router.get("")
async def model_selections_list(_request: Request) -> JSONResponse:
    store = Store(default_db_path())
    try:
        return JSONResponse(_selections.get_model_selections(store))
    finally:
        store.close()


class _SetLocalProviderBody(BaseModel):
    provider: str = Field(min_length=1)


# Registered BEFORE `PUT /{role}` on purpose: `/{role}` captures a single path
# segment, so it would otherwise swallow `PUT /local-provider` as
# ``role="local-provider"`` and reject it with ``invalid_role``. Route order is
# load-bearing here — see the route-ordering contract test.
@model_selections_router.put("/local-provider")
async def model_selections_set_local_provider(
    body: _SetLocalProviderBody,
) -> JSONResponse:
    if body.provider not in _selections.VALID_PROVIDERS:
        return error_response(
            "invalid_provider",
            f"Unknown local provider: {body.provider!r}. "
            f"Valid providers: {sorted(_selections.VALID_PROVIDERS)}",
            status_code=422,
        )
    store = Store(default_db_path())
    try:
        result = _selections.set_local_provider(store, body.provider)
    finally:
        store.close()

    # This only persists intent — it must NOT stop the shared llama-server.
    # Selecting `edge` here does not mean edge is reachable/connected yet (the
    # user may not have entered credentials, or Connect may still fail); tearing
    # the local runtime down on mere selection would leave the box with no
    # working provider until a real connection succeeds. The actual "connect
    # succeeded" signal — and the only place that stops the shared
    # RouterSupervisor for an edge switch — is a successful edge
    # `commit_primary_bundle` (capability/api.py), which by construction only
    # runs after `prepare_edge_bundle` has verified the endpoint is reachable.
    # See docs/design/2026-07-09_local_server_lifecycle_boot_resume.md §5.
    return JSONResponse(result)


# GET counterpart to `PUT /local-provider`. Registered before the `/{path:path}`
# stub so the literal path wins over the catch-all (which would 404
# ``route_not_found``). ``available_providers`` is hardware-gated by the offer
# rule: `edge` is always selectable, `llamacpp` only when the host is eligible to
# run a non-fallback local chat model — so an ineligible box never advertises
# `llamacpp` even though it is a member of ``VALID_PROVIDERS``.
@model_selections_router.get("/local-provider")
async def model_selections_get_local_provider(request: Request) -> JSONResponse:
    """Read the offerable local backends plus the current selection.

    ``available_providers`` applies the offer rule: `edge` always; `llamacpp` iff
    ``get_eligibility`` says the host can run a non-fallback local chat model
    (the same verdict `/status.eligibility` exposes). ``local_provider`` is the
    persisted choice, or ``null`` when local is not yet configured — reported
    independently of the menu, so a stale `llamacpp` selection on a now-ineligible
    box still round-trips (write-time vs resolve-time validation).
    """
    elig = await get_eligibility(request.app.state)
    available = {"edge"}
    if elig.eligible:
        available.add("llamacpp")
    store = Store(default_db_path())
    try:
        return JSONResponse(
            {
                "available_providers": sorted(available),
                "local_provider": _selections.get_local_provider(store),
            }
        )
    finally:
        store.close()


class _SetTierBody(BaseModel):
    tier: str = Field(min_length=1)


# Registered BEFORE `PUT /{role}` for the same reason as `/local-provider`: the
# single-segment `/{role}` capture would otherwise bind `PUT /tier` as
# ``role="tier"`` and reject it ``invalid_role``. Unlike that dumb KV writer,
# `/tier` is the hardware-gated chat picker (§3.5): it validates the tier against
# ``available_chat_tiers``, persists it as ``active_chat_model_id``, tears down a
# running chat server on a real change, then (downloads if needed +) respawns via
# the ensure-ready orchestrator — returning the same ``{state, operation_id}`` shape as
# POST /inference-servers/provisions so the UI can poll the operation.
@model_selections_router.put("/tier")
async def model_selections_set_tier(
    body: _SetTierBody, request: Request
) -> JSONResponse:
    app_state = request.app.state
    hw = await get_hardware(app_state)
    available = available_chat_tiers(app_state.registry, hw)
    if body.tier not in {entry.id for entry in available}:
        return error_response(
            "invalid_tier",
            f"Tier {body.tier!r} is not available on this hardware. "
            f"Available tiers: {[entry.id for entry in available]}",
            status_code=422,
        )

    # Persist the choice first so the selection is sticky even when the respawn
    # short-circuits: ensure-ready's fast path returns WITHOUT persisting when the
    # router is already serving the same tier (inference_logic.py:143-150,163).
    store = Store(default_db_path())
    try:
        _selections.set_model_selection(store, ROLE_CHAT, body.tier)
    finally:
        store.close()

    # Tear down a running chat server on a real tier change. ensure-ready fast-
    # paths (and the supervisor no-ops ensure_running) while chat is already
    # "ready"/"starting", so without an explicit stop the switch is silently
    # ignored. A same-tier re-select skips teardown (idempotent, no disruption).
    chat_sup = app_state.supervisor[ROLE_CHAT]
    snap = chat_sup.snapshot()
    if snap["state"] in ("ready", "starting") and snap["model_id"] != body.tier:
        await chat_sup.stop()

    await get_eligibility(app_state)
    result = await ensure_model_servers_ready(app_state, chat_model_id=body.tier)
    status_code = 202 if result.state == "running" else 200
    return JSONResponse(result.model_dump(), status_code=status_code)


# GET counterpart to `PUT /tier`. Registered before the `/{path:path}` stub so
# the literal path wins over the catch-all (which would 404 ``route_not_found``).
@model_selections_router.get("/tier")
async def model_selections_get_tier(request: Request) -> JSONResponse:
    """Read the hardware-gated chat-tier menu plus the current selection.

    Returns the same ``{available_tiers, selected_tier}`` shape `/status`
    exposes — both are fed by ``system.get_tier_selection`` — so a tier picker
    reads what is selectable and what is currently selected in one call.
    ``available_tiers`` is empty on an ineligible host; ``selected_tier`` still
    defaults to the biggest eligible tier (§3.5).
    """
    app_state = request.app.state
    store = Store(default_db_path())
    try:
        return JSONResponse(await _system.get_tier_selection(app_state, store))
    finally:
        store.close()


# Registered BEFORE the `/{path:path}` stub so the literal `DELETE /tier` wins
# over the catch-all (which would 404 ``route_not_found``). This is the
# "disconnect" action: it stops the shared chat server AND clears the persisted
# chat tier selection, atomically, so the user can then delete the tier's GGUF
# file without the running llama-server holding the mmap open (Windows unlink
# would fail with the file in use). Stop precedes clear: chat + the co-hosted
# embedding share one RouterSupervisor, so a single stop() on the chat facade
# releases GPU/RAM and the file handle for both roles. Guarded on a live
# snapshot so it is a no-op when nothing is running (and idempotent on repeat).
@model_selections_router.delete("/tier")
async def model_selections_disconnect_tier(request: Request) -> JSONResponse:
    app_state = request.app.state
    chat_sup = app_state.supervisor[ROLE_CHAT]
    snap = chat_sup.snapshot()
    stopped = snap["state"] in ("ready", "starting")
    if stopped:
        await chat_sup.stop()

    store = Store(default_db_path())
    try:
        _selections.clear_model_selection(store, ROLE_CHAT)
    finally:
        store.close()

    return JSONResponse(
        {"success": True, "role": "chat", "model_id": None, "stopped": stopped}
    )


class _SetSelectionBody(BaseModel):
    model_id: str = Field(min_length=1)


@model_selections_router.put("/{role}")
async def model_selections_set(
    role: str, body: _SetSelectionBody, _request: Request
) -> JSONResponse:
    if role not in _selections.VALID_ROLES:
        return error_response(
            "invalid_role",
            f"Unknown model selection role: {role!r}. Valid roles: {sorted(_selections.VALID_ROLES)}",
            status_code=400,
        )
    store = Store(default_db_path())
    try:
        result = _selections.set_model_selection(store, role, body.model_id)
        return JSONResponse(result)
    finally:
        store.close()


@model_selections_router.api_route(
    "/{path:path}",
    methods=["GET", "POST", "PUT", "DELETE", "PATCH"],
)
async def model_selections_stub(path: str, request: Request) -> JSONResponse:
    return _route_not_found("/llm-router/v1/model-selections", path, request.method)


# `/llm-router/v1/inference-servers/*` — llama-server read/log/probe.
inference_servers_router = APIRouter(
    prefix="/llm-router/v1/inference-servers",
    tags=["local.inference-servers"],
)

_VALID_ROLES = _inference_servers.VALID_ROLES
_VALID_ACTIONS = ("start", "stop", "restart")


class _InferenceServerActionBody(BaseModel):
    action: str
    model_id: str | None = None


@inference_servers_router.get("")
async def inference_servers_list(request: Request) -> JSONResponse:
    return JSONResponse(_inference_servers.list_servers(request.app.state))


@inference_servers_router.post("/provisions")
async def inference_servers_provision(request: Request) -> JSONResponse:
    """Provision the local llama-server for both roles (download + launch).

    Runs the strict eligibility gate first (caching the verdict on
    ``app.state`` so ``ensure_model_servers_ready`` sees it), then hands off
    to the ensure-ready orchestrator. On an ineligible host the result is
    ``state="skipped"`` with no download or spawn — the Tauri shell normally
    avoids this call on such hosts, but any caller hits the same gate here.
    Returns 202 while an orchestration operation is running, else 200
    (``ready`` / ``skipped``).
    """
    app_state = request.app.state
    await get_eligibility(app_state)
    result = await ensure_model_servers_ready(app_state)
    status_code = 202 if result.state == "running" else 200
    return JSONResponse(result.model_dump(), status_code=status_code)


@inference_servers_router.get("/{role}/logs")
async def inference_servers_logs(role: str, request: Request) -> JSONResponse:
    if role not in _VALID_ROLES:
        return error_response(
            "invalid_role",
            f"Unknown inference server role: {role!r}. Valid roles: {list(_VALID_ROLES)}",
            status_code=404,
        )
    tail_raw = request.query_params.get("tail", "100")
    try:
        tail = int(tail_raw)
    except ValueError:
        tail = 100
    return JSONResponse(_inference_servers.get_server_logs(role, tail=tail))


@inference_servers_router.get("/{role}/probes")
async def inference_servers_probes(role: str, request: Request) -> JSONResponse:
    if role not in _VALID_ROLES:
        return error_response(
            "invalid_role",
            f"Unknown inference server role: {role!r}. Valid roles: {list(_VALID_ROLES)}",
            status_code=404,
        )
    probes = await asyncio.to_thread(_inference_servers.get_server_probes, role, request.app.state)
    return JSONResponse(probes)


@inference_servers_router.post("/{role}/actions")
async def inference_servers_action(role: str, request: Request) -> JSONResponse:
    if role not in _VALID_ROLES:
        return error_response(
            "invalid_role",
            f"Unknown inference server role: {role!r}. Valid roles: {list(_VALID_ROLES)}",
            status_code=404,
        )

    try:
        body = _InferenceServerActionBody.model_validate(await request.json())
    except (ValidationError, ValueError):
        return error_response(
            "invalid_body",
            "Request body must include an action string.",
            status_code=422,
        )

    if body.action not in _VALID_ACTIONS:
        return error_response(
            "invalid_action",
            f"Unknown inference server action: {body.action!r}. Valid actions: {list(_VALID_ACTIONS)}",
            status_code=422,
        )

    metadata: dict[str, object] = {"role": role, "action": body.action}
    if body.model_id is not None:
        metadata["model_id"] = body.model_id

    operation_pool = _operation_pool(request)
    operation = await operation_pool.create(
        "inference_server_action",
        metadata=metadata,
    )
    operation_id = str(operation["operation_id"])
    running = await operation_pool.transition(
        operation_id,
        "running",
        pct=0,
        message="action requested",
    )
    if running is None:
        return error_response(
            "operation_not_found",
            f"Operation not found: {operation_id!r}",
            status_code=404,
        )
    return JSONResponse(running, status_code=202)


@inference_servers_router.api_route(
    "",
    methods=["POST", "PUT", "DELETE", "PATCH"],
)
async def inference_servers_root_stub(request: Request) -> JSONResponse:
    return _route_not_found("/llm-router/v1/inference-servers", "", request.method)


@inference_servers_router.api_route(
    "/{path:path}",
    methods=["GET", "POST", "PUT", "DELETE", "PATCH"],
)
async def inference_servers_stub(path: str, request: Request) -> JSONResponse:
    return _route_not_found("/llm-router/v1/inference-servers", path, request.method)
