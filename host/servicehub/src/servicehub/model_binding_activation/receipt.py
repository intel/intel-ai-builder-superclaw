"""Secret-free durable evidence for one Model Binding Activation."""

from __future__ import annotations

import asyncio
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import os
from pathlib import Path
import time
import uuid
from typing import Iterator, Literal, cast

from contracts.model_binding_activation_operation import ModelBindingActivationOperation
from contracts.model_binding_activation_request import ModelBindingActivationRequest
from contracts.primary_bundle_commit_request import PrimaryBundleCommitRequest
from contracts.primary_bundle_commit_response import PrimaryBundleCommitResponse
from contracts.primary_bundle_lifecycle_readback import ReasonCode as PrepareReasonCode
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from servicehub.capability.atomic_json import AtomicJsonCorruptionError, atomic_write_json, canonical_json_bytes, read_json_object
from servicehub.model_binding_activation.activation_failure_copy import activation_failure_message

# A failed activation has no outstanding LRM or Profile state. Recovery-required is
# intentionally not terminal: its external outcome is unknown, so it continues
# to reserve the one activation slot until replay/read-back proves a resolution.
_TERMINAL_STATES = frozenset({"succeeded", "failed", "cancelled"})
_NON_RETRYABLE_RUNTIME_ERRORS = frozenset({"runtime_profile_incompatible", "runtime_profile_unreadable"})
# A refused provision fails the receipt only after its Runtime Deployment is revoked and its pending
# Profile discarded, so `resume` has nothing to reopen: the console's Retry starts a new activation.
# Unlike the errors above it is no Profile recovery state, so only the projection treats it as final.
_NOT_RESUMABLE_RUNTIME_ERRORS = _NON_RETRYABLE_RUNTIME_ERRORS | {"runtime_provision_failed"}
_JOURNAL_STATE = Literal["queued", "running", "succeeded", "failed", "cancelled"]
_PREPARE_REASON_CODES = frozenset(member.value for member in PrepareReasonCode)


class ActivationReceiptError(RuntimeError):
    pass


