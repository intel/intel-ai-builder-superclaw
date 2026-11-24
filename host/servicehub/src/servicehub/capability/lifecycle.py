"""Owned dependencies for the dark capability lifecycle."""

from __future__ import annotations

import asyncio
import re
import uuid
from contextlib import suppress
from pathlib import Path
from typing import Callable

from contracts.model_binding_activation_request import ModelBindingActivationRequest

from servicehub.adapters.lrm_bundle_client import (
    LrmBundleCapabilityResult,
    LrmBundleClient,
    LrmCredentialSupplier,
)
from servicehub.adapters.lrm_primary_bundle_client import LrmPrimaryBundleClient
from servicehub.adapters.http_restricted_sandbox_lifecycle_client import HttpRestrictedSandboxLifecycleClient
from servicehub.adapters.restricted_sandbox_lifecycle_client import (
    RestrictedSandboxLifecycleClient,
    UnavailableRestrictedSandboxLifecycleClient,
)
from loguru import logger

from servicehub.capability.product_profile_catalog import (
    ProductProfileCatalog,
    ProductProfileLoadError,
)
from servicehub.capability.profile_store import ProfileRecord, ProfileStore, ProfileStoreCorruptionError, runtime_deployment_spec
from servicehub.model_binding_activation.coordinator import (
    ModelBindingActivationCoordinator,
    _runtime_evidence_matches,
    _runtime_evidence_ready,
)
from servicehub.model_binding_activation.receipt import ModelBindingActivationReceiptStore
from servicehub.model_binding_activation.runtime_provision_failure import provision_failure_code


_SECRET_RE = re.compile(
    r"(?i)(Bearer\s+\S+|sk-[A-Za-z0-9_\-]{16,}|owt_[A-Za-z0-9_\-]{16,}|tvly-[A-Za-z0-9_\-]{16,})"
)


def _redact_exc_msg(exc: BaseException, limit: int = 200) -> str:
    """Return ``str(exc)`` with known secrets stripped, truncated to ``limit`` chars."""
    msg = _SECRET_RE.sub("<redacted>", str(exc))
    if len(msg) > limit:
        msg = msg[:limit] + f"…<truncated,total={len(str(exc))}>"
    return msg


def _hardware_evidence_degraded(capability: object) -> bool:
    """LRM's hardware reading is incomplete, so its verdict may still change this session."""
    if "hardware_evidence_unknown" in getattr(capability, "reasons", ()):
        return True
    hardware = getattr(capability, "hardware", None)
    return bool(getattr(hardware, "detection_errors", ()))


