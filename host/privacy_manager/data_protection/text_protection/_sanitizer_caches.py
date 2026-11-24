"""Bounded caches used by ``ConsistentSanitizer``.

Exposes a ``CacheBackend`` Protocol so the in-process ``LRUCache`` can be
swapped for a distributed backend (Redis, memcached, custom) without
changing call sites in the pipelines.

All bundled implementations are thread-safe — concurrent ``sanitize()``
calls on a single sanitizer must not corrupt cache state.

Two-tier persistence (``TieredCache`` = L1 ``LRUCache`` + L2 ``SqliteCache``)
lets the sanitizer keep hot-path speed while surviving restarts: an L1 miss
reads through to the on-disk L2 and promotes the row back into L1, and a
``put`` writes L1 immediately and queues the L2 write behind a background
thread so callers never block on disk. A misbehaving L2 (locked DB, disk
full, corrupt row) is swallowed — the cache degrades to L1-only rather than
breaking sanitization.
"""

from __future__ import annotations

import logging
import queue
import threading
from collections import OrderedDict
from typing import Callable, Generic, Iterator, Optional, Protocol, Tuple, TypeVar

logger = logging.getLogger(__name__)

K = TypeVar("K")
V = TypeVar("V")


class CacheBackend(Protocol[K, V]):
    """Read/write key-value cache with size eviction.

    Implementations must be thread-safe. Returning ``None`` from ``get``
    means "miss" — implementations that need to disambiguate "miss" vs.
    "stored value is None" should box the value or use a sentinel.
    """

    def get(self, key: K) -> Optional[V]: ...
    def put(self, key: K, value: V) -> None: ...
    def clear(self) -> None: ...


class LRUCache(Generic[K, V]):
    """A thread-safe bounded LRU cache.

    Default :class:`CacheBackend` implementation. Uses
    ``OrderedDict.move_to_end`` for O(1) recency tracking. When the
    cache is at capacity, the least-recently-used entry is evicted on
    insert — never a whole-cache flush.
    """

    def __init__(self, capacity: int) -> None:
        if capacity < 1:
            raise ValueError(f"LRU capacity must be >= 1, got {capacity}")
        self._capacity = capacity
        self._data: "OrderedDict[K, V]" = OrderedDict()
        self._lock = threading.Lock()

    def get(self, key: K) -> Optional[V]:
        with self._lock:
            value = self._data.get(key)
            if value is None and key not in self._data:
                return None
            self._data.move_to_end(key)
            return value

    def put(self, key: K, value: V) -> None:
        with self._lock:
            if key in self._data:
                self._data.move_to_end(key)
                self._data[key] = value
                return
            self._data[key] = value
            if len(self._data) > self._capacity:
                self._data.popitem(last=False)

    def __contains__(self, key: object) -> bool:
        with self._lock:
            return key in self._data

    def __len__(self) -> int:
        with self._lock:
            return len(self._data)

    def clear(self) -> None:
        with self._lock:
            self._data.clear()

    def keys(self) -> Iterator[K]:
        # Snapshot so callers can iterate without holding the lock.
        with self._lock:
            return iter(list(self._data.keys()))


class NullCache(Generic[K, V]):
    """No-op cache for diagnostics ("does case X pass with empty caches?").

    All ``get`` calls miss; ``put`` is a no-op. Conforms to
    :class:`CacheBackend` so it can be swapped in without touching the
    pipelines. Useful for benchmarking the cost of cache lookups
    themselves and for repro runs that must not benefit from prior state.
    """

    def get(self, key: K) -> Optional[V]:
        return None

    def put(self, key: K, value: V) -> None:
        return

    def clear(self) -> None:
        return


# --------------------------------------------------------------------------
# Persistent L2 (SQLite) + two-tier (L1 memory + L2 disk)
# --------------------------------------------------------------------------

