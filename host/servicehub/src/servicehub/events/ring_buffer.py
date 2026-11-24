"""In-memory event ring buffer for ServiceHub SSE clients."""

from __future__ import annotations

import asyncio
import time
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from threading import RLock
from typing import Literal


EventType = Literal["service.status", "operation.progress", "error"]


@dataclass(frozen=True)
class EventRecord:
    cursor: int
    event_type: EventType
    service: str
    payload: dict[str, object]
    operation_id: str | None = None
    occurred_at: str = field(default_factory=lambda: _now_iso())

    def as_dict(self) -> dict[str, object]:
        return {
            "cursor": self.cursor,
            "event_type": self.event_type,
            "service": self.service,
            "operation_id": self.operation_id,
            "payload": self.payload,
            "occurred_at": self.occurred_at,
        }


class EventRingBuffer:
    def __init__(self, capacity: int = 1000) -> None:
        if capacity <= 0:
            raise ValueError("capacity must be positive")
        self._capacity = capacity
        self._events: deque[EventRecord] = deque(maxlen=capacity)
        self._next_cursor = 1
        self._lock = RLock()

    async def append(
        self,
        *,
        event_type: EventType,
        service: str,
        payload: dict[str, object],
        operation_id: str | None = None,
    ) -> EventRecord:
        with self._lock:
            event = EventRecord(
                cursor=self._next_cursor,
                event_type=event_type,
                service=service,
                payload=payload,
                operation_id=operation_id,
            )
            self._next_cursor += 1
            self._events.append(event)
            return event

    async def events_after(self, cursor: int) -> list[EventRecord]:
        with self._lock:
            return [event for event in self._events if event.cursor > cursor]

    async def wait_for_events_after(self, cursor: int, timeout_s: float) -> list[EventRecord]:
        deadline = time.monotonic() + max(0.0, timeout_s)
        while True:
            existing = await self.events_after(cursor)
            if existing:
                return existing
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return []
            await asyncio.sleep(min(0.05, remaining))

    async def is_expired(self, cursor: int) -> bool:
        with self._lock:
            if not self._events:
                return False
            # A cursor points to the last event a client has already seen.
            # The cursor immediately before the oldest buffered event can still
            # replay the full available window; anything older has an unrecoverable gap.
            return cursor < self._events[0].cursor - 1

    async def oldest_replay_cursor(self) -> int:
        with self._lock:
            if not self._events:
                return 0
            return self._events[0].cursor - 1


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
