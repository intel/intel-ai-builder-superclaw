"""polish phase node.

Strangler-fig phase #1 per ARCHITECTURE.md. Single LLM call, well-bounded
inputs (assembled_report.md + polish_skeleton.json), well-bounded outputs
(executive_report.md + analyst_report.md + gap_manifest.json).

Preserves the artifact validation contract used by the legacy Hybrid DR
polish phase, so the sidecar produces outputs the UI/eval pipeline still
understands:

  - executive_content >= EXEC_MIN_BYTES (rejects empty / stub output)
  - executive_content NOT byte-identical to assembled_report (would mean
    the polisher copied instead of condensing)
  - gap_content parses as JSON and has 'defects' key
  - analyst_report = audit-header + assembled_report (deterministic, so
    we don't burn polisher tokens on a 60-80KB regurgitation)

The node is purely async + injectable: paths and LLM client come in via
`PolishContext`, so unit tests use tmp paths and a `MockLLMClient`.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..json_repair import loads_lenient
from ..llm import PHASE_POLISH, CompletionRequest, LLMClient, LLMEndpointConfig, Message
from ..prompts import load_prompt
from ..state import Phase, PipelineState, PrivacyTier
from .assemble import _references_block, _sweep_placeholders


EXEC_MIN_BYTES = 500
"""Lower bound on executive_content length. Below this we treat the
polisher's output as a stub (the same threshold the existing TS tool
applies)."""

_DELIM_EXEC = "===EXECUTIVE_CONTENT==="
_DELIM_GAP = "===GAP_CONTENT==="
_DELIM_END = "===END==="

# Fuzzy whole-line delimiter matchers. A weak polisher model frequently mangles
# the exact delimiters (drops the leading "===", writes "_CONTENT===", spaces out
# "EXECUTIVE CONTENT", pads to "====...====", etc.). We normalize any such
# delimiter-shaped LINE to its canonical form BEFORE parsing, so mangled output
# parses identically to well-formed output and the gap-audit JSON can never leak
# into the published executive report (issue #1633). GAP is matched first so a
# "GAP_CONTENT" line is never mis-normalized as the EXECUTIVE delimiter.
_FUZZY_GAP_LINE = re.compile(
    r"^[ \t]*[=_]*[ \t]*GAP[ _]?CONTENT[ \t]*=+[ \t]*$",
    re.IGNORECASE | re.MULTILINE,
)
_FUZZY_EXEC_LINE = re.compile(
    r"^[ \t]*[=_]*[ \t]*(?:EXECUTIVE[ _]?)?CONTENT[ \t]*=+[ \t]*$",
    re.IGNORECASE | re.MULTILINE,
)
_FUZZY_END_LINE = re.compile(
    r"^[ \t]*[=_]*[ \t]*END[ \t]*=+[ \t]*$",
    re.IGNORECASE | re.MULTILINE,
)


def _normalize_delims(text: str) -> str:
    """Rewrite mangled/partial delimiter LINES to their canonical form."""
    text = _FUZZY_GAP_LINE.sub(_DELIM_GAP, text)
    text = _FUZZY_EXEC_LINE.sub(_DELIM_EXEC, text)
    text = _FUZZY_END_LINE.sub(_DELIM_END, text)
    return text


# ───── exceptions ───────────────────────────────────────────────────────


class PolishError(Exception):
    """Polish-phase validation failure. The graph router catches this and
    routes back to the phase node for retry, or to FAILED if the retry
    budget is exhausted."""


# ───── context ──────────────────────────────────────────────────────────


@dataclass(frozen=True)
class PolishContext:
    """Inputs the polish node needs, injected by the graph runtime."""

    local_intermediate_dir: Path
    """Where assembled_report.md lives and where outputs go."""

    polish_skeleton_path: Path
    """Absolute path to polish_skeleton.json (slot list)."""

    llm: LLMClient

    model: str = "cloud-model"
    """llmrouter model alias. Defaults to cloud-model (the existing
    polisher is cloud)."""
    endpoint: LLMEndpointConfig | None = None

    local_model: str = "local-model"
    """Used instead of `model` at tier 2 when local files were ingested and the
    cloud drafts below are missing or empty, so no paragraph can be proven cloud-safe."""
    local_endpoint: LLMEndpointConfig | None = None

    cloud_sections_dir: Path | None = None
    """Where the cloud's own `S<i>_final.md` drafts live. At tier 2 with local
    files, only paragraphs found verbatim here or in `winner.md` reach the cloud."""
    conclusions_dir: Path | None = None
    web_insights_dir: Path | None = None
    """The web `W-NNN.md` sheets; the References appendix is rebuilt from these rather than found in the report."""

    # 16384 (was 8192): the polisher emits the full executive report + gap JSON
    # (~3-4k tokens), and thinking/reasoning models (sonnet-5, kimi-k3, ...)
    # additionally spend the completion budget on reasoning tokens. At 8192 a
    # heavy reasoning pass leaves an empty / stub polish -> PolishError
    # ("content is empty" / "executive_content N bytes; minimum 500"). The extra
    # headroom is for the reasoning prefix. Per-request; no shared-state impact.
    max_tokens: int = 16384


# ───── output parser ────────────────────────────────────────────────────


_PARSE_RE = re.compile(
    re.escape(_DELIM_EXEC)
    + r"\s*(?P<exec>.*?)\s*"
    + re.escape(_DELIM_GAP)
    + r"\s*(?P<gap>.*?)\s*"
    + re.escape(_DELIM_END),
    re.DOTALL,
)


def _parse_polisher_output(text: str) -> tuple[str, str]:
    """Split the polisher's delimited output into (executive, gap) strings.

    Raises PolishError when the delimiters are missing or out of order —
    those are exactly the cases that today's tool-call protocol silently
    swallows (model emits a content-only message and opencode rejects it).
    """
    # Normalize mangled/partial delimiters to canonical first, so a weak
    # polisher's imperfect delimiters parse identically to well-formed output
    # (the strict regex otherwise sub-string-matches a padded "====…====" and
    # leaks a stray "=", or misses "_CONTENT===" and leaks the whole gap block).
    normalized = _normalize_delims(text)
    match = _PARSE_RE.search(normalized)
    if match is not None:
        return match.group("exec").strip(), match.group("gap").strip()
    # Fallback for output missing the END rail entirely: split at the GAP
    # delimiter so the gap-audit JSON never leaks into the executive report, and
    # strip any stray EXECUTIVE/END delimiters from each side (issue #1633).
    cleaned = re.sub(r"```(?:markdown|md)?\s*", "", normalized)
    cleaned = re.sub(r"```", "", cleaned)
    if _DELIM_GAP in cleaned:
        exec_src, gap_src = cleaned.split(_DELIM_GAP, 1)
    else:
        exec_src, gap_src = cleaned, ""
    executive = exec_src.replace(_DELIM_EXEC, "").replace(_DELIM_END, "").strip()
    gap = gap_src.split(_DELIM_END, 1)[0].replace(_DELIM_EXEC, "").strip()
    if not executive:
        raise PolishError(
            "polisher output missing required delimiters "
            f"({_DELIM_EXEC!r}, {_DELIM_GAP!r}, {_DELIM_END!r}) "
            "and content is empty"
        )
    return executive, gap


# ───── local-source reference collector ────────────────────────────────


_L_NNN_INLINE_RE = re.compile(r"\[L-(\d+)\]")
_L_FILE_RE = re.compile(r"^L-(\d+)\.md$")


def _read_insight_title(path: Path) -> str:
    """Read the ``title:`` (original filename) from an L-NNN.md insight
    sheet written by ``input_local``."""
    try:
        with path.open("r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.rstrip("\n")
                if line.startswith("title:"):
                    return line[len("title:") :].strip()
                if line == "" or line.startswith("---"):
                    break
    except OSError:
        pass
    return ""


def _build_local_sources(
    *, local_insights_dir: Path, privacy_tier: str
) -> tuple[str, str]:
    """Return ``(reference_lines, local_sources_note)`` for every local file
    the user provided, read from the ingested L-NNN insight sheets.

    ``reference_lines``: newline-joined ``- [L-NNN] filename`` entries to
    append to the References section, so every inline [L-NNN] tag has a
    matching reference entry.

    ``local_sources_note``: a trailing 'Local Sources' note listing all
    provided files with inline [L-NNN] tags, phrased as simply reviewed. It
    deliberately does NOT label any file irrelevant: a weak on-device pass
    may under-use a genuinely relevant file, so calling it irrelevant would
    be wrong. Computed in code from the ingested
    sheets, so it is honest and survives polisher compression / weak-model
    omission. The on-device privacy line is added only at tier 2, where
    local contents stay on-device. Both strings are "" when no local files
    were ingested, so the note never appears empty and never fabricates a
    source.
    """
    if not local_insights_dir.exists():
        return "", ""
    files: list[tuple[str, str]] = []  # (L-NNN, filename)
    for p in sorted(local_insights_dir.iterdir()):
        m = _L_FILE_RE.match(p.name)
        if not m:
            continue
        lid = f"L-{m.group(1)}"
        title = _read_insight_title(p) or f"{lid} (filename unavailable)"
        files.append((lid, title))
    if not files:
        return "", ""
    reference_lines = "\n".join(f"- [{lid}] {title}" for lid, title in files)
    listing = ", ".join(f"`{title}`[{lid}]" for lid, title in files)
    note = (
        "## Local Sources\n\n"
        f"This report also reviewed the local files you provided: {listing}."
    )
    if privacy_tier == "2":
        note += "\n\nProcessed on-device and not sent to the cloud."
    return reference_lines, "\n" + note + "\n"


_LOCAL_BLOCKS_HEADING = "## From your local files"
_LOCAL_BLOCK_RE = re.compile(r"\[\[\s*LOCAL[ _]?BLOCK[ _]?(\d+)\s*\]\]", re.IGNORECASE)


_PARAGRAPH_SPLIT_RE = re.compile(r"(\n[ \t]*\n)")
# Only the trailing web appendix that assemble builds counts as References; a heading in a section body does not.
_WEB_REFERENCES_RE = re.compile(r"\n## References\n\n(?:- \[W-\d+\][^\n]*\n?)+\s*\Z")


def _split_web_references(text: str, web_insights_dir: Path | None) -> tuple[str, str]:
    if web_insights_dir is None:
        m = _WEB_REFERENCES_RE.search(text)
        return (text[: m.start()], text[m.start() :]) if m else (text, "")
    expected = _references_block(web_insights_dir)
    trimmed = text.rstrip("\n")
    if expected and trimmed.endswith("\n" + expected):
        cut = len(trimmed) - len(expected) - 1
        return text[:cut], text[cut:]
    return text, ""


def _cloud_drafted_paragraphs(sections_dir: Path, conclusions_dir: Path) -> set[str]:
    """Paragraphs the cloud wrote itself: its section drafts and winning conclusion."""
    drafts = sorted(sections_dir.glob("*_final.md")) + [conclusions_dir / "winner.md"]
    return {
        p.strip()
        for path in drafts
        if path.is_file()
        for p in _PARAGRAPH_SPLIT_RE.split(_sweep_placeholders(path.read_text(encoding="utf-8")))
        if p.strip()
    }


def _mask_local_paragraphs(body: str, cloud_paragraphs: set[str]) -> tuple[str, list[str]]:
    """Swap every paragraph the cloud did not write for a [[LOCAL_BLOCK_n]] marker."""
    blocks: list[str] = []

    def mask(index: int, paragraph: str) -> str:
        text = paragraph.strip()
        is_title = index == 0 and text.startswith("# ") and "\n" not in text
        if is_title or text in cloud_paragraphs or not _L_NNN_INLINE_RE.sub("", text).strip():
            return paragraph
        blocks.append(text)
        return f"[[LOCAL_BLOCK_{len(blocks)}]]"

    parts = _PARAGRAPH_SPLIT_RE.split(body)
    return "".join(p if i % 2 else mask(i, p) for i, p in enumerate(parts)), blocks


def _unmask_local_paragraphs(executive: str, blocks: list[str]) -> str:
    """Put each marker's paragraph back in place, and append those whose marker the polisher dropped."""
    placed: set[int] = set()

    def put(match: re.Match[str]) -> str:
        i = int(match.group(1))
        if not 1 <= i <= len(blocks) or i in placed:
            return ""
        placed.add(i)
        return f"\n\n{blocks[i - 1]}\n\n"

    text = re.sub(r"\n{3,}", "\n\n", _LOCAL_BLOCK_RE.sub(put, executive)).strip()
    missing = [b for i, b in enumerate(blocks, 1) if i not in placed]
    if missing:
        text += f"\n\n{_LOCAL_BLOCKS_HEADING}\n\n" + "\n\n".join(missing)
    return text


