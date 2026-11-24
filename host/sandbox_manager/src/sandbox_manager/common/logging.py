"""Logging setup for the sandbox-manager process.

Mirrors the ServiceHub loguru approach
(``host/servicehub/src/servicehub/common/logging.py``, introduced in #1162) but
preserves sandbox_manager's existing two-sink, file-only behavior:

* Two timestamped file sinks under ``<DATA_DIR>/logs``:
    - manager sink -> ``logs/manager/sbms-<ts>.log`` (every record)
    - install sink -> ``logs/sandbox/install/install-attempt-<ts>.log`` (only the
      sandbox install/runtime namespaces). The sandbox API globs
      ``install-attempt*.log`` and reads it back, so the filename and the
      namespace filter are a contract.
* Each start prunes the files of earlier starts in both folders. It keeps the newest
  :data:`_RETAINED_STARTS` starts (this one included) and every start younger than
  :data:`_RETAINED_START_AGE`.
* No stderr sink: sandbox_manager runs as a ServiceHub child whose ``stdout`` /
  ``stderr`` are already captured by the Hub into ``sandbox-manager-stderr-*.log``.
  A console sink would double-log every line.
* An :class:`InterceptHandler` routes stdlib ``logging`` records (uvicorn,
  httpx, huggingface_hub, ...) into the same loguru sinks, preserving the prior
  root-logger capture behavior.

Idempotent and thread-safe: safe to call from multiple entry points
(``python -m sandbox_manager.main``, ``build_app()`` under pytest / uvicorn). The
first call fixes the timestamp so all records from one process share a filename;
a later call with a different ``log_dir`` swaps the sinks to the new location.
"""

from __future__ import annotations

import logging
import os
import re
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import TYPE_CHECKING

from loguru import logger

from sandbox_manager.config import Config

if TYPE_CHECKING:
    from loguru import Record


# 10 MB rotation matches the prior ``RotatingFileHandler`` sizing. ``retention``
# as an int keeps that many rotated files (plus the current one), mirroring the
# old ``backupCount`` semantics (manager: 5 backups, install: 3 backups).
_MAX_LOG_BYTES = 10 * 1024 * 1024
_MANAGER_RETAINED_FILES = 5
_INSTALL_RETAINED_FILES = 3
# ``retention`` only prunes one start's rotation set, so each start leaves its files
# behind. Keep this many starts per log folder, the current one included; it matches the
# Tauri shell's ``LOG_FILE_RETENTION`` so both logs cover the same launches by boot_id.
_RETAINED_STARTS = 10
# Also keep any start this recent, whatever the count: ServiceHub relaunches a failing
# manager up to 5 times per app launch, so a crash loop would otherwise rotate out the
# first failure's log within two launches.
_RETAINED_START_AGE = timedelta(days=3)
_START_TS_FORMAT = "%Y%m%dT%H%M%S"
# loguru renames a rotated file to ``<stem>.<YYYY-MM-DD_HH-MM-SS_ffffff>[.<n>].log``.
_ROTATED_SUFFIX = r"(?:\.\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_\d{6}(?:\.\d+)?)?"
# ``--reload`` sets this on its workers. The supervisor keeps writing its own start's
# file for the whole session, so it prunes and its workers do not.
DEV_RELOAD_WORKER_ENV = "SANDBOX_MANAGER_DEV_RELOAD_WORKER"
# Startup-logging unification (2026-07-21 §3.2 / §4.2): reference
# {extra[boot_id]} explicitly; default seeded via logger.configure below.
_LOG_FORMAT = (
    "{time:YYYY-MM-DDTHH:mm:ss.SSSZ!UTC} [{level}] "
    "boot_id={extra[boot_id]} {name}: {message}"
)
_LOG_LEVEL = "INFO"

# Sandbox install/runtime logger namespaces routed into ``install-attempt-*.log``.
# Keep this list in sync with the modules that log install/runtime progress.
_SANDBOX_INSTALL_PREFIXES = ("sandbox_manager.owt_cache",)

