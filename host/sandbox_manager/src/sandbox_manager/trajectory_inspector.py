"""Trajectory Inspector supervisor (host-side debug tool).

When ``SUPERCLAW_DEBUG_OBSERVABILITY=1`` the sandbox-manager makes sure the
SuperClaw Inspector (``tools/trajectory``) is running on ``localhost:7778`` so
engineers never have to start it by hand. It is brought up *after* the backend
runtime deployment converges (the inspector scrapes the owner token from the
running backend), from every chokepoint that reaches Ready, via
``NativeBackendLifecycle._schedule_trajectory_inspector``.

Design notes
------------
* **Idempotent.** :meth:`ensure_running` is a no-op when the flag is off (it
  stops a stray instance), a no-op when ``/health`` already answers, and a
  start otherwise. Safe to call on every ``ensure_ready`` (which can run many
  times per session).
* **No restart-on-recycle needed.** The inspector self-heals a stale owner
  token on its own: ``tools/trajectory/src/server.ts`` retries 401s via
  ``refreshAuth`` (re-detects the token + workspace). So we only need to keep
  *a* process alive, not respawn it whenever the backend recycles.
* **Fail-safe.** Any error here is logged and swallowed — the inspector is a
  debug aid and must never break backend bring-up.

The inspector is launched only from the canonical packaged location:
``<resources>/superclaw-trajectory.exe``. Developers can run the source server
manually; the health check above will adopt it without spawning another process.
"""

from __future__ import annotations

import asyncio
import os
import socket
import subprocess
import time
from pathlib import Path

import httpx
from loguru import logger

# The bundled inspector is a ~98 MB single-file bun binary, so a cold first launch
# can spend most of a minute being scanned before it binds the port.
_READY_TIMEOUT_S = 30.0
_READY_POLL_S = 0.5


_CHILD_ENV_KEYS = (
    "SYSTEMROOT",
    "WINDIR",
    "PATH",
    "TEMP",
    "TMP",
    "LOCALAPPDATA",
    "SERVICEHUB_DATA_DIR",
)


def _debug_observability_enabled() -> bool:
    """Read the flag fresh each call (mirrors llm_router_serve._debug_observability_enabled)."""
    return (os.environ.get("SUPERCLAW_DEBUG_OBSERVABILITY") or "").strip() == "1"


def _port() -> int:
    raw = (os.environ.get("TRAJECTORY_PORT") or "").strip()
    try:
        p = int(raw)
        if 1 <= p <= 65535:
            return p
    except ValueError:
        pass
    return 7778


def _child_environment(port: int) -> dict[str, str]:
    env = {key: os.environ[key] for key in _CHILD_ENV_KEYS if os.environ.get(key)}
    env["PORT"] = str(port)
    env["TRAJECTORY_NO_OPEN"] = "1"
    return env