class CapabilityLifecycle:
    """Own capability dependencies without performing startup capability work."""

    def __init__(
        self,
        *,
        profile_store: ProfileStore,
        lrm_bundle_client: LrmBundleClient,
        product_profile_catalog: ProductProfileCatalog | None = None,
        activation_receipt_store: ModelBindingActivationReceiptStore | None = None,
        lrm_primary_bundle_client: LrmPrimaryBundleClient | None = None,
        restricted_sandbox_lifecycle_client: RestrictedSandboxLifecycleClient | None = None,
    ) -> None:
        self.profile_store = profile_store
        self.lrm_bundle_client = lrm_bundle_client
        self.product_profile_catalog = product_profile_catalog or ProductProfileCatalog()
        self.activation_receipt_store = activation_receipt_store or ModelBindingActivationReceiptStore(profile_store.data_dir)
        self.lrm_primary_bundle_client = lrm_primary_bundle_client or LrmPrimaryBundleClient()
        self.restricted_sandbox_lifecycle_client = (
            restricted_sandbox_lifecycle_client or UnavailableRestrictedSandboxLifecycleClient()
        )
        self.model_binding_activation_coordinator: ModelBindingActivationCoordinator | None = None
        self._registry: object | None = None
        self._closed = False
        self._close_task: asyncio.Task[None] | None = None
        self._lite_bootstrap_task: asyncio.Task[None] | None = None
        self._lite_admission_task: asyncio.Task[None] | None = None
        self._lite_bootstrap_failed = False
        # The sandbox refusal word behind a failed Lite bootstrap, when the evidence names one.
        self._lite_bootstrap_failure_reason: str | None = None

    @classmethod
    def create(cls, data_dir: Path) -> CapabilityLifecycle:
        return cls(
            profile_store=ProfileStore(data_dir),
            lrm_bundle_client=LrmBundleClient(),
            product_profile_catalog=ProductProfileCatalog(),
            activation_receipt_store=ModelBindingActivationReceiptStore(data_dir),
            lrm_primary_bundle_client=LrmPrimaryBundleClient(),
            restricted_sandbox_lifecycle_client=HttpRestrictedSandboxLifecycleClient(
                base_url="http://127.0.0.1:18821"
            ),
        )

    async def aclose(self) -> None:
        if self._closed:
            return
        task = self._close_task
        if task is None:
            task = asyncio.create_task(self._close_clients())
            self._close_task = task
        try:
            await asyncio.shield(task)
        except BaseException:
            if task.done():
                try:
                    task.result()
                except BaseException:
                    if self._close_task is task:
                        self._close_task = None
                else:
                    self._closed = True
            raise
        self._closed = True

    async def _close_clients(self) -> None:
        if self._lite_bootstrap_task is not None:
            self._lite_bootstrap_task.cancel()
            with suppress(asyncio.CancelledError):
                await self._lite_bootstrap_task
        if self._lite_admission_task is not None:
            self._lite_admission_task.cancel()
            with suppress(asyncio.CancelledError):
                await self._lite_admission_task
        if self.model_binding_activation_coordinator is not None:
            await self.model_binding_activation_coordinator.aclose()
        await self.restricted_sandbox_lifecycle_client.aclose()
        await self.lrm_primary_bundle_client.aclose()
        await self.lrm_bundle_client.aclose()

    def wire_model_binding_activation_coordinator(
        self,
        *,
        registry: object,
        background_tasks: list[asyncio.Task[None]],
        sandbox_credential_supplier: Callable[[], str | None],
        lrm_credential_supplier: LrmCredentialSupplier | None = None,
    ) -> None:
        if self.model_binding_activation_coordinator is not None:
            return
        self._registry = registry
        if isinstance(
            self.restricted_sandbox_lifecycle_client,
            HttpRestrictedSandboxLifecycleClient,
        ):
            self.restricted_sandbox_lifecycle_client.set_credential_supplier(
                sandbox_credential_supplier
            )
        if lrm_credential_supplier is not None:
            if isinstance(self.lrm_bundle_client, LrmBundleClient):
                self.lrm_bundle_client.set_credential_supplier(lrm_credential_supplier)
            if isinstance(self.lrm_primary_bundle_client, LrmPrimaryBundleClient):
                self.lrm_primary_bundle_client.set_credential_supplier(lrm_credential_supplier)
        self.model_binding_activation_coordinator = ModelBindingActivationCoordinator(
            capability=self,
            receipt_store=self.activation_receipt_store,
            lrm_primary_bundle_client=self.lrm_primary_bundle_client,
            registry=registry,
            background_tasks=background_tasks,
        )

    async def bootstrap_cloud_only_lite(self) -> ProfileRecord | None:
        """Converge a hardware-qualified Lite runtime without a local Binding.

        The caller validates LRM's cloud-only hardware verdict. Repeated requests
        reuse the same durable pending Profile until the sandbox reports ready.
        """
        active = await self.profile_store.get_active()
        if active is not None:
            return active
        pending = await self.profile_store.get_pending()
        if pending is None:
            pending = await self.profile_store.stage_pending(
                self.product_profile_catalog.load("lite"),
                primary_bundle=None,
                operation_id="hub:lite-bootstrap",
                expected_active_revision=0,
            )
        if pending.operation_id != "hub:lite-bootstrap" or pending.product_profile_id != "lite":
            return None
        deployment = runtime_deployment_spec(pending)
        persisted = await self.restricted_sandbox_lifecycle_client.persist_runtime_deployment(deployment)
        if persisted != deployment:
            raise ValueError("Lite runtime deployment read-back mismatch")
        evidence = (await self.restricted_sandbox_lifecycle_client.get_runtime_instance_evidence()).root
        if evidence.status == "failed" and _runtime_evidence_matches(evidence, deployment):
            self._lite_bootstrap_failed = True
            self._lite_bootstrap_failure_reason = provision_failure_code(evidence)
            logger.error(
                "Lite runtime bootstrap failed reason={}; waiting for a user Retry (POST /app/runtime/converge)",
                self._lite_bootstrap_failure_reason,
            )
            return None
        if not _runtime_evidence_ready(evidence, deployment, pending.snapshot.descriptor):
            return None
        return await self.profile_store.activate_cloud_only_lite_pending(
            operation_id=pending.operation_id,
            expected_target_revision=pending.snapshot.profile_revision,
        )

    def _schedule_lite_bootstrap(self) -> None:
        if self._lite_bootstrap_task is not None and not self._lite_bootstrap_task.done():
            return

        async def converge() -> None:
            while not self._lite_bootstrap_failed:
                try:
                    if await self.bootstrap_cloud_only_lite() is not None:
                        return
                except Exception as exc:
                    logger.warning("Lite runtime bootstrap deferred error_type={}", type(exc).__name__)
                await asyncio.sleep(1)

        self._lite_bootstrap_task = asyncio.create_task(converge(), name="servicehub.lite-bootstrap")

    async def retry_cloud_only_lite(self) -> bool:
        """Relaunch a failed Lite runtime once per explicit request.

        SandboxManager does not relaunch a deployment whose run already failed, so
        the failed pending Profile is discarded and the bootstrap stages a new one
        under a new deployment id. Returns False when Lite has not failed.
        """
        if not self._lite_bootstrap_failed:
            return False
        self._lite_bootstrap_failed = False
        try:
            pending = await self.profile_store.get_pending()
            if pending is not None and pending.operation_id == "hub:lite-bootstrap":
                await self.profile_store.discard_pending(
                    operation_id=pending.operation_id,
                    expected_target_revision=pending.snapshot.profile_revision,
                )
        except Exception as exc:  # leave the failure on screen rather than half-retry
            self._lite_bootstrap_failed = True
            logger.warning("Lite runtime retry not started error_type={}", type(exc).__name__)
            return False
        self._lite_bootstrap_failure_reason = None
        logger.info("Lite runtime retry requested; relaunching under a new runtime deployment")
        self._schedule_lite_bootstrap()
        return True

    async def reconcile_active_profile_against_artifacts(self) -> str:
        """Self-heal a stale or missing active Profile so the hub never strands itself
        next to a healthy LRM-committed bundle.

        The persisted active ProfileSnapshot survives restarts by design, but an app
        upgrade or image rebuild can change the baked Product Profile while the
        Snapshot still carries the previous ``product_profile_digest``. Replaying that stale
        Snapshot makes the container's fail-closed startup barrier reject it with
        ``product_profile_digest_mismatch`` and exit, surfacing as an opaque "runtime
        disconnected". Detect that drift, discard the stale active Profile, and re-drive
        the committed primary bundle through a normal ``connect`` switch so a fresh
        Snapshot is resolved against the current artifacts.

        A hub can also boot with no active Profile at all while LRM still reports a
        committed, ready bundle (#2013): a first boot after a clean split-brain, or any
        later boot after a *previous* reheal attempt deferred or failed (#2056) and left
        ``active: null`` with nothing to ever retry it. Before this method also tried
        `_reheal_committed_bundle()` for that case, `active is None` short-circuited to a
        permanent no-op on every subsequent boot -- the LRM read was only ever attempted
        in the same call that just discarded a stale Profile. Route both "was just
        discarded" and "was already null" through the same reheal attempt: it already
        fails open to `reheal_deferred` when there is nothing safe to re-drive (e.g. a
        genuinely fresh install with no committed bundle yet), so this costs an extra LRM
        read per boot in that case, not a behavior change for it.

        Runs after switch recovery has settled and only when no switch is in flight, so
        it never races a pending transition. Fail-open on detection: any error reading
        the artifacts or the persisted state leaves the Profile untouched (the container
        gate remains the backstop). Returns a short outcome string for observability.
        """
        try:
            active = await self.profile_store.get_active()
        except ProfileStoreCorruptionError:
            logger.warning("capability reconcile skipped: active Profile state is unreadable")
            return "skipped_unreadable"
        pending = await self.profile_store.get_pending()
        if pending is not None:
            if pending.operation_id == "hub:lite-bootstrap":
                self._schedule_lite_bootstrap()
            # An in-flight switch owns the Profile transition; let it settle rather
            # than discarding underneath it, or racing it with a reheal switch.
            return "skipped_pending_switch"
        if active is None:
            return await self._reheal_committed_bundle()
        try:
            product_profile = self.product_profile_catalog.load(active.product_profile_id)
        except ProductProfileLoadError as exc:
            logger.warning("capability reconcile skipped: current Product Profile unreadable ({})", exc)
            return "skipped_artifacts_unreadable"
        discarded = await self.profile_store.discard_active_on_product_profile_drift(product_profile=product_profile)
        if discarded is None:
            return "aligned"
        logger.warning(
            "capability reconcile detected Product Profile drift: discarding stale active Profile "
            "profile_revision={} snapshot_product_profile_digest={} current_product_profile_digest={}; "
            "re-driving committed bundle",
            discarded.snapshot.profile_revision,
            discarded.product_profile_digest,
            product_profile.artifact_digest,
        )
        return await self._reheal_committed_bundle()

    async def _reheal_committed_bundle(self) -> str:
        """Re-drive the committed primary bundle when the active Profile was just
        discarded for manifest drift, or was already absent (#2013/#2056).

        Reads LRM's committed bundle and, when it is a supported bundle whose assets
        are cached, submits a ``connect`` switch through the coordinator to resolve a
        fresh Snapshot and recreate the container. Returns:

        * ``rehealed`` — a ``connect`` switch was submitted.
        * ``reheal_deferred`` — no committed bundle, or it is not a cached supported
          bundle (e.g. an edge bundle with drifted assets that can never download):
          nothing safe to re-drive, so leave ``active: null`` for the first-boot
          resolution / UI recovery path.
        * ``reheal_failed`` — reading LRM or submitting the switch raised; logged so the
          failure is legible instead of an opaque hang.
        """
        coordinator = self.model_binding_activation_coordinator
        registry = self._registry
        if coordinator is None or registry is None:
            logger.warning("capability reheal deferred: coordinator not wired")
            return "reheal_deferred"
        service = registry.get_by_prefix("/llm-router")
        if service is None or getattr(service, "state", None) != "running":
            logger.warning("capability reheal deferred: LRM unavailable")
            self._schedule_lite_admission_retry()
            return "reheal_deferred"
        try:
            result = await self.lrm_bundle_client.get_primary_bundle(service)
        except Exception as exc:  # cross-process read: surface as reheal_failed, never crash boot
            logger.error(
                "capability reheal failed: LRM read raised type={} msg={}",
                type(exc).__name__,
                _redact_exc_msg(exc),
            )
            self._schedule_lite_admission_retry()
            return "reheal_failed"
        if not isinstance(result, LrmBundleCapabilityResult):
            logger.warning("capability reheal deferred: LRM capability unavailable/malformed")
            self._schedule_lite_admission_retry()
            return "reheal_deferred"
        capability = result.capability
        committed = capability.primary_bundle
        if committed is None:
            if getattr(capability, "cloud_only_product_profile_id", None) == "lite":
                self._schedule_lite_bootstrap()
                return "lite_bootstrap_started"
            if _hardware_evidence_degraded(capability):
                # LRM re-probes in the background; its Lite verdict can still arrive.
                logger.info("capability reheal deferred: no committed primary bundle, hardware evidence incomplete")
                self._schedule_lite_admission_retry()
                return "reheal_deferred"
            logger.info("capability reheal deferred: no committed primary bundle")
            return "reheal_deferred"
        supported = next(
            (b for b in capability.supported_bundles if b.bundle_id == committed.bundle_id),
            None,
        )
        if supported is None or not supported.fully_cached_and_verified:
            logger.warning(
                "capability reheal deferred: committed bundle {} not a cached supported bundle",
                committed.bundle_id,
            )
            return "reheal_deferred"
        request = ModelBindingActivationRequest.model_validate({
            "contract_version": 1,
            "intent": "connect",
            "target_bundle_id": committed.bundle_id,
            "expected_bundle_revision": committed.bundle_revision,
            "candidate_revision": capability.model_candidate_revision,
            "idempotency_key": f"reheal-{committed.bundle_id}-{uuid.uuid4()}",
        }, strict=True)
        try:
            record = await coordinator.start_activation(request)
        except Exception as exc:  # switch submit failure: surface as reheal_failed, never crash boot
            logger.error(
                "capability reheal failed: switch submit raised type={} msg={}",
                type(exc).__name__,
                _redact_exc_msg(exc),
            )
            return "reheal_failed"
        logger.warning(
            "capability reheal re-driving committed bundle {} operation_id={} bundle_revision={}",
            committed.bundle_id,
            record.operation_id,
            committed.bundle_revision,
        )
        return "rehealed"

    def _schedule_lite_admission_retry(self) -> None:
        if self._registry is None or self.model_binding_activation_coordinator is None:
            return
        if self._lite_admission_task is not None and not self._lite_admission_task.done():
            return

        async def retry() -> None:
            while True:
                await asyncio.sleep(1)
                if await self.profile_store.get_active() is not None or await self.profile_store.get_pending() is not None:
                    return
                try:
                    result = await self._reheal_committed_bundle()
                except Exception as exc:
                    logger.warning("Lite admission retry deferred error_type={}", type(exc).__name__)
                    continue
                if result not in {"reheal_deferred", "reheal_failed"}:
                    return

        self._lite_admission_task = asyncio.create_task(retry(), name="servicehub.lite-admission")

    def product_profile_digest(self, product_profile_id: str) -> str:
        return self.product_profile_catalog.load(product_profile_id).artifact_digest
