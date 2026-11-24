"""Named mutex with an explicit security descriptor, for the ServiceHub singleton.

A mutex created with default security can be pre-created by any process in the
same logon session (including a low-integrity one), which then disrupts the
single-instance check. This module creates the mutex with an owner-only DACL
and a medium mandatory label, and when the name already exists it only accepts
the object if its owner, DACL and integrity label match what we would have
created, or if it is the default-security mutex of a still-running Hub from
before this hardening (a one-time upgrade case). Anything else raises
``SingletonUnavailableError`` instead of letting the caller assume it is the
first instance.
"""

from __future__ import annotations

import re
import sys
from typing import Any

from servicehub.owner_only_acl import current_user_sid

_ERROR_ALREADY_EXISTS = 183
_MUTEX_ALL_ACCESS = 0x1F0001
_SDDL_REVISION_1 = 1
_SE_KERNEL_OBJECT = 6
_OWNER_DACL_LABEL_SECURITY_INFORMATION = 0x1 | 0x4 | 0x10


class SingletonUnavailableError(OSError):
    """The singleton mutex cannot be created or trusted; startup must not continue."""


def _without_auto_inherit_flags(sddl: str) -> str:
    """Drop the ``AI``/``AR`` ACL flags, which Windows adds on its own when storing the SACL."""
    return re.sub(r"(?<=[DS]:)(P?)(?:AI|AR)+", r"\1", sddl)


def _mutex_sddl(sid: str) -> str:
    return (
        f"O:{sid}D:P(A;;0x{_MUTEX_ALL_ACCESS:X};;;{sid})"
        f"(A;;0x{_MUTEX_ALL_ACCESS:X};;;SY)S:(ML;;NW;;;ME)"
    )


class _Api:
    """Lazy ctypes bindings; only constructed on Windows."""

    def __init__(self) -> None:
        import ctypes
        from ctypes import wintypes

        class SecurityAttributes(ctypes.Structure):
            _fields_ = [
                ("nLength", wintypes.DWORD),
                ("lpSecurityDescriptor", wintypes.LPVOID),
                ("bInheritHandle", wintypes.BOOL),
            ]

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)

        kernel32.CreateMutexW.argtypes = [
            ctypes.POINTER(SecurityAttributes),
            wintypes.BOOL,
            wintypes.LPCWSTR,
        ]
        kernel32.CreateMutexW.restype = wintypes.HANDLE
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel32.CloseHandle.restype = wintypes.BOOL
        kernel32.LocalFree.argtypes = [wintypes.HLOCAL]
        kernel32.LocalFree.restype = wintypes.HLOCAL

        advapi32.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = [
            wintypes.LPCWSTR,
            wintypes.DWORD,
            ctypes.POINTER(wintypes.LPVOID),
            ctypes.POINTER(wintypes.ULONG),
        ]
        advapi32.ConvertStringSecurityDescriptorToSecurityDescriptorW.restype = wintypes.BOOL
        advapi32.ConvertSecurityDescriptorToStringSecurityDescriptorW.argtypes = [
            wintypes.LPVOID,
            wintypes.DWORD,
            wintypes.DWORD,
            ctypes.POINTER(wintypes.LPWSTR),
            ctypes.POINTER(wintypes.ULONG),
        ]
        advapi32.ConvertSecurityDescriptorToStringSecurityDescriptorW.restype = wintypes.BOOL
        advapi32.GetSecurityInfo.argtypes = [
            wintypes.HANDLE,
            ctypes.c_int,
            wintypes.DWORD,
            wintypes.LPVOID,
            wintypes.LPVOID,
            wintypes.LPVOID,
            wintypes.LPVOID,
            ctypes.POINTER(wintypes.LPVOID),
        ]
        advapi32.GetSecurityInfo.restype = wintypes.DWORD

        self.ctypes = ctypes
        self.wintypes = wintypes
        self.SecurityAttributes = SecurityAttributes
        self.kernel32 = kernel32
        self.advapi32 = advapi32

    def error(self, what: str, code: int | None = None) -> SingletonUnavailableError:
        if code is None:
            code = self.ctypes.get_last_error()
        return SingletonUnavailableError(
            0, f"{what} failed: {self.ctypes.FormatError(code)}", None, code
        )

    def descriptor_from_sddl(self, sddl: str) -> Any:
        """Return a LocalAlloc'd security descriptor; the caller frees it."""
        descriptor = self.wintypes.LPVOID()
        if not self.advapi32.ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl, _SDDL_REVISION_1, self.ctypes.byref(descriptor), None
        ):
            raise self.error("ConvertStringSecurityDescriptorToSecurityDescriptorW")
        return descriptor

    def sddl_of(self, descriptor: Any) -> str:
        text = self.wintypes.LPWSTR()
        if not self.advapi32.ConvertSecurityDescriptorToStringSecurityDescriptorW(
            descriptor,
            _SDDL_REVISION_1,
            _OWNER_DACL_LABEL_SECURITY_INFORMATION,
            self.ctypes.byref(text),
            None,
        ):
            raise self.error("ConvertSecurityDescriptorToStringSecurityDescriptorW")
        try:
            return str(text.value)
        finally:
            self.kernel32.LocalFree(text)

    def canonical(self, sddl: str) -> str:
        """Round-trip ``sddl`` through Windows so it compares against a read-back descriptor."""
        descriptor = self.descriptor_from_sddl(sddl)
        try:
            return self.sddl_of(descriptor)
        finally:
            self.kernel32.LocalFree(descriptor)

    def object_sddl(self, handle: int) -> str:
        descriptor = self.wintypes.LPVOID()
        status = self.advapi32.GetSecurityInfo(
            handle,
            _SE_KERNEL_OBJECT,
            _OWNER_DACL_LABEL_SECURITY_INFORMATION,
            None,
            None,
            None,
            None,
            self.ctypes.byref(descriptor),
        )
        if status != 0:
            raise self.error("GetSecurityInfo", status)
        try:
            return self.sddl_of(descriptor)
        finally:
            self.kernel32.LocalFree(descriptor)


