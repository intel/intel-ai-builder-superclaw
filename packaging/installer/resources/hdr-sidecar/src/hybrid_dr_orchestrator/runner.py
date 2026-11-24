"""Phase runner — execute one phase at a time, advance state, persist.

The graph topology in `graph.py` is the design + topology test artifact.
At runtime the sidecar uses this thinner driver because:

  - LangGraph's StateGraph wants a single graph-level state, but each
    real node has its own per-phase context (file paths + LLM client +
    knobs). Wiring those as graph-level state pollutes the state shape.
  - Tests need to be able to advance one phase at a time and inspect
    state between phases. The driver makes that natural.

Behavior:

  - `Runner.advance()` picks the node matching `state.current_phase`,
    builds its context from the session config, runs the node, applies
    the returned state delta, persists, returns the new state.
  - Phase 'done' / 'failed' → no-op (idempotent terminal).
  - Per-node exceptions are caught, recorded as `failed_phases` entry,
    state is persisted, and the exception propagates so the API layer
    can decide whether to retry (next call to `advance()` retries via
    the graph's retry budget).
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .config import PipelineConfig, load_config
from .llm import LLMClient, LLMEndpointConfig
from .managed_paths import AuthorizedFile
from .nodes.assemble import AssembleContext, run_assemble
from .nodes.conclusion import ConclusionContext, run_conclusion
from .nodes.fill import FillContext, run_fill
from .nodes.input_local import InputLocalContext, run_input_local
from .nodes.input_web import InputWebContext, run_input_web
from .nodes.plan import PlanContext, run_plan
from .nodes.polish import PolishContext, PolishRefusalError, run_polish
from .nodes.section_write import SectionWriteContext, run_section_write
from .persistence import save_legacy
from .search import SearchClient
from .state import Phase, PipelineState


logger = logging.getLogger("uvicorn.error")


@dataclass(frozen=True)
class SessionLayout:
    """All on-disk paths used by a single session. The runner builds the
    per-node Context objects from this."""

    root_dir: Path
    """e.g. /workspace/deep-research-workspaces/sessions/<sid>"""

    @property
    def local_intermediate_dir(self) -> Path:
        return self.root_dir / "local_intermediate"

    @property
    def cloud_intermediate_dir(self) -> Path:
        return self.root_dir / "cloud_intermediate"

    @property
    def web_insights_dir(self) -> Path:
        return self.cloud_intermediate_dir / "insights" / "web"

    @property
    def web_searches_dir(self) -> Path:
        return self.cloud_intermediate_dir / "insights" / "web_searches"

    @property
    def local_insights_dir(self) -> Path:
        return self.local_intermediate_dir / "insights" / "local"

    @property
    def sections_dir(self) -> Path:
        return self.cloud_intermediate_dir / "sections"

    @property
    def filled_sections_dir(self) -> Path:
        return self.local_intermediate_dir / "filled_sections"

    @property
    def conclusions_dir(self) -> Path:
        return self.cloud_intermediate_dir / "conclusions"

    @property
    def plan_path(self) -> Path:
        return self.cloud_intermediate_dir / "plan.json"

    @property
    def polish_skeleton_path(self) -> Path:
        return self.local_intermediate_dir / "polish_skeleton.json"


@dataclass(frozen=True)
class SessionConfig:
    """Per-session knobs the runner needs to build per-node contexts."""

    user_query: str
    data_paths: list[Path] = field(default_factory=list)
    """Files or directories to ingest. Empty → input_local is a no-op."""
    title: str = "Assembled Report"
    cloud_model: str | None = None
    """Override the cloud model id used by every phase that calls the
    cloud LLM. None → fall back to each context's default ("cloud-model").
    The deployed OpenCode tool leaves this as cloud-model by default."""
    cloud_llm: LLMEndpointConfig | None = None
    """OpenAI-compatible cloud model endpoint. Takes precedence over cloud_model."""
    local_llm: LLMEndpointConfig | None = None
    """OpenAI-compatible local model endpoint for fill/local phases."""
    managed_inputs: tuple[AuthorizedFile, ...] | None = None
    """Managed mode's validated local files; None in legacy mode."""


