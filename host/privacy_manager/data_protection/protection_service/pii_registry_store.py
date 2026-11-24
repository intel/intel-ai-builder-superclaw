"""SQLite-backed PII session/operation registry store.

Records metadata about each protect/redact operation so later calls can
look up the registry file to rewrite queries or restore agent responses
without requiring the caller to carry the full registry payload.

The DB stores only metadata pointers — the actual placeholder→original
mapping stays in the registry JSON files managed by RedactsStore. No new
surface holds plaintext PII. Rows are reaped on TTL sweep, co-ordinated
with the existing RedactsStore sweeper loop via add_sweep_hook().

Schema:
    pii_registry_operations
        session_id    TEXT  scoped caller session id
        operation_id  TEXT  uuid hex slice from _new_operation_id()
        pipeline      TEXT  'file' | 'text'
        source_path   TEXT  container-visible /workspace/... path (nullable)
        masked_path   TEXT  masked file path returned to the agent (nullable)
        registry_path TEXT  host path of the registry JSON file (nullable)
        created_at    INTEGER  epoch seconds
        expires_at    INTEGER  epoch seconds
        PRIMARY KEY (session_id, operation_id)
"""
from __future__ import annotations

import logging
import sqlite3
import threading
import time
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class OperationRecord:
    """One protect/redact operation's metadata row."""

    session_id: str
    operation_id: str
    pipeline: str           # 'file' | 'text'
    source_path: str | None
    masked_path: str | None
    registry_path: str | None
    created_at: float       # epoch seconds
    expires_at: float       # epoch seconds


