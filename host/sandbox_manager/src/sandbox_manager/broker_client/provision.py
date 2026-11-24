"""Provision orchestration for Sandbox Manager: tier identities and workspace access control.

Both decisions are taken here, before anything is launched, and both are recorded in the owner's
marker.
On a first start both are due, and one elevated session answers both under one UAC prompt.
Neither marker is evidence: the elevated broker re-validates every payload it is handed, and the
unelevated launcher re-reads every bound root's DACL at start.
A marker only answers "does the elevated broker have to be asked again", which is the same question as
"is a UAC prompt about to appear".
"""

from __future__ import annotations

import os
import time
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import TYPE_CHECKING, Protocol

from loguru import logger

from .elevate import (
    PROVISION_IDENTITIES_AND_SESSION,
    PROVISION_SESSION,
    ElevatedBroker,
    ElevationCancelled,
    SessionOperation,
    launch_broker_provision_session,
    run_broker_provision_elevated,
)
from . import egress_wfp
from .egress_wfp import desired_plan_digest, install_in_session, record_outcome as record_wfp_outcome
from .cache_quarantine import quarantine_disposable_caches
from .elevation_log import SESSION_ELEVATION_OPS, ElevationLog
from .errors import BrokerClientRefusal, BrokerRefusalReason, WorkspaceAclRefusal
from .identity import canonical_owner_sid
from .isolation_evidence import EVIDENCE
from .markers import (
    clear_workspace_acl_provisioned,
    mark_provisioned,
    mark_workspace_acl_provisioned,
    owner_provisioned,
    wfp_plan_due,
    workspace_acl_provisioned,
)
from .paths import resolve_broker_executable
from .provision_pipe import ProvisionPipeServer, ProvisionPipeTimeout
from .root_owner import take_back_ownership, token_user_sid
from .provision_wire import (
    TO_OWNER,
    ProvisionSession,
    ProvisionWireError,
    new_auth_key,
    new_pipe_id,
    normalized_digest,
    provision_frame,
)

if TYPE_CHECKING:
    from ..payload_integrity import VerifiedPayload

#: How long the owner waits for the elevated broker to connect. This covers a human deciding on a UAC
#: prompt, so it is generous; a dismissed prompt does not wait at all, because ``ShellExecuteExW``
#: reports that immediately.
_CONNECT_TIMEOUT_SECONDS = 120.0

#: How long either side waits for one frame once the pipe is bound. The elevated broker's own frame
#: timeout is the same, so neither side outlives the other by design.
_FRAME_TIMEOUT_SECONDS = 30.0

#: How much longer the owner waits for the receipt than for a request frame, in every provision session.
#: The broker may create three accounts between reading the request and answering it, and new accounts
#: mean every descendant of a kept data root is rewritten for the new SIDs - about 130 s for a 95k-file
#: file_tool tree. ``--provision`` alone has no bound at all (PowerShell waits for the broker to exit);
#: this wait is bounded like every other wait on the pipe.
_TIER_IDENTITY_TIMEOUT_SECONDS = 300.0

#: The one broker refusal word that is about the tier identities rather than the workspace plan.
_TIER_IDENTITY_REFUSAL = "tier_identity_provision_failed"

#: How long to wait for the elevated broker to exit after the exchange, purely so its exit code can be
#: quoted in a refusal detail.
_EXIT_TIMEOUT_SECONDS = 10.0

#: The reason the launcher reports when a bound root no longer carries the provisioned descriptor.
PROVISION_REQUIRED_REASON = BrokerRefusalReason.provision_required.value

#: The managed roots this side creates, because the elevated broker will not.
#:
#: The broker authorizes these by ownership read off its own apply handle, so the object has to exist and
#: has to be owned by the owner before the request is made - which means the owner has to create it. The
#: other two managed roots (``protected_root`` and ``isolation_root``) are absent on purpose: the broker
#: derives those paths itself, creates them itself, and writes ``Administrators`` as their object owner.
#: Creating one here would accomplish nothing - an object owner holds ``WRITE_DAC`` implicitly, and
#: ``isolation_root`` grants this account read and nothing more, so the elevated apply takes that ownership
#: back from whoever reached the name first.
OWNER_OWNED_BACKEND_ROOTS = (
    "config_root",
    "data_root",
    "logs_root",
    "payload_root",
    "temp_root",
)

