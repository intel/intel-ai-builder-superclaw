"""Read-only primary-bundle capability control-plane endpoint."""

from __future__ import annotations

import asyncio
import hashlib
import os
import sqlite3
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Literal

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from loguru import logger
from pydantic import BaseModel, ConfigDict, Field
from contracts.primary_bundle import ModelWarning
from contracts.primary_bundle_abort_request import PrimaryBundleAbortRequest
from contracts.primary_bundle_abort_response import PrimaryBundleAbortResponse
from contracts.primary_bundle_commit_request import PrimaryBundleCommitRequest
from contracts.primary_bundle_commit_response import PrimaryBundleCommitResponse
from contracts.primary_bundle_lifecycle_readback import PrimaryBundleLifecycleReadback
from contracts.primary_bundle_prepare_request import PrimaryBundlePrepareRequest
from contracts.primary_bundle_prepare_response import PrimaryBundlePrepareResponse
from contracts.primary_bundle_release_request import PrimaryBundleReleaseRequest
from contracts.primary_bundle_release_response import PrimaryBundleReleaseResponse
from contracts.model_binding_state import ModelBindingState
from contracts.prepared_model_binding import PreparedModelBinding

from .bundle_capability import (
    AssetCacheState,
    compute_supported_bundles,
    evaluate_primary_bundle_capability,
    inspect_asset_cache,
    is_cloud_only_lite_hardware,
)
from .bundle_registry import load_bundle_registry
from .bundle_lifecycle import pending_state, prepare_local_bundle, resume_interrupted_local_bundle
from .model_binding import read_model_binding_state
from ..common.errors import error_response
from ..common.operations import OperationPool
from ..common.store import (
    BundleRevisionConflict,
    EdgeConfigChanged,
    IdempotencyConflict,
    PendingBundleConflict,
    PreparationEvidenceIncompatible,
    PreparationIdentityMismatch,
    PrimaryBundleNotReleasable,
    is_preparation_in_flight,
)
from ..local import selections as _selections
from ..local.deps import get_eligibility, get_hardware
from ..local.inference_logic import ensure_model_servers_ready, get_downloader
from ..local.hardware import probe_disk_free_bytes
from ..local.registry import ROLE_CHAT, load_builtin_registry
from ..edge.bundle_adapter import (
    edge_config_fingerprint,
    edge_model_selection_fingerprint,
    prepare_edge_bundle,
)
from ..edge import config as edge_config

capability_router = APIRouter(prefix="/llm-router/v1/capability", tags=["capability"])

_DEFAULT_LOCAL_DRAIN_TIMEOUT_S = 30.0


@capability_router.get(
    "/model-binding", response_model=ModelBindingState, response_model_exclude_none=True
)
async def get_model_binding(request: Request) -> dict[str, object]:
    """Read the atomic model selection independently from Product Profile state."""
    return read_model_binding_state(request.app.state.store)


def _candidate_revision_for_edge_config(
    local_revision: int, config: dict[str, Any] | None
) -> int:
    edge_fingerprint = edge_config_fingerprint(config) if config is not None else ""
    selection_fingerprint = (
        edge_model_selection_fingerprint(config) if config is not None else ""
    )
    digest = hashlib.sha256(
        f"{local_revision}:{edge_fingerprint}:{selection_fingerprint}".encode("utf-8")
    ).digest()
    return int.from_bytes(digest[:6], "big")


def _candidate_revision_with_edge(local_revision: int) -> int:
    return _candidate_revision_for_edge_config(local_revision, edge_config.get())


class _StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class _HardwareCeiling(_StrictModel):
    bundle_id: str = Field(min_length=1)
    capability_grade: str = Field(pattern=r"^[a-z][a-z0-9-]*$")


class _AssetRow(_StrictModel):
    asset_id: str = Field(min_length=1)
    label: str = Field(min_length=1)
    role: Literal["chat", "embedding"]
    download_bytes: int = Field(ge=0)
    cached_and_verified: bool


class _SupportedBundle(_StrictModel):
    bundle_id: str = Field(min_length=1)
    backend: Literal["llama", "edge"]
    display_name: str = Field(min_length=1)
    capability_grade: str = Field(pattern=r"^[a-z][a-z0-9-]*$")
    chat_model_label: str = Field(min_length=1)
    embedding_model_label: str = Field(min_length=1)
    assets: list[_AssetRow]
    total_download_bytes: int = Field(ge=0)
    required_free_bytes: int = Field(ge=0)
    fully_cached_and_verified: bool
    download_feasibility: Literal["ready", "insufficient_disk", "probe_unknown"]
    download_block_reason: str | None = None
    model_warnings: list[ModelWarning] | None = Field(None, min_length=1)


class _HardwareEvidence(_StrictModel):
    cpu_brand: str
    gpu_names: list[str]
    total_ram_gb: float = Field(ge=0)
    mem_speed_mts: int = Field(ge=0)
    detection_errors: list[str]


class PrimaryBundleCapabilityResponse(_StrictModel):
    model_candidate_revision: int = Field(ge=0)
    edge_model_selection_fingerprint: str | None = None
    primary_edge_config_matches: bool | None = None
    hardware_capability_ceiling: _HardwareCeiling | None = None
    supported_bundle_ids: list[str]
    recommended_bundle_id: str | None = None
    supported_bundles: list[_SupportedBundle]
    bundle_revision: int = Field(ge=0)
    primary_bundle: dict[str, object] | None = None
    pending_bundle: dict[str, object] | None = None
    hardware: _HardwareEvidence
    observed_at: datetime
    reasons: list[str]
    cloud_only_product_profile_id: Literal["lite"] | None = None


