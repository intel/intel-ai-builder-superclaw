"""Background cleanup job for workspace intermediate files.

Runs as an asyncio task inside the sandbox-manager lifespan. On each wake:
1. Reads enabled + retentionDays from the SandboxManager config store.
2. If disabled, sleeps and tries again next cycle.
3. Resolves SuperClawProjects root from USERPROFILE.
4. Loads the cleanup policy (allowlist).
5. Walks ONLY the allowlisted directories/files and removes entries older than retentionDays. Nothing outside the allowlist is ever touched.

Contract touched: Sandbox (workspace filesystem boundary).
"""

from __future__ import annotations
import asyncio
import fnmatch
import functools
import json
import os
import stat
import threading
import time
from pathlib import Path

from loguru import logger

from .workspace_cleanup import (
    CleanupPattern,
    CleanupPolicy,
    load_cleanup_settings,
    load_cleanup_policy,
)
from typing import TYPE_CHECKING

_POLL_INTERVAL_SECONDS = 3600
_EMERGENCY_RETENTION_DAYS = 1
_cleanup_run_lock = threading.Lock()
_IO_REPARSE_TAG_MOUNT_POINT = getattr(
    stat, "IO_REPARSE_TAG_MOUNT_POINT", 0xA0000003
)
_IO_REPARSE_TAG_SYMLINK = getattr(stat, "IO_REPARSE_TAG_SYMLINK", 0xA000000C)
_FILE_ATTRIBUTE_DIRECTORY = 0x10
_FILE_ATTRIBUTE_REPARSE_POINT = 0x400

if TYPE_CHECKING:
    from .store import Store


def _resolve_superclaw_root(env: dict[str, str] | None = None) -> Path | None:
    resolved_env = env if env is not None else dict(os.environ)
    userprofile = resolved_env.get("USERPROFILE", "").strip()
    if not userprofile:
        logger.debug("USERPROFILE not set; skipping workspace cleanup")
        return None
    root = Path(userprofile) / "SuperClawProjects"
    if not root.exists():
        logger.debug("Workspace root does not exist at {}; skipping", root)
        return None
    return root


def _age_days(path: Path) -> float:
    if _is_link_or_junction(path):
        return 0.0
    try:
        return (time.time() - path.lstat().st_mtime) / 86400
    except OSError:
        return 0.0


def _session_age_days(
    session_path: Path,
    *,
    retention_days: float | None = None,
    cache: dict[Path, float] | None = None,
) -> float:
    """Return the age (in days) of a session directory.

    Windows NTFS does not propagate mtime upward when a file is written: only
    the file's immediate parent directory changes. Writing
    ``session-abc/local_intermediate/chunks/data.json`` leaves both
    ``local_intermediate/`` and ``session-abc/`` stale, so sampling only the
    session root and its direct children reports an actively-written session as
    old. We therefore take the most recent mtime found anywhere in the tree.

    ``retention_days`` turns this into a short-circuit: the scan stops as soon
    as an entry newer than that threshold is found, because the caller only
    needs to know the session is too new to delete. The result is then an upper
    bound on freshness rather than the exact age — exact whenever the session is
    old enough to be deleted, approximate only when it is being kept.

    Links and junctions are never followed, so the scan cannot leave the
    workspace or revisit a directory.
    """
    if cache is not None:
        cached = cache.get(session_path)
        if cached is not None:
            return cached
    if _is_link_or_junction(session_path):
        return 0.0
    try:
        now = time.time()
        most_recent = session_path.lstat().st_mtime
    except OSError:
        return 0.0

    cutoff = None if retention_days is None else now - (retention_days * 86400)

    pending: list[Path] = [session_path]
    while pending:
        if cutoff is not None and most_recent > cutoff:
            break
        current = pending.pop()
        if _is_link_or_junction(current):
            continue
        try:
            with os.scandir(current) as entries:
                for entry in entries:
                    entry_path = Path(entry.path)
                    if _is_link_or_junction(entry_path):
                        continue
                    try:
                        most_recent = max(
                            most_recent, entry.stat(follow_symlinks=False).st_mtime
                        )
                        is_dir = entry.is_dir(follow_symlinks=False)
                    except OSError:
                        continue
                    if is_dir:
                        pending.append(entry_path)
        except OSError:
            continue

    age = max(0.0, (now - most_recent) / 86400)
    if cache is not None:
        cache[session_path] = age
    return age


