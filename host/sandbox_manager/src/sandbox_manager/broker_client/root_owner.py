"""Gives an owner-owned backend root back to the token user when an elevated run left it owned by another principal.

An elevated administrator token creates objects owned by ``Administrators``, and the broker authorizes an
owner-owned root only when the requester owns it, so one elevated launch used to strand every later one
(#3176). Naming one's own token user as owner needs only ``WRITE_OWNER``, which the inherited
``%LOCALAPPDATA%`` DACL already grants. The repair is skipped under a deliberately elevated split token,
so it confers nothing beyond what the user's own unelevated token could do. The broker still re-reads the
owner on its own handle.
"""

from __future__ import annotations

import ctypes
import os
from pathlib import Path

from loguru import logger

_READ_CONTROL = 0x00020000
_WRITE_OWNER = 0x00080000
_FILE_SHARE_ALL = 0x00000007
_OPEN_EXISTING = 3
# A junction is re-owned as itself, never as whatever it points at; the broker refuses it afterwards.
_OPEN_FLAGS = 0x02000000 | 0x00200000  # FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT
_INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value
_TOKEN_QUERY = 0x0008
_TOKEN_USER = 1
_TOKEN_ELEVATION_TYPE = 18
_TOKEN_ELEVATION_TYPE_FULL = 2
_ERROR_INSUFFICIENT_BUFFER = 122
# What a size probe of a fixed-size class such as TokenElevationType reports instead.
_ERROR_BAD_LENGTH = 24
_SE_FILE_OBJECT = 1
_OWNER_SECURITY_INFORMATION = 0x00000001


class _Win32:
    def __init__(self) -> None:
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)  # type: ignore[attr-defined]
        advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)  # type: ignore[attr-defined]
        pvoid = ctypes.c_void_p
        ppvoid = ctypes.POINTER(ctypes.c_void_p)

        self.GetCurrentProcess = kernel32.GetCurrentProcess
        self.GetCurrentProcess.restype = pvoid
        self.GetCurrentProcess.argtypes = ()
        self.CreateFileW = kernel32.CreateFileW
        self.CreateFileW.restype = pvoid
        self.CreateFileW.argtypes = (
            ctypes.c_wchar_p,
            ctypes.c_uint32,
            ctypes.c_uint32,
            pvoid,
            ctypes.c_uint32,
            ctypes.c_uint32,
            pvoid,
        )
        self.CloseHandle = kernel32.CloseHandle
        self.CloseHandle.restype = ctypes.c_int32
        self.CloseHandle.argtypes = (pvoid,)
        self.LocalFree = kernel32.LocalFree
        self.LocalFree.restype = pvoid
        self.LocalFree.argtypes = (pvoid,)
        self.OpenProcessToken = advapi32.OpenProcessToken
        self.OpenProcessToken.restype = ctypes.c_int32
        self.OpenProcessToken.argtypes = (pvoid, ctypes.c_uint32, ppvoid)
        self.GetTokenInformation = advapi32.GetTokenInformation
        self.GetTokenInformation.restype = ctypes.c_int32
        self.GetTokenInformation.argtypes = (
            pvoid,
            ctypes.c_int32,
            pvoid,
            ctypes.c_uint32,
            ctypes.POINTER(ctypes.c_uint32),
        )
        self.GetSecurityInfo = advapi32.GetSecurityInfo
        self.GetSecurityInfo.restype = ctypes.c_uint32
        self.GetSecurityInfo.argtypes = (
            pvoid,
            ctypes.c_int32,
            ctypes.c_uint32,
            ppvoid,
            ppvoid,
            ppvoid,
            ppvoid,
            ppvoid,
        )
        self.SetSecurityInfo = advapi32.SetSecurityInfo
        self.SetSecurityInfo.restype = ctypes.c_uint32
        self.SetSecurityInfo.argtypes = (
            pvoid,
            ctypes.c_int32,
            ctypes.c_uint32,
            pvoid,
            pvoid,
            pvoid,
            pvoid,
        )
        self.EqualSid = advapi32.EqualSid
        self.EqualSid.restype = ctypes.c_int32
        self.EqualSid.argtypes = (pvoid, pvoid)
        self.ConvertSidToStringSidW = advapi32.ConvertSidToStringSidW
        self.ConvertSidToStringSidW.restype = ctypes.c_int32
        self.ConvertSidToStringSidW.argtypes = (pvoid, ppvoid)


_WIN32: _Win32 | None = None


def _win32() -> _Win32:
    global _WIN32
    if _WIN32 is None:
        _WIN32 = _Win32()
    return _WIN32