class TrajectoryInspector:
    """Supervises the host-side inspector process. One instance per sandbox-manager."""

    def __init__(self, cfg) -> None:
        self._cfg = cfg
        self._port = _port()
        self._proc: subprocess.Popen | None = None
        self._last_state: str | None = None

    # ---------------------------------------------------------------- public

    async def ensure_running(self) -> None:
        """Bring the inspector up iff debug observability is on. Never raises."""
        try:
            if not _debug_observability_enabled():
                self._log_state(
                    "disabled",
                    "[trajectory] SUPERCLAW_DEBUG_OBSERVABILITY != 1; inspector "
                    "disabled (port={})",
                    self._port,
                )
                self.stop()  # flag toggled off → clean up any stray instance
                return
            if await asyncio.to_thread(self._healthy):
                # already serving (ours or a manual instance) - leave it
                self._log_state(
                    "serving",
                    "[trajectory] inspector already serving "
                    "http://127.0.0.1:{}/health; adopting (not starting another)",
                    self._port,
                )
                return
            # The port probe and the spawn block; on the loop they stall the evidence probes (#3936).
            # A cancelled bring-up still waits for the thread, so the task (the lifecycle's one
            # bring-up slot) is not done while a spawn may still land, and `_proc` records it.
            start = asyncio.create_task(asyncio.to_thread(self._start))
            try:
                await asyncio.shield(start)
            except asyncio.CancelledError:
                try:
                    await start
                except Exception:  # noqa: BLE001 - the cancellation is what propagates
                    pass
                raise
            if self._proc is None:
                # _start() already logged why: the port is held by a process we do
                # not own, or the exe is not staged. Nothing to verify.
                self._last_state = "not_started"
                return
            self._last_state = "serving" if await self._confirm_serving() else "failed"
        except Exception:  # noqa: BLE001 - debug aid must not break bring-up
            logger.opt(exception=True).warning("[trajectory] ensure_running failed")

    def stop(self) -> None:
        proc = self._proc
        self._proc = None
        if proc and proc.poll() is None:
            try:
                proc.terminate()
            except Exception:  # noqa: BLE001
                pass

    # ---------------------------------------------------------------- internals

    def _healthy(self) -> bool:
        try:
            # trust_env=False: the inspector is reached over loopback (127.0.0.1); a
            # corporate HTTP_PROXY must never intercept it, and httpx does not honor
            # NO_PROXY CIDR entries such as 127.0.0.0/8. Without this a proxy can
            # answer 200 and make ensure_running() conclude "already serving" while
            # nothing is listening, which the UI then reports as a refused iframe.
            r = httpx.get(
                f"http://127.0.0.1:{self._port}/health", timeout=2.0, trust_env=False
            )
            return r.status_code == 200
        except Exception:  # noqa: BLE001
            return False

    def _port_in_use(self) -> bool:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(0.5)
            return s.connect_ex(("127.0.0.1", self._port)) == 0

    def _resolve_launch(self) -> tuple[list[str], str | None] | None:
        """Return (argv, cwd) for the inspector, or None if it can't be located."""
        bundled = Path(self._cfg.resources_dir) / "superclaw-trajectory.exe"
        if bundled.is_file():
            return [str(bundled)], None
        return None

    def _start(self) -> None:
        if self._port_in_use():
            # Something already holds the port (a manual inspector). Don't fight it.
            logger.info("[trajectory] port {} already in use — not starting", self._port)
            return
        launch = self._resolve_launch()
        if launch is None:
            logger.warning(
                "[trajectory] inspector not found at canonical resources path; "
                "skipping auto-start"
            )
            return
        argv, cwd = launch

        env = _child_environment(self._port)

        log_dir = Path(self._cfg.data_dir) / "logs"
        log_dir.mkdir(parents=True, exist_ok=True)
        log_path = log_dir / "trajectory-inspector.log"

        creationflags = 0
        if os.name == "nt":
            # New process group so a Ctrl-C to us doesn't take it down mid-flight.
            creationflags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0) | getattr(subprocess, "CREATE_NO_WINDOW", 0)

        logger.info("[trajectory] starting inspector: {} (cwd={})", " ".join(argv), cwd)
        log_fp = open(log_path, "ab", buffering=0)
        proc = subprocess.Popen(  # noqa: S603 - argv is resolved from trusted sources
            argv,
            cwd=cwd,
            env=env,
            stdout=log_fp,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            creationflags=creationflags,
        )
        self._proc = proc

        # NOTE: deliberately NOT assigned to the supervisor's kill-on-close job.
        # That job's handle dies with the *specific* sandbox-manager instance
        # that spawned us, and sandbox-manager instances churn during boot — so
        # binding to it killed the inspector mid-startup. Running independently
        # is safe: ensure_running() is idempotent (it adopts a live :7778 via the
        # health check) and the inspector self-heals a stale token on 401.
        logger.info("[trajectory] inspector launched (pid={}, log={})", proc.pid, log_path)

    # ------------------------------------------------- diagnostics

    def _log_state(self, state: str, message: str, *args) -> None:
        """INFO on transition, DEBUG while unchanged: one evidence line per change.

        ``ensure_running()`` runs on every ready transition *and* every deployment
        reuse fast path, so an unconditional INFO would flood ``sbms-*.log``.
        Transition-only keeps the log readable while guaranteeing it is never
        silent: the gap that made #2546 and #2208 indistinguishable from the UI.
        """
        level = "INFO" if state != self._last_state else "DEBUG"
        self._last_state = state
        logger.opt(depth=1).log(level, message, *args)

    def _log_file(self) -> Path:
        """Where :meth:`_start` tees the child's stdout/stderr."""
        # The literal is duplicated with _start() on purpose: _start()'s body is
        # rewritten by PR #2377, so keeping this out of it avoids a merge conflict.
        return Path(self._cfg.data_dir) / "logs" / "trajectory-inspector.log"

    async def _confirm_serving(self) -> bool:
        """Poll ``/health`` until the freshly spawned child answers. Logs the outcome.

        :meth:`_start` only proves ``CreateProcess`` succeeded; the inspector still
        dies on a missing ``ui/`` directory, an unreadable payload or a port race,
        and logged "inspector launched (pid=...)" regardless. #2546 asks for a 200
        from ``GET /health`` to be asserted, so assert it here and leave exactly one
        actionable line in the manager log when it never arrives.
        """
        proc = self._proc
        deadline = time.monotonic() + _READY_TIMEOUT_S
        while time.monotonic() < deadline:
            if proc is not None and proc.poll() is not None:
                logger.error(
                    "[trajectory] inspector exited during startup "
                    "(pid={} exit_code={}); see {}",
                    proc.pid,
                    proc.returncode,
                    self._log_file(),
                )
                self._proc = None
                return False
            if await asyncio.to_thread(self._healthy):
                logger.info(
                    "[trajectory] inspector serving http://127.0.0.1:{}/health (pid={})",
                    self._port,
                    getattr(proc, "pid", None),
                )
                return True
            await asyncio.sleep(_READY_POLL_S)
        logger.error(
            "[trajectory] inspector did not answer GET http://127.0.0.1:{}/health "
            "within {}s; Dev Tools -> Trajectory will show a connection error. See {}",
            self._port,
            _READY_TIMEOUT_S,
            self._log_file(),
        )
        return False
