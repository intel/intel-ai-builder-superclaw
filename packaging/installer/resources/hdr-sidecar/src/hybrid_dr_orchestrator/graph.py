"""LangGraph compilation: phase nodes + supervisor routing.

The graph is a thin orchestrator that:

  - calls one phase node at a time
  - routes via conditional edges based on (current_phase, retries,
    failed_phases, task-class skip rules)
  - emits state deltas back to the FastAPI surface

Node bodies are stub-shaped in this file — they take state and return a
state-delta dict. Real phase implementations live in
`hybrid_dr_orchestrator.nodes.<phase>`. The stub returns `{}` plus an
"advance to next ordered phase" delta so the graph topology is testable
without LLM access.

Routing semantics (conditional edges per phase):

  on success → advance to the next non-skipped phase
  on failure → if retries remaining → retry same phase
              else → advance to FAILED terminal
  on skip    → ordinary advance, no node body runs
  on terminal (DONE / FAILED) → END

The supervisor pattern is implicit in the conditional edges; there is no
separate supervisor node. This matches LangGraph idiom.
"""
from __future__ import annotations

from collections.abc import Callable
from typing import Any

from langgraph.graph import END, START, StateGraph

from .config import PipelineConfig, load_config
from .state import Phase, PipelineState


# ───── stub node bodies ─────────────────────────────────────────────────


def _stub_node(phase: Phase) -> Callable[[PipelineState], dict[str, Any]]:
    """Returns a node function that records phase start time, does nothing,
    and returns an empty delta. Real implementations replace these one
    phase at a time per the strangler-fig migration order in
    ARCHITECTURE.md."""

    def node(state: PipelineState) -> dict[str, Any]:
        # Real nodes mutate state via state.advance_to / add_artifact /
        # record_failure. Stubs do nothing; the conditional-edge function
        # below handles the advance.
        return {}

    node.__name__ = f"stub_{phase.value}"
    return node


# ───── routing helpers ──────────────────────────────────────────────────


def _next_non_skipped_phase(
    after: Phase,
    cfg: PipelineConfig,
    task_class_cfg_skip: dict[str, bool],
) -> Phase:
    """Returns the next phase after `after` that is not marked skipped for
    this task class. If we run off the end, return DONE."""
    ordered = Phase.ordered()
    try:
        idx = ordered.index(after)
    except ValueError:
        return Phase.DONE
    for next_phase in ordered[idx + 1 :]:
        if not task_class_cfg_skip.get(next_phase.value, False):
            return next_phase
    return Phase.DONE


def _make_router(
    cfg: PipelineConfig,
) -> Callable[[PipelineState], str]:
    """Returns the conditional-edge function used for every phase node's
    outgoing edge. The function reads the latest state and decides which
    node to run next.

    Decision tree:

      1. If state.is_terminal() → END
      2. If state.current_phase ∈ failed_phases:
           a. If retries[phase] < retries_budget → re-run same phase
           b. Else → advance current_phase to FAILED terminal (will hit END
              on next router invocation)
      3. Else → advance to next non-skipped phase per task_class config
    """

    def router(state: PipelineState) -> str:
        if state.is_terminal():
            return END

        cur = state.current_phase
        task_cfg = cfg.for_task(state.task_class)

        # Failure path
        if cur in state.failed_phases:
            attempts = state.retries.get(cur, 0)
            budget = task_cfg.retries_for(cur)
            if attempts < budget:
                return cur.value  # retry the same phase
            return END  # caller marks FAILED terminal separately

        # Success path
        nxt = _next_non_skipped_phase(cur, cfg, task_cfg.skip)
        return nxt.value if nxt is not Phase.DONE else END

    return router


# ───── graph compilation ────────────────────────────────────────────────


def build_graph(cfg: PipelineConfig | None = None) -> Any:
    """Compile the hybrid-DR LangGraph. Returns the compiled graph ready
    to invoke / stream."""
    if cfg is None:
        cfg = load_config()

    builder: StateGraph[PipelineState] = StateGraph(PipelineState)

    # Register every non-terminal phase as a node, even those marked
    # skip — the router decides whether to enter them. Keeping the node
    # registered means a runtime config change can re-enable a skipped
    # phase without recompiling.
    for phase in Phase.ordered():
        builder.add_node(phase.value, _stub_node(phase))

    router = _make_router(cfg)

    # Entry: route from START using the first non-skipped phase.
    builder.add_conditional_edges(
        START,
        lambda state: _first_phase(state, cfg).value,
        {p.value: p.value for p in Phase.ordered()} | {END: END},
    )

    # Each phase routes via the same conditional function.
    for phase in Phase.ordered():
        builder.add_conditional_edges(
            phase.value,
            router,
            {p.value: p.value for p in Phase.ordered()} | {END: END},
        )

    return builder.compile()


def _first_phase(state: PipelineState, cfg: PipelineConfig) -> Phase:
    """Find the first non-skipped phase for this task class. Used by the
    START → ? edge."""
    task_cfg = cfg.for_task(state.task_class)
    for p in Phase.ordered():
        if not task_cfg.is_skipped(p):
            return p
    return Phase.DONE


__all__ = ["build_graph"]