#: The ancestors the broker derives from those roots (``backend_ancestors.rs``), as (scope, child root).
#: The broker requires the owner to own them too. A test pins these names to the Rust ``SCOPES``.
BACKEND_ANCESTORS = (
    ("backend_root", "config_root"),
    ("payload_container_root", "payload_root"),
    ("temp_container_root", "temp_root"),
)


class ForcibleProvision(Protocol):
    """A provision callable that can be told to ignore the marker."""

    def __call__(self, *, force: bool) -> object: ...


def _running_on_windows() -> bool:
    return os.name == "nt"


def owner_tiers_fully_provisioned(
    owner_sid: str, *, marker_dir: Path | None = None
) -> bool:
    return owner_provisioned(owner_sid, marker_dir=marker_dir)


def ensure_owner_tier_identities(
    *,
    owner_sid: str,
    payload_root: Path | None,
    verified_payload: VerifiedPayload | None,
    marker_dir: Path | None = None,
    elevate: bool = True,
    force: bool = False,
) -> None:
    sid = _require_owner_sid(owner_sid)
    if not force and owner_provisioned(sid, marker_dir=marker_dir):
        return

    if not elevate:
        raise BrokerClientRefusal.single(
            BrokerRefusalReason.tier_identity_missing,
            "owner tier identities are not provisioned",
        )

    broker_path = _resolved_broker_path(
        payload_root, verified_payload, "provision owner tier identities"
    )

    if not _running_on_windows():
        raise BrokerClientRefusal.single(
            BrokerRefusalReason.provision_elevation_failed,
            "broker provision requires Windows elevation",
        )

    with ElevationLog("provision") as elevation:
        elevation.begin()
        try:
            payload = run_broker_provision_elevated(broker_path, sid)
        except OSError as exc:
            raise BrokerClientRefusal.single(
                BrokerRefusalReason.provision_elevation_failed,
                str(exc),
            ) from exc
        if payload.get("ok") is not True:
            detail = str(payload.get("detail") or payload.get("reason") or "unknown refusal")
            raise BrokerClientRefusal.single(BrokerRefusalReason.provision_refused, detail)

    # The elevated broker is the source of truth and is idempotent. Its
    # identity records and their directory are DACL-protected to
    # SYSTEM + Administrators, so this unprivileged client records a
    # non-secret owner marker rather than reading that state back (which it
    # cannot) to confirm success.
    mark_provisioned(sid, marker_dir=marker_dir)


def current_owner_sid() -> str:
    if not _running_on_windows():
        raise BrokerClientRefusal.single(
            BrokerRefusalReason.owner_sid_unavailable,
            "owner SID lookup requires Windows",
        )
    return _windows_token_user_sid()


def _wfp_plan_is_due(owner_sid: str, marker_dir: Path | None) -> bool:
    digest = desired_plan_digest(owner_sid)
    return digest is not None and wfp_plan_due(
        owner_sid, plan_digest=digest, now=egress_wfp.now_seconds(), marker_dir=marker_dir
    )


def workspace_acl_up_to_date(
    owner_sid: str,
    *,
    path_set: Mapping[str, object],
    acl_plan: Mapping[str, object],
    marker_dir: Path | None = None,
) -> bool:
    """Whether the elevated broker has already confirmed exactly this path set and this plan.

    False is not "the roots are wrong" - it is "the elevated broker has not been asked about these
    inputs", which is the only thing a marker can tell anyone.
    """
    try:
        sid = canonical_owner_sid(owner_sid)
    except ValueError:
        return False
    return workspace_acl_provisioned(
        sid,
        path_set_digest=normalized_digest(dict(path_set)),
        acl_plan_digest=normalized_digest(dict(acl_plan)),
        marker_dir=marker_dir,
    )


def provision_steps_due(
    owner_sid: str,
    *,
    path_set: Mapping[str, object],
    acl_plan: Mapping[str, object],
    marker_dir: Path | None = None,
) -> bool:
    """Whether a start's two provision steps would ask the elevated broker for anything, by local markers.

    The markers' answer, the one ``ensure_tier_identities_and_workspace_acl`` and the ACL step after it
    reach before they elevate: no identity marker, a backend root still to create, or no receipt for these
    exact digests. A WFP plan due is not asked: planning it can read the host's proxy script and services,
    and a caller that only orders work around elevation must already tolerate a wrong answer. A drift the
    launcher reports later is not foreseen here either.
    """
    try:
        sid = canonical_owner_sid(owner_sid)
    except ValueError:
        return True
    return not (
        owner_provisioned(sid, marker_dir=marker_dir)
        and not _absent_owner_owned_backend_roots(path_set)
        and workspace_acl_up_to_date(sid, path_set=path_set, acl_plan=acl_plan, marker_dir=marker_dir)
    )


