"""SQLite persistence layer (WAL mode, single-writer, threading-safe).

Schema (see model_manager_todo.md §0.3):

* ``models``  – physical file presence + sha + state per model id
* ``runs``    – generic async job ledger (download, server start, ensure-ready, …)
* ``config``  – key/JSON-value store for active model ids, persistent flag, etc.

The ``Store`` is intentionally synchronous: SQLite calls inside FastAPI handlers
run in the default threadpool via ``await asyncio.to_thread(...)``.  All mutating
methods take ``self._lock`` *and* a SQLite transaction — this prevents the
classic "transaction visible across threads but lock not held" race.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator


RUNTIME_DEPLOYMENT_CONFIG_KEY = "runtime_deployment"


_SCHEMA = """
CREATE TABLE IF NOT EXISTS models (
    id                TEXT PRIMARY KEY,
    role              TEXT NOT NULL,
    state             TEXT NOT NULL DEFAULT 'missing',
    downloaded_bytes  INTEGER NOT NULL DEFAULT 0,
    total_bytes       INTEGER NOT NULL DEFAULT 0,
    sha256            TEXT,
    path              TEXT,
    updated_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS runs (
    run_id        TEXT PRIMARY KEY,
    kind          TEXT NOT NULL,
    state         TEXT NOT NULL DEFAULT 'pending',
    pct           REAL NOT NULL DEFAULT 0.0,
    message       TEXT,
    started_at    TIMESTAMP,
    finished_at   TIMESTAMP,
    error         TEXT,
    parent_run_id TEXT,
    metadata      TEXT  -- JSON blob: role, model_id, etc.
);

CREATE INDEX IF NOT EXISTS idx_runs_parent ON runs(parent_run_id);
CREATE INDEX IF NOT EXISTS idx_runs_state  ON runs(state);

CREATE TABLE IF NOT EXISTS config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL  -- JSON
);
"""


_DEFAULT_CONFIG: dict[str, Any] = {
    "active_chat_model_id": None,  # populated from registry default at startup
    "active_embedding_model_id": None,
    "persistent": False,
    "model_download_concurrency": 1,
    # SANDBOX keys are seeded separately via sandbox_seed in Store.__init__
    # (values come from sandbox.default.json / user's sandbox.json at runtime)
}


class Store:
    """Thread-safe SQLite wrapper.

    A single connection is shared across threads; SQLite is built with
    ``check_same_thread=False`` and every operation is serialized with
    ``self._lock`` so we get correct semantics without paying the cost of
    a connection pool.
    """

    def __init__(self, db_path: Path, sandbox_seed: dict[str, Any] | None = None) -> None:
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._sandbox_seed = sandbox_seed or {}
        self._conn = sqlite3.connect(
            db_path,
            check_same_thread=False,
            isolation_level=None,  # autocommit; we manage txns explicitly
            timeout=30.0,
        )
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA synchronous=NORMAL")
        self._conn.execute("PRAGMA foreign_keys=ON")
        self._conn.executescript(_SCHEMA)
        self._seed_defaults()

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    # ------------------------------------------------------------------ utils

    @contextmanager
    def _tx(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            try:
                yield self._conn
            except Exception:
                self._conn.execute("ROLLBACK")
                raise
            else:
                self._conn.execute("COMMIT")

    def _seed_defaults(self) -> None:
        merged = {**_DEFAULT_CONFIG, **self._sandbox_seed}
        with self._tx() as cx:
            for k, v in merged.items():
                cx.execute(
                    "INSERT OR IGNORE INTO config(key, value) VALUES(?, ?)",
                    (k, json.dumps(v)),
                )

    # --------------------------------------------------------------- config kv

    def get_config(self, key: str, default: Any = None) -> Any:
        with self._lock:
            row = self._conn.execute(
                "SELECT value FROM config WHERE key = ?", (key,)
            ).fetchone()
        return json.loads(row["value"]) if row else default

    def set_config(self, key: str, value: Any) -> None:
        with self._tx() as cx:
            cx.execute(
                "INSERT INTO config(key, value) VALUES(?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, json.dumps(value)),
            )

    def delete_config(self, key: str) -> None:
        with self._tx() as cx:
            cx.execute("DELETE FROM config WHERE key = ?", (key,))

    def delete_config_prefix(self, prefix: str) -> None:
        with self._tx() as cx:
            cx.execute(
                "DELETE FROM config WHERE substr(key, 1, ?) = ?",
                (len(prefix), prefix),
            )

    def put_runtime_deployment(self, value: dict[str, Any]) -> str:
        """Apply the RuntimeDeploymentSpec profile revision CAS atomically."""
        revision = value.get("profile_revision")
        if not isinstance(revision, int) or isinstance(revision, bool):
            raise ValueError("profile_revision must be an integer")
        with self._tx() as cx:
            row = cx.execute(
                "SELECT value FROM config WHERE key = ?",
                (RUNTIME_DEPLOYMENT_CONFIG_KEY,),
            ).fetchone()
            if row is not None:
                stored = json.loads(row["value"])
                stored_revision = stored.get("profile_revision")
                if revision < stored_revision:
                    return "stale"
                if revision == stored_revision:
                    return "unchanged" if value == stored else "conflict"
            cx.execute(
                "INSERT INTO config(key, value) VALUES(?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (RUNTIME_DEPLOYMENT_CONFIG_KEY, json.dumps(value)),
            )
            return "stored"

    def delete_runtime_deployment(self, expected: dict[str, Any]) -> str:
        """Delete only the exact RuntimeDeploymentSpec the caller owns."""
        with self._tx() as cx:
            row = cx.execute(
                "SELECT value FROM config WHERE key = ?",
                (RUNTIME_DEPLOYMENT_CONFIG_KEY,),
            ).fetchone()
            if row is None:
                return "absent"
            if json.loads(row["value"]) != expected:
                return "conflict"
            cx.execute(
                "DELETE FROM config WHERE key = ?",
                (RUNTIME_DEPLOYMENT_CONFIG_KEY,),
            )
            return "deleted"

    def all_config(self) -> dict[str, Any]:
        with self._lock:
            rows = self._conn.execute("SELECT key, value FROM config").fetchall()
        return {r["key"]: json.loads(r["value"]) for r in rows}

    # ----------------------------------------------------------------- models

    def upsert_model(
        self,
        *,
        id: str,
        role: str,
        state: str,
        downloaded_bytes: int = 0,
        total_bytes: int = 0,
        sha256: str | None = None,
        path: str | None = None,
    ) -> None:
        with self._tx() as cx:
            cx.execute(
                """
                INSERT INTO models(id, role, state, downloaded_bytes, total_bytes, sha256, path, updated_at)
                VALUES(?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(id) DO UPDATE SET
                    role             = excluded.role,
                    state            = excluded.state,
                    downloaded_bytes = excluded.downloaded_bytes,
                    total_bytes      = excluded.total_bytes,
                    sha256           = COALESCE(excluded.sha256, models.sha256),
                    path             = COALESCE(excluded.path,   models.path),
                    updated_at       = CURRENT_TIMESTAMP
                """,
                (id, role, state, downloaded_bytes, total_bytes, sha256, path),
            )

    def update_model_progress(
        self,
        model_id: str,
        *,
        downloaded_bytes: int,
        total_bytes: int | None = None,
        state: str | None = None,
    ) -> None:
        with self._tx() as cx:
            if total_bytes is not None and state is not None:
                cx.execute(
                    "UPDATE models SET downloaded_bytes=?, total_bytes=?, state=?, updated_at=CURRENT_TIMESTAMP WHERE id=?",
                    (downloaded_bytes, total_bytes, state, model_id),
                )
            elif total_bytes is not None:
                cx.execute(
                    "UPDATE models SET downloaded_bytes=?, total_bytes=?, updated_at=CURRENT_TIMESTAMP WHERE id=?",
                    (downloaded_bytes, total_bytes, model_id),
                )
            elif state is not None:
                cx.execute(
                    "UPDATE models SET downloaded_bytes=?, state=?, updated_at=CURRENT_TIMESTAMP WHERE id=?",
                    (downloaded_bytes, state, model_id),
                )
            else:
                cx.execute(
                    "UPDATE models SET downloaded_bytes=?, updated_at=CURRENT_TIMESTAMP WHERE id=?",
                    (downloaded_bytes, model_id),
                )

    def get_model(self, model_id: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM models WHERE id=?", (model_id,)
            ).fetchone()
        return dict(row) if row else None

    def list_models(self) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute("SELECT * FROM models").fetchall()
        return [dict(r) for r in rows]

    def delete_model(self, model_id: str) -> None:
        with self._tx() as cx:
            cx.execute("DELETE FROM models WHERE id=?", (model_id,))

    # ------------------------------------------------------------------- runs

    def insert_run(
        self,
        *,
        run_id: str,
        kind: str,
        parent_run_id: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        with self._tx() as cx:
            cx.execute(
                """
                INSERT INTO runs(run_id, kind, state, pct, parent_run_id, metadata, started_at)
                VALUES(?, ?, 'pending', 0.0, ?, ?, ?)
                """,
                (
                    run_id,
                    kind,
                    parent_run_id,
                    json.dumps(metadata or {}),
                    _now_iso(),
                ),
            )

    def patch_run_metadata(self, run_id: str, key: str, value: Any) -> None:
        """Merge a single key into an existing run's metadata JSON blob."""
        row = self.get_run(run_id)
        if not row:
            return
        meta: dict[str, Any] = dict(row.get("metadata") or {})
        meta[key] = value
        with self._tx() as cx:
            cx.execute(
                "UPDATE runs SET metadata=? WHERE run_id=?",
                (json.dumps(meta), run_id),
            )

    def update_run(
        self,
        run_id: str,
        *,
        state: str | None = None,
        pct: float | None = None,
        message: str | None = None,
        error: str | None = None,
        finished: bool = False,
    ) -> None:
        sets: list[str] = []
        args: list[Any] = []
        if state is not None:
            sets.append("state=?")
            args.append(state)
        if pct is not None:
            sets.append("pct=?")
            args.append(max(0.0, min(100.0, pct)))
        if message is not None:
            sets.append("message=?")
            args.append(message)
        if error is not None:
            sets.append("error=?")
            args.append(error)
        if finished:
            sets.append("finished_at=?")
            args.append(_now_iso())
        if not sets:
            return
        args.append(run_id)
        with self._tx() as cx:
            cx.execute(f"UPDATE runs SET {', '.join(sets)} WHERE run_id=?", args)

    def get_run(self, run_id: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM runs WHERE run_id=?", (run_id,)
            ).fetchone()
        if not row:
            return None
        d = dict(row)
        d["metadata"] = json.loads(d["metadata"]) if d.get("metadata") else {}
        return d

    def get_child_runs(self, parent_run_id: str) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM runs WHERE parent_run_id=? ORDER BY started_at",
                (parent_run_id,),
            ).fetchall()
        out: list[dict[str, Any]] = []
        for r in rows:
            d = dict(r)
            d["metadata"] = json.loads(d["metadata"]) if d.get("metadata") else {}
            out.append(d)
        return out

    def reset_stale_runs(self) -> int:
        """Mark any pending/running runs as error on process startup.

        Runs in those states from a previous process are zombies — their
        background tasks no longer exist.  Leaving them as ``running``
        causes ``find_active_run`` to deduplicate new requests onto them,
        preventing the real work from ever being scheduled.

        Returns the number of rows updated.
        """
        with self._tx() as cx:
            result = cx.execute(
                "UPDATE runs SET state='error', error='interrupted-by-process-restart',"
                " finished_at=? WHERE state IN ('pending','running')",
                (_now_iso(),),
            )
            return result.rowcount

    def find_active_run(
        self, *, kind: str, model_id: str | None = None
    ) -> dict[str, Any] | None:
        """Return the in-flight run (pending/running) of given kind for a model, if any."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM runs WHERE kind=? AND state IN ('pending','running')",
                (kind,),
            ).fetchall()
        for r in rows:
            d = dict(r)
            d["metadata"] = json.loads(d["metadata"]) if d.get("metadata") else {}
            if model_id is None:
                return d
            meta = d["metadata"]
            if (
                meta.get("model_id") == model_id
                or meta.get("chat_model_id") == model_id
                or meta.get("embedding_model_id") == model_id
            ):
                return d
        return None

    def find_active_operations(self) -> list[dict[str, Any]]:
        """Return all top-level in-flight operations (parent_run_id IS NULL, non-terminal)."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM runs WHERE parent_run_id IS NULL AND state IN ('pending','running')"
                " ORDER BY started_at",
            ).fetchall()
        out: list[dict[str, Any]] = []
        for r in rows:
            d = dict(r)
            d["metadata"] = json.loads(d["metadata"]) if d.get("metadata") else {}
            out.append(d)
        return out

    def recent_runs(self, limit: int = 10) -> list[dict[str, Any]]:
        """Return the most recent *limit* runs ordered by start time descending.

        Used by the diagnostics endpoint to avoid direct ``_conn`` access from
        outside this class.
        """
        with self._lock:
            rows = self._conn.execute(
                "SELECT run_id, kind, state, pct, started_at, finished_at, error"
                " FROM runs ORDER BY started_at DESC LIMIT ?",
                (limit,),
            ).fetchall()
        out: list[dict[str, Any]] = []
        for r in rows:
            d = dict(r)
            out.append(d)
        return out


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + "Z"
