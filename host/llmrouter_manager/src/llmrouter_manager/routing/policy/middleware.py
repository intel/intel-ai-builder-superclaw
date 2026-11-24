"""Serving-policy middleware — the over-limit decision for the proxy.

Composes the ported pure helpers into the one decision ``chat_completions``
needs after slot resolution: given a LOCAL-resolved request that may exceed the
local context cap, decide whether to

  * PROCEED    — under cap (or no cap): dispatch as normal;
  * COMPACT    — over cap, budget remaining: return a synthetic
                 ``context_length_exceeded`` 400 so opencode compacts + retries;
  * ESCALATE   — over cap, budget spent (or fresh-read / sticky-blob, or no
                 session): switch to the cloud slot and re-dispatch.

Phase 1 wires PROCEED / COMPACT / ESCALATE(budget). Phase 2 adds the
fresh-read/sticky-blob and cloud-sticky reasons (the tracker already supports
them; this decision consults them so Phase 2 only needs to confirm behaviour).

See docs/design/routing_service_integration_plan.md §5b, §9.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional

from loguru import logger

from .compaction_tracker import CompactionTracker
from .config import RoutingPolicyConfig
from .context_cap import (
    _SAFETY_MARGIN,
    resolve_effective_n_ctx,
    resolve_policy_token_cap,
)

# Decision kinds.
PROCEED = "proceed"
COMPACT = "compact"
ESCALATE = "escalate"


@dataclass(frozen=True)
class OverLimitDecision:
    action: str                      # PROCEED | COMPACT | ESCALATE
    reason: str = ""                 # human/telemetry tag
    req_tokens: int = 0
    cap: Optional[int] = None
    local_n: int = 0                 # local-compaction count after this decision


def decide_over_limit(
    *,
    tracker: CompactionTracker,
    session_id: Optional[str],
    req_tokens: int,
    cap: Optional[int],
    has_cloud: bool,
    now: float,
    allow_escalate: bool = True,
    is_compaction_request: bool = False,
) -> OverLimitDecision:
    """Decision helper for a LOCAL-resolved request.
    Updates ``tracker`` state (blob-resident / compaction counters) and logs; the caller performs
    the returned action — PROCEED continues on local, COMPACT returns a synthetic
    ``ContextOverflowCompactLocally`` 400, ESCALATE re-resolves to the cloud slot.

    ``allow_escalate`` gates the two cloud-escalation branches. It is True for an
    ``auto`` request (the router is invited to pick the slot, so diverting an
    over-cap turn to cloud is legitimate). It is False when the caller EXPLICITLY
    pinned ``local-model`` (router-bypass): the caller demanded local, so we honor
    the local server's context and compact locally, but must NEVER silently divert
    to cloud — otherwise a "force-local" measurement leaks cloud tokens. When
    escalation is disallowed an over-cap turn compacts locally (budget remaining)
    or, once the budget is spent, PROCEEDs to let the local server's own n_ctx
    gate (fits under the real n_ctx / else a genuine context_length_exceeded).

    ``is_compaction_request`` marks the request opencode sends on behalf of the
    ``compaction`` agent — the summary request that follows a COMPACT 400. It is
    an under-cap request on the SAME session, so without this flag it would
    take branch 1 and refund the preventive budget on every compact → summary
    cycle, and ``max_local_compaction`` would never bound the loop (every
    COMPACT_LOCALLY line reads 1/2). With the flag the request still PROCEEDs
    (or, if it is itself over cap, takes the same branches as any other
    request) but neither refunds the budget nor clears the resident-blob mark:
    the summary being small says nothing about whether the original agent's
    transcript recovered. The refund fires on the original agent's next
    under-cap request, which is the "compaction demonstrably worked" case.

    Ordering mirrors the sidecar handler:
      1. under cap / no cap                       → PROCEED (refunds the budget,
                                                    unless is_compaction_request)
      2. escalate-allowed + fresh/sticky (cloud)  → ESCALATE(blob)
      3. budget remaining                         → COMPACT (increments local counter)
      4. escalate-allowed + budget spent + cloud  → ESCALATE(budget)
      5. over cap, no escalation/cloud             → PROCEED (server is authoritative)
    """
    if cap is None or req_tokens <= cap:
        if cap is not None and req_tokens <= cap and not is_compaction_request:
            tracker.clear_blob_resident(session_id)
            # Compaction (or plain session churn) brought this session back under
            # the cap, so the local-compaction budget has done its job and is
            # refunded. See CompactionTracker.reset_compaction_budget. The
            # compaction agent's own summary request is excluded: it is always
            # under cap and proves nothing about the original transcript.
            tracker.reset_compaction_budget(session_id)
        return OverLimitDecision(
            PROCEED,
            reason="under-cap:compaction-agent" if is_compaction_request else "under-cap",
            req_tokens=req_tokens, cap=cap,
        )

    # Fresh-read / sticky-blob escalation — only when escalation is allowed (auto
    # request) AND a cloud slot exists to escalate to. An explicit local-model pin
    # (allow_escalate=False) skips this and falls through to local compaction.
    if allow_escalate and has_cloud:
        is_fresh = tracker.is_fresh_read(session_id, req_tokens)
        is_sticky = (not is_fresh
                     and tracker.should_stick_cloud(session_id, req_tokens, cap))
        if is_fresh or is_sticky:
            kind = "fresh-read" if is_fresh else "sticky-blob"
            tracker.mark_blob_resident(session_id, now)
            logger.info(
                "{} → cloud: session={} tokens={} > cap={} "
                "(preserving resident blob on cloud)",
                kind, session_id, req_tokens, cap,
            )
            return OverLimitDecision(ESCALATE, reason=f"blob:{kind}",
                                     req_tokens=req_tokens, cap=cap)

    # Budget path.
    if tracker.budget_remaining(session_id):
        local_n = tracker.note_local_compaction(session_id, now)
        logger.info(
            "COMPACT_LOCALLY: session={} tokens={} > cap={} local_compaction={}/{}",
            session_id, req_tokens, cap, local_n, tracker.max_local_compaction,
        )
        return OverLimitDecision(COMPACT, reason="compact-locally",
                                 req_tokens=req_tokens, cap=cap, local_n=local_n)

    if allow_escalate and has_cloud:
        logger.info(
            "compaction budget spent ({}) → cloud: session={} tokens={} > cap={}",
            tracker.max_local_compaction, session_id, req_tokens, cap,
        )
        return OverLimitDecision(ESCALATE, reason="budget-spent",
                                 req_tokens=req_tokens, cap=cap)

    # The request-size counter is intentionally conservative for modality and
    # structured parts, so it cannot prove that a request exceeds the server's
    # rendered prompt window. Once recoverable policy actions are exhausted, let
    # the upstream make the authoritative decision.
    return OverLimitDecision(PROCEED, reason="over-cap-no-cloud",
                             req_tokens=req_tokens, cap=cap)


def resolve_cap_from_probe(
    policy: RoutingPolicyConfig,
    probed_n_ctx: Optional[int],
    upstream_cap: Optional[int] = None,
) -> Optional[int]:
    """Turn a probed server n_ctx + policy knobs into the effective token cap.

    Applies the ``max_context`` shrink-only override, then the
    ``output_reserve``/``safety`` subtraction (or an explicit
    ``max_input_tokens`` override). Returns None when nothing gives a cap (the
    server's own limit then gates).
    """
    routing_cfg: dict[str, Any] = {}
    if policy.max_input_tokens is not None:
        routing_cfg["max_input_tokens"] = policy.max_input_tokens
    eff_n_ctx = resolve_effective_n_ctx(
        {"max_context": policy.max_context} if policy.max_context else {},
        probed_n_ctx,
    )
    return resolve_policy_token_cap(
        routing_cfg,
        upstream_cap=upstream_cap,
        server_n_ctx=eff_n_ctx,
        output_reserve=policy.output_reserve,
        safety=_SAFETY_MARGIN,
    )
