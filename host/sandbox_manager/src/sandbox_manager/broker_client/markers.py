"""Owner provision markers written by the unprivileged Sandbox Manager client.

The broker's identity state under ``%ProgramData%\\SuperClaw\\isolation`` is
DACL-protected to SYSTEM + Administrators (``native_isolation_broker``
``acl_windows`` ``BROKER_FILE_DACL`` / ``BROKER_DIRECTORY_DACL``): the identity
directory, the identity records, the grant store and the ACL records. This
unprivileged L2 process therefore cannot enumerate that directory or read any
identity record, and so cannot determine whether provisioning has already
happened. These markers are a **non-secret**, owner-scoped record the client
writes only after the elevated broker confirms success. They gate one thing:
whether to re-invoke the idempotent elevated provision, i.e. whether to show a
UAC prompt.

One file class is deliberately wider: a tier credential blob carries
SYSTEM + Administrators + *the owner SID, read-only*
(``credential_store::credential_dacl_sddl``), so the owner can decrypt a
credential whose exact path it derives itself. That does not amount to
provisioning state - the blob holds only the tier password, and the identity
record that attests an identity is valid stays unreadable - and it grants no
privilege: the broker still creates every account and enforces every tier
boundary.

# What a marker is not

A marker is not authorization evidence, and nothing on the Rust side reads one.
It lives in ``%LOCALAPPDATA%``, where the owner can write it freely, so a marker
that said "these roots carry the shipped descriptor" would be a claim the owner
made about itself.
The launcher therefore ignores markers entirely and re-reads each bound root's
DACL with ``READ_CONTROL`` at start (``launcher::drift``); a drifted root fails
closed with a typed ``provision_required`` no matter what any marker says.
The digests recorded here answer one question and only one: does the elevated
broker need to be asked again, which is the same as asking whether to show UAC.

# Why the version is 3

The payload gained the workspace ACL digests, so the version moved with it. It moves again when the
workspace marker records an attempted descendant-convergence epoch, including one with bounded skips:
version 2 markers may have recorded the older all-or-nothing result and must not suppress the new policy.
An older marker is not upgraded in place: it simply stops matching, which costs
exactly one UAC prompt per owner and keeps the "a marker means the elevated
broker confirmed *this* payload" rule true without a migration path that could
get it wrong.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
from pathlib import Path
from typing import Any

from .identity import TIERS, canonical_owner_sid

_MARKER_VERSION = 3
# The provisioning contract version. It is separate from the marker *format* version above: bump it
# when the broker's provisioning behaviour changes (a new step, a new right, a changed descriptor), so
# an existing install's marker stops matching and the next start re-provisions once (one UAC prompt).
# Without this, a marker written by an older broker keeps suppressing provision, and the new
# provisioning never runs - the elevated provision is idempotent, so asking again is always safe.
_PROVISIONING_VERSION = 1
# The broker's startup convergence target table digest (`STARTUP_CONVERGENCE_TARGETS` in the broker's
# `workspace_grant/apply/tier_subtrees.rs`; a broker test fails until this copy matches it). A workspace
# claim recorded under another table stops matching, so an update that changes what convergence repairs
# provisions once even when the tier SIDs are unchanged (#3846).
_STARTUP_CONVERGENCE_FINGERPRINT = "171fca79bb8d3ea97fc4fc1cc7ff69d2318312a7a6784d856a1fd4d8317267ef"
_DIGEST_PATTERN = re.compile(r"^[0-9a-f]{64}$")


def default_marker_dir() -> Path:
    """The owner's marker directory, under the owner's own local application data.

    This is only ever called in the unprivileged client, which is what makes ``%LOCALAPPDATA%`` the
    *owner's* profile: the elevated broker's environment would name the administrator's. Nothing on the
    elevated side reads a marker, so there is no path here that could cross profiles.

    The absolute check is not about trust - the owner may set its own variables - it is about not writing
    markers into whatever the current directory happens to be, which would silently cost a UAC prompt per
    launch.
    """
    base = os.environ.get("LOCALAPPDATA")
    if not base:
        raise RuntimeError(
            "LOCALAPPDATA is required for broker client provision markers"
        )
    root = Path(base)
    if not root.is_absolute():
        raise RuntimeError(
            f"LOCALAPPDATA must name an absolute directory for provision markers, got {base!r}"
        )
    return root / "SuperClaw" / "isolation" / "provisioned"


def _marker_path(root: Path, owner_sid: str) -> Path:
    digest = hashlib.sha256(owner_sid.encode("utf-8")).hexdigest()[:32]
    return root / f"owner-{digest}.json"


def _read_marker(root: Path, owner_sid: str) -> dict[str, Any]:
    """The marker's payload, or an empty mapping if there is nothing usable to read.

    A marker from another version, another owner or a corrupt file is treated
    exactly like a missing one: the client asks the elevated broker again. That
    is the only failure mode this file is allowed to have, because the
    alternative - carrying a partly understood payload forward - is the one that
    could skip a provision.
    """
    try:
        payload = json.loads(_marker_path(root, owner_sid).read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return {}
    if not isinstance(payload, dict):
        return {}
    if (
        payload.get("version") != _MARKER_VERSION
        or payload.get("owner_sid") != owner_sid
    ):
        return {}
    return payload


def _write_marker(root: Path, owner_sid: str, updates: dict[str, Any]) -> None:
    """Merges ``updates`` into the owner's marker and replaces it atomically.

    Read-modify-write rather than overwrite, because the tier-identity decision
    and the workspace ACL decision are recorded in the same file and are taken at
    different times. Two provisions racing here can cost one of them its member
    and therefore one extra UAC prompt; neither can produce a marker that claims
    something the elevated broker did not confirm, because each writer only ever
    adds what it just saw succeed.
    """
    payload = _read_marker(root, owner_sid)
    payload.update({"version": _MARKER_VERSION, "owner_sid": owner_sid, **updates})
    root.mkdir(parents=True, exist_ok=True)
    path = _marker_path(root, owner_sid)
    temporary = path.with_suffix(f".{secrets.token_hex(8)}.tmp")
    try:
        temporary.write_text(json.dumps(payload, sort_keys=True), encoding="utf-8")
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def mark_provisioned(owner_sid: str, *, marker_dir: Path | None = None) -> None:
    """Records that the elevated broker confirmed this owner's tier identities."""
    sid = canonical_owner_sid(owner_sid)
    _write_marker(
        marker_dir or default_marker_dir(),
        sid,
        {"tiers": list(TIERS), "provisioning_version": _PROVISIONING_VERSION},
    )


