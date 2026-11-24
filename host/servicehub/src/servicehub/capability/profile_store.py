"""Durable active and pending Profile state for capability transitions."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import hashlib
from pathlib import Path
import re
import uuid
from threading import Lock
from typing import ClassVar, Literal

from loguru import logger

from contracts.model_bundle import ModelBundle
from contracts.primary_bundle_state import PrimaryBundleState
from contracts.profile_snapshot import ProfileSnapshot
from contracts.runtime_deployment_spec import RuntimeDeploymentSpec
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

from servicehub.capability.atomic_json import (
    AtomicJsonCorruptionError,
    canonical_json_bytes,
    atomic_write_json,
    read_json_object,
)
from servicehub.capability.product_profile_catalog import LoadedProductProfile

_STATE_SCHEMA_VERSION = 1
_HUB_OPERATION_ID = r"^hub:[A-Za-z0-9][A-Za-z0-9._-]*$"
_PERSISTED_REASON_CODES = frozenset({"alternative_reason", "bundle_ready", "trusted"})
_UTC_TIMESTAMP = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z$"
)


class ProfileStoreCorruptionError(ValueError):
    """Persisted Profile evidence violates the durable state contract."""


class ProfileRevisionConflict(RuntimeError):
    """A caller's active or pending revision compare-and-swap failed."""


class ProfileOperationConflict(RuntimeError):
    """A different pending operation already owns the Profile transition."""


def _validate_reason_codes(reasons: tuple[str, ...]) -> tuple[str, ...]:
    if tuple(sorted(set(reasons))) != reasons:
        raise ValueError("reasons must be sorted unique stable codes")
    for reason in reasons:
        if reason not in _PERSISTED_REASON_CODES:
            raise ValueError("reasons must contain only allowlisted stable codes")
    return reasons


