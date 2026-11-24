"""Async subprocess management for ServiceHub child services."""

from __future__ import annotations

import asyncio
import json
import os
import re
import secrets
import shutil
import socket
import subprocess
import sys
import time
import uuid
from collections.abc import Awaitable, Callable
from datetime import datetime
from pathlib import Path, PureWindowsPath
from typing import Protocol
from asyncio.subprocess import DEVNULL, PIPE, Process

import httpx
from loguru import logger

from servicehub.config import Config
from servicehub.supervisor.loader import ServiceEntry, load_service_config
from servicehub.supervisor.persisted_credentials import (
    PersistedCredentials,
    read_persisted_credentials,
)
from servicehub.supervisor.readiness import ReadinessError, wait_for_healthy
from servicehub.supervisor.registry import ServiceInfo, ServiceRegistry
from servicehub.supervisor.windows_job import WindowsJob, WindowsJobError


PROCESS_CREDENTIAL_ENV = "SERVICEHUB_PROCESS_CREDENTIAL"
PROCESS_CREDENTIAL_HEADER = "X-SuperClaw-Process-Credential"
LRM_API_KEY_ENV = "LRM_API_KEY"
# The host-only data-plane credential. Deliberately NOT forwarded into the
# sandbox container, which is what makes it usable to gate a route against
# agent-authored code. See llmrouter_manager/common/inference_key.py.
LRM_HOST_API_KEY_ENV = "LRM_HOST_API_KEY"
SERVICEHUB_MANAGED_LRM_API_KEY_ENV = "SERVICEHUB_MANAGED_LRM_API_KEY"
DATA_PROTECTION_API_KEY_ENV = "DATA_PROTECTION_API_KEY"
PRIVACY_API_KEY_ENV = "PRIVACY_API_KEY"
SERVICEHUB_MANAGED_PRIVACY_API_KEY_ENV = "SERVICEHUB_MANAGED_PRIVACY_API_KEY"
LRM_SERVICE_NAME = "llmrouter_manager"
PRIVACY_SERVICE_NAME = "privacy_manager"
SANDBOX_MANAGER_SERVICE_NAME = "sandbox_manager"

LRM_HOST_ACCESS_SERVICES = frozenset({"asr_manager"})
"""Services granted the host-only LRM data-plane credential.

An ALLOW-LIST, not "everything that is not the sandbox". Three services declare
``depends_on: ["llmrouter_manager"]`` -- ``asr_manager``, ``privacy_manager``
and ``sandbox_manager`` -- but only ``asr_manager`` calls
``/v1/chat/completions/pinned``, so only it needs this credential. Granting it
to ``privacy_manager`` as well, which an earlier revision did, added a holder
that never uses it; the point of splitting the credential is to keep the set of
holders as small as the feature allows.

Kept here as a name rather than a ``service_cfg.json`` field because there is
exactly one member: AGENTS.md §5c discourages configurability for a second
caller that does not exist yet. Add the field when one does.
"""

EARLY_SPAWN_SERVICES = frozenset({SANDBOX_MANAGER_SERVICE_NAME})
"""Required children that may start before LRM / Privacy are ready (#3928).

Only when the keys they would wait for were read from the providers' persisted
records first; otherwise they wait exactly as declared. An ALLOW-LIST, because a
``depends_on`` is an ordering promise as well as a key handoff, and dropping the
ordering is only safe for a child whose start-up never needs the provider
listening. For ``sandbox_manager`` that holds: its own start-up calls neither,
and the roles it launches either retry until LRM answers (HDR ``/readyz``, which
the native backend polls) or treat a miss as non-fatal (the Runtime's
context-window probe, the supervisor's pre-warm); Privacy is only called per turn.

``privacy_manager`` is left out. Its first data-protection mode read goes to LRM
at start, and a miss falls back to mode ``none`` with a warning and defers the
sanitizer warm-up by a poll. It is also not on the critical path: the sandbox is.
"""
_VALID_EXE_NAME = re.compile(r"^[A-Za-z0-9_.-]+\.exe$")


class HealthRecorder(Protocol):
    """Write-only sink for health evidence produced by the spawn barrier."""

    def __call__(self, name: str, *, healthy: bool, instance_id: str) -> None: ...

_NETSTAT_TIMEOUT_S = 10.0
_WMIC_TIMEOUT_S = 10.0
_POWERSHELL_TIMEOUT_S = 15.0
_TASKKILL_TIMEOUT_S = 10.0
_TREE_KILL_EXIT_WAIT_S = 5.0
_CREATE_SUSPENDED = 0x00000004
_CHILD_RAW_LOG_RETENTION_COUNT = 5
# Settle delay after reaping our own orphaned child, before re-probing the port.
# A killed listener's socket may linger briefly (TIME_WAIT / async teardown).
_ORPHAN_REAP_SETTLE_S = 1.0

# Self-heal restart budget (issue #1663; mirrors the LLMRouter RouterSupervisor
# fix in #1624 so both supervisors behave identically).
#
# A child is relaunched on any unexpected crash-exit OR sustained watchdog probe
# failure. ``MAX_ON_FAILURE_RESTARTS`` bounds the number of consecutive relaunch
# attempts; ``RESTART_BACKOFFS`` is the per-attempt delay (clamped to the last
# entry once attempts exceed the tuple). A relaunch that spawns but fails
# readiness CONSUMES an attempt and we keep retrying to the cap - it is NOT a
# one-and-done give-up. Permanent pre-spawn failures (blocked port) short-circuit
# to ``error`` because retrying cannot help.
#
# ``RESTART_STABILITY_S`` is the startsecs-style dwell: the watchdog resets the
# budget only after a child has stayed healthy for this long, so a child that
# crashes immediately after reaching readiness cannot reset the budget every
# cycle (which would make the N-in-a-row cap never engage).
MAX_ON_FAILURE_RESTARTS = 5
RESTART_BACKOFFS = (2.0, 4.0, 8.0, 16.0, 32.0)
RESTART_STABILITY_S = 30.0

# A packaged replacement may need to page Python, native extensions, and service
# modules back in while the local 35B worker owns most system commit. Cold-start
# timeouts remain service-specific; only an already-supervised replacement gets
# this larger floor.
PACKAGED_RECOVERY_READY_TIMEOUT_S = 180.0
# Required children can now spawn concurrently because _spawn_child no longer
# mutates process-global state: the PowerShell broker, `_PYI_*` stripping, and
# DLL-directory reset went away when the Hub and its children became one bundle.
# A strictly serial barrier pays the sum of child init times instead of the max.
#
# The cap is deliberately not unbounded, for the same reason _recovery_lock
# exists: two frozen children importing large dependency graphs concurrently can
# exhaust the commit headroom left by a resident local 35B worker, and at grade
# `full-hdr` llama-server's ~22 GB load OVERLAPS this barrier - LRM resumes it
# fire-and-forget, so it is never awaited here, but the memory pressure is
# concurrent all the same. 2 bounds the worst-case concurrent working set while
# still moving the common three-child barrier from sum toward max.
#
# Set SUPERCLAW_BOOT_SPAWN_CONCURRENCY=1 to restore the previous strictly-serial
# barrier in the field without a rebuild.
BOOT_SPAWN_CONCURRENCY = 2


class ShutdownInProgress(RuntimeError):
    def __init__(self, service_name: str) -> None:
        super().__init__(f"ServiceHub shutdown in progress for {service_name}")


class ProcessTerminationError(RuntimeError):
    def __init__(self, service_name: str, pid: int, detail: str) -> None:
        super().__init__(
            f"could not terminate service {service_name} process tree pid={pid}: {detail}"
        )
        self.service_name = service_name
        self.pid = pid


class ProcessShutdownError(RuntimeError):
    pass


def _is_port_free(port: int, bind_host: str) -> bool:
    """Return True if ``bind_host:port`` can be exclusively bound right now.

    Probes the SAME host the child's uvicorn server will bind (``0.0.0.0`` for
    data-plane services, ``127.0.0.1`` otherwise). This matters: a process
    listening on ``0.0.0.0:port`` does not block a ``127.0.0.1:port`` bind, so a
    hardcoded loopback probe would report the port free and then the child's
    wildcard bind would fail. No ``SO_REUSEADDR`` - we want true exclusive
    bindability. The socket is closed immediately via the context manager so the
    port is released for the child to claim.
    """
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        try:
            sock.bind((bind_host, port))
            return True
        except OSError:
            return False


def _port_owner_pid(port: int) -> int | None:
    """Return the PID of a process LISTENING on ``port``, or None.

    Uses ``netstat -ano`` (works without elevation, unlike ``psutil`` which
    raises AccessDenied for system-wide sockets on Windows). Only ``LISTENING``
    rows count: a ``TIME_WAIT`` row has PID 0 and no live owner, and must not be
    mistaken for a real process holding the port.

    Return value semantics are strictly two-valued:

    * ``int``  - a real process is listening on the port (an ordinary conflict).
    * ``None`` - netstat ran cleanly and NOTHING is listening (the port is held
      by a ``TIME_WAIT`` peer or sits in a reserved port range).

    Diagnostic FAILURE is NOT collapsed into ``None``: if netstat cannot run or
    exits non-zero (possibly truncated output), the underlying ``OSError`` /
    ``subprocess.SubprocessError`` propagates. The caller must treat that as
    "ownership unknown" and fail safe.
    """
    completed = subprocess.run(
        ["netstat", "-ano"],
        timeout=_NETSTAT_TIMEOUT_S,
        capture_output=True,
        text=True,
        check=True,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )

    suffix = f":{port}"
    for line in completed.stdout.splitlines():
        fields = line.split()
        # Expected: proto local remote state pid  (5 columns for a TCP row).
        # Do NOT pass `-p TCP` to netstat: on Windows that filters OUT IPv6
        # (TCPv6) rows, so an IPv6-only listener would be missed and misread as
        # ownerless. Match both TCP and TCPv6 here instead.
        if len(fields) < 5 or fields[0].upper() not in ("TCP", "TCPV6"):
            continue
        local, state, pid_str = fields[1], fields[-2], fields[-1]
        if state.upper() != "LISTENING" or not local.endswith(suffix):
            continue
        try:
            pid = int(pid_str)
        except ValueError:
            continue
        if pid > 0:
            return pid
    return None


def _cmdline_via_wmic(pid: int) -> str | None:
    """Read ``pid``'s command line via ``wmic``. None on any failure.

    ``wmic`` is deprecated in recent Windows builds and may be absent; the caller
    falls back to PowerShell when this returns None.
    """
    try:
        completed = subprocess.run(
            ["wmic", "process", "where", f"processid={pid}", "get", "commandline"],
            timeout=_WMIC_TIMEOUT_S,
            capture_output=True,
            text=True,
            check=True,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.SubprocessError):
        return None

    # wmic prints a "CommandLine" header row followed by the value row(s). Join
    # the non-header, non-empty lines so a wrapped command line still matches.
    lines = [line.strip() for line in completed.stdout.splitlines() if line.strip()]
    value_lines = [line for line in lines if line.lower() != "commandline"]
    if not value_lines:
        return None
    return " ".join(value_lines)


def _cmdline_via_powershell(pid: int) -> str | None:
    """Read ``pid``'s command line via PowerShell ``Get-CimInstance``. None on failure.

    Fallback for Windows builds where ``wmic`` has been removed. Uses the same
    underlying CIM/WMI ``Win32_Process.CommandLine`` property. Returns None (never
    raises) so the caller fails safe and never kills an unverified process.
    """
    if shutil.which("powershell") is None:
        return None
    script = (
        f"(Get-CimInstance Win32_Process -Filter 'ProcessId={pid}')"
        ".CommandLine"
    )
    try:
        completed = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
            timeout=_POWERSHELL_TIMEOUT_S,
            capture_output=True,
            text=True,
            check=True,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.SubprocessError):
        return None

    value = completed.stdout.strip()
    return value or None


def _port_owner_cmdline(pid: int) -> str | None:
    """Return the full command line of ``pid``, or None if it cannot be read.

    Used to decide whether a process holding one of our fixed ports is one of
    OUR own orphaned child services (safe to reap) or an unrelated third-party
    process (must never be killed). Neither backend requires elevation, unlike
    ``psutil`` which raises AccessDenied for another process's metadata.

    Tries ``wmic`` first, then falls back to PowerShell ``Get-CimInstance``
    (``wmic`` is deprecated and absent on newer Windows). Returns ``None`` (not an
    exception) when BOTH backends fail - a process that exited between the netstat
    probe and this call, neither tool available, a non-zero exit, or empty output.
    ``None`` is treated by the caller as "cannot confirm this is ours" and
    therefore fails safe (the port stays an ordinary blocker; nothing is killed).
    """
    return _cmdline_via_wmic(pid) or _cmdline_via_powershell(pid)


def _process_image_path(pid: int) -> str | None:
    """Return a process executable path through the native Windows API.

    This path does not depend on WMIC or PowerShell, which may be unavailable or
    blocked by application-control policy. Access failures are treated as
    unknown ownership so callers continue to fail safe.
    """
    if sys.platform != "win32":
        return None

    import ctypes
    from ctypes import wintypes

    process_query_limited_information = 0x1000
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.QueryFullProcessImageNameW.argtypes = [
        wintypes.HANDLE,
        wintypes.DWORD,
        wintypes.LPWSTR,
        ctypes.POINTER(wintypes.DWORD),
    ]
    kernel32.QueryFullProcessImageNameW.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL

    handle = kernel32.OpenProcess(process_query_limited_information, False, pid)
    if not handle:
        return None
    try:
        size = wintypes.DWORD(32768)
        buffer = ctypes.create_unicode_buffer(size.value)
        if not kernel32.QueryFullProcessImageNameW(
            handle,
            0,
            buffer,
            ctypes.byref(size),
        ):
            return None
        value = buffer.value.strip()
        return value or None
    finally:
        kernel32.CloseHandle(handle)


def _ownership_markers() -> tuple[str, ...]:
    """Lowercase substrings that mark a command line as belonging to SuperClaw.

    The built-in markers cover the dev source tree
    (``applications.ai.superclaw``) and the packaged layout
    (``servicehub`` / ``superclaw`` in ``...\\servicehub\\<child>\\<child>.exe``
    and the ``%LOCALAPPDATA%\\SuperClaw`` app-data root). A custom install path
    that contains none of these would cause a false negative (we would decline to
    reap our own orphan and fail startup with an actionable error rather than
    kill it). To cover such installs, additional markers can be supplied via the
    ``SUPERCLAW_ORPHAN_MARKERS`` env var (comma/semicolon/OS-path-separator list).
    """
    markers = ["applications.ai.superclaw", "servicehub", "superclaw"]
    extra = os.environ.get("SUPERCLAW_ORPHAN_MARKERS", "")
    for chunk in extra.replace(";", ",").replace(os.pathsep, ",").split(","):
        token = chunk.strip().lower()
        if token:
            markers.append(token)
    return tuple(markers)


def _configured_exe_names(entry: ServiceEntry) -> tuple[str, ...]:
    names = {f"{entry.entrypoint}.exe".lower()}
    names.add(_configured_launch_exe_name(entry).lower())
    return tuple(sorted(names))


def _configured_launch_exe_name(entry: ServiceEntry) -> str:
    exe_name = (entry.launch or {}).get("exe_name")
    if isinstance(exe_name, str) and _VALID_EXE_NAME.fullmatch(exe_name):
        return exe_name
    return f"{entry.entrypoint}.exe"


def _normalized_windows_path(value: str | PureWindowsPath) -> str:
    return str(PureWindowsPath(value)).rstrip("\\").casefold()


def _expected_frozen_child_image_path(entry: ServiceEntry) -> PureWindowsPath | None:
    if not bool(getattr(sys, "frozen", False)):
        return None
    # A role child is THIS application under a different role, so its image path is
    # our own exe - there is no `<hub>/<stem>/<exe_name>` sibling tree to point at.
    if _launch_role(entry) is not None:
        return PureWindowsPath(sys.executable)
    exe_name = _configured_launch_exe_name(entry)
    hub_dir = PureWindowsPath(sys.executable).parent
    return hub_dir / PureWindowsPath(exe_name).stem / exe_name


def _is_our_orphan_image_path(image_path: str, entry: ServiceEntry) -> bool:
    """Return whether a native image path exactly matches a frozen sibling child."""
    expected = _expected_frozen_child_image_path(entry)
    if expected is None:
        return False
    return _normalized_windows_path(image_path) == _normalized_windows_path(expected)


def _cmdline_declares_role(cmdline: str, role: str) -> bool:
    """Whether ``cmdline`` selects ``role`` via the dispatcher's ``--service`` flag.

    Token-exact, not a substring test: ``--service sandbox_manager_backup`` must not
    satisfy ``sandbox_manager``. This gate decides whether a process gets killed, so
    a prefix collision between two role names has to be a miss, not a match.
    """
    tokens = cmdline.lower().split()
    target = role.lower()
    for index, token in enumerate(tokens):
        if token == "--service" and index + 1 < len(tokens) and tokens[index + 1] == target:
            return True
        if token == f"--service={target}":
            return True
    return False


def _is_our_orphan_cmdline(cmdline: str, entry: ServiceEntry) -> bool:
    """Return True only if ``cmdline`` is unmistakably OUR orphaned child.

    Fail-safe identity gate for reaping a process that holds a fixed child port.
    To qualify, the command line must reference BOTH:

    1. this specific child's entrypoint (e.g. ``llmrouter_manager``) - either as
       a ``-m <entrypoint>`` module launch (source/dev) or a ``<entrypoint>.exe``
       sibling bundle (packaged); AND
    2. a SuperClaw ownership marker (see :func:`_ownership_markers`; extendable
       via ``SUPERCLAW_ORPHAN_MARKERS`` for custom install paths).

    Requiring both, matched case-insensitively on the whole command line, keeps
    the gate narrow: a user's unrelated ``python -m http.server`` or a private
    ``llmrouter_manager`` clone outside our tree will NOT match, so it is never
    killed - it stays an ordinary blocker and startup fails with a clear error.

    A ``launch.kind == "role"`` entry adds a THIRD requirement: the role token.
    Its exe name, image path and every other argv token are identical across the
    services sharing that bundle, so without ``--service <name>`` the first two
    proofs above would approve killing ANY of our services for ANY of our ports.
    Requiring the role restores the exact per-service identity that separate
    sibling exes used to provide for free.
    """
    haystack = cmdline.lower()
    normalized = haystack.replace("/", "\\")
    entrypoint = entry.entrypoint.lower()
    role = _launch_role(entry)
    if role is not None and not _cmdline_declares_role(cmdline, role):
        return False
    expected_image = _expected_frozen_child_image_path(entry)
    if expected_image is not None:
        references_executable = _normalized_windows_path(expected_image) in normalized.casefold()
    else:
        references_executable = any(
            f"\\{exe_name}" in normalized
            or normalized.lstrip('"').startswith(f"{exe_name} ")
            for exe_name in _configured_exe_names(entry)
        )
    references_entrypoint = (
        f"-m {entrypoint}" in haystack
        or references_executable
        or f" {entrypoint} " in f" {haystack} "
    )
    ownership_marker = any(marker in haystack for marker in _ownership_markers())
    return references_entrypoint and ownership_marker


def _kill_pid(pid: int) -> None:
    """Force-kill ``pid`` and its process tree (``taskkill /F /T``).

    Best-effort and Windows-only (callers guard on ``sys.platform``). Never
    raises: a failure to kill simply means the port stays blocked and the caller
    re-probes and fails with an actionable error, rather than crashing startup.
    """
    try:
        subprocess.run(
            ["taskkill", "/F", "/T", "/PID", str(pid)],
            timeout=_TASKKILL_TIMEOUT_S,
            capture_output=True,
            text=True,
            check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.SubprocessError) as exc:
        logger.warning("failed to taskkill orphaned child PID {}: {}", pid, exc)


def _direct_child_processes(parent_pid: int) -> list[tuple[int, str]]:
    """Return readable direct children of ``parent_pid`` from Windows CIM."""
    if sys.platform != "win32" or shutil.which("powershell") is None:
        return []
    script = (
        f"@(Get-CimInstance Win32_Process -Filter 'ParentProcessId={parent_pid}' | "
        "Select-Object ProcessId,CommandLine) | ConvertTo-Json -Compress"
    )
    try:
        completed = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
            timeout=_POWERSHELL_TIMEOUT_S,
            capture_output=True,
            text=True,
            check=True,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        payload = json.loads(completed.stdout)
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError) as exc:
        logger.warning(
            "could not enumerate child processes parent_pid={} error_type={}",
            parent_pid,
            type(exc).__name__,
        )
        return []

    rows = payload if isinstance(payload, list) else [payload]
    children: list[tuple[int, str]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        pid = row.get("ProcessId")
        command_line = row.get("CommandLine")
        if (
            isinstance(pid, int)
            and pid > 0
            and isinstance(command_line, str)
            and command_line.strip()
        ):
            children.append((pid, command_line))
    return children


def _reap_owned_descendants(parent_pid: int) -> None:
    """Terminate verified SuperClaw descendants left by a crashed child."""
    markers = _ownership_markers()
    for pid, command_line in _direct_child_processes(parent_pid):
        normalized = " ".join(command_line.lower().split())
        if not any(marker in command_line.lower() for marker in markers):
            logger.warning(
                "leaving unverified descendant alive parent_pid={} child_pid={}",
                parent_pid,
                pid,
            )
            continue
        logger.warning(
            "reaping orphaned SuperClaw descendant parent_pid={} child_pid={}",
            parent_pid,
            pid,
        )
        _kill_pid(pid)


def _launch_role(entry: ServiceEntry) -> str | None:
    """The ``--service`` token this entry is launched with, or None.

    Mirrors :func:`child_argv`'s exe-path condition EXACTLY, and must keep doing
    so: the role only reaches the command line when the child is launched as the
    packaged executable. In source/dev mode ``child_argv`` emits
    ``python -m <entrypoint>`` with no ``--service``, and there the entrypoint is
    already a unique identifier - demanding a role token that is never present
    would make ServiceHub refuse to reap its own orphan and turn the common
    ``pnpm dev`` Ctrl-C case into a hard startup failure.
    """
    if not bool(getattr(sys, "frozen", False)):
        return None
    if (entry.launch or {}).get("kind") != "role":
        return None
    return entry.name


def child_argv(entry: ServiceEntry) -> list[str]:
    launch = entry.launch or {}
    # `launch.kind` declares how the child is launched in a *packaged* build.
    # The actual exe-vs-module decision is gated on whether ServiceHub itself is
    # frozen: a single shared `service_cfg.json` ships `kind="exe"`, but in
    # source/dev mode (running under `.venv/Scripts/python.exe`, not frozen) the
    # sibling child exes do not exist, so we must fall back to `python -m`.
    # An explicit `kind="module"` forces the module path even when frozen.
    frozen = bool(getattr(sys, "frozen", False))
    use_exe = frozen and launch.get("kind") != "module"
    if use_exe:
        exe_name = launch.get("exe_name") or f"{entry.entrypoint}.exe"
        if _VALID_EXE_NAME.fullmatch(exe_name) is None:
            raise RuntimeError(f"child exe_name is invalid: {exe_name!r}")
        role = _launch_role(entry)
        if role is None:
            exe_dir = Path(sys.executable).resolve().parent
            child_dir = Path(exe_name).stem
            child_exe = exe_dir / child_dir / exe_name
            if not child_exe.is_file():
                raise RuntimeError(f"child exe not found: {child_exe}")
            role_argv: list[str] = []
        else:
            # A role child is THIS application run under a different role, so
            # re-exec our own image. There is no sibling `<stem>/<exe_name>` tree to
            # find, and because parent and child are one PyInstaller application the
            # child inherits a consistent `_MEIPASS`/`_internal`/DLL context - which
            # is what lets `_spawn_child` create it directly instead of laundering it
            # through a broker process.
            child_exe = Path(sys.executable).resolve()
            if child_exe.name.lower() != exe_name.lower():
                raise RuntimeError(
                    f"service {entry.name} declares launch.exe_name={exe_name!r} but this "
                    f"application is {child_exe.name!r}; a role child re-execs the running "
                    "image, so the two must name the same executable"
                )
            role_argv = ["--service", role]
        # A role-dispatched bundle hosts several services behind ONE exe name and
        # ONE image path, so the role must travel on the command line: it is the
        # only identity the OS exposes (Task Manager, WER, Win32_Process.CommandLine
        # all show argv; none of them show environment variables), and it is what
        # makes the child hand-reproducible. `SERVICEHUB_SERVICE_NAME` stays as the
        # fallback the dispatcher accepts when argv carries no role.
        return [
            str(child_exe),
            *role_argv,
            "--host",
            entry.bind_host,
            "--port",
            str(entry.port),
        ]
    return [
        sys.executable,
        "-m",
        entry.entrypoint,
        "--host",
        entry.bind_host,
        "--port",
        str(entry.port),
    ]


class ProcessManager:
    def __init__(self, cfg: Config) -> None:
        self._cfg = cfg
        self.registry = ServiceRegistry()
        self._entries: dict[str, ServiceEntry] = {}
        self._monitor_tasks: dict[str, asyncio.Task] = {}
        self._jobs_by_pid: dict[int, WindowsJob] = {}
        self._start_tasks: dict[str, asyncio.Task[ServiceInfo]] = {}
        self._start_failures: set[str] = set()
        self._restart_attempts: dict[str, int] = {}
        self._current_process_credentials: dict[str, tuple[str, str]] = {}
        self._lrm_api_key: str | None = None
        self._lrm_host_api_key: str | None = None
        self._privacy_data_plane_key: str | None = None
        self._read_persisted_credentials: Callable[[], PersistedCredentials] = (
            read_persisted_credentials
        )
        # Providers whose key in the fields above came from the persisted record
        # and has not yet been confirmed by the provider's own handoff.
        self._unconfirmed_credentials: set[str] = set()
        # Names with a self-heal loop currently in flight. The crash-exit monitor
        # and the watchdog both trigger self-heal and share one restart budget on
        # ServiceInfo; this guard stops them from driving the same child's
        # relaunch concurrently and double-spending the budget.
        self._healing: set[str] = set()
        # Serialize the full automatic recovery cycle, not only CreateProcess.
        # Two frozen children importing large dependency graphs concurrently can
        # exhaust the small commit headroom left by the local 35B worker.
        self._recovery_lock = asyncio.Lock()
        self._service_restarted_callback: (
            Callable[[ServiceInfo, str], Awaitable[None]] | None
        ) = None
        self._active_bundle_id_supplier: Callable[[], Awaitable[str | None]] | None = None
        self._health_recorder: HealthRecorder | None = None
        self._shutting_down = False

    def set_health_recorder(self, recorder: HealthRecorder) -> None:
        """Attach a write-only sink for spawn-time health evidence.

        Write-only on purpose: the restart path must not gain a way to read an
        aggregate readiness verdict, or `not ready -> restart everything` becomes
        reachable and produces a restart feedback loop.
        """
        self._health_recorder = recorder

    def report_spawn_health(self, name: str, *, instance_id: str) -> None:
        """Publish the readiness the spawn barrier already proved.

        A child is registered only after `wait_for_healthy` validated its
        `service`, `status`, positive `pid`, and expected `instance_id`, so this is
        positive identity-matched evidence, not an assumption.

        Without it the readiness projection has no host evidence until the
        watchdog's first probe, and `watchdog_grace_s` is the child's
        `ready_timeout_s` (30s-90s), so every boot would report `unknown` for the
        first half-minute-plus even though the barrier had already passed.
        """
        if self._health_recorder is None:
            return
        try:
            self._health_recorder(name, healthy=True, instance_id=instance_id)
        except Exception:
            logger.warning("readiness spawn health publish failed service={}", name)

    def set_service_restarted_callback(
        self, callback: Callable[[ServiceInfo, str], Awaitable[None]]
    ) -> None:
        self._service_restarted_callback = callback

    def set_active_bundle_id_supplier(
        self, supplier: Callable[[], Awaitable[str | None]]
    ) -> None:
        self._active_bundle_id_supplier = supplier

    def begin_shutdown(self) -> None:
        """Block every restart path before any child teardown begins."""
        self._shutting_down = True
        for service in self.registry.all():
            service.stopping = True

    def load_declarations(self) -> list[ServiceEntry]:
        entries = load_service_config(self._cfg.service_cfg_path)
        self._entries = {entry.name: entry for entry in entries}
        return entries

    async def spawn_all(self) -> None:
        barrier_t0 = time.monotonic()
        entries = self.load_declarations()
        required = [entry for entry in entries if entry.startup == "required"]
        on_demand = [entry for entry in entries if entry.startup == "on_demand"]
        await self._ensure_fixed_ports_bindable(required)
        early_dependencies = await self._preread_persisted_credentials(required)
        preflight_ms = round((time.monotonic() - barrier_t0) * 1000)
        ready_ms = await self._spawn_required_concurrently(
            required, early_dependencies=early_dependencies
        )
        # `required=M/N` is the field that survives moving children out of this
        # phase: it counts the ones this barrier actually awaited, not the ones
        # configured.
        logger.info(
            "startup.barrier.complete elapsed_ms={} preflight_ms={} required={}/{} "
            "ready={} on_demand={} spawn_concurrency={}",
            round((time.monotonic() - barrier_t0) * 1000),
            preflight_ms,
            len(ready_ms),
            len(required),
            "|".join(f"{name}:{child_ms}" for name, child_ms in ready_ms.items()) or "-",
            ",".join(entry.name for entry in on_demand) or "-",
            self._boot_spawn_concurrency(),
        )

    @staticmethod
    def _boot_spawn_concurrency() -> int:
        raw = os.environ.get("SUPERCLAW_BOOT_SPAWN_CONCURRENCY", "").strip()
        if raw:
            try:
                return max(1, int(raw))
            except ValueError:
                logger.warning(
                    "ignoring non-integer SUPERCLAW_BOOT_SPAWN_CONCURRENCY={!r}", raw
                )
        return BOOT_SPAWN_CONCURRENCY

    async def _preread_persisted_credentials(
        self, required: list[ServiceEntry]
    ) -> dict[str, frozenset[str]]:
        """Read LRM's and Privacy's persisted keys so an early-spawn child need not wait.

        Returns, per :data:`EARLY_SPAWN_SERVICES` child, the declared dependencies
        whose key it now already has. A provider whose record is missing,
        unreadable, or would be migrated by the provider on start is simply not
        in that set, so the child waits for it exactly as before.

        Runs before any child is spawned, which is what makes the owners' lockless
        readers safe: LRM and Privacy are the only writers of these records.
        Skipped at ``SUPERCLAW_BOOT_SPAWN_CONCURRENCY=1`` so that setting still
        restores the strictly serial barrier.
        """
        providers = {LRM_SERVICE_NAME, PRIVACY_SERVICE_NAME}
        early = [
            entry
            for entry in required
            if entry.name in EARLY_SPAWN_SERVICES and providers & set(entry.depends_on)
        ]
        if not early or self._boot_spawn_concurrency() == 1:
            return {}
        credentials = await asyncio.to_thread(self._read_persisted_credentials)
        wanted = set().union(*(set(entry.depends_on) & providers for entry in early))
        held: set[str] = set()
        if LRM_SERVICE_NAME in wanted and credentials.lrm_api_key:
            self._lrm_api_key = credentials.lrm_api_key
            held.add(LRM_SERVICE_NAME)
        if PRIVACY_SERVICE_NAME in wanted and credentials.privacy_data_plane_key:
            self._privacy_data_plane_key = credentials.privacy_data_plane_key
            held.add(PRIVACY_SERVICE_NAME)
        self._unconfirmed_credentials = set(held)
        early_dependencies = {
            entry.name: frozenset(set(entry.depends_on) & held) for entry in early
        }
        logger.info(
            "startup.credentials.preread held={} early={}",
            ",".join(sorted(held)) or "-",
            "|".join(
                f"{name}:{'+'.join(sorted(deps)) or '-'}"
                for name, deps in early_dependencies.items()
            ),
        )
        return early_dependencies

    async def _spawn_required_concurrently(
        self,
        required: list[ServiceEntry],
        *,
        early_dependencies: dict[str, frozenset[str]] | None = None,
    ) -> dict[str, int]:
        """Spawn required children in dependency waves, capped concurrency.

        Returns per-child ready durations keyed by name, in ``required`` order.

        A wave is every not-yet-started entry whose declared ``depends_on`` are
        all READY — which is the only guarantee the previous strictly-serial loop
        actually provided — except the ones ``early_dependencies`` lists for it,
        whose key the child was already given (see
        :meth:`_preread_persisted_credentials`). Concurrency within a wave is
        capped by :func:`_boot_spawn_concurrency`; each child's recorded duration
        is measured after it acquires the semaphore, so the numbers stay
        comparable to the serial barrier instead of absorbing queue wait.
        """
        early_dependencies = early_dependencies or {}
        limit = self._boot_spawn_concurrency()
        semaphore = asyncio.Semaphore(limit)
        durations: dict[str, int] = {}

        async def spawn_one(entry: ServiceEntry) -> None:
            async with semaphore:
                child_t0 = time.monotonic()
                await self.spawn_service(entry)
                durations[entry.name] = round((time.monotonic() - child_t0) * 1000)

        ready: set[str] = set()
        pending = list(required)
        while pending:
            wave = [
                entry
                for entry in pending
                if all(
                    dep in ready or dep in early_dependencies.get(entry.name, ())
                    for dep in entry.depends_on
                )
            ]
            if not wave:
                # Unreachable: the loader rejects dependency cycles and unknown
                # dependency names. Fail loudly rather than spin forever.
                await self.shutdown_all()
                raise RuntimeError(
                    "failed to start ServiceHub child services: unsatisfiable "
                    f"dependencies among {[entry.name for entry in pending]}"
                )
            # return_exceptions so every sibling spawn settles before teardown;
            # shutdown_all can then reap whatever did come up. Cancelling
            # mid-CreateProcess would risk leaving an unregistered child behind.
            results = await asyncio.gather(
                *(spawn_one(entry) for entry in wave), return_exceptions=True
            )
            failure = next(
                (r for r in results if isinstance(r, BaseException)),
                None,
            )
            if failure is not None:
                # Required children hard-fail boot: tear down any children that
                # already started in this or an earlier dependency wave.
                await self.shutdown_all()
                raise RuntimeError(
                    f"failed to start ServiceHub child services: {failure}"
                ) from failure
            ready.update(entry.name for entry in wave)
            pending = [entry for entry in pending if entry.name not in ready]
        return {entry.name: durations[entry.name] for entry in required}

    def entry_by_prefix(self, proxy_prefix: str) -> ServiceEntry | None:
        return next(
            (entry for entry in self._entries.values() if entry.proxy_prefix == proxy_prefix),
            None,
        )

    def service_catalog(self) -> list[dict[str, object]]:
        catalog: list[dict[str, object]] = []
        for entry in self._entries.values():
            service = self.registry.get(entry.name)
            if service is not None:
                state = service.state
            elif entry.name in self._start_tasks:
                state = "starting"
            elif entry.name in self._start_failures:
                state = "error"
            else:
                state = "dormant" if entry.startup == "on_demand" else "stopped"
            item: dict[str, object] = {
                "name": entry.name,
                "proxy_prefix": entry.proxy_prefix,
                "startup": entry.startup,
                "state": state,
            }
            catalog.append(item)
        return catalog

    async def ensure_started(self, name: str) -> ServiceInfo:
        service = self.registry.get(name)
        if service is not None and service.state == "running":
            return service
        if service is not None:
            raise RuntimeError(f"service {name} is currently {service.state}")
        if self._cfg.no_spawn:
            raise RuntimeError("ServiceHub child spawning is disabled")
        entry = self._entries.get(name)
        if entry is None or entry.startup != "on_demand":
            raise RuntimeError(f"service {name} is not available on demand")
        task = self._start_tasks.get(name)
        if task is None:
            task = asyncio.create_task(self._start_on_demand(entry))
            self._start_tasks[name] = task
            task.add_done_callback(
                lambda completed, service_name=name: self._finish_start_task(
                    service_name, completed
                )
            )
        return await asyncio.shield(task)

    def _finish_start_task(
        self, name: str, task: asyncio.Task[ServiceInfo]
    ) -> None:
        if self._start_tasks.get(name) is task:
            self._start_tasks.pop(name, None)
        if task.cancelled():
            return
        if task.exception() is None:
            self._start_failures.discard(name)
        else:
            self._start_failures.add(name)

    async def _start_on_demand(self, entry: ServiceEntry) -> ServiceInfo:
        logger.info("starting on-demand child service name={}", entry.name)
        await self._ensure_fixed_ports_bindable([entry], fail_on_ownerless=False)
        return await self.spawn_service(entry)

    async def _ensure_fixed_ports_bindable(
        self, entries: list[ServiceEntry], *, fail_on_ownerless: bool = True
    ) -> None:
        """Make the fixed child ports bindable, recovering from prior bad exits.

        ServiceHub binds each child to the fixed port declared in
        ``service_cfg.json``. A previous run that died abruptly (the desktop app
        was force-killed, crashed, or hot-restarted) can leave a fixed port
        unbindable. The one case recovered here:

        * **Our own orphaned child still listening.** A real process holds the
          port and its command line proves it is one of OUR children. We reap
          that specific PID (``taskkill /F /T``) and re-probe. The kill is gated
          on a strict command-line identity match (:func:`_is_our_orphan_cmdline`)
          so unrelated third-party listeners are never touched. This is the
          common ``pnpm dev`` Ctrl-C / watcher-restart orphan case.

        Everything else fails SAFE with an actionable error and touches nothing:
        an unrelated process is LISTENING, a port whose owner cannot be verified
        (netstat/wmic failed), a port still held after we reaped our child, or a
        port that is blocked with nothing listening on it (a ``TIME_WAIT`` peer or
        a reserved port range), which ServiceHub cannot free.

        No-ops off Windows (the netstat/wmic probes and ``taskkill`` are
        Windows-specific). Self-gating: with all ports free the probe never trips,
        so no reap runs.

        ``fail_on_ownerless`` gates ONLY the error for a blocked port with no
        listening owner, never the orphan reap. Pass ``False`` for an on-demand
        child: the ownerless port is then logged and left in place (the caller
        tolerates the on-demand child failing to bind); the orphan reap - the
        common ``pnpm dev`` Ctrl-C case - still runs so a real orphaned child of
        ours is cleaned up.

        The netstat/wmic owner probes, ``taskkill``, and the settle delays all run
        off the event loop (``asyncio.to_thread`` / ``asyncio.sleep``) so a startup
        recovery never freezes the ASGI loop while the desktop UI polls for
        readiness.
        """
        if sys.platform != "win32":
            return

        blocked = [entry for entry in entries if not _is_port_free(entry.port, entry.bind_host)]
        if not blocked:
            return

        # Classify each blocked port:
        #
        #   1. A real process is LISTENING and its command line proves it is one
        #      of OUR OWN orphaned child services (from a force-killed / crashed
        #      previous run). Reap that specific PID (taskkill /F /T) and re-probe
        #      - this is the common `pnpm dev` orphan case. Killing is gated on a
        #      strict command-line identity match so unrelated processes are safe.
        #   2. A blocked port with NO listening owner (a TIME_WAIT peer or a
        #      reserved port range). ServiceHub cannot free it.
        #   3. Anything else fails SAFE with an actionable error and touches
        #      nothing: an unrelated third-party listener, or a port whose owner
        #      could not be verified (netstat/wmic failed).
        blockers: list[str] = []  # human-readable reasons; non-empty => raise
        ownerless: list[ServiceEntry] = []
        for entry in blocked:
            try:
                pid = await asyncio.to_thread(_port_owner_pid, entry.port)
            except (OSError, subprocess.SubprocessError) as exc:
                logger.warning(
                    "could not verify owner of blocked port {}: {}", entry.port, exc
                )
                blockers.append(f"{entry.port} (owner unverifiable: {exc})")
                continue
            if pid is None:
                ownerless.append(entry)
                continue

            # A real PID holds the port. Only reap it if it is unmistakably one
            # of our own orphaned children; otherwise leave it as a blocker.
            image_path = await asyncio.to_thread(_process_image_path, pid)
            # A role-dispatched bundle serves every service it hosts from ONE image
            # path, so matching that path proves only "one of ours" and not WHICH
            # one. Those entries must be confirmed on the command line, which is
            # where the role is; skipping the cmdline read for them would approve
            # killing any of our services for any of our ports.
            role = _launch_role(entry)
            image_matches = (
                role is None
                and image_path is not None
                and _is_our_orphan_image_path(image_path, entry)
            )
            cmdline = None
            if not image_matches:
                cmdline = await asyncio.to_thread(_port_owner_cmdline, pid)
            cmdline_matches = (
                cmdline is not None and _is_our_orphan_cmdline(cmdline, entry)
            )
            if image_matches or cmdline_matches:
                logger.warning(
                    "port {} held by our own orphaned child {} (PID {}); reaping it",
                    entry.port,
                    entry.name,
                    pid,
                )
                await asyncio.to_thread(_kill_pid, pid)
                await asyncio.sleep(_ORPHAN_REAP_SETTLE_S)
                if _is_port_free(entry.port, entry.bind_host):
                    continue  # recovered
                # Still blocked after reap: re-check the owner.
                try:
                    residual_pid = await asyncio.to_thread(_port_owner_pid, entry.port)
                except (OSError, subprocess.SubprocessError) as exc:
                    blockers.append(f"{entry.port} (owner unverifiable after reap: {exc})")
                    continue
                if residual_pid is None:
                    ownerless.append(entry)
                else:
                    blockers.append(
                        f"{entry.port} (still held by PID {residual_pid} after reaping our child)"
                    )
                continue

            owner_readable = image_path is not None or cmdline is not None
            reason = "unrelated process" if owner_readable else "owner identity unreadable"
            blockers.append(f"{entry.port} (held by PID {pid}, {reason})")

        if blockers:
            detail = ", ".join(blockers)
            raise RuntimeError(
                f"ServiceHub child ports cannot be claimed: {detail}. These are "
                "ordinary conflicts (or could not be verified). Stop the "
                "conflicting process(es) and relaunch."
            )

        # Every blocked port that reached here was either reaped (our own orphan,
        # port now free) or is ownerless. If reaping cleared them all, there is
        # nothing left to report.
        if not ownerless:
            return

        ownerless_ports = [entry.port for entry in ownerless]

        # An on-demand child failing to bind is tolerated by its caller, so log
        # the ownerless port and leave it.
        if not fail_on_ownerless:
            logger.warning(
                "on-demand child port(s) {} are blocked with no listening owner; "
                "the affected on-demand child cannot start until the port is free.",
                ownerless_ports,
            )
            return

        raise RuntimeError(
            f"ServiceHub child ports {ownerless_ports} are blocked with no "
            "listening owner (a TIME_WAIT peer or a reserved port range). Wait "
            "for the port(s) to be released, or free them, then relaunch."
        )

    async def spawn_service(
        self,
        entry: ServiceEntry,
        *,
        _replace: bool = False,
        ready_timeout_s: float | None = None,
    ) -> ServiceInfo:
        if self._shutting_down:
            logger.info(
                "refusing to spawn child during ServiceHub shutdown name={}",
                entry.name,
            )
            raise ShutdownInProgress(entry.name)
        instance_id = uuid.uuid4().hex
        process_credential = secrets.token_urlsafe(32)
        logger.info(
            "starting child service name={} port={} entrypoint={} restart_policy={}",
            entry.name,
            entry.port,
            entry.entrypoint,
            entry.restart_policy,
        )
        env = {
            **os.environ,
            **entry.env,
            "SERVICEHUB_SERVICE_NAME": entry.name,
            "SERVICEHUB_INSTANCE_ID": instance_id,
            "SERVICEHUB_CFG_PATH": str(Path(self._cfg.service_cfg_path).resolve()),
            "SERVICEHUB_MANAGED": "1",
            PROCESS_CREDENTIAL_ENV: process_credential,
        }
        env.pop(SERVICEHUB_MANAGED_LRM_API_KEY_ENV, None)
        env.pop(SERVICEHUB_MANAGED_PRIVACY_API_KEY_ENV, None)
        env.pop(DATA_PROTECTION_API_KEY_ENV, None)
        env.pop(PRIVACY_API_KEY_ENV, None)
        # Cleared unconditionally, including for SandboxManager: the host key is
        # granted below only to services that are not it, and an inherited value
        # from this process's own environment must never substitute for that
        # grant. SandboxManager forwards its env into the container.
        env.pop(LRM_HOST_API_KEY_ENV, None)
        if entry.name != SANDBOX_MANAGER_SERVICE_NAME:
            env.pop(LRM_API_KEY_ENV, None)
        if LRM_SERVICE_NAME in entry.depends_on:
            if self._lrm_api_key is None:
                raise ReadinessError(
                    f"LRM inference credential is unavailable for {entry.name}"
                )
            if entry.name == SANDBOX_MANAGER_SERVICE_NAME:
                # Keep an explicit endpoint/key override paired. SandboxManager
                # selects this managed key only for the local LRM endpoint.
                #
                # The shared key ONLY. SandboxManager passes its credential into
                # the container, so anything granted here is reachable by
                # agent-authored code -- which is exactly what the host key
                # exists to exclude from `/v1/chat/completions/pinned`.
                env[SERVICEHUB_MANAGED_LRM_API_KEY_ENV] = self._lrm_api_key
            else:
                env[LRM_API_KEY_ENV] = self._lrm_api_key
                # Granted only to a service that actually calls the pinned route
                # (see LRM_HOST_ACCESS_SERVICES), and only when LRM issued one.
                # An empty value is left ABSENT rather than set to "", so a
                # consumer sees "not granted" instead of a credential that
                # silently fails auth.
                if (
                    entry.name in LRM_HOST_ACCESS_SERVICES
                    and self._lrm_host_api_key
                ):
                    env[LRM_HOST_API_KEY_ENV] = self._lrm_host_api_key
        if PRIVACY_SERVICE_NAME in entry.depends_on:
            if self._privacy_data_plane_key is None:
                raise ReadinessError(
                    f"Privacy data-plane credential is unavailable for {entry.name}"
                )
            if entry.name == SANDBOX_MANAGER_SERVICE_NAME:
                env[SERVICEHUB_MANAGED_PRIVACY_API_KEY_ENV] = (
                    self._privacy_data_plane_key
                )
        # Bundle attribution is a Capability projection. Do not inherit or
        # accept a service_cfg (or host) value because only the active Profile
        # may author this value.
        env.pop("SUPERCLAW_BUNDLE_ID", None)
        if self._active_bundle_id_supplier is not None:
            try:
                bundle_id = await self._active_bundle_id_supplier()
            except Exception as exc:
                logger.warning(
                    "active bundle projection unavailable; spawning without bundle attribution "
                    "service={} error_type={}",
                    entry.name,
                    type(exc).__name__,
                )
            else:
                if bundle_id and bundle_id.strip():
                    env["SUPERCLAW_BUNDLE_ID"] = bundle_id.strip()
        stdout_path = self._log_path(entry.name, "stdout")
        stderr_path = self._log_path(entry.name, "stderr")
        await asyncio.to_thread(self._prepare_raw_log, stdout_path, entry.name, "stdout")
        await asyncio.to_thread(self._prepare_raw_log, stderr_path, entry.name, "stderr")
        # A Windows child is given NO inherited pipe handles: stdout/stderr go to
        # REAL FILES and stdin to DEVNULL. This is not a logging choice — it fixes
        # a boot deadlock. On a managed endpoint whose EDR filter driver hooks
        # file/pipe operations, a child launched with pipe std handles hangs
        # forever during startup, at 0% CPU, before any log line or port bind.
        # py-spy pinned two distinct hangs, both on a pipe std handle:
        #   1. ~10 MB, in Py_InitializeFromConfig: fflush_nolock → SetFilePointerEx
        #      (CPython *seeks* stdout to choose a buffering mode). A seek on a
        #      non-seekable PIPE takes the hooked slow path and wedges; on a real
        #      FILE it is an ordinary instant syscall.
        #   2. ~57 MB, deeper in native-import warmup: scipy/OpenBLAS DLL init
        #      calls PeekNamedPipe → ZwFsControlFile on an inherited pipe handle
        #      (stdin), which the filter driver likewise hangs.
        # Handing the child only files + DEVNULL removes every hooked pipe op from
        # its critical startup path. ServiceHub only ever used the stdout/stderr
        # pipes to copy the child's output into these same log files (see
        # `_drain_stream`: raw bytes, same path, no framing), and readiness is a
        # pure HTTP health probe that never reads the child's streams, so this is
        # behaviour-preserving for logs.
        #
        # This was once gated on `sys.frozen` too, on the theory that only the
        # packaged sibling exe was affected. It is not: hang #1 reproduced exactly
        # as above on `asr_manager` spawned by a SOURCE-mode hub
        # (`python -m servicehub`), four attempts running, each ending in the
        # 120 s readiness timeout with two zero-byte logs. The filter driver hooks
        # the HANDLE and does not care how the process that opened it was built,
        # so frozen-ness cannot be the gate.
        #
        # Being precise about what is NOT proven: pipes do not hang every child.
        # In those same source-mode runs `llmrouter_manager`, `privacy_manager` and
        # `sandbox_manager` all came ready on the pipe path in 1.1–3.8 s. What
        # distinguishes `asr_manager` is not established — it is spawned later, on
        # demand, from a request handler rather than during the startup barrier,
        # and it is the one child that loads heavy native DLLs. So the gate is the
        # platform not because every Windows child demonstrably needs files, but
        # because the failure is invisible in a diff, costs a 120 s timeout and a
        # dead feature when it lands, and the mitigation is free: the pipes were
        # only ever copied into these same files. Narrowing this gate again needs a
        # reason better than "the other services were fine" — they were fine here
        # too, until one was not.
        # See test_windows_child_gets_file_std_handles_in_source_mode.
        file_std_handles = sys.platform == "win32"
        if file_std_handles:
            stdout_handle = stdout_path.open("ab")
            stderr_handle = stderr_path.open("ab")
            try:
                process = await self._spawn_child(
                    entry,
                    env,
                    stdin=DEVNULL,
                    stdout=stdout_handle,
                    stderr=stderr_handle,
                )
            finally:
                # The child inherited its own duplicated handles at CreateProcess
                # time; drop ours so the file is not held open by ServiceHub for
                # the child's whole lifetime.
                stdout_handle.close()
                stderr_handle.close()
            drain_tasks: tuple[asyncio.Task, ...] = ()
        else:
            process = await self._spawn_child(
                entry, env, stdin=None, stdout=PIPE, stderr=PIPE
            )
            drain_tasks = (
                asyncio.create_task(self._drain_stream(process.stdout, stdout_path)),
                asyncio.create_task(self._drain_stream(process.stderr, stderr_path)),
            )
        try:
            await wait_for_healthy(
                process,
                entry,
                instance_id,
                entry.ready_timeout_s
                if ready_timeout_s is None
                else ready_timeout_s,
            )
            if entry.name == LRM_SERVICE_NAME:
                fetched_key, fetched_host_key = await self._fetch_lrm_inference_key(
                    entry, process_credential=process_credential
                )
                if self._lrm_api_key is not None and not secrets.compare_digest(
                    self._lrm_api_key, fetched_key
                ):
                    raise ReadinessError(
                        self._credential_changed_message(
                            LRM_SERVICE_NAME, "LRM inference credential"
                        )
                    )
                self._lrm_api_key = fetched_key
                self._lrm_host_api_key = fetched_host_key
                self._unconfirmed_credentials.discard(LRM_SERVICE_NAME)
            if entry.name == PRIVACY_SERVICE_NAME:
                fetched_key = await self._fetch_privacy_data_plane_key(
                    entry, process_credential=process_credential
                )
                if (
                    self._privacy_data_plane_key is not None
                    and not secrets.compare_digest(
                        self._privacy_data_plane_key, fetched_key
                    )
                ):
                    raise ReadinessError(
                        self._credential_changed_message(
                            PRIVACY_SERVICE_NAME, "Privacy data-plane credential"
                        )
                    )
                self._privacy_data_plane_key = fetched_key
                self._unconfirmed_credentials.discard(PRIVACY_SERVICE_NAME)
        except ReadinessError:
            logger.exception(
                "child service failed readiness name={} port={} instance_id={}",
                entry.name,
                entry.port,
                instance_id,
            )
            # The child failed readiness (wedged / never bound its port); it was
            # never sent a stop signal and will not exit on its own, so skip the
            # grace wait and go straight to the force-kill: waiting on a child
            # that never became ready cannot help.
            await self._terminate(
                process,
                entry.shutdown_grace_s,
                skip_grace=True,
                service_name=entry.name,
            )
            await asyncio.gather(*drain_tasks)
            raise
        except asyncio.CancelledError:
            # The readiness wait was cancelled (for example while ServiceHub is
            # shutting down). The just-spawned child is not yet
            # registered or monitored, so nothing else will reap it — terminate and
            # drain it here, then re-raise so cancellation still unwinds. Shield the
            # teardown so this cleanup itself is not cut short by the cancellation.
            logger.info(
                "child spawn cancelled during readiness wait; tearing down "
                "unregistered child name={} instance_id={}",
                entry.name,
                instance_id,
            )
            # Same as the readiness-failure path: this child never reached
            # readiness and got no stop signal, so skip the pointless grace wait
            # on a process that will not exit on its own and force-kill it.
            await asyncio.shield(
                self._terminate(
                    process,
                    entry.shutdown_grace_s,
                    skip_grace=True,
                    service_name=entry.name,
                )
            )
            await asyncio.gather(*drain_tasks, return_exceptions=True)
            raise

        service = ServiceInfo(
            name=entry.name,
            proxy_prefix=entry.proxy_prefix,
            port=entry.port,
            process=process,
            state="running",
            restart_policy=entry.restart_policy,
            failure_count=0,
            shutdown_grace_s=entry.shutdown_grace_s,
            instance_id=instance_id,
            restart_attempts=self._restart_attempts.get(entry.name, 0),
            watchdog_grace_s=entry.ready_timeout_s,
            # Start the dwell clock at the moment the child passes readiness.
            # Reaching "running" must NOT zero restart_attempts (issue #1663):
            # the budget is only reset later by the watchdog once the child has
            # dwelled healthy for RESTART_STABILITY_S.
            ready_since=time.monotonic(),
        )
        if _replace:
            self.registry.remove(entry.name)
        self.registry.register(service)
        self._current_process_credentials[entry.name] = (
            instance_id,
            process_credential,
        )
        self.report_spawn_health(entry.name, instance_id=instance_id)
        self._monitor_tasks[entry.name] = asyncio.create_task(self._watch_process_exit(service))
        logger.info(
            "child service ready name={} pid={} port={} instance_id={}",
            entry.name,
            process.pid,
            entry.port,
            instance_id,
        )
        return service

    def _credential_changed_message(self, provider: str, credential: str) -> str:
        """Why a provider's handoff is refused when it differs from the key already held.

        Both cases fail the provider's readiness, and at boot that fails the
        barrier, which tears down a dependent already started with the old key.
        Re-keying the dependent instead would hide the cause: a warm-start record
        changes only if something other than its owner rewrote it, or a second
        owner instance raced this one.
        """
        if provider in self._unconfirmed_credentials:
            return (
                f"{credential} differs from its persisted record, which was already "
                "handed to an early-started dependent"
            )
        return f"{credential} changed during ordinary restart"

    async def _fetch_lrm_inference_key(
        self, entry: ServiceEntry, *, process_credential: str
    ) -> tuple[str, str]:
        """``(shared_key, host_key)``.

        The shared key goes to every dependent including the sandbox container;
        the host key is withheld from it. See
        ``llmrouter_manager/common/inference_key.py`` for why they differ.
        """
        url = (
            f"http://127.0.0.1:{entry.port}"
            f"{entry.proxy_prefix}/v1/internal/inference-key"
        )
        try:
            async with httpx.AsyncClient(timeout=1.0, trust_env=False) as client:
                response = await client.get(
                    url,
                    headers={PROCESS_CREDENTIAL_HEADER: process_credential},
                )
            if response.status_code != 200:
                raise ReadinessError(
                    f"LRM inference credential endpoint returned HTTP {response.status_code}"
                )
            payload = response.json()
        except httpx.HTTPError as exc:
            raise ReadinessError(
                f"LRM inference credential request failed: {type(exc).__name__}"
            ) from exc
        except ValueError as exc:
            raise ReadinessError("LRM inference credential payload is invalid") from exc
        if not isinstance(payload, dict):
            raise ReadinessError("LRM inference credential payload must be an object")
        api_key = payload.get("api_key")
        if not isinstance(api_key, str) or not api_key.strip():
            raise ReadinessError("LRM inference credential payload has no key")
        # Absent host key -> distribute NONE, rather than mirroring the shared
        # one. Mirroring would hand the sandbox a credential that opens the
        # pinned route, which is precisely what this pair exists to prevent;
        # distributing nothing instead costs only dictation clean-up, which
        # degrades to a legible error. Not a readiness failure either: LRM and
        # ServiceHub ship in one executable, so a missing member is a build
        # mismatch, and bricking startup over it would be worse than losing one
        # optional feature.
        host_key = payload.get("host_api_key")
        if not isinstance(host_key, str) or not host_key.strip():
            logger.warning(
                "LRM reported no host-only data-plane key; "
                "pinned completions will be unavailable name={}",
                entry.name,
            )
            return api_key, ""
        return api_key, host_key

    async def _fetch_privacy_data_plane_key(
        self, entry: ServiceEntry, *, process_credential: str
    ) -> str:
        url = (
            f"http://127.0.0.1:{entry.port}"
            f"{entry.proxy_prefix}/v1/internal/data-plane-key"
        )
        try:
            async with httpx.AsyncClient(timeout=1.0, trust_env=False) as client:
                response = await client.get(
                    url,
                    headers={PROCESS_CREDENTIAL_HEADER: process_credential},
                )
            if response.status_code != 200:
                raise ReadinessError(
                    "Privacy data-plane credential endpoint returned "
                    f"HTTP {response.status_code}"
                )
            payload = response.json()
        except httpx.HTTPError as exc:
            raise ReadinessError(
                f"Privacy data-plane credential request failed: {type(exc).__name__}"
            ) from exc
        except ValueError as exc:
            raise ReadinessError(
                "Privacy data-plane credential payload is invalid"
            ) from exc
        if not isinstance(payload, dict):
            raise ReadinessError(
                "Privacy data-plane credential payload must be an object"
            )
        api_key = payload.get("api_key")
        if not isinstance(api_key, str) or not api_key.strip():
            raise ReadinessError("Privacy data-plane credential payload has no key")
        return api_key

    async def _spawn_child(
        self, entry: ServiceEntry, env: dict[str, str], *, stdout, stderr, stdin
    ) -> Process:
        """Create a child process directly.

        A frozen child used to be an INDEPENDENT PyInstaller application launched
        from its own sibling `<child>/<child>.exe` tree, and starting one as a
        direct child of the long-lived frozen Hub was unreliable: on
        Windows/PyInstaller 6.21 a replacement could stall in
        Py_InitializeFromConfig after the original was force-killed. That needed
        three workarounds - a PowerShell broker process to establish a clean host,
        stripping every private `_PYI_*` variable plus setting
        PYINSTALLER_RESET_ENVIRONMENT, and clearing the process-wide DLL directory
        (which PyInstaller points at its own `_internal`) across the spawn.

        None of that applies now. ServiceHub and its children are ONE PyInstaller
        application selected by `--service <role>`, so a child re-execs our own
        image and inherits exactly the `_MEIPASS`/`_internal`/DLL context it is
        supposed to run under - which is the launch shape PyInstaller supports for
        `multiprocessing.freeze_support`. Removing the broker also removes a
        process layer from the tree: `superclaw-services.exe -> superclaw-services.exe`
        rather than `superclaw-services.exe -> powershell.exe -> <child>.exe`.

        The pipe-vs-file stdio choice made by the caller is UNRELATED to any of
        this and is still load-bearing; see the EDR filter-driver deadlock
        documented in :meth:`spawn_service`.

        A frozen ``launch.kind = "exe"`` child would still be an independent
        application and would still need that isolation, so it is refused rather
        than launched into the known Py_InitializeFromConfig stall. The schema
        keeps accepting ``"exe"`` because a non-frozen dev run resolves it through
        the module path, where the question does not arise.
        """
        role = _launch_role(entry)
        if (
            sys.platform == "win32"
            and bool(getattr(sys, "frozen", False))
            and role is None
            and (entry.launch or {}).get("kind") != "module"
        ):
            raise RuntimeError(
                f"service {entry.name} declares launch.kind="
                f"{(entry.launch or {}).get('kind')!r}, which would start an "
                "INDEPENDENT frozen application. The PowerShell broker, _PYI_* "
                "stripping and DLL-directory reset that made that safe were removed "
                "when ServiceHub and its children became one PyInstaller bundle. "
                "Use launch.kind='role' (same bundle, selected by --service) or "
                "'module' (source launch)."
            )
        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        if sys.platform == "win32":
            creationflags |= _CREATE_SUSPENDED
        process = await asyncio.create_subprocess_exec(
            *child_argv(entry),
            stdin=stdin,
            stdout=stdout,
            stderr=stderr,
            env=env,
            creationflags=creationflags,
        )
        if sys.platform == "win32":
            transport = getattr(process, "_transport")
            popen = transport.get_extra_info("subprocess")
            try:
                job = WindowsJob.assign_suspended_process(
                    int(getattr(popen, "_handle")),
                    process.pid,
                )
            except Exception as exc:
                try:
                    process.kill()
                except ProcessLookupError:
                    pass
                except OSError as kill_error:
                    raise RuntimeError(
                        f"could not contain child process tree name={entry.name} "
                        f"pid={process.pid}: {exc}; cleanup kill failed: {kill_error}"
                    ) from kill_error
                try:
                    await asyncio.wait_for(
                        asyncio.shield(process.wait()),
                        timeout=_TREE_KILL_EXIT_WAIT_S,
                    )
                except asyncio.TimeoutError as wait_error:
                    raise RuntimeError(
                        f"could not contain child process tree name={entry.name} "
                        f"pid={process.pid}: {exc}; suspended child did not exit "
                        f"within {_TREE_KILL_EXIT_WAIT_S:.1f}s"
                    ) from wait_error
                raise RuntimeError(
                    f"could not contain child process tree name={entry.name} "
                    f"pid={process.pid}: {exc}"
                ) from exc
            self._jobs_by_pid[process.pid] = job
        return process

    async def restart_service(self, name: str, *, reason: str) -> None:
        """Manual, one-shot restart (the operations fan-out ``reason="manual"``).

        A user-initiated restart gets a FRESH restart budget (mirrors
        ``RouterSupervisor.restart``) and surfaces a failed relaunch to the caller
        (the operation tracker) rather than looping. Automatic recovery from a
        crash-exit or sustained probe failure goes through
        :meth:`trigger_self_heal`, which consumes the budget and never raises.
        """
        if self._shutting_down:
            logger.info(
                "ignoring child restart during ServiceHub shutdown name={} reason={}",
                name,
                reason,
            )
            return
        service = self.registry.get(name)
        entry = self._entries.get(name)
        if service is None or entry is None:
            return
        logger.info(
            "restarting child service name={} reason={} restart_attempt={}",
            name,
            reason,
            service.restart_attempts + 1,
        )
        # A manual restart starts the budget over so a fresh user action is never
        # pre-charged by earlier automatic self-heal attempts.
        service.restart_attempts = 0
        service.ready_since = None
        try:
            await self._attempt_relaunch(name, reason=reason)
        except ShutdownInProgress:
            service.state = "stopped"
            logger.info(
                "child restart cancelled by ServiceHub shutdown name={}",
                name,
            )
        except ReadinessError:
            service.state = "error"
            logger.error("child service restart failed readiness name={}", name)
            raise
        except RuntimeError as exc:
            service.state = "error"
            logger.error("child service restart blocked name={} detail={}", name, exc)
            raise

    async def _attempt_relaunch(self, name: str, *, reason: str) -> ServiceInfo:
        """Tear down the current child and spawn a fresh instance in its place.

        Shared by :meth:`restart_service` (manual) and :meth:`trigger_self_heal`
        (automatic). Persists the current attempt count so the respawned
        ``ServiceInfo`` carries the budget forward, then propagates
        ``ShutdownInProgress`` / ``ReadinessError`` / ``RuntimeError`` to the
        caller, which decides how to treat each (one-shot vs consumable retry).
        """
        service = self.registry.get(name)
        entry = self._entries[name]
        self._restart_attempts[name] = service.restart_attempts
        service.state = "restarting"
        await self.shutdown_service(service)
        await self._stop_monitor(name)
        # An on-demand child can reach here mid-session via trigger_self_heal on
        # an unexpected exit. A blocked port with no owner must not fail its
        # relaunch; the orphan reap still runs for both.
        await self._ensure_fixed_ports_bindable(
            [entry], fail_on_ownerless=entry.startup != "on_demand"
        )
        # ``shutdown_service`` above leaves the (now torn-down) instance in
        # "stopped". Re-assert "restarting" so status consumers (Dev Tools) show
        # a relaunch in progress rather than a spuriously "stopped" service for
        # the whole ``spawn_service`` readiness wait - which can now legitimately
        # last minutes while a slow child (AV re-scan of the frozen image on
        # relaunch) initialises. ``stopping`` is likewise cleared so the fresh
        # instance is not mistaken for one being shut down.
        service.state = "restarting"
        service.stopping = False
        packaged_exe = (
            sys.platform == "win32"
            and bool(getattr(sys, "frozen", False))
            and entry.launch.get("kind") != "module"
        )
        if packaged_exe:
            restarted = await self.spawn_service(
                entry,
                _replace=True,
                ready_timeout_s=max(
                    entry.ready_timeout_s,
                    PACKAGED_RECOVERY_READY_TIMEOUT_S,
                ),
            )
        else:
            restarted = await self.spawn_service(
                entry,
                _replace=True,
            )
        await self._notify_service_restarted(restarted, reason)
        return restarted

    async def _notify_service_restarted(
        self, service: ServiceInfo, reason: str
    ) -> None:
        callback = self._service_restarted_callback
        if callback is None:
            return
        try:
            await callback(service, reason)
        except Exception as exc:
            # The child itself is healthy. A domain recovery callback failure
            # must not spend another process-restart attempt or kill it again.
            logger.exception(
                "post-restart recovery failed name={} reason={} error_type={} detail={}",
                service.name,
                reason,
                type(exc).__name__,
                str(exc),
            )

    async def trigger_self_heal(self, name: str, *, reason: str) -> None:
        """Relaunch a crashed / unhealthy child within the restart budget.

        Invoked by the crash-exit monitor (``reason="unexpected_exit"``) and the
        watchdog (``reason="probe_failures"``). Both share the one
        ``restart_attempts`` budget on ``ServiceInfo``; the ``_healing`` guard
        stops them from driving the same child concurrently and double-spending
        it.

        The loop mirrors the LLMRouter fix (#1624): it consumes an attempt with
        backoff before each relaunch and NEVER raises. A relaunch that spawns but
        fails readiness (``ReadinessError``) is a CONSUMABLE attempt - keep
        retrying to ``MAX_ON_FAILURE_RESTARTS`` instead of giving up after one. A
        permanent pre-spawn failure (blocked port, ``RuntimeError``)
        short-circuits to ``error`` because retrying cannot help.
        """
        if self._shutting_down:
            logger.info(
                "ignoring child self-heal during ServiceHub shutdown name={} reason={}",
                name,
                reason,
            )
            return
        service = self.registry.get(name)
        entry = self._entries.get(name)
        if service is None or entry is None:
            return
        if service.stopping:
            return
        if name in self._healing:
            logger.debug(
                "child self-heal already in flight name={} reason={}", name, reason
            )
            return
        self._healing.add(name)
        try:
            async with self._recovery_lock:
                await self._run_self_heal(name, service=service, reason=reason)
        finally:
            self._healing.discard(name)

    async def _run_self_heal(
        self,
        name: str,
        *,
        service: ServiceInfo,
        reason: str,
    ) -> None:
        while True:
            if service.restart_attempts >= MAX_ON_FAILURE_RESTARTS:
                service.state = "error"
                logger.error(
                    "child self-heal leaving service in error state name={} "
                    "reason=max_restarts_exhausted restarts={}",
                    name,
                    service.restart_attempts,
                )
                return
            backoff = RESTART_BACKOFFS[
                min(service.restart_attempts, len(RESTART_BACKOFFS) - 1)
            ]
            service.restart_attempts += 1
            logger.warning(
                "child self-heal scheduling relaunch name={} reason={} "
                "restart_attempt={} delay_s={}",
                name,
                reason,
                service.restart_attempts,
                backoff,
            )
            await asyncio.sleep(backoff)
            # Hub shutdown is the authoritative external cancel; the per-service
            # ``stopping`` flag may have been set by our own teardown above, so it
            # must NOT abort a mid-budget retry.
            if self._shutting_down:
                return
            try:
                await self._attempt_relaunch(name, reason=reason)
            except ShutdownInProgress:
                service.state = "stopped"
                logger.info(
                    "child self-heal cancelled by ServiceHub shutdown name={}",
                    name,
                )
                return
            except ReadinessError as exc:
                logger.warning(
                    "child self-heal relaunch failed readiness name={} "
                    "attempt={} detail={}",
                    name,
                    service.restart_attempts,
                    exc,
                )
                continue
            except RuntimeError as exc:
                service.state = "error"
                logger.error(
                    "child self-heal relaunch blocked name={} detail={}", name, exc
                )
                return
            else:
                return

    async def shutdown_all(self) -> None:
        self.begin_shutdown()
        for task in list(self._start_tasks.values()):
            task.cancel()
        if self._start_tasks:
            await asyncio.gather(*self._start_tasks.values(), return_exceptions=True)
        self._start_tasks.clear()
        for name in list(self._monitor_tasks):
            await self._stop_monitor(name)
        failures: list[str] = []
        # Dependents first, by declaration order (topological), not registration
        # order: an early-spawned child registers before the providers it uses.
        declared = {name: index for index, name in enumerate(self._entries)}
        for service in sorted(
            reversed(self.registry.all()),
            key=lambda service: declared.get(service.name, len(declared)),
            reverse=True,
        ):
            try:
                await self.shutdown_service(service)
            except Exception as exc:
                failures.append(f"{service.name}: {exc}")
                logger.error(
                    "child shutdown failed name={} error_type={} detail={}",
                    service.name,
                    type(exc).__name__,
                    str(exc),
                )
        if failures:
            raise ProcessShutdownError(
                "one or more child process trees could not be stopped: "
                + "; ".join(failures)
            )

    def current_process_credential(
        self,
        name: str,
        *,
        expected_instance_id: str | None = None,
    ) -> str | None:
        service = self.registry.get(name)
        if service is None:
            return None
        if expected_instance_id is None and service.state != "running":
            return None
        if expected_instance_id is not None and service.instance_id != expected_instance_id:
            return None
        current = self._current_process_credentials.get(name)
        if current is None or current[0] != service.instance_id:
            return None
        return current[1]

    async def shutdown_service(self, service: ServiceInfo) -> None:
        process = service.process
        if not isinstance(process, Process):
            service.state = "stopped"
            return
        # A registered Job Object means the tree may outlive the root, so an exited
        # root alone is not "stopped" until ``_terminate`` has drained its job.
        if process.returncode is not None and process.pid not in self._jobs_by_pid:
            service.state = "stopped"
            return
        service.stopping = True
        logger.info(
            "shutting down child service name={} pid={} port={}",
            service.name,
            process.pid,
            service.port,
        )
        if process.returncode is None:
            await self._try_http_shutdown(service)
        try:
            await self._terminate(
                process,
                service.shutdown_grace_s,
                service_name=service.name,
            )
        except ProcessTerminationError:
            service.state = "error"
            raise
        service.state = "stopped"

    async def _try_http_shutdown(self, service: ServiceInfo) -> None:
        url = f"http://127.0.0.1:{service.port}{service.proxy_prefix}/v1/shutdown"
        credential = self.current_process_credential(
            service.name,
            expected_instance_id=service.instance_id,
        )
        if credential is None:
            logger.warning(
                "child shutdown credential unavailable name={} port={} instance_id={}",
                service.name,
                service.port,
                service.instance_id,
            )
            return
        try:
            async with httpx.AsyncClient(timeout=1.0, trust_env=False) as client:
                response = await client.post(
                    url,
                    headers={PROCESS_CREDENTIAL_HEADER: credential},
                )
                if not 200 <= response.status_code < 300:
                    logger.warning(
                        "child shutdown request rejected name={} port={} status_code={}",
                        service.name,
                        service.port,
                        response.status_code,
                    )
        except httpx.HTTPError as exc:
            logger.warning(
                "child shutdown request failed name={} port={} error_type={}",
                service.name,
                service.port,
                type(exc).__name__,
            )
            return

    async def _terminate(
        self,
        process: Process,
        grace_s: float,
        *,
        skip_grace: bool = False,
        service_name: str = "unknown",
    ) -> None:
        # ``skip_grace`` is for a child that was NEVER asked to exit and is not
        # healthy — a readiness failure or a cancelled just-spawned child. The
        # grace wait exists to give a child that received a shutdown request time
        # to exit cleanly; a wedged startup child (0% CPU, no port bound) will
        # never answer, so waiting ``grace_s`` on it just burns that many seconds
        # doing nothing before the force-kill that was always coming. Skip
        # straight to the tree-kill. The normal ``shutdown_service`` path leaves
        # this False: there the child was healthy and got an HTTP shutdown first,
        # so grace is a real graceful-exit window.
        job = self._jobs_by_pid.get(process.pid) if sys.platform == "win32" else None
        if sys.platform == "win32" and job is None:
            raise ProcessTerminationError(
                service_name,
                process.pid,
                "managed Windows child has no Job Object; refusing a root-only kill",
            )

        graceful_exit = process.returncode is not None
        if not skip_grace and not graceful_exit:
            try:
                await asyncio.wait_for(process.wait(), timeout=grace_s)
                graceful_exit = True
            except asyncio.TimeoutError:
                logger.warning(
                    "force-killing child service pid={} after grace timeout={}s",
                    process.pid,
                    grace_s,
                )
        if job is not None:
            if graceful_exit:
                try:
                    await job.wait_empty(_TREE_KILL_EXIT_WAIT_S)
                except WindowsJobError as drain_error:
                    logger.warning(
                        "child process tree did not drain pid={} detail={}; terminating Job Object",
                        process.pid,
                        drain_error,
                    )
                    try:
                        await job.terminate_and_wait(_TREE_KILL_EXIT_WAIT_S)
                    except WindowsJobError as terminate_error:
                        raise ProcessTerminationError(
                            service_name,
                            process.pid,
                            f"graceful drain failed ({drain_error}); Job Object termination failed "
                            f"({terminate_error})",
                        ) from terminate_error
            else:
                try:
                    await job.terminate_and_wait(_TREE_KILL_EXIT_WAIT_S)
                except WindowsJobError as exc:
                    raise ProcessTerminationError(
                        service_name, process.pid, str(exc)
                    ) from exc
            if process.returncode is None:
                try:
                    await asyncio.wait_for(
                        process.wait(), timeout=_TREE_KILL_EXIT_WAIT_S
                    )
                except asyncio.TimeoutError as exc:
                    raise ProcessTerminationError(
                        service_name,
                        process.pid,
                        "Job Object drained but the root process handle did not signal exit",
                    ) from exc
            self._jobs_by_pid.pop(process.pid, None)
            return

        if graceful_exit:
            return
        if process.returncode is None:
            try:
                process.kill()
            except ProcessLookupError:
                pass
            except OSError as exc:
                raise ProcessTerminationError(
                    service_name,
                    process.pid,
                    f"direct process termination failed: {exc}",
                ) from exc
        try:
            await asyncio.wait_for(process.wait(), timeout=_TREE_KILL_EXIT_WAIT_S)
        except asyncio.TimeoutError as exc:
            raise ProcessTerminationError(
                service_name,
                process.pid,
                "root process remained alive after force-kill timeout",
            ) from exc

    async def _watch_process_exit(self, service: ServiceInfo) -> None:
        process = service.process
        if not isinstance(process, Process):
            return
        await process.wait()
        if self._shutting_down or service.stopping or service.state == "stopped":
            return
        logger.warning(
            "child service exited unexpectedly name={} pid={} returncode={}",
            service.name,
            process.pid,
            process.returncode,
        )
        if process.pid in self._jobs_by_pid:
            try:
                await self._terminate(
                    process,
                    0.0,
                    skip_grace=True,
                    service_name=service.name,
                )
            except ProcessTerminationError as exc:
                service.state = "error"
                logger.error("crashed child process tree cleanup failed: {}", exc)
                return
        else:
            await asyncio.to_thread(_reap_owned_descendants, process.pid)
        service.state = "error"
        # A crash invalidates the dwell window: the child is no longer healthy, so
        # the watchdog must not reset the budget on the strength of a stale
        # ready_since (issue #1663).
        service.ready_since = None
        if service.restart_policy in {"on-failure", "always"}:
            await self.trigger_self_heal(service.name, reason="unexpected_exit")

    async def _stop_monitor(self, name: str) -> None:
        task = self._monitor_tasks.pop(name, None)
        current = asyncio.current_task()
        if task is None or task.done() or task is current:
            return
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            return

    def _log_path(self, service_name: str, stream_name: str) -> Path:
        self._cfg.log_dir.mkdir(parents=True, exist_ok=True)
        timestamp = datetime.now().strftime("%Y%m%dT%H%M%S")
        return self._cfg.log_dir / f"{service_name}-{stream_name}-{timestamp}.log"

    def _prepare_raw_log(self, path: Path, service_name: str, stream_name: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self._prune_raw_logs(service_name, stream_name, keep=path)

    def _prune_raw_logs(self, service_name: str, stream_name: str, *, keep: Path | None = None) -> None:
        pattern = f"{service_name}-{stream_name}-*.log"
        paths = sorted(self._cfg.log_dir.glob(pattern))
        if keep is not None and keep not in paths:
            paths.append(keep)
            paths.sort()
        if len(paths) <= _CHILD_RAW_LOG_RETENTION_COUNT:
            return
        for old_path in paths[:-_CHILD_RAW_LOG_RETENTION_COUNT]:
            if keep is not None and old_path == keep:
                continue
            try:
                old_path.unlink(missing_ok=True)
            except OSError as exc:
                # A Windows child inherits its stdout/stderr file handle for its
                # whole lifetime (open("ab") in spawn_service — Windows omits
                # FILE_SHARE_DELETE), so if a prior child was stranded (force-kill
                # / crash that skipped the tree-kill, or a taskkill that failed)
                # its still-open log raises PermissionError [WinError 32] here.
                # missing_ok covers only FileNotFoundError. This runs pre-spawn in
                # _prepare_raw_log, so letting it propagate would make every future
                # launch of this service fail before it spawns — permanently dead
                # narration, or an app that stops opening. Retention is best-effort:
                # log the leaked file and move on.
                logger.warning(
                    "could not prune raw log {} (held open by a stranded child?); "
                    "leaving it in place: {}",
                    old_path,
                    exc,
                )

    async def _drain_stream(self, stream, path: Path) -> None:
        if stream is None:
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("ab") as handle:
            while True:
                chunk = await stream.readline()
                if not chunk:
                    return
                handle.write(chunk)
                handle.flush()
