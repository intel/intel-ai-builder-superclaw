"""Logging setup for llmrouter_manager (loguru-backed).

- Business events only — no per-request HTTP access log; health checks and
  SSE keepalives never touch the logger.
- Single human-readable text format for stdout + file tail.
- Dual sink — stdout and a per-launch timestamped file under
  ``%LOCALAPPDATA%/SuperClaw/llmrouter_manager/logs/`` with 50-file retention.
- Third-party stdlib loggers (uvicorn / litellm / httpx / fastapi / asyncio)
  are clamped to WARNING+ at the stdlib layer, then bridged into loguru via
  an ``InterceptHandler`` on the stdlib root so health-check polling never
  floods the file. ``LRM_LOG_LEVEL=DEBUG`` bumps LRM + third-party to DEBUG.
- Loguru is the single logging backend. Application code emits via
  ``from loguru import logger; logger.info(...)``. Stdlib ``logging`` is
  kept alive only so third-party libraries route through the same sinks.

Log lines currently include full user query text at INFO. See ``AGENTS.md``
for the outstanding PII redaction gap.
"""

from __future__ import annotations

import glob
import inspect
import logging
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from loguru import logger

from .state import default_state_root

# Reused by tests and by __main__.py to compute the default log directory.
LOG_DIR_ENV = "LRM_LOG_DIR"
LOG_LEVEL_ENV = "LRM_LOG_LEVEL"
LOG_RETENTION_ENV = "LRM_LOG_RETENTION"

DEFAULT_RETENTION = 50
DEFAULT_LEVEL = "INFO"

# Third-party stdlib loggers that must be clamped so their INFO output does
# not swamp the file with health-check polling noise. Clamping happens at
# the stdlib layer BEFORE records reach the InterceptHandler; loguru only
# sees records that survive per-logger filtering.
#
# Names are CASE-SENSITIVE (Python stdlib logging convention). LiteLLM
# uses three mixed-case verbose loggers (``LiteLLM``, ``LiteLLM Proxy``,
# ``LiteLLM Router``) — the lowercase ``litellm`` entry alone does NOT
# clamp them, so the mixed-case names are listed explicitly.
_THIRD_PARTY_LOGGERS = (
    "uvicorn",
    "uvicorn.error",
    "uvicorn.access",
    "litellm",
    "LiteLLM",
    "LiteLLM Proxy",
    "LiteLLM Router",
    "httpx",
    "httpcore",
    "fastapi",
    "asyncio",
    "apscheduler.executors.default",
    "apscheduler.scheduler",
    "opentelemetry.sdk.trace.export",
    "langfuse",
)

# Format: ``2026-07-05 12:34:56.789 INFO  chat.completion foo=bar ...``.
# ``SSS`` renders the millisecond tail of the record time; ``level: <5``
# left-justifies to 5 chars (matches the old stdlib ``%(levelname)-5s``).
# Startup-logging unification (2026-07-21 §3.2 / §4.2): {extra[boot_id]} is
# referenced explicitly; the default is seeded via logger.configure in
# setup_logging so records without an explicit boot_id never raise KeyError.
_LOGURU_FORMAT = (
    "{time:YYYY-MM-DDTHH:mm:ss.SSSZ!UTC} {level: <5} "
    "boot_id={extra[boot_id]} {message}"
)

# Track sink ids we install so setup_logging is idempotent across repeated
# calls (tests + hot-reload scenarios).
_INSTALLED_SINK_IDS: list[int] = []


class _InterceptHandler(logging.Handler):
    """Bridge stdlib ``logging`` records into loguru.

    Attached to the stdlib root so third-party libraries (uvicorn / litellm
    / httpx / fastapi) that emit via stdlib ``logging`` end up in the same
    dual sink loguru writes to. Level mapping falls back to the numeric
    level if the level name is unknown to loguru.
    """

    def emit(self, record: logging.LogRecord) -> None:  # noqa: D401
        try:
            level: str | int = logger.level(record.levelname).name
        except (AttributeError, ValueError):
            level = record.levelno

        # Walk past the ``logging`` module so loguru's caller info (which
        # our format string does not render today) reflects the true origin.
        frame, depth = inspect.currentframe(), 2
        while frame and frame.f_code.co_filename == logging.__file__:
            frame = frame.f_back
            depth += 1

        logger.opt(depth=depth, exception=record.exc_info).log(
            level, record.getMessage()
        )


def _boot_id() -> str:
    """Launch correlation id injected by the Tauri shell via env, or ``-``."""
    return (os.environ.get("SUPERCLAW_BOOT_ID") or "").strip() or "-"


def default_log_dir() -> Path:
    """Per-user log dir mirroring ``default_state_root()`` layout.

    Windows: ``%LOCALAPPDATA%/SuperClaw/llmrouter_manager/logs/`` (matches
    README §8). Non-Windows falls back next to the temp state root so tests
    on Linux/macOS CI don't touch real user directories.
    """
    override = os.environ.get(LOG_DIR_ENV, "").strip()
    if override:
        return Path(override)
    return default_state_root().parent / "logs"


def _resolve_level(explicit: str | None) -> str:
    """Return the effective LRM level string: explicit > env > default."""
    raw = (explicit or os.environ.get(LOG_LEVEL_ENV) or DEFAULT_LEVEL).strip().upper()
    if raw not in ("DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"):
        return DEFAULT_LEVEL
    return raw


def _resolve_retention() -> int:
    raw = os.environ.get(LOG_RETENTION_ENV, "").strip()
    if not raw:
        return DEFAULT_RETENTION
    try:
        value = int(raw)
    except ValueError:
        return DEFAULT_RETENTION
    return max(1, value)


