"""Fail-closed planning and ledger contract for Docker-volume copy-out.

This module intentionally performs no Docker, WSL, or filesystem copy work.
It models the evidence and decisions a lifecycle adapter acts on; the v1
session import (`v1_import.adapter`) is the first.
The source contract is immutable: migration may copy from a source volume but
never move, truncate, or delete it.
"""

from __future__ import annotations

import json
from datetime import datetime
from enum import StrEnum
from pathlib import Path
from typing import Annotated, Any, Literal, Self

from pydantic import (
    BaseModel,
    ConfigDict,
    StringConstraints,
    ValidationError,
    field_validator,
    model_validator,
)

from sandbox_manager.state_migration_io import (
    LedgerError,
    atomic_cas_json,
    canonical_migration_paths,
    ledger_write_lock,
    load_json_object,
    validate_ledger_path,
)


LEDGER_SCHEMA_VERSION = 1

NonEmptyString = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]
Sha256 = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        to_lower=True,
        pattern=r"^[0-9a-f]{64}$",
    ),
]


class MigrationStatus(StrEnum):
    STARTED = "started"
    COMPLETED = "completed"
    BLOCKED = "blocked"


class ConflictOutcome(StrEnum):
    NONE = "none"
    DESTINATION_EXISTS = "destination_exists"
    DESTINATION_MISSING = "destination_missing"
    DESTINATION_UNVERIFIED = "destination_unverified"
    DESTINATION_CONTENT_CHANGED = "destination_content_changed"
    LEDGER_MISMATCH = "ledger_mismatch"
    SOURCE_CHANGED = "source_changed"
    SOURCE_CHANGED_AFTER_ROLLBACK = "source_changed_after_rollback"
    SOURCE_AND_DESTINATION_CHANGED_AFTER_ROLLBACK = (
        "source_and_destination_changed_after_rollback"
    )


class MigrationDecision(StrEnum):
    COPY_TO_STAGING = "copy_to_staging"
    RESTART_STAGING_COPY = "restart_staging_copy"
    FINALIZE_VERIFIED_COPY = "finalize_verified_copy"
    NO_OP = "no_op"
    BLOCK = "block"


class DestinationMutation(StrEnum):
    CREATE_STAGING_COPY = "create_staging_copy"
    REPLACE_OWNED_STAGING_COPY = "replace_owned_staging_copy"
    NONE = "none"


class SourceMutation(StrEnum):
    """The only permitted source-volume action."""

    PRESERVE = "preserve"


class _StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


class ContentEvidence(_StrictModel):
    """Deterministic content evidence captured without modifying the source."""

    algorithm: Literal["sha256"] = "sha256"
    tree_sha256: Sha256
    manifest_sha256: Sha256
    file_count: int
    total_bytes: int
    captured_at: datetime

    @field_validator("file_count", "total_bytes")
    @classmethod
    def _non_negative(cls, value: int) -> int:
        if value < 0:
            raise ValueError("content evidence counts must be non-negative")
        return value

    @field_validator("captured_at")
    @classmethod
    def _timezone_required(cls, value: datetime) -> datetime:
        if value.utcoffset() is None:
            raise ValueError("captured_at must include a timezone")
        return value

    def same_content(self, other: ContentEvidence) -> bool:
        """Compare content, excluding the observation timestamp."""

        return (
            self.algorithm == other.algorithm
            and self.tree_sha256 == other.tree_sha256
            and self.manifest_sha256 == other.manifest_sha256
            and self.file_count == other.file_count
            and self.total_bytes == other.total_bytes
        )


class SourceVolumeIdentity(_StrictModel):
    """Stable Docker volume identity recorded before copy-out."""

    engine: Literal["docker"] = "docker"
    name: NonEmptyString
    driver: NonEmptyString
    scope: NonEmptyString
    identity_sha256: Sha256


