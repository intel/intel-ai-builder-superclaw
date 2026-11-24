"""plan phase node — one LLM call, produces plan.json.

Strangler-fig phase #6. Single cloud LLM call; reads upstream insight
summaries; outputs the section plan that section_write will consume one
section at a time.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..json_repair import loads_lenient
from ..llm import (
    PHASE_PLAN,
    CompletionRequest,
    CompletionResponse,
    LLMClient,
    LLMEndpointConfig,
    Message,
)
from ..prompts import load_prompt
from ..state import Phase, PipelineState, PrivacyTier


# ───── exceptions ──────────────────────────────────────────────────────


class PlanError(Exception):
    """plan-phase failure."""


# ───── context ─────────────────────────────────────────────────────────


@dataclass(frozen=True)
class PlanContext:
    user_query: str
    web_insights_dir: Path
    local_insights_dir: Path
    cloud_intermediate_dir: Path
    """Where plan.json is written."""

    llm: LLMClient

    max_sections: int = 5
    expected_length_words: str = "1500-2500"
    model: str = "cloud-model"
    endpoint: LLMEndpointConfig | None = None
    # 8192 (was 4096): thinking/reasoning models (kimi-k3, glm-5, ...) spend part
    # of the completion budget on reasoning tokens (OpenRouter counts them in
    # completion_tokens), so at 4096 a heavy reasoning pass leaves the plan JSON
    # truncated -> "plan JSON does not parse". The plan output itself is small
    # (~1-1.5k tokens); the extra headroom is for the reasoning prefix. Matches
    # polish.py's 8192. Per-request only; does not touch shared router state.
    max_tokens: int = 8192


# ───── parser ──────────────────────────────────────────────────────────


_PLAN_RE = re.compile(
    r"===PLAN===\s*(?P<plan>.*?)\s*===END===",
    re.DOTALL,
)


_REQUIRED_SECTION_KEYS = (
    "id",
    "title",
    "type",
    "web_sources",
    "local_data_hints",
    "outline",
    "target_words",
)


# Forced tool call (tools + tool_choice) so the model must return a
# schema-valid plan via a function call rather than the free-text
# ===PLAN===/===END=== contract. This makes the planner robust to
# reasoning-first cloud models (e.g. Opus 4.8) that otherwise return prose.
# llmrouter whitelists tools/tool_choice (cloud/dispatch.py) and LiteLLM
# translates them to each vendor's native format (Anthropic tool_use,
# OpenAI/openrouter function calling); drop_params=True degrades to plain
# content on providers without function calling, where _parse_plan still runs
# on the content as before, so this is additive. response_format is
# deliberately avoided because llmrouter drops it (not in the whitelist).
_PLAN_PARAMETERS: dict[str, Any] = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "sections": {
            "type": "array",
            "minItems": 1,
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "title": {"type": "string"},
                    "type": {"type": "string", "enum": ["cloud", "local", "hybrid"]},
                    "web_sources": {"type": "array", "items": {"type": "string"}},
                    "local_data_hints": {"type": "array", "items": {"type": "string"}},
                    "outline": {"type": "array", "items": {"type": "string"}},
                    "target_words": {"type": "integer"},
                },
                "required": list(_REQUIRED_SECTION_KEYS),
                "additionalProperties": False,
            },
        },
    },
    "required": ["title", "sections"],
    "additionalProperties": False,
}
PLAN_TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "emit_plan",
            "description": "Emit the hybrid deep-research section plan as a structured object.",
            "parameters": _PLAN_PARAMETERS,
        },
    }
]
PLAN_TOOL_CHOICE: dict[str, Any] = {"type": "function", "function": {"name": "emit_plan"}}


def _parse_plan(text: str) -> dict[str, Any]:
    m = _PLAN_RE.search(text)
    raw = m.group("plan") if m is not None else text
    # Models sometimes wrap the plan JSON in a ```json code fence even inside
    # the ===PLAN=== / ===END=== delimiters, which the delimiter path used to
    # pass through verbatim, so loads_lenient choked on the leading fence.
    # Strip fences and isolate the JSON object for both the delimited and the
    # fallback case.
    cleaned = re.sub(r"```(?:json)?\s*", "", raw)
    cleaned = re.sub(r"```", "", cleaned)
    obj_match = re.search(r"\{.*\}", cleaned, flags=re.DOTALL)
    if obj_match is None:
        raise PlanError(
            "planner output missing required ===PLAN=== / ===END=== "
            "delimiters and no JSON object found"
        )
    plan_str = obj_match.group(0)
    try:
        plan = loads_lenient(plan_str)
    except json.JSONDecodeError as e:
        snippet = plan_str.strip().replace("\n", "\\n")[:600]
        raise PlanError(f"plan JSON does not parse: {e}; got: {snippet}") from e
    if not isinstance(plan, dict):
        raise PlanError(f"plan must be a JSON object; got {type(plan).__name__}")
    # Some providers emit the emit_plan tool-call arguments with the WHOLE plan
    # re-encoded as a JSON *string* nested under a single key:
    # {"sections": "<plan>"} (anthropic/claude-sonnet-5 via openrouter/litellm,
    # #1502-family) or {"arguments": "<plan>"} (recursive/flint-v1.0 via
    # openrouter). Unwrap one level when that string parses to the real plan.
    wrapped = plan.get("sections")
    if not isinstance(wrapped, str) and len(plan) == 1:
        wrapped = next(iter(plan.values()))
    if isinstance(wrapped, str):
        try:
            inner = loads_lenient(wrapped)
        except json.JSONDecodeError:
            inner = None
        if isinstance(inner, dict) and isinstance(inner.get("sections"), list):
            plan = inner
    if "sections" not in plan or not isinstance(plan["sections"], list):
        raise PlanError("plan missing 'sections' array")
    if len(plan["sections"]) == 0:
        raise PlanError("plan has empty sections[]")
    for i, sec in enumerate(plan["sections"]):
        if not isinstance(sec, dict):
            raise PlanError(f"sections[{i}] is not an object")
        for key in _REQUIRED_SECTION_KEYS:
            if key not in sec:
                raise PlanError(f"sections[{i}] missing required key {key!r}")
        # Normalize the section id to the canonical sequential form rather than
        # rejecting it. Weaker models (e.g. Qwen3-Coder-Next) emit varied id
        # formats such as "S-001" or "section_1"; the downstream pipeline only
        # needs a stable sequential id and never cross-references these ids, so
        # renumber instead of raising PlanError (#1502).
        sec["id"] = f"S{i + 1}"
    return plan


# ───── insight summaries ────────────────────────────────────────────────


_PREVIEW_BYTES = 500


def _summarize_insights(directory: Path, prefix: str) -> list[dict[str, str]]:
    """Return [{id, summary}, ...] where summary is the first
    _PREVIEW_BYTES of each <prefix>-NNN.md file. We avoid sending whole
    sheets to the planner because the planner only needs the topic
    coverage, not the facts."""
    out: list[dict[str, str]] = []
    if not directory.exists():
        return out
    for path in sorted(directory.iterdir()):
        if (
            not path.is_file()
            or not path.name.startswith(f"{prefix}-")
            or not path.name.endswith(".md")
        ):
            continue
        body = path.read_text(encoding="utf-8", errors="replace")
        out.append({"id": path.stem, "summary": body[:_PREVIEW_BYTES]})
    return out


def _local_catalog(directory: Path) -> list[dict[str, str]]:
    """Return [{id, source_file}, ...] for L-NNN.md sheets, reading ONLY
    the ``title:`` frontmatter line (filename), never the body.

    This is the Tier-2 ("L2") representation of the local-insights dir:
    the cloud planner is allowed to know which local files exist and
    their filenames (so it can map user-prompt phrases like "from our
    internal vendor contracts" onto a section), but it must never see
    body content or even body summaries.

    The ``title:`` line is written by ``input_local.run_input_local``
    as ``title: <original-filename>``. We stop reading at the first
    blank line so body bytes can never leak into the cloud payload
    even if a file is malformed.
    """
    out: list[dict[str, str]] = []
    if not directory.exists():
        return out
    for path in sorted(directory.iterdir()):
        if not path.is_file() or not path.name.startswith("L-") or not path.name.endswith(".md"):
            continue
        source_file = path.name  # safe default
        try:
            with path.open("r", encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    stripped = line.rstrip("\n")
                    if stripped == "":
                        # End of frontmatter — stop before body bytes are read.
                        break
                    if stripped.startswith("title:"):
                        source_file = stripped[len("title:") :].strip() or path.name
                        break
        except OSError:
            pass
        out.append({"id": path.stem, "source_file": source_file})
    return out


def _resolve_web_sources(plan: dict[str, Any], available_ids: list[str]) -> None:
    """Keep only real W-NNN ids in each section's web_sources.

    section_write loads sources by id and silently skips unknown ones, so a
    planner that names sources in prose ("NVIDIA product page") leaves every
    writer with no material. A section whose requested sources all fail to
    resolve, or that has neither web sources nor local hints, gets every web
    insight instead.
    """
    known = set(available_ids)
    for sec in plan["sections"]:
        raw = sec["web_sources"] if isinstance(sec["web_sources"], list) else []
        valid = [w for w in raw if isinstance(w, str) and w in known]
        if not valid and (raw or not sec["local_data_hints"]):
            valid = list(available_ids)
        sec["web_sources"] = valid


# ───── the node ────────────────────────────────────────────────────────


async def run_plan(state: PipelineState, ctx: PlanContext) -> dict[str, Any]:
    web_summary = _summarize_insights(ctx.web_insights_dir, "W")

    # Privacy contract: at L2 the cloud planner must not see L-NNN body
    # content or any derived summary of it (see PrivacyTier docstring in
    # state.py). At L0 the body preview is fair game. We deliberately
    # branch here on the deterministic state field rather than trusting
    # downstream code (or the LLM) to redact, so the contract is a
    # property of the request shape, not a behaviour to be reviewed.
    user_payload: dict[str, Any] = {
        "user_query": ctx.user_query,
        "max_sections": ctx.max_sections,
        "expected_length_words": ctx.expected_length_words,
        "web_insights_summary": web_summary,
    }
    if state.privacy_tier == PrivacyTier.L2:
        user_payload["local_hints_in_scope"] = _local_catalog(ctx.local_insights_dir)
    else:
        user_payload["local_insights_summary"] = _summarize_insights(ctx.local_insights_dir, "L")

    system = load_prompt("planner")
    user = json.dumps(user_payload, indent=2)

    messages = [
        Message(role="system", content=system),
        Message(role="user", content=user),
    ]

    async def _call(tool_choice: dict[str, Any] | str) -> "CompletionResponse":
        return await ctx.llm.complete(
            CompletionRequest(
                messages=messages,
                model=ctx.model,
                endpoint=ctx.endpoint,
                max_tokens=ctx.max_tokens,
                temperature=0.2,
                tools=PLAN_TOOLS,
                tool_choice=tool_choice,
                phase=PHASE_PLAN,
            )
        )

    # Forced tool_choice (PLAN_TOOL_CHOICE) makes non-thinking models emit a
    # schema-valid plan instead of prose. But thinking/reasoning models reject a
    # forced tool_choice at the vendor: kimi-k3/Moonshot returns 400
    # "tool_choice 'specified' is incompatible with thinking enabled", and the
    # same restriction holds for Anthropic (Claude thinking) and other reasoners
    # -- with reasoning on, only tool_choice auto/none is allowed (see Anthropic
    # extended-thinking docs, pydantic-ai #2425, langchain-aws #647, opencode
    # #15226). Fall back to "auto" when the forced call errors OR its output does
    # not parse: the planner prompt also documents the ===PLAN=== text contract,
    # so _parse_plan recovers whether the model calls emit_plan or answers in
    # content. This is per-request only -- it never mutates shared router state.
    try:
        resp = await _call(PLAN_TOOL_CHOICE)
        plan = _parse_plan(resp.content)
    except Exception:
        resp = await _call("auto")
        plan = _parse_plan(resp.content)

    if len(plan["sections"]) > ctx.max_sections:
        raise PlanError(
            f"planner produced {len(plan['sections'])} sections; max_sections={ctx.max_sections}"
        )
    _resolve_web_sources(plan, [w["id"] for w in web_summary])

    ctx.cloud_intermediate_dir.mkdir(parents=True, exist_ok=True)
    plan_path = ctx.cloud_intermediate_dir / "plan.json"
    plan_path.write_bytes(json.dumps(plan, indent=2).encode("utf-8"))

    return {
        "current_phase": Phase.SECTION_WRITE,
        "completed_phases": [*state.completed_phases, Phase.PLAN],
        "artifacts": {**state.artifacts, "plan.json": str(plan_path)},
        "extras": {**state.extras, "plan_section_count": len(plan["sections"])},
    }


__all__ = ["PlanContext", "PlanError", "run_plan"]
