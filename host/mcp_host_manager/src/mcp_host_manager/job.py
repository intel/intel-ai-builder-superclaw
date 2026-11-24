"""Lifecycle-only Job Objects for host MCP servers and the host browser.

A host process is created suspended, assigned to a Job the gateway holds, checked to be in it, and
only then resumed, so not one instruction of it runs outside the Job. The Job has kill-on-close and
no breakaway, so closing its handle (or the gateway dying) ends the whole tree. It deliberately sets
no UI restrictions: computer-use servers need the user's desktop, and Chromium's sandbox cannot nest
under a Job that has them (#3247).
"""

from __future__ import annotations

import ctypes
import subprocess
import sys
import threading
import weakref
from pathlib import Path

_JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION = 1
_JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9
_JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 0x00000008
_JOB_OBJECT_LIMIT_JOB_MEMORY = 0x00000200
_JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
_TH32CS_SNAPTHREAD = 0x00000004
_THREAD_SUSPEND_RESUME = 0x0002
_CREATE_SUSPENDED = 0x00000004
_CREATE_NEW_PROCESS_GROUP = 0x00000200
_CREATE_NO_WINDOW = 0x08000000
_RESUME_FAILED = 0xFFFFFFFF


class HostJobError(Exception):
    """A Job Object operation failed, or Job Objects are not available on this platform."""


if sys.platform == "win32":
    from ctypes import wintypes

    class _IoCounters(ctypes.Structure):
        _fields_ = [
            ("ReadOperationCount", ctypes.c_uint64),
            ("WriteOperationCount", ctypes.c_uint64),
            ("OtherOperationCount", ctypes.c_uint64),
            ("ReadTransferCount", ctypes.c_uint64),
            ("WriteTransferCount", ctypes.c_uint64),
            ("OtherTransferCount", ctypes.c_uint64),
        ]

    class _BasicLimitInformation(ctypes.Structure):
        _fields_ = [
            ("PerProcessUserTimeLimit", ctypes.c_int64),
            ("PerJobUserTimeLimit", ctypes.c_int64),
            ("LimitFlags", wintypes.DWORD),
            ("MinimumWorkingSetSize", ctypes.c_size_t),
            ("MaximumWorkingSetSize", ctypes.c_size_t),
            ("ActiveProcessLimit", wintypes.DWORD),
            ("Affinity", ctypes.c_size_t),
            ("PriorityClass", wintypes.DWORD),
            ("SchedulingClass", wintypes.DWORD),
        ]

    class _ExtendedLimitInformation(ctypes.Structure):
        _fields_ = [
            ("BasicLimitInformation", _BasicLimitInformation),
            ("IoInfo", _IoCounters),
            ("ProcessMemoryLimit", ctypes.c_size_t),
            ("JobMemoryLimit", ctypes.c_size_t),
            ("PeakProcessMemoryUsed", ctypes.c_size_t),
            ("PeakJobMemoryUsed", ctypes.c_size_t),
        ]

    class _BasicAccountingInformation(ctypes.Structure):
        _fields_ = [
            ("TotalUserTime", ctypes.c_int64),
            ("TotalKernelTime", ctypes.c_int64),
            ("ThisPeriodTotalUserTime", ctypes.c_int64),
            ("ThisPeriodTotalKernelTime", ctypes.c_int64),
            ("TotalPageFaults", wintypes.DWORD),
            ("TotalProcesses", wintypes.DWORD),
            ("ActiveProcesses", wintypes.DWORD),
            ("TotalTerminatedProcesses", wintypes.DWORD),
        ]

    class _ThreadEntry32(ctypes.Structure):
        _fields_ = [
            ("dwSize", wintypes.DWORD),
            ("cntUsage", wintypes.DWORD),
            ("th32ThreadID", wintypes.DWORD),
            ("th32OwnerProcessID", wintypes.DWORD),
            ("tpBasePri", ctypes.c_long),
            ("tpDeltaPri", ctypes.c_long),
            ("dwFlags", wintypes.DWORD),
        ]

    _kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _kernel32.CreateJobObjectW.argtypes = [wintypes.LPVOID, wintypes.LPCWSTR]
    _kernel32.CreateJobObjectW.restype = wintypes.HANDLE
    _kernel32.SetInformationJobObject.argtypes = [
        wintypes.HANDLE,
        ctypes.c_int,
        wintypes.LPVOID,
        wintypes.DWORD,
    ]
    _kernel32.SetInformationJobObject.restype = wintypes.BOOL
    _kernel32.QueryInformationJobObject.argtypes = [
        wintypes.HANDLE,
        ctypes.c_int,
        wintypes.LPVOID,
        wintypes.DWORD,
        ctypes.POINTER(wintypes.DWORD),
    ]
    _kernel32.QueryInformationJobObject.restype = wintypes.BOOL
    _kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    _kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
    _kernel32.IsProcessInJob.argtypes = [
        wintypes.HANDLE,
        wintypes.HANDLE,
        ctypes.POINTER(wintypes.BOOL),
    ]
    _kernel32.IsProcessInJob.restype = wintypes.BOOL
    _kernel32.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
    _kernel32.TerminateJobObject.restype = wintypes.BOOL
    _kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    _kernel32.CloseHandle.restype = wintypes.BOOL
    _kernel32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    _kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    _kernel32.Thread32First.argtypes = [wintypes.HANDLE, ctypes.POINTER(_ThreadEntry32)]
    _kernel32.Thread32First.restype = wintypes.BOOL
    _kernel32.Thread32Next.argtypes = [wintypes.HANDLE, ctypes.POINTER(_ThreadEntry32)]
    _kernel32.Thread32Next.restype = wintypes.BOOL
    _kernel32.OpenThread.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    _kernel32.OpenThread.restype = wintypes.HANDLE
    _kernel32.ResumeThread.argtypes = [wintypes.HANDLE]
    _kernel32.ResumeThread.restype = wintypes.DWORD
    _INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value


