"""Atomic, user-scoped state storage for Privacy Manager credentials."""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

from protection_service import dpapi


def default_state_root() -> Path:
    """Return the per-user Privacy Manager state directory."""
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA")
        if base:
            return Path(base) / "SuperClaw" / "privacy_manager" / "state"
        return Path.home() / "AppData" / "Local" / "SuperClaw" / "privacy_manager" / "state"
    return Path(tempfile.gettempdir()) / "SuperClaw-privacy_manager" / "state"


def _atomic_write_bytes(target: Path, data: bytes) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(
        prefix=target.name + ".", suffix=".tmp", dir=str(target.parent)
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, target)
    except BaseException:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
        raise


class ProtectedStateError(ValueError):
    """A state file exists but cannot be decrypted or parsed. Callers fail closed."""


def read_protected_json(path: Path) -> object | None:
    """Read DPAPI-protected JSON on Windows and plain JSON in non-Windows tests.

    Raises ProtectedStateError when the file exists but cannot be decrypted or
    parsed, so a corrupt state file is one typed error on every platform.
    """
    try:
        payload = path.read_bytes()
    except FileNotFoundError:
        return None
    try:
        if sys.platform == "win32":
            payload = dpapi.unprotect(payload)
        return json.loads(payload.decode("utf-8"))
    except (OSError, ValueError) as exc:
        raise ProtectedStateError(f"protected state at {path} is unreadable: {exc}") from exc


def write_protected_json_atomic(path: Path, value: object) -> None:
    """Serialize and atomically persist a state value."""
    payload = json.dumps(
        value, separators=(",", ":"), sort_keys=True, ensure_ascii=False
    ).encode("utf-8")
    if sys.platform == "win32":
        payload = dpapi.protect(payload)
    _atomic_write_bytes(path, payload)
