"""Bridge from the legacy ``RunHandle`` progress API onto LRM's async
:class:`~llmrouter_manager.common.operations.OperationPool`.

The local subsystem was originally written against ``backend_manager``'s
``RunManager`` / ``RunHandle`` (SQLite-backed ``runs`` table, *synchronous*
progress writes, per-run ``asyncio.Event`` cancellation). LRM instead owns a
minimal in-memory :class:`OperationPool` whose ``transition`` / ``get`` /
``cancel`` are ``async`` and whose ``pct`` is an ``int``.

``OperationHandle`` gives the ported workers (downloader, supervisor) the same
call shape they expect - ``progress`` / ``message`` / ``done`` /
``raise_if_cancelled`` - re-expressed as ``await``-able methods over the pool.
Cancellation is cooperative: a caller flips the operation to ``cancelled`` via
``pool.cancel(op_id)``; the worker observes it on its next
``await handle.raise_if_cancelled()`` and unwinds by raising
:class:`OperationCancelled`.
"""

from __future__ import annotations

from collections.abc import Callable

from ..common.operations import OperationPool


class OperationCancelled(Exception):
    """Raised inside a worker when its operation has been cancelled."""


def _as_pct(value: float) -> int:
    """Coerce a possibly-fractional progress value to the pool's int scale."""
    return max(0, min(100, int(value)))


class OperationHandle:
    """Per-operation progress handle passed into ported worker coroutines.

    Wraps an ``OperationPool`` + ``operation_id``. All mutating methods are
    ``async`` (the pool serializes on an ``asyncio.Lock``); the pool ignores
    writes once the operation is terminal, so a late ``progress`` after a
    ``cancel`` is a harmless no-op rather than an error.
    """

    def __init__(
        self,
        pool: OperationPool,
        operation_id: str,
        progress_sink: Callable[[str, float, str | None], None] | None = None,
        initial_pct: float = 0,
    ) -> None:
        self._pool = pool
        self._operation_id = operation_id
        self._progress_sink = progress_sink
        self._last_pct = _as_pct(initial_pct)
        self._last_message: str | None = None
        self._files: list[dict[str, object]] = []

    @property
    def operation_id(self) -> str:
        return self._operation_id

    async def progress(self, pct: float, *, message: str | None = None) -> None:
        self._last_pct = _as_pct(pct)
        if message is None:
            message = self._last_message
        else:
            self._last_message = message
        await self._pool.transition(
            self._operation_id, "running", self._last_pct, message
        )
        self._persist("running", self._last_pct, message)

    async def message(self, msg: str) -> None:
        self._last_message = msg
        await self._pool.transition(
            self._operation_id, "running", self._last_pct, msg
        )
        self._persist("running", self._last_pct, msg)

    async def set_files(self, files: list[dict[str, object]]) -> None:
        """Publish the full per-file download manifest onto the operation.

        Called once up front so the UI can list every file (and show
        already-present ones as complete) before any bytes move.
        """
        self._files = [dict(f) for f in files]
        await self._pool.update_metadata(
            self._operation_id, {"files": [dict(f) for f in self._files]}
        )

    async def file_progress(
        self,
        file_id: str,
        *,
        done: int,
        total: int | None = None,
        state: str | None = None,
        error_code: str | None = None,
        error_detail: str | None = None,
    ) -> None:
        """Update one file's live byte counters / state, then push the manifest."""
        updated = False
        for entry in self._files:
            if entry.get("id") == file_id:
                entry["done"] = int(done)
                if total is not None:
                    entry["total"] = int(total)
                if state is not None:
                    entry["state"] = state
                if error_code is not None:
                    entry["error_code"] = error_code
                if error_detail is not None:
                    entry["error_detail"] = error_detail
                updated = True
                break
        if updated:
            await self._pool.update_metadata(
                self._operation_id, {"files": [dict(f) for f in self._files]}
            )

    async def done(self, *, message: str | None = None) -> None:
        await self._pool.transition(self._operation_id, "done", 100, message)
        self._persist("done", 100, message)

    async def error(self, message: str) -> None:
        await self._pool.transition(
            self._operation_id, "error", self._last_pct, message
        )
        self._persist("error", self._last_pct, message)

    def _persist(self, state: str, pct: float, message: str | None) -> None:
        if self._progress_sink is not None:
            self._progress_sink(state, pct, message)

    async def raise_if_cancelled(self) -> None:
        snap = await self._pool.get(self._operation_id)
        if snap is not None and snap.get("state") == "cancelled":
            raise OperationCancelled()
