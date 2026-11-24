"""`disconnect` intent: release the committed Edge primary Bundle and return to bundle-free Lite.

Lite hardware only (#3446). Kept apart from the connect-oriented coordinator body:
a disconnect has no target Bundle and no prepare/commit phase. It shares only the
receipt store, so the App polls it like any other activation.
"""

from __future__ import annotations

import asyncio

import httpx
from loguru import logger

from contracts.model_binding_activation_request import ModelBindingActivationRequest
from contracts.primary_bundle import PrimaryBundleCapability
from contracts.primary_bundle_release_request import PrimaryBundleReleaseRequest
from contracts.runtime_deployment_spec import RuntimeDeploymentSpec

from servicehub.adapters.lrm_bundle_client import LrmBundleCapabilityResult
from servicehub.adapters.lrm_primary_bundle_client import LrmPrimaryBundleFailure
from servicehub.capability.profile_store import (
    ProfileOperationConflict,
    ProfileRevisionConflict,
    ProfileStoreCorruptionError,
    runtime_deployment_spec,
)
from servicehub.model_binding_activation.coordinator import (
    ModelBindingActivationCoordinator,
    ModelBindingActivationStartError,
    _elapsed_seconds,
    _runtime_evidence_matches,
    _runtime_evidence_ready,
    _timestamp,
)
from servicehub.model_binding_activation.receipt import ModelBindingActivationReceipt
from servicehub.model_binding_activation.runtime_provision_failure import provision_failure_code
from servicehub.supervisor.registry import ServiceInfo


async def start_disconnect(
    coordinator: ModelBindingActivationCoordinator, request: ModelBindingActivationRequest
) -> ModelBindingActivationReceipt:
    receipts = coordinator._receipt_store
    for existing in await receipts.scan():
        if existing.app_request.root.idempotency_key == request.root.idempotency_key:
            logger.info(
                "disconnect idempotent join operation_id={} state={}",
                existing.operation_id,
                existing.state,
            )
            record, _ = await receipts.create_or_join(request)
            return record
    profile_store = coordinator._capability.profile_store
    pending = await profile_store.get_pending()
    if pending is not None:
        logger.info(
            "disconnect rejected: model_binding_activation_in_progress pending_operation_id={} "
            "profile_revision={}",
            pending.operation_id,
            pending.snapshot.profile_revision,
        )
        raise ModelBindingActivationStartError("model_binding_activation_in_progress")
    active = await profile_store.get_active()
    if active is None or active.primary_bundle is None or active.primary_bundle.backend.value != "edge":
        raise ModelBindingActivationStartError("disconnect_not_available")
    actual = active.primary_bundle.bundle_revision
    if request.root.expected_bundle_revision != actual:
        logger.warning(
            "disconnect rejected: lrm_bundle_revision_conflict idempotency_key={} "
            "expected_bundle_revision={} actual_bundle_revision={}",
            request.root.idempotency_key,
            request.root.expected_bundle_revision,
            actual,
        )
        raise ModelBindingActivationStartError("lrm_bundle_revision_conflict", actual)
    capability = await _read_lrm_capability(coordinator, coordinator._lrm_service())
    if capability.primary_bundle is not None or await _earlier_release_command(
        coordinator, exclude_operation_id=None
    ) is None:
        # Skipped only when this retries a disconnect whose release LRM already applied.
        _require_lite(capability)
    record, created = await receipts.create_or_join(request)
    if created:
        logger.info("disconnect started operation_id={}", record.operation_id)
        schedule_disconnect(coordinator, record)
    return record


def schedule_disconnect(coordinator: ModelBindingActivationCoordinator, record: ModelBindingActivationReceipt) -> None:
    tasks = coordinator._background_tasks
    name = f"model-binding-disconnect:{record.operation_id}"
    if any(task.get_name() == name and not task.done() for task in tasks):
        return
    task = asyncio.create_task(run_disconnect(coordinator, record), name=name)
    tasks.append(task)
    task.add_done_callback(tasks.remove)


