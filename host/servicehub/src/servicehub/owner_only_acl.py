"""Owner-only Windows DACLs for ServiceHub state that carries the Hub token.

The grant is the process token's user plus ``SYSTEM``, protected from
inheritance, so the file's readers do not depend on whatever ACL the parent
directory happens to carry. Elsewhere only the POSIX file mode is set; the
product ships on Windows.
"""

from __future__ import annotations

import os
import stat
import sys
from pathlib import Path
from typing import BinaryIO

from loguru import logger

_DIRECTORY_ACE_FLAGS = "OICI"
_FILE_ACE_FLAGS = ""


class AclUnsupportedError(OSError):
    """The volume stores no ACLs, so a secret written there cannot be protected."""


def restrict_directory_to_owner(path: Path) -> bool:
    """Give ``path`` a protected owner-only DACL; return whether it changed.

    Already-converged directories are left untouched, because rewriting a
    directory DACL re-propagates inheritance through every existing child.
    Only the directory's own DACL is verified: propagation to existing
    children is best-effort, and a child with explicit ACEs keeps them.
    A ``path`` that is itself a junction or symlink is left alone, so a
    redirected data dir never rewrites the DACLs of the tree it points at.

    Raises ``AclUnsupportedError`` on a volume without ACLs, and ``OSError``
    if the DACL cannot be applied or does not read back.
    """
    if sys.platform != "win32":
        return False
    if os.lstat(path).st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT:
        logger.warning(
            "servicehub data dir is a reparse point; leaving its DACL unchanged path={}", path
        )
        return False
    return _win32.restrict_directory(path, _owner_only_sddl(_DIRECTORY_ACE_FLAGS))


def create_owner_only_file(path: Path) -> BinaryIO:
    """Create ``path`` (which must not exist) with an owner-only DACL and open it for writing.

    The descriptor is attached at creation, so there is no moment where the
    file carries an inherited ACL. Raises ``AclUnsupportedError`` (and removes
    the file) if the volume cannot store the DACL.
    """
    if sys.platform != "win32":
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        return os.fdopen(fd, "wb")
    return _win32.create_file(path, _owner_only_sddl(_FILE_ACE_FLAGS))


def read_dacl_sddl(path: Path) -> str:
    """Return the DACL of ``path`` as SDDL (Windows only)."""
    return _win32.read_dacl_sddl(path)


def current_user_sid() -> str:
    """Return the string SID of the process token's user (Windows only)."""
    return _win32.current_user_sid()


def _owner_only_sddl(ace_flags: str) -> str:
    sid = _win32.current_user_sid()
    return f"D:P(A;{ace_flags};FA;;;{sid})(A;{ace_flags};FA;;;SY)"