class DestinationRecord(_StrictModel):
    """Native destination and its migration-owned staging location."""

    migration_root: NonEmptyString
    path: NonEmptyString
    staging_path: NonEmptyString
    copied_evidence: ContentEvidence | None = None

    @model_validator(mode="after")
    def _paths_are_owned_and_canonical(self) -> Self:
        canonical_migration_paths(
            self.migration_root,
            self.path,
            self.staging_path,
        )
        return self


class RollbackMetadata(_StrictModel):
    """Evidence retained when the product switches back to container mode."""

    recorded_at: datetime
    source_evidence_at_rollback: ContentEvidence
    native_destination_preserved: Literal[True] = True
    source_volume_preserved: Literal[True] = True

    @field_validator("recorded_at")
    @classmethod
    def _timezone_required(cls, value: datetime) -> datetime:
        if value.utcoffset() is None:
            raise ValueError("rollback recorded_at must include a timezone")
        return value


class MigrationLedger(_StrictModel):
    """Versioned durable record of one source-to-destination migration."""

    schema_version: Literal[LEDGER_SCHEMA_VERSION] = LEDGER_SCHEMA_VERSION
    generation: int = 0
    migration_id: NonEmptyString
    source_volume: SourceVolumeIdentity
    source_evidence: ContentEvidence
    destination: DestinationRecord
    status: MigrationStatus
    started_at: datetime | None
    completed_at: datetime | None
    conflict_outcome: ConflictOutcome = ConflictOutcome.NONE
    rollback: RollbackMetadata | None = None
    source_mutation: Literal[SourceMutation.PRESERVE] = SourceMutation.PRESERVE

    @field_validator("started_at", "completed_at")
    @classmethod
    def _timezone_required(cls, value: datetime | None) -> datetime | None:
        if value is not None and value.utcoffset() is None:
            raise ValueError("ledger timestamps must include a timezone")
        return value

    @field_validator("generation")
    @classmethod
    def _generation_is_non_negative(cls, value: int) -> int:
        if value < 0:
            raise ValueError("ledger generation must be non-negative")
        return value

    @model_validator(mode="after")
    def _valid_state(self) -> Self:
        if self.status is MigrationStatus.STARTED:
            if self.started_at is None or self.completed_at is not None:
                raise ValueError("started ledger requires only started_at")
            if self.destination.copied_evidence is not None:
                raise ValueError("started ledger cannot claim copied destination evidence")
        elif self.status is MigrationStatus.COMPLETED:
            if self.started_at is None or self.completed_at is None:
                raise ValueError("completed ledger requires started_at and completed_at")
            if self.destination.copied_evidence is None:
                raise ValueError("completed ledger requires destination evidence")
            if not self.source_evidence.same_content(
                self.destination.copied_evidence
            ):
                raise ValueError(
                    "completed ledger source evidence must match copied evidence"
                )
        elif self.status is MigrationStatus.BLOCKED:
            if self.started_at is not None or self.completed_at is not None:
                raise ValueError("blocked initial migration cannot have copy timestamps")
            if self.conflict_outcome is ConflictOutcome.NONE:
                raise ValueError("blocked ledger requires a conflict outcome")
        return self


class MigrationRequest(_StrictModel):
    """Current observations supplied to the pure migration planner."""

    migration_id: NonEmptyString
    source_volume: SourceVolumeIdentity
    source_evidence: ContentEvidence
    migration_root: NonEmptyString
    destination_path: NonEmptyString
    staging_path: NonEmptyString
    destination_exists: bool
    destination_evidence: ContentEvidence | None
    observed_at: datetime

    @field_validator("observed_at")
    @classmethod
    def _timezone_required(cls, value: datetime) -> datetime:
        if value.utcoffset() is None:
            raise ValueError("observed_at must include a timezone")
        return value

    @model_validator(mode="after")
    def _valid_destination_observation(self) -> Self:
        canonical_migration_paths(
            self.migration_root,
            self.destination_path,
            self.staging_path,
        )
        if not self.destination_exists and self.destination_evidence is not None:
            raise ValueError("missing destination cannot have content evidence")
        return self