@capability_router.get(
    "/primary-bundle",
    response_model=PrimaryBundleCapabilityResponse,
    response_model_exclude_none=True,
)
async def get_primary_bundle_capability(request: Request) -> dict[str, object]:
    hardware = await get_hardware(request.app.state)
    bundles = load_bundle_registry()
    assets = load_builtin_registry()
    models_dir = request.app.state.local_config.models_dir
    supported = compute_supported_bundles(hardware, bundles, assets)
    asset_ids = {
        asset_id
        for bundle in supported
        for asset_id in (bundle.chat_model_id, bundle.embedding_model_id)
    }

    def _inspect_supported_assets() -> dict[str, AssetCacheState]:
        # verify_hash=False: this read-only projection is behind ServiceHub's
        # 10 s B3 deadline. A freshly-completed multi-GB download reaches full
        # size a beat before the downloader persists its verification record;
        # an inline sha256_file here would run for minutes and wedge the
        # capability chain (Binding commit → bootstrap → Runtime availability).
        # Trust the downloader-owned record; a missing one self-heals next poll.
        return {
            asset_id: inspect_asset_cache(
                models_dir,
                assets.require(asset_id),
                request.app.state.store,
                verify_hash=False,
            )
            for asset_id in asset_ids
        }

    cache_states = await asyncio.to_thread(_inspect_supported_assets)
    async with request.app.state.edge_config_lock:
        edge_config_record = edge_config.get()
        lifecycle = request.app.state.store.get_bundle_lifecycle()
    primary = lifecycle.get("primary_bundle")
    primary_edge_config_matches = (
        edge_config_record is not None
        and isinstance(primary, dict)
        and primary.get("backend") == "edge"
        and primary.get("state") == "ready"
        and lifecycle.get("primary_edge_config_fingerprint")
        == edge_config_fingerprint(edge_config_record)
    )
    committed_edge_bundle_id = None
    if primary_edge_config_matches:
        assert isinstance(primary, dict)
        committed_edge_bundle_id = str(primary.get("bundle_id", ""))

    result = evaluate_primary_bundle_capability(
        hardware=hardware,
        bundle_registry=bundles,
        asset_registry=assets,
        cache_states=cache_states,
        free_bytes=probe_disk_free_bytes(models_dir),
        edge_config_record=edge_config_record,
        committed_edge_bundle_id=committed_edge_bundle_id,
    )

    supported_bundles = []
    for item in result.supported_bundles:
        asset_rows = [
            {
                "asset_id": asset.id,
                "label": asset.name,
                "role": asset.role,
                "download_bytes": state.missing_bytes,
                "cached_and_verified": state.cached_and_verified,
            }
            for asset, state in zip(
                (item.chat, item.embedding), item.cache_states, strict=True
            )
        ]
        row: dict[str, object] = {
            "bundle_id": item.bundle.bundle_id,
            "backend": item.bundle.backend,
            "display_name": item.chat.name,
            "capability_grade": item.bundle.capability_grade,
            "chat_model_label": item.chat.name,
            "embedding_model_label": item.embedding.name,
            "assets": asset_rows,
            "total_download_bytes": item.total_download_bytes,
            "required_free_bytes": item.download.required_free_bytes,
            "fully_cached_and_verified": all(
                state.cached_and_verified for state in item.cache_states
            ),
            "download_feasibility": item.download.status,
        }
        if item.download.reason_code and item.download.reason_text:
            row["download_block_reason"] = (
                f"{item.download.reason_code}: {item.download.reason_text}"
            )
        if item.chat.warnings:
            row["model_warnings"] = list(item.chat.warnings)
        supported_bundles.append(row)

    response: dict[str, object] = {
        "model_candidate_revision": _candidate_revision_for_edge_config(
            result.model_candidate_revision, edge_config_record
        ),
        "primary_edge_config_matches": primary_edge_config_matches,
        "supported_bundle_ids": list(result.supported_bundle_ids),
        "supported_bundles": supported_bundles,
        "hardware": {
            "cpu_brand": hardware.cpu_brand,
            "gpu_names": list(hardware.igpu_names),
            "total_ram_gb": round(hardware.total_ram_gb, 2),
            "mem_speed_mts": hardware.mem_speed_mts,
            "detection_errors": list(hardware.detection_errors),
        },
        "observed_at": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace(
            "+00:00", "Z"
        ),
        "reasons": list(result.reasons),
    }
    response["bundle_revision"] = lifecycle["bundle_revision"]
    if edge_config_record is not None:
        response["edge_model_selection_fingerprint"] = (
            edge_model_selection_fingerprint(edge_config_record)
        )
    if lifecycle["primary_bundle"]:
        response["primary_bundle"] = lifecycle["primary_bundle"]
    if lifecycle["pending_bundle"]:
        response["pending_bundle"] = lifecycle["pending_bundle"]
    if result.hardware_capability_ceiling:
        bundle_id, grade = result.hardware_capability_ceiling
        response["hardware_capability_ceiling"] = {
            "bundle_id": bundle_id,
            "capability_grade": grade,
        }
    if result.recommended_bundle_id:
        response["recommended_bundle_id"] = result.recommended_bundle_id
    if result.cloud_only_product_profile_id:
        response["cloud_only_product_profile_id"] = result.cloud_only_product_profile_id
    return response


def _operation_pool(request: Request) -> OperationPool:
    return request.app.state.operation_pool