def _install_wfp_plan_only(
    sid: str,
    *,
    path_set: Mapping[str, object],
    acl_plan: Mapping[str, object],
    payload_root: Path | None,
    verified_payload: VerifiedPayload | None,
    marker_dir: Path | None,
) -> Mapping[str, object] | None:
    """The provision elevation for a start whose roots are already provisioned and only the WFP plan is due.

    The plan is optional while enforcement is off: the launcher re-reads every root's DACL whatever happens
    here, and the ACL record and its evidence are left as they are. A dismissed prompt, a broker that did
    not launch or answer, or a refusal ends the attempt, records it so the next start inside the cooldown
    does not prompt again, and lets the start continue. Only the WFP marker changes on success.
    """
    try:
        broker_path = _resolved_broker_path(
            payload_root, verified_payload, "install the egress plan"
        )
        if not _running_on_windows():
            raise BrokerClientRefusal.single(
                BrokerRefusalReason.provision_elevation_failed,
                "the provision pipe requires Windows elevation",
            )
        _create_owner_owned_backend_roots(path_set)
        receipt = _run_provision_session(broker_path, sid, dict(path_set), dict(acl_plan))
    except BrokerClientRefusal as refusal:
        reason = refusal.items[0].reason
        logger.warning("native-provision: phase=wfp event=not_installed reason={}", reason.value)
        egress_wfp.record_attempt_failure(
            sid,
            declined=reason is BrokerRefusalReason.provision_elevation_declined,
            reason=reason.value,
            marker_dir=marker_dir,
        )
        return None
    record_wfp_outcome(sid, marker_dir)
    return receipt


def ensure_workspace_acl_provisioned(
    *,
    owner_sid: str,
    path_set: Mapping[str, object],
    acl_plan: Mapping[str, object],
    payload_root: Path | None,
    verified_payload: VerifiedPayload | None,
    marker_dir: Path | None = None,
    elevate: bool = True,
    force: bool = False,
) -> Mapping[str, object] | None:
    """Converges this owner's managed roots onto ``acl_plan``, elevating at most once.

    Returns the elevated broker's receipt if a provision ran, or ``None`` if the marker already recorded
    these exact digests and no elevation was needed.
    Raises a typed refusal otherwise - there is deliberately no third outcome in which the caller may
    launch without the plan having been applied.

    ``force`` skips the marker short-circuit, and exists because the marker is a UAC hint rather than
    evidence.
    When the launcher's own DACL readback reports drift, the marker still records these exact digests, so
    without ``force`` the repair the launcher asked for would return ``None`` and change nothing.
    """
    sid = _require_owner_sid(owner_sid)
    if not force and workspace_acl_up_to_date(
        sid, path_set=path_set, acl_plan=acl_plan, marker_dir=marker_dir
    ):
        # An app update that ships a new egress plan makes the plan, not the ACL, the reason to ask the one
        # provision elevation again. Without elevation it is not a reason to refuse the start.
        EVIDENCE.record_provision(
            owner_sid=sid,
            path_set=path_set,
            acl_plan=acl_plan,
            payload_root=payload_root,
            verified_payload=verified_payload,
            source="marker",
        )
        if not elevate or not _wfp_plan_is_due(sid, marker_dir):
            return None
        return _install_wfp_plan_only(
            sid,
            path_set=path_set,
            acl_plan=acl_plan,
            payload_root=payload_root,
            verified_payload=verified_payload,
            marker_dir=marker_dir,
        )

    # Whatever this attempt does, the previous record no longer describes the current path set.
    EVIDENCE.clear_provision()
    if not elevate:
        raise BrokerClientRefusal.single(
            BrokerRefusalReason.provision_required,
            "the managed roots need an elevated provision for this workspace",
        )

    broker_path = _resolved_broker_path(
        payload_root, verified_payload, "apply the workspace access control plan"
    )
    if not _running_on_windows():
        raise BrokerClientRefusal.single(
            BrokerRefusalReason.provision_elevation_failed,
            "the provision pipe requires Windows elevation",
        )

    _create_owner_owned_backend_roots(path_set)
    receipt = _run_provision_session(broker_path, sid, dict(path_set), dict(acl_plan))
    # After, never before. A marker written ahead of the receipt would be a claim about a provision that
    # had not happened yet, and a crash between the two would leave it standing.
    _record_workspace_acl_marker(
        sid, receipt, marker_dir=marker_dir
    )
    EVIDENCE.record_provision(
        owner_sid=sid,
        path_set=path_set,
        acl_plan=acl_plan,
        payload_root=payload_root,
        verified_payload=verified_payload,
        source="receipt",
    )
    record_wfp_outcome(sid, marker_dir)
    return receipt


