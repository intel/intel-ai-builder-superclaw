"""In-place staging of a trusted native payload into its stable, governed runtime root.

The managed payload directory is one fixed path, `backend/payload/current`, and this module
updates what is *inside* it. Nothing here replaces, renames or re-creates the root itself:
the elevated provisioning step gives that directory a protected DACL exactly once, the
launcher re-reads that DACL on every start, and the tier accounts' read/execute grant is
inheritable, so a file this module writes under the root receives it from NTFS. That is why a
payload content change needs no new elevation, and also why the copy must be written through
paths inside the root: a file renamed in from outside keeps the ACL it was created with and
would carry no tier access at all.
"""

from __future__ import annotations

from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from contextlib import AbstractContextManager, nullcontext
from dataclasses import dataclass
import errno
import os
from pathlib import Path
import shutil
import stat
import threading
import time
from typing import Any, Protocol
from uuid import uuid4

from loguru import logger

from .native_isolation.paths import PAYLOAD_DIRECTORY_NAME
from .payload_integrity import (
    PAYLOAD_MANIFEST_NAME,
    PayloadIntegrityError,
    VerifiedPayload,
    payload_content_fingerprint,
    payload_roster,
    verify_payload,
)
from .startup_diagnostics import startup_stage

_PAYLOAD_CONTAINER_NAME = "payload"
_REPARSE_ATTRIBUTE = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
_DIRECTORY_ATTRIBUTE = getattr(stat, "FILE_ATTRIBUTE_DIRECTORY", 0)
_LOCKED_PATHS_REPORTED = 5
_ERROR_ACCESS_DENIED = 5
_ERROR_SHARING_VIOLATION = 32
_EXTENDED_PREFIX = "\\\\?\\"
_DELETING_SUFFIX = ".deleting"


def _is_link(entry: os.DirEntry[str], metadata: os.stat_result) -> bool:
    attributes = getattr(metadata, "st_file_attributes", 0)
    return entry.is_symlink() or bool(attributes & _REPARSE_ATTRIBUTE)


class NativePayloadDestination(Protocol):
    config_root: str
    payload_root: str
    payload_version: str


class PayloadInUseError(PayloadIntegrityError):
    """A file the update must replace or delete is held open: the backend is probably running."""

    def __init__(self, message: str) -> None:
        super().__init__(message, reason="payload_in_use")


def stage_verified_payload(
    source: VerifiedPayload, path_set: NativePayloadDestination
) -> VerifiedPayload:
    """Bring the payload selected by NativePathSet up to `source`, verifying what lands there.

    Either outcome checks the manifest, the inventory and every member's size of the tree at
    the managed root, and requires its roster fingerprint to equal the source's. The
    fingerprint - not the path, which never changes - is what decides whether the published
    tree is the wanted one: a match is reused untouched, anything else is updated in place.

    The update is neither atomic nor side by side. It may only run while the backend is
    stopped, because it replaces and deletes files that running roles hold open. That rule is
    enforced only by a heuristic: before the first change every file to be replaced or deleted
    is opened for writing, which a running executable or loaded DLL refuses, and if any does
    this raises `PayloadInUseError` without having modified anything. A file another process
    holds open with full sharing passes the probe, and a read-only file is not probed; those
    fail during the update instead, which is repaired at the next start. It does not check that
    the backend is stopped. Links are removed rather than followed only for a static tree: a
    process running as the same user could swap a directory between the scan and the delete or
    copy, which is not an escalation because that user owns this root. To keep an
    interrupted update detectable, the destination manifest is deleted before the first change
    and written after the last: a tree without its manifest cannot pass `verify_payload`, so
    the next start repairs it instead of trusting a half-updated one. Only members whose
    manifest entry changed are rewritten, and only when the previous tree still verified.
    """
    # Staging is the largest measured startup stage. Time the whole thing and record which
    # branch ran, so a reused destination is not mistaken for a free cache hit - it still
    # reads the destination's manifest and walks its inventory.
    with startup_stage("stage_payload") as counts:
        return stage_payload_members(
            source,
            path_set,
            lambda: nullcontext(_tree_members(source)),
            counts,
            source_root=source.payload_root,
        )