# ───── validators ───────────────────────────────────────────────────────


class PolishRefusalError(PolishError):
    """The polisher declined to write a report. Retrying the same input gets the
    same refusal, so neither the node nor the runner retries it."""


# A polisher handed thin or broken sections answers conversationally ("I can't
# polish this report as it stands...") with enough bytes to pass the stub check.
# A report never opens in the first person, so treat that opener (after any
# leading headings or markdown emphasis) as a refusal.
_REFUSAL_OPENER_RE = re.compile(
    r"(?:\s*#[^\n]*\n)*[\s>*_\ufeff]*"
    r"(?:I(?:\s+can(?:no|\s+no|['\u2019])t|\s+am\s+(?:not\s+able|unable|sorry)"
    r"|['\u2019]m\s+(?:not\s+able|unable|sorry)|\s+won['\u2019]t|\s+will\s+not"
    r"|\s+apologi[sz]e)|(?:Unfortunately,?|Sorry,?(?:\s+but)?)\s+I(?=\s|['\u2019]))\b"
)

# A reasoning-tuned polisher sometimes emits its working notes as the visible
# answer ("Let me analyze the assembled report and the polish skeleton...")
# with one or more report drafts buried below \u2014 large enough to pass the stub
# check and different enough to pass the copy check. A report never opens with
# first-person planning. Unlike a refusal this is a per-attempt fluke (the next
# attempt regularly produces a clean report), so raise the retryable
# PolishError rather than PolishRefusalError.
_DELIBERATION_OPENER_RE = re.compile(
    r"[\s>*_\ufeff]*"
    r"(?:Let(?:\s+me|['\u2019]s)\b|Okay[,.]|Alright[,.]"
    r"|I(?:\s+(?:need|want|am\s+going)\s+to|['\u2019]ll|\s+will)\s)"
)


