"""The one-shot provision pipe, served by the unprivileged owner (Windows only).

# Why the owner is the server here

Every other named pipe in this product is created by the more privileged side.
This one is inverted on purpose.
The elevated broker is started through ``runas``, so the owner cannot read its standard output and
cannot hand it a file, a handle or an argument that another process could not have forged.
What the owner *can* do is create a kernel object first, under a DACL it chooses, and let the elevated
process come to it: the pipe exists before the broker is launched, it is created with
``FILE_FLAG_FIRST_PIPE_INSTANCE`` so no other process can have got there first, ``nMaxInstances`` is 1
so no second instance can appear, and ``PIPE_REJECT_REMOTE_CLIENTS`` keeps it local.

The two peer checks are facts about processes, not fields in a frame:

- this side accepts only ``GetNamedPipeClientProcessId`` equal to the process id ``ShellExecuteExW``
  handed back, and holds that process handle open for the whole exchange so the id cannot be recycled
  underneath the check;
- the elevated side accepts only a pipe whose *server* process token SID is the owner SID it was asked
  to provision for (``provision_session::pipe::bind_server``).

# Why the I/O is overlapped

A blocking ``ConnectNamedPipe`` on a pipe the broker never reaches would hang the caller with no way
out, and a UAC prompt the user dismisses is exactly that case.
Every operation here is issued overlapped against one manual-reset event and bounded by a deadline, so
a dismissed prompt, a broker that exits before connecting and a broker that connects and says nothing
all end as a timeout rather than a hang.
"""

from __future__ import annotations

import ctypes
import os
import re
import time
from types import TracebackType
from typing import Any, NoReturn

from .provision_wire import (
    FRAME_PREFIX_BYTES,
    MAX_PROVISION_FRAME_BYTES,
    ProvisionWireError,
    declared_frame_len,
    frame_prefix,
)

PROVISION_PIPE_PREFIX = r"\\.\pipe\SuperClawProvision-"

#: The rights the pipe's DACL grants each of its three trustees, matching the broker's
#: ``launcher::pipe_acl::FULL_PIPE_RIGHTS``.
FULL_PIPE_RIGHTS = 0x001F01FF

_LOCAL_SYSTEM_SID = "S-1-5-18"
_BUILTIN_ADMINISTRATORS_SID = "S-1-5-32-544"
#: Decimal ASCII only. ``\d`` would also accept non-ASCII digits, and this SID goes into the pipe's DACL.
_OWNER_SID_PATTERN = re.compile(r"^S-1-(?:[0-9]+-)+[0-9]+$")
_PIPE_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

_PIPE_ACCESS_DUPLEX = 0x00000003
_FILE_FLAG_FIRST_PIPE_INSTANCE = 0x00080000
_FILE_FLAG_OVERLAPPED = 0x40000000
_PIPE_TYPE_BYTE = 0x00000000
_PIPE_READMODE_BYTE = 0x00000000
_PIPE_WAIT = 0x00000000
_PIPE_REJECT_REMOTE_CLIENTS = 0x00000008
_PIPE_BUFFER_BYTES = MAX_PROVISION_FRAME_BYTES + FRAME_PREFIX_BYTES

_ERROR_BROKEN_PIPE = 109
_ERROR_PIPE_NOT_CONNECTED = 233
_ERROR_PIPE_CONNECTED = 535
_ERROR_IO_PENDING = 997
_ERROR_OPERATION_ABORTED = 995
_WAIT_OBJECT_0 = 0x00000000
_WAIT_TIMEOUT = 0x00000102
_SDDL_REVISION_1 = 1
_INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value

_EOF_ERRORS = frozenset({_ERROR_BROKEN_PIPE, _ERROR_PIPE_NOT_CONNECTED})


class _Overlapped(ctypes.Structure):
    _fields_ = (
        ("Internal", ctypes.c_void_p),
        ("InternalHigh", ctypes.c_void_p),
        ("Offset", ctypes.c_uint32),
        ("OffsetHigh", ctypes.c_uint32),
        ("hEvent", ctypes.c_void_p),
    )


class _SecurityAttributes(ctypes.Structure):
    _fields_ = (
        ("nLength", ctypes.c_uint32),
        ("lpSecurityDescriptor", ctypes.c_void_p),
        ("bInheritHandle", ctypes.c_int32),
    )