def _record_workspace_acl_marker(
    owner_sid: str,
    receipt: Mapping[str, object],
    *,
    marker_dir: Path | None,
) -> None:
    observation = receipt.get("observation")
    if _convergence_requires_retry(observation):
        clear_workspace_acl_provisioned(owner_sid, marker_dir=marker_dir)
        return
    mark_workspace_acl_provisioned(
        owner_sid,
        path_set_digest=str(receipt["path_set_digest"]),
        acl_plan_digest=str(receipt["acl_plan_digest"]),
        marker_dir=marker_dir,
    )


def _convergence_requires_retry(value: object) -> bool:
    metrics_list = _convergence_metrics(value)
    if not metrics_list:
        if (
            isinstance(value, Mapping)
            and value.get("descendant_convergence_required") is False
        ):
            return False
        return True
    for metrics in metrics_list:
        skipped = metrics.get("skipped")
        truncated = metrics.get("skipped_entries_truncated")
        entries = metrics.get("skipped_entries")
        retryable_skips = metrics.get("retryable_skips")
        coverage_bound_exceeded = metrics.get("coverage_bound_exceeded")
        if (
            type(skipped) is not int
            or type(truncated) is not bool
            or not isinstance(entries, list)
            or (
                retryable_skips is not None
                and type(retryable_skips) is not int
            )
            or (
                coverage_bound_exceeded is not None
                and type(coverage_bound_exceeded) is not bool
            )
        ):
            return True
        if skipped < 0:
            return True
        if coverage_bound_exceeded is True:
            return True
        if retryable_skips is not None and retryable_skips < 0:
            return True
        if retryable_skips is not None and retryable_skips > 0:
            return True
        if skipped == 0:
            continue
        if retryable_skips is not None:
            continue
        if truncated or skipped > len(entries):
            return True
        for entry in entries:
            if not isinstance(entry, Mapping):
                continue
            reason = entry.get("reason")
            if isinstance(reason, str) and (
                reason == "multiply_linked"
                or reason
                in {
                    "managed_path_not_absolute",
                    "managed_path_too_deep",
                    "managed_path_component_not_normal",
                    "managed_path_object_type",
                    "managed_path_reparse_point",
                    "managed_path_identity_mismatch",
                }
                or "reparse" in reason
            ):
                continue
            return True
    return False


