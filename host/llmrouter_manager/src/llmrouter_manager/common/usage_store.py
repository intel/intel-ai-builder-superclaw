"""SuperClaw LLMRouter Manager - token usage persistence.

Two SQLite tables in the shared ``llmrouter_manager.db``:

- ``token_events`` - append-only per-request audit trail. Rows are pruned by
  a rolling cap (``LRM_TOKEN_EVENTS_CAP``, default 100_000; set 0 to disable).
- ``token_usage`` - monotonic aggregate. Primary key
  ``(underlying_model, provider, source)``. Never pruned (lifetime totals per
  plan section 5.3 Q16).

Called from ``common.usage.record_usage`` at all 4 dispatch call sites
(cloud + local/edge x stream/non-stream). Thread-safe via ``RLock`` +
explicit ``BEGIN IMMEDIATE`` transactions, matching the pattern used by
``common/store.py::Store``.

Design record: ``docs/design/2026-07-09_llmrouter_manager_token_usage.md``.
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterator, Literal


Source = Literal["cloud", "local", "edge"]
GroupBy = Literal["none", "model", "provider", "source", "alias"]


_DEFAULT_CAP = 100_000
_GC_INTERVAL_DEFAULT = 100
_LIMIT_MAX = 1000

# Bucket label for events whose alias is NULL or empty. A sentinel string
# rather than JSON null for two reasons: SQLite's GROUP BY puts NULL and ''
# in *separate* buckets, which would surface as two rows a reader cannot tell
# apart; and a null key invites a client-side `if (!group.alias) continue`
# that silently drops real spend. Collides only with a literal alias named
# "unaliased", which no caller uses.
_UNALIASED_BUCKET = "unaliased"


_SCHEMA = """
CREATE TABLE IF NOT EXISTS token_events (
    event_id                    TEXT PRIMARY KEY,
    occurred_at                 INTEGER NOT NULL,
    session_id                  TEXT,
    message_id                  TEXT,
    source                      TEXT NOT NULL CHECK (source IN ('cloud','local','edge')),
    provider                    TEXT,
    underlying_model            TEXT NOT NULL,
    alias                       TEXT,
    prompt_tokens               INTEGER NOT NULL DEFAULT 0,
    completion_tokens           INTEGER NOT NULL DEFAULT 0,
    total_tokens                INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens            INTEGER NOT NULL DEFAULT 0,
    cache_read_input_tokens     INTEGER NOT NULL DEFAULT 0,
    cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd                    REAL NOT NULL DEFAULT 0.0,
    trace_id                    TEXT,
    tool_call_ids               TEXT
);

CREATE INDEX IF NOT EXISTS ix_token_events_session_occurred
    ON token_events (session_id, occurred_at);
CREATE INDEX IF NOT EXISTS ix_token_events_message
    ON token_events (message_id);
CREATE INDEX IF NOT EXISTS ix_token_events_occurred
    ON token_events (occurred_at);

