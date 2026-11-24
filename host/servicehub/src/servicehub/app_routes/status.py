"""ServiceHub service status and health aggregate routes."""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, Request

from servicehub.proxy.service_client import ServiceClientError, ServiceClientResult
from servicehub.supervisor.registry import ServiceInfo


router = APIRouter(prefix="/app/services")
_CHILD_HEALTH_PROBE_TIMEOUT_S = 3.0


@router.get("/catalog")
async def services_catalog(request: Request) -> dict[str, object]:
    """Declared services and their PROCESS lifecycle state, for feature discovery.

    `state` here answers "is this feature's process up" (`running`, `starting`,
    `error`, `stopped`, `dormant`) so the App can discover which optional features
    exist without probing a child or starting a dormant one.

    It is deliberately NOT a readiness verdict, and `running` is not `ready`: a live
    process that has stopped honoring its health contract still reports `running`.
    Product readiness has one authority, `GET /app/readiness`, which requires
    positive, fresh, identity-matched health evidence on top of this state.
    """
    return {"services": request.app.state.process_manager.service_catalog()}


@router.get("/health")
async def services_health(request: Request) -> dict[str, object]:
    services = await asyncio.gather(
        *[_health_entry(request, service) for service in _services(request)]
    )
    return {
        "healthy": all(service["healthy"] for service in services),
        "services": services,
    }


@router.get("/status")
async def services_status(request: Request) -> dict[str, object]:
    services = await asyncio.gather(
        *[_status_entry(request, service) for service in _services(request)]
    )
    return {
        "ok": all(service["error"] is None for service in services),
        "services": services,
    }


def _services(request: Request) -> list[ServiceInfo]:
    return request.app.state.process_manager.registry.all()


async def _health_entry(request: Request, service: ServiceInfo) -> dict[str, object]:
    registry_healthy = service.state == "running"
    probe_healthy = False
    if registry_healthy:
        try:
            probe_healthy = await asyncio.wait_for(
                _probe_service_health(request, service),
                timeout=_CHILD_HEALTH_PROBE_TIMEOUT_S,
            )
        except asyncio.TimeoutError:
            probe_healthy = False
    healthy = registry_healthy and probe_healthy
    return {
        "name": service.name,
        "proxy_prefix": service.proxy_prefix,
        "port": service.port,
        "state": service.state,
        "healthy": healthy,
        "registry_healthy": registry_healthy,
        "probe_healthy": probe_healthy,
        "failure_count": service.failure_count,
        "restart_attempts": service.restart_attempts,
        "instance_id": service.instance_id,
    }


async def _probe_service_health(request: Request, service: ServiceInfo) -> bool:
    result = await request.app.state.service_client.request_json(service, "GET", "/v1/health")
    if isinstance(result, ServiceClientError):
        return False
    if result.status_code != 200 or not isinstance(result.payload, dict):
        return False
    return (
        result.payload.get("service") == service.name
        and result.payload.get("status") == "ok"
        and result.payload.get("instance_id") == service.instance_id
    )


async def _status_entry(request: Request, service: ServiceInfo) -> dict[str, Any]:
    base = {
        "name": service.name,
        "proxy_prefix": service.proxy_prefix,
        "port": service.port,
        "state": service.state,
    }
    result = await request.app.state.service_client.request_json(service, "GET", "/v1/status")
    if isinstance(result, ServiceClientError):
        return {
            **base,
            "status_supported": True,
            "status": None,
            "error": result.as_dict(),
        }
    if result.status_code == 404:
        return {**base, "status_supported": False, "status": None, "error": None}
    if result.status_code >= 400:
        return {
            **base,
            "status_supported": True,
            "status": None,
            "error": _upstream_error(result),
        }
    return {
        **base,
        "status_supported": True,
        "status": result.payload,
        "error": None,
    }


def _upstream_error(result: ServiceClientResult) -> dict[str, str]:
    if isinstance(result.payload, dict):
        error = result.payload.get("error")
        if isinstance(error, dict) and isinstance(error.get("code"), str) and isinstance(error.get("message"), str):
            return {"code": error["code"], "message": error["message"]}
    return {"code": "upstream_error", "message": "Upstream service returned an error"}
