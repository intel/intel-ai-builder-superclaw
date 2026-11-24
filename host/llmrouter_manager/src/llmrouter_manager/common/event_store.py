"""SuperClaw LLMRouter Manager — typed diagnostic event persistence.

One SQLite table, ``events``, in the shared ``llmrouter_manager.db`` — the same
file (and the same creation pattern) as ``token_events`` in
``common/usage_store.py``. ``token_events`` answers *"what did this turn
cost?"*; ``events`` answers *"what went wrong?"*. A turn that hung for twelve
minutes and died writes nothing to ``token_events``: the failure exists only as
an absence between two rows, and absence is not queryable.

Key shape and correlation ids are deliberately identical to ``token_events``
(``event_id``, ``occurred_at``, ``session_id``, ``message_id``, ``trace_id``) so
the two tables join, and so the bench harness can join either against its own
per-task results on ``session_id``.

Schema is verbatim from the design doc §4.1, with ``IF NOT EXISTS`` added so
creation is idempotent across restarts — exactly how ``usage_store._SCHEMA``
creates ``token_events``. There is no other migration mechanism in this service.

Rows are pruned by a rolling cap (``LRM_EVENTS_CAP``, default 100_000; set 0 to
disable), mirroring ``LRM_TOKEN_EVENTS_CAP``.

Design record: ``docs/design/2026-09-11_benchmark_error_observability.md`` §4.
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator, Sequence


_DEFAULT_CAP = 100_000
_GC_INTERVAL_DEFAULT = 100
_LIMIT_MAX = 1000

# The context-ledger attrs contract, duplicated as strings because
# ``common/events.py`` imports this module (importing ``routing/context_ledger``
# here would close a cycle). ``tests/test_event_store.py`` asserts this tuple
# equals ``routing.context_ledger.LEDGER_KEYS`` so the two cannot drift.
_LEDGER_KEYS: tuple[str, ...] = (
    "chat_req_id",
    "alias",
    "alias_resolved",
    "locality",
    "bundle_id",
    "mocked",
    "parent_session_id",
    "llama_c",
    "lrm_probed_n_ctx",
    "lrm_cap",
    "lrm_cap_source",
    "lrm_compact_budget_max",
    "lrm_compact_budget_left",
    "lrm_req_estimate",
    "lrm_req_estimate_source",
    "lrm_decision",
    "lrm_decision_reason",
    "oc_usable",
    "oc_reserve",
    "oc_baseline_prompt",
    "oc_baseline_tools",
    "oc_next_estimate",
)

# Event types the ledger reader folds into one row per request. Strings for
# the same cycle reason; ``tests/test_event_store.py`` pins them to EventType.
_LEDGER_EVENT_TYPES: tuple[str, ...] = (
    "chat.request",
    "chat.ctx_proceed",
    "chat.completion",
    "context.compaction_triggered",
    "context.compaction_exhausted",
    "context.overflow",
)


# Verbatim from design §4.1 (``IF NOT EXISTS`` added for idempotent creation,
# matching how ``usage_store`` creates ``token_events``).
_SCHEMA = """
CREATE TABLE IF NOT EXISTS events (
  event_id    TEXT PRIMARY KEY,        -- uuid, matches token_events convention
  occurred_at INTEGER NOT NULL,        -- epoch ms
  event_type  TEXT    NOT NULL,        -- dotted, closed vocabulary (see events.py)
  severity    TEXT    NOT NULL
              CHECK (severity IN ('debug','info','warn','error','fatal')),
  session_id  TEXT,                    -- THE join key to the bench harness
  message_id  TEXT,
  trace_id    TEXT,                    -- already OTLP-correlated
  agent       TEXT,
  model       TEXT,
  attrs_json  TEXT                     -- typed payload, per event_type
);

