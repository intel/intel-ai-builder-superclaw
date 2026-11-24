"""Per-run trace capture for the Protected File Pipeline.

Each ``/v1/file/protect`` request writes its own chronological log under::

    <security logs>/pipeline_runs/<session>/<timestamp>_<operation_id>/pipeline.log

so a single protected-file run can be read end to end without grepping the
shared daily logs.

Two sinks are attached for the lifetime of one run and removed afterwards:

* a stdlib :mod:`logging` handler on the root logger, capturing the
  ``data_protection`` route lines; and
* a loguru sink, capturing the vendored ``llm_pipeline`` orchestrator, tool and
  client lines including their DEBUG prompt/response dumps.

Both are scoped by a :class:`~contextvars.ContextVar`, so concurrent requests
never write into each other's file. Capture is best-effort: any failure to set
up or tear down a sink is swallowed, because tracing must never break file
protection.
"""

from __future__ import annotations

import functools
import logging
import os
import re
import sys
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from contextvars import ContextVar
from pathlib import Path
from typing import Any, Awaitable, Callable, Iterator

from protection_service.io.session_utils import new_operation_id

try:  # pragma: no cover - loguru ships with the vendored llm_pipeline.
    from loguru import logger as _loguru_logger
except ImportError:  # pragma: no cover - degrade to stdlib-only capture.
    _loguru_logger = None

# Identifies which run the current async context belongs to. Read by both sink
# filters at emit time; contextvars propagate across ``await`` and
# ``asyncio.to_thread``, so nested pipeline work stays attributed correctly.
_RUN_KEY: ContextVar[str | None] = ContextVar("pfp_run_key", default=None)

# Operation id minted by :func:`traced_pipeline_run` so the decorator and the
# route body agree on one id without changing the handler signature.
_OPERATION_ID: ContextVar[str] = ContextVar("pfp_operation_id", default="")

# Path of the in-flight run's trace file, so the shared daily log can name it.
_RUN_LOG_PATH: ContextVar[str] = ContextVar("pfp_run_log_path", default="")

_STDLIB_FMT = "%(asctime)s.%(msecs)03dZ [%(levelname)s] %(name)s: %(message)s"
_STDLIB_DATEFMT = "%Y-%m-%dT%H:%M:%S"
# Trailing literal ``Z`` rather than loguru's ``Z`` token (which renders the
# ``+00:00`` offset), so both sinks timestamp identically inside one run file.
_LOGURU_FMT = "{time:YYYY-MM-DDTHH:mm:ss.SSS!UTC}Z [{level}] {extra[name]}: {message}"

# Keep the most recent run directories per session so long-lived installs do not
# accumulate unbounded trace folders.
_MAX_RUNS_PER_SESSION = 50

_RUN_LOG_NAME = "pipeline.log"


def _security_log_dir() -> Path:
    """Return the security log root, matching the service's own log location.

    Returns:
        Path: ``%LOCALAPPDATA%\\SuperClaw\\security\\logs`` on Windows, or a
        temp-dir equivalent elsewhere.
    """
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(base) / "SuperClaw" / "security" / "logs"
    import tempfile

    return Path(tempfile.gettempdir()) / "SuperClaw-security" / "logs"


def pipeline_runs_root() -> Path:
    """Return the directory holding one folder per protected-file run.

    Returns:
        Path: ``<security logs>/pipeline_runs``.
    """
    return _security_log_dir() / "pipeline_runs"


def _safe_component(value: str | None, fallback: str) -> str:
    """Sanitize an untrusted id into a single safe path component.

    ``session_id`` arrives from the request body, so it must never be able to
    escape the runs root via separators or ``..`` segments.

    Args:
        value: Raw identifier, possibly ``None`` or attacker-controlled.
        fallback: Component to use when nothing usable remains.

    Returns:
        str: A filesystem-safe component containing only ``[A-Za-z0-9._-]``.
    """
    if not value:
        return fallback
    cleaned = re.sub(r"[^A-Za-z0-9._-]", "_", value.strip())
    cleaned = cleaned.strip("._")
    return (cleaned or fallback)[:64]


def _prune_old_runs(session_dir: Path) -> None:
    """Drop the oldest run folders for one session, keeping the newest few.

    Args:
        session_dir: Directory holding this session's run folders.
    """
    try:
        runs = sorted(
            (path for path in session_dir.iterdir() if path.is_dir()),
            key=lambda path: path.name,
        )
        for stale in runs[:-_MAX_RUNS_PER_SESSION]:
            for child in stale.iterdir():
                child.unlink(missing_ok=True)
            stale.rmdir()
    except OSError:
        # Pruning is opportunistic; a locked or vanished folder is not an error.
        return


class _RunScopeFilter(logging.Filter):
    """Admit only records emitted inside one specific pipeline run."""

    def __init__(self, run_key: str) -> None:
        """Store the run this handler belongs to.

        Args:
            run_key: Unique key identifying the run.
        """
        super().__init__()
        self._run_key = run_key

    def filter(self, record: logging.LogRecord) -> bool:
        """Return whether the record was emitted inside this run.

        Args:
            record: Candidate log record.

        Returns:
            bool: ``True`` when the current context belongs to this run.
        """
        return _RUN_KEY.get() == self._run_key


