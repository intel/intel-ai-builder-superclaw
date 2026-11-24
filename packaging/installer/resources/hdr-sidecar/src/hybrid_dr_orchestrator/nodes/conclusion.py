"""conclusion phase node — N candidate writers + 1 scorer.

Strangler-fig phase #3 per ARCHITECTURE.md. Proves the multi-LLM-call,
multi-candidate pattern works on the sidecar: N parallel writer LLM
calls, then one scorer LLM call to pick the winner. The old hand-rolled
"two candidates" flow now lives in one sidecar async gather plus a
deterministic file writer.

Inputs:

  - section_dir (`cloud_intermediate/sections/`) — read all `*_final.md`
    files (one per planned section) as the body the conclusion concludes
    on.

Outputs (under `conclusions_dir`):

  - `cand_1.md` ... `cand_N.md` — each candidate's verbatim body.
  - `scoring.json` — scorer's chosen_index + reason + per-candidate
    integer scores 0-10.
  - `winner.md` — verbatim copy of the chosen candidate's body. This is
    what the downstream `assemble` node reads.

The candidate count + the angle list come from pipeline_config.json (the
candidates.conclusion key) — defaults to 2 candidates: `action` +
`risk`. Extending to 4 angles is a config change, no code change.
"""

from __future__ import annotations

import asyncio
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..delims import normalize_delims
from ..json_repair import loads_lenient
from ..llm import (
    PHASE_CONCLUSION_SCORER,
    PHASE_CONCLUSION_WRITER,
    CompletionRequest,
    LLMClient,
    LLMEndpointConfig,
    Message,
)
from ..prompts import load_prompt
from ..state import Phase, PipelineState

DEFAULT_ANGLES = ("action", "risk", "roadmap", "strategic-alignment")


# ───── exceptions ───────────────────────────────────────────────────────


class ConclusionError(Exception):
    """Conclusion-phase failure. Caught by the graph router for retry vs
    fail decision (deep_research config allows 1 retry on this phase)."""


# ───── context ──────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ConclusionContext:
    sections_dir: Path
    """Where S<i>_final.md lives."""

    conclusions_dir: Path
    """Where cand_N.md / scoring.json / winner.md get written."""

    llm: LLMClient

    n_candidates: int = 2
    """How many candidates to write. Capped at len(DEFAULT_ANGLES)."""

    model_writer: str = "cloud-model"
    model_scorer: str = "cloud-model"
    endpoint_writer: LLMEndpointConfig | None = None
    endpoint_scorer: LLMEndpointConfig | None = None
    # Ceiling, not cost: room for a reasoning model to think before writing.
    max_tokens_writer: int = 8192
    # The scorer echoes the whole winning candidate (up to max_tokens_writer)
    # before its SCORING JSON; a smaller budget truncates it before the JSON.
    max_tokens_scorer: int = 16384


# ───── parsers ──────────────────────────────────────────────────────────


_WRITER_RE = re.compile(
    r"===CONCLUSION===\s*(?P<body>.*?)\s*===END===",
    re.DOTALL,
)

_SCORER_RE = re.compile(
    r"===WINNER===\s*(?P<winner>.*?)\s*===SCORING===\s*(?P<scoring>.*?)\s*===END===",
    re.DOTALL,
)


def _parse_candidate(text: str) -> str:
    text = normalize_delims(text, ["CONCLUSION", "END"])
    m = _WRITER_RE.search(text)
    if m is not None:
        body = m.group("body").strip()
    else:
        cleaned = text.strip()
        cleaned = re.sub(r"```(?:markdown|md)?\s*", "", cleaned)
        cleaned = re.sub(r"```", "", cleaned)
        cleaned = re.sub(r"===\s*CONCLUSION\s*===", "", cleaned)
        cleaned = re.sub(r"===\s*END\s*===", "", cleaned)
        body = cleaned.strip()
    if not body:
        raise ConclusionError("candidate writer emitted empty body")
    return body


def _parse_scoring(text: str) -> tuple[str, dict[str, Any]]:
    # Scorer output is best-effort. When the scorer model doesn't emit a
    # parseable verdict we default to picking the first candidate so the
    # pipeline can advance instead of getting stuck.
    # `chosen_index` is 1-indexed per the upstream contract; 0 fails the
    # validator at conclusion.py:262.
    default_scoring: dict[str, Any] = {
        "chosen_index": 1,
        "reason": "scorer output unparseable; defaulting to first candidate",
        "per_candidate_scores": {},
    }

    text = normalize_delims(text, ["WINNER", "SCORING", "END"])
    m = _SCORER_RE.search(text)
    if m is not None:
        winner = m.group("winner").strip()
        raw_scoring = m.group("scoring").strip()
    else:
        cleaned = re.sub(r"```(?:json)?\s*", "", text)
        cleaned = re.sub(r"```", "", cleaned)
        obj_match = re.search(r"\{.*\}", cleaned, flags=re.DOTALL)
        if obj_match is None:
            return "", dict(default_scoring)
        winner = ""
        raw_scoring = obj_match.group(0)
    try:
        scoring = loads_lenient(raw_scoring)
    except json.JSONDecodeError:
        return winner, dict(default_scoring)
    if not isinstance(scoring, dict):
        return winner, dict(default_scoring)
    out: dict[str, Any] = {}
    chosen = scoring.get("chosen_index", 1)
    chosen_int = int(chosen) if isinstance(chosen, (int, float)) else 1
    # Clamp into the 1-indexed valid range to survive scorer hallucinations.
    if chosen_int < 1:
        chosen_int = 1
    out["chosen_index"] = chosen_int
    out["reason"] = str(scoring.get("reason", default_scoring["reason"]))
    per_cand = scoring.get("per_candidate_scores", {})
    out["per_candidate_scores"] = per_cand if isinstance(per_cand, dict) else {}
    return winner, out


