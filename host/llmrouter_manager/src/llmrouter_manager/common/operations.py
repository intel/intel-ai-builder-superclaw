"""Service-local in-memory operation pool for llmrouter_manager."""

from __future__ import annotations

import asyncio
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Literal


OperationState = Literal["pending", "running", "done", "error", "cancelled"]
TerminalOperationState = Literal["done", "error", "cancelled"]

TERMINAL_STATES: set[OperationState] = {"done", "error", "cancelled"}


@dataclass
class Operation:
    operation_id: str
    kind: str
    state: OperationState = "pending"
    pct: int = 0
    message: str | None = None
    last_error_message: str | None = None
    started_at: str = field(default_factory=lambda: _now_iso())
    finished_at: str | None = None
    metadata: dict[str, object] = field(default_factory=dict)
    children: list[dict[str, object]] = field(default_factory=list)

    def as_dict(self) -> dict[str, object]:
        return {
            "operation_id": self.operation_id,
            "kind": self.kind,
            "state": self.state,
            "pct": self.pct,
            "message": self.message,
            "last_error_message": self.last_error_message,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "metadata": dict(self.metadata),
            "children": list(self.children),
        }


class OperationPool:
    def __init__(self) -> None:
        self._operations: dict[str, Operation] = {}
        self._lock: asyncio.Lock = asyncio.Lock()

    async def create(
        self,
        kind: str,
        metadata: dict[str, object] | None = None,
    ) -> dict[str, object]:
        async with self._lock:
            operation_id = f"lrm:{kind}-{uuid.uuid4().hex}"
            operation = Operation(
                operation_id=operation_id,
                kind=kind,
                metadata=dict(metadata or {}),
            )
            self._operations[operation_id] = operation
            return operation.as_dict()

    async def restore(
        self,
        operation_id: str,
        kind: str,
        *,
        pct: int,
        message: str | None,
        metadata: dict[str, object] | None = None,
    ) -> dict[str, object]:
        """Restore one durable in-flight operation after a process restart."""
        async with self._lock:
            existing = self._operations.get(operation_id)
            if existing is not None:
                return existing.as_dict()
            operation = Operation(
                operation_id=operation_id,
                kind=kind,
                state="running",
                pct=_clamp_pct(pct),
                message=message,
                metadata=dict(metadata or {}),
            )
            self._operations[operation_id] = operation
            return operation.as_dict()

    async def get(self, operation_id: str) -> dict[str, object] | None:
        async with self._lock:
            operation = self._operations.get(operation_id)
            if operation is None:
                return None
            return operation.as_dict()

    async def update_metadata(
        self, operation_id: str, patch: dict[str, object]
    ) -> dict[str, object] | None:
        """Shallow-merge *patch* into an operation's ``metadata``.

        Used to attach structured progress detail (e.g. a per-file download
        manifest) that ``transition``'s flat ``pct``/``message`` cannot carry.
        A no-op once the operation is terminal, mirroring ``transition``.
        """
        async with self._lock:
            operation = self._operations.get(operation_id)
            if operation is None:
                return None
            if operation.state in TERMINAL_STATES:
                return operation.as_dict()
            operation.metadata.update(patch)
            return operation.as_dict()

    async def cancel(self, operation_id: str) -> dict[str, object] | None:
        async with self._lock:
            operation = self._operations.get(operation_id)
            if operation is None:
                return None
            if operation.state in TERMINAL_STATES:
                return operation.as_dict()
            self._finish(
                operation, "cancelled", operation.pct, operation.message or "cancelled"
            )
            return operation.as_dict()

    async def transition(
        self,
        operation_id: str,
        state: OperationState,
        pct: int,
        message: str | None,
    ) -> dict[str, object] | None:
        async with self._lock:
            operation = self._operations.get(operation_id)
            if operation is None:
                return None
            if operation.state in TERMINAL_STATES:
                return operation.as_dict()
            if state in TERMINAL_STATES:
                self._finish(operation, state, pct, message)
                return operation.as_dict()
            operation.state = state
            operation.pct = _clamp_pct(pct)
            operation.message = message
            return operation.as_dict()

    def _finish(
        self,
        operation: Operation,
        state: OperationState,
        pct: int,
        message: str | None,
    ) -> None:
        if state not in TERMINAL_STATES:
            return
        operation.state = state
        operation.pct = _clamp_pct(pct)
        operation.message = message
        if state == "error":
            operation.last_error_message = message
        operation.finished_at = operation.finished_at or _now_iso()


def _now_iso() -> str:
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def _clamp_pct(value: int) -> int:
    return max(0, min(100, value))
