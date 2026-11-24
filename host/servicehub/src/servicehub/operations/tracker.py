"""In-memory ServiceHub parent operation tracker."""

from __future__ import annotations

import asyncio
import itertools
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Literal


OperationKind = Literal["provisions", "restart", "shutdown"]
OperationState = Literal["running", "done", "error", "cancelled", "skipped"]


@dataclass
class ChildOperation:
    service: str
    operation_id: str | None
    state: OperationState
    pct: int
    error: dict[str, str] | None

    def as_dict(self) -> dict[str, object]:
        return {
            "service": self.service,
            "operation_id": self.operation_id,
            "state": self.state,
            "pct": self.pct,
            "error": self.error,
        }


@dataclass
class HubOperation:
    operation_id: str
    kind: OperationKind
    state: OperationState
    pct: int
    children: list[ChildOperation] = field(default_factory=list)
    started_at: str = field(default_factory=lambda: _now_iso())
    finished_at: str | None = None

    def as_dict(self) -> dict[str, object]:
        return {
            "operation_id": self.operation_id,
            "kind": self.kind,
            "state": self.state,
            "pct": self.pct,
            "children": [child.as_dict() for child in self.children],
            "started_at": self.started_at,
            "finished_at": self.finished_at,
        }


class OperationTracker:
    def __init__(self) -> None:
        self._operations: dict[str, HubOperation] = {}
        self._counter = itertools.count(1)
        self._lock = asyncio.Lock()

    async def has_running(self, kind: OperationKind) -> bool:
        """Check if any operation of the given kind is still running."""
        async with self._lock:
            return any(
                op.kind == kind and op.state == "running"
                for op in self._operations.values()
            )

    async def create(self, kind: OperationKind) -> dict[str, object]:
        async with self._lock:
            operation_id = f"hub:{kind}_{next(self._counter)}"
            operation = HubOperation(
                operation_id=operation_id,
                kind=kind,
                state="running",
                pct=0,
            )
            self._operations[operation_id] = operation
            return operation.as_dict()

    async def get(self, operation_id: str) -> dict[str, object] | None:
        async with self._lock:
            operation = self._operations.get(operation_id)
            if operation is None:
                return None
            return operation.as_dict()

    async def add_child(
        self,
        operation_id: str,
        *,
        service: str,
        child_operation_id: str | None,
        state: OperationState,
        pct: int,
        error: dict[str, str] | None,
    ) -> dict[str, object]:
        async with self._lock:
            operation = self._require(operation_id)
            operation.children.append(
                ChildOperation(
                    service=service,
                    operation_id=child_operation_id,
                    state=state,
                    pct=_clamp_pct(pct),
                    error=error,
                )
            )
            self._recompute_locked(operation)
            return operation.as_dict()

    async def update_child(
        self,
        operation_id: str,
        *,
        child_operation_id: str,
        state: OperationState,
        pct: int,
        error: dict[str, str] | None,
    ) -> dict[str, object]:
        async with self._lock:
            operation = self._require(operation_id)
            for child in operation.children:
                if child.operation_id == child_operation_id:
                    child.state = state
                    child.pct = _clamp_pct(pct)
                    child.error = error
                    self._recompute_locked(operation)
                    return operation.as_dict()
            return operation.as_dict()

    async def mark_done(self, operation_id: str) -> dict[str, object]:
        async with self._lock:
            operation = self._require(operation_id)
            if operation.state == "running":
                operation.state = "done"
                operation.pct = 100
                operation.finished_at = _now_iso()
            return operation.as_dict()

    async def mark_error(
        self,
        operation_id: str,
        *,
        service: str,
        error: dict[str, str],
    ) -> dict[str, object]:
        async with self._lock:
            operation = self._require(operation_id)
            operation.children.append(
                ChildOperation(
                    service=service,
                    operation_id=None,
                    state="error",
                    pct=0,
                    error=error,
                )
            )
            self._recompute_locked(operation)
            return operation.as_dict()

    async def cancel(self, operation_id: str) -> dict[str, object]:
        async with self._lock:
            operation = self._require(operation_id)
            operation.state = "cancelled"
            operation.finished_at = _now_iso()
            return operation.as_dict()

    async def child_operation_services(self, operation_id: str) -> dict[str, str]:
        async with self._lock:
            operation = self._require(operation_id)
            return {
                child.operation_id: child.service
                for child in operation.children
                if child.operation_id is not None
            }

    async def recompute(self, operation_id: str) -> dict[str, object]:
        async with self._lock:
            operation = self._require(operation_id)
            self._recompute_locked(operation)
            return operation.as_dict()

    def _require(self, operation_id: str) -> HubOperation:
        operation = self._operations.get(operation_id)
        if operation is None:
            raise KeyError(operation_id)
        return operation

    def _recompute_locked(self, operation: HubOperation) -> None:
        if operation.state == "cancelled":
            return
        if not operation.children:
            return
        operation.pct = sum(child.pct for child in operation.children) // len(operation.children)
        if any(child.state == "error" for child in operation.children):
            operation.state = "error"
            operation.finished_at = operation.finished_at or _now_iso()
            return
        if all(child.state in {"done", "skipped"} for child in operation.children):
            operation.state = "done"
            operation.pct = 100
            operation.finished_at = operation.finished_at or _now_iso()
            return
        operation.state = "running"
        operation.finished_at = None


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _clamp_pct(value: int) -> int:
    return max(0, min(100, value))