class _Win32:
    """The exact Win32 surface this module uses, bound once and lazily."""

    def __init__(self) -> None:
        if os.name != "nt":
            raise OSError("the provision pipe requires Windows")
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)

        self.CreateNamedPipeW = kernel32.CreateNamedPipeW
        self.CreateNamedPipeW.restype = ctypes.c_void_p
        self.CreateNamedPipeW.argtypes = (
            ctypes.c_wchar_p,
            ctypes.c_uint32,
            ctypes.c_uint32,
            ctypes.c_uint32,
            ctypes.c_uint32,
            ctypes.c_uint32,
            ctypes.c_uint32,
            ctypes.POINTER(_SecurityAttributes),
        )
        self.ConnectNamedPipe = kernel32.ConnectNamedPipe
        self.ConnectNamedPipe.restype = ctypes.c_int32
        self.ConnectNamedPipe.argtypes = (ctypes.c_void_p, ctypes.POINTER(_Overlapped))
        self.GetNamedPipeClientProcessId = kernel32.GetNamedPipeClientProcessId
        self.GetNamedPipeClientProcessId.restype = ctypes.c_int32
        self.GetNamedPipeClientProcessId.argtypes = (
            ctypes.c_void_p,
            ctypes.POINTER(ctypes.c_uint32),
        )
        self.ReadFile = kernel32.ReadFile
        self.ReadFile.restype = ctypes.c_int32
        self.ReadFile.argtypes = (
            ctypes.c_void_p,
            ctypes.c_void_p,
            ctypes.c_uint32,
            ctypes.POINTER(ctypes.c_uint32),
            ctypes.POINTER(_Overlapped),
        )
        self.WriteFile = kernel32.WriteFile
        self.WriteFile.restype = ctypes.c_int32
        self.WriteFile.argtypes = self.ReadFile.argtypes
        self.CreateEventW = kernel32.CreateEventW
        self.CreateEventW.restype = ctypes.c_void_p
        self.CreateEventW.argtypes = (
            ctypes.c_void_p,
            ctypes.c_int32,
            ctypes.c_int32,
            ctypes.c_wchar_p,
        )
        self.ResetEvent = kernel32.ResetEvent
        self.ResetEvent.restype = ctypes.c_int32
        self.ResetEvent.argtypes = (ctypes.c_void_p,)
        self.WaitForSingleObject = kernel32.WaitForSingleObject
        self.WaitForSingleObject.restype = ctypes.c_uint32
        self.WaitForSingleObject.argtypes = (ctypes.c_void_p, ctypes.c_uint32)
        self.GetOverlappedResult = kernel32.GetOverlappedResult
        self.GetOverlappedResult.restype = ctypes.c_int32
        self.GetOverlappedResult.argtypes = (
            ctypes.c_void_p,
            ctypes.POINTER(_Overlapped),
            ctypes.POINTER(ctypes.c_uint32),
            ctypes.c_int32,
        )
        self.CancelIoEx = kernel32.CancelIoEx
        self.CancelIoEx.restype = ctypes.c_int32
        self.CancelIoEx.argtypes = (ctypes.c_void_p, ctypes.POINTER(_Overlapped))
        self.CloseHandle = kernel32.CloseHandle
        self.CloseHandle.restype = ctypes.c_int32
        self.CloseHandle.argtypes = (ctypes.c_void_p,)
        self.LocalFree = kernel32.LocalFree
        self.LocalFree.restype = ctypes.c_void_p
        self.LocalFree.argtypes = (ctypes.c_void_p,)
        self.ConvertStringSecurityDescriptorToSecurityDescriptorW = (
            advapi32.ConvertStringSecurityDescriptorToSecurityDescriptorW
        )
        self.ConvertStringSecurityDescriptorToSecurityDescriptorW.restype = ctypes.c_int32
        self.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = (
            ctypes.c_wchar_p,
            ctypes.c_uint32,
            ctypes.POINTER(ctypes.c_void_p),
            ctypes.POINTER(ctypes.c_uint32),
        )


_WIN32: _Win32 | None = None


def _win32() -> _Win32:
    global _WIN32
    if _WIN32 is None:
        _WIN32 = _Win32()
    return _WIN32


def provision_pipe_name(pipe_id: str) -> str:
    """The pipe path for ``pipe_id``, refusing anything the broker would refuse.

    The character set is closed rather than escaped: a pipe id is generated by this process from
    ``secrets``, so a value outside it is a defect, and a name that could carry a path separator is a
    name that could point somewhere else in the pipe namespace.
    """
    if not _PIPE_ID_PATTERN.fullmatch(pipe_id):
        raise ValueError("a provision pipe id is 1-64 characters of [A-Za-z0-9_-]")
    return f"{PROVISION_PIPE_PREFIX}{pipe_id}"


