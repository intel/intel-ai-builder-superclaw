from __future__ import annotations

from contracts.product_profile_runtime_status import ProductProfileRuntimeStatus
from contracts.runtime_deployment_spec import RuntimeDeploymentSpec
from contracts.runtime_instance_evidence import RuntimeInstanceEvidence
from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from loguru import logger

from ...native_deployment import NativeEvidencePending
from ...store import RUNTIME_DEPLOYMENT_CONFIG_KEY
from ..errors import http_error
from ..process_auth import reject_managed_public_mutation, require_process_credential
from ._utils import to_operation_id


router = APIRouter(prefix="/capability")

_NO_STORE_HEADERS = {"Cache-Control": "no-store"}


@router.post("/runtime-infrastructure/preparations", status_code=202)
async def prepare_runtime_infrastructure(request: Request) -> dict[str, str]:
    """Wake target-independent Runtime preparation without creating a Runtime."""
    reject_managed_public_mutation(request)
    return await _prepare_runtime_infrastructure(request)


async def _prepare_runtime_infrastructure(request: Request) -> dict[str, str]:
    lifecycle = getattr(request.app.state, "lifecycle", None)
    if lifecycle is None:
        raise http_error(
            503,
            "runtime_infrastructure_unavailable",
            "Runtime infrastructure preparation is unavailable.",
        )
    run_id = await lifecycle.prepare_runtime_infrastructure()
    return {"operation_id": to_operation_id(run_id), "state": "running"}


@router.put("/runtime-deployment")
async def put_runtime_deployment(
    request: Request, command: RuntimeDeploymentSpec
) -> JSONResponse:
    reject_managed_public_mutation(request)
    return await _put_runtime_deployment(request, command)


async def _put_runtime_deployment(
    request: Request, command: RuntimeDeploymentSpec
) -> JSONResponse:
    payload = command.model_dump(mode="json")
    try:
        result = request.app.state.store.put_runtime_deployment(payload)
    except ValueError as exc:
        raise http_error(422, "runtime_deployment_invalid", str(exc)) from None
    if result == "conflict":
        raise http_error(
            409,
            "runtime_deployment_revision_conflict",
            "A different Runtime Deployment is stored at this profile revision.",
        )
    if result == "stale":
        raise http_error(
            409,
            "runtime_deployment_revision_stale",
            "A newer Runtime Deployment profile revision is already stored.",
        )
    lifecycle = getattr(request.app.state, "lifecycle", None)
    if lifecycle is not None:
        try:
            await lifecycle.ensure_runtime_deployment()
        except Exception as exc:
            logger.warning(
                "durable runtime deployment wake failed error_type={} detail={}",
                type(exc).__name__,
                exc,
            )
            raise http_error(503, "runtime_deployment_wake_failed",
                             "Deployment is saved but native startup could not be scheduled.") from None
    return JSONResponse(content=payload, headers=_NO_STORE_HEADERS)


@router.get("/runtime-deployment", response_model=RuntimeDeploymentSpec)
async def get_runtime_deployment(request: Request) -> RuntimeDeploymentSpec:
    payload = request.app.state.store.get_config(RUNTIME_DEPLOYMENT_CONFIG_KEY)
    if payload is None:
        raise http_error(404, "runtime_deployment_not_found", "No Runtime Deployment is stored.")
    return RuntimeDeploymentSpec.model_validate(payload)


@router.delete("/runtime-deployment", status_code=204)
async def delete_runtime_deployment(
    request: Request, command: RuntimeDeploymentSpec
) -> None:
    reject_managed_public_mutation(request)
    await _delete_runtime_deployment(request, command)


async def _delete_runtime_deployment(
    request: Request, command: RuntimeDeploymentSpec
) -> None:
    payload = command.model_dump(mode="json")
    lifecycle = getattr(request.app.state, "lifecycle", None)
    if lifecycle is not None:
        result = await lifecycle.revoke_runtime_deployment(payload)
    else:
        result = request.app.state.store.delete_runtime_deployment(payload)
    if result == "conflict":
        raise http_error(
            409,
            "runtime_deployment_revision_conflict",
            "A different Runtime Deployment is currently stored.",
        )


@router.get("/runtime-instance", response_model=RuntimeInstanceEvidence)
async def get_runtime_instance(request: Request) -> RuntimeInstanceEvidence:
    lifecycle = getattr(request.app.state, "lifecycle", None)
    if lifecycle is None:
        raise http_error(503, "runtime_instance_unavailable", "Runtime instance evidence is unavailable.")
    try:
        return await lifecycle.runtime_instance_evidence()
    except Exception as exc:
        logger.warning(
            "runtime instance evidence unavailable error_type={} detail={}",
            type(exc).__name__,
            exc,
        )
        if not isinstance(exc, NativeEvidencePending):
            raise http_error(409, "native_runtime_evidence_invalid",
                             "Native Runtime evidence is inconsistent or unavailable after scheduling.") from None
        raise http_error(
            503,
            "runtime_instance_unavailable",
            "No matching live Runtime instance evidence is available.",
        ) from None


@router.get("/runtime-profile")
async def get_runtime_profile(request: Request) -> JSONResponse:
    evidence = (await get_runtime_instance(request)).root
    profile = evidence.product_profile_id.value
    if evidence.status == "ready":
        payload = {"contract_version": 1, "state": "ready", "profile": profile}
    elif evidence.status == "applying":
        payload = {"contract_version": 1, "state": "applying", "profile": None, "target_profile": profile}
    else:
        payload = {"contract_version": 1, "state": "failed", "profile": None,
                   "target_profile": profile, "error": evidence.error.model_dump(mode="json")}
    validated = ProductProfileRuntimeStatus.model_validate(payload)
    return JSONResponse(content=validated.model_dump(mode="json"), headers=_NO_STORE_HEADERS)


internal_router = APIRouter(
    prefix="/internal/capability",
    dependencies=[Depends(require_process_credential)],
)


@internal_router.post("/runtime-infrastructure/preparations", status_code=202)
async def prepare_runtime_infrastructure_internal(request: Request) -> dict[str, str]:
    return await _prepare_runtime_infrastructure(request)


@internal_router.put("/runtime-deployment")
async def put_runtime_deployment_internal(
    request: Request, command: RuntimeDeploymentSpec
) -> JSONResponse:
    return await _put_runtime_deployment(request, command)


@internal_router.delete("/runtime-deployment", status_code=204)
async def delete_runtime_deployment_internal(
    request: Request, command: RuntimeDeploymentSpec
) -> None:
    await _delete_runtime_deployment(request, command)
