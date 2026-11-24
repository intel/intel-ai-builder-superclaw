"""Copy named files out of a v1 Docker volume: GNU `tar` run in the v1 distro, streamed over stdout.

Docker is not started: the distro's `wsl.conf` sets only the default user, so booting it starts no
Docker daemon, and `tar` reads the volume's `_data` directory as root. Nothing in the volume is written.
"""

from __future__ import annotations

import contextlib
import io
import os
import shutil
import subprocess
import tarfile
import threading
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import IO, Protocol

from .outcome import V1ImportReason

_VOLUMES = PurePosixPath("/var/lib/docker/volumes")
_CHUNK = 1 << 20
_GRACE_S = 2.0
_TAIL_BYTES = 2048


class Process(Protocol):
    @property
    def stdout(self) -> IO[bytes] | None: ...

    @property
    def stderr(self) -> IO[bytes] | None: ...

    def wait(self, timeout: float | None = None) -> int: ...

    def kill(self) -> None: ...


Spawn = Callable[[Sequence[str]], Process]


class CopyOutFailure(Exception):
    def __init__(self, reason: V1ImportReason, detail: str) -> None:
        super().__init__(f"{reason}: {detail}")
        self.reason = reason
        self.detail = detail


def spawn_process(argv: Sequence[str]) -> Process:
    return subprocess.Popen(
        list(argv),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )


def locate_wsl_exe() -> str | None:
    system_root = os.environ.get("SystemRoot") or os.environ.get("WINDIR")
    if not system_root:
        return None
    candidate = Path(system_root) / "System32" / "wsl.exe"
    return str(candidate) if candidate.is_file() else None


def tar_command(wsl_exe: str, distro: str, volume: str, members: Sequence[str]) -> list[str]:
    """`--exec` skips the login shell, so nothing expands the arguments; a missing member is a warning."""
    return [
        wsl_exe, "-d", distro, "-u", "root", "--exec",
        "tar", "--create", "--file=-", f"--directory={_VOLUMES / volume / '_data'}",
        "--ignore-failed-read", "--", *members,
    ]


def copy_out(
    *,
    spawn: Spawn,
    argv: Sequence[str],
    members: Sequence[str],
    staging: Path,
    max_bytes: int,
    first_byte_s: float,
    stall_s: float,
) -> dict[str, Path]:
    """Extract `members` (regular files only) into `staging`, keyed by member name. Missing ones are absent.

    A stream that sends nothing within `first_byte_s`, or nothing for `stall_s` after that, is killed; one
    that keeps moving runs until it ends or passes `max_bytes`.
    """
    try:
        process = spawn(argv)
    except OSError as error:
        raise CopyOutFailure(V1ImportReason.COPY_OUT_FAILED, f"wsl.exe did not start: {error}") from error
    stderr = _Tail(process.stderr)
    stream = _Capped(process.stdout or io.BytesIO(), max_bytes)
    result = _Extraction()
    reader = threading.Thread(
        target=_extract, args=(stream, frozenset(members), staging, result), name="v1-import-copy-out", daemon=True
    )
    reader.start()
    timeout = _await_reader(reader, stream, first_byte_s=first_byte_s, stall_s=stall_s)
    if timeout or result.failure is not None:
        process.kill()
        reader.join(_GRACE_S)
    returncode = _wait(process, _GRACE_S)
    stderr.join(_GRACE_S)
    # A pipe a reader is still blocked on is left open: closing it under the read can hang.
    _close(process.stdout if not reader.is_alive() else None, process.stderr if stderr.done else None)

    if timeout:
        raise CopyOutFailure(V1ImportReason.COPY_OUT_TIMEOUT, timeout)
    if result.failure is not None:
        raise result.failure
    if returncode != 0:
        said = _legible(stderr.data or stream.head)
        raise CopyOutFailure(V1ImportReason.COPY_OUT_FAILED, f"wsl.exe exited {returncode}: {said}".rstrip(": "))
    if result.error:
        raise CopyOutFailure(V1ImportReason.COPY_OUT_FAILED, result.error)
    return result.copied


def terminate_distro(*, spawn: Spawn, wsl_exe: str, distro: str, timeout_s: float) -> bool:
    """Stop the distro; `True` when `wsl.exe` reports success. Never raises."""
    return _wsl_succeeds(spawn, [wsl_exe, "--terminate", distro], timeout_s)


