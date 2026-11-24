"""Filesystem safety primitives for the native state-migration contract.

The caller supplies one pre-created, host-owned migration root. Paths are
accepted only in canonical absolute form beneath that root. Ledger writes use
an exclusive lock, generation compare-and-swap, unique same-directory
temporary files, and atomic replacement. Temporary files are never recovery
sources: an exclusive writer removes them before writing fresh validated bytes.
"""

from __future__ import annotations

import json
import os
import stat
import tempfile
import time
from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager
from pathlib import Path
from typing import Any


class LedgerError(RuntimeError):
    """Raised when migration state or persistence cannot be trusted."""


def canonical_migration_paths(
    migration_root: str,
    destination_path: str,
    staging_path: str,
) -> tuple[str, str, str]:
    """Validate canonical, distinct paths beneath one owned migration root."""

    root = _canonical_root(Path(migration_root))
    destination = _canonical_child(root, Path(destination_path), "destination")
    staging = _canonical_child(root, Path(staging_path), "staging")
    if _path_key(destination) == _path_key(staging):
        raise ValueError("destination and staging paths must be distinct")
    return str(root), str(destination), str(staging)


def validate_ledger_path(migration_root: str, ledger_path: Path) -> Path:
    """Require a canonical ledger path beneath the owned migration root."""

    root = _canonical_root(Path(migration_root))
    return _canonical_child(root, ledger_path, "ledger")


def load_json_object(path: Path) -> dict[str, Any] | None:
    """Read only the committed ledger path; temporary bytes are ignored."""

    if not path.exists():
        if path.is_symlink():
            raise LedgerError(f"migration ledger path is untrusted: {path}")
        return None
    try:
        _reject_reparse(path, "ledger")
    except ValueError as exc:
        raise LedgerError(f"migration ledger path is untrusted: {path}") from exc
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise LedgerError(f"migration ledger is invalid: {path}") from exc
    if not isinstance(payload, dict):
        raise LedgerError(f"migration ledger is invalid: {path}")
    return payload


def atomic_cas_json(
    path: Path,
    payload: Mapping[str, Any],
    *,
    expected_generation: int | None,
    read_current: Callable[[Path], Mapping[str, Any] | None],
    lock_timeout_seconds: float = 0.0,
) -> dict[str, Any]:
    """Persist JSON under a lock if the committed generation still matches."""

    if expected_generation is not None and expected_generation < 0:
        raise LedgerError("expected ledger generation must be non-negative")
    temp_path: Path | None = None
    with ledger_write_lock(path, timeout_seconds=lock_timeout_seconds):
        _cleanup_stale_temps(path)
        current = read_current(path)
        current_generation = None if current is None else current.get("generation")
        if current is None:
            if expected_generation is not None:
                raise LedgerError("ledger compare-and-swap failed: ledger is missing")
            next_generation = 0
        else:
            if (
                isinstance(current_generation, bool)
                or not isinstance(current_generation, int)
                or current_generation < 0
            ):
                raise LedgerError("ledger compare-and-swap failed: invalid generation")
            if expected_generation is None or current_generation != expected_generation:
                raise LedgerError("ledger compare-and-swap failed: stale writer")
            next_generation = current_generation + 1

        candidate = dict(payload)
        candidate_generation = candidate.get("generation")
        if candidate_generation != (0 if current is None else expected_generation):
            raise LedgerError("candidate ledger generation is stale")
        candidate["generation"] = next_generation
        encoded = (json.dumps(candidate, indent=2, default=str) + "\n").encode("utf-8")
        try:
            descriptor, temp_name = tempfile.mkstemp(
                prefix=f".{path.name}.",
                suffix=".tmp",
                dir=path.parent,
            )
            temp_path = Path(temp_name)
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(encoded)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temp_path, path)
            temp_path = None
            _fsync_directory(path.parent)
        except OSError as exc:
            raise LedgerError(f"could not persist migration ledger: {path}") from exc
        finally:
            if temp_path is not None:
                try:
                    temp_path.unlink(missing_ok=True)
                except OSError:
                    pass
        return candidate


@contextmanager
def ledger_write_lock(
    ledger_path: Path,
    *,
    timeout_seconds: float = 0.0,
) -> Iterator[None]:
    """Hold the ledger's explicit cross-process single-writer lock."""

    if timeout_seconds < 0:
        raise LedgerError("lock timeout must be non-negative")
    lock_path = ledger_path.with_name(f".{ledger_path.name}.lock")
    _reject_reparse_if_present(lock_path, "ledger lock")
    flags = os.O_RDWR | os.O_CREAT
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(lock_path, flags, 0o600)
    except OSError as exc:
        raise LedgerError(f"could not open migration ledger lock: {lock_path}") from exc

    acquired = False
    body_error: BaseException | None = None
    try:
        _reject_descriptor_reparse(descriptor, "ledger lock")
        if os.fstat(descriptor).st_size == 0:
            os.write(descriptor, b"\0")
            os.fsync(descriptor)
        deadline = time.monotonic() + timeout_seconds
        while True:
            try:
                _lock_descriptor(descriptor)
                acquired = True
                break
            except OSError as exc:
                if time.monotonic() >= deadline:
                    raise LedgerError("migration ledger writer lock is unavailable") from exc
                time.sleep(min(0.01, max(0.0, deadline - time.monotonic())))
        try:
            yield
        except BaseException as exc:
            body_error = exc
            raise
    finally:
        release_error: OSError | None = None
        if acquired:
            try:
                _unlock_descriptor(descriptor)
            except OSError as exc:
                release_error = exc
        os.close(descriptor)
        if release_error is not None and body_error is None:
            raise LedgerError("migration ledger writer lock release is uncertain") from release_error