def _prune_old_files(log_dir: Path, retention: int) -> None:
    """Delete oldest ``llmrouter_manager-*.log`` files beyond ``retention``.

    Runs BEFORE the new per-launch file is created so retention reflects the
    outgoing state. Errors are swallowed with a stderr warning — pruning
    failure must never prevent the process from booting.
    """
    try:
        pattern = str(log_dir / "llmrouter_manager-*.log")
        files = sorted(glob.glob(pattern), key=os.path.getmtime, reverse=True)
        # Keep the newest (retention - 1) so post-create count is exactly retention.
        for stale in files[max(retention - 1, 0):]:
            try:
                os.unlink(stale)
            except OSError:
                pass
    except Exception as exc:  # pragma: no cover — defensive
        sys.stderr.write(f"[llmrouter_manager] log prune failed: {exc}\n")


def _clear_installed_handlers() -> None:
    """Detach sinks + stdlib bridge installed by a prior ``setup_logging``.

    Guarantees idempotency: setup_logging can be called multiple times in
    the same process (tests, hot-reload) without stacking sinks that would
    produce N-way duplicated log lines. Also detaches any ``_InterceptHandler``
    from the stdlib root so third-party routing is re-established cleanly.
    """
    for sink_id in list(_INSTALLED_SINK_IDS):
        try:
            logger.remove(sink_id)
        except (ValueError, KeyError):
            pass
    _INSTALLED_SINK_IDS.clear()

    root = logging.getLogger()
    for handler in list(root.handlers):
        if isinstance(handler, _InterceptHandler):
            root.removeHandler(handler)


def setup_logging(log_dir: Path | None = None, level: str | None = None) -> Path | None:
    """Configure logging for the LRM process (loguru-backed).

    Returns the path of the created per-launch log file, or ``None`` if
    file creation failed (in which case only stdout logging is active).

    Contract:

    - loguru is the single logging backend. Business code emits via
      ``from loguru import logger; logger.info(...)``.
    - stdlib ``logging`` is bridged into loguru via ``_InterceptHandler``
      on the stdlib root so third-party libraries (uvicorn / litellm /
      httpx / fastapi) go through the same sinks.
    - Third-party stdlib loggers are clamped to WARNING+ at the stdlib
      layer BEFORE records reach the InterceptHandler (default) or DEBUG
      when ``LRM_LOG_LEVEL=DEBUG``. Clamping at stdlib avoids the cost of
      wrapping records that would be dropped by loguru anyway.
    - Idempotent within a process — subsequent calls detach prior sinks +
      handlers first so tests + hot-reload never stack duplicate output.
    """
    resolved_level = _resolve_level(level)
    is_debug = resolved_level == "DEBUG"
    target_dir = log_dir if log_dir is not None else default_log_dir()
    retention = _resolve_retention()

    _clear_installed_handlers()

    # Drop loguru's default stderr sink so setup_logging is authoritative.
    logger.remove()
    # Seed the default boot_id so every record renders {extra[boot_id]}.
    logger.configure(extra={"boot_id": _boot_id()})

    # stdout sink — resolved level for our own logger; DEBUG opens up
    # everything (including third-party via the InterceptHandler below).
    stdout_id = logger.add(
        sys.stdout,
        level=resolved_level,
        format=_LOGURU_FORMAT,
        enqueue=False,
        backtrace=False,
        diagnose=False,
        colorize=False,
    )
    _INSTALLED_SINK_IDS.append(stdout_id)

    file_path: Path | None = None
    try:
        target_dir.mkdir(parents=True, exist_ok=True)
        _prune_old_files(target_dir, retention)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
        file_path = target_dir / f"llmrouter_manager-{stamp}.log"
        file_id = logger.add(
            str(file_path),
            level=resolved_level,
            format=_LOGURU_FORMAT,
            encoding="utf-8",
            enqueue=False,
            backtrace=False,
            diagnose=False,
            colorize=False,
        )
        _INSTALLED_SINK_IDS.append(file_id)
    except OSError as exc:
        # File sink unavailable — stdout still works. Emit one warning via
        # the already-attached stdout sink so the operator sees the drop.
        logger.warning(
            "log file setup failed at {}: {} (stdout logging still active)",
            target_dir,
            exc,
        )
        file_path = None

    # Bridge stdlib logging into loguru so third-party lib records land in
    # the same sinks. Root captures every record that survives per-logger
    # filtering; the loguru sinks apply the final level cut.
    root = logging.getLogger()
    root.addHandler(_InterceptHandler())
    # Root gates the effective level of any child logger that has NOT set
    # its own level. Keep this at WARNING (default) so unclamped third-party
    # libraries — including any lib whose name is not in
    # ``_THIRD_PARTY_LOGGERS`` yet — inherit WARNING and their INFO/DEBUG
    # records never reach the InterceptHandler. ``LRM_LOG_LEVEL=DEBUG``
    # opens root to DEBUG so those libraries' full diagnostics surface.
    root.setLevel(logging.DEBUG if is_debug else logging.WARNING)

    # LRM's own stdlib logger — kept alive for backwards compat with any
    # caller that still emits via ``logging.getLogger("llmrouter_manager")``.
    # Explicit level so records reach the InterceptHandler even when root
    # is above INFO.
    logging.getLogger("llmrouter_manager").setLevel(
        logging.DEBUG if is_debug else logging.INFO
    )

    # Third-party stdlib loggers: default clamp to WARNING+ (so
    # health-check polling never floods the file), DEBUG opens them.
    third_party_level = logging.DEBUG if is_debug else logging.WARNING
    for name in _THIRD_PARTY_LOGGERS:
        lg = logging.getLogger(name)
        lg.setLevel(third_party_level)
        lg.propagate = True

    return file_path
