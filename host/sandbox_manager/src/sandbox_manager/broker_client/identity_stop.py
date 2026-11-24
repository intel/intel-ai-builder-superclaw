"""Stop every launch of one tier identity together (#3010).

A tier account runs several roles - ``file_tool`` runs the runtime, opencode-router, openwork-server
and, on pro, HDR - each under its own launcher and its own owner-held Job. Stopping that identity means
stopping all of them, so the stop is scoped to ``(instance, SID, generation)``: this backend instance,
the tier's account, and the launches it owns now. Each launcher terminates its own Job without waiting
on its runner, so stopping an identity's launches concurrently bounds the identity's stop by its
slowest launcher rather than by their sum.
"""

from __future__ import annotations

import subprocess
import time
from collections.abc import Sequence
from concurrent.futures import ThreadPoolExecutor
from typing import Protocol

from contracts.broker_startup_catalog_data import BROKER_LAUNCH_ROLE_TIER
from loguru import logger


class StoppableLaunch(Protocol):
    def poll(self) -> int | None: ...

    def stop(self, timeout: float) -> None: ...

    def kill(self) -> None: ...


def stop_launches_by_identity(
    launches: Sequence[tuple[str, str, StoppableLaunch | None]],
    *,
    timeout: float,
) -> list[str]:
    """Stops owned ``(role, handle name, launch)`` entries one tier identity at a time.

    Every live launch of an identity is stopped at once. Identities are visited in the order their first
    launch appears in ``launches``, so the caller's stop order between tiers is kept. Returns the handle
    names whose exit could not be confirmed.
    """
    identities: dict[str, list[tuple[str, StoppableLaunch]]] = {}
    for role, name, launch in launches:
        if launch is not None and launch.poll() is None:
            identities.setdefault(BROKER_LAUNCH_ROLE_TIER[role], []).append((name, launch))
    unconfirmed: list[str] = []
    for tier, members in identities.items():
        started = time.monotonic()
        with ThreadPoolExecutor(max_workers=len(members), thread_name_prefix=f"stop-{tier}") as pool:
            confirmed = list(pool.map(lambda member: _stop_one(member[1], timeout), members))
        failed = [name for (name, _), ok in zip(members, confirmed, strict=True) if not ok]
        unconfirmed.extend(failed)
        logger.info(
            "native-launcher: event=identity_stopped tier={} launches={} unconfirmed={} elapsed_ms={}",
            tier,
            len(members),
            len(failed),
            round((time.monotonic() - started) * 1000),
        )
    return unconfirmed


def _stop_one(launch: StoppableLaunch, timeout: float) -> bool:
    try:
        launch.stop(timeout=timeout)
    except (OSError, subprocess.SubprocessError):
        try:
            launch.kill()
        except (OSError, subprocess.SubprocessError):
            return False
    return launch.poll() is not None
