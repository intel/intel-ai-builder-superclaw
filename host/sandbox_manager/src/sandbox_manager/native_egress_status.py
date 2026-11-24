"""Where the WFP install outcome and the unelevated readback are kept, run and published.

Contract touched: ``RuntimeStatus`` (``GET .../agent/sandbox/diagnostics``, ``isolation_report``). Adapter:
this module; the diagnostics route reads it and nothing else. It only wires, as ``native_isolation_report``
does: the install outcome and the readback come from ``broker_client``, and what the report may claim from
them is ``native_isolation.egress_evidence``'s, which is handed plain values.

A start schedules one readback and does not wait for it: the readback runs on its own thread under the
launcher's timeout, records its verdict here, and logs one line. A failure of any kind is a ``not_read``
verdict with an error code, never an exception into the start.

The published report stays the fail-closed one - no level is established, because nothing in this build
applies the file policy or proves the tier launches - and gains exactly two things when a readback has
run: the egress policy version with its readback evidence, and an ``egress_policy_drifted`` warning when
that readback found drift. With an egress version and no file policy version, the reason the level is not
established is ``policy_version_unavailable``, which is the one the rules accept for that pair.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable, Mapping
from copy import deepcopy
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from loguru import logger

from .broker_client.egress_readback import (
    EgressReadback,
    UnelevatedRunner,
    read_back_installed,
)
from .broker_client.egress_wfp import (
    AccountSidLookup,
    WfpInstallOutcome,
    last_install_outcome,
)
from .native_isolation.egress_evidence import egress_policy_version_evidence
from .native_isolation.isolation_report_rules import (
    IsolationReportRefusal,
    validate_isolation_report,
)

#: A start that follows another within this long reuses the readback already taken, so the several
#: roles one start launches cost one read.
_DEBOUNCE_SECONDS = 60.0

#: How often the installed objects are read back after the start's own readback. A constant on purpose: drift
#: detection is part of enforcement, so there is no setting, flag or variable that turns it off.
READBACK_INTERVAL_SECONDS = 15 * 60


@dataclass(frozen=True)
class EgressStatus:
    """The latest readback, the plan it was compared with, and what the last provision did."""

    readback: EgressReadback
    plan: Mapping[str, Any] | None
    install: WfpInstallOutcome | None


_lock = threading.Lock()
_latest: EgressStatus | None = None
_in_flight = False
_last_started_at: float | None = None
# Every read takes a number when it starts; only a read newer than the published one publishes. A start-triggered
# read and the periodic one can overlap, and a read that started earlier but finished later must not replace a
# newer result (a clean read would hide the drift warning a newer read found). A number instead of one in-flight
# guard for both, because skipping a periodic read would delay drift detection by a whole interval.
_started_reads = 0
_published_read = 0


def latest_status() -> EgressStatus | None:
    with _lock:
        return _latest


def reset_for_tests() -> None:
    global _latest, _in_flight, _last_started_at, _periodic_started, _started_reads, _published_read
    with _lock:
        _latest, _in_flight, _last_started_at = None, False, None
        _periodic_started = False
        _started_reads = _published_read = 0


def _event(status: EgressStatus) -> str:
    install = status.install
    if install is None:
        return "readback"
    return "installed" if install.status == "installed" else "install_failed"


def run_readback(
    owner_sid: str,
    launcher_path: Path,
    *,
    lookup: AccountSidLookup | None = None,
    run: UnelevatedRunner | None = None,
    now: Callable[[], str] | None = None,
) -> EgressStatus:
    """Reads our WFP objects back once, records the result and logs its one line. A result older than the
    one already published is returned but neither published nor logged."""
    global _latest, _started_reads, _published_read
    with _lock:
        _started_reads += 1
        this_read = _started_reads
    options: dict[str, Any] = {}
    if run is not None:
        options["run"] = run
    if now is not None:
        options["now"] = now
    try:
        plan, readback = read_back_installed(owner_sid, launcher_path, lookup=lookup, **options)
    except Exception as exc:  # noqa: BLE001 - nothing the readback does may reach the start
        plan = None
        readback = EgressReadback(
            verdict="not_read",
            read_at=None,
            detail={"reason": "readback_exception", "exception_type": type(exc).__name__},
        )
    status = EgressStatus(readback=readback, plan=plan, install=last_install_outcome())
    with _lock:
        stale = this_read < _published_read
        if not stale:
            _latest, _published_read = status, this_read
    if stale:
        return status
    install = status.install
    logger.info(
        "native-start: phase=wfp event={} verdict={} read_at={} install={} reason={}",
        _event(status),
        readback.verdict,
        readback.read_at,
        install.status if install else "not_run",
        (install.reason if install and install.reason else readback.detail.get("reason")),
    )
    if readback.verdict == "drifted":
        # Reported, never repaired: a repair is an elevated write, and drift is something a person looks at.
        logger.warning(
            "native-start: phase=wfp event=egress_policy_drifted read_at={} sublayer={} missing={} changed={} extra={}",
            readback.read_at,
            readback.detail.get("sublayer"),
            len(readback.detail.get("missing", [])),
            len(readback.detail.get("changed", [])),
            len(readback.detail.get("extra", [])),
        )
    return status


def schedule_readback(
    owner_sid: str,
    launcher_path: Path,
    *,
    spawn: Callable[[Callable[[], None]], object] | None = None,
    clock: Callable[[], float] = time.monotonic,
    **options: Any,
) -> bool:
    """Starts one readback without waiting for it. False when one is running or one was just taken."""
    global _in_flight, _last_started_at
    with _lock:
        recent = _last_started_at is not None and clock() - _last_started_at < _DEBOUNCE_SECONDS
        if _in_flight or recent:
            return False
        _in_flight, _last_started_at = True, clock()

    def work() -> None:
        global _in_flight
        try:
            run_readback(owner_sid, launcher_path, **options)
        finally:
            with _lock:
                _in_flight = False

    try:
        if spawn is None:
            threading.Thread(target=work, name="egress-wfp-readback", daemon=True).start()
        else:
            spawn(work)
    except RuntimeError as exc:
        with _lock:
            _in_flight, _last_started_at = False, None
        logger.warning(
            "native-start: phase=wfp event=readback_not_started exception_type={}",
            type(exc).__name__,
        )
        return False
    start_periodic_readback(owner_sid, launcher_path, spawn=spawn, **options)
    return True


_periodic_started = False
_stop = threading.Event()


def _periodic_loop(
    owner_sid: str,
    launcher_path: Path,
    wait: Callable[[float], bool],
    options: Mapping[str, Any],
) -> None:
    """Reads back once per interval until wait says stop. A read that raises ends nothing."""
    while not wait(READBACK_INTERVAL_SECONDS):
        try:
            run_readback(owner_sid, launcher_path, **options)
        except Exception as exc:  # noqa: BLE001 - one bad cycle must not end the detection
            logger.warning(
                "native-start: phase=wfp event=periodic_readback_failed exception_type={}",
                type(exc).__name__,
            )


def start_periodic_readback(
    owner_sid: str,
    launcher_path: Path,
    *,
    spawn: Callable[[Callable[[], None]], object] | None = None,
    **options: Any,
) -> bool:
    """Starts the one periodic readback of this process. False when it is already running."""
    global _periodic_started
    with _lock:
        if _periodic_started:
            return False
        _periodic_started = True

    def work() -> None:
        _periodic_loop(owner_sid, launcher_path, _stop.wait, options)

    try:
        if spawn is None:
            threading.Thread(target=work, name="egress-wfp-periodic-readback", daemon=True).start()
        else:
            spawn(work)
    except RuntimeError as exc:
        with _lock:
            _periodic_started = False
        logger.warning(
            "native-start: phase=wfp event=periodic_readback_not_started exception_type={}",
            type(exc).__name__,
        )
        return False
    return True


def diagnostics_block() -> dict[str, Any] | None:
    """The ``egress_wfp`` member of the diagnostics body, or None before any readback ran.

    Counts and states only: the keys of individual filters stay out of the response, which is the
    app-adjacent surface; the launcher's own answer carries them for whoever chases drift.
    """
    status = latest_status()
    if status is None:
        return None
    detail = status.readback.detail
    install = status.install
    return {
        "install": None
        if install is None
        else {"status": install.status, "reason": install.reason, "tier": install.tier},
        "readback": {
            "verdict": status.readback.verdict,
            "read_at": status.readback.read_at,
            "reason": detail.get("reason"),
            "sublayer": detail.get("sublayer"),
            "enumeration": detail.get("enumeration"),
            "expected_filters": detail.get("expected_filters"),
            "observed_filters": detail.get("observed_filters"),
            "missing": len(detail.get("missing", [])),
            "changed": len(detail.get("changed", [])),
            "extra": len(detail.get("extra", [])),
        },
    }


def published_isolation_report(base: Mapping[str, Any]) -> dict[str, Any]:
    """``base`` with the egress evidence and any drift warning, or ``base`` itself when there is none.

    The level is whatever ``base`` says: an installed anchor, a clean readback or a drifted one never
    moves it. If the overlay would not survive the rules it is published under, the base report is
    published instead and the refusal is logged.
    """
    status = latest_status()
    if status is None or status.plan is None:
        return dict(base)
    report = deepcopy(dict(base))
    report["isolation_egress_policy_version"] = egress_policy_version_evidence(
        status.plan, status.readback.verdict, status.readback.read_at
    )
    for warning in report["isolation_warnings"]:
        # Only "neither version" stops being true once the egress version is filled in; the ACL one may
        # still be missing. Every other reason is the producer's evidence and stays as it was.
        if (
            warning.get("code") == "isolation_level_not_established"
            and warning.get("reason") == "native_isolation_not_applied"
        ):
            warning["reason"] = "policy_version_unavailable"
    gap = report["isolation_egress_policy_version"].get("loopback_open_tcp_range")
    if gap is not None:
        report["isolation_warnings"].append({"code": "loopback_dynamic_range_open", **gap})
    if status.readback.verdict == "drifted":
        report["isolation_warnings"].append({"code": "egress_policy_drifted"})
    try:
        validate_isolation_report(report)
    except IsolationReportRefusal as refusal:
        logger.error("native-start: phase=wfp event=evidence_refused reasons={}", refusal)
        return dict(base)
    return report
