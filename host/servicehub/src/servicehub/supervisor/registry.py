"""In-memory registry of supervised services."""

from __future__ import annotations

from dataclasses import dataclass
import time
from typing import Literal


ServiceState = Literal["starting", "running", "stopped", "error", "restarting"]
RestartPolicy = Literal["never", "on-failure", "always"]


class RegistryError(ValueError):
    """Raised when service registry invariants are violated."""


@dataclass
class ServiceInfo:
    name: str
    proxy_prefix: str
    port: int
    process: object | None
    state: ServiceState
    restart_policy: RestartPolicy
    failure_count: int
    shutdown_grace_s: float
    instance_id: str = ""
    restart_attempts: int = 0
    stopping: bool = False
    started_at_monotonic: float = 0.0
    watchdog_grace_s: float = 0.0
    # Monotonic time the child last reached the healthy "running" state, used by
    # the watchdog's startsecs-style dwell gate to reset the restart budget only
    # after the child has stayed healthy for RESTART_STABILITY_S. ``None`` means
    # "not yet healthy" or "dwell invalidated by a crash", so the budget must NOT
    # be reset.
    ready_since: float | None = None

    def __post_init__(self) -> None:
        if self.started_at_monotonic <= 0:
            self.started_at_monotonic = time.monotonic()


class ServiceRegistry:
    def __init__(self) -> None:
        self._by_name: dict[str, ServiceInfo] = {}
        self._by_prefix: dict[str, ServiceInfo] = {}
        self._order: list[str] = []

    def register(self, service: ServiceInfo) -> None:
        if service.name in self._by_name:
            raise RegistryError(f"duplicate service name: {service.name}")
        if service.proxy_prefix in self._by_prefix:
            raise RegistryError(f"duplicate proxy_prefix: {service.proxy_prefix}")
        self._by_name[service.name] = service
        self._by_prefix[service.proxy_prefix] = service
        self._order.append(service.name)

    def get(self, name: str) -> ServiceInfo | None:
        return self._by_name.get(name)

    def get_by_prefix(self, proxy_prefix: str) -> ServiceInfo | None:
        return self._by_prefix.get(proxy_prefix)

    def all(self) -> list[ServiceInfo]:
        return [self._by_name[name] for name in self._order]

    def remove(self, name: str) -> None:
        service = self._by_name.pop(name, None)
        if service is None:
            return
        self._by_prefix.pop(service.proxy_prefix, None)
        self._order = [existing for existing in self._order if existing != name]

    def clear(self) -> None:
        self._by_name.clear()
        self._by_prefix.clear()
        self._order.clear()