@dataclass(frozen=True)
class PayloadMembers:
    """The wanted payload as an in-place update reads it, whatever holds its bytes."""

    roster: dict[str, tuple[str, int, str]]
    directories: list[str]
    files: list[str]
    copy: Callable[[str, Path], None]
    manifest: bytes
    # How many members `copy` may write at once; above 1 only if it is safe across threads.
    workers: int = 1
    # Runs once the in-use probe has passed and before the first change to the root.
    before_writing: Callable[[], None] | None = None


class PayloadIdentity(Protocol):
    payload_version: str
    file_count: int
    content_fingerprint: str


def _tree_members(source: VerifiedPayload) -> PayloadMembers:
    root = source.payload_root
    # Before the first change to the root, so a source that was swapped after setup costs nothing.
    if payload_content_fingerprint(root) != source.content_fingerprint:
        raise PayloadIntegrityError(
            "payload source content does not match the verified source"
        )
    directories, files = _walk_source(root)
    return PayloadMembers(
        roster=payload_roster(root),
        directories=directories,
        files=files,
        copy=lambda relative, target: shutil.copy2(root / relative, target),
        manifest=(root / PAYLOAD_MANIFEST_NAME).read_bytes(),
    )


def stage_payload_members(
    source: PayloadIdentity,
    path_set: NativePayloadDestination,
    open_members: Callable[[], AbstractContextManager[PayloadMembers]],
    counts: dict[str, Any],
    *,
    source_root: Path | None = None,
) -> VerifiedPayload:
    """`stage_verified_payload` for any source; `open_members` runs only if the root must change."""
    destination = Path(path_set.payload_root)
    # In-place pruning deletes whatever the payload does not list, so it must never be
    # pointed at any other directory. The check ties `payload_root` to the backend root the
    # path set was built for, so an arbitrary `payload/current` is an error, not a deletion.
    if path_set.payload_version != PAYLOAD_DIRECTORY_NAME or not _is_managed_payload_root(
        destination, Path(path_set.config_root)
    ):
        raise PayloadIntegrityError(
            "NativePathSet payload_version does not match the managed payload directory"
        )
    if source_root is not None:
        _require_non_overlapping_roots(source_root, destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    _require_plain_existing_ancestry(destination.parent)

    published: dict[str, tuple[str, int, str]] | None = None
    existed = os.path.lexists(destination)
    if existed:
        # Never write through a link standing where the root should be.
        _require_plain_directory(destination)
        started = time.perf_counter()
        staged = _verified_or_none(destination)
        counts["check_ms"] = _elapsed_ms(started)
        if staged is not None:
            if staged.content_fingerprint == source.content_fingerprint:
                # Nothing is copied, so the source is never re-read on this path - what
                # establishes the tree about to execute is the destination's own verification.
                counts["outcome"] = "reused_destination"
                counts["files"] = staged.file_count
                return staged
            published = payload_roster(destination)

    started = time.perf_counter()
    with open_members() as members:
        counts["open_ms"] = _elapsed_ms(started)
        if not existed:
            # Created once, as the owner, before the elevated step gives it its protected DACL;
            # the broker requires an owner-owned root to exist and never creates it.
            destination.mkdir()

        counts["files"] = source.file_count
        counts["outcome"] = (
            "updated_in_place" if _has_children(destination) else "copied"
        )
        # `files` is the payload's member count; `copied` is how many of them were written.
        with startup_stage(
            "copy_payload", files=source.file_count, workers=members.workers
        ) as copy_counts:
            _update_in_place(members, destination, published, copy_counts)

    started = time.perf_counter()
    staged = verify_payload(destination)
    counts["verify_ms"] = _elapsed_ms(started)
    if staged.payload_version != source.payload_version:
        raise PayloadIntegrityError("staged payload version does not match its source")
    if staged.content_fingerprint != source.content_fingerprint:
        raise PayloadIntegrityError("staged payload content does not match the verified source")
    _require_plain_directory(destination)
    return staged


def _is_managed_payload_root(path: Path, config_root: Path) -> bool:
    """Whether `path` is `<backend>/payload/current` for the backend that owns `config_root`."""
    return (
        path.name.casefold() == PAYLOAD_DIRECTORY_NAME
        and path.parent.name.casefold() == _PAYLOAD_CONTAINER_NAME
        and config_root.name.casefold() == "config"
        and os.path.normcase(str(path.parent.parent)) == os.path.normcase(str(config_root.parent))
    )


def _has_children(directory: Path) -> bool:
    try:
        with os.scandir(directory) as entries:
            return next(entries, None) is not None
    except FileNotFoundError:
        return False


def _verified_or_none(destination: Path) -> VerifiedPayload | None:
    """The published payload if it verifies, None when it is absent, partial or damaged.

    An update that was interrupted (no manifest), a tree that lost or gained a member, or one
    whose sizes disagree with its manifest is not an error to stop on any more: the root is
    stable, so the only way forward is to make it right in place.
    """
    try:
        return verify_payload(destination)
    except PayloadIntegrityError:
        return None


def _elapsed_ms(started: float) -> int:
    return round((time.perf_counter() - started) * 1000)


def _update_in_place(
    members: PayloadMembers,
    destination: Path,
    published: dict[str, tuple[str, int, str]] | None,
    counts: dict[str, Any],
) -> None:
    """Write what differs from `published`, recording what was written and each sub-stage's time."""
    started = time.perf_counter()
    wanted = members.roster
    source_dirs, source_files = members.directories, members.files

    def unchanged(relative: str) -> bool:
        key = relative.casefold()
        return (
            published is not None
            and key in published
            and key in wanted
            and published[key][1:] == wanted[key][1:]
        )

    to_copy = [relative for relative in source_files if not unchanged(relative)]
    keep_files = {relative.casefold() for relative in source_files}
    keep_dirs = {relative.casefold() for relative in source_dirs}
    doomed_files, doomed_dirs = _unlisted_entries(destination, keep_files, keep_dirs)
    # An empty root - the first start after an install - holds nothing to probe or replace,
    # and the probe and the discard each cost one failed lstat per member, ~0.7 s per pass on the
    # installed payload.
    occupied = _has_children(destination)
    counts["copied"] = len(to_copy)
    counts["copied_bytes"] = sum(
        wanted[relative.casefold()][1] for relative in to_copy if relative.casefold() in wanted
    )
    counts["deleted"] = len(doomed_files) + len(doomed_dirs)
    counts["plan_ms"] = _elapsed_ms(started)
    started = time.perf_counter()

    # Every existing file the update is about to overwrite or delete, checked before the first
    # change so that a running backend costs nothing but a refusal.
    touched = (
        (
            *doomed_files,
            *(destination / relative for relative in to_copy),
            destination / PAYLOAD_MANIFEST_NAME,
        )
        if occupied
        else ()
    )
    locked: list[Path] = []
    for path in touched:
        if not _is_regular_file(path):
            continue
        error = _write_probe(path)
        if error == _ERROR_SHARING_VIOLATION:
            locked.append(path)
        elif error and os.access(path, os.W_OK):
            # Not the read-only attribute, not a sharing violation: a permission problem, which
            # stopping the backend will not fix.
            raise _access_denied_error(destination, path)
    if locked:
        raise _in_use_error(destination, len(locked), locked)
    counts["probe_ms"] = _elapsed_ms(started)
    if members.before_writing is not None:
        # The installed archive's whole-file hash, for one.
        started = time.perf_counter()
        members.before_writing()
        counts["before_writing_ms"] = _elapsed_ms(started)
    started = time.perf_counter()

    def replace(relative: str) -> None:
        target = destination / relative
        if occupied:
            _remove(target)
        members.copy(relative, target)

    try:
        # From here on the tree is inconsistent until the manifest is written back, and
        # without a manifest it cannot verify: that is how an interruption is detected.
        _remove(destination / PAYLOAD_MANIFEST_NAME)
        for path in doomed_files:
            _remove(path)
        for path in doomed_dirs:
            os.rmdir(path)
        for relative in source_dirs:
            _ensure_plain_directory(destination / relative)
        _run_bounded(replace, to_copy, members.workers)
        _write_manifest(members.manifest, destination)
        counts["write_ms"] = _elapsed_ms(started)
    except PermissionError as exc:
        if getattr(exc, "winerror", None) == _ERROR_SHARING_VIOLATION:
            raise PayloadInUseError(
                f"the managed payload update stopped because {exc.filename} is in use; "
                "the next start repairs the tree. Stop the backend and its roles, then start again."
            ) from exc
        # Windows also reports deleting a running executable as access denied, so this cannot
        # tell a running backend from a permission problem; it says both.
        raise PayloadIntegrityError(
            f"the managed payload update stopped: access denied on {exc.filename}. The file is "
            "either used by a running process (stop the backend and its roles) or its permissions "
            "refuse the current user; the next start repairs the tree.",
            reason="payload_io_error",
        ) from exc


def _run_bounded(task: Callable[[str], None], items: list[str], workers: int) -> None:
    """Call `task` for every item on up to `workers` threads, raising the first failure.

    After a failure no thread starts another item, and this returns only once every thread has
    stopped, so nothing is still writing into the root when the caller handles the error.
    """
    if workers <= 1 or len(items) <= 1:
        for item in items:
            task(item)
        return
    remaining = iter(items)
    lock = threading.Lock()
    failures: list[BaseException] = []

    def drain() -> None:
        while True:
            with lock:
                item = None if failures else next(remaining, None)
            if item is None:
                return
            try:
                task(item)
            except BaseException as exc:  # noqa: BLE001 - raised on the calling thread below
                with lock:
                    failures.append(exc)
                return

    count = min(workers, len(items))
    with ThreadPoolExecutor(count, thread_name_prefix="payload-copy") as pool:
        for _ in range(count):
            pool.submit(drain)
    if failures:
        raise failures[0]


def _write_manifest(manifest: bytes, destination: Path) -> None:
    """Publish `manifest` last, through a temporary name inside the root."""
    pending = destination / f".manifest-{uuid4().hex[:12]}.tmp"
    try:
        pending.write_bytes(manifest)
        os.replace(pending, destination / PAYLOAD_MANIFEST_NAME)
    finally:
        pending.unlink(missing_ok=True)


def _access_denied_error(destination: Path, path: Path) -> PayloadIntegrityError:
    return PayloadIntegrityError(
        f"the managed payload was not modified: access denied opening "
        f"{path.relative_to(destination)} for writing, and it is not in use. "
        "Check the file's permissions.",
        reason="payload_io_error",
    )


def _in_use_error(destination: Path, count: int, paths: list[Path]) -> PayloadInUseError:
    shown = ", ".join(
        str(path.relative_to(destination)) for path in paths[:_LOCKED_PATHS_REPORTED]
    )
    return PayloadInUseError(
        f"the managed payload is in use and was not modified: {count} file(s) that the update "
        f"must replace or delete are held open by a running process (first: {shown}). "
        "The payload can only be updated while the backend is stopped; stop the backend and "
        "its roles, then start again."
    )


def _walk_source(root: Path) -> tuple[list[str], list[str]]:
    """The source's directories and files as relative POSIX paths, manifest excluded."""
    directories: list[str] = []
    files: list[str] = []

    def visit(directory: Path, prefix: str) -> None:
        with os.scandir(directory) as entries:
            for entry in entries:
                relative = f"{prefix}{entry.name}"
                if relative == PAYLOAD_MANIFEST_NAME:
                    continue
                metadata = entry.stat(follow_symlinks=False)
                if _is_link(entry, metadata):
                    raise PayloadIntegrityError(
                        f"payload may not contain reparse points: {relative}"
                    )
                if stat.S_ISDIR(metadata.st_mode):
                    directories.append(relative)
                    visit(Path(entry.path), f"{relative}/")
                elif stat.S_ISREG(metadata.st_mode):
                    files.append(relative)
                else:
                    raise PayloadIntegrityError(f"payload contains a non-file path: {relative}")

    visit(root, "")
    return directories, files


def _unlisted_entries(
    root: Path, keep_files: set[str], keep_dirs: set[str]
) -> tuple[list[Path], list[Path]]:
    """What is under `root` that the wanted payload does not contain.

    Returns `(files_and_links, directories)`, directories deepest first so each is empty by the
    time it is removed. A link is always doomed, even where the wanted payload has a file of
    that name, so nothing is ever written through one.
    """
    files: list[Path] = []
    directories: list[Path] = []

    def visit(directory: Path, prefix: str) -> None:
        with os.scandir(directory) as entries:
            for entry in entries:
                relative = f"{prefix}{entry.name}"
                if relative == PAYLOAD_MANIFEST_NAME:
                    continue
                metadata = entry.stat(follow_symlinks=False)
                key = relative.casefold()
                path = Path(entry.path)
                if _is_link(entry, metadata):
                    files.append(path)
                elif stat.S_ISDIR(metadata.st_mode):
                    visit(path, f"{relative}/")
                    if key not in keep_dirs:
                        directories.append(path)
                elif key not in keep_files:
                    files.append(path)

    visit(root, "")
    return files, directories


def _is_regular_file(path: Path) -> bool:
    try:
        return stat.S_ISREG(path.lstat().st_mode)
    except OSError:
        return False


def _write_probe(path: Path) -> int:
    """Open the file for writing without changing anything; 0 or the Win32 error code.

    Sharing violation (32) is what a running executable or loaded DLL gives; access denied (5)
    is a permission problem or the read-only attribute. The CRT `open` reports both as
    EACCES, so on Windows this asks `CreateFileW` directly.
    """
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateFileW.restype = wintypes.HANDLE
        kernel32.CreateFileW.argtypes = [
            wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID,
            wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE,
        ]
        generic_write, share_all, open_existing, normal = 0x40000000, 7, 3, 0x80
        handle = kernel32.CreateFileW(
            str(path), generic_write, share_all, None, open_existing, normal, None
        )
        if handle in (None, wintypes.HANDLE(-1).value):
            return ctypes.get_last_error()
        kernel32.CloseHandle(handle)
        return 0
    try:
        with open(path, "r+b"):
            return 0
    except OSError as exc:
        return _ERROR_SHARING_VIOLATION if exc.errno == errno.ETXTBSY else _ERROR_ACCESS_DENIED


def _remove(path: Path) -> None:
    """Delete a file, a link or a read-only file; a missing path is already done."""
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return
    if getattr(metadata, "st_file_attributes", 0) & _DIRECTORY_ATTRIBUTE and not stat.S_ISREG(
        metadata.st_mode
    ):
        os.rmdir(path)
        return
    try:
        path.unlink()
    except PermissionError:
        os.chmod(path, stat.S_IREAD | stat.S_IWRITE)
        path.unlink()


def remove_legacy_payload_dirs(payload_container: Path, keep: int) -> int:
    """Delete the per-version payload directories that predate `payload/current`; bytes freed.

    Before the stable root every payload version got its own `payload/<name>` directory and
    nothing ever removed them. Nothing writes them now and nothing points at them, so every
    plain directory directly under `payload_container` other than `current` is leftover. The
    `keep` (>= 0, the caller clamps it) most recently modified are spared; `current` is never
    touched and never counts.

    Best effort, meant for a background thread, and nothing here raises. Each directory is
    first renamed to `<name>.deleting`, and only then emptied. Windows refuses to rename a
    directory with a file open inside it, so one still in use by a running process is left
    whole and retried next start. A `.deleting` directory left half-emptied by an earlier run
    is finished off regardless of `keep`. A link directly under the container is skipped
    rather than followed; a link met inside a legacy directory is removed as a link, never
    entered.
    """
    legacy: list[tuple[float, str]] = []
    leftovers: list[str] = []
    try:
        with os.scandir(payload_container) as entries:
            for entry in entries:
                if entry.name.casefold() == PAYLOAD_DIRECTORY_NAME:
                    continue
                try:
                    metadata = entry.stat(follow_symlinks=False)
                except OSError:
                    continue
                if _is_link(entry, metadata) or not stat.S_ISDIR(metadata.st_mode):
                    continue
                if entry.name.endswith(_DELETING_SUFFIX):
                    leftovers.append(entry.name)
                else:
                    legacy.append((metadata.st_mtime, entry.name))
    except FileNotFoundError:
        return 0
    except OSError as exc:
        logger.warning(
            "native-backend: legacy payload cleanup could not list {}: {}",
            payload_container,
            exc,
        )
        return 0

    legacy.sort(reverse=True)
    freed = 0
    for name in leftovers + [name for _, name in legacy[keep:]]:
        freed += _remove_legacy_dir(payload_container, name)
    if freed:
        logger.info(
            "native-backend: legacy payload cleanup freed {} bytes under {}",
            freed,
            payload_container,
        )
    return freed


def _remove_legacy_dir(payload_container: Path, name: str) -> int:
    """Rename `name` aside and delete it; bytes freed. A directory in use is left untouched."""
    target = payload_container / name
    if not name.endswith(_DELETING_SUFFIX):
        target = payload_container / f"{name}{_DELETING_SUFFIX}"
        try:
            os.rename(_extended_length(payload_container / name), _extended_length(target))
        except OSError as exc:
            logger.warning(
                "native-backend: legacy payload directory {} is in use, will retry next start: {}",
                name,
                exc,
            )
            return 0
    freed, error = _remove_tree(_extended_length(target))
    if error is None:
        logger.info("native-backend: removed legacy payload directory {}", name)
    else:
        logger.warning(
            "native-backend: legacy payload directory {} not fully removed, will retry next "
            "start: {}",
            target.name,
            error,
        )
    return freed


def _extended_length(path: Path) -> str:
    """The Win32 extended-length form, so a deep tree is not limited to MAX_PATH."""
    text = str(path.absolute())
    if os.name != "nt" or text.startswith(_EXTENDED_PREFIX):
        return text
    if text.startswith("\\\\"):
        return _EXTENDED_PREFIX + "UNC\\" + text[2:]
    return _EXTENDED_PREFIX + text


def _remove_tree(directory: str) -> tuple[int, OSError | None]:
    """Delete `directory` and everything in it; (bytes freed, the first error or None).

    Removes what it can and carries on past a file that is in use. The caller has already
    renamed the tree aside, so nothing that needs it is still running from it.
    """
    freed = 0
    first_error: OSError | None = None
    try:
        with os.scandir(directory) as entries:
            children = list(entries)
        for entry in children:
            try:
                metadata = entry.stat(follow_symlinks=False)
                if not _is_link(entry, metadata) and stat.S_ISDIR(metadata.st_mode):
                    removed, error = _remove_tree(entry.path)
                    freed += removed
                    first_error = first_error or error
                else:
                    _remove(Path(entry.path))
                    freed += 0 if _is_link(entry, metadata) else metadata.st_size
            except OSError as exc:
                first_error = first_error or exc
        if first_error is None:
            os.rmdir(directory)
    except OSError as exc:
        first_error = first_error or exc
    return freed, first_error


def _ensure_plain_directory(path: Path) -> None:
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        path.mkdir()
        return
    attributes = getattr(metadata, "st_file_attributes", 0)
    if path.is_symlink() or attributes & _REPARSE_ATTRIBUTE or not stat.S_ISDIR(metadata.st_mode):
        raise PayloadIntegrityError(f"managed payload path is not a plain directory: {path}")


def _require_plain_directory(path: Path) -> None:
    """Refuse a published payload root that is a reparse point rather than a real directory."""
    metadata = path.lstat()
    attributes = getattr(metadata, "st_file_attributes", 0)
    reparse = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
    if path.is_symlink() or attributes & reparse:
        raise PayloadIntegrityError(
            f"managed payload root may not be a reparse point: {path}"
        )
    if not path.is_dir():
        raise PayloadIntegrityError(
            f"managed payload root is not a directory: {path}", reason="payload_root_invalid"
        )


def _require_non_overlapping_roots(source: Path, destination: Path) -> None:
    source_key = os.path.normcase(str(source.resolve()))
    destination_key = os.path.normcase(str(destination.resolve()))
    try:
        common = os.path.commonpath((source_key, destination_key))
    except ValueError:
        return
    if common in {source_key, destination_key}:
        raise PayloadIntegrityError("source and managed payload roots may not overlap")


def _require_plain_existing_ancestry(path: Path) -> None:
    current = path
    while True:
        if current.exists() or current.is_symlink():
            metadata = current.lstat()
            attributes = getattr(metadata, "st_file_attributes", 0)
            reparse = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
            if current.is_symlink() or attributes & reparse:
                raise PayloadIntegrityError(
                    f"managed payload ancestry may not contain reparse points: {current}"
                )
        if current == current.parent:
            return
        current = current.parent
