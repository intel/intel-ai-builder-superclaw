"""SQLite-backed config KV (WAL mode, thread-safe).

Currently stores only the ``config`` table — a key/JSON-value store
consumed by ``routing/proxy.py`` for active model selections. Additional
tables (``models`` for file presence, ``runs`` for the async job ledger)
land when local model downloads + supervisor work go live.

Independent from ``services/backend_manager/store.py`` — separate DB file,
no cross-service shared persistence (plan §5 contract).
"""

from __future__ import annotations

import json
import os
import sqlite3
import tempfile
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from loguru import logger

from .state import default_state_root


_SCHEMA = """
CREATE TABLE IF NOT EXISTS config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS model_verifications (
    asset_id       TEXT PRIMARY KEY,
    expected_sha256 TEXT NOT NULL,
    filename       TEXT NOT NULL,
    size_bytes     INTEGER NOT NULL,
    mtime_ns       INTEGER NOT NULL,
    ctime_ns       INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS bundle_lifecycle (
    singleton       INTEGER PRIMARY KEY CHECK (singleton = 1),
    bundle_revision INTEGER NOT NULL,
    primary_bundle  TEXT,
    pending_bundle  TEXT,
    previous_bundle TEXT,
    prepare_token    TEXT,
    prepare_operation_id TEXT,
    primary_edge_config_fingerprint TEXT,
    pending_edge_config_fingerprint TEXT,
    pending_edge_model_selection_fingerprint TEXT,
    release_cleanup TEXT
);
CREATE TABLE IF NOT EXISTS bundle_idempotency (
    operation_id    TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    action          TEXT NOT NULL,
    request_json    TEXT NOT NULL,
    response_json   TEXT NOT NULL,
    PRIMARY KEY (operation_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS bundle_idempotency_legacy (
    action          TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_json    TEXT NOT NULL,
    response_json   TEXT NOT NULL,
    PRIMARY KEY (action, idempotency_key)
);
CREATE TABLE IF NOT EXISTS bundle_prepare_operations (
    operation_id     TEXT PRIMARY KEY,
    target_bundle_id TEXT NOT NULL,
    correlation_operation_id TEXT,
    target_bundle    TEXT,
    candidate_revision INTEGER,
    expected_bundle_revision INTEGER,
    bundle_revision INTEGER,
    idempotency_key TEXT,
    state            TEXT NOT NULL,
    pct              REAL NOT NULL,
    message          TEXT,
    reason_code      TEXT
);
"""


_DEFAULT_CONFIG: dict[str, Any] = {
    "active_chat_model_id": None,
    "active_embedding_model_id": None,
}


def default_db_path() -> Path:
    """Default SQLite DB path — sibling of the state directory."""
    return default_state_root().parent / "llmrouter_manager.db"


