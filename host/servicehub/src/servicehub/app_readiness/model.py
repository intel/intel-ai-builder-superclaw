"""App readiness domain types and aggregation (SVC-04).

Pure: no I/O, no clocks, no framework. The wire shape lives in
`shared/contracts/src/capability/app-readiness.ts` and is validated on the way
out by the generated `contracts.app_readiness.AppReadiness`; this module is the
internal vocabulary ServiceHub reasons in.

Named `app_readiness` rather than `readiness` because
`servicehub/supervisor/readiness.py` already owns a different question — whether a
freshly spawned child passed its startup health probe. That is per-child startup
readiness; this is the product-level projection across all of them.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Literal


ComponentState = Literal["ready", "starting", "failed", "unknown", "dormant"]
AppState = Literal["ready", "starting", "failed", "unknown"]
Startup = Literal["required", "on_demand"]
ComponentKind = Literal["host_service", "runtime"]
ReasonCode = Literal[
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
]

CONTRACT_VERSION = 1

# Suggested consumer backoff while not ready. Advisory: the endpoint is a cheap
# snapshot read, and this only exists so every consumer does not invent its own
# poll cadence the way the current callers do.
RETRY_AFTER_MS = 2000


@dataclass(frozen=True)
class ComponentReadiness:
    name: str
    kind: ComponentKind
    startup: Startup
    state: ComponentState
    instance_id: str | None = None
    reason_code: ReasonCode | None = None
    observed_at: datetime | None = None
    last_transition_at: datetime | None = None
    applied_revision: int | None = None
    active_revision: int | None = None

    def as_wire(self) -> dict[str, object]:
        return {
            "name": self.name,
            "kind": self.kind,
            "startup": self.startup,
            "state": self.state,
            "instance_id": self.instance_id,
            "reason_code": self.reason_code,
            "observed_at": _iso(self.observed_at),
            "last_transition_at": _iso(self.last_transition_at),
            "applied_revision": self.applied_revision,
            "active_revision": self.active_revision,
        }


def aggregate(components: list[ComponentReadiness]) -> AppState:
    """Collapse component evidence into the one top-level value.

    Precedence is `failed > unknown > starting > ready`, evaluated over
    `startup: "required"` components only, so a dormant or broken on-demand
    feature can never gate the product.

    Two fail-closed cases deliberately return `unknown` rather than `ready`:
    an empty required set (no declarations loaded, so there is nothing to assert
    readiness *about*), and a required component reporting `dormant` (which is
    illegal for a required service and means the snapshot is inconsistent).
    Reporting `ready` in either case is the exact defect this endpoint replaces.
    """
    required = [component for component in components if component.startup == "required"]
    if not required:
        return "unknown"

    states = {component.state for component in required}
    if "failed" in states:
        return "failed"
    if "unknown" in states:
        return "unknown"
    if "starting" in states:
        return "starting"
    if states == {"ready"}:
        return "ready"
    return "unknown"


def retry_after_ms(state: AppState) -> int | None:
    return None if state == "ready" else RETRY_AFTER_MS


def _iso(value: datetime | None) -> str | None:
    return None if value is None else value.isoformat()