def _is_link_or_junction(path: Path) -> bool:
    """Return whether *path* is unsafe to traverse as a real directory.

    Classification failures fail closed. On Python 3.11, Windows junctions
    are detected from the no-follow reparse tag because os.path.isjunction is
    only available from Python 3.12.
    """
    try:
        path_stat = path.lstat()
        if stat.S_ISLNK(path_stat.st_mode):
            return True
    except OSError:
        return True

    isjunction = getattr(os.path, "isjunction", None)
    if isjunction is not None:
        try:
            if isjunction(path):
                return True
        except OSError:
            return True

    if os.name != "nt":
        return False

    reparse_tag = getattr(path_stat, "st_reparse_tag", 0)
    boundary_tags = {
        _IO_REPARSE_TAG_MOUNT_POINT,
        _IO_REPARSE_TAG_SYMLINK,
    }
    return reparse_tag in boundary_tags or bool(reparse_tag)


def _open_pinned_directory(path: Path, *, delete_access: bool = False) -> int | None:
    """Open a real Windows directory without allowing it to be replaced."""
    if os.name != "nt":
        return 0 if not _is_link_or_junction(path) else None

    import ctypes
    from ctypes import wintypes

    class _ByHandleFileInformation(ctypes.Structure):
        _fields_ = [
            ("dwFileAttributes", wintypes.DWORD),
            ("ftCreationTime", wintypes.FILETIME),
            ("ftLastAccessTime", wintypes.FILETIME),
            ("ftLastWriteTime", wintypes.FILETIME),
            ("dwVolumeSerialNumber", wintypes.DWORD),
            ("nFileSizeHigh", wintypes.DWORD),
            ("nFileSizeLow", wintypes.DWORD),
            ("nNumberOfLinks", wintypes.DWORD),
            ("nFileIndexHigh", wintypes.DWORD),
            ("nFileIndexLow", wintypes.DWORD),
        ]

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    create_file = kernel32.CreateFileW
    create_file.argtypes = [
        wintypes.LPCWSTR,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.LPVOID,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.HANDLE,
    ]
    create_file.restype = wintypes.HANDLE
    get_information = kernel32.GetFileInformationByHandle
    get_information.argtypes = [
        wintypes.HANDLE,
        ctypes.POINTER(_ByHandleFileInformation),
    ]
    get_information.restype = wintypes.BOOL
    close_handle = kernel32.CloseHandle
    close_handle.argtypes = [wintypes.HANDLE]
    close_handle.restype = wintypes.BOOL

    file_list_directory = 0x0001
    file_read_attributes = 0x0080
    delete = 0x00010000
    file_share_read = 0x0001
    file_share_write = 0x0002
    open_existing = 3
    file_flag_backup_semantics = 0x02000000
    file_flag_open_reparse_point = 0x00200000
    invalid_handle_value = wintypes.HANDLE(-1).value

    handle = create_file(
        str(path),
        file_list_directory | file_read_attributes | (delete if delete_access else 0),
        file_share_read | file_share_write,
        None,
        open_existing,
        file_flag_backup_semantics | file_flag_open_reparse_point,
        None,
    )
    if handle == invalid_handle_value:
        return None

    information = _ByHandleFileInformation()
    if not get_information(handle, ctypes.byref(information)):
        close_handle(handle)
        return None
    if not information.dwFileAttributes & _FILE_ATTRIBUTE_DIRECTORY:
        close_handle(handle)
        return None
    if information.dwFileAttributes & _FILE_ATTRIBUTE_REPARSE_POINT:
        close_handle(handle)
        return None
    return int(handle)


def _close_pinned_directory(handle: int) -> None:
    if os.name == "nt" and handle:
        import ctypes
        from ctypes import wintypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel32.CloseHandle.restype = wintypes.BOOL
        kernel32.CloseHandle(handle)


def _close_pinned_directories(handles: list[int]) -> None:
    for handle in reversed(handles):
        _close_pinned_directory(handle)


def _open_pinned_ancestry(path: Path, *, delete_target: bool = False) -> list[int] | None:
    """Pin every component from the Windows volume root through *path*."""
    if os.name != "nt":
        handle = _open_pinned_directory(path, delete_access=delete_target)
        return None if handle is None else [handle]

    absolute = Path(os.path.abspath(path))
    if not absolute.anchor:
        return None
    current = Path(absolute.anchor)
    paths = [current]
    for part in absolute.parts[1:]:
        current /= part
        paths.append(current)

    handles: list[int] = []
    for index, current in enumerate(paths):
        handle = _open_pinned_directory(
            current,
            delete_access=delete_target and index == len(paths) - 1,
        )
        if handle is None:
            _close_pinned_directories(handles)
            return None
        handles.append(handle)
    return handles