# The polisher's ESCALATE policy (prompts/polisher.md) marks a point it can
# neither hedge nor drop with an inline `[ESCALATE: <reason>]` tag and keeps
# the surrounding prose. That tag is a QA annotation: gap_manifest.json already
# records every escalation structurally, so leaving the bracket mid-sentence
# only ships an internal sticky note in the reader-facing report. Reason text
# may itself cite a tag such as [W-002], hence one level of nested brackets.
_ESCALATE_TAG_RE = re.compile(
    r"\[ESCALATE:\s*((?:[^\[\]]|\[[^\[\]]*\])*?)\s*\]"
)
_ESCALATIONS_HEADING = "## Points requiring verification"


def _relocate_escalations(content: str) -> str:
    """Lift every `[ESCALATE: reason]` tag out of the prose into one closing
    section. The sentence the tag annotated stays in place, as the polisher
    intended; the reasons become a legible, de-duplicated list the reader can
    act on. Content without tags is returned unchanged."""
    reasons: list[str] = []
    for match in _ESCALATE_TAG_RE.finditer(content):
        reason = " ".join(match.group(1).split())
        if reason and reason not in reasons:
            reasons.append(reason)
    if not reasons:
        return content
    body = _ESCALATE_TAG_RE.sub("", content)
    body = re.sub(r"[ \t]+([.,;:!?])", r"\1", body)
    body = re.sub(r"[ \t]{2,}", " ", body)
    body = re.sub(r"[ \t]+\n", "\n", body).rstrip()
    bullets = "\n".join(f"- {reason}" for reason in reasons)
    return (
        f"{body}\n\n{_ESCALATIONS_HEADING}\n\n"
        "The following points could not be verified from the available "
        "sources and should be treated as unconfirmed:\n\n"
        f"{bullets}"
    )