_api: _Api | None = None


def _get_api() -> _Api:
    global _api
    if _api is None:
        _api = _Api()
    return _api


def _is_legacy_default_descriptor(actual: str, user: str) -> bool:
    """Whether ``actual`` is the default-security mutex a Hub from before this hardening created.

    Such a Hub can outlive an upgrade (keepBackendOnExit) and holds the mutex with
    default security: owned by the current user, an unprotected DACL granting only the
    user, SYSTEM and the logon session SID, and no integrity label. A process below
    medium integrity always gets a Low label on objects it creates, even with an
    explicit descriptor, so the absent label means the creator was not a Low-IL squatter.
    """
    prefix = f"O:{user}D:"
    if not actual.startswith(prefix):
        return False
    aces = re.fullmatch(r"(?:\(A;;0x1f0001;;;[^;()]+\)){3}", actual[len(prefix) :])
    if aces is None:
        return False
    trustees = re.findall(r"\(A;;0x1f0001;;;([^;()]+)\)", actual)
    logon = [t for t in trustees if re.fullmatch(r"S-1-5-5-\d+-\d+", t)]
    return len(logon) == 1 and sorted(t for t in trustees if t not in logon) == sorted([user, "SY"])


def create_hardened_mutex(name: str) -> tuple[int, bool]:
    """Create or open the named mutex; return ``(handle, already_exists)``.

    A new mutex gets the owner-only descriptor. An existing one is accepted
    only if its owner, DACL and integrity label equal that descriptor, or if it
    is the default-security mutex of a still-running pre-hardening Hub.
    Raises ``SingletonUnavailableError`` if creation fails (access denied,
    name-type conflict, ...) or the existing object is not ours.
    """
    if sys.platform != "win32":
        raise SingletonUnavailableError("named mutexes are only available on Windows")
    api = _get_api()
    sid = current_user_sid()
    sddl = _mutex_sddl(sid)
    descriptor = api.descriptor_from_sddl(sddl)
    try:
        attributes = api.SecurityAttributes(
            api.ctypes.sizeof(api.SecurityAttributes), descriptor, False
        )
        handle = api.kernel32.CreateMutexW(api.ctypes.byref(attributes), False, name)
        last_error = api.ctypes.get_last_error()
    finally:
        api.kernel32.LocalFree(descriptor)
    if not handle:
        raise api.error(f"CreateMutexW({name})", last_error)
    if last_error != _ERROR_ALREADY_EXISTS:
        return int(handle), False

    try:
        actual = _without_auto_inherit_flags(api.object_sddl(handle))
        expected = _without_auto_inherit_flags(api.canonical(sddl))
        if actual != expected:
            user = re.fullmatch(r"O:(.+)D:", api.canonical(f"O:{sid}D:"))
            if user is None or not _is_legacy_default_descriptor(actual, user.group(1)):
                raise SingletonUnavailableError(
                    f"existing mutex {name} has an unexpected owner/DACL/integrity label: {actual}"
                )
    except BaseException:
        api.kernel32.CloseHandle(handle)
        raise
    return int(handle), True


def close_handle(handle: int) -> None:
    if sys.platform == "win32":
        _get_api().kernel32.CloseHandle(handle)
