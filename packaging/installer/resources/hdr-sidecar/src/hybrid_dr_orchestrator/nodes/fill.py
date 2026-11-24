"""fill phase node — substitute <LOCAL_DATA:slug> placeholders per section.

Strangler-fig phase #4 per ARCHITECTURE.md. Proves the per-section
parallelism pattern: N sections fanned out with `asyncio.gather`, each
calling the local model once. The hand-rolled per-section loop that
today spans plugin 02's sub-progress counter + the hybrid_dr_local_filler
agent collapses into a `gather` over a list of section ids.

Inputs:

  - `cloud_sections_dir` — read every `S<i>_final.md` produced by
    section_write.
  - `local_insights_dir` — read every `L-NNN.md` (may be empty, e.g.
    for L0 runs).

Outputs (under `filled_sections_dir`):

  - `S<i>_filled.md` — section with `<LOCAL_DATA:slug>` replaced (or
    hedged when no matching L-NNN exists).

Fast path: when there are no `<LOCAL_DATA:...>` placeholders in a
section AND no local insights, the section is emitted verbatim with no
LLM call — important for L0 runs where `local_insights_dir` is empty
and the cloud writer also emitted no placeholders.
"""

from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..delims import normalize_delims
from ..llm import PHASE_FILL, CompletionRequest, LLMClient, LLMEndpointConfig, Message
from ..prompts import load_prompt
from ..state import Phase, PipelineState

PLACEHOLDER_RE = re.compile(r"<LOCAL_DATA:([^>]+)>")


# ───── exceptions ──────────────────────────────────────────────────────


class FillError(Exception):
    """Fill-phase failure."""


# ───── context ─────────────────────────────────────────────────────────


@dataclass(frozen=True)
class FillContext:
    cloud_sections_dir: Path
    local_insights_dir: Path
    filled_sections_dir: Path

    llm: LLMClient

    model: str = "local-model"
    """Filler runs on the local LLM by default."""
    endpoint: LLMEndpointConfig | None = None

    max_tokens: int = 2048
    concurrency: int = 1


# ───── parser ──────────────────────────────────────────────────────────


_FILLED_RE = re.compile(
    r"===FILLED===\s*(?P<body>.*?)\s*===END===",
    re.DOTALL,
)


def _parse_filler_output(text: str) -> str:
    text = normalize_delims(text, ["FILLED", "END"])
    m = _FILLED_RE.search(text)
    if m is not None:
        body = m.group("body")
    else:
        cleaned = text.strip()
        cleaned = re.sub(r"```(?:markdown|md)?\s*", "", cleaned)
        cleaned = re.sub(r"```", "", cleaned)
        cleaned = re.sub(r"===\s*FILLED\s*===", "", cleaned)
        cleaned = re.sub(r"===\s*END\s*===", "", cleaned)
        body = cleaned
    if not body.strip():
        raise FillError("filler emitted empty body")
    return body


# ───── helpers ─────────────────────────────────────────────────────────


def _list_local_insights(local_insights_dir: Path) -> list[tuple[str, str]]:
    """Return [(L-NNN id, body), ...] sorted by id. Missing dir → []."""
    if not local_insights_dir.exists():
        return []
    out: list[tuple[str, str]] = []
    for path in sorted(local_insights_dir.iterdir()):
        if not path.is_file() or not path.name.startswith("L-") or not path.name.endswith(".md"):
            continue
        out.append((path.stem, path.read_text(encoding="utf-8")))
    return out


def _has_placeholder(body: str) -> bool:
    return PLACEHOLDER_RE.search(body) is not None


def _hedge_all_placeholders(body: str) -> str:
    """Deterministic fallback used on L0 runs (no local insights). Every
    `<LOCAL_DATA:slug>` becomes `[data not available]` so the section
    parses cleanly downstream."""
    return PLACEHOLDER_RE.sub("[data not available]", body)


# ───── per-section LLM call ────────────────────────────────────────────


async def _fill_one_section(
    *,
    llm: LLMClient,
    model: str,
    endpoint: LLMEndpointConfig | None,
    max_tokens: int,
    section_body: str,
    local_insights: list[tuple[str, str]],
) -> str:
    """Single LLM call for a single section. Returns the filled body."""
    system = load_prompt("filler")
    insight_chunks = [f"=== {lid}.md ===\n{body}" for lid, body in local_insights]
    user_chunks = [f"=== section_body ===\n{section_body}"]
    if insight_chunks:
        user_chunks.append("=== local_insights ===\n" + "\n\n".join(insight_chunks))
    else:
        user_chunks.append("=== local_insights ===\n(none)")
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
            phase=PHASE_FILL,
        )
    )
    return _parse_filler_output(resp.content)


# ───── the node ────────────────────────────────────────────────────────


async def run_fill(state: PipelineState, ctx: FillContext) -> dict[str, Any]:
    """Walk every `S<i>_final.md`, fill placeholders, write `S<i>_filled.md`.

    Sections without placeholders take a fast path: copy through with
    no LLM call. This is the common case for L0 runs.
    """
    if not ctx.cloud_sections_dir.exists():
        raise FillError(f"cloud_sections_dir missing: {ctx.cloud_sections_dir}")
    cloud_sections = sorted(
        p for p in ctx.cloud_sections_dir.iterdir() if p.is_file() and p.name.endswith("_final.md")
    )
    if not cloud_sections:
        raise FillError(f"no S<i>_final.md files in {ctx.cloud_sections_dir}")

    insights = _list_local_insights(ctx.local_insights_dir)
    ctx.filled_sections_dir.mkdir(parents=True, exist_ok=True)

    sem = asyncio.Semaphore(max(1, ctx.concurrency))

    async def _process(path: Path) -> tuple[str, str]:
        sid = path.name.removesuffix("_final.md")
        body = path.read_text(encoding="utf-8")
        # Fast path: no placeholders AND no insights → emit verbatim.
        if not _has_placeholder(body):
            return sid, body
        # No insights AND there are placeholders → deterministic hedge,
        # no LLM call needed.
        if not insights:
            return sid, _hedge_all_placeholders(body)
        async with sem:
            filled = await _fill_one_section(
                llm=ctx.llm,
                model=ctx.model,
                endpoint=ctx.endpoint,
                max_tokens=ctx.max_tokens,
                section_body=body,
                local_insights=insights,
            )
        return sid, filled

    results = await asyncio.gather(*(_process(p) for p in cloud_sections))

    artifacts: dict[str, str] = dict(state.artifacts)
    for sid, body in results:
        out_path = ctx.filled_sections_dir / f"{sid}_filled.md"
        out_path.write_bytes(body.encode("utf-8"))
        artifacts[f"{sid}_filled.md"] = str(out_path)

    return {
        "current_phase": Phase.CONCLUSION,
        "completed_phases": [*state.completed_phases, Phase.FILL],
        "artifacts": artifacts,
        "extras": {
            **state.extras,
            "fill_section_count": len(results),
            "fill_had_insights": bool(insights),
        },
    }


__all__ = [
    "PLACEHOLDER_RE",
    "FillContext",
    "FillError",
    "run_fill",
]
