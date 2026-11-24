"""The native isolation report as the diagnostics endpoint publishes it.

Contract touched: ``RuntimeStatus`` (the isolation report). This module only wires: the evidence the broker
client recorded (``broker_client.isolation_evidence``), a fresh read-only DACL readback of the current
roots through the launcher (``broker_client.acl_readback``), and the tier account SIDs resolved by name,
into ``native_isolation.isolation_report_producer``, which decides what the evidence lets the report say.
What the host MCP gateway runs outside the sandbox comes from ``host_mcp_activity``.

The readback is what makes the report move. It is cached for ``READBACK_MAX_AGE_SECONDS`` so a UI polling
the endpoint costs one short launcher process per interval and not one per request, and it is bounded by
the readback's own timeout so the call cannot hang on a stuck launcher: a readback that did not run is
reported as ``not_read``. The tier account SIDs are resolved by name for the readback too, so the launcher
pins every tier ACE to its own account; a tier that does not resolve makes the readback ``not_read``
(``tier_sids_unresolved``) rather than a looser match. Deleting a tier ACE on a workspace root is therefore
visible on the first request after the cache ages out, and never after a repair this side did not make -
the launcher cannot write.

The provision record can be replaced while the launcher runs (diagnostics runs in a worker thread, and a
re-provision clears the record before it may be refused). A readback is only published for the record that
is still current afterwards: otherwise the new record is read once, and if it moved again the report names
the current record (or none) with ``not_read``. A result for a superseded record is never cached.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable, Mapping

from loguru import logger

from .broker_client.account_sid import AccountSidLookup, lookup_local_account_sid
from .broker_client.acl_readback import (
    AclReadbackOutcome,
    UnelevatedRunner,
    read_back_roots,
)
from .broker_client.identity import TIERS, tier_account_name
from .broker_client.isolation_evidence import (
    EVIDENCE,
    IsolationEvidence,
    ProvisionRecord,
)
from .host_mcp_activity import HostMcpActivityCache
from .native_isolation.isolation_report_producer import (
    NOT_READ,
    AclReadback,
    AclReadbackVerdict,
    HostMcpActivity,
    ProvisionEvidence,
    RunningRole,
    produce_isolation_report,
)

#: Shorter than a person refreshing a panel, long enough that a poll does not spawn a launcher per call.
READBACK_MAX_AGE_SECONDS = 5.0

_VERDICT_WORDS: Mapping[str, AclReadbackVerdict] = {
    "matches": "matches_shipped_descriptor",
    "drifted": "drifted",
    "not_read": "not_read",
}


class _ReadbackCache:
    """The latest readback, reused while it is young and while it is about the same provision."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._provision: ProvisionRecord | None = None
        self._taken_at = 0.0
        self._readback = NOT_READ

    def get(
        self,
        provision: ProvisionRecord,
        read: Callable[[], AclReadbackOutcome],
        clock: Callable[[], float],
        is_current: Callable[[], bool],
    ) -> AclReadback:
        """The readback for ``provision``; stored only if it is still the current provision afterwards.

        The read blocks on a launcher, so a re-provision can replace the record while it runs. A result
        for a record that is no longer current is returned to the caller (who discards it) but never
        cached, so it cannot be served for a later request.
        """
        with self._lock:
            fresh = (
                self._provision is provision
                and clock() - self._taken_at < READBACK_MAX_AGE_SECONDS
            )
            if not fresh:
                outcome = read()
                if outcome.verdict == "not_read" or outcome.detail.get("drifted"):
                    logger.info(
                        "isolation-report: event=acl_readback verdict={} detail={}",
                        outcome.verdict,
                        dict(outcome.detail),
                    )
                readback = AclReadback(
                    verdict=_VERDICT_WORDS[outcome.verdict],
                    read_at=outcome.read_at,
                )
                if not is_current():
                    return readback
                self._readback = readback
                self._provision = provision
                self._taken_at = clock()
            return self._readback

    def reset(self) -> None:
        with self._lock:
            self._provision = None
            self._taken_at = 0.0
            self._readback = NOT_READ


_CACHE = _ReadbackCache()
HOST_MCP_ACTIVITY = HostMcpActivityCache()


def reset_for_tests() -> None:
    EVIDENCE.reset()
    _CACHE.reset()


def current_isolation_report(
    *,
    evidence: IsolationEvidence = EVIDENCE,
    read: Callable[..., AclReadbackOutcome] = read_back_roots,
    run: UnelevatedRunner | None = None,
    lookup: AccountSidLookup = lookup_local_account_sid,
    clock: Callable[[], float] = time.monotonic,
    host_mcp: Callable[[], HostMcpActivity | None] | None = None,
) -> dict[str, object]:
    """The report for this moment. Blocking: it may run the launcher, so call it off the event loop."""
    host_activity = (host_mcp or HOST_MCP_ACTIVITY.current)()

    def readback_of(provision: ProvisionRecord | None) -> AclReadback:
        if provision is None or provision.launcher is None:
            return NOT_READ
        launcher = provision.launcher

        def run_readback() -> AclReadbackOutcome:
            tier_sids = _resolved_tier_sids(provision.owner_sid, lookup)
            if run is None:
                return read(
                    launcher,
                    provision.owner_sid,
                    provision.path_set,
                    tier_sids,
                )
            return read(
                launcher,
                provision.owner_sid,
                provision.path_set,
                tier_sids,
                run=run,
            )

        return _CACHE.get(
            provision,
            run_readback,
            clock,
            lambda: evidence.provision() is provision,
        )

    # A readback is only about the record it read. If a re-provision replaced it while the launcher ran,
    # read the new one once; if it moved again, publish the current record with no readback.
    provision = evidence.provision()
    readback = NOT_READ
    for _ in range(2):
        readback = readback_of(provision)
        current = evidence.provision()
        if current is provision:
            break
        provision = current
        readback = NOT_READ
    # Read after the readback, which can block for two launcher runs: a role that exited meanwhile is gone.
    launches = evidence.running_launches()
    owner_sid = (
        provision.owner_sid
        if provision is not None
        else (launches[0].owner_sid if launches else None)
    )
    return produce_isolation_report(
        provision=(
            ProvisionEvidence(
                source=provision.source,
                acl_policy_version=provision.acl_policy_version,
                workspace_root_classes=provision.workspace_root_classes,
            )
            if provision is not None
            else None
        ),
        roles=[
            RunningRole(
                tier=launch.tier,
                owner_sid=launch.owner_sid,
                runner_sid=launch.runner_sid,
                job_verified=launch.job_verified,
                started_at=launch.started_at,
            )
            for launch in launches
        ],
        readback=readback,
        tier_sids=_tier_sids(owner_sid, lookup) if launches else {},
        host_mcp=host_activity,
    )


def _resolved_tier_sids(owner_sid: str, lookup: AccountSidLookup) -> dict[str, str]:
    """The tier SIDs that resolve now; a tier that does not is left out and the readback is not run."""
    return {
        tier: sid
        for tier, sid in _tier_sids(owner_sid, lookup).items()
        if sid is not None
    }


def _tier_sids(
    owner_sid: str | None, lookup: AccountSidLookup
) -> Mapping[str, str | None]:
    """The SID each tier account resolves to now, by its derived name."""
    if owner_sid is None:
        return {}
    return {tier: lookup(tier_account_name(owner_sid, tier)) for tier in TIERS}