@contextmanager
def capture_pipeline_run(
    session_id: str | None,
    operation_id: str,
    *,
    source_file_path: str | None = None,
) -> Iterator[Path | None]:
    """Mirror every log line of one protected-file run into its own folder.

    Args:
        session_id: Caller session id used to group runs. May be ``None``.
        operation_id: Operation id for this run, used in the folder name.
        source_file_path: Caller-supplied path, recorded in the file header.

    Yields:
        Path | None: The run log file, or ``None`` when capture is unavailable.
    """
    run_key = f"{session_id or '-'}:{operation_id}"
    started = datetime.now(timezone.utc)
    session_component = _safe_component(session_id, "no-session")
    run_component = f"{started.strftime('%Y%m%dT%H%M%S')}_{_safe_component(operation_id, 'run')}"

    log_path: Path | None = None
    handler: logging.Handler | None = None
    loguru_sink_id: int | None = None
    token = _RUN_KEY.set(run_key)
    started_at = time.monotonic()

    try:
        session_dir = pipeline_runs_root() / session_component
        run_dir = session_dir / run_component
        run_dir.mkdir(parents=True, exist_ok=True)
        _prune_old_runs(session_dir)
        log_path = run_dir / _RUN_LOG_NAME

        log_path.write_text(
            f"# Protected File Pipeline run trace\n"
            f"# started_utc={started.strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3]}Z\n"
            f"# session_id={session_id or '-'}\n"
            f"# operation_id={operation_id}\n"
            f"# source_file_path={source_file_path or '-'}\n"
            f"# boot_id={(os.environ.get('SUPERCLAW_BOOT_ID') or '-').strip() or '-'}\n"
            f"#\n",
            encoding="utf-8",
        )

        formatter = logging.Formatter(_STDLIB_FMT, datefmt=_STDLIB_DATEFMT)
        formatter.converter = time.gmtime
        handler = logging.FileHandler(log_path, encoding="utf-8", delay=True)
        handler.setFormatter(formatter)
        handler.setLevel(logging.DEBUG)
        handler.addFilter(_RunScopeFilter(run_key))
        logging.getLogger().addHandler(handler)

        if _loguru_logger is not None:
            loguru_sink_id = _loguru_logger.add(
                log_path,
                level="DEBUG",
                format=_LOGURU_FMT,
                encoding="utf-8",
                filter=lambda record: _RUN_KEY.get() == run_key,
            )
    except (OSError, ValueError):
        # Never fail a protection request because tracing could not start.
        log_path = None

    path_token = _RUN_LOG_PATH.set(str(log_path) if log_path is not None else "")
    try:
        yield log_path
    finally:
        _RUN_LOG_PATH.reset(path_token)
        if log_path is not None:
            try:
                with log_path.open("a", encoding="utf-8") as stream:
                    stream.write(
                        f"#\n# run finished elapsed_seconds="
                        f"{time.monotonic() - started_at:.3f}\n"
                    )
            except OSError:
                pass
        if loguru_sink_id is not None and _loguru_logger is not None:
            try:
                _loguru_logger.remove(loguru_sink_id)
            except ValueError:
                pass
        if handler is not None:
            logging.getLogger().removeHandler(handler)
            handler.close()
        _RUN_KEY.reset(token)


def current_operation_id() -> str:
    """Return the operation id minted for the in-flight run.

    Returns:
        str: The current run's operation id, or ``""`` outside a traced run.
    """
    return _OPERATION_ID.get()


def current_run_log_path() -> str:
    """Return the trace file path for the in-flight run.

    Returns:
        str: Absolute path of the run's ``pipeline.log``, or ``""`` when tracing
        is unavailable or no run is active.
    """
    return _RUN_LOG_PATH.get()


def traced_pipeline_run(
    handler: Callable[..., Awaitable[Any]],
) -> Callable[..., Awaitable[Any]]:
    """Wrap a protect route so each request writes its own run trace folder.

    The operation id is minted here and exposed through
    :func:`current_operation_id`, so the wrapped handler keeps its signature and
    FastAPI's dependency resolution is unaffected.

    Args:
        handler: The async route handler to wrap.

    Returns:
        Callable[..., Awaitable[Any]]: The wrapped handler.
    """

    @functools.wraps(handler)
    async def wrapper(req: Any, *args: Any, **kwargs: Any) -> Any:
        operation_id = new_operation_id()
        operation_token = _OPERATION_ID.set(operation_id)
        try:
            with capture_pipeline_run(
                getattr(req, "session_id", None),
                operation_id,
                source_file_path=getattr(req, "source_file_path", None),
            ):
                return await handler(req, *args, **kwargs)
        finally:
            _OPERATION_ID.reset(operation_token)

    return wrapper
