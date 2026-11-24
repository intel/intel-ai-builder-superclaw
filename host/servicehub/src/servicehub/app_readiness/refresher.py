"""Background refresh of SandboxManager's runtime readiness evidence (SVC-04).

Exists so that `GET /app/readiness` performs no I/O. The route serves a
snapshot; this task is what keeps the snapshot current. Consequences that matter:
a wedged Sandbox cannot make the endpoint hang or 500, and a UI polling readiness
cannot amplify into per-request runtime probes the way the current
per-request aggregates do.

On any failure this records nothing. Letting the previous evidence age out into
`evidence_stale` is correct; substituting a fabricated verdict is how a readiness
endpoint starts lying.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from typing import Any

from loguru import logger

from servicehub.app_readiness.store import RUNTIME_COMPONENTS, SANDBOX_MANAGER_SERVICE
from servicehub.proxy.service_client import ServiceClientError


READINESS_PATH = "/v1/readiness"

REFRESH_INTERVAL_S = 5.0

# Pace while the current SandboxManager's Runtime is starting, so that turning ready reaches
# the snapshot within about a second. SandboxManager answers an in-flight start-up without
# opening the Supervisor's evidence file, so this pace adds no reader there.
PENDING_REFRESH_INTERVAL_S = 1.0

# The faster pace lasts at most this long per SandboxManager instance. A Runtime still not
# ready by then is refreshed at the steady pace, so it cannot hold the faster one for a session.
PENDING_REFRESH_WINDOW_S = 120.0

# Ceiling for one refresh. `ServiceClient`'s own read timeout is 30s, tuned for
# control-plane calls; a readiness refresh must give up long before that so a
# stalled child cannot pin the refresh loop. Native /readiness retains a 5s
# total ceiling for live OpenWork/Connector reads; HDR (8s server / 10s caller)
# uses a context-bound async observation, never a nested 10s request here.
REFRESH_TIMEOUT_S = 8.0


class RuntimeEvidenceRefresher:
    def __init__(
        self,
        *,
        registry: Any,
        service_client: Any,
        store: Any,
        interval_s: float = REFRESH_INTERVAL_S,
        pending_interval_s: float = PENDING_REFRESH_INTERVAL_S,
        pending_window_s: float = PENDING_REFRESH_WINDOW_S,
        timeout_s: float = REFRESH_TIMEOUT_S,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self._registry = registry
        self._service_client = service_client
        self._store = store
        self._interval_s = interval_s
        self._pending_interval_s = pending_interval_s
        self._pending_window_s = pending_window_s
        self._timeout_s = timeout_s
        self._sleep = sleep
        self._monotonic = monotonic
        self._running = False
        # The running SandboxManager instance, when this refresher first saw it, and whether
        # its last recorded evidence said the Runtime is starting. An instance with no
        # evidence yet counts as starting; a failed read leaves the flag as it was.
        self._pace_instance_id: str | None = None
        self._pace_since = 0.0
        self._runtime_starting = False
        self._recorded_states: tuple[str | None, str] | None = None

    async def run(self) -> None:
        self._running = True
        logger.info(
            "app readiness refresher started interval_s={} pending_interval_s={}",
            self._interval_s,
            self._pending_interval_s,
        )
        try:
            while self._running:
                await self.refresh_once()
                await self._sleep(
                    self._pending_interval_s if self.paces_start_up() else self._interval_s
                )
        except asyncio.CancelledError:
            raise
        finally:
            logger.info("app readiness refresher stopped")

    def stop(self) -> None:
        self._running = False

    def paces_start_up(self) -> bool:
        """Whether the next refresh comes at the start-up pace rather than the steady one."""
        return (
            self._pace_instance_id is not None
            and self._runtime_starting
            and self._monotonic() - self._pace_since < self._pending_window_s
        )

    async def refresh_once(self) -> None:
        """One bounded read. Never raises, never records on failure."""
        try:
            service = self._registry.get(SANDBOX_MANAGER_SERVICE)
        except Exception:
            return
        if service is None or getattr(service, "state", None) != "running":
            # SandboxManager owns this evidence; with it down there is nothing to
            # ask, and its own host_service component already reports why.
            self._pace_instance_id = None
            return
        source_instance_id = getattr(service, "instance_id", None)
        if not isinstance(source_instance_id, str) or not source_instance_id:
            self._pace_instance_id = None
            return
        if self._pace_instance_id != source_instance_id:
            self._pace_instance_id = source_instance_id
            self._pace_since = self._monotonic()
            self._runtime_starting = True

        started = time.monotonic()
        try:
            result = await asyncio.wait_for(
                self._service_client.request_json(service, "GET", READINESS_PATH),
                timeout=self._timeout_s,
            )
        except asyncio.CancelledError:
            raise
        except Exception:
            return

        if isinstance(result, ServiceClientError):
            return
        if getattr(result, "status_code", None) != 200:
            return
        try:
            current = self._registry.get(SANDBOX_MANAGER_SERVICE)
        except Exception:
            return
        if (
            current is None
            or getattr(current, "state", None) != "running"
            or getattr(current, "instance_id", None) != source_instance_id
        ):
            return
        payload = getattr(result, "payload", None)
        self._store.record_runtime_evidence(payload, source_instance_id=source_instance_id)
        states = _runtime_states(payload)
        required = [states.get(name) for name in RUNTIME_COMPONENTS]
        # Only `starting` is on its way to ready; `failed` and `unknown` are not worth the pace.
        self._runtime_starting = "starting" in required and all(
            state in ("ready", "starting") for state in required
        )
        recorded = (
            source_instance_id,
            ",".join(sorted({str(states.get(name)) for name in RUNTIME_COMPONENTS})),
        )
        if recorded != self._recorded_states:
            # On change only: one line per transition, never one per refresh.
            logger.info(
                "app readiness runtime evidence states={} source_instance_id={} request_ms={}",
                recorded[1],
                source_instance_id,
                round((time.monotonic() - started) * 1000),
            )
            self._recorded_states = recorded


def _runtime_states(payload: Any) -> dict[str, Any]:
    """Pacing and logging only: the store, not this, decides what `/app/readiness` reports."""
    components = payload.get("components") if isinstance(payload, dict) else None
    if not isinstance(components, list):
        return {}
    return {
        item["name"]: item.get("state")
        for item in components
        if isinstance(item, dict) and isinstance(item.get("name"), str)
    }
