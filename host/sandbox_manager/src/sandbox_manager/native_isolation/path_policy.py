r"""Lexical Windows path policy and ancestor inspection.

Lexical comparison cannot detect these ways two spellings can name one directory:
- subst drives
- mapped network drives
- per-logon-session drive-letter scope
- junctions and symlinks below an accepted member
- hardlinks
- per-directory NTFS case sensitivity
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path, PureWindowsPath

from contracts.workspace_root_refusal import Reason


class NativePathPolicyError(ValueError):
    """A path is outside the supported local Windows lexical policy."""

    def __init__(
        self,
        message: str,
        *,
        reason: str = Reason.path_not_canonical_local_windows.value,
    ) -> None:
        super().__init__(message)
        self.reason = reason


class NativePathInspectionError(RuntimeError):
    """A Windows filesystem ancestor could not be inspected."""


_LOCAL_PATH_PATTERN = re.compile(
    r"^(?:[A-Za-z]:\\|\\\\\?\\[A-Za-z]:\\)"
    r"(?!(?:[Cc][Oo][Nn]|[Pp][Rr][Nn]|[Aa][Uu][Xx]|[Nn][Uu][Ll]|"
    r"[Cc][Ll][Oo][Cc][Kk]\$|[Cc][Oo][Mm][1-9]|[Ll][Pp][Tt][1-9])"
    r"(?:\.|\\|$))(?!\.{1,2}(?:\\|$))"
    r"[^<>:\"/\\|?*\x00-\x1f]*[^<>:\"/\\|?*\x00-\x1f .]"
    r"(?:\\(?!(?:[Cc][Oo][Nn]|[Pp][Rr][Nn]|[Aa][Uu][Xx]|[Nn][Uu][Ll]|"
    r"[Cc][Ll][Oo][Cc][Kk]\$|[Cc][Oo][Mm][1-9]|[Ll][Pp][Tt][1-9])"
    r"(?:\.|\\|$))(?!\.{1,2}(?:\\|$))"
    r"[^<>:\"/\\|?*\x00-\x1f]*[^<>:\"/\\|?*\x00-\x1f .])*$"
)
_RESERVED_DOS_NAME = re.compile(
    r"^(?:con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\.|$)",
    re.IGNORECASE,
)
_VOLUME_ROOT_PATTERN = re.compile(r"^(?:\\\\\?\\)?[A-Za-z]:\\?$")
_SHORT_NAME_ALIAS = re.compile(r"^[^.]{0,6}~[0-9]{1,6}(?:\.[^.]{1,3})?$")
_FILE_ATTRIBUTE_REPARSE_POINT = 0x400


@dataclass(frozen=True)
class ExistingAncestorInspection:
    """Point-in-time ancestor observations."""

    requested_path: PureWindowsPath
    nearest_existing_ancestor: Path
    reparse_points: tuple[Path, ...]


def normalize_local_windows_path(value: str) -> PureWindowsPath:
    """Return canonical spelling for a supported path."""
    if _VOLUME_ROOT_PATTERN.fullmatch(value):
        raise NativePathPolicyError(
            "a whole volume root is not a managed root",
            reason=Reason.path_is_volume_root.value,
        )
    if not _LOCAL_PATH_PATTERN.fullmatch(value):
        raise NativePathPolicyError(
            "path must be an absolute local Windows drive path with canonical "
            "separators and components"
        )

    ordinary = value.removeprefix("\\\\?\\")
    components = ordinary.split("\\")[1:]
    for component in components:
        if component.endswith((".", " ")):
            raise NativePathPolicyError(
                "path components must not end in a dot or space"
            )
        if _RESERVED_DOS_NAME.match(component):
            raise NativePathPolicyError("reserved DOS device names are not allowed")
        if _SHORT_NAME_ALIAS.fullmatch(component):
            raise NativePathPolicyError(
                "8.3 short-name components are not accepted; supply the long path "
                "spelling",
                reason=Reason.path_uses_short_name_alias.value,
            )

    return PureWindowsPath(ordinary[0].upper() + ordinary[1:])


def paths_equal(left: str, right: str) -> bool:
    """Compare paths case-insensitively."""
    try:
        return comparison_parts(left) == comparison_parts(right)
    except NativePathPolicyError:
        return False


def is_path_within(root: str, candidate: str) -> bool:
    try:
        root_parts = comparison_parts(root)
        candidate_parts = comparison_parts(candidate)
    except NativePathPolicyError:
        return False
    return (
        len(candidate_parts) >= len(root_parts)
        and candidate_parts[: len(root_parts)] == root_parts
    )


def paths_overlap(left: str, right: str) -> bool:
    return is_path_within(left, right) or is_path_within(right, left)


def require_path_within(root: str, candidate: str) -> PureWindowsPath:
    if not is_path_within(root, candidate):
        raise NativePathPolicyError("candidate path escapes its declared root")
    return normalize_local_windows_path(candidate)


def inspect_existing_ancestors(value: str) -> ExistingAncestorInspection:
    """Inspect the nearest existing ancestor and its parent chain.

    Point-in-time only.
    """
    requested = normalize_local_windows_path(value)
    if os.name != "nt":
        raise NativePathInspectionError(
            "existing-ancestor inspection is available only on Windows"
        )

    candidate = Path(str(requested))
    while True:
        try:
            candidate_stat = candidate.lstat()
        except (FileNotFoundError, NotADirectoryError):
            parent = candidate.parent
            if parent == candidate:
                raise NativePathInspectionError(
                    "no existing ancestor was found for the Windows path"
                )
            candidate = parent
        except OSError as exc:
            raise NativePathInspectionError(
                f"failed to inspect Windows path entry: {candidate}"
            ) from exc
        else:
            break

    reparse_points: list[Path] = []
    if _stat_is_reparse_point(candidate_stat):
        reparse_points.append(candidate)
    reparse_points.extend(path for path in candidate.parents if _is_reparse_point(path))
    return ExistingAncestorInspection(
        requested_path=requested,
        nearest_existing_ancestor=candidate,
        reparse_points=tuple(reparse_points),
    )


def comparison_parts(value: str) -> tuple[str, ...]:
    """Return the case-folded, component-bounded parts for comparison."""
    return tuple(part.lower() for part in normalize_local_windows_path(value).parts)


def _is_reparse_point(path: Path) -> bool:
    try:
        path_stat = path.lstat()
    except OSError as exc:
        raise NativePathInspectionError(
            f"failed to inspect Windows ancestor attributes: {path}"
        ) from exc
    return _stat_is_reparse_point(path_stat)


def _stat_is_reparse_point(path_stat: os.stat_result) -> bool:
    try:
        attributes = path_stat.st_file_attributes
    except AttributeError as exc:
        raise NativePathInspectionError(
            "this platform does not report Windows file attributes, so the reparse "
            "state of a path cannot be observed here"
        ) from exc
    return bool(attributes & _FILE_ATTRIBUTE_REPARSE_POINT)