class ProfileRecord(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    snapshot: ProfileSnapshot
    resolution_source: Literal["hardware_ceiling", "primary_bundle"]
    resolved_at: str = Field(pattern=_UTC_TIMESTAMP.pattern)
    reasons: tuple[str, ...]
    primary_bundle: PrimaryBundleState | None
    target_bundle: ModelBundle | None = None
    surface_fingerprint: str = Field(pattern=r"^[0-9a-f]{64}$")
    target_fingerprint: str = Field(pattern=r"^[0-9a-f]{64}$")
    product_profile_id: Literal["lite", "standard", "pro"]
    product_profile_digest: str = Field(pattern=r"^[0-9a-f]{64}$")
    runtime_deployment_id: str = Field(pattern=r"^runtime-deployment-[0-9a-f]{32}$")
    source_operation_id: str | None = Field(default=None, pattern=_HUB_OPERATION_ID)

    @field_validator("resolved_at")
    @classmethod
    def validate_resolved_at(cls, value: str) -> str:
        if _UTC_TIMESTAMP.fullmatch(value) is None:
            raise ValueError("resolved_at must be a UTC Z timestamp")
        try:
            datetime.fromisoformat(value[:-1] + "+00:00")
        except ValueError as exc:
            raise ValueError("resolved_at must be a valid timestamp") from exc
        return value

    @model_validator(mode="after")
    def validate_record(self) -> ProfileRecord:
        if self.snapshot.profile_revision <= 0:
            raise ValueError("persisted Profile revision must be greater than zero")
        if self.snapshot.product_profile_id.value != self.product_profile_id:
            raise ValueError("persisted Product Profile id does not match its Snapshot")
        if self.snapshot.product_profile_digest != self.product_profile_digest:
            raise ValueError("persisted Product Profile digest does not match its Snapshot")
        if self.surface_fingerprint != _surface_fingerprint(self.snapshot):
            raise ValueError("persisted Profile fingerprint does not match its Snapshot")
        if self.resolution_source == "hardware_ceiling" and (
            self.primary_bundle is not None or self.target_bundle is not None
        ):
            raise ValueError("hardware_ceiling Profile cannot retain a primary bundle")
        if self.resolution_source == "primary_bundle" and (
            self.primary_bundle is None and self.target_bundle is None
        ):
            raise ValueError("primary_bundle Profile requires a Bundle identity")
        if self.primary_bundle is not None and self.target_bundle is not None:
            raise ValueError("Profile cannot retain committed and prepared Bundle identities")
        if self.primary_bundle is not None:
            if self.primary_bundle.reason is not None:
                raise ValueError("persisted primary bundle cannot retain a free-text reason")
            if self.primary_bundle.capability_contract_version != self.snapshot.capability_contract_version:
                raise ValueError("primary bundle contract does not match Profile Snapshot")
        _validate_reason_codes(self.reasons)
        if self.target_fingerprint != _target_fingerprint(
            self.snapshot, self.resolution_source, self.reasons, self.primary_bundle, self.target_bundle
        ):
            raise ValueError("persisted Profile target fingerprint does not match its target")
        return self


class PendingProfileRecord(ProfileRecord):
    operation_id: str = Field(pattern=_HUB_OPERATION_ID)

    @model_validator(mode="after")
    def validate_pending_record(self) -> PendingProfileRecord:
        if self.source_operation_id is not None:
            raise ValueError("pending Profile cannot duplicate its operation provenance")
        if self.target_bundle is not None:
            if self.primary_bundle is not None:
                raise ValueError("prepared target cannot also retain a committed primary bundle")
            if self.resolution_source != "primary_bundle":
                raise ValueError("prepared target requires primary_bundle resolution")
            if self.target_bundle.capability_contract_version != self.snapshot.capability_contract_version:
                raise ValueError("prepared target contract does not match Profile Snapshot")
        return self


class ProfileState(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    schema_version: Literal[1]
    revision_counter: int = Field(ge=0)
    active: ProfileRecord | None
    pending: PendingProfileRecord | None

    @model_validator(mode="after")
    def validate_revisions(self) -> ProfileState:
        revisions = [record.snapshot.profile_revision for record in (self.active, self.pending) if record]
        if any(revision > self.revision_counter for revision in revisions):
            raise ValueError("revision counter is behind stored Profile evidence")
        if self.active is not None and self.active.target_bundle is not None:
            raise ValueError("active Profile cannot retain a prepared target Bundle")
        return self


class ProfileStore:
    """A process-local serialized read-modify-write owner for Profile evidence."""

    _locks: ClassVar[dict[Path, asyncio.Lock]] = {}
    _locks_guard: ClassVar[Lock] = Lock()

    def __init__(self, data_dir: Path) -> None:
        self._path = (Path(data_dir) / "capability" / "profile-state.json").resolve()
        with self._locks_guard:
            self._lock = self._locks.setdefault(self._path, asyncio.Lock())

    @property
    def data_dir(self) -> Path:
        return self._path.parents[1]

    async def get_active(self) -> ProfileRecord | None:
        async with self._lock:
            return (await self._load_state_async()).active

    async def get_pending(self) -> PendingProfileRecord | None:
        async with self._lock:
            return (await self._load_state_async()).pending

    async def update_active_primary_bundle(
        self,
        *,
        expected_profile_revision: int,
        expected_product_profile: Literal["lite", "standard", "pro"],
        committed_primary_bundle: PrimaryBundleState,
    ) -> ProfileRecord:
        """Update Bundle attribution without changing the active Runtime surface."""
        async with self._lock:
            state = await self._load_state_async()
            active = state.active
            if active is None:
                raise ProfileOperationConflict("no active Profile is available")
            if state.pending is not None:
                raise ProfileOperationConflict("pending Profile prevents in-place Bundle update")
            if active.snapshot.profile_revision != expected_profile_revision:
                raise ProfileRevisionConflict("active Profile revision changed")
            if active.product_profile_id != expected_product_profile:
                raise ProfileOperationConflict("active Product Profile changed")
            persisted_bundle = _persisted_bundle(committed_primary_bundle)
            updated = ProfileRecord(**(
                active.model_dump()
                | {
                    "primary_bundle": persisted_bundle,
                    "target_fingerprint": _target_fingerprint(
                        active.snapshot,
                        active.resolution_source,
                        active.reasons,
                        persisted_bundle,
                    ),
                }
            ))
            await self._write_state_async(state.model_copy(update={"active": updated}))
            return updated

    async def stage_pending(
        self,
        product_profile: LoadedProductProfile,
        *,
        resolution_source: Literal["hardware_ceiling", "primary_bundle"] | None = None,
        reasons: tuple[str, ...] = (),
        primary_bundle: PrimaryBundleState | None,
        target_bundle: ModelBundle | None = None,
        operation_id: str,
        expected_active_revision: int,
    ) -> PendingProfileRecord:
        async with self._lock:
            state = await self._load_state_async()
            actual_active_revision = state.active.snapshot.profile_revision if state.active else 0
            if expected_active_revision != actual_active_revision:
                raise ProfileRevisionConflict(
                    f"expected active revision {expected_active_revision}, found {actual_active_revision}"
                )
            selected_source: Literal["hardware_ceiling", "primary_bundle"] = resolution_source or (
                "primary_bundle" if primary_bundle is not None or target_bundle is not None else "hardware_ceiling"
            )
            _validate_resolution_bundle(product_profile, selected_source, reasons, primary_bundle, target_bundle)
            requested_fingerprint = _surface_fingerprint_from_product_profile(product_profile)
            target_revision = (
                state.pending.snapshot.profile_revision
                if state.pending is not None and state.pending.operation_id == operation_id
                else state.active.snapshot.profile_revision
                if state.active is not None and state.active.surface_fingerprint == requested_fingerprint
                else state.revision_counter + 1
            )
            requested = _pending_record_from_resolution(
                product_profile, selected_source, reasons, primary_bundle, target_bundle, operation_id, target_revision,
                requested_fingerprint,
                state.pending.runtime_deployment_id
                if state.pending is not None and state.pending.operation_id == operation_id
                else _new_runtime_deployment_id(),
            )
            if state.pending is not None:
                if state.pending.operation_id != operation_id:
                    raise ProfileOperationConflict("another operation already owns the pending Profile")
                if state.pending.target_fingerprint != requested.target_fingerprint:
                    raise ProfileOperationConflict("operation already stages a different Profile target")
                return state.pending

            await self._write_state_async(ProfileState(
                schema_version=_STATE_SCHEMA_VERSION,
                revision_counter=max(state.revision_counter, target_revision),
                active=state.active,
                pending=requested,
            ))
            saved = (await self._load_state_async()).pending
            if saved is None:
                raise ProfileStoreCorruptionError("pending Profile disappeared after durable write")
            logger.info(
                "profile_store staged_pending operation_id={} target_revision={}",
                operation_id,
                saved.snapshot.profile_revision,
            )
            return saved

    async def restage_pending_for_recovery(
        self,
        product_profile: LoadedProductProfile,
        *,
        target_bundle: ModelBundle,
        operation_id: str,
        expected_active_revision: int,
    ) -> PendingProfileRecord:
        async with self._lock:
            state = await self._load_state_async()
            actual_active_revision = state.active.snapshot.profile_revision if state.active else 0
            if expected_active_revision != actual_active_revision:
                raise ProfileRevisionConflict(
                    f"expected active revision {expected_active_revision}, found {actual_active_revision}"
                )
            if state.pending is not None and state.pending.operation_id != operation_id:
                raise ProfileOperationConflict("another operation already owns the pending Profile")

            _validate_resolution_bundle(
                product_profile,
                "primary_bundle",
                ("trusted",),
                None,
                target_bundle,
            )
            requested_fingerprint = _surface_fingerprint_from_product_profile(product_profile)
            if (
                state.pending is not None
                and state.pending.product_profile_id == product_profile.product_profile_id
                and state.pending.product_profile_digest == product_profile.artifact_digest
                and state.pending.target_bundle == target_bundle
            ):
                return state.pending

            target_revision = state.revision_counter + 1
            requested = _pending_record_from_resolution(
                product_profile,
                "primary_bundle",
                ("trusted",),
                None,
                target_bundle,
                operation_id,
                target_revision,
                requested_fingerprint,
                _new_runtime_deployment_id(),
            )
            await self._write_state_async(ProfileState(
                schema_version=_STATE_SCHEMA_VERSION,
                revision_counter=target_revision,
                active=state.active,
                pending=requested,
            ))
            saved = (await self._load_state_async()).pending
            if saved is None:
                raise ProfileStoreCorruptionError("recovered pending Profile disappeared after durable write")
            logger.warning(
                "profile_store restaged_pending_for_recovery operation_id={} target_revision={}",
                operation_id,
                saved.snapshot.profile_revision,
            )
            return saved

    async def activate_runtime_ready_pending(
        self,
        *,
        operation_id: str,
        expected_target_revision: int,
        expected_product_profile: Literal["lite", "standard", "pro"],
        committed_primary_bundle: PrimaryBundleState,
    ) -> ProfileRecord:
        """Atomically promote a pending Profile after fresh Runtime ready proof."""
        async with self._lock:
            state = await self._load_state_async()
            pending = state.pending
            if pending is None:
                active = state.active
                if (
                    active is not None
                    and active.snapshot.profile_revision == expected_target_revision
                    and active.product_profile_id == expected_product_profile
                    and active.primary_bundle == _persisted_bundle(committed_primary_bundle)
                ):
                    return active
                raise ProfileOperationConflict("no pending Profile is available to activate")
            if pending.operation_id != operation_id:
                raise ProfileOperationConflict("pending Profile belongs to another operation")
            if pending.snapshot.profile_revision != expected_target_revision:
                raise ProfileRevisionConflict("pending Profile revision does not match activation target")
            if pending.product_profile_id != expected_product_profile:
                raise ProfileOperationConflict("pending Product Profile does not match Runtime ready proof")
            if pending.target_bundle is None or not _committed_bundle_matches_target(
                committed_primary_bundle, pending.target_bundle
            ):
                raise ProfileOperationConflict("committed Bundle does not match pending target")
            persisted_bundle = _persisted_bundle(committed_primary_bundle)
            active = ProfileRecord(**(
                pending.model_dump(exclude={"operation_id"})
                | {
                    "source_operation_id": pending.operation_id,
                    "primary_bundle": persisted_bundle,
                    "target_bundle": None,
                    "target_fingerprint": _target_fingerprint(
                        pending.snapshot,
                        pending.resolution_source,
                        pending.reasons,
                        persisted_bundle,
                    ),
                }
            ))
            await self._write_state_async(ProfileState(
                schema_version=_STATE_SCHEMA_VERSION,
                revision_counter=state.revision_counter,
                active=active,
                pending=None,
            ))
            saved = (await self._load_state_async()).active
            if saved is None:
                raise ProfileStoreCorruptionError("active Profile disappeared after durable write")
            logger.info(
                "profile_store activated_runtime_ready operation_id={} profile_revision={}",
                operation_id,
                saved.snapshot.profile_revision,
            )
            return saved

    async def activate_cloud_only_lite_pending(
        self, *, operation_id: str, expected_target_revision: int
    ) -> ProfileRecord:
        """Promote a hardware-qualified Lite Profile after Runtime ready proof."""
        async with self._lock:
            state = await self._load_state_async()
            pending = state.pending
            if pending is None or pending.operation_id != operation_id:
                raise ProfileOperationConflict("Lite bootstrap pending Profile is missing")
            if pending.snapshot.profile_revision != expected_target_revision:
                raise ProfileRevisionConflict("Lite bootstrap revision changed")
            if (
                pending.product_profile_id != "lite"
                or pending.resolution_source != "hardware_ceiling"
                or pending.primary_bundle is not None
                or pending.target_bundle is not None
            ):
                raise ProfileOperationConflict("Lite bootstrap requires a bundle-free Profile")
            active = ProfileRecord(**(
                pending.model_dump(exclude={"operation_id"})
                | {"source_operation_id": operation_id}
            ))
            await self._write_state_async(ProfileState(
                schema_version=_STATE_SCHEMA_VERSION,
                revision_counter=state.revision_counter,
                active=active,
                pending=None,
            ))
            return active

    async def discard_pending(self, *, operation_id: str, expected_target_revision: int) -> None:
        async with self._lock:
            state = await self._load_state_async()
            pending = state.pending
            if pending is None:
                return
            if pending.operation_id != operation_id:
                raise ProfileOperationConflict("pending Profile belongs to another operation")
            if pending.snapshot.profile_revision != expected_target_revision:
                raise ProfileRevisionConflict("pending Profile revision does not match discard target")
            await self._write_state_async(ProfileState(
                schema_version=_STATE_SCHEMA_VERSION,
                revision_counter=state.revision_counter,
                active=state.active,
                pending=None,
            ))
            logger.info(
                "profile_store discarded_pending operation_id={} target_revision={}",
                operation_id,
                expected_target_revision,
            )

    async def discard_active_on_product_profile_drift(
        self, *, product_profile: LoadedProductProfile
    ) -> ProfileRecord | None:
        async with self._lock:
            state = await self._load_state_async()
            active = state.active
            if active is None:
                return None
            if (
                active.product_profile_id == product_profile.product_profile_id
                and active.product_profile_digest == product_profile.artifact_digest
            ):
                return None
            await self._write_state_async(ProfileState(
                schema_version=_STATE_SCHEMA_VERSION,
                revision_counter=state.revision_counter,
                active=None,
                pending=state.pending,
            ))
            logger.warning(
                "profile_store discarded_active_on_product_profile_drift profile_revision={} "
                "snapshot_product_profile_id={} current_product_profile_id={} "
                "snapshot_product_profile_digest={} current_product_profile_digest={}",
                active.snapshot.profile_revision,
                active.product_profile_id,
                product_profile.product_profile_id,
                active.product_profile_digest,
                product_profile.artifact_digest,
            )
            return active

    async def _load_state_async(self) -> ProfileState:
        # `_load_state`/`_write_state` are synchronous file I/O (`journal.py`'s
        # equivalent operations already run via `asyncio.to_thread`; this store
        # did not). On Windows, a file held by AV scanning, OneDrive, or another
        # handle can block for an unbounded time -- run off the event loop
        # thread so a slow disk stalls only this awaiter, not every other
        # coroutine in the process (a suspected contributor to #2013's
        # unexplained multi-minute coordinator stalls).
        return await asyncio.to_thread(self._load_state)

    async def _write_state_async(self, state: ProfileState) -> None:
        await asyncio.to_thread(self._write_state, state)

    def _load_state(self) -> ProfileState:
        try:
            raw = read_json_object(self._path)
        except AtomicJsonCorruptionError as exc:
            raise ProfileStoreCorruptionError(f"invalid persisted Profile state: {self._path}") from exc
        if raw is None:
            return ProfileState(schema_version=_STATE_SCHEMA_VERSION, revision_counter=0, active=None, pending=None)
        migrated = _migrate_runtime_deployment_ids(raw)
        if migrated:
            atomic_write_json(self._path, raw)
        try:
            return ProfileState.model_validate_json(canonical_json_bytes(raw), strict=True)
        except ValidationError as exc:
            if _is_legacy_profile_state(raw):
                logger.warning("profile_store resetting legacy Profile state path={}", self._path)
                revision_counter = raw.get("revision_counter")
                preserved_counter = (
                    revision_counter
                    if isinstance(revision_counter, int) and not isinstance(revision_counter, bool) and revision_counter >= 0
                    else 0
                )
                reset = ProfileState(
                    schema_version=_STATE_SCHEMA_VERSION,
                    revision_counter=preserved_counter,
                    active=None,
                    pending=None,
                )
                self._write_state(reset)
                return reset
            raise ProfileStoreCorruptionError(f"invalid persisted Profile state: {self._path}") from exc

    def _write_state(self, state: ProfileState) -> None:
        atomic_write_json(self._path, state.model_dump(mode="json"))


# Fingerprints omit None so a new optional field leaves persisted state valid;
# a new field with any other default still invalidates every stored record.
def _surface_fingerprint(snapshot: ProfileSnapshot) -> str:
    return hashlib.sha256(canonical_json_bytes({
        "capability_contract_version": snapshot.capability_contract_version,
        "descriptor": snapshot.descriptor.model_dump(mode="json", exclude_none=True),
        "product_profile_digest": snapshot.product_profile_digest,
        "product_profile_id": snapshot.product_profile_id.value,
    })).hexdigest()


def runtime_deployment_spec(
    record: ProfileRecord, *, source_operation_id: str | None = None
) -> RuntimeDeploymentSpec:
    return RuntimeDeploymentSpec.model_validate_json(canonical_json_bytes({
        "schema_version": 2,
        "deployment_id": record.runtime_deployment_id,
        "source_operation_id": (
            record.operation_id
            if isinstance(record, PendingProfileRecord)
            else source_operation_id or record.source_operation_id
        ),
        "product_profile_id": record.product_profile_id,
        "product_profile_digest": record.product_profile_digest,
        "profile_revision": record.snapshot.profile_revision,
    }), strict=True)


def _surface_fingerprint_from_product_profile(product_profile: LoadedProductProfile) -> str:
    return hashlib.sha256(canonical_json_bytes({
        "capability_contract_version": 1,
        "descriptor": product_profile.descriptor.model_dump(mode="json", exclude_none=True),
        "product_profile_digest": product_profile.artifact_digest,
        "product_profile_id": product_profile.product_profile_id,
    })).hexdigest()


def _target_fingerprint(
    snapshot: ProfileSnapshot,
    resolution_source: str,
    reasons: tuple[str, ...],
    primary_bundle: PrimaryBundleState | None,
    target_bundle: ModelBundle | None = None,
) -> str:
    return hashlib.sha256(canonical_json_bytes({
        "snapshot": snapshot.model_dump(mode="json", exclude_none=True),
        "resolution_source": resolution_source,
        "reasons": reasons,
        "primary_bundle": (
            primary_bundle.model_dump(mode="json", exclude={"reason"}, exclude_none=True) if primary_bundle else None
        ),
        "target_bundle": target_bundle.model_dump(mode="json", exclude_none=True) if target_bundle else None,
    })).hexdigest()


def _snapshot_from_product_profile(product_profile: LoadedProductProfile, revision: int) -> ProfileSnapshot:
    return ProfileSnapshot.model_validate({
        "capability_contract_version": 1,
        "descriptor": product_profile.descriptor.model_dump(mode="json"),
        "product_profile_digest": product_profile.artifact_digest,
        "product_profile_id": product_profile.product_profile_id,
        "profile_revision": revision,
    })


def _pending_record_from_resolution(
    product_profile: LoadedProductProfile,
    resolution_source: Literal["hardware_ceiling", "primary_bundle"],
    reasons: tuple[str, ...],
    primary_bundle: PrimaryBundleState | None,
    target_bundle: ModelBundle | None,
    operation_id: str,
    target_revision: int,
    surface_fingerprint: str,
    runtime_deployment_id: str,
) -> PendingProfileRecord:
    snapshot = _snapshot_from_product_profile(product_profile, target_revision)
    persisted_bundle = _persisted_bundle(primary_bundle)
    return PendingProfileRecord(
        snapshot=snapshot,
        resolution_source=resolution_source,
        resolved_at=_timestamp(),
        reasons=reasons,
        primary_bundle=persisted_bundle,
        surface_fingerprint=surface_fingerprint,
        target_fingerprint=_target_fingerprint(
            snapshot, resolution_source, reasons, persisted_bundle, target_bundle
        ),
        operation_id=operation_id,
        target_bundle=target_bundle,
        product_profile_id=product_profile.product_profile_id,
        product_profile_digest=product_profile.artifact_digest,
        runtime_deployment_id=runtime_deployment_id,
    )


def _validate_resolution_bundle(
    product_profile: LoadedProductProfile,
    resolution_source: Literal["hardware_ceiling", "primary_bundle"],
    reasons: tuple[str, ...],
    primary_bundle: PrimaryBundleState | None,
    target_bundle: ModelBundle | None,
) -> None:
    if product_profile.product_profile_id != product_profile.descriptor.profile.value:
        raise ProfileStoreCorruptionError("Product Profile descriptor identity mismatch")
    _validate_reason_codes(reasons)
    if primary_bundle is not None and target_bundle is not None:
        raise ProfileStoreCorruptionError("pending Profile cannot contain two Bundle identities")
    if resolution_source == "hardware_ceiling" and primary_bundle is not None:
        raise ProfileStoreCorruptionError("hardware_ceiling resolution cannot stage a primary bundle")
    if resolution_source == "primary_bundle" and primary_bundle is None and target_bundle is None:
        raise ProfileStoreCorruptionError("primary_bundle resolution requires a Bundle identity")
    if primary_bundle is not None and primary_bundle.capability_contract_version != 1:
        raise ProfileStoreCorruptionError("primary bundle does not match resolved Profile facts")
    if target_bundle is not None and target_bundle.capability_contract_version != 1:
        raise ProfileStoreCorruptionError("prepared target does not match resolved Profile facts")


def _persisted_bundle(primary_bundle: PrimaryBundleState | None) -> PrimaryBundleState | None:
    if primary_bundle is None:
        return None
    return PrimaryBundleState.model_validate(primary_bundle.model_dump(exclude={"reason"}))


def _committed_bundle_matches_target(committed: PrimaryBundleState, target: ModelBundle) -> bool:
    return (
        committed.bundle_id == target.bundle_id
        and committed.backend.value == target.backend.value
        and committed.chat_model_id == target.chat_model_id
        and committed.embedding_model_id == target.embedding_model_id
        and committed.capability_grade == target.capability_grade
        and committed.capability_contract_version == target.capability_contract_version
        and committed.registry_version == target.registry_version
        and committed.state.value == "ready"
    )


def _timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _new_runtime_deployment_id() -> str:
    return f"runtime-deployment-{uuid.uuid4().hex}"


def _migrate_runtime_deployment_ids(raw: dict[str, object]) -> bool:
    """Persist deterministic deployment identities for pre-deployment records."""
    migrated = False
    for key in ("active", "pending"):
        record = raw.get(key)
        if not isinstance(record, dict) or "runtime_deployment_id" in record:
            continue
        digest = record.get("product_profile_digest")
        snapshot = record.get("snapshot")
        revision = snapshot.get("profile_revision") if isinstance(snapshot, dict) else None
        if not isinstance(digest, str) or not isinstance(revision, int) or isinstance(revision, bool):
            continue
        identity = hashlib.sha256(f"{digest}:{revision}".encode("ascii")).hexdigest()[:32]
        record["runtime_deployment_id"] = f"runtime-deployment-{identity}"
        migrated = True
    return migrated


def _is_legacy_profile_state(raw: object) -> bool:
    if not isinstance(raw, dict):
        return False
    for key in ("active", "pending"):
        record = raw.get(key)
        if not isinstance(record, dict):
            continue
        snapshot = record.get("snapshot")
        if isinstance(snapshot, dict) and any(
            legacy in snapshot
            for legacy in (
                "manifest_sha256",
                "emergency_sha256",
                "projection_hash",
                "resolved_agent_profile",
                "feature_manifest_version",
            )
        ):
            return True
        if record.get("product_profile_id") is None or record.get("product_profile_digest") is None:
            return True
    return False
