"""Whether the user's session is locked: a host tool call while it is gets refused.

This follows Codex's ``allow_locked_computer_use = false``: nobody is watching a locked screen, so
nobody can see what a computer-use tool does. Read through ``WTSQuerySessionInformationW`` with
``WTSSessionInfoEx``. Only an explicit "unlocked" answer counts as unlocked; a failed query or an
unknown state is treated as locked, and logged once.
"""

from __future__ import annotations

import ctypes
import sys
import threading

from loguru import logger

_WTS_CURRENT_SERVER_HANDLE = 0
_WTS_CURRENT_SESSION = 0xFFFFFFFF
_WTS_SESSION_INFO_EX = 25
_WTS_SESSIONSTATE_UNLOCK = 0x1
_WINSTATIONNAME_LENGTH = 32
_USERNAME_LENGTH = 20
_DOMAIN_LENGTH = 17

_logged = threading.Event()


if sys.platform == "win32":
    from ctypes import wintypes

    class _WtsInfoExLevel1(ctypes.Structure):
        _fields_ = [
            ("SessionId", wintypes.ULONG),
            ("SessionState", ctypes.c_int),
            ("SessionFlags", wintypes.LONG),
            ("WinStationName", wintypes.WCHAR * (_WINSTATIONNAME_LENGTH + 1)),
            ("UserName", wintypes.WCHAR * (_USERNAME_LENGTH + 1)),
            ("DomainName", wintypes.WCHAR * (_DOMAIN_LENGTH + 1)),
            ("LogonTime", ctypes.c_int64),
            ("ConnectTime", ctypes.c_int64),
            ("DisconnectTime", ctypes.c_int64),
            ("LastInputTime", ctypes.c_int64),
            ("CurrentTime", ctypes.c_int64),
            ("IncomingBytes", wintypes.DWORD),
            ("OutgoingBytes", wintypes.DWORD),
            ("IncomingFrames", wintypes.DWORD),
            ("OutgoingFrames", wintypes.DWORD),
            ("IncomingCompressedBytes", wintypes.DWORD),
            ("OutgoingCompressedBytes", wintypes.DWORD),
        ]

    class _WtsInfoEx(ctypes.Structure):
        _fields_ = [("Level", wintypes.DWORD), ("Data", _WtsInfoExLevel1)]

    _wtsapi32 = ctypes.WinDLL("wtsapi32", use_last_error=True)
    _wtsapi32.WTSQuerySessionInformationW.argtypes = [
        wintypes.HANDLE,
        wintypes.DWORD,
        ctypes.c_int,
        ctypes.POINTER(ctypes.c_void_p),
        ctypes.POINTER(wintypes.DWORD),
    ]
    _wtsapi32.WTSQuerySessionInformationW.restype = wintypes.BOOL
    _wtsapi32.WTSFreeMemory.argtypes = [ctypes.c_void_p]
    _wtsapi32.WTSFreeMemory.restype = None


def _fail_closed(reason: str) -> bool:
    if not _logged.is_set():
        _logged.set()
        logger.warning("session lock state unknown; host tool calls are refused as locked reason={}", reason)
    return True


def is_session_locked() -> bool:
    if sys.platform != "win32":
        return False
    buffer = ctypes.c_void_p()
    returned = wintypes.DWORD()
    if not _wtsapi32.WTSQuerySessionInformationW(
        _WTS_CURRENT_SERVER_HANDLE,
        _WTS_CURRENT_SESSION,
        _WTS_SESSION_INFO_EX,
        ctypes.byref(buffer),
        ctypes.byref(returned),
    ):
        return _fail_closed(f"WTSQuerySessionInformationW error={ctypes.get_last_error()}")
    try:
        if not buffer.value or returned.value < ctypes.sizeof(_WtsInfoEx):
            return _fail_closed("short WTSSessionInfoEx answer")
        info = _WtsInfoEx.from_address(buffer.value)
        if info.Level != 1:
            return _fail_closed(f"WTSSessionInfoEx level={info.Level}")
        if info.Data.SessionFlags == _WTS_SESSIONSTATE_UNLOCK:
            return False
        if info.Data.SessionFlags != 0:
            return _fail_closed(f"session flags={info.Data.SessionFlags}")
        return True
    finally:
        _wtsapi32.WTSFreeMemory(buffer)
