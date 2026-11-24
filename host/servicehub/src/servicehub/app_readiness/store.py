"""The single readiness evidence snapshot ServiceHub serves and supervises from.

Two kinds of writer feed it and neither can read the aggregate:

    record_child_health()      the watchdog, every probe cycle
    record_runtime_evidence()  the background refresher, from SandboxManager

Write-only by construction. This is the structural half of the rule that
supervision must never act on the aggregate App state -- the watchdog is handed a
recorder, not the store -- so `state != "ready" -> restart everything` is not
something a future edit can reach for. That feedback loop (restart -> less ready
-> restart) is the failure mode this design exists to avoid.

Freshness uses a monotonic clock: a wall-clock step (NTP, DST, resume from sleep)
would otherwise make healthy evidence look stale or stale evidence look fresh.
Wall-clock timestamps are recorded only for reporting.

Missing evidence is never promoted to `ready`.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from servicehub.app_readiness.model import (
    CONTRACT_VERSION,
    ComponentReadiness,
    ComponentState,
    ReasonCode,
    Startup,
    aggregate,
    retry_after_ms,
)


# Four missed watchdog cycles (5s each) before host evidence is stale. Long enough
# that one slow probe does not flap the projection, short enough that a wedged
# child does not keep reporting ready for a minute.
EVIDENCE_TTL_S = 20.0
SANDBOX_MANAGER_SERVICE = "sandbox_manager"

# One watchdog interval plus margin. Added to a child's grace window to work out
# when its first probe is actually due, so spawn evidence is not expired while the
# watchdog is still deliberately silent.
_WATCHDOG_PROBE_ALLOWANCE_S = 15.0

# Runtime component names, in dependency order. Fixed here rather than trusted from
# the child so a malformed payload cannot silently shrink the required set and make
# the App look ready.
RUNTIME_COMPONENTS: tuple[str, ...] = (
    "sandbox_container",
    "profile_application",
    "openwork_server",
    "opencode_engine",
)

_VALID_RUNTIME_STATES: tuple[ComponentState, ...] = ("ready", "starting", "failed", "unknown")

# Listed explicitly and typed, rather than derived via `get_args`, so narrowing a
# child-supplied string stays type-checked instead of laundering it through `Any`.
_VALID_REASON_CODES: tuple[ReasonCode, ...] = (
    "unreachable",
    "identity_mismatch",
    "probe_timeout",
    "probe_pending",
    "start_failed",
    "not_running",
    "native_hdr_restart_budget_exhausted",
    "profile_revision_mismatch",
    "evidence_stale",
    "evidence_unavailable",
)


@dataclass(frozen=True)
class _HealthEvidence:
    healthy: bool
    instance_id: str
    observed_monotonic: float
    observed_at: datetime


@dataclass(frozen=True)
class _RuntimeEvidence:
    components: tuple[ComponentReadiness, ...]
    observed_monotonic: float
    source_instance_id: str | None


class ReadinessStore:
    def __init__(
        self,
        *,
        process_manager: Any,
        monotonic: Callable[[], float] = time.monotonic,
        now: Callable[[], datetime] | None = None,
        ttl_s: float = EVIDENCE_TTL_S,
    ) -> None:
        self._process_manager = process_manager
        self._monotonic = monotonic
        self._now = now or (lambda: datetime.now(timezone.utc))
        self._ttl_s = ttl_s
        self._health: dict[str, _HealthEvidence] = {}
        self._runtime: _RuntimeEvidence | None = None
        self._transitions: dict[str, tuple[str, datetime]] = {}

    # ------------------------------------------------------------------- writers

    def record_child_health(self, name: str, *, healthy: bool, instance_id: str) -> None:
        """Record one child health observation. Write-only; returns nothing to act on."""
        self._health[name] = _HealthEvidence(
            healthy=healthy,
            instance_id=instance_id,
            observed_monotonic=self._monotonic(),
            observed_at=self._now(),
        )

    def record_runtime_evidence(
        self,
        payload: Any,
        *,
        source_instance_id: str | None = None,
    ) -> None:
        """Record SandboxManager's runtime evidence.

        A malformed or unreachable child leaves the previous evidence to age out
        into `evidence_stale` rather than being overwritten with a fabricated
        verdict.
        """
        components = _parse_runtime_payload(payload, observed_at=self._now())
        if components is None:
            return
        self._runtime = _RuntimeEvidence(
            components=components,
            observed_monotonic=self._monotonic(),
            source_instance_id=source_instance_id,
        )

    # ---------------------------------------------------------------- projection

    def app_projection(self) -> dict[str, object]:
        """Build the wire document. Pure read of the snapshot; performs no I/O."""
        components = self._components()
        state = aggregate(components)
        return {
            "contract_version": CONTRACT_VERSION,
            "state": state,
            "retry_after_ms": retry_after_ms(state),
            "components": [component.as_wire() for component in components],
            "observed_at": self._now().isoformat(),
        }

    def _components(self) -> list[ComponentReadiness]:
        return [*self._host_components(), *self._runtime_components()]

    # -------------------------------------------------------------- host services

    def _host_components(self) -> list[ComponentReadiness]:
        components: list[ComponentReadiness] = []
        for entry in self._catalog():
            name = entry.get("name")
            if not isinstance(name, str):
                continue
            startup: Startup = "on_demand" if entry.get("startup") == "on_demand" else "required"
            state, reason, instance_id, observed_at = self._host_state(
                name, str(entry.get("state") or ""), startup
            )
            components.append(
                ComponentReadiness(
                    name=name,
                    kind="host_service",
                    startup=startup,
                    state=state,
                    instance_id=instance_id,
                    reason_code=reason,
                    observed_at=observed_at,
                    last_transition_at=self._transition(name, state),
                )
            )
        return components

    def _catalog(self) -> list[dict[str, Any]]:
        try:
            catalog = self._process_manager.service_catalog()
        except Exception:
            return []
        return catalog if isinstance(catalog, list) else []

    def _host_state(
        self, name: str, process_state: str, startup: Startup
    ) -> tuple[ComponentState, ReasonCode | None, str | None, datetime | None]:
        """Map process lifecycle plus health evidence onto a readiness state.

        `running` alone is never `ready`. A live process that no longer answers its
        health contract is the precise case the product currently mistakes for
        health, so readiness requires positive, fresh, identity-matched evidence.
        """
        if process_state == "dormant":
            return "dormant", None, None, None
        if process_state == "error":
            return "failed", "unreachable", self._registry_instance(name), None
        if process_state in {"starting", "stopped"}:
            return "starting", "probe_pending", None, None
        if process_state != "running":
            return "unknown", "evidence_stale", None, None

        evidence = self._health.get(name)
        if evidence is None:
            return "unknown", "evidence_stale", self._registry_instance(name), None
        if self._is_stale(name, evidence):
            return "unknown", "evidence_stale", evidence.instance_id, evidence.observed_at

        expected = self._registry_instance(name)
        if expected is not None and evidence.instance_id != expected:
            # Evidence describes a previous incarnation; a restart happened between
            # the probe and now, so it proves nothing about the current process.
            return "failed", "identity_mismatch", expected, evidence.observed_at
        if not evidence.healthy:
            return "failed", "unreachable", evidence.instance_id, evidence.observed_at
        return "ready", None, evidence.instance_id, evidence.observed_at

    def _is_stale(self, name: str, evidence: _HealthEvidence) -> bool:
        """Whether evidence has aged out, accounting for the watchdog's grace window.

        The watchdog does not probe a child until `watchdog_grace_s` (its
        `ready_timeout_s`, 30s-120s) has elapsed since spawn. Inside that window the
        spawn-barrier evidence is the freshest evidence that can exist, so expiring
        it would report `unknown` for a child that is demonstrably healthy -- which
        is what a real boot did, with `sandbox_manager` (grace 30s) reading `ready`
        while `llmrouter_manager` (60s) and `privacy_manager` (90s) read `unknown`.

        Once a probe is due the ordinary TTL applies, so this is a bounded allowance
        during startup rather than a permanent exemption.
        """
        now = self._monotonic()
        if now - evidence.observed_monotonic <= self._ttl_s:
            return False
        service = self._registry_service(name)
        grace_s = getattr(service, "watchdog_grace_s", 0.0) or 0.0
        started_at = getattr(service, "started_at_monotonic", None)
        if not isinstance(started_at, (int, float)) or grace_s <= 0:
            return True
        probe_due_at = started_at + grace_s + _WATCHDOG_PROBE_ALLOWANCE_S
        return now > probe_due_at

    def _registry_service(self, name: str) -> Any:
        try:
            return self._process_manager.registry.get(name)
        except Exception:
            return None

    def _registry_instance(self, name: str) -> str | None:
        service = self._registry_service(name)
        instance_id = getattr(service, "instance_id", None)
        return instance_id if isinstance(instance_id, str) and instance_id else None

    # -------------------------------------------------------------------- runtime

    def _runtime_components(self) -> list[ComponentReadiness]:
        evidence = self._runtime
        stale = (
            evidence is None
            or self._monotonic() - evidence.observed_monotonic > self._ttl_s
        )
        expected_source = self._registry_instance(SANDBOX_MANAGER_SERVICE)
        identity_mismatch = (
            evidence is not None
            and evidence.source_instance_id is not None
            and expected_source is not None
            and evidence.source_instance_id != expected_source
        )
        if stale or identity_mismatch:
            return [
                ComponentReadiness(
                    name=name,
                    kind="runtime",
                    startup="required",
                    state="failed" if identity_mismatch else "unknown",
                    instance_id=expected_source if identity_mismatch else None,
                    reason_code="identity_mismatch" if identity_mismatch else "evidence_stale",
                    last_transition_at=self._transition(name, "unknown"),
                )
                for name in RUNTIME_COMPONENTS
            ]
        assert evidence is not None
        return [
            ComponentReadiness(
                name=component.name,
                kind=component.kind,
                startup=component.startup,
                state=component.state,
                instance_id=component.instance_id,
                reason_code=component.reason_code,
                observed_at=component.observed_at,
                last_transition_at=self._transition(component.name, component.state),
                applied_revision=component.applied_revision,
                active_revision=component.active_revision,
            )
            for component in evidence.components
        ]

    # ----------------------------------------------------------------- transitions

    def _transition(self, name: str, state: str) -> datetime:
        """When this component last changed state.

        Startup timing is deliberately not a contract here -- Tauri and ServiceHub
        share no clock, and one Hub can outlive several App launches -- but "stuck
        in `starting` since 10 minutes ago" is the single most useful support signal,
        and it costs one dict entry.
        """
        previous = self._transitions.get(name)
        if previous is None or previous[0] != state:
            changed_at = self._now()
            self._transitions[name] = (state, changed_at)
            return changed_at
        return previous[1]


def _parse_runtime_payload(
    payload: Any, *, observed_at: datetime
) -> tuple[ComponentReadiness, ...] | None:
    """Validate the child payload into the fixed required set, or reject it entirely.

    Rejecting is safer than partially trusting: a payload missing `opencode_engine`
    would otherwise silently drop a required component and let the App aggregate to
    `ready` on three quarters of the evidence.
    """
    if not isinstance(payload, dict):
        return None
    raw = payload.get("components")
    if not isinstance(raw, list):
        return None

    by_name: dict[str, dict[str, Any]] = {}
    for item in raw:
        if isinstance(item, dict) and isinstance(item.get("name"), str):
            by_name[item["name"]] = item
    if not set(RUNTIME_COMPONENTS).issubset(by_name):
        return None

    components: list[ComponentReadiness] = []
    for name in RUNTIME_COMPONENTS:
        item = by_name[name]
        state = _runtime_state(item.get("state"))
        if state is None:
            return None
        components.append(
            ComponentReadiness(
                name=name,
                kind="runtime",
                startup="required",
                state=state,
                instance_id=_opt_str(item.get("instance_id")),
                reason_code=_opt_reason(item.get("reason_code")),
                observed_at=observed_at,
                applied_revision=_opt_int(item.get("applied_revision")),
                active_revision=_opt_int(item.get("active_revision")),
            )
        )
    return tuple(components)


def _opt_str(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _opt_int(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _runtime_state(value: Any) -> ComponentState | None:
    return next((state for state in _VALID_RUNTIME_STATES if state == value), None)


def _opt_reason(value: Any) -> ReasonCode | None:
    return next((code for code in _VALID_REASON_CODES if code == value), None)
