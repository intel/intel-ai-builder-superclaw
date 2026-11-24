"""Shared logger setup for the LLM Pipeline service."""
from __future__ import annotations

import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING

from loguru import logger

if TYPE_CHECKING:
    from loguru import Logger

_sinks_added: bool = False

_LOG_FMT = (
    "{time:YYYY-MM-DDTHH:mm:ss.SSSZ!UTC} [{level}] "
    "boot_id={extra[boot_id]} {extra[name]}: {message}"
)


def _default_log_dir() -> Path:
    """Windows host log dir under %LOCALAPPDATA%; falls back to temp on non-Windows."""
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(base) / "SuperClaw" / "security" / "logs"
    import tempfile
    return Path(tempfile.gettempdir()) / "SuperClaw-security" / "logs"


def setup_logger(
    name: str = "llm_pipeline",
    log_dir: str | Path | None = None,
    level: str = "DEBUG",
) -> Logger:
    """
    Set up a logger for the protected file pipeline.

    Args:
        name (str): Name of the logger.
        log_dir (str | Path): Directory where log files will be stored.
        level (str): Logging level (e.g., ``"INFO"``, ``"DEBUG"``).

    Returns:
        Logger: Bound loguru logger instance.
    """
    global _sinks_added
    if not _sinks_added:
        _sinks_added = True

        resolved_dir = Path(log_dir) if log_dir is not None else _default_log_dir()
        resolved_dir.mkdir(parents=True, exist_ok=True)
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        log_file_path = resolved_dir / f"llm_pipeline_{today}.log"

        boot_id = (os.environ.get("SUPERCLAW_BOOT_ID") or "").strip() or "-"
        logger.configure(extra={"boot_id": boot_id})
        logger.add(sys.stderr, level=level, format=_LOG_FMT)
        logger.add(log_file_path, level=level, format=_LOG_FMT, encoding="utf-8")

    return logger.bind(name=name)
