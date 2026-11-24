"""Run lifecycle helpers.

A *run* is a unit of asynchronous work whose progress is exposed to the UI
via ``GET /sandbox-manager/v1/operations/{operation_id}``.  All long-running
work (server starts, ensure-ready orchestration, native backend bring-up)
is wrapped in a run so the frontend has a single polling shape.

State machine (model_manager_todo.md §0.4):

    pending ──► running ──► done
                    │
                    ├──► error
                    └──► cancelled

* ``pending``   – row inserted, worker not yet started
* ``running``   – worker has begun emitting progress
* ``done``      – work completed successfully (pct=100)
* ``error``     – worker failed; ``error`` column populated
* ``cancelled`` – cancelled via API (best-effort cooperative cancel)

Parent / child runs: ``ensure-ready`` creates a parent run and emits
child runs for each download + server start.  Parent ``pct`` is
recomputed by :meth:`RunManager.recompute_parent_pct` using a weighted
average (chat:embedding = 2:1, see §6.2).
"""

from __future__ import annotations

import asyncio
import secrets
from typing import Any, Awaitable, Callable

from loguru import logger

from .store import Store


# Run kind enum.
#
# Values are the wire-format `kind` strings used in API responses (api.md
# children shape). Internal-only kinds (parents, controls) keep
# concise names that don't appear in api.md but are needed for store-level
# tracking and dedup.
KIND_MODEL_DOWNLOAD = "model_download"
KIND_MODEL_VERIFY = "model_verify"
KIND_MODEL_SERVER_START = "server_start"
KIND_MODEL_SERVER_ENSURE_READY = "model_server.ensure_ready"

# SANDBOX (native backend) kinds.
KIND_RUNTIME_INFRASTRUCTURE_PREPARE = "runtime_infrastructure.prepare"
KIND_RUNTIME_DEPLOYMENT_ENSURE = "runtime_deployment.ensure"
KIND_SANDBOX_CONTROL = "sandbox.control"  # atomic

# Installs an allow-listed optional package (the Office preview's LibreOffice).
KIND_OPTIONAL_PACKAGE_INSTALL = "optional_package.install"

ALLOWED_KINDS = {
    KIND_MODEL_DOWNLOAD,
    KIND_MODEL_VERIFY,
    KIND_MODEL_SERVER_START,
    KIND_MODEL_SERVER_ENSURE_READY,
    KIND_RUNTIME_INFRASTRUCTURE_PREPARE,
    KIND_RUNTIME_DEPLOYMENT_ENSURE,
    KIND_SANDBOX_CONTROL,
    KIND_OPTIONAL_PACKAGE_INSTALL,
}

STATE_PENDING = "pending"
STATE_RUNNING = "running"
STATE_DONE = "done"
STATE_ERROR = "error"
STATE_CANCELLED = "cancelled"

TERMINAL_STATES = {STATE_DONE, STATE_ERROR, STATE_CANCELLED}


def new_run_id() -> str:
    return "run_" + secrets.token_hex(8)


class RunCancelled(Exception):
    """Raised inside a worker when its run has been cancelled."""