class ActivationReceiptConflict(ActivationReceiptError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class RuntimeRecoveryTarget(BaseModel):
    """Current Profile target for a post-commit recovery attempt.

    The original staged revision remains immutable evidence. A recovered pending
    Profile receives a new monotonic revision, so the receipt records that current
    target separately instead of rewriting the original transition history.
    """

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    profile_revision: int = Field(gt=0)
    product_profile_digest: str = Field(pattern=r"^[0-9a-f]{64}$")


def _public_error(error: dict[str, object] | None) -> dict[str, object] | None:
    if error is None:
        return None
    code = error.get("code")
    if code in {
        "download_confirmation_required",
        "bundle_candidate_changed",
        "idempotency_conflict",
        "model_binding_activation_in_progress",
        "lrm_bundle_revision_conflict",
        "runtime_alignment_conflict",
        "safe_error",
        "feature_not_ready",
        "recovery_required",
        "connect_intent_required",
        "primary_bundle_prepare_in_progress",
        "preparation_recovery_required",
        "pending_bundle_recovery_required",
        "preparation_identity_mismatch",
        "disconnect_not_available",
        "runtime_provision_failed",
    }:
        if code == "safe_error" and "reason_code" in error and error["reason_code"] not in _PREPARE_REASON_CODES:
            # Only a contract reason_code is public; an unknown or null one is dropped.
            return {key: value for key, value in error.items() if key != "reason_code"}
        return error
    return {
        "code": "safe_error",
        "message": str(error.get("message") or activation_failure_message(code)),
    }


_IDENTITY_FIELDS = frozenset({
    "schema_version", "operation_id", "created_at", "app_request", "app_request_sha256",
})
_IMMUTABLE_EVIDENCE_FIELDS = frozenset({
    "prepare_command", "prepare_operation_id", "prepare_readback", "stage_command",
    "abort_command", "commit_command", "commit_result", "commit_readback",
    "activation_result", "target_product_profile",
    "target_profile_revision", "release_command", "release_result",
})
class ModelBindingActivationReceipt(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    schema_version: Literal[3]
    operation_id: str = Field(pattern=r"^hub:activation-[A-Za-z0-9-]+$")
    app_request: ModelBindingActivationRequest
    app_request_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    state: _JOURNAL_STATE
    pct: float = Field(ge=0, le=100)
    created_at: str
    updated_at: str
    finished_at: str | None = None
    target_profile_revision: int | None = Field(default=None, ge=0)
    target_product_profile: Literal["lite", "standard", "pro"] | None = None
    runtime_reconcile_started_at: str | None = None
    runtime_deployment_fingerprint: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    prepare_command: dict[str, object] | None = None
    prepare_operation_id: str | None = None
    prepare_readback: dict[str, object] | None = None
    stage_command: dict[str, object] | None = None
    abort_command: dict[str, object] | None = None
    recovery_evidence: dict[str, object] | None = None
    error: dict[str, object] | None = None
    cancellation_requested: bool = False
    activation_result: Literal["binding_only", "runtime_transition_required"] | None = None
    commit_command: PrimaryBundleCommitRequest | None = None
    commit_result: PrimaryBundleCommitResponse | None = None
    commit_readback: PrimaryBundleCommitResponse | None = None
    # `disconnect` intent only: LRM release evidence (no prepare/commit phase).
    release_command: dict[str, object] | None = None
    release_result: dict[str, object] | None = None


def is_retryable_activation(record: ModelBindingActivationReceipt) -> bool:
    return (
        (record.error or {}).get("code") not in _NOT_RESUMABLE_RUNTIME_ERRORS
        and record.activation_result == "runtime_transition_required"
        and record.commit_readback is not None
        and record.target_product_profile is not None
        and record.target_profile_revision is not None
    )


def runtime_recovery_target(record: ModelBindingActivationReceipt) -> RuntimeRecoveryTarget | None:
    evidence = record.recovery_evidence or {}
    profile_revision = evidence.get("target_profile_revision")
    product_profile_digest = evidence.get("product_profile_digest")
    if not isinstance(profile_revision, int) or not isinstance(product_profile_digest, str):
        return None
    return RuntimeRecoveryTarget(
        profile_revision=profile_revision,
        product_profile_digest=product_profile_digest,
    )


def _is_prepare_success_upgrade(current: object, replacement: object) -> bool:
    if not isinstance(current, dict) or not isinstance(replacement, dict):
        return False
    if current.get("state") not in {"queued", "running"} or replacement.get("state") != "succeeded":
        return False
    identity_fields = (
        "contract_version",
        "correlation_operation_id",
        "prepare_operation_id",
        "idempotency_key",
        "candidate_revision",
        "expected_bundle_revision",
        "bundle_revision",
        "target_bundle",
    )
    return all(current.get(field) == replacement.get(field) for field in identity_fields)


class ModelBindingActivationReceiptStore:
    """Own file-per-operation identity, projection, and in-process single-flight."""

    def __init__(self, data_dir: Path) -> None:
        self._directory = Path(data_dir) / "model-binding-activations" / "operations"
        self._lock = asyncio.Lock()
        self._recovery_gate = False

    async def create_or_join(self, request: ModelBindingActivationRequest) -> tuple[ModelBindingActivationReceipt, bool]:
        async with self._lock:
            return await asyncio.to_thread(self._create_or_join, request)

    async def get(self, operation_id: str) -> ModelBindingActivationReceipt | None:
        async with self._lock:
            return await asyncio.to_thread(self._read, self._path(operation_id))

    async def update(self, record: ModelBindingActivationReceipt, **changes: object) -> ModelBindingActivationReceipt:
        async with self._lock:
            return await asyncio.to_thread(self._update, record, changes)

    async def scan(self) -> list[ModelBindingActivationReceipt]:
        """Claim durable work on startup without inventing a second operation."""
        async with self._lock:
            return await asyncio.to_thread(self._scan_records)

    async def find_latest_non_retryable_runtime_failure(self) -> ModelBindingActivationReceipt | None:
        async with self._lock:
            return await asyncio.to_thread(self._find_latest_non_retryable_runtime_failure)

    def _create_or_join(self, request: ModelBindingActivationRequest) -> tuple[ModelBindingActivationReceipt, bool]:
        with self._file_lock():
            records = self._scan_records()
            if self._recovery_gate:
                raise ActivationReceiptConflict("recovery_required")
            digest = _digest(request)
            for record in records:
                if record.app_request.root.idempotency_key == request.root.idempotency_key:
                    if record.app_request_sha256 != digest:
                        raise ActivationReceiptConflict("idempotency_conflict")
                    return record, False
            active = [record for record in records if record.state not in _TERMINAL_STATES]
            if len(active) > 1:
                raise ActivationReceiptConflict("recovery_required")
            if active:
                raise ActivationReceiptConflict("model_binding_activation_in_progress")
            now = _timestamp()
            record = ModelBindingActivationReceipt(
                schema_version=3, operation_id=f"hub:activation-{uuid.uuid4()}", app_request=request,
                app_request_sha256=digest, state="queued", pct=0,
                created_at=now, updated_at=now,
            )
            self._write(record)
            return record, True

    def _update(self, record: ModelBindingActivationReceipt, changes: dict[str, object]) -> ModelBindingActivationReceipt:
        with self._file_lock():
            current = self._read(self._path(record.operation_id))
            if current is None or current != record:
                raise ActivationReceiptError("receipt compare-and-swap failed")
            if _IDENTITY_FIELDS.intersection(changes):
                raise ActivationReceiptError("receipt identity is immutable")
            for field in _IMMUTABLE_EVIDENCE_FIELDS.intersection(changes):
                current_value = getattr(record, field)
                if (
                    current_value is not None
                    and changes[field] != current_value
                    and not (
                        field == "prepare_readback"
                        and _is_prepare_success_upgrade(current_value, changes[field])
                    )
                    and not (
                        # Allow resetting prepare_operation_id to
                        # None when prepare_readback has never been written â€” the
                        # prepare was interrupted before a durable success was proven,
                        # so there is nothing to protect yet.
                        field == "prepare_operation_id"
                        and changes[field] is None
                        and record.prepare_readback is None
                    )
                ):
                    raise ActivationReceiptError(f"receipt {field} is immutable once recorded")
            try:
                # Validate the canonical wire form. Pydantic strict Python mode
                # rejects enum strings emitted by generated nested contracts.
                json_changes = {key: _json_value(value) for key, value in changes.items()}
                updated = ModelBindingActivationReceipt.model_validate_json(
                    canonical_json_bytes(record.model_dump(mode="json") | json_changes | {"updated_at": _timestamp()}), strict=True
                )
            except ValidationError as exc:
                raise ActivationReceiptError("receipt update violates frozen model") from exc
            self._write(updated)
            return updated

    def to_projection(self, record: ModelBindingActivationReceipt) -> dict[str, object]:
        payload: dict[str, object] = {"contract_version": 1, "operation_id": record.operation_id}
        if record.state == "succeeded":
            payload.update({
                "status": "succeeded",
                "runtime_transition_required": record.activation_result == "runtime_transition_required",
            })
        elif record.state in _TERMINAL_STATES:
            error = _public_error(record.error) or {
                "code": "safe_error",
                "message": (
                    "Model Binding Activation was cancelled."
                    if record.state == "cancelled"
                    else activation_failure_message("safe_error")
                ),
            }
            payload.update({"status": "failed", "error": error, "retryable": is_retryable_activation(record)})
        else:
            if record.commit_readback is not None and record.activation_result == "runtime_transition_required":
                stage = "aligning_runtime"
            elif record.activation_result is not None or record.commit_command is not None:
                stage = "activating"
            else:
                stage = "preparing"
            progress: dict[str, object] = {"pct": record.pct}
            if record.prepare_operation_id:
                progress["lrm_prepare_operation_id"] = record.prepare_operation_id
            payload.update({"status": "applying", "stage": stage, "progress": progress})
        try:
            projection = ModelBindingActivationOperation.model_validate(payload).root.model_dump(
                mode="json", exclude_none=True
            )
        except ValidationError as exc:
            raise ActivationReceiptError("receipt projection violates generated contract") from exc
        return projection

    def _records(self) -> list[ModelBindingActivationReceipt]:
        if not self._directory.exists():
            return []
        records: list[ModelBindingActivationReceipt] = []
        for path in self._directory.glob("hub-activation-*.json"):
            record = self._read(path)
            if record is None:
                raise ActivationReceiptError("receipt_store disappeared during scan")
            records.append(record)
        return records

    def _scan_records(self) -> list[ModelBindingActivationReceipt]:
        try:
            records = self._records()
        except ActivationReceiptError:
            self._recovery_gate = True
            raise
        active = [record for record in records if record.state not in _TERMINAL_STATES]
        if len(active) > 1:
            self._recovery_gate = True
        return records

    def _find_latest_non_retryable_runtime_failure(self) -> ModelBindingActivationReceipt | None:
        latest_transition: ModelBindingActivationReceipt | None = None
        if not self._directory.exists():
            return None
        for path in self._directory.glob("hub-activation-*.json"):
            try:
                record = self._read(path)
            except ActivationReceiptError:
                continue
            if (
                record is None
                or record.activation_result != "runtime_transition_required"
                or record.commit_readback is None
            ):
                continue
            if latest_transition is None or record.created_at > latest_transition.created_at:
                latest_transition = record
        if (
            latest_transition is not None
            and latest_transition.state == "failed"
            and (latest_transition.error or {}).get("code") in _NON_RETRYABLE_RUNTIME_ERRORS
        ):
            return latest_transition
        return None

    def _path(self, operation_id: str) -> Path:
        # Windows forbids ':' in file names; the validated operation id remains
        # inside the durable record while its filename uses an unambiguous form.
        return self._directory / f"{operation_id.replace(':', '-')}.json"

    def _read(self, path: Path) -> ModelBindingActivationReceipt | None:
        try:
            raw = read_json_object(path)
            if raw is None:
                return None
            try:
                return ModelBindingActivationReceipt.model_validate_json(canonical_json_bytes(raw), strict=True)
            except ValidationError:
                raise
        except AtomicJsonCorruptionError as exc:
            raise ActivationReceiptError(
                f"invalid activation receipt path={path}: corrupt JSON ({exc})"
            ) from exc
        except ValidationError as exc:
            operation_id = raw.get("operation_id", "?")
            raise ActivationReceiptError(
                f"invalid activation receipt path={path} operation_id={operation_id}: {exc}"
            ) from exc

    def _write(self, record: ModelBindingActivationReceipt) -> None:
        atomic_write_json(self._path(record.operation_id), record.model_dump(mode="json", exclude_none=True))

    @contextmanager
    def _file_lock(self) -> Iterator[None]:
        """Serialize receipt_store CAS across Hub processes, not only asyncio tasks."""
        self._directory.mkdir(parents=True, exist_ok=True)
        lock_path = self._directory.parent / ".operations.lock"
        # "a+b" ignores seek(0) on write and always appends, so this file grew
        # by one byte per acquisition forever (harmless -- only byte 0 is ever
        # locked -- but unbounded, and it looks corrupt during triage). "r+b"
        # honors seek(0); touch first so "r+b" has a file to open.
        lock_path.touch(exist_ok=True)
        with lock_path.open("r+b") as lock_file:
            lock_file.seek(0)
            lock_file.write(b"0")
            lock_file.flush()
            lock_file.seek(0)
            while True:
                try:
                    if os.name == "nt":
                        import msvcrt
                        msvcrt.locking(lock_file.fileno(), msvcrt.LK_NBLCK, 1)
                    else:
                        import fcntl
                        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except OSError:
                    time.sleep(0.01)
            try:
                yield
            finally:
                lock_file.seek(0)
                if os.name == "nt":
                    import msvcrt
                    msvcrt.locking(lock_file.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


def _json_value(value: object) -> object:
    if isinstance(value, BaseModel):
        return cast(BaseModel, value).model_dump(mode="json")
    return value


def _digest(request: ModelBindingActivationRequest) -> str:
    return hashlib.sha256(canonical_json_bytes(request.model_dump(mode="json", exclude_none=True))).hexdigest()


def _timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