# Guard 6: retry a transiently-failed phase in-place before giving up, so a
# single flaky cloud response (e.g. glm-5.2 under load) does not abort the
# whole DR. Backoff between attempts; the last value repeats if the retry
# count exceeds its length.
_PHASE_RETRY_BACKOFF_S = (5.0, 15.0)


_SECRET_RE = re.compile(
    r"(?i)("
    r"Bearer\s+\S+"
    r"|sk-[A-Za-z0-9_\-]{16,}"
    r"|owt_[A-Za-z0-9_\-]{16,}"
    r"|tvly-[A-Za-z0-9_\-]{16,}"
    r")"
)
_USER_PATH_RE = re.compile(
    r"([A-Za-z]:\\Users\\[^\\]+|/home/[^/\s]+|/Users/[^/\s]+)"
)


def _summarize_exc(e: BaseException) -> str:
    """Return ``<Type>: <msg>`` with known secrets/user paths masked, capped at 400 chars."""
    msg = str(e)
    msg = _SECRET_RE.sub("<redacted>", msg)
    msg = _USER_PATH_RE.sub("<user-path>", msg)
    if len(msg) > 400:
        msg = msg[:400] + f"…<truncated, total_len={len(str(e))}>"
    return f"{type(e).__name__}: {msg}"


