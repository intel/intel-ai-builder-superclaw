"""Import a SuperClaw 1.x install's OpenCode sessions once, before the native runtime role starts.

The `state_migration` ledger decides; this adapter observes, copies and promotes, and first renames aside a
native database that holds no sessions, or database sidecars without a database. A completed or blocked
ledger is final; a completed one also has the imported distro unregistered, on a later start. No outcome
raises, and none stops the native start.
"""

from __future__ import annotations

import contextlib
import dataclasses
import errno
import hashlib
import json
import os
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path, PurePath

from loguru import logger

from sandbox_manager.owner_dpapi import atomic_write
from sandbox_manager.state_migration import (
    ConflictOutcome,
    ContentEvidence,
    MigrationDecision,
    MigrationLedger,
    MigrationRequest,
    MigrationStatus,
    SourceVolumeIdentity,
    load_ledger,
    mark_completed,
    plan_migration,
    save_ledger,
)
from sandbox_manager.state_migration_io import LedgerError, canonical_migration_paths, validate_ledger_path

from .copy_out import (
    CopyOutFailure,
    Spawn,
    copy_out,
    locate_wsl_exe,
    spawn_process,
    tar_command,
    terminate_distro,
    unregister_distro,
)
from .detect import WslDistro, find_v1_distro
from .opencode_db import DATABASE_NAME, ImportDatabaseError, count_user_rows, prepare_import_database
from .outcome import FINAL_REASONS, RewriteSummary, V1ImportOutcome, V1ImportReason, V1ImportResult

MIGRATION_ID = "v1-wsl-opencode-sessions"
DATA_VOLUME = "superclaw-workspace-data"
MEMBERS = (f"opencode/{DATABASE_NAME}", f"opencode/{DATABASE_NAME}-wal")
MAX_STREAM_BYTES = 2 << 30
# Long enough for WSL to boot a cold VM before `tar` writes anything.
FIRST_BYTE_DEADLINE_S = 45.0
STALL_TIMEOUT_S = 30.0
TERMINATE_TIMEOUT_S = 10.0
UNREGISTER_TIMEOUT_S = 30.0
MAX_FAILED_ATTEMPTS = 3
_SIDECARS = ("-wal", "-shm", "-journal")
_STAGED_NAMES = tuple(f"{DATABASE_NAME}{suffix}" for suffix in ("", *_SIDECARS))


@dataclass(frozen=True)
class _Layout:
    root: Path
    ledger: Path
    attempts: Path
    destination: Path
    staging: Path

    @classmethod
    def under(cls, data_root: Path) -> _Layout:
        migrations = data_root.parent / "migrations"
        opencode = data_root / "file_tool" / "opencode"
        return cls(
            root=data_root.parent,
            ledger=migrations / f"{MIGRATION_ID}.json",
            attempts=migrations / f"{MIGRATION_ID}.attempts.json",
            destination=opencode / DATABASE_NAME,
            staging=opencode / "v1-import-staging",
        )


def _utc_now() -> datetime:
    return datetime.now(UTC)


def _start_background(task: Callable[[], None]) -> None:
    threading.Thread(target=task, name="v1-import-unregister", daemon=True).start()


def import_v1_state_once(
    *,
    data_root: Path,
    workspace_root: PurePath,
    find_distro: Callable[[], WslDistro | None] = find_v1_distro,
    locate_wsl: Callable[[], str | None] = locate_wsl_exe,
    spawn: Spawn = spawn_process,
    now: Callable[[], datetime] = _utc_now,
    background: Callable[[Callable[[], None]], None] = _start_background,
) -> V1ImportResult:
    started = time.monotonic()
    layout = _Layout.under(data_root)
    try:
        result = _import(layout, workspace_root, find_distro, locate_wsl, spawn, now, background)
    except Exception as error:  # noqa: BLE001 - the native start goes on whatever happens here
        logger.opt(exception=error).warning("v1-import: unexpected {}", type(error).__name__)
        result = _failed(V1ImportReason.UNEXPECTED_ERROR, type(error).__name__)
    if result.outcome is V1ImportOutcome.IMPORTED or isinstance(result.reason, ConflictOutcome):
        _close_attempts(layout)
    elif result.outcome is not V1ImportOutcome.SKIPPED and isinstance(result.reason, V1ImportReason):
        _record_attempt(layout, result.reason)
    _log(result, time.monotonic() - started)
    return result