def ensure_tier_identities_and_workspace_acl(
    *,
    owner_sid: str,
    path_set: Mapping[str, object],
    acl_plan: Mapping[str, object],
    payload_root: Path | None,
    verified_payload: VerifiedPayload | None,
    marker_dir: Path | None = None,
) -> None:
    """Ensures the owner's tier identities, and on a first start the workspace plan under the same prompt.

    Both are due on a first start: no identity marker, and the workspace plan due too - no receipt for
    these exact payloads, or a backend root that does not exist yet, which the start's ACL step forces a
    re-apply for whatever its marker says.
    That case is one elevated ``--provision-identities-and-session``, and both markers are written from its
    receipt, so the ACL step that follows finds the roots present and the marker current and asks for
    nothing. Every other case is unchanged: identities alone go through ``ensure_owner_tier_identities``,
    and a workspace plan alone is left to the ACL step.

    Neither marker is written on a refusal, even one the session raised after the identity step succeeded -
    the receipt does not say which step refused - so the next start asks again, and the broker's identity
    step is idempotent.

    A refusal of the combined session is a ``WorkspaceAclRefusal`` unless the broker answered
    ``tier_identity_provision_failed``: a declined prompt, a pipe that timed out or broke, a broker that
    exited without answering, a backend root this side could not create, and a refused plan are the same
    failures the ACL step would report, and they keep its recovery codes.
    """
    sid = _require_owner_sid(owner_sid)
    if owner_provisioned(sid, marker_dir=marker_dir) and workspace_acl_up_to_date(
        sid, path_set=path_set, acl_plan=acl_plan, marker_dir=marker_dir
    ):
        return
    if not _absent_owner_owned_backend_roots(path_set) and workspace_acl_up_to_date(
        sid, path_set=path_set, acl_plan=acl_plan, marker_dir=marker_dir
    ):
        ensure_owner_tier_identities(
            owner_sid=sid,
            payload_root=payload_root,
            verified_payload=verified_payload,
            marker_dir=marker_dir,
        )
        return

    broker_path = _resolved_broker_path(
        payload_root,
        verified_payload,
        "provision tier identities and the workspace access control plan",
    )
    EVIDENCE.clear_provision()
    if not _running_on_windows():
        raise BrokerClientRefusal.single(
            BrokerRefusalReason.provision_elevation_failed,
            "the provision pipe requires Windows elevation",
        )

    try:
        _create_owner_owned_backend_roots(path_set)
        # With no identity marker the session creates the tier accounts, so every file under the kept data
        # roots is rewritten for new SIDs and the caches go first instead of being walked. A stale
        # workspace marker alone changes no SID, so it costs no cache.
        if not owner_provisioned(sid, marker_dir=marker_dir):
            quarantine_disposable_caches(path_set)
        receipt = _run_provision_session(
            broker_path,
            sid,
            dict(path_set),
            dict(acl_plan),
            operation=PROVISION_IDENTITIES_AND_SESSION,
        )
    except BrokerClientRefusal as refusal:
        if any(item.broker_refusal == _TIER_IDENTITY_REFUSAL for item in refusal.items):
            raise
        raise WorkspaceAclRefusal(refusal.items) from refusal
    mark_provisioned(sid, marker_dir=marker_dir)
    _record_workspace_acl_marker(
        sid, receipt, marker_dir=marker_dir
    )
    EVIDENCE.record_provision(
        owner_sid=sid,
        path_set=path_set,
        acl_plan=acl_plan,
        payload_root=payload_root,
        verified_payload=verified_payload,
        source="receipt",
    )
    record_wfp_outcome(sid, marker_dir)


def is_workspace_acl_refusal(refusal: BrokerClientRefusal) -> bool:
    """Whether ``ensure_tier_identities_and_workspace_acl`` failed anywhere but the tier identities.

    A start that provisions both under one prompt reports such a failure the way the ACL step that would
    otherwise have provisioned the plan does.
    """
    return isinstance(refusal, WorkspaceAclRefusal)


def start_with_provision_retry(
    *,
    start: Callable[[], Mapping[str, object]],
    provision: ForcibleProvision,
) -> Mapping[str, object]:
    """Runs ``start``; on a typed ``provision_required`` refusal, provisions once and runs it again.

    Once, not until it works. A provision that ran to completion and still left a bound root drifted is
    reporting something a second identical attempt cannot change, and a client that kept retrying would
    turn that into an unbounded series of UAC prompts. The second refusal is raised.

    The provision is asked for with ``force=True``. The launcher only reports ``provision_required`` after
    reading the real DACLs, so arriving here means the marker and the objects disagree; a marker-gated
    provision would look at the marker, find these digests already recorded, and repair nothing.

    There is no branch here that continues to a launch without the plan applied. That is the whole point
    of the helper: marker-only operation is not a fallback this client has.
    """
    outcome = start()
    if not _is_provision_required(outcome):
        return outcome
    provision(force=True)
    retried = start()
    if _is_provision_required(retried):
        raise BrokerClientRefusal.single(
            BrokerRefusalReason.provision_required,
            str(retried.get("detail") or "managed roots are still not provisioned"),
        )
    return retried


def create_owner_owned_backend_roots(path_set: Mapping[str, object]) -> list[str]:
    """Create the owner roots and report which scopes were absent beforehand."""
    created = _absent_owner_owned_backend_roots(path_set)
    _create_owner_owned_backend_roots(path_set)
    return created


def _absent_owner_owned_backend_roots(path_set: Mapping[str, object]) -> list[str]:
    return [
        scope
        for scope in OWNER_OWNED_BACKEND_ROOTS
        if isinstance(path_set.get(scope), str)
        and not Path(str(path_set[scope])).exists()
    ]


