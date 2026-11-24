"""Durable canonical JSON reads and atomic writes for capability evidence."""

from __future__ import annotations

import errno
import json
import os
from pathlib import Path
import secrets
from typing import BinaryIO


class AtomicJsonError(OSError):
    """A durable JSON persistence operation failed."""


class AtomicJsonCorruptionError(ValueError):
    """A persisted JSON file cannot be safely interpreted."""


def canonical_json_bytes(value: object) -> bytes:
    """Encode one stable UTF-8 JSON representation shared by state and hashes."""
    try:
        return (json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n").encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise AtomicJsonError("value cannot be encoded as canonical JSON") from exc


def read_json_object(path: Path) -> dict[str, object] | None:
    """Read a JSON object, distinguishing a missing file from corrupt evidence."""
    try:
        raw = path.read_bytes()
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise AtomicJsonError(f"cannot read JSON state: {path}") from exc

    try:
        value = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise AtomicJsonCorruptionError(f"invalid JSON state: {path}") from exc
    if not isinstance(value, dict):
        raise AtomicJsonCorruptionError(f"JSON state must be an object: {path}")
    return value


def atomic_write_json(path: Path, value: object) -> None:
    """Replace ``path`` with a fully flushed canonical JSON file."""
    payload = canonical_json_bytes(value)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise AtomicJsonError(f"cannot create JSON state directory: {path.parent}") from exc

    temporary, descriptor = _create_temporary_path(path)
    try:
        with os.fdopen(descriptor, "wb") as output:
            _write_payload(output, payload)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        _fsync_directory(path.parent)
    except AtomicJsonError:
        _remove_temporary(temporary)
        raise
    except OSError as exc:
        _remove_temporary(temporary)
        raise AtomicJsonError(f"cannot atomically write JSON state: {path}") from exc


def _create_temporary_path(target: Path) -> tuple[Path, int]:
    for _ in range(100):
        candidate = target.parent / f".{target.name}.{secrets.token_hex(16)}.tmp"
        try:
            # Keep the exclusive descriptor so no other caller can claim this name.
            descriptor = os.open(candidate, os.O_WRONLY | os.O_CREAT | os.O_EXCL)
        except FileExistsError:
            continue
        except OSError as exc:
            raise AtomicJsonError(f"cannot create JSON temporary file: {candidate}") from exc
        return candidate, descriptor
    raise AtomicJsonError(f"cannot allocate unique JSON temporary file for {target}")


def _write_payload(output: BinaryIO, payload: bytes) -> None:
    output.write(payload)


def _remove_temporary(path: Path) -> None:
    try:
        path.unlink()
    except FileNotFoundError:
        pass
    except OSError:
        # Preserve the original write error; this file was created by this call only.
        pass


def _fsync_directory(directory: Path) -> None:
    if os.name == "nt":
        # Windows does not expose a portable directory fsync; replace remains atomic.
        return
    try:
        descriptor = os.open(directory, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    except OSError as exc:
        if exc.errno in {errno.EACCES, errno.EINVAL, errno.ENOTSUP, errno.EPERM}:
            return
        raise AtomicJsonError(f"cannot open JSON state directory: {directory}") from exc
    try:
        os.fsync(descriptor)
    except OSError as exc:
        if exc.errno not in {errno.EACCES, errno.EINVAL, errno.ENOTSUP, errno.EPERM}:
            raise AtomicJsonError(f"cannot flush JSON state directory: {directory}") from exc
    finally:
        os.close(descriptor)