def _import(
    layout: _Layout,
    workspace_root: PurePath,
    find_distro: Callable[[], WslDistro | None],
    locate_wsl: Callable[[], str | None],
    spawn: Spawn,
    now: Callable[[], datetime],
    background: Callable[[Callable[[], None]], None],
) -> V1ImportResult:
    try:
        ledger = load_ledger(layout.ledger)
    except LedgerError as error:
        return _failed(V1ImportReason.LEDGER_UNREADABLE, str(error))
    if ledger is not None and ledger.conflict_outcome is not ConflictOutcome.NONE:
        return V1ImportResult(V1ImportOutcome.SKIPPED, V1ImportReason.LEDGER_BLOCKED, str(ledger.conflict_outcome))
    if ledger is not None and ledger.status is MigrationStatus.COMPLETED:
        return _remove_imported_distro(layout, ledger, find_distro, locate_wsl, spawn, background)
    attempts = _read_attempts(layout)
    if attempts.last_reason in FINAL_REASONS or attempts.count >= MAX_FAILED_ATTEMPTS:
        return V1ImportResult(
            V1ImportOutcome.SKIPPED,
            V1ImportReason.ATTEMPTS_EXHAUSTED,
            f"{attempts.count} attempts, last {attempts.last_reason}",
        )
    distro = find_distro()
    if distro is None:
        return V1ImportResult(V1ImportOutcome.SKIPPED, V1ImportReason.NO_V1_INSTALL)
    try:
        canonical_migration_paths(str(layout.root), str(layout.destination), str(layout.staging))
        validate_ledger_path(str(layout.root), layout.ledger)
    except ValueError as error:
        return _failed(V1ImportReason.MIGRATION_ROOT_UNTRUSTED, str(error))
    in_use = None if ledger is not None else _native_database_in_use(layout.destination)
    if in_use is not None:
        return in_use
    wsl_exe = locate_wsl()
    if wsl_exe is None:
        return _failed(V1ImportReason.WSL_UNAVAILABLE, "no wsl.exe under SystemRoot")
    try:
        _reset_staging(layout.staging)
    except OSError as error:
        return _failed(V1ImportReason.STAGING_UNCLEAN, f"{type(error).__name__}: {error}")
    try:
        staged = _copy_out(spawn, wsl_exe, distro, layout.staging).get(MEMBERS[0])
        if staged is None:
            return V1ImportResult(V1ImportOutcome.NOTHING_TO_IMPORT, V1ImportReason.SOURCE_ABSENT)
        summary = prepare_import_database(staged, workspace_root=workspace_root)
        return _settle(layout, ledger, distro, staged, summary, now)
    except CopyOutFailure as failure:
        return _failed(failure.reason, failure.detail)
    except ImportDatabaseError as error:
        reason = V1ImportReason.STAGING_IO_FAILED if error.retryable else V1ImportReason.SOURCE_DATABASE_INVALID
        return _failed(reason, str(error))
    finally:
        _clear_staging(layout.staging)


def _remove_imported_distro(
    layout: _Layout,
    ledger: MigrationLedger,
    find_distro: Callable[[], WslDistro | None],
    locate_wsl: Callable[[], str | None],
    spawn: Spawn,
    background: Callable[[Callable[[], None]], None],
) -> V1ImportResult:
    """Unregister the distro a completed import copied from, on a start after the import's own.

    Only that distro (the registry GUID the ledger recorded), and only while the imported database is still
    where it was put: after a backend reset the distro stays. What the import did not carry goes with it,
    among it v1's logs and any credential files. `wsl.exe` runs in the background, so the native start never
    waits for it; a failed run is tried again on the next start.
    """
    done = V1ImportResult(V1ImportOutcome.SKIPPED, V1ImportReason.LEDGER_COMPLETED)
    distro = find_distro()
    if distro is None or not layout.destination.is_file():
        return done
    if _source_volume(distro).identity_sha256 != ledger.source_volume.identity_sha256:
        return dataclasses.replace(done, detail=f"{distro.name} is not the distro that was imported, left in place")
    wsl_exe = locate_wsl()
    if wsl_exe is None:
        return dataclasses.replace(done, detail="no wsl.exe under SystemRoot, distro left in place")

    def unregister() -> None:
        if unregister_distro(spawn=spawn, wsl_exe=wsl_exe, distro=distro.name, timeout_s=UNREGISTER_TIMEOUT_S):
            logger.info("v1-import: unregistered {}", distro.name)
        else:
            logger.warning("v1-import: wsl.exe --unregister {} did not report success", distro.name)

    background(unregister)
    return dataclasses.replace(done, detail=f"unregistering {distro.name} in the background")