class MigrationPlan(_StrictModel):
    """A non-executing decision; the lifecycle adapter that receives it does the work."""

    decision: MigrationDecision
    reason: NonEmptyString
    ledger: MigrationLedger
    destination_mutation: DestinationMutation
    source_mutation: Literal[SourceMutation.PRESERVE] = SourceMutation.PRESERVE
    conflict_outcome: ConflictOutcome = ConflictOutcome.NONE

    @model_validator(mode="after")
    def _blocked_plan_has_conflict(self) -> Self:
        if self.decision is MigrationDecision.BLOCK:
            if self.conflict_outcome is ConflictOutcome.NONE:
                raise ValueError("blocked plan requires a conflict outcome")
            if self.destination_mutation is not DestinationMutation.NONE:
                raise ValueError("blocked plan cannot mutate the destination")
        elif self.conflict_outcome is not ConflictOutcome.NONE:
            raise ValueError("non-blocked plan cannot have a conflict outcome")
        return self


def load_ledger(path: Path) -> MigrationLedger | None:
    """Load a supported ledger version, failing closed without upgrading.

    Schema v1 is the first version and has no predecessor upgrader. Both stale
    and future versions are rejected until an explicit dispatcher entry and
    tested upgrader policy exist.
    """

    payload = load_json_object(path)
    if payload is None:
        return None
    version = payload.get("schema_version")
    if isinstance(version, bool) or not isinstance(version, int):
        raise LedgerError("migration ledger schema version is invalid")
    loaders = {LEDGER_SCHEMA_VERSION: _load_schema_v1}
    loader = loaders.get(version)
    if loader is None:
        raise LedgerError(f"unsupported migration ledger schema version: {version}")
    try:
        ledger = loader(payload)
        validate_ledger_path(ledger.destination.migration_root, path)
        return ledger
    except (ValidationError, ValueError) as exc:
        raise LedgerError(f"migration ledger is invalid: {path}") from exc


def save_ledger(
    path: Path,
    ledger: MigrationLedger,
    *,
    expected_generation: int | None,
) -> MigrationLedger:
    """Persist with exclusive locking and generation compare-and-swap."""

    try:
        canonical_path = validate_ledger_path(ledger.destination.migration_root, path)
    except ValueError as exc:
        raise LedgerError(f"migration ledger path is invalid: {path}") from exc

    candidate_identity = _ledger_identity(ledger)

    def read_current(current_path: Path) -> dict[str, Any] | None:
        current = load_ledger(current_path)
        if current is None:
            return None
        if _ledger_identity(current) != candidate_identity:
            raise LedgerError("existing ledger identity differs from candidate")
        return current.model_dump(mode="json")

    persisted = atomic_cas_json(
        canonical_path,
        ledger.model_dump(mode="json"),
        expected_generation=expected_generation,
        read_current=read_current,
    )
    try:
        return _load_schema_v1(persisted)
    except ValidationError as exc:
        raise LedgerError("persisted migration ledger is invalid") from exc


def _load_schema_v1(payload: dict[str, Any]) -> MigrationLedger:
    return MigrationLedger.model_validate_json(json.dumps(payload))


def mark_completed(
    ledger: MigrationLedger,
    destination_evidence: ContentEvidence,
    *,
    completed_at: datetime,
) -> MigrationLedger:
    """Transition a started ledger after a verified atomic destination promote."""

    if ledger.status is not MigrationStatus.STARTED:
        raise LedgerError("only a started migration can be completed")
    if ledger.conflict_outcome is not ConflictOutcome.NONE:
        raise LedgerError("a migration with an unresolved conflict cannot be completed")
    if not ledger.source_evidence.same_content(destination_evidence):
        raise LedgerError("destination evidence does not match the copied source")

    payload = ledger.model_dump(mode="python")
    payload["status"] = MigrationStatus.COMPLETED
    payload["completed_at"] = completed_at
    payload["destination"] = {
        **ledger.destination.model_dump(mode="python"),
        "copied_evidence": destination_evidence,
    }
    try:
        return MigrationLedger.model_validate(payload)
    except ValidationError as exc:
        raise LedgerError("completed migration ledger is invalid") from exc


