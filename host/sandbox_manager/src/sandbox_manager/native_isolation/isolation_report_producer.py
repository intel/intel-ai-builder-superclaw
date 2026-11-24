"""Assembles the native isolation report of authority section 6.3 from the evidence the host holds.

Contract touched: ``RuntimeStatus`` (the isolation report). This module sits on the Sandbox Manager side
of the boundary: it takes plain values that the broker client collected - what the last verified
provision applied, which tier roles are running and what their launcher said, what the launcher's
read-only DACL readback just found, what the host MCP gateway says runs outside every tier - and decides
what the report may claim. It imports nothing from ``broker_client``, so those values arrive as the small
dataclasses below.

The rule it keeps is the validator's own, made operational: claim only what the evidence covers.

* The control plane forms every claim. A restricted process's account of itself is never an input;
  ``RunningRole.job_verified`` is the one tier-reported fact, and the contract carries it as exactly
  that (``tier_reported_verified``), never as an owner-kernel fact.
* Tier identity is ``owner_kernel_verified`` only when the SID the launcher bound the runner to is the
  SID this side resolved for that tier's account, differs from the owner and differs from every other
  tier's SID.
* A readback that did not run is ``not_read``. It is never replaced by an older success.
* The level is ``not_established`` here. Naming a level needs a passing attestation
  (``current_attestation``), and nothing produces one yet.
* Everything goes through ``validate_isolation_report``. A report the validator refuses is logged by
  reason and replaced by the fail-closed report, so a bug in this module reads as an absence of
  containment and never as a stronger claim.

No value in the report is a path, a SID, an account name or a digest.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal

from contracts.isolation_reporting_data import (
    ISOLATION_REPORT_CONTRACT_VERSION,
    ISOLATION_REPORTING_RULES,
)
from loguru import logger
from sandbox_policy import egress_descriptors

from .isolation_report_rules import (
    IsolationReportRefusal,
    fail_closed_isolation_report,
    validate_isolation_report,
)

AclReadbackVerdict = Literal["matches_shipped_descriptor", "drifted", "not_read"]
ProvisionSource = Literal["receipt", "marker"]

_BACKEND_MODE = "native"
_TIER_ORDER: tuple[str, ...] = tuple(egress_descriptors.ISOLATION_TIERS)


@dataclass(frozen=True)
class ProvisionEvidence:
    """What the latest provision of this Sandbox Manager's lifetime applied.

    ``source`` is ``receipt`` when the elevated broker's receipt was verified in this lifetime, and
    ``marker`` when the marker recorded the plan's digests on an earlier one. A marker is an owner-writable
    hint, so the producer lets it name the policy version only while a readback agrees the roots carry
    the shipped descriptor now.
    ``workspace_root_classes`` are policy classes only, one per workspace root, never a path.
    """

    source: ProvisionSource
    acl_policy_version: int
    workspace_root_classes: tuple[str, ...]


@dataclass(frozen=True)
class AclReadback:
    """The result of the launcher's read-only DACL readback of the current roots."""

    verdict: AclReadbackVerdict
    read_at: str | None


NOT_READ = AclReadback(verdict="not_read", read_at=None)


@dataclass(frozen=True)
class HostMcpActivity:
    """What the host MCP gateway's summary says runs outside every tier, as the signed-in user."""

    host_server_count: int
    host_browser_active: bool


@dataclass(frozen=True)
class RunningRole:
    """A tier role whose launcher is still running, from its parsed started line.

    ``job_verified`` is the tier's own report that the role was in its Job before it resumed. It is
    tier-reported by construction and is only ever carried as ``tier_reported_verified``.
    """

    tier: str
    owner_sid: str
    runner_sid: str
    job_verified: bool
    started_at: str


def current_attestation() -> dict[str, Any]:
    """The runtime policy attestation, as ``IsolationAttestation``.

    The seam for the section 6.5 probes. Nothing runs them yet, so the answer is the one a missing
    attestation has to give: ``stale``, no probe set, no pass instant, nothing covered.

    The probe owner replaces this body with a read of the latest probe run held by the control plane.
    A ``pass`` must carry the ``pst_<sha256>`` id of the probe set that ran, the RFC 3339 UTC instant of
    the last pass, and exactly the policy categories (``identity``, ``filesystem``, ``egress``) the probes
    covered; ``fail`` and ``stale`` carry no coverage. The result must come from a probe the control
    plane ran from outside the restricted process: a restricted process's own report of passing is never
    attestation. ``validate_isolation_report`` then holds the report to those claims - a category
    covered without the evidence behind it is refused and the report falls back to fail closed.
    """
    return {
        "verdict": "stale",
        "probe_set_id": None,
        "last_pass_at": None,
        "covered_policy_categories": [],
    }