CREATE TABLE IF NOT EXISTS token_usage (
    underlying_model                  TEXT NOT NULL,
    provider                          TEXT NOT NULL,
    source                            TEXT NOT NULL CHECK (source IN ('cloud','local','edge')),
    prompt_tokens_total               INTEGER NOT NULL DEFAULT 0,
    completion_tokens_total           INTEGER NOT NULL DEFAULT 0,
    total_tokens_total                INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens_total            INTEGER NOT NULL DEFAULT 0,
    cache_read_input_tokens_total     INTEGER NOT NULL DEFAULT 0,
    cache_creation_input_tokens_total INTEGER NOT NULL DEFAULT 0,
    cost_usd_total                    REAL NOT NULL DEFAULT 0.0,
    request_count                     INTEGER NOT NULL DEFAULT 0,
    first_seen_at                     INTEGER NOT NULL,
    last_updated_at                   INTEGER NOT NULL,
    PRIMARY KEY (underlying_model, provider, source)
);
"""


@dataclass(frozen=True, slots=True)
class TokenEvent:
    """One record of an inbound completion's usage payload.

    Constructed inside ``common.usage.record_usage`` from ``response.usage``
    plus per-request context (session/message headers, alias, trace id).
    Fields align with LiteLLM canonical ``Usage`` naming.
    """
    event_id: str
    occurred_at: int  # unix millis
    session_id: str | None
    message_id: str | None
    source: str  # 'cloud' | 'local' | 'edge'; narrowed by record_usage
    provider: str | None
    underlying_model: str
    alias: str | None
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int
    reasoning_tokens: int
    cache_read_input_tokens: int
    cache_creation_input_tokens: int
    cost_usd: float
    trace_id: str | None
    # Ids of the tool calls this completion emitted, so a client can tie each
    # tool step back to the exact model call that produced it.
    tool_call_ids: tuple[str, ...] = ()


def _encode_tool_call_ids(ids: tuple[str, ...]) -> str | None:
    return json.dumps(list(ids)) if ids else None


def _decode_tool_call_ids(raw: object) -> list[str]:
    if not isinstance(raw, str) or not raw:
        return []
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        return []
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, str)]


def _read_cap_from_env() -> int:
    raw = os.environ.get("LRM_TOKEN_EVENTS_CAP")
    if raw is None or raw == "":
        return _DEFAULT_CAP
    try:
        value = int(raw)
    except ValueError:
        return _DEFAULT_CAP
    return max(0, value)


class UsageStore:
    """Thread-safe SQLite-backed token usage store.

    Follows the ``common/store.py::Store`` pattern: single connection with
    ``check_same_thread=False``, ``RLock`` around every operation, explicit
    ``BEGIN IMMEDIATE`` / COMMIT via ``_tx``. Same DB file as ``Store``
    (``llmrouter_manager.db``); WAL mode handles concurrent readers.
    """

    def __init__(
        self,
        db_path: Path,
        *,
        cap: int | None = None,
        gc_interval: int = _GC_INTERVAL_DEFAULT,
    ) -> None:
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self._cap = _read_cap_from_env() if cap is None else max(0, int(cap))
        self._gc_interval = max(1, int(gc_interval))
        self._insert_counter = 0
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
        self._migrate()

    def _migrate(self) -> None:
        """Add columns introduced after a DB file was first created."""
        with self._lock:
            columns = {
                row["name"]
                for row in self._conn.execute("PRAGMA table_info(token_events)")
            }
            if "tool_call_ids" not in columns:
                self._conn.execute(
                    "ALTER TABLE token_events ADD COLUMN tool_call_ids TEXT"
                )

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

    def insert_event(self, event: TokenEvent) -> None:
        """Insert one event and upsert the aggregate row. Atomic.

        Rolling GC runs outside the tx after commit (best-effort; pruning old
        rows has no consistency requirement on the newly inserted row).
        """
        params = asdict(event)
        params["tool_call_ids"] = _encode_tool_call_ids(event.tool_call_ids)
        # Aggregate PK requires non-NULL provider; fall back to source when
        # event.provider is None (defensive; record_usage always supplies a
        # value in production, but tests may construct TokenEvent directly).
        params_agg = {**params, "provider_upsert": event.provider or event.source}
        with self._tx() as cx:
            cx.execute(
                """
                INSERT INTO token_events (
                    event_id, occurred_at, session_id, message_id, source, provider,
                    underlying_model, alias,
                    prompt_tokens, completion_tokens, total_tokens, reasoning_tokens,
                    cache_read_input_tokens, cache_creation_input_tokens,
                    cost_usd, trace_id, tool_call_ids
                ) VALUES (
                    :event_id, :occurred_at, :session_id, :message_id, :source, :provider,
                    :underlying_model, :alias,
                    :prompt_tokens, :completion_tokens, :total_tokens, :reasoning_tokens,
                    :cache_read_input_tokens, :cache_creation_input_tokens,
                    :cost_usd, :trace_id, :tool_call_ids
                )
                """,
                params,
            )
            cx.execute(
                """
                INSERT INTO token_usage (
                    underlying_model, provider, source,
                    prompt_tokens_total, completion_tokens_total, total_tokens_total,
                    reasoning_tokens_total,
                    cache_read_input_tokens_total, cache_creation_input_tokens_total,
                    cost_usd_total, request_count,
                    first_seen_at, last_updated_at
                ) VALUES (
                    :underlying_model, :provider_upsert, :source,
                    :prompt_tokens, :completion_tokens, :total_tokens, :reasoning_tokens,
                    :cache_read_input_tokens, :cache_creation_input_tokens,
                    :cost_usd, 1,
                    :occurred_at, :occurred_at
                )
                ON CONFLICT(underlying_model, provider, source) DO UPDATE SET
                    prompt_tokens_total               = prompt_tokens_total + excluded.prompt_tokens_total,
                    completion_tokens_total           = completion_tokens_total + excluded.completion_tokens_total,
                    total_tokens_total                = total_tokens_total + excluded.total_tokens_total,
                    reasoning_tokens_total            = reasoning_tokens_total + excluded.reasoning_tokens_total,
                    cache_read_input_tokens_total     = cache_read_input_tokens_total + excluded.cache_read_input_tokens_total,
                    cache_creation_input_tokens_total = cache_creation_input_tokens_total + excluded.cache_creation_input_tokens_total,
                    cost_usd_total                    = cost_usd_total + excluded.cost_usd_total,
                    request_count                     = request_count + 1,
                    last_updated_at                   = excluded.last_updated_at
                """,
                params_agg,
            )
            self._insert_counter += 1
        # GC outside the tx (best-effort; no consistency dependency on the insert).
        self._maybe_gc()

    def _maybe_gc(self) -> None:
        if self._cap <= 0:
            return
        if self._insert_counter % self._gc_interval != 0:
            return
        with self._lock:
            (count,) = self._conn.execute(
                "SELECT COUNT(*) FROM token_events"
            ).fetchone()
            if count <= self._cap:
                return
            target = int(self._cap * 0.9)
            delete_n = count - target
            self._conn.execute(
                "DELETE FROM token_events WHERE event_id IN "
                "(SELECT event_id FROM token_events ORDER BY occurred_at ASC LIMIT ?)",
                (delete_n,),
            )

    # ── Queries ──

    def query_aggregate(self, *, group_by: GroupBy = "none") -> dict:
        """Cross-session token usage aggregate.

        ``group_by=none`` returns just ``{total: ...}``. Grouped variants
        add ``groups: [...]``. Each row carries the same canonical LiteLLM
        field names - see design section 6.1 for the exact response shape.

        ``group_by=alias`` is the one dimension not held by ``token_usage``,
        so its rows are summed from the ``token_events`` audit trail instead.
        That trail is pruned by the rolling cap, so alias rows can sum to
        *less* than ``total`` once a DB passes ``LRM_TOKEN_EVENTS_CAP``
        events. ``total`` stays the lifetime aggregate for every ``group_by``
        value so the same field never means two different things; a caller
        that renders alias shares must treat the shortfall as unattributed
        rather than assume the rows add up.
        """
        if group_by not in ("none", "model", "provider", "source", "alias"):
            raise ValueError(f"invalid group_by: {group_by!r}")
        with self._lock:
            total = self._query_total()
            if group_by == "none":
                return {"total": total}
            groups = self._query_groups(group_by)
            return {"total": total, "groups": groups}

    def _query_total(self) -> dict:
        row = self._conn.execute(
            """
            SELECT
                COALESCE(SUM(prompt_tokens_total), 0) AS prompt_tokens,
                COALESCE(SUM(completion_tokens_total), 0) AS completion_tokens,
                COALESCE(SUM(total_tokens_total), 0) AS total_tokens,
                COALESCE(SUM(reasoning_tokens_total), 0) AS reasoning_tokens,
                COALESCE(SUM(cache_read_input_tokens_total), 0) AS cache_read_input_tokens,
                COALESCE(SUM(cache_creation_input_tokens_total), 0) AS cache_creation_input_tokens,
                COALESCE(SUM(cost_usd_total), 0.0) AS cost_usd,
                COALESCE(SUM(request_count), 0) AS request_count,
                MIN(first_seen_at) AS first_seen_at,
                MAX(last_updated_at) AS last_updated_at
            FROM token_usage
            """
        ).fetchone()
        return dict(row) if row else {}

    def _query_groups(self, group_by: GroupBy) -> list[dict]:
        params: tuple[object, ...] = ()
        if group_by == "model":
            sql = """
                SELECT
                    underlying_model, provider, source,
                    prompt_tokens_total               AS prompt_tokens,
                    completion_tokens_total           AS completion_tokens,
                    total_tokens_total                AS total_tokens,
                    reasoning_tokens_total            AS reasoning_tokens,
                    cache_read_input_tokens_total     AS cache_read_input_tokens,
                    cache_creation_input_tokens_total AS cache_creation_input_tokens,
                    cost_usd_total                    AS cost_usd,
                    request_count,
                    first_seen_at, last_updated_at
                FROM token_usage
                ORDER BY total_tokens_total DESC
                """
        elif group_by == "alias":
            # The only branch reading token_events: token_usage's PK is
            # (model, provider, source) and carries no alias, so the alias
            # dimension exists nowhere else. Column names are re-exported
            # under the same aliases as the token_usage branches so a client
            # can consume any group_by with one row parser.
            sql = """
                SELECT
                    COALESCE(NULLIF(alias, ''), ?) AS alias,
                    SUM(prompt_tokens)               AS prompt_tokens,
                    SUM(completion_tokens)           AS completion_tokens,
                    SUM(total_tokens)                AS total_tokens,
                    SUM(reasoning_tokens)            AS reasoning_tokens,
                    SUM(cache_read_input_tokens)     AS cache_read_input_tokens,
                    SUM(cache_creation_input_tokens) AS cache_creation_input_tokens,
                    SUM(cost_usd)                    AS cost_usd,
                    COUNT(*)                         AS request_count,
                    MIN(occurred_at)                 AS first_seen_at,
                    MAX(occurred_at)                 AS last_updated_at
                FROM token_events
                GROUP BY COALESCE(NULLIF(alias, ''), ?)
                ORDER BY SUM(total_tokens) DESC
                """
            # Bound twice: SQLite numbers positional params per occurrence,
            # so the SELECT and GROUP BY copies each need their own value.
            params = (_UNALIASED_BUCKET, _UNALIASED_BUCKET)
        elif group_by == "provider":
            sql = """
                SELECT
                    provider,
                    SUM(prompt_tokens_total)               AS prompt_tokens,
                    SUM(completion_tokens_total)           AS completion_tokens,
                    SUM(total_tokens_total)                AS total_tokens,
                    SUM(reasoning_tokens_total)            AS reasoning_tokens,
                    SUM(cache_read_input_tokens_total)     AS cache_read_input_tokens,
                    SUM(cache_creation_input_tokens_total) AS cache_creation_input_tokens,
                    SUM(cost_usd_total)                    AS cost_usd,
                    SUM(request_count)                     AS request_count,
                    MIN(first_seen_at)                     AS first_seen_at,
                    MAX(last_updated_at)                   AS last_updated_at
                FROM token_usage
                GROUP BY provider
                ORDER BY SUM(total_tokens_total) DESC
                """
        else:  # source
            sql = """
                SELECT
                    source,
                    SUM(prompt_tokens_total)               AS prompt_tokens,
                    SUM(completion_tokens_total)           AS completion_tokens,
                    SUM(total_tokens_total)                AS total_tokens,
                    SUM(reasoning_tokens_total)            AS reasoning_tokens,
                    SUM(cache_read_input_tokens_total)     AS cache_read_input_tokens,
                    SUM(cache_creation_input_tokens_total) AS cache_creation_input_tokens,
                    SUM(cost_usd_total)                    AS cost_usd,
                    SUM(request_count)                     AS request_count,
                    MIN(first_seen_at)                     AS first_seen_at,
                    MAX(last_updated_at)                   AS last_updated_at
                FROM token_usage
                GROUP BY source
                ORDER BY SUM(total_tokens_total) DESC
                """
        return [dict(r) for r in self._conn.execute(sql, params).fetchall()]

    def query_events(
        self,
        *,
        session_id: str | None = None,
        message_id: str | None = None,
        since_ms: int | None = None,
        limit: int = 100,
    ) -> tuple[list[dict], int | None]:
        """Ordered ASCENDING by ``occurred_at`` for stable cursor pagination.

        Returns ``(events, next_since_ms)``. ``next_since_ms`` is the last
        event's ``occurred_at`` when ``len(events) == limit`` (more may
        exist), otherwise ``None``.
        """
        if not (1 <= limit <= _LIMIT_MAX):
            raise ValueError(f"invalid limit: {limit} (must be 1..{_LIMIT_MAX})")

        clauses: list[str] = []
        params: list = []
        if session_id is not None:
            clauses.append("session_id = ?")
            params.append(session_id)
        if message_id is not None:
            clauses.append("message_id = ?")
            params.append(message_id)
        if since_ms is not None:
            clauses.append("occurred_at > ?")
            params.append(since_ms)
        where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
        sql = f"""
            SELECT
                event_id, occurred_at, session_id, message_id, source, provider,
                underlying_model, alias,
                prompt_tokens, completion_tokens, total_tokens, reasoning_tokens,
                cache_read_input_tokens, cache_creation_input_tokens,
                cost_usd, trace_id, tool_call_ids
            FROM token_events
            {where}
            ORDER BY occurred_at ASC
            LIMIT ?
            """
        params.append(limit)
        with self._lock:
            rows = self._conn.execute(sql, params).fetchall()
        events = [
            {**dict(r), "tool_call_ids": _decode_tool_call_ids(r["tool_call_ids"])}
            for r in rows
        ]
        next_cursor = (
            int(events[-1]["occurred_at"])
            if len(events) == limit and events
            else None
        )
        return events, next_cursor

    def truncate(self) -> None:
        """Truncate BOTH tables. Idempotent."""
        with self._tx() as cx:
            cx.execute("DELETE FROM token_events")
            cx.execute("DELETE FROM token_usage")
