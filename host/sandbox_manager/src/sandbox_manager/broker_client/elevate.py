"""Closed-argument elevation for the broker executable (Windows only).

Two elevations live here because they need two different things back.

``run_broker_provision_elevated`` starts ``--provision --owner-sid`` and needs only the exit code, so it
goes through PowerShell's ``Start-Process -Verb RunAs -Wait``.

``launch_broker_provision_session`` starts ``--provision-session`` - or, on a first start,
``--provision-identities-and-session``, the same session preceded by the identity step in the same
elevated process - and needs the *exact* process id of the process the UAC prompt created, which
``Start-Process`` cannot give:
its ``-PassThru`` hands back a process id read inside another process, and the PowerShell host that
held the process handle exits, so by the time this client reads the number nothing keeps Windows from
recycling it onto some other process.
``ShellExecuteExW`` with ``SEE_MASK_NOCLOSEPROCESS`` hands back a handle to that process instead.
Holding the handle open for the whole exchange is what makes "the pipe was connected by this process
id" mean "the pipe was connected by the process I launched": a process id cannot be reused while a
handle to it is open.
"""

from __future__ import annotations

import ctypes
import os
import re
import subprocess
import time
from pathlib import Path
from types import TracebackType
from typing import Literal, get_args

from .paths import system_powershell_executable

#: Decimal ASCII only. ``\d`` would also accept non-ASCII digits, and this pattern guards what goes onto
#: an elevated command line.
_OWNER_SID_PATTERN = re.compile(r"^S-1-(?:[0-9]+-)+[0-9]+$")
_PIPE_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_AUTH_KEY_PATTERN = re.compile(r"^[0-9a-f]{64}$")

#: The two closed operations that open a provision session (``BROKER_ELEVATED_OPERATIONS`` in
#: ``shared/contracts``). They take the same three values; the second ensures the owner's tier
#: identities first, so a first start costs one UAC prompt instead of two.
PROVISION_SESSION = "--provision-session"
PROVISION_IDENTITIES_AND_SESSION = "--provision-identities-and-session"
SessionOperation = Literal["--provision-session", "--provision-identities-and-session"]
_SESSION_OPERATIONS: frozenset[str] = frozenset(get_args(SessionOperation))

_SEE_MASK_NOCLOSEPROCESS = 0x00000040
_SEE_MASK_NOASYNC = 0x00000100
_SEE_MASK_FLAG_NO_UI = 0x00000400
_SW_HIDE = 0
_ERROR_CANCELLED = 1223
_WAIT_OBJECT_0 = 0x00000000
_WAIT_TIMEOUT = 0x00000102
_STILL_ACTIVE = 259


class _ShellExecuteInfoW(ctypes.Structure):
    _fields_ = (
        ("cbSize", ctypes.c_uint32),
        ("fMask", ctypes.c_uint32),
        ("hwnd", ctypes.c_void_p),
        ("lpVerb", ctypes.c_wchar_p),
        ("lpFile", ctypes.c_wchar_p),
        ("lpParameters", ctypes.c_wchar_p),
        ("lpDirectory", ctypes.c_wchar_p),
        ("nShow", ctypes.c_int32),
        ("hInstApp", ctypes.c_void_p),
        ("lpIDList", ctypes.c_void_p),
        ("lpClass", ctypes.c_wchar_p),
        ("hkeyClass", ctypes.c_void_p),
        ("dwHotKey", ctypes.c_uint32),
        ("hIcon", ctypes.c_void_p),
        ("hProcess", ctypes.c_void_p),
    )


def _kernel32() -> ctypes.WinDLL:
    """``kernel32`` with the prototypes this module uses declared.

    Declared rather than left to the ctypes defaults, which describe every argument and every return value
    as a C ``int``: a 64-bit handle passed that way is truncated, and a ``DWORD`` process id above 2^31
    comes back negative.
    """
    library = ctypes.WinDLL("kernel32", use_last_error=True)
    library.WaitForSingleObject.argtypes = (ctypes.c_void_p, ctypes.c_uint32)
    library.WaitForSingleObject.restype = ctypes.c_uint32
    library.GetExitCodeProcess.argtypes = (
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_uint32),
    )
    library.GetExitCodeProcess.restype = ctypes.c_int32
    library.GetProcessId.argtypes = (ctypes.c_void_p,)
    library.GetProcessId.restype = ctypes.c_uint32
    library.CloseHandle.argtypes = (ctypes.c_void_p,)
    library.CloseHandle.restype = ctypes.c_int32
    return library


