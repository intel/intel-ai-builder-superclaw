"""The unelevated, read-only DACL readback of the current roots, run through the launcher.

Contract touched: ``RuntimeStatus`` (the isolation report's tier ``acl_readback``) over the ``Sandbox``
access-control plan. Adapter: this module; the launcher is the only thing that opens a root.

It runs ``native_isolation_launcher --acl-readback --owner-sid <sid>`` as the owner, with the roots on
standard input - paths travel on a pipe, never on a command line - and the launcher re-reads each root's
DACL with ``READ_CONTROL`` and compares it with the shipped descriptor, which is the comparison it makes
at every start. It cannot repair and this module requests no elevation.

Every tier ACE is pinned to the exact SID of its tier account, which the caller resolved by name and which
travels with the roots on standard input (``tier_sids``; never argv, never in the output). Without that
the launcher can only check that a tier position names *some* non-broad local SID, so another tier's SID
with the same rights would read as ``matches``. ``protected_root`` is read back with the rest.

A readback that could not run - no launcher, a launcher that refused, a timeout, an answer that does not
parse, a launcher built against another descriptor - is ``not_read``, never ``matches``: the report may
only say the roots carry the descriptor when something read them just now.
"""

from __future__ import annotations

import json
import subprocess
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from contracts.acl_policy_descriptor_data import ACL_POLICY_RULES

from .identity import TIERS

ReadbackVerdict = Literal["matches", "drifted", "not_read"]

#: A path-set key and the launcher placeholder it binds, the same bindings a role start makes.
_MANAGED_BINDINGS: tuple[tuple[str, str], ...] = (
    ("payload_root", "payload_root"),
    ("config_root", "state_config_root"),
    ("data_root", "state_data_root"),
    ("logs_root", "state_logs_root"),
    ("temp_root", "state_temp_root"),
    ("protected_root", "state_protected_root"),
    ("isolation_root", "isolation_root"),
)

#: Reading a handful of DACLs takes milliseconds; anything slower than this is a hung launcher, and the
#: diagnostics call waiting on it must not hang with it.
READBACK_TIMEOUT_SECONDS = 5.0

#: ``(argv, standard input, timeout) -> (exit code, standard output)``. A test hands in a fake.
UnelevatedRunner = Callable[[Sequence[str], bytes, float], tuple[int, bytes]]


@dataclass(frozen=True)
class AclReadbackOutcome:
    """The verdict and the instant it was read, plus a typed reason for the log.

    ``detail`` holds reason codes and root names only; the launcher's output carries no path.
    """

    verdict: ReadbackVerdict
    read_at: str | None
    detail: Mapping[str, Any] = field(default_factory=dict)


def _run_unelevated(
    argv: Sequence[str], stdin: bytes, timeout: float
) -> tuple[int, bytes]:
    completed = subprocess.run(
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


def _not_read(reason: str, **detail: object) -> AclReadbackOutcome:
    return AclReadbackOutcome("not_read", None, {"reason": reason, **detail})


def readback_request(
    path_set: Mapping[str, object], tier_sids: Mapping[str, str]
) -> bytes | None:
    """The launcher's standard input for this path set, or None if it names no root to read.

    ``tier_sids`` maps each tier name (``identity.TIERS``) to the SID its account resolves to now; the
    launcher pins every tier ACE to the SID of the descriptor principal ``sandbox_tier_<tier>``.
    """
    bindings = [
        {"placeholder": placeholder, "path": path_set[key]}
        for key, placeholder in _MANAGED_BINDINGS
        if isinstance(path_set.get(key), str)
    ]
    workspace_roots = [
        {
            "root_id": root.get("root_id"),
            "path": root.get("path"),
            "policy_class": root.get("policy_class"),
        }
        for root in path_set.get("workspace_roots", ())
        if isinstance(root, Mapping)
    ]
    if not bindings and not workspace_roots:
        return None
    return json.dumps(
        {
            "path_bindings": bindings,
            "workspace_roots": workspace_roots,
            "tier_sids": {f"sandbox_tier_{tier}": tier_sids[tier] for tier in TIERS},
        },
        separators=(",", ":"),
    ).encode("utf-8")


def read_back_roots(
    launcher: Path,
    owner_sid: str,
    path_set: Mapping[str, object],
    tier_sids: Mapping[str, str],
    *,
    run: UnelevatedRunner = _run_unelevated,
    now: Callable[[], str] = _utc_now,
) -> AclReadbackOutcome:
    """Reads every current root's DACL back through the launcher and compares it with the descriptor.

    Without a SID for every tier the launcher could only run its relaxed tier check, which accepts one
    tier's SID in another's place, so the readback is not run: ``not_read``, reason
    ``tier_sids_unresolved``.
    """
    if any(not tier_sids.get(tier) for tier in TIERS):
        return _not_read("tier_sids_unresolved")
    request = readback_request(path_set, tier_sids)
    if request is None:
        return _not_read("no_roots_to_read")
    argv = [str(launcher), "--acl-readback", "--owner-sid", owner_sid]
    try:
        code, stdout = run(argv, request, READBACK_TIMEOUT_SECONDS)
    except (OSError, subprocess.SubprocessError):
        return _not_read("launcher_unavailable")
    try:
        answer = json.loads(stdout.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError):
        return _not_read("launcher_answer_unreadable", exit_code=code)
    if code != 0 or not isinstance(answer, dict) or answer.get("ok") is not True:
        error = answer.get("error_code") if isinstance(answer, dict) else None
        return _not_read(str(error or "readback_failed"), exit_code=code)
    if answer.get("descriptor_digest") != ACL_POLICY_RULES["descriptor_digest"]:
        return _not_read("launcher_descriptor_is_not_the_shipped_policy")
    word = answer.get("verdict")
    if word not in ("matches", "drifted"):
        return _not_read("launcher_verdict_unknown", exit_code=code)
    verdict: ReadbackVerdict = "matches" if word == "matches" else "drifted"
    drifted = [
        {"root": root.get("root"), "reason": root.get("reason")}
        for root in answer.get("roots", ())
        if isinstance(root, dict) and root.get("verdict") == "drifted"
    ]
    return AclReadbackOutcome(verdict, now(), {"drifted": drifted})
