"""The egress evidence the WFP readback fills in the isolation report.

Contract touched: ``RuntimeStatus`` (the isolation report's ``isolation_egress_policy_version``). A pure
leaf: it takes the egress plan and the readback's verdict and instant as plain values, so it imports
nothing from ``broker_client``; ``broker_client.egress_readback`` is what runs the readback.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Literal

from contracts.egress_policy_descriptor_data import EGRESS_POLICY_RULES

EgressReadbackVerdict = Literal["matches_plan", "drifted", "not_read"]


def egress_policy_version_evidence(
    plan: Mapping[str, Any], verdict: EgressReadbackVerdict, read_at: str | None
) -> dict[str, Any]:
    """``isolation_egress_policy_version`` for the isolation report, from the plan and its readback.

    ``boundary_state`` and ``enforced_tiers`` are the plan's own, so under the shipped permissive policy
    this is ``declared_permissive_no_rules`` with no enforced tier whatever the readback says: the level
    does not leave ``user_open_egress`` because an anchor is installed, and a drifted or unread anchor
    does not change it either. Only ``readback`` moves.
    """
    evidence: dict[str, Any] = {
        "version_label": plan["policy_version_label"],
        "boundary_state": plan["boundary_state"],
        "enforced_tiers": list(plan["covered_tiers"]),
        "readback": {"verdict": verdict, "read_at": read_at},
    }
    gap = open_loopback_tcp_range(plan)
    if gap is not None:
        evidence["loopback_open_tcp_range"] = gap
    return evidence


def open_loopback_tcp_range(plan: Mapping[str, Any]) -> dict[str, int] | None:
    """The loopback TCP range the installed ``plan`` leaves open to its tiers, or None when it has none (EG2-11).

    Read off the plan itself, never off the host: the range is the complement of what the loopback rules
    block, so it is what was installed even if the host range has moved since. Open runs shorter than the
    contract's minimum range size are a tier's own declared services, not the gap. If tiers differ the hull
    is reported, so the report never states less than is open.
    """
    min_count = EGRESS_POLICY_RULES["loopback_dynamic_port_range_bounds"]["min_count"]
    spans: list[tuple[int, int]] = []
    for rule in plan.get("primary_rules", ()):
        blocked = rule.get("blocked_tcp_port_ranges") or []
        if rule.get("match_mode") != "block_complement_of_allowed_ports" or not blocked:
            continue
        cursor = 1
        for span in sorted(blocked, key=lambda item: item["first"]):
            if span["first"] - cursor >= min_count:
                spans.append((cursor, span["first"] - 1))
            cursor = max(cursor, span["last"] + 1)
        if 65535 - cursor + 1 >= min_count:
            spans.append((cursor, 65535))
    if not spans:
        return None
    return {"first": min(first for first, _ in spans), "last": max(last for _, last in spans)}