def _open_pinned_descendants(
    path: Path, *, boundary: Path, delete_target: bool
) -> list[int] | None:
    """Pin the components below an ancestry-pinned workspace boundary."""
    try:
        relative_parts = path.relative_to(boundary).parts
    except ValueError:
        return None
    if not relative_parts:
        return None

    handles: list[int] = []
    current = boundary
    for index, part in enumerate(relative_parts):
        current /= part
        handle = _open_pinned_directory(
            current,
            delete_access=delete_target and index == len(relative_parts) - 1,
        )
        if handle is None:
            _close_pinned_directories(handles)
            return None
        handles.append(handle)
    return handles


def _delete_pinned_directory(handle: int) -> bool:
    if os.name != "nt":
        return False

    import ctypes
    from ctypes import wintypes

    class _FileDispositionInfo(ctypes.Structure):
        _fields_ = [("DeleteFile", wintypes.BOOLEAN)]

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    set_information = kernel32.SetFileInformationByHandle
    set_information.argtypes = [
        wintypes.HANDLE,
        ctypes.c_int,
        wintypes.LPVOID,
        wintypes.DWORD,
    ]
    set_information.restype = wintypes.BOOL
    disposition = _FileDispositionInfo(True)
    return bool(
        set_information(
            handle,
            4,  # FileDispositionInfo
            ctypes.byref(disposition),
            ctypes.sizeof(disposition),
        )
    )


def _rmtree_skip_locked(
    path: Path,
    *,
    boundary: Path | None = None,
    pinned_boundary: list[int] | None = None,
) -> tuple[int, int, int, bool]:
    """Remove a directory tree, skipping files that are locked/in-use.

    On Windows, open file handles cause PermissionError / WinError 32 when
    shutil.rmtree tries to delete a file inside the tree.  Instead of failing
    the entire directory, we skip locked entries and delete everything else.

    Returns (files_deleted, files_skipped, freed, root_removed).
    """
    files_deleted = 0
    files_skipped = 0
    bytes_freed = 0
    root_removed = False

    if os.name == "nt":
        if boundary is not None and pinned_boundary:
            pinned_chain = _open_pinned_descendants(
                path, boundary=boundary, delete_target=True
            )
        else:
            pinned_chain = _open_pinned_ancestry(path, delete_target=True)
        if pinned_chain is None:
            return files_deleted, files_skipped, bytes_freed, root_removed
        target_handle = pinned_chain.pop()
    else:
        if _is_link_or_junction(path):
            return files_deleted, files_skipped, bytes_freed, root_removed
        pinned_chain = []
        target_handle = 0

    pending: list[tuple[Path, bool, int]] = [(path, False, target_handle)]
    try:
        while pending:
            current, children_processed, pinned_handle = pending.pop()
            if children_processed:
                if os.name == "nt":
                    removed = _delete_pinned_directory(pinned_handle)
                    _close_pinned_directory(pinned_handle)
                else:
                    try:
                        current.rmdir()
                        removed = True
                    except OSError:
                        removed = False
                if current == path:
                    root_removed = removed
                continue

            try:
                with os.scandir(current) as entries:
                    children = list(entries)
            except OSError as exc:
                _close_pinned_directory(pinned_handle)
                logger.debug("Skipping unreadable directory: {} ({})", current, exc)
                continue

            pending.append((current, True, pinned_handle))
            for entry in children:
                entry_path = Path(entry.path)
                if _is_link_or_junction(entry_path):
                    continue
                try:
                    is_dir = entry.is_dir(follow_symlinks=False)
                except OSError as exc:
                    logger.debug("Skipping unreadable entry: {} ({})", entry_path, exc)
                    continue
                if is_dir:
                    if os.name == "nt":
                        child_handle = _open_pinned_directory(
                            entry_path, delete_access=True
                        )
                        if child_handle is not None:
                            pending.append((entry_path, False, child_handle))
                    else:
                        pending.append((entry_path, False, 0))
                    continue
                try:
                    size = entry.stat(follow_symlinks=False).st_size
                    entry_path.unlink()
                except PermissionError as exc:
                    logger.debug("Skipping locked file: {} ({})", entry_path, exc)
                    files_skipped += 1
                except OSError as exc:
                    logger.debug("Skipping unreadable file: {} ({})", entry_path, exc)
                    files_skipped += 1
                else:
                    files_deleted += 1
                    bytes_freed += size
    finally:
        _close_pinned_directories(pinned_chain)

    return files_deleted, files_skipped, bytes_freed, root_removed


def _glob_to_parts(pattern: str) -> list[str]:
    return [p for p in pattern.rstrip("/").split("/") if p]