def _idempotent_replay(
    request: Request, operation_id: str, action: str, key: str, body: dict[str, object]
) -> dict[str, object] | JSONResponse | None:
    try:
        response = request.app.state.store.get_idempotent_response(
            operation_id, action, key, body
        )
        if action == "prepare" and response is not None:
            prep_op_id = response.get("prepare_operation_id")
            if isinstance(prep_op_id, str):
                durable = request.app.state.store.get_preparation_lifecycle(prep_op_id)
                if durable is not None:
                    # A cached preparation in error state was interrupted (e.g. by an
                    # LRM restart). Treat it as a cache miss so a fresh prepare runs.
                    if durable["state"] == "error":
                        return None
                    return _prepare_response(durable)
        return response
    except IdempotencyConflict:
        return error_response(
            "idempotency_conflict",
            "The idempotency key was already used with a different request.",
            status_code=409,
        )


def _prepare_response(operation: dict[str, object]) -> dict[str, object]:
    return PrimaryBundlePrepareResponse.model_validate(
        {
            "contract_version": 1,
            "correlation_operation_id": operation["correlation_operation_id"],
            "prepare_operation_id": operation["prepare_operation_id"],
            "idempotency_key": operation["idempotency_key"],
            "state": _canonical_state(operation["state"]),
            "pct": operation["pct"],
            "message": operation.get("message"),
        }
    ).model_dump(mode="json")


def _canonical_state(state: object) -> str:
    canonical = {
        "pending": "queued",
        "running": "running",
        "done": "succeeded",
        "error": "failed",
        "cancelled": "cancelled",
    }.get(state)
    if canonical is None:
        raise ValueError(f"unknown internal lifecycle state: {state}")
    return canonical


def _full_lifecycle_response(
    evidence: dict[str, object], response_type: type[BaseModel]
) -> dict[str, object]:
    value = {
        **evidence,
        "contract_version": 1,
        "state": _canonical_state(evidence["state"]),
        "reason_code": evidence.get("reason_code"),
    }
    return response_type.model_validate(value).model_dump(mode="json")


@capability_router.get(
    "/primary-bundle/preparations/{prepare_operation_id}",
    response_model=PrimaryBundleLifecycleReadback,
)
async def get_primary_bundle_preparation(
    prepare_operation_id: str, request: Request
) -> dict[str, object] | JSONResponse:
    try:
        evidence = request.app.state.store.get_preparation_lifecycle(prepare_operation_id)
        if evidence is None:
            return error_response("preparation_not_found", "Preparation not found.", status_code=404)
        return _full_lifecycle_response(evidence, PrimaryBundleLifecycleReadback)
    except PreparationEvidenceIncompatible:
        return error_response(
            "preparation_recovery_required",
            "Stored preparation evidence predates the durable B4 contract.",
            status_code=409,
        )
    except ValueError:
        return error_response(
            "invalid_lifecycle_state",
            "Stored preparation has an invalid lifecycle state.",
            status_code=500,
        )


@capability_router.get(
    "/primary-bundle/preparations/{prepare_operation_id}/model-binding",
    response_model=PreparedModelBinding,
)
async def get_prepared_model_binding(
    prepare_operation_id: str, request: Request
) -> dict[str, object] | JSONResponse:
    """Return immutable compatibility facts for the durable prepared candidate."""
    try:
        evidence = request.app.state.store.get_preparation_lifecycle(prepare_operation_id)
        if evidence is None:
            return error_response("preparation_not_found", "Preparation not found.", status_code=404)
        if _canonical_state(evidence["state"]) != "succeeded":
            return error_response(
                "preparation_not_ready", "Preparation is not ready.", status_code=409
            )
        target = evidence.get("target_bundle")
        if not isinstance(target, dict) or not isinstance(target.get("bundle_id"), str):
            raise PreparationEvidenceIncompatible(prepare_operation_id)
        bundle = load_bundle_registry().require(target["bundle_id"])
        return PreparedModelBinding.model_validate({
            "contract_version": 1,
            "prepare_operation_id": prepare_operation_id,
            "target_bundle_id": bundle.bundle_id,
            "candidate_revision": evidence["candidate_revision"],
            "expected_binding_revision": evidence["expected_bundle_revision"],
            "compatible_product_profiles": list(bundle.compatible_product_profiles),
        }).model_dump(mode="json")
    except PreparationEvidenceIncompatible:
        return error_response(
            "preparation_recovery_required",
            "Stored preparation evidence cannot prove the candidate Binding.",
            status_code=409,
        )
    except (KeyError, ValueError):
        return error_response(
            "preparation_identity_mismatch",
            "Prepared Binding identity does not match the trusted registry.",
            status_code=409,
        )


@capability_router.post(
    "/primary-bundle/preparations/{prepare_operation_id}/resume",
    response_model=PrimaryBundleLifecycleReadback,
)
async def resume_primary_bundle_preparation(
    prepare_operation_id: str, request: Request
) -> dict[str, object] | JSONResponse:
    logger.info("primary Bundle preparation resume requested prepare_operation_id={}", prepare_operation_id)
    recovery = request.app.state.store.get_resumable_preparation()
    if recovery is None or recovery["prepare_operation_id"] != prepare_operation_id:
        logger.warning(
            "primary Bundle preparation resume not_found requested={} resumable={}",
            prepare_operation_id,
            recovery["prepare_operation_id"] if recovery else None,
        )
        return error_response("preparation_not_found", "Preparation not found.", status_code=404)
    await resume_interrupted_local_bundle(request.app.state)
    evidence = request.app.state.store.get_preparation_lifecycle(prepare_operation_id)
    if evidence is None:
        logger.warning(
            "primary Bundle preparation resume lifecycle_missing prepare_operation_id={}",
            prepare_operation_id,
        )
        return error_response("preparation_not_found", "Preparation not found.", status_code=404)
    return _full_lifecycle_response(evidence, PrimaryBundleLifecycleReadback)