def record_rollback(
    ledger: MigrationLedger,
    source_evidence: ContentEvidence,
    *,
    recorded_at: datetime,
) -> MigrationLedger:
    """Record container re-entry while preserving both source and native state."""

    if ledger.status is not MigrationStatus.COMPLETED:
        raise LedgerError("rollback can only be recorded for a completed migration")
    payload = ledger.model_dump(mode="python")
    payload["rollback"] = RollbackMetadata(
        recorded_at=recorded_at,
        source_evidence_at_rollback=source_evidence,
    )
    try:
        return MigrationLedger.model_validate(payload)
    except ValidationError as exc:
        raise LedgerError("rollback migration ledger is invalid") from exc


def plan_migration(
    request: MigrationRequest,
    ledger: MigrationLedger | None,
) -> MigrationPlan:
    """Plan copy-out or fail closed without performing any live operation."""

    if ledger is None:
        if request.destination_exists:
            conflict = ConflictOutcome.DESTINATION_EXISTS
            blocked = _new_ledger(request, MigrationStatus.BLOCKED, conflict)
            return _blocked_plan(
                blocked,
                conflict,
                "destination already exists without migration ownership evidence",
            )
        started = _new_ledger(request, MigrationStatus.STARTED)
        return MigrationPlan(
            decision=MigrationDecision.COPY_TO_STAGING,
            reason="no prior ledger or destination; start atomic staging copy",
            ledger=started,
            destination_mutation=DestinationMutation.CREATE_STAGING_COPY,
        )

    if ledger.conflict_outcome is not ConflictOutcome.NONE:
        return _blocked_plan(
            ledger,
            ledger.conflict_outcome,
            "ledger contains an unresolved conflict",
        )

    mismatch = _ledger_mismatch(request, ledger)
    if mismatch is not None:
        conflicted = _with_conflict(ledger, mismatch)
        return _blocked_plan(
            conflicted,
            mismatch,
            "current source or destination identity differs from the ledger",
        )

    copied_evidence = ledger.destination.copied_evidence
    source_diverged = not ledger.source_evidence.same_content(request.source_evidence)
    destination_diverged = (
        request.destination_exists
        and request.destination_evidence is not None
        and copied_evidence is not None
        and not copied_evidence.same_content(request.destination_evidence)
    )
    if ledger.rollback is not None and source_diverged and destination_diverged:
        conflict = ConflictOutcome.SOURCE_AND_DESTINATION_CHANGED_AFTER_ROLLBACK
        conflicted = _with_conflict(ledger, conflict)
        return _blocked_plan(
            conflicted,
            conflict,
            "source and native destination both changed after rollback; "
            "authority requires manual resolution",
        )

    if (
        ledger.rollback is not None
        and not ledger.rollback.source_evidence_at_rollback.same_content(
            request.source_evidence
        )
    ):
        conflict = ConflictOutcome.SOURCE_CHANGED_AFTER_ROLLBACK
        conflicted = _with_conflict(ledger, conflict)
        return _blocked_plan(
            conflicted,
            conflict,
            "source content changed after the rollback checkpoint",
        )

    if not ledger.source_evidence.same_content(request.source_evidence):
        conflict = ConflictOutcome.SOURCE_CHANGED
        conflicted = _with_conflict(ledger, conflict)
        return _blocked_plan(
            conflicted,
            conflict,
            "source content differs from the native copied state",
        )

    if ledger.status is MigrationStatus.STARTED:
        if not request.destination_exists:
            return MigrationPlan(
                decision=MigrationDecision.RESTART_STAGING_COPY,
                reason="prior copy was interrupted; replace only migration-owned staging",
                ledger=ledger,
                destination_mutation=DestinationMutation.REPLACE_OWNED_STAGING_COPY,
            )
        if (
            request.destination_evidence is not None
            and ledger.source_evidence.same_content(request.destination_evidence)
        ):
            completed = mark_completed(
                ledger,
                request.destination_evidence,
                completed_at=request.observed_at,
            )
            return MigrationPlan(
                decision=MigrationDecision.FINALIZE_VERIFIED_COPY,
                reason="destination was promoted before interruption and verifies successfully",
                ledger=completed,
                destination_mutation=DestinationMutation.NONE,
            )
        conflict = (
            ConflictOutcome.DESTINATION_UNVERIFIED
            if request.destination_evidence is None
            else ConflictOutcome.DESTINATION_CONTENT_CHANGED
        )
        return _blocked_plan(
            _with_conflict(ledger, conflict),
            conflict,
            "interrupted migration found an unverified or conflicting destination",
        )

    if ledger.status is MigrationStatus.COMPLETED:
        if not request.destination_exists:
            conflict = ConflictOutcome.DESTINATION_MISSING
            return _blocked_plan(
                _with_conflict(ledger, conflict),
                conflict,
                "completed ledger destination is missing",
            )
        if request.destination_evidence is None:
            conflict = ConflictOutcome.DESTINATION_UNVERIFIED
            return _blocked_plan(
                _with_conflict(ledger, conflict),
                conflict,
                "completed ledger destination cannot be verified",
            )
        expected = ledger.destination.copied_evidence
        if expected is None or not expected.same_content(request.destination_evidence):
            conflict = ConflictOutcome.DESTINATION_CONTENT_CHANGED
            return _blocked_plan(
                _with_conflict(ledger, conflict),
                conflict,
                "completed destination content differs from the ledger",
            )
        return MigrationPlan(
            decision=MigrationDecision.NO_OP,
            reason="source and destination evidence match the completed ledger",
            ledger=ledger,
            destination_mutation=DestinationMutation.NONE,
        )

    return _blocked_plan(
        ledger,
        ledger.conflict_outcome,
        "blocked migration requires manual conflict resolution",
    )


