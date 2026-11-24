"""Cross-layer context ledger — what every layer believed the window was.

One record per model request carrying, side by side, the numbers each layer
used for its own context decision:

* **llama-server** — the ``-c`` the supervisor actually launched with
  (``llama_c``, read from ``active-llm-tuning.json`` exactly like
  ``GET /llm-router/v1/local/ctx-size`` reports ``applied``).
* **LRM** — the window the cap was derived from (``lrm_probed_n_ctx``), the cap
  used for this request's over-limit decision (``lrm_cap``), which precedence
  layer produced it (``lrm_cap_source``), the local-compaction budget state, the
  request estimate the decision used and where that number came from, and the
  decision itself.
* **opencode** — the five ``x-opencode-*`` budget headers the fork engine sends
  on every request (D2), persisted verbatim as ints, ``None`` when absent.

The point is the join: "which layer decided to compact, and what did each layer
believe the window was" becomes one query over ``events`` instead of an
afternoon of grep across three repos. Design record:
``intel-ai-builder-internal/docs/design/2026-09-15_cross_layer_context_ledger_plan.md``
§2 P0 and ``…/2026-09-15_context_ledger_wave1.md``.

Rules inherited from ``common/events.py``:

* **Null-safe.** A missing or malformed header is ``None``, never a crash and
  never a dropped row. :func:`build_context_ledger` never raises.
* **Observability only.** Nothing here feeds back into routing, caps, budgets
  or retries. It reads the same values the decision used, after the decision.
* **Closed vocabularies.** ``lrm_cap_source``, ``lrm_decision`` and the
  compaction ``authority`` are enumerated below, so ``GROUP BY`` on any of them
  is exhaustive.
"""

from __future__ import annotations

import os
from dataclasses import asdict, dataclass, fields
from typing import Any, Callable, Optional

from loguru import logger

# ── Contract ─────────────────────────────────────────────────────────────────

# Request header → ledger attr. The names are the ones opencode's
# session/llm/request.ts sends (fork commit "D2 request telemetry headers").
OPENCODE_BUDGET_HEADERS: dict[str, str] = {
    "oc_usable": "x-opencode-context-usable",
    "oc_reserve": "x-opencode-context-reserve",
    "oc_baseline_prompt": "x-opencode-baseline-prompt",
    "oc_baseline_tools": "x-opencode-baseline-tools",
    "oc_next_estimate": "x-opencode-next-request-estimate",
}

# Which precedence layer produced the window ``lrm_cap`` derives from.
#
#   env                    LATENTFACTOR_LOCAL_CTX set llama-server's -c
#   store                  the ctx-size slider override (PUT /local/ctx-size)
#   booster                the hardware booster shrank -c below the override
#   registry               registry ``default_ctx`` (no override in play)
#   edge_probe             the edge server's own probed window (no local -c)
#   mock                   probe failed; the dev Bundle mock's declared ctx
#   opencode_usable        probe AND mock absent; x-opencode-context-usable
#                          stood in for the cap (cold-probe fallback)
#   max_context_override   LATENTFACTOR_MAX_CONTEXT shrank the effective
#                          window below the probed one (shrink-only knob)
#   max_input_tokens       explicit routing.max_input_tokens override
#   unknown                a cap exists but the applied -c could not be
#                          reconciled (active-llm-tuning.json missing/lagging)
#
# ``None`` (JSON null) means no cap was in play: policy off, cloud path, or
# nothing derivable.
CAP_SOURCES: frozenset[str] = frozenset(
    {
        "env",
        "store",
        "booster",
        "registry",
        "edge_probe",
        "mock",
        "opencode_usable",
        "max_context_override",
        "max_input_tokens",
        "unknown",
    }
)

# Who decided to compact.
#   lrm       LRM's synthetic 400 (``evidence: synthetic_400``).
#   opencode  the compaction-summary request LRM OBSERVED arriving with
#             ``Superclaw-Agent: compaction`` and no LRM trigger preceding it
#             in the session (``evidence: superclaw-agent-header``). LRM never
#             infers opencode's post-step ``isOverflow`` decision itself — the
#             *why* is wave 2's ``x-opencode-request-kind`` header; wave 1
#             records only what LRM saw (decision 2026-09-15).
COMPACTION_AUTHORITIES: frozenset[str] = frozenset({"lrm", "opencode"})
COMPACTION_EVIDENCE: frozenset[str] = frozenset({"synthetic_400", "superclaw-agent-header"})

# ``lrm_decision`` mirrors routing/policy/middleware.py's action constants.
LRM_DECISIONS: frozenset[str] = frozenset({"proceed", "compact", "escalate"})