def _native_database_in_use(destination: Path) -> V1ImportResult | None:
    """Settle before WSL starts when a native database holds sessions, or cannot be shown not to."""
    if not (destination.exists() or destination.is_symlink()):
        return None
    if destination.is_symlink() or not destination.is_file():
        return _failed(V1ImportReason.NATIVE_DATABASE_UNREADABLE, f"{destination.name} is not a regular file")
    try:
        rows = count_user_rows(destination)
    except ImportDatabaseError as error:
        return _failed(V1ImportReason.NATIVE_DATABASE_UNREADABLE, str(error))
    if rows:
        return V1ImportResult(
            V1ImportOutcome.BLOCKED, V1ImportReason.NATIVE_SESSIONS_EXIST, f"{rows} session and message rows"
        )
    return None


def _copy_out(spawn: Spawn, wsl_exe: str, distro: WslDistro, staging: Path) -> dict[str, Path]:
    """Stop the distro before the copy, so a running v1 cannot write the volume under `tar`, and after it."""
    if not terminate_distro(spawn=spawn, wsl_exe=wsl_exe, distro=distro.name, timeout_s=TERMINATE_TIMEOUT_S):
        raise CopyOutFailure(
            V1ImportReason.DISTRO_NOT_STOPPED, f"wsl.exe --terminate {distro.name} did not report success"
        )
    try:
        return copy_out(
            spawn=spawn,
            argv=tar_command(wsl_exe, distro.name, DATA_VOLUME, MEMBERS),
            members=MEMBERS,
            staging=staging,
            max_bytes=MAX_STREAM_BYTES,
            first_byte_s=FIRST_BYTE_DEADLINE_S,
            stall_s=STALL_TIMEOUT_S,
        )
    finally:
        if not terminate_distro(spawn=spawn, wsl_exe=wsl_exe, distro=distro.name, timeout_s=TERMINATE_TIMEOUT_S):
            logger.warning("v1-import: wsl.exe --terminate {} did not report success", distro.name)


def _settle(
    layout: _Layout,
    ledger: MigrationLedger | None,
    distro: WslDistro,
    staged: Path,
    summary: RewriteSummary,
    now: Callable[[], datetime],
) -> V1ImportResult:
    try:
        _set_aside_empty_destination(layout, ledger, now())
    except ImportDatabaseError as error:
        return _failed(V1ImportReason.NATIVE_DATABASE_UNREADABLE, str(error), summary)
    except OSError as error:
        return _failed(V1ImportReason.SET_ASIDE_FAILED, f"{type(error).__name__}: {error}", summary)
    observed = now()
    destination = layout.destination
    verifiable = ledger is not None and destination.is_file() and not destination.is_symlink()
    plan = plan_migration(
        MigrationRequest(
            migration_id=MIGRATION_ID,
            source_volume=_source_volume(distro),
            source_evidence=_file_evidence(staged, observed),
            migration_root=str(layout.root),
            destination_path=str(destination),
            staging_path=str(layout.staging),
            destination_exists=destination.exists() or destination.is_symlink(),
            destination_evidence=_file_evidence(destination, observed) if verifiable else None,
            observed_at=observed,
        ),
        ledger,
    )
    try:
        layout.ledger.parent.mkdir(exist_ok=True)
    except OSError as error:
        return _failed(V1ImportReason.LEDGER_WRITE_FAILED, f"{type(error).__name__}: {error}", summary)
    try:
        if plan.decision in (MigrationDecision.BLOCK, MigrationDecision.FINALIZE_VERIFIED_COPY):
            save_ledger(layout.ledger, plan.ledger, expected_generation=None if ledger is None else ledger.generation)
            if plan.decision is MigrationDecision.BLOCK:
                return V1ImportResult(V1ImportOutcome.BLOCKED, plan.conflict_outcome, plan.reason, summary)
            return V1ImportResult(V1ImportOutcome.IMPORTED, plan.decision, summary=summary)
        persisted = (
            plan.ledger
            if plan.decision is MigrationDecision.RESTART_STAGING_COPY
            else save_ledger(layout.ledger, plan.ledger, expected_generation=None)
        )
        try:
            _promote(staged, destination)
        except OSError as error:
            return _failed(V1ImportReason.PROMOTE_FAILED, f"{type(error).__name__}: {error}", summary)
        completed_at = now()
        completed = mark_completed(persisted, _file_evidence(destination, completed_at), completed_at=completed_at)
        save_ledger(layout.ledger, completed, expected_generation=persisted.generation)
    except LedgerError as error:
        return _failed(V1ImportReason.LEDGER_WRITE_FAILED, str(error), summary)
    return V1ImportResult(V1ImportOutcome.IMPORTED, plan.decision, summary=summary)


