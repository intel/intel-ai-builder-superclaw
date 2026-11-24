"""ServiceHub-owned system fan-out operation routes."""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import APIRouter, Request, status
from fastapi.responses import JSONResponse
from loguru import logger

from servicehub.app_routes.events import sanitize_event_payload
from servicehub.operations.fanout import poll_child_operations, provision_services, restart_services, shutdown_services
from servicehub.supervisor.registry import ServiceInfo


OperationEventCallback = Callable[[str, str | None, dict[str, object]], Awaitable[None]]


router = APIRouter(prefix="/app/system")


def _request_audit_fields(request: Request) -> dict[str, Any]:
    client = request.client
    return {
        "method": request.method,
        "path": request.url.path,
        "client": client.host if client is not None else "unknown",
    }


@router.post("/provisions")
async def system_provisions(request: Request) -> JSONResponse:
    tracker = request.app.state.operation_tracker
    if await tracker.has_running("provisions"):
        _log_management_rejection(
            request,
            action="provisions",
            reason="provisions_already_running",
        )
        return JSONResponse(
            status_code=status.HTTP_409_CONFLICT,
            content={
                "error": {
                    "code": "provisions_already_running",
                    "message": "A provisions operation is already in progress",
                }
            },
        )
    operation = await tracker.create("provisions")
    operation_id = str(operation["operation_id"])
    services = _services_snapshot(request)
    _log_management_action(request, action="provisions", operation_id=operation_id, services=services)

    async def emit_operation_event(service: str, child_operation_id: str | None, payload: dict[str, object]) -> None:
        await _emit_operation_event(request, service, child_operation_id, payload)

    async def run() -> None:
        await _run_provisions(
            tracker=tracker,
            service_client=request.app.state.service_client,
            services=services,
            operation_id=operation_id,
            event_callback=emit_operation_event,
            poll_interval_s=float(getattr(request.app.state, "operation_poll_interval_s", 0.5)),
        )
        await _log_management_completion(
            request,
            action="provisions",
            operation_id=operation_id,
            tracker=tracker,
        )

    task = asyncio.create_task(run())
    _track_background_task(request, task)
    await _drain_task_if_test_override(request, task)
    snapshot = await tracker.get(operation_id)
    return JSONResponse(status_code=status.HTTP_202_ACCEPTED, content=snapshot or operation)


@router.post("/restart")
async def system_restart(request: Request) -> JSONResponse:
    tracker = request.app.state.operation_tracker
    operation = await tracker.create("restart")
    operation_id = str(operation["operation_id"])
    services = _services_snapshot(request)
    _log_management_action(request, action="restart", operation_id=operation_id, services=services)

    async def emit_operation_event(service: str, child_operation_id: str | None, payload: dict[str, object]) -> None:
        await _emit_operation_event(request, service, child_operation_id, payload)

    async def run() -> None:
        await _run_with_boundary(
            restart_services(
                tracker=tracker,
                process_manager=request.app.state.process_manager,
                services=services,
                operation_id=operation_id,
                event_callback=emit_operation_event,
            ),
            tracker=tracker,
            operation_id=operation_id,
        )
        await _log_management_completion(
            request,
            action="restart",
            operation_id=operation_id,
            tracker=tracker,
        )

    task = asyncio.create_task(run())
    _track_background_task(request, task)
    await _drain_task_if_test_override(request, task)
    snapshot = await tracker.get(operation_id)
    return JSONResponse(status_code=status.HTTP_202_ACCEPTED, content=snapshot or operation)


