"""Managed HDR ``data_paths`` authorization (HDR-PR4, #2836).

The enforced boundary lives here. A local research file is authorized only if it is a regular,
singly linked file strictly under the workspace root the broker bound for this process
(``HYBRID_DR_WORKSPACE_ROOT``), named in a plain canonical drive form, and reached without a
reparse point in any component from the drive down to the leaf.

The research tool additionally drops model-supplied paths that are not ``file`` parts on the
user's current message. That runs under the same file_tool identity as this process, so it is an
intent/privacy control and not part of this boundary; nothing here trusts it.

Validation records each file's final path and ``(volume serial, file index)`` from an opened
handle. ``open_authorized`` re-reads them, plus the link count, from the handle it returns and
refuses any difference, so a swap between validation and read is an ``identity_mismatch`` rather
than a read of something else. Refusals carry a typed reason and the request index only, never
the path.
"""

from __future__ import annotations

import functools
import os
import re
import stat
import sys
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path, PureWindowsPath
from typing import BinaryIO

MAX_DATA_PATHS = 50
MAX_DATA_PATH_CHARS = 1024

REFUSAL_REASONS = frozenset(
    {
        "too_many_paths",
        "path_too_long",
        "not_absolute",
        "unc_path",
        "extended_length_prefix",
        "device_path",
        "alternate_data_stream",
        "short_name_alias",
        "path_traversal",
        "non_canonical",
        "outside_workspace_root",
        "not_found",
        "not_accessible",
        "reparse_point",
        "not_regular_file",
        "hard_link",
        "identity_mismatch",
        "platform_unsupported",
    }
)

_FILE_ATTRIBUTE_REPARSE_POINT = 0x400
_OPEN_FLAGS = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOINHERIT", 0)
_DRIVE_ABSOLUTE = re.compile(r"^[A-Za-z]:\\")
# An 8.3 alias: up to six characters, a tilde and a number, and an optional short extension.
_SHORT_NAME = re.compile(r"^[^.~]{1,6}~[0-9]+(\.[^.]{0,3})?$")
_INVALID_CHARS = re.compile(r'[\x00-\x1f<>"|?*]')
_RESERVED_NAMES = frozenset(
    {"CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"}
    | {f"{device}{suffix}" for device in ("COM", "LPT") for suffix in "0123456789\u00b9\u00b2\u00b3"}
)


class DataPathRefusal(Exception):
    """A typed refusal of one ``data_paths`` entry (or of the list, when ``index`` is None)."""

    def __init__(self, reason: str, index: int | None) -> None:
        if reason not in REFUSAL_REASONS:
            raise ValueError(f"unknown data path refusal reason: {reason}")
        super().__init__(reason, index)
        self.reason = reason
        self.index = index

    def __str__(self) -> str:
        where = "local data paths" if self.index is None else f"local data path {self.index}"
        return f"{where} refused: {self.reason}"


@dataclass(frozen=True)
class AuthorizedFile:
    """One validated file and the identity its handle had at validation."""

    index: int
    path: Path
    final_path: str
    volume_serial: int
    file_index: int


def lexical_data_path(raw: str, index: int, root: PureWindowsPath) -> PureWindowsPath:
    """Classify one entry from its text alone; no filesystem access."""
    text = raw.replace("/", "\\")
    if not text.strip():
        raise DataPathRefusal("not_absolute", index)
    if text.startswith(("\\\\?\\", "\\??\\")):
        raise DataPathRefusal("extended_length_prefix", index)
    if text.startswith("\\\\.\\"):
        raise DataPathRefusal("device_path", index)
    if text.startswith("\\\\"):
        raise DataPathRefusal("unc_path", index)
    if not _DRIVE_ABSOLUTE.match(text):
        raise DataPathRefusal("not_absolute", index)
    components = text[3:].split("\\")
    if any(component in (".", "..") for component in components):
        raise DataPathRefusal("path_traversal", index)
    for component in components:
        _classify_component(component, index)
    path = PureWindowsPath(text)
    if not _strictly_under(path, root):
        raise DataPathRefusal("outside_workspace_root", index)
    return path


def authorize_data_paths(raw_paths: Sequence[str], root: Path) -> tuple[AuthorizedFile, ...]:
    """Authorize every entry or refuse the whole request on the first failure."""
    if len(raw_paths) > MAX_DATA_PATHS:
        raise DataPathRefusal("too_many_paths", None)
    for index, raw in enumerate(raw_paths):
        if len(raw) > MAX_DATA_PATH_CHARS:
            raise DataPathRefusal("path_too_long", index)
    windows_root = PureWindowsPath(str(root))
    lexical = [lexical_data_path(raw, index, windows_root) for index, raw in enumerate(raw_paths)]
    if not lexical:
        return ()
    if sys.platform != "win32":
        raise DataPathRefusal("platform_unsupported", 0)
    authorized: list[AuthorizedFile] = []
    seen: set[tuple[int, int]] = set()
    for index, path in enumerate(lexical):
        file = _authorize_on_disk(path, index)
        if (file.volume_serial, file.file_index) not in seen:
            seen.add((file.volume_serial, file.file_index))
            authorized.append(file)
    return tuple(authorized)


