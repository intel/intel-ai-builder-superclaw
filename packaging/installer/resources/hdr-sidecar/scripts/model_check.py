"""Per-phase Hybrid Deep Research compatibility check for cloud models.

Replays every cloud-model phase of the HDR pipeline against one or more models
and reports, per phase, whether the sidecar's own parser accepted the model's
real output. Inputs come from a completed HDR session directory, so each phase
sees realistic material without running the whole pipeline.

Calls go through a running llmrouter_manager. A ``provider:model`` target is
sent to ``/v1/chat/completions/pinned`` (API-key providers only, needs the
host inference key); the target ``cloud-model`` uses the user's current
selection, which is the only way to reach an OAuth provider such as Copilot.

    $env:LRM_API_KEY = "<host inference key>"
    python scripts/model_check.py --fixture <session dir> --query "<that session's query>" \
        --target openrouter:z-ai/glm-5 --target deepseek:deepseek-flash
"""

from __future__ import annotations

import argparse
import asyncio
import io
import json
import re
import shutil
import sys
import tempfile
import time
from collections.abc import Awaitable, Callable
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import httpx

from hybrid_dr_orchestrator.delims import normalize_delims
from hybrid_dr_orchestrator.llm import (
    PHASE_SECTION_WRITE_REVIEWER,
    PHASE_SECTION_WRITE_WRITER,
    CompletionRequest,
    CompletionResponse,
    HTTPLLMClient,
    Message,
)
from hybrid_dr_orchestrator.nodes.conclusion import (
    DEFAULT_ANGLES,
    ConclusionContext,
    _read_sections,
    _score_candidates,
    _write_one_candidate,
)
from hybrid_dr_orchestrator.nodes.input_web import (
    InputWebContext,
    _derive_subquestions,
    _synthesize_one,
)
from hybrid_dr_orchestrator.nodes.plan import PlanContext, run_plan
from hybrid_dr_orchestrator.nodes.polish import PolishContext, run_polish
from hybrid_dr_orchestrator.nodes.section_write import (
    SectionWriteContext,
    _parse_reviewer_output,
    _parse_writer_output,
)
from hybrid_dr_orchestrator.prompts import load_prompt
from hybrid_dr_orchestrator.state import PipelineState

PHASES = ("derive", "synthesize", "plan", "writer", "reviewer", "conclusion", "scorer", "polish")
_STOP = {
    "the", "and", "for", "with", "what", "how", "why", "please", "research",
    "along", "similar", "range", "compare", "versus",
}  # fmt: skip
_FIXTURE_FILES = (
    "cloud_intermediate/plan.json",
    "cloud_intermediate/conclusions/cand_1.md",
    "cloud_intermediate/conclusions/cand_2.md",
    "local_intermediate/assembled_report.md",
    "local_intermediate/polish_skeleton.json",
)


@dataclass(frozen=True)
class Target:
    label: str
    provider: str | None
    model: str | None


@dataclass
class PhaseResult:
    phase: str
    ok: bool
    reason: str
    finish_reason: str | None = None
    completion_tokens: int | None = None
    reasoning_tokens: int | None = None
    calls: int = 0
    seconds: float = 0.0
    excerpt: str = ""


class _PinningTransport(httpx.AsyncBaseTransport):
    """Redirects the sidecar's alias calls to the pinned route and records every raw response."""

    def __init__(self, target: Target) -> None:
        self._inner = httpx.AsyncHTTPTransport()
        self._target = target
        self.responses: list[dict[str, Any] | None] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        if self._target.provider and request.url.path.endswith("/v1/chat/completions"):
            body = json.loads(request.content)
            body.update(
                provider=self._target.provider,
                model=self._target.model,
                usage_alias="hdr-model-check",
            )
            headers = {k: v for k, v in request.headers.items() if k.lower() != "content-length"}
            request = httpx.Request(
                request.method,
                request.url.copy_with(path=request.url.path + "/pinned"),
                headers=headers,
                content=json.dumps(body).encode(),
                extensions=request.extensions,
            )
        response = await self._inner.handle_async_request(request)
        await response.aread()
        try:
            self.responses.append(json.loads(response.content))
        except ValueError:
            self.responses.append(None)
        return response

    async def aclose(self) -> None:
        await self._inner.aclose()


class _RecordingLLM:
    """The production client, keeping the last parsed response so phases are judged on it."""

    def __init__(self, inner: HTTPLLMClient) -> None:
        self._inner = inner
        self.last: CompletionResponse | None = None

    async def complete(self, req: CompletionRequest) -> CompletionResponse:
        self.last = None
        self.last = await self._inner.complete(req)
        return self.last

    def content(self) -> str:
        return self.last.content if self.last else ""

    async def aclose(self) -> None:
        await self._inner.aclose()


