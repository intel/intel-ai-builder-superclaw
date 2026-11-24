"""Fan-out operations across ServiceHub-managed child services."""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import Awaitable, Callable
from typing import Protocol

from loguru import logger

from servicehub.operations.tracker import OperationTracker
from servicehub.proxy.service_client import ServiceClient, ServiceClientError, ServiceClientResult
from servicehub.supervisor.registry import ServiceInfo


class ProcessManagerProtocol(Protocol):
    async def restart_service(self, name: str, *, reason: str) -> None: ...

    async def shutdown_all(self) -> None: ...


EventCallback = Callable[[str, str | None, dict[str, object]], Awaitable[None]]


async def provision_services(
    *,
    tracker: OperationTracker,
    service_client: ServiceClient,
    services: list[ServiceInfo],
    operation_id: str,
    event_callback: EventCallback | None = None,
) -> dict[str, ServiceInfo]:
    running_services = [
        service
        for service in services
        if service.state == "running" and service.name != "sandbox_manager"
    ]
    logger.info(
        "provision_services operation_id={} total={} running={}",
        operation_id,
        len(services),
        len(running_services),
    )
    if not running_services:
        snapshot = await tracker.mark_done(operation_id)
        await _emit_parent_event(event_callback, snapshot)
        return {}
    await asyncio.gather(
        *[
            _provision_service(
                tracker=tracker,
                service_client=service_client,
                service=service,
                operation_id=operation_id,
                event_callback=event_callback,
            )
            for service in running_services
        ]
    )
    snapshot = await tracker.recompute(operation_id)
    await _emit_parent_event(event_callback, snapshot)
    return await _services_by_child_operation(
        tracker=tracker,
        services=running_services,
        operation_id=operation_id,
    )


async def restart_services(
    *,
    tracker: OperationTracker,
    process_manager: ProcessManagerProtocol,
    services: list[ServiceInfo],
    operation_id: str,
    event_callback: EventCallback | None = None,
) -> None:
    logger.info("restart_services operation_id={} count={}", operation_id, len(services))
    if not services:
        snapshot = await tracker.mark_done(operation_id)
        await _emit_parent_event(event_callback, snapshot)
        return
    for service in services:
        try:
            await process_manager.restart_service(service.name, reason="manual")
        except Exception as exc:
            logger.error(
                "restart_services failed service={} operation_id={} error_type={} detail={}",
                service.name,
                operation_id,
                type(exc).__name__,
                str(exc),
            )
            await tracker.add_child(
                operation_id,
                service=service.name,
                child_operation_id=None,
                state="error",
                pct=0,
                error={"code": "restart_failed", "message": str(exc)},
            )
            await _emit_event(
                event_callback,
                service.name,
                None,
                {"operation_id": None, "state": "error", "pct": 0, "message": "Restart failed"},
            )
            continue
        await tracker.add_child(
            operation_id,
            service=service.name,
            child_operation_id=None,
            state="done",
            pct=100,
            error=None,
        )
        await _emit_event(
            event_callback,
            service.name,
            None,
            {"operation_id": None, "state": "done", "pct": 100},
        )
    snapshot = await tracker.recompute(operation_id)
    await _emit_parent_event(event_callback, snapshot)


async def shutdown_services(
    *,
    tracker: OperationTracker,
    process_manager: ProcessManagerProtocol,
    services: list[ServiceInfo],
    operation_id: str,
    request_hub_shutdown: Callable[[], None] | None = None,
    event_callback: EventCallback | None = None,
) -> None:
    logger.info("shutdown_services operation_id={} count={}", operation_id, len(services))
    try:
        await process_manager.shutdown_all()
    except Exception as exc:
        logger.error(
            "shutdown_services failed operation_id={} error_type={} detail={}",
            operation_id,
            type(exc).__name__,
            str(exc),
        )
        snapshot = await tracker.mark_error(
            operation_id,
            service="servicehub",
            error={"code": "shutdown_failed", "message": str(exc)},
        )
        await _emit_parent_event(event_callback, snapshot)
        return
    for service in services:
        await tracker.add_child(
            operation_id,
            service=service.name,
            child_operation_id=None,
            state="done",
            pct=100,
            error=None,
        )
        await _emit_event(
            event_callback,
            service.name,
            None,
            {"operation_id": None, "state": "done", "pct": 100},
        )
    snapshot = await tracker.mark_done(operation_id)
    await _emit_parent_event(event_callback, snapshot)
    if callable(request_hub_shutdown):
        request_hub_shutdown()


