"""Direct child-service health watchdog."""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from typing import Protocol

import httpx
from loguru import logger

from servicehub.supervisor.process_manager import RESTART_STABILITY_S
from servicehub.supervisor.registry import ServiceInfo, ServiceRegistry


Probe = Callable[..., Awaitable[bool]]


class RecordHealth(Protocol):
    """Write-only sink for probe observations.

    Injected rather than imported so the watchdog can feed the readiness snapshot
    without gaining any way to read the aggregate App state. Restart decisions must
    stay on per-child evidence -- instance identity, grace window, failure
    threshold, restart budget -- because acting on an aggregate verdict produces a
    restart feedback loop: not ready triggers a restart, which makes it less ready.
    """

    def __call__(self, name: str, *, healthy: bool, instance_id: str) -> None: ...


class SelfHeal(Protocol):
    async def __call__(self, name: str, *, reason: str) -> None: ...


Sleep = Callable[[float], Awaitable[None]]


async def default_probe(url: str, *, expected_service: str = "", expected_instance_id: str = "") -> bool:
    try:
        async with httpx.AsyncClient(timeout=2.0, trust_env=False) as client:
            response = await client.get(url)
        if response.status_code != 200:
            return False
        payload = response.json()
        if not isinstance(payload, dict):
            return False
        if expected_service and payload.get("service") != expected_service:
            return False
        if expected_instance_id and payload.get("instance_id") != expected_instance_id:
            return False
        return payload.get("status") == "ok"
    except (httpx.HTTPError, ValueError):
        return False


class Watchdog:
    def __init__(
        self,
        *,
        registry: ServiceRegistry,
        trigger_self_heal: SelfHeal,
        probe: Probe = default_probe,
        sleep: Sleep = asyncio.sleep,
        monotonic: Callable[[], float] | None = None,
        interval_s: float = 5.0,
        failure_threshold: int = 3,
        record_health: RecordHealth | None = None,
    ) -> None:
        self._registry = registry
        # The restart budget, backoff, and retry-within-budget all live in
        # ProcessManager.trigger_self_heal now (issue #1663); the watchdog only
        # detects sustained probe failure and hands off. This keeps a single
        # budget shared with the crash-exit monitor rather than two competing
        # ones.
        self._trigger_self_heal = trigger_self_heal
        self._probe = probe
        self._sleep = sleep
        self._monotonic = monotonic or time.monotonic
        self._interval_s = interval_s
        self._failure_threshold = failure_threshold
        self._record_health = record_health
        self._running = False
        self._heal_tasks: set[asyncio.Task[None]] = set()

    async def check_once(self) -> None:
        for service in self._registry.all():
            await self._check_service(service)

    async def run(self) -> None:
        self._running = True
        logger.info(
            "watchdog started interval_s={} failure_threshold={}",
            self._interval_s,
            self._failure_threshold,
        )
        while self._running:
            await self.check_once()
            await asyncio.sleep(self._interval_s)
        logger.info("watchdog stopped")

    def stop(self) -> None:
        self._running = False

    async def _check_service(self, service: ServiceInfo) -> None:
        if service.stopping or service.state not in {"running", "error"}:
            return
        if service.watchdog_grace_s > 0:
            elapsed = self._monotonic() - service.started_at_monotonic
            if elapsed < service.watchdog_grace_s:
                return
        url = f"http://127.0.0.1:{service.port}{service.proxy_prefix}/v1/health"
        healthy = await self._probe(
            url,
            expected_service=service.name,
            expected_instance_id=service.instance_id,
        )
        self._publish_health(service, healthy)
        if healthy:
            recovered = service.state == "error"
            if service.failure_count > 0 or recovered:
                logger.info(
                    "watchdog recovered service name={} port={} instance_id={}",
                    service.name,
                    service.port,
                    service.instance_id,
                )
            service.failure_count = 0
            if recovered:
                service.state = "running"
                # Recovery restarts the dwell clock so the budget only resets
                # after a fresh RESTART_STABILITY_S of sustained health.
                service.ready_since = self._monotonic()
            self._maybe_reset_restart_budget(service)
            return

        service.failure_count += 1
        logger.debug(
            "watchdog probe failed service name={} port={} failures={} threshold={}",
            service.name,
            service.port,
            service.failure_count,
            self._failure_threshold,
        )
        if service.failure_count < self._failure_threshold:
            return

        if service.restart_policy == "never":
            service.state = "error"
            logger.error(
                "watchdog leaving service in error state name={} reason=restart_policy_never",
                service.name,
            )
            return

        if service.restart_policy in {"on-failure", "always"}:
            # Reset the accrued failures so the next full threshold is required
            # before another hand-off, then delegate. The budget, backoff, and
            # retry-within-budget all live in trigger_self_heal, which shares one
            # restart_attempts budget with the crash-exit monitor and never
            # raises (issue #1663).
            service.failure_count = 0
            if service.stopping or service.state not in {"running", "error"}:
                return
            task = asyncio.create_task(
                self._trigger_self_heal(
                    service.name,
                    reason="probe_failures",
                ),
                name=f"servicehub.self-heal.{service.name}",
            )
            self._heal_tasks.add(task)
            task.add_done_callback(self._self_heal_done)
            # Let an immediate delegate run for deterministic status/tests, but
            # never await its backoff/readiness loop and block probes for peers.
            await asyncio.sleep(0)

    def _publish_health(self, service: ServiceInfo, healthy: bool) -> None:
        if self._record_health is None:
            return
        try:
            self._record_health(
                service.name, healthy=healthy, instance_id=service.instance_id
            )
        except Exception:
            # Readiness reporting must never break supervision. A failure here
            # leaves the evidence to age out into `evidence_stale`, which blocks
            # `ready` without disturbing the restart path.
            logger.warning(
                "readiness health publish failed service={}", service.name
            )

    def _self_heal_done(self, task: asyncio.Task[None]) -> None:
        self._heal_tasks.discard(task)
        if task.cancelled():
            return
        try:
            task.result()
        except Exception as exc:
            logger.exception(
                "watchdog self-heal task failed error_type={} detail={}",
                type(exc).__name__,
                str(exc),
            )

    def _maybe_reset_restart_budget(self, service: ServiceInfo) -> None:
        """Reset the self-heal budget only after the child has dwelled healthy for
        RESTART_STABILITY_S (startsecs-style gate, issue #1663).

        Reaching "running" is not enough - a child that crashes seconds after
        readiness would otherwise reset the budget every cycle and the N-in-a-row
        cap would never engage. ``ready_since`` is cleared to ``None`` on a crash,
        so a stale timestamp can never satisfy the gate.
        """
        if (
            service.state == "running"
            and service.restart_attempts > 0
            and service.ready_since is not None
            and (self._monotonic() - service.ready_since) >= RESTART_STABILITY_S
        ):
            logger.info(
                "watchdog service stable for >= {:.0f}s; resetting restart budget name={} restarts={}",
                RESTART_STABILITY_S,
                service.name,
                service.restart_attempts,
            )
            service.restart_attempts = 0