def _raw_excerpt(data: dict[str, Any] | None) -> str:
    """What the upstream actually sent, for failure reports (not for judging)."""
    if not data or not data.get("choices"):
        return json.dumps(data)[:400] if data else ""
    msg = data["choices"][0].get("message") or {}
    for call in msg.get("tool_calls") or []:
        args = (call.get("function") or {}).get("arguments")
        if isinstance(args, str) and args.strip():
            return args
    return str(msg.get("content") or msg.get("reasoning") or msg.get("reasoning_content") or "")


def _summarize(result: PhaseResult, responses: list[dict[str, Any] | None]) -> PhaseResult:
    result.calls = len(responses)
    last = responses[-1] if responses else None
    if last and last.get("choices"):
        result.finish_reason = last["choices"][0].get("finish_reason")
        usage = last.get("usage") or {}
        result.completion_tokens = usage.get("completion_tokens")
        result.reasoning_tokens = (usage.get("completion_tokens_details") or {}).get(
            "reasoning_tokens"
        )
    if not result.ok:
        result.excerpt = re.sub(r"\s+", " ", _raw_excerpt(last))[:240]
    return result


def _tokens(text: str) -> set[str]:
    return set(re.findall(r"[a-z0-9]{3,}", text.lower())) - _STOP


def _has_block(text: str, keyword: str) -> bool:
    normalized = normalize_delims(text, [keyword, "END"])
    return f"==={keyword}===" in normalized and "===END===" in normalized


class Fixture:
    def __init__(self, root: Path, query: str) -> None:
        missing = [p for p in _FIXTURE_FILES if not (root / p).is_file()]
        self.web_dir = root / "cloud_intermediate" / "insights" / "web"
        self.sections_dir = root / "cloud_intermediate" / "sections"
        if not list(self.web_dir.glob("W-*.md")):
            missing.append("cloud_intermediate/insights/web/W-*.md")
        if not list(self.sections_dir.glob("S*_final.md")):
            missing.append("cloud_intermediate/sections/S*_final.md")
        if missing:
            raise SystemExit(f"fixture {root} is not a completed HDR session; missing: {missing}")
        self.query = query
        self.plan = json.loads((root / _FIXTURE_FILES[0]).read_text(encoding="utf-8"))
        self.candidates = [
            (DEFAULT_ANGLES[i], (root / _FIXTURE_FILES[1 + i]).read_text(encoding="utf-8"))
            for i in range(2)
        ]
        self.local_dir = root / "local_intermediate"
        self.web = {
            p.stem: p.read_text(encoding="utf-8") for p in sorted(self.web_dir.glob("W-*.md"))
        }

    def hits(self) -> list[dict[str, str]]:
        out = []
        for body in self.web.values():
            title = re.search(r"^title:\s*(.+)$", body, re.MULTILINE)
            url = re.search(r"https?://\S+", body)
            out.append(
                {
                    "title": title.group(1).strip() if title else "",
                    "url": url.group(0).rstrip(").,") if url else "",
                    "snippet": body[:600],
                }
            )
        return out