class PiiRegistryStore:
    """TTL-managed SQLite store for PII operation metadata.

    Thread-safe via per-thread connections (WAL mode allows concurrent
    readers). Schema is bootstrapped on construction. Every public method
    swallows exceptions so a locked/corrupt DB never raises into request
    handlers — it degrades gracefully (query/restore endpoints return 404).

    Intended to be driven by the RedactsStore sweeper loop::

        redacts_store.add_sweep_hook(pii_registry_store.sweep_expired)
    """

    # Default TTL matches RedactsStore max_ttl_seconds (1 hour). Override
    # by passing ``ttl_seconds`` to the constructor, e.g. to match the
    # value from AppConfig.redact.max_ttl_seconds.
    _DEFAULT_TTL_SECONDS: int = 3_600

    def __init__(self, db_path: Path, *, ttl_seconds: int | None = None) -> None:
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self._db_path = str(db_path)
        self._ttl_seconds = ttl_seconds if ttl_seconds is not None else self._DEFAULT_TTL_SECONDS
        self._local = threading.local()
        self._schema_lock = threading.Lock()
        self._schema_ready = False
        self._ensure_schema()

    # ------------------------------------------------------------------
    # Internal: connection + schema
    # ------------------------------------------------------------------

    def _conn(self) -> sqlite3.Connection:
        """Return this thread's SQLite connection, creating it if needed."""
        conn = getattr(self._local, "conn", None)
        if conn is None:
            self._ensure_schema()
            conn = sqlite3.connect(
                self._db_path,
                timeout=5.0,
                isolation_level=None,
                check_same_thread=False,
            )
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA synchronous=NORMAL")
            conn.execute("PRAGMA busy_timeout=5000")
            self._local.conn = conn
        return conn

    def _ensure_schema(self) -> None:
        """Idempotent DDL bootstrap, safe under concurrent construction."""
        if self._schema_ready:
            return
        with self._schema_lock:
            if self._schema_ready:
                return
            try:
                init_conn = sqlite3.connect(
                    self._db_path,
                    timeout=5.0,
                    isolation_level=None,
                    check_same_thread=False,
                )
                try:
                    init_conn.execute("PRAGMA journal_mode=WAL")
                    init_conn.execute("PRAGMA synchronous=NORMAL")
                    init_conn.execute(
                        "CREATE TABLE IF NOT EXISTS pii_registry_operations ("
                        "  session_id    TEXT    NOT NULL,"
                        "  operation_id  TEXT    NOT NULL,"
                        "  pipeline      TEXT    NOT NULL,"
                        "  source_path   TEXT,"
                        "  masked_path   TEXT,"
                        "  registry_path TEXT,"
                        "  created_at    INTEGER NOT NULL,"
                        "  expires_at    INTEGER NOT NULL,"
                        "  PRIMARY KEY (session_id, operation_id)"
                        ")"
                    )
                    init_conn.execute(
                        "CREATE INDEX IF NOT EXISTS idx_pii_registry_session "
                        "ON pii_registry_operations (session_id, pipeline, created_at)"
                    )
                    init_conn.execute(
                        "CREATE INDEX IF NOT EXISTS idx_pii_registry_expires "
                        "ON pii_registry_operations (expires_at)"
                    )
                finally:
                    try:
                        init_conn.close()
                    except Exception:
                        pass
                self._schema_ready = True
            except Exception as exc:
                logger.warning(
                    "PiiRegistryStore: schema init failed — store disabled. %s: %s",
                    type(exc).__name__, exc,
                )

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def save_operation(
        self,
        *,
        session_id: str,
        operation_id: str,
        pipeline: str,
        source_path: str | None = None,
        masked_path: str | None = None,
        registry_path: str | None = None,
        ttl_seconds: int | None = None,
    ) -> None:
        """Persist (or upsert) an operation row.

        Args:
            session_id: Scoped caller session id (from ``_scoped_session_id``).
            operation_id: Short hex id from ``_new_operation_id()``.
            pipeline: ``'file'`` or ``'text'``.
            source_path: Caller-supplied source file path (container-facing).
            masked_path: Path to the masked output file.
            registry_path: Host path of the registry JSON file.
            ttl_seconds: Override the instance default TTL for this row.
        """
        now = time.time()
        ttl = ttl_seconds if ttl_seconds is not None else self._ttl_seconds
        try:
            self._conn().execute(
                "INSERT OR REPLACE INTO pii_registry_operations "
                "(session_id, operation_id, pipeline, source_path, "
                " masked_path, registry_path, created_at, expires_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    session_id, operation_id, pipeline,
                    source_path, masked_path, registry_path,
                    int(now), int(now + ttl),
                ),
            )
            logger.debug(
                "PiiRegistryStore: saved op session=%s op=%s pipeline=%s registry=%s",
                session_id, operation_id, pipeline,
                "yes" if registry_path else "no",
            )
        except Exception as exc:
            logger.warning(
                "PiiRegistryStore.save_operation failed: %s: %s",
                type(exc).__name__, exc,
            )

    def get_operation(
        self, session_id: str, operation_id: str
    ) -> OperationRecord | None:
        """Return a non-expired operation row, or None if not found/expired."""
        now = time.time()
        try:
            row = self._conn().execute(
                "SELECT session_id, operation_id, pipeline, source_path, "
                "masked_path, registry_path, created_at, expires_at "
                "FROM pii_registry_operations "
                "WHERE session_id = ? AND operation_id = ? AND expires_at > ?",
                (session_id, operation_id, now),
            ).fetchone()
            if row is None:
                return None
            return OperationRecord(
                session_id=row[0], operation_id=row[1], pipeline=row[2],
                source_path=row[3], masked_path=row[4], registry_path=row[5],
                created_at=float(row[6]), expires_at=float(row[7]),
            )
        except Exception as exc:
            logger.warning(
                "PiiRegistryStore.get_operation failed: %s: %s",
                type(exc).__name__, exc,
            )
            return None

    def get_latest_operation(
        self, session_id: str, *, pipeline: str = "file"
    ) -> OperationRecord | None:
        """Return the most recent non-expired operation for a session.

        Used as a convenience fallback when the caller does not supply an
        ``operation_id`` — the latest file protect/redact operation for the
        session is assumed to be the one in play.
        """
        now = time.time()
        try:
            row = self._conn().execute(
                "SELECT session_id, operation_id, pipeline, source_path, "
                "masked_path, registry_path, created_at, expires_at "
                "FROM pii_registry_operations "
                "WHERE session_id = ? AND pipeline = ? AND expires_at > ? "
                "ORDER BY created_at DESC LIMIT 1",
                (session_id, pipeline, now),
            ).fetchone()
            if row is None:
                return None
            return OperationRecord(
                session_id=row[0], operation_id=row[1], pipeline=row[2],
                source_path=row[3], masked_path=row[4], registry_path=row[5],
                created_at=float(row[6]), expires_at=float(row[7]),
            )
        except Exception as exc:
            logger.warning(
                "PiiRegistryStore.get_latest_operation failed: %s: %s",
                type(exc).__name__, exc,
            )
            return None

    def sweep_expired(self) -> int:
        """Delete expired rows. Registered as a RedactsStore sweep hook."""
        now = time.time()
        try:
            cur = self._conn().execute(
                "DELETE FROM pii_registry_operations WHERE expires_at <= ?",
                (now,),
            )
            deleted: int = cur.rowcount
            if deleted:
                logger.debug(
                    "PiiRegistryStore: swept %d expired operation row(s)", deleted
                )
            return deleted
        except Exception as exc:
            logger.warning(
                "PiiRegistryStore.sweep_expired failed: %s: %s",
                type(exc).__name__, exc,
            )
            return 0

    def close(self) -> None:
        """Close this thread's SQLite connection."""
        conn = getattr(self._local, "conn", None)
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass
            self._local.conn = None