def _new_ledger(
    request: MigrationRequest,
    status: MigrationStatus,
    conflict: ConflictOutcome = ConflictOutcome.NONE,
) -> MigrationLedger:
    started_at = request.observed_at if status is MigrationStatus.STARTED else None
    return MigrationLedger(
        migration_id=request.migration_id,
        source_volume=request.source_volume,
        source_evidence=request.source_evidence,
        destination=DestinationRecord(
            migration_root=request.migration_root,
            path=request.destination_path,
            staging_path=request.staging_path,
        ),
        status=status,
        started_at=started_at,
        completed_at=None,
        conflict_outcome=conflict,
    )


def _ledger_mismatch(
    request: MigrationRequest,
    ledger: MigrationLedger,
) -> ConflictOutcome | None:
    if request.migration_id != ledger.migration_id:
        return ConflictOutcome.LEDGER_MISMATCH
    if request.source_volume != ledger.source_volume:
        return ConflictOutcome.LEDGER_MISMATCH
    if request.migration_root != ledger.destination.migration_root:
        return ConflictOutcome.LEDGER_MISMATCH
    if request.destination_path != ledger.destination.path:
        return ConflictOutcome.LEDGER_MISMATCH
    if request.staging_path != ledger.destination.staging_path:
        return ConflictOutcome.LEDGER_MISMATCH
    return None


def _ledger_identity(ledger: MigrationLedger) -> tuple[object, ...]:
    return (
        ledger.schema_version,
        ledger.migration_id,
        ledger.source_volume,
        ledger.destination.migration_root,
        ledger.destination.path,
        ledger.destination.staging_path,
    )


def _with_conflict(
    ledger: MigrationLedger,
    conflict: ConflictOutcome,
) -> MigrationLedger:
    payload = ledger.model_dump(mode="python")
    payload["conflict_outcome"] = conflict
    return MigrationLedger.model_validate(payload)


def _blocked_plan(
    ledger: MigrationLedger,
    conflict: ConflictOutcome,
    reason: str,
) -> MigrationPlan:
    return MigrationPlan(
        decision=MigrationDecision.BLOCK,
        reason=reason,
        ledger=ledger,
        destination_mutation=DestinationMutation.NONE,
        conflict_outcome=conflict,
    )
