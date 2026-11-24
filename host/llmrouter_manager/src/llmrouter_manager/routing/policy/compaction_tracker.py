"""Per-session compaction state + local-compaction budget.

Ported verbatim (behaviour-preserving) from ``D:/routing_service/sidecar.py``
(``CompactionTracker``, ``resolve_max_local_compaction``,
``resolve_fresh_read_jump_tokens``). See
docs/design/routing_service_integration_plan.md §4 / §5a-b.

Holds three per-session counters:
  * ``observed`` — opencode compactions inferred from ``n_msgs`` downdrops
    (telemetry only).
  * ``local``    — COMPACT_LOCALLY 400s the proxy has returned for the session
    (authoritative; governs the escalate-to-cloud budget). This is the
    PREVENTIVE budget: charged before dispatch, on the estimate.
  * ``upstream_overflows`` — real upstream context rejections that requested a
    reactive compaction (authoritative and independent from ``local``). This
    is the REACTIVE budget: charged after the server itself rejected the
    rendered prompt. Cleared only once the original agent's next request
    completes, never by the compaction agent's own summary request.

Process-safety: the tracker is an in-memory per-session dict guarded by the
GIL for its O(1) mutations. It is correct only under a SINGLE process — with
multiple workers, sessions fragment across processes and stickiness/budget
degrade. ``llmrouter_manager`` runs single-worker (verify in deployment; see
plan §5d).
"""
from __future__ import annotations

from typing import Any, Optional

from loguru import logger


