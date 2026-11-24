"""Windows Job Object containment for ServiceHub child process trees."""

from __future__ import annotations

import asyncio
import ctypes
import threading
import time
from ctypes import wintypes


_JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9
_JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION = 1
_JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
_TH32CS_SNAPTHREAD = 0x00000004
_THREAD_SUSPEND_RESUME = 0x0002
_INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value
_ACTIVE_PROCESS_POLL_S = 0.025


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


class WindowsJobError(RuntimeError):
    """A Job Object operation failed or the job did not drain before its deadline."""


class WindowsJob:
    def __init__(self, handle: int) -> None:
        self._handle = handle
        self._closed = False
        # Every use of the handle holds this lock and re-checks ``_closed``. A
        # cancelled asyncio task cannot stop its ``to_thread`` worker, so a crash
        # watcher's drain poll can still be running when shutdown closes the job;
        # without the lock it would query (or terminate) a freed handle value that
        # the next ``CreateJobObjectW`` may already have reused for another child.
        self._lock = threading.Lock()

    @classmethod
    def assign_suspended_process(cls, process_handle: int, pid: int) -> WindowsJob:
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateJobObjectW.argtypes = [wintypes.LPVOID, wintypes.LPCWSTR]
        kernel32.CreateJobObjectW.restype = wintypes.HANDLE
        kernel32.SetInformationJobObject.argtypes = [
            wintypes.HANDLE,
            ctypes.c_int,
            wintypes.LPVOID,
            wintypes.DWORD,
        ]
        kernel32.SetInformationJobObject.restype = wintypes.BOOL
        kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel32.CloseHandle.restype = wintypes.BOOL

        handle = kernel32.CreateJobObjectW(None, None)
        if not handle:
            raise _win_error("CreateJobObjectW")
        job = cls(int(handle))
        try:
            limits = _ExtendedLimitInformation()
            limits.BasicLimitInformation.LimitFlags = _JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            if not kernel32.SetInformationJobObject(
                handle,
                _JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                ctypes.byref(limits),
                ctypes.sizeof(limits),
            ):
                raise _win_error("SetInformationJobObject")
            if not kernel32.AssignProcessToJobObject(handle, process_handle):
                raise _win_error(f"AssignProcessToJobObject(pid={pid})")
            _resume_primary_thread(pid)
            return job
        except BaseException:
            job.close()
            raise

    async def terminate_and_wait(self, timeout_s: float) -> None:
        await asyncio.to_thread(self._terminate_and_wait, timeout_s)

    async def wait_empty(self, timeout_s: float) -> None:
        await asyncio.to_thread(self._wait_empty, timeout_s)

    def _terminate_and_wait(self, timeout_s: float) -> None:
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
        kernel32.TerminateJobObject.restype = wintypes.BOOL
        with self._lock:
            if self._closed:
                return
            if not kernel32.TerminateJobObject(self._handle, 1):
                raise _win_error("TerminateJobObject")
        self._wait_empty(timeout_s)

    def _wait_empty(self, timeout_s: float) -> None:
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.QueryInformationJobObject.argtypes = [
            wintypes.HANDLE,
            ctypes.c_int,
            wintypes.LPVOID,
            wintypes.DWORD,
            ctypes.POINTER(wintypes.DWORD),
        ]
        kernel32.QueryInformationJobObject.restype = wintypes.BOOL
        deadline = time.monotonic() + timeout_s
        while True:
            accounting = _BasicAccountingInformation()
            returned = wintypes.DWORD()
            with self._lock:
                if self._closed:
                    return
                if not kernel32.QueryInformationJobObject(
                    self._handle,
                    _JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION,
                    ctypes.byref(accounting),
                    ctypes.sizeof(accounting),
                    ctypes.byref(returned),
                ):
                    raise _win_error("QueryInformationJobObject")
                if accounting.ActiveProcesses == 0:
                    self._close_locked()
                    return
            if time.monotonic() >= deadline:
                raise WindowsJobError(
                    "Job Object still has "
                    f"{accounting.ActiveProcesses} active process(es) after "
                    f"{timeout_s:.3f}s"
                )
            time.sleep(_ACTIVE_PROCESS_POLL_S)

    def close(self) -> None:
        with self._lock:
            self._close_locked()

    def _close_locked(self) -> None:
        if self._closed:
            return
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel32.CloseHandle.restype = wintypes.BOOL
        if not kernel32.CloseHandle(self._handle):
            raise _win_error("CloseHandle(Job Object)")
        self._closed = True


def _resume_primary_thread(pid: int) -> None:
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    kernel32.Thread32First.argtypes = [wintypes.HANDLE, ctypes.POINTER(_ThreadEntry32)]
    kernel32.Thread32First.restype = wintypes.BOOL
    kernel32.Thread32Next.argtypes = [wintypes.HANDLE, ctypes.POINTER(_ThreadEntry32)]
    kernel32.Thread32Next.restype = wintypes.BOOL
    kernel32.OpenThread.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenThread.restype = wintypes.HANDLE
    kernel32.ResumeThread.argtypes = [wintypes.HANDLE]
    kernel32.ResumeThread.restype = wintypes.DWORD
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL

    snapshot = kernel32.CreateToolhelp32Snapshot(_TH32CS_SNAPTHREAD, 0)
    if not snapshot or snapshot == _INVALID_HANDLE_VALUE:
        raise _win_error("CreateToolhelp32Snapshot")
    try:
        entry = _ThreadEntry32()
        entry.dwSize = ctypes.sizeof(entry)
        found = kernel32.Thread32First(snapshot, ctypes.byref(entry))
        while found:
            if entry.th32OwnerProcessID == pid:
                thread = kernel32.OpenThread(
                    _THREAD_SUSPEND_RESUME,
                    False,
                    entry.th32ThreadID,
                )
                if not thread:
                    raise _win_error(f"OpenThread(pid={pid})")
                try:
                    previous_count = kernel32.ResumeThread(thread)
                    if previous_count == 0xFFFFFFFF:
                        raise _win_error(f"ResumeThread(pid={pid})")
                    return
                finally:
                    kernel32.CloseHandle(thread)
            found = kernel32.Thread32Next(snapshot, ctypes.byref(entry))
        raise WindowsJobError(f"no suspended primary thread found for pid={pid}")
    finally:
        kernel32.CloseHandle(snapshot)


def _win_error(operation: str) -> WindowsJobError:
    error = ctypes.WinError(ctypes.get_last_error())
    return WindowsJobError(f"{operation} failed: {error}")
