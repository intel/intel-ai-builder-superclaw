"""Stable credential owned by the Privacy Manager data plane."""

from __future__ import annotations

import os
import secrets
import sys
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from protection_service.state import (
    default_state_root,
    read_protected_json,
    write_protected_json_atomic,
)

_KEY_FILE = "data-plane-key.bin"
STANDALONE_KEY_ENV = "DATA_PROTECTION_API_KEY"


def default_data_plane_key_path() -> Path:
    return default_state_root() / _KEY_FILE


def load_standalone_data_plane_key() -> str:
    """Return the explicit standalone key or fail closed."""
    key = os.environ.get(STANDALONE_KEY_ENV, "").strip()
    if not key:
        raise RuntimeError(f"{STANDALONE_KEY_ENV} is required in standalone mode")
    return key


@contextmanager
def _initialization_lock(target: Path) -> Iterator[None]:
    lock_path = target.with_suffix(target.suffix + ".lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+b") as lock_file:
        if lock_file.tell() == 0:
            lock_file.write(b"0")
            lock_file.flush()
        lock_file.seek(0)
        if sys.platform == "win32":
            import msvcrt

            msvcrt.locking(lock_file.fileno(), msvcrt.LK_LOCK, 1)
            try:
                yield
            finally:
                lock_file.seek(0)
                msvcrt.locking(lock_file.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


def _parse_record(record: object) -> str:
    if not isinstance(record, dict) or not isinstance(record.get("api_key"), str):
        raise ValueError("invalid data-plane key record")
    key = record["api_key"].strip()
    if not key:
        raise ValueError("data-plane key record contains an empty key")
    return key


def read_data_plane_key(path: Path | None = None) -> str | None:
    """The persisted key, or ``None`` when there is no record yet; never creates one.

    A record :func:`load_or_create_data_plane_key` would reject raises the same
    error. Takes no lock, so a caller must not run concurrently with a writer:
    Windows refuses the writer's atomic replace while the file is open here.
    ServiceHub reads this before it spawns Privacy Manager, the only writer.
    """
    record = read_protected_json(path or default_data_plane_key_path())
    if record is None:
        return None
    return _parse_record(record)


def load_or_create_data_plane_key(path: Path | None = None) -> str:
    """Load the stable key, creating it only when no state file exists."""
    target = path or default_data_plane_key_path()
    with _initialization_lock(target):
        record = read_protected_json(target)
        if record is not None:
            return _parse_record(record)

        key = secrets.token_urlsafe(48)
        write_protected_json_atomic(target, {"api_key": key})
        return key