class CompactionTracker:
    """Per-session compaction state with TTL-based eviction."""

    # Opencode's compaction pattern is a drop of many messages at once
    # (typical: 20→2). A drop of ≥3 avoids false positives from natural
    # in-session pruning (delete-one-tool-result etc.).
    DROP_MIN = 3
    # Sessions are evicted after this long without a request.
    SESSION_TTL_S = 30 * 60.0
    # Hard cap on tracked sessions. LRU-evict oldest-by-last-seen when full.
    MAX_TRACKED = 4096
    # Default single-turn token jump that marks a "fresh read": a large blob
    # landing in context in one step (observed CSV reads jumped 17k→58k), vs
    # gradual growth (<5k/turn). Compacting a fresh read destroys the data the
    # task needs, so we escalate it to cloud instead.
    FRESH_READ_JUMP_TOKENS = 10_000

    def __init__(
        self,
        max_local_compaction: int,
        fresh_read_jump_tokens: Optional[int] = None,
    ) -> None:
        self.max_local_compaction = max(0, int(max_local_compaction))
        self.fresh_read_jump_tokens = (
            self.FRESH_READ_JUMP_TOKENS if fresh_read_jump_tokens is None
            else max(0, int(fresh_read_jump_tokens))
        )
        # session_id -> {"n_msgs", "observed", "local", "upstream_overflows",
        #                "prev_tokens", "blob_resident", "cloud_sticky",
        #                "expires_at"}
        self._sessions: dict[str, dict[str, Any]] = {}

    def _prune(self, now: float) -> None:
        """Drop expired sessions and enforce ``MAX_TRACKED``. Called on every
        mutation so the map bounds itself without a bg task."""
        stale = [sid for sid, s in self._sessions.items() if s["expires_at"] < now]
        for sid in stale:
            self._sessions.pop(sid, None)
        if len(self._sessions) > self.MAX_TRACKED:
            overflow = len(self._sessions) - self.MAX_TRACKED
            for sid, _ in sorted(
                self._sessions.items(), key=lambda kv: kv[1]["expires_at"]
            )[:overflow]:
                self._sessions.pop(sid, None)

    def _ensure(self, session_id: str, now: float) -> dict[str, Any]:
        state = self._sessions.get(session_id)
        if state is None:
            state = {"n_msgs": None, "observed": 0, "local": 0,
                     "upstream_overflows": 0,
                     "prev_tokens": None, "blob_resident": False,
                     "cloud_sticky": False,
                     "expires_at": now + self.SESSION_TTL_S}
            self._sessions[session_id] = state
        else:
            state["expires_at"] = now + self.SESSION_TTL_S
            state.setdefault("prev_tokens", None)
            state.setdefault("blob_resident", False)
            state.setdefault("cloud_sticky", False)
            state.setdefault("upstream_overflows", 0)
        return state

    def mark_cloud_sticky(self, session_id: Optional[str], now: float) -> None:
        """Record that this session has been routed to cloud (for ANY reason).
        Once set, every subsequent turn sticks to cloud (see
        :meth:`is_cloud_sticky`), so the per-request router can't flip a session
        that already committed to cloud back to a local model that can't hold
        its now-large transcript. No-op without a session id; never auto-cleared.
        """
        if not session_id:
            return
        self._prune(now)
        state = self._ensure(session_id, now)
        state["cloud_sticky"] = True

    def is_cloud_sticky(self, session_id: Optional[str]) -> bool:
        """True if this session has previously been routed to cloud and should
        stay on cloud for all remaining turns. False without a session id."""
        if not session_id:
            return False
        import time
        self._prune(time.monotonic())
        state = self._sessions.get(session_id)
        return bool(state.get("cloud_sticky")) if state else False

    def note_tokens(self, session_id: Optional[str], tokens_in: int, now: float) -> None:
        """Record this request's ``tokens_in`` so the NEXT request can be
        classified as a fresh read. Call once per request, after the fresh-read
        check for the current request. No-op without a session id."""
        if not session_id:
            return
        self._prune(now)
        state = self._ensure(session_id, now)
        state["prev_tokens"] = int(tokens_in)

    def is_fresh_read(self, session_id: Optional[str], tokens_in: int) -> bool:
        """True if ``tokens_in`` jumped by ≥ ``fresh_read_jump_tokens`` versus
        the previous request on this session — a large blob just landed, rather
        than gradual growth. Such a request should escalate to cloud (holds the
        blob), NOT COMPACT_LOCALLY (summarises it away). False when fresh-read
        escalation is disabled or the session has no prior request."""
        if self.fresh_read_jump_tokens <= 0 or not session_id:
            return False
        state = self._sessions.get(session_id)
        if state is None:
            return False
        prev = state.get("prev_tokens")
        if prev is None:
            return False
        return (int(tokens_in) - int(prev)) >= self.fresh_read_jump_tokens

    def mark_blob_resident(self, session_id: Optional[str], now: float) -> None:
        """Record that a fresh read just escalated to cloud, so the large blob
        is now resident in the transcript. Subsequent over-limit turns should
        keep escalating (see :meth:`should_stick_cloud`). No-op without a sid."""
        if not session_id:
            return
        self._prune(now)
        state = self._ensure(session_id, now)
        state["blob_resident"] = True

    def should_stick_cloud(self, session_id: Optional[str], tokens_in: int,
                           cap: int) -> bool:
        """True if this over-limit request should escalate to cloud because a
        big blob is still resident from an earlier fresh-read escalation. Fires
        while ``blob_resident`` is set AND the request is still over ``cap``.
        Disabled when fresh-read escalation is off. False without a session id."""
        if self.fresh_read_jump_tokens <= 0 or not session_id:
            return False
        state = self._sessions.get(session_id)
        if state is None:
            return False
        return bool(state.get("blob_resident")) and int(tokens_in) > int(cap)

    def clear_blob_resident(self, session_id: Optional[str]) -> None:
        """Clear the blob-resident sticky flag — call when a request drops back
        to/under the cap (blob left context). No-op without a session id."""
        if not session_id:
            return
        state = self._sessions.get(session_id)
        if state is not None:
            state["blob_resident"] = False

    def observe(self, session_id: Optional[str], n_msgs: int, now: float) -> int:
        """Telemetry: update the inferred-compaction counter from an ``n_msgs``
        downdrop and return it. First observation baselines and returns 0; a
        drop of ≥ :attr:`DROP_MIN` increments. Returns 0 for empty session_id."""
        if not session_id:
            return 0
        self._prune(now)
        state = self._ensure(session_id, now)
        prev = state["n_msgs"]
        if prev is not None and prev - n_msgs >= self.DROP_MIN:
            state["observed"] += 1
        state["n_msgs"] = n_msgs
        return int(state["observed"])

    def note_local_compaction(self, session_id: Optional[str], now: float) -> int:
        """Record that the proxy just returned a COMPACT_LOCALLY 400 for this
        session. Increments and returns the authoritative ``local`` counter.
        Returns 0 for empty session_id (untrackable)."""
        if not session_id:
            return 0
        self._prune(now)
        state = self._ensure(session_id, now)
        state["local"] += 1
        return int(state["local"])

    def local_compactions(self, session_id: Optional[str]) -> int:
        """Current authoritative local-compaction count (0 if unknown)."""
        if not session_id:
            return 0
        state = self._sessions.get(session_id)
        return int(state["local"]) if state else 0

    def budget_remaining(self, session_id: Optional[str]) -> bool:
        """True iff this session may still COMPACT_LOCALLY (local count below
        ``max_local_compaction``). When False, over-limit local requests should
        escalate to cloud. Returns False for an empty session_id — without a
        session we can't count, so bouncing the same oversized request would
        loop forever; escalate instead."""
        if not session_id:
            return False
        return self.local_compactions(session_id) < self.max_local_compaction

    def upstream_overflow_budget_remaining(self, session_id: Optional[str]) -> bool:
        """Whether a real upstream overflow may still request compaction.

        This counter is separate from the preventive counter because an under-cap
        estimate may be wrong repeatedly. It is cleared only after the original
        agent completes a successful request, not while the compaction agent is
        generating its summary.
        """
        if not session_id:
            return False
        state = self._sessions.get(session_id)
        used = int(state["upstream_overflows"]) if state else 0
        return used < self.max_local_compaction

    def note_upstream_overflow(self, session_id: Optional[str], now: float) -> int:
        """Consume one reactive-compaction attempt for ``session_id``."""
        if not session_id:
            return 0
        self._prune(now)
        state = self._ensure(session_id, now)
        state["upstream_overflows"] += 1
        return int(state["upstream_overflows"])

    def clear_upstream_overflows(self, session_id: Optional[str]) -> None:
        """Clear reactive attempts after a normal agent request succeeds."""
        if not session_id:
            return
        state = self._sessions.get(session_id)
        if state is not None:
            state["upstream_overflows"] = 0

    def reset_compaction_budget(self, session_id: Optional[str]) -> None:
        """Refund the local-compaction budget — call when a request drops back
        to/under the cap, i.e. compaction demonstrably WORKED.

        Without this the budget is charged against the session's whole TTL, so a
        long session that overflows once more after two successful compactions
        can no longer compact and its turn is handed to a server that may not
        hold it (issue #1799: two working compactions, then a 71208-token prompt
        forwarded into a 65536-token window).

        Safe against the loop the budget exists to stop ONLY if the caller
        excludes the compaction agent's own request. That loop is
        compact → summary → compact → summary → …, and the summary request
        opencode sends after each synthetic 400 (agent ``compaction``, a few
        thousand tokens) IS an under-cap request on the same session. Refunding
        on it resets ``local`` to 0 every cycle, so ``max_local_compaction``
        never bounds anything (observed 2026-09-15: 25 synthetic 400s / 49
        compactions on a "budget of 2"; every COMPACT_LOCALLY line read 1/2).
        ``decide_over_limit`` therefore skips the refund when
        ``is_compaction_request`` is set; a refund requires the ORIGINAL agent's
        next request to come back under the cap — real forward progress.
        """
        if not session_id:
            return
        state = self._sessions.get(session_id)
        if state is not None:
            state["local"] = 0

    def tracked_count(self) -> int:
        """For tests / diagnostics."""
        return len(self._sessions)


