"""Single-instance handoff for ServiceHub.

When the desktop app exits with keep-backend-alive enabled, the ServiceHub
process and its fixed-port children intentionally keep running. A later app
launch must attach to that existing Hub instead of starting a second Hub that
tries to spawn children on already-owned ports.
"""

from __future__ import annotations

import json
import os
import secrets
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from loguru import logger

from servicehub.hardened_mutex import close_handle, create_hardened_mutex
from servicehub.owner_only_acl import (
    create_owner_only_file,
    restrict_directory_to_owner,
)


_MUTEX_NAME = r"Local\SuperClaw_ServiceHub"
_TEST_MUTEX_ENV = "_SERVICEHUB_TEST_MUTEX_NAME"
_LOCKFILE_NAME = "servicehub.lock"
_LOCKFILE_READ_ATTEMPTS = 10
_LOCKFILE_READ_DELAY_S = 0.1
_LOCKFILE_REPLACE_ATTEMPTS = 10


def _mutex_name() -> str:
    """Return the Windows singleton mutex name.

    Production always uses the stable ``Local\\SuperClaw_ServiceHub`` name so an
    installed app cannot spawn duplicate supervisors. Pytest runs may override
    the mutex with a private name to avoid attaching to a developer's
    intentionally kept-alive Hub from another process.
    """
    if _pytest_mutex_override_allowed():
        return os.environ.get(_TEST_MUTEX_ENV) or _MUTEX_NAME
    return _MUTEX_NAME


def _pytest_mutex_override_allowed() -> bool:
    return "PYTEST_CURRENT_TEST" in os.environ and "pytest" in sys.modules


@dataclass
class SingletonResult:
    is_first: bool
    existing: dict[str, Any] | None


class _MutexHandle:
    def __init__(self) -> None:
        self._handle = None

    def acquire(self) -> bool:
        """Return whether this process is the first instance.

        Raises ``SingletonUnavailableError`` rather than assuming first-instance
        when the mutex cannot be created or an existing one is not ours.
        """
        if sys.platform != "win32":
            return True
        handle, already_exists = create_hardened_mutex(_mutex_name())
        self._handle = handle
        return not already_exists

    def release(self) -> None:
        if self._handle is None:
            return
        try:
            close_handle(self._handle)
        finally:
            self._handle = None


_MUTEX = _MutexHandle()


def acquire_or_describe_existing(data_dir: Path) -> SingletonResult:
    if _MUTEX.acquire():
        return SingletonResult(is_first=True, existing=None)

    lock_path = data_dir / _LOCKFILE_NAME
    existing: dict[str, Any] | None = None
    for _ in range(_LOCKFILE_READ_ATTEMPTS):
        if not lock_path.exists():
            time.sleep(_LOCKFILE_READ_DELAY_S)
            continue
        try:
            candidate = json.loads(lock_path.read_text(encoding="utf-8"))
            if _valid_existing_lockfile(candidate):
                existing = candidate
                break
            logger.warning("invalid singleton lockfile metadata path={}", lock_path)
            time.sleep(_LOCKFILE_READ_DELAY_S)
        except Exception as exc:
            logger.warning(
                "failed to read singleton lockfile path={} error_type={} detail={}",
                lock_path,
                type(exc).__name__,
                str(exc),
            )
            existing = None
            time.sleep(_LOCKFILE_READ_DELAY_S)
    return SingletonResult(is_first=False, existing=existing)


def _valid_existing_lockfile(value: object) -> bool:
    if not isinstance(value, dict):
        return False
    pid = value.get("pid")
    port = value.get("port")
    token = value.get("token")
    return (
        type(pid) is int
        and pid > 0
        and pid <= 0xFFFFFFFF
        and type(port) is int
        and 1 <= port <= 65535
        and isinstance(token, str)
        and bool(token)
    )


def write_lockfile(data_dir: Path, *, port: int, token: str) -> None:
    """Atomically publish ``{pid, port, token}`` under an owner-only DACL.

    The token is the Hub bearer credential, so neither the file nor its
    directory may rely on an inherited ACL.
    """
    data_dir.mkdir(parents=True, exist_ok=True)
    if restrict_directory_to_owner(data_dir):
        logger.info("servicehub data dir restricted to owner-only DACL path={}", data_dir)
    payload = json.dumps({"pid": os.getpid(), "port": port, "token": token}).encode("utf-8")
    lock_path = data_dir / _LOCKFILE_NAME
    temp_path = data_dir / f"{_LOCKFILE_NAME}.{secrets.token_hex(8)}.tmp"
    try:
        with create_owner_only_file(temp_path) as handle:
            handle.write(payload)
        _replace_lockfile(temp_path, lock_path)
    finally:
        temp_path.unlink(missing_ok=True)


def _replace_lockfile(temp_path: Path, lock_path: Path) -> None:
    # A reader that opened the old lockfile without FILE_SHARE_DELETE (Python's
    # open(), .NET's ReadAllText) blocks the replace until it closes the file.
    for attempt in range(_LOCKFILE_REPLACE_ATTEMPTS):
        try:
            os.replace(temp_path, lock_path)
            return
        except PermissionError:
            if attempt == _LOCKFILE_REPLACE_ATTEMPTS - 1:
                raise
            time.sleep(_LOCKFILE_READ_DELAY_S)


def remove_lockfile(data_dir: Path) -> None:
    try:
        (data_dir / _LOCKFILE_NAME).unlink(missing_ok=True)
    except Exception as exc:
        logger.warning(
            "failed to remove singleton lockfile path={} error_type={} detail={}",
            data_dir / _LOCKFILE_NAME,
            type(exc).__name__,
            str(exc),
        )
    _MUTEX.release()