def _matches_glob_parts(candidate: list[str], pattern: list[str]) -> bool:
    if not pattern:
        return not candidate
    head, tail = pattern[0], pattern[1:]
    if head == "**":
        return any(
            _matches_glob_parts(candidate[skip:], tail)
            for skip in range(len(candidate) + 1)
        )
    if not candidate:
        return False
    if fnmatch.fnmatch(candidate[0], head):
        return _matches_glob_parts(candidate[1:], tail)
    return False


def _matches_dir_pattern(rel: str, p: CleanupPattern) -> bool:
    if p.pattern_type != "dir_glob":
        return False
    return _matches_glob_parts(
        [s for s in rel.rstrip("/").split("/") if s],
        _glob_to_parts(p.pattern),
    )


def _to_posix_rel(path: Path, base: Path) -> str:
    """Return the POSIX-style relative path of *path* under *base*.

    Returns ``""`` when *path* is outside *base* (ValueError) or equal to *base*
    (which would otherwise return ``"."``). Callers treat both as "root itself".
    """
    try:
        rel = path.relative_to(base).as_posix()
        return "" if rel == "." else rel
    except ValueError:
        return ""


def _dir_stats(path: Path) -> tuple[int, int]:
    """Return ``(total_bytes, file_count)`` for the tree rooted at *path*."""
    total = 0
    files_seen = 0
    if _is_link_or_junction(path):
        return total, files_seen

    pending = [path]
    while pending:
        current = pending.pop()
        if _is_link_or_junction(current):
            continue
        try:
            with os.scandir(current) as entries:
                children = list(entries)
        except OSError:
            continue
        for entry in children:
            entry_path = Path(entry.path)
            if _is_link_or_junction(entry_path):
                continue
            try:
                if entry.is_dir(follow_symlinks=False):
                    pending.append(entry_path)
                else:
                    total += entry.stat(follow_symlinks=False).st_size
                    files_seen += 1
            except OSError:
                continue
    return total, files_seen


def _file_size(path: Path) -> int:
    try:
        return path.lstat().st_size
    except OSError:
        return 0


def _is_session_scoped(pattern: str) -> bool:
    """Return True for patterns that target a subdir *inside* a session directory.

    Session-scoped patterns contain a bare ``*`` wildcard (not ``**``) that
    represents the session folder, e.g. ``deep-research-workspaces/*/logs/``.
    For these patterns the age gate should be applied to the *session directory*
    (the parent) not to the eligible subdir itself — so a session still being
    written to is never cleaned even if its logs/ dir is old.
    """
    return "*" in pattern and not pattern.startswith("**")


def _session_root_path(current: Path, rel: str, pattern: str, root: Path) -> Path:
    """Return the session root directory for a session-scoped pattern match.

    Example: pattern rel
    ``deep-research-workspaces/session-abc/logs`` → returns
    ``root/deep-research-workspaces/session-abc``.
    """
    pattern_parts = [p for p in pattern.rstrip("/").split("/") if p]
    star_idx = next((i for i, p in enumerate(pattern_parts) if p == "*"), None)
    if star_idx is None:
        return current.parent
    rel_parts = [s for s in rel.rstrip("/").split("/") if s]
    session_parts = rel_parts[: star_idx + 1]
    return root.joinpath(*session_parts)


