"""Logging setup for the ServiceHub process."""

from __future__ import annotations

import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from loguru import logger

from servicehub.config import Config


_MAX_LOG_BYTES = 2 * 1024 * 1024
_BACKUP_COUNT = 3
_RETAINED_ROTATED_FILES = _BACKUP_COUNT
# Startup-logging unification (2026-07-21 §3.2 / §4.2): the format string MUST
# reference {extra[boot_id]} explicitly — loguru only renders `extra` fields the
# format references. The default is seeded via logger.configure below so records
# without an explicit boot_id never raise KeyError.
_LOG_FORMAT = (
    "{time:YYYY-MM-DDTHH:mm:ss.SSSZ!UTC} [{level}] "
    "boot_id={extra[boot_id]} {name}: {message}"
)
_FILE_LOG_LEVEL = "DEBUG"
_STDERR_LOG_LEVEL = "INFO"
_LOGURU_CONFIGURED = False


def _boot_id() -> str:
    """Launch correlation id injected by the Tauri shell via env, or ``-``."""
    return (os.environ.get("SUPERCLAW_BOOT_ID") or "").strip() or "-"


def _prune_old_launch_logs(log_dir: Path) -> None:
    def _mtime_or_none(path: Path) -> float | None:
        try:
            return path.stat().st_mtime
        except OSError:
            return None

    candidates = [
        (path, mtime)
        for path in log_dir.glob("servicehub-*.log")
        if (mtime := _mtime_or_none(path)) is not None
    ]
    files = [path for path, _mtime in sorted(candidates, key=lambda item: item[1], reverse=True)]
    # Keep three prior files; the new launch file becomes the current fourth.
    for stale in files[_BACKUP_COUNT:]:
        try:
            stale.unlink()
        except OSError:
            pass


def setup_logging(cfg: Config) -> Path:
    global _LOGURU_CONFIGURED
    cfg.ensure_directories()
    teardown_logging()
    _prune_old_launch_logs(cfg.log_dir)
    stamp = (
        f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')}"
        f"-{uuid4().hex[:8]}"
    )
    log_path = cfg.log_dir / f"servicehub-{stamp}.log"
    logger.remove()
    # Seed the default boot_id so every record renders {extra[boot_id]} without
    # a per-call bind and without KeyError.
    logger.configure(extra={"boot_id": _boot_id()})
    logger.add(
        log_path,
        level=_FILE_LOG_LEVEL,
        format=_LOG_FORMAT,
        rotation=_MAX_LOG_BYTES,
        retention=_RETAINED_ROTATED_FILES,
        encoding="utf-8",
    )
    logger.add(sys.stderr, level=_STDERR_LOG_LEVEL, format=_LOG_FORMAT)
    _LOGURU_CONFIGURED = True
    return log_path


def teardown_logging() -> None:
    global _LOGURU_CONFIGURED
    if not _LOGURU_CONFIGURED:
        return
    logger.remove()
    _LOGURU_CONFIGURED = False