def _win_error(operation: str) -> HostJobError:
    return HostJobError(f"{operation} failed: {ctypes.WinError(ctypes.get_last_error())}")


class _JobHandle:
    """The handle value, taken out exactly once, by ``close()`` or by the finalizer, under the one
    lock every use of it holds. A handle value the next ``CreateJobObjectW`` may reuse is never
    touched, or closed a second time, after that."""

    def __init__(self, handle: int) -> None:
        self.value: int | None = handle
        self.lock = threading.Lock()

    def close(self) -> bool:
        """True when the handle was closed now or before; False when CloseHandle failed."""
        with self.lock:
            handle, self.value = self.value, None
            return handle is None or bool(_kernel32.CloseHandle(handle))


class HostJob:
    """One Job Object handle. A HostJob dropped without ``close()`` still closes its handle when
    collected, so kill-on-close still ends its tree."""

    def __init__(self, handle: int) -> None:
        self._handle = _JobHandle(handle)
        self._finalizer = weakref.finalize(self, self._handle.close)

    @classmethod
    def create(
        cls,
        *,
        active_process_limit: int | None = None,
        job_memory_limit_bytes: int | None = None,
    ) -> HostJob:
        if sys.platform != "win32":
            raise HostJobError("Job Objects are available only on Windows")
        handle = _kernel32.CreateJobObjectW(None, None)
        if not handle:
            raise _win_error("CreateJobObjectW")
        job = cls(int(handle))
        try:
            limits = _ExtendedLimitInformation()
            flags = _JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            if active_process_limit is not None:
                flags |= _JOB_OBJECT_LIMIT_ACTIVE_PROCESS
                limits.BasicLimitInformation.ActiveProcessLimit = active_process_limit
            if job_memory_limit_bytes is not None:
                flags |= _JOB_OBJECT_LIMIT_JOB_MEMORY
                limits.JobMemoryLimit = job_memory_limit_bytes
            limits.BasicLimitInformation.LimitFlags = flags
            if not _kernel32.SetInformationJobObject(
                handle,
                _JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                ctypes.byref(limits),
                ctypes.sizeof(limits),
            ):
                raise _win_error("SetInformationJobObject")
        except BaseException:
            job.close()
            raise
        return job

    def assign(self, process_handle: int) -> None:
        with self._handle.lock:
            handle = self._handle.value
            if handle is None:
                raise HostJobError("the Job Object is closed")
            if not _kernel32.AssignProcessToJobObject(handle, process_handle):
                raise _win_error("AssignProcessToJobObject")
            member = wintypes.BOOL(False)
            if not _kernel32.IsProcessInJob(process_handle, handle, ctypes.byref(member)):
                raise _win_error("IsProcessInJob")
            if not member.value:
                raise HostJobError("the process is not in the Job Object after assignment")

    def terminate(self, exit_code: int = 1) -> None:
        with self._handle.lock:
            handle = self._handle.value
            if handle is None:
                return
            if not _kernel32.TerminateJobObject(handle, exit_code):
                raise _win_error("TerminateJobObject")

    def close(self) -> None:
        self._finalizer.detach()
        if not self._handle.close():
            raise _win_error("CloseHandle(Job Object)")

    def is_empty(self) -> bool:
        with self._handle.lock:
            handle = self._handle.value
            if handle is None:
                return True
            accounting = _BasicAccountingInformation()
            returned = wintypes.DWORD()
            if not _kernel32.QueryInformationJobObject(
                handle,
                _JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION,
                ctypes.byref(accounting),
                ctypes.sizeof(accounting),
                ctypes.byref(returned),
            ):
                raise _win_error("QueryInformationJobObject")
            return accounting.ActiveProcesses == 0