async def poll_child_operations(
    *,
    tracker: OperationTracker,
    service_client: ServiceClient,
    services_by_operation: dict[str, ServiceInfo],
    operation_id: str,
    interval_s: float = 0.5,
    event_callback: EventCallback | None = None,
) -> None:
    last_parent_signature: tuple[object, object] | None = None
    while True:
        parent = await tracker.get(operation_id)
        if parent is None or parent["state"] != "running":
            return
        last_parent_signature = last_parent_signature or _parent_signature(parent)
        child_ids = [
            child["operation_id"]
            for child in parent["children"]
            if isinstance(child, dict) and isinstance(child.get("operation_id"), str)
        ]
        if not child_ids:
            return
        for child_id in child_ids:
            service = services_by_operation.get(child_id)
            if service is None:
                continue
            result = await service_client.request_json(service, "GET", f"/v1/operations/{child_id}")
            await _update_child_from_poll_result(
                tracker=tracker,
                operation_id=operation_id,
                child_operation_id=child_id,
                service=service,
                result=result,
                event_callback=event_callback,
            )
        snapshot = await tracker.recompute(operation_id)
        signature = _parent_signature(snapshot)
        if signature != last_parent_signature:
            await _emit_parent_event(event_callback, snapshot)
            last_parent_signature = signature
        await asyncio.sleep(interval_s)


async def cancel_child_operations(
    *,
    tracker: OperationTracker,
    service_client: ServiceClient,
    services: list[ServiceInfo],
    operation_id: str,
) -> dict[str, object]:
    child_services = await tracker.child_operation_services(operation_id)
    services_by_name = {service.name: service for service in services}
    for child_operation_id, service_name in child_services.items():
        service = services_by_name.get(service_name)
        if service is None or service.state != "running":
            continue
        await service_client.request_json(
            service,
            "POST",
            f"/v1/operations/{child_operation_id}/cancellations",
        )
    return await tracker.cancel(operation_id)


async def _provision_service(
    *,
    tracker: OperationTracker,
    service_client: ServiceClient,
    service: ServiceInfo,
    operation_id: str,
    event_callback: EventCallback | None = None,
) -> None:
    result = await service_client.request_json(service, "POST", "/v1/system/provisions")
    if isinstance(result, ServiceClientError):
        logger.warning(
            "provision_service unavailable service={} operation_id={} error_type={}",
            service.name,
            operation_id,
            result.error_type,
        )
        await tracker.add_child(
            operation_id,
            service=service.name,
            child_operation_id=None,
            state="error",
            pct=0,
            error=result.as_dict(),
        )
        await _emit_event(
            event_callback,
            service.name,
            None,
            {"operation_id": None, "state": "error", "pct": 0, "message": "Service unavailable"},
        )
        return
    if result.status_code == 404:
        logger.debug(
            "provision_service skipped service={} operation_id={} reason=not_implemented",
            service.name,
            operation_id,
        )
        await tracker.add_child(
            operation_id,
            service=service.name,
            child_operation_id=None,
            state="skipped",
            pct=100,
            error=None,
        )
        await _emit_event(
            event_callback,
            service.name,
            None,
            {"operation_id": None, "state": "skipped", "pct": 100},
        )
        return
    if result.status_code >= 400:
        logger.warning(
            "provision_service error service={} operation_id={} status={}",
            service.name,
            operation_id,
            result.status_code,
        )
        await tracker.add_child(
            operation_id,
            service=service.name,
            child_operation_id=None,
            state="error",
            pct=0,
            error=_upstream_error(result),
        )
        await _emit_event(
            event_callback,
            service.name,
            None,
            {"operation_id": None, "state": "error", "pct": 0, "message": "Upstream service returned an error"},
        )
        return
    payload = result.payload if isinstance(result.payload, dict) else {}
    child_operation_id = payload.get("operation_id") if isinstance(payload.get("operation_id"), str) else None
    state = _state_from_payload(payload)
    pct = payload.get("pct") if isinstance(payload.get("pct"), int) else 100 if child_operation_id is None else 0
    await tracker.add_child(
        operation_id,
        service=service.name,
        child_operation_id=child_operation_id,
        state=state,
        pct=pct,
        error=None,
    )
    await _emit_event(
        event_callback,
        service.name,
        child_operation_id,
        _operation_progress_payload(payload, child_operation_id, state, pct),
    )


