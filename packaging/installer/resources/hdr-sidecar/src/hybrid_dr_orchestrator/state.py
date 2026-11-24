"""State schema for the hybrid-DR LangGraph.

Mirrors the on-disk `pipeline_state.json` produced by the current
opencode-plugin orchestrator field-for-field, so the two formats are
mutually convertible during the strangler-fig migration window. Once the
sidecar fully owns orchestration, the back-compat dump becomes optional.

Pipeline phases follow plugin 02's PHASE_ORDER (per CLAUDE.md memory: the
order has nine items so UI labels read `[N/9: phase]`). `fill_conclusion`
is an orchestrator-emitted intermediate phase that exists today between
`conclusion` and `assemble`; we preserve it for back-compat but the new
orchestrator may collapse it later.
"""
from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class Phase(str, Enum):
    """All phases the orchestrator may report. Order matters — index is what
    the UI label `[N/9: phase]` reads off."""

    INPUT_LOCAL = "input_local"
    INPUT_WEB = "input_web"
    PLAN = "plan"
    SECTION_WRITE = "section_write"
    FILL = "fill"
    CONCLUSION = "conclusion"
    FILL_CONCLUSION = "fill_conclusion"
    ASSEMBLE = "assemble"
    POLISH = "polish"
    DONE = "done"
    FAILED = "failed"
    CANCELLED = "cancelled"

    @classmethod
    def ordered(cls) -> list[Phase]:
        """Returns the phases in the order plugin 02's PHASE_ORDER lists them.

        Excludes terminal phases (DONE / FAILED / CANCELLED) — those mark exit, not
        progression.
        """
        return [
            cls.INPUT_LOCAL,
            cls.INPUT_WEB,
            cls.PLAN,
            cls.SECTION_WRITE,
            cls.FILL,
            cls.CONCLUSION,
            cls.FILL_CONCLUSION,
            cls.ASSEMBLE,
            cls.POLISH,
        ]

    @classmethod
    def total(cls) -> int:
        """The `/N` denominator UI labels use."""
        return len(cls.ordered())

    def ordinal(self) -> int:
        """1-based index of this phase in the ordered list, or 0 for terminal."""
        try:
            return self.ordered().index(self) + 1
        except ValueError:
            return 0


class TaskClass(str, Enum):
    """How the pipeline routes the task. Matches pipeline_config.json keys."""

    DEEP_RESEARCH = "deep_research"
    TEN_TASK = "ten_task"
    OFFICEQA = "officeqa"


class PrivacyTier(str, Enum):
    """L0 = no local files involved beyond user query.
    L2 = local files involved; cloud envelope must not see L-data raw
    or derived summary."""

    L0 = "0"
    L2 = "2"


class PhaseStatus(BaseModel):
    """Per-phase progression record. Optional; mainly populated for phases
    that have non-trivial sub-progress (section_write, fill, conclusion)."""

    model_config = ConfigDict(extra="forbid")

    started_at: datetime | None = None
    completed_at: datetime | None = None
    attempt: int = 1
    sub_units_total: int | None = None
    sub_units_done: int | None = None
    last_error: str | None = None


