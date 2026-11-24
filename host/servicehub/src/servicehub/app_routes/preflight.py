"""ServiceHub system preflight aggregate route."""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response

from servicehub.common.errors import error_body
from servicehub.proxy.router import resolve_service
from servicehub.proxy.service_client import ServiceClientError, ServiceClientResult
from servicehub.supervisor.registry import ServiceInfo


router = APIRouter(prefix="/app/system")

# Not prefixed under /app: this shadows the App's direct LRM preflight probe
# (`GET /llm-router/v1/system/preflight`), which otherwise falls through to
# `ProxyFallbackMiddleware`'s generic pass-through with no coordinator
# awareness at all.
lrm_preflight_router = APIRouter()


@lrm_preflight_router.get("/llm-router/v1/system/preflight")
async def llm_router_system_preflight(request: Request) -> Response:
    """Gate the App's LRM memory/hardware preflight probe on boot recovery.

    The activation coordinator's boot-time recovery sweep can resume a
    leftover non-terminal activation (e.g. re-issue the LRM `commit` call
    that spawns the model) fully independently of the App. Without this
    gate, the App's preflight probe could sample free RAM while that
    recovery-driven load was already under way, reporting memory already
    consumed by it as "insufficient" against the true idle baseline. Block
    with the same 423 + Retry-After shape `/app/capability-profile` already
    uses for this instead of racing it.
    """
    capability = getattr(request.app.state, "capability", None)
    coordinator = getattr(capability, "model_binding_activation_coordinator", None)
    if coordinator is not None and coordinator.recovering:
        raise HTTPException(
            status_code=423,
            detail=error_body(
                "system_preflight_recovery_in_progress",
                "Model Binding Activation recovery is in progress; retry shortly.",
            ),
            headers={"Retry-After": "1"},
        )
    service = resolve_service(request.app.state.process_manager.registry, "/llm-router")
    return await request.app.state.proxy_forwarder.forward(request, service)


@router.get("/preflight")
async def system_preflight(request: Request) -> dict[str, object]:
    services = await asyncio.gather(
        *[_preflight_entry(request, service) for service in request.app.state.process_manager.registry.all()]
    )
    return {
        "ready": all(service["ready"] for service in services),
        "services": services,
    }


async def _preflight_entry(request: Request, service: ServiceInfo) -> dict[str, Any]:
    base = {
        "name": service.name,
        "proxy_prefix": service.proxy_prefix,
        "port": service.port,
    }
    result = await request.app.state.service_client.request_json(service, "GET", "/v1/system/preflight")
    if isinstance(result, ServiceClientError):
        return {
            **base,
            "preflight_supported": True,
            "ready": False,
            "checks": [],
            "missing_resources": [],
            "error": result.as_dict(),
        }
    if result.status_code == 404:
        return {
            **base,
            "preflight_supported": False,
            "ready": True,
            "checks": [],
            "missing_resources": [],
            "error": None,
        }
    if result.status_code >= 400:
        return {
            **base,
            "preflight_supported": True,
            "ready": False,
            "checks": [],
            "missing_resources": [],
            "error": _upstream_error(result),
        }
    payload = result.payload if isinstance(result.payload, dict) else {}
    return {
        **base,
        "preflight_supported": True,
        "ready": payload.get("ready") is True,
        "checks": payload.get("checks") if isinstance(payload.get("checks"), list) else [],
        "missing_resources": payload.get("missing_resources") if isinstance(payload.get("missing_resources"), list) else [],
        "error": None,
    }


def _upstream_error(result: ServiceClientResult) -> dict[str, str]:
    if isinstance(result.payload, dict):
        error = result.payload.get("error")
        if isinstance(error, dict) and isinstance(error.get("code"), str) and isinstance(error.get("message"), str):
            return {"code": error["code"], "message": error["message"]}
    return {"code": "upstream_error", "message": "Upstream service returned an error"}