async def _update_child_from_poll_result(
    *,
    tracker: OperationTracker,
    operation_id: str,
    child_operation_id: str,
    service: ServiceInfo,
    result: ServiceClientResult | ServiceClientError,
    event_callback: EventCallback | None = None,
) -> None:
    if isinstance(result, ServiceClientError):
        await tracker.update_child(
            operation_id,
            child_operation_id=child_operation_id,
            state="error",
            pct=0,
            error=result.as_dict(),
        )
        await _emit_event(
            event_callback,
            service.name,
            child_operation_id,
            {"operation_id": child_operation_id, "state": "error", "pct": 0, "message": "Service unavailable"},
        )
        return
    if result.status_code >= 400:
        await tracker.update_child(
            operation_id,
            child_operation_id=child_operation_id,
            state="error",
            pct=0,
            error=_upstream_error(result),
        )
        await _emit_event(
            event_callback,
            service.name,
            child_operation_id,
            {"operation_id": child_operation_id, "state": "error", "pct": 0, "message": "Upstream service returned an error"},
        )
        return
    payload = result.payload if isinstance(result.payload, dict) else {}
    pct = payload.get("pct") if isinstance(payload.get("pct"), int) else 0
    state = _state_from_payload(payload)
    await tracker.update_child(
        operation_id,
        child_operation_id=child_operation_id,
        state=state,
        pct=pct,
        error=None,
    )
    await _emit_event(event_callback, service.name, child_operation_id, _operation_progress_payload(payload, child_operation_id, state, pct))


async def _emit_event(
    event_callback: EventCallback | None,
    service: str,
    operation_id: str | None,
    payload: dict[str, object],
) -> None:
    if event_callback is None:
        return
    with contextlib.suppress(Exception):
        await event_callback(service, operation_id, payload)


async def _emit_parent_event(
    event_callback: EventCallback | None,
    snapshot: dict[str, object],
) -> None:
    operation_id = snapshot.get("operation_id")
    if not isinstance(operation_id, str):
        return
    state = snapshot.get("state") if isinstance(snapshot.get("state"), str) else "running"
    pct = snapshot.get("pct") if isinstance(snapshot.get("pct"), int) else 0
    await _emit_event(
        event_callback,
        "servicehub",
        operation_id,
        {"operation_id": operation_id, "state": state, "pct": pct},
    )


def _parent_signature(snapshot: dict[str, object]) -> tuple[object, object]:
    return snapshot.get("state"), snapshot.get("pct")


def _operation_progress_payload(
    payload: dict[str, object],
    operation_id: str | None,
    state: str,
    pct: int,
) -> dict[str, object]:
    event_payload = dict(payload)
    event_payload["operation_id"] = operation_id
    event_payload["state"] = state
    event_payload["pct"] = pct
    return event_payload


def _state_from_payload(payload: dict[str, object]) -> str:
    state = payload.get("state")
    if state in {"running", "done", "error", "cancelled", "skipped"}:
        return str(state)
    return "running" if isinstance(payload.get("operation_id"), str) else "done"


def _upstream_error(result: ServiceClientResult) -> dict[str, str]:
    if isinstance(result.payload, dict):
        error = result.payload.get("error")
        if isinstance(error, dict) and isinstance(error.get("code"), str) and isinstance(error.get("message"), str):
            return {"code": error["code"], "message": error["message"]}
    return {"code": "upstream_error", "message": "Upstream service returned an error"}


async def _services_by_child_operation(
    *,
    tracker: OperationTracker,
    services: list[ServiceInfo],
    operation_id: str,
) -> dict[str, ServiceInfo]:
    child_services = await tracker.child_operation_services(operation_id)
    services_by_name = {service.name: service for service in services}
    return {
        child_operation_id: services_by_name[service_name]
        for child_operation_id, service_name in child_services.items()
        if service_name in services_by_name
    }