@capability_router.post(
    "/primary-bundle/preparations",
    response_model=PrimaryBundlePrepareResponse,
)
async def prepare_primary_bundle(
    body: PrimaryBundlePrepareRequest, request: Request
) -> dict[str, object] | JSONResponse:
    command = body.root
    body_value = body.model_dump(mode="json", exclude_none=True)
    intent = command.intent
    replay = _idempotent_replay(
        request,
        command.correlation_operation_id,
        "prepare",
        command.idempotency_key,
        body_value,
    )
    if replay is not None:
        return replay
    bundles = load_bundle_registry()
    try:
        bundle = bundles.require(command.target_bundle_id)
    except ValueError:
        return error_response("unknown_bundle", "Unknown target Bundle.", status_code=404)
    hardware = await get_hardware(request.app.state)
    assets = load_builtin_registry()
    models_dir = request.app.state.local_config.models_dir
    supported = compute_supported_bundles(hardware, bundles, assets)
    if bundle.backend == "llama" and bundle not in supported:
        return error_response(
            "unsupported_bundle", "Target Bundle is not compute-supported.", status_code=409
        )
    asset_ids = {
        asset_id
        for supported_bundle in supported
        for asset_id in (
            supported_bundle.chat_model_id,
            supported_bundle.embedding_model_id,
        )
    }

    def _inspect() -> dict[str, AssetCacheState]:
        # verify_hash=False: the admission checks below need only metadata facts,
        # and ServiceHub wraps this call in a hard 15 s deadline
        # (adapters/lrm_primary_bundle_client.py::_REQUEST_DEADLINE_S). Hashing a
        # 20 GB chat model inline takes ~15 s, so the deadline and the hash raced —
        # and the hash lost by 0.14 s on the observed run, pinning the switch at
        # `recovery_required` while this handler went on to prepare successfully.
        # The hash result was computed too late for anyone to use.
        #
        # `downloader.py` already states the rule: a multi-GB first check "takes
        # tens of seconds - call it from a background task or an operation, never
        # inline in a request handler". The real hashing therefore happens in the
        # background operation spawned below (prepare_local_bundle ->
        # downloader._verify_existing), which has no deadline and reports progress.
        #
        # Integrity is unchanged: the full sha256 still runs exactly once, and a
        # file that fails it is deleted and re-fetched rather than launched
        # (see ModelDownloader._verify_existing). Only the *timing* moves. This
        # also makes the two projections agree — the read projection
        # (`_inspect_supported_assets`) already uses verify_hash=False, and the
        # disagreement between them was what produced the revision/intent
        # rejections this endpoint used to return.
        return {
            asset_id: inspect_asset_cache(
                models_dir,
                assets.require(asset_id),
                request.app.state.store,
                verify_hash=False,
            )
            for asset_id in asset_ids
        }

    cache_states = await asyncio.to_thread(_inspect)
    # Deliberately omit ``edge_config_record`` here (unlike
    # ``get_primary_bundle_capability``): the prepare path only needs
    # ``model_candidate_revision``, which is local-only (computed from the local
    # ``evaluations`` tuple) in BOTH paths and wrapped by
    # ``_candidate_revision_with_edge`` below, so the client revision still
    # matches. Passing the edge record would only add the edge row to
    # ``supported_bundles`` (unused here — the edge target legitimately resolves
    # to ``target is None`` → ``has_missing_assets = False`` → forced connect
    # intent). If ``model_candidate_revision`` ever becomes edge-aware, this
    # omission MUST be revisited or the two paths silently diverge.
    evaluation = evaluate_primary_bundle_capability(
        hardware=hardware,
        bundle_registry=bundles,
        asset_registry=assets,
        cache_states=cache_states,
        free_bytes=probe_disk_free_bytes(models_dir),
    )
    expected_candidate_revision = _candidate_revision_with_edge(
        evaluation.model_candidate_revision
    )
    if command.candidate_revision != expected_candidate_revision:
        return error_response(
            "bundle_candidate_changed",
            "Bundle asset or cache facts changed; refresh before continuing.",
            status_code=409,
        )
    target = next(
        (item for item in evaluation.supported_bundles if item.bundle == bundle), None
    )
    has_missing_assets = (
        not all(state.cached_and_verified for state in target.cache_states)
        if target is not None
        else False
    )
    if has_missing_assets and (
        intent != "download_and_connect"
        or not getattr(command, "user_confirmed_download", False)
    ):
        return error_response(
            "download_confirmation_required",
            "Explicit download confirmation is required for missing assets.",
            status_code=409,
        )
    if not has_missing_assets and intent != "connect":
        # A local bundle whose assets are all present-and-verified may still be
        # asked for with `download_and_connect`, and that is not a client error:
        # the read projection is deliberately hash-free (`verify_hash=False`, see
        # `_inspect_supported_assets`), so on a `-Clean -KeepModels` box -- model
        # files kept, `model_verifications` wiped -- it honestly reports
        # `cached=false` and the client correctly asks to download. This handler
        # then re-inspects WITH hashing, which verifies the files and persists the
        # records, so by the time we get here nothing is missing after all.
        #
        # Rejecting that made the FIRST launch fail deterministically (a 20 GB
        # chat model takes ~15 s to hash, so the window is wide open), while the
        # second launch -- records now present -- succeeded. `download_and_connect`
        # carries explicit download consent, so it is a superset of `connect`:
        # honouring it when there is nothing left to download is safe, and the
        # download path below is a no-op for already-verified assets.
        #
        # `target is None` (the Edge bundle, which has no local assets at all and
        # can never download) is NOT covered by this: Edge must still be refused,
        # so the exemption requires a real local target.
        if not (target is not None and intent == "download_and_connect"):
            return error_response(
                "connect_intent_required",
                "Fully verified assets must use connect intent.",
                status_code=409,
            )

    store = request.app.state.store
    actual_bundle_revision = store.get_bundle_lifecycle()["bundle_revision"]
    if command.expected_bundle_revision != actual_bundle_revision:
        return error_response(
            "lrm_bundle_revision_conflict",
            "The authoritative Bundle revision changed.",
            status_code=409,
            details={
                "expected_bundle_revision": command.expected_bundle_revision,
                "actual_bundle_revision": actual_bundle_revision,
            },
        )
    operation = await _operation_pool(request).create(
        "primary_bundle.prepare",
        metadata={"bundle_id": bundle.bundle_id, "idempotency_key": command.idempotency_key},
    )
    operation_id = str(operation["operation_id"])
    prepare_token = uuid.uuid4().hex
    try:
        async with request.app.state.edge_config_lock:
            current_edge_config = edge_config.get()
            if command.candidate_revision != _candidate_revision_for_edge_config(
                evaluation.model_candidate_revision, current_edge_config
            ):
                await _operation_pool(request).transition(
                    operation_id,
                    "cancelled",
                    0,
                    "Bundle candidate changed before claim",
                )
                return error_response(
                    "bundle_candidate_changed",
                    "Bundle asset, Edge connection, or model selection changed; refresh before continuing.",
                    status_code=409,
                )
            claimed, joined_operation_id = store.claim_pending_bundle(
                pending_bundle=pending_state(bundle, "preparing"),
                prepare_token=prepare_token,
                operation_id=operation_id,
                correlation_operation_id=command.correlation_operation_id,
                candidate_revision=command.candidate_revision,
                expected_bundle_revision=command.expected_bundle_revision,
                idempotency_key=command.idempotency_key,
                pending_edge_model_selection_fingerprint=(
                    edge_model_selection_fingerprint(current_edge_config)
                    if bundle.backend == "edge" and current_edge_config is not None
                    else None
                ),
                allow_download=intent == "download_and_connect"
                and getattr(command, "user_confirmed_download", False),
            )
    except BundleRevisionConflict as exc:
        await _operation_pool(request).transition(
            operation_id, "cancelled", 0, "Bundle revision changed before claim"
        )
        return error_response(
            "lrm_bundle_revision_conflict",
            str(exc),
            status_code=409,
            details={
                "expected_bundle_revision": exc.expected,
                "actual_bundle_revision": exc.actual,
            },
        )
    except PendingBundleConflict:
        await _operation_pool(request).transition(
            operation_id, "cancelled", 0, "different Bundle already pending"
        )
        return error_response(
            "primary_bundle_prepare_in_progress",
            "A different Bundle is already pending.",
            status_code=409,
        )
    if not claimed and joined_operation_id:
        await _operation_pool(request).transition(
            operation_id, "cancelled", 0, "joined existing preparation"
        )
        joined = store.get_preparation_lifecycle(joined_operation_id)
        if joined is not None:
            joined_response = _prepare_response(joined)
            store.set_idempotent_response(
                command.correlation_operation_id,
                "prepare",
                command.idempotency_key,
                body_value,
                joined_response,
            )
            return JSONResponse(joined_response, status_code=202)
        return error_response(
            "pending_bundle_recovery_required",
            "Pending Bundle has no live preparation operation.",
            status_code=409,
        )
    await _operation_pool(request).transition(
        operation_id, "running", 0, "preparing bundle"
    )
    evidence = store.get_preparation_lifecycle(operation_id)
    if evidence is None:
        raise RuntimeError("durable preparation evidence was not created")
    response = _prepare_response(evidence)
    store.set_idempotent_response(
        command.correlation_operation_id,
        "prepare",
        command.idempotency_key,
        body_value,
        response,
    )
    prepare_coro = (
        prepare_local_bundle(
            bundle=bundle,
            asset_registry=assets,
            store=store,
            downloader=get_downloader(request.app.state),
            operation_pool=_operation_pool(request),
            operation_id=operation_id,
            prepare_token=prepare_token,
            cache_states=cache_states,
            allow_download=intent == "download_and_connect"
            and getattr(command, "user_confirmed_download", False),
        )
        if bundle.backend == "llama"
        else prepare_edge_bundle(
            bundle=bundle,
            bundle_registry=bundles,
            store=store,
            operation_pool=_operation_pool(request),
            operation_id=operation_id,
            prepare_token=prepare_token,
            edge_config_lock=request.app.state.edge_config_lock,
        )
    )
    task = asyncio.create_task(prepare_coro)
    request.app.state.bundle_prepare_tasks.add(task)
    task.add_done_callback(request.app.state.bundle_prepare_tasks.discard)
    return JSONResponse(response, status_code=202)