class _Win32:
    """Lazy ctypes bindings; only touched on Windows."""

    _SDDL_REVISION_1 = 1
    _DACL_SECURITY_INFORMATION = 0x00000004
    _PROTECTED_DACL_SECURITY_INFORMATION = 0x80000000
    _SE_FILE_OBJECT = 1
    _TOKEN_QUERY = 0x0008
    _TOKEN_USER = 1
    _ERROR_INSUFFICIENT_BUFFER = 122
    _READ_CONTROL = 0x00020000
    _WRITE_DAC = 0x00040000
    _GENERIC_WRITE = 0x40000000
    _FILE_SHARE_ALL = 0x00000007
    _CREATE_NEW = 1
    _OPEN_EXISTING = 3
    _FILE_ATTRIBUTE_NORMAL = 0x00000080
    _FILE_FLAG_BACKUP_SEMANTICS = 0x02000000
    _FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000
    _FILE_PERSISTENT_ACLS = 0x00000008

    def __init__(self) -> None:
        self._loaded = False
        self._sid: str | None = None

    def _load(self) -> None:
        if self._loaded:
            return
        import ctypes
        from ctypes import wintypes

        class SecurityAttributes(ctypes.Structure):
            _fields_ = [
                ("nLength", wintypes.DWORD),
                ("lpSecurityDescriptor", wintypes.LPVOID),
                ("bInheritHandle", wintypes.BOOL),
            ]

        advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

        kernel32.GetCurrentProcess.argtypes = []
        kernel32.GetCurrentProcess.restype = wintypes.HANDLE
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel32.CloseHandle.restype = wintypes.BOOL
        kernel32.LocalFree.argtypes = [wintypes.HLOCAL]
        kernel32.LocalFree.restype = wintypes.HLOCAL
        kernel32.CreateFileW.argtypes = [
            wintypes.LPCWSTR,
            wintypes.DWORD,
            wintypes.DWORD,
            ctypes.POINTER(SecurityAttributes),
            wintypes.DWORD,
            wintypes.DWORD,
            wintypes.HANDLE,
        ]
        kernel32.CreateFileW.restype = wintypes.HANDLE
        kernel32.GetVolumeInformationByHandleW.argtypes = [
            wintypes.HANDLE,
            wintypes.LPWSTR,
            wintypes.DWORD,
            ctypes.POINTER(wintypes.DWORD),
            ctypes.POINTER(wintypes.DWORD),
            ctypes.POINTER(wintypes.DWORD),
            wintypes.LPWSTR,
            wintypes.DWORD,
        ]
        kernel32.GetVolumeInformationByHandleW.restype = wintypes.BOOL

        advapi32.OpenProcessToken.argtypes = [
            wintypes.HANDLE,
            wintypes.DWORD,
            ctypes.POINTER(wintypes.HANDLE),
        ]
        advapi32.OpenProcessToken.restype = wintypes.BOOL
        advapi32.GetTokenInformation.argtypes = [
            wintypes.HANDLE,
            ctypes.c_int,
            wintypes.LPVOID,
            wintypes.DWORD,
            ctypes.POINTER(wintypes.DWORD),
        ]
        advapi32.GetTokenInformation.restype = wintypes.BOOL
        advapi32.ConvertSidToStringSidW.argtypes = [
            wintypes.LPVOID,
            ctypes.POINTER(wintypes.LPWSTR),
        ]
        advapi32.ConvertSidToStringSidW.restype = wintypes.BOOL
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
        advapi32.GetSecurityDescriptorDacl.argtypes = [
            wintypes.LPVOID,
            ctypes.POINTER(wintypes.BOOL),
            ctypes.POINTER(wintypes.LPVOID),
            ctypes.POINTER(wintypes.BOOL),
        ]
        advapi32.GetSecurityDescriptorDacl.restype = wintypes.BOOL
        advapi32.GetSecurityInfo.argtypes = [
            wintypes.HANDLE,
            ctypes.c_int,
            wintypes.DWORD,
            wintypes.LPVOID,
            wintypes.LPVOID,
            ctypes.POINTER(wintypes.LPVOID),
            wintypes.LPVOID,
            ctypes.POINTER(wintypes.LPVOID),
        ]
        advapi32.GetSecurityInfo.restype = wintypes.DWORD
        advapi32.SetSecurityInfo.argtypes = [
            wintypes.HANDLE,
            ctypes.c_int,
            wintypes.DWORD,
            wintypes.LPVOID,
            wintypes.LPVOID,
            wintypes.LPVOID,
            wintypes.LPVOID,
        ]
        advapi32.SetSecurityInfo.restype = wintypes.DWORD

        self._ctypes = ctypes
        self._wintypes = wintypes
        self._SecurityAttributes = SecurityAttributes
        self._advapi32 = advapi32
        self._kernel32 = kernel32
        self._invalid_handle = wintypes.HANDLE(-1).value
        self._loaded = True

    def _last_error(self, what: str) -> OSError:
        code = self._ctypes.get_last_error()
        return OSError(0, f"{what} failed: {self._ctypes.FormatError(code)}", None, code)

    def _status_error(self, what: str, code: int) -> OSError:
        return OSError(0, f"{what} failed: {self._ctypes.FormatError(code)}", None, code)

    def _require_persistent_acls(self, handle: int, path: Path) -> None:
        flags = self._wintypes.DWORD()
        if not self._kernel32.GetVolumeInformationByHandleW(
            handle, None, 0, None, None, self._ctypes.byref(flags), None, 0
        ):
            raise self._last_error(f"GetVolumeInformationByHandleW({path})")
        if not flags.value & self._FILE_PERSISTENT_ACLS:
            raise AclUnsupportedError(
                f"{path} is on a volume without ACLs; the ServiceHub token cannot be protected there"
            )

    def current_user_sid(self) -> str:
        if self._sid is None:
            self._sid = self._query_current_user_sid()
        return self._sid

    def _query_current_user_sid(self) -> str:
        self._load()
        ctypes, wintypes = self._ctypes, self._wintypes
        token = wintypes.HANDLE()
        if not self._advapi32.OpenProcessToken(
            self._kernel32.GetCurrentProcess(), self._TOKEN_QUERY, ctypes.byref(token)
        ):
            raise self._last_error("OpenProcessToken")
        try:
            size = wintypes.DWORD()
            self._advapi32.GetTokenInformation(token, self._TOKEN_USER, None, 0, ctypes.byref(size))
            if ctypes.get_last_error() != self._ERROR_INSUFFICIENT_BUFFER:
                raise self._last_error("GetTokenInformation")
            buffer = ctypes.create_string_buffer(size.value)
            if not self._advapi32.GetTokenInformation(
                token, self._TOKEN_USER, buffer, size, ctypes.byref(size)
            ):
                raise self._last_error("GetTokenInformation")
        finally:
            self._kernel32.CloseHandle(token)
        # TOKEN_USER begins with SID_AND_ATTRIBUTES, whose first field is the PSID.
        sid_pointer = ctypes.cast(buffer, ctypes.POINTER(wintypes.LPVOID))[0]
        text = wintypes.LPWSTR()
        if not self._advapi32.ConvertSidToStringSidW(sid_pointer, ctypes.byref(text)):
            raise self._last_error("ConvertSidToStringSidW")
        try:
            return str(text.value)
        finally:
            self._kernel32.LocalFree(text)

    def _descriptor_from_sddl(self, sddl: str) -> int:
        """Return a LocalAlloc'd self-relative security descriptor; the caller frees it."""
        descriptor = self._wintypes.LPVOID()
        if not self._advapi32.ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl, self._SDDL_REVISION_1, self._ctypes.byref(descriptor), None
        ):
            raise self._last_error("ConvertStringSecurityDescriptorToSecurityDescriptorW")
        return int(descriptor.value or 0)

    def _dacl_sddl_of(self, descriptor: int) -> str:
        text = self._wintypes.LPWSTR()
        if not self._advapi32.ConvertSecurityDescriptorToStringSecurityDescriptorW(
            descriptor,
            self._SDDL_REVISION_1,
            self._DACL_SECURITY_INFORMATION,
            self._ctypes.byref(text),
            None,
        ):
            raise self._last_error("ConvertSecurityDescriptorToStringSecurityDescriptorW")
        try:
            return str(text.value)
        finally:
            self._kernel32.LocalFree(text)

    def _canonical(self, sddl: str) -> str:
        """Round-trip ``sddl`` through Windows so it compares against a read-back DACL."""
        descriptor = self._descriptor_from_sddl(sddl)
        try:
            return self._dacl_sddl_of(descriptor)
        finally:
            self._kernel32.LocalFree(descriptor)

    def _open(self, path: Path, access: int, flags: int = 0) -> int:
        handle = self._kernel32.CreateFileW(
            str(path),
            access,
            self._FILE_SHARE_ALL,
            None,
            self._OPEN_EXISTING,
            self._FILE_FLAG_BACKUP_SEMANTICS | flags,
            None,
        )
        if handle is None or handle == self._invalid_handle:
            raise self._last_error(f"CreateFileW({path})")
        return int(handle)

    def _read_dacl_sddl(self, handle: int) -> str:
        descriptor = self._wintypes.LPVOID()
        dacl = self._wintypes.LPVOID()
        status = self._advapi32.GetSecurityInfo(
            handle,
            self._SE_FILE_OBJECT,
            self._DACL_SECURITY_INFORMATION,
            None,
            None,
            self._ctypes.byref(dacl),
            None,
            self._ctypes.byref(descriptor),
        )
        if status != 0:
            raise self._status_error("GetSecurityInfo", status)
        try:
            return self._dacl_sddl_of(int(descriptor.value or 0))
        finally:
            self._kernel32.LocalFree(descriptor)

    def read_dacl_sddl(self, path: Path) -> str:
        self._load()
        handle = self._open(path, self._READ_CONTROL)
        try:
            return self._read_dacl_sddl(handle)
        finally:
            self._kernel32.CloseHandle(handle)

    def restrict_directory(self, path: Path, sddl: str) -> bool:
        self._load()
        expected = _without_auto_inherit_flags(self._canonical(sddl))
        handle = self._open(
            path, self._READ_CONTROL | self._WRITE_DAC, self._FILE_FLAG_OPEN_REPARSE_POINT
        )
        try:
            self._require_persistent_acls(handle, path)
            if _without_auto_inherit_flags(self._read_dacl_sddl(handle)) == expected:
                return False
            descriptor = self._descriptor_from_sddl(sddl)
            try:
                present = self._wintypes.BOOL()
                defaulted = self._wintypes.BOOL()
                dacl = self._wintypes.LPVOID()
                if not self._advapi32.GetSecurityDescriptorDacl(
                    descriptor,
                    self._ctypes.byref(present),
                    self._ctypes.byref(dacl),
                    self._ctypes.byref(defaulted),
                ):
                    raise self._last_error("GetSecurityDescriptorDacl")
                status = self._advapi32.SetSecurityInfo(
                    handle,
                    self._SE_FILE_OBJECT,
                    self._DACL_SECURITY_INFORMATION | self._PROTECTED_DACL_SECURITY_INFORMATION,
                    None,
                    None,
                    dacl,
                    None,
                )
                if status != 0:
                    raise self._status_error(f"SetSecurityInfo({path})", status)
            finally:
                self._kernel32.LocalFree(descriptor)
            actual = _without_auto_inherit_flags(self._read_dacl_sddl(handle))
            if actual != expected:
                raise OSError(f"owner-only DACL did not read back on {path}: {actual}")
            return True
        finally:
            self._kernel32.CloseHandle(handle)

    def create_file(self, path: Path, sddl: str) -> BinaryIO:
        self._load()
        import msvcrt

        descriptor = self._descriptor_from_sddl(sddl)
        try:
            attributes = self._SecurityAttributes(
                self._ctypes.sizeof(self._SecurityAttributes), descriptor, False
            )
            handle = self._kernel32.CreateFileW(
                str(path),
                self._GENERIC_WRITE,
                0,
                self._ctypes.byref(attributes),
                self._CREATE_NEW,
                self._FILE_ATTRIBUTE_NORMAL,
                None,
            )
        finally:
            self._kernel32.LocalFree(descriptor)
        if handle is None or handle == self._invalid_handle:
            raise self._last_error(f"CreateFileW({path})")
        try:
            self._require_persistent_acls(handle, path)
            fd = msvcrt.open_osfhandle(int(handle), os.O_WRONLY | os.O_BINARY)
        except OSError:
            self._kernel32.CloseHandle(handle)
            path.unlink(missing_ok=True)
            raise
        return os.fdopen(fd, "wb")


def _without_auto_inherit_flags(dacl_sddl: str) -> str:
    """Drop the ``AI``/``AR`` control flags, which Windows sets on its own during a write."""
    header, separator, aces = dacl_sddl.partition("(")
    return header.replace("AI", "").replace("AR", "") + separator + aces


_win32 = _Win32()
