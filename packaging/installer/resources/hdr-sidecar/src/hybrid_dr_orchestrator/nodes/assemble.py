"""assemble phase node.

Strangler-fig phase #2 per ARCHITECTURE.md. Pure file concat, no LLM
call — the easiest phase to lift into the sidecar because the only
"orchestration" is deterministic string-building.

Inputs:

  - plan.json — section order + titles (from upstream plan phase)
  - cloud_intermediate/sections/<section_id>_final.md — cloud writer
    output per section
  - local_intermediate/filled_sections/<section_id>_filled.md — local
    filler output per section, preferred over _final.md when present
  - cloud_intermediate/conclusions/winner.md — winning conclusion
  - cloud_intermediate/insights/web/W-NNN.md — sources for the
    References appendix

Outputs:

  - local_intermediate/assembled_report.md
  - local_intermediate/polish_skeleton.json — slot list polish reads

assembled_report.md layout:

    # <title>

    <section 1 body (filled if available, else cloud final)>

    <section 2 body>
    ...

    <winning conclusion body>

    ## References

    - [W-001] <title> — <url>
    - [W-002] <title> — <url>
    ...

The references appendix is built from the W-NNN.md frontmatter. When
frontmatter is missing we fall back to the file name.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..state import Phase, PipelineState


# ───── exceptions ───────────────────────────────────────────────────────


class AssembleError(Exception):
    """Assemble-phase validation failure. No LLM call to retry, so the
    graph router treats this as terminal-fail (retries=0 in pipeline_config
    for assemble already enforces this)."""


# ───── context ──────────────────────────────────────────────────────────


@dataclass(frozen=True)
class AssembleContext:
    plan_path: Path
    """Absolute path to plan.json."""

    cloud_sections_dir: Path
    """Where S<i>_final.md files live."""

    filled_sections_dir: Path
    """Where S<i>_filled.md files live. Preferred over cloud_sections."""

    conclusions_dir: Path
    """Where winner.md lives."""

    web_insights_dir: Path
    """Where W-NNN.md files live (for references appendix)."""

    output_dir: Path
    """Where assembled_report.md + polish_skeleton.json are written.
    Typically equals local_intermediate_dir."""

    title: str = "Assembled Report"


# ───── plan + section IO ────────────────────────────────────────────────


def _read_plan(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise AssembleError(f"plan.json missing at {path}")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise AssembleError(f"plan.json is not valid JSON: {e}") from e


def _section_body(*, section_id: str, cloud_dir: Path, filled_dir: Path) -> tuple[str, str]:
    """Returns `(body_text, source_label)` where source_label is one of
    'filled' / 'cloud' / 'missing'. Filled takes precedence — that's the
    section after local_filler substituted <LOCAL_DATA:slug> placeholders.

    Missing section → empty body + 'missing'. Whether that's fatal is
    decided by `run_assemble` (depends on whether the plan listed it)."""
    filled = filled_dir / f"{section_id}_filled.md"
    if filled.exists():
        return filled.read_text(encoding="utf-8").rstrip("\n"), "filled"
    cloud = cloud_dir / f"{section_id}_final.md"
    if cloud.exists():
        return cloud.read_text(encoding="utf-8").rstrip("\n"), "cloud"
    return "", "missing"


# ───── placeholder sweep ────────────────────────────────────────────────


_PLACEHOLDER_RE = re.compile(r"<LOCAL_DATA:[^>]+>")


def _sweep_placeholders(text: str) -> str:
    """Deterministic final guard for any ``<LOCAL_DATA:slug>`` marker the
    fill phase left unresolved (filler miss on a section, ``fill_conclusion``
    no-op, etc.). The published executive/analyst report must never surface a
    raw placeholder, so we strip the marker here and tidy the
    whitespace/punctuation it leaves behind, dropping list items that became
    empty. This is a no-op when the filler resolved everything."""
    if "<LOCAL_DATA:" not in text:
        return text
    out = _PLACEHOLDER_RE.sub("", text)
    out = re.sub(r"[ \t]*:[ \t]*\.", ".", out)     # "fixed releases: ." -> "fixed releases."
    out = re.sub(r"\(\s*\)", "", out)              # empty parens left behind
    out = re.sub(r"[ \t]{2,}", " ", out)           # doubled spaces
    out = re.sub(r"[ \t]+([.,;:)])", r"\1", out)   # space before punctuation
    cleaned: list[str] = []
    for line in out.split("\n"):
        # A list item whose only content was the marker becomes an empty
        # bullet — drop it rather than leave a dangling "- ".
        if re.fullmatch(r"\s*[-*•]\s*", line):
            continue
        cleaned.append(line)
    return "\n".join(cleaned)


# ───── references appendix ──────────────────────────────────────────────


_FRONT_TITLE = re.compile(r"^title:\s*(.+)$", re.MULTILINE)
_FRONT_URL = re.compile(r"^url:\s*(.+)$", re.MULTILINE)
_W_FILE = re.compile(r"^(W-\d{3})\.md$")


def _references_block(web_insights_dir: Path) -> str:
    """Build the References appendix from W-NNN.md files. Sorted by W-NNN
    id. Each line has the shape:

        - [W-001] <title> — <url>

    Falls back to just the file id when title/url can't be parsed."""
    if not web_insights_dir.exists():
        return ""
    entries: list[tuple[str, str, str]] = []
    for path in sorted(web_insights_dir.iterdir()):
        if not path.is_file():
            continue
        m = _W_FILE.match(path.name)
        if m is None:
            continue
        wid = m.group(1)
        body = path.read_text(encoding="utf-8", errors="replace")
        head = body[:1000]
        title_m = _FRONT_TITLE.search(head)
        url_m = _FRONT_URL.search(head)
        title = (_PLACEHOLDER_RE.sub("", title_m.group(1)).strip() if title_m else "") or wid
        url = _PLACEHOLDER_RE.sub("", url_m.group(1)).strip() if url_m else ""
        entries.append((wid, title, url))
    if not entries:
        return ""
    lines = ["## References", ""]
    for wid, title, url in entries:
        if url:
            lines.append(f"- [{wid}] {title} — {url}")
        else:
            lines.append(f"- [{wid}] {title}")
    return "\n".join(lines)


