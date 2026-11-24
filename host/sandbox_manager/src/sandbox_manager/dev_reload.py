"""Standalone-dev source watcher for ``python -m sandbox_manager --reload``.

Inner loop for iterating on this package (and on the native isolation broker it
drives): watch the package source tree and restart the control plane on an edit,
so a change lands without a packaging build. README §4.1 documents the workflow.

Nothing here is reachable from the packaged entry point: :func:`run` only calls
into this module when the dev-only ``--reload`` flag is passed, ServiceHub and
the frozen exe never pass it, and the supervisor refuses to run frozen.

**Why not uvicorn's own ``--reload``.** uvicorn's ``ChangeReload`` supervisor
restarts its worker with ``os.kill(pid, CTRL_C_EVENT)``. That worker is a
multiprocessing-spawn child, so it lives in the *supervisor's* console process
group and no process has a group id equal to the worker's pid — the console
control event is therefore delivered to nobody and the supervisor blocks forever
in ``process.join()``. Measured on Windows 11 (Python 3.12, uvicorn 0.50)
against a bare ``FastAPI`` app as well as against this service: the reloader logs
``detected changes … Reloading…`` and then serves the pre-edit code indefinitely.

So this supervisor runs the worker as a real child *process group* of its own and
signals that group, which Windows does deliver. The worker is the ordinary
``python -m sandbox_manager --port … --host …`` invocation — the same entry point
ServiceHub spawns — so what a contributor iterates on is the production boot
path, and the worker still gets uvicorn's graceful shutdown (``CTRL_BREAK_EVENT``
is in uvicorn's handled-signal set on Windows) before being killed as a fallback.
"""

from __future__ import annotations

import os
import signal
import subprocess
import sys
from collections.abc import Callable, Iterable
from functools import partial
from pathlib import Path

from loguru import logger

from .common.logging import DEV_RELOAD_WORKER_ENV

# Popen kwarg: make the worker its own process group so a console control event
# addressed to its pid actually reaches it (and so a Ctrl+C in the supervisor's
# console does not race us to it — the supervisor stops the worker itself).
# Absent off Windows, where the flag has no meaning and 0 is "no extra flags".
_CREATE_NEW_PROCESS_GROUP = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)

#: Graceful-stop budget before the worker is killed. Generous because the
#: lifespan shutdown tears down the native backend tree.
_STOP_TIMEOUT_SECONDS = 15.0
_KILL_TIMEOUT_SECONDS = 5.0


def package_source_dir() -> Path:
    """Directory watched for changes: this installed package's source tree.

    An editable install (``uv sync``) resolves this to the checkout's
    ``src/sandbox_manager``, which is what makes an edit observable at all.
    """
    return Path(__file__).resolve().parent


def worker_command(*, port: int, host: str) -> list[str]:
    """Argv for one worker generation.

    Deliberately the plain production invocation, and deliberately without
    ``--reload``: the worker must serve, not supervise.
    """
    return [
        sys.executable,
        "-m",
        "sandbox_manager",
        "--port",
        str(port),
        "--host",
        host,
    ]


def _spawn_worker(
    *, port: int, host: str, process_credential: str
) -> subprocess.Popen[bytes]:
    cmd = worker_command(port=port, host=host)
    env = {**os.environ, DEV_RELOAD_WORKER_ENV: "1"}
    if process_credential:
        env["SERVICEHUB_PROCESS_CREDENTIAL"] = process_credential
    else:
        env.pop("SERVICEHUB_PROCESS_CREDENTIAL", None)
    logger.info("dev reload: starting worker: {}", " ".join(cmd))
    return subprocess.Popen(
        cmd, creationflags=_CREATE_NEW_PROCESS_GROUP, env=env
    )


