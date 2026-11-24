"""Continuous HDR supervision, fenced generation restart and durable cleanup intent.

Sandbox Manager is the only owner of the native HDR role (PR3 #2662). Without this module it
noticed an HDR exit only when a caller polled ``status()``. This module watches the live ``pro``
generation and, when HDR exits or sustainedly loses authenticated readiness, *fences* it:

1. Runtime evidence stops reporting ready: the deployment adapter's ``finished`` is cleared,
   so evidence reads ``applying`` until a new generation is proven, and the HDR observation is
   detached.
2. The HDR API and readiness tokens are dropped.
3. A durable cleanup intent is persisted before anything is stopped (``_stop_broker_roles``).
4. Every role stops in reverse order; the intent is cleared only after each launcher confirms
   its Job drained.
5. The whole role set restarts through the deployment adapter under a new
   ``runtime_instance_id``, new launch identities and fresh tokens. Tokens still travel only as
   broker catalog launch scalars; nothing here carries a credential.

Restarts are bounded by :class:`RestartBudget`. When it is spent the state is
``recovery_required`` and nothing restarts until an explicit ``control("start"|"restart")``.

Serialisation: a fence runs under the deployment adapter's lock, the same lock ``ensure``,
``stop``, ``revoke`` and ``resume`` take, and the restart is an ordinary adapter run, so
``ensure`` joins it and ``stop``/``revoke`` abort it through ``_startup_abort``. The Supervisor
role stays observe-only (it refuses to restart an external HDR) and ServiceHub only reads
readiness, so there is no second restarter.

The cleanup intent lives in Sandbox Manager's own SQLite store (``<DATA_DIR>\\sbms.db``, by
default ``%LOCALAPPDATA%\\SuperClaw\\sandbox_manager``). No isolation tier is granted any access
to that directory - tier ACLs cover only the ``config``/``data``/``logs`` subtrees of
``%LOCALAPPDATA%\\SuperClaw\\backend`` - so a tier can neither forge nor erase an intent.

Logs carry only generation, role, PID, exit code, counts and durations.
"""

from __future__ import annotations

import asyncio
import ctypes
import json
import os
import socket
import sqlite3
import time
from collections import deque
from collections.abc import Callable
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal

import httpx
from loguru import logger

from .native_runtime_evidence import deployment_snapshot, fingerprint
from .store import RUNTIME_DEPLOYMENT_CONFIG_KEY

if TYPE_CHECKING:
    from .native_backend import NativeBackendLifecycle

# An exit is noticed within one tick; the fence begins on the same tick.
WATCH_INTERVAL_S = 0.5
# Authenticated readiness is probed on its own cadence. Only a probe that cannot prove HDR
# itself is alive counts as loss: 503 means HDR answered and is waiting on LRM/Connector, which a
# restart would not fix.
PROBE_INTERVAL_S = 5.0
# Each /readyz checks Connector and LRM. A healthy observation this fresh, bound to the current
# HDR context (made for status/evidence, e.g. ServiceHub's 5 s refresh), stands in for a probe.
PROVEN_FRESH_S = 10.0
READINESS_LOSS_S = 30.0
READINESS_LOSS_PROBES = 3
HDR_PROBE_TIMEOUT_S = 10.0
RESTART_BUDGET = 3
RESTART_WINDOW_S = 900.0
# After a Sandbox Manager crash the orphaned launchers see stdin close and drain their Jobs.
CLEANUP_WAIT_S = 10.0
CLEANUP_POLL_S = 0.25
CLEANUP_INTENT_CONFIG_KEY = "native_backend_cleanup_intent"

_CONNECTOR_FILE_NAMES = frozenset({"connector-client.json", "connector-provider.json"})
_PORT_FIELDS = (
    "_port",
    "_runtime_port",
    "_router_health_port",
    "_hdr_port",
    "_connector_port",
    "_egress_proxy_shell_port",
    "_egress_proxy_channel_port",
)
_CLEANUP_UNCONFIRMED = (
    "native backend cleanup unconfirmed reason=cleanup_intent_outstanding recovery=retry_start"
)
_RECOVERING = {
    "phase": "starting", "mode": "native",
    "message": "native HDR generation restarting; recovery=in_progress",
}
_RECOVERY_REQUIRED = {
    "phase": "error", "mode": "native",
    "message": "native HDR restart budget exhausted; recovery=recovery_required",
}
_RECOVERY_REQUIRED_EVIDENCE = {
    "code": "native_runtime_unavailable",
    "message": "Native HDR restart budget is exhausted; recovery_required.",
}