# ───── polish skeleton ──────────────────────────────────────────────────


def _build_polish_skeleton(
    *,
    plan: dict[str, Any],
    section_sources: dict[str, str],
) -> dict[str, Any]:
    """The polish_skeleton.json polish reads. One slot per planned section,
    annotated with whether the body came from filled / cloud / missing —
    polish uses these annotations to decide HEDGE / DROP / ESCALATE per
    defect."""
    sections_out: list[dict[str, Any]] = []
    for entry in plan.get("sections") or []:
        if not isinstance(entry, dict):
            continue
        sid = str(entry.get("id") or entry.get("section_id") or "")
        if not sid:
            continue
        sections_out.append(
            {
                "section_id": sid,
                "title": entry.get("title") or sid,
                "source": section_sources.get(sid, "missing"),
                "annotations": [],
            }
        )
    return {"sections": sections_out}


# ───── the node ─────────────────────────────────────────────────────────


def run_assemble(state: PipelineState, ctx: AssembleContext) -> dict[str, Any]:
    """Execute the assemble phase synchronously — no LLM, no I/O blocking
    that benefits from async. Returns the LangGraph state delta."""

    plan = _read_plan(ctx.plan_path)

    body_chunks: list[str] = [f"# {ctx.title}", ""]
    section_sources: dict[str, str] = {}
    missing_sections: list[str] = []

    for entry in plan.get("sections") or []:
        if not isinstance(entry, dict):
            continue
        sid = str(entry.get("id") or entry.get("section_id") or "")
        if not sid:
            continue
        text, source = _section_body(
            section_id=sid,
            cloud_dir=ctx.cloud_sections_dir,
            filled_dir=ctx.filled_sections_dir,
        )
        section_sources[sid] = source
        if source == "missing":
            missing_sections.append(sid)
            # Still emit the section header so polish sees the slot.
            body_chunks.append(f"<!-- section {sid}: missing body -->")
            body_chunks.append("")
            continue
        body_chunks.append(text)
        body_chunks.append("")

    # Refuse to write an empty assembled_report — that's the same shape of
    # failure as "polisher returned a stub". Caller should retry sections.
    if all(src == "missing" for src in section_sources.values()):
        raise AssembleError(
            f"all {len(section_sources)} planned sections are missing both "
            f"filled and cloud-final variants — refusing to write an empty "
            f"assembled_report.md"
        )

    # Winning conclusion
    winner_path = ctx.conclusions_dir / "winner.md"
    if winner_path.exists():
        body_chunks.append(winner_path.read_text(encoding="utf-8").rstrip("\n"))
        body_chunks.append("")

    # Deterministic guard: strip any <LOCAL_DATA:slug> the fill phase left
    # unresolved so it never reaches the published executive/analyst report.
    # Swept before the References appendix is added: the sweep also tidies
    # spacing, and polish finds the appendix by its exact text.
    body = _sweep_placeholders("\n".join(body_chunks))

    # References appendix
    refs = _references_block(ctx.web_insights_dir)
    assembled = (f"{body}\n{refs}" if refs else body).rstrip() + "\n"

    ctx.output_dir.mkdir(parents=True, exist_ok=True)
    assembled_path = ctx.output_dir / "assembled_report.md"
    assembled_path.write_bytes(assembled.encode("utf-8"))

    skeleton = _build_polish_skeleton(plan=plan, section_sources=section_sources)
    skeleton_path = ctx.output_dir / "polish_skeleton.json"
    skeleton_path.write_bytes(json.dumps(skeleton, indent=2).encode("utf-8"))

    # State delta — advance to POLISH unless config skipped it. The graph
    # router decides; this node only marks assemble complete.
    return {
        "current_phase": Phase.POLISH,
        "completed_phases": [*state.completed_phases, Phase.ASSEMBLE],
        "artifacts": {
            **state.artifacts,
            "assembled_report.md": str(assembled_path),
            "polish_skeleton.json": str(skeleton_path),
        },
        "extras": {
            **state.extras,
            "assemble_missing_sections": missing_sections,
        },
    }


__all__ = [
    "AssembleContext",
    "AssembleError",
    "run_assemble",
]