def open_authorized(file: AuthorizedFile) -> BinaryIO:
    """Open ``file`` for reading only if its handle still has the validated identity."""
    if sys.platform != "win32":
        raise DataPathRefusal("platform_unsupported", file.index)
    fd = _open(file.path, file.index)
    try:
        observed, final_path = _observe(fd)
        if (
            final_path != file.final_path
            or observed.st_dev != file.volume_serial
            or observed.st_ino != file.file_index
            or observed.st_nlink != 1
            or not stat.S_ISREG(observed.st_mode)
        ):
            raise DataPathRefusal("identity_mismatch", file.index)
        return os.fdopen(fd, "rb")
    except BaseException:
        os.close(fd)
        raise


def _classify_component(component: str, index: int) -> None:
    if not component:
        raise DataPathRefusal("non_canonical", index)
    if ":" in component:
        raise DataPathRefusal("alternate_data_stream", index)
    if _INVALID_CHARS.search(component) or component.endswith((".", " ")):
        raise DataPathRefusal("non_canonical", index)
    if component.split(".", 1)[0].rstrip(" ").upper() in _RESERVED_NAMES:
        raise DataPathRefusal("device_path", index)
    if _SHORT_NAME.fullmatch(component):
        raise DataPathRefusal("short_name_alias", index)


def _strictly_under(path: PureWindowsPath, root: PureWindowsPath) -> bool:
    root_parts = [part.casefold() for part in root.parts]
    path_parts = [part.casefold() for part in path.parts]
    return len(path_parts) > len(root_parts) and path_parts[: len(root_parts)] == root_parts


def _authorize_on_disk(path: PureWindowsPath, index: int) -> AuthorizedFile:
    current = Path(path.anchor)
    leaf: os.stat_result | None = None
    for part in path.parts[1:]:
        current = current / part
        try:
            leaf = os.lstat(current)
        except FileNotFoundError:
            raise DataPathRefusal("not_found", index) from None
        except OSError:
            raise DataPathRefusal("not_accessible", index) from None
        if leaf.st_file_attributes & _FILE_ATTRIBUTE_REPARSE_POINT:
            raise DataPathRefusal("reparse_point", index)
    if leaf is None or not stat.S_ISREG(leaf.st_mode):
        raise DataPathRefusal("not_regular_file", index)
    if leaf.st_nlink != 1:
        raise DataPathRefusal("hard_link", index)

    fd = _open(current, index)
    try:
        observed, final_path = _observe(fd)
    finally:
        os.close(fd)
    if observed.st_nlink != 1:
        raise DataPathRefusal("hard_link", index)
    if final_path != os.path.normcase(str(current)):
        raise DataPathRefusal("non_canonical", index)
    if (observed.st_dev, observed.st_ino) != (leaf.st_dev, leaf.st_ino):
        raise DataPathRefusal("identity_mismatch", index)
    return AuthorizedFile(
        index=index,
        path=current,
        final_path=final_path,
        volume_serial=observed.st_dev,
        file_index=observed.st_ino,
    )


def _open(path: Path, index: int) -> int:
    try:
        return os.open(path, _OPEN_FLAGS)
    except FileNotFoundError:
        raise DataPathRefusal("not_found", index) from None
    except OSError:
        raise DataPathRefusal("not_accessible", index) from None


def _observe(fd: int) -> tuple[os.stat_result, str]:
    return os.fstat(fd), os.path.normcase(_final_path(fd))


def _final_path(fd: int) -> str:
    import ctypes
    import msvcrt

    handle = msvcrt.get_osfhandle(fd)
    size = 512
    while True:
        buffer = ctypes.create_unicode_buffer(size)
        # FILE_NAME_NORMALIZED | VOLUME_NAME_DOS
        length = _get_final_path_name()(handle, buffer, size, 0)
        if length == 0:
            raise ctypes.WinError(ctypes.get_last_error())
        if length < size:
            break
        size = length + 1
    value = buffer.value
    if value.startswith("\\\\?\\UNC\\"):
        return "\\\\" + value[len("\\\\?\\UNC\\") :]
    if value.startswith("\\\\?\\"):
        return value[len("\\\\?\\") :]
    return value


@functools.cache
def _get_final_path_name() -> Callable[..., int]:
    import ctypes
    from ctypes import wintypes

    function = ctypes.WinDLL("kernel32", use_last_error=True).GetFinalPathNameByHandleW
    function.argtypes = [wintypes.HANDLE, wintypes.LPWSTR, wintypes.DWORD, wintypes.DWORD]
    function.restype = wintypes.DWORD
    return function  # type: ignore[no-any-return]


__all__ = [
    "MAX_DATA_PATHS",
    "MAX_DATA_PATH_CHARS",
    "REFUSAL_REASONS",
    "AuthorizedFile",
    "DataPathRefusal",
    "authorize_data_paths",
    "lexical_data_path",
    "open_authorized",
]
