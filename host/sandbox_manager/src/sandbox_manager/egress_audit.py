"""Append-only JSONL audit for the network_connector tier's egress processes (design 6.2, 6.4).

The Connector and the egress proxy each append one line per request to a fixed file in the tier's own log
directory. The file is opened the way the tier runner opens a role log (`role_log.rs`): append-only,
sharing read and delete so the owner can read a live file and rotate it. Never `open(path, "a")`, which
asks for `GENERIC_WRITE`: the shipped log policy grants a tier only append, read-attributes and
synchronize on a file in its log directory (`LOG_FILE_RIGHTS`), so a restarted process reopening the
file an earlier launch created would be refused.

Tier self-report, not evidence: the tier creates the file, so the tier owns it. Standard library only:
it ships in the Connector's payload.
"""

from __future__ import annotations

import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import threading
from typing import Any

_FILE_APPEND_DATA = 0x0004
_SYNCHRONIZE = 0x00100000
_FILE_SHARE_READ = 0x0001
_FILE_SHARE_DELETE = 0x0004
_OPEN_ALWAYS = 4
_FILE_ATTRIBUTE_NORMAL = 0x80
_FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000
_INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value


class AuditLog:
    """One append-only JSONL file; each `write` is one whole line."""

    def __init__(self, path: Path) -> None:
        self._lock = threading.Lock()
        if os.name == "nt":
            self._kernel32 = _kernel32()
            handle = self._kernel32.CreateFileW(
                str(path),
                _FILE_APPEND_DATA | _SYNCHRONIZE,
                _FILE_SHARE_READ | _FILE_SHARE_DELETE,
                None,
                _OPEN_ALWAYS,
                _FILE_ATTRIBUTE_NORMAL | _FILE_FLAG_OPEN_REPARSE_POINT,
                None,
            )
            if handle in (None, _INVALID_HANDLE_VALUE):
                raise ctypes.WinError(ctypes.get_last_error())  # type: ignore[attr-defined]
            self._handle: int | None = handle
        else:
            self._handle = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)

    def write(self, record: dict[str, Any]) -> None:
        line = json.dumps(record, sort_keys=True, separators=(",", ":")).encode() + b"\n"
        with self._lock:
            if self._handle is None:
                raise OSError("the audit log is closed")
            if os.name != "nt":
                os.write(self._handle, line)
                return
            written = wintypes.DWORD()
            if not self._kernel32.WriteFile(self._handle, line, len(line), ctypes.byref(written), None):
                raise ctypes.WinError(ctypes.get_last_error())  # type: ignore[attr-defined]
            if written.value != len(line):
                raise OSError("the audit log took a partial line")

    def close(self) -> None:
        with self._lock:
            handle, self._handle = self._handle, None
            if handle is None:
                return
            if os.name == "nt":
                self._kernel32.CloseHandle(handle)
            else:
                os.close(handle)


def _kernel32() -> Any:
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)  # type: ignore[attr-defined]
    kernel32.CreateFileW.restype = wintypes.HANDLE
    kernel32.CreateFileW.argtypes = [
        wintypes.LPCWSTR,
        wintypes.DWORD,
        wintypes.DWORD,
        ctypes.c_void_p,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.HANDLE,
    ]
    kernel32.WriteFile.restype = wintypes.BOOL
    kernel32.WriteFile.argtypes = [
        wintypes.HANDLE,
        ctypes.c_char_p,
        wintypes.DWORD,
        ctypes.POINTER(wintypes.DWORD),
        ctypes.c_void_p,
    ]
    kernel32.CloseHandle.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    return kernel32
