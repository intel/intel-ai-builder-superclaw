"""Public Runtime Deployment adapter for the owner-managed Windows lifecycle."""
from __future__ import annotations

import asyncio
import json
import time
from typing import TYPE_CHECKING

from contracts.runtime_instance_evidence import RuntimeInstanceEvidence
from loguru import logger

from .broker_client.errors import refusal_reason_word
from .native_runtime_evidence import deployment_snapshot, fingerprint, read_supervisor_ready
from .native_supervision import READINESS_LOSS_PROBES, READINESS_LOSS_S
from .runs import (
    KIND_RUNTIME_DEPLOYMENT_ENSURE,
    KIND_RUNTIME_INFRASTRUCTURE_PREPARE,
    RunCancelled,
    RunHandle,
)
from .store import RUNTIME_DEPLOYMENT_CONFIG_KEY

if TYPE_CHECKING:
    from .native_backend import NativeBackendLifecycle


# Post-run misses that no wait can clear. Every other miss is held as `applying` for the HDR loss window.
_TERMINAL_MISSES = frozenset({"run_failed", "broker_roles"})


class NativeEvidencePending(RuntimeError):
    """No instance has been scheduled yet; a deployment wake may still arrive."""


class NativeDeploymentSuperseded(RuntimeError):
    """A newer deployment was committed before this run launched anything."""


