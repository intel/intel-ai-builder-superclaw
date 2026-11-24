"""Durable Model Binding and Product Profile activation coordinator."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import hashlib
import json
import time
from typing import TYPE_CHECKING, cast

import httpx
from loguru import logger

from contracts.model_bundle import ModelBundle
from contracts.primary_bundle_lifecycle_readback import PrimaryBundleLifecycleReadback
from contracts.primary_bundle_prepare_request import PrimaryBundlePrepareRequest
from contracts.primary_bundle_commit_request import PrimaryBundleCommitRequest
from contracts.model_binding_activation_request import ModelBindingActivationRequest
from contracts.primary_bundle_state import PrimaryBundleState
from contracts.runtime_deployment_spec import RuntimeDeploymentSpec
from contracts.runtime_instance_evidence import (
    RuntimeInstanceEvidence1,
    RuntimeInstanceEvidence2,
    RuntimeInstanceEvidence3,
)

from servicehub.adapters.lrm_bundle_client import LrmBundleCapabilityResult
from servicehub.adapters.restricted_sandbox_lifecycle_client import (
    RestrictedSandboxFeatureNotReady,
    RestrictedSandboxLifecycleClient,
)
from servicehub.adapters.lrm_primary_bundle_client import (
    LrmPrimaryBundleClient,
    LrmPrimaryBundleFailure,
    LrmPrimaryBundleSuccess,
)
from servicehub.capability.atomic_json import canonical_json_bytes
from servicehub.capability.product_profile_catalog import (
    ProductProfileLoadError,
    ProductProfileTransientLoadError,
)
from servicehub.capability.profile_store import (
    PendingProfileRecord,
    ProfileOperationConflict,
    ProfileRevisionConflict,
    ProfileStoreCorruptionError,
    runtime_deployment_spec,
)
from servicehub.model_binding_activation.activation_failure_copy import (
    activation_failure_error,
    activation_failure_message,
)
from servicehub.model_binding_activation.receipt import (
    ActivationReceiptError,
    ModelBindingActivationReceipt,
    ModelBindingActivationReceiptStore,
    is_retryable_activation,
    runtime_recovery_target,
)
from servicehub.model_binding_activation.runtime_provision_failure import provision_failure_code, provision_failure_error
from servicehub.supervisor.registry import ServiceInfo

if TYPE_CHECKING:
    from servicehub.capability.lifecycle import CapabilityLifecycle

# How often `recover()` logs a heartbeat while its initial sweep is still
# running (#2013's 15+ minute silent hang). Diagnostic only: does not bound
# or cancel the sweep itself.
_RECOVER_HEARTBEAT_INTERVAL_S = 5.0
_RUNTIME_RECONCILE_TIMEOUT_S = 600.0


class ModelBindingActivationCoordinator:
    def __init__(
        self,
        *,
        capability: CapabilityLifecycle,
        receipt_store: ModelBindingActivationReceiptStore,
        lrm_primary_bundle_client: LrmPrimaryBundleClient,
        registry: object,
        background_tasks: list[asyncio.Task[None]],
        poll_interval_s: float = 0.05,
        runtime_reconcile_interval_s: float = 0.5,
        runtime_reconcile_timeout_s: float = _RUNTIME_RECONCILE_TIMEOUT_S,
    ) -> None:
        self._capability = capability
        self._receipt_store = receipt_store
        self._lrm = lrm_primary_bundle_client
        self._registry = registry
        self._background_tasks = background_tasks
        self._sandbox: RestrictedSandboxLifecycleClient = capability.restricted_sandbox_lifecycle_client
        self._poll_interval_s = poll_interval_s
        self._runtime_reconcile_interval_s = runtime_reconcile_interval_s
        self._runtime_reconcile_timeout_s = runtime_reconcile_timeout_s
        self._operation_locks: dict[str, asyncio.Lock] = {}
        self._runtime_reconcile_delays: dict[str, asyncio.Task[None]] = {}
        self._recovery_task: asyncio.Task[None] | None = None
        # #2013: `recover()` was observed logging "recover starting" and then
        # nothing further for 15+ minutes, with no timeout and no way for an
        # inbound request to tell the difference between "still recovering"
        # and "hub is dead". Exposed so callers (e.g. the capability-profile
        # and activation routes) can return a typed, actionable response while
        # this is true instead of an opaque 503/500.
        self._recovery_in_progress = False

    async def start_activation(self, request: ModelBindingActivationRequest) -> ModelBindingActivationReceipt:
        if request.root.intent == "disconnect":
            from servicehub.model_binding_activation.disconnect import start_disconnect  # import cycle
            return await start_disconnect(self, request)
        records = await self._receipt_store.scan()
        for existing in records:
            if existing.app_request.root.idempotency_key == request.root.idempotency_key:
                logger.info(
                    "activation idempotent join operation_id={} state={}",
                    existing.operation_id,
                    existing.state,
                )
                record, _ = await self._receipt_store.create_or_join(request)
                return record
        pending = await self._capability.profile_store.get_pending()
        if pending is not None and not pending.operation_id.startswith("hub:activation-"):
            logger.info(
                "activation discarding legacy pending Profile operation_id={} profile_revision={}",
                pending.operation_id,
                pending.snapshot.profile_revision,
            )
            await self._capability.profile_store.discard_pending(
                operation_id=pending.operation_id,
                expected_target_revision=pending.snapshot.profile_revision,
            )
            pending = None
        if pending is not None:
            logger.info(
                "activation rejected: model_binding_activation_in_progress pending_operation_id={} "
                "profile_revision={}",
                pending.operation_id,
                pending.snapshot.profile_revision,
            )
            raise ModelBindingActivationStartError("model_binding_activation_in_progress")
        service = self._lrm_service()
        await self._preflight(service, request)
        record, created = await self._receipt_store.create_or_join(request)
        if created:
            logger.info(
                "activation started operation_id={} target_bundle_id={}",
                record.operation_id,
                request.root.target_bundle_id,
            )
            self.request_reconcile(record.operation_id)
        return record

    @property
    def recovering(self) -> bool:
        """True while the initial `recover()` sweep is in flight (#2013)."""
        return self._recovery_in_progress

    async def recover(self) -> None:
        """Recover the durable activation, pausing interrupted downloads for consent.

        #2013 observed this logging "recover starting" and then nothing further
        for 15+ minutes: no timeout, no error, no way to tell a slow-but-alive
        recovery from a hung one. This does not change the recovery's own
        timeout/retry behavior (any real fix for a hang belongs in whatever
        `_recover_once()` awaits, not here) -- it only makes a slow sweep
        observable: a heartbeat warning every `_RECOVER_HEARTBEAT_INTERVAL_S`
        while it is still running, and an elapsed-time line when it finishes.
        """
        logger.info("activation coordinator recover starting")
        started = time.monotonic()
        self._recovery_in_progress = True
        task = asyncio.create_task(self._recover_once())
        try:
            while True:
                done, _pending = await asyncio.wait({task}, timeout=_RECOVER_HEARTBEAT_INTERVAL_S)
                if task in done:
                    break
                logger.warning(
                    "activation coordinator recover still in progress elapsed_ms={}",
                    round((time.monotonic() - started) * 1000, 1),
                )
            await task  # re-raise anything `_recover_once` did not itself swallow
        except asyncio.CancelledError:
            # `asyncio.wait()` does not cancel the futures/tasks it was
            # waiting on when *this* coroutine is the one cancelled (e.g. a
            # future caller wraps `recover()` in `wait_for(...)` or cancels
            # the task running it during shutdown) -- without this, `task`
            # would keep running detached in the background after
            # `recover()` itself has already unwound. No current caller
            # cancels `recover()`, but nothing should rely on that; mirrors
            # `aclose()`'s handling of `_recovery_task` below.
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            raise
        finally:
            self._recovery_in_progress = False
            logger.info(
                "activation coordinator recover finished elapsed_ms={}",
                round((time.monotonic() - started) * 1000, 1),
            )
        if self._recovery_task is None or self._recovery_task.done():
            self._recovery_task = asyncio.create_task(self._recover_until_settled())

    async def aclose(self) -> None:
        for task in self._runtime_reconcile_delays.values():
            task.cancel()
        if self._runtime_reconcile_delays:
            await asyncio.gather(*self._runtime_reconcile_delays.values(), return_exceptions=True)
        self._runtime_reconcile_delays.clear()
        if self._recovery_task is not None:
            self._recovery_task.cancel()
            try:
                await self._recovery_task
            except asyncio.CancelledError:
                pass

    async def _recover_until_settled(self) -> None:
        """Keep sweeping for records parked in `recovery_required`.

        Deliberately does NOT exit once none are found. It used to `return` on the
        first clean sweep, which made it useless for anything that entered the
        phase LATER in the same process: `recover()` runs once from the startup
        lifespan, so after this task exited nothing retried such a record for the
        rest of the process's life. Observed in #1682 -- the task returned at
        03:38:11 (the only stuck record had just turned `failed`), an activation entered
        `recovery_required` at 03:42:07, and the log carries no further coordinator
        line at all. The activation slot stayed held and the only escape was restarting
        the app.

        Runs for the lifetime of the coordinator instead, and `aclose()` cancels
        it. A sweep with nothing to do is a receipt_store scan on the poll interval,
        which is the same cost the operation-polling path already pays.
        """
        while True:
            await asyncio.sleep(max(1.0, self._poll_interval_s))
            try:
                records = await self._receipt_store.scan()
            except ActivationReceiptError:
                # A scan failure is not evidence that there is nothing to recover,
                # so keep sweeping rather than exiting; the next pass may succeed.
                continue
            if not any(record.state not in {"succeeded", "failed", "cancelled"} for record in records):
                continue
            await self._recover_once()

    async def _recover_once(self) -> None:
        try:
            records = await self._receipt_store.scan()
        except ActivationReceiptError:
            return
        active = [record for record in records if record.state not in {"succeeded", "failed", "cancelled"}]
        if len(active) != 1:
            return
        record = active[0]
        logger.info(
            "activation coordinator recover_once operation_id={} state={}",
            record.operation_id,
            record.state,
        )
        if record.app_request.root.intent == "disconnect":
            from servicehub.model_binding_activation.disconnect import schedule_disconnect  # import cycle
            schedule_disconnect(self, record)
            return
        if _is_applying_runtime_transition(record):
            self.request_reconcile(record.operation_id)
            return
        try:
            pending = await self._capability.profile_store.get_pending()
        except ProfileStoreCorruptionError:
            await self._recover_required(record, "profile_store_corrupt")
            return
        if pending is not None and pending.operation_id != record.operation_id:
            await self._recover_required(record, "pending_profile_owner_mismatch")
            return
        if record.cancellation_requested:
            await self.cancel(record.operation_id)
            return
        if (
            record.app_request.root.intent == "download_and_connect"
            and record.prepare_operation_id is not None
            and record.prepare_readback is None
        ):
            # Auto-resume instead of waiting for an explicit App confirmation
            # that never arrives on its own: no live UI path calls the
            # resume endpoint on the App's behalf (only a manual "Retry"
            # click attempts a new activation, which just re-hits this same
            # active record via `create_or_join`'s conflict check). Without
            # this, an interrupted download stays parked here forever after
            # every ServiceHub restart, permanently reserving the one activation
            # slot (`model_binding_activation_in_progress` on every future
            # attempt) with no way for the App to ever get unstuck short of
            # exiting. `resume()` reuses the exact same LRM resume-preparation
            # call the (dead) explicit-confirmation path would have made, so
            # LRM's own boot-time drift detection is discovered here too.
            await self._attempt_auto_resume(record)
            return
        self.request_reconcile(record.operation_id)

    async def _attempt_auto_resume(self, record: ModelBindingActivationReceipt) -> None:
        """Call `resume()` for an unattended, auto-resume-eligible record.

        Shared by both `_recover_once()` call sites that drive this (the
        initial attempt for a freshly-interrupted download, and the retry
        for one already parked in `recovery_required` because a prior
        attempt hit this same failure) so they can't drift apart. Unlike the
        explicit `POST /activations/{id}/resume` route (`api.py`, which already
        catches `ModelBindingActivationStartError` and returns 409), there is no HTTP
        caller here to hand an error to -- this runs from `recover()`,
        called unconditionally from ServiceHub's own startup lifespan.
        `_lrm_service()` raises when LRM is not yet registered as "running"
        (e.g. ServiceHub started with `--no-spawn` ahead of LRM, or a
        boot-time race), which would otherwise propagate out of `recover()`
        and crash ServiceHub startup. Fall back to `recovery_required`
        instead, so the caller retries this same attempt once LRM is
        reachable.

        Before retrying `resume_preparation`, read LRM's plain readback
        first (when a `prepare_operation_id` already exists) to find out
        whether there is anything left to resume at all: a real
        registry/revision drift means LRM's own boot-time recovery
        (`restore_interrupted_local_bundle` -> `_transition_recovery_to_error`)
        already terminated the pending Bundle before we ever asked, so
        `resume_preparation` itself would keep answering a transport-shaped
        `safe_error` (404 `preparation_not_found`, mapped generically) on
        every future attempt -- retrying that call forever would just trade
        the original permanent-lockout bug for a new one that can never
        reach a terminal state. The readback is not subject to that 404: it
        honestly reports whatever durable state LRM actually holds.
        """
        logger.info(
            "activation recover auto-resuming interrupted download operation_id={}",
            record.operation_id,
        )
        if record.prepare_operation_id is not None:
            try:
                readback_result = await self._lrm.get_preparation(
                    self._lrm_service(), record.prepare_operation_id
                )
            except ModelBindingActivationStartError:
                await self._recover_required(record, "resume_transport_unavailable")
                return
            if isinstance(readback_result, LrmPrimaryBundleFailure):
                # Transport hiccup on the readback itself (not a terminal LRM
                # verdict) -- stay in `recovery_required` and let the next
                # settling pass try again, same as an unreachable LRM.
                await self._recover_required(record, "resume_readback_outcome_unknown")
                return
            readback = readback_result.payload
            if readback.state.value in {"failed", "cancelled"}:
                # Terminal per LRM's own record: no amount of retrying
                # `resume_preparation` will ever change this outcome. Free
                # the one activation slot instead of looping forever.
                await self._fail(record, "safe_error", _prepare_failed_error(readback))
                return
            if readback.state.value == "succeeded":
                # Already done -- calling `resume_preparation` now would hit
                # LRM's own "nothing left to resume" 404 (mapped to a
                # transport-shaped `safe_error`) since the pending slot is no
                # longer in a resumable state. Go straight to the ordinary
                # worker poll loop, which re-reads this same readback and
                # advances the activation normally.
                self.request_reconcile(record.operation_id)
                return
        try:
            await self.resume(record.operation_id)
        except ModelBindingActivationStartError:
            await self._recover_required(record, "resume_transport_unavailable")

    async def resume(self, operation_id: str) -> ModelBindingActivationReceipt | None:
        """Resume a durable pre-restart preparation.

        Called both from `_recover_once()` (unattended, on every ServiceHub
        boot) and from the explicit user Retry route. Idempotent either way:
        re-checks durable owner evidence before doing anything.
        """
        record = await self._receipt_store.get(operation_id)
        if record is None:
            logger.info("activation resume no-op operation_id={} reason=not_found", operation_id)
            return record
        if record.app_request.root.intent == "disconnect":
            logger.info("activation resume no-op operation_id={} reason=disconnect_not_resumable", operation_id)
            return record
        if record.state in {"succeeded", "failed", "cancelled"}:
            logger.info(
                "activation resume no-op operation_id={} reason=already_terminal state={}",
                operation_id,
                record.state,
            )
            return record
        if record.commit_command is not None or record.commit_readback is not None:
            logger.info("activation resume no-op operation_id={} reason=commit_started", operation_id)
            return record
        logger.info(
            "activation resume starting operation_id={} prepare_operation_id={}",
            operation_id,
            record.prepare_operation_id,
        )
        if record.prepare_operation_id is not None:
            result = await self._lrm.resume_preparation(
                self._lrm_service(), record.prepare_operation_id
            )
            if isinstance(result, LrmPrimaryBundleFailure):
                return await self._handle_lrm_failure(record, result, "prepare_resume")
        self.request_reconcile(operation_id)
        logger.info("activation resume worker started operation_id={}", operation_id)
        return await self._receipt_store.get(operation_id)

    async def get(self, operation_id: str) -> ModelBindingActivationReceipt | None:
        return await self._receipt_store.get(operation_id)

    async def cancel(self, operation_id: str) -> ModelBindingActivationReceipt | None:
        async with self._operation_lock(operation_id):
            record = await self._receipt_store.get(operation_id)
            if record is None:
                return None
            if record.app_request.root.intent == "disconnect":
                # The LRM release may already be irreversible; disconnect is not cancellable.
                return record
            if record.state in {"succeeded", "failed", "cancelled"}:
                return record
            if _is_applying_runtime_transition(record):
                return record
            if record.commit_command is not None or record.commit_readback is not None:
                return await self._recover_required(record, "cancellation_after_commit_started")
            if not record.cancellation_requested:
                record = await self._receipt_store.update(record, cancellation_requested=True)
            if record.prepare_operation_id is None:
                if record.prepare_command is not None:
                    try:
                        replay = await self._lrm.prepare(
                            self._lrm_service(),
                            PrimaryBundlePrepareRequest.model_validate(record.prepare_command),
                        )
                    except (ModelBindingActivationStartError, ValueError):
                        return await self._recover_required(record, "prepare_outcome_unknown")
                    if isinstance(replay, LrmPrimaryBundleFailure):
                        return await self._handle_lrm_failure(record, replay, "prepare_replay_for_abort")
                    response = replay.payload
                    if (
                        response.correlation_operation_id != record.operation_id
                        or response.idempotency_key != record.app_request.root.idempotency_key
                    ):
                        return await self._recover_required(record, "prepare_replay_response_identity_mismatch")
                    record = await self._receipt_store.update(
                        record,
                        prepare_operation_id=response.prepare_operation_id,
                    )
                    readback = await self._lrm.get_preparation(self._lrm_service(), record.prepare_operation_id)
                    if isinstance(readback, LrmPrimaryBundleFailure):
                        return await self._handle_lrm_failure(record, readback, "prepare_replay_readback")
                    if not _matches(record, readback.payload):
                        return await self._recover_required(record, "prepare_replay_readback_identity_mismatch")
                    record = await self._receipt_store.update(
                        record, prepare_readback=readback.payload.model_dump(mode="json", exclude_none=True)
                    )
                else:
                    return await self._cancelled(record)
            command = record.abort_command or {
                "contract_version": 1,
                "correlation_operation_id": record.operation_id,
                "target_bundle_id": record.app_request.root.target_bundle_id,
                "expected_bundle_revision": record.app_request.root.expected_bundle_revision,
                "prepare_operation_id": record.prepare_operation_id,
                "idempotency_key": f"{record.app_request.root.idempotency_key}:abort",
            }
            record = await self._receipt_store.update(record, abort_command=command)
            from contracts.primary_bundle_abort_request import PrimaryBundleAbortRequest
            try:
                result = await self._lrm.abort(self._lrm_service(), PrimaryBundleAbortRequest.model_validate(command))
            except ModelBindingActivationStartError:
                return await self._recover_required(record, "abort_transport_unavailable")
            if isinstance(result, LrmPrimaryBundleFailure):
                return await self._handle_lrm_failure(record, result, "abort")
            if not _matches_abort(record, result.payload, command):
                return await self._recover_required(record, "abort_response_identity_mismatch")
            readback_result = await self._lrm.get_preparation(self._lrm_service(), record.prepare_operation_id)
            if isinstance(readback_result, LrmPrimaryBundleFailure):
                return await self._handle_lrm_failure(record, readback_result, "abort_readback")
            if not _matches_abort(record, readback_result.payload, command):
                return await self._recover_required(record, "abort_readback_identity_mismatch")
            if record.target_profile_revision is not None:
                try:
                    await self._capability.profile_store.discard_pending(
                        operation_id=record.operation_id,
                        expected_target_revision=record.target_profile_revision,
                    )
                except (ProfileStoreCorruptionError, RuntimeError):
                    return await self._recover_required(record, "pending_profile_discard_unknown")
            return await self._cancelled(record)

    async def _preflight(self, service: ServiceInfo, request: ModelBindingActivationRequest) -> None:
        result = await self._capability.lrm_bundle_client.get_primary_bundle(service)
        if not isinstance(result, LrmBundleCapabilityResult):
            logger.warning(
                "activation preflight rejected: safe_error service={} result_type={}",
                service.name,
                type(result).__name__,
            )
            raise ModelBindingActivationStartError("safe_error")
        capability = result.capability
        body = request.root
        if body.target_bundle_id not in capability.supported_bundle_ids:
            raise ModelBindingActivationStartError("bundle_candidate_changed")
        if body.candidate_revision != capability.model_candidate_revision:
            raise ModelBindingActivationStartError("bundle_candidate_changed")
        actual = result.bundle_revision
        if body.expected_bundle_revision != actual:
            # Silent before this line: neither this raise nor api.py's except
            # clause logged anything, so a real occurrence (e.g. the App's own
            # startup connect racing ServiceHub's own manifest-drift reheal --
            # both target the same bundle around boot) left zero trace in
            # servicehub-*.log despite surfacing to the user as a bare
            # "Model Binding Activation cannot start." (#2013/#2056 family).
            logger.warning(
                "model Binding activation preflight rejected: lrm_bundle_revision_conflict "
                "target_bundle_id={} idempotency_key={} expected_bundle_revision={} actual_bundle_revision={}",
                body.target_bundle_id,
                body.idempotency_key,
                body.expected_bundle_revision,
                actual,
            )
            raise ModelBindingActivationStartError("lrm_bundle_revision_conflict", actual)

    async def _run(self, operation_id: str) -> None:
        async with self._operation_lock(operation_id):
            record = await self._receipt_store.get(operation_id)
            if record is None or record.state in {"succeeded", "failed", "cancelled"}:
                return
            try:
                await self._run_locked(record)
            except Exception as exc:
                logger.exception(
                    "model Binding activation reconcile failed operation_id={} error_type={}",
                    operation_id,
                    type(exc).__name__,
                )
                latest = await self._receipt_store.get(operation_id)
                if latest is not None and latest.state not in {"succeeded", "failed", "cancelled"}:
                    await self._recover_required(latest, "worker_exception")
                    if _is_committed_runtime_transition(latest):
                        self._schedule_runtime_reconcile(operation_id)

    async def _run_locked(self, record: ModelBindingActivationReceipt) -> None:
        try:
            if record.cancellation_requested:
                return
            if record.commit_readback is not None:
                if record.activation_result == "binding_only":
                    await self._finish_binding_only(record)
                    return
                if (
                    record.activation_result == "runtime_transition_required"
                    and record.target_product_profile is not None
                ):
                    await self._reconcile_runtime_locked(record)
                    return
                await self._recover_required(record, "target_product_profile_missing_after_commit")
                return
            if record.commit_command is not None:
                await self._commit_and_persist(record)
                return
            if record.activation_result is not None:
                await self._commit_and_persist(record)
                return
            if record.prepare_command is None:
                logger.info(
                    "activation preparing operation_id={}",
                    record.operation_id,
                )
                if record.app_request.root.expected_bundle_revision == 0:
                    self._schedule_runtime_infrastructure_preparation(record.operation_id)
                record = await self._receipt_store.update(
                    record, state="running", pct=10, error=None, recovery_evidence=None
                )
                record = await self._receipt_store.update(record, state="running", pct=20)
            command = record.prepare_command or _prepare_command(record)
            if record.prepare_command is None:
                record = await self._receipt_store.update(record, prepare_command=command)
            if record.prepare_operation_id is None:
                result = await self._lrm.prepare(self._lrm_service(), PrimaryBundlePrepareRequest.model_validate(command))
                if isinstance(result, LrmPrimaryBundleFailure):
                    await self._handle_lrm_failure(record, result, "prepare")
                    return
                response = result.payload
                if response.correlation_operation_id != record.operation_id or response.idempotency_key != record.app_request.root.idempotency_key:
                    await self._recover_required(record, "prepare_response_identity_mismatch")
                    return
                record = await self._receipt_store.update(
                    record,
                    prepare_operation_id=response.prepare_operation_id,
                )
            if record.prepare_operation_id is None:
                await self._recover_required(record, "prepare_receipt_missing")
                return
            # If prepare_readback was already durably written but captured a stale
            # "running" snapshot (e.g. worker crashed mid-poll), re-read from LRM
            # to get the current state but do NOT attempt to overwrite the immutable
            # field — only advance if LRM now reports succeeded.
            if record.prepare_readback is not None:
                stale_state = (record.prepare_readback or {}).get("state")
                if stale_state in {"queued", "running"}:
                    readback_result = await self._lrm.get_preparation(self._lrm_service(), record.prepare_operation_id)
                    if isinstance(readback_result, LrmPrimaryBundleFailure):
                        if readback_result.code == "safe_error":
                            await asyncio.sleep(max(5.0, self._poll_interval_s))
                            return  # let _recover_until_settled re-dispatch the worker
                        await self._handle_lrm_failure(record, readback_result, "prepare_readback_resume")
                        return
                    readback = readback_result.payload
                    if not _matches(record, readback):
                        await self._recover_required(record, "prepare_readback_identity_mismatch")
                        return
                    if readback.state.value in {"queued", "running"}:
                        record = await self._receipt_store.update(record, pct=max(20, min(90, readback.pct)))
                        await asyncio.sleep(max(5.0, self._poll_interval_s))
                        refreshed = await self._receipt_store.get(record.operation_id)
                        if refreshed is None or refreshed.cancellation_requested:
                            return
                        record = refreshed
                    elif readback.state.value == "succeeded":
                        latest = await self._receipt_store.get(record.operation_id)
                        if latest is None or latest.cancellation_requested:
                            return
                        record = await self._receipt_store.update(
                            latest,
                            prepare_readback=readback.model_dump(mode="json", exclude_none=True),
                        )
                        await self._advance_prepared(record, readback)
                        return
                    else:
                        await self._fail(record, "safe_error", _prepare_failed_error(readback))
                        return
            # Track the last logged (state, pct) so the poll-readback line is
            # only emitted when it actually changes — the poll runs many times a
            # second and would otherwise flood the log with identical lines.
            _last_logged_readback: tuple[str, float] | None = None
            while True:
                latest = await self._receipt_store.get(record.operation_id)
                if latest is None or latest.cancellation_requested:
                    return
                readback_result = await self._lrm.get_preparation(self._lrm_service(), record.prepare_operation_id)
                if isinstance(readback_result, LrmPrimaryBundleFailure):
                    # safe_error covers transport timeouts (e.g. LRM loading model into
                    # memory and temporarily unresponsive) — retry rather than escalate.
                    if readback_result.code == "safe_error":
                        await asyncio.sleep(max(5.0, self._poll_interval_s))
                        continue
                    await self._handle_lrm_failure(record, readback_result, "prepare_readback")
                    return
                readback = readback_result.payload
                _readback_key = (readback.state.value, readback.pct)
                if _readback_key != _last_logged_readback:
                    _last_logged_readback = _readback_key
                    logger.info(
                        "[activation-debug] poll readback: op={} state={} pct={} matches={}",
                        record.operation_id,
                        readback.state.value,
                        readback.pct,
                        _matches(record, readback),
                    )
                if not _matches(record, readback):
                    logger.error(
                        "[activation-debug] _matches FAILED -> recover_required. record.target_bundle_id={} candidate_rev={} expected_rev={} idem={} || readback.target_bundle_id={} candidate_rev={} expected_rev={} idem={} correlation={}",
                        record.app_request.root.target_bundle_id,
                        record.app_request.root.candidate_revision,
                        record.app_request.root.expected_bundle_revision,
                        record.app_request.root.idempotency_key,
                        getattr(getattr(readback, "target_bundle", None), "bundle_id", "?"),
                        getattr(readback, "candidate_revision", "?"),
                        getattr(readback, "expected_bundle_revision", "?"),
                        getattr(readback, "idempotency_key", "?"),
                        getattr(readback, "correlation_operation_id", "?"),
                    )
                    await self._recover_required(record, "prepare_readback_identity_mismatch")
                    return
                if record.prepare_readback is None and readback.state.value not in {"queued", "running"}:
                    if readback.state.value == "succeeded":
                        # Persist the success readback durably before advancing.
                        record = await self._receipt_store.update(
                            record, prepare_readback=readback.model_dump(mode="json", exclude_none=True)
                        )
                    # Failed readback with no prior success: do NOT persist it; keeping
                    # prepare_readback=None is what lets _run_locked detect the
                    # interrupted state and re-prepare on the next boot.
                if readback.state.value in {"queued", "running"}:
                    record = await self._receipt_store.update(record, pct=max(20, min(90, readback.pct)))
                    await asyncio.sleep(self._poll_interval_s)
                    continue
                if readback.state.value != "succeeded":
                    logger.error(
                        "[activation-debug] poll _fail: op={} readback.state={} pct={} message={}",
                        record.operation_id,
                        readback.state.value,
                        readback.pct,
                        readback.message,
                    )
                    # A `failed`/`cancelled` readback payload is terminal: LRM
                    # reports a genuine prepare failure (e.g. Edge probe failure).
                    # A real LRM-restart interruption never lands here — it keeps
                    # the op `running` (resumed) or surfaces as a transport
                    # `safe_error` (retried above). Terminate the activation instead of
                    # looping a fresh prepare against an already-failed target.
                    await self._fail(record, "safe_error", _prepare_failed_error(readback))
                    return
                latest = await self._receipt_store.get(record.operation_id)
                if latest is None or latest.cancellation_requested:
                    return
                await self._advance_prepared(record, readback)
                return

        except (ProfileStoreCorruptionError, ActivationReceiptError, ValueError, RuntimeError):
            raise

    async def _advance_prepared(self, record: ModelBindingActivationReceipt, readback: object) -> None:
        if record.prepare_operation_id is None:
            await self._recover_required(record, "prepare_receipt_missing")
            return
        candidate_result = await self._lrm.get_prepared_model_binding(
            self._lrm_service(), record.prepare_operation_id
        )
        if isinstance(candidate_result, LrmPrimaryBundleFailure):
            await self._handle_lrm_failure(record, candidate_result, "prepared_binding_readback")
            return
        candidate = candidate_result.payload
        if not _matches_prepared_binding(record, candidate):
            await self._recover_required(record, "prepared_binding_identity_mismatch")
            return

        active = await self._capability.profile_store.get_active()
        active_product_profile_id = active.product_profile_id if active else None
        compatible_profiles = tuple(profile.value for profile in candidate.compatible_product_profiles)
        activation_result = (
            "binding_only"
            if active_product_profile_id in compatible_profiles
            else "runtime_transition_required"
        )
        if activation_result == "binding_only":
            record = await self._receipt_store.update(
                record,
                state="running",
                pct=90,
                activation_result=activation_result,
            )
            await self._commit_and_persist(record)
            return

        if len(compatible_profiles) != 1:
            await self._recover_required(record, "target_product_profile_selection_ambiguous")
            return
        selected_profile_id = compatible_profiles[0]
        prepared = cast(PrimaryBundleLifecycleReadback, readback)
        target = ModelBundle.model_validate(prepared.target_bundle.model_dump(mode="json"))
        try:
            product_profile = self._capability.product_profile_catalog.load(selected_profile_id)
        except ProductProfileLoadError:
            await self._recover_required(record, "target_product_profile_unreadable")
            return
        active_revision = active.snapshot.profile_revision if active else 0
        record = await self._receipt_store.update(
            record,
            activation_result=activation_result,
            stage_command=_stage_command(record, target, active_revision),
        )
        pending = await self._capability.profile_store.stage_pending(
            product_profile,
            resolution_source="primary_bundle",
            reasons=("trusted",),
            primary_bundle=None,
            target_bundle=target,
            operation_id=record.operation_id,
            expected_active_revision=active_revision,
        )
        persisted_pending = await self._capability.profile_store.get_pending()
        if persisted_pending is None:
            await self._recover_required(record, "staged_profile_missing")
            return
        if not _matches_staged_profile(record, persisted_pending, target, pending):
            await self._recover_required(record, "staged_profile_identity_mismatch")
            return
        record = await self._receipt_store.update(
            record,
            state="running",
            pct=90,
            target_profile_revision=persisted_pending.snapshot.profile_revision,
            target_product_profile=compatible_profiles[0],
        )
        if active is None and record.app_request.root.expected_bundle_revision == 0:
            await self._start_first_runtime_convergence(record, persisted_pending)
        await self._commit_and_persist(record)

    async def _commit_and_persist(self, record: ModelBindingActivationReceipt) -> None:
        logger.info(
            "activation committing operation_id={}",
            record.operation_id,
        )
        command = record.commit_command or PrimaryBundleCommitRequest.model_validate({
            "contract_version": 1,
            "correlation_operation_id": record.operation_id,
            "target_bundle_id": record.app_request.root.target_bundle_id,
            "expected_bundle_revision": record.app_request.root.expected_bundle_revision,
            "prepare_operation_id": record.prepare_operation_id,
            "idempotency_key": f"{record.app_request.root.idempotency_key}:commit",
        }, strict=True)
        if record.commit_command is None:
            record = await self._receipt_store.update(
                record, state="running", pct=92, commit_command=command
            )
        if record.commit_result is None:
            result = await self._lrm.commit(self._lrm_service(), command)
            if isinstance(result, LrmPrimaryBundleFailure):
                # A `safe_error` means the REQUEST failed, not that the commit
                # did. `_REQUEST_DEADLINE_S` (15 s) fires on a slow LRM while the
                # commit itself may already be durable, and the outcome is
                # readable: `get_commit` is idempotent and answers from LRM's own
                # store. Escalating straight to `recovery_required` threw away an
                # answer that was one call away, and that phase is a one-way trap
                # -- nothing retries it in-process, `cancel()` refuses it, and the
                # record holds the single activation slot until the app restarts
                # (#1687). In the #1682 incident LRM already held
                # `bundle_revision=2` when ServiceHub gave up.
                #
                # Only `safe_error` is retried this way. Every other code is a
                # definite verdict from LRM, so re-asking would just be noise.
                if result.code == "safe_error":
                    proven = await self._prove_commit(record, command)
                    if proven is not None:
                        record = proven
                    else:
                        await self._handle_lrm_failure(record, result, "commit")
                        return
                else:
                    await self._handle_lrm_failure(record, result, "commit")
                    return
            elif not _matches_commit(record, result.payload):
                await self._recover_required(record, "commit_response_identity_mismatch")
                return
            else:
                record = await self._receipt_store.update(record, commit_result=result.payload)
        readback = await self._lrm.get_commit(
            self._lrm_service(),
            correlation_operation_id=record.operation_id,
            idempotency_key=command.idempotency_key,
        )
        if isinstance(readback, LrmPrimaryBundleFailure):
            await self._handle_lrm_failure(record, readback, "commit_readback")
            return
        if not _matches_commit(record, readback.payload):
            await self._recover_required(record, "commit_readback_identity_mismatch")
            return
        if record.commit_readback is None:
            record = await self._receipt_store.update(record, commit_readback=readback.payload)
        if record.activation_result == "binding_only":
            await self._finish_binding_only(record)
            return
        if record.target_product_profile is None:
            await self._recover_required(record, "target_product_profile_missing_after_commit")
            return
        await self._reconcile_runtime_locked(record)

    def request_reconcile(self, operation_id: str) -> None:
        """Wake the one evidence-driven reconcile entry for an activation."""
        name = f"model-binding-activation:{operation_id}"
        if any(task.get_name() == name and not task.done() for task in self._background_tasks):
            return
        task = asyncio.create_task(self._run(operation_id), name=name)
        self._background_tasks.append(task)
        task.add_done_callback(self._background_tasks.remove)

    def _schedule_runtime_infrastructure_preparation(self, operation_id: str) -> None:
        name = f"runtime.infrastructure.prepare:{operation_id}"
        if any(task.get_name() == name and not task.done() for task in self._background_tasks):
            return

        async def prepare() -> None:
            try:
                await self._sandbox.prepare_runtime_infrastructure()
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "Runtime infrastructure preparation wake failed operation_id={} error_type={}",
                    operation_id,
                    type(exc).__name__,
                )

        task = asyncio.create_task(prepare(), name=name)
        self._background_tasks.append(task)
        task.add_done_callback(self._background_tasks.remove)

    async def _start_first_runtime_convergence(
        self, record: ModelBindingActivationReceipt, pending: PendingProfileRecord
    ) -> None:
        """Overlap first Runtime startup with Model Binding activation."""
        try:
            deployment = runtime_deployment_spec(pending)
            persisted = await self._sandbox.persist_runtime_deployment(deployment)
            if persisted != deployment:
                raise ValueError("deployment read-back mismatch")
        except Exception as exc:  # noqa: BLE001
            # The post-commit reconciler remains authoritative and retries this
            # same deterministic deployment after the Binding outcome is proven.
            logger.warning(
                "First Runtime convergence wake failed operation_id={} error_type={}",
                record.operation_id,
                type(exc).__name__,
            )

    async def _reconcile_runtime_locked(self, record: ModelBindingActivationReceipt) -> None:
        if record.state in {"succeeded", "cancelled"}:
            return
        if record.state == "failed":
            return
        if not _is_committed_runtime_transition(record):
            await self._fail(record, "runtime_transition_identity_missing")
            return
        if record.runtime_reconcile_started_at is None:
            record = await self._receipt_store.update(
                record,
                runtime_reconcile_started_at=_timestamp(),
            )
            logger.info(
                "activation runtime reconcile phase=start operation_id={} timeout_s={}",
                record.operation_id,
                self._runtime_reconcile_timeout_s,
            )
        elif _elapsed_seconds(record.runtime_reconcile_started_at) >= self._runtime_reconcile_timeout_s:
            logger.error(
                "activation runtime reconcile phase=deadline event=exhausted "
                "operation_id={}",
                record.operation_id,
            )
            await self._fail_runtime_transition(record, "native_runtime_unavailable")
            return
        desired_profile = record.target_product_profile
        desired_revision = _desired_profile_revision(record)
        if desired_profile is None or desired_revision is None or record.commit_readback is None:
            await self._fail(record, "runtime_transition_identity_missing")
            return
        try:
            active = await self._capability.profile_store.get_active()
            pending = await self._capability.profile_store.get_pending()
        except ProfileStoreCorruptionError:
            await self._fail(record, "profile_store_corrupt")
            return

        try:
            current_profile = self._capability.product_profile_catalog.load(desired_profile)
        except ProductProfileTransientLoadError:
            await self._recover_required(record, "runtime_profile_temporarily_unreadable")
            return
        except ProductProfileLoadError:
            if pending is not None and pending.operation_id == record.operation_id:
                try:
                    await self._capability.profile_store.discard_pending(
                        operation_id=record.operation_id,
                        expected_target_revision=pending.snapshot.profile_revision,
                    )
                except (ProfileOperationConflict, ProfileRevisionConflict, ProfileStoreCorruptionError):
                    await self._recover_required(record, "unreadable_profile_pending_cleanup_failed")
                    return
            await self._fail(record, "runtime_profile_unreadable")
            return
        if (
            pending is None
            and active is not None
            and _active_matches_desired(record, active)
            and active.product_profile_digest == current_profile.artifact_digest
        ):
            deployment = runtime_deployment_spec(active, source_operation_id=record.operation_id)
            observed, record = await self._observe_runtime_instance(record, deployment)
            if observed is None:
                return
            if _runtime_evidence_ready(observed, deployment, active.snapshot.descriptor):
                await self._succeed_runtime_transition(record)
            elif observed.status == "applying":
                self._schedule_runtime_reconcile(record.operation_id)
            elif _runtime_evidence_matches(observed, deployment):
                await self._fail_runtime_transition(
                    record, "runtime_instance_failed", provision_failure_code(observed)
                )
            else:
                await self._fail(record, "runtime_instance_failed")
            return
        committed_target = ModelBundle.model_validate(
            record.commit_readback.target_bundle.model_dump(mode="json")
        )
        if committed_target.capability_contract_version != 1:
            await self._fail(record, "runtime_profile_incompatible")
            return
        if pending is not None and (
            pending.operation_id != record.operation_id
            or pending.product_profile_id != desired_profile
            or _bundle_dump(pending.target_bundle) != _bundle_dump(committed_target)
        ):
            await self._fail(record, "runtime_transition_conflict")
            return
        if (
            pending is None
            or not _pending_matches_desired(record, pending)
            or pending.product_profile_digest != current_profile.artifact_digest
        ):
            active_revision = active.snapshot.profile_revision if active is not None else 0
            reason = "pending_profile_missing" if pending is None else "pending_profile_stale"
            try:
                pending = await self._capability.profile_store.restage_pending_for_recovery(
                    current_profile,
                    target_bundle=committed_target,
                    operation_id=record.operation_id,
                    expected_active_revision=active_revision,
                )
                record = await self._receipt_store.update(
                    record,
                    recovery_evidence={
                        "reason": reason,
                        "target_profile_revision": pending.snapshot.profile_revision,
                        "product_profile_digest": pending.product_profile_digest,
                    },
                    error=None,
                )
                desired_revision = pending.snapshot.profile_revision
            except (ProfileOperationConflict, ProfileRevisionConflict, ProfileStoreCorruptionError):
                await self._recover_required(record, "pending_profile_restage_conflict")
                return

        deployment = runtime_deployment_spec(pending)
        try:
            record = await self._ensure_runtime_deployment_persisted(record, deployment)
        except httpx.HTTPStatusError as exc:
            code = (
                "runtime_deployment_conflict"
                if exc.response.status_code == 409
                else "runtime_deployment_unavailable"
            )
            if exc.response.status_code == 409:
                await self._fail(record, code)
            else:
                await self._recover_required(record, code)
                self._schedule_runtime_reconcile(record.operation_id)
            return
        except httpx.RequestError:
            self._schedule_runtime_reconcile(record.operation_id)
            return
        except ValueError:
            await self._fail(record, "runtime_deployment_response_invalid")
            return

        observed, record = await self._observe_runtime_instance(record, deployment)
        if observed is None:
            return
        if _runtime_evidence_ready(observed, deployment, pending.snapshot.descriptor):
            try:
                await self._capability.profile_store.activate_runtime_ready_pending(
                    operation_id=record.operation_id,
                    expected_target_revision=desired_revision,
                    expected_product_profile=desired_profile,
                    committed_primary_bundle=_committed_bundle(record.commit_readback),
                )
            except (ProfileOperationConflict, ProfileRevisionConflict, ProfileStoreCorruptionError):
                await self._fail(record, "runtime_transition_conflict")
                return
            await self._succeed_runtime_transition(record)
            return
        if observed.status == "applying" and _runtime_evidence_matches(observed, deployment):
            self._schedule_runtime_reconcile(record.operation_id)
            return
        if observed.status == "failed" and _runtime_evidence_matches(observed, deployment):
            reason = provision_failure_code(observed)
            if reason is not None or (
                observed.error is not None and observed.error.code == "native_runtime_unavailable"
            ):
                # A listed refusal word is as terminal as the generic code: it needs the user, not a re-poll.
                await self._fail_runtime_transition(record, "native_runtime_unavailable", reason)
                return
            self._schedule_runtime_reconcile(record.operation_id)
            return
        await self._fail(record, "runtime_transition_conflict")

    async def _ensure_runtime_deployment_persisted(
        self,
        record: ModelBindingActivationReceipt,
        deployment: RuntimeDeploymentSpec,
    ) -> ModelBindingActivationReceipt:
        expected_fingerprint = _runtime_deployment_fingerprint(deployment)
        if record.runtime_deployment_fingerprint == expected_fingerprint:
            logger.debug(
                "activation runtime deployment phase=persist event=confirmed "
                "operation_id={} source=receipt",
                record.operation_id,
            )
            return record
        started = time.monotonic()
        try:
            existing = await self._sandbox.get_runtime_deployment()
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code != 404:
                raise
        else:
            if existing == deployment:
                logger.info(
                    "activation runtime deployment phase=persist event=confirmed "
                    "operation_id={} source=readback elapsed_ms={}",
                    record.operation_id,
                    round((time.monotonic() - started) * 1000),
                )
                return await self._receipt_store.update(
                    record,
                    runtime_deployment_fingerprint=expected_fingerprint,
                )
        persisted = await self._sandbox.persist_runtime_deployment(deployment)
        if persisted != deployment:
            raise ValueError("deployment read-back mismatch")
        logger.info(
            "activation runtime deployment phase=persist event=confirmed "
            "operation_id={} source=write elapsed_ms={}",
            record.operation_id,
            round((time.monotonic() - started) * 1000),
        )
        return await self._receipt_store.update(
            record,
            runtime_deployment_fingerprint=expected_fingerprint,
        )

    async def _observe_runtime_instance(
        self,
        record: ModelBindingActivationReceipt,
        deployment: RuntimeDeploymentSpec,
    ) -> tuple[
        RuntimeInstanceEvidence1 | RuntimeInstanceEvidence2 | RuntimeInstanceEvidence3 | None,
        ModelBindingActivationReceipt,
    ]:
        """Observe Runtime evidence without mutating the durable deployment."""
        observed = await self._get_runtime_instance(record)
        if observed is None:
            return None, record
        logger.info(
            "activation runtime evidence phase=observe event=result "
            "operation_id={} status={} instance={} attempt={}",
            record.operation_id,
            observed.status,
            observed.runtime_instance_id,
            observed.launch_attempt_id,
        )
        return observed, record

    async def _get_runtime_instance(
        self, record: ModelBindingActivationReceipt
    ) -> RuntimeInstanceEvidence1 | RuntimeInstanceEvidence2 | RuntimeInstanceEvidence3 | None:
        try:
            return (await self._sandbox.get_runtime_instance_evidence()).root
        except httpx.RequestError:
            self._schedule_runtime_reconcile(record.operation_id)
            return None
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code == 503:
                self._schedule_runtime_reconcile(record.operation_id)
                return None
            await self._fail(record, "runtime_instance_unavailable")
            return None
        except ValueError:
            await self._fail(record, "runtime_instance_unavailable")
            return None

    async def _succeed_runtime_transition(self, record: ModelBindingActivationReceipt) -> None:
        logger.info(
            "activation runtime reconcile phase=complete event=ready "
            "operation_id={}",
            record.operation_id,
        )
        await self._receipt_store.update(
            record,
            state="succeeded",
            pct=100,
            finished_at=_timestamp(),
            error=None,
        )

    def _schedule_runtime_reconcile(self, operation_id: str) -> None:
        existing = self._runtime_reconcile_delays.get(operation_id)
        if existing is not None and not existing.done():
            return

        async def delayed() -> None:
            try:
                await asyncio.sleep(self._runtime_reconcile_interval_s)
                self.request_reconcile(operation_id)
            finally:
                self._runtime_reconcile_delays.pop(operation_id, None)

        task = asyncio.create_task(delayed(), name=f"runtime-reconcile-delay:{operation_id}")
        self._runtime_reconcile_delays[operation_id] = task
        self._background_tasks.append(task)
        task.add_done_callback(self._background_tasks.remove)

    async def _finish_binding_only(self, record: ModelBindingActivationReceipt) -> None:
        active = await self._capability.profile_store.get_active()
        if active is None or record.commit_readback is None:
            await self._fail(record, "binding_only_active_profile_missing")
            return
        try:
            await self._capability.profile_store.update_active_primary_bundle(
                expected_profile_revision=active.snapshot.profile_revision,
                expected_product_profile=active.product_profile_id,
                committed_primary_bundle=_committed_bundle(record.commit_readback),
            )
        except (ProfileOperationConflict, ProfileRevisionConflict, ProfileStoreCorruptionError):
            await self._fail(record, "binding_only_profile_conflict")
            return
        await self._receipt_store.update(
            record,
            state="succeeded",
            pct=100,
            finished_at=_timestamp(),
        )

    async def _prove_commit(
        self, record: ModelBindingActivationReceipt, command: PrimaryBundleCommitRequest
    ) -> ModelBindingActivationReceipt | None:
        """Read back whether a commit whose response was lost actually landed.

        Returns the updated record when the commit is proven, or ``None`` when it
        cannot be proven -- in which case the caller escalates exactly as before,
        so this can only ever turn an unrecoverable outcome into a recoverable one.

        `get_commit` is safe to call here: it is a read of LRM's own idempotency
        evidence keyed by the same `idempotency_key`, so it neither commits
        anything nor mutates the pending Bundle. A `404` (never committed) and a
        transport failure both come back as a failure result and both mean "not
        proven", which is the honest answer.
        """
        readback = await self._lrm.get_commit(
            self._lrm_service(),
            correlation_operation_id=record.operation_id,
            idempotency_key=command.idempotency_key,
        )
        if isinstance(readback, LrmPrimaryBundleFailure) or not _matches_commit(record, readback.payload):
            logger.warning(
                "[activation-debug] commit not proven after safe_error operation_id={} readback={}",
                record.operation_id,
                type(readback).__name__,
            )
            return None
        logger.info(
            "activation commit proven by readback after safe_error operation_id={}",
            record.operation_id,
        )
        return await self._receipt_store.update(record, commit_result=readback.payload)

    async def _handle_lrm_failure(
        self, record: ModelBindingActivationReceipt, failure: LrmPrimaryBundleFailure, action: str
    ) -> ModelBindingActivationReceipt:
        logger.error(
            "[activation-debug] LRM failure: action={} code={} failure={} operation_id={}",
            action,
            getattr(failure, "code", "?"),
            repr(failure),
            record.operation_id,
        )
        if failure.code in {
            "preparation_recovery_required",
            "pending_bundle_recovery_required",
            "preparation_identity_mismatch",
            "primary_bundle_prepare_in_progress",
        }:
            # A pre-commit failure never mutated the active Profile: the LRM
            # still owns a discardable pending Bundle. Terminate the activation
            # instead of pinning the one recovery slot forever, so a fresh
            # activation can start. After commit, the
            # outcome is genuinely unknown and still needs operator recovery.
            if record.commit_command is None:
                desired_revision = _desired_profile_revision(record)
                if desired_revision is not None:
                    try:
                        await self._capability.profile_store.discard_pending(
                            operation_id=record.operation_id,
                            expected_target_revision=desired_revision,
                        )
                    except (ProfileStoreCorruptionError, RuntimeError):
                        return await self._recover_required(record, f"{action}_{failure.code}", failure.code)
                return await self._fail(record, failure.code)
            return await self._recover_required(record, f"{action}_{failure.code}", failure.code)
        if failure.code == "safe_error":
            return await self._recover_required(record, f"{action}_outcome_unknown")
        error = activation_failure_error(failure.code)
        if failure.code == "lrm_bundle_revision_conflict":
            if failure.expected_bundle_revision is None or failure.actual_bundle_revision is None:
                return await self._recover_required(record, f"{action}_revision_conflict_incomplete")
            error["expected_bundle_revision"] = failure.expected_bundle_revision
            error["actual_bundle_revision"] = failure.actual_bundle_revision
        desired_revision = _desired_profile_revision(record)
        if desired_revision is not None:
            await self._capability.profile_store.discard_pending(
                operation_id=record.operation_id,
                expected_target_revision=desired_revision,
            )
        return await self._fail(record, failure.code, error)

    async def _recover_required(
        self, record: ModelBindingActivationReceipt, reason: str, code: str = "safe_error"
    ) -> ModelBindingActivationReceipt:
        logger.warning(
            "activation recovery_required operation_id={} reason={} code={}",
            record.operation_id,
            reason,
            code,
        )
        recovery_evidence = dict(record.recovery_evidence or {})
        recovery_evidence["reason"] = reason
        return await self._receipt_store.update(
            record,
            state="running",
            error={"code": code, "message": "Model Binding Activation requires recovery."},
            recovery_evidence=recovery_evidence,
        )

    async def _fail(
        self, record: ModelBindingActivationReceipt, code: str, error: dict[str, object] | None = None
    ) -> ModelBindingActivationReceipt:
        logger.error(
            "activation failed operation_id={} code={}",
            record.operation_id,
            code,
        )
        await self._release_pending_if_owned(record)
        return await self._receipt_store.update(
            record,
            state="failed",
            pct=100,
            finished_at=_timestamp(),
            error=error or activation_failure_error(code),
        )

    async def _fail_runtime_transition(
        self, record: ModelBindingActivationReceipt, code: str, reason: str | None = None
    ) -> ModelBindingActivationReceipt:
        pending = await self._capability.profile_store.get_pending()
        active = await self._capability.profile_store.get_active()
        discard_pending = _pending_matches_desired(record, pending)
        if discard_pending:
            deployment = runtime_deployment_spec(pending)
        elif _active_matches_desired(record, active):
            deployment = runtime_deployment_spec(active, source_operation_id=record.operation_id)
        else:
            return await self._fail(record, "runtime_transition_conflict")
        try:
            await self._sandbox.revoke_runtime_deployment(deployment)
            if discard_pending:
                await self._capability.profile_store.discard_pending(
                    operation_id=record.operation_id,
                    expected_target_revision=record.target_profile_revision,
                )
        except Exception as exc:  # noqa: BLE001
            logger.error(
                "activation runtime failure cleanup incomplete operation_id={} error_type={}",
                record.operation_id,
                type(exc).__name__,
            )
            return await self._recover_required(record, "runtime_failure_cleanup_incomplete")
        failure = provision_failure_error(reason)
        if failure is not None:
            logger.warning("activation runtime failure operation_id={} code={} reason={}", record.operation_id, code, reason)
        return await self._fail(record, code, failure)

    async def _cancelled(self, record: ModelBindingActivationReceipt) -> ModelBindingActivationReceipt:
        logger.info("activation cancelled operation_id={}", record.operation_id)
        await self._release_pending_if_owned(record)
        return await self._receipt_store.update(
            record, state="cancelled", pct=100, finished_at=_timestamp(), error=None
        )

    async def _release_pending_if_owned(self, record: ModelBindingActivationReceipt) -> None:
        """Release the current pending Profile record when it belongs to `record`.

        `_fail()` and `_cancelled()` are the two terminal-state writer helpers that
        every failure/cancellation call site already funnels through (~20 `_fail(...)`
        sites plus the cancellation path), so this is the one seam that guarantees a
        failed or cancelled activation never permanently orphans the pending Profile
        marker it staged (#2615) -- regardless of whether the specific call site
        remembered to discard it itself.

        Some callers (e.g. the `ProductProfileLoadError` branch in
        `_reconcile_runtime_locked`, `_handle_lrm_failure`'s pre-commit branches, and
        `cancel()`'s abort path) already discard the matching pending record
        themselves before calling `_fail()`/`_cancelled()`. In that case
        `get_pending()` correctly returns `None` (or a record belonging to a
        different operation) by the time we get here -- that is the normal,
        already-clean case, not evidence of a problem, so it is a no-op rather than
        a second discard.
        """
        try:
            pending = await self._capability.profile_store.get_pending()
        except ProfileStoreCorruptionError:
            return
        if not _pending_matches_desired(record, pending):
            return
        assert pending is not None
        try:
            await self._capability.profile_store.discard_pending(
                operation_id=record.operation_id,
                expected_target_revision=pending.snapshot.profile_revision,
            )
        except (ProfileOperationConflict, ProfileRevisionConflict, ProfileStoreCorruptionError):
            # Someone else already raced us to release/replace this pending
            # record -- treat as already-released rather than a new failure.
            return

    def _operation_lock(self, operation_id: str) -> asyncio.Lock:
        return self._operation_locks.setdefault(operation_id, asyncio.Lock())

    def _lrm_service(self) -> ServiceInfo:
        service = self._registry.get_by_prefix("/llm-router")
        if service is None or service.state != "running":
            raise ModelBindingActivationStartError("safe_error")
        return service


