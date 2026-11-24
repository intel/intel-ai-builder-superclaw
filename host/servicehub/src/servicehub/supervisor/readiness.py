"""Health-based readiness checks for ServiceHub-supervised child services."""

from __future__ import annotations

import asyncio
from asyncio.subprocess import Process
from typing import Any

import httpx
from loguru import logger

from servicehub.supervisor.loader import ServiceEntry


class ReadinessError(RuntimeError):
    """Raised when a child process does not become health-ready."""


async def wait_for_healthy(
    process: Process,
    entry: ServiceEntry,
    instance_id: str,
    timeout: float = 15.0,
) -> None:
    loop = asyncio.get_running_loop()
    start = loop.time()
    deadline = start + timeout
    url = f"http://127.0.0.1:{entry.port}{entry.proxy_prefix}/v1/health"
    last_error: str | None = None
    first_probe_logged = False
    async with httpx.AsyncClient(timeout=1.0, trust_env=False) as client:
        while loop.time() < deadline:
            if process.returncode is not None:
                # Diagnostic (ServiceHub exit-code-1 debugging): a child that
                # dies during startup previously raised a bare "exited before
                # health readiness" with no exit code and no pointer to the
                # cause, so the host log showed only `readiness.first_probe`
                # then a silent ServiceHub exit. Include the child exit code and
                # name the raw stderr log file (written by ProcessManager's
                # `_drain_stream` to `<log_dir>/<name>-stderr-<ts>.log`) where
                # the child's own traceback lives — that file, not ServiceHub's
                # own stderr, holds the actual failure reason.
                raise ReadinessError(
                    f"service {entry.name} exited before health readiness "
                    f"(exit_code={process.returncode}); "
                    f"see the child's stderr log '{entry.name}-stderr-*.log' "
                    f"in the ServiceHub log dir for the cause"
                )
            try:
                # Startup-logging unification (2026-07-21 §3.3): record the first
                # probe + total ready time on the SUCCESS path so a slow child is
                # visible in the per-launch ServiceHub log, not only on failure.
                if not first_probe_logged:
                    logger.info(
                        "readiness.first_probe name={} port={}",
                        entry.name,
                        entry.port,
                    )
                    first_probe_logged = True
                response = await client.get(url)
                if response.status_code == 200:
                    payload = response.json()
                    _validate_health_payload(payload, entry, instance_id)
                    logger.info(
                        "readiness.ready name={} port={} elapsed_ms={}",
                        entry.name,
                        entry.port,
                        round((loop.time() - start) * 1000),
                    )
                    return
                last_error = f"HTTP {response.status_code}"
            except (httpx.HTTPError, ValueError, ReadinessError) as exc:
                last_error = str(exc)
            await asyncio.sleep(0.1)
    raise ReadinessError(f"timed out waiting for {entry.name} health readiness: {last_error}")


def _validate_health_payload(payload: Any, entry: ServiceEntry, instance_id: str) -> None:
    if not isinstance(payload, dict):
        raise ReadinessError(f"health payload for {entry.name} must be an object")
    if payload.get("service") != entry.name:
        raise ReadinessError(f"health service mismatch for {entry.name}")
    if payload.get("status") != "ok":
        raise ReadinessError(f"health status for {entry.name} is not ok")
    if payload.get("instance_id") != instance_id:
        raise ReadinessError(f"health instance_id mismatch for {entry.name}")
    if not isinstance(payload.get("pid"), int) or payload["pid"] <= 0:
        raise ReadinessError(f"health pid for {entry.name} must be a positive integer")
