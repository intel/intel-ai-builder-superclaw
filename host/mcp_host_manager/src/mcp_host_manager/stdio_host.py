"""One stdio MCP server process per registered host server, spoken to as an MCP client.

The process is created suspended in its own Job (``job.py``), so it runs only inside it, and it gets
an explicit environment: the user's own minus SuperClaw's credentials and the frozen bundle's state,
plus what the user registered. Messages are newline-delimited JSON-RPC on its stdin and stdout.
Because the process must be assigned to its Job before it runs, it is a ``subprocess.Popen`` and its
pipes are bridged to the event loop by threads. Its stderr goes into a bounded ring whose last lines
are logged when it fails.
"""

from __future__ import annotations

import asyncio
import contextlib
import itertools
import json
import os
import shutil
import subprocess
import sys
import threading
from collections import deque
from collections.abc import Callable, Coroutine, Mapping, Sequence
from pathlib import Path

from loguru import logger

from . import __version__
from .job import HostJob, HostJobError, spawn_in_job

CLIENT_PROTOCOL_VERSION = "2025-06-18"
CLIENT_NAME = "superclaw-mcp-host"
STARTUP_TIMEOUT_S = 60.0
JOB_ACTIVE_PROCESS_LIMIT = 128
JOB_MEMORY_LIMIT_BYTES = 8 * 1024 * 1024 * 1024
METHOD_NOT_FOUND = -32601

# SuperClaw's own credentials and configuration that ServiceHub children inherit: the hub and process
# credentials, the LRM / data-protection / privacy keys, the telemetry export endpoint and headers
# (the headers carry SuperClaw's telemetry token), and the frozen bundle's loader state.
_STRIPPED_PREFIXES = (
    "SERVICEHUB_",
    "SUPERCLAW_",
    "OPENWORK_",
    "OPENCODE_",
    "LRM_",
    "LLMROUTER_",
    "SC_",
    "MCP_HOST_MANAGER_",
    "OTEL_EXPORTER_OTLP_",
    "DATA_PROTECTION_",
    "PROTECTION_",
    "PRIVACY_",
    "_PYI",
    "PYINSTALLER",
)
_STRIPPED_NAMES = frozenset({"_MEIPASS2", "PYTHONHOME", "PYTHONPATH"})
# cmd.exe reinterprets these even inside the line `list2cmdline` builds: `"` is escaped as `\"`,
# which cmd does not understand, `%` and `!` expand variables, `(` `)` group commands, and the rest
# split or redirect the command.
_CMD_UNSAFE = frozenset('"%!^&|<>()\r\n')
_DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD"
_MAX_LINE_BYTES = 64 * 1024 * 1024
_STDERR_LINES = 50
_STDERR_LINE_CHARS = 500
_STDERR_READ_BYTES = 64 * 1024
_STDERR_LOGGED_LINES = 20
_TOOLS_MAX_PAGES = 100
_REFRESH_TIMEOUT_S = 30.0
_STOP_WAIT_S = 5.0


class ServerUnavailable(Exception):
    """The server is not running, died, or did not answer in time."""


class ServerStartFailed(ServerUnavailable):
    """The server could not be started or did not complete the MCP handshake."""


class RequestCancelled(Exception):
    """The gateway's client cancelled the request this one was forwarded for."""


