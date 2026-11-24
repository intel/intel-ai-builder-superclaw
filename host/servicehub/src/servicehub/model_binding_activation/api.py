"""App surface for Model Binding Activation operations."""

from __future__ import annotations

import json
from typing import Any

from contracts.model_binding_activation_active_response import ModelBindingActivationActiveResponse
from contracts.model_binding_activation_request import ModelBindingActivationRequest
from fastapi import APIRouter, HTTPException, Request, status
from loguru import logger
from pydantic import ValidationError

from servicehub.common.errors import error_body
from servicehub.model_binding_activation.activation_failure_copy import activation_failure_message
from servicehub.model_binding_activation.coordinator import ModelBindingActivationStartError
from servicehub.model_binding_activation.receipt import ActivationReceiptConflict
from servicehub.model_binding_activation.receipt import ActivationReceiptError

router = APIRouter(prefix="/app/model-binding", tags=["model-binding-activation"])
_MAX_ACTIVATION_BODY_BYTES = 64 * 1024


@router.post("/activations", status_code=status.HTTP_202_ACCEPTED)
async def start_activation(request: Request) -> dict[str, Any]:
    coordinator = request.app.state.capability.model_binding_activation_coordinator
    if coordinator is not None and coordinator.recovering:
        # #2013: the hub's own boot-time activation coordinator recovery is still
        # in flight. An activation submitted mid-recovery used to race straight
        # into whatever receipt_store state recovery was still settling, surfacing
        # as an opaque, unrelated-looking failure. Ask the caller to retry
        # with a typed, actionable response instead.
        raise HTTPException(
            status_code=409,
            detail=error_body(
                "model_binding_activation_recovery_in_progress",
                "Model Binding Activation recovery is in progress; retry shortly.",
            ),
        )
    content_length = request.headers.get("content-length")
    if content_length is not None and content_length.isdigit() and int(content_length) > _MAX_ACTIVATION_BODY_BYTES:
        raise HTTPException(status_code=413, detail=error_body("request_too_large", "Activation request body exceeds 64 KiB."))
    try:
        raw = bytearray()
        async for chunk in request.stream():
            raw.extend(chunk)
            if len(raw) > _MAX_ACTIVATION_BODY_BYTES:
                raise HTTPException(status_code=413, detail=error_body("request_too_large", "Activation request body exceeds 64 KiB."))
        payload = json.loads(raw)
        if (
            isinstance(payload, dict)
            and payload.get("intent") == "download_and_connect"
            and payload.get("user_confirmed_download") is not True
        ):
            raise HTTPException(
                status_code=409,
                detail=error_body(
                    "download_confirmation_required",
                    activation_failure_message("download_confirmation_required"),
                ),
            )
        command = ModelBindingActivationRequest.model_validate(payload, strict=True)
    except (ValidationError, ValueError):
        raise HTTPException(status_code=422, detail=error_body("invalid_request", "Invalid Model Binding Activation request."))
    try:
        record = await request.app.state.capability.model_binding_activation_coordinator.start_activation(command)
        return request.app.state.capability.activation_receipt_store.to_projection(record)
    except ModelBindingActivationStartError as exc:
        detail: dict[str, object] = {"code": exc.code, "message": activation_failure_message(exc.code)}
        if exc.code == "lrm_bundle_revision_conflict" and exc.actual_revision is not None:
            detail["expected_bundle_revision"] = command.root.expected_bundle_revision
            detail["actual_bundle_revision"] = exc.actual_revision
        raise HTTPException(status_code=409, detail={"error": detail})
    except ActivationReceiptConflict as exc:
        raise HTTPException(status_code=409, detail=error_body(exc.code, activation_failure_message(exc.code)))
    except ActivationReceiptError as exc:
        # A cross-build or corrupt receipt record used to surface here as a bare,
        # unhandled 500 with no actionable body (#2013/#2056): `_read()` now
        # tolerates additive cross-build fields, so this should only fire for a
        # genuinely unreadable record. Log the full diagnostic server-side and
        # return a typed, actionable response instead of letting it fall through
        # to FastAPI's generic handler.
        logger.error("model binding activation rejected: receipt unreadable ({})", exc)
        raise HTTPException(
            status_code=503,
            detail=error_body(
                "activation_receipt_unreadable",
                "Model Binding Activation receipt is unreadable; see ServiceHub logs for the failing record.",
            ),
        )


@router.post("/activations/{operation_id}/resume")
async def resume_activation(operation_id: str, request: Request) -> dict[str, object]:
    """Retry the same durable activation after an explicit user action."""
    logger.info("model binding activation resume requested operation_id={}", operation_id)
    try:
        record = await request.app.state.capability.model_binding_activation_coordinator.resume(operation_id)
    except ModelBindingActivationStartError:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=error_body("recovery_required", activation_failure_message("recovery_required")),
        )
    if record is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=error_body("operation_not_found", "Model Binding Activation was not found."),
        )
    return request.app.state.capability.activation_receipt_store.to_projection(record)


@router.get(
    "/activations/active",
    response_model=ModelBindingActivationActiveResponse,
    response_model_exclude_unset=True,
)
async def get_active_activation(request: Request) -> dict[str, object]:
    """Return the single non-terminal activation without changing its state."""
    capability = request.app.state.capability
    try:
        records = await capability.activation_receipt_store.scan()
    except ActivationReceiptError as exc:
        logger.error("active Model Binding Activation discovery failed: receipt unreadable ({})", exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=error_body(
                "activation_receipt_unreadable",
                "Model Binding Activation receipt is unreadable; see ServiceHub logs for the failing record.",
            ),
        )
    active = [record for record in records if record.state not in {"succeeded", "failed", "cancelled"}]
    logger.info(
        "active Model Binding Activation requested active_count={}",
        len(active),
    )
    if len(active) > 1:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=error_body("recovery_required", activation_failure_message("recovery_required")),
        )
    if not active:
        return {"contract_version": 1, "operation": None}
    try:
        projection = capability.activation_receipt_store.to_projection(active[0])
    except ActivationReceiptError as exc:
        logger.error("active Model Binding Activation projection failed operation_id={} ({})", active[0].operation_id, exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=error_body(
                "activation_receipt_unreadable",
                "Model Binding Activation receipt is unreadable; see ServiceHub logs for the failing record.",
            ),
        )
    return {"contract_version": 1, "operation": projection}