async def run_disconnect(coordinator: ModelBindingActivationCoordinator, record: ModelBindingActivationReceipt) -> None:
    """Drive one disconnect to a terminal state; every step is safe to re-run after a restart."""
    profile_store = coordinator._capability.profile_store
    try:
        active = await profile_store.get_active()
        if active is not None and active.product_profile_id == "lite" and active.primary_bundle is None:
            await _succeed(coordinator, record)
            return
        if active is None or active.primary_bundle is None or active.primary_bundle.backend.value != "edge":
            await _fail_not_available(coordinator, record, "No committed Edge primary Bundle to disconnect.")
            return
        if record.release_result is None:
            service = coordinator._lrm_service()
            capability = await _read_lrm_capability(coordinator, service)
            committed = capability.primary_bundle
            if committed is not None and committed.backend.value != "edge":
                await _fail_not_available(coordinator, record, "Committed primary Bundle is not Edge.")
                return
            command = await _release_command(coordinator, record, release_needed=committed is not None)
            if record.release_command is None and (committed is not None or command is None):
                # Only before any release was sent. Once one was, a degraded hardware probe must
                # not strand a half-finished disconnect; LRM refuses new releases off Lite itself.
                _require_lite(capability)
            if command is not None:
                if record.release_command is None:
                    # Saved before sending, so a crash after LRM commits still replays this exact release.
                    record = await coordinator._receipt_store.update(record, release_command=command)
                result = await coordinator._lrm.release(service, PrimaryBundleReleaseRequest.model_validate(command))
                if isinstance(result, LrmPrimaryBundleFailure):
                    await coordinator._handle_lrm_failure(record, result, "release")
                    return
                record = await coordinator._receipt_store.update(
                    record, release_result=result.payload.model_dump(mode="json")
                )
        if record.target_profile_revision is not None and await profile_store.get_pending() is None:
            # Lite is not active, so only runtime-failure cleanup discarded this operation's
            # pending Profile; the process stopped before the terminal write. Staging again
            # would leave a pending Profile no failed receipt owns, blocking every activation.
            await coordinator._fail(record, "safe_error")
            return
        pending = await profile_store.stage_pending(
            coordinator._capability.product_profile_catalog.load("lite"),
            resolution_source="hardware_ceiling",
            reasons=("trusted",),
            primary_bundle=None,
            operation_id=record.operation_id,
            expected_active_revision=active.snapshot.profile_revision,
        )
        if record.target_profile_revision is None:
            record = await coordinator._receipt_store.update(
                record,
                target_product_profile="lite",
                target_profile_revision=pending.snapshot.profile_revision,
                activation_result="runtime_transition_required",
            )
        if record.runtime_reconcile_started_at is None:
            # Saved before any sandbox I/O, so the deadline survives the recovery sweep re-running this worker.
            record = await coordinator._receipt_store.update(record, runtime_reconcile_started_at=_timestamp())
        started_at = record.runtime_reconcile_started_at
        deployment = runtime_deployment_spec(pending)
        sandbox_retries = 0
        while True:
            if _elapsed_seconds(started_at) >= coordinator._runtime_reconcile_timeout_s:
                logger.error("disconnect runtime reconcile deadline exhausted operation_id={}", record.operation_id)
                await _fail_runtime(coordinator, record, deployment, "native_runtime_unavailable")
                return
            try:
                record = await coordinator._ensure_runtime_deployment_persisted(record, deployment)
                evidence = (await coordinator._sandbox.get_runtime_instance_evidence()).root
            except (httpx.RequestError, httpx.HTTPStatusError, ValueError) as exc:
                if not _is_transient_sandbox_error(exc):
                    logger.error(
                        "disconnect runtime sandbox error operation_id={} error_type={}",
                        record.operation_id,
                        type(exc).__name__,
                    )
                    await _fail_runtime(coordinator, record, deployment, "runtime_instance_unavailable")
                    return
                # Warn once per outage; the rest go to debug until the sandbox answers or the deadline ends it.
                sandbox_retries += 1
                logger.log(
                    "WARNING" if sandbox_retries == 1 else "DEBUG",
                    "disconnect runtime sandbox unavailable, retrying operation_id={} error_type={} attempt={}",
                    record.operation_id,
                    type(exc).__name__,
                    sandbox_retries,
                )
            else:
                sandbox_retries = 0
                if evidence.status == "failed" and _runtime_evidence_matches(evidence, deployment):
                    await coordinator._fail_runtime_transition(record, "safe_error", provision_failure_code(evidence))
                    return
                if _runtime_evidence_ready(evidence, deployment, pending.snapshot.descriptor):
                    break
            await asyncio.sleep(coordinator._runtime_reconcile_interval_s)
        await profile_store.activate_cloud_only_lite_pending(
            operation_id=record.operation_id,
            expected_target_revision=pending.snapshot.profile_revision,
        )
        await _succeed(coordinator, record)
    except (ProfileStoreCorruptionError, ProfileOperationConflict, ProfileRevisionConflict) as exc:
        await coordinator._recover_required(record, f"disconnect_profile_error:{type(exc).__name__}")
    except ModelBindingActivationStartError as exc:
        if exc.code == "disconnect_not_available":
            await _fail_not_available(coordinator, record, "Disconnect is only available on Lite hardware.")
            return
        await coordinator._recover_required(record, "disconnect_lrm_unavailable")