@capability_router.post(
    "/primary-bundle/commits", response_model=PrimaryBundleCommitResponse
)
async def commit_primary_bundle(
    body: PrimaryBundleCommitRequest, request: Request
) -> dict[str, object] | JSONResponse:
    commit_t0 = time.monotonic()
    body_value = body.model_dump(mode="json", exclude_none=True)
    store = request.app.state.store
    replay = _idempotent_replay(
        request,
        body.correlation_operation_id,
        "commit",
        body.idempotency_key,
        body_value,
    )
    if isinstance(replay, JSONResponse):
        return replay
    if replay is not None:
        return _full_lifecycle_response(replay, PrimaryBundleCommitResponse)

    try:
        target_bundle = store.validate_pending_bundle_commit(
            target_bundle_id=body.target_bundle_id,
            expected_revision=body.expected_bundle_revision,
            correlation_operation_id=body.correlation_operation_id,
            prepare_operation_id=body.prepare_operation_id,
        )
    except BundleRevisionConflict as exc:
        return _bundle_revision_error(exc)
    except PendingBundleConflict:
        return error_response(
            "pending_bundle_conflict",
            "The target Bundle is not prepared.",
            status_code=409,
        )
    except PreparationIdentityMismatch:
        return error_response(
            "preparation_identity_mismatch",
            "The command does not match the durable preparation identity.",
            status_code=409,
        )

    if target_bundle.get("backend") == "llama":
        await request.app.state.model_binding_activation_lock.acquire()
        try:
            # A duplicate may have waited while the first request activated and committed.
            replay = _idempotent_replay(
                request,
                body.correlation_operation_id,
                "commit",
                body.idempotency_key,
                body_value,
            )
            if replay is not None:
                _release_model_binding_activation_lock(request.app.state)
                if isinstance(replay, JSONResponse):
                    return replay
                return _full_lifecycle_response(replay, PrimaryBundleCommitResponse)
            try:
                await get_eligibility(request.app.state)
            except Exception as exc:
                logger.opt(exception=True).warning(
                    "local Binding candidate eligibility failed"
                )
                request.app.state.local_request_admission.open()
                _release_model_binding_activation_lock(request.app.state)
                return error_response(
                    "model_binding_activation_failed",
                    str(exc),
                    status_code=503,
                    headers={"Retry-After": "1"},
                )
            activation_error = await _activate_local_binding_candidate(
                request.app.state,
                chat_model_id=str(target_bundle["chat_model_id"]),
                embedding_model_id=str(target_bundle["embedding_model_id"]),
            )
            if activation_error is not None:
                request.app.state.local_request_admission.open()
                _release_model_binding_activation_lock(request.app.state)
                return activation_error
        except BaseException:
            request.app.state.local_request_admission.open()
            _release_model_binding_activation_lock(request.app.state)
            raise

    try:
        if target_bundle.get("backend") == "edge":
            async with request.app.state.edge_config_lock:
                config = edge_config.get()
                current_edge_fingerprint = (
                    edge_config_fingerprint(config) if config is not None else None
                )
                current_model_selection_fingerprint = (
                    edge_model_selection_fingerprint(config)
                    if config is not None
                    else None
                )
                response, replayed = store.commit_pending_bundle_idempotent(
                    target_bundle_id=body.target_bundle_id,
                    expected_revision=body.expected_bundle_revision,
                    correlation_operation_id=body.correlation_operation_id,
                    prepare_operation_id=body.prepare_operation_id,
                    idempotency_key=body.idempotency_key,
                    request=body_value,
                    current_edge_config_fingerprint=current_edge_fingerprint,
                    current_edge_model_selection_fingerprint=current_model_selection_fingerprint,
                )
        else:
            response, replayed = store.commit_pending_bundle_idempotent(
                target_bundle_id=body.target_bundle_id,
                expected_revision=body.expected_bundle_revision,
                correlation_operation_id=body.correlation_operation_id,
                prepare_operation_id=body.prepare_operation_id,
                idempotency_key=body.idempotency_key,
                request=body_value,
            )
    except BundleRevisionConflict as exc:
        await _restore_local_worker_after_commit_failure(request.app.state, target_bundle)
        return _bundle_revision_error(exc)
    except PendingBundleConflict:
        await _restore_local_worker_after_commit_failure(request.app.state, target_bundle)
        return error_response(
            "pending_bundle_conflict",
            "The target Bundle is not prepared.",
            status_code=409,
        )
    except PreparationIdentityMismatch:
        await _restore_local_worker_after_commit_failure(request.app.state, target_bundle)
        return error_response(
            "preparation_identity_mismatch",
            "The command does not match the durable preparation identity.",
            status_code=409,
        )
    except EdgeConfigChanged:
        return error_response(
            "edge_config_changed",
            "The Edge configuration changed after preparation. Prepare it again before committing.",
            status_code=409,
        )
    except IdempotencyConflict:
        await _restore_local_worker_after_commit_failure(request.app.state, target_bundle)
        return error_response(
            "idempotency_conflict",
            "The idempotency key was already used with a different request.",
            status_code=409,
        )
    except Exception:
        await _restore_local_worker_after_commit_failure(request.app.state, target_bundle)
        raise
    if not replayed:
        logger.info(
            "startup step complete step=primary_bundle_commit bundle_id={} duration_ms={}",
            body.target_bundle_id,
            round((time.monotonic() - commit_t0) * 1000),
        )
    request.app.state.local_request_admission.open()
    _release_model_binding_activation_lock(request.app.state)
    target_bundle = response.get("target_bundle")
    if (
        not replayed
        and isinstance(target_bundle, dict)
        and target_bundle.get("backend") == "edge"
    ):
        # Edge became the committed primary bundle — by this point
        # `prepare_edge_bundle` has already verified the endpoint is reachable
        # (chat + embedding probes), so this is the genuine "connect succeeded"
        # signal. Sync the `local_provider` KV (the data-plane routing switch)
        # to `edge` inline — it is a cheap KV write the response implies — and
        # free the shared llama-server (chat + co-hosted embedding) off the
        # request path, for the reason documented on
        # `_release_local_chat_for_edge`.
        try:
            _selections.set_local_provider(store, "edge")
        except Exception:
            logger.opt(exception=True).warning(
                "committed edge primary Bundle but could not switch local_provider bundle_id={}",
                target_bundle.get("bundle_id"),
            )
        else:
            # Only after the routing switch actually flipped: a failed KV write
            # leaves `llamacpp` selected, and stopping its server then would
            # strand the box with no serving provider.
            task = asyncio.create_task(
                _release_local_chat_for_edge(
                    request.app.state, str(target_bundle.get("bundle_id"))
                )
            )
            request.app.state.bundle_prepare_tasks.add(task)
            task.add_done_callback(request.app.state.bundle_prepare_tasks.discard)
    return _full_lifecycle_response(response, PrimaryBundleCommitResponse)