def stop_worker(
    proc: subprocess.Popen[bytes],
    *,
    stop_timeout: float = _STOP_TIMEOUT_SECONDS,
    kill_timeout: float = _KILL_TIMEOUT_SECONDS,
) -> bool:
    """Ask the worker to shut down gracefully, then kill it if it will not.

    ``CTRL_BREAK_EVENT`` on Windows (uvicorn handles ``SIGBREAK``), ``SIGINT``
    elsewhere. A worker that ignores the signal must not wedge the loop, so the
    wait is bounded and ``kill()`` is the fallback.

    Returns ``True`` once the worker is confirmed gone (already exited,
    exited after the signal, or exited after ``kill()``), ``False`` if it is
    still alive even after ``kill()``. The caller must not spawn a
    replacement worker on ``False``: the old process may still hold the
    listen port, and starting a new one anyway risks a bind collision between
    the two.
    """
    if proc.poll() is not None:
        return True
    graceful = getattr(signal, "CTRL_BREAK_EVENT", signal.SIGINT)
    try:
        proc.send_signal(graceful)
    except (OSError, ValueError):  # already gone, or signal unsupported here
        proc.kill()
    try:
        proc.wait(timeout=stop_timeout)
        return True
    except subprocess.TimeoutExpired:
        logger.warning(
            "dev reload: worker did not exit within {}s; killing it", stop_timeout
        )
    proc.kill()
    try:
        proc.wait(timeout=kill_timeout)
        return True
    except subprocess.TimeoutExpired:
        logger.error("dev reload: worker survived kill(); restart it manually")
        return False


def describe_changes(batch: object) -> str:
    """Render one watchfiles change batch as the changed file names.

    The raw batch is a set of ``(Change, absolute path)`` tuples, which is far
    too noisy for a console line; anything unexpected falls back to ``repr``.
    """
    try:
        # Split on both separators, not just the host OS's: this module only
        # ever runs on Windows, but the unit tests run on Linux CI too, and
        # pathlib.Path resolves "/" vs "\\" per the *test runner's* platform,
        # not the platform the path string actually came from.
        names = sorted({str(path).replace("\\", "/").rsplit("/", 1)[-1] for _, path in batch})  # type: ignore[union-attr]
    except (TypeError, ValueError):
        return repr(batch)
    return ", ".join(names) if names else repr(batch)


def _default_change_stream(watch_dir: Path) -> Iterable[object]:
    # watchfiles ships with uvicorn[standard]; PythonFilter keeps __pycache__
    # writes and editor swap files from triggering a restart.
    from watchfiles import PythonFilter, watch

    return watch(watch_dir, watch_filter=PythonFilter(), raise_interrupt=False)


def watch_and_serve(
    *,
    port: int,
    host: str,
    process_credential: str = "",
    changes: Iterable[object] | None = None,
    spawn: Callable[[], subprocess.Popen[bytes]] | None = None,
) -> None:
    """Run the dev watch/restart loop until interrupted.

    ``changes`` and ``spawn`` are test seams; production callers pass neither.
    Returns when the change stream ends (Ctrl+C), having stopped the worker.
    """
    if getattr(sys, "frozen", False):
        raise SystemExit(
            "--reload is a source-checkout dev flag and cannot run from a frozen "
            "build: it restarts `python -m sandbox_manager` from the source tree. "
            "Run it from host/sandbox_manager instead."
        )

    watch_dir = package_source_dir()
    if changes is None:
        changes = _default_change_stream(watch_dir)
    spawn_worker = spawn or partial(
        _spawn_worker,
        port=port,
        host=host,
        process_credential=process_credential,
    )

    # ASCII only: this line goes to a Windows console whose code page is
    # typically cp1252, where a non-ASCII character renders as garbage.
    logger.info(
        "dev reload: watching {} (the app logs to <DATA_DIR>/logs/manager; "
        "Ctrl+C to stop)",
        watch_dir,
    )
    proc = spawn_worker()
    try:
        for batch in changes:
            logger.info(
                "dev reload: change in {}; restarting worker", describe_changes(batch)
            )
            if not stop_worker(proc):
                # The old worker is still alive (survived kill()) and may still
                # own the listen port. Starting a fresh worker now would race it
                # for the bind, so skip this restart instead of spawning a
                # second process against the same port. `proc` stays the old,
                # stuck worker; the next change batch tries to stop it again.
                logger.error(
                    "dev reload: previous worker did not exit; skipping restart "
                    "to avoid a port-bind collision. Stop it manually (it may "
                    "still hold the port), then save again to retry."
                )
                continue
            proc = spawn_worker()
    finally:
        stop_worker(proc)