def utc_now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def produce_isolation_report(
    *,
    provision: ProvisionEvidence | None,
    roles: Sequence[RunningRole],
    readback: AclReadback,
    tier_sids: Mapping[str, str | None],
    attestation: Callable[[], Mapping[str, Any]] = current_attestation,
    host_mcp: HostMcpActivity | None = None,
) -> dict[str, Any]:
    """The report to publish: assembled from the evidence, validated, or fail closed.

    What runs on the host is outside every tier whatever the tiers' state, so the fail-closed report
    carries the host MCP warning too.
    """
    if provision is None and not roles:
        return _fail_closed(host_mcp)
    try:
        report = build_isolation_report(
            provision=provision,
            roles=roles,
            readback=readback,
            tier_sids=tier_sids,
            attestation=attestation,
            host_mcp=host_mcp,
        )
        validate_isolation_report(report)
    except IsolationReportRefusal as refusal:
        logger.error(
            "isolation-report: event=refused reasons={}; publishing the fail-closed report",
            ",".join(sorted({reason.value for reason in refusal.reasons})),
        )
        return _fail_closed(host_mcp)
    return report


def _fail_closed(host_mcp: HostMcpActivity | None) -> dict[str, Any]:
    report = fail_closed_isolation_report(_BACKEND_MODE)
    warnings = _host_mcp_warnings(host_mcp)
    if not warnings:
        return report
    report["isolation_warnings"].extend(warnings)
    try:
        validate_isolation_report(report)
    except IsolationReportRefusal as refusal:
        logger.error(
            "isolation-report: event=host_mcp_warning_refused reasons={}",
            ",".join(sorted({reason.value for reason in refusal.reasons})),
        )
        return fail_closed_isolation_report(_BACKEND_MODE)
    return report


def build_isolation_report(
    *,
    provision: ProvisionEvidence | None,
    roles: Sequence[RunningRole],
    readback: AclReadback,
    tier_sids: Mapping[str, str | None],
    attestation: Callable[[], Mapping[str, Any]] = current_attestation,
    host_mcp: HostMcpActivity | None = None,
) -> dict[str, Any]:
    """The report as assembled, before validation."""
    policy_version = _applied_policy_version(provision, readback)
    egress = _egress_policy_version() if policy_version is not None else None
    evidence = _tier_evidence(roles, readback, tier_sids)
    attested = dict(attestation())
    classes = list(provision.workspace_root_classes) if provision is not None else []
    return {
        "contract_version": ISOLATION_REPORT_CONTRACT_VERSION,
        "backend_mode": _BACKEND_MODE,
        "isolation_level": "not_established",
        "isolation_policy_version": policy_version,
        "isolation_egress_policy_version": egress,
        "isolation_attestation": attested,
        "isolation_token_shape": "unknown",
        "isolation_tier_evidence": evidence,
        "isolation_workspace_root_count": len(classes),
        "isolation_workspace_root_classes": classes,
        "isolation_warnings": _warnings(
            policy_version=policy_version,
            egress=egress,
            attestation=attested,
            evidence=evidence,
            provisioned=provision is not None,
        )
        + _host_mcp_warnings(host_mcp),
    }


def _applied_policy_version(
    provision: ProvisionEvidence | None, readback: AclReadback
) -> int | None:
    # A receipt and a marker get the same gate: the same disk state reports the same way whether or
    # not this process ran the provision itself.
    if provision is None or readback.verdict != "matches_shipped_descriptor":
        return None
    return provision.acl_policy_version