class JsonRpcError(Exception):
    def __init__(self, code: int, message: str, data: object = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data

    def as_error(self) -> dict[str, object]:
        error: dict[str, object] = {"code": self.code, "message": self.message}
        if self.data is not None:
            error["data"] = self.data
        return error


def _stripped(name: str) -> bool:
    upper = name.upper()
    return upper in _STRIPPED_NAMES or upper.startswith(_STRIPPED_PREFIXES)


def _same_name(left: str, right: str) -> bool:
    return left.upper() == right.upper() if sys.platform == "win32" else left == right


def _env_get(env: Mapping[str, str], name: str) -> str | None:
    for key, value in env.items():
        if _same_name(key, name):
            return value
    return None


def _under(entry: str, root: str) -> bool:
    candidate, base = Path(entry.strip('"').casefold()), Path(root.casefold())
    return candidate == base or candidate.is_relative_to(base)


def child_environment(registered: Mapping[str, str], base: Mapping[str, str] | None = None) -> dict[str, str]:
    """The environment block a host server starts with."""
    env = {key: value for key, value in (os.environ if base is None else base).items() if not _stripped(key)}
    meipass = getattr(sys, "_MEIPASS", None) if getattr(sys, "frozen", False) else None
    if meipass:
        for key in [key for key in env if _same_name(key, "PATH")]:
            env[key] = os.pathsep.join(
                entry for entry in env[key].split(os.pathsep) if entry and not _under(entry, meipass)
            )
    for name, value in registered.items():
        for existing in [key for key in env if _same_name(key, name)]:
            del env[existing]
        env[name] = value
    return env


def _find_program(program: str, search_path: str | None, pathext: str | None) -> Path | None:
    """PATH and PATHEXT lookup as CreateProcess users expect, but never in the current directory."""
    extensions = [ext.lower() for ext in (pathext or _DEFAULT_PATHEXT).split(";") if ext]
    candidate = Path(program)
    names = (
        [program]
        if candidate.suffix and candidate.suffix.lower() in extensions
        else [program + ext for ext in extensions]
    )
    if candidate.is_absolute():
        return next((Path(name) for name in names if Path(name).is_file()), None)
    if len(candidate.parts) > 1:
        return None
    for directory in (search_path or "").split(os.pathsep):
        directory = directory.strip().strip('"')
        if not directory:
            continue
        for name in names:
            found = Path(directory) / name
            if found.is_file():
                return found
    return None


def resolve_command(command: Sequence[str], env: Mapping[str, str]) -> list[str] | str:
    """The argv (or, for a batch file, the exact command line) to start ``command`` with.

    A ``.cmd`` or ``.bat`` (``npx``, ``uvx`` shims) runs as ``cmd.exe /d /v:off /s /c "<line>"``,
    where ``<line>`` is ``list2cmdline`` of the resolved argv. ``/s`` makes cmd strip exactly the
    outer quotes, so the line must reach CreateProcess as built here, and no argument may contain a
    character cmd would still reinterpret (``" % ! ^ & | < > ( )`` or a line break).
    """
    program, arguments = command[0], list(command[1:])
    if sys.platform != "win32":
        found_posix = shutil.which(program, path=_env_get(env, "PATH"))
        if found_posix is None:
            raise ServerStartFailed("the command was not found")
        return [found_posix, *arguments]
    found = _find_program(program, _env_get(env, "PATH"), _env_get(env, "PATHEXT"))
    if found is None:
        raise ServerStartFailed("the command was not found")
    if found.suffix.lower() not in (".cmd", ".bat"):
        return [str(found), *arguments]
    resolved = [str(found), *arguments]
    if any(char in _CMD_UNSAFE for argument in resolved for char in argument):
        raise ServerStartFailed("a batch-file command has an argument cmd.exe would reinterpret")
    comspec = os.environ.get("ComSpec") or str(
        Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "cmd.exe"
    )
    return f'"{comspec}" /d /v:off /s /c "{subprocess.list2cmdline(resolved)}"'


class StdioServer:
    def __init__(
        self,
        name: str,
        command: Sequence[str],
        environment: Mapping[str, str],
        *,
        startup_timeout_s: float = STARTUP_TIMEOUT_S,
        cwd: Path | None = None,
        on_tools: Callable[[list[dict[str, object]], str | None], None] | None = None,
    ) -> None:
        """``on_tools`` hears every tool list the server gives at start or on refresh, with the
        instructions from its ``initialize``, so the gateway can keep the last good one."""
        self.name = name
        self._on_tools = on_tools
        self.command = tuple(command)
        self._environment = dict(environment)
        self._startup_timeout_s = startup_timeout_s
        self._cwd = cwd
        self.state = "stopped"
        self.error_code: str | None = None
        self.instructions: str | None = None
        self._tools: list[dict[str, object]] = []
        self._job: HostJob | None = None
        self._process: subprocess.Popen[bytes] | None = None
        self._generation = 0
        self._ids = itertools.count(1)
        self._waiting: dict[int, asyncio.Future[object]] = {}
        self._stderr: deque[str] = deque(maxlen=_STDERR_LINES)
        self._start_lock = asyncio.Lock()
        self._write_lock = threading.Lock()
        self._stopping = False
        self._exited = False
        self._stops = 0
        self._start_attempts = 0
        self._tools_changed = 0
        self._tools_fresh_at = 0
        self._loop: asyncio.AbstractEventLoop | None = None
        self._background: set[asyncio.Task[object]] = set()

    @property
    def pid(self) -> int | None:
        return self._process.pid if self._process is not None else None

    @property
    def job(self) -> HostJob | None:
        return self._job

    @property
    def tools(self) -> list[dict[str, object]]:
        return list(self._tools)

    def tool(self, name: str) -> dict[str, object] | None:
        return next((tool for tool in self._tools if tool.get("name") == name), None)

    @property
    def tools_stale(self) -> bool:
        """The server said its tools changed (or a refresh failed) since the cache was last filled."""
        return self._tools_fresh_at != self._tools_changed

    async def start(self) -> None:
        """Start the server if it is not running; raises ServerStartFailed or ServerUnavailable.
        Concurrent callers share one start, including its failure, and a caller that queued behind a
        ``stop()`` is refused rather than starting a server that was stopped (or dropped) meanwhile."""
        stops = self._stops
        attempts = self._start_attempts
        async with self._start_lock:
            if self._stops != stops:
                raise ServerUnavailable("the server was stopped while this start waited")
            if self.state == "running" and self._process is not None:
                return
            if self._start_attempts != attempts and self.state == "failed":
                raise ServerStartFailed("the start this call waited for failed")
            try:
                await self._start()
            finally:
                self._start_attempts += 1

    async def _start(self) -> None:
        self._loop = asyncio.get_running_loop()
        self._reap_in_background(self._detach())
        generation = self._generation
        self._stopping = False
        self._stderr.clear()
        self.state, self.error_code = "starting", None
        env = child_environment(self._environment)
        try:
            argv = resolve_command(self.command, env)
            job = HostJob.create(
                active_process_limit=JOB_ACTIVE_PROCESS_LIMIT,
                job_memory_limit_bytes=JOB_MEMORY_LIMIT_BYTES,
            )
            try:
                process = await asyncio.to_thread(spawn_in_job, job, argv, env=env, cwd=self._cwd)
            except BaseException:
                job.close()
                raise
        except (ServerStartFailed, HostJobError) as exc:
            logger.warning("host MCP server did not start server={} reason={}", self.name, exc)
            if generation == self._generation:
                self.state, self.error_code = "failed", "host_mcp_server_start_failed"
            raise ServerStartFailed(str(exc)) from exc
        except BaseException:
            if generation == self._generation:
                self.state = "stopped"
            raise
        if generation != self._generation:
            job.close()
            self._reap_in_background(process)
            raise ServerUnavailable("the server was stopped while it started")
        self._job, self._process, self._exited = job, process, False
        threading.Thread(
            target=self._read_stdout, args=(process, generation), name=f"mcp-host-{self.name}-out", daemon=True
        ).start()
        threading.Thread(
            target=self._read_stderr, args=(process,), name=f"mcp-host-{self.name}-err", daemon=True
        ).start()
        threading.Thread(
            target=self._wait_exit, args=(process, generation), name=f"mcp-host-{self.name}-wait", daemon=True
        ).start()
        try:
            async with asyncio.timeout(self._startup_timeout_s):
                initialized = await self._request(
                    "initialize",
                    {
                        "protocolVersion": CLIENT_PROTOCOL_VERSION,
                        "capabilities": {},
                        "clientInfo": {"name": CLIENT_NAME, "version": __version__},
                    },
                )
                await self._write({"jsonrpc": "2.0", "method": "notifications/initialized"})
                tools = await self._list_tools()
        except BaseException as exc:
            # Cancellation included: the Job is closed here, synchronously, so no start that
            # was abandoned half way can leave a tree nothing supervises.
            handshake_failed = isinstance(exc, (TimeoutError, ServerUnavailable, JsonRpcError))
            if generation == self._generation:
                self._reap_in_background(self._detach())
                if handshake_failed:
                    logger.warning(
                        "host MCP server failed its handshake server={} reason={} stderr_tail={!r}",
                        self.name,
                        type(exc).__name__,
                        self._stderr_tail(),
                    )
                    self.state, self.error_code = "failed", "host_mcp_server_start_failed"
                else:
                    self.state, self.error_code = "stopped", None
            if handshake_failed:
                raise ServerStartFailed("the MCP handshake did not complete") from exc
            raise
        instructions = initialized.get("instructions") if isinstance(initialized, dict) else None
        self.instructions = instructions if isinstance(instructions, str) else None
        self._tools = tools
        self._tools_fresh_at = self._tools_changed
        self.state = "running"
        logger.info("host MCP server running server={} pid={} tools={}", self.name, process.pid, len(tools))
        self._report_tools()

    async def request(
        self,
        method: str,
        params: dict[str, object] | None,
        timeout_s: float,
        *,
        on_sent: Callable[[int], None] | None = None,
    ) -> object:
        """Send one request to a running server; raises ServerUnavailable, JsonRpcError, or
        RequestCancelled after ``cancel_request``. ``on_sent`` gets the request's id."""
        if self.state != "running":
            raise ServerUnavailable("the server is not running")
        return await self._request(method, params, timeout_s, on_sent=on_sent)

    def cancel_request(self, request_id: int) -> bool:
        """Stop waiting for ``request_id`` and tell the server it was cancelled. False when it was not
        in flight."""
        future = self._waiting.get(request_id)
        if future is None or future.done():
            return False
        future.set_exception(RequestCancelled())
        self._spawn(self._notify_cancelled(request_id, "cancelled by the client"))
        return True

    async def refresh_tools(self) -> list[dict[str, object]]:
        """Reload the tool list. A failed reload empties the cache rather than keep annotations the
        server may have since withdrawn, so the next call reloads again."""
        if self.state == "running":
            changed = self._tools_changed
            try:
                async with asyncio.timeout(_REFRESH_TIMEOUT_S):
                    tools = await self._list_tools()
            except (TimeoutError, ServerUnavailable, JsonRpcError) as exc:
                logger.warning("host MCP tool list refresh failed server={} reason={}", self.name, type(exc).__name__)
                self._tools = []
                self._tools_changed += 1
            else:
                self._tools = tools
                self._tools_fresh_at = changed
                self._report_tools()
        return self.tools

    def _report_tools(self) -> None:
        if self._on_tools is not None:
            self._on_tools(self.tools, self.instructions)

    async def stop(self) -> bool:
        """Stop the server and its whole tree at once, even mid-start; True when a process was live.

        Not under the start lock: a stop must not wait out a 60 s handshake. Closing the Job fails the
        handshake, and the start that was running sees the generation moved and leaves the state
        alone."""
        was_live = self._process is not None or self.state == "starting"
        self._stops += 1
        self._stopping = True
        process = self._detach()
        self.state, self.error_code = "stopped", None
        if process is not None:
            await asyncio.shield(asyncio.to_thread(_reap, process))
        return was_live

    async def _list_tools(self) -> list[dict[str, object]]:
        tools: list[dict[str, object]] = []
        cursor: object = None
        for _ in range(_TOOLS_MAX_PAGES):
            page = await self._request("tools/list", {"cursor": cursor} if cursor else None)
            listed = page.get("tools") if isinstance(page, dict) else None
            if not isinstance(listed, list):
                raise JsonRpcError(-32603, "tools/list answered without a tool list")
            tools.extend(tool for tool in listed if isinstance(tool, dict) and isinstance(tool.get("name"), str))
            cursor = page.get("nextCursor") if isinstance(page, dict) else None
            if not cursor:
                break
        return tools

    async def _request(
        self,
        method: str,
        params: dict[str, object] | None,
        timeout_s: float | None = None,
        *,
        on_sent: Callable[[int], None] | None = None,
    ) -> object:
        if self._process is None or self._loop is None or self._exited:
            raise ServerUnavailable("the server is not running")
        request_id = next(self._ids)
        future: asyncio.Future[object] = self._loop.create_future()
        self._waiting[request_id] = future
        if on_sent is not None:
            on_sent(request_id)
        message: dict[str, object] = {"jsonrpc": "2.0", "id": request_id, "method": method}
        if params is not None:
            message["params"] = params
        try:
            await self._write(message)
            if timeout_s is None:
                return await future
            try:
                return await asyncio.wait_for(future, timeout_s)
            except TimeoutError:
                await self._notify_cancelled(request_id)
                raise ServerUnavailable("the server did not answer in time") from None
        finally:
            self._waiting.pop(request_id, None)

    async def _notify_cancelled(self, request_id: int, reason: str = "timeout") -> None:
        try:
            await self._write(
                {
                    "jsonrpc": "2.0",
                    "method": "notifications/cancelled",
                    "params": {"requestId": request_id, "reason": reason},
                }
            )
        except ServerUnavailable:
            pass

    async def _write(self, message: dict[str, object]) -> None:
        process = self._process
        if process is None or process.stdin is None:
            raise ServerUnavailable("the server is not running")
        data = json.dumps(message, separators=(",", ":")).encode("ascii") + b"\n"
        try:
            await asyncio.to_thread(self._write_bytes, process, data)
        except (OSError, ValueError) as exc:
            raise ServerUnavailable("the server's stdin is closed") from exc

    def _write_bytes(self, process: subprocess.Popen[bytes], data: bytes) -> None:
        with self._write_lock:
            assert process.stdin is not None  # checked by _write before the thread hop
            process.stdin.write(data)
            process.stdin.flush()

    def _read_stdout(self, process: subprocess.Popen[bytes], generation: int) -> None:
        stdout = process.stdout
        assert stdout is not None  # spawn_in_job always pipes stdout
        try:
            while True:
                line = stdout.readline(_MAX_LINE_BYTES + 1)
                if not line:
                    break
                if len(line) > _MAX_LINE_BYTES:
                    logger.warning("host MCP server sent an oversized message server={}", self.name)
                    break
                if line.strip():
                    self._deliver(self._on_line, generation, line)
        except (OSError, ValueError):
            pass
        finally:
            with contextlib.suppress(OSError, ValueError):
                stdout.close()
            self._deliver(self._on_exit, generation)

    def _wait_exit(self, process: subprocess.Popen[bytes], generation: int) -> None:
        """A grandchild that inherited the server's stdout would keep EOF from ever arriving, so the
        server's own exit is watched too."""
        process.wait()
        self._deliver(self._on_exit, generation)

    def _read_stderr(self, process: subprocess.Popen[bytes]) -> None:
        stderr = process.stderr
        assert stderr is not None  # spawn_in_job always pipes stderr
        try:
            while raw := stderr.readline(_STDERR_READ_BYTES):
                self._stderr.append(raw.decode("utf-8", "replace").rstrip()[:_STDERR_LINE_CHARS])
        except (OSError, ValueError):
            pass
        finally:
            with contextlib.suppress(OSError, ValueError):
                stderr.close()

    def _deliver(self, callback: Callable[..., None], *args: object) -> None:
        loop = self._loop
        if loop is None:
            return
        try:
            loop.call_soon_threadsafe(callback, *args)
        except RuntimeError:
            pass

    def _on_line(self, generation: int, line: bytes) -> None:
        if generation != self._generation:
            return
        try:
            message = json.loads(line)
        except (ValueError, RecursionError):
            logger.debug("host MCP server wrote a non-JSON line server={}", self.name)
            return
        if not isinstance(message, dict):
            return
        method = message.get("method")
        if isinstance(method, str):
            if "id" in message:
                self._spawn(
                    self._write_quietly(
                        {
                            "jsonrpc": "2.0",
                            "id": message["id"],
                            "error": {"code": METHOD_NOT_FOUND, "message": "Method not found"},
                        }
                    )
                )
            elif method == "notifications/tools/list_changed":
                self._tools_changed += 1
            return
        request_id = message.get("id")
        future = self._waiting.get(request_id) if isinstance(request_id, int) else None
        if future is None or future.done():
            return
        error = message.get("error")
        if isinstance(error, dict):
            code = error.get("code")
            text = error.get("message")
            future.set_exception(
                JsonRpcError(
                    code if isinstance(code, int) else -32603,
                    text if isinstance(text, str) else "error",
                    error.get("data"),
                )
            )
        else:
            future.set_result(message.get("result"))

    def _on_exit(self, generation: int) -> None:
        if generation != self._generation:
            return
        self._exited = True
        for future in self._waiting.values():
            if not future.done():
                future.set_exception(ServerUnavailable("the server exited"))
        if self._stopping or self._process is None or self.state == "starting":
            # A start in progress sees its handshake fail and tears down itself.
            return
        if self.state == "running":
            logger.warning(
                "host MCP server exited server={} stderr_tail={!r}", self.name, self._stderr_tail()
            )
            self.state = "failed"
        self._reap_in_background(self._detach())

    async def _write_quietly(self, message: dict[str, object]) -> None:
        try:
            await self._write(message)
        except ServerUnavailable:
            pass

    def _spawn(self, coroutine: Coroutine[object, object, object]) -> None:
        task = asyncio.ensure_future(coroutine)
        self._background.add(task)
        task.add_done_callback(self._background.discard)

    def _reap_in_background(self, process: subprocess.Popen[bytes] | None) -> None:
        """Collect a process whose Job is already closed, on a task of its own, so cancelling the
        caller cannot abandon it."""
        if process is not None:
            self._spawn(asyncio.to_thread(_reap, process))

    def _detach(self) -> subprocess.Popen[bytes] | None:
        """Close the Job, which ends the whole tree, and forget the process. Synchronous, so a start
        that follows can never have its new Job closed by an older teardown."""
        job, process = self._job, self._process
        self._job, self._process = None, None
        self._generation += 1
        for future in self._waiting.values():
            if not future.done():
                future.set_exception(ServerUnavailable("the server stopped"))
        if job is not None:
            try:
                job.close()
            except HostJobError as exc:
                logger.error("host MCP server Job did not close server={} error={}", self.name, exc)
        return process

    def _stderr_tail(self) -> str:
        return "\n".join(list(self._stderr)[-_STDERR_LOGGED_LINES:])


def _reap(process: subprocess.Popen[bytes]) -> None:
    if process.stdin is not None:
        with contextlib.suppress(OSError, ValueError):
            process.stdin.close()
    try:
        process.wait(timeout=_STOP_WAIT_S)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=_STOP_WAIT_S)