# ───── helpers ──────────────────────────────────────────────────────────


def _read_sections(sections_dir: Path) -> str:
    """Concatenate every `S<i>_final.md` into a single labeled string for
    the writer / scorer prompt's user block."""
    if not sections_dir.exists():
        raise ConclusionError(f"sections dir missing: {sections_dir}")
    chunks: list[str] = []
    for path in sorted(sections_dir.iterdir()):
        if not path.is_file() or not path.name.endswith("_final.md"):
            continue
        chunks.append(f"=== {path.name} ===\n{path.read_text(encoding='utf-8')}")
    if not chunks:
        raise ConclusionError(f"no S<i>_final.md files in {sections_dir}")
    return "\n\n".join(chunks)


async def _write_one_candidate(
    *,
    llm: LLMClient,
    model: str,
    endpoint: LLMEndpointConfig | None,
    max_tokens: int,
    body_text: str,
    angle: str,
) -> str:
    system = load_prompt("conclusion_writer")
    user = f"angle: {angle}\n\n=== report body ===\n{body_text}"
    resp = await llm.complete(
        CompletionRequest(
            messages=[
                Message(role="system", content=system),
                Message(role="user", content=user),
            ],
            model=model,
            endpoint=endpoint,
            max_tokens=max_tokens,
            temperature=0.4,
            phase=PHASE_CONCLUSION_WRITER,
        )
    )
    return _parse_candidate(resp.content)


async def _score_candidates(
    *,
    llm: LLMClient,
    model: str,
    endpoint: LLMEndpointConfig | None,
    max_tokens: int,
    body_text: str,
    candidates: list[tuple[str, str]],  # (angle, body)
) -> tuple[str, dict[str, Any]]:
    system = load_prompt("conclusion_scorer")
    user_chunks = [f"=== report body ===\n{body_text}"]
    for i, (angle, cand) in enumerate(candidates, start=1):
        user_chunks.append(f"=== cand_{i} (angle: {angle}) ===\n{cand}")
    resp = await llm.complete(
        CompletionRequest(
            messages=[
                Message(role="system", content=system),
                Message(role="user", content="\n\n".join(user_chunks)),
            ],
            model=model,
            endpoint=endpoint,
            max_tokens=max_tokens,
            temperature=0.0,
            phase=PHASE_CONCLUSION_SCORER,
        )
    )
    return _parse_scoring(resp.content)


# ───── the node ─────────────────────────────────────────────────────────


async def run_conclusion(state: PipelineState, ctx: ConclusionContext) -> dict[str, Any]:
    body_text = _read_sections(ctx.sections_dir)

    n = max(1, min(ctx.n_candidates, len(DEFAULT_ANGLES)))
    angles = list(DEFAULT_ANGLES[:n])

    # Parallel candidate generation
    candidates_raw = await asyncio.gather(
        *(
            _write_one_candidate(
                llm=ctx.llm,
                model=ctx.model_writer,
                endpoint=ctx.endpoint_writer,
                max_tokens=ctx.max_tokens_writer,
                body_text=body_text,
                angle=angle,
            )
            for angle in angles
        )
    )
    candidates = list(zip(angles, candidates_raw, strict=True))

    # Write each candidate to disk
    ctx.conclusions_dir.mkdir(parents=True, exist_ok=True)
    cand_paths: list[Path] = []
    for i, (_angle, body) in enumerate(candidates, start=1):
        p = ctx.conclusions_dir / f"cand_{i}.md"
        p.write_bytes(body.encode("utf-8"))
        cand_paths.append(p)

    # Scorer picks the winner
    if n == 1:
        scoring: dict[str, Any] = {
            "chosen_index": 1,
            "reason": "single candidate",
            "per_candidate_scores": {"cand_1": 10},
        }
    else:
        _winner, scoring = await _score_candidates(
            llm=ctx.llm,
            model=ctx.model_scorer,
            endpoint=ctx.endpoint_scorer,
            max_tokens=ctx.max_tokens_scorer,
            body_text=body_text,
            candidates=candidates,
        )
        # Defense in depth: verify chosen_index points at a real candidate
        if not (1 <= scoring["chosen_index"] <= n):
            raise ConclusionError(
                f"scorer chose index {scoring['chosen_index']} but we only have {n} candidate(s)"
            )
    # The scorer's echoed WINNER text is capped at max_tokens_scorer and can be
    # truncated or empty, so winner.md always comes from the candidate itself.
    winner_body = candidates[scoring["chosen_index"] - 1][1]

    winner_path = ctx.conclusions_dir / "winner.md"
    scoring_path = ctx.conclusions_dir / "scoring.json"
    winner_path.write_bytes(winner_body.encode("utf-8"))
    scoring_path.write_bytes(json.dumps(scoring, indent=2).encode("utf-8"))

    return {
        "current_phase": Phase.FILL_CONCLUSION,
        "completed_phases": [*state.completed_phases, Phase.CONCLUSION],
        "artifacts": {
            **state.artifacts,
            "winner.md": str(winner_path),
            "scoring.json": str(scoring_path),
            **{f"cand_{i}.md": str(p) for i, p in enumerate(cand_paths, start=1)},
        },
    }


__all__ = [
    "DEFAULT_ANGLES",
    "ConclusionContext",
    "ConclusionError",
    "run_conclusion",
]