def _create_owner_owned_backend_roots(path_set: Mapping[str, object]) -> None:
    """Creates the backend roots the elevated broker refuses to create, as the owner, before elevating.

    This is the client half of the broker's rule that an elevated process does not create a directory at a
    path a caller named.
    Created here, the directory is owned by the owner who is asking, which is exactly the fact the broker
    then reads off its own apply handle to authorize the write.

    A root an elevated run created is owned by ``Administrators`` and is handed back to the token user
    here (#3176). Whether the path is a reparse point, whether it lands where its name says, and whether
    the owner really owns it are still re-decided on the elevated side, on a handle, and nothing checked
    here would be evidence there.
    """
    owned: list[tuple[str, Path]] = []
    for scope in OWNER_OWNED_BACKEND_ROOTS:
        value = path_set.get(scope)
        if not isinstance(value, str) or not value:
            raise BrokerClientRefusal.single(
                BrokerRefusalReason.provision_refused,
                f"the path set does not name a {scope} to provision",
            )
        try:
            Path(value).mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise BrokerClientRefusal.single(
                BrokerRefusalReason.provision_refused,
                f"could not create {scope} at {value} as the owner: {exc}",
            ) from exc
        owned.append((scope, Path(value)))
    roots = dict(owned)
    owned += [(scope, roots[child].parent) for scope, child in BACKEND_ANCESTORS]
    # Only the default workspace the app creates itself; a root the user chose, or one moved by
    # WINDOWS_SUPERCLAW_PATH, keeps the broker's verdict.
    profile = os.environ.get("USERPROFILE")
    default_workspace = Path(profile) / "SuperClawProjects" if profile else None
    for member in path_set.get("workspace_roots") or ():
        if (
            default_workspace is not None
            and isinstance(member, Mapping)
            and member.get("policy_class") == "managed_default"
            and Path(str(member.get("path"))) == default_workspace
            and default_workspace.is_dir()
        ):
            owned.append(("workspace_root", default_workspace))
    for scope, path in owned:
        try:
            previous_owner = take_back_ownership(path)
        except OSError as exc:
            raise BrokerClientRefusal.single(
                BrokerRefusalReason.provision_refused,
                f"{scope} at {path} is not owned by the owner and could not be taken back: {exc}",
            ) from exc
        if previous_owner is not None:
            logger.info(
                "native-provision: phase=owner_repair event=repaired scope={} previous_owner={}",
                scope,
                previous_owner,
            )


def _is_provision_required(payload: Mapping[str, object]) -> bool:
    return payload.get("ok") is False and payload.get("reason") == (
        PROVISION_REQUIRED_REASON
    )


def _run_provision_session(
    broker_path: Path,
    owner_sid: str,
    path_set: dict[str, object],
    acl_plan: dict[str, object],
    *,
    operation: SessionOperation = PROVISION_SESSION,
) -> dict[str, object]:
    """One provision exchange, from pipe creation to the receipt, and nothing reusable afterwards.

    The pipe is created before the broker is launched, so there is no window in which the name exists
    unclaimed, and it is closed on the way out either way: this pipe serves one elevated broker, once.
    """
    with ElevationLog(SESSION_ELEVATION_OPS[operation]) as elevation:
        return _provision_session(
            broker_path, owner_sid, path_set, acl_plan, elevation, operation
        )


