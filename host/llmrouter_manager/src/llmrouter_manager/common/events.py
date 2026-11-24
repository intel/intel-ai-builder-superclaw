"""Typed diagnostic event emission — the closed vocabulary and the writer.

Mirrors ``common/usage.py``: a module-level store singleton wired once at app
startup, a single ``record_event`` entry point, and a silent no-op when no store
is set (early boot, tests that do not need persistence).

Three rules this module enforces, from the design doc §4.2 / §7:

1. **Closed vocabulary.** ``event_type`` must be an :class:`EventType`. A
   free-form string field degrades to ``UnknownError`` within two releases — we
   have the receipt. The whole value of the taxonomy is that ``GROUP BY
   event_type`` is exhaustive, so an unknown type is dropped and logged rather
   than written.
2. **``error``/``fatal`` are ALWAYS written.** They are never gated behind
   ``SUPERCLAW_DEBUG_OBSERVABILITY``. A failure must not depend on someone
   having thought to enable debugging beforehand. ``debug``/``info`` ARE gated.
   ``warn`` is always written too — the ``warn`` types in the catalogue
   (``tool.error``, ``mock.armed``/``mock.refused``, and the two
   ``context.compaction_*`` rows) each explain a degraded, non-representative
   or user-visible-but-recoverable turn, which is exactly what a post-hoc
   triage needs. ``context.compaction_triggered`` in particular ships in
   release builds by decision (2026-09-15): "it compacted when it should not
   have" is the user-reported symptom, so its row must not depend on
   ``SUPERCLAW_DEBUG_OBSERVABILITY`` having been on first.
3. **Emission never breaks the request path.** Every public function here
   swallows its own exceptions. This is observability, not a feature: a
   full disk, a locked DB or a weird attrs payload must cost a log line, never
   a turn.

Correlation ids default from a :class:`contextvars.ContextVar` set once per
chat request by ``routing/proxy.py``. That lets the deep, pure repair layers in
``common/tools.py`` emit correlated events without threading ``session_id``
through half a dozen signatures. Explicit keyword arguments always win over the
context.

Design record: ``docs/design/2026-09-11_benchmark_error_observability.md`` §4.
"""

from __future__ import annotations

import contextvars
import os
import time
import uuid
from dataclasses import dataclass
from enum import Enum
from typing import Any, Literal

from loguru import logger

from llmrouter_manager.common.event_store import EventRecord, EventStore


Severity = Literal["debug", "info", "warn", "error", "fatal"]

_SEVERITIES: frozenset[str] = frozenset(
    {"debug", "info", "warn", "error", "fatal"}
)

# Severities that are NEVER gated. See rule 2 in the module docstring.
_ALWAYS_WRITE: frozenset[str] = frozenset({"warn", "error", "fatal"})


class EventType(str, Enum):
    """The closed vocabulary (design §4.2).

    Everything here is emitted except ``turn.terminal``. That one is the
    persisted ``classifyTerminal()`` verdict, and ``classifyTerminal`` grades a
    whole *opencode* turn (``tools/trajectory/src/turns.ts``) from the assistant
    message parts, tool-part error states and abort signals. LRM sees one
    ``/v1/chat/completions`` STEP of that turn, never the turn: it does not
    observe tool execution results, whether opencode kept looping, or a UI
    abort. Emitting a per-step guess under the same name would poison the one
    property the taxonomy exists for — that ``GROUP BY event_type`` means the
    same thing to every reader. The name stays reserved for whoever can compute
    it honestly (the inspector, or opencode itself).
    """

    # ── error: the ones that currently log nothing ──
    UPSTREAM_STREAM_TIMEOUT = "upstream.stream_timeout"
    UPSTREAM_STREAM_ABORT = "upstream.stream_abort"
    UPSTREAM_HTTP_ERROR = "upstream.http_error"
    UPSTREAM_SSE_REPAIR_FAILED = "upstream.sse_repair_failed"
    CONTEXT_OVERFLOW = "context.overflow"
    AGENT_STEP_BUDGET_EXHAUSTED = "agent.step_budget_exhausted"

    # ── warn ──
    TOOL_ERROR = "tool.error"
    MOCK_ARMED = "mock.armed"
    MOCK_REFUSED = "mock.refused"
    # A compaction was triggered. attrs ``authority``/``evidence`` say by
    # whom and how LRM knows: ``lrm``/``synthetic_400`` — LRM's own
    # ``context_length_exceeded`` 400 from ``proxy._compact_locally_response``
    # (with the budget arithmetic); ``opencode``/``superclaw-agent-header`` —
    # LRM observed the compaction-summary request (``Superclaw-Agent:
    # compaction``) with no LRM trigger preceding it in the session. Both
    # carry the full context ledger (``routing/context_ledger.py``). This is
    # the ONLY row for a recoverable LRM compaction — it is deliberately not
    # a ``context.overflow`` (decision 2026-09-15).
    CONTEXT_COMPACTION_TRIGGERED = "context.compaction_triggered"
    # LRM's local-compaction budget is spent (or disabled) and no escalation
    # is possible, so an over-cap request is FORWARDED and the upstream's own
    # window becomes the authority. Not ``context.overflow``: that row means
    # the prompt provably did not fit, whereas this one records LRM giving up
    # its recoverable options — the upstream may still accept the request.
    CONTEXT_COMPACTION_EXHAUSTED = "context.compaction_exhausted"

    # ── info (gated on SUPERCLAW_DEBUG_OBSERVABILITY) ──
    CHAT_REQUEST = "chat.request"
    CHAT_CTX_PROCEED = "chat.ctx_proceed"
    CHAT_MODEL_POLICY = "chat.model_policy"
    CHAT_COMPLETION = "chat.completion"
    ROUTE_DECISION = "route.decision"
    # Reserved, never emitted by LRM — see the class docstring.
    TURN_TERMINAL = "turn.terminal"