class ModelBindingActivationStartError(RuntimeError):
    def __init__(self, code: str, actual_revision: int | None = None) -> None:
        super().__init__(code)
        self.code = code
        self.actual_revision = actual_revision


def _prepare_failed_error(readback: PrimaryBundleLifecycleReadback) -> dict[str, object]:
    """Terminal prepare failure as a public ``safe_error``, keeping LRM's classified reason."""
    error: dict[str, object] = {
        "code": "safe_error",
        "message": readback.message or activation_failure_message("safe_error"),
    }
    if readback.reason_code is not None:
        error["reason_code"] = readback.reason_code.value
    return error


def _prepare_command(record: ModelBindingActivationReceipt) -> dict[str, object]:
    body = record.app_request.root.model_dump(mode="json", exclude_none=True)
    return {
        **body,
        "correlation_operation_id": record.operation_id,
    }


def _is_committed_runtime_transition(record: ModelBindingActivationReceipt) -> bool:
    return is_retryable_activation(record)


def _is_applying_runtime_transition(record: ModelBindingActivationReceipt) -> bool:
    return record.state == "running" and _is_committed_runtime_transition(record)


def _desired_profile_revision(record: ModelBindingActivationReceipt) -> int | None:
    recovery_target = runtime_recovery_target(record)
    if recovery_target is not None:
        return recovery_target.profile_revision
    return record.target_profile_revision


