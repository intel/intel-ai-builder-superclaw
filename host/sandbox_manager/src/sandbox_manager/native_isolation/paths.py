r"""Host-owned NativePathSet construction.

Resolves the environment once and hands canonical spellings to the contract.
The contract never reads the environment or derives paths by convention.
Volume and ancestry facts are inputs with no default.
"""

from __future__ import annotations

import os
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path, PureWindowsPath

from contracts.native_path_set import (
    AncestryVerdict,
    NativePathSetShape,
    PolicyClass,
    VolumeVerdict,
)
from contracts.workspace_root_refusal import Reason

from .path_policy import (
    NativePathInspectionError,
    NativePathPolicyError,
    inspect_existing_ancestors,
    normalize_local_windows_path,
)

from .path_set_rules import (
    NATIVE_PATH_CONTRACT_VERSION,
    NativePathSetRefusal,
    derive_workspace_root_id,
    validate_native_path_set,
)
from .containment import open_managed_root


class NativePathConfigurationError(RuntimeError):
    """Required Windows path configuration is absent, invalid, or overlapping."""

    def __init__(self, message: str, *, reasons: Sequence[Reason] = ()) -> None:
        super().__init__(message)
        self.reasons = tuple(reasons)


_OWNER_SID = re.compile(r"^S-1-(?:\d+-)+\d+$")
_PATH_TOKEN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")

_ACCESS_MODE_BY_POLICY_CLASS = {
    PolicyClass.managed_default: "read_write",
    PolicyClass.user_granted_rw: "read_write",
    PolicyClass.user_granted_ro: "read_only",
}
# The one directory under `backend/payload/` that holds the staged payload. A constant, not a
# function of the payload: the path set is what the provisioning evidence is a digest of, so a
# name that followed the payload's version or content would turn every rebuild into "new
# evidence" and a UAC prompt, although no permission changed. The broker's layout rule only needs
# `payload_root` to be `<backend>/payload/<name>`, which any fixed name satisfies.
PAYLOAD_DIRECTORY_NAME = "current"

_INSTALLER_AUTHORIZATION: Mapping[str, object] = {
    "kind": "installer_provisioned",
    "grant_id": None,
    "granted_at": None,
    "revocable": False,
}


@dataclass(frozen=True)
class WorkspaceRootFacts:
    """Facts about one workspace root, observed by the caller."""

    volume_verdict: str
    ancestry_verdict: str


@dataclass(frozen=True)
class WorkspaceRootRequest:
    """A user-granted workspace root."""

    path: str
    policy_class: str
    facts: WorkspaceRootFacts
    authorization: Mapping[str, object] = field(default_factory=dict)


def runtime_backend_root(env: Mapping[str, str] | None = None) -> Path:
    values = os.environ if env is None else env
    if values.get("SUPERCLAW_NATIVE_BACKEND_STATE_DIR") or values.get("LOCALAPPDATA"):
        return Path(str(_configured_backend_root(values)))
    if os.name == "nt":
        raise NativePathConfigurationError(
            "required Windows environment path is unset: LOCALAPPDATA"
        )
    return Path.home() / ".local" / "share" / "SuperClaw" / "backend"


def runtime_workspace_root(env: Mapping[str, str] | None = None) -> Path:
    """Return the installer-provisioned workspace root or a non-Windows dev fallback."""
    values = os.environ if env is None else env
    if values.get("WINDOWS_SUPERCLAW_PATH") or values.get("USERPROFILE"):
        return Path(str(_configured_workspace_root(values)))
    if os.name == "nt":
        raise NativePathConfigurationError(
            "required Windows environment path is unset: USERPROFILE"
        )
    return Path.home() / "SuperClawProjects"


def observe_ancestry_verdict(path: str) -> str:
    """Return an ancestry verdict from a point-in-time lstat walk.

    Not race-aware.
    A walk that could not complete reports unknown, which the rules refuse.
    """
    try:
        inspection = inspect_existing_ancestors(path)
    except (NativePathInspectionError, NativePathPolicyError):
        return AncestryVerdict.unknown.value
    if inspection.reparse_points:
        return AncestryVerdict.reparse_point_observed.value
    return AncestryVerdict.no_reparse_point_observed.value