def unregister_distro(*, spawn: Spawn, wsl_exe: str, distro: str, timeout_s: float) -> bool:
    """Remove the distro and its virtual disk; `True` when `wsl.exe` reports success. Never raises."""
    return _wsl_succeeds(spawn, [wsl_exe, "--unregister", distro], timeout_s)


def _wsl_succeeds(spawn: Spawn, argv: Sequence[str], timeout_s: float) -> bool:
    try:
        process = spawn(argv)
    except OSError:
        return False
    try:
        return _wait(process, timeout_s) == 0
    finally:
        _close(process.stdout, process.stderr)


@dataclass
class _Extraction:
    copied: dict[str, Path] = field(default_factory=dict)
    failure: CopyOutFailure | None = None
    error: str = ""


class _Capped:
    def __init__(self, source: IO[bytes], limit: int) -> None:
        self._source = source
        self._limit = limit
        self.consumed = 0
        self.moved_at = 0.0
        self.head = b""

    def read(self, size: int = -1) -> bytes:
        data = self._source.read(size)
        if data:
            self.moved_at = time.monotonic()
        if len(self.head) < 512:
            self.head += data[: 512 - len(self.head)]
        self.consumed += len(data)
        if self.consumed > self._limit:
            raise CopyOutFailure(V1ImportReason.SOURCE_TOO_LARGE, f"stream passed {self._limit} bytes")
        return data


def _await_reader(reader: threading.Thread, stream: _Capped, *, first_byte_s: float, stall_s: float) -> str:
    """Wait for the reader while the stream moves; why it was given up on, or "" when the reader ended."""
    started = time.monotonic()
    while reader.is_alive():
        if stream.consumed:
            due, why = stream.moved_at + stall_s, f"no output for {stall_s:g} s after {stream.consumed} bytes"
        else:
            due, why = started + first_byte_s, f"no output within {first_byte_s:g} s"
        remaining = due - time.monotonic()
        if remaining <= 0:
            return why
        reader.join(remaining)
    return ""


def _extract(stream: _Capped, members: frozenset[str], staging: Path, result: _Extraction) -> None:
    try:
        with tarfile.open(fileobj=stream, mode="r|") as archive:
            for member in archive:
                source = archive.extractfile(member) if member.isreg() else None
                if member.name not in members or member.name in result.copied or source is None:
                    raise CopyOutFailure(
                        V1ImportReason.UNSAFE_ARCHIVE, f"unexpected member {member.name!r} of type {member.type!r}"
                    )
                target = staging / PurePosixPath(member.name).name
                with target.open("xb") as sink:
                    shutil.copyfileobj(source, sink, _CHUNK)
                result.copied[member.name] = target
        while stream.read(_CHUNK):
            pass
    except CopyOutFailure as failure:
        result.failure = failure
    except (tarfile.TarError, OSError) as error:
        result.error = f"{type(error).__name__}: {error}"


class _Tail:
    def __init__(self, source: IO[bytes] | None) -> None:
        self._buffer = bytearray()
        self._thread: threading.Thread | None = None
        if source is not None:
            self._thread = threading.Thread(target=self._drain, args=(source,), daemon=True)
            self._thread.start()

    def _drain(self, source: IO[bytes]) -> None:
        with contextlib.suppress(OSError, ValueError):
            while chunk := source.read(4096):
                self._buffer.extend(chunk)
                del self._buffer[:-_TAIL_BYTES]

    def join(self, timeout: float) -> None:
        if self._thread is not None:
            self._thread.join(timeout)

    @property
    def done(self) -> bool:
        return self._thread is None or not self._thread.is_alive()

    @property
    def data(self) -> bytes:
        return bytes(self._buffer)


def _wait(process: Process, timeout_s: float) -> int | None:
    try:
        return process.wait(timeout=timeout_s)
    except subprocess.TimeoutExpired:
        process.kill()
        try:
            return process.wait(timeout=_GRACE_S)
        except subprocess.TimeoutExpired:
            return None


def _close(*pipes: IO[bytes] | None) -> None:
    for pipe in pipes:
        if pipe is not None:
            with contextlib.suppress(OSError):
                pipe.close()


def _legible(data: bytes) -> str:
    """`wsl.exe` writes its own messages as UTF-16LE; `tar` writes UTF-8."""
    text = data.decode("utf-16-le" if b"\x00" in data else "utf-8", errors="replace")
    return " ".join(text.replace("\ufeff", "").split())[-300:]