def export_model_verifications(source: Path, destination: Path) -> int:
    """Create a fresh database containing only model verification records."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        prefix=destination.name + ".", suffix=".tmp", dir=str(destination.parent)
    )
    os.close(fd)
    tmp = Path(tmp_name)
    source_conn: sqlite3.Connection | None = None
    destination_conn: sqlite3.Connection | None = None
    try:
        source_conn = sqlite3.connect(source)
        destination_conn = sqlite3.connect(tmp)
        try:
            source_conn.row_factory = sqlite3.Row
            columns = {
                row["name"]
                for row in source_conn.execute(
                    "PRAGMA table_info(model_verifications)"
                ).fetchall()
            }
            required = {
                "asset_id",
                "expected_sha256",
                "filename",
                "size_bytes",
                "mtime_ns",
            }
            if not required.issubset(columns):
                raise RuntimeError("source model_verifications schema is incompatible")
            ctime_expression = "ctime_ns" if "ctime_ns" in columns else "0 AS ctime_ns"
            rows = source_conn.execute(
                "SELECT asset_id, expected_sha256, filename, size_bytes, mtime_ns, "
                f"{ctime_expression} FROM model_verifications"
            ).fetchall()
            destination_conn.executescript(_SCHEMA)
            destination_conn.executemany(
                "INSERT INTO model_verifications"
                "(asset_id, expected_sha256, filename, size_bytes, mtime_ns, ctime_ns) "
                "VALUES(?, ?, ?, ?, ?, ?)",
                [tuple(row) for row in rows],
            )
            destination_conn.commit()
        finally:
            if destination_conn is not None:
                destination_conn.close()
            if source_conn is not None:
                source_conn.close()
        os.replace(tmp, destination)
        return len(rows)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


class Store:
    """Thread-safe SQLite wrapper backing the per-user config KV.

    Single connection shared across threads (``check_same_thread=False``);
    every operation is serialized via ``self._lock``.
    """

    def __init__(self, db_path: Path) -> None:
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(
            db_path,
            check_same_thread=False,
            isolation_level=None,
            timeout=30.0,
        )
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA synchronous=NORMAL")
        self._conn.executescript(_SCHEMA)
        self._ensure_bundle_idempotency_schema()
        self._ensure_bundle_lifecycle_columns()
        self._ensure_bundle_prepare_operation_columns()
        self._ensure_model_verification_columns()
        self._seed_defaults()
        self._conn.execute(
            "INSERT OR IGNORE INTO bundle_lifecycle"
            "(singleton, bundle_revision, primary_bundle, pending_bundle, previous_bundle) "
            "VALUES(1, 0, NULL, NULL, NULL)"
        )
        self._recover_interrupted_preparation()

    def close(self) -> None:
        with self._lock:
            self._conn.close()

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
        with self._tx() as cx:
            for k, v in _DEFAULT_CONFIG.items():
                cx.execute(
                    "INSERT OR IGNORE INTO config(key, value) VALUES(?, ?)",
                    (k, json.dumps(v)),
                )

    def _ensure_bundle_lifecycle_columns(self) -> None:
        columns = {
            row["name"]
            for row in self._conn.execute("PRAGMA table_info(bundle_lifecycle)").fetchall()
        }
        for name in (
            "prepare_token",
            "prepare_operation_id",
            "primary_edge_config_fingerprint",
            "pending_edge_config_fingerprint",
            "pending_edge_model_selection_fingerprint",
            "release_cleanup",
        ):
            if name not in columns:
                self._conn.execute(f"ALTER TABLE bundle_lifecycle ADD COLUMN {name} TEXT")

    def _ensure_bundle_idempotency_schema(self) -> None:
        columns = {
            row["name"]
            for row in self._conn.execute("PRAGMA table_info(bundle_idempotency)").fetchall()
        }
        if columns == {
            "operation_id",
            "idempotency_key",
            "action",
            "request_json",
            "response_json",
        }:
            return
        with self._tx() as cx:
            cx.execute(
                "INSERT OR IGNORE INTO bundle_idempotency_legacy"
                "(action, idempotency_key, request_json, response_json) "
                "SELECT action, idempotency_key, request_json, response_json "
                "FROM bundle_idempotency"
            )
            cx.execute("DROP TABLE bundle_idempotency")
            cx.execute(
                "CREATE TABLE bundle_idempotency ("
                "operation_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, "
                "action TEXT NOT NULL, request_json TEXT NOT NULL, response_json TEXT NOT NULL, "
                "PRIMARY KEY (operation_id, idempotency_key))"
            )

    def _ensure_model_verification_columns(self) -> None:
        columns = {
            row["name"]
            for row in self._conn.execute("PRAGMA table_info(model_verifications)").fetchall()
        }
        if "ctime_ns" not in columns:
            self._conn.execute(
                "ALTER TABLE model_verifications ADD COLUMN ctime_ns INTEGER NOT NULL DEFAULT 0"
            )

    def _ensure_bundle_prepare_operation_columns(self) -> None:
        columns = {
            row["name"]
            for row in self._conn.execute(
                "PRAGMA table_info(bundle_prepare_operations)"
            ).fetchall()
        }
        for name, sql_type in {
            "correlation_operation_id": "TEXT",
            "target_bundle": "TEXT",
            "candidate_revision": "INTEGER",
            "expected_bundle_revision": "INTEGER",
            "bundle_revision": "INTEGER",
            "idempotency_key": "TEXT",
            "allow_download": "INTEGER",
            "reason_code": "TEXT",
        }.items():
            if name not in columns:
                self._conn.execute(
                    f"ALTER TABLE bundle_prepare_operations ADD COLUMN {name} {sql_type}"
                )

    def _recover_interrupted_preparation(self) -> None:
        """Fail closed only when legacy evidence cannot support task recovery."""
        with self._tx() as cx:
            row = cx.execute(
                "SELECT l.pending_bundle, l.prepare_operation_id, o.allow_download "
                "FROM bundle_lifecycle l LEFT JOIN bundle_prepare_operations o "
                "ON o.operation_id = l.prepare_operation_id WHERE l.singleton = 1"
            ).fetchone()
            pending = json.loads(row["pending_bundle"]) if row and row["pending_bundle"] else None
            if not pending or pending.get("state") != "preparing" or row["allow_download"] is not None:
                return
            reason = "preparation recovery evidence is incomplete after service restart"
            pending["state"] = "error"
            pending["reason"] = reason
            logger.warning(
                "store.recover_interrupted_preparation operation_id={} reason={}",
                row["prepare_operation_id"],
                reason,
            )
            cx.execute(
                "UPDATE bundle_lifecycle SET pending_bundle = ?, prepare_token = NULL, "
                "pending_edge_config_fingerprint = NULL, "
                "pending_edge_model_selection_fingerprint = NULL WHERE singleton = 1",
                (json.dumps(pending, sort_keys=True),),
            )
            cx.execute(
                "UPDATE bundle_prepare_operations SET state = 'error', pct = 0, message = ? "
                "WHERE operation_id = ?",
                (reason, row["prepare_operation_id"]),
            )

    def reset_uncatalogued_bindings(
        self, *, bundle_ids: frozenset[str], model_ids: frozenset[str]
    ) -> None:
        """Drop saved Bundles and model selections the current catalogue no longer has.

        A retired committed Bundle resets the lifecycle row to the fresh-install
        state: the UI sends ``expected_bundle_revision = 0`` once no primary is
        reported, so a revision left above 0 would refuse every later prepare.
        A retired pending Bundle beside a catalogued primary clears only the
        pending slot.
        """
        with self._tx() as cx:
            row = cx.execute(
                "SELECT primary_bundle, pending_bundle, prepare_operation_id "
                "FROM bundle_lifecycle WHERE singleton = 1"
            ).fetchone()
            primary = json.loads(row["primary_bundle"]) if row["primary_bundle"] else None
            pending = json.loads(row["pending_bundle"]) if row["pending_bundle"] else None
            retired_primary = (
                primary.get("bundle_id")
                if primary and primary.get("bundle_id") not in bundle_ids
                else None
            )
            retired_pending = (
                pending.get("bundle_id")
                if pending and pending.get("bundle_id") not in bundle_ids
                else None
            )
            if retired_primary:
                cx.execute(
                    "UPDATE bundle_lifecycle SET bundle_revision = 0, primary_bundle = NULL, "
                    "pending_bundle = NULL, previous_bundle = NULL, prepare_token = NULL, "
                    "prepare_operation_id = NULL, primary_edge_config_fingerprint = NULL, "
                    "pending_edge_config_fingerprint = NULL WHERE singleton = 1"
                )
            elif retired_pending:
                cx.execute(
                    "UPDATE bundle_lifecycle SET pending_bundle = NULL, prepare_token = NULL, "
                    "prepare_operation_id = NULL, pending_edge_config_fingerprint = NULL "
                    "WHERE singleton = 1"
                )
            if (retired_primary or retired_pending) and row["prepare_operation_id"]:
                cx.execute(
                    "UPDATE bundle_prepare_operations SET state = 'error', message = ? "
                    "WHERE operation_id = ? AND state = 'running'",
                    ("Bundle is no longer in the catalogue", row["prepare_operation_id"]),
                )
            retired_models: dict[str, str] = {}
            for key in ("active_chat_model_id", "active_embedding_model_id"):
                selected = cx.execute("SELECT value FROM config WHERE key = ?", (key,)).fetchone()
                model_id = json.loads(selected["value"]) if selected else None
                if model_id is not None and model_id not in model_ids:
                    retired_models[key] = str(model_id)
                    cx.execute(
                        "UPDATE config SET value = ? WHERE key = ?", (json.dumps(None), key)
                    )
        if retired_primary or retired_pending or retired_models:
            logger.warning(
                "store.reset_uncatalogued_bindings cleared state no longer in the catalogue: "
                "primary_bundle={} pending_bundle={} model_selections={}",
                retired_primary,
                retired_pending,
                retired_models,
            )

    def get_resumable_preparation(self) -> dict[str, Any] | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT l.pending_bundle, l.prepare_token, l.prepare_operation_id, "
                "o.correlation_operation_id, o.target_bundle, o.candidate_revision, "
                "o.expected_bundle_revision, o.bundle_revision, o.idempotency_key, "
                "o.allow_download, o.state, o.pct, o.message "
                "FROM bundle_lifecycle l JOIN bundle_prepare_operations o "
                "ON o.operation_id = l.prepare_operation_id WHERE l.singleton = 1"
            ).fetchone()
        if row is None or not row["pending_bundle"] or not row["prepare_token"]:
            return None
        pending = json.loads(row["pending_bundle"])
        if pending.get("state") != "preparing" or row["state"] != "running":
            return None
        required = (
            "correlation_operation_id",
            "target_bundle",
            "candidate_revision",
            "expected_bundle_revision",
            "bundle_revision",
            "idempotency_key",
            "allow_download",
        )
        if any(row[name] is None for name in required):
            return None
        return {
            "prepare_operation_id": str(row["prepare_operation_id"]),
            "prepare_token": str(row["prepare_token"]),
            "correlation_operation_id": str(row["correlation_operation_id"]),
            "target_bundle": json.loads(row["target_bundle"]),
            "candidate_revision": int(row["candidate_revision"]),
            "expected_bundle_revision": int(row["expected_bundle_revision"]),
            "bundle_revision": int(row["bundle_revision"]),
            "idempotency_key": str(row["idempotency_key"]),
            "allow_download": bool(row["allow_download"]),
            "pct": float(row["pct"]),
            "message": str(row["message"]) if row["message"] is not None else None,
        }

    def get_durable_preparation_operation(
        self, operation_id: str
    ) -> dict[str, Any] | None:
        """Reconstruct the preparation receipt from durable pending state."""
        evidence = self.get_preparation_lifecycle(operation_id)
        if evidence is None:
            return None
        state = str(evidence["state"])
        message = evidence["message"]
        target_bundle = evidence["target_bundle"]
        return {
            "operation_id": operation_id,
            "kind": "primary_bundle.prepare",
            "state": state,
            "pct": evidence["pct"],
            "message": message,
            "last_error_message": message if state == "error" else None,
            "started_at": None,
            "finished_at": None,
            "metadata": {"bundle_id": target_bundle["bundle_id"]},
            "children": [],
        }

    def get_preparation_lifecycle(
        self, operation_id: str
    ) -> dict[str, Any] | None:
        """Return the full durable capability lifecycle evidence."""
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM bundle_prepare_operations WHERE operation_id = ?",
                (operation_id,),
            ).fetchone()
        if row is None:
            return None
        required = (
            "correlation_operation_id",
            "target_bundle",
            "candidate_revision",
            "expected_bundle_revision",
            "bundle_revision",
            "idempotency_key",
        )
        if any(row[name] is None for name in required):
            raise PreparationEvidenceIncompatible(operation_id)
        return {
            "prepare_operation_id": operation_id,
            "correlation_operation_id": row["correlation_operation_id"],
            "target_bundle": json.loads(row["target_bundle"])
            if row["target_bundle"]
            else None,
            "candidate_revision": row["candidate_revision"],
            "expected_bundle_revision": row["expected_bundle_revision"],
            "bundle_revision": int(row["bundle_revision"]),
            "idempotency_key": row["idempotency_key"],
            "state": str(row["state"]),
            "pct": float(row["pct"]),
            "message": str(row["message"]) if row["message"] is not None else None,
            "reason_code": str(row["reason_code"]) if row["reason_code"] is not None else None,
        }

    def update_preparation_progress(
        self,
        operation_id: str,
        *,
        state: str,
        pct: float,
        message: str | None,
    ) -> None:
        with self._tx() as cx:
            cx.execute(
                "UPDATE bundle_prepare_operations SET state = ?, pct = ?, message = ? "
                "WHERE operation_id = ? AND state NOT IN ('done', 'error', 'cancelled')",
                (state, max(0.0, min(100.0, pct)), message, operation_id),
            )

    def set_preparation_reason_code(self, operation_id: str, reason_code: str | None) -> None:
        with self._tx() as cx:
            cx.execute(
                "UPDATE bundle_prepare_operations SET reason_code = ? WHERE operation_id = ?",
                (reason_code, operation_id),
            )

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

    def all_config(self) -> dict[str, Any]:
        with self._lock:
            rows = self._conn.execute("SELECT key, value FROM config").fetchall()
        return {r["key"]: json.loads(r["value"]) for r in rows}

    def get_model_verification(self, asset_id: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT expected_sha256, filename, size_bytes, mtime_ns, ctime_ns "
                "FROM model_verifications WHERE asset_id = ?",
                (asset_id,),
            ).fetchone()
        return dict(row) if row else None

    def set_model_verification(
        self,
        *,
        asset_id: str,
        expected_sha256: str,
        filename: str,
        size_bytes: int,
        mtime_ns: int,
        ctime_ns: int,
    ) -> None:
        with self._tx() as cx:
            cx.execute(
                "INSERT INTO model_verifications"
                "(asset_id, expected_sha256, filename, size_bytes, mtime_ns, ctime_ns) "
                "VALUES(?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(asset_id) DO UPDATE SET "
                "expected_sha256 = excluded.expected_sha256, "
                "filename = excluded.filename, size_bytes = excluded.size_bytes, "
                "mtime_ns = excluded.mtime_ns, ctime_ns = excluded.ctime_ns",
                (asset_id, expected_sha256, filename, size_bytes, mtime_ns, ctime_ns),
            )

    def delete_model_verification(self, asset_id: str) -> None:
        with self._tx() as cx:
            cx.execute("DELETE FROM model_verifications WHERE asset_id = ?", (asset_id,))

    def get_bundle_lifecycle(self) -> dict[str, Any]:
        with self._lock:
            row = self._conn.execute(
                "SELECT bundle_revision, primary_bundle, pending_bundle, previous_bundle, "
                "primary_edge_config_fingerprint "
                "FROM bundle_lifecycle WHERE singleton = 1"
            ).fetchone()
        if row is None:
            raise RuntimeError("bundle lifecycle row missing")
        return {
            "bundle_revision": int(row["bundle_revision"]),
            "primary_bundle": json.loads(row["primary_bundle"]) if row["primary_bundle"] else None,
            "pending_bundle": json.loads(row["pending_bundle"]) if row["pending_bundle"] else None,
            "previous_bundle": json.loads(row["previous_bundle"]) if row["previous_bundle"] else None,
            "primary_edge_config_fingerprint": row["primary_edge_config_fingerprint"],
        }

    def set_primary_bundle_for_test(
        self, primary: dict[str, Any], *, edge_fingerprint: str | None = None
    ) -> None:
        """Seed committed state for contract tests without weakening production CAS APIs."""
        with self._tx() as cx:
            cx.execute(
                "UPDATE bundle_lifecycle SET primary_bundle = ?, bundle_revision = ?, "
                "pending_bundle = NULL, primary_edge_config_fingerprint = ?, "
                "pending_edge_config_fingerprint = NULL, "
                "pending_edge_model_selection_fingerprint = NULL WHERE singleton = 1",
                (
                    json.dumps(primary, sort_keys=True),
                    int(primary["bundle_revision"]),
                    edge_fingerprint,
                ),
            )

    def get_preparation_binding(self) -> dict[str, str] | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT prepare_token, prepare_operation_id FROM bundle_lifecycle "
                "WHERE singleton = 1"
            ).fetchone()
        if row is None or not row["prepare_token"] or not row["prepare_operation_id"]:
            return None
        return {
            "prepare_token": str(row["prepare_token"]),
            "operation_id": str(row["prepare_operation_id"]),
        }

    def get_edge_config_fingerprint(self) -> str | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT primary_edge_config_fingerprint FROM bundle_lifecycle WHERE singleton = 1"
            ).fetchone()
        return str(row["primary_edge_config_fingerprint"]) if row and row["primary_edge_config_fingerprint"] else None

    def get_pending_edge_config_fingerprint(self) -> str | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT pending_edge_config_fingerprint FROM bundle_lifecycle WHERE singleton = 1"
            ).fetchone()
        return str(row["pending_edge_config_fingerprint"]) if row and row["pending_edge_config_fingerprint"] else None

    def get_pending_edge_model_selection_fingerprint(self) -> str | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT pending_edge_model_selection_fingerprint "
                "FROM bundle_lifecycle WHERE singleton = 1"
            ).fetchone()
        return (
            str(row["pending_edge_model_selection_fingerprint"])
            if row and row["pending_edge_model_selection_fingerprint"]
            else None
        )

    def bind_pending_edge_config(self, *, prepare_token: str, fingerprint: str) -> bool:
        with self._tx() as cx:
            changed = cx.execute(
                "UPDATE bundle_lifecycle SET pending_edge_config_fingerprint = ? "
                "WHERE singleton = 1 AND prepare_token = ?",
                (fingerprint, prepare_token),
            ).rowcount
        return changed == 1

    def set_pending_bundle(self, pending_bundle: dict[str, Any] | None) -> None:
        value = json.dumps(pending_bundle, sort_keys=True) if pending_bundle else None
        with self._tx() as cx:
            cx.execute(
                "UPDATE bundle_lifecycle SET pending_bundle = ?, prepare_token = NULL, "
                "prepare_operation_id = NULL, pending_edge_config_fingerprint = NULL, "
                "pending_edge_model_selection_fingerprint = NULL WHERE singleton = 1",
                (value,),
            )

    def claim_pending_bundle(
        self,
        *,
        pending_bundle: dict[str, Any],
        prepare_token: str,
        operation_id: str,
        correlation_operation_id: str,
        candidate_revision: int,
        expected_bundle_revision: int,
        idempotency_key: str,
        pending_edge_model_selection_fingerprint: str | None = None,
        allow_download: bool = False,
    ) -> tuple[bool, str | None]:
        """Atomically claim the one pending slot; only the owning saga may replay it."""
        with self._tx() as cx:
            row = cx.execute(
                "SELECT bundle_revision, pending_bundle, prepare_operation_id FROM bundle_lifecycle "
                "WHERE singleton = 1"
            ).fetchone()
            if row is None:
                raise RuntimeError("bundle lifecycle row missing")
            actual_revision = int(row["bundle_revision"])
            if actual_revision != expected_bundle_revision:
                raise BundleRevisionConflict(expected_bundle_revision, actual_revision)
            existing = json.loads(row["pending_bundle"]) if row and row["pending_bundle"] else None
            if existing and existing.get("state") in {"preparing", "prepared"}:
                existing_operation_id = row["prepare_operation_id"]
                evidence = (
                    cx.execute(
                        "SELECT correlation_operation_id, target_bundle_id, candidate_revision, "
                        "expected_bundle_revision, idempotency_key FROM bundle_prepare_operations "
                        "WHERE operation_id = ?",
                        (existing_operation_id,),
                    ).fetchone()
                    if existing_operation_id
                    else None
                )
                if (
                    evidence
                    and evidence["correlation_operation_id"] == correlation_operation_id
                    and evidence["target_bundle_id"] == pending_bundle.get("bundle_id")
                    and evidence["candidate_revision"] == candidate_revision
                    and evidence["expected_bundle_revision"] == expected_bundle_revision
                    and evidence["idempotency_key"] == idempotency_key
                ):
                    return False, str(existing_operation_id)
                raise PendingBundleConflict(str(pending_bundle.get("bundle_id")))
            cx.execute(
                "UPDATE bundle_lifecycle SET pending_bundle = ?, prepare_token = ?, "
                "prepare_operation_id = ?, pending_edge_config_fingerprint = NULL, "
                "pending_edge_model_selection_fingerprint = ? WHERE singleton = 1",
                (
                    json.dumps(pending_bundle, sort_keys=True),
                    prepare_token,
                    operation_id,
                    pending_edge_model_selection_fingerprint,
                ),
            )
            cx.execute(
                "INSERT INTO bundle_prepare_operations"
                "(operation_id, target_bundle_id, correlation_operation_id, target_bundle, "
                "candidate_revision, expected_bundle_revision, bundle_revision, "
                "idempotency_key, allow_download, state, pct, message) "
                "VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', 0, ?)",
                (
                    operation_id,
                    str(pending_bundle["bundle_id"]),
                    correlation_operation_id,
                    json.dumps(
                        {
                            key: value
                            for key, value in pending_bundle.items()
                            if key not in {"state", "reason"}
                        },
                        sort_keys=True,
                    ),
                    candidate_revision,
                    expected_bundle_revision,
                    expected_bundle_revision,
                    idempotency_key,
                    int(allow_download),
                    "preparing bundle",
                ),
            )
        return True, operation_id

    def transition_pending_bundle(
        self, *, prepare_token: str, pending_bundle: dict[str, Any] | None
    ) -> bool:
        value = json.dumps(pending_bundle, sort_keys=True) if pending_bundle else None
        clear_edge_identity = (
            pending_bundle is None
            or pending_bundle.get("state") in {"error", "cancelled"}
        )
        with self._tx() as cx:
            binding = cx.execute(
                "SELECT prepare_operation_id FROM bundle_lifecycle "
                "WHERE singleton = 1 AND prepare_token = ?",
                (prepare_token,),
            ).fetchone()
            changed = cx.execute(
                "UPDATE bundle_lifecycle SET pending_bundle = ?, "
                "prepare_token = CASE WHEN ? IS NULL THEN NULL ELSE prepare_token END, "
                "prepare_operation_id = CASE WHEN ? IS NULL THEN NULL ELSE prepare_operation_id END, "
                "pending_edge_config_fingerprint = CASE WHEN ? THEN NULL ELSE pending_edge_config_fingerprint END, "
                "pending_edge_model_selection_fingerprint = CASE WHEN ? THEN NULL "
                "ELSE pending_edge_model_selection_fingerprint END "
                "WHERE singleton = 1 AND prepare_token = ?",
                (
                    value,
                    value,
                    value,
                    int(clear_edge_identity),
                    int(clear_edge_identity),
                    prepare_token,
                ),
            ).rowcount
            if changed == 1 and binding and binding["prepare_operation_id"]:
                state = "cancelled" if pending_bundle is None else (
                    "done" if pending_bundle.get("state") == "prepared" else (
                        "error" if pending_bundle.get("state") == "error" else "running"
                    )
                )
                message = (
                    "bundle prepared" if state == "done" else
                    "preparation cancelled" if state == "cancelled" else
                    str((pending_bundle or {}).get("reason") or "preparing bundle")
                )
                cx.execute(
                    "UPDATE bundle_prepare_operations SET state = ?, pct = ?, message = ? "
                    "WHERE operation_id = ?",
                    (state, 100 if state == "done" else 0, message, binding["prepare_operation_id"]),
                )
        return changed == 1

    def abort_pending_bundle(self, target_bundle_id: str) -> str | None:
        with self._tx() as cx:
            row = cx.execute(
                "SELECT pending_bundle, prepare_operation_id FROM bundle_lifecycle "
                "WHERE singleton = 1"
            ).fetchone()
            pending = json.loads(row["pending_bundle"]) if row and row["pending_bundle"] else None
            if pending is not None and pending.get("bundle_id") != target_bundle_id:
                raise PendingBundleConflict(target_bundle_id)
            operation_id = str(row["prepare_operation_id"]) if row and row["prepare_operation_id"] else None
            cx.execute(
                "UPDATE bundle_lifecycle SET pending_bundle = NULL, prepare_token = NULL, "
                "prepare_operation_id = NULL, pending_edge_config_fingerprint = NULL, "
                "pending_edge_model_selection_fingerprint = NULL WHERE singleton = 1"
            )
        return operation_id

    def commit_pending_bundle(
        self,
        *,
        target_bundle_id: str,
        expected_revision: int,
        current_edge_config_fingerprint: str | None = None,
        current_edge_model_selection_fingerprint: str | None = None,
    ) -> dict[str, Any]:
        with self._tx() as cx:
            row = cx.execute(
                "SELECT bundle_revision, primary_bundle, pending_bundle, pending_edge_config_fingerprint, "
                "pending_edge_model_selection_fingerprint "
                "FROM bundle_lifecycle WHERE singleton = 1"
            ).fetchone()
            if row is None:
                raise RuntimeError("bundle lifecycle row missing")
            actual_revision = int(row["bundle_revision"])
            if actual_revision != expected_revision:
                raise BundleRevisionConflict(expected_revision, actual_revision)
            pending = json.loads(row["pending_bundle"]) if row["pending_bundle"] else None
            if pending is None or pending.get("bundle_id") != target_bundle_id:
                raise PendingBundleConflict(target_bundle_id)
            if pending.get("state") != "prepared":
                raise PendingBundleConflict(target_bundle_id)
            if (
                pending.get("backend") == "edge"
                and (
                    not row["pending_edge_config_fingerprint"]
                    or row["pending_edge_config_fingerprint"]
                    != current_edge_config_fingerprint
                    or not row["pending_edge_model_selection_fingerprint"]
                    or (
                        row["pending_edge_model_selection_fingerprint"]
                        != current_edge_model_selection_fingerprint
                    )
                )
            ):
                raise EdgeConfigChanged
            revision = actual_revision + 1
            primary = {**pending, "bundle_revision": revision, "state": "ready"}
            primary.pop("reason", None)
            previous = row["primary_bundle"]
            cx.execute(
                "UPDATE bundle_lifecycle SET bundle_revision = ?, primary_bundle = ?, "
                "pending_bundle = NULL, previous_bundle = ?, prepare_token = NULL, "
                "prepare_operation_id = NULL, primary_edge_config_fingerprint = ?, "
                "pending_edge_config_fingerprint = NULL, "
                "pending_edge_model_selection_fingerprint = NULL WHERE singleton = 1",
                (
                    revision,
                    json.dumps(primary, sort_keys=True),
                    previous,
                    row["pending_edge_config_fingerprint"],
                ),
            )
            for key, value in (
                ("active_chat_model_id", primary["chat_model_id"]),
                ("active_embedding_model_id", primary["embedding_model_id"]),
            ):
                cx.execute(
                    "INSERT INTO config(key, value) VALUES(?, ?) "
                    "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    (key, json.dumps(value)),
                )
        return primary

    def commit_pending_bundle_idempotent(
        self,
        *,
        target_bundle_id: str,
        expected_revision: int,
        correlation_operation_id: str,
        prepare_operation_id: str,
        idempotency_key: str,
        request: dict[str, Any],
        current_edge_config_fingerprint: str | None = None,
        current_edge_model_selection_fingerprint: str | None = None,
    ) -> tuple[dict[str, Any], bool]:
        request_json = json.dumps(request, sort_keys=True, separators=(",", ":"))
        with self._tx() as cx:
            replay = cx.execute(
                "SELECT action, request_json, response_json FROM bundle_idempotency "
                "WHERE operation_id = ? AND idempotency_key = ?",
                (correlation_operation_id, idempotency_key),
            ).fetchone()
            if replay:
                if replay["action"] != "commit" or replay["request_json"] != request_json:
                    raise IdempotencyConflict("commit", idempotency_key)
                return json.loads(replay["response_json"]), True
            self._raise_for_legacy_idempotency(cx, idempotency_key)
            row = cx.execute(
                "SELECT bundle_revision, primary_bundle, pending_bundle, prepare_operation_id, "
                "pending_edge_config_fingerprint, pending_edge_model_selection_fingerprint "
                "FROM bundle_lifecycle WHERE singleton = 1"
            ).fetchone()
            if row is None:
                raise RuntimeError("bundle lifecycle row missing")
            actual_revision = int(row["bundle_revision"])
            if actual_revision != expected_revision:
                raise BundleRevisionConflict(expected_revision, actual_revision)
            evidence = cx.execute(
                "SELECT * FROM bundle_prepare_operations WHERE operation_id = ?",
                (prepare_operation_id,),
            ).fetchone()
            if not self._preparation_identity_matches(
                evidence,
                correlation_operation_id=correlation_operation_id,
                prepare_operation_id=prepare_operation_id,
                target_bundle_id=target_bundle_id,
                expected_bundle_revision=expected_revision,
            ):
                raise PreparationIdentityMismatch(prepare_operation_id)
            if row["prepare_operation_id"] != prepare_operation_id:
                raise PreparationIdentityMismatch(prepare_operation_id)
            pending = json.loads(row["pending_bundle"]) if row["pending_bundle"] else None
            if (
                pending is None
                or pending.get("bundle_id") != target_bundle_id
                or pending.get("state") != "prepared"
            ):
                raise PendingBundleConflict(target_bundle_id)
            if (
                pending.get("backend") == "edge"
                and (
                    not row["pending_edge_config_fingerprint"]
                    or row["pending_edge_config_fingerprint"]
                    != current_edge_config_fingerprint
                    or not row["pending_edge_model_selection_fingerprint"]
                    or (
                        row["pending_edge_model_selection_fingerprint"]
                        != current_edge_model_selection_fingerprint
                    )
                )
            ):
                raise EdgeConfigChanged
            revision = actual_revision + 1
            primary = {**pending, "bundle_revision": revision, "state": "ready"}
            primary.pop("reason", None)
            cx.execute(
                "UPDATE bundle_lifecycle SET bundle_revision = ?, primary_bundle = ?, "
                "pending_bundle = NULL, previous_bundle = ?, prepare_token = NULL, "
                "prepare_operation_id = NULL, primary_edge_config_fingerprint = ?, "
                "pending_edge_config_fingerprint = NULL, "
                "pending_edge_model_selection_fingerprint = NULL WHERE singleton = 1",
                (
                    revision,
                    json.dumps(primary, sort_keys=True),
                    row["primary_bundle"],
                    row["pending_edge_config_fingerprint"],
                ),
            )
            for key, value in (
                ("active_chat_model_id", primary["chat_model_id"]),
                ("active_embedding_model_id", primary["embedding_model_id"]),
            ):
                cx.execute(
                    "INSERT INTO config(key, value) VALUES(?, ?) "
                    "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    (key, json.dumps(value)),
                )
            cx.execute(
                "UPDATE bundle_prepare_operations SET bundle_revision = ?, state = 'done', "
                "pct = 100, message = ?, idempotency_key = ? WHERE operation_id = ?",
                (revision, "bundle committed", idempotency_key, prepare_operation_id),
            )
            response = self._lifecycle_response(
                evidence,
                bundle_revision=revision,
                idempotency_key=idempotency_key,
                state="done",
                message="bundle committed",
            )
            cx.execute(
                "INSERT INTO bundle_idempotency"
                "(operation_id, idempotency_key, action, request_json, response_json) "
                "VALUES(?, ?, 'commit', ?, ?)",
                (correlation_operation_id, idempotency_key, request_json, json.dumps(response, sort_keys=True)),
            )
        logger.info(
            "store.bundle_committed correlation_operation_id={} prepare_operation_id={} bundle_revision={}",
            correlation_operation_id,
            prepare_operation_id,
            revision,
        )
        return response, False

    def validate_pending_bundle_commit(
        self,
        *,
        target_bundle_id: str,
        expected_revision: int,
        correlation_operation_id: str,
        prepare_operation_id: str,
    ) -> dict[str, Any]:
        """Validate a prepared candidate without changing Binding authority."""
        with self._lock:
            row = self._conn.execute(
                "SELECT bundle_revision, pending_bundle, prepare_operation_id "
                "FROM bundle_lifecycle WHERE singleton = 1"
            ).fetchone()
            if row is None:
                raise RuntimeError("bundle lifecycle row missing")
            actual_revision = int(row["bundle_revision"])
            if actual_revision != expected_revision:
                raise BundleRevisionConflict(expected_revision, actual_revision)
            evidence = self._conn.execute(
                "SELECT * FROM bundle_prepare_operations WHERE operation_id = ?",
                (prepare_operation_id,),
            ).fetchone()
            if not self._preparation_identity_matches(
                evidence,
                correlation_operation_id=correlation_operation_id,
                prepare_operation_id=prepare_operation_id,
                target_bundle_id=target_bundle_id,
                expected_bundle_revision=expected_revision,
            ):
                raise PreparationIdentityMismatch(prepare_operation_id)
            if row["prepare_operation_id"] != prepare_operation_id:
                raise PreparationIdentityMismatch(prepare_operation_id)
            pending = json.loads(row["pending_bundle"]) if row["pending_bundle"] else None
            if (
                pending is None
                or pending.get("bundle_id") != target_bundle_id
                or pending.get("state") != "prepared"
            ):
                raise PendingBundleConflict(target_bundle_id)
            return pending

    def release_primary_bundle_idempotent(
        self,
        *,
        expected_revision: int,
        correlation_operation_id: str,
        idempotency_key: str,
        request: dict[str, Any],
        cloud_only_lite: bool,
    ) -> tuple[dict[str, Any], bool]:
        """Release the committed primary Bundle with no replacement target.

        Only an Edge primary Bundle on cloud-only Lite hardware may be released;
        anything else raises `PrimaryBundleNotReleasable`. A replay is answered
        from its idempotency record before those checks, so recovery still works.
        The release also records a pending cleanup; see `get_pending_release_cleanup`.
        """
        request_json = json.dumps(request, sort_keys=True, separators=(",", ":"))
        with self._tx() as cx:
            replay = cx.execute(
                "SELECT action, request_json, response_json FROM bundle_idempotency "
                "WHERE operation_id = ? AND idempotency_key = ?",
                (correlation_operation_id, idempotency_key),
            ).fetchone()
            if replay:
                if replay["action"] != "release" or replay["request_json"] != request_json:
                    raise IdempotencyConflict("release", idempotency_key)
                return json.loads(replay["response_json"]), True
            self._raise_for_legacy_idempotency(cx, idempotency_key)
            if not cloud_only_lite:
                raise PrimaryBundleNotReleasable("Disconnect is only available on Lite hardware")
            row = cx.execute(
                "SELECT bundle_revision, primary_bundle, pending_bundle FROM bundle_lifecycle WHERE singleton = 1"
            ).fetchone()
            if row is None:
                raise RuntimeError("bundle lifecycle row missing")
            actual_revision = int(row["bundle_revision"])
            if actual_revision != expected_revision:
                raise BundleRevisionConflict(expected_revision, actual_revision)
            primary = json.loads(row["primary_bundle"]) if row["primary_bundle"] else None
            if primary is None:
                raise PrimaryBundleNotReleasable("no committed primary Bundle to release")
            if primary.get("backend") != "edge":
                raise PrimaryBundleNotReleasable("only the Edge primary Bundle can be released")
            pending = json.loads(row["pending_bundle"]) if row["pending_bundle"] else None
            if is_preparation_in_flight(pending):
                # Releasing would move the revision under this preparation, so it could never commit or abort.
                raise PrimaryBundleNotReleasable("a Bundle preparation is in progress")
            revision = actual_revision + 1
            cleanup = {
                "correlation_operation_id": correlation_operation_id,
                "idempotency_key": idempotency_key,
                "delete_edge_config": True,
            }
            cx.execute(
                "UPDATE bundle_lifecycle SET bundle_revision = ?, primary_bundle = NULL, "
                "previous_bundle = ?, primary_edge_config_fingerprint = NULL, release_cleanup = ? "
                "WHERE singleton = 1",
                (revision, row["primary_bundle"], json.dumps(cleanup, sort_keys=True)),
            )
            response = {
                "contract_version": 1,
                "correlation_operation_id": correlation_operation_id,
                "idempotency_key": idempotency_key,
                "state": "succeeded",
            }
            cx.execute(
                "INSERT INTO bundle_idempotency"
                "(operation_id, idempotency_key, action, request_json, response_json) "
                "VALUES(?, ?, 'release', ?, ?)",
                (correlation_operation_id, idempotency_key, request_json, json.dumps(response, sort_keys=True)),
            )
        logger.info(
            "store.bundle_released correlation_operation_id={} bundle_revision={}",
            correlation_operation_id,
            revision,
        )
        return response, False

    def get_pending_release_cleanup(
        self, *, correlation_operation_id: str, idempotency_key: str
    ) -> dict[str, Any] | None:
        """Return this release's unfinished cleanup, or None once done or superseded.

        A newer release replaces the record, so a replay of an older release finds
        nothing to clean. Once Edge config is saved after the release,
        `delete_edge_config` turns false and `saved_edge_config_fingerprint` names the
        config that save wrote; the caller keeps `edge.json` only while it still holds
        that config, so a save that failed or never ran cannot keep the released one.
        """
        with self._lock:
            row = self._conn.execute(
                "SELECT release_cleanup FROM bundle_lifecycle WHERE singleton = 1"
            ).fetchone()
        cleanup = _matching_release_cleanup(row, correlation_operation_id, idempotency_key)
        if cleanup is None:
            return None
        return {
            "delete_edge_config": bool(cleanup.get("delete_edge_config")),
            "saved_edge_config_fingerprint": cleanup.get("saved_edge_config_fingerprint"),
        }

    def retain_edge_config_after_release(self, fingerprint: str) -> None:
        """Keep the Edge config about to be saved out of any unfinished release cleanup.

        Callers hold `edge_config_lock` and call this before writing the config whose
        fingerprint they pass. The fingerprint is the evidence: if the write then
        fails or the process crashes first, `edge.json` still holds the released
        config, its fingerprint differs, and a release replay still deletes it.
        """
        with self._tx() as cx:
            row = cx.execute("SELECT release_cleanup FROM bundle_lifecycle WHERE singleton = 1").fetchone()
            if row is None or not row["release_cleanup"]:
                return
            cleanup = json.loads(row["release_cleanup"])
            cleanup["delete_edge_config"] = False
            cleanup["saved_edge_config_fingerprint"] = fingerprint
            cx.execute(
                "UPDATE bundle_lifecycle SET release_cleanup = ? WHERE singleton = 1",
                (json.dumps(cleanup, sort_keys=True),),
            )

    def finish_release_cleanup(self, *, correlation_operation_id: str, idempotency_key: str) -> None:
        with self._tx() as cx:
            row = cx.execute("SELECT release_cleanup FROM bundle_lifecycle WHERE singleton = 1").fetchone()
            if _matching_release_cleanup(row, correlation_operation_id, idempotency_key) is not None:
                cx.execute("UPDATE bundle_lifecycle SET release_cleanup = NULL WHERE singleton = 1")

    def get_commit_response(
        self, *, correlation_operation_id: str, idempotency_key: str
    ) -> dict[str, Any] | None:
        """Return the durable commit receipt, never a transient POST response."""
        with self._lock:
            row = self._conn.execute(
                "SELECT action, response_json FROM bundle_idempotency "
                "WHERE operation_id = ? AND idempotency_key = ?",
                (correlation_operation_id, idempotency_key),
            ).fetchone()
        if row is None or row["action"] != "commit":
            return None
        return json.loads(row["response_json"])

    def abort_pending_bundle_idempotent(
        self,
        *,
        target_bundle_id: str,
        expected_revision: int,
        correlation_operation_id: str,
        prepare_operation_id: str,
        idempotency_key: str,
        request: dict[str, Any],
    ) -> tuple[dict[str, Any], str | None]:
        request_json = json.dumps(request, sort_keys=True, separators=(",", ":"))
        with self._tx() as cx:
            replay = cx.execute(
                "SELECT action, request_json, response_json FROM bundle_idempotency "
                "WHERE operation_id = ? AND idempotency_key = ?",
                (correlation_operation_id, idempotency_key),
            ).fetchone()
            if replay:
                if replay["action"] != "abort" or replay["request_json"] != request_json:
                    raise IdempotencyConflict("abort", idempotency_key)
                return json.loads(replay["response_json"]), None
            self._raise_for_legacy_idempotency(cx, idempotency_key)
            row = cx.execute(
                "SELECT bundle_revision, pending_bundle, prepare_operation_id FROM bundle_lifecycle "
                "WHERE singleton = 1"
            ).fetchone()
            if row is None:
                raise RuntimeError("bundle lifecycle row missing")
            actual_revision = int(row["bundle_revision"])
            if actual_revision != expected_revision:
                raise BundleRevisionConflict(expected_revision, actual_revision)
            evidence = cx.execute(
                "SELECT * FROM bundle_prepare_operations WHERE operation_id = ?",
                (prepare_operation_id,),
            ).fetchone()
            if not self._preparation_identity_matches(
                evidence,
                correlation_operation_id=correlation_operation_id,
                prepare_operation_id=prepare_operation_id,
                target_bundle_id=target_bundle_id,
                expected_bundle_revision=expected_revision,
            ):
                raise PreparationIdentityMismatch(prepare_operation_id)
            if row["prepare_operation_id"] != prepare_operation_id:
                raise PreparationIdentityMismatch(prepare_operation_id)
            pending = json.loads(row["pending_bundle"]) if row and row["pending_bundle"] else None
            if pending is not None and pending.get("bundle_id") != target_bundle_id:
                raise PendingBundleConflict(target_bundle_id)
            operation_id = prepare_operation_id
            cx.execute(
                "UPDATE bundle_lifecycle SET pending_bundle = NULL, prepare_token = NULL, "
                "prepare_operation_id = NULL, pending_edge_config_fingerprint = NULL, "
                "pending_edge_model_selection_fingerprint = NULL WHERE singleton = 1"
            )
            cx.execute(
                "UPDATE bundle_prepare_operations SET state = 'cancelled', pct = 100, "
                "message = ?, idempotency_key = ? "
                "WHERE operation_id = ?",
                ("bundle preparation aborted", idempotency_key, operation_id),
            )
            response = self._lifecycle_response(
                evidence,
                bundle_revision=actual_revision,
                idempotency_key=idempotency_key,
                state="cancelled",
                message="bundle preparation aborted",
            )
            cx.execute(
                "INSERT INTO bundle_idempotency"
                "(operation_id, idempotency_key, action, request_json, response_json) "
                "VALUES(?, ?, 'abort', ?, ?)",
                (correlation_operation_id, idempotency_key, request_json, json.dumps(response, sort_keys=True)),
            )
        logger.info(
            "store.bundle_aborted correlation_operation_id={} prepare_operation_id={}",
            correlation_operation_id,
            prepare_operation_id,
        )
        return response, operation_id

    @staticmethod
    def _preparation_identity_matches(
        evidence: sqlite3.Row | None,
        *,
        correlation_operation_id: str,
        prepare_operation_id: str,
        target_bundle_id: str,
        expected_bundle_revision: int,
    ) -> bool:
        return bool(
            evidence
            and evidence["operation_id"] == prepare_operation_id
            and evidence["correlation_operation_id"] == correlation_operation_id
            and evidence["target_bundle_id"] == target_bundle_id
            and evidence["expected_bundle_revision"] == expected_bundle_revision
        )

    @staticmethod
    def _lifecycle_response(
        evidence: sqlite3.Row,
        *,
        bundle_revision: int,
        idempotency_key: str,
        state: str,
        message: str,
    ) -> dict[str, Any]:
        return {
            "contract_version": 1,
            "correlation_operation_id": str(evidence["correlation_operation_id"]),
            "prepare_operation_id": str(evidence["operation_id"]),
            "target_bundle": json.loads(evidence["target_bundle"]),
            "candidate_revision": int(evidence["candidate_revision"]),
            "expected_bundle_revision": int(evidence["expected_bundle_revision"]),
            "bundle_revision": bundle_revision,
            "idempotency_key": idempotency_key,
            "state": state,
            "pct": 100.0,
            "message": message,
        }

    def get_idempotent_response(
        self, operation_id: str, action: str, idempotency_key: str, request: dict[str, Any]
    ) -> dict[str, Any] | None:
        request_json = json.dumps(request, sort_keys=True, separators=(",", ":"))
        with self._lock:
            row = self._conn.execute(
                "SELECT action, request_json, response_json FROM bundle_idempotency "
                "WHERE operation_id = ? AND idempotency_key = ?",
                (operation_id, idempotency_key),
            ).fetchone()
        if row is None:
            with self._lock:
                legacy = self._conn.execute(
                    "SELECT 1 FROM bundle_idempotency_legacy WHERE idempotency_key = ?",
                    (idempotency_key,),
                ).fetchone()
            if legacy is not None:
                raise IdempotencyConflict(action, idempotency_key)
            return None
        if row["action"] != action or row["request_json"] != request_json:
            raise IdempotencyConflict(action, idempotency_key)
        return json.loads(row["response_json"])

    def set_idempotent_response(
        self,
        operation_id: str,
        action: str,
        idempotency_key: str,
        request: dict[str, Any],
        response: dict[str, Any],
    ) -> None:
        request_json = json.dumps(request, sort_keys=True, separators=(",", ":"))
        with self._tx() as cx:
            existing = cx.execute(
                "SELECT action, request_json FROM bundle_idempotency "
                "WHERE operation_id = ? AND idempotency_key = ?",
                (operation_id, idempotency_key),
            ).fetchone()
            if existing:
                if existing["action"] != action or existing["request_json"] != request_json:
                    raise IdempotencyConflict(action, idempotency_key)
                return
            self._raise_for_legacy_idempotency(cx, idempotency_key)
            cx.execute(
                "INSERT INTO bundle_idempotency"
                "(operation_id, idempotency_key, action, request_json, response_json) "
                "VALUES(?, ?, ?, ?, ?)",
                (operation_id, idempotency_key, action, request_json, json.dumps(response, sort_keys=True)),
            )

    @staticmethod
    def _raise_for_legacy_idempotency(
        cx: sqlite3.Connection, idempotency_key: str
    ) -> None:
        legacy = cx.execute(
            "SELECT 1 FROM bundle_idempotency_legacy WHERE idempotency_key = ?",
            (idempotency_key,),
        ).fetchone()
        if legacy is not None:
            raise IdempotencyConflict("legacy", idempotency_key)


class BundleRevisionConflict(RuntimeError):
    def __init__(self, expected: int, actual: int) -> None:
        super().__init__(f"expected bundle revision {expected}, actual {actual}")
        self.expected = expected
        self.actual = actual


class PendingBundleConflict(RuntimeError):
    pass


class PreparationIdentityMismatch(RuntimeError):
    pass


class PrimaryBundleNotReleasable(RuntimeError):
    pass


def is_preparation_in_flight(pending: dict[str, Any] | None) -> bool:
    """True while a pending Bundle can still commit or abort (an `error` slot is discardable)."""
    return pending is not None and pending.get("state") in {"preparing", "prepared"}


def _matching_release_cleanup(
    row: sqlite3.Row | None, correlation_operation_id: str, idempotency_key: str
) -> dict[str, Any] | None:
    if row is None or not row["release_cleanup"]:
        return None
    cleanup = json.loads(row["release_cleanup"])
    if (
        cleanup.get("correlation_operation_id") != correlation_operation_id
        or cleanup.get("idempotency_key") != idempotency_key
    ):
        return None
    return cleanup


class EdgeConfigChanged(RuntimeError):
    pass


class PreparationEvidenceIncompatible(RuntimeError):
    pass


class IdempotencyConflict(RuntimeError):
    pass