# Default severity per type. ``record_event`` uses it unless the caller
# overrides, so a call site cannot accidentally downgrade an error to info.
DEFAULT_SEVERITY: dict[EventType, Severity] = {
    EventType.UPSTREAM_STREAM_TIMEOUT: "error",
    EventType.UPSTREAM_STREAM_ABORT: "error",
    EventType.UPSTREAM_HTTP_ERROR: "error",
    EventType.UPSTREAM_SSE_REPAIR_FAILED: "error",
    EventType.CONTEXT_OVERFLOW: "error",
    EventType.AGENT_STEP_BUDGET_EXHAUSTED: "error",
    EventType.TOOL_ERROR: "warn",
    EventType.MOCK_ARMED: "warn",
    EventType.MOCK_REFUSED: "warn",
    EventType.CONTEXT_COMPACTION_TRIGGERED: "warn",
    EventType.CONTEXT_COMPACTION_EXHAUSTED: "warn",
    EventType.CHAT_REQUEST: "info",
    EventType.CHAT_CTX_PROCEED: "info",
    EventType.CHAT_MODEL_POLICY: "info",
    EventType.CHAT_COMPLETION: "info",
    EventType.ROUTE_DECISION: "info",
    EventType.TURN_TERMINAL: "info",
}


@dataclass(frozen=True, slots=True)
class EventContext:
    """Per-request correlation defaults."""

    session_id: str | None = None
    message_id: str | None = None
    trace_id: str | None = None
    agent: str | None = None
    model: str | None = None


_EMPTY_CONTEXT = EventContext()

# Set once per chat request by the proxy; read by every emission site that does
# not carry the ids itself.
_context: contextvars.ContextVar[EventContext] = contextvars.ContextVar(
    "llmrouter_event_context", default=_EMPTY_CONTEXT
)


# Module-level singleton set by app.py at startup via set_store().
# None until then -> record_event silently no-ops.
_store: EventStore | None = None


def set_store(store: EventStore | None) -> None:
    """Wire the module-level EventStore. Called once at app startup.

    Pass ``None`` from test teardown / shutdown to detach.
    """
    global _store
    _store = store


def get_store() -> EventStore | None:
    """The wired store, or ``None``. Exposed for tests and for the app's
    shutdown path."""
    return _store


def set_event_context(ctx: EventContext) -> contextvars.Token:
    """Install per-request correlation defaults. Returns the reset token."""
    return _context.set(ctx)


def reset_event_context(token: contextvars.Token) -> None:
    """Restore the previous correlation defaults. Never raises."""
    try:
        _context.reset(token)
    except Exception:  # noqa: BLE001
        pass


def current_event_context() -> EventContext:
    return _context.get()


def _debug_observability_enabled() -> bool:
    return (os.environ.get("SUPERCLAW_DEBUG_OBSERVABILITY") or "").strip() == "1"


def should_write(severity: str) -> bool:
    """``warn``/``error``/``fatal`` always; ``debug``/``info`` only under
    ``SUPERCLAW_DEBUG_OBSERVABILITY=1``."""
    if severity in _ALWAYS_WRITE:
        return True
    return _debug_observability_enabled()


def record_event(
    event_type: EventType,
    *,
    severity: Severity | None = None,
    session_id: str | None = None,
    message_id: str | None = None,
    trace_id: str | None = None,
    agent: str | None = None,
    model: str | None = None,
    attrs: dict[str, Any] | None = None,
) -> bool:
    """Write one typed event. Returns True when a row was written.

    Never raises. Returns False when the store is not wired, the severity is
    gated off, or the write failed — the caller must not branch on the result
    for anything but "did this actually persist" bookkeeping.
    """
    try:
        if not isinstance(event_type, EventType):
            logger.warning(
                "events: refusing unknown event_type {!r} (closed vocabulary)",
                event_type,
            )
            return False
        sev = severity or DEFAULT_SEVERITY.get(event_type, "info")
        if sev not in _SEVERITIES:
            logger.warning(
                "events: refusing unknown severity {!r} for {}",
                sev,
                event_type.value,
            )
            return False
        if not should_write(sev):
            return False
        store = _store
        if store is None:
            return False
        ctx = _context.get()
        record = EventRecord(
            event_id=str(uuid.uuid4()),
            occurred_at=int(time.time() * 1000),
            event_type=event_type.value,
            severity=sev,
            session_id=session_id if session_id is not None else ctx.session_id,
            message_id=message_id if message_id is not None else ctx.message_id,
            trace_id=trace_id if trace_id is not None else ctx.trace_id,
            agent=agent if agent is not None else ctx.agent,
            model=model if model is not None else ctx.model,
            attrs=attrs,
        )
        store.insert(record)
        return True
    except Exception as exc:  # noqa: BLE001
        # Rule 3: observability must never break the request path.
        logger.warning(
            "events: failed to record {} ({}: {})",
            getattr(event_type, "value", event_type),
            exc.__class__.__name__,
            exc,
        )
        return False
