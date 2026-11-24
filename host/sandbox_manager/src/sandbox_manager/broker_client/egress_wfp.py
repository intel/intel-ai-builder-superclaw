"""The WFP half of the one provision: plan inputs, and the install that rides the same elevation.

Contract touched: ``Sandbox`` (the egress policy plan, descriptor contract 4). Adapter: this module, and
nothing above it knows the wire.

The plan is the shipped permissive one unless the internal ``SUPERCLAW_NATIVE_EGRESS_WFP_PLAN=enforcing`` setting
selects the enforcing reference, whose connector permit is built in ``egress_wfp_inputs`` (EG2-11).

There is no elevation here. The provision session that already prompts once answers the ACL plan, and
then - over the same authenticated pipe - takes this plan and installs it in the same elevated process.
The plan can only be written after that first answer, because the tier accounts' SIDs do not exist until
the session's identity step has run; they are read back here with a plain, unelevated account lookup of
the derived account names.

Failure is reported and never raised. The ACL receipt has already been answered, so a plan this side
cannot write, or an install the broker refuses, leaves the start exactly as it was and is carried in the
:class:`WfpInstallOutcome` for the isolation report instead.
"""

from __future__ import annotations

import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from loguru import logger
from sandbox_policy.egress_plan import (
    EgressPolicyRefusalError,
    plan_egress_policy,
    plan_enforcing_reference_policy,
)

from .account_sid import AccountSidLookup, lookup_local_account_sid
from .egress_wfp_inputs import WfpPlanInputs, current_plan_inputs
from .identity import TIERS, tier_account_name
from .markers import mark_wfp_plan
from .provision_pipe import ProvisionPipeServer, ProvisionPipeTimeout
from .provision_wire import (
    TO_OWNER,
    ProvisionSession,
    ProvisionWireError,
    normalized_digest,
    wfp_plan_frame,
)

WfpInstallStatus = Literal["installed", "refused", "skipped", "declined", "failed"]

#: How long either side waits for the one WFP frame. Short: the engine write is one transaction.
_WFP_FRAME_TIMEOUT_SECONDS = 30.0


@dataclass(frozen=True)
class WfpInstallOutcome:
    """What became of the WFP plan in this provision.

    ``skipped`` is this side not sending a plan, with the planner's own typed reason and the tier it is
    about; ``refused`` is the broker declining it, with the broker's closed reason. ``declined`` is the
    owner dismissing the elevation prompt of a start whose only reason to prompt was this plan, and
    ``failed`` is that elevation not completing for another reason (``reason`` names it). None of them is
    an error for the provision.
    """

    status: WfpInstallStatus
    reason: str | None = None
    tier: str | None = None
    plan: Mapping[str, Any] | None = None


def tier_accounts_for(owner_sid: str, lookup: AccountSidLookup) -> list[dict[str, str]]:
    """One ``{tier, account_sid}`` per tier whose account resolves, channel included.

    A tier whose account does not resolve is left out rather than invented, so the planner refuses with
    ``tier_account_absent_for_tier`` for exactly that tier and the install is skipped with a typed reason.
    """
    accounts: list[dict[str, str]] = []
    for tier in TIERS:
        account_sid = lookup(tier_account_name(owner_sid, tier))
        if account_sid:
            accounts.append({"tier": tier, "account_sid": account_sid})
    return accounts


def plan_install(
    owner_sid: str,
    lookup: AccountSidLookup | None = None,
    *,
    inputs: WfpPlanInputs | None = None,
) -> tuple[Mapping[str, Any] | None, WfpInstallOutcome | None]:
    """The plan for the selected policy over this owner's four tier accounts, or a typed skip.

    The shipped permissive plan unless the internal ``SUPERCLAW_NATIVE_EGRESS_WFP_PLAN=enforcing`` setting
    selects the enforcing reference (EG2-11, ``egress_wfp_inputs``). Exactly one of the two results is set. The
    skip carries the planner's first refusal reason and the tier it is about, or the typed reason the enforcing
    inputs could not be had.
    """
    inputs = inputs or current_plan_inputs()
    if inputs.skip_reason is not None:
        return None, WfpInstallOutcome(status="skipped", reason=inputs.skip_reason)
    accounts = tier_accounts_for(owner_sid, lookup or lookup_local_account_sid)
    try:
        if inputs.mode == "enforcing" and inputs.host_policy_state is not None:
            plan = plan_enforcing_reference_policy(
                owner_sid=owner_sid,
                tier_accounts=accounts,
                host_policy_state=inputs.host_policy_state,
                upstream_proxy=inputs.upstream_proxy,
            ).model_dump(mode="json")
        else:
            plan = plan_egress_policy(owner_sid=owner_sid, tier_accounts=accounts).model_dump(
                mode="json"
            )
    except EgressPolicyRefusalError as refusal:
        first = refusal.items[0]
        return None, WfpInstallOutcome(status="skipped", reason=first.reason, tier=first.tier)
    return plan, None