def _validate_executive(content: str, assembled_bytes: bytes) -> None:
    if _REFUSAL_OPENER_RE.match(content):
        raise PolishRefusalError(
            "the report writer refused to produce a report from the gathered "
            "material (likely too little source content). No report was produced."
        )
    if _DELIBERATION_OPENER_RE.match(content):
        raise PolishError(
            "executive_content opens with the polisher's own deliberation "
            "instead of a report (reasoning model emitted its working notes). "
            "Rejecting the attempt."
        )
    if len(content.encode("utf-8")) < EXEC_MIN_BYTES:
        raise PolishError(
            f"executive_content is {len(content.encode('utf-8'))} bytes; "
            f"minimum is {EXEC_MIN_BYTES}. Polisher likely emitted a stub."
        )
    # Compare after stripping trailing whitespace on both sides: the
    # parser already strips the LLM output, and the on-disk assembled
    # may legitimately end in a trailing newline. We only want to catch
    # "polisher copied the whole report verbatim" — not whitespace noise.
    content_norm = content.encode("utf-8").rstrip()
    assembled_norm = assembled_bytes.rstrip()
    if content_norm == assembled_norm:
        raise PolishError(
            "executive_content is byte-identical to assembled_report.md "
            "(after trailing-whitespace normalization). Polisher copied "
            "instead of condensing — refusing the output."
        )