def _egress_policy_version() -> dict[str, Any]:
    """The shipped egress descriptor's version, derived from it and never spelled here.

    The boundary state and the enforced tiers are the descriptor's own, so the shipped permissive
    descriptor reads ``declared_permissive_no_rules`` with no enforced tier. Nothing here reads the
    filtering platform back, so the readback is ``not_read`` and carries no instant.
    """
    descriptor = egress_descriptors.descriptor_data()
    return {
        "version_label": egress_descriptors.version_label(descriptor),
        "boundary_state": egress_descriptors.boundary_state(descriptor),
        "enforced_tiers": [
            tier
            for tier in _TIER_ORDER
            if tier in egress_descriptors.covered_tiers(descriptor)
        ],
        "readback": {"verdict": "not_read", "read_at": None},
    }


def _tier_evidence(
    roles: Sequence[RunningRole],
    readback: AclReadback,
    tier_sids: Mapping[str, str | None],
) -> list[dict[str, Any]]:
    by_tier: dict[str, list[RunningRole]] = {}
    for role in roles:
        by_tier.setdefault(role.tier, []).append(role)
    entries: list[dict[str, Any]] = []
    for tier in _TIER_ORDER:
        tier_roles = by_tier.get(tier)
        if not tier_roles:
            continue
        identity_ok = all(_identity_verified(role, tier_sids) for role in tier_roles)
        job_ok = all(role.job_verified for role in tier_roles)
        entries.append(
            {
                "tier": tier,
                "identity": "owner_kernel_verified" if identity_ok else "not_verified",
                "acl_readback": readback.verdict,
                "job": "tier_reported_verified" if job_ok else "not_reported",
                "observed_at": readback.read_at
                or max(role.started_at for role in tier_roles),
            }
        )
    return entries


def _identity_verified(role: RunningRole, tier_sids: Mapping[str, str | None]) -> bool:
    resolved = tier_sids.get(role.tier)
    if resolved is None or role.runner_sid != resolved:
        return False
    if role.runner_sid == role.owner_sid:
        return False
    others = (sid for tier, sid in tier_sids.items() if tier != role.tier)
    return role.runner_sid not in others


def _warnings(
    *,
    policy_version: int | None,
    egress: Mapping[str, Any] | None,
    attestation: Mapping[str, Any],
    evidence: Sequence[Mapping[str, Any]],
    provisioned: bool,
) -> list[dict[str, Any]]:
    warnings: list[dict[str, Any]] = [
        {"code": "token_hardening_unverified", "token_shape": "unknown"}
    ]
    if attestation.get("verdict") != "pass":
        warnings.append(
            {
                "code": "policy_attestation_not_passing",
                "verdict": attestation.get("verdict"),
            }
        )
    for reason in _not_established_reasons(
        policy_version, egress, attestation, evidence, provisioned
    ):
        warnings.append({"code": "isolation_level_not_established", "reason": reason})
    return warnings


def _host_mcp_warnings(host_mcp: HostMcpActivity | None) -> list[dict[str, Any]]:
    if host_mcp is None or (host_mcp.host_server_count == 0 and not host_mcp.host_browser_active):
        return []
    return [
        {
            "code": "host_mcp_execution_enabled",
            "host_server_count": host_mcp.host_server_count,
            "host_browser_active": host_mcp.host_browser_active,
        }
    ]


def _not_established_reasons(
    policy_version: int | None,
    egress: Mapping[str, Any] | None,
    attestation: Mapping[str, Any],
    evidence: Sequence[Mapping[str, Any]],
    provisioned: bool,
) -> Iterable[str]:
    if policy_version is None and egress is None and not provisioned:
        yield "native_isolation_not_applied"
    elif policy_version is None or egress is None:
        yield "policy_version_unavailable"
    if attestation.get("verdict") != "pass":
        yield "attestation_not_passing"
    if not _launch_evidence_complete(evidence):
        yield "tier_launch_evidence_incomplete"


def _launch_evidence_complete(evidence: Sequence[Mapping[str, Any]]) -> bool:
    required = ISOLATION_REPORTING_RULES["tiers_requiring_launch_evidence"]
    named = {entry["tier"] for entry in evidence}
    return (
        bool(evidence)
        and all(tier in named for tier in required)
        and all(
            entry["identity"] == "owner_kernel_verified"
            and entry["acl_readback"] == "matches_shipped_descriptor"
            and entry["job"] == "tier_reported_verified"
            for entry in evidence
        )
    )