class WorkspaceCleanupJob:
    def __init__(
        self,
        data_dir: Path | None = None,
        env: dict[str, str] | None = None,
        store: "Store | None" = None,
    ) -> None:
        self._data_dir = data_dir
        self._env = env
        self._store = store
        self._last_run_at: float | None = self._read_last_run_at()
        self._last_cleaned_at: float | None = self._read_last_cleaned_at()
        self._last_emergency_cleanup_at: float | None = (
            self._read_last_emergency_cleanup_at()
        )
        self._soon_event: asyncio.Event | None = None

    def schedule_soon(self) -> None:
        """Signal the cleanup loop to run a pass shortly after the current
        sleep, rather than waiting the full hourly interval.

        Safe to call from any thread or non-async context; uses
        call_soon_threadsafe so it works when invoked from a RunManager
        completion callback.
        """
        if self._soon_event is not None and not self._soon_event.is_set():
            try:
                loop = asyncio.get_running_loop()
                loop.call_soon_threadsafe(self._soon_event.set)
            except RuntimeError:
                pass

    # State persistence
    def _state_file(self) -> Path | None:
        """Path to ws_cleanup_state.json, or None if data_dir is unknown."""
        if self._data_dir is None:
            return None
        return Path(self._data_dir) / "ws_cleanup_state.json"

    def _read_last_run_at(self) -> float | None:
        sf = self._state_file()
        if sf is None or not sf.exists():
            return None
        try:
            data = json.loads(sf.read_text(encoding="utf-8"))
            return float(data["last_run_at"])
        except Exception:
            return None

    def _read_last_cleaned_at(self) -> float | None:
        sf = self._state_file()
        if sf is None or not sf.exists():
            return None
        try:
            data = json.loads(sf.read_text(encoding="utf-8"))
            value = data.get("last_cleaned_at")
            return float(value) if value is not None else None
        except Exception:
            return None

    def _read_last_emergency_cleanup_at(self) -> float | None:
        sf = self._state_file()
        if sf is None or not sf.exists():
            return None
        try:
            data = json.loads(sf.read_text(encoding="utf-8"))
            value = data.get("last_emergency_cleanup_at")
            return float(value) if value is not None else None
        except Exception:
            return None

    def _write_last_run_at(
        self, ts: float, *, cleaned: bool = False, emergency: bool = False
    ) -> None:
        """Persist last_run_at (every pass) and, when ``cleaned`` is True,
        also bump last_cleaned_at to the same timestamp.
        """
        sf = self._state_file()
        if sf is None:
            return
        try:
            sf.parent.mkdir(parents=True, exist_ok=True)
            last_cleaned_at = ts if cleaned else self._last_cleaned_at
            last_emergency_cleanup_at = (
                ts if emergency else self._last_emergency_cleanup_at
            )
            payload: dict[str, float] = {"last_run_at": ts}
            if last_cleaned_at is not None:
                payload["last_cleaned_at"] = last_cleaned_at
            if last_emergency_cleanup_at is not None:
                payload["last_emergency_cleanup_at"] = last_emergency_cleanup_at
            tmp = sf.with_name(sf.name + ".tmp")
            tmp.write_text(json.dumps(payload), encoding="utf-8")
            os.replace(tmp, sf)
        except Exception as exc:
            logger.warning("Could not persist cleanup state: {}", exc)

    def _scan_intermediate_bytes(
        self,
        root: Path,
        policy: CleanupPolicy,
        *,
        retention_days: float | None = None,
        stop_at: int | None = None,
    ) -> tuple[int, int]:
        """Size the allowlisted intermediate directories under *root* in ONE walk.

        Returns ``(total_bytes, reclaimable_bytes)``:

        * ``total_bytes`` — every directory matched by the cleanup allowlist,
          including content still protected by retention.
        * ``reclaimable_bytes`` — the subset already old enough to delete under
          ``retention_days``. Equals ``total_bytes`` when ``retention_days`` is
          None.

        ``stop_at`` is an opt-in short-circuit for callers that only need a
        threshold comparison (the scheduler's critical-disk check): the walk
        returns as soon as ``total_bytes`` reaches it, so BOTH figures are then
        lower bounds. Callers that display the numbers must leave it None.
        The threshold comparison itself belongs to the caller, so a non-positive
        ``stop_at`` disables the short-circuit rather than reporting a bogus
        "threshold reached with 0 bytes".
        """
        if stop_at is not None and stop_at <= 0:
            stop_at = None

        # Pin every component from the volume root through *root* so an ancestor
        # (e.g. USERPROFILE) that is or becomes a junction fails closed instead
        # of redirecting this sizing walk outside the cleanup boundary. This is
        # the same boundary-to-target no-follow protection used for deletion.
        pinned_ancestry = _open_pinned_ancestry(root)
        if pinned_ancestry is None:
            return 0, 0
        try:
            return self._scan_intermediate_bytes_locked(
                root, policy, retention_days=retention_days, stop_at=stop_at
            )
        finally:
            _close_pinned_directories(pinned_ancestry)

    def _scan_intermediate_bytes_locked(
        self,
        root: Path,
        policy: CleanupPolicy,
        *,
        retention_days: float | None,
        stop_at: int | None,
    ) -> tuple[int, int]:
        dir_patterns = policy.eligible_patterns

        eligible_roots = {
            p.pattern.split("/")[0]
            for p in policy.eligible_patterns
            if "/" in p.pattern and not p.pattern.startswith("**")
        }
        double_star_dir_targets: set[str] = set()
        for p in policy.eligible_patterns:
            if p.pattern.startswith("**"):
                parts = _glob_to_parts(p.pattern)
                if len(parts) >= 2:
                    double_star_dir_targets.add(parts[-1])

        total = 0
        reclaimable = 0
        session_ages: dict[Path, float] = {}
        for dirpath, dirnames, _ in os.walk(root, topdown=True):
            current = Path(dirpath)
            rel = _to_posix_rel(current, root)
            dirnames[:] = [d for d in dirnames if not _is_link_or_junction(current / d)]
            if rel in ("", "."):
                dirnames[:] = [
                    d
                    for d in dirnames
                    if d in eligible_roots or d in double_star_dir_targets
                ]

            matched = (
                next((p for p in dir_patterns if _matches_dir_pattern(rel, p)), None)
                if rel not in ("", ".")
                else None
            )

            if matched is not None:
                size, _ = _dir_stats(current)
                total += size
                if retention_days is None:
                    reclaimable += size
                elif _is_session_scoped(matched.pattern):
                    session_path = _session_root_path(
                        current, rel, matched.pattern, root
                    )
                    session_age = _session_age_days(
                        session_path,
                        retention_days=retention_days,
                        cache=session_ages,
                    )
                    if session_age >= retention_days:
                        reclaimable += size
                elif _age_days(current) >= retention_days:
                    reclaimable += size
                dirnames.clear()
                if stop_at is not None and total >= stop_at:
                    return total, reclaimable
                continue

        return total, reclaimable

    def _run_emergency_cleanup(
        self, *, root: Path, policy: CleanupPolicy, dry_run: bool
    ) -> dict[str, object]:
        """Single emergency pass when the workspace crosses the critical-disk
        threshold.

        We reclaim exactly what the allowlist permits: every eligible
        intermediate directory older than ``_EMERGENCY_RETENTION_DAYS`` (1 day),
        in one pass. The 1-day floor comes solely from passing that constant
        here — ``run_once`` applies no minimum of its own and will honour any
        retention it is given, including 0. There is no progressive retention
        ladder: we claim what is reclaimable and report the bytes actually
        freed.
        """
        return self.run_once(
            workspace_root=root,
            policy=policy,
            retention_days=_EMERGENCY_RETENTION_DAYS,
            dry_run=dry_run,
            emergency=True,
        )

    def run_once(
        self,
        *,
        workspace_root: Path | None = None,
        policy: CleanupPolicy | None = None,
        retention_days: int | None = None,
        dry_run: bool = False,
        emergency: bool = False,
    ) -> dict[str, object]:
        env = self._env if self._env is not None else dict(os.environ)
        dry_run = dry_run or env.get("SUPERCLAW_CLEANUP_DRY_RUN", "").strip().lower() in (
            "1", "true", "yes",
        )
        root = workspace_root or _resolve_superclaw_root(env)
        if root is None:
            return {
                "dirs_removed": 0,
                "files_removed": 0,
                "errors": 0,
                "bytes_freed": 0,
                "dry_run": dry_run,
            }

        if not _cleanup_run_lock.acquire(blocking=False):
            logger.warning(
                "Cleanup pass skipped: another cleanup pass is already running"
            )
            return {
                "dirs_removed": 0,
                "files_removed": 0,
                "errors": 0,
                "bytes_freed": 0,
                "dry_run": dry_run,
                "skipped": True,
                "reason": "cleanup_already_running",
            }
        try:
            return self._run_once_locked(
                root=root,
                policy=policy,
                retention_days=retention_days,
                dry_run=dry_run,
                env=env,
                emergency=emergency,
            )
        finally:
            _cleanup_run_lock.release()

    def _run_once_locked(
        self,
        *,
        root: Path,
        policy: CleanupPolicy | None,
        retention_days: int | None,
        dry_run: bool,
        env: dict[str, str],
        emergency: bool = False,
    ) -> dict[str, object]:
        resolved_policy = policy or load_cleanup_policy()

        if retention_days is None:
            runtime_cfg = load_cleanup_settings(self._store)
            retention_days = int(runtime_cfg["retentionDays"])

        logger.info(
            "Cleanup pass: root={} retention_days={} patterns={} dry_run={}",
            root,
            retention_days,
            len(resolved_policy.eligible_patterns),
            dry_run,
        )

        summary: dict[str, object] = {
            "dirs_removed": 0,
            "files_removed": 0,
            "errors": 0,
            "bytes_freed": 0,
            "age_deferred": 0,
            "dry_run": dry_run,
        }
        pinned_root: list[int] | None = None
        if os.name == "nt" and not dry_run:
            root = Path(os.path.abspath(root))
            pinned_root = _open_pinned_ancestry(root)
            if pinned_root is None:
                logger.warning("Skipping unsafe or unclassifiable cleanup root: {}", root)
                return summary
        elif _is_link_or_junction(root):
            logger.warning("Skipping unsafe or unclassifiable cleanup root: {}", root)
            return summary
        session_ages: dict[Path, float] = {}
        dir_patterns = resolved_policy.eligible_patterns

        eligible_roots = {
            p.pattern.split("/")[0]
            for p in resolved_policy.eligible_patterns
            if "/" in p.pattern and not p.pattern.startswith("**")
        }

        # Collect directory names that ** patterns can match at any depth
        _double_star_dir_targets: set[str] = set()
        for p in resolved_policy.eligible_patterns:
            if p.pattern.startswith("**"):
                parts = _glob_to_parts(p.pattern)
                if len(parts) >= 2:
                    # e.g. "**/target/" → "target"
                    _double_star_dir_targets.add(parts[-1])

        try:
            for dirpath, dirnames, filenames in os.walk(root, topdown=True):
                current = Path(dirpath)
                rel = _to_posix_rel(current, root)
                dirnames[:] = [d for d in dirnames if not _is_link_or_junction(current / d)]
                if rel in ("", "."):
                    dirnames[:] = [
                        d
                        for d in dirnames
                        if d in eligible_roots or d in _double_star_dir_targets
                    ]

                matched = (
                    next((p for p in dir_patterns if _matches_dir_pattern(rel, p)), None)
                    if rel not in ("", ".")
                    else None
                )
                if matched is None:
                    continue
                # Session scoped patterns  measure inactivity on the session directory, not the eligible subdir
                if _is_session_scoped(matched.pattern):
                    session_path = _session_root_path(
                        current, rel, matched.pattern, root
                    )
                    age = _session_age_days(
                        session_path,
                        retention_days=retention_days,
                        cache=session_ages,
                    )
                    age_label = str(session_path)
                else:
                    age = _age_days(current)
                    age_label = str(current)
                if age >= retention_days:
                    evict_reason = f"age={age:.1f}d"
                    if dry_run:
                        size, file_count = _dir_stats(current)
                        logger.info(
                            "[dry-run] would remove dir: {} ({})", current, evict_reason
                        )
                        summary["dirs_removed"] = int(summary["dirs_removed"]) + 1
                        summary["files_removed"] = (
                            int(summary["files_removed"]) + file_count
                        )
                        summary["bytes_freed"] = int(summary["bytes_freed"]) + size
                    else:
                        # Re check active operations immediately before deletion to
                        # eliminate the TOCTOU race
                        if (
                            self._store is not None
                            and self._store.find_active_operations()
                        ):
                            logger.info(
                                "Aborting cleanup pass: agent task became active mid-walk. "
                                "Skipping {} and all remaining entries.",
                                current,
                            )
                            break
                        try:
                            deleted, skipped, freed, root_removed = _rmtree_skip_locked(
                                current,
                                boundary=root,
                                pinned_boundary=pinned_root,
                            )
                            if root_removed:
                                summary["dirs_removed"] = (
                                    int(summary["dirs_removed"]) + 1
                                )
                            summary["files_removed"] = (
                                int(summary["files_removed"]) + deleted
                            )
                            summary["bytes_freed"] = int(summary["bytes_freed"]) + freed
                            logger.info(
                                "Removed dir: {} | category={!r} reason={} freed={} bytes files_deleted={} files_skipped={}",
                                current,
                                matched.description,
                                evict_reason,
                                freed,
                                deleted,
                                skipped,
                            )
                        except OSError as exc:
                            summary["errors"] = int(summary["errors"]) + 1
                            logger.warning("Failed to remove dir {}: {}", current, exc)
                else:
                    summary["age_deferred"] = int(summary["age_deferred"]) + 1
                    logger.debug(
                        "Session too recent to clean: {} ({:.1f}d < {}d)",
                        age_label,
                        age,
                        retention_days,
                    )
                dirnames.clear()
                continue
        finally:
            if pinned_root is not None:
                _close_pinned_directories(pinned_root)

        logger.info(
            "Cleanup done: dirs={} files={} errors={} freed={} bytes kept_too_recent={}",
            summary["dirs_removed"],
            summary["files_removed"],
            summary["errors"],
            summary["bytes_freed"],
            summary["age_deferred"],
        )
        if not dry_run:
            ts = time.time()
            cleaned = (
                int(summary["dirs_removed"]) > 0 or int(summary["files_removed"]) > 0
            )
            if cleaned:
                self._last_cleaned_at = ts
            mark_emergency = emergency and cleaned
            if mark_emergency:
                self._last_emergency_cleanup_at = ts
            self._last_run_at = ts
            self._write_last_run_at(ts, cleaned=cleaned, emergency=mark_emergency)
        return summary

    async def loop(self) -> None:
        """Run cleanup passes until cancelled
        """
        logger.debug("Workspace cleanup loop started")
        self._soon_event = asyncio.Event()
        # Delay between a task completion signal and the triggered cleanup pass
        _POST_TASK_DELAY_SECONDS = 60
        consecutive_failures = 0
        while True:
            poll_interval = _POLL_INTERVAL_SECONDS
            try:
                env = self._env if self._env is not None else dict(os.environ)
                try:
                    poll_interval = int(
                        env.get(
                            "SUPERCLAW_CLEANUP_POLL_SECONDS",
                            _POLL_INTERVAL_SECONDS,
                        )
                    )
                except (TypeError, ValueError):
                    poll_interval = _POLL_INTERVAL_SECONDS

                force_dry_run = env.get("SUPERCLAW_CLEANUP_DRY_RUN", "").strip().lower() in (
                    "1",
                    "true",
                    "yes",
                )
                if force_dry_run:
                    logger.warning(
                        "SUPERCLAW_CLEANUP_DRY_RUN is set — scheduled cleanup will report eligible files but will not delete anything."
                    )
                cfg = load_cleanup_settings(self._store)
                policy = load_cleanup_policy()
                logger.info(
                    "Cleanup loop tick: enabled={} retentionDays={}",
                    cfg["enabled"],
                    cfg["retentionDays"],
                )

                # Critical disk threshold
                if self._store is None or not self._store.find_active_operations():
                    root = _resolve_superclaw_root(env)
                    if root is not None:
                        total_bytes, _ = self._scan_intermediate_bytes(
                            root, policy, stop_at=policy.critical_bytes
                        )
                        reached_critical = total_bytes >= policy.critical_bytes
                        # Emergency (critical-disk) cleanup runs automatically only
                        # when the user has opted into auto-cleanup
                        if reached_critical and cfg["enabled"]:
                            logger.warning(
                                "Workspace usage {} bytes exceeds critical threshold {} bytes — "
                                "triggering emergency cleanup (dry_run={})",
                                total_bytes,
                                policy.critical_bytes,
                                force_dry_run,
                            )
                            summary = await asyncio.get_running_loop().run_in_executor(
                                None,
                                functools.partial(
                                    self._run_emergency_cleanup,
                                    root=root,
                                    policy=policy,
                                    dry_run=force_dry_run,
                                ),
                            )
                            if (
                                not force_dry_run
                                and not summary.get("skipped")
                            ):
                                self._last_run_at = time.time()
                            await asyncio.sleep(poll_interval)
                            continue
                        elif reached_critical:
                            logger.warning(
                                "Workspace usage {} bytes exceeds critical threshold {} bytes, "
                                "but auto-cleanup is disabled — not deleting; the UI will prompt "
                                "the user to allow cleanup.",
                                total_bytes,
                                policy.critical_bytes,
                            )
                        elif total_bytes >= policy.warn_bytes:
                            logger.warning(
                                "Workspace usage {} bytes exceeds warn threshold {} bytes.",
                                total_bytes,
                                policy.warn_bytes,
                            )

                if cfg["enabled"]:
                    if self._store is not None and self._store.find_active_operations():
                        logger.info("Cleanup deferred: agent task is active")
                    else:
                        retention_days = cfg["retentionDays"]
                        _DAILY = int(
                            env.get("SUPERCLAW_CLEANUP_INTERVAL_SECONDS", 86400)
                        )
                        now = time.time()
                        if (
                            self._last_run_at is None
                            or retention_days <= 0
                            or (now - self._last_run_at) >= _DAILY
                        ):
                            summary = await asyncio.get_running_loop().run_in_executor(
                                None,
                                functools.partial(
                                    self.run_once,
                                    retention_days=retention_days,
                                    dry_run=force_dry_run,
                                ),
                            )
                            if (
                                not force_dry_run
                                and not summary.get("skipped")
                            ):
                                self._last_run_at = time.time()
                        else:
                            logger.info(
                                "Cleanup not due yet (last={:.0f}s ago, daily schedule)",
                                now - self._last_run_at,
                            )
                else:
                    logger.info("Workspace cleanup disabled; skipping pass")
                consecutive_failures = 0
            except asyncio.CancelledError:
                logger.debug("Workspace cleanup loop cancelled")
                return
            except Exception as exc:
                consecutive_failures += 1
                logger.opt(exception=True).error(
                    "Cleanup pass failed with {} ({} consecutive failure(s)); "
                    "no workspace files are being cleaned up: {}",
                    type(exc).__name__,
                    consecutive_failures,
                    exc,
                )

            self._soon_event.clear()
            try:
                await asyncio.wait_for(
                    asyncio.shield(asyncio.ensure_future(self._soon_event.wait())),
                    timeout=poll_interval,
                )
                logger.debug(
                    "Cleanup loop woken early by task completion; waiting {}s",
                    _POST_TASK_DELAY_SECONDS,
                )
                await asyncio.sleep(_POST_TASK_DELAY_SECONDS)
            except asyncio.TimeoutError:
                pass