async def _release_command(
    coordinator: ModelBindingActivationCoordinator,
    record: ModelBindingActivationReceipt,
    *,
    release_needed: bool,
) -> dict[str, object] | None:
    """The LRM release to send, or None when there is nothing to release or replay.

    A release this operation already saved is always resent with the same identity.
    With LRM's Bundle already gone (an earlier disconnect released it, then failed
    before Lite went active), the newest earlier release is replayed instead: LRM
    answers it from its idempotency record and finishes any Edge config cleanup a
    crash interrupted.
    """
    if record.release_command is not None:
        return record.release_command
    if release_needed:
        return PrimaryBundleReleaseRequest.model_validate({
            "contract_version": 1,
            "correlation_operation_id": record.operation_id,
            "expected_bundle_revision": record.app_request.root.expected_bundle_revision,
            "idempotency_key": f"{record.app_request.root.idempotency_key}:release",
        }).model_dump(mode="json")
    return await _earlier_release_command(coordinator, exclude_operation_id=record.operation_id)


async def _earlier_release_command(
    coordinator: ModelBindingActivationCoordinator, *, exclude_operation_id: str | None
) -> dict[str, object] | None:
    """The newest release an earlier disconnect already sent to LRM, if any."""
    earlier = [
        receipt
        for receipt in await coordinator._receipt_store.scan()
        if receipt.operation_id != exclude_operation_id
        and receipt.app_request.root.intent == "disconnect"
        and receipt.release_command is not None
    ]
    if not earlier:
        return None
    return max(earlier, key=lambda receipt: receipt.updated_at).release_command


async def _read_lrm_capability(
    coordinator: ModelBindingActivationCoordinator, service: ServiceInfo
) -> PrimaryBundleCapability:
    result = await coordinator._capability.lrm_bundle_client.get_primary_bundle(service)
    if not isinstance(result, LrmBundleCapabilityResult):
        raise ModelBindingActivationStartError("safe_error")
    return result.capability


def _require_lite(capability: PrimaryBundleCapability) -> None:
    if capability.cloud_only_product_profile_id != "lite":
        raise ModelBindingActivationStartError("disconnect_not_available")


async def _fail_not_available(
    coordinator: ModelBindingActivationCoordinator, record: ModelBindingActivationReceipt, message: str
) -> None:
    await coordinator._fail(
        record, "disconnect_not_available", {"code": "disconnect_not_available", "message": message}
    )


async def _fail_runtime(
    coordinator: ModelBindingActivationCoordinator,
    record: ModelBindingActivationReceipt,
    deployment: RuntimeDeploymentSpec,
    code: str,
) -> None:
    """Fail the Lite transition, revoking the Lite deployment whenever the sandbox may hold it.

    A saved fingerprint proves the sandbox stored it. Without one the write may still
    have landed (lost reply, or a crash before the fingerprint was saved), so the
    sandbox is read back first. Revoking a deployment the sandbox never stored would
    conflict with the one it holds and never finish, so that case only fails. An
    unreadable sandbox keeps the operation in recovery, so the slot is never freed
    with the Lite deployment possibly still live.
    """
    if record.runtime_deployment_fingerprint is None:
        try:
            stored = await coordinator._sandbox.get_runtime_deployment()
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code != 404:
                await coordinator._recover_required(record, "disconnect_deployment_outcome_unknown")
                return
            stored = None
        except (httpx.RequestError, ValueError):
            await coordinator._recover_required(record, "disconnect_deployment_outcome_unknown")
            return
        if stored != deployment:
            await coordinator._fail(record, code)
            return
    await coordinator._fail_runtime_transition(record, code)


def _is_transient_sandbox_error(exc: Exception) -> bool:
    return isinstance(exc, httpx.RequestError) or (
        isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code == 503
    )


async def _succeed(coordinator: ModelBindingActivationCoordinator, record: ModelBindingActivationReceipt) -> None:
    logger.info("disconnect succeeded operation_id={}", record.operation_id)
    await coordinator._receipt_store.update(record, state="succeeded", pct=100, finished_at=_timestamp())
