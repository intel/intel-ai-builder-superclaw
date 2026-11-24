"""pipeline_config.json loader.

The bundled config is at `pipeline_config.json` next to this file. Deploy-
time overrides come from `HYBRID_DR_PIPELINE_CONFIG_PATH`.
"""
from __future__ import annotations

import json
import os
from functools import lru_cache
from importlib import resources
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from .state import Phase, TaskClass

_PACKAGE = "hybrid_dr_orchestrator"


class ReportShape(BaseModel):
    model_config = ConfigDict(extra="ignore")

    max_sections: int = Field(default=2, ge=1)
    expected_length_words: str = "150-250"


class TaskClassConfig(BaseModel):
    """One row of pipeline_config.json's `task_classes` table."""

    model_config = ConfigDict(extra="ignore")

    report_shape: ReportShape = Field(default_factory=ReportShape)
    candidates: dict[str, int] = Field(default_factory=dict)
    retries: dict[str, int] = Field(default_factory=dict)
    concurrency: dict[str, int] = Field(default_factory=dict)
    skip: dict[str, bool] = Field(default_factory=dict)
    total_budget_sec: int = Field(default=3600, ge=1)

    def retries_for(self, phase: Phase) -> int:
        return int(self.retries.get(phase.value, 0))

    def candidates_for(self, phase: Phase) -> int:
        return int(self.candidates.get(phase.value, 1))

    def is_skipped(self, phase: Phase) -> bool:
        return bool(self.skip.get(phase.value, False))


class PipelineConfig(BaseModel):
    """Top-level pipeline_config.json model."""

    model_config = ConfigDict(extra="ignore")

    stages_skeleton: list[str] = Field(default_factory=list)
    task_classes: dict[str, TaskClassConfig] = Field(default_factory=dict)

    def for_task(self, task_class: TaskClass) -> TaskClassConfig:
        """Returns the per-task-class config. Falls back to deep_research
        when the requested class is missing (matches the upstream behavior;
        keeping fallback because a sidecar restart should not break running
        sessions whose task_class might be a not-yet-redeployed value)."""
        if task_class.value in self.task_classes:
            return self.task_classes[task_class.value]
        if TaskClass.DEEP_RESEARCH.value in self.task_classes:
            return self.task_classes[TaskClass.DEEP_RESEARCH.value]
        return TaskClassConfig()


def _load_raw(path: Path | None = None) -> dict[str, Any]:
    if path is not None:
        return json.loads(path.read_text(encoding="utf-8"))
    return json.loads(resources.files(_PACKAGE).joinpath("pipeline_config.json").read_text(encoding="utf-8"))


@lru_cache(maxsize=1)
def load_config() -> PipelineConfig:
    """Load pipeline_config.json. Honors HYBRID_DR_PIPELINE_CONFIG_PATH env
    override. Cached for the process lifetime; restart to reload."""
    override = os.environ.get("HYBRID_DR_PIPELINE_CONFIG_PATH", "").strip()
    return PipelineConfig.model_validate(_load_raw(Path(override) if override else None))


__all__ = ["PipelineConfig", "TaskClassConfig", "ReportShape", "load_config"]