# A codec turns an arbitrary cache key/value into a form SQLite can store
# (TEXT key, BLOB value) and back. The pipelines cache non-trivial types —
# NER keys are ``(len, text)`` tuples and values are tuples of span tuples;
# embedding values are numpy arrays — so the caller supplies the codec that
# knows how to (de)serialize its own payloads.
KeyEncoder = Callable[[object], str]
ValueEncoder = Callable[[object], bytes]
ValueDecoder = Callable[[bytes], object]


class SqliteCache(Generic[K, V]):
    """Persistent, size-bounded L2 cache backed by a single SQLite file.

    Conforms to :class:`CacheBackend`. Intended as the L2 tier under
    :class:`TieredCache`, but usable standalone. Properties:

    * **Survives restarts.** Rows live in ``db_path`` and are keyed within a
      ``namespace`` (e.g. a model-version hash) so a model change simply
      misses instead of returning stale outputs.
    * **Thread-safe.** SQLite connections are not shareable across threads,
      so each thread gets its own connection (``threading.local``). WAL mode
      allows concurrent readers alongside the single writer.
    * **Approximate LRU.** A monotonic ``used_at`` counter is bumped on
      access; when the namespace exceeds ``max_entries`` an insert deletes
      the lowest-``used_at`` rows in a batch. This avoids a write on every
      read path except the touch, and never does a full-table scan-and-sort
      beyond the eviction batch.
    * **Row TTL.** With ``ttl_seconds`` set, each row records an absolute
      ``expires_at`` (wall-clock, seconds since epoch). ``get`` treats an
      expired row as a miss, and :meth:`sweep_expired` bulk-deletes them.
      This bounds how long any cached PII persists on disk — a data-at-rest
      hygiene guarantee that mirrors the redacts store's file TTL. ``0`` (the
      default) disables the TTL (rows live until LRU-evicted or the namespace
      is invalidated by a model change).
    * **Error-tolerant.** Every operation is wrapped: a locked / corrupt /
      full database logs once and returns a miss (or drops a write) rather
      than raising into the sanitize path.

    ``get`` returning ``None`` means miss; store a boxed value if you must
    cache a genuine ``None``.
    """

    # Evict in batches so we amortize the delete over many inserts rather
    # than trimming exactly one row per insert (each delete is a write txn).
    _EVICT_BATCH = 64

    def __init__(
        self,
        db_path: str,
        *,
        namespace: str,
        max_entries: int,
        value_encoder: ValueEncoder,
        value_decoder: ValueDecoder,
        key_encoder: Optional[KeyEncoder] = None,
        ttl_seconds: int = 0,
    ) -> None:
        if max_entries < 1:
            raise ValueError(f"SqliteCache max_entries must be >= 1, got {max_entries}")
        if ttl_seconds < 0:
            raise ValueError(f"SqliteCache ttl_seconds must be >= 0, got {ttl_seconds}")
        self._db_path = db_path
        self._namespace = namespace
        self._max_entries = max_entries
        self._ttl_seconds = ttl_seconds
        self._encode_value = value_encoder
        self._decode_value = value_decoder
        self._encode_key = key_encoder or (lambda k: repr(k))
        self._local = threading.local()
        # Monotonic access clock shared across threads (cheap; guarded by a
        # short lock). Persisted implicitly through the max stored used_at so
        # ordering survives restarts well enough for approximate LRU.
        self._clock_lock = threading.Lock()
        self._clock = 0
        self._available = True
        self._init_error_logged = False
        # Serialize schema initialization + parent-directory creation across
        # threads. A racing get() from another thread would otherwise open a
        # NEW connection that sees a partial schema and fail with a
        # missing-column / missing-index error, disabling the whole cache.
        # Guarded by ``_schema_ready`` so subsequent connections skip the DDL
        # entirely.
        self._schema_lock = threading.Lock()
        self._schema_ready = False
        # Prime the schema on the constructor thread so early callers on
        # this same thread go straight to a working DB. Other threads will
        # re-enter ``_ensure_schema_locked`` once and then be a no-op.
        self._ensure_schema()

    # -- connection / schema -------------------------------------------

    def _conn(self):
        conn = getattr(self._local, "conn", None)
        if conn is None:
            import sqlite3

            # Ensure the schema exists BEFORE a fresh per-thread connection
            # starts issuing queries. Without this a thread that races the
            # constructor gets its own connection first, sees an incomplete
            # schema, and disables the cache for the whole process.
            self._ensure_schema()
            conn = sqlite3.connect(
                self._db_path, timeout=5.0, isolation_level=None, check_same_thread=False
            )
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA synchronous=NORMAL")
            conn.execute("PRAGMA busy_timeout=5000")
            self._local.conn = conn
        return conn

    def _ensure_schema(self) -> None:
        """Idempotent DDL bootstrap, safe under concurrent construction.

        Fast path: ``_schema_ready`` is set and we return immediately. Slow
        path: take the lock, double-check, and issue the CREATE / ALTER /
        INDEX statements. Any exception here disables the cache.
        """
        if self._schema_ready:
            return
        with self._schema_lock:
            if self._schema_ready:
                return
            try:
                import os
                import sqlite3

                parent = os.path.dirname(self._db_path)
                if parent:
                    os.makedirs(parent, exist_ok=True)
                # Use a dedicated short-lived connection for DDL so we don't
                # cache it in _local (that would defeat the per-thread
                # convention for read/write connections).
                init_conn = sqlite3.connect(
                    self._db_path,
                    timeout=5.0,
                    isolation_level=None,
                    check_same_thread=False,
                )
                try:
                    init_conn.execute("PRAGMA journal_mode=WAL")
                    init_conn.execute("PRAGMA synchronous=NORMAL")
                    init_conn.execute("PRAGMA busy_timeout=5000")
                    init_conn.execute(
                        "CREATE TABLE IF NOT EXISTS cache ("
                        "  ns TEXT NOT NULL,"
                        "  k  TEXT NOT NULL,"
                        "  v  BLOB NOT NULL,"
                        "  used_at INTEGER NOT NULL,"
                        "  expires_at INTEGER NOT NULL DEFAULT 0,"  # 0 = never expires
                        "  PRIMARY KEY (ns, k)"
                        ")"
                    )
                    # Migrate a pre-TTL DB: add the column if older schema lacks it.
                    cols = {r[1] for r in init_conn.execute("PRAGMA table_info(cache)").fetchall()}
                    if "expires_at" not in cols:
                        init_conn.execute(
                            "ALTER TABLE cache ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0"
                        )
                    init_conn.execute(
                        "CREATE INDEX IF NOT EXISTS idx_cache_ns_used "
                        "ON cache (ns, used_at)"
                    )
                    init_conn.execute(
                        "CREATE INDEX IF NOT EXISTS idx_cache_expires "
                        "ON cache (expires_at)"
                    )
                    row = init_conn.execute(
                        "SELECT MAX(used_at) FROM cache WHERE ns = ?", (self._namespace,)
                    ).fetchone()
                    if row and row[0] is not None:
                        self._clock = int(row[0])
                finally:
                    try:
                        init_conn.close()
                    except Exception:
                        pass
                self._schema_ready = True
            except Exception as exc:  # pragma: no cover - environability
                self._disable(exc, "init")

    def _disable(self, exc: Exception, op: str) -> None:
        self._available = False
        if not self._init_error_logged:
            self._init_error_logged = True
            logger.warning(
                "SqliteCache disabled (L2 unavailable) at %s: %s: %s",
                op, exc.__class__.__name__, exc,
            )

    def _tick(self) -> int:
        with self._clock_lock:
            self._clock += 1
            return self._clock

    @staticmethod
    def _now() -> int:
        import time

        return int(time.time())

    def _expiry_for_write(self) -> int:
        """Absolute epoch-seconds deadline for a new row, or 0 = never."""
        return self._now() + self._ttl_seconds if self._ttl_seconds > 0 else 0

    # -- CacheBackend --------------------------------------------------

    def get(self, key: K) -> Optional[V]:
        if not self._available:
            return None
        try:
            k = self._encode_key(key)
            conn = self._conn()
            row = conn.execute(
                "SELECT v, expires_at FROM cache WHERE ns = ? AND k = ?",
                (self._namespace, k),
            ).fetchone()
            if row is None:
                return None
            expires_at = row[1]
            if expires_at and expires_at <= self._now():
                # Expired: treat as a miss and drop the row opportunistically
                # (the periodic sweep is the primary reaper; this is a cheap
                # lazy cleanup on the read path).
                try:
                    conn.execute(
                        "DELETE FROM cache WHERE ns = ? AND k = ?",
                        (self._namespace, k),
                    )
                except Exception:
                    pass
                return None
            # Touch recency (best-effort; a failure here shouldn't lose the hit).
            try:
                conn.execute(
                    "UPDATE cache SET used_at = ? WHERE ns = ? AND k = ?",
                    (self._tick(), self._namespace, k),
                )
            except Exception:
                pass
            try:
                return self._decode_value(row[0])
            except Exception as dec_exc:
                # Decode failure is a per-row problem (corrupt bytes,
                # tampered blob, unrecognized frame version) — not a
                # DB-level fault. Drop the bad row so the caller re-computes
                # and next reader stops paying the decode cost. Do NOT
                # disable the whole cache the way a schema/lock error would.
                logger.debug(
                    "SqliteCache: dropping row with undecodable value at ns=%s: %s: %s",
                    self._namespace, dec_exc.__class__.__name__, dec_exc,
                )
                try:
                    conn.execute(
                        "DELETE FROM cache WHERE ns = ? AND k = ?",
                        (self._namespace, k),
                    )
                except Exception:
                    pass
                return None
        except Exception as exc:
            self._disable(exc, "get")
            return None

    def put(self, key: K, value: V) -> None:
        if not self._available:
            return
        try:
            k = self._encode_key(key)
            blob = self._encode_value(value)
            conn = self._conn()
            conn.execute(
                "INSERT INTO cache (ns, k, v, used_at, expires_at) VALUES (?, ?, ?, ?, ?) "
                "ON CONFLICT(ns, k) DO UPDATE SET v = excluded.v, "
                "used_at = excluded.used_at, expires_at = excluded.expires_at",
                (self._namespace, k, blob, self._tick(), self._expiry_for_write()),
            )
            self._evict_if_needed(conn)
        except Exception as exc:
            self._disable(exc, "put")

    def _evict_if_needed(self, conn) -> None:
        count = conn.execute(
            "SELECT COUNT(*) FROM cache WHERE ns = ?", (self._namespace,)
        ).fetchone()[0]
        if count <= self._max_entries:
            return
        over = count - self._max_entries
        # Trim the overflow plus a batch so we don't evict on every insert.
        to_delete = over + self._EVICT_BATCH
        conn.execute(
            "DELETE FROM cache WHERE ns = ? AND k IN ("
            "  SELECT k FROM cache WHERE ns = ? ORDER BY used_at ASC LIMIT ?"
            ")",
            (self._namespace, self._namespace, to_delete),
        )

    def clear(self) -> None:
        if not self._available:
            return
        try:
            self._conn().execute(
                "DELETE FROM cache WHERE ns = ?", (self._namespace,)
            )
        except Exception as exc:
            self._disable(exc, "clear")

    def sweep_expired(self, *, now: Optional[int] = None) -> int:
        """Delete all rows whose TTL has passed. Returns the number removed.

        Sweeps the **whole** database (every namespace), not just this
        instance's — one cache file may hold several namespaces (e.g. NER +
        embeddings) and the periodic sweeper should reap them all in one
        pass. Rows with ``expires_at = 0`` (no TTL) are never touched.
        Best-effort: a locked/broken DB returns 0 rather than raising.
        """
        if not self._available:
            return 0
        cutoff = self._now() if now is None else int(now)
        try:
            cur = self._conn().execute(
                "DELETE FROM cache WHERE expires_at != 0 AND expires_at <= ?",
                (cutoff,),
            )
            return cur.rowcount if cur.rowcount is not None and cur.rowcount > 0 else 0
        except Exception as exc:
            self._disable(exc, "sweep")
            return 0

    def __len__(self) -> int:
        if not self._available:
            return 0
        try:
            return self._conn().execute(
                "SELECT COUNT(*) FROM cache WHERE ns = ?", (self._namespace,)
            ).fetchone()[0]
        except Exception:
            return 0

    @property
    def available(self) -> bool:
        return self._available