def _promote(staged: Path, destination: Path) -> None:
    """A hard link never replaces an existing file, so native data that appeared meanwhile survives.

    SQLite replays a `-wal` or `-journal` it finds beside a database into it, so any sidecar there stops this.
    """
    for sidecar in _SIDECARS:
        if _occupied(name := destination.with_name(destination.name + sidecar)):
            raise FileExistsError(errno.EEXIST, "a database sidecar is in the way", str(name))
    os.link(staged, destination)
    staged.unlink()


def _set_aside_empty_destination(layout: _Layout, ledger: MigrationLedger | None, at: datetime) -> None:
    """Rename a native database without sessions or messages, or sidecars without a database, out of the way.

    This import's own copy stays. Nothing is deleted. Sidecars move before the database: a `-wal` or
    `-journal` left behind would be replayed into the next database created under that name.
    """
    destination = layout.destination
    if _occupied(destination):
        if destination.is_symlink() or not destination.is_file():
            return
        if ledger is not None and ledger.source_evidence.same_content(_file_evidence(destination, at)):
            return
        if count_user_rows(destination):
            return
    elif not any(_occupied(destination.with_name(destination.name + sidecar)) for sidecar in _SIDECARS):
        return
    stem = f"{destination.name}.set-aside-{at.strftime('%Y%m%dT%H%M%SZ')}"
    target = destination.with_name(stem)
    suffix = 1
    while any(_occupied(target.with_name(target.name + sidecar)) for sidecar in ("", *_SIDECARS)):
        suffix += 1
        target = destination.with_name(f"{stem}-{suffix}")
    _record_set_aside(layout, target)
    moved: list[str] = []
    for sidecar in (*_SIDECARS, ""):
        source = destination.with_name(destination.name + sidecar)
        if _occupied(source):
            source.rename(target.with_name(target.name + sidecar))
            moved.append(source.name)
    logger.info("v1-import: set aside native {} as {}", " ".join(moved), target.name)


def _occupied(path: Path) -> bool:
    return path.exists() or path.is_symlink()


def _source_volume(distro: WslDistro) -> SourceVolumeIdentity:
    identity = f"wsl:{distro.guid.casefold()}:{DATA_VOLUME}".encode()
    return SourceVolumeIdentity(
        name=DATA_VOLUME, driver="local", scope="local", identity_sha256=hashlib.sha256(identity).hexdigest()
    )


def _file_evidence(path: Path, captured_at: datetime) -> ContentEvidence:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as handle:
        while chunk := handle.read(1 << 20):
            digest.update(chunk)
            size += len(chunk)
    tree = digest.hexdigest()
    manifest = hashlib.sha256(f"{tree}  {size}  {DATABASE_NAME}\n".encode()).hexdigest()
    return ContentEvidence(
        tree_sha256=tree, manifest_sha256=manifest, file_count=1, total_bytes=size, captured_at=captured_at
    )


def _reset_staging(staging: Path) -> None:
    """Remove only what an earlier run leaves in staging; anything else there stops this attempt."""
    for name in _STAGED_NAMES:
        (staging / name).unlink(missing_ok=True)
    with contextlib.suppress(FileNotFoundError):
        staging.rmdir()
    staging.mkdir(parents=True)