class RunManager:
    """Coordinates background runs and cancellation tokens.

    The manager keeps an in-memory map of ``run_id → asyncio.Event`` used
    to signal cancellation cooperatively.  Workers must periodically call
    :meth:`raise_if_cancelled` (or pass the event into low-level IO).
    """

    def __init__(self, store: Store) -> None:
        self._store = store
        self._cancel_events: dict[str, asyncio.Event] = {}
        self._tasks: dict[str, asyncio.Task[Any]] = {}
        self._lock = asyncio.Lock()
        # Callbacks invoked when a top-level run (parent_run_id IS NULL) reaches
        # a terminal state (done / error / cancelled).  Use register_completion_callback()
        # to subscribe; callbacks must be non-blocking (fire-and-forget coroutines
        # should be wrapped in asyncio.create_task inside the callback).
        self._completion_callbacks: list[Callable[[], None]] = []

    def register_completion_callback(self, cb: Callable[[], None]) -> None:
        """Register a zero-argument callable to be called when any top-level run finishes."""
        self._completion_callbacks.append(cb)

    # ----------------------------------------------------------- creation

    def create(
        self,
        *,
        kind: str,
        parent_run_id: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> str:
        if kind not in ALLOWED_KINDS:
            raise ValueError(f"unknown run kind: {kind!r}")
        run_id = new_run_id()
        self._store.insert_run(
            run_id=run_id,
            kind=kind,
            parent_run_id=parent_run_id,
            metadata=metadata,
        )
        self._cancel_events[run_id] = asyncio.Event()
        return run_id

    async def spawn(
        self,
        *,
        kind: str,
        worker: Callable[["RunHandle"], Awaitable[None]],
        parent_run_id: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> str:
        """Create a run row + schedule ``worker`` on the event loop.

        ``worker`` receives a :class:`RunHandle` for progress reporting and
        cancellation checks.  Exceptions are caught and recorded as
        ``state=error``; ``RunCancelled`` becomes ``state=cancelled``.
        """
        run_id = self.create(kind=kind, parent_run_id=parent_run_id, metadata=metadata)
        handle = RunHandle(self, run_id)

        async def _runner() -> None:
            self._store.update_run(run_id, state=STATE_RUNNING)
            try:
                await worker(handle)
            except RunCancelled:
                self._store.update_run(
                    run_id, state=STATE_CANCELLED, finished=True, message="cancelled"
                )
            except asyncio.CancelledError:
                self._store.update_run(
                    run_id, state=STATE_CANCELLED, finished=True, message="cancelled"
                )
                raise
            except Exception as exc:  # noqa: BLE001 — log and surface to UI
                logger.opt(exception=True).error(
                    "run failed run_id={} kind={} exc_type={} exc={}",
                    run_id,
                    kind,
                    type(exc).__name__,
                    exc,
                )
                self._store.update_run(
                    run_id,
                    state=STATE_ERROR,
                    finished=True,
                    error=f"{type(exc).__name__}: {exc}",
                )
            else:
                # If the worker didn't already mark done, mark done at 100%.
                row = self._store.get_run(run_id)
                if row and row["state"] not in TERMINAL_STATES:
                    self._store.update_run(
                        run_id, state=STATE_DONE, pct=100.0, finished=True
                    )
            finally:
                # Recompute parent pct now that this child is terminal.
                _row = self._store.get_run(run_id)
                _parent_id = (_row or {}).get("parent_run_id")
                if _parent_id:
                    self.recompute_parent_pct(_parent_id)
                else:
                    # Top-level run just finished — notify subscribers so they
                    # can react immediately (e.g. trigger a cleanup pass).
                    for _cb in self._completion_callbacks:
                        try:
                            _cb()
                        except Exception:  # noqa: BLE001
                            pass
                async with self._lock:
                    self._tasks.pop(run_id, None)

        task = asyncio.create_task(_runner(), name=f"run:{kind}:{run_id}")
        async with self._lock:
            self._tasks[run_id] = task
        return run_id

    # ----------------------------------------------------------- accessors

    def get(self, run_id: str) -> dict[str, Any] | None:
        return self._store.get_run(run_id)

    def cancel(self, run_id: str) -> bool:
        ev = self._cancel_events.get(run_id)
        if not ev:
            return False
        ev.set()
        return True

    def cancel_event(self, run_id: str) -> asyncio.Event | None:
        return self._cancel_events.get(run_id)

    async def wait_for_run(self, run_id: str) -> None:
        """Wait through worker cleanup and terminal Store updates without cancelling it."""
        async with self._lock:
            task = self._tasks.get(run_id)
        if task is not None and task is not asyncio.current_task():
            await asyncio.shield(task)

    # -------------------------------------------------------- parent recompute

    def recompute_parent_pct(self, parent_run_id: str) -> None:
        """Update parent ``pct`` based on its children using weighted average.

        Weight resolution order (sps_manager_todo.md §0.5):

        1. ``metadata.weight`` (int) — preferred, set by SANDBOX lifecycle
        2. role-based fallback (chat=2, embedding=1) for model_manager parity
        3. weight=1 default

        Only **scheduled** children (rows that already exist) participate in
        the denominator.  Future-but-not-yet-created children must NOT be
        pre-counted; otherwise scenario B (skip install) would dilute the
        parent pct so it could never reach 100%.

        However, to avoid the visual regression where pct jumps backward
        (e.g. 100→92) when a new child is spawned after a previous child
        completes, callers may stamp ``metadata.expected_total_weight`` on the
        parent run.  The denominator becomes
        ``max(actual_weight, expected_total_weight)`` so that completing an
        early child never pushes the parent beyond the proportion that child
        represents of the full budget.

        Failure propagation: any child in ``error`` state stops further
        scheduling at the caller layer, but this method
        still recomputes pct based on whatever children exist.

        Edge: terminal children (done/error/cancelled) count as 100% to avoid
        the parent stalling at 99.x when a child reports pct=99.5 then
        transitions to done without an explicit pct=100.
        """
        children = self._store.get_child_runs(parent_run_id)
        if not children:
            return
        total_weight = 0.0
        weighted_sum = 0.0
        for c in children:
            meta = c.get("metadata") or {}
            w_raw = meta.get("weight")
            if isinstance(w_raw, (int, float)) and w_raw > 0:
                w = float(w_raw)
            else:
                role = meta.get("role")
                w = 2.0 if role == "chat" else 1.0
            total_weight += w
            # Treat terminal children as 100% to avoid stalling parent pct
            pct = 100.0 if c["state"] in TERMINAL_STATES else float(c.get("pct") or 0.0)
            weighted_sum += w * pct
        if total_weight > 0:
            # Use the pre-declared full budget as denominator when available so
            # that finishing an early child never pushes parent pct above the
            # fraction that child represents of the total (no backward jumps).
            parent_row = self._store.get_run(parent_run_id)
            parent_meta = (parent_row or {}).get("metadata") or {}
            expected = parent_meta.get("expected_total_weight")
            if isinstance(expected, (int, float)) and expected > total_weight:
                denominator = float(expected)
            else:
                denominator = total_weight
            self._store.update_run(parent_run_id, pct=weighted_sum / denominator)


class RunHandle:
    """Per-run handle passed into worker coroutines."""

    def __init__(self, mgr: RunManager, run_id: str) -> None:
        self._mgr = mgr
        self._run_id = run_id

    @property
    def run_id(self) -> str:
        return self._run_id

    def raise_if_cancelled(self) -> None:
        ev = self._mgr.cancel_event(self._run_id)
        if ev is not None and ev.is_set():
            raise RunCancelled()

    def progress(self, pct: float, *, message: str | None = None) -> None:
        self._mgr._store.update_run(self._run_id, pct=pct, message=message)
        row = self._mgr._store.get_run(self._run_id)
        parent = (row or {}).get("parent_run_id")
        if parent:
            self._mgr.recompute_parent_pct(parent)

    def message(self, msg: str) -> None:
        self._mgr._store.update_run(self._run_id, message=msg)

    def done(self, *, message: str | None = None) -> None:
        self._mgr._store.update_run(
            self._run_id, state=STATE_DONE, pct=100.0, message=message, finished=True
        )

    def end(self, state: str, *, error: str, message: str | None = None) -> None:
        """Finish the run as ``error`` or ``cancelled``, with a short stable ``error`` code."""
        self._mgr._store.update_run(
            self._run_id, state=state, error=error, message=message, finished=True
        )