class NativeDeployment:
    def __init__(self, lifecycle: NativeBackendLifecycle) -> None:
        self.lifecycle = lifecycle
        self.lock = asyncio.Lock()
        self.run_id: str | None = None
        self.context: dict[str, str] | None = None
        self.deployment: dict[str, object] | None = None
        self.failed = False
        # Stable word of the broker refusal that failed the last run, else None.
        self.failure_code: str | None = None
        self.finished = asyncio.Event()
        self.finished.set()
        self.tasks: set[asyncio.Task[None]] = set()
        self.run_ids: set[str] = set()
        self.follow_ups: set[asyncio.Task[None]] = set()
        # Post-run HDR readiness misses of the current run: (first miss, misses, loss reported).
        self.hdr_unready: tuple[float, int, bool] | None = None
        self._hdr_miss_counted_at: float | None = None
        # Post-run misses of every other prerequisite: (first miss, misses, missing input, loss reported).
        self.prerequisites_unready: tuple[float, int, str, bool] | None = None

    @property
    def refusal(self) -> str | None:
        """The refusal word of the run that has just failed, else ``None``.

        The one record of a refusal: a run that is scheduled again, resumed, stopped or revoked no longer
        has one, so a stale word never reaches a newer run.
        """
        return self.failure_code if self.failed and self.finished.is_set() else None

    async def ensure(self, *, follow_up: bool = False) -> tuple[str, str, str, str, str]:
        owner = self.lifecycle
        if owner._shutdown_requested.is_set():
            raise RuntimeError("native backend shutdown requested")
        deployment = deployment_snapshot(owner._store.get_config(RUNTIME_DEPLOYMENT_CONFIG_KEY))
        desired = fingerprint(deployment)
        async with self.lock:
            # A stop sets the abort before it takes this lock. Decided here, with no await
            # before the clear below, a follow-up can never clear an abort a stop raised.
            if follow_up and (owner._startup_abort.is_set() or owner._shutdown_requested.is_set()):
                raise RuntimeError("native deployment follow-up cancelled by a stop")
            if self.run_id is not None and not self.finished.is_set():
                if self.context is None or self.context["runtime_desired_fingerprint"] != desired:
                    raise RuntimeError("a different runtime deployment is already converging")
                return self.identity()
            if (self.failed and self.run_id is not None and self.context is not None
                    and self.context["runtime_desired_fingerprint"] == desired):
                return self.identity()
            previous_fingerprint = (
                self.context["runtime_desired_fingerprint"] if self.context is not None else None
            )
            if previous_fingerprint is not None and previous_fingerprint != desired:
                owner._startup_abort.clear()
            reuse_context = (self.run_id is not None and self.context is not None
                    and self.context == owner._runtime_launch_context
                    and self.context["runtime_desired_fingerprint"] == desired
                    and owner._owt.is_present() and owner._supervisor_ready()
                    and await owner._healthy() and await owner._connector_healthy()
                    and await owner._hdr_healthy()
                    and not owner._startup_abort.is_set())
            if reuse_context:
                from .native_backend import owner_tiers_fully_provisioned

                if owner._payload_root is None or owner._host_token is None:
                    raise RuntimeError("native owned process state is incomplete")
                verification = asyncio.create_task(asyncio.to_thread(
                    owner._trust_payload, owner._payload_root, phase="reuse"))
                try:
                    await asyncio.shield(verification)
                except asyncio.CancelledError:
                    try:
                        await verification
                    except Exception:
                        pass
                    raise
                if owner._owner_sid is not None and not owner_tiers_fully_provisioned(owner._owner_sid):
                    raise RuntimeError("native tier identities are no longer provisioned")
                owner._raise_if_shutdown_requested()
                if not owner._deployment_still_current():
                    raise RuntimeError("native deployment changed during reuse")
                if (
                    self.context != owner._runtime_launch_context
                    or not owner._broker_roles_complete_and_alive()
                    or not owner._supervisor_ready()
                ):
                    raise RuntimeError("native role generation changed during reuse")
                # Ready without spawning a run, so no worker exit covers this path.
                # Re-checking here is the self-healing cadence: a reaped inspector
                # comes back on the next ensure() instead of staying dead for the
                # whole session.
                owner._schedule_trajectory_inspector(reason="reuse_fast_path")
                return self.identity()
            await self.schedule(deployment, owner._runtime_launch_context_scalars(deployment))
            return self.identity()

    async def schedule(self, deployment: dict[str, object], context: dict[str, str]) -> None:
        """Start one convergence run for ``context``; callers hold ``self.lock``."""
        owner = self.lifecycle
        self.deployment = deployment
        self.context = context
        self.failed = False
        self.failure_code = None
        self.hdr_unready = None
        self.prerequisites_unready = None
        self.finished.clear()
        captured_context = dict(context)
        desired = captured_context["runtime_desired_fingerprint"]

        async def converge(handle: RunHandle) -> None:
            await owner.complete_outstanding_cleanup()
            await owner._ensure_worker(handle, deployment=deployment, launch_context=captured_context)

        async def work(handle: RunHandle) -> None:
            task = asyncio.create_task(converge(handle))
            self.tasks.add(task)
            try:
                handle.raise_if_cancelled()
                await asyncio.shield(task)
                owner._supervision.watch(captured_context)
            except asyncio.CancelledError:
                owner._startup_abort.set()
                try:
                    await task
                except Exception:
                    pass
                self.failed = True
                await owner._owt.clear()
                async with owner._lock:
                    owner._kill_tree()
                raise
            except NativeDeploymentSuperseded as exc:
                # Not a failure: the follow-up queued in `finally` converges on the newer commit.
                self.failed = False
                await owner._owt.clear()
                logger.info("native-deployment: run superseded run_id={} detail={}", handle.run_id, exc)
                raise RunCancelled() from exc
            except BaseException as exc:
                self.failed = True
                self.failure_code = refusal_reason_word(exc)
                await owner._owt.clear()
                if not task.done():
                    owner._startup_abort.set()
                    try:
                        await task
                    except Exception:
                        pass
                # _ensure_worker serializes the process tree and owns its startup unwind.
                raise
            finally:
                self.tasks.discard(task)
                self.finished.set()
                self._follow_committed(desired)

        try:
            self.run_id = await owner._runs.spawn(
                kind=KIND_RUNTIME_DEPLOYMENT_ENSURE, worker=work,
                metadata={"deployment_id": deployment["deployment_id"],
                          "desired_fingerprint": desired,
                          "runtime_instance_id": captured_context["runtime_instance_id"],
                          "launch_attempt_id": captured_context["runtime_launch_attempt_id"]},
            )
            self.run_ids.add(self.run_id)
        except BaseException:
            self.failed = True
            self.finished.set()
            raise

    def _follow_committed(self, converged: str) -> None:
        """Converge on a deployment committed while the run for `converged` held the adapter.

        `ensure` refuses a different deployment while a run is in flight, and the
        activation coordinator reads a persisted deployment back as confirmed rather
        than waking it again. The end of this run is therefore the only point left at
        which the newer deployment can be picked up.
        """
        owner = self.lifecycle
        if owner._shutdown_requested.is_set() or owner._startup_abort.is_set():
            return
        try:
            committed = deployment_snapshot(owner._store.get_config(RUNTIME_DEPLOYMENT_CONFIG_KEY))
        except RuntimeError:
            return
        if fingerprint(committed) == converged:
            return
        if self.failure_code is not None:
            # This start was just refused (a declined UAC prompt, say). Provisioning again for the newer
            # deployment would show the same prompt a second time and make the user wait it out before
            # anything reports the failure, so the newer deployment inherits the refusal until an
            # explicit Retry re-arms it (`NativeBackendLifecycle.rearm_after_provision_refusal`).
            self.deployment = committed
            self.context = owner._runtime_launch_context_scalars(committed)
            logger.info(
                "native-deployment: newer deployment_id={} inherits refusal reason={}",
                committed["deployment_id"], self.failure_code,
            )
            return
        logger.info(
            "native-deployment: run for a superseded deployment finished; "
            "converging on deployment_id={}",
            committed["deployment_id"],
        )
        follow_up = asyncio.get_running_loop().create_task(self._ensure_committed())
        self.follow_ups.add(follow_up)
        follow_up.add_done_callback(self.follow_ups.discard)

    async def _ensure_committed(self) -> None:
        try:
            await self.ensure(follow_up=True)
        except Exception as exc:  # noqa: BLE001 - a follow-up has no caller to raise to
            logger.warning(
                "native-deployment: superseded-run follow-up failed error_type={} detail={}",
                type(exc).__name__,
                exc,
            )

    async def stop(self) -> None:
        owner = self.lifecycle
        owner._startup_abort.set()
        async with self.lock:
            if not self.finished.is_set():
                await self.finished.wait()
            async with owner._lock:
                await owner._owt.clear()
                owner._kill_tree(clear_status=True)
                self.failed = True
                self.failure_code = None

    async def revoke(self, expected: dict[str, object]) -> str:
        owner = self.lifecycle
        async with self.lock:
            result = owner._store.delete_runtime_deployment(expected)
            if result != "deleted":
                return result
            owner._startup_abort.set()
            if not self.finished.is_set():
                await self.finished.wait()
            async with owner._lock:
                await owner._owt.clear()
                owner._kill_tree(clear_status=True)
                self.failed = True
                self.failure_code = None
            return result

    async def resume(self) -> None:
        async with self.lock:
            if self.lifecycle._startup_abort.is_set() and not self.finished.is_set():
                await self.finished.wait()
            self.lifecycle._startup_abort.clear()
            if self.failed or self.lifecycle._has_broker_roles():
                await self.lifecycle._owt.clear()
                async with self.lifecycle._lock:
                    self.lifecycle._kill_tree(clear_status=True)
            self.failed = False
            self.failure_code = None
            self.lifecycle._supervision.reset()

    async def drain(self) -> None:
        for run_id in tuple(self.run_ids):
            await self.lifecycle._runs.wait_for_run(run_id)

    def _hdr_loss_sustained(self, observed_at: float | None = None) -> bool:
        """Count one post-run HDR readiness miss; True once it outlasts the supervisor's loss window.

        `observed_at` stamps a cached observation: reading the same one again is not a new probe.
        """
        now = time.monotonic()
        since, misses, reported = self.hdr_unready or (now, 0, False)
        fresh = observed_at is None or observed_at != self._hdr_miss_counted_at
        if fresh:
            misses += 1
            self._hdr_miss_counted_at = observed_at
        sustained = misses >= READINESS_LOSS_PROBES and now - since >= READINESS_LOSS_S
        if fresh and misses == 1:
            logger.warning(
                "native-deployment: phase=evidence event=hdr_not_ready run_id={} "
                "loss_after_probes={} loss_after_s={:.0f}",
                self.run_id, READINESS_LOSS_PROBES, READINESS_LOSS_S,
            )
        elif sustained and not reported:
            logger.error(
                "native-deployment: phase=evidence event=hdr_readiness_lost run_id={} misses={} "
                "duration_ms={}", self.run_id, misses, round((now - since) * 1000),
            )
        self.hdr_unready = (since, misses, reported or sustained)
        return sustained

    def hdr_ready_again(self) -> None:
        if self.hdr_unready is None:
            return
        since, misses, _reported = self.hdr_unready
        self.hdr_unready = None
        logger.info(
            "native-deployment: phase=evidence event=hdr_ready_again run_id={} misses={} "
            "duration_ms={}", self.run_id, misses, round((time.monotonic() - since) * 1000),
        )

    def _prerequisite_loss_sustained(self, missing: str) -> bool:
        """Count one post-run miss of a non-HDR prerequisite; True once it outlasts HDR's loss window.

        A terminal miss is sustained at once. One window logs when it opens, when its loss is first
        reported (again only if a terminal input then appears) and when it closes, however often the
        missing input changes in between.
        """
        now = time.monotonic()
        since, misses, previous, reported = self.prerequisites_unready or (now, 0, None, False)
        misses += 1
        sustained = missing in _TERMINAL_MISSES or (
            misses >= READINESS_LOSS_PROBES and now - since >= READINESS_LOSS_S)
        if sustained and (not reported or (missing in _TERMINAL_MISSES and previous not in _TERMINAL_MISSES)):
            logger.error(
                "native-deployment: phase=evidence event=prerequisite_lost run_id={} input={} misses={} "
                "duration_ms={}", self.run_id, missing, misses, round((now - since) * 1000),
            )
        elif previous is None:
            logger.warning(
                "native-deployment: phase=evidence event=prerequisite_not_ready run_id={} input={} "
                "loss_after_probes={} loss_after_s={:.0f}",
                self.run_id, missing, READINESS_LOSS_PROBES, READINESS_LOSS_S,
            )
        elif missing != previous:
            logger.debug(
                "native-deployment: phase=evidence event=prerequisite_not_ready run_id={} input={} misses={}",
                self.run_id, missing, misses,
            )
        self.prerequisites_unready = (since, misses, missing, reported or sustained)
        return sustained

    def _prerequisites_ready_again(self) -> None:
        if self.prerequisites_unready is None:
            return
        since, misses, missing, _reported = self.prerequisites_unready
        self.prerequisites_unready = None
        logger.info(
            "native-deployment: phase=evidence event=prerequisite_ready_again run_id={} input={} misses={} "
            "duration_ms={}", self.run_id, missing, misses, round((time.monotonic() - since) * 1000),
        )

    def _missing_local(self, ready: dict[str, object] | None) -> str | None:
        """The first unmet prerequisite this process can check without a probe, terminal ones first."""
        if self.failed:
            return "run_failed"
        if not self.finished.is_set():
            return "run_in_flight"
        if not self.lifecycle._broker_roles_complete_and_alive():
            return "broker_roles"
        return "supervisor_ready" if ready is None else None

    def identity(self) -> tuple[str, str, str, str, str]:
        if self.run_id is None or self.context is None or self.deployment is None:
            raise RuntimeError("native deployment has not been scheduled")
        return (self.run_id, str(self.deployment["deployment_id"]),
                self.context["runtime_desired_fingerprint"], self.context["runtime_instance_id"],
                self.context["runtime_launch_attempt_id"])

    async def prepare(self) -> str:
        owner = self.lifecycle
        owner._raise_if_shutdown_requested()
        async with self.lock:
            active = owner._store.find_active_run(kind=KIND_RUNTIME_INFRASTRUCTURE_PREPARE)
            if active:
                return active["run_id"]

            async def work(handle: RunHandle) -> None:
                from .native_backend import resolve_bin_dir

                handle.raise_if_cancelled()
                binary = resolve_bin_dir(getattr(owner._cfg, "resources_dir", None))
                if binary is None:
                    raise RuntimeError("native payload unavailable")
                task = asyncio.create_task(asyncio.to_thread(owner._trust_payload, binary, phase="setup"))
                try:
                    await asyncio.shield(task)
                except asyncio.CancelledError:
                    try:
                        await task
                    except Exception:
                        pass
                    raise
                handle.raise_if_cancelled()
                owner._raise_if_shutdown_requested()
                handle.done()

            run_id = await owner._runs.spawn(kind=KIND_RUNTIME_INFRASTRUCTURE_PREPARE, worker=work)
            self.run_ids.add(run_id)
            return run_id

    async def evidence(self) -> RuntimeInstanceEvidence:
        return await self._evidence(observe_hdr=False)

    async def readiness_evidence(self) -> RuntimeInstanceEvidence:
        """Read-only projection may use a fresh, context-bound HDR observation.

        Missing/expired observations schedule one bounded async refresh and are
        applying, not failed. Public instance evidence and ensure never use this
        path: their HDR verification remains fresh on every call.
        """
        return await self._evidence(observe_hdr=True)

    def _settled_supervisor_ready(self, context: dict[str, str] | None) -> dict[str, object] | None:
        """The Supervisor's ready evidence, read only while no start-up run is in flight.

        While a run is in flight its Supervisor replaces this file by rename, and on Windows
        that rename fails, ending its start-up, if the file is open here at that moment. A run
        can start during any await of an observation, so every read checks again. An in-flight
        run is never eligible, so leaving the file closed changes no answer.
        """
        if not self.finished.is_set():
            return None
        return read_supervisor_ready(self.lifecycle._runtime_evidence_path, context)

    async def _evidence(self, *, observe_hdr: bool) -> RuntimeInstanceEvidence:
        owner = self.lifecycle
        if self.deployment is None or self.context is None:
            raise NativeEvidencePending("no native deployment is scheduled")
        captured_context = dict(self.context)
        captured_run = self.run_id
        current = deployment_snapshot(owner._store.get_config(RUNTIME_DEPLOYMENT_CONFIG_KEY))
        if fingerprint(current) != self.context["runtime_desired_fingerprint"]:
            # The tracked instance converges on an older deployment than the one now
            # committed. That is the normal boot ordering -- `main.py` resumes the
            # previously committed deployment before the capability reheal PUTs the new
            # one -- so the in-flight run finishing is what lets the new deployment
            # converge. Reporting this as a hard inconsistency made the handler answer
            # 409, which the activation coordinator treats as terminal, failing the
            # activation ~600ms into a 600s reconcile budget.
            raise NativeEvidencePending(
                "native instance belongs to a superseded deployment"
            )
        identity = {
            "schema_version": 1,
            **{key: self.deployment[key] for key in ("deployment_id", "product_profile_id", "product_profile_digest", "profile_revision")},
            "desired_fingerprint": self.context["runtime_desired_fingerprint"],
            "runtime_instance_id": self.context["runtime_instance_id"],
            "launch_attempt_id": self.context["runtime_launch_attempt_id"],
        }
        ready = self._settled_supervisor_ready(self.context)
        missing = self._missing_local(ready)
        if missing is None and not await owner._healthy():
            missing = "openwork_health"
        if missing is None and not await owner._connector_healthy():
            missing = "connector_health"
        hdr_health = False
        observed_at: float | None = None
        if missing is None:
            if observe_hdr:
                # Evaluate age/context after the awaited probes, not before them.
                # Re-read the local prerequisites too: a role or receipt may have
                # disappeared while OpenWork/Connector were answering.
                ready = self._settled_supervisor_ready(self.context)
                missing = self._missing_local(ready)
                hdr_health = owner._hdr_status_health() if missing is None else False
                observation = owner._hdr_health_observation
                observed_at = observation[1] if observation is not None else None
            else:
                hdr_health = await owner._hdr_healthy()
        if missing is None:
            final_ready = self._settled_supervisor_ready(captured_context)
            missing = self._missing_local(final_ready)
            if missing is None and (self.context != captured_context
                                    or owner._runtime_launch_context != captured_context):
                missing = "launch_context"
            if final_ready is not None:
                ready = final_ready
        if missing is None and not owner._owt.is_present():
            missing = "owt"
        if missing not in (None, *_TERMINAL_MISSES):
            # A role that exited while a probe was waiting is why that probe missed.
            missing = self._missing_local(ready) or missing
        # Settle the observation before it touches the loss windows below: a read that began under
        # an older run must not count against, or log as, the run that replaced it.
        if self.context != captured_context or self.run_id != captured_run:
            # Torn read: a concurrent ensure() re-pointed the adapter mid-observation.
            # The next poll sees a settled pair, so this is retriable, not terminal.
            raise NativeEvidencePending(
                "native instance changed during evidence observation"
            )
        if owner._startup_abort.is_set() or owner._shutdown_requested.is_set():
            raise RuntimeError("native instance is stopping")
        current_after = deployment_snapshot(owner._store.get_config(RUNTIME_DEPLOYMENT_CONFIG_KEY))
        if fingerprint(current_after) != captured_context["runtime_desired_fingerprint"]:
            # The committed deployment moved while we were reading. Same reasoning as
            # the superseded-deployment case above: retriable, not a hard conflict.
            raise NativeEvidencePending(
                "native deployment changed during evidence observation"
            )
        if missing is None:
            self._prerequisites_ready_again()
        if missing is None and hdr_health is True:
            self.hdr_ready_again()
            result = {**ready, "backend": "native"}
        elif missing is None and hdr_health is None:
            result = {**identity, "status": "applying"}
        elif missing is None and not self._hdr_loss_sustained(observed_at):
            # Everything but HDR is ready. A /readyz miss is usually HDR waiting on Connector or
            # LRM (503), which the supervisor does not count as loss either; failing here made one
            # miss after the run finished revoke the runtime (#3658).
            result = {**identity, "status": "applying"}
        elif missing not in (None, "run_in_flight") and not self._prerequisite_loss_sustained(missing):
            # A probe timing out or an evidence read racing its writer clears on the next poll;
            # failing here failed a Runtime that was up (#3936).
            result = {**identity, "status": "applying"}
        elif self.failed or (self.finished.is_set() and self.run_id is not None):
            result = {**identity, "status": "failed", "error": owner._supervision.evidence_error() or {
                # The refusal word replaces the generic code; the message stays generic because
                # ServiceHub owns the user-facing text for each word.
                "code": self.failure_code or "native_runtime_unavailable",
                "message": "Native Runtime startup failed or is no longer ready."}}
        else:
            result = {**identity, "status": "applying"}
        return RuntimeInstanceEvidence.model_validate_json(json.dumps(result), strict=True)