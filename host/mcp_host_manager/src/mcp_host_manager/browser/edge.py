"""Finds and launches the host Edge with `--remote-debugging-pipe`, in a gateway-held Job.

Chromium reads CDP from CRT file descriptor 3 and writes to 4, NUL-terminated JSON each way. On
Windows a parent hands a child CRT descriptors through `STARTUPINFOW.lpReserved2` (the table the
MSVCRT and UCRT read at start-up, and that libuv writes for Node), so Edge is started with
`CreateProcessW` directly. Only the two pipe ends are inherited (`PROC_THREAD_ATTRIBUTE_HANDLE_LIST`).
"""

from __future__ import annotations

import asyncio
import ctypes
import os
import queue
import struct
import subprocess
import sys
import threading
import time
from collections.abc import Sequence
from pathlib import Path

from contracts.host_mcp_api_data import HOST_MCP_RULES
from loguru import logger

from ..job import HostJob, HostJobError
from ..stdio_host import child_environment
from .authenticode import signed_by_microsoft
from .relay import MessageTooLarge, TransportFull

_FOPEN = 0x01
_FPIPE = 0x08
_INVALID_HANDLE_VALUE = -1
_HANDLE_FLAG_INHERIT = 0x00000001
_CREATE_SUSPENDED = 0x00000004
_CREATE_UNICODE_ENVIRONMENT = 0x00000400
_EXTENDED_STARTUPINFO_PRESENT = 0x00080000
_PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x00020002
_WAIT_OBJECT_0 = 0
_RESUME_FAILED = 0xFFFFFFFF
_PIPE_BUFFER_BYTES = 1024 * 1024
_READ_CHUNK_BYTES = 64 * 1024
_APP_PATHS_KEY = r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe"
_KILL_WAIT_S = 2.0
MAX_MESSAGE_BYTES = 64 * 1024 * 1024
MAX_QUEUED_BYTES = 128 * 1024 * 1024

EDGE_ARGUMENTS = (
    "--remote-debugging-pipe",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--hide-crash-restore-bubble",
    # No start-up window: it would be in the default context, which is signed in to the user's
    # account. The DevTools pipe keeps Edge running with no window open.
    "--no-startup-window",
    *HOST_MCP_RULES["edge_required_args"],
)


class HostBrowserUnavailable(Exception):
    """Edge cannot be launched on this computer (not Windows, or msedge.exe not found)."""


def default_user_data_dir() -> Path:
    local = os.environ.get("LOCALAPPDATA")
    base = Path(local) if local else Path.home() / "AppData" / "Local"
    return base / "SuperClaw" / "agent-browser"


def locate_edge() -> Path:
    """The machine-wide Edge, Authenticode-signed by Microsoft.

    The two Program Files installs first, then the machine App Paths entry. The per-user App Paths
    entry is never read: any process running as the user can rewrite it.
    """
    if sys.platform != "win32":
        raise HostBrowserUnavailable("the host browser needs Windows")
    candidates = [
        Path(base) / "Microsoft" / "Edge" / "Application" / "msedge.exe"
        for base in (os.environ.get("ProgramFiles(x86)"), os.environ.get("ProgramFiles"))
        if base
    ]
    registered = _machine_app_path()
    if registered is not None:
        candidates.append(registered)
    for candidate in candidates:
        if candidate.is_file() and signed_by_microsoft(candidate):
            return candidate
        if candidate.is_file():
            logger.warning("ignoring {}: it is not signed by Microsoft", candidate)
    raise HostBrowserUnavailable("msedge.exe was not found")


def _machine_app_path() -> Path | None:
    import winreg

    try:
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, _APP_PATHS_KEY) as key:
            value, _ = winreg.QueryValueEx(key, None)
    except OSError:
        return None
    return Path(os.path.expandvars(value.strip().strip('"'))) if isinstance(value, str) else None


def edge_command_line(edge: Path, user_data_dir: Path) -> list[str]:
    return [str(edge), f"--user-data-dir={user_data_dir}", *EDGE_ARGUMENTS]


def build_crt_fd_blob(handles: Sequence[int | None]) -> bytes:
    """`lpReserved2` for CRT descriptors 0..n-1: an int count, a flag byte each, a HANDLE each.

    None is a descriptor the child does not get (flags 0, INVALID_HANDLE_VALUE); a handle is a pipe.
    """
    handle_format = "q" if struct.calcsize("P") == 8 else "i"
    flags = bytes(0 if handle is None else _FOPEN | _FPIPE for handle in handles)
    values = struct.pack(
        f"<{len(handles)}{handle_format}",
        *(_INVALID_HANDLE_VALUE if handle is None else handle for handle in handles),
    )
    return struct.pack("<i", len(handles)) + flags + values


def environment_block(env: dict[str, str]) -> str:
    entries = sorted(env.items(), key=lambda item: item[0].upper())
    return "".join(f"{key}={value}\0" for key, value in entries) + "\0"


class _StartupInfo(ctypes.Structure):
    _fields_ = [
        ("cb", ctypes.c_uint32),
        ("lpReserved", ctypes.c_wchar_p),
        ("lpDesktop", ctypes.c_wchar_p),
        ("lpTitle", ctypes.c_wchar_p),
        ("dwX", ctypes.c_uint32),
        ("dwY", ctypes.c_uint32),
        ("dwXSize", ctypes.c_uint32),
        ("dwYSize", ctypes.c_uint32),
        ("dwXCountChars", ctypes.c_uint32),
        ("dwYCountChars", ctypes.c_uint32),
        ("dwFillAttribute", ctypes.c_uint32),
        ("dwFlags", ctypes.c_uint32),
        ("wShowWindow", ctypes.c_uint16),
        ("cbReserved2", ctypes.c_uint16),
        ("lpReserved2", ctypes.c_void_p),
        ("hStdInput", ctypes.c_void_p),
        ("hStdOutput", ctypes.c_void_p),
        ("hStdError", ctypes.c_void_p),
    ]


class _StartupInfoEx(ctypes.Structure):
    _fields_ = [("StartupInfo", _StartupInfo), ("lpAttributeList", ctypes.c_void_p)]


class _ProcessInformation(ctypes.Structure):
    _fields_ = [
        ("hProcess", ctypes.c_void_p),
        ("hThread", ctypes.c_void_p),
        ("dwProcessId", ctypes.c_uint32),
        ("dwThreadId", ctypes.c_uint32),
    ]


_kernel32_cache: ctypes.CDLL | None = None


def _kernel32() -> ctypes.CDLL:
    global _kernel32_cache
    if _kernel32_cache is not None:
        return _kernel32_cache
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    handle, dword, boolean = ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int
    k32.CreatePipe.argtypes = [ctypes.POINTER(handle), ctypes.POINTER(handle), ctypes.c_void_p, dword]
    k32.CreatePipe.restype = boolean
    k32.SetHandleInformation.argtypes = [handle, dword, dword]
    k32.SetHandleInformation.restype = boolean
    k32.InitializeProcThreadAttributeList.argtypes = [
        ctypes.c_void_p,
        dword,
        dword,
        ctypes.POINTER(ctypes.c_size_t),
    ]
    k32.InitializeProcThreadAttributeList.restype = boolean
    k32.UpdateProcThreadAttribute.argtypes = [
        ctypes.c_void_p,
        dword,
        ctypes.c_size_t,
        ctypes.c_void_p,
        ctypes.c_size_t,
        ctypes.c_void_p,
        ctypes.c_void_p,
    ]
    k32.UpdateProcThreadAttribute.restype = boolean
    k32.DeleteProcThreadAttributeList.argtypes = [ctypes.c_void_p]
    k32.DeleteProcThreadAttributeList.restype = None
    k32.CreateProcessW.argtypes = [
        ctypes.c_wchar_p,
        ctypes.c_wchar_p,
        ctypes.c_void_p,
        ctypes.c_void_p,
        boolean,
        dword,
        ctypes.c_void_p,
        ctypes.c_wchar_p,
        ctypes.c_void_p,
        ctypes.POINTER(_ProcessInformation),
    ]
    k32.CreateProcessW.restype = boolean
    k32.ResumeThread.argtypes = [handle]
    k32.ResumeThread.restype = dword
    k32.TerminateProcess.argtypes = [handle, ctypes.c_uint]
    k32.TerminateProcess.restype = boolean
    k32.WaitForSingleObject.argtypes = [handle, dword]
    k32.WaitForSingleObject.restype = dword
    k32.CloseHandle.argtypes = [handle]
    k32.CloseHandle.restype = boolean
    k32.ReadFile.argtypes = [handle, ctypes.c_void_p, dword, ctypes.POINTER(dword), ctypes.c_void_p]
    k32.ReadFile.restype = boolean
    k32.WriteFile.argtypes = [handle, ctypes.c_void_p, dword, ctypes.POINTER(dword), ctypes.c_void_p]
    k32.WriteFile.restype = boolean
    _kernel32_cache = k32
    return k32


def _win_error(operation: str) -> HostBrowserUnavailable:
    return HostBrowserUnavailable(f"{operation} failed: {ctypes.WinError(ctypes.get_last_error())}")


def _create_pipe(k32: ctypes.CDLL) -> tuple[int, int]:
    read, write = ctypes.c_void_p(), ctypes.c_void_p()
    if not k32.CreatePipe(ctypes.byref(read), ctypes.byref(write), None, _PIPE_BUFFER_BYTES):
        raise _win_error("CreatePipe")
    return int(read.value or 0), int(write.value or 0)


class NulFramer:
    """Splits the pipe's byte stream into NUL-terminated messages, never buffering past the cap."""

    def __init__(self, max_message_bytes: int) -> None:
        self._max = max_message_bytes
        self._pending = bytearray()

    @property
    def buffered(self) -> int:
        return len(self._pending)

    def feed(self, chunk: bytes) -> list[bytes]:
        """The messages `chunk` completes. Raises MessageTooLarge before holding more than the cap."""
        messages: list[bytes] = []
        start = 0
        while (end := chunk.find(0, start)) >= 0:
            if len(self._pending) + end - start > self._max:
                raise MessageTooLarge
            messages.append(bytes(self._pending) + chunk[start:end])
            self._pending.clear()
            start = end + 1
        if len(self._pending) + len(chunk) - start > self._max:
            raise MessageTooLarge
        self._pending += chunk[start:]
        return messages


class ByteBudget:
    """Bytes queued between a thread and the event loop. One item may exceed the limit on its own."""

    def __init__(self, limit: int) -> None:
        self._limit = limit
        self._used = 0
        self._closed = False
        self._condition = threading.Condition()

    @property
    def used(self) -> int:
        return self._used

    def acquire(self, size: int) -> bool:
        """Wait until `size` fits; False once closed."""
        with self._condition:
            while not self._closed and self._used and self._used + size > self._limit:
                self._condition.wait()
            if self._closed:
                return False
            self._used += size
            return True

    def try_acquire(self, size: int) -> bool:
        with self._condition:
            if self._closed or (self._used and self._used + size > self._limit):
                return False
            self._used += size
            return True

    def charge(self, size: int) -> None:
        """Count bytes that are queued regardless of the limit (the relay's own small commands)."""
        with self._condition:
            self._used += size

    def release(self, size: int) -> None:
        with self._condition:
            self._used -= size
            self._condition.notify_all()

    def close(self) -> None:
        with self._condition:
            self._closed = True
            self._condition.notify_all()


class _Overflow:
    pass


_OVERFLOW = _Overflow()


class EdgeProcess:
    """A running Edge: its Job, its process handle, and the parent ends of the DevTools pipe.

    Memory is bounded three ways: one message from Edge is at most `max_message_bytes` (beyond it the
    connection is dropped), messages waiting for the relay are at most `max_queued_bytes` (the reader
    stops reading the pipe until the relay catches up), and so are messages waiting for the pipe (a
    bounded send past it raises TransportFull).
    """

    def __init__(
        self,
        *,
        job: HostJob,
        process_handle: int,
        pid: int,
        read_handle: int,
        write_handle: int,
        max_message_bytes: int = MAX_MESSAGE_BYTES,
        max_queued_bytes: int = MAX_QUEUED_BYTES,
    ) -> None:
        self.pid = pid
        self._job = job
        self._process = process_handle
        self._read = read_handle
        self._write = write_handle
        self._max_message_bytes = max_message_bytes
        self._incoming: asyncio.Queue[tuple[str, int] | _Overflow | None] = asyncio.Queue()
        self._incoming_budget = ByteBudget(max_queued_bytes)
        self._outgoing: queue.SimpleQueue[bytes | None] = queue.SimpleQueue()
        self._outgoing_budget = ByteBudget(max_queued_bytes)
        self._loop: asyncio.AbstractEventLoop | None = None
        self._reader: threading.Thread | None = None
        self._writer: threading.Thread | None = None
        self._closed = False
        self._close_lock = threading.Lock()

    def start(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop
        self._reader = threading.Thread(target=self._read_loop, name=f"host-edge-{self.pid}-read", daemon=True)
        self._writer = threading.Thread(target=self._write_loop, name=f"host-edge-{self.pid}-write", daemon=True)
        self._reader.start()
        self._writer.start()

    def send(self, message: str, *, bounded: bool = True) -> None:
        data = message.encode("utf-8") + b"\0"
        if bounded:
            if not self._outgoing_budget.try_acquire(len(data)):
                raise TransportFull
        else:
            self._outgoing_budget.charge(len(data))
        self._outgoing.put(data)

    async def receive(self) -> str | None:
        item = await self._incoming.get()
        if item is None:
            return None
        if isinstance(item, _Overflow):
            raise MessageTooLarge
        text, size = item
        self._incoming_budget.release(size)
        return text

    def wait_exit(self, timeout_s: float) -> bool:
        return _kernel32().WaitForSingleObject(self._process, int(timeout_s * 1000)) == _WAIT_OBJECT_0

    def kill(self) -> None:
        """End every process in the Job and wait (up to 2 s) until it is empty."""
        try:
            self._job.terminate(1)
        except HostJobError as error:
            logger.error("host Edge Job did not terminate: {}", error)
        deadline = time.monotonic() + _KILL_WAIT_S
        while time.monotonic() < deadline:
            try:
                if self._job.is_empty():
                    return
            except HostJobError:
                return
            time.sleep(0.02)
        logger.error("host Edge Job still had processes {} s after termination", _KILL_WAIT_S)

    def close(self) -> None:
        """Release the handles. Call after `kill`, once the browser can no longer hold the pipe open.

        Safe to call from two threads: a handle value closed twice could belong to someone else.
        """
        with self._close_lock:
            if self._closed:
                return
            self._closed = True
        k32 = _kernel32()
        self._incoming_budget.close()
        self._outgoing_budget.close()
        self._outgoing.put(None)
        if self._writer is not None:
            self._writer.join(timeout=_KILL_WAIT_S)
        if self._reader is not None:
            self._reader.join(timeout=_KILL_WAIT_S)
        for handle in (self._read, self._write, self._process):
            k32.CloseHandle(handle)
        try:
            self._job.close()
        except HostJobError as error:
            logger.error("host Edge Job did not close: {}", error)

    def _read_loop(self) -> None:
        k32 = _kernel32()
        buffer = ctypes.create_string_buffer(_READ_CHUNK_BYTES)
        count = ctypes.c_uint32()
        framer = NulFramer(self._max_message_bytes)
        while k32.ReadFile(self._read, buffer, _READ_CHUNK_BYTES, ctypes.byref(count), None):
            try:
                messages = framer.feed(buffer.raw[: count.value])
            except MessageTooLarge:
                self._deliver(_OVERFLOW)
                return
            for message in messages:
                if not self._incoming_budget.acquire(len(message)):
                    return
                self._deliver((message.decode("utf-8", errors="replace"), len(message)))
        self._deliver(None)

    def _write_loop(self) -> None:
        k32 = _kernel32()
        written = ctypes.c_uint32()
        while (data := self._outgoing.get()) is not None:
            view = memoryview(data)
            while view:
                chunk = (ctypes.c_char * len(view)).from_buffer_copy(view)
                if not k32.WriteFile(self._write, chunk, len(view), ctypes.byref(written), None):
                    return
                view = view[written.value :]
            self._outgoing_budget.release(len(data))

    def _deliver(self, item: tuple[str, int] | _Overflow | None) -> None:
        loop = self._loop
        if loop is None:
            return
        try:
            loop.call_soon_threadsafe(self._incoming.put_nowait, item)
        except RuntimeError:
            pass


def launch_edge(user_data_dir: Path) -> EdgeProcess:
    """Start Edge suspended, put it in a new Job, resume it. Raises HostBrowserUnavailable."""
    edge = locate_edge()
    user_data_dir.mkdir(parents=True, exist_ok=True)
    k32 = _kernel32()
    try:
        job = HostJob.create()
    except HostJobError as error:
        raise HostBrowserUnavailable(f"the Job could not be created: {error}") from error
    parent_ends: list[int] = []
    child_ends: list[int] = []
    attributes: ctypes.Array[ctypes.c_char] | None = None
    process_info = _ProcessInformation()
    try:
        child_read, parent_write = _create_pipe(k32)
        parent_ends.append(parent_write)
        child_ends.append(child_read)
        parent_read, child_write = _create_pipe(k32)
        parent_ends.append(parent_read)
        child_ends.append(child_write)
        for handle in child_ends:
            if not k32.SetHandleInformation(handle, _HANDLE_FLAG_INHERIT, _HANDLE_FLAG_INHERIT):
                raise _win_error("SetHandleInformation")

        size = ctypes.c_size_t()
        k32.InitializeProcThreadAttributeList(None, 1, 0, ctypes.byref(size))
        attributes = ctypes.create_string_buffer(size.value)
        if not k32.InitializeProcThreadAttributeList(attributes, 1, 0, ctypes.byref(size)):
            attributes = None
            raise _win_error("InitializeProcThreadAttributeList")
        inherited = (ctypes.c_void_p * 2)(child_read, child_write)
        if not k32.UpdateProcThreadAttribute(
            attributes, 0, _PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited, ctypes.sizeof(inherited), None, None
        ):
            raise _win_error("UpdateProcThreadAttribute")

        blob = build_crt_fd_blob([None, None, None, child_read, child_write])
        blob_buffer = ctypes.create_string_buffer(blob, len(blob))
        startup = _StartupInfoEx()
        startup.StartupInfo.cb = ctypes.sizeof(_StartupInfoEx)
        startup.StartupInfo.cbReserved2 = len(blob)
        startup.StartupInfo.lpReserved2 = ctypes.cast(blob_buffer, ctypes.c_void_p).value
        startup.lpAttributeList = ctypes.cast(attributes, ctypes.c_void_p).value

        command_line = ctypes.create_unicode_buffer(subprocess.list2cmdline(edge_command_line(edge, user_data_dir)))
        environment = ctypes.create_unicode_buffer(environment_block(child_environment({})))
        if not k32.CreateProcessW(
            str(edge),
            command_line,
            None,
            None,
            True,
            _CREATE_SUSPENDED | _CREATE_UNICODE_ENVIRONMENT | _EXTENDED_STARTUPINFO_PRESENT,
            environment,
            None,
            ctypes.byref(startup),
            ctypes.byref(process_info),
        ):
            raise _win_error("CreateProcessW")
        try:
            job.assign(int(process_info.hProcess))
            if k32.ResumeThread(process_info.hThread) == _RESUME_FAILED:
                raise _win_error("ResumeThread")
        except (HostJobError, HostBrowserUnavailable):
            k32.TerminateProcess(process_info.hProcess, 1)
            k32.CloseHandle(process_info.hProcess)
            raise
        finally:
            k32.CloseHandle(process_info.hThread)
    except BaseException:
        for handle in parent_ends:
            k32.CloseHandle(handle)
        job.close()
        raise
    finally:
        for handle in child_ends:
            k32.CloseHandle(handle)
        if attributes is not None:
            k32.DeleteProcThreadAttributeList(attributes)
    logger.info("host Edge launched pid={}", process_info.dwProcessId)
    return EdgeProcess(
        job=job,
        process_handle=int(process_info.hProcess),
        pid=int(process_info.dwProcessId),
        read_handle=parent_read,
        write_handle=parent_write,
    )