Liveness = Literal["ready", "dependency_wait", "lost"]
NativeRecoveryReason = Literal["native_hdr_restart_budget_exhausted"]


class RestartBudget:
    """At most ``limit`` restarts in any ``window_s`` seconds."""

    def __init__(self, *, limit: int, window_s: float,
                 clock: Callable[[], float] = time.monotonic) -> None:
        self._limit = limit
        self._window_s = window_s
        self._clock = clock
        self._spent: deque[float] = deque()

    @property
    def used(self) -> int:
        return len(self._spent)

    @property
    def limit(self) -> int:
        return self._limit

    @property
    def window_s(self) -> float:
        return self._window_s

    def try_consume(self) -> bool:
        now = self._clock()
        while self._spent and now - self._spent[0] >= self._window_s:
            self._spent.popleft()
        if len(self._spent) >= self._limit:
            return False
        self._spent.append(now)
        return True

    def reset(self) -> None:
        self._spent.clear()


async def probe_hdr_liveness(port: int | None, token: str | None) -> Liveness:
    """Classify one authenticated ``/readyz`` read; the body is bounded before parsing."""
    if port is None or token is None:
        return "lost"
    try:
        async with asyncio.timeout(HDR_PROBE_TIMEOUT_S):
            async with httpx.AsyncClient(trust_env=False, timeout=HDR_PROBE_TIMEOUT_S) as client:
                async with client.stream(
                    "GET", f"http://127.0.0.1:{port}/readyz",
                    headers={"Authorization": f"Bearer {token}"},
                ) as response:
                    if response.status_code == 503:
                        return "dependency_wait"
                    if response.status_code != 200:
                        return "lost"
                    body = bytearray()
                    async for chunk in response.aiter_raw():
                        body.extend(chunk)
                        if len(body) > 4096:
                            return "lost"
        ready = json.loads(bytes(body)) == {"status": "ready", "mode": "native_managed"}
    except (TimeoutError, httpx.HTTPError, ValueError, RecursionError):
        return "lost"
    return "ready" if ready else "lost"


def _process_running(pid: int) -> bool | None:
    """Whether ``pid`` still runs; ``None`` when this account may not observe it."""
    if os.name != "nt":
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            return None
        return True
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)  # type: ignore[attr-defined]
    synchronize, query_limited, invalid_parameter, wait_timeout = 0x00100000, 0x1000, 87, 0x102
    handle = k32.OpenProcess(synchronize | query_limited, False, pid)
    if not handle:
        return False if ctypes.get_last_error() == invalid_parameter else None  # type: ignore[attr-defined]
    try:
        return k32.WaitForSingleObject(handle, 0) == wait_timeout
    finally:
        k32.CloseHandle(handle)


def _port_listening(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.2):
            return True
    except OSError:
        return False


