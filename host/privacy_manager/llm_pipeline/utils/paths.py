"""Shared path utilities for the llm-pipeline service."""
import os
import stat
from pathlib import Path
from typing import BinaryIO, NamedTuple

from llm_pipeline.utils.logger import setup_logger

logger = setup_logger(__name__)

# Output base: ~/SuperClawProjects on the Windows host.
WORKSPACE_ROOT = Path(
    os.environ.get("WINDOWS_SUPERCLAW_PATH") or Path.home() / "SuperClawProjects"
)


class FileIdentity(NamedTuple):
    """Filesystem identity used to detect replacement of an authorized file."""

    device: int
    inode: int
    size: int
    modified_ns: int


def capture_file_identity(source_file_path: str | Path) -> FileIdentity:
    """Capture stable metadata for an existing regular file."""
    path = Path(source_file_path)
    stat = path.stat()
    if not path.is_file():
        raise ValueError("Source path is not an authorized file.")
    return FileIdentity(
        device=stat.st_dev,
        inode=stat.st_ino,
        size=stat.st_size,
        modified_ns=stat.st_mtime_ns,
    )


def capture_open_file_identity(source_file: BinaryIO) -> FileIdentity:
    """Capture identity from an open handle so pathname swaps cannot race it."""
    stat = os.fstat(source_file.fileno())
    return FileIdentity(
        device=stat.st_dev,
        inode=stat.st_ino,
        size=stat.st_size,
        modified_ns=stat.st_mtime_ns,
    )


def verify_file_identity(
    source_file_path: str | Path, expected_identity: FileIdentity
) -> None:
    """Reject a file whose identity changed after authorization."""
    try:
        current_identity = capture_file_identity(source_file_path)
    except (OSError, RuntimeError, ValueError) as exc:
        raise ValueError("Source file changed after authorization.") from exc
    if current_identity != expected_identity:
        raise ValueError("Source file changed after authorization.")


def verify_open_file_identity(
    source_file: BinaryIO, expected_identity: FileIdentity
) -> None:
    """Reject an opened handle that is not the file authorized by the route."""
    if capture_open_file_identity(source_file) != expected_identity:
        raise ValueError("Source file changed after authorization.")


class ReparsePointError(OSError):
    """A path under ``WORKSPACE_ROOT`` goes through a symlink, junction or other reparse point."""


def reject_reparse_components(path: Path) -> None:
    """Refuse ``path`` if a component below ``WORKSPACE_ROOT`` is a reparse point (#3666).

    A sandbox tier can plant a junction inside the workspace; an owner-side
    write that follows it lands wherever the junction points. Components that
    do not exist yet are fine (the caller creates them as real directories),
    and paths outside ``WORKSPACE_ROOT`` are not checked.

    Point-in-time check: a component swapped for a junction between this call
    and the caller's open is still followed. That check-to-use race is a known
    residual.
    """
    root = Path(os.path.abspath(WORKSPACE_ROOT))
    try:
        relative = Path(os.path.abspath(path)).relative_to(root)
    except ValueError:
        return
    current = root
    for part in relative.parts:
        current = current / part
        try:
            info = current.lstat()
        except (FileNotFoundError, NotADirectoryError):
            return
        if stat.S_ISLNK(info.st_mode) or (
            getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT
        ):
            logger.warning(
                "Refused a reparse point under the workspace root: {}", current.relative_to(root)
            )
            raise ReparsePointError("Refusing to follow a link or junction under the workspace root.")


def resolve_workspace_path(source_file_path: str) -> str:
    """
    Map a container /workspace/ path to the Windows host path.

    The container mounts ``~/SuperClawProjects`` as ``/workspace``.
    Paths not under /workspace are returned unchanged.

    Examples:
        ``/workspace/data.xlsx``     → ``~/SuperClawProjects/data.xlsx``
        ``workspace/sub/data.xlsx``  → ``~/SuperClawProjects/sub/data.xlsx``
        ``/workspace``               → ``~/SuperClawProjects``
        ``C:/any/other/path``        → unchanged
    """
    normalized = source_file_path.replace("\\", "/").strip()

    if normalized == "/workspace":
        return str(WORKSPACE_ROOT)

    if normalized.startswith("/workspace/"):
        relative = normalized[len("/workspace/"):]
        return str(WORKSPACE_ROOT / relative)

    if normalized.startswith("workspace/"):
        relative = normalized[len("workspace/"):]
        return str(WORKSPACE_ROOT / relative)

    return source_file_path


def resolve_confined_workspace_file(source_file_path: str) -> Path:
    """Resolve an existing file while confining it to ``WORKSPACE_ROOT``.

    Both the lexical path and the link-resolved target must remain under the
    workspace. This rejects traversal as well as symlink and junction escapes.
    """
    if not isinstance(source_file_path, str) or not source_file_path.strip():
        raise ValueError("Source path is not an allowed workspace file.")

    normalized = source_file_path.replace("\\", "/").strip()
    if normalized == "/workspace":
        mapped = WORKSPACE_ROOT
    elif normalized.startswith("/workspace/"):
        mapped = WORKSPACE_ROOT / normalized[len("/workspace/"):]
    elif normalized.startswith("workspace/"):
        mapped = WORKSPACE_ROOT / normalized[len("workspace/"):]
    else:
        mapped = Path(source_file_path)
        if not mapped.is_absolute():
            raise ValueError("Source path is not an allowed workspace file.")

    try:
        lexical_root = Path(os.path.abspath(WORKSPACE_ROOT))
        lexical_path = Path(os.path.abspath(mapped))
        resolved_root = WORKSPACE_ROOT.resolve(strict=True)
        resolved_path = mapped.resolve(strict=True)
        lexical_path.relative_to(lexical_root)
        resolved_path.relative_to(resolved_root)
    except (OSError, RuntimeError, ValueError) as exc:
        raise ValueError("Source path is not an allowed workspace file.") from exc

    if not resolved_path.is_file():
        raise ValueError("Source path is not an allowed workspace file.")
    return resolved_path


def resolve_authorized_source_file(
    source_file_path: str,
    authorized_source_file_path: str | Path | None = None,
    authorized_source_file_identity: FileIdentity | None = None,
) -> Path:
    """Resolve a source against trusted request authorization state.

    Integrated Privacy Manager requests provide the exact canonical file that
    passed configured ``source_roots`` validation. Standalone callers without
    that state remain confined to the default workspace.
    """
    if authorized_source_file_path is None:
        if authorized_source_file_identity is not None:
            raise ValueError("Source path is not an authorized file.")
        return resolve_confined_workspace_file(source_file_path)
    if authorized_source_file_identity is None:
        raise ValueError("Source path is not an authorized file.")

    try:
        source = Path(source_file_path).resolve(strict=True)
        # This value is the canonical identity captured by the route before
        # pipeline execution. Do not resolve it again after a possible swap.
        authorized = Path(os.path.abspath(authorized_source_file_path))
    except (OSError, RuntimeError, ValueError) as exc:
        raise ValueError("Source path is not an authorized file.") from exc

    if source != authorized or not source.is_file():
        raise ValueError("Source path is not an authorized file.")
    verify_file_identity(source, authorized_source_file_identity)
    return source