class Runner:
    """Drives one session through its phases, one phase per call to
    `advance()`."""

    def __init__(
        self,
        *,
        layout: SessionLayout,
        session_config: SessionConfig,
        llm: LLMClient,
        search: SearchClient,
        pipeline_config: PipelineConfig | None = None,
        phase_max_retries: int = 0,
    ) -> None:
        self.layout = layout
        self.session_config = session_config
        self.llm = llm
        self.search = search
        self.pipeline_config = pipeline_config or load_config()
        # Number of in-place retries for a failed phase before the failure is
        # recorded and re-raised. 0 (default) preserves the original
        # fail-fast behaviour for unit tests; the API layer raises it for
        # production sessions so a transient phase failure retries instead of
        # aborting the whole DR.
        self.phase_max_retries = max(0, phase_max_retries)

    # ───── public API ────────────────────────────────────────────────

    async def advance(self, state: PipelineState) -> PipelineState:
        """Run the node for `state.current_phase`, apply the returned
        delta, persist legacy state, return the new state.

        Terminal phases are idempotent: advance on DONE / FAILED returns
        the same state without doing work.
        """
        if state.is_terminal():
            return state

        phase = state.current_phase
        node_fn = self._lookup_node(phase)
        session_id = self.layout.root_dir.name
        started = time.perf_counter()
        logger.info(
            "hybrid_dr.phase.start session_id=%s task_id=%s phase=%s phase_index=%s/%s",
            session_id,
            state.task_id,
            phase.value,
            phase.ordinal(),
            Phase.total(),
        )

        # Guard 6: run the phase node, retrying in place on a transient
        # failure (state / current_phase are unchanged on failure, so a
        # re-run retries the same phase) before recording the failure and
        # re-raising. `phase_max_retries == 0` keeps the original fail-fast
        # behaviour.
        delta: dict[str, Any] | None = None
        for attempt in range(self.phase_max_retries + 1):
            try:
                if node_fn is None:
                    # No implementation registered for this phase — advance
                    # past it. Should not happen for any of the 9 phases.
                    delta = {
                        "current_phase": _next_known_phase(phase),
                        "completed_phases": [*state.completed_phases, phase],
                    }
                else:
                    ctx = self._build_context(phase)
                    # All node functions are either sync (assemble, input_local)
                    # or async (rest). We adapt.
                    result = node_fn(state, ctx)
                    if hasattr(result, "__await__"):
                        delta = await result  # type: ignore[assignment]
                    else:
                        delta = result  # type: ignore[assignment]
                break
            except Exception as e:
                dur_ms = int((time.perf_counter() - started) * 1000)
                if attempt < self.phase_max_retries and not isinstance(e, PolishRefusalError):
                    backoff = _PHASE_RETRY_BACKOFF_S[
                        min(attempt, len(_PHASE_RETRY_BACKOFF_S) - 1)
                    ]
                    logger.warning(
                        "hybrid_dr.phase.retry session_id=%s task_id=%s phase=%s "
                        "attempt=%s/%s dur_ms=%s backoff_s=%s error=%s",
                        session_id,
                        state.task_id,
                        phase.value,
                        attempt + 1,
                        self.phase_max_retries,
                        dur_ms,
                        backoff,
                        _summarize_exc(e),
                    )
                    await asyncio.sleep(backoff)
                    continue
                logger.exception(
                    "hybrid_dr.phase.error session_id=%s task_id=%s phase=%s dur_ms=%s error=%s",
                    session_id,
                    state.task_id,
                    phase.value,
                    dur_ms,
                    _summarize_exc(e),
                )
                # Retries exhausted: record failure on the state, persist,
                # re-raise so the API layer / driver sees a terminal failure.
                state = state.record_failure(phase, _summarize_exc(e))
                self._persist(state)
                raise

        new_state = state.model_copy(update=delta) if delta else state
        self._persist(new_state)
        dur_ms = int((time.perf_counter() - started) * 1000)
        logger.info(
            "hybrid_dr.phase.done session_id=%s task_id=%s phase=%s next_phase=%s dur_ms=%s",
            session_id,
            state.task_id,
            phase.value,
            new_state.current_phase.value,
            dur_ms,
        )
        return new_state

    async def run_to_terminal(
        self, state: PipelineState, *, max_advances: int = 32
    ) -> PipelineState:
        """Convenience: keep calling advance until terminal or budget hit."""
        for _ in range(max_advances):
            if state.is_terminal():
                return state
            state = await self.advance(state)
        return state

    # ───── internals ─────────────────────────────────────────────────

    def _persist(self, state: PipelineState) -> None:
        save_legacy(state, self.layout.local_intermediate_dir)

    def _lookup_node(self, phase: Phase):
        # Mapping is intentionally explicit so an unknown phase fails
        # noisily rather than silently advancing.
        if phase is Phase.INPUT_LOCAL:
            return run_input_local
        if phase is Phase.INPUT_WEB:
            return run_input_web
        if phase is Phase.PLAN:
            return run_plan
        if phase is Phase.SECTION_WRITE:
            return run_section_write
        if phase is Phase.FILL:
            return run_fill
        if phase is Phase.CONCLUSION:
            return run_conclusion
        if phase is Phase.FILL_CONCLUSION:
            # fill_conclusion is an orchestrator-emitted intermediate that
            # the existing implementation creates between conclusion and
            # assemble. The sidecar treats it as a no-op pass-through —
            # we already have winner.md and the filled_sections from
            # the upstream conclusion / fill phases.
            return None
        if phase is Phase.ASSEMBLE:
            return run_assemble
        if phase is Phase.POLISH:
            return run_polish
        return None

    def _build_context(self, phase: Phase):
        L = self.layout
        cloud_model = self.session_config.cloud_model
        cloud_llm = self.session_config.cloud_llm
        local_llm = self.session_config.local_llm
        if phase is Phase.INPUT_LOCAL:
            return InputLocalContext(
                data_paths=self.session_config.data_paths,
                local_insights_dir=L.local_insights_dir,
                managed_files=self.session_config.managed_inputs,
            )
        if phase is Phase.INPUT_WEB:
            kwargs: dict[str, Any] = dict(
                user_query=self.session_config.user_query,
                web_insights_dir=L.web_insights_dir,
                web_searches_dir=L.web_searches_dir,
                llm=self.llm,
                search=self.search,
            )
            if cloud_model:
                kwargs["model"] = cloud_model
            if cloud_llm:
                kwargs["model"] = cloud_llm.model
                kwargs["endpoint"] = cloud_llm
            return InputWebContext(**kwargs)
        if phase is Phase.PLAN:
            kwargs = dict(
                user_query=self.session_config.user_query,
                web_insights_dir=L.web_insights_dir,
                local_insights_dir=L.local_insights_dir,
                cloud_intermediate_dir=L.cloud_intermediate_dir,
                llm=self.llm,
            )
            if cloud_model:
                kwargs["model"] = cloud_model
            if cloud_llm:
                kwargs["model"] = cloud_llm.model
                kwargs["endpoint"] = cloud_llm
            return PlanContext(**kwargs)
        if phase is Phase.SECTION_WRITE:
            kwargs = dict(
                plan_path=L.plan_path,
                web_insights_dir=L.web_insights_dir,
                cloud_sections_dir=L.sections_dir,
                llm=self.llm,
            )
            if cloud_model:
                kwargs["model_writer"] = cloud_model
                kwargs["model_reviewer"] = cloud_model
            if cloud_llm:
                kwargs["model_writer"] = cloud_llm.model
                kwargs["model_reviewer"] = cloud_llm.model
                kwargs["endpoint_writer"] = cloud_llm
                kwargs["endpoint_reviewer"] = cloud_llm
            return SectionWriteContext(**kwargs)
        if phase is Phase.FILL:
            # FillContext uses the LOCAL model by default. Cloud override
            # does not apply here per the L0/L2 privacy contract.
            kwargs = dict(
                cloud_sections_dir=L.sections_dir,
                local_insights_dir=L.local_insights_dir,
                filled_sections_dir=L.filled_sections_dir,
                llm=self.llm,
            )
            if local_llm:
                kwargs["model"] = local_llm.model
                kwargs["endpoint"] = local_llm
            return FillContext(**kwargs)
        if phase is Phase.CONCLUSION:
            kwargs = dict(
                sections_dir=L.sections_dir,
                conclusions_dir=L.conclusions_dir,
                llm=self.llm,
            )
            if cloud_model:
                kwargs["model_writer"] = cloud_model
                kwargs["model_scorer"] = cloud_model
            if cloud_llm:
                kwargs["model_writer"] = cloud_llm.model
                kwargs["model_scorer"] = cloud_llm.model
                kwargs["endpoint_writer"] = cloud_llm
                kwargs["endpoint_scorer"] = cloud_llm
            return ConclusionContext(**kwargs)
        if phase is Phase.ASSEMBLE:
            return AssembleContext(
                plan_path=L.plan_path,
                cloud_sections_dir=L.sections_dir,
                filled_sections_dir=L.filled_sections_dir,
                conclusions_dir=L.conclusions_dir,
                web_insights_dir=L.web_insights_dir,
                output_dir=L.local_intermediate_dir,
                title=self.session_config.title,
            )
        if phase is Phase.POLISH:
            kwargs = dict(
                local_intermediate_dir=L.local_intermediate_dir,
                polish_skeleton_path=L.polish_skeleton_path,
                llm=self.llm,
                cloud_sections_dir=L.sections_dir,
                conclusions_dir=L.conclusions_dir,
                web_insights_dir=L.web_insights_dir,
            )
            if cloud_model:
                kwargs["model"] = cloud_model
            if cloud_llm:
                kwargs["model"] = cloud_llm.model
                kwargs["endpoint"] = cloud_llm
            if local_llm:
                kwargs["local_model"] = local_llm.model
                kwargs["local_endpoint"] = local_llm
            return PolishContext(**kwargs)
        raise ValueError(f"no context builder for phase {phase!r}")


def _next_known_phase(phase: Phase) -> Phase:
    """Fallback for phases without registered implementations (e.g.
    fill_conclusion). Walks ordered() forward by one and snaps to DONE
    if we run off the end."""
    ordered = Phase.ordered()
    try:
        idx = ordered.index(phase)
    except ValueError:
        return Phase.DONE
    if idx + 1 >= len(ordered):
        return Phase.DONE
    return ordered[idx + 1]


__all__ = ["Runner", "SessionConfig", "SessionLayout"]