def provision_pipe_sddl(owner_sid: str) -> str:
    """The protected DACL the pipe is created with: SYSTEM, Administrators and the owner, nobody else.

    Administrators is not decoration.
    Under an alternate-administrator UAC prompt the elevated broker runs as a different account than the
    owner, so the owner ACE alone would leave the broker unable to open the pipe it was launched to
    answer.
    """
    if not _OWNER_SID_PATTERN.fullmatch(owner_sid):
        raise ValueError("owner_sid is not a well-formed Windows SID")
    rights = f"0x{FULL_PIPE_RIGHTS:08x}"
    return (
        "D:P"
        f"(A;;{rights};;;{_LOCAL_SYSTEM_SID})"
        f"(A;;{rights};;;{_BUILTIN_ADMINISTRATORS_SID})"
        f"(A;;{rights};;;{owner_sid})"
    )


class ProvisionPipeTimeout(TimeoutError):
    """A provision pipe operation did not complete inside its deadline."""


class ProvisionPipeServer:
    """One provision pipe instance, from creation to close. Not reusable and not reconnectable."""

    def __init__(self, pipe_id: str, owner_sid: str) -> None:
        api = _win32()
        name = provision_pipe_name(pipe_id)
        descriptor = _security_descriptor(provision_pipe_sddl(owner_sid))
        try:
            attributes = _SecurityAttributes(
                nLength=ctypes.sizeof(_SecurityAttributes),
                lpSecurityDescriptor=descriptor,
                bInheritHandle=0,
            )
            handle = api.CreateNamedPipeW(
                name,
                _PIPE_ACCESS_DUPLEX
                | _FILE_FLAG_FIRST_PIPE_INSTANCE
                | _FILE_FLAG_OVERLAPPED,
                _PIPE_TYPE_BYTE
                | _PIPE_READMODE_BYTE
                | _PIPE_WAIT
                | _PIPE_REJECT_REMOTE_CLIENTS,
                1,
                _PIPE_BUFFER_BYTES,
                _PIPE_BUFFER_BYTES,
                0,
                ctypes.byref(attributes),
            )
            if handle is None or handle == _INVALID_HANDLE_VALUE:
                raise _os_error(ctypes.get_last_error(), f"could not create {name}")
        finally:
            api.LocalFree(descriptor)
        self._handle: int | None = handle
        self._event: int | None = api.CreateEventW(None, 1, 0, None)
        if not self._event:
            error = ctypes.get_last_error()
            self.close()
            raise _os_error(error, "could not create the provision pipe event")
        self.name = name

    def __enter__(self) -> ProvisionPipeServer:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self.close()

    def close(self) -> None:
        """Closes both handles. There is deliberately no disconnect.

        ``DisconnectNamedPipe`` would return the single instance to the namespace, which is how a pipe
        already bound to one process could acquire a second, unbound peer.
        """
        api = _win32()
        for attribute in ("_handle", "_event"):
            handle = getattr(self, attribute, None)
            if handle:
                api.CloseHandle(ctypes.c_void_p(handle))
            setattr(self, attribute, None)

    def await_client(self, expected_pid: int, deadline: float) -> None:
        """Waits for one client and refuses any process other than ``expected_pid``.

        The refusal is fatal for this pipe: the instance stays bound to whoever connected and is closed
        by the caller rather than offered to a second peer.
        """
        api = _win32()
        overlapped = self._arm()
        started = api.ConnectNamedPipe(self._raw(), ctypes.byref(overlapped))
        if not started:
            error = ctypes.get_last_error()
            if error == _ERROR_PIPE_CONNECTED:
                started = 1
            elif error != _ERROR_IO_PENDING:
                raise _os_error(error, "could not wait for the elevated broker")
        if not started:
            self._finish(overlapped, deadline, "the elevated broker's connection")
        actual = ctypes.c_uint32()
        if not api.GetNamedPipeClientProcessId(self._raw(), ctypes.byref(actual)):
            raise _os_error(
                ctypes.get_last_error(), "could not read the connecting process id"
            )
        if actual.value != expected_pid:
            raise PermissionError(
                "the provision pipe was connected by process "
                f"{actual.value}, not by the elevated broker this client launched "
                f"({expected_pid})"
            )

    def send(self, body: bytes, deadline: float) -> None:
        # The two refusals are separate because they mean different things to whoever reads one. An empty
        # body is this side having composed nothing; only a body past the cap is about the frame bound.
        if not body:
            raise ProvisionWireError("invalid_field", "the frame body is empty")
        if len(body) > MAX_PROVISION_FRAME_BYTES:
            raise ProvisionWireError("request_oversized", f"{len(body)} bytes")
        self._write_all(frame_prefix(body) + body, deadline)

    def receive(self, deadline: float) -> bytes | None:
        """One whole frame body, or ``None`` if the peer closed without sending another."""
        prefix = self._read_exact(FRAME_PREFIX_BYTES, deadline)
        if prefix is None:
            return None
        length = declared_frame_len(prefix, MAX_PROVISION_FRAME_BYTES)
        body = self._read_exact(length, deadline)
        if body is None:
            raise ProvisionWireError(
                "invalid_field", "the peer closed in the middle of a frame"
            )
        return body

    def _raw(self) -> ctypes.c_void_p:
        if self._handle is None:
            raise ValueError("this provision pipe is closed")
        return ctypes.c_void_p(self._handle)

    def _arm(self) -> _Overlapped:
        api = _win32()
        if self._event is None:
            raise ValueError("this provision pipe is closed")
        if not api.ResetEvent(ctypes.c_void_p(self._event)):
            raise _os_error(ctypes.get_last_error(), "could not reset the pipe event")
        return _Overlapped(hEvent=self._event)

    def _finish(self, overlapped: _Overlapped, deadline: float, what: str) -> int:
        """Waits for one armed operation, cancelling it rather than waiting forever."""
        api = _win32()
        waited = api.WaitForSingleObject(
            ctypes.c_void_p(self._event), _remaining_ms(deadline)
        )
        if waited == _WAIT_TIMEOUT:
            api.CancelIoEx(self._raw(), ctypes.byref(overlapped))
            transferred = ctypes.c_uint32()
            api.GetOverlappedResult(
                self._raw(), ctypes.byref(overlapped), ctypes.byref(transferred), 1
            )
            raise ProvisionPipeTimeout(f"{what} did not arrive inside the deadline")
        if waited != _WAIT_OBJECT_0:
            raise _os_error(ctypes.get_last_error(), f"could not wait for {what}")
        transferred = ctypes.c_uint32()
        if not api.GetOverlappedResult(
            self._raw(), ctypes.byref(overlapped), ctypes.byref(transferred), 0
        ):
            error = ctypes.get_last_error()
            if error in _EOF_ERRORS:
                return 0
            raise _os_error(error, f"could not complete {what}")
        return transferred.value

    def _read_exact(self, count: int, deadline: float) -> bytes | None:
        api = _win32()
        buffer = ctypes.create_string_buffer(count)
        filled = 0
        while filled < count:
            overlapped = self._arm()
            transferred = ctypes.c_uint32()
            started = api.ReadFile(
                self._raw(),
                ctypes.byref(buffer, filled),
                count - filled,
                ctypes.byref(transferred),
                ctypes.byref(overlapped),
            )
            if not started:
                error = ctypes.get_last_error()
                if error in _EOF_ERRORS:
                    return None if filled == 0 else _short_read(filled)
                if error != _ERROR_IO_PENDING:
                    raise _os_error(error, "could not read a provision frame")
                moved = self._finish(overlapped, deadline, "a provision frame")
            else:
                moved = transferred.value
            if moved == 0:
                return None if filled == 0 else _short_read(filled)
            filled += moved
        return buffer.raw[:count]

    def _write_all(self, framed: bytes, deadline: float) -> None:
        api = _win32()
        buffer = ctypes.create_string_buffer(framed, len(framed))
        sent = 0
        while sent < len(framed):
            overlapped = self._arm()
            transferred = ctypes.c_uint32()
            started = api.WriteFile(
                self._raw(),
                ctypes.byref(buffer, sent),
                len(framed) - sent,
                ctypes.byref(transferred),
                ctypes.byref(overlapped),
            )
            if not started:
                error = ctypes.get_last_error()
                if error != _ERROR_IO_PENDING:
                    raise _os_error(error, "could not write a provision frame")
                moved = self._finish(overlapped, deadline, "a provision frame write")
            else:
                moved = transferred.value
            if moved == 0:
                raise BrokenPipeError("the provision pipe accepted no bytes")
            sent += moved


def _short_read(filled: int) -> NoReturn:
    raise ProvisionWireError(
        "invalid_field", f"the peer closed after {filled} bytes of a frame"
    )


def _security_descriptor(sddl: str) -> Any:
    api = _win32()
    descriptor = ctypes.c_void_p()
    size = ctypes.c_uint32()
    if not api.ConvertStringSecurityDescriptorToSecurityDescriptorW(
        sddl, _SDDL_REVISION_1, ctypes.byref(descriptor), ctypes.byref(size)
    ):
        raise _os_error(ctypes.get_last_error(), "could not convert the pipe DACL")
    return descriptor


def _remaining_ms(deadline: float) -> int:
    remaining = deadline - time.monotonic()
    return 0 if remaining <= 0 else int(remaining * 1000) + 1


def _os_error(code: int, message: str) -> OSError:
    return ctypes.WinError(code, f"{message}") if os.name == "nt" else OSError(message)