async def _check(
    target: Target, fx: Fixture, lrm_url: str, phases: tuple[str, ...]
) -> list[PhaseResult]:
    transport = _PinningTransport(target)
    client = HTTPLLMClient(base_url=lrm_url)
    # The production client is reused for its request shaping and content
    # extraction; only its transport is swapped to reach the pinned route.
    await client._client.aclose()
    # egress-surface: hdr_lrm_chat
    client._client = httpx.AsyncClient(
        transport=transport,
        timeout=httpx.Timeout(connect=8.0, read=420.0, write=30.0, pool=30.0),
    )
    llm = _RecordingLLM(client)
    results: list[PhaseResult] = []
    queries: list[str] = []
    section = fx.plan["sections"][0]
    web_ids = [w for w in section.get("web_sources") or [] if w in fx.web] or list(fx.web)
    web_bodies = {w: fx.web[w] for w in web_ids}
    first_section = sorted(fx.sections_dir.glob("S*_final.md"))[0].read_text(encoding="utf-8")
    body_text = _read_sections(fx.sections_dir)
    target_words = int(section.get("target_words") or SectionWriteContext.target_words_default)

    async def run(phase: str, fn: Callable[[PhaseResult], Awaitable[None]]) -> None:
        if phase not in phases:
            return
        start = len(transport.responses)
        t0 = time.perf_counter()
        result = PhaseResult(phase=phase, ok=False, reason="")
        try:
            await fn(result)
        except Exception as exc:  # one phase's failure is a result, not a reason to stop
            result.ok, result.reason = False, f"{type(exc).__name__}: {str(exc)[:160]}"
        result.seconds = round(time.perf_counter() - t0, 1)
        if result.ok and transport.responses[start:]:
            last = transport.responses[-1] or {}
            if (last.get("choices") or [{}])[0].get("finish_reason") == "length":
                result.ok, result.reason = False, "finish_reason=length (output truncated)"
        results.append(_summarize(result, transport.responses[start:]))

    async def derive(r: PhaseResult) -> None:
        got = await _derive_subquestions(
            llm=llm,
            model="cloud-model",
            endpoint=None,
            user_query=fx.query,
            n=5,
            max_tokens=InputWebContext.max_tokens // 4,
        )
        # Like production, skip the overlap test when the query has no usable
        # tokens (e.g. a Chinese-only question).
        query_tokens = _tokens(fx.query)
        relevant = [q for q in got if not query_tokens or _tokens(q) & query_tokens]
        queries.extend(relevant)
        r.ok = len(relevant) >= 3 and got != [fx.query]
        r.reason = f"{len(relevant)}/{len(got)} relevant queries: {got[:3]}"

    async def synthesize(r: PhaseResult) -> None:
        await _synthesize_one(
            llm=llm,
            model="cloud-model",
            endpoint=None,
            max_tokens=InputWebContext.max_tokens,
            topic=queries[0] if queries else fx.query,
            hits=fx.hits(),
        )
        r.ok = _has_block(llm.content(), "INSIGHT")
        r.reason = (
            "strict: INSIGHT block present"
            if r.ok
            else "strict: no ===INSIGHT=== ... ===END=== block"
        )

    async def plan(r: PhaseResult) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            web = Path(tmp) / "web"
            shutil.copytree(fx.web_dir, web)
            ctx = PlanContext(
                user_query=fx.query,
                web_insights_dir=web,
                local_insights_dir=Path(tmp) / "local",
                cloud_intermediate_dir=Path(tmp) / "ci",
                llm=llm,
            )
            start = len(transport.responses)
            await run_plan(PipelineState(task_id="model-check"), ctx)
            r.ok = True
            r.reason = (
                "forced tool call"
                if len(transport.responses) - start == 1
                else "needed tool_choice=auto fallback"
            )

    async def writer(r: PhaseResult) -> None:
        user = json.dumps(
            {
                "section_id": "S1",
                "title": section["title"],
                "target_words": target_words,
                "web_sources_ids": web_ids,
                "local_data_hints": list(section.get("local_data_hints") or []),
                "attempt": 1,
                "reviewer_feedback": None,
                "web_sources_bodies": web_bodies,
            },
            indent=2,
        )
        resp = await llm.complete(
            CompletionRequest(
                messages=[Message("system", load_prompt("section_writer")), Message("user", user)],
                model="cloud-model",
                max_tokens=SectionWriteContext.max_tokens_writer,
                temperature=0.5,
                phase=PHASE_SECTION_WRITE_WRITER,
            )
        )
        _parse_writer_output(resp.content)
        r.ok = _has_block(resp.content, "SECTION")
        r.reason = (
            "strict: SECTION block present"
            if r.ok
            else "strict: body accepted only by the lenient fallback (no ===SECTION=== block)"
        )

    async def reviewer(r: PhaseResult) -> None:
        user = json.dumps(
            {
                "section_id": "S1",
                "title": section["title"],
                "target_words": target_words,
                "web_sources_ids": web_ids,
                "web_sources_bodies": web_bodies,
                "attempt_body": first_section,
            },
            indent=2,
        )
        resp = await llm.complete(
            CompletionRequest(
                messages=[
                    Message("system", load_prompt("section_reviewer")),
                    Message("user", user),
                ],
                model="cloud-model",
                max_tokens=SectionWriteContext.max_tokens_reviewer,
                temperature=0.0,
                phase=PHASE_SECTION_WRITE_REVIEWER,
            )
        )
        verdict = _parse_reviewer_output(resp.content)
        r.ok = not any("unparseable" in str(i) for i in verdict["issues"])
        r.reason = (
            f"passed={verdict['passed']} score={verdict['score']}"
            if r.ok
            else "verdict unparseable (defaults to pass)"
        )

    async def conclusion(r: PhaseResult) -> None:
        await _write_one_candidate(
            llm=llm,
            model="cloud-model",
            endpoint=None,
            max_tokens=ConclusionContext.max_tokens_writer,
            body_text=body_text,
            angle=DEFAULT_ANGLES[0],
        )
        r.ok = _has_block(llm.content(), "CONCLUSION")
        r.reason = (
            "strict: CONCLUSION block present" if r.ok else "strict: no ===CONCLUSION=== block"
        )

    async def scorer(r: PhaseResult) -> None:
        _winner, scoring = await _score_candidates(
            llm=llm,
            model="cloud-model",
            endpoint=None,
            max_tokens=ConclusionContext.max_tokens_scorer,
            body_text=body_text,
            candidates=fx.candidates,
        )
        chosen = scoring["chosen_index"]
        if "unparseable" in scoring["reason"]:
            r.reason = "scoring unparseable (defaults to first candidate)"
        elif not 1 <= chosen <= len(fx.candidates):
            r.reason = f"chose cand_{chosen} of {len(fx.candidates)} (production rejects it)"
        else:
            r.ok = True
            r.reason = f"chose cand_{chosen}"

    async def polish(r: PhaseResult) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            local = Path(tmp) / "local_intermediate"
            local.mkdir()
            for name in ("assembled_report.md", "polish_skeleton.json"):
                shutil.copy2(fx.local_dir / name, local / name)
            await run_polish(
                PipelineState(task_id="model-check"),
                PolishContext(
                    local_intermediate_dir=local,
                    polish_skeleton_path=local / "polish_skeleton.json",
                    llm=llm,
                ),
            )
            r.ok = True
            r.reason = "executive report accepted"

    checks = (derive, synthesize, plan, writer, reviewer, conclusion, scorer, polish)
    for name, fn in zip(PHASES, checks, strict=True):
        await run(name, fn)
    await llm.aclose()
    await transport.aclose()
    return results