def _runtime_evidence_matches(
    evidence: RuntimeInstanceEvidence1 | RuntimeInstanceEvidence2 | RuntimeInstanceEvidence3,
    deployment: RuntimeDeploymentSpec,
) -> bool:
    return (
        evidence.deployment_id == deployment.deployment_id
        and evidence.product_profile_id.value == deployment.product_profile_id.value
        and evidence.product_profile_digest == deployment.product_profile_digest
        and evidence.profile_revision == deployment.profile_revision
        and evidence.desired_fingerprint == _runtime_deployment_fingerprint(deployment)
    )


def _runtime_deployment_fingerprint(deployment: RuntimeDeploymentSpec) -> str:
    payload = json.dumps(
        deployment.model_dump(mode="json"),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def _runtime_evidence_ready(
    evidence: RuntimeInstanceEvidence1 | RuntimeInstanceEvidence2 | RuntimeInstanceEvidence3,
    deployment: RuntimeDeploymentSpec,
    descriptor: object,
) -> bool:
    required_sidecars = {
        getattr(sidecar, "value", sidecar)
        for sidecar in getattr(descriptor, "required_sidecars", ())
    }
    classifier_required = "intent-classifier" in required_sidecars
    hdr_required = "hdr-sidecar" in required_sidecars
    return bool(
        evidence.status == "ready"
        and _runtime_evidence_matches(evidence, deployment)
        and evidence.runtime_ready
        and evidence.components.opencode
        and evidence.components.openwork
        and evidence.intent_classifier.mode.value == ("enabled" if classifier_required else "bypass")
        and evidence.hybrid_dr.status.value == ("healthy" if hdr_required else "absent")
    )


def _pending_matches_desired(record: ModelBindingActivationReceipt, pending: object) -> bool:
    snapshot = getattr(pending, "snapshot", None)
    return bool(
        pending is not None
        and getattr(pending, "operation_id", None) == record.operation_id
        and getattr(pending, "product_profile_id", None) == record.target_product_profile
        and getattr(snapshot, "profile_revision", None) == _desired_profile_revision(record)
    )


def _active_matches_desired(record: ModelBindingActivationReceipt, active: object) -> bool:
    snapshot = getattr(active, "snapshot", None)
    primary_bundle = getattr(active, "primary_bundle", None)
    if record.commit_readback is None:
        return False
    committed = _committed_bundle(record.commit_readback)
    return bool(
        active is not None
        and getattr(active, "product_profile_id", None) == record.target_product_profile
        and getattr(snapshot, "profile_revision", None) == _desired_profile_revision(record)
        and primary_bundle == committed
    )


def _committed_bundle(payload: object) -> PrimaryBundleState:
    target = getattr(payload, "target_bundle")
    return PrimaryBundleState.model_validate({
        **target.model_dump(mode="json"),
        "bundle_revision": getattr(payload, "bundle_revision"),
        "state": "ready",
    })


def _matches(record: ModelBindingActivationReceipt, readback: object) -> bool:
    command = record.prepare_command
    return bool(
        command
        and getattr(readback, "correlation_operation_id", None) == record.operation_id
        and getattr(readback, "prepare_operation_id", None) == record.prepare_operation_id
        and getattr(readback, "idempotency_key", None) == record.app_request.root.idempotency_key
        and getattr(readback, "candidate_revision", None) == command["candidate_revision"]
        and getattr(readback, "expected_bundle_revision", None) == command["expected_bundle_revision"]
        and getattr(readback, "bundle_revision", None) == command["expected_bundle_revision"]
        and getattr(readback, "target_bundle", None) is not None
        and getattr(readback, "target_bundle", None).bundle_id == command["target_bundle_id"]
    )


def _matches_prepared_binding(record: ModelBindingActivationReceipt, candidate: object) -> bool:
    return bool(
        getattr(candidate, "prepare_operation_id", None) == record.prepare_operation_id
        and getattr(candidate, "target_bundle_id", None) == record.app_request.root.target_bundle_id
        and getattr(candidate, "candidate_revision", None) == record.app_request.root.candidate_revision
        and getattr(candidate, "expected_binding_revision", None)
        == record.app_request.root.expected_bundle_revision
    )


def _matches_abort(record: ModelBindingActivationReceipt, readback: object, command: dict[str, object]) -> bool:
    prepare_command = record.prepare_command
    prepared_target = (record.prepare_readback or {}).get("target_bundle")
    return bool(
        getattr(readback, "correlation_operation_id", None) == record.operation_id
        and getattr(readback, "prepare_operation_id", None) == record.prepare_operation_id
        and getattr(readback, "idempotency_key", None) == command["idempotency_key"]
        and getattr(readback, "expected_bundle_revision", None) == command["expected_bundle_revision"]
        and getattr(readback, "bundle_revision", None) == command["expected_bundle_revision"]
        and prepare_command is not None
        and getattr(readback, "candidate_revision", None) == prepare_command["candidate_revision"]
        and getattr(readback, "target_bundle", None) is not None
        and _bundle_dump(getattr(readback, "target_bundle")) == prepared_target
        and getattr(readback, "state", None).value == "cancelled"
    )


def _matches_commit(record: ModelBindingActivationReceipt, payload: object) -> bool:
    command = record.commit_command
    prepared_target = (record.prepare_readback or {}).get("target_bundle")
    return bool(
        command
        and getattr(payload, "correlation_operation_id", None) == record.operation_id
        and getattr(payload, "prepare_operation_id", None) == command.prepare_operation_id
        and getattr(payload, "idempotency_key", None) == command.idempotency_key
        and getattr(payload, "target_bundle", None) is not None
        and getattr(payload, "target_bundle", None).bundle_id == command.target_bundle_id
        and _bundle_dump(getattr(payload, "target_bundle", None)) == prepared_target
        and getattr(payload, "candidate_revision", None) == (record.prepare_command or {}).get("candidate_revision")
        and getattr(payload, "expected_bundle_revision", None) == command.expected_bundle_revision
        and getattr(payload, "bundle_revision", None) == command.expected_bundle_revision + 1
        and str(getattr(payload, "state", None)) == "succeeded"
    )


def _stage_command(record: ModelBindingActivationReceipt, target: ModelBundle, expected_active_revision: int) -> dict[str, object]:
    target_payload = target.model_dump(mode="json")
    return {
        "operation_id": record.operation_id,
        "idempotency_key": record.app_request.root.idempotency_key,
        "prepare_operation_id": record.prepare_operation_id,
        "expected_bundle_revision": record.app_request.root.expected_bundle_revision,
        "expected_active_profile_revision": expected_active_revision,
        "target_bundle": target_payload,
        "target_bundle_sha256": _bundle_digest(target),
    }


def _matches_staged_profile(
    record: ModelBindingActivationReceipt, persisted_pending: object, target: ModelBundle, staged_pending: object
) -> bool:
    command = record.stage_command
    return bool(
        command
        and persisted_pending is not None
        and getattr(persisted_pending, "operation_id", None) == record.operation_id
        and getattr(persisted_pending, "target_fingerprint", None) == getattr(staged_pending, "target_fingerprint", None)
        and _bundle_dump(getattr(persisted_pending, "target_bundle", None)) == _bundle_dump(target)
        and command["target_bundle_sha256"] == _bundle_digest(getattr(persisted_pending, "target_bundle", None))
    )


def _bundle_dump(bundle: object) -> dict[str, object] | None:
    if bundle is None:
        return None
    return bundle.model_dump(mode="json")


def _bundle_digest(bundle: object) -> str | None:
    payload = _bundle_dump(bundle)
    if payload is None:
        return None
    return hashlib.sha256(canonical_json_bytes(payload)).hexdigest()


def _timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _elapsed_seconds(timestamp: str) -> float:
    started = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    return max(0.0, (datetime.now(timezone.utc) - started).total_seconds())