def owner_provisioned(owner_sid: str, *, marker_dir: Path | None = None) -> bool:
    try:
        sid = canonical_owner_sid(owner_sid)
    except ValueError:
        return False
    payload = _read_marker(marker_dir or default_marker_dir(), sid)
    tiers = payload.get("tiers", [])
    return (
        payload.get("provisioning_version") == _PROVISIONING_VERSION
        and isinstance(tiers, list)
        and all(isinstance(tier, str) for tier in tiers)
        and set(tiers) >= set(TIERS)
    )


def mark_workspace_acl_provisioned(
    owner_sid: str,
    *,
    path_set_digest: str,
    acl_plan_digest: str,
    marker_dir: Path | None = None,
) -> None:
    """Records the digests the elevated broker returned in its success receipt.

    The digests are the broker's, normalized on the broker's side and read off
    the receipt frame - not recomputed here from the client's own inputs. A
    client that recorded what it *sent* would keep a marker that agreed with
    itself even if the broker had normalized something differently.
    """
    sid = canonical_owner_sid(owner_sid)
    _write_marker(
        marker_dir or default_marker_dir(),
        sid,
        {
            "path_set_digest": _require_digest(path_set_digest, "path_set_digest"),
            "acl_plan_digest": _require_digest(acl_plan_digest, "acl_plan_digest"),
            "startup_convergence_fingerprint": _STARTUP_CONVERGENCE_FINGERPRINT,
        },
    )


