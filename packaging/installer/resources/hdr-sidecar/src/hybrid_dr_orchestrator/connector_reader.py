"""Bounded fixed-purpose subprocess for unsealing Connector client configuration."""

from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path

MAX_CONFIG_BYTES = 16 * 1024
MAX_STDERR_BYTES = 8 * 1024
# Paid once per sealed file (see search._load_sealed_config). With cleanup, the
# Connector and LRM probes and local work, a cold readiness probe can outrun its
# 8 s budget (see serve.py); its 503 leaves the cache warm for the next probe.
READER_TIMEOUT_S = 5.0
READER_CLEANUP_TIMEOUT_S = 1.0


class ConnectorConfigUnavailable(ValueError):
    """The sealed Connector client configuration could not be read."""


def _set_nonblocking(fd: int) -> None:
    if os.name != "nt" or sys.version_info >= (3, 12):
        os.set_blocking(fd, False)
        return

    # Python 3.11 has no os.set_blocking support for Windows pipes. Anonymous
    # pipes are implemented as named pipes and support PIPE_NOWAIT on the reader.
    import ctypes
    import msvcrt
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    set_state = kernel32.SetNamedPipeHandleState
    set_state.argtypes = [
        wintypes.HANDLE,
        ctypes.POINTER(wintypes.DWORD),
        ctypes.c_void_p,
        ctypes.c_void_p,
    ]
    set_state.restype = wintypes.BOOL
    mode = wintypes.DWORD(1)  # PIPE_READMODE_BYTE | PIPE_NOWAIT
    if not set_state(msvcrt.get_osfhandle(fd), ctypes.byref(mode), None, None):
        raise ctypes.WinError(ctypes.get_last_error())


def read_sealed_connector_config(reader_python: Path, reader_root: Path, path: Path) -> bytes:
    """Run the packaged DPAPI reader with bounded output, time, and cleanup."""
    deadline = time.monotonic() + READER_TIMEOUT_S
    try:
        process = subprocess.Popen(
            [
                str(reader_python),
                "-E",
                "-s",
                "-m",
                "sandbox_manager.dpapi_connector_reader",
                str(path),
            ],
            # Keep module resolution rooted in the packaged source, not PYTHONPATH
            # or the user site. The reader needs no HDR credentials or proxy env.
            cwd=reader_root,
            env={k: v for k, v in os.environ.items() if k.upper() in {"SYSTEMROOT", "WINDIR"}},
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=0,
            close_fds=True,
            # Readiness invokes this short-lived console Python repeatedly.
            # Redirected stdio alone does not prevent Windows console windows.
            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
        )
        assert process.stdout is not None
        assert process.stderr is not None
        stdout = bytearray()
        stderr = bytearray()
        pending = [
            (process.stdout, stdout, MAX_CONFIG_BYTES),
            (process.stderr, stderr, MAX_STDERR_BYTES),
        ]
        try:
            for stream, _, _ in pending:
                _set_nonblocking(stream.fileno())
            while time.monotonic() < deadline:
                progressed = False
                # One bounded read per pipe per turn: neither a noisy stdout nor
                # stderr can starve the other pipe, exit checks, or the deadline.
                for entry in pending[:]:
                    stream, output, limit = entry
                    chunk = stream.read(min(4096, limit - len(output) + 1))
                    if chunk is None:  # EAGAIN / Windows ERROR_NO_DATA, not EOF.
                        continue
                    progressed = True
                    if not chunk:
                        pending.remove(entry)
                    elif len(output) + len(chunk) > limit:
                        raise ValueError("reader output exceeds limit")
                    else:
                        output.extend(chunk)
                returncode = process.poll()
                if returncode is not None:
                    if returncode != 0:
                        raise ValueError("reader failed")
                    if not pending:
                        if not stdout:
                            raise ValueError("reader output is empty")
                        return bytes(stdout)
                if not progressed:
                    time.sleep(min(0.01, max(0.0, deadline - time.monotonic())))
            raise ValueError("reader timed out")
        finally:
            try:
                try:
                    if process.poll() is None:
                        process.kill()
                finally:
                    process.wait(timeout=READER_CLEANUP_TIMEOUT_S)
            finally:
                # FileIO is unbuffered and no other thread ever accesses it.
                # Closing cannot wait for a reader lock or descendant-held EOF.
                process.stdout.close()
                process.stderr.close()
    except (OSError, ValueError, subprocess.SubprocessError):
        raise ConnectorConfigUnavailable("Connector client configuration is unavailable") from None