def _parse_target(spec: str) -> Target:
    if spec == "cloud-model":
        return Target(label="cloud-model (current selection)", provider=None, model=None)
    provider, sep, model = spec.partition(":")
    if not sep or not provider or not model:
        raise SystemExit(f"--target must be 'provider:model' or 'cloud-model', got {spec!r}")
    return Target(label=f"{provider}:{model}", provider=provider, model=model)


def _render(all_results: dict[str, list[PhaseResult]], phases: tuple[str, ...]) -> str:
    lines = ["| model | " + " | ".join(phases) + " |", "|---|" + "---|" * len(phases)]
    for label, results in all_results.items():
        by_phase = {r.phase: r for r in results}
        cells = ["pass" if by_phase[p].ok else "**FAIL**" for p in phases if p in by_phase]
        lines.append(f"| `{label}` | " + " | ".join(cells) + " |")
    lines.append("")
    for label, results in all_results.items():
        for r in results:
            if not r.ok:
                lines.append(
                    f"- `{label}` **{r.phase}**: {r.reason} (finish={r.finish_reason}, "
                    f"completion={r.completion_tokens}, reasoning={r.reasoning_tokens}, calls={r.calls})"
                    + (f" - `{r.excerpt}`" if r.excerpt else "")
                )
    return "\n".join(lines)


async def _main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--fixture", type=Path, required=True, help="a completed HDR session directory"
    )
    parser.add_argument(
        "--query", required=True, help="the user query that fixture session answered"
    )
    parser.add_argument(
        "--target", action="append", required=True, help="provider:model, or cloud-model"
    )
    parser.add_argument(
        "--lrm", default="http://127.0.0.1:18321", help="llmrouter_manager base URL"
    )
    parser.add_argument("--phases", default=",".join(PHASES))
    parser.add_argument("--out", type=Path, help="write raw results as JSON")
    args = parser.parse_args()
    phases = tuple(p.strip() for p in args.phases.split(",") if p.strip())
    unknown = [p for p in phases if p not in PHASES]
    if unknown or not phases:
        parser.error(f"--phases must name one or more of {', '.join(PHASES)}; got {args.phases!r}")
    fx = Fixture(args.fixture, args.query)
    all_results: dict[str, list[PhaseResult]] = {}
    for spec in args.target:
        target = _parse_target(spec)
        print(f"checking {target.label} ...", file=sys.stderr, flush=True)
        all_results[target.label] = await _check(target, fx, args.lrm.rstrip("/"), phases)
    if args.out:
        args.out.write_text(
            json.dumps({k: [asdict(r) for r in v] for k, v in all_results.items()}, indent=2),
            encoding="utf-8",
        )
    if isinstance(sys.stdout, io.TextIOWrapper):
        sys.stdout.reconfigure(encoding="utf-8")
    print(_render(all_results, phases))
    return 0 if all(r.ok for v in all_results.values() for r in v) else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_main()))