def _shell32() -> ctypes.WinDLL:
    """``shell32`` with ``ShellExecuteExW`` declared, for the same reason as :func:`_kernel32`."""
    library = ctypes.WinDLL("shell32", use_last_error=True)
    library.ShellExecuteExW.argtypes = (ctypes.POINTER(_ShellExecuteInfoW),)
    library.ShellExecuteExW.restype = ctypes.c_int32
    return library


class ElevationCancelled(OSError):
    """The user dismissed the UAC prompt. Not a failure of the broker, and not retried silently."""


class ElevatedBroker:
    """A live elevated broker process whose id is pinned by the handle this object holds."""

    def __init__(self, pid: int, handle: int) -> None:
        self.pid = pid
        self._handle: int | None = handle

    def __enter__(self) -> ElevatedBroker:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self.close()

    def wait(self, timeout_seconds: float) -> int | None:
        """The process's exit code, or ``None`` if it is still running at the deadline."""
        kernel32 = _kernel32()
        deadline = time.monotonic() + timeout_seconds
        remaining = max(0, int((deadline - time.monotonic()) * 1000))
        waited = kernel32.WaitForSingleObject(
            ctypes.c_void_p(self._require_handle()), ctypes.c_uint32(remaining)
        )
        if waited == _WAIT_TIMEOUT:
            return None
        if waited != _WAIT_OBJECT_0:
            raise ctypes.WinError(ctypes.get_last_error())
        code = ctypes.c_uint32()
        if not kernel32.GetExitCodeProcess(
            ctypes.c_void_p(self._require_handle()), ctypes.byref(code)
        ):
            raise ctypes.WinError(ctypes.get_last_error())
        return None if code.value == _STILL_ACTIVE else int(code.value)

    def close(self) -> None:
        """Releases the process handle, and with it the guarantee about the process id."""
        if self._handle is not None:
            _kernel32().CloseHandle(ctypes.c_void_p(self._handle))
            self._handle = None

    def _require_handle(self) -> int:
        if self._handle is None:
            raise ValueError("this elevated broker handle is already released")
        return self._handle


def _session_parameters(
    operation: SessionOperation, owner_sid: str, pipe_id: str, auth_key_hex: str
) -> str:
    """The ``lpParameters`` of one provision-session operation, with every value checked first.

    The operation is one of the two closed session operations, and every one of the three arguments is
    checked against a closed pattern before it is composed.
    That is not defence against this module's own callers: it is what makes the command line on the UAC
    prompt describable in advance.
    There is no path, no plan, no root and no free-form text on it - the payload arrives over the pipe,
    from a peer whose account the broker checks, and is re-validated there from scratch.
    """
    if operation not in _SESSION_OPERATIONS:
        raise ValueError("operation is not one of the closed provision-session operations")
    if not _OWNER_SID_PATTERN.fullmatch(owner_sid):
        raise ValueError("owner_sid is not a well-formed Windows SID")
    if not _PIPE_ID_PATTERN.fullmatch(pipe_id):
        raise ValueError("a provision pipe id is 1-64 characters of [A-Za-z0-9_-]")
    if not _AUTH_KEY_PATTERN.fullmatch(auth_key_hex):
        raise ValueError("a provision auth key is 64 lowercase hex characters")
    return f"{operation} --owner-sid {owner_sid} --pipe-id {pipe_id} --auth-key {auth_key_hex}"