_LOG_LOCK = threading.Lock()
_CONFIGURED = False
_MANAGER_LOG_DIR: Path | None = None
_INSTALL_LOG_DIR: Path | None = None
_MANAGER_LOG_PATH: Path | None = None
_INSTALL_LOG_PATH: Path | None = None


def _boot_id() -> str:
    """Launch correlation id injected by the Tauri shell via env, or ``-``."""
    return (os.environ.get("SUPERCLAW_BOOT_ID") or "").strip() or "-"


class InterceptHandler(logging.Handler):
    """Route stdlib ``logging`` records into loguru.

    Preserves sandbox_manager's prior behavior of capturing third-party stdlib
    logs (uvicorn, httpx, huggingface_hub) into the manager log file.
    Records emitted by third-party namespaces do not match
    :data:`_SANDBOX_INSTALL_PREFIXES`, so they land in the manager sink only —
    exactly as before.
    """

    def emit(self, record: logging.LogRecord) -> None:
        # Map the stdlib level onto loguru's, falling back to the numeric level
        # for custom names loguru does not know.
        try:
            level: str | int = logger.level(record.levelname).name
        except ValueError:
            level = record.levelno

        # Walk out of the logging module so loguru attributes the record to the
        # real caller (and reports the caller's module as ``record["name"]``).
        frame, depth = logging.currentframe(), 2
        while frame.f_back and frame.f_code.co_filename == logging.__file__:
            frame = frame.f_back
            depth += 1

        logger.opt(depth=depth, exception=record.exc_info).log(level, record.getMessage())


def _install_filter(record: Record) -> bool:
    name = record["name"]
    return bool(name) and name.startswith(_SANDBOX_INSTALL_PREFIXES)


def _install_intercept_handler() -> None:
    root = logging.getLogger()
    if not any(isinstance(handler, InterceptHandler) for handler in root.handlers):
        root.addHandler(InterceptHandler())
    # Only widen the root level; never override an explicitly lower (more
    # verbose) level a developer may have set.
    if root.level > logging.INFO or root.level == logging.NOTSET:
        root.setLevel(logging.INFO)
    # httpx logs every request at INFO, and readiness probes poll every few
    # seconds. Leave a level a developer set explicitly alone.
    for name in ("httpx", "httpcore"):
        third_party = logging.getLogger(name)
        if third_party.level == logging.NOTSET:
            third_party.setLevel(logging.WARNING)


def _remove_intercept_handler() -> None:
    root = logging.getLogger()
    for handler in list(root.handlers):
        if isinstance(handler, InterceptHandler):
            root.removeHandler(handler)


def _prune_earlier_starts(log_dir: Path, prefix: str, current_ts: str) -> list[Path]:
    """Delete the files of earlier starts that are neither among the newest nor recent.

    Returns what it could not delete, or ``[log_dir]`` if the folder could not be read.
    """
    pattern = re.compile(
        re.escape(prefix) + r"-(\d{8}T\d{6})" + _ROTATED_SUFFIX + r"\.log"
    )
    starts: dict[str, list[Path]] = {}
    try:
        for path in log_dir.iterdir():
            match = pattern.fullmatch(path.name)
            if match and match.group(1) != current_ts and path.is_file():
                starts.setdefault(match.group(1), []).append(path)
    except OSError:
        return [log_dir]

    undeletable: list[Path] = []
    floor = datetime.strptime(current_ts, _START_TS_FORMAT) - _RETAINED_START_AGE
    # The start timestamp sorts chronologically as a string.
    for ts in sorted(starts)[: max(len(starts) - (_RETAINED_STARTS - 1), 0)]:
        try:
            if datetime.strptime(ts, _START_TS_FORMAT) >= floor:
                continue
        except ValueError:
            continue
        for path in starts[ts]:
            try:
                path.unlink(missing_ok=True)
            except OSError:
                undeletable.append(path)
    return undeletable