def _bundle_revision_error(exc: BundleRevisionConflict) -> JSONResponse:
    return error_response(
        "lrm_bundle_revision_conflict",
        str(exc),
        status_code=409,
        details={
            "expected_bundle_revision": exc.expected,
            "actual_bundle_revision": exc.actual,
        },
    )


def _local_drain_timeout_s() -> float:
    raw = os.environ.get("LRM_LOCAL_DRAIN_TIMEOUT_S")
    if raw is None:
        return _DEFAULT_LOCAL_DRAIN_TIMEOUT_S
    try:
        value = float(raw)
    except ValueError:
        return _DEFAULT_LOCAL_DRAIN_TIMEOUT_S
    return value if value >= 0 else _DEFAULT_LOCAL_DRAIN_TIMEOUT_S


async def _activate_local_binding_candidate(
    app_state: Any, *, chat_model_id: str, embedding_model_id: str
) -> JSONResponse | None:
    gate = app_state.local_request_admission
    drained = await gate.close_and_drain(_local_drain_timeout_s())
    if not drained:
        return error_response(
            "model_binding_drain_timeout",
            "Existing local requests did not finish before the transition timeout.",
            status_code=503,
            headers={"Retry-After": "1"},
        )
    try:
        await app_state.supervisor[ROLE_CHAT].replace_models(
            chat_model_id=chat_model_id,
            embedding_model_id=embedding_model_id,
        )
    except Exception as exc:
        logger.opt(exception=True).warning(
            "local Binding candidate activation failed chat={} embedding={}",
            chat_model_id,
            embedding_model_id,
        )
        return error_response(
            "model_binding_activation_failed",
            str(exc),
            status_code=503,
            headers={"Retry-After": "1"},
        )
    return None


