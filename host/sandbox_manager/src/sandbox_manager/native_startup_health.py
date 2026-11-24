"""Sandbox Manager's start-up health wait for the native backend (#3928).

Ready needs one pass in which openwork-server, the Connector and HDR all answer and, after them,
the Supervisor's ready evidence is valid with every broker role alive. The probes of a pass run
together, and a pass longer than the poll interval is not followed by a sleep: HDR's /readyz starts
a reader process each time, so a pass can take over a second.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence
from pathlib import Path

from loguru import logger


async def wait_for_startup_health(
    *,
    started: float,
    timeout_s: float,
    poll_s: float,
    probes: Mapping[str, Callable[[], Awaitable[bool]]],
    supervisor_ready: Callable[[], bool],
    checks: Sequence[Callable[[], None]],
    role_logs_root: Callable[[], Path],
) -> None:
    """Return on the first pass that sees every probe true and then the Supervisor ready.

    `supervisor_ready` opens the Supervisor's evidence file, which the Supervisor replaces by rename
    during start-up; on Windows that rename fails while the file is open. So it is read only in a
    pass where every probe has already answered, as the short-circuiting check before #3928 did.
    """
    first_true: dict[str, int] = {}

    def held(name: str) -> None:
        first_true.setdefault(name, round((time.monotonic() - started) * 1000))

    async def run(name: str, probe: Callable[[], Awaitable[bool]]) -> bool:
        healthy = await probe()
        if healthy:
            held(name)
        return healthy

    passes = 0
    while time.monotonic() - started < timeout_s:
        for check in checks:
            check()
        pass_started = time.monotonic()
        results = await asyncio.gather(*(run(name, probe) for name, probe in probes.items()))
        passes += 1
        if all(results) and supervisor_ready():
            held("supervisor_ready")
            logger.info(
                "native-backend: startup phase=health event=observed passes={} "
                "last_pass_ms={} {}",
                passes,
                round((time.monotonic() - pass_started) * 1000),
                " ".join(f"{name}_ms={ms}" for name, ms in first_true.items()),
            )
            return
        await asyncio.sleep(max(0.0, poll_s - (time.monotonic() - pass_started)))
    logger.error(
        "native-backend: startup phase=health event=timeout elapsed_ms={} "
        "openwork_healthy={} connector_healthy={} supervisor_ready={}",
        round((time.monotonic() - started) * 1000),
        await probes["openwork"](),
        await probes["connector"](),
        supervisor_ready(),
    )
    raise RuntimeError(
        f"native backend not healthy within {timeout_s:.0f}s; "
        f"see the role logs under {role_logs_root()}"
    )
