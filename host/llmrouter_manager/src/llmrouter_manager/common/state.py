"""State file I/O for llmrouter_manager (atomic, optionally DPAPI-encrypted).

Layout under `default_state_root()` is the contract defined in README §9.
Atomic write semantics: write payload to a sibling `.tmp` file, fsync, then
`os.replace()` — atomic on Windows + POSIX within the same filesystem.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any

from . import dpapi


def default_state_root() -> Path:
    """Per-user state root.

    Windows: `%LOCALAPPDATA%/SuperClaw/llmrouter_manager/state/`. Non-Windows
    falls back to the system temp dir so plain-JSON tests run on Linux/macOS
    CI; production is Windows-only because DPAPI requires it.
    """
    if sys.platform == "win32":
        local_app_data = os.environ.get("LOCALAPPDATA")
        if local_app_data:
            return Path(local_app_data) / "SuperClaw" / "llmrouter_manager" / "state"
        return (
            Path.home() / "AppData" / "Local" / "SuperClaw" / "llmrouter_manager" / "state"
        )
    return Path(tempfile.gettempdir()) / "SuperClaw-llmrouter_manager" / "state"


def _atomic_write_bytes(target: Path, data: bytes) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        prefix=target.name + ".",
        suffix=".tmp",
        dir=str(target.parent),
    )
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, target)
    except BaseException:
        try:
            tmp.unlink()
        except FileNotFoundError:
            pass
        raise


def read_json(path: Path) -> Any | None:
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    return json.loads(text)


def write_json_atomic(path: Path, data: Any) -> None:
    payload = json.dumps(data, separators=(",", ":"), sort_keys=True, ensure_ascii=False)
    _atomic_write_bytes(path, payload.encode("utf-8"))


def read_encrypted_json(path: Path) -> Any | None:
    try:
        blob = path.read_bytes()
    except FileNotFoundError:
        return None
    plaintext = dpapi.unprotect(blob)
    return json.loads(plaintext.decode("utf-8"))


def write_encrypted_json_atomic(path: Path, data: Any) -> None:
    payload = json.dumps(data, separators=(",", ":"), sort_keys=True, ensure_ascii=False)
    ciphertext = dpapi.protect(payload.encode("utf-8"))
    _atomic_write_bytes(path, ciphertext)


def delete_state_file(path: Path) -> bool:
    try:
        path.unlink()
        return True
    except FileNotFoundError:
        return False