async def _restore_local_worker_after_commit_failure(
    app_state: Any, target_bundle: dict[str, Any]
) -> None:
    if target_bundle.get("backend") != "llama":
        return
    try:
        await app_state.supervisor[ROLE_CHAT].restore_previous_plan()
    except Exception:
        logger.opt(exception=True).error(
            "Binding commit failed and previous local worker could not be restored"
        )
    finally:
        app_state.local_request_admission.open()
        _release_model_binding_activation_lock(app_state)


def _release_model_binding_activation_lock(app_state: Any) -> None:
    lock = app_state.model_binding_activation_lock
    if lock.locked():
        lock.release()


async def _release_local_chat_for_edge(app_state: Any, bundle_id: str) -> None:
    """Stop the shared llama-server after an edge Bundle commit.

    Scheduled off the commit request path by `commit_primary_bundle`, never
    awaited by it. `RouterSupervisor.stop()` takes the same `_lock` that
    `ensure_running()` holds for the whole of `_probe_ready`, whose model-load
    budget is `MODEL_LOAD_TIMEOUT_S` (300s) — so with a 35B launch in flight
    this call blocks for minutes. ServiceHub's B4 commit call has a hard 15s
    deadline, and awaiting this inline made an already-durable commit come back
    as `commit_outcome_unknown`, stranding the switch with no restart handoff
    (issue #1682). Teardown is a resource-release side effect, not part of the
    commit outcome, so it must not gate the response.

    Same `snapshot()`-guarded, idempotent stop as the manual
    `PUT /model-selections/local-provider` switch (`local/api.py`); failures
    are logged, never raised (nothing awaits this task).

    Because this runs detached it can wait on the supervisor lock for the whole of
    a model load, during which the user may have switched BACK to a local Bundle.
    `snapshot()` cannot tell the server this task meant to stop from one a later
    local switch just started -- both read `ready`/`starting` -- and
    `ensure_running()` returns without relaunching when the server is already up,
    so nothing else marks the difference either. Tearing it down then would leave
    the box with a committed local Bundle, no llama-server, and no self-healing
    (`stop()` sets `_manual_stop` and cancels the watcher). So the real intent test
    -- "is Edge still the committed primary?" -- is handed to `stop()` as
    `abort_if`, which re-checks it after taking the lock. Checking it here, before
    blocking, would read state that is minutes stale by the time it matters.
    """

    def _edge_no_longer_primary() -> bool:
        try:
            primary = app_state.store.get_bundle_lifecycle()["primary_bundle"]
        except Exception:
            # Cannot prove the intent still holds -> do not tear anything down.
            logger.opt(exception=True).warning(
                "could not read committed Bundle before stopping llama-server; skipping"
            )
            return True
        return not (isinstance(primary, dict) and primary.get("backend") == "edge")

    try:
        chat_sup = app_state.supervisor[ROLE_CHAT]
        if chat_sup.snapshot()["state"] in ("ready", "starting"):
            await chat_sup.stop(abort_if=_edge_no_longer_primary)
    except Exception:
        logger.opt(exception=True).warning(
            "committed edge primary Bundle but could not stop local llama-server bundle_id={}",
            bundle_id,
        )


@capability_router.get(
    "/primary-bundle/commits/{correlation_operation_id}", response_model=PrimaryBundleCommitResponse
)
async def get_primary_bundle_commit(
    correlation_operation_id: str, idempotency_key: str, request: Request
) -> dict[str, object] | JSONResponse:
    response = request.app.state.store.get_commit_response(
        correlation_operation_id=correlation_operation_id, idempotency_key=idempotency_key
    )
    if response is None:
        return error_response("commit_not_found", "Commit evidence was not found.", status_code=404)
    return _full_lifecycle_response(response, PrimaryBundleCommitResponse)


