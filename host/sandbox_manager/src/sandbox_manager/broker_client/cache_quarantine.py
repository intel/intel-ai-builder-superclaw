"""Moves rebuildable tool caches out of the tier data tree before the tier accounts are recreated.

A reinstall that keeps user data gives the tier accounts new SIDs, and the elevated provision then rewrites
the ACL of every file under ``data_root/file_tool`` for them. On a machine that has run the agent for a
while that tree is mostly uv, npm and bun caches (about 110k of 123k files on the machine this was found
on), the rewrite takes minutes, and the session has to outwait it.

The caches are not needed to run the app, so each is renamed into ``data_root/.cache-quarantine`` - one operation
that does not depend on how many files it holds - and deleted later. The owner has full control of the
whole tree through its own inherited ACE, so none of this needs elevation, and the broker neither knows nor
needs to know about it: it simply no longer finds those directories to walk.

The file_tool runtime's own TEMP, TMP and TMPDIR directory (``temp_root/file_tool``) is renamed the same
way, as a whole: its contents are temporary by definition, and on a machine that has run the agent for a
while it held 162k files, more than the data tree. The broker creates the directory again, with the tier's
ACL, in the provision session that follows.

This is only done when the tier accounts are being recreated, never for an ACL change alone, because it
costs the caches: the runtime defaults to ``UV_OFFLINE=1``, so uv cannot fetch what it lost until a
package is resolved online again (a catalog ``uvx`` server does that in its own environment).

Only what is named here moves. opencode's own downloads under ``data`` stay because they are fetched on
demand and the machine may be offline, and so does everything else the agent wrote.
"""

from __future__ import annotations

import os
import shutil
import stat
import threading
import uuid
from collections.abc import Mapping
from pathlib import Path

from loguru import logger

#: Beside the tier directories, outside the subtree the broker's startup convergence walks.
QUARANTINE_DIRECTORY = ".cache-quarantine"

#: Rebuildable caches, relative to ``data_root``.
_DISPOSABLE_CACHES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("uv", ("file_tool", "home", ".local", "cache")),
    ("npm", ("file_tool", "cache", "npm")),
    ("bun", ("file_tool", "cache", "bun")),
)


#: The tier directory under ``temp_root`` that the file_tool runtime uses as TEMP, TMP and TMPDIR.
_TEMP_TIER = "file_tool"


def _is_reparse_point(path: Path) -> bool:
    """Whether ``path`` is a symlink or junction, read without following it (works on Python 3.11)."""
    try:
        info = os.lstat(path)
    except OSError:
        return False
    if stat.S_ISLNK(info.st_mode):
        return True
    return bool(
        getattr(info, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    )


def _has_reparse_point_on_the_way(root: Path, relative: tuple[str, ...]) -> bool:
    current = root
    for part in relative:
        current = current / part
        if current.exists() and _is_reparse_point(current):
            return True
    return False


def _move(source: Path, target: Path, label: str) -> bool:
    try:
        os.rename(source, target)
    except OSError as exc:
        logger.warning(
            "native-provision: phase=cache_quarantine event=skipped reason={} cache={}",
            type(exc).__name__,
            label,
        )
        return False
    return True


def quarantine_disposable_caches(path_set: Mapping[str, object]) -> list[Path]:
    """Renames each rebuildable cache and the file_tool temp directory into the quarantine; returns the new paths.

    ``path_set`` supplies ``data_root`` (the caches) and, optionally, ``temp_root`` (the file_tool TEMP).
    Something absent is skipped, a path that is or crosses a reparse point is never moved or followed, and
    one that cannot be renamed - a sharing violation, say - stays where it is for the elevated walk to
    rewrite. Nothing here is allowed to fail the start.
    """
    data_root = path_set.get("data_root")
    if not isinstance(data_root, str) or not data_root:
        return []
    root = Path(data_root)
    quarantine = root / QUARANTINE_DIRECTORY
    if _is_reparse_point(root) or (quarantine.exists() and _is_reparse_point(quarantine)):
        logger.warning("native-provision: phase=cache_quarantine event=skipped reason=reparse_point root=data")
        return []
    moved: list[Path] = []
    batch: Path | None = None

    def batch_directory() -> Path | None:
        nonlocal batch
        if batch is None:
            try:
                batch = root / QUARANTINE_DIRECTORY / uuid.uuid4().hex
                batch.mkdir(parents=True, exist_ok=True)
            except OSError as exc:
                logger.warning(
                    "native-provision: phase=cache_quarantine event=skipped reason={}",
                    type(exc).__name__,
                )
                batch = None
        return batch

    for name, relative in _DISPOSABLE_CACHES:
        source = root.joinpath(*relative)
        try:
            if not source.is_dir():
                continue
            if _has_reparse_point_on_the_way(root, relative):
                logger.warning(
                    "native-provision: phase=cache_quarantine event=skipped reason=reparse_point cache={}",
                    name,
                )
                continue
        except OSError:
            continue
        directory = batch_directory()
        if directory is not None and _move(source, directory / name, name):
            moved.append(directory / name)

    temp_root = path_set.get("temp_root")
    if isinstance(temp_root, str) and temp_root:
        temp_path = Path(temp_root)
        tier_temp = temp_path / _TEMP_TIER
        # The temp root, the directory above it and the tier directory are all owner-controlled; a link in
        # any of them would send the rename outside the managed tree, so none may be one.
        if any(_is_reparse_point(path) for path in (temp_path.parent, temp_path, tier_temp)):
            logger.warning("native-provision: phase=cache_quarantine event=skipped reason=reparse_point root=temp")
        elif tier_temp.is_dir():
            # The whole directory in one rename: renaming its entries one by one costs about 0.8 ms each,
            # 80 s for 100k, which is worse than the ACL rewrite it replaces. The broker creates the tier
            # directory again with the tier's ACL (create_dir_all, then apply_object) in the session that
            # follows.
            directory = batch_directory()
            if directory is not None and _move(tier_temp, directory / "temp", "temp"):
                moved.append(directory / "temp")
    if moved:
        logger.info(
            "native-provision: phase=cache_quarantine event=moved caches={}",
            ",".join(sorted(path.name for path in moved)),
        )
    return moved


def purge_cache_quarantine(data_root: str | Path) -> None:
    """Deletes whatever the quarantine holds. Best effort: what cannot be deleted now is tried next start."""
    root = Path(data_root)
    quarantine = root / QUARANTINE_DIRECTORY
    try:
        if _is_reparse_point(root) or not quarantine.is_dir() or _is_reparse_point(quarantine):
            return
        shutil.rmtree(quarantine, ignore_errors=True)
    except OSError as exc:
        logger.warning(
            "native-provision: phase=cache_quarantine event=purge_failed reason={}",
            type(exc).__name__,
        )
        return
    logger.info(
        "native-provision: phase=cache_quarantine event=purged remaining={}",
        quarantine.exists(),
    )


def purge_cache_quarantine_in_background(path_set: object) -> None:
    """Starts :func:`purge_cache_quarantine` on a daemon thread, so a start does not wait for the deletes.

    Anything that is not a path set naming a ``data_root`` is ignored: the quarantine only ever lives under
    the data root of a real one.
    """
    if not isinstance(path_set, Mapping):
        return
    data_root = path_set.get("data_root")
    if not isinstance(data_root, str) or not data_root:
        return
    threading.Thread(
        target=purge_cache_quarantine,
        args=(data_root,),
        name="cache-quarantine-purge",
        daemon=True,
    ).start()