def observe_workspace_root_facts(path: str) -> WorkspaceRootFacts:
    """Measure the accepted volume and ancestry facts through one pinned handle walk."""
    with open_managed_root(path):
        return WorkspaceRootFacts(
            volume_verdict=VolumeVerdict.fixed_ntfs.value,
            ancestry_verdict=AncestryVerdict.no_reparse_point_observed.value,
        )


def resolve_denied_workspace_ancestors(
    env: Mapping[str, str] | None = None,
) -> dict[str, object]:
    r"""Resolve the locations a workspace root may not occupy.

    These values are caller-supplied inputs, not measurements, and a wrong one fails open.
    With SystemRoot set to Z:\Nothing, C:\Windows\System32 is accepted and no other rule notices.
    """
    values = os.environ if env is None else env
    owner_profile = _required_env(values, "USERPROFILE")
    windows_raw = values.get("SystemRoot") or values.get("windir")
    if not windows_raw:
        raise NativePathConfigurationError(
            "required Windows environment path is unset: SystemRoot"
        )
    windows_root = _canonical_managed_path(windows_raw, "SystemRoot")
    return {
        "users_container_roots": _resolve_users_container_roots(
            values, owner_profile, windows_root
        ),
        "owner_profile_root": str(owner_profile),
        "local_app_data_root": str(_required_env(values, "LOCALAPPDATA")),
        "program_data_root": str(_required_env(values, "PROGRAMDATA")),
        "windows_root": str(windows_root),
    }


def _resolve_users_container_roots(
    env: Mapping[str, str],
    owner_profile: PureWindowsPath,
    windows_root: PureWindowsPath,
) -> list[str]:
    container_override = env.get("SUPERCLAW_USERS_CONTAINER_DIR")
    if container_override:
        owner_container = _canonical_managed_path(
            container_override, "SUPERCLAW_USERS_CONTAINER_DIR"
        )
    else:
        owner_container = _profile_container_of(owner_profile)

    system_drive = env.get("SystemDrive") or windows_root.drive
    system_users = _canonical_managed_path(
        str(PureWindowsPath(f"{system_drive}\\") / "Users"), "system drive Users"
    )

    resolved: dict[str, str] = {}
    for container in (owner_container, system_users):
        resolved.setdefault(str(container).casefold(), str(container))
    return list(resolved.values())


def _profile_container_of(owner_profile: PureWindowsPath) -> PureWindowsPath:
    if len(owner_profile.parent.parts) < 2:
        raise NativePathConfigurationError(
            "USERPROFILE names a directory directly on a volume root, so the directory "
            "holding user profiles would be the whole volume; set "
            "SUPERCLAW_USERS_CONTAINER_DIR to the directory that holds user profiles"
        )
    return _canonical_managed_path(str(owner_profile.parent), "USERPROFILE parent")


