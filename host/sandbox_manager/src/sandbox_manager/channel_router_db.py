"""The router's SQLite database, carried from the file_tool tier's directory to the channel tier's (EG2-6).

The router keeps its sessions, bindings, allowlist and settings in ``opencode-router.db`` beside its config.
When the router moved to the channel tier, that directory moved with it, so without this step an upgrade
starts the router on an empty database.

It runs at the same time as the config migration: router stopped, before the channel router starts. The
copy goes through SQLite's backup API, so rows that are committed but still only in the ``-wal`` file come
along. It is written beside its destination, so it inherits that directory's ACL exactly as the config file
does, and it replaces the destination only once it opens, passes an integrity check and has the legacy
tables. A destination that holds rows is never overwritten. A failure logs a typed reason, leaves the legacy
files in place and never blocks start-up: the router then starts with whatever database the destination has.
"""

from __future__ import annotations

import os
import sqlite3
from contextlib import closing
from pathlib import Path
from typing import Literal, Protocol

from loguru import logger

ROUTER_DB_NAME = "opencode-router.db"
LEGACY_ROUTER_DB_RELATIVE_PATH = Path("file_tool") / "opencode-router" / ROUTER_DB_NAME
ROUTER_DB_RELATIVE_PATH = Path("channel") / "opencode-router" / ROUTER_DB_NAME

DbMigrationFailure = Literal[
    "legacy_db_unreadable",
    "channel_db_unreadable",
    "channel_db_not_empty",
    "copy_failed",
    "verify_failed",
]

_SIDE_FILE_SUFFIXES = ("-wal", "-shm")


class _Audit(Protocol):
    def record(self, event: str, **fields: str) -> None: ...


def _table_names(connection: sqlite3.Connection) -> set[str]:
    rows = connection.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    return {name for (name,) in rows}


def _holds_rows(connection: sqlite3.Connection) -> bool:
    return any(
        connection.execute(f'SELECT 1 FROM "{name}" LIMIT 1').fetchone() is not None
        for name in _table_names(connection)
    )


def _remove_db_files(db: Path) -> None:
    for suffix in ("", *_SIDE_FILE_SUFFIXES):
        db.with_name(db.name + suffix).unlink(missing_ok=True)


def migrate_legacy_router_db(data_root: Path, audit: _Audit | None) -> None:
    """Move the legacy database into the channel tier. Idempotent; a failure is logged, never raised."""
    legacy = data_root / LEGACY_ROUTER_DB_RELATIVE_PATH
    if not legacy.is_file():
        return
    try:
        reason = _copy_legacy_db(legacy, data_root / ROUTER_DB_RELATIVE_PATH, audit)
    except OSError:
        reason = "copy_failed"
    if reason is not None:
        logger.warning("router database not migrated reason={}", reason)
        return
    try:
        _remove_db_files(legacy)
        legacy.parent.rmdir()
    except OSError:
        # Copied already; leftovers or a directory still holding the old config are harmless.
        pass


def _copy_legacy_db(legacy: Path, destination: Path, audit: _Audit | None) -> DbMigrationFailure | None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        try:
            with closing(sqlite3.connect(destination)) as existing:
                if _holds_rows(existing):
                    return "channel_db_not_empty"
        except sqlite3.Error:
            return "channel_db_unreadable"
    staged = destination.with_name(f"{destination.name}.migrating")
    _remove_db_files(staged)
    try:
        try:
            with closing(sqlite3.connect(legacy)) as source:
                expected = _table_names(source)
                with closing(sqlite3.connect(staged)) as target:
                    source.backup(target)
        except sqlite3.Error:
            return "copy_failed" if staged.exists() else "legacy_db_unreadable"
        try:
            with closing(sqlite3.connect(staged)) as copied:
                intact = copied.execute("PRAGMA integrity_check").fetchone() == ("ok",)
                if not intact or not expected <= _table_names(copied):
                    return "verify_failed"
        except sqlite3.Error:
            return "verify_failed"
        # Written before the change, as ControlAudit's contract says.
        if audit is not None:
            audit.record("channel.router_db_migrated")
        for suffix in _SIDE_FILE_SUFFIXES:
            destination.with_name(destination.name + suffix).unlink(missing_ok=True)
        os.replace(staged, destination)
        return None
    finally:
        _remove_db_files(staged)