@capability_router.post(
    "/primary-bundle/aborts", response_model=PrimaryBundleAbortResponse
)
async def abort_primary_bundle(
    body: PrimaryBundleAbortRequest, request: Request
) -> dict[str, object] | JSONResponse:
    body_value = body.model_dump(mode="json", exclude_none=True)
    store = request.app.state.store
    try:
        response, operation_id = store.abort_pending_bundle_idempotent(
            target_bundle_id=body.target_bundle_id,
            expected_revision=body.expected_bundle_revision,
            correlation_operation_id=body.correlation_operation_id,
            prepare_operation_id=body.prepare_operation_id,
            idempotency_key=body.idempotency_key,
            request=body_value,
        )
    except PendingBundleConflict:
        return error_response(
            "pending_bundle_conflict", "A different Bundle is pending.", status_code=409
        )
    except BundleRevisionConflict as exc:
        return error_response(
            "lrm_bundle_revision_conflict",
            str(exc),
            status_code=409,
            details={
                "expected_bundle_revision": exc.expected,
                "actual_bundle_revision": exc.actual,
            },
        )
    except PreparationIdentityMismatch:
        return error_response(
            "preparation_identity_mismatch",
            "The command does not match the durable preparation identity.",
            status_code=409,
        )
    except IdempotencyConflict:
        return error_response(
            "idempotency_conflict",
            "The idempotency key was already used with a different request.",
            status_code=409,
        )
    if operation_id:
        await _operation_pool(request).cancel(operation_id)
    return _full_lifecycle_response(response, PrimaryBundleAbortResponse)


def _holds_edge_config(fingerprint: str | None) -> bool:
    """True only when edge.json provably holds the config saved after the release.

    An unreadable file counts as not holding it, so release still deletes it and an
    unreadable edge.json can never keep the released server and key on disk.
    """
    if fingerprint is None:
        return False
    try:
        current = edge_config.get()
    # DPAPI raises pywintypes.error, which shares no narrower base with the JSON and I/O errors.
    except Exception:  # noqa: BLE001
        logger.opt(exception=True).warning("release cleanup could not read edge.json; deleting it")
        return False
    return current is not None and edge_config_fingerprint(current) == fingerprint


async def _is_cloud_only_lite_hardware(request: Request) -> bool:
    hardware = await get_hardware(request.app.state)
    return is_cloud_only_lite_hardware(hardware, load_bundle_registry(), load_builtin_registry())


@capability_router.post(
    "/primary-bundle/releases", response_model=PrimaryBundleReleaseResponse
)
async def release_primary_bundle(
    body: PrimaryBundleReleaseRequest, request: Request
) -> dict[str, object] | JSONResponse:
    """Release the committed Edge primary Bundle with no replacement target.

    The store rejects a non-Edge primary Bundle, non-Lite hardware, and an
    in-flight preparation. Edge config and the `local_provider` selection are
    cleared after the release commits. The store keeps that cleanup pending until
    it finishes, so a replay completes a cleanup a crash interrupted but never
    repeats a finished one. Edge config saved after the release (`PUT /edge`) is
    kept only while `edge.json` still holds what that save wrote, so a delayed
    replay cannot delete a newer save, and a save that failed or never ran cannot
    keep the released server and key. The config is read only in that case, and an
    unreadable `edge.json` is deleted, so it cannot block a Disconnect.
    A cleanup failure returns 503, so the caller replays until it succeeds.
    """
    body_value = body.model_dump(mode="json", exclude_none=True)
    store = request.app.state.store
    cloud_only_lite = await _is_cloud_only_lite_hardware(request)
    async with request.app.state.edge_config_lock:
        try:
            response, replayed = store.release_primary_bundle_idempotent(
                expected_revision=body.expected_bundle_revision,
                correlation_operation_id=body.correlation_operation_id,
                idempotency_key=body.idempotency_key,
                request=body_value,
                cloud_only_lite=cloud_only_lite,
            )
        except BundleRevisionConflict as exc:
            return _bundle_revision_error(exc)
        except PrimaryBundleNotReleasable as exc:
            return error_response("disconnect_not_available", str(exc), status_code=409)
        except IdempotencyConflict:
            return error_response(
                "idempotency_conflict",
                "The idempotency key was already used with a different request.",
                status_code=409,
            )
        cleanup = store.get_pending_release_cleanup(
            correlation_operation_id=body.correlation_operation_id,
            idempotency_key=body.idempotency_key,
        )
        lifecycle = store.get_bundle_lifecycle()
        if cleanup is not None and (
            lifecycle["primary_bundle"] is None and not is_preparation_in_flight(lifecycle["pending_bundle"])
        ):
            try:
                if cleanup["delete_edge_config"] or not _holds_edge_config(cleanup["saved_edge_config_fingerprint"]):
                    edge_config.delete()
                _selections.clear_local_provider(store)
                store.finish_release_cleanup(
                    correlation_operation_id=body.correlation_operation_id,
                    idempotency_key=body.idempotency_key,
                )
            except (OSError, sqlite3.Error):
                logger.opt(exception=True).error(
                    "released Edge primary Bundle but could not clear Edge config or local_provider"
                )
                return error_response(
                    "release_cleanup_failed",
                    "The Edge Bundle was released but its saved settings could not be cleared.",
                    status_code=503,
                )
    if not replayed:
        logger.info(
            "config.change kind=edge action=release correlation_operation_id={}",
            body.correlation_operation_id,
        )
    return PrimaryBundleReleaseResponse.model_validate(response).model_dump(mode="json")