def _provision_session(
    broker_path: Path,
    owner_sid: str,
    path_set: dict[str, object],
    acl_plan: dict[str, object],
    elevation: ElevationLog,
    operation: SessionOperation,
) -> dict[str, object]:
    """The exchange :func:`_run_provision_session` describes, telling ``elevation`` when it prompts."""
    key = new_auth_key()
    pipe_id = new_pipe_id()
    session = ProvisionSession(key, owner_sid)
    # Every session can follow new tier SIDs, not only the combined one: a stale marker sends the owner
    # through a session-only refusal, ``--provision`` and then a second session-only provision, and that
    # second one rewrites every descendant of the kept data roots. An early broker exit closes the pipe
    # and ends the wait at once, so a long bound only matters while the broker is still working.
    receipt_timeout = _FRAME_TIMEOUT_SECONDS + _TIER_IDENTITY_TIMEOUT_SECONDS
    logger.info("native-provision: phase=session event=begin")
    try:
        with ProvisionPipeServer(pipe_id, owner_sid) as pipe:
            try:
                logger.info("native-provision: phase=elevation event=begin")
                elevation.begin()
                broker = launch_broker_provision_session(
                    broker_path, owner_sid, pipe_id, key.hex(), operation
                )
            except ElevationCancelled as exc:
                logger.warning("native-provision: phase=elevation event=declined")
                raise BrokerClientRefusal.single(
                    BrokerRefusalReason.provision_elevation_declined, str(exc)
                ) from exc
            except OSError as exc:
                logger.error(
                    "native-provision: phase=elevation event=failed exception_type={}",
                    type(exc).__name__,
                )
                raise BrokerClientRefusal.single(
                    BrokerRefusalReason.provision_elevation_failed, str(exc)
                ) from exc
            elevation.consented()
            logger.info("native-provision: phase=elevation event=started")
            with broker:
                receipt = _exchange(
                    pipe, broker, session, path_set, acl_plan, receipt_timeout
                )
                # Same pipe, same elevated process, no second prompt: the broker takes the WFP plan after
                # the ACL receipt. Nothing it reports here can fail the provision.
                install_in_session(pipe, session, owner_sid, now=time.monotonic)
            logger.info("native-provision: phase=session event=completed")
            return receipt
    except ProvisionWireError as exc:
        raise BrokerClientRefusal.single(
            BrokerRefusalReason.provision_pipe_refused, f"{exc.code}: {exc.detail}"
        ) from exc
    except PermissionError as exc:
        raise BrokerClientRefusal.single(
            BrokerRefusalReason.provision_pipe_refused, str(exc)
        ) from exc
    except OSError as exc:
        logger.error(
            "native-provision: phase=session event=failed exception_type={}",
            type(exc).__name__,
        )
        raise BrokerClientRefusal.single(
            BrokerRefusalReason.provision_elevation_failed, str(exc)
        ) from exc


def _exchange(
    pipe: ProvisionPipeServer,
    broker: ElevatedBroker,
    session: ProvisionSession,
    path_set: dict[str, object],
    acl_plan: dict[str, object],
    receipt_timeout: float,
) -> dict[str, object]:
    """Sends one request, reads one answer, and refuses everything else."""
    logger.info("native-provision: phase=connect event=begin timeout_s={}", _CONNECT_TIMEOUT_SECONDS)
    try:
        pipe.await_client(broker.pid, time.monotonic() + _CONNECT_TIMEOUT_SECONDS)
    except ProvisionPipeTimeout as exc:
        logger.error("native-provision: phase=connect event=timeout")
        raise BrokerClientRefusal.single(
            BrokerRefusalReason.provision_connect_timeout, str(exc)
        ) from exc
    logger.info("native-provision: phase=connect event=end")
    request = session.seal(provision_frame(path_set, acl_plan))
    logger.info("native-provision: phase=exchange event=begin timeout_s={}", receipt_timeout)
    try:
        pipe.send(request, time.monotonic() + _FRAME_TIMEOUT_SECONDS)
        body = pipe.receive(time.monotonic() + receipt_timeout)
    except ProvisionPipeTimeout as exc:
        logger.error("native-provision: phase=exchange event=timeout")
        raise BrokerClientRefusal.single(
            BrokerRefusalReason.provision_frame_timeout, str(exc)
        ) from exc
    if body is None:
        exit_code = broker.wait(_EXIT_TIMEOUT_SECONDS)
        logger.error(
            "native-provision: phase=exchange event=broker_exited exit_code={}",
            exit_code,
        )
        raise BrokerClientRefusal.single(
            BrokerRefusalReason.provision_broker_exited,
            "the elevated broker closed the provision pipe without answering"
            + (f" (exit code {exit_code})" if exit_code is not None else ""),
        )
    frame = session.open(body, TO_OWNER)
    if frame["op"] == "refused":
        logger.error(
            "native-provision: phase=receipt event=refused reason={}",
            frame["reason"],
        )
        raise BrokerClientRefusal.single(
            BrokerRefusalReason.provision_refused,
            str(frame["reason"]),
            broker_refusal=str(frame["reason"]),
        )
    receipt = _verified_receipt(frame, path_set, acl_plan)
    logger.info("native-provision: phase=receipt event=verified")
    for metrics in _convergence_metrics(receipt["observation"]):
        integer_fields = ("visited", "repaired", "skipped", "duration_ms")
        if any(type(metrics.get(field)) is not int for field in integer_fields):
            logger.warning(
                "native-provision: event=convergence_metric_malformed missing_or_invalid_fields={}",
                integer_fields,
            )
            continue
        skipped_entries = metrics.get("skipped_entries")
        skipped_entries_truncated = metrics.get("skipped_entries_truncated")
        if not isinstance(skipped_entries, list) or type(skipped_entries_truncated) is not bool:
            logger.warning(
                "native-provision: event=convergence_metric_malformed "
                "invalid_skipped_entries_shape=true"
            )
            continue
        logger.info(
            "native-provision: event=convergence_walk scope={} tier={} visited={} "
            "repaired={} skipped={} duration_ms={} skipped_entries_truncated={}",
            metrics.get("scope", "unknown"),
            metrics.get("tier", "unknown"),
            metrics["visited"],
            metrics["repaired"],
            metrics["skipped"],
            metrics["duration_ms"],
            metrics["skipped_entries_truncated"],
        )
        for entry in skipped_entries:
            if not isinstance(entry, Mapping):
                continue
            logger.warning(
                "native-provision: event=convergence_skip path={} reason={}",
                entry.get("path"),
                entry.get("reason"),
            )
    return receipt


