"""Stable DPAPI-backed credential for the LRM inference data plane."""

from __future__ import annotations

import secrets
import sys
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from .state import default_state_root, read_encrypted_json, write_encrypted_json_atomic

_KEY_FILE = "inference-key.bin"


def default_inference_key_path() -> Path:
    return default_state_root() / _KEY_FILE


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


def _parse_record(record: object) -> tuple[str, str]:
    """``(shared_key, host_key)`` from a stored record; ``host_key`` is "" before the split."""
    if not isinstance(record, dict) or not isinstance(record.get("api_key"), str):
        raise ValueError("invalid inference key record")
    key = record["api_key"].strip()
    if not key:
        raise ValueError("inference key record contains an empty key")
    host_raw = record.get("host_api_key")
    host_key = host_raw.strip() if isinstance(host_raw, str) else ""
    return key, host_key


def read_inference_keys(path: Path | None = None) -> tuple[str, str] | None:
    """The persisted ``(shared_key, host_key)``, never creating or migrating the record.

    ``None`` whenever :func:`load_or_create_inference_keys` would write instead of
    only read: no record yet, or a record from before ``host_api_key`` existed. A
    record that function would reject raises the same ``ValueError``.

    Takes no lock, so a caller must not run concurrently with a writer: Windows
    refuses the writer's atomic replace while the file is open here. ServiceHub
    reads this before it spawns LRM, the only writer.
    """
    record = read_encrypted_json(path or default_inference_key_path())
    if record is None:
        return None
    key, host_key = _parse_record(record)
    if not host_key:
        return None
    return key, host_key


def load_or_create_inference_key(path: Path | None = None) -> str:
    """The shared data-plane credential. See :func:`load_or_create_inference_keys`."""
    return load_or_create_inference_keys(path)[0]


def load_or_create_inference_keys(path: Path | None = None) -> tuple[str, str]:
    """``(shared_key, host_key)`` for the inference data plane.

    TWO KEYS, BECAUSE ONE OF THE CALLERS IS NOT TRUSTED. ``shared_key`` is the
    credential ServiceHub hands to every dependent, **including the sandbox
    container** -- agent code needs it to reach ``/v1/chat/completions`` for its
    own turns. ``host_key`` is withheld from the container and given only to
    host-side services, so a route can require a caller that is demonstrably not
    sandboxed.

    Without the split, every ``/v1`` route is reachable by anything running
    inside the sandbox. That is correct for the alias route -- which resolves
    ``auto`` / ``local-model`` / ``cloud-model`` against the user's committed
    selections, so the caller cannot choose a model -- and wrong for
    ``/v1/chat/completions/pinned``, which names its own provider, model and
    usage label. With one key, sandboxed code could spend the user's cloud
    credential on any connected model and record it under any label, including
    this feature's own ``dictation-refine``.

    Both live in ONE encrypted record under one lock: two files would make
    "rotated together" an invariant maintained by luck. A record written before
    ``host_api_key`` existed is migrated in place on first read rather than
    rejected -- an install that already has a key must keep it, because
    ServiceHub treats a changed key across a restart as a readiness failure.
    """
    target = path or default_inference_key_path()
    with _initialization_lock(target):
        record = read_encrypted_json(target)
        if record is not None:
            key, host_key = _parse_record(record)
            if not host_key:
                # Migration, not an error: pre-split installs have only
                # `api_key`. Mint the host key and persist it, keeping the
                # shared key byte-identical so ServiceHub's
                # "credential changed during ordinary restart" check still holds.
                host_key = secrets.token_urlsafe(48)
                write_encrypted_json_atomic(
                    target, {"api_key": key, "host_api_key": host_key}
                )
            return key, host_key

        key = secrets.token_urlsafe(48)
        host_key = secrets.token_urlsafe(48)
        write_encrypted_json_atomic(target, {"api_key": key, "host_api_key": host_key})
        return key, host_key
