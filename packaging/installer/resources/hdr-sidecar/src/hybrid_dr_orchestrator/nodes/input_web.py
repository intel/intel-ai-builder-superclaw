"""input_web phase node — derive sub-questions, search, synthesize W-NNN.md."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..json_repair import loads_lenient
from ..llm import (
    PHASE_INPUT_WEB_DERIVE,
    PHASE_INPUT_WEB_SYNTHESIZE,
    CompletionRequest,
    LLMClient,
    LLMEndpointConfig,
    Message,
)
from ..prompts import load_prompt
from ..search import SearchClient
from ..state import Phase, PipelineState


logger = logging.getLogger("uvicorn.error")


def _query_fp(query: str) -> str:
    return hashlib.sha256(query.encode("utf-8", errors="replace")).hexdigest()[:12]


class InputWebError(Exception):
    """input_web-phase failure."""


@dataclass(frozen=True)
class InputWebContext:
    user_query: str
    web_insights_dir: Path

    llm: LLMClient
    search: SearchClient

    n_subquestions: int = 5
    hits_per_query: int = 8
    model: str = "cloud-model"
    endpoint: LLMEndpointConfig | None = None
    # Ceilings, not costs. Reasoning models spend the completion budget thinking
    # before they answer; at 2048 (512 for derive, a quarter of this) they
    # stopped on finish_reason=length with no answer.
    max_tokens: int = 8192
    concurrency: int = 3
    # One W-NNN.json per query ({query, results: [{title, url}]}), written as
    # each search returns so the SuperClaw tool can show HDR's web searches
    # while the phase runs. Snippets are not kept. None writes nothing.
    web_searches_dir: Path | None = None


def _write_search_record(directory: Path, wid: str, query: str, hits: list[dict[str, str]]) -> None:
    record = {
        "query": query,
        "results": [{"title": hit["title"], "url": hit["url"]} for hit in hits],
    }
    path = directory / f"{wid}.json"
    tmp = directory / f"{wid}.json.tmp"
    try:
        tmp.write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")
        tmp.replace(path)
    except OSError as exc:
        logger.warning(
            "hybrid_dr.input_web.search_record.failed wid=%s error=%s", wid, type(exc).__name__
        )


_INSIGHT_RE = re.compile(
    r"===INSIGHT===\s*(?P<body>.*?)\s*===END===",
    re.DOTALL,
)

_FRONT_TITLE_RE = re.compile(r"^title:\s*(.+)$", re.MULTILINE)
_FRONT_URL_RE = re.compile(r"^url:\s*(.+)$", re.MULTILINE)


def _parse_insight(text: str) -> str:
    m = _INSIGHT_RE.search(text)
    if m is not None:
        body = m.group("body").strip()
    else:
        cleaned = text.strip()
        cleaned = re.sub(r"```(?:markdown|md)?\s*", "", cleaned)
        cleaned = re.sub(r"```", "", cleaned)
        cleaned = re.sub(r"===\s*INSIGHT\s*===", "", cleaned)
        cleaned = re.sub(r"===\s*END\s*===", "", cleaned)
        body = cleaned.strip()
    # Frontmatter is best-effort. Synthesize minimal title: / url: lines
    # when the model omits them so downstream readers don't crash on a
    # technicality.
    has_title = bool(_FRONT_TITLE_RE.search(body))
    has_url = bool(_FRONT_URL_RE.search(body))
    if not has_title or not has_url:
        first_line = next(
            (line.strip() for line in body.splitlines() if line.strip()),
            "Untitled web insight",
        )
        # Strip leading markdown heading markers so the title looks clean.
        synthesized_title = re.sub(r"^#+\s*", "", first_line)[:120]
        synthesized_url = ""
        # Try to scrape the first URL out of the body; otherwise leave blank.
        url_match = re.search(r"https?://\S+", body)
        if url_match:
            synthesized_url = url_match.group(0)
        prefix_parts = []
        if not has_title:
            prefix_parts.append(f"title: {synthesized_title}")
        if not has_url:
            prefix_parts.append(f"url: {synthesized_url}")
        body = "\n".join(prefix_parts) + "\n\n" + body
    return body


async def _derive_subquestions(
    *,
    llm: LLMClient,
    model: str,
    endpoint: LLMEndpointConfig | None,
    user_query: str,
    n: int,
    max_tokens: int,
) -> list[str]:
    """Ask the LLM for N focused sub-questions to search on."""
    # Phrase the instruction in a way that does NOT prime the model with
    # vocabulary it could mistake for the topic itself. Avoid words like
    # "queries", "draft", "select", "ranking", "research" — glm-5 in
    # particular will happily lift those into its search terms when in
    # markdown-drafting mode.
    system = (
        "Return a JSON array of strings about the user's topic.\n"
        "\n"
        "Each string is a phrase a search engine would accept (5-15 words). "
        "Each phrase must be directly about the user's actual subject "
        "matter — about people, places, events, technologies, organizations, "
        "or concepts that appear in or naturally extend the user's text. "
        "Never paraphrase the user's instructions, the output format, or "
        "anything about how the array should look.\n"
        "\n"
        "OUTPUT CONTRACT:\n"
        "  - Exactly N entries.\n"
        "  - The very first character is '['. The very last is ']'.\n"
        "  - No prose, no commentary, no headings, no markdown.\n"
        "\n"
        "Example:\n"
        '  user input: {"user_query": "what is quantum entanglement", "n": 3}\n'
        "  your output:\n"
        '  ["quantum entanglement physics explanation",'
        ' "Bell inequality experimental tests history",'
        ' "quantum entanglement applications quantum cryptography"]\n'
    )
    user = json.dumps({"user_query": user_query, "n": n})
    resp = await llm.complete(
        CompletionRequest(
            messages=[
                Message(role="system", content=system),
                Message(role="user", content=user),
            ],
            model=model,
            endpoint=endpoint,
            max_tokens=max_tokens,
            temperature=0.2,
            phase=PHASE_INPUT_WEB_DERIVE,
        )
    )
    text = resp.content.strip()
    # Strip llmrouter's `[provider/model]` response prefix (show_model_prefix=true).
    text = re.sub(r"^\[[\w./:-]+\]\s*", "", text)
    # Strip <think>...</think> reasoning blocks emitted by some models.
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()
    # Tolerate the model wrapping the array in code fences anywhere.
    text = re.sub(r"```(?:json)?\s*", "", text)
    text = re.sub(r"```", "", text).strip()

    queries: list[str] | None = None

    # Try 1: outermost [...] JSON array.
    bracket_match = re.search(r"\[\s*(?:\".*?\"\s*,?\s*)+\]", text, flags=re.DOTALL)
    if bracket_match:
        try:
            parsed = loads_lenient(bracket_match.group(0))
            if isinstance(parsed, list) and all(isinstance(q, str) for q in parsed):
                queries = parsed
        except json.JSONDecodeError:
            queries = None

    # Meta-instruction headers the model often emits while drafting in
    # markdown. Skip these so we don't end up searching the web for
    # "User Query" or "Output Format".
    _META_PHRASES = (
        "analyze the request",
        "user query",
        "n:",
        "goal:",
        "output format",
        "output contract",
        "instructions:",
        "approach:",
        "step ",
        "step:",
        "draft:",
        "plan:",
        "research queries",
        "queries:",
    )

    def _clean_item(raw: str) -> str:
        cleaned = re.sub(r"\*\*|\*|`|^[\"“”']|[\"“”']$", "", raw)
        return cleaned.strip().strip(",.;:")

    def _is_meta(s: str) -> bool:
        low = s.lower()
        if any(low.startswith(phrase) for phrase in _META_PHRASES):
            return True
        # Lines that look like field/value headers (e.g. "N: 3") are meta.
        if re.match(r"^[A-Z][\w\s]{0,15}:\s", s):
            return True
        return False

    # Try 2: numbered list `1. ...\n2. ...` (glm-5 sometimes drafts as
    # markdown despite the instruction).
    if queries is None:
        items: list[str] = []
        for line_match in re.finditer(r"^\s*\d+[.)\s]\s*(.+?)\s*$", text, flags=re.MULTILINE):
            raw = _clean_item(line_match.group(1).strip())
            if raw and not _is_meta(raw) and len(raw) > 8:
                items.append(raw)
        if items:
            queries = items

    # Try 3: bullet list `- ...` or `* ...`.
    if queries is None:
        items = []
        for line_match in re.finditer(r"^\s*[-*]\s+(.+?)\s*$", text, flags=re.MULTILINE):
            raw = _clean_item(line_match.group(1).strip())
            if raw and not _is_meta(raw) and len(raw) > 8:
                items.append(raw)
        if items:
            queries = items

    # Try 4: extract any quoted strings the model emitted. Salvages the
    # truncated-JSON-array case where the closing `]` never arrived and
    # Try 1's strict bracket regex fails to match. Restricted to non-meta
    # entries of plausible length so we don't pick up boilerplate.
    if queries is None:
        items = []
        for q_match in re.finditer(r'"([^"]{8,200})"', text):
            raw = _clean_item(q_match.group(1).strip())
            if raw and not _is_meta(raw):
                items.append(raw)
        if items:
            queries = items

    # Final fallback: synthesize a single query from the user_query so the
    # pipeline can keep advancing instead of hard-failing on a JSON quibble.
    # Triggered when the LLM ignores the contract entirely (refuses, delegates,
    # produces prose) — the safety net below also catches the empty-after-
    # filter case but only when something parsed in the first place.
    if queries is None:
        queries = [user_query.strip()]

    # Topic-relevance filter: drop entries that share no meaningful word with
    # the user query. This catches glm-5's tendency to lift words like
    # "queries", "draft", "select" from the system prompt itself.
    def _tokens(s: str) -> set[str]:
        return {t for t in re.findall(r"[A-Za-z一-鿿]{3,}", s.lower()) if t}

    _STOP = {
        "the",
        "and",
        "for",
        "with",
        "what",
        "how",
        "why",
        "from",
        "into",
        "this",
        "that",
        "these",
        "those",
        "about",
        "between",
        "across",
        "are",
        "is",
        "was",
        "were",
        "has",
        "have",
        "had",
        "but",
        "not",
        "such",
        "any",
        "all",
        "some",
        "their",
        "they",
        "you",
        "your",
        "queries",
        "query",
        "draft",
        "select",
        "ranking",
        "research",
        "list",
        "items",
        "output",
        "format",
        "json",
        "array",
        "string",
        "subject",
        "topic",
        "search",
        "results",
    }
    user_tokens = _tokens(user_query) - _STOP
    if user_tokens:
        filtered = [q for q in queries if (_tokens(q) - _STOP) & user_tokens]
        # Only enforce the filter if it leaves at least one query; otherwise
        # the user_query may be very short and we'd over-prune.
        if filtered:
            queries = filtered

    # Final safety net: if we ended up with zero queries, search the user
    # query verbatim instead of failing.
    if not queries:
        queries = [user_query]

    return queries[:n]


async def _synthesize_one(
    *,
    llm: LLMClient,
    model: str,
    endpoint: LLMEndpointConfig | None,
    max_tokens: int,
    topic: str,
    hits: list[dict[str, str]],
) -> str:
    system = load_prompt("web_researcher")
    user = json.dumps({"topic": topic, "hits": hits}, indent=2)
    resp = await llm.complete(
        CompletionRequest(
            messages=[
                Message(role="system", content=system),
                Message(role="user", content=user),
            ],
            model=model,
            endpoint=endpoint,
            max_tokens=max_tokens,
            temperature=0.2,
            phase=PHASE_INPUT_WEB_SYNTHESIZE,
        )
    )
    return _parse_insight(resp.content)


async def run_input_web(state: PipelineState, ctx: InputWebContext) -> dict[str, Any]:
    phase_started = time.perf_counter()
    derive_started = time.perf_counter()
    logger.info(
        "hybrid_dr.input_web.derive.start task_id=%s requested=%s model=%s",
        state.task_id,
        ctx.n_subquestions,
        ctx.model,
    )
    queries = await _derive_subquestions(
        llm=ctx.llm,
        model=ctx.model,
        endpoint=ctx.endpoint,
        user_query=ctx.user_query,
        n=ctx.n_subquestions,
        max_tokens=ctx.max_tokens // 4,
    )
    logger.info(
        "hybrid_dr.input_web.derive.done task_id=%s query_count=%s dur_ms=%s query_fps=%s",
        state.task_id,
        len(queries),
        int((time.perf_counter() - derive_started) * 1000),
        [_query_fp(q) for q in queries],
    )
    if ctx.web_searches_dir is not None:
        # A retried phase derives new queries; drop the previous attempt's records.
        # UI-only, so a file held open (WinError 32) is logged, never fatal.
        try:
            ctx.web_searches_dir.mkdir(parents=True, exist_ok=True)
            for stale in ctx.web_searches_dir.glob("W-*.json"):
                stale.unlink(missing_ok=True)
        except OSError as exc:
            logger.warning(
                "hybrid_dr.input_web.search_record.cleanup_failed error=%s", type(exc).__name__
            )
    sem = asyncio.Semaphore(max(1, ctx.concurrency))

    async def _one(idx: int, query: str) -> tuple[str, str]:
        unit_started = time.perf_counter()
        logger.info(
            "hybrid_dr.input_web.query.start task_id=%s idx=%s query_len=%d query_fp=%s",
            state.task_id,
            idx,
            len(query),
            _query_fp(query),
        )
        async with sem:
            search_started = time.perf_counter()
            logger.info(
                "hybrid_dr.input_web.search.start task_id=%s idx=%s max_results=%s query_len=%d query_fp=%s",
                state.task_id,
                idx,
                ctx.hits_per_query,
                len(query),
                _query_fp(query),
            )
            search_hits = await ctx.search.search(query, max_results=ctx.hits_per_query)
            logger.info(
                "hybrid_dr.input_web.search.done task_id=%s idx=%s hit_count=%s dur_ms=%s query_fp=%s",
                state.task_id,
                idx,
                len(search_hits),
                int((time.perf_counter() - search_started) * 1000),
                _query_fp(query),
            )
        hits = [{"title": h.title, "url": h.url, "snippet": h.snippet} for h in search_hits]
        if ctx.web_searches_dir is not None:
            _write_search_record(ctx.web_searches_dir, f"W-{idx:03d}", query, hits)
        synth_started = time.perf_counter()
        logger.info(
            "hybrid_dr.input_web.synthesize.start task_id=%s idx=%s hit_count=%s model=%s query_fp=%s",
            state.task_id,
            idx,
            len(hits),
            ctx.model,
            _query_fp(query),
        )
        insight = await _synthesize_one(
            llm=ctx.llm,
            model=ctx.model,
            endpoint=ctx.endpoint,
            max_tokens=ctx.max_tokens,
            topic=query,
            hits=hits,
        )
        logger.info(
            "hybrid_dr.input_web.synthesize.done task_id=%s idx=%s bytes=%s dur_ms=%s query_fp=%s",
            state.task_id,
            idx,
            len(insight.encode("utf-8")),
            int((time.perf_counter() - synth_started) * 1000),
            _query_fp(query),
        )
        logger.info(
            "hybrid_dr.input_web.query.done task_id=%s idx=%s dur_ms=%s query_fp=%s",
            state.task_id,
            idx,
            int((time.perf_counter() - unit_started) * 1000),
            _query_fp(query),
        )
        return f"W-{idx:03d}", insight

    insights = await asyncio.gather(*(_one(i + 1, q) for i, q in enumerate(queries)))

    ctx.web_insights_dir.mkdir(parents=True, exist_ok=True)
    artifacts: dict[str, str] = dict(state.artifacts)
    for wid, body in insights:
        path = ctx.web_insights_dir / f"{wid}.md"
        path.write_bytes(body.encode("utf-8"))
        artifacts[f"{wid}.md"] = str(path)

    logger.info(
        "hybrid_dr.input_web.done task_id=%s query_count=%s insight_count=%s dur_ms=%s output_dir=%s",
        state.task_id,
        len(queries),
        len(insights),
        int((time.perf_counter() - phase_started) * 1000),
        ctx.web_insights_dir,
    )

    return {
        "current_phase": Phase.PLAN,
        "completed_phases": [*state.completed_phases, Phase.INPUT_WEB],
        "artifacts": artifacts,
        "extras": {
            **state.extras,
            "input_web_query_count": len(queries),
            "input_web_insight_count": len(insights),
        },
    }


__all__ = ["InputWebContext", "InputWebError", "run_input_web"]