def resolve_max_local_compaction(
    arg_value: Optional[int],
    env_value: Optional[str],
    legacy_arg_value: Optional[int] = None,
    legacy_env_value: Optional[str] = None,
    default: int = 2,
) -> int:
    """Resolve the per-session local-compaction budget. Precedence:
      1. ``arg_value``
      2. ``LATENTFACTOR_MAX_LOCAL_COMPACTION`` env
      3. legacy ``legacy_arg_value``
      4. legacy ``LATENTFACTOR_COMPACTION_CLOUD_THRESHOLD`` env
      5. default (2)
    ``0`` = never compact locally (over-limit → cloud). Negative clamps to 0.
    """
    def _parse(v: Optional[str], name: str) -> Optional[int]:
        if not v:
            return None
        try:
            return max(0, int(v))
        except ValueError:
            logger.warning("invalid {}={!r}, ignoring", name, v)
            return None

    if arg_value is not None:
        return max(0, int(arg_value))
    env = _parse(env_value, "LATENTFACTOR_MAX_LOCAL_COMPACTION")
    if env is not None:
        return env
    if legacy_arg_value is not None:
        return max(0, int(legacy_arg_value))
    legacy_env = _parse(legacy_env_value, "LATENTFACTOR_COMPACTION_CLOUD_THRESHOLD")
    if legacy_env is not None:
        return legacy_env
    return default


def resolve_fresh_read_jump_tokens(
    arg_value: Optional[int],
    env_value: Optional[str],
    default: int = CompactionTracker.FRESH_READ_JUMP_TOKENS,
) -> int:
    """Resolve the fresh-read jump threshold (tokens). Precedence:
    arg → ``LATENTFACTOR_FRESH_READ_JUMP_TOKENS`` env → default. ``0`` disables
    fresh-read escalation. Negative clamps to 0; invalid env warns + falls back.
    """
    if arg_value is not None:
        return max(0, int(arg_value))
    if env_value:
        try:
            return max(0, int(env_value))
        except ValueError:
            logger.warning(
                "invalid LATENTFACTOR_FRESH_READ_JUMP_TOKENS={!r}, "
                "falling back to default ({})", env_value, default,
            )
    return default