def take_back_ownership(path: Path) -> str | None:
    """Makes the current token user own ``path``.

    Returns the previous owner's SID when the owner was changed, or ``None`` when the token user already
    owned it, when the process runs under a deliberately elevated split token, and always off Windows.
    Raises ``OSError`` when the owner is foreign and cannot be changed.
    """
    if os.name != "nt":
        return None
    win32 = _win32()
    if _elevated_split_token(win32):
        # This token can reach more than the user's normal one; the next normal launch repairs instead.
        logger.info("native-provision: phase=owner_repair event=skipped reason=elevated_token path={}", path)
        return None
    token_user = _token_information(win32, _TOKEN_USER)
    user_sid = ctypes.c_void_p.from_buffer(token_user).value

    handle = _open(win32, path, _READ_CONTROL)
    try:
        owner = ctypes.c_void_p()
        descriptor = ctypes.c_void_p()
        status = win32.GetSecurityInfo(
            handle,
            _SE_FILE_OBJECT,
            _OWNER_SECURITY_INFORMATION,
            ctypes.byref(owner),
            None,
            None,
            None,
            ctypes.byref(descriptor),
        )
        if status != 0:
            raise ctypes.WinError(status)  # type: ignore[attr-defined]
        try:
            if win32.EqualSid(owner, user_sid):
                return None
            previous = _sid_string(win32, owner)
        finally:
            win32.LocalFree(descriptor)
    finally:
        win32.CloseHandle(handle)

    # WRITE_OWNER only when a repair is needed, so a correctly owned folder never needs that right.
    handle = _open(win32, path, _WRITE_OWNER)
    try:
        status = win32.SetSecurityInfo(
            handle, _SE_FILE_OBJECT, _OWNER_SECURITY_INFORMATION, user_sid, None, None, None
        )
        if status != 0:
            raise ctypes.WinError(status)  # type: ignore[attr-defined]
    finally:
        win32.CloseHandle(handle)
    return previous


def token_user_sid() -> str:
    """The SID string of this process token's user. Raises ``OSError`` when the token cannot be read."""
    win32 = _win32()
    token_user = _token_information(win32, _TOKEN_USER)
    user_sid = ctypes.c_void_p.from_buffer(token_user).value
    text = ctypes.c_void_p()
    if not win32.ConvertSidToStringSidW(user_sid, ctypes.byref(text)):
        raise ctypes.WinError(ctypes.get_last_error())  # type: ignore[attr-defined]
    try:
        return ctypes.wstring_at(text.value)
    finally:
        win32.LocalFree(text)


def _elevated_split_token(win32: _Win32) -> bool:
    """An admin token the user chose to elevate. With UAC off (``Default``) there is no weaker token to protect."""
    elevation_type = _token_information(win32, _TOKEN_ELEVATION_TYPE)
    return ctypes.c_int32.from_buffer(elevation_type).value == _TOKEN_ELEVATION_TYPE_FULL


def _token_information(win32: _Win32, info_class: int) -> ctypes.Array[ctypes.c_char]:
    """One class of the process token's information; for ``TOKEN_USER`` the SID pointer is valid while this lives."""
    token = ctypes.c_void_p()
    if not win32.OpenProcessToken(win32.GetCurrentProcess(), _TOKEN_QUERY, ctypes.byref(token)):
        raise ctypes.WinError(ctypes.get_last_error())  # type: ignore[attr-defined]
    try:
        size = ctypes.c_uint32()
        win32.GetTokenInformation(token, info_class, None, 0, ctypes.byref(size))
        if ctypes.get_last_error() not in (_ERROR_INSUFFICIENT_BUFFER, _ERROR_BAD_LENGTH):
            raise ctypes.WinError(ctypes.get_last_error())  # type: ignore[attr-defined]
        buffer = ctypes.create_string_buffer(size.value)
        if not win32.GetTokenInformation(token, info_class, buffer, size, ctypes.byref(size)):
            raise ctypes.WinError(ctypes.get_last_error())  # type: ignore[attr-defined]
        return buffer
    finally:
        win32.CloseHandle(token)


def _open(win32: _Win32, path: Path, access: int) -> int:
    handle = win32.CreateFileW(
        str(path), access, _FILE_SHARE_ALL, None, _OPEN_EXISTING, _OPEN_FLAGS, None
    )
    if handle is None or handle == _INVALID_HANDLE_VALUE:
        raise ctypes.WinError(ctypes.get_last_error())  # type: ignore[attr-defined]
    return handle


def _sid_string(win32: _Win32, sid: ctypes.c_void_p) -> str:
    text = ctypes.c_void_p()
    if not win32.ConvertSidToStringSidW(sid, ctypes.byref(text)):
        return "an owner this side could not name"
    try:
        return ctypes.wstring_at(text.value)
    finally:
        win32.LocalFree(text)
