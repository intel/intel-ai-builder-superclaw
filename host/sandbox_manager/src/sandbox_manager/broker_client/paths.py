"""Resolve the broker from env, the install directory, payload, or dev build roots."""

from __future__ import annotations

import os
import sys
from pathlib import Path
import logging

from ..payload_integrity import VerifiedPayload

BROKER_PAYLOAD_RELATIVE = Path("native-isolation") / "native_isolation_broker.exe"
LAUNCHER_PAYLOAD_RELATIVE = Path("native-isolation") / "native_isolation_launcher.exe"
_ENV_BROKER = "SUPERCLAW_NATIVE_ISOLATION_BROKER"
_ENV_LAUNCHER = "SUPERCLAW_NATIVE_ISOLATION_LAUNCHER"

logger = logging.getLogger(__name__)

def system_powershell_executable() -> Path:
    system_root = os.environ.get("SystemRoot")
    if not system_root:
        raise OSError("SystemRoot is required to resolve Windows PowerShell")
    candidate = (
        Path(system_root)
        / "System32"
        / "WindowsPowerShell"
        / "v1.0"
        / "powershell.exe"
    )
    if not candidate.is_file():
        raise OSError(f"Windows PowerShell is missing: {candidate}")
    return candidate

def _env_override(name: str) -> Path | None:
    value = os.environ.get(name)
    if not value:
        return None

    # Deferred: native_backend imports broker_client, so a module-level import cycles.
    from ..native_backend import _source_development_runtime

    if not _source_development_runtime():
        logger.warning("Ignoring %s in an installed build: %s", name, value)
        return None
    candidate = Path(value)
    return candidate.resolve() if candidate.is_file() else None

def resolve_broker_executable(
    *,
    payload_root: Path | None,
    verified: VerifiedPayload | None,
) -> Path | None:
    override = _env_override(_ENV_BROKER)
    if override is not None:
        return override
    if getattr(sys, "frozen", False):
        # Elevated, so only from the install directory beside this executable, which the user
        # cannot write; a payload root lives under %LOCALAPPDATA%, which the user can.
        install = Path(sys.executable).resolve().parent
        for candidate in (
            install / BROKER_PAYLOAD_RELATIVE,
            install / "native-backend" / BROKER_PAYLOAD_RELATIVE,
        ):
            if candidate.is_file():
                return candidate
        return None
    if payload_root is not None:
        candidate = payload_root / BROKER_PAYLOAD_RELATIVE
        if candidate.is_file():
            return candidate.resolve()
        if verified is not None:
            manifest_path = verified.payload_root / BROKER_PAYLOAD_RELATIVE
            if manifest_path.is_file():
                return manifest_path.resolve()
    repo = _repo_root_from_here()
    if repo is not None:
        release = (
            repo
            / "host"
            / "native_isolation_broker"
            / "target"
            / "release"
            / "native_isolation_broker.exe"
        )
        if release.is_file():
            return release.resolve()
    return None


def resolve_launcher_executable(
    *,
    payload_root: Path | None,
    verified: VerifiedPayload | None,
) -> Path | None:
    override = _env_override(_ENV_LAUNCHER)
    if override is not None:
        return override
    if payload_root is not None:
        candidate = payload_root / LAUNCHER_PAYLOAD_RELATIVE
        if candidate.is_file():
            return candidate.resolve()
        if verified is not None:
            manifest_path = verified.payload_root / LAUNCHER_PAYLOAD_RELATIVE
            if manifest_path.is_file():
                return manifest_path.resolve()
    repo = _repo_root_from_here()
    if repo is not None:
        release = (
            repo
            / "host"
            / "native_isolation_broker"
            / "target"
            / "release"
            / "native_isolation_launcher.exe"
        )
        if release.is_file():
            return release.resolve()
    return None


def _repo_root_from_here() -> Path | None:
    here = Path(__file__).resolve()
    for parent in here.parents:
        if (parent / "host" / "sandbox_manager").is_dir() and (
            parent / "shared" / "contracts"
        ).is_dir():
            return parent
    return None
