"""Admission and drain tracking for llama-local data-plane requests."""

from __future__ import annotations

import asyncio


class LocalRequestLease:
    def __init__(self, admission: "LocalRequestAdmission") -> None:
        self._admission = admission
        self._released = False

    def release(self) -> None:
        if self._released:
            return
        self._released = True
        self._admission._release()


class LocalRequestAdmission:
    """Reject new local work while allowing admitted requests to drain."""

    def __init__(self) -> None:
        self._open = True
        self._in_flight = 0
        self._drained = asyncio.Event()
        self._drained.set()

    @property
    def in_flight(self) -> int:
        return self._in_flight

    def try_admit(self) -> LocalRequestLease | None:
        if not self._open:
            return None
        self._in_flight += 1
        self._drained.clear()
        return LocalRequestLease(self)

    def open(self) -> None:
        self._open = True

    async def close_and_drain(self, timeout_s: float) -> bool:
        self._open = False
        if self._in_flight == 0:
            return True
        try:
            await asyncio.wait_for(self._drained.wait(), timeout=timeout_s)
        except TimeoutError:
            return False
        return True

    def _release(self) -> None:
        self._in_flight -= 1
        if self._in_flight == 0:
            self._drained.set()
