"""What the host sets up for the channel tier before the router starts (EG2-6).

The router runs as the ``channel`` tier and sees the workspace only through three openings: an inbox it
writes, an outbox it reads, and an agent definition it reads. The Sandbox Manager makes each of them
here, as the owner, at every router start. The workspace MCP config and policy are not openings: the router
reads them through the engine's file API, not the workspace. It also carries over the Slack and Telegram identities an
earlier release kept in the file_tool tier's data directory, where that tier could read their tokens.

Nothing here reads a token into a variable that outlives the merge, and the audit names only which
secret moved.
"""

from __future__ import annotations

import ctypes
from collections.abc import Mapping
from pathlib import Path
from typing import Any, Protocol

from loguru import logger

from .channel_router_db import migrate_legacy_router_db
from .channel_config import (
    ROUTER_CONFIG_RELATIVE_PATH,
    ChannelConfigError,
    RouterConfigFile,
    normalize_identity_id,
)
from .native_isolation import NativeContainmentError, open_managed_root

AGENT_FILE_NAME = "superclaw-router.md"
_WORKSPACE_AGENT_RELATIVE_PATH = f".opencode\\agents\\{AGENT_FILE_NAME}"
# ERROR_FILE_NOT_FOUND and ERROR_PATH_NOT_FOUND: the workspace has no agent file, which is not a refusal.
_ABSENT_ERRORS = (2, 3)
_READ_CHUNK = 64 * 1024
# file_tool can write a file of any size there, and the owner reads it into memory at router start.
_MAX_AGENT_FILE_BYTES = 1024 * 1024
# Where the router's config lived while it ran as the file_tool tier (under the data root).
LEGACY_ROUTER_CONFIG_RELATIVE_PATH = Path("file_tool") / "opencode-router" / "opencode-router.json"

_LIST_KEYS = {"slack": "apps", "telegram": "bots"}
_SECRET_FOR_CHANNEL = {"slack": "slack_tokens", "telegram": "telegram_token"}
_TOKEN_FIELDS = {"slack": ("botToken", "appToken"), "telegram": ("token",)}


class _Audit(Protocol):
    def record(self, event: str, **fields: str) -> None: ...


def prepare_channel_tier(*, data_root: Path, config_root: Path, workspace: Path, audit: _Audit | None) -> None:
    """Make the router's openings and carry over an earlier release's identities. Safe to repeat."""
    channel_data = data_root / "channel"
    (channel_data / "inbox").mkdir(parents=True, exist_ok=True)
    (channel_data / "outbox").mkdir(parents=True, exist_ok=True)
    _provide_agent_file(workspace, config_root / "channel" / "agents" / AGENT_FILE_NAME)
    migrate_legacy_router_db(data_root, audit)
    _migrate_legacy_config(data_root, audit)


def seal_router_approval(data_root: Path, section: Mapping[str, str] | None) -> None:
    """Write this start's approval key, boot id and admin secret into the router's config (EG2-7).

    The router reads it once, at its start, and checks every grant against it. With no broker the section is
    removed, so a secret from an earlier start is not left behind; a config the router could not read either
    is left alone, and the router then refuses any send that needs an approval.
    """
    config_file = RouterConfigFile(data_root / ROUTER_CONFIG_RELATIVE_PATH)
    try:
        config = dict(config_file.read())
    except ChannelConfigError:
        return
    if section is None:
        if "approval" not in config:
            return
        config.pop("approval")
    else:
        config["approval"] = dict(section)
    config.setdefault("version", 1)
    config_file.write(config)


def _provide_agent_file(workspace: Path, destination: Path) -> None:
    content = _read_workspace_agent(workspace)
    if content is None:
        destination.unlink(missing_ok=True)
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(content)


def _read_workspace_agent(workspace: Path) -> bytes | None:
    """The workspace's router agent, or ``None`` if there is none or it is not a plain file (#3666).

    file_tool can write the workspace and this runs as the owner, so a junction, symlink or hard link
    planted there would carry an owner-only file into the router's config. The file is opened from the
    workspace root by handle, one component at a time, and read through that handle; a reparse point
    or a second hard link anywhere on the way is refused and treated as no agent file.
    """
    try:
        with open_managed_root(str(workspace)) as root, root.contain(_WORKSPACE_AGENT_RELATIVE_PATH) as entry:
            if entry.is_directory:
                return None
            return _read_handle(entry.handle)
    except NativeContainmentError as exc:
        if getattr(exc.__cause__, "winerror", None) in _ABSENT_ERRORS:
            return None
        logger.warning("Gave the router no agent file: the workspace's {} was refused: {}", AGENT_FILE_NAME, exc)
        return None