_last_outcome: WfpInstallOutcome | None = None


def last_install_outcome() -> WfpInstallOutcome | None:
    """What the most recent provision in this process did with the WFP plan, or None if none ran."""
    return _last_outcome


def install_in_session(
    pipe: ProvisionPipeServer,
    session: ProvisionSession,
    owner_sid: str,
    *,
    lookup: AccountSidLookup | None = None,
    now: Callable[[], float],
) -> WfpInstallOutcome:
    """Sends the WFP plan over the provision pipe that is already open, and reports what came back.

    Reached only from the provision exchange, after the ACL receipt verified. It opens no process and
    asks for no elevation: the broker is already running elevated for this one operation. The outcome
    is also kept for :func:`last_install_outcome`, which is where the isolation report reads it.
    """
    global _last_outcome
    _last_outcome = _install_in_session(pipe, session, owner_sid, lookup, now)
    return _last_outcome


def _install_in_session(
    pipe: ProvisionPipeServer,
    session: ProvisionSession,
    owner_sid: str,
    lookup: AccountSidLookup | None,
    now: Callable[[], float],
) -> WfpInstallOutcome:
    plan, skipped = plan_install(owner_sid, lookup)
    if plan is None:
        outcome = skipped or WfpInstallOutcome(status="skipped", reason="egress_plan_unavailable")
        logger.warning(
            "native-provision: phase=wfp event=skipped reason={} tier={}",
            outcome.reason,
            outcome.tier,
        )
        return outcome
    try:
        pipe.send(
            session.seal(wfp_plan_frame(plan)), now() + _WFP_FRAME_TIMEOUT_SECONDS
        )
        body = pipe.receive(now() + _WFP_FRAME_TIMEOUT_SECONDS)
        if body is None:
            return WfpInstallOutcome(status="refused", reason="wfp_no_answer", plan=plan)
        frame = session.open(body, TO_OWNER)
    except (ProvisionWireError, ProvisionPipeTimeout, OSError) as exc:
        logger.warning(
            "native-provision: phase=wfp event=exchange_failed exception_type={}",
            type(exc).__name__,
        )
        return WfpInstallOutcome(status="refused", reason="wfp_exchange_failed", plan=plan)
    if frame["op"] == "wfp_installed":
        if frame["wfp_plan_digest"] != normalized_digest(plan):
            return WfpInstallOutcome(
                status="refused", reason="wfp_receipt_digest_mismatch", plan=plan
            )
        logger.info("native-provision: phase=wfp event=installed")
        return WfpInstallOutcome(status="installed", plan=plan)
    if frame["op"] == "wfp_refused":
        logger.warning("native-provision: phase=wfp event=refused reason={}", frame["reason"])
        return WfpInstallOutcome(status="refused", reason=str(frame["reason"]), plan=plan)
    return WfpInstallOutcome(status="refused", reason="wfp_unexpected_frame", plan=plan)


def now_seconds() -> float:
    return time.time()


def desired_plan_digest(
    owner_sid: str, lookup: AccountSidLookup | None = None
) -> str | None:
    """The digest of the plan this build wants installed, or None when none can be planned yet.

    None is not "due": a host whose tier accounts do not all resolve has no plan to install, and asking
    for a prompt on its behalf would loop.
    """
    plan, _ = plan_install(owner_sid, lookup)
    return None if plan is None else normalized_digest(dict(plan))


def record_attempt_failure(
    owner_sid: str,
    *,
    declined: bool,
    reason: str,
    marker_dir: Path | None = None,
    lookup: AccountSidLookup | None = None,
) -> None:
    """Records a WFP-only elevation that never delivered the plan, so the next start does not ask at once.

    The cooldown is the one a broker refusal sets: this is the same "do not prompt per start for a fault
    the user may not want to fix" decision, for a prompt that was dismissed or a broker that did not run.
    """
    global _last_outcome
    plan, _ = plan_install(owner_sid, lookup)
    _last_outcome = WfpInstallOutcome(
        status="declined" if declined else "failed", reason=reason, plan=plan
    )
    record_outcome(owner_sid, marker_dir)


def record_outcome(owner_sid: str, marker_dir: Path | None = None) -> None:
    """Writes the last provision's WFP outcome into the owner's marker. A skipped install writes nothing.

    A write that fails is logged, not raised: the marker is an optional UAC hint, replaced atomically, so
    it keeps its previous claim and the next start asks again.
    """
    outcome = last_install_outcome()
    if outcome is None or outcome.plan is None or outcome.status == "skipped":
        return
    try:
        mark_wfp_plan(
            owner_sid,
            plan_digest=normalized_digest(dict(outcome.plan)),
            installed=outcome.status == "installed",
            now=now_seconds(),
            marker_dir=marker_dir,
        )
    except OSError as exc:
        logger.warning(
            "native-provision: phase=wfp event=marker_write_failed status={} exception_type={} path={}",
            outcome.status,
            type(exc).__name__,
            getattr(exc, "filename", None) or marker_dir,
        )
