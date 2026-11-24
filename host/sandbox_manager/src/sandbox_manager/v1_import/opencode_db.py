"""Turn a v1 container's `opencode.db` into one the native runtime opens as its own.

The file comes out of a distro agents ran in, so it is checked before any statement runs against it: it
passes `quick_check`, holds no trigger, view or virtual table, and has the tables and columns the rewrite
needs. Its `credential` table is emptied, because this import carries sessions only.

The paths OpenCode resolves are rewritten from `/workspace` to the native workspace root, in the form
native OpenCode writes each one: `C:/...` in the session and project tables, `C:\\...` in workspace rows
and message JSON. Parts, events and diff summaries are history and keep their container paths.
"""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from pathlib import Path, PurePath, PurePosixPath, PureWindowsPath

from .outcome import RewriteSummary

DATABASE_NAME = "opencode.db"
_REQUIRED_COLUMNS: dict[str, frozenset[str]] = {
    "session": frozenset({"id", "project_id", "directory", "path"}),
    "project": frozenset({"id", "worktree", "sandboxes"}),
    "project_directory": frozenset({"project_id", "directory"}),
    "workspace": frozenset({"id", "directory"}),
    "message": frozenset({"id", "data"}),
    "credential": frozenset({"id"}),
    "migration": frozenset({"id"}),
}
# A global-project session's path is relative to the project worktree, "/", which native OpenCode
# resolves to the drive root.
_REWRITES = (
    "UPDATE session SET path = v1_drive_relative(directory) "
    "WHERE path IS NOT NULL AND project_id IN (SELECT id FROM project WHERE worktree = '/') "
    "AND v1_drive_relative(directory) IS NOT NULL AND v1_drive_relative(directory) IS NOT path",
    "UPDATE project SET worktree = v1_storage(worktree) WHERE v1_storage(worktree) IS NOT worktree",
    "UPDATE project SET sandboxes = v1_storage_list(sandboxes) WHERE v1_storage_list(sandboxes) IS NOT sandboxes",
    "UPDATE project_directory SET directory = v1_storage(directory) WHERE v1_storage(directory) IS NOT directory",
    "UPDATE workspace SET directory = v1_platform(directory) WHERE v1_platform(directory) IS NOT directory",
    *(
        f"UPDATE message SET data = json_set(data, '$.path.{key}', v1_platform(json_extract(data, '$.path.{key}'))) "
        f"WHERE CASE WHEN json_valid(data) "
        f"THEN v1_platform(json_extract(data, '$.path.{key}')) IS NOT json_extract(data, '$.path.{key}') END"
        for key in ("cwd", "root")
    ),
)


# Errors of this machine's disk or of another open connection, not of the file's content.
_RETRYABLE_SQLITE = frozenset(
    {sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED, sqlite3.SQLITE_IOERR, sqlite3.SQLITE_FULL, sqlite3.SQLITE_CANTOPEN}
)


class ImportDatabaseError(Exception):
    """The file is not an OpenCode database this importer will carry over, or could not be read now."""

    def __init__(self, message: str, *, retryable: bool = False) -> None:
        super().__init__(message)
        self.retryable = retryable


@dataclass(frozen=True)
class _Workspace:
    root: PureWindowsPath

    def native(self, value: object) -> PureWindowsPath | None:
        if not isinstance(value, str):
            return None
        container = PurePosixPath(value)
        if container.parts[:2] != ("/", "workspace"):
            return None
        rest = container.parts[2:]
        if any(part == ".." or "\\" in part or ":" in part for part in rest):
            return None
        return self.root.joinpath(*rest)

    def storage(self, value: object) -> object:
        native = self.native(value)
        return value if native is None else native.as_posix()

    def platform(self, value: object) -> object:
        native = self.native(value)
        return value if native is None else str(native)

    def drive_relative(self, value: object) -> str | None:
        native = self.native(value)
        if native is None:
            return None
        relative = native.relative_to(native.anchor).as_posix()
        return "" if relative == "." else relative

    def storage_list(self, value: object) -> object:
        try:
            paths = json.loads(value) if isinstance(value, str) else None
        except json.JSONDecodeError:
            return value
        if not isinstance(paths, list):
            return value
        return json.dumps([self.storage(path) for path in paths], separators=(",", ":"), ensure_ascii=False)