def _clear_staging(staging: Path) -> None:
    for name in _STAGED_NAMES:
        with contextlib.suppress(OSError):
            (staging / name).unlink(missing_ok=True)
    with contextlib.suppress(OSError):
        staging.rmdir()


@dataclass(frozen=True)
class _Attempts:
    count: int = 0
    last_reason: str = ""
    set_aside: tuple[str, ...] = ()


_UNREADABLE_ATTEMPTS = _Attempts(MAX_FAILED_ATTEMPTS, "unreadable attempt record")


def _read_attempts(layout: _Layout) -> _Attempts:
    try:
        payload = json.loads(layout.attempts.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return _Attempts()
    except (OSError, ValueError):
        return _UNREADABLE_ATTEMPTS
    if not isinstance(payload, dict):
        return _UNREADABLE_ATTEMPTS
    count, last_reason, set_aside = payload.get("attempts"), payload.get("last_reason"), payload.get("set_aside", [])
    if (
        not isinstance(count, int)
        or isinstance(count, bool)
        or not isinstance(last_reason, str)
        or not isinstance(set_aside, list)
        or not all(isinstance(path, str) for path in set_aside)
    ):
        return _UNREADABLE_ATTEMPTS
    return _Attempts(count, last_reason, tuple(set_aside))


def _write_attempts(layout: _Layout, attempts: _Attempts) -> None:
    payload = {
        "schema_version": 1,
        "attempts": attempts.count,
        "last_reason": attempts.last_reason,
        "set_aside": list(attempts.set_aside),
    }
    with contextlib.suppress(OSError, ValueError):
        validate_ledger_path(str(layout.root), layout.attempts)
        atomic_write(layout.attempts, json.dumps(payload).encode("utf-8"))


def _record_attempt(layout: _Layout, reason: V1ImportReason) -> None:
    attempts = _read_attempts(layout)
    _write_attempts(
        layout,
        dataclasses.replace(
            attempts, count=attempts.count + 1, last_reason=str(reason), set_aside=_present(attempts.set_aside)
        ),
    )


def _record_set_aside(layout: _Layout, path: Path) -> None:
    attempts = _read_attempts(layout)
    _write_attempts(layout, dataclasses.replace(attempts, set_aside=(*_present(attempts.set_aside), str(path))))


def _close_attempts(layout: _Layout) -> None:
    """The ledger decides from here on; a record that names set-aside databases stays as their record."""
    attempts = _read_attempts(layout)
    if set_aside := _present(attempts.set_aside):
        _write_attempts(layout, dataclasses.replace(attempts, set_aside=set_aside))
        return
    with contextlib.suppress(OSError):
        layout.attempts.unlink(missing_ok=True)


def _present(set_aside: tuple[str, ...]) -> tuple[str, ...]:
    """A name is recorded before anything is renamed to it, so a rename that failed leaves it behind."""
    return tuple(path for path in set_aside if _names_anything(path))


def _names_anything(path: str) -> bool:
    """A name that cannot be inspected is kept: these run outside the catch-all, and must not drop a file."""
    try:
        return any(_occupied(Path(path + suffix)) for suffix in ("", *_SIDECARS))
    except OSError:
        return True


def _failed(reason: V1ImportReason, detail: str, summary: RewriteSummary | None = None) -> V1ImportResult:
    return V1ImportResult(V1ImportOutcome.FAILED, reason, detail, summary)


def _log(result: V1ImportResult, elapsed_s: float) -> None:
    summary = result.summary
    counts = (
        ""
        if summary is None
        else f" sessions={summary.sessions} rewritten={summary.rewritten} unmapped={summary.unmapped}"
        f" credential_rows={summary.credential_rows}"
    )
    log = logger.warning if result.outcome in (V1ImportOutcome.FAILED, V1ImportOutcome.BLOCKED) else logger.info
    log(
        "v1-import: outcome={} reason={}{} duration_ms={}{}",
        result.outcome,
        result.reason,
        counts,
        round(elapsed_s * 1000),
        f" detail={result.detail!r}" if result.detail else "",
    )