class NativeSupervision:
    def __init__(self, lifecycle: NativeBackendLifecycle) -> None:
        self._owner = lifecycle
        self.budget = RestartBudget(limit=RESTART_BUDGET, window_s=RESTART_WINDOW_S)
        self._state: Literal["recovering", "recovery_required"] | None = None
        self._state_context: dict[str, str] | None = None
        self._watch_task: asyncio.Task[None] | None = None
        self._watch_context: dict[str, str] | None = None
        self._recovery_task: asyncio.Task[None] | None = None

    # ------------------------------------------------------------ cleanup intent

    def record_cleanup_intent(self) -> bool:
        """Persist what a stop must drain before the stop touches anything."""
        owner = self._owner
        from .native_backend import _BROKER_ROLE_FIELDS

        roles = [
            {"role": role, "pid": launch.pid}
            for role, field in _BROKER_ROLE_FIELDS
            if (launch := getattr(owner, field)) is not None and isinstance(launch.pid, int)
        ]
        if not roles:
            return False
        context = owner._runtime_launch_context or {}
        intent = {
            "schema_version": 1,
            "runtime_instance_id": context.get("runtime_instance_id"),
            "roles": roles,
            "ports": sorted({
                port for field in _PORT_FIELDS
                # lite/standard launch no HDR: its port is an unprobed placeholder, not a listener.
                if (field != "_hdr_port" or owner._hdr_proc is not None)
                and isinstance(port := getattr(owner, field), int)
            }),
            "connector_files": [
                str(path) for path in (
                    owner._connector_client_config_path, owner._connector_provider_config_path,
                ) if path is not None
            ],
        }
        try:
            owner._store.set_config(CLEANUP_INTENT_CONFIG_KEY, intent)
        except (sqlite3.Error, OSError) as exc:
            # A live generation is worse than an unrecorded one: stop anyway.
            logger.error(
                "native-supervision: phase=intent event=persist_failed generation={} "
                "exception_type={}", intent["runtime_instance_id"], type(exc).__name__,
            )
            return False
        logger.info(
            "native-supervision: phase=intent event=recorded generation={} roles={}",
            intent["runtime_instance_id"], len(roles),
        )
        return True

    def clear_cleanup_intent(self) -> None:
        try:
            self._owner._store.delete_config(CLEANUP_INTENT_CONFIG_KEY)
        except (sqlite3.Error, OSError) as exc:
            # The next start completes a stale intent observationally; the drain already happened.
            logger.error(
                "native-supervision: phase=intent event=clear_failed exception_type={}",
                type(exc).__name__,
            )

    def complete_outstanding_cleanup(self) -> None:
        """Finish an intent a previous Sandbox Manager process could not; raise if unproven.

        This process's own handles are authoritative when it has any: ``_stop_broker_roles``
        clears the intent after Job-drain proof. Otherwise the proof is observational - every
        recorded role PID gone (where this account may observe it) and no listener left on any
        recorded loopback port.
        """
        owner = self._owner
        intent = owner._store.get_config(CLEANUP_INTENT_CONFIG_KEY)
        if intent is None or owner._has_broker_roles():
            return
        record = intent if isinstance(intent, dict) else {}
        generation = record.get("runtime_instance_id")
        pids = [
            item["pid"] for item in record.get("roles", ())
            if isinstance(item, dict) and isinstance(item.get("pid"), int)
        ]
        ports = [port for port in record.get("ports", ()) if isinstance(port, int)]
        started = time.monotonic()
        for name in record.get("connector_files", ()):
            path = Path(name) if isinstance(name, str) else None
            if path is not None and path.name in _CONNECTOR_FILE_NAMES:
                try:
                    path.unlink(missing_ok=True)
                except OSError as exc:
                    logger.warning(
                        "native-supervision: phase=complete event=file_revoke_failed "
                        "generation={} exception_type={}", generation, type(exc).__name__,
                    )
        owner._remove_connector_config_files()
        deadline = started + CLEANUP_WAIT_S
        while True:
            alive = [pid for pid in pids if _process_running(pid) is True]
            listening = [port for port in ports if _port_listening(port)]
            if not alive and not listening:
                break
            if time.monotonic() >= deadline:
                logger.error(
                    "native-supervision: phase=complete event=unconfirmed generation={} "
                    "roles_alive={} listeners={} duration_ms={}",
                    generation, len(alive), len(listening),
                    round((time.monotonic() - started) * 1000),
                )
                owner._payload_status_message = _CLEANUP_UNCONFIRMED
                owner._payload_integrity_failed = True
                raise RuntimeError(_CLEANUP_UNCONFIRMED)
            time.sleep(CLEANUP_POLL_S)
        self.clear_cleanup_intent()
        if owner._payload_status_message == _CLEANUP_UNCONFIRMED:
            owner._payload_status_message = None
            owner._payload_integrity_failed = False
        logger.info(
            "native-supervision: phase=complete event=confirmed generation={} roles={} "
            "duration_ms={}", generation, len(pids), round((time.monotonic() - started) * 1000),
        )

    # ------------------------------------------------------------- projection

    def status_override(self) -> dict[str, Any] | None:
        adapter = self._owner._deployment_adapter
        if self._state == "recovering" and not adapter.finished.is_set():
            return dict(_RECOVERING)
        if self._recovery_required(adapter):
            return dict(_RECOVERY_REQUIRED)
        return None

    def evidence_error(self) -> dict[str, str] | None:
        if self._recovery_required(self._owner._deployment_adapter):
            return dict(_RECOVERY_REQUIRED_EVIDENCE)
        return None

    def recovery_reason(self) -> NativeRecoveryReason | None:
        if self._recovery_required(self._owner._deployment_adapter):
            return "native_hdr_restart_budget_exhausted"
        return None

    def _recovery_required(self, adapter: Any) -> bool:
        return (self._state == "recovery_required" and adapter.failed
                and adapter.context == self._state_context)

    def reset(self) -> None:
        """An explicit start/restart leaves ``recovery_required`` with a fresh budget."""
        self.budget.reset()
        self._state = None
        self._state_context = None

    # -------------------------------------------------------------- supervision

    def watch(self, context: dict[str, str]) -> None:
        """Supervise the generation that ``context`` just proved ready; ``pro`` only."""
        owner = self._owner
        if "hdr-sidecar" not in owner._required_sidecars:
            return
        if (self._watch_task is not None and not self._watch_task.done()
                and self._watch_context == context):
            return
        if self._watch_task is not None:
            self._watch_task.cancel()
        self._state = None
        self._state_context = None
        self._watch_context = dict(context)
        self._watch_task = asyncio.get_running_loop().create_task(
            self._watch(dict(context)), name="native.hdr.supervision",
        )
        logger.info(
            "native-supervision: phase=watch event=begin generation={} role=hdr_sidecar role_pid={}",
            context["runtime_instance_id"], getattr(owner._hdr_proc, "pid", None),
        )

    async def aclose(self) -> None:
        for task in (self._watch_task, self._recovery_task):
            if task is not None and not task.done():
                task.cancel()
        await asyncio.gather(
            *(task for task in (self._watch_task, self._recovery_task) if task is not None),
            return_exceptions=True,
        )

    def _watching(self, context: dict[str, str]) -> bool:
        owner = self._owner
        adapter = owner._deployment_adapter
        return (adapter.context == context and adapter.finished.is_set() and not adapter.failed
                and owner._runtime_launch_context == context
                and "hdr-sidecar" in owner._required_sidecars
                and not owner._startup_abort.is_set() and not owner._shutdown_requested.is_set())

    async def _watch(self, context: dict[str, str]) -> None:
        owner = self._owner
        lost_since: float | None = None
        lost_probes = 0
        next_probe = time.monotonic() + PROBE_INTERVAL_S
        while True:
            await asyncio.sleep(WATCH_INTERVAL_S)
            if owner._deployment_adapter.context != context or owner._shutdown_requested.is_set():
                return
            if not self._watching(context):
                if owner._deployment_adapter.finished.is_set():
                    return
                continue
            launch = owner._hdr_proc
            code = None if launch is None else launch.poll()
            if launch is None or code is not None:
                self._start_recovery(context, "hdr_exited", getattr(launch, "pid", None), code)
                return
            if time.monotonic() < next_probe:
                continue
            liveness = ("ready" if self._recently_proven() else
                        await probe_hdr_liveness(owner._hdr_port, owner._hdr_ready_token))
            now = time.monotonic()
            next_probe = now + PROBE_INTERVAL_S
            if liveness == "ready" and owner._deployment_adapter.context == context:
                # A recovery seen here ends the evidence miss window too (#3658).
                owner._deployment_adapter.hdr_ready_again()
            if liveness != "lost":
                lost_since, lost_probes = None, 0
                continue
            lost_since = now if lost_since is None else lost_since
            lost_probes += 1
            if (lost_probes >= READINESS_LOSS_PROBES and now - lost_since >= READINESS_LOSS_S
                    and self._watching(context)):
                self._start_recovery(context, "hdr_readiness_lost", launch.pid, None)
                return

    def _recently_proven(self) -> bool:
        owner = self._owner
        observation = owner._hdr_health_observation
        return (observation is not None and observation[2] is True
                and observation[0] == owner._hdr_health_context()
                and time.monotonic() - observation[1] < PROVEN_FRESH_S)

    def _start_recovery(self, context: dict[str, str], reason: str,
                        role_pid: int | None, exit_code: int | None) -> None:
        if self._recovery_task is not None and not self._recovery_task.done():
            return
        logger.warning(
            "native-supervision: phase=detect event={} generation={} role=hdr_sidecar "
            "role_pid={} exit_code={}", reason, context["runtime_instance_id"], role_pid, exit_code,
        )
        self._recovery_task = asyncio.get_running_loop().create_task(
            self._recover(context, reason), name="native.hdr.recovery",
        )
        self._recovery_task.add_done_callback(self._drain_recovery_task)

    def _drain_recovery_task(self, task: asyncio.Task[None]) -> None:
        if not task.cancelled() and task.exception() is not None:
            logger.error(
                "native-supervision: phase=recover event=failed exception_type={}",
                type(task.exception()).__name__,
            )

    async def _recover(self, context: dict[str, str], reason: str) -> None:
        owner = self._owner
        adapter = owner._deployment_adapter
        retry = False
        while True:
            next_context = await self._fence(context, reason, retry=retry)
            if next_context is None:
                return
            await adapter.finished.wait()
            if not adapter.failed and adapter.context == next_context:
                return
            if (adapter.context != next_context
                    or owner._startup_abort.is_set() or owner._shutdown_requested.is_set()):
                self._state = None
                return
            context, reason, retry = next_context, "restart_failed", True

    def _fence_allowed(self, context: dict[str, str], *, retry: bool) -> bool:
        owner = self._owner
        adapter = owner._deployment_adapter
        if (adapter.context != context or not adapter.finished.is_set()
                or adapter.deployment is None
                or owner._startup_abort.is_set() or owner._shutdown_requested.is_set()):
            return False
        if not retry and (adapter.failed or owner._runtime_launch_context != context):
            return False
        try:
            current = deployment_snapshot(owner._store.get_config(RUNTIME_DEPLOYMENT_CONFIG_KEY))
        except RuntimeError:
            return False
        return fingerprint(current) == context["runtime_desired_fingerprint"]

    async def _fence(self, context: dict[str, str], reason: str, *,
                     retry: bool) -> dict[str, str] | None:
        """Fence and drain ``context``, then schedule its replacement; ``None`` when not."""
        owner = self._owner
        adapter = owner._deployment_adapter
        async with adapter.lock:
            if not self._fence_allowed(context, retry=retry):
                logger.info(
                    "native-supervision: phase=fence event=superseded generation={} reason={}",
                    context["runtime_instance_id"], reason,
                )
                return None
            generation = context["runtime_instance_id"]
            started = time.monotonic()
            logger.warning(
                "native-supervision: phase=fence event=begin generation={} reason={} "
                "restarts_used={} restart_budget={}", generation, reason, self.budget.used,
                self.budget.limit,
            )
            self._state, self._state_context = "recovering", context
            adapter.finished.clear()
            scheduled: dict[str, str] | None = None
            try:
                owner._detach_hdr_status_task()
                owner._hdr_api_token = None
                owner._hdr_ready_token = None
                await owner._owt.clear()
                try:
                    async with owner._lock:
                        await asyncio.to_thread(owner._kill_tree, clear_status=True)
                except RuntimeError:
                    adapter.failed = True
                    self._state = None
                    logger.error(
                        "native-supervision: phase=drain event=unconfirmed generation={} "
                        "duration_ms={}", generation, round((time.monotonic() - started) * 1000),
                    )
                    return None
                logger.info(
                    "native-supervision: phase=drain event=confirmed generation={} duration_ms={}",
                    generation, round((time.monotonic() - started) * 1000),
                )
                if owner._startup_abort.is_set() or owner._shutdown_requested.is_set():
                    adapter.failed = True
                    self._state = None
                    logger.info(
                        "native-supervision: phase=restart event=superseded_by_stop generation={}",
                        generation,
                    )
                    return None
                if not self.budget.try_consume():
                    adapter.failed = True
                    self._state = "recovery_required"
                    logger.error(
                        "native-supervision: phase=restart event=budget_exhausted generation={} "
                        "restart_budget={} window_s={:.0f}", generation, self.budget.limit,
                        self.budget.window_s,
                    )
                    return None
                assert adapter.deployment is not None  # checked by _fence_allowed under this lock
                next_context = owner._runtime_launch_context_scalars(adapter.deployment)
                await adapter.schedule(adapter.deployment, next_context)
                scheduled = next_context
                self._state_context = next_context
                logger.warning(
                    "native-supervision: phase=restart event=scheduled generation={} "
                    "new_generation={} attempt={} restart_budget={} duration_ms={}",
                    generation, next_context["runtime_instance_id"], self.budget.used,
                    self.budget.limit, round((time.monotonic() - started) * 1000),
                )
                return next_context
            finally:
                if scheduled is None:
                    adapter.finished.set()