def prepare_import_database(database: Path, *, workspace_root: PurePath) -> RewriteSummary:
    """Rewrite `database` in place and leave it as one file, its WAL folded in."""
    workspace = _Workspace(PureWindowsPath(workspace_root))
    try:
        connection = sqlite3.connect(database, isolation_level=None)
    except sqlite3.Error as error:
        raise _failure(error) from error
    try:
        _require_opencode_schema(connection)
        for name, function in (
            ("v1_storage", workspace.storage),
            ("v1_storage_list", workspace.storage_list),
            ("v1_platform", workspace.platform),
            ("v1_drive_relative", workspace.drive_relative),
        ):
            connection.create_function(name, 1, function, deterministic=True)
        connection.execute("PRAGMA secure_delete = ON")  # a deleted credential must not stay in free pages
        connection.execute("BEGIN IMMEDIATE")
        for statement in _REWRITES:
            connection.execute(statement)
        # Sessions only: a credential changing place needs an audited secret move (#3389).
        credential_rows = _count(connection, "SELECT COUNT(*) FROM credential")
        connection.execute("DELETE FROM credential")
        rewritten = connection.execute(
            "UPDATE session SET directory = v1_storage(directory) WHERE v1_storage(directory) IS NOT directory"
        ).rowcount
        connection.execute("COMMIT")
        summary = RewriteSummary(
            sessions=_count(connection, "SELECT COUNT(*) FROM session"),
            rewritten=rewritten,
            unmapped=_count(connection, "SELECT COUNT(*) FROM session WHERE directory LIKE '/%'"),
            credential_rows=credential_rows,
        )
        (mode,) = connection.execute("PRAGMA journal_mode = DELETE").fetchone()
        if mode != "delete":
            raise ImportDatabaseError(f"journal stayed in {mode} mode", retryable=True)
        return summary
    except sqlite3.Error as error:
        raise _failure(error) from error
    finally:
        connection.close()


def count_user_rows(database: Path) -> int:
    """Sessions plus messages in a native `opencode.db`, read without writing it.

    `mode=ro` still reads the WAL, where the newest rows can sit; `immutable=1` would skip it. SQLite may
    create the empty `-wal` and `-shm` beside the file.
    """
    try:
        connection = sqlite3.connect(f"{database.as_uri()}?mode=ro", uri=True)
    except sqlite3.Error as error:
        raise _failure(error) from error
    try:
        connection.execute("PRAGMA trusted_schema = OFF")
        tables = [
            name
            for (name,) in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('session', 'message') ORDER BY name"
            )
        ]
        return sum(_count(connection, f"SELECT COUNT(*) FROM {table}") for table in tables)
    except sqlite3.Error as error:
        raise _failure(error) from error
    finally:
        connection.close()


def _failure(error: sqlite3.Error) -> ImportDatabaseError:
    code = getattr(error, "sqlite_errorcode", None)
    retryable = isinstance(code, int) and (code & 0xFF) in _RETRYABLE_SQLITE
    return ImportDatabaseError(f"{type(error).__name__}: {error}", retryable=retryable)


def _require_opencode_schema(connection: sqlite3.Connection) -> None:
    connection.execute("PRAGMA trusted_schema = OFF")
    if connection.execute("PRAGMA quick_check").fetchall() != [("ok",)]:
        raise ImportDatabaseError("quick_check reported damage")
    foreign = connection.execute(
        "SELECT type, name FROM sqlite_master "
        "WHERE type NOT IN ('table', 'index') OR sql LIKE 'CREATE VIRTUAL TABLE%'"
    ).fetchone()
    if foreign is not None:
        raise ImportDatabaseError(f"schema holds a {foreign[0]} {foreign[1]!r}, which OpenCode never creates")
    for table, required in _REQUIRED_COLUMNS.items():
        columns = {name for (name,) in connection.execute("SELECT name FROM pragma_table_info(?)", (table,))}
        missing = required - columns
        if missing:
            raise ImportDatabaseError(f"table {table!r} lacks {', '.join(sorted(missing))}")


def _count(connection: sqlite3.Connection, query: str) -> int:
    (count,) = connection.execute(query).fetchone()
    return int(count)