def setup_logging(cfg: Config) -> Path:
    """Configure loguru file sinks and return the manager log path.

    Idempotent: repeated calls with the same log directories are a no-op and
    return the already-configured manager log path, so one process writes to one
    pair of timestamped files. A call with different log directories swaps the
    sinks to the new location.
    """
    global _CONFIGURED, _MANAGER_LOG_DIR, _INSTALL_LOG_DIR
    global _MANAGER_LOG_PATH, _INSTALL_LOG_PATH

    cfg.manager_log_dir.mkdir(parents=True, exist_ok=True)
    cfg.sandbox_log_dir.mkdir(parents=True, exist_ok=True)
    cfg.sandbox_install_log_dir.mkdir(parents=True, exist_ok=True)
    cfg.sandbox_runtime_log_dir.mkdir(parents=True, exist_ok=True)

    manager_dir = cfg.manager_log_dir.resolve()
    install_dir = cfg.sandbox_install_log_dir.resolve()

    with _LOG_LOCK:
        if (
            _CONFIGURED
            and _MANAGER_LOG_DIR == manager_dir
            and _INSTALL_LOG_DIR == install_dir
            and _MANAGER_LOG_PATH is not None
        ):
            return _MANAGER_LOG_PATH

        _teardown_locked()
        # Drop loguru's default stderr sink (and any leftover sinks) before
        # attaching our own; we are file-only by design.
        logger.remove()
        # Seed the default boot_id so every record renders {extra[boot_id]}.
        logger.configure(extra={"boot_id": _boot_id()})

        ts = datetime.now(timezone.utc).strftime(_START_TS_FORMAT)
        manager_path = manager_dir / f"sbms-{ts}.log"
        install_path = install_dir / f"install-attempt-{ts}.log"
        undeletable: list[Path] = []
        if not os.environ.get(DEV_RELOAD_WORKER_ENV):
            undeletable = _prune_earlier_starts(manager_dir, "sbms", ts)
            undeletable += _prune_earlier_starts(install_dir, "install-attempt", ts)

        # diagnose=False: a traceback keeps its lines but not the values of the variables on them, which can be
        # tokens and secrets held by the request being served.
        logger.add(
            manager_path,
            level=_LOG_LEVEL,
            format=_LOG_FORMAT,
            rotation=_MAX_LOG_BYTES,
            retention=_MANAGER_RETAINED_FILES,
            encoding="utf-8",
            diagnose=False,
        )
        logger.add(
            install_path,
            level=_LOG_LEVEL,
            format=_LOG_FORMAT,
            rotation=_MAX_LOG_BYTES,
            retention=_INSTALL_RETAINED_FILES,
            encoding="utf-8",
            filter=_install_filter,
            diagnose=False,
        )
        _install_intercept_handler()
        if undeletable:
            # Usually a file another process holds open; the next start tries again.
            logger.warning(
                "could not prune logs of earlier starts, skipped: {}",
                ", ".join(str(path) for path in undeletable),
            )

        _CONFIGURED = True
        _MANAGER_LOG_DIR = manager_dir
        _INSTALL_LOG_DIR = install_dir
        _MANAGER_LOG_PATH = manager_path
        _INSTALL_LOG_PATH = install_path
        return manager_path


def teardown_logging() -> None:
    with _LOG_LOCK:
        _teardown_locked()


def _teardown_locked() -> None:
    global _CONFIGURED, _MANAGER_LOG_DIR, _INSTALL_LOG_DIR
    global _MANAGER_LOG_PATH, _INSTALL_LOG_PATH
    if not _CONFIGURED:
        return
    logger.remove()
    _remove_intercept_handler()
    _CONFIGURED = False
    _MANAGER_LOG_DIR = None
    _INSTALL_LOG_DIR = None
    _MANAGER_LOG_PATH = None
    _INSTALL_LOG_PATH = None