@router.post("/shutdown")
async def system_shutdown(request: Request) -> JSONResponse:
    tracker = request.app.state.operation_tracker
    operation = await tracker.create("shutdown")
    operation_id = str(operation["operation_id"])
    services = _services_snapshot(request)
    _log_management_action(request, action="shutdown", operation_id=operation_id, services=services)

    async def emit_operation_event(service: str, child_operation_id: str | None, payload: dict[str, object]) -> None:
        await _emit_operation_event(request, service, child_operation_id, payload)

    async def run() -> None:
        await _run_with_boundary(
            shutdown_services(
                tracker=tracker,
                process_manager=request.app.state.process_manager,
                services=services,
                operation_id=operation_id,
                request_hub_shutdown=getattr(request.app.state, "request_hub_shutdown", None),
                event_callback=emit_operation_event,
            ),
            tracker=tracker,
            operation_id=operation_id,
        )
        await _log_management_completion(
            request,
            action="shutdown",
            operation_id=operation_id,
            tracker=tracker,
        )

    task = asyncio.create_task(run())
    _track_background_task(request, task)
    await _drain_task_if_test_override(request, task)
    snapshot = await tracker.get(operation_id)
    return JSONResponse(status_code=status.HTTP_202_ACCEPTED, content=snapshot or operation)


def _services_snapshot(request: Request) -> list[ServiceInfo]:
    return list(request.app.state.process_manager.registry.all())


def _log_management_action(
    request: Request,
    *,
    action: str,
    operation_id: str,
    services: list[ServiceInfo],
) -> None:
    fields = _request_audit_fields(request)
    logger.info(
        "management action={} phase=accepted operation_id={} method={} path={} client={} services={}",
        action,
        operation_id,
        fields["method"],
        fields["path"],
        fields["client"],
        ",".join(service.name for service in services) or "none",
    )


async def _log_management_completion(
    request: Request,
    *,
    action: str,
    operation_id: str,
    tracker,
) -> None:
    snapshot = await tracker.get(operation_id)
    state = snapshot.get("state") if isinstance(snapshot, dict) else "unknown"
    fields = _request_audit_fields(request)
    logger.info(
        "management action={} phase=completed operation_id={} state={} method={} path={} client={}",
        action,
        operation_id,
        state,
        fields["method"],
        fields["path"],
        fields["client"],
    )


def _log_management_rejection(
    request: Request,
    *,
    action: str,
    reason: str,
) -> None:
    fields = _request_audit_fields(request)
    logger.warning(
        "management action={} phase=rejected reason={} method={} path={} client={}",
        action,
        reason,
        fields["method"],
        fields["path"],
        fields["client"],
    )


def _track_background_task(request: Request, task: asyncio.Task[None]) -> None:
    tasks = getattr(request.app.state, "background_tasks", None)
    if tasks is None:
        tasks = []
        request.app.state.background_tasks = tasks
    tasks.append(task)
    task.add_done_callback(lambda done: tasks.remove(done) if done in tasks else None)


async def _drain_task_if_test_override(request: Request, task: asyncio.Task[None]) -> None:
    if getattr(request.app.state, "drain_background_tasks_for_tests", False):
        await task


async def _run_provisions(
    *,
    tracker,
    service_client,
    services: list[ServiceInfo],
    operation_id: str,
    event_callback: OperationEventCallback | None,
    poll_interval_s: float,
) -> None:
    async def run() -> None:
        child_services = await provision_services(
            tracker=tracker,
            service_client=service_client,
            services=services,
            operation_id=operation_id,
            event_callback=event_callback,
        )
        if child_services:
            await poll_child_operations(
                tracker=tracker,
                service_client=service_client,
                services_by_operation=child_services,
                operation_id=operation_id,
                interval_s=poll_interval_s,
                event_callback=event_callback,
            )

    await _run_with_boundary(run(), tracker=tracker, operation_id=operation_id)


async def _emit_operation_event(request: Request, service: str, operation_id: str | None, payload: dict[str, object]) -> None:
    await request.app.state.event_buffer.append(
        event_type="operation.progress",
        service=service,
        operation_id=operation_id,
        payload=sanitize_event_payload(payload),
    )


async def _run_with_boundary(coro, *, tracker=None, operation_id: str | None = None) -> None:
    try:
        await coro
    except Exception as exc:
        logger.exception("Background operation {} failed", operation_id)
        if tracker is not None and operation_id is not None:
            with contextlib.suppress(Exception):
                await tracker.mark_error(
                    operation_id,
                    service="servicehub",
                    error={"code": "internal_error", "message": str(exc)},
                )