class PipelineState(BaseModel):
    """The single source of truth for a hybrid-DR run.

    Field names and shape match `pipeline_state.json` so that the on-disk
    dump round-trips. Additional sidecar-only fields go in `extras`.
    """

    model_config = ConfigDict(
        extra="forbid",
        json_schema_extra={"description": "Hybrid-DR pipeline state"},
    )

    # — Identity —
    task_id: str = Field(..., description="Opaque task identifier from the caller.")
    task_class: TaskClass = Field(
        default=TaskClass.DEEP_RESEARCH,
        description="Pipeline-config routing key (matches pipeline_config.json).",
    )
    privacy_tier: PrivacyTier = Field(
        default=PrivacyTier.L2,
        description="Privacy contract level. L2 requires cloud-envelope shape checks.",
    )

    # — Progression —
    started_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    last_updated: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    current_phase: Phase = Field(
        default=Phase.INPUT_LOCAL,
        description="Phase the orchestrator is currently driving.",
    )
    completed_phases: list[Phase] = Field(default_factory=list)
    failed_phases: list[Phase] = Field(default_factory=list)
    retries: dict[Phase, int] = Field(default_factory=dict)
    phase_status: dict[Phase, PhaseStatus] = Field(default_factory=dict)

    # — Outputs —
    artifacts: dict[str, str] = Field(
        default_factory=dict,
        description="Map of named artifact -> absolute on-disk path. e.g. "
        "{'assembled_report.md': '/workspace/.../local_intermediate/assembled_report.md'}",
    )

    # — Sidecar extras — fields not present in legacy pipeline_state.json —
    extras: dict[str, Any] = Field(
        default_factory=dict,
        description="Sidecar-only fields. e.g. checkpoint_ids, llm_costs. The "
        "on-disk legacy dumper drops this map.",
    )

    # ───── helpers ──────────────────────────────────────────────────────

    def advance_to(self, next_phase: Phase) -> PipelineState:
        """Returns a new state with `current_phase` advanced and the previous
        phase moved into `completed_phases`.

        Fails loud (raises ValueError) when `next_phase` is not in
        `Phase.ordered()` *and* not terminal — never silently coerces. Per
        CLAUDE.md memory, the 2026-05-29 L0 bailout was caused by the
        opposite anti-pattern (`payload.next_phase || "done"` fallback).
        """
        if next_phase not in (*Phase.ordered(), Phase.DONE, Phase.FAILED, Phase.CANCELLED):
            raise ValueError(
                f"refusing to advance to unknown phase {next_phase!r}; "
                f"must be one of {[p.value for p in Phase.ordered()]} "
                f"or terminal (done/failed/cancelled)"
            )
        new_completed = list(self.completed_phases)
        if (
            self.current_phase not in new_completed
            and self.current_phase not in (Phase.DONE, Phase.FAILED, Phase.CANCELLED)
        ):
            new_completed.append(self.current_phase)
        return self.model_copy(
            update={
                "current_phase": next_phase,
                "completed_phases": new_completed,
                "last_updated": datetime.now(timezone.utc),
            }
        )

    def record_failure(self, phase: Phase, reason: str) -> PipelineState:
        """Marks `phase` failed; does not advance current_phase. The next
        edge function in the graph decides whether to retry or terminate."""
        new_failed = list(self.failed_phases)
        if phase not in new_failed:
            new_failed.append(phase)
        new_status = dict(self.phase_status)
        cur = new_status.get(phase) or PhaseStatus()
        new_status[phase] = cur.model_copy(update={"last_error": reason})
        return self.model_copy(
            update={
                "failed_phases": new_failed,
                "phase_status": new_status,
                "last_updated": datetime.now(timezone.utc),
            }
        )

    def increment_retry(self, phase: Phase) -> PipelineState:
        new_retries = dict(self.retries)
        new_retries[phase] = new_retries.get(phase, 0) + 1
        return self.model_copy(
            update={"retries": new_retries, "last_updated": datetime.now(timezone.utc)}
        )

    def add_artifact(self, name: str, path: str) -> PipelineState:
        new_artifacts = dict(self.artifacts)
        new_artifacts[name] = path
        return self.model_copy(
            update={"artifacts": new_artifacts, "last_updated": datetime.now(timezone.utc)}
        )

    def is_terminal(self) -> bool:
        return self.current_phase in (Phase.DONE, Phase.FAILED, Phase.CANCELLED)

    # ───── legacy compat ────────────────────────────────────────────────

    def to_legacy_dict(self) -> dict[str, Any]:
        """Render in the on-disk `pipeline_state.json` shape that today's
        opencode plugins / observers read.

        Drops sidecar-only fields (`extras`, `phase_status`) the legacy
        consumers do not understand. The fields kept are: task_id,
        task_class, privacy_tier, started_at, current_phase,
        completed_phases, failed_phases, retries, artifacts, last_updated,
        last_error.

        `last_error` is the one exception to the phase_status drop: the
        driver tool reads GET /state (this shape) to tell the user WHY a
        run failed, and the reason must survive a sidecar restart — an
        in-memory-only error means a failed run reads as an unexplained
        "failed" after recovery (issue #1633).
        """
        return {
            "task_id": self.task_id,
            "task_class": self.task_class.value,
            "privacy_tier": self.privacy_tier.value,
            "started_at": self.started_at.isoformat().replace("+00:00", "Z"),
            "current_phase": self.current_phase.value,
            "completed_phases": [p.value for p in self.completed_phases],
            "failed_phases": [p.value for p in self.failed_phases],
            "retries": {p.value: n for p, n in self.retries.items()},
            "artifacts": dict(self.artifacts),
            "last_updated": self.last_updated.isoformat().replace("+00:00", "Z"),
            "last_error": self.last_error(),
        }

    def last_error(self) -> str | None:
        """The most recent failed phase's recorded error, or None."""
        for phase in reversed(self.failed_phases):
            status = self.phase_status.get(phase)
            if status and status.last_error:
                return status.last_error
        return None

    @classmethod
    def from_legacy_dict(cls, data: dict[str, Any]) -> PipelineState:
        """Inverse of `to_legacy_dict`. Tolerant of missing optional fields
        because old on-disk files may pre-date some shape changes."""

        def _phase(v: Any) -> Phase:
            return Phase(v)

        failed_phases = [_phase(p) for p in data.get("failed_phases", [])]
        # Re-seed the reason onto the last failed phase so last_error()
        # round-trips through disk (the legacy shape has no phase_status).
        phase_status: dict[Phase, PhaseStatus] = {}
        last_error = data.get("last_error")
        if isinstance(last_error, str) and last_error and failed_phases:
            phase_status[failed_phases[-1]] = PhaseStatus(last_error=last_error)

        return cls(
            task_id=str(data["task_id"]),
            task_class=TaskClass(data.get("task_class", "deep_research")),
            privacy_tier=PrivacyTier(str(data.get("privacy_tier", "2"))),
            started_at=_parse_iso(data.get("started_at")),
            last_updated=_parse_iso(data.get("last_updated")),
            current_phase=_phase(data.get("current_phase", "input_local")),
            completed_phases=[_phase(p) for p in data.get("completed_phases", [])],
            failed_phases=failed_phases,
            retries={_phase(k): int(v) for k, v in (data.get("retries") or {}).items()},
            artifacts=dict(data.get("artifacts") or {}),
            phase_status=phase_status,
        )

    @field_validator("completed_phases", "failed_phases", mode="before")
    @classmethod
    def _coerce_phase_list(cls, v: Any) -> Any:
        if v is None:
            return []
        return v


def _parse_iso(value: Any) -> datetime:
    if value is None:
        return datetime.now(timezone.utc)
    if isinstance(value, datetime):
        return value
    s = str(value)
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    return datetime.fromisoformat(s)


__all__ = [
    "Phase",
    "PhaseStatus",
    "PipelineState",
    "PrivacyTier",
    "TaskClass",
]
