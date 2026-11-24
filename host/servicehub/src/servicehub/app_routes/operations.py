"""ServiceHub operation lookup and cancellation routes."""

from __future__ import annotations

import re
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Request, status

from servicehub.common.errors import error_body
from servicehub.operations.compatibility import adapt_operation_payload, child_operation_id
from servicehub.operations.fanout import cancel_child_operations
from servicehub.proxy.error_normalizer import service_unavailable
from servicehub.proxy.service_client import ServiceClientError, ServiceClientResult
from servicehub.supervisor.registry import ServiceInfo


router = APIRouter(prefix="/app/operations")

_OPERATION_PREFIX_TO_PROXY_PREFIX = {
    "lrm:": "/llm-router",
    "sm:": "/sandbox-manager",
    "sec:": "/file-guard",
}
_OPERATION_ID_PATTERN = re.compile(r"^[A-Za-z][A-Za-z0-9_-]*:[A-Za-z0-9][A-Za-z0-9._-]*$")


@router.post("/{operation_id}/cancellations")
async def cancel_operation(operation_id: str, request: Request) -> Any:
    _validate_operation_id(operation_id)
    if operation_id.startswith("hub:"):
        coordinator = _model_binding_activation_coordinator(request)
        if coordinator is not None:
            record = await coordinator.cancel(operation_id)
            if record is not None:
                return request.app.state.capability.activation_receipt_store.to_projection(record)
        services = list(request.app.state.process_manager.registry.all())
        return await cancel_child_operations(
            tracker=request.app.state.operation_tracker,
            service_client=request.app.state.service_client,
            services=services,
            operation_id=operation_id,
        )
    service = _resolve_operation_service(request, operation_id)
    upstream_operation_id = _child_operation_id(service, operation_id)
    result = await request.app.state.service_client.request_json(
        service,
        "POST",
        _cancellation_path(service, upstream_operation_id),
    )
    return _operation_response(result, service, mode="cancellation")


@router.get("/{operation_id}")
async def get_operation(operation_id: str, request: Request) -> Any:
    _validate_operation_id(operation_id)
    if operation_id.startswith("hub:"):
        coordinator = _model_binding_activation_coordinator(request)
        if coordinator is not None:
            record = await coordinator.get(operation_id)
            if record is not None:
                return request.app.state.capability.activation_receipt_store.to_projection(record)
        snapshot = await request.app.state.operation_tracker.get(operation_id)
        if snapshot is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=error_body(
                    "operation_not_found",
                    f"No ServiceHub operation exists for {operation_id}",
                ),
            )
        return snapshot
    service = _resolve_operation_service(request, operation_id)
    upstream_operation_id = _child_operation_id(service, operation_id)
    result = await request.app.state.service_client.request_json(
        service,
        "GET",
        f"/v1/operations/{upstream_operation_id}",
    )
    return _operation_response(result, service, mode="lookup")


def _resolve_operation_service(request: Request, operation_id: str) -> ServiceInfo:
    _validate_operation_id(operation_id)
    proxy_prefix = _proxy_prefix_for_operation(operation_id)
    if proxy_prefix is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=error_body(
                "operation_owner_not_found",
                f"No ServiceHub service owns operation {operation_id}",
            ),
        )
    service = request.app.state.process_manager.registry.get_by_prefix(proxy_prefix)
    if service is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=error_body(
                "operation_owner_not_found",
                f"No ServiceHub service owns operation {operation_id}",
            ),
        )
    if service.state != "running":
        raise service_unavailable(service.name)
    return service


def _model_binding_activation_coordinator(request: Request) -> Any | None:
    capability = getattr(request.app.state, "capability", None)
    return getattr(capability, "model_binding_activation_coordinator", None)


def _validate_operation_id(operation_id: str) -> None:
    if _OPERATION_ID_PATTERN.fullmatch(operation_id) is not None:
        return
    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail=error_body(
            "invalid_operation_id",
            "Operation id contains unsupported characters",
        ),
    )


def _proxy_prefix_for_operation(operation_id: str) -> str | None:
    for operation_prefix, proxy_prefix in _OPERATION_PREFIX_TO_PROXY_PREFIX.items():
        if operation_id.startswith(operation_prefix):
            return proxy_prefix
    return None


def _operation_response(
    result: ServiceClientResult | ServiceClientError,
    service: ServiceInfo,
    *,
    mode: Literal["lookup", "cancellation"],
) -> Any:
    if isinstance(result, ServiceClientError):
        status_code = (
            status.HTTP_504_GATEWAY_TIMEOUT
            if result.code == "gateway_timeout"
            else status.HTTP_503_SERVICE_UNAVAILABLE
        )
        raise HTTPException(status_code=status_code, detail={"error": result.as_dict()})
    if result.status_code >= 400:
        raise HTTPException(
            status_code=result.status_code,
            detail=_error_detail(result, service, mode),
        )
    owner = _operation_owner(service)
    if owner is None or not isinstance(result.payload, dict):
        return result.payload
    try:
        return adapt_operation_payload(result.payload, owner=owner)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=error_body("invalid_operation_payload", str(exc)),
        ) from exc


def _error_detail(
    result: ServiceClientResult,
    service: ServiceInfo,
    mode: Literal["lookup", "cancellation"],
) -> dict[str, dict[str, str]]:
    if isinstance(result.payload, dict):
        error = result.payload.get("error")
        if isinstance(error, dict) and isinstance(error.get("code"), str) and isinstance(error.get("message"), str):
            return {"error": {"code": error["code"], "message": error["message"]}}
    action = "lookup" if mode == "lookup" else "cancellation"
    return error_body("upstream_error", f"Operation {action} failed in service {service.name}")


def _operation_owner(service: ServiceInfo) -> Literal["lrm", "sm"] | None:
    if service.proxy_prefix == "/llm-router":
        return "lrm"
    if service.proxy_prefix == "/sandbox-manager":
        return "sm"
    return None


def _cancellation_path(service: ServiceInfo, operation_id: str) -> str:
    # A managed Sandbox Manager refuses a public cancellation (#3749).
    if _operation_owner(service) == "sm":
        return f"/v1/internal/operations/{operation_id}/cancellations"
    return f"/v1/operations/{operation_id}/cancellations"


def _child_operation_id(service: ServiceInfo, operation_id: str) -> str:
    owner = _operation_owner(service)
    if owner is None:
        return operation_id
    try:
        return child_operation_id(operation_id, owner=owner)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=error_body("invalid_operation_id", str(exc)),
        ) from exc