@dataclass(frozen=True, slots=True)
class ContextLedger:
    """The attrs contract. Every field is JSON-serialisable and nullable
    except ``mocked``; see the module docstring for what each layer owns."""

    # request identity: the proxy's per-request id, also stamped as
    # ``trace_id`` on this row AND on ``token_events`` — the per-request join.
    chat_req_id: Optional[str]
    # opencode-facing identity
    alias: Optional[str]            # auto | cloud-model | local-model (as requested)
    alias_resolved: Optional[str]   # after auto-routing / escalation
    locality: Optional[str]         # local | cloud | edge (as resolved)
    bundle_id: Optional[str]
    mocked: bool
    parent_session_id: Optional[str]
    # llama-server
    llama_c: Optional[int]
    # LRM
    lrm_probed_n_ctx: Optional[int]
    lrm_cap: Optional[int]
    lrm_cap_source: Optional[str]
    lrm_compact_budget_max: Optional[int]
    lrm_compact_budget_left: Optional[int]
    lrm_req_estimate: Optional[int]
    lrm_req_estimate_source: Optional[str]   # opencode_header | lrm_tokenizer
    lrm_decision: Optional[str]              # proceed | compact | escalate
    lrm_decision_reason: Optional[str]       # middleware's reason tag
    # opencode (D2 headers, verbatim)
    oc_usable: Optional[int]
    oc_reserve: Optional[int]
    oc_baseline_prompt: Optional[int]
    oc_baseline_tools: Optional[int]
    oc_next_estimate: Optional[int]

    def as_attrs(self) -> dict[str, Any]:
        return asdict(self)


LEDGER_KEYS: tuple[str, ...] = tuple(f.name for f in fields(ContextLedger))


def empty_ledger_attrs() -> dict[str, Any]:
    """Every ledger key present, every value null (``mocked`` False). Used
    when the ledger could not be built so a row's attrs keep a stable shape."""
    return {k: (False if k == "mocked" else None) for k in LEDGER_KEYS}


# ── Inputs ───────────────────────────────────────────────────────────────────


def read_budget_headers(
    read_int: Callable[[str], Optional[int]],
) -> dict[str, Optional[int]]:
    """Read the five D2 headers through the caller's tolerant int parser
    (``proxy._read_int_header``). Absent or malformed → ``None``."""
    out: dict[str, Optional[int]] = {}
    for attr, header in OPENCODE_BUDGET_HEADERS.items():
        try:
            out[attr] = read_int(header)
        except Exception:  # noqa: BLE001
            out[attr] = None
    return out


def _applied_ctx(app_state: Any) -> Optional[int]:
    """The ``-c`` llama-server is running with — the same read the ctx-size
    endpoint reports as ``applied``."""
    from .local_ctx_api import _read_applied

    try:
        return _read_applied(app_state)
    except Exception:  # noqa: BLE001
        return None


def _persisted_ctx_override(app_state: Any) -> Optional[int]:
    """The slider override, read through the app's already-open Store when
    there is one (no second connection on the request path), else via the
    endpoint's own reader. Same bounds validation as the boot-time read."""
    from .local_ctx_api import _CONFIG_KEY, _read_persisted, is_valid_persisted_ctx_size

    store = getattr(app_state, "store", None)
    if store is None:
        try:
            return _read_persisted()
        except Exception:  # noqa: BLE001
            return None
    try:
        raw = store.get_config(_CONFIG_KEY)
    except Exception:  # noqa: BLE001
        return None
    if raw is None:
        return None
    try:
        n = int(raw)
    except (TypeError, ValueError):
        return None
    return n if is_valid_persisted_ctx_size(n) else None


def resolve_cap_source(
    *,
    kind: Optional[str],
    cap: Optional[int],
    probed_n_ctx: Optional[int],
    probe_from_mock: bool,
    cap_from_header: bool,
    applied_c: Optional[int],
    persisted_c: Optional[int],
    env_local_ctx: Optional[str],
    max_context: Optional[str],
    max_input_tokens: Optional[int],
) -> Optional[str]:
    """Label the precedence layer behind ``cap`` (see :data:`CAP_SOURCES`).

    Pure. Overrides are checked first (they replace or shrink whatever the
    window was), then the window's own origin. For the local llama path the
    origin label is the ctx-size endpoint's own reconciliation
    (``local_ctx_api._resolve_source``) so the ledger and the UI never
    disagree about "using saved override" vs "registry default".
    """
    if cap is None:
        return None
    if max_input_tokens is not None:
        return "max_input_tokens"
    if cap_from_header:
        return "opencode_usable"
    if max_context and probed_n_ctx:
        try:
            override = int(max_context)
        except (TypeError, ValueError):
            override = 0
        if 0 < override < int(probed_n_ctx):
            return "max_context_override"
    if probe_from_mock:
        return "mock"
    if kind == "edge":
        return "edge_probe"
    from .local_ctx_api import _resolve_source

    return _resolve_source(persisted_c, applied_c, env_local_ctx)