def clear_workspace_acl_provisioned(
    owner_sid: str, *, marker_dir: Path | None = None
) -> None:
    """Removes only the workspace ACL claim, preserving the tier identity claim."""
    sid = canonical_owner_sid(owner_sid)
    root = marker_dir or default_marker_dir()
    payload = _read_marker(root, sid)
    payload.pop("path_set_digest", None)
    payload.pop("acl_plan_digest", None)
    payload.pop("startup_convergence_fingerprint", None)
    path = _marker_path(root, sid)
    if payload:
        _write_marker(root, sid, payload)
    else:
        path.unlink(missing_ok=True)


def workspace_acl_provisioned(
    owner_sid: str,
    *,
    path_set_digest: str,
    acl_plan_digest: str,
    marker_dir: Path | None = None,
) -> bool:
    """Whether the last confirmed provision was for exactly these two payloads.

    Both digests have to match. A new workspace root or another owner changes the
    path set and the plan, and either one means the elevated broker has not seen
    what is about to be launched. A new payload does not: the payload directory is
    the fixed ``payload/current``, so payload content is not part of either digest.
    """
    try:
        sid = canonical_owner_sid(owner_sid)
    except ValueError:
        return False
    payload = _read_marker(marker_dir or default_marker_dir(), sid)
    return (
        payload.get("path_set_digest") == _require_digest(path_set_digest, "path_set_digest")
        and payload.get("acl_plan_digest") == _require_digest(acl_plan_digest, "acl_plan_digest")
        and payload.get("startup_convergence_fingerprint") == _STARTUP_CONVERGENCE_FINGERPRINT
    )


def _require_digest(value: str, field: str) -> str:
    if not _DIGEST_PATTERN.fullmatch(value):
        raise ValueError(f"{field} is not a lowercase sha256 hex digest")
    return value


#: A failed install of a plan is not retried for this long. The failure is reported in the isolation
#: report; retrying on every start would put up a prompt per start for a fault the user cannot fix.
WFP_RETRY_COOLDOWN_SECONDS = 24 * 60 * 60


def mark_wfp_plan(
    owner_sid: str,
    *,
    plan_digest: str,
    installed: bool,
    now: float,
    marker_dir: Path | None = None,
) -> None:
    """Records what became of a WFP plan in the elevated provision that carried it.

    ``installed`` advances the active plan: the broker verified the plan inside its transaction before
    committing and the owner checked the receipt's digest, so this is the switch. A failure leaves the
    active plan alone - the transaction aborted, so the old plan is what is installed - and records the
    attempt so the next start does not ask again at once.
    """
    sid = canonical_owner_sid(owner_sid)
    digest = _require_digest(plan_digest, "plan_digest")
    updates: dict[str, Any] = (
        {"wfp_plan_digest": digest, "wfp_failed_digest": None, "wfp_failed_at": None}
        if installed
        else {"wfp_failed_digest": digest, "wfp_failed_at": now}
    )
    _write_marker(marker_dir or default_marker_dir(), sid, updates)


def wfp_plan_due(
    owner_sid: str,
    *,
    plan_digest: str,
    now: float,
    marker_dir: Path | None = None,
) -> bool:
    """Whether the elevated provision has to carry ``plan_digest`` because it is not the active plan.

    An app update that ships a new egress policy changes the digest, which is how it is noticed: the
    next start asks the one provision elevation to install it. A plan that failed is left alone until
    the cooldown passes.
    """
    try:
        sid = canonical_owner_sid(owner_sid)
        digest = _require_digest(plan_digest, "plan_digest")
    except ValueError:
        return False
    payload = _read_marker(marker_dir or default_marker_dir(), sid)
    if payload.get("wfp_plan_digest") == digest:
        return False
    failed_at = payload.get("wfp_failed_at")
    if payload.get("wfp_failed_digest") == digest and isinstance(failed_at, int | float):
        return now - failed_at >= WFP_RETRY_COOLDOWN_SECONDS
    return True
