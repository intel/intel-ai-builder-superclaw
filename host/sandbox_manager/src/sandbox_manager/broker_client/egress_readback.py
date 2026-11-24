"""The unelevated WFP readback of the installed egress plan, run through the launcher.

Contract touched: ``RuntimeStatus`` (the isolation report's ``isolation_egress_policy_version``) over the
``Sandbox`` egress plan. Adapter: this module; the launcher binary is the only thing that touches the
filtering engine. The report receives only the verdict and the instant, as plain values, through
``native_isolation.egress_evidence``.

The readback never elevates. It runs ``native_isolation_launcher --wfp-readback`` as the owner, with the
plan on standard input, and the launcher reads our sublayer and what is in it with the owner's own token:
every object the elevated install wrote carries a security descriptor granting the owner read. This
module imports nothing from ``elevate`` and opens no process with a ``runas`` verb, which a test pins.

A readback that could not run - no launcher, an engine that refused the read, a launcher that crashed - is
``not_read``, never ``matches_plan``: the report may only say the filters are as planned when something
read them.
"""

from __future__ import annotations

import json
import subprocess
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from .egress_wfp import AccountSidLookup, plan_install

ReadbackVerdict = Literal["matches_plan", "drifted", "not_read"]

#: The launcher's answer words, mapped to the contract's verdict vocabulary.
_VERDICT_BY_LAUNCHER_WORD: Mapping[str, ReadbackVerdict] = {
    "consistent": "matches_plan",
    "drifted": "drifted",
}

_READBACK_TIMEOUT_SECONDS = 15.0

#: ``(argv, standard input, timeout) -> (exit code, standard output)``. The default runs the launcher as
#: this process's own account; a test hands in a fake and so never opens an engine.
UnelevatedRunner = Callable[[Sequence[str], bytes, float], tuple[int, bytes]]


@dataclass(frozen=True)
class EgressReadback:
    """The readback verdict and the instant it ran, plus what the launcher found.

    ``verdict`` and ``read_at`` are what the report carries. ``detail`` is for the log: the sublayer's
    state and which filters were missing, changed or extra, or the typed reason nothing was read.
    """

    verdict: ReadbackVerdict
    read_at: str | None
    detail: Mapping[str, Any] = field(default_factory=dict)


def _run_unelevated(
    argv: Sequence[str], stdin: bytes, timeout: float
) -> tuple[int, bytes]:
    completed = subprocess.run(  # noqa: S603 - argv is the resolved launcher and fixed flags
        list(argv),
        input=stdin,
        capture_output=True,
        timeout=timeout,
        check=False,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    return completed.returncode, completed.stdout


def _utc_now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _not_read(reason: str, **detail: object) -> EgressReadback:
    return EgressReadback(verdict="not_read", read_at=None, detail={"reason": reason, **detail})


def read_back_plan(
    plan: Mapping[str, Any],
    owner_sid: str,
    launcher_path: Path,
    *,
    run: UnelevatedRunner = _run_unelevated,
    now: Callable[[], str] = _utc_now,
) -> EgressReadback:
    """Reads our sublayer and filters back and compares them with ``plan``.

    Drift is a sublayer that is missing or carries a missing or different tag, a filter in our sublayer the plan does not name, a planned
    filter that is missing, and a planned filter whose content changed.
    """
    argv = [str(launcher_path), "--wfp-readback", "--owner-sid", owner_sid]
    try:
        code, stdout = run(argv, json.dumps(plan, sort_keys=True).encode("utf-8"), _READBACK_TIMEOUT_SECONDS)
    except (OSError, subprocess.SubprocessError):
        return _not_read("launcher_unavailable")
    try:
        answer = json.loads(stdout.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError):
        return _not_read("launcher_answer_unreadable", exit_code=code)
    if code != 0 or not isinstance(answer, dict) or answer.get("ok") is not True:
        error = answer.get("error_code") if isinstance(answer, dict) else None
        return _not_read(str(error or "readback_failed"), exit_code=code)
    verdict = _VERDICT_BY_LAUNCHER_WORD.get(str(answer.get("verdict")))
    if verdict is None:
        return _not_read("launcher_verdict_unknown", exit_code=code)
    detail = {
        key: answer[key]
        for key in ("sublayer", "enumeration", "expected_filters", "observed_filters", "missing", "changed", "extra")
        if key in answer
    }
    return EgressReadback(verdict=verdict, read_at=now(), detail=detail)


def read_back_installed(
    owner_sid: str,
    launcher_path: Path,
    *,
    lookup: AccountSidLookup | None = None,
    run: UnelevatedRunner = _run_unelevated,
    now: Callable[[], str] = _utc_now,
) -> tuple[Mapping[str, Any] | None, EgressReadback]:
    """The plan for this owner's current accounts, and its readback.

    A tier account that does not resolve means there is no plan to compare with, so the verdict is
    ``not_read`` with the planner's typed reason - the same reason the install was skipped for.
    """
    plan, skipped = plan_install(owner_sid, lookup)
    if plan is None:
        reason = skipped.reason if skipped else "egress_plan_unavailable"
        return None, _not_read(str(reason), tier=skipped.tier if skipped else None)
    return plan, read_back_plan(plan, owner_sid, launcher_path, run=run, now=now)