def _read_handle(handle: int) -> bytes:
    """Read to the end through a contained handle, without taking ownership of it."""
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    buffer = ctypes.create_string_buffer(_READ_CHUNK)
    read = ctypes.c_ulong(0)
    chunks: list[bytes] = []
    total = 0
    while True:
        if not kernel32.ReadFile(ctypes.c_void_p(handle), buffer, _READ_CHUNK, ctypes.byref(read), None):
            raise NativeContainmentError("could not read the contained agent file") from ctypes.WinError(
                ctypes.get_last_error()
            )
        if read.value == 0:
            return b"".join(chunks)
        total += read.value
        if total > _MAX_AGENT_FILE_BYTES:
            raise NativeContainmentError(f"the contained agent file is larger than {_MAX_AGENT_FILE_BYTES} bytes")
        chunks.append(buffer.raw[: read.value])


def _identities(section: object, channel: str) -> list[Mapping[str, Any]]:
    if not isinstance(section, Mapping):
        return []
    listed = section.get(_LIST_KEYS[channel])
    return [entry for entry in listed if isinstance(entry, Mapping)] if isinstance(listed, list) else []


def _holds_tokens(section: object, channel: str) -> bool:
    if not isinstance(section, Mapping):
        return False
    fields = _TOKEN_FIELDS[channel]
    if any(isinstance(section.get(name), str) and section[name] for name in fields):
        return True
    return any(
        any(isinstance(entry.get(name), str) and entry[name] for name in fields)
        for entry in _identities(section, channel)
    )


def _merged(current: Mapping[str, Any], legacy: Mapping[str, Any]) -> dict[str, Any]:
    """The current config plus whatever the legacy one has that it lacks. The current config wins."""
    merged: dict[str, Any] = dict(current)
    channels: dict[str, Any] = dict(current.get("channels")) if isinstance(current.get("channels"), Mapping) else {}
    legacy_channels = legacy.get("channels")
    for channel, old_section in (legacy_channels.items() if isinstance(legacy_channels, Mapping) else []):
        if not isinstance(old_section, Mapping):
            continue
        section: dict[str, Any] = dict(channels.get(channel)) if isinstance(channels.get(channel), Mapping) else {}
        for key, value in old_section.items():
            if key == _LIST_KEYS.get(channel):
                continue
            section.setdefault(key, value)
        if channel in _LIST_KEYS:
            entries = [dict(entry) for entry in _identities(section, channel)]
            present = {normalize_identity_id(entry.get("id")) for entry in entries}
            for entry in _identities(old_section, channel):
                if normalize_identity_id(entry.get("id")) not in present:
                    entries.append(dict(entry))
            if entries:
                section[_LIST_KEYS[channel]] = entries
        channels[channel] = section
    if channels:
        merged["channels"] = channels
    for key, value in legacy.items():
        if key not in ("channels", "version"):
            merged.setdefault(key, value)
    merged.setdefault("version", 1)
    return merged


def _migrate_legacy_config(data_root: Path, audit: _Audit | None) -> None:
    legacy_file = RouterConfigFile(data_root / LEGACY_ROUTER_CONFIG_RELATIVE_PATH)
    if not legacy_file.path.exists():
        return
    current_file = RouterConfigFile(data_root / ROUTER_CONFIG_RELATIVE_PATH)
    try:
        legacy = legacy_file.read()
        current = current_file.read()
    except ChannelConfigError:
        # Unreadable: keep the old file, so nothing a user saved is lost to a parse failure.
        return
    # The audit line is written before the change, as ControlAudit's contract says.
    legacy_channels = legacy.get("channels")
    if audit is not None and isinstance(legacy_channels, Mapping):
        for channel, secret in _SECRET_FOR_CHANNEL.items():
            if _holds_tokens(legacy_channels.get(channel), channel):
                audit.record("secret.migrated", secret=secret)
    current_file.write(_merged(current, legacy))
    legacy_file.path.unlink()
    # Not left as a directory of nothing: the router's old data directory held only this file.
    try:
        legacy_file.path.parent.rmdir()
    except OSError:
        pass
