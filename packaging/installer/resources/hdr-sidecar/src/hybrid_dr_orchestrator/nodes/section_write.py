"""section_write phase node — writer + reviewer + retry, per section, parallel.

Strangler-fig phase #5 per ARCHITECTURE.md. The most intricate of the
ported nodes because each section runs a writer→reviewer cycle with
retries. In the existing implementation this lives split across plugin
02 (sub-progress counter), the cloud_writer / section_reviewer skills,
and the per-attempt file-naming logic. Here it folds into a single async
function with a tidy retry loop.

For each section in plan.json (in parallel, bounded by the writer-worker
concurrency from pipeline_config.json):

  Attempt 1 → writer → write S<i>_attempt_1.md
            → reviewer → write S<i>_attempt_1_reviewer.json
            → reviewer.passed?  yes → promote to S<i>_final.md (done)
                                 no → loop with attempt=2

Section gives up after `retries.section_write` attempts (3 in the
deep_research config). When the budget is exhausted we promote the
highest-scoring attempt to S<i>_final.md so downstream phases have
something to work with — refusing to write would cascade into
assemble's "all sections missing" failure.

Inputs:

  - plan_path — plan.json with `sections[]` having id / title /
    web_sources / outline / local_data_hints / target_words.
  - web_insights_dir — read W-NNN.md bodies referenced by each section.

Outputs:

  - cloud_sections_dir/S<i>_attempt_<j>.md
  - cloud_sections_dir/S<i>_attempt_<j>_reviewer.json
  - cloud_sections_dir/S<i>_final.md
  - cloud_sections_dir/S<i>_status.json — the stage a section is in
    (writing, reviewing, done), for the UI only. A retried phase clears them
    but leaves the previous attempt's finals, so the UI reads only these.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..delims import normalize_delims
from ..json_repair import loads_lenient
from ..llm import (
    PHASE_SECTION_WRITE_REVIEWER,
    PHASE_SECTION_WRITE_WRITER,
    CompletionRequest,
    LLMClient,
    LLMEndpointConfig,
    Message,
)
from ..prompts import load_prompt
from ..state import Phase, PipelineState

logger = logging.getLogger("uvicorn.error")

# ───── exceptions ──────────────────────────────────────────────────────


class SectionWriteError(Exception):
    """section_write-phase failure."""


# ───── context ─────────────────────────────────────────────────────────


@dataclass(frozen=True)
class SectionWriteContext:
    plan_path: Path
    web_insights_dir: Path
    cloud_sections_dir: Path

    llm: LLMClient

    model_writer: str = "cloud-model"
    model_reviewer: str = "cloud-model"
    endpoint_writer: LLMEndpointConfig | None = None
    endpoint_reviewer: LLMEndpointConfig | None = None
    # Ceilings, not costs. Reasoning models spend the completion budget thinking
    # first: at 2048 the writer (minimax-m3.1-flash) and at 1024 and 4096 the
    # reviewer (deepseek-flash, whose reasoning varied 1.4k-4k+ per call)
    # stopped on finish_reason=length with no output.
    max_tokens_writer: int = 8192
    max_tokens_reviewer: int = 8192
    max_attempts: int = 3
    concurrency: int = 4
    target_words_default: int = 500


# ───── parsers ─────────────────────────────────────────────────────────


_WRITER_RE = re.compile(
    r"===SECTION===\s*(?P<body>.*?)\s*===END===",
    re.DOTALL,
)

_REVIEWER_RE = re.compile(
    r"===VERDICT===\s*(?P<verdict>.*?)\s*===END===",
    re.DOTALL,
)


def _parse_writer_output(text: str) -> str:
    text = normalize_delims(text, ["SECTION", "END"])
    m = _WRITER_RE.search(text)
    if m is not None:
        body = m.group("body").strip()
    else:
        # Tolerate models that drop the delimiters: strip ``` fences and
        # any single ===SECTION=== / ===END=== that appears alone, then
        # use whatever substantial prose remains.
        cleaned = text.strip()
        cleaned = re.sub(r"```(?:markdown|md)?\s*", "", cleaned)
        cleaned = re.sub(r"```", "", cleaned)
        cleaned = re.sub(r"===\s*SECTION\s*===", "", cleaned)
        cleaned = re.sub(r"===\s*END\s*===", "", cleaned)
        body = cleaned.strip()
    if not body or len(body) < 40:
        raise SectionWriteError(
            f"section writer emitted empty / too-short body ({len(body)} chars)"
        )
    return body


def _parse_reviewer_output(text: str) -> dict[str, Any]:
    # Reviewer output is best-effort: when the model refuses to emit a
    # parseable verdict we treat the attempt as a soft pass with score 0,
    # so the orchestrator promotes the writer's draft instead of looping
    # forever. The writer body has already been written to disk.
    _DEFAULT_PASS = {
        "passed": True,
        "score": 0,
        "issues": ["reviewer output unparseable; defaulting to pass"],
        "annotations": [],
    }

    text = normalize_delims(text, ["VERDICT", "END"])
    m = _REVIEWER_RE.search(text)
    if m is not None:
        verdict_str = m.group("verdict")
    else:
        cleaned = re.sub(r"```(?:json)?\s*", "", text)
        cleaned = re.sub(r"```", "", cleaned)
        obj_match = re.search(r"\{.*\}", cleaned, flags=re.DOTALL)
        if obj_match is None:
            return dict(_DEFAULT_PASS)
        verdict_str = obj_match.group(0)
    try:
        verdict = loads_lenient(verdict_str)
    except json.JSONDecodeError:
        return dict(_DEFAULT_PASS)
    if not isinstance(verdict, dict):
        return dict(_DEFAULT_PASS)
    # Coerce missing / wrong-typed fields to a sane default rather than
    # failing — the reviewer model is unreliable; the writer body matters
    # more than the verdict schema.
    out: dict[str, Any] = {}
    out["passed"] = bool(verdict.get("passed", True))
    score = verdict.get("score", 0)
    out["score"] = int(score) if isinstance(score, (int, float)) else 0
    issues = verdict.get("issues", [])
    out["issues"] = issues if isinstance(issues, list) else []
    annotations = verdict.get("annotations", [])
    out["annotations"] = annotations if isinstance(annotations, list) else []
    return out


# ───── helpers ─────────────────────────────────────────────────────────


def _read_plan(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise SectionWriteError(f"plan.json missing at {path}")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise SectionWriteError(f"plan.json is not valid JSON: {e}") from e


def _load_web_sources(web_insights_dir: Path, ids: list[str]) -> dict[str, str]:
    """Read W-NNN.md bodies for the ids referenced by this section."""
    out: dict[str, str] = {}
    if not web_insights_dir.exists():
        return out
    for wid in ids:
        path = web_insights_dir / f"{wid}.md"
        if path.exists():
            out[wid] = path.read_text(encoding="utf-8")
    return out


# ───── per-section pipeline ────────────────────────────────────────────


def _write_status(directory: Path, sid: str, stage: str, attempt: int) -> None:
    """Record the stage a section has reached, so the UI lists a section only
    once work on it begins. Best-effort: a failed write never fails the phase."""
    path = directory / f"{sid}_status.json"
    tmp = directory / f"{sid}_status.json.tmp"
    try:
        tmp.write_text(json.dumps({"stage": stage, "attempt": attempt}), encoding="utf-8")
        tmp.replace(path)
    except OSError as exc:
        logger.warning(
            "hybrid_dr.section_write.status.failed sid=%s error=%s", sid, type(exc).__name__
        )


@dataclass(frozen=True)
class _SectionOutcome:
    section_id: str
    final_path: Path
    attempts: int
    final_score: int
    passed: bool


async def _drive_one_section(
    section: dict[str, Any],
    *,
    ctx: SectionWriteContext,
    sem: asyncio.Semaphore,
) -> _SectionOutcome:
    sid = str(section.get("id") or section.get("section_id") or "")
    if not sid:
        raise SectionWriteError(f"section entry missing id field: {section!r}")

    title = str(section.get("title") or sid)
    web_ids = list(section.get("web_sources") or [])
    web_sources = _load_web_sources(ctx.web_insights_dir, web_ids)
    target_words = int(section.get("target_words") or ctx.target_words_default)
    local_hints = list(section.get("local_data_hints") or [])

    sys_writer = load_prompt("section_writer")
    sys_reviewer = load_prompt("section_reviewer")

    best_attempt: tuple[int, int, str] | None = None  # (attempt, score, body)
    reviewer_feedback: list[str] = []
    final_verdict: dict[str, Any] = {}

    for attempt in range(1, ctx.max_attempts + 1):
        # Writer
        writer_user = json.dumps(
            {
                "section_id": sid,
                "title": title,
                "target_words": target_words,
                "web_sources_ids": web_ids,
                "local_data_hints": local_hints,
                "attempt": attempt,
                "reviewer_feedback": reviewer_feedback if attempt > 1 else None,
                "web_sources_bodies": web_sources,
            },
            indent=2,
        )
        async with sem:
            _write_status(ctx.cloud_sections_dir, sid, "writing", attempt)
            writer_resp = await ctx.llm.complete(
                CompletionRequest(
                    messages=[
                        Message(role="system", content=sys_writer),
                        Message(role="user", content=writer_user),
                    ],
                    model=ctx.model_writer,
                    endpoint=ctx.endpoint_writer,
                    max_tokens=ctx.max_tokens_writer,
                    temperature=0.5,
                    phase=PHASE_SECTION_WRITE_WRITER,
                )
            )
        try:
            body = _parse_writer_output(writer_resp.content)
        except SectionWriteError:
            # Model returned empty / too-short content on this attempt; burn
            # an attempt slot and let the loop try again. Only re-raise once
            # we've exhausted the per-section budget so a single bad sample
            # doesn't kill the whole phase.
            if attempt < ctx.max_attempts:
                reviewer_feedback = [
                    f"previous attempt returned empty body ({len(writer_resp.content)} chars); retry with more detail"
                ]
                continue
            raise
        attempt_path = ctx.cloud_sections_dir / f"{sid}_attempt_{attempt}.md"
        attempt_path.write_bytes(body.encode("utf-8"))

        # Reviewer
        reviewer_user = json.dumps(
            {
                "section_id": sid,
                "title": title,
                "target_words": target_words,
                "web_sources_ids": web_ids,
                "web_sources_bodies": web_sources,
                "attempt_body": body,
            },
            indent=2,
        )
        async with sem:
            _write_status(ctx.cloud_sections_dir, sid, "reviewing", attempt)
            reviewer_resp = await ctx.llm.complete(
                CompletionRequest(
                    messages=[
                        Message(role="system", content=sys_reviewer),
                        Message(role="user", content=reviewer_user),
                    ],
                    model=ctx.model_reviewer,
                    endpoint=ctx.endpoint_reviewer,
                    max_tokens=ctx.max_tokens_reviewer,
                    temperature=0.0,
                    phase=PHASE_SECTION_WRITE_REVIEWER,
                )
            )
        verdict = _parse_reviewer_output(reviewer_resp.content)
        reviewer_path = ctx.cloud_sections_dir / f"{sid}_attempt_{attempt}_reviewer.json"
        reviewer_path.write_bytes(json.dumps(verdict, indent=2).encode("utf-8"))

        # Track best-so-far for the budget-exhaustion fallback
        score = int(verdict.get("score", 0))
        if best_attempt is None or score > best_attempt[1]:
            best_attempt = (attempt, score, body)
        final_verdict = verdict

        if verdict["passed"]:
            final_path = ctx.cloud_sections_dir / f"{sid}_final.md"
            final_path.write_bytes(body.encode("utf-8"))
            _write_status(ctx.cloud_sections_dir, sid, "done", attempt)
            return _SectionOutcome(
                section_id=sid,
                final_path=final_path,
                attempts=attempt,
                final_score=score,
                passed=True,
            )

        reviewer_feedback = list(verdict.get("issues") or [])

    # Budget exhausted → promote best attempt so downstream isn't blocked
    assert best_attempt is not None
    final_path = ctx.cloud_sections_dir / f"{sid}_final.md"
    final_path.write_bytes(best_attempt[2].encode("utf-8"))
    _write_status(ctx.cloud_sections_dir, sid, "done", best_attempt[0])
    return _SectionOutcome(
        section_id=sid,
        final_path=final_path,
        attempts=best_attempt[0],
        final_score=best_attempt[1],
        passed=False,
    )


# ───── the node ────────────────────────────────────────────────────────


async def run_section_write(state: PipelineState, ctx: SectionWriteContext) -> dict[str, Any]:
    plan = _read_plan(ctx.plan_path)
    sections = plan.get("sections") or []
    if not sections:
        raise SectionWriteError("plan.json has no sections[]")

    ctx.cloud_sections_dir.mkdir(parents=True, exist_ok=True)
    # A retried phase starts every section over. UI-only, so a file held open
    # (WinError 32) is logged, never fatal; the section's next stage overwrites it.
    for stale in ctx.cloud_sections_dir.glob("*_status.json"):
        try:
            stale.unlink(missing_ok=True)
        except OSError as exc:
            logger.warning(
                "hybrid_dr.section_write.status.cleanup_failed file=%s error=%s",
                stale.name,
                type(exc).__name__,
            )
    sem = asyncio.Semaphore(max(1, ctx.concurrency))

    outcomes: list[_SectionOutcome] = await asyncio.gather(
        *(_drive_one_section(section=s, ctx=ctx, sem=sem) for s in sections if isinstance(s, dict))
    )

    artifacts: dict[str, str] = dict(state.artifacts)
    for o in outcomes:
        artifacts[f"{o.section_id}_final.md"] = str(o.final_path)

    return {
        "current_phase": Phase.FILL,
        "completed_phases": [*state.completed_phases, Phase.SECTION_WRITE],
        "artifacts": artifacts,
        "extras": {
            **state.extras,
            "section_write_outcomes": [
                {
                    "section_id": o.section_id,
                    "attempts": o.attempts,
                    "score": o.final_score,
                    "passed": o.passed,
                }
                for o in outcomes
            ],
        },
    }


__all__ = [
    "SectionWriteContext",
    "SectionWriteError",
    "run_section_write",
]