def launch_broker_provision_session(
    broker_path: Path,
    owner_sid: str,
    pipe_id: str,
    auth_key_hex: str,
    operation: SessionOperation = PROVISION_SESSION,
) -> ElevatedBroker:
    """Starts ``operation`` elevated and returns the process, id pinned."""
    if os.name != "nt":
        raise OSError("broker elevation requires Windows")
    parameters = _session_parameters(operation, owner_sid, pipe_id, auth_key_hex)

    shell32 = _shell32()
    kernel32 = _kernel32()
    info = _ShellExecuteInfoW(
        cbSize=ctypes.sizeof(_ShellExecuteInfoW),
        fMask=_SEE_MASK_NOCLOSEPROCESS | _SEE_MASK_NOASYNC | _SEE_MASK_FLAG_NO_UI,
        lpVerb="runas",
        lpFile=str(broker_path),
        lpParameters=parameters,
        nShow=_SW_HIDE,
    )
    if not shell32.ShellExecuteExW(ctypes.byref(info)):
        error = ctypes.get_last_error()
        if error == _ERROR_CANCELLED:
            raise ElevationCancelled("the elevation prompt was dismissed")
        raise ctypes.WinError(error)
    if not info.hProcess:
        raise OSError("elevation returned no process handle")
    pid = kernel32.GetProcessId(ctypes.c_void_p(info.hProcess))
    if not pid:
        error = ctypes.get_last_error()
        kernel32.CloseHandle(ctypes.c_void_p(info.hProcess))
        raise ctypes.WinError(error)
    return ElevatedBroker(int(pid), int(info.hProcess))


def run_broker_provision_elevated(broker_path: Path, owner_sid: str) -> dict[str, object]:
    """Launch ``native_isolation_broker --provision --owner-sid …`` elevated.

    A dismissed prompt raises :class:`ElevationCancelled`, any other launch failure ``OSError``; both carry
    PowerShell's own report as the message.
    """
    if os.name != "nt":
        raise OSError("broker elevation requires Windows")
    environment = dict(os.environ)
    environment.update(
        {
            "SUPERCLAW_BROKER_CLIENT_EXE": str(broker_path),
            "SUPERCLAW_BROKER_CLIENT_OWNER_SID": owner_sid,
        }
    )
    script = (
        "$ErrorActionPreference = 'Stop' ; "
        "$p = Start-Process "
        "-FilePath $env:SUPERCLAW_BROKER_CLIENT_EXE "
        "-ArgumentList @('--provision','--owner-sid',"
        "$env:SUPERCLAW_BROKER_CLIENT_OWNER_SID) "
        "-Verb RunAs -Wait -PassThru -WindowStyle Hidden ; "
        "Write-Output $p.ExitCode"
    )
    completed = subprocess.run(
        [
            str(system_powershell_executable()),
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            script,
        ],
        capture_output=True,
        text=True,
        check=False,
        env=environment,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    if completed.returncode != 0:
        report = (
            completed.stderr.strip()
            or completed.stdout.strip()
            or "could not launch elevated broker provision"
        )
        if _reports_dismissed_prompt(report):
            raise ElevationCancelled(report)
        raise OSError(report)
    try:
        exit_code = int(completed.stdout.strip().splitlines()[-1])
    except (IndexError, ValueError) as exc:
        raise OSError("elevated broker did not report an exit code") from exc
    if exit_code == 0:
        return {"ok": True}
    return {
        "ok": False,
        "reason": "broker_exit_nonzero",
        "detail": f"broker provision exited with code {exit_code}",
    }


def _reports_dismissed_prompt(report: str) -> bool:
    """Whether PowerShell's report is ``Start-Process`` quoting ``ERROR_CANCELLED``.

    ``Start-Process`` wraps the Win32 error in an ``InvalidOperationException`` that keeps only its message, so
    the system's text for 1223, in the user's language, is all that identifies a dismissed prompt. .NET
    renders it without the final period ``FormatError`` keeps. The English text is always looked for as
    well, since ``FormatError`` exists only on Windows.
    """
    texts = {"The operation was canceled by the user"}
    format_error = getattr(ctypes, "FormatError", None)
    if format_error is not None:
        texts.add(" ".join(format_error(_ERROR_CANCELLED).split()).rstrip("."))
    flattened = " ".join(report.split())
    return any(text and text in flattened for text in texts)