def resume_process(pid: int) -> None:
    """Resume the primary thread of a process created with ``CREATE_SUSPENDED``.

    A suspended process has exactly one thread, so the first thread the snapshot lists for ``pid``
    is the primary thread.
    """
    if sys.platform != "win32":
        raise HostJobError("resuming a suspended process is available only on Windows")
    snapshot = _kernel32.CreateToolhelp32Snapshot(_TH32CS_SNAPTHREAD, 0)
    if not snapshot or snapshot == _INVALID_HANDLE_VALUE:
        raise _win_error("CreateToolhelp32Snapshot")
    try:
        entry = _ThreadEntry32()
        entry.dwSize = ctypes.sizeof(entry)
        found = _kernel32.Thread32First(snapshot, ctypes.byref(entry))
        while found:
            if entry.th32OwnerProcessID == pid:
                thread = _kernel32.OpenThread(_THREAD_SUSPEND_RESUME, False, entry.th32ThreadID)
                if not thread:
                    raise _win_error(f"OpenThread(pid={pid})")
                try:
                    if _kernel32.ResumeThread(thread) == _RESUME_FAILED:
                        raise _win_error(f"ResumeThread(pid={pid})")
                    return
                finally:
                    _kernel32.CloseHandle(thread)
            found = _kernel32.Thread32Next(snapshot, ctypes.byref(entry))
        raise HostJobError(f"no suspended primary thread found for pid={pid}")
    finally:
        _kernel32.CloseHandle(snapshot)


def spawn_in_job(
    job: HostJob,
    argv: list[str] | str,
    *,
    env: dict[str, str],
    cwd: Path | None = None,
) -> subprocess.Popen[bytes]:
    """Start ``argv`` suspended, put it in ``job``, verify, then resume it.

    ``argv`` may be a ready command line string: a ``cmd.exe /s /c "..."`` line must reach
    CreateProcess verbatim, which ``list2cmdline`` over a list cannot produce.
    """
    if sys.platform != "win32":
        raise HostJobError("spawning into a Job Object is available only on Windows")
    try:
        process = subprocess.Popen(
            argv,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            cwd=cwd,
            creationflags=_CREATE_SUSPENDED | _CREATE_NO_WINDOW | _CREATE_NEW_PROCESS_GROUP,
        )
    except OSError as exc:
        raise HostJobError(f"CreateProcess failed: {exc.strerror or type(exc).__name__}") from exc
    try:
        job.assign(int(process._handle))  # type: ignore[attr-defined]
        resume_process(process.pid)
    except BaseException:
        process.kill()
        process.wait()
        for pipe in (process.stdin, process.stdout, process.stderr):
            if pipe is not None:
                pipe.close()
        raise
    return process