def _convergence_metrics(
    value: object,
    *,
    scope: str | None = None,
    tier: str | None = None,
) -> list[Mapping[str, object]]:
    if isinstance(value, list):
        found: list[Mapping[str, object]] = []
        for child in value:
            found.extend(_convergence_metrics(child, scope=scope, tier=tier))
        return found
    if not isinstance(value, Mapping):
        return []
    observed_scope = value.get("managed_root_scope")
    if not isinstance(observed_scope, str):
        observed_scope = scope
    observed_tier = value.get("tier")
    if not isinstance(observed_tier, str):
        observed_tier = tier
    found = []
    convergence = value.get("convergence")
    if isinstance(convergence, Mapping):
        metric = dict(convergence)
        if observed_scope is not None:
            metric["scope"] = observed_scope
        if observed_tier is not None:
            metric["tier"] = observed_tier
        found.append(metric)
    for child in value.values():
        found.extend(
            _convergence_metrics(child, scope=observed_scope, tier=observed_tier)
        )
    return found


def _verified_receipt(
    frame: Mapping[str, object],
    path_set: Mapping[str, object],
    acl_plan: Mapping[str, object],
) -> dict[str, object]:
    """The receipt, checked against the payloads this client actually sent.

    The broker normalizes before it digests, and so does this client, so the two have to agree. If they
    do not, the receipt is describing some other pair of payloads and is refused rather than recorded -
    a marker written from it would claim a provision that did not happen for these inputs.
    """
    expected = {
        "path_set_digest": normalized_digest(dict(path_set)),
        "acl_plan_digest": normalized_digest(dict(acl_plan)),
    }
    for field, value in expected.items():
        if frame[field] != value:
            raise BrokerClientRefusal.single(
                BrokerRefusalReason.provision_pipe_refused,
                f"the receipt's {field} does not describe the payload that was sent",
            )
    # The broker's own digests, not this client's copies of them. They have just been checked equal, so
    # the two are interchangeable in value - but the marker is a record of what the elevated side said,
    # and reading it out of the frame is what keeps that true if the check above is ever loosened.
    return {
        "path_set_digest": frame["path_set_digest"],
        "acl_plan_digest": frame["acl_plan_digest"],
        "observation": frame["observation"],
    }


def _resolved_broker_path(
    payload_root: Path | None,
    verified_payload: VerifiedPayload | None,
    purpose: str,
) -> Path:
    """The broker executable, resolved out of the verified payload."""
    broker_path = resolve_broker_executable(
        payload_root=payload_root, verified=verified_payload
    )
    if broker_path is None:
        raise BrokerClientRefusal.single(
            BrokerRefusalReason.broker_not_found,
            f"broker executable not found; cannot {purpose}",
        )
    return broker_path.resolve()


def _require_owner_sid(owner_sid: str) -> str:
    try:
        return canonical_owner_sid(owner_sid)
    except ValueError as exc:
        raise BrokerClientRefusal.single(
            BrokerRefusalReason.owner_sid_unavailable,
            str(exc),
        ) from exc


def _windows_token_user_sid() -> str:
    # In process, never a child: this runs on every start, and a PowerShell child costs seconds there.
    try:
        return token_user_sid()
    except OSError as exc:
        raise BrokerClientRefusal.single(
            BrokerRefusalReason.owner_sid_unavailable,
            str(exc),
        ) from exc
