"""Remove stale native runtime generations before a backend cold start."""

from __future__ import annotations

import asyncio
import re
import shutil
import threading
import time
from collections.abc import Callable
from concurrent.futures import Future
from pathlib import Path

from loguru import logger

#: How long a stop waits for the prune to finish; well inside ServiceHub's 40 s shutdown grace.
GENERATION_PRUNE_STOP_WAIT_S = 5.0
#: How often a join looks at its abort check while it waits.
_JOIN_SLICE_S = 0.25

_RUNTIME_INSTANCE_ID = re.compile(r"runtime-instance-[0-9a-f]{32}\Z")
_REPARSE_POINT = 0x0400


def _is_reparse_point(path: Path) -> bool:
    if path.is_symlink():
        return True
    return bool(getattr(path.lstat(), "st_file_attributes", 0) & _REPARSE_POINT)


def prune_stale_runtime_generations(
    config_root: Path,
    keep_instance_id: str | None = None,
    *,
    should_stop: Callable[[], bool] = lambda: False,
) -> int:
    """Remove old runtime generations below the native bootstrap config root.

    Only directories with the native runtime-instance naming convention are eligible.
    Reparse points and the generation being prepared are preserved. ``should_stop`` is
    asked before each generation; a generation left behind is removed by the next prune.
    """
    generations_root = config_root / "bootstrap" / "runtime-generations"
    try:
        if not generations_root.is_dir() or _is_reparse_point(generations_root):
            return 0
        candidates = list(generations_root.iterdir())
    except OSError as exc:
        logger.warning(
            "native-backend: failed to scan runtime generations "
            "exception_type={}",
            type(exc).__name__,
        )
        return 0

    removed = 0
    for candidate in candidates:
        if should_stop():
            break
        try:
            eligible = (
                candidate.is_dir()
                and candidate.name != keep_instance_id
                and _RUNTIME_INSTANCE_ID.fullmatch(candidate.name) is not None
                and not _is_reparse_point(candidate)
            )
        except OSError as exc:
            logger.warning(
                "native-backend: failed to inspect runtime generation "
                "name={} exception_type={}",
                candidate.name,
                type(exc).__name__,
            )
            continue
        if not eligible:
            continue
        try:
            shutil.rmtree(candidate)
        except OSError as exc:
            logger.warning(
                "native-backend: failed to prune runtime generation "
                "name={} exception_type={}",
                candidate.name,
                type(exc).__name__,
            )
            continue
        removed += 1
    return removed


class GenerationPruneStillRunning(RuntimeError):
    """A stop asked for a finished prune, and one was still deleting a generation past the deadline."""

    def __init__(self) -> None:
        super().__init__(
            "native backend stale runtime generations are still being deleted "
            "reason=generation_prune_running recovery=retry"
        )


class GenerationPrune:
    """The prune of one start, on a daemon thread; each prune waits for the one before it.

    An elevated provision re-ACLs the tree a prune deletes from, so a prune runs either before the
    provision steps (``inline``) or, held by ``schedule``, only once ``release`` is called after
    them. Holding it costs no overlap if a step elevates after all; the caller joins it before
    anything else that could elevate.
    """

    def __init__(self, should_stop: Callable[[], bool], abort: Callable[[], None]) -> None:
        """``should_stop`` ends the prune between generations; whatever ``abort`` raises ends a start's wait."""
        self._should_stop = should_stop
        self._abort = abort
        self._stopping = threading.Event()
        self._future: Future[None] | None = None
        self._held: tuple[Path, str | None] | None = None

    async def schedule(self, config_root: Path, keep_instance_id: str | None, *, inline: bool) -> None:
        """Prune now and return once done, if ``inline``; otherwise hold the prune for ``release``.

        Either way a prune a failed start left running is waited for first, so it cannot overlap this
        start's provision steps.
        """
        self._held = None
        await asyncio.to_thread(self.join, check=self._abort)
        if inline:
            await self._start(config_root, keep_instance_id, mode="inline")
            await asyncio.to_thread(self.join, check=self._abort)
        else:
            self._held = (config_root, keep_instance_id)

    async def release(self) -> None:
        """Start a held prune in the background; nothing if none is held."""
        held, self._held = self._held, None
        if held is not None:
            await self._start(*held, mode="background")

    async def stop(self, *, must_finish: bool = False) -> None:
        """Drop a held prune, ask the one in flight to stop, and wait for it up to the stop deadline.

        Past the deadline the prune is left running and logged, or, with ``must_finish``, refused
        with ``GenerationPruneStillRunning``. The next start prunes whatever it leaves.
        """
        self._held = None
        self._stopping.set()
        started = time.monotonic()
        if await asyncio.to_thread(self.join, GENERATION_PRUNE_STOP_WAIT_S):
            return
        logger.warning(
            "native-backend: startup phase=generation_prune event=still_running waited_ms={} refused={}",
            round((time.monotonic() - started) * 1000),
            must_finish,
        )
        if must_finish:
            raise GenerationPruneStillRunning()

    def join(self, timeout: float | None = None, *, check: Callable[[], None] = lambda: None) -> bool:
        """Block until the prune in flight, if any, has finished; False past ``timeout``.

        ``check`` runs once even with nothing in flight, then before each short slice of the wait, so
        whatever it raises ends the caller's step. What the prune raised is raised here.
        """
        future = self._future
        if future is None:
            check()
            return True
        pending = not future.done()
        started = time.monotonic()
        try:
            while True:
                check()
                left = None if timeout is None else timeout - (time.monotonic() - started)
                if left is not None and left <= 0:
                    return False
                try:
                    future.result(_JOIN_SLICE_S if left is None else min(_JOIN_SLICE_S, left))
                    break
                except TimeoutError:
                    continue
        finally:
            if future.done() and self._future is future:
                self._future = None
        if pending:
            logger.info(
                "native-backend: startup phase=generation_prune event=awaited waited_ms={}",
                round((time.monotonic() - started) * 1000),
            )
        return True

    async def _start(self, config_root: Path, keep_instance_id: str | None, *, mode: str) -> None:
        await asyncio.to_thread(self.join, check=self._abort)
        self._stopping.clear()
        logger.info("native-backend: startup phase=generation_prune event=begin mode={}", mode)
        future: Future[None] = Future()

        def run() -> None:
            try:
                self._prune(config_root, keep_instance_id)
            except Exception as exc:  # re-raised by join()
                future.set_exception(exc)
            else:
                future.set_result(None)

        self._future = future
        # A daemon thread: a delete still running must never hold up the interpreter's exit.
        threading.Thread(target=run, name="native-generation-prune", daemon=True).start()

    def _prune(self, config_root: Path, keep_instance_id: str | None) -> None:
        started = time.monotonic()
        removed = prune_stale_runtime_generations(
            config_root,
            keep_instance_id,
            should_stop=lambda: self._stopping.is_set() or self._should_stop(),
        )
        logger.info(
            "native-backend: startup phase=generation_prune event=end removed={} elapsed_ms={}",
            removed,
            round((time.monotonic() - started) * 1000),
        )