# ── Builder ──────────────────────────────────────────────────────────────────


def build_context_ledger(
    *,
    app_state: Any,
    chat_req_id: Optional[str],
    kind: Optional[str],
    alias_requested: Optional[str],
    alias_resolved: Optional[str],
    bundle_id: Optional[str],
    parent_session_id: Optional[str],
    budget_headers: dict[str, Optional[int]],
    cap: Optional[int],
    probed_n_ctx: Optional[int],
    probe_from_mock: bool,
    cap_from_header: bool,
    req_tokens: Optional[int],
    estimate_source: Optional[str],
    decision: Optional[str],
    decision_reason: Optional[str],
    tracker: Any,
    session_id: Optional[str],
    max_context: Optional[str],
    max_input_tokens: Optional[int],
) -> ContextLedger:
    """Assemble the ledger for one request AFTER the over-limit decision, so
    the budget fields describe the state the session is left in.

    Never raises: any individual read that fails leaves its field ``None``.
    Call it only when a row will actually be written — it costs a file read
    (``active-llm-tuning.json``) and a Store read on the local path.
    """
    from ..local import mock_bundle

    try:
        mocked = bool(mock_bundle.is_armed())
    except Exception:  # noqa: BLE001
        mocked = False

    locality = kind if kind in ("local", "cloud", "edge") else None

    # llama-server's -c only exists on the local llama path. Edge serves its
    # own window; cloud has none LRM can see.
    applied_c: Optional[int] = None
    persisted_c: Optional[int] = None
    if kind == "local":
        applied_c = _applied_ctx(app_state)
        persisted_c = _persisted_ctx_override(app_state)

    try:
        cap_source = resolve_cap_source(
            kind=kind,
            cap=cap,
            probed_n_ctx=probed_n_ctx,
            probe_from_mock=probe_from_mock,
            cap_from_header=cap_from_header,
            applied_c=applied_c,
            persisted_c=persisted_c,
            env_local_ctx=os.environ.get("LATENTFACTOR_LOCAL_CTX"),
            max_context=max_context,
            max_input_tokens=max_input_tokens,
        )
    except Exception:  # noqa: BLE001
        cap_source = "unknown" if cap is not None else None

    budget_max: Optional[int] = None
    budget_left: Optional[int] = None
    if tracker is not None:
        try:
            budget_max = int(tracker.max_local_compaction)
            # Without a session id the tracker cannot count, so it never
            # compacts locally (budget_remaining() is False) — report 0, not
            # the nominal maximum.
            if session_id:
                budget_left = max(0, budget_max - int(tracker.local_compactions(session_id)))
            else:
                budget_left = 0
        except Exception:  # noqa: BLE001
            budget_max = budget_left = None

    return ContextLedger(
        chat_req_id=chat_req_id or None,
        alias=alias_requested,
        alias_resolved=alias_resolved,
        locality=locality,
        bundle_id=bundle_id,
        mocked=mocked,
        parent_session_id=parent_session_id or None,
        llama_c=applied_c,
        lrm_probed_n_ctx=probed_n_ctx,
        lrm_cap=cap,
        lrm_cap_source=cap_source,
        lrm_compact_budget_max=budget_max,
        lrm_compact_budget_left=budget_left,
        lrm_req_estimate=req_tokens,
        lrm_req_estimate_source=estimate_source,
        lrm_decision=decision if decision in LRM_DECISIONS else None,
        lrm_decision_reason=decision_reason or None,
        oc_usable=budget_headers.get("oc_usable"),
        oc_reserve=budget_headers.get("oc_reserve"),
        oc_baseline_prompt=budget_headers.get("oc_baseline_prompt"),
        oc_baseline_tools=budget_headers.get("oc_baseline_tools"),
        oc_next_estimate=budget_headers.get("oc_next_estimate"),
    )


def safe_ledger_attrs(build: Callable[[], ContextLedger]) -> dict[str, Any]:
    """Run ``build`` and return its attrs; on ANY failure return the
    null-shaped attrs and log once. This is the guard that keeps a ledger bug
    from costing a turn (rule 3): the attrs are assembled at the call site
    *before* ``record_event`` can catch anything."""
    try:
        return build().as_attrs()
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "context ledger: could not build attrs ({}: {}); writing nulls",
            exc.__class__.__name__,
            exc,
        )
        return empty_ledger_attrs()
