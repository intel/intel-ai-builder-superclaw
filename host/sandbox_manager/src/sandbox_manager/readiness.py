"""Runtime readiness evidence nodes for the App-facing readiness projection (SVC-04).

SandboxManager owns the four execution-plane facts behind runtime convergence and
reports them as independent evidence nodes so a consumer can tell *what* is
stalled; ServiceHub aggregates them. The names are wire values:

    sandbox_container    the native backend tree for the committed deployment
    profile_application  the running Profile revision equals the desired revision
    openwork_server      the Runtime reports OpenWork present
    opencode_engine      the Runtime reports OpenCode present

:func:`sandbox_manager.native_readiness.native_components` maps the native
backend's evidence onto these nodes. Two mapping rules are load-bearing:

1. Absence of proof is never `failed`. An un-committed deployment or a Runtime
   still `applying` is `starting`/`probe_pending`. Only positive terminal evidence
   is `failed`. There is deliberately no wall-clock window promoting `starting` to
   `failed`, since two callers polling at different moments would then disagree
   about the same system state.

2. Our inability to obtain evidence is `unknown`, not `failed`. Keeping that apart
   from `starting` is what stops `unknown` from also describing a normal boot.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal


ComponentState = Literal["ready", "starting", "failed", "unknown"]
ReasonCode = Literal[
    "unreachable",
    "probe_timeout",
    "probe_pending",
    "not_running",
    "native_hdr_restart_budget_exhausted",
    "profile_revision_mismatch",
    "evidence_unavailable",
]

# Ordered so the report reads as the real dependency chain, outermost first.
COMPONENT_NAMES: tuple[str, ...] = (
    "sandbox_container",
    "profile_application",
    "openwork_server",
    "opencode_engine",
)


@dataclass(frozen=True)
class RuntimeComponent:
    """One execution-plane evidence node."""

    name: str
    state: ComponentState
    reason_code: ReasonCode | None = None
    instance_id: str | None = None
    applied_revision: int | None = None
    active_revision: int | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "state": self.state,
            "reason_code": self.reason_code,
            "instance_id": self.instance_id,
            "applied_revision": self.applied_revision,
            "active_revision": self.active_revision,
        }