CREATE INDEX IF NOT EXISTS events_by_time    ON events(occurred_at);
CREATE INDEX IF NOT EXISTS events_by_type    ON events(event_type, occurred_at);
CREATE INDEX IF NOT EXISTS events_by_session ON events(session_id);
"""


@dataclass(frozen=True, slots=True)
class EventRecord:
    """One typed diagnostic event row.

    ``attrs`` is an arbitrary JSON-serialisable mapping serialised into
    ``attrs_json``; ``event_type`` is validated against the closed vocabulary in
    ``common/events.py`` *before* it reaches this layer.
    """

    event_id: str
    occurred_at: int  # unix millis
    event_type: str
    severity: str  # 'debug' | 'info' | 'warn' | 'error' | 'fatal'
    session_id: str | None = None
    message_id: str | None = None
    trace_id: str | None = None
    agent: str | None = None
    model: str | None = None
    attrs: dict[str, Any] | None = None


def _read_cap_from_env() -> int:
    raw = os.environ.get("LRM_EVENTS_CAP")
    if raw is None or raw == "":
        return _DEFAULT_CAP
    try:
        value = int(raw)
    except ValueError:
        return _DEFAULT_CAP
    return max(0, value)


def _dump_attrs(attrs: dict[str, Any] | None) -> str | None:
    """Serialise ``attrs`` defensively — a non-serialisable value must never
    cost us the row (the row is the whole point)."""
    if attrs is None:
        return None
    try:
        return json.dumps(attrs, default=str, sort_keys=True)
    except Exception:  # noqa: BLE001
        return json.dumps({"_attrs_unserialisable": True})


class EventStore:
    """Thread-safe SQLite-backed diagnostic event store.

    Same pattern as ``common/store.py::Store`` and
    ``common/usage_store.py::UsageStore``: one connection with
    ``check_same_thread=False``, an ``RLock`` around every operation, explicit
    ``BEGIN IMMEDIATE`` / COMMIT via ``_tx``. Same DB file
    (``llmrouter_manager.db``); WAL mode handles the concurrent readers.
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

    def insert(self, record: EventRecord) -> None:
        """Insert one event row. Rolling GC runs outside the tx after commit."""
        with self._tx() as cx:
            cx.execute(
                """
                INSERT INTO events (
                    event_id, occurred_at, event_type, severity,
                    session_id, message_id, trace_id, agent, model, attrs_json
                ) VALUES (
                    :event_id, :occurred_at, :event_type, :severity,
                    :session_id, :message_id, :trace_id, :agent, :model, :attrs_json
                )
                """,
                {
                    "event_id": record.event_id,
                    "occurred_at": int(record.occurred_at),
                    "event_type": record.event_type,
                    "severity": record.severity,
                    "session_id": record.session_id,
                    "message_id": record.message_id,
                    "trace_id": record.trace_id,
                    "agent": record.agent,
                    "model": record.model,
                    "attrs_json": _dump_attrs(record.attrs),
                },
            )
            self._insert_counter += 1
        self._maybe_gc()

    def _maybe_gc(self) -> None:
        if self._cap <= 0:
            return
        if self._insert_counter % self._gc_interval != 0:
            return
        with self._lock:
            (count,) = self._conn.execute("SELECT COUNT(*) FROM events").fetchone()
            if count <= self._cap:
                return
            # Keep 90% of the cap, but never less than one row: for any cap
            # under 10 the 90% target is 0 and GC would delete EVERY row, the
            # newest included.
            target = max(1, int(self._cap * 0.9))
            delete_n = count - target
            self._conn.execute(
                "DELETE FROM events WHERE event_id IN "
                "(SELECT event_id FROM events ORDER BY occurred_at ASC LIMIT ?)",
                (delete_n,),
            )

    # ── Queries ──

    def query(
        self,
        *,
        session_id: str | None = None,
        event_type: str | None = None,
        severities: tuple[str, ...] | None = None,
        since_ms: int | None = None,
        until_ms: int | None = None,
        limit: int = 100,
    ) -> list[dict]:
        """Ordered ASCENDING by ``occurred_at`` (stable cursor pagination),
        matching ``UsageStore.query_events``."""
        if not (1 <= limit <= _LIMIT_MAX):
            raise ValueError(f"invalid limit: {limit} (must be 1..{_LIMIT_MAX})")
        clauses: list[str] = []
        params: list[Any] = []
        if session_id is not None:
            clauses.append("session_id = ?")
            params.append(session_id)
        if event_type is not None:
            clauses.append("event_type = ?")
            params.append(event_type)
        if severities:
            clauses.append(
                "severity IN (" + ",".join("?" for _ in severities) + ")"
            )
            params.extend(severities)
        if since_ms is not None:
            clauses.append("occurred_at >= ?")
            params.append(since_ms)
        if until_ms is not None:
            clauses.append("occurred_at <= ?")
            params.append(until_ms)
        where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
        params.append(limit)
        with self._lock:
            rows = self._conn.execute(
                f"""
                SELECT event_id, occurred_at, event_type, severity,
                       session_id, message_id, trace_id, agent, model, attrs_json
                FROM events
                {where}
                ORDER BY occurred_at ASC
                LIMIT ?
                """,
                params,
            ).fetchall()
        out: list[dict] = []
        for row in rows:
            item = dict(row)
            raw = item.pop("attrs_json", None)
            try:
                item["attrs"] = json.loads(raw) if raw else {}
            except Exception:  # noqa: BLE001
                item["attrs"] = {}
            out.append(item)
        return out

    def count_by_type(
        self, *, severities: tuple[str, ...] = ("error", "fatal")
    ) -> list[dict]:
        """``GROUP BY event_type`` — the query the taxonomy exists to make
        exhaustive (design §5)."""
        placeholders = ",".join("?" for _ in severities)
        with self._lock:
            rows = self._conn.execute(
                f"""
                SELECT event_type,
                       COUNT(*) AS n,
                       COUNT(DISTINCT session_id) AS sessions
                FROM events
                WHERE severity IN ({placeholders})
                GROUP BY event_type
                ORDER BY n DESC
                """,
                list(severities),
            ).fetchall()
        return [dict(r) for r in rows]

    def context_ledger(
        self,
        session_ids: str | Sequence[str] | None = None,
        *,
        limit: int = 1000,
        session_id: str | None = None,
    ) -> list[dict]:
        """The one-query test the context ledger exists for: per model request
        of the given session(s), what each layer believed the window was and
        whether a compaction was triggered.

        ``session_ids`` is one id or a sequence — typically
        ``[root_id, *child_ids]`` so a task's sub-agent requests interleave
        with the root's, in time order, in one result (``session_id`` is
        accepted as a keyword alias for the single-id form). Every result dict
        carries its ``session_id``.

        One dict per request, ordered by first ``occurred_at`` across all the
        sessions given. ``limit``
        counts REQUESTS: the first ``limit`` distinct ``trace_id``s (by their
        earliest row) are selected in a subquery and every ledger row of those
        requests is fetched, so a page never truncates a request. Requests are
        the ``trace_id`` groups (the proxy stamps its per-request
        ``chat_req_id`` as ``trace_id`` on every row it writes). Ledger attrs
        are taken from the ``chat.request`` row when present (info — needs
        ``SUPERCLAW_DEBUG_OBSERVABILITY=1``), else from any always-on row that
        carries them (``context.compaction_triggered``,
        ``context.compaction_exhausted``, ``context.overflow``), so a request
        that compacted is fully described even with the info gate shut.

        Equivalent SQL, for readers without this helper::

            SELECT trace_id, MIN(occurred_at) AS occurred_at,
                   MAX(json_extract(attrs_json,'$.alias'))            AS alias,
                   MAX(json_extract(attrs_json,'$.locality'))         AS locality,
                   MAX(json_extract(attrs_json,'$.lrm_cap'))          AS lrm_cap,
                   MAX(json_extract(attrs_json,'$.oc_usable'))        AS oc_usable,
                   MAX(json_extract(attrs_json,'$.oc_next_estimate')) AS oc_next_estimate,
                   SUM(event_type='context.compaction_triggered')     AS compaction_triggered
            FROM events WHERE session_id IN (?, ?, ...) AND trace_id IS NOT NULL
            GROUP BY trace_id ORDER BY occurred_at;
        """
        if not (1 <= limit <= 100_000):
            raise ValueError(f"invalid limit: {limit} (must be 1..100000)")
        if session_ids is None:
            session_ids = session_id
        elif session_id is not None:
            raise TypeError("pass either session_ids or session_id, not both")
        if session_ids is None:
            raise TypeError("context_ledger() needs a session id or a sequence of them")
        if isinstance(session_ids, str):
            ids: tuple[str, ...] = (session_ids,)
        else:
            seen: dict[str, None] = {}
            for sid in session_ids:
                if isinstance(sid, str) and sid:
                    seen.setdefault(sid, None)
            ids = tuple(seen)
        if not ids:
            return []
        type_ph = ",".join("?" for _ in _LEDGER_EVENT_TYPES)
        sid_ph = ",".join("?" for _ in ids)
        with self._lock:
            rows = self._conn.execute(
                f"""
                SELECT occurred_at, event_type, severity, session_id, message_id,
                       trace_id, agent, model, attrs_json
                FROM events
                WHERE session_id IN ({sid_ph})
                  AND event_type IN ({type_ph})
                  AND trace_id IN (
                      SELECT trace_id FROM events
                      WHERE session_id IN ({sid_ph}) AND trace_id IS NOT NULL
                        AND event_type IN ({type_ph})
                      GROUP BY trace_id
                      ORDER BY MIN(occurred_at) ASC, MIN(rowid) ASC
                      LIMIT ?
                  )
                ORDER BY occurred_at ASC, rowid ASC
                """,
                (*ids, *_LEDGER_EVENT_TYPES,
                 *ids, *_LEDGER_EVENT_TYPES, limit),
            ).fetchall()

        groups: dict[str, dict] = {}
        for row in rows:
            item = dict(row)
            raw = item.get("attrs_json")
            try:
                attrs = json.loads(raw) if raw else {}
            except Exception:  # noqa: BLE001
                attrs = {}
            key = item["trace_id"]
            entry = groups.get(key)
            if entry is None:
                entry = {
                    "trace_id": key,
                    "session_id": item.get("session_id"),
                    "occurred_at": item["occurred_at"],
                    "message_id": item.get("message_id"),
                    "agent": item.get("agent"),
                    "model": item.get("model"),
                    "ledger": None,
                    "ledger_from": None,
                    "compaction_triggered": False,
                    "compaction_authority": None,
                    "compaction_authorities": [],
                    "compaction_exhausted": False,
                    "overflow": False,
                    "overflow_source": None,
                    "status": None,
                    "error_class": None,
                }
                groups[key] = entry
            if entry["message_id"] is None and item.get("message_id"):
                entry["message_id"] = item["message_id"]
            if entry["model"] is None and item.get("model"):
                entry["model"] = item["model"]
            et = item["event_type"]
            has_ledger = "lrm_cap_source" in attrs
            # chat.request is the canonical carrier; anything else only fills
            # the gap when the info gate kept chat.request out of the store.
            if has_ledger and (entry["ledger"] is None or et == "chat.request"):
                entry["ledger"] = {k: attrs.get(k) for k in _LEDGER_KEYS}
                entry["ledger_from"] = et
            if et == "context.compaction_triggered":
                entry["compaction_triggered"] = True
                # First authority wins the scalar; the list keeps the rare
                # case of a summary request that itself got LRM's 400.
                if entry["compaction_authority"] is None:
                    entry["compaction_authority"] = attrs.get("authority")
                entry["compaction_authorities"].append(attrs.get("authority"))
            elif et == "context.compaction_exhausted":
                entry["compaction_exhausted"] = True
            elif et == "context.overflow":
                entry["overflow"] = True
                entry["overflow_source"] = attrs.get("source")
            elif et == "chat.completion":
                entry["status"] = attrs.get("status")
                entry["error_class"] = attrs.get("error_class")

        out: list[dict] = []
        for entry in groups.values():
            ledger = entry.pop("ledger") or {}
            flat = {
                "trace_id": entry["trace_id"],
                "session_id": entry["session_id"],
                "occurred_at": entry["occurred_at"],
                "message_id": entry["message_id"],
                "agent": entry["agent"],
                "model": entry["model"],
            }
            for k in _LEDGER_KEYS:
                flat[k] = ledger.get(k)
            flat.update(
                {
                    "ledger_from": entry["ledger_from"],
                    "compaction_triggered": entry["compaction_triggered"],
                    "compaction_authority": entry["compaction_authority"],
                    "compaction_authorities": entry["compaction_authorities"],
                    "compaction_exhausted": entry["compaction_exhausted"],
                    "overflow": entry["overflow"],
                    "overflow_source": entry["overflow_source"],
                    "status": entry["status"],
                    "error_class": entry["error_class"],
                }
            )
            out.append(flat)
        out.sort(key=lambda e: e["occurred_at"])
        return out

    def truncate(self) -> None:
        """Drop every row. Idempotent."""
        with self._tx() as cx:
            cx.execute("DELETE FROM events")