def build_native_path_set(
    *,
    owner_sid: str,
    session_id: str,
    payload_version: str = PAYLOAD_DIRECTORY_NAME,
    managed_default_facts: WorkspaceRootFacts,
    additional_workspace_roots: Sequence[WorkspaceRootRequest] = (),
    env: Mapping[str, str] | None = None,
) -> NativePathSetShape:
    """Build and validate the native path descriptor.

    `payload_version` names the directory under `payload/` and is a field of the path-set
    contract, so it stays; it is the same constant on every start. Passing anything that varies
    with the payload changes the path set and so the evidence digest.
    """
    _require_identity_token(owner_sid, "owner_sid", _OWNER_SID)
    _require_identity_token(session_id, "session_id", _PATH_TOKEN)
    _require_identity_token(payload_version, "payload_version", _PATH_TOKEN)

    values = os.environ if env is None else env
    program_data = _required_env(values, "PROGRAMDATA")
    backend_root = _configured_backend_root(values)
    fixed_roots = {
        "config_root": backend_root / "config",
        "data_root": backend_root / "data",
        "logs_root": backend_root / "logs",
        "payload_root": backend_root / "payload" / payload_version,
        "temp_root": backend_root / "tmp" / session_id,
        "protected_root": program_data / "SuperClaw" / "protected" / owner_sid,
        "isolation_root": program_data / "SuperClaw" / "isolation",
    }
    canonical_fixed_roots = {
        name: str(_canonical_managed_path(str(path), name))
        for name, path in fixed_roots.items()
    }

    requests = [
        WorkspaceRootRequest(
            path=str(_configured_workspace_root(values)),
            policy_class=PolicyClass.managed_default.value,
            facts=managed_default_facts,
            authorization=_INSTALLER_AUTHORIZATION,
        ),
        *additional_workspace_roots,
    ]

    payload = {
        "contract_version": NATIVE_PATH_CONTRACT_VERSION,
        "owner_sid": owner_sid,
        "session_id": session_id,
        "payload_version": payload_version,
        "workspace_roots": [_member(request) for request in requests],
        **canonical_fixed_roots,
        "denied_workspace_ancestors": resolve_denied_workspace_ancestors(values),
    }
    try:
        return validate_native_path_set(payload)
    except NativePathSetRefusal as exc:
        raise NativePathConfigurationError(str(exc), reasons=exc.reasons) from exc


def _member(request: WorkspaceRootRequest) -> dict[str, object]:
    canonical = str(_canonical_managed_path(request.path, "workspace root"))
    policy_class = _require_policy_class(request.policy_class)
    return {
        "root_id": derive_workspace_root_id(canonical),
        "path": canonical,
        "policy_class": policy_class.value,
        "access_mode": _ACCESS_MODE_BY_POLICY_CLASS[policy_class],
        "volume_verdict": _require_enum_value(
            request.facts.volume_verdict, VolumeVerdict, "volume_verdict"
        ),
        "ancestry_verdict": _require_enum_value(
            request.facts.ancestry_verdict, AncestryVerdict, "ancestry_verdict"
        ),
        "authorization": dict(request.authorization),
    }


def _require_policy_class(value: str) -> PolicyClass:
    try:
        return PolicyClass(value)
    except ValueError as exc:
        raise NativePathConfigurationError(
            f"policy_class is not a workspace root policy class: {value}"
        ) from exc


def _require_enum_value(value: str, enum: type, name: str) -> str:
    try:
        return enum(value).value
    except ValueError as exc:
        raise NativePathConfigurationError(
            f"{name} is not a member of its closed vocabulary: {value}"
        ) from exc


def _configured_backend_root(env: Mapping[str, str]) -> PureWindowsPath:
    override = env.get("SUPERCLAW_NATIVE_BACKEND_STATE_DIR")
    if override:
        return _canonical_managed_path(override, "SUPERCLAW_NATIVE_BACKEND_STATE_DIR")
    return _required_env(env, "LOCALAPPDATA") / "SuperClaw" / "backend"


def _configured_workspace_root(env: Mapping[str, str]) -> PureWindowsPath:
    override = env.get("WINDOWS_SUPERCLAW_PATH")
    if override:
        return _canonical_managed_path(override, "WINDOWS_SUPERCLAW_PATH")
    return _required_env(env, "USERPROFILE") / "SuperClawProjects"


def _required_env(env: Mapping[str, str], name: str) -> PureWindowsPath:
    raw = env.get(name)
    if not raw:
        raise NativePathConfigurationError(
            f"required Windows environment path is unset: {name}"
        )
    return _canonical_managed_path(raw, name)


def _canonical_managed_path(value: str, name: str) -> PureWindowsPath:
    try:
        return normalize_local_windows_path(value)
    except NativePathPolicyError as exc:
        raise NativePathConfigurationError(
            f"{name} must be a canonical absolute local Windows path",
            reasons=(Reason(exc.reason),),
        ) from exc


def _require_identity_token(value: str, name: str, pattern: re.Pattern[str]) -> None:
    if not pattern.fullmatch(value):
        raise NativePathConfigurationError(f"{name} is invalid for a managed path")