def _validate_gap(content: str) -> dict[str, Any]:
    # gap_content is best-effort metadata for the analyst report; when the
    # polisher model emits something unparseable, default to an empty gap
    # manifest rather than failing the whole pipeline.
    default_gap: dict[str, Any] = {"defects": []}
    if not content.strip():
        return dict(default_gap)
    try:
        parsed = loads_lenient(content)
    except json.JSONDecodeError:
        # Try to find a JSON object embedded in prose.
        obj_match = re.search(r"\{.*\}", content, flags=re.DOTALL)
        if not obj_match:
            return dict(default_gap)
        try:
            parsed = loads_lenient(obj_match.group(0))
        except json.JSONDecodeError:
            return dict(default_gap)
    if not isinstance(parsed, dict):
        return dict(default_gap)
    defects = parsed.get("defects", [])
    parsed["defects"] = defects if isinstance(defects, list) else []
    return parsed


# ───── analyst generator ────────────────────────────────────────────────


def _build_analyst_report(*, task_id: str, assembled_body: bytes, gap_obj: dict[str, Any]) -> bytes:
    """Deterministic analyst_report = audit header + assembled body.

    Generating analyst this way (rather than asking the LLM to regurgitate
    assembled into analyst form) sidesteps the qwen3.6-35b-a3b output-
    budget exhaustion case that was causing polish stalls — assembled is
    routinely 60-80KB ≈ 15-20K tokens, well past the polisher model's
    per-completion budget.
    """
    # Non-security: content fingerprint for the audit header, not a signature.
    md5 = hashlib.md5(assembled_body, usedforsecurity=False).hexdigest()
    defects = gap_obj.get("defects") or []
    lines = [
        "<!-- audit-header (generated by hybrid_dr_orchestrator polish node) -->",
        f"task_id: {task_id}",
        f"assembled_md5: {md5}",
        f"defects_count: {len(defects)}",
        f"defect_kinds: {sorted({(d.get('kind') or '?') for d in defects if isinstance(d, dict)})}",
        "<!-- end audit-header -->",
        "",
        "",
    ]
    header_bytes = "\n".join(lines).encode("utf-8")
    return header_bytes + assembled_body