def _canonical_root(path: Path) -> Path:
    _reject_lexical_alias(path, "migration root")
    try:
        resolved = path.resolve(strict=True)
    except OSError as exc:
        raise ValueError("migration root must exist and be resolvable") from exc
    if str(path) != str(resolved):
        raise ValueError("migration root must use its canonical path")
    if not resolved.is_dir():
        raise ValueError("migration root must be a directory")
    _reject_reparse_chain(resolved, "migration root")
    return resolved


def _canonical_child(root: Path, path: Path, label: str) -> Path:
    _reject_lexical_alias(path, label)
    try:
        resolved = path.resolve(strict=False)
    except OSError as exc:
        raise ValueError(f"{label} path cannot be resolved") from exc
    if str(path) != str(resolved):
        raise ValueError(f"{label} path must use its canonical path")
    try:
        resolved.relative_to(root)
    except ValueError as exc:
        raise ValueError(f"{label} path must be contained by the migration root") from exc
    if resolved == root:
        raise ValueError(f"{label} path cannot be the migration root")
    _reject_reparse_chain(resolved, label, stop_at_missing=True)
    return resolved


def _reject_lexical_alias(path: Path, label: str) -> None:
    if not path.is_absolute():
        raise ValueError(f"{label} path must be absolute")
    if ".." in path.parts:
        raise ValueError(f"{label} path cannot contain traversal")
    if os.name == "nt" and str(path).startswith("\\\\"):
        raise ValueError(f"{label} path cannot use a UNC alias")


def _reject_reparse_chain(
    path: Path,
    label: str,
    *,
    stop_at_missing: bool = False,
) -> None:
    current = Path(path.anchor)
    for part in path.parts[1:]:
        current /= part
        if stop_at_missing and not current.exists() and not current.is_symlink():
            break
        _reject_reparse(current, label)


def _reject_reparse_if_present(path: Path, label: str) -> None:
    if path.exists() or path.is_symlink():
        _reject_reparse(path, label)


def _reject_reparse(path: Path, label: str) -> None:
    try:
        metadata = path.lstat()
    except OSError as exc:
        raise ValueError(f"{label} path metadata cannot be trusted") from exc
    attributes = getattr(metadata, "st_file_attributes", 0)
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
    is_junction = getattr(path, "is_junction", lambda: False)()
    if stat.S_ISLNK(metadata.st_mode) or is_junction or bool(attributes & reparse_flag):
        raise ValueError(f"{label} path cannot contain a symlink, junction, or reparse point")


def _path_key(path: Path) -> str:
    return os.path.normcase(str(path))


def _reject_descriptor_reparse(descriptor: int, label: str) -> None:
    metadata = os.fstat(descriptor)
    attributes = getattr(metadata, "st_file_attributes", 0)
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
    if bool(attributes & reparse_flag):
        raise LedgerError(f"{label} cannot be a reparse point")


def _cleanup_stale_temps(path: Path) -> None:
    legacy_temp = path.with_name(f".{path.name}.tmp")
    candidates = set(path.parent.glob(f".{path.name}.*.tmp"))
    if legacy_temp.exists() or legacy_temp.is_symlink():
        candidates.add(legacy_temp)
    for candidate in sorted(candidates):
        try:
            _reject_reparse(candidate, "stale ledger temporary file")
            if not candidate.is_file():
                raise LedgerError("stale ledger temporary path is not a regular file")
            candidate.unlink()
        except (OSError, ValueError) as exc:
            raise LedgerError(
                f"could not safely remove stale migration ledger temporary file: {candidate}"
            ) from exc


def _fsync_directory(directory: Path) -> None:
    if not hasattr(os, "O_DIRECTORY"):
        return
    descriptor: int | None = None
    try:
        descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
        os.fsync(descriptor)
    except OSError as exc:
        raise LedgerError(
            f"migration ledger directory durability is uncertain: {directory}"
        ) from exc
    finally:
        if descriptor is not None:
            os.close(descriptor)


def _lock_descriptor(descriptor: int) -> None:
    if os.name == "nt":
        import msvcrt

        os.lseek(descriptor, 0, os.SEEK_SET)
        msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
        return
    import fcntl

    fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)


def _unlock_descriptor(descriptor: int) -> None:
    if os.name == "nt":
        import msvcrt

        os.lseek(descriptor, 0, os.SEEK_SET)
        msvcrt.locking(descriptor, msvcrt.LK_UNLCK, 1)
        return
    import fcntl

    fcntl.flock(descriptor, fcntl.LOCK_UN)