# Sentinel put onto the write-behind queue to signal the writer to stop.
_STOP = object()


class TieredCache(Generic[K, V]):
    """Two-tier cache: in-memory L1 (LRU) + persistent L2 (SQLite).

    Conforms to :class:`CacheBackend`. Read path is *read-through*: an L1 miss
    consults L2 and, on an L2 hit, promotes the value back into L1 so
    subsequent reads stay in memory. Write path is *write-behind*: ``put``
    updates L1 synchronously and enqueues the L2 write onto a background
    daemon thread, so the hot path never blocks on disk. If the L2 backend is
    unavailable the cache transparently behaves as L1-only.

    Call :meth:`close` (or :meth:`flush`) on shutdown to drain pending L2
    writes; the FastAPI lifespan does this so a restart re-warms from disk.
    """

    def __init__(
        self,
        l1: "LRUCache[K, V]",
        l2: CacheBackend,
        *,
        write_queue_max: int = 10_000,
    ) -> None:
        self._l1 = l1
        self._l2 = l2
        self._q: "queue.Queue[Tuple[object, object] | object]" = queue.Queue(
            maxsize=write_queue_max
        )
        self._stats_lock = threading.Lock()
        self._stats = {"l1_hits": 0, "l2_hits": 0, "misses": 0, "l2_write_drops": 0}
        self._closed = False
        self._writer = threading.Thread(
            target=self._drain, name="tiered-cache-writer", daemon=True
        )
        self._writer.start()

    def get(self, key: K) -> Optional[V]:
        value = self._l1.get(key)
        if value is not None:
            with self._stats_lock:
                self._stats["l1_hits"] += 1
            return value
        value = self._l2.get(key)
        if value is not None:
            # Promote to L1 without re-queuing an L2 write (it's already there).
            self._l1.put(key, value)
            with self._stats_lock:
                self._stats["l2_hits"] += 1
            return value
        with self._stats_lock:
            self._stats["misses"] += 1
        return None

    def put(self, key: K, value: V) -> None:
        self._l1.put(key, value)
        if self._closed:
            return
        try:
            self._q.put_nowait((key, value))
        except queue.Full:
            # Back-pressure relief: never block the sanitize path on L2. The
            # entry still lives in L1; it just won't be persisted this time.
            with self._stats_lock:
                self._stats["l2_write_drops"] += 1

    def _drain(self) -> None:
        while True:
            item = self._q.get()
            try:
                if item is _STOP:
                    return
                key, value = item
                self._l2.put(key, value)
            except Exception:  # never let the writer thread die
                logger.debug("TieredCache L2 write failed", exc_info=True)
            finally:
                self._q.task_done()

    def clear(self) -> None:
        self._l1.clear()
        self._l2.clear()

    def sweep(self) -> int:
        """Reap expired L2 rows (row-TTL). Returns rows removed; 0 if the L2
        backend has no sweep. L1 is bounded by its own LRU, so it needs none."""
        sweeper = getattr(self._l2, "sweep_expired", None)
        return sweeper() if callable(sweeper) else 0

    def flush(self, timeout: Optional[float] = None) -> None:
        """Block until queued L2 writes are drained (best-effort)."""
        try:
            self._q.join()
        except Exception:
            pass

    def close(self, timeout: float = 5.0) -> None:
        """Drain pending writes and stop the writer thread."""
        if self._closed:
            return
        self._closed = True
        try:
            self._q.put_nowait(_STOP)
        except queue.Full:
            # Force room for the stop sentinel.
            try:
                self._q.get_nowait()
                self._q.put_nowait(_STOP)
            except Exception:
                pass
        self._writer.join(timeout=timeout)

    def stats(self) -> dict:
        with self._stats_lock:
            return dict(self._stats)