# ───── the node ─────────────────────────────────────────────────────────


async def run_polish(state: PipelineState, ctx: PolishContext) -> dict[str, Any]:
    """Execute the polish phase. Returns a state delta dict for LangGraph.

    On success: writes the three artifacts, returns delta with
    advance-to-DONE (polish is the last non-terminal phase).

    On validation failure: raises `PolishError`. The graph router catches
    this and decides retry vs terminal-fail per the task class's
    retry budget.
    """
    assembled_path = ctx.local_intermediate_dir / "assembled_report.md"
    if not assembled_path.exists():
        raise PolishError(f"polish input missing: {assembled_path} (assemble stage did not run)")
    if not ctx.polish_skeleton_path.exists():
        raise PolishError(f"polish input missing: {ctx.polish_skeleton_path}")

    assembled_bytes = assembled_path.read_bytes()
    skeleton_bytes = ctx.polish_skeleton_path.read_bytes()

    local_insights_dir = ctx.local_intermediate_dir / "insights" / "local"
    has_local_files = local_insights_dir.is_dir() and any(
        _L_FILE_RE.match(p.name) for p in local_insights_dir.iterdir()
    )
    assembled_text = assembled_bytes.decode("utf-8", errors="replace")
    refs_marker = "## References"
    body, web_refs = _split_web_references(assembled_text, ctx.web_insights_dir)
    polish_input, local_blocks = assembled_text, []
    model, endpoint = ctx.model, ctx.endpoint
    if state.privacy_tier == PrivacyTier.L2 and has_local_files:
        cloud_paragraphs = (
            _cloud_drafted_paragraphs(ctx.cloud_sections_dir, ctx.conclusions_dir)
            if ctx.cloud_sections_dir is not None and ctx.conclusions_dir is not None
            else set()
        )
        if not cloud_paragraphs:
            model, endpoint = ctx.local_model, ctx.local_endpoint
        else:
            masked_body, local_blocks = _mask_local_paragraphs(body, cloud_paragraphs)
            polish_input = masked_body + web_refs

    system_prompt = load_prompt("polisher")
    user_prompt = (
        f"task_id: {state.task_id}\n\n"
        f"=== assembled_report.md ===\n{polish_input}\n\n"
        f"=== polish_skeleton.json ===\n{skeleton_bytes.decode('utf-8')}\n"
    )

    async def _attempt() -> tuple[str, dict[str, Any]]:
        resp = await ctx.llm.complete(
            CompletionRequest(
                messages=[
                    Message(role="system", content=system_prompt),
                    Message(role="user", content=user_prompt),
                ],
                model=model,
                endpoint=endpoint,
                max_tokens=ctx.max_tokens,
                temperature=0.0,
                phase=PHASE_POLISH,
            )
        )
        exec_c, gap_c = _parse_polisher_output(resp.content)
        _validate_executive(exec_c, polish_input.encode("utf-8"))
        return exec_c, _validate_gap(gap_c)

    # Retry once on a stub/empty polish. Thinking models occasionally burn the
    # whole budget on reasoning and return nothing parseable; the failure is
    # flaky (the same model's other case polishes fine), so a single fresh
    # attempt at the raised max_tokens usually recovers it in-phase.
    try:
        executive_content, gap_obj = await _attempt()
    except PolishRefusalError:
        raise
    except PolishError:
        executive_content, gap_obj = await _attempt()

    # The polisher often fabricates its own References section (made-up
    # arXiv-style citations) and drops URLs. ALWAYS strip whatever the
    # polisher wrote for References and append the verbatim URL-bearing
    # block from assembled_report.md.
    executive_content = re.sub(
        r"\n+##\s*References[\s\S]*",
        "",
        executive_content,
    ).rstrip()
    if local_blocks:
        executive_content = _unmask_local_paragraphs(executive_content, local_blocks)
    # After the References strip (so the new closing section survives it) and
    # before the verbatim References block is appended (so it reads as part of
    # the body, not as a footnote to the bibliography).
    executive_content = _relocate_escalations(executive_content)
    if web_refs:
        executive_content = executive_content + "\n\n" + web_refs.strip()

    # Acknowledge every local file the user provided: add a reference entry
    # for each [L-NNN] to the References section, and append a trailing
    # 'Local Sources' note listing them as reviewed and drawn on where
    # relevant (never labelled irrelevant, since a weak on-device pass can
    # under-use a genuinely relevant file). Computed from the ingested
    # insight sheets, so it is honest and never fabricated; omitted entirely
    # when no local files were ingested.
    reference_lines, local_sources_note = _build_local_sources(
        local_insights_dir=local_insights_dir,
        privacy_tier=state.privacy_tier.value,
    )
    if reference_lines:
        if refs_marker in executive_content:
            executive_content = executive_content.rstrip() + "\n" + reference_lines
        else:
            executive_content = (
                executive_content.rstrip()
                + "\n\n"
                + refs_marker
                + "\n\n"
                + reference_lines
            )
    if local_sources_note:
        executive_content = executive_content + "\n" + local_sources_note

    # Write the three artifacts atomically (each as a separate file write —
    # the temp-rename pattern is overkill for sidecar usage but is on the
    # follow-up list).
    exec_path = ctx.local_intermediate_dir / "executive_report.md"
    analyst_path = ctx.local_intermediate_dir / "analyst_report.md"
    gap_path = ctx.local_intermediate_dir / "gap_manifest.json"

    exec_path.write_text(executive_content + "\n", encoding="utf-8")
    analyst_bytes = _build_analyst_report(
        task_id=state.task_id,
        assembled_body=assembled_bytes,
        gap_obj=gap_obj,
    )
    analyst_path.write_bytes(analyst_bytes)
    gap_path.write_text(json.dumps(gap_obj, indent=2), encoding="utf-8")

    # Also publish to the session-root `reports/` directory so the UI's
    # legacy report-resolver finds it without sidecar-specific awareness.
    # UI summary is the first ~600 chars of executive content, trimmed at
    # a sentence boundary when possible.
    reports_dir = ctx.local_intermediate_dir.parent / "reports"
    reports_dir.mkdir(parents=True, exist_ok=True)
    (reports_dir / "executive_report.md").write_text(executive_content + "\n", encoding="utf-8")
    (reports_dir / "analyst_report.md").write_bytes(analyst_bytes)
    (reports_dir / "gap_manifest.json").write_text(json.dumps(gap_obj, indent=2), encoding="utf-8")
    ui_summary = executive_content.strip()
    if len(ui_summary) > 600:
        cutoff = ui_summary.rfind("。", 0, 600)
        if cutoff < 200:
            cutoff = ui_summary.rfind(". ", 0, 600)
        if cutoff < 200:
            cutoff = 600
        ui_summary = ui_summary[: cutoff + 1].rstrip() + "\n\n..."
    (reports_dir / "ui_summary.md").write_text(ui_summary + "\n", encoding="utf-8")

    return {
        "current_phase": Phase.DONE,
        "completed_phases": [*state.completed_phases, Phase.POLISH],
        "artifacts": {
            **state.artifacts,
            "executive_report.md": str(exec_path),
            "analyst_report.md": str(analyst_path),
            "gap_manifest.json": str(gap_path),
            "reports/executive_report.md": str(reports_dir / "executive_report.md"),
            "reports/ui_summary.md": str(reports_dir / "ui_summary.md"),
        },
    }


__all__ = [
    "EXEC_MIN_BYTES",
    "PolishContext",
    "PolishError",
    "PolishRefusalError",
    "run_polish",
]
