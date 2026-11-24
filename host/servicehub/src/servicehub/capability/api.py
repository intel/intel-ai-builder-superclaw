"""App-facing, read-only capability Profile projection."""

from __future__ import annotations

from typing import Any, NoReturn


from contracts.app_capability_profile import AppCapabilityProfile
from fastapi import APIRouter, HTTPException, Request
from pydantic import ValidationError

from servicehub.adapters.lrm_bundle_client import (
    LrmBundleCapabilityResult,
    LrmBundleMalformed,
)
from servicehub.capability.profile_store import ProfileRecord, ProfileStoreCorruptionError
from servicehub.common.errors import error_body

router = APIRouter(prefix="/app", tags=["capability"])

_APP_CONTRACT_VERSION = 1


@router.get("/capability-profile")
async def get_capability_profile(request: Request) -> dict[str, Any]:
    capability = request.app.state.capability
    coordinator = getattr(capability, "model_binding_activation_coordinator", None)
    if coordinator is not None and coordinator.recovering:
        # #2013: the hub's own boot-time switch-coordinator recovery is still
        # in flight. Distinguish that from "no active Profile and nothing to
        # fall back on" (`_initializing()` below) instead of returning the
        # same opaque 503 for both -- a stuck recovery and a dead hub used to
        # look identical from this endpoint.
        _recovering()
    try:
        active = await capability.profile_store.get_active()
    except ProfileStoreCorruptionError:
        return _recovery("saga_recovery_required", ["profile_state_invalid"])
    except OSError:
        _initializing()

    latest_transition = await capability.activation_receipt_store.find_latest_non_retryable_runtime_failure()
    if (
        latest_transition is not None
        and (latest_transition.error or {}).get("code")
        in {"runtime_profile_incompatible", "runtime_profile_unreadable"}
    ):
        return _recovery(
            "saga_recovery_required",
            [str((latest_transition.error or {})["code"])],
        )

    if active is not None:
        try:
            return _active_projection(active)
        except (TypeError, ValidationError, ValueError):
            return _recovery("saga_recovery_required", ["profile_state_invalid"])

    if getattr(capability, "_lite_bootstrap_failed", False):
        reason = getattr(capability, "_lite_bootstrap_failure_reason", None)
        return _recovery("saga_recovery_required", ["native_runtime_unavailable", *([reason] if reason else [])])

    service = request.app.state.process_manager.registry.get_by_prefix("/llm-router")
    if service is None or service.state != "running":
        _initializing()
    result = await capability.lrm_bundle_client.get_primary_bundle(service)
    if isinstance(result, LrmBundleMalformed):
        _invalid_lrm_payload()
    if not isinstance(result, LrmBundleCapabilityResult):
        _initializing()

    capability = result.capability
    if getattr(capability, "cloud_only_product_profile_id", None) == "lite":
        _initializing()
    if capability.hardware_capability_ceiling is None:
        if "hardware_evidence_unknown" in capability.reasons:
            return _recovery(
                "hardware_capability_unknown",
                sorted(set(capability.reasons) | {"hardware_capability_unknown"}),
            )
        return _recovery(
            "hardware_unsupported",
            sorted(set(capability.reasons) | {"hardware_unsupported"}),
        )
    if (
        capability.primary_bundle is not None
        and capability.primary_bundle.capability_contract_version != _APP_CONTRACT_VERSION
    ):
        return _recovery(
            "profile_incompatible",
            sorted(set(capability.reasons) | {"capability_contract_incompatible"}),
        )
    _initializing()


def _active_projection(record: ProfileRecord) -> dict[str, Any]:
    payload: dict[str, object] = {
        "lifecycle_state": "active",
        "resolution_source": record.resolution_source,
        "descriptor": record.snapshot.descriptor.model_dump(mode="json"),
        "product_profile_digest": record.product_profile_digest,
        "product_profile_id": record.product_profile_id,
        "profile_revision": record.snapshot.profile_revision,
        "resolved_at": record.resolved_at,
        "reasons": list(record.reasons),
    }
    if record.primary_bundle is not None:
        payload["primary_bundle"] = record.primary_bundle.model_dump(
            mode="json", exclude_none=True
        )
    return _validated_projection(payload)


def _recovery(recovery_code: str, reasons: list[str]) -> dict[str, Any]:
    return _validated_projection({
        "lifecycle_state": "recovery_required",
        "capability_contract_version": _APP_CONTRACT_VERSION,
        "recovery_code": recovery_code,
        "reasons": reasons,
    })


def _validated_projection(payload: dict[str, object]) -> dict[str, Any]:
    profile = AppCapabilityProfile.model_validate(payload)
    return profile.root.model_dump(mode="json", exclude_none=True)


def _initializing() -> NoReturn:
    raise HTTPException(
        status_code=503,
        detail=error_body(
            "capability_profile_initializing",
            "Capability Profile is not active yet.",
        ),
        headers={"Retry-After": "1"},
    )


def _recovering() -> NoReturn:
    raise HTTPException(
        status_code=423,
        detail=error_body(
            "capability_profile_recovery_in_progress",
            "Model Binding Activation recovery is in progress; retry shortly.",
        ),
        headers={"Retry-After": "1"},
    )


def _invalid_lrm_payload() -> NoReturn:
    raise HTTPException(
        status_code=502,
        detail=error_body(
            "invalid_lrm_capability_payload",
            "LRM returned an invalid capability payload.",
        ),
    )
