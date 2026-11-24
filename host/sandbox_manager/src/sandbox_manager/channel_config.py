"""Edits to the router's ``opencode-router.json``, made by the host (EG2-6).

The Slack and Telegram tokens live in this file, in the channel tier's data directory. Nothing that
runs as the file_tool tier may read it, so the edits openwork-server used to make are made here, by the
Sandbox Manager as the owner. Each edit is a pure function of the config it is given and returns a new
one; :class:`RouterConfigFile` is the only thing that touches the disk.

An error carries a contract code and nothing from the file or the request: a token must not reach a
log line through an exception message.
"""

from __future__ import annotations

import json
import os
import re
import secrets
import time
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any, TypeGuard

# Under the data root: the channel tier's data directory, which the broker gives the router as its
# `OPENCODE_ROUTER_DATA_DIR` (`catalog_roles/opencode_router.rs`), and where the router looks for this file.
ROUTER_CONFIG_RELATIVE_PATH = Path("channel") / "opencode-router" / "opencode-router.json"

_ID_UNSAFE = re.compile(r"[^a-zA-Z0-9_.-]+")
_REPLACE_ATTEMPTS = 5
_REPLACE_PAUSE_S = 0.05


class ChannelConfigError(Exception):
    """A refusal the routes answer with ``code``; the message is the code and never the input."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def normalize_identity_id(value: object) -> str:
    """The router's own spelling of an identity id: ``openwork-server``'s ``normalizeOpenCodeRouterIdentityId``."""
    trimmed = value.strip() if isinstance(value, str) else ""
    if not trimmed:
        return "default"
    cleaned = _ID_UNSAFE.sub("-", trimmed).strip("-")[:48]
    return cleaned or "default"


def _plain(value: object) -> dict[str, Any]:
    return dict(value) if isinstance(value, Mapping) else {}


def _entries(value: object) -> list[dict[str, Any]]:
    if not isinstance(value, Sequence) or isinstance(value, str):
        return []
    return [dict(entry) for entry in value if isinstance(entry, Mapping)]


def _with_channel(config: Mapping[str, Any], channel: str, section: dict[str, Any]) -> dict[str, Any]:
    channels = _plain(config.get("channels"))
    channels[channel] = section
    edited = dict(config)
    edited["channels"] = channels
    edited["version"] = config.get("version") if isinstance(config.get("version"), int) else 1
    return edited


def with_slack_identity(
    config: Mapping[str, Any],
    identity_id: str,
    bot_token: str,
    app_token: str,
    enabled: bool,
    directory: str | None,
) -> dict[str, Any]:
    slack = _plain(_plain(config.get("channels")).get("slack"))
    identity = normalize_identity_id(identity_id)
    # The router reads the top-level pair only while `apps` is empty, so another identity would hide it.
    if (
        identity != "default"
        and isinstance(slack.get("botToken"), str)
        and isinstance(slack.get("appToken"), str)
    ):
        raise ChannelConfigError("channel_legacy_slack_config")

    apps: list[dict[str, Any]] = []
    found = False
    for record in _entries(slack.get("apps")):
        if normalize_identity_id(record.get("id")) != identity:
            apps.append(record)
            continue
        found = True
        previous = record.get("directory")
        kept = (directory or (previous.strip() if isinstance(previous, str) else "")) or None
        apps.append(_slack_entry(identity, bot_token, app_token, enabled, kept))
    if not found:
        apps.append(_slack_entry(identity, bot_token, app_token, enabled, directory))

    # The router ANDs the channel flag into every app, so a channel switched off is carried into the other apps
    # before the flag is set again; otherwise they would start on the next router start.
    if slack.get("enabled") is False:
        apps = [
            record if normalize_identity_id(record.get("id")) == identity else {**record, "enabled": False}
            for record in apps
        ]
    slack.update({"enabled": True, "apps": apps})
    slack.pop("botToken", None)
    slack.pop("appToken", None)
    return _with_channel(config, "slack", slack)


def saved_slack_identity(config: Mapping[str, Any], identity_id: str) -> tuple[str, str, str | None] | None:
    """The bot token, app token and directory saved for one Slack identity, or None when none is saved."""
    identity = normalize_identity_id(identity_id)
    slack = _plain(_plain(config.get("channels")).get("slack"))
    records = _entries(slack.get("apps"))
    for record in records:
        if normalize_identity_id(record.get("id")) != identity:
            continue
        bot_token, app_token, directory = record.get("botToken"), record.get("appToken"), record.get("directory")
        if not (_token(bot_token) and _token(app_token)):
            break
        return bot_token, app_token, directory.strip() if isinstance(directory, str) and directory.strip() else None
    usable = any(_token(record.get("botToken")) and _token(record.get("appToken")) for record in records)
    # As the router reads it: the top-level pair is the default bot while no app entry has both tokens.
    bot_token, app_token = slack.get("botToken"), slack.get("appToken")
    if identity == "default" and not usable and _token(bot_token) and _token(app_token):
        return bot_token, app_token, None
    return None


def _token(value: object) -> TypeGuard[str]:
    return isinstance(value, str) and bool(value.strip())


def _slack_entry(
    identity: str, bot_token: str, app_token: str, enabled: bool, directory: str | None
) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "id": identity,
        "botToken": bot_token,
        "appToken": app_token,
        "enabled": enabled,
    }
    if directory:
        entry["directory"] = directory
    return entry


def with_telegram_identity(
    config: Mapping[str, Any],
    identity_id: str,
    token: str,
    enabled: bool,
    directory: str | None,
    access: str | None,
    pairing_code_hash: str | None,
) -> dict[str, Any]:
    telegram = _plain(_plain(config.get("channels")).get("telegram"))
    identity = normalize_identity_id(identity_id)

    bots: list[dict[str, Any]] = []
    found = False
    for record in _entries(telegram.get("bots")):
        if normalize_identity_id(record.get("id")) != identity:
            bots.append(record)
            continue
        found = True
        previous_directory = record.get("directory")
        kept = (directory or (previous_directory.strip() if isinstance(previous_directory, str) else "")) or None
        previous_access = "private" if record.get("access") == "private" and record.get("pairingCodeHash") else "public"
        previous_hash = record.get("pairingCodeHash") if previous_access == "private" else None
        chosen = access or previous_access
        chosen_hash = (pairing_code_hash or previous_hash) if chosen == "private" else None
        bots.append(_telegram_entry(identity, token, enabled, kept, chosen, chosen_hash))
    if not found:
        chosen = access or "public"
        bots.append(
            _telegram_entry(
                identity, token, enabled, directory, chosen, pairing_code_hash if chosen == "private" else None
            )
        )

    # As for Slack: a channel switched off is carried into the other bots before the flag is set again.
    if telegram.get("enabled") is False:
        bots = [
            record if normalize_identity_id(record.get("id")) == identity else {**record, "enabled": False}
            for record in bots
        ]
    telegram.update({"enabled": True, "bots": bots})
    if identity == "default":
        telegram["token"] = token  # the legacy single-bot fallback
    return _with_channel(config, "telegram", telegram)


def saved_telegram_identity(
    config: Mapping[str, Any], identity_id: str
) -> tuple[str, str | None, str, str | None] | None:
    """The token, directory, access and pairing-code hash saved for one Telegram bot, or None when none is saved."""
    identity = normalize_identity_id(identity_id)
    telegram = _plain(_plain(config.get("channels")).get("telegram"))
    records = _entries(telegram.get("bots"))
    for record in records:
        if normalize_identity_id(record.get("id")) != identity:
            continue
        token, directory = record.get("token"), record.get("directory")
        if not _token(token):
            break
        pairing_code_hash = record.get("pairingCodeHash")
        private = record.get("access") == "private" and _token(pairing_code_hash)
        return (
            token,
            directory.strip() if isinstance(directory, str) and directory.strip() else None,
            "private" if private else "public",
            pairing_code_hash if private else None,
        )
    # As the router reads it: the legacy top-level token is the default bot while no bot entry has a token.
    legacy = telegram.get("token")
    if identity == "default" and not any(_token(record.get("token")) for record in records) and _token(legacy):
        return legacy, None, "public", None
    return None


def _telegram_entry(
    identity: str,
    token: str,
    enabled: bool,
    directory: str | None,
    access: str,
    pairing_code_hash: str | None,
) -> dict[str, Any]:
    if access == "private" and not pairing_code_hash:
        raise ChannelConfigError("invalid_request")
    entry: dict[str, Any] = {"id": identity, "token": token, "enabled": enabled}
    if directory:
        entry["directory"] = directory
    entry["access"] = access
    if access == "private":
        entry["pairingCodeHash"] = pairing_code_hash
    return entry


def without_identity(
    config: Mapping[str, Any], channel: str, identity_id: str
) -> tuple[dict[str, Any], bool]:
    """The config without one identity, and whether it was there."""
    key = "apps" if channel == "slack" else "bots"
    section = _plain(_plain(config.get("channels")).get(channel))
    identity = normalize_identity_id(identity_id)
    kept: list[dict[str, Any]] = []
    deleted = False
    for record in _entries(section.get(key)):
        if normalize_identity_id(record.get("id")) == identity:
            deleted = True
            continue
        kept.append(record)
    section[key] = kept
    if identity == "default":
        for legacy in ("botToken", "appToken") if channel == "slack" else ("token",):
            section.pop(legacy, None)
    return _with_channel(config, channel, section), deleted


def with_channel_enabled(
    config: Mapping[str, Any], channel: str, enabled: bool, *, clear_token: bool
) -> dict[str, Any]:
    """The channel-wide switch. ``clear_token`` drops Telegram's legacy token, and only while switching off."""
    if clear_token and channel != "telegram":
        raise ChannelConfigError("invalid_request")
    section = _plain(_plain(config.get("channels")).get(channel))
    section["enabled"] = enabled
    if channel == "telegram" and clear_token and not enabled:
        section.pop("token", None)
        bots = _entries(section.get("bots"))
        for bot in bots:
            if bot.get("id") == "default":
                bot.pop("token", None)
        if bots:
            section["bots"] = bots
    return _with_channel(config, channel, section)


class RouterConfigFile:
    """The file at one path: read whole, replaced whole, never edited in place."""

    def __init__(self, path: Path) -> None:
        self._path = path

    @property
    def path(self) -> Path:
        return self._path

    def read(self) -> dict[str, Any]:
        try:
            raw = self._path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return {"version": 1}
        except OSError as exc:
            raise ChannelConfigError("channel_config_unreadable") from exc
        try:
            parsed = json.loads(raw)
        except ValueError:
            raise ChannelConfigError("channel_config_unreadable") from None
        if not isinstance(parsed, dict):
            raise ChannelConfigError("channel_config_unreadable")
        return parsed

    def write(self, config: Mapping[str, Any]) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self._path.with_name(f"{self._path.name}.tmp.{secrets.token_hex(4)}")
        try:
            temporary.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8", newline="\n")
            for attempt in range(_REPLACE_ATTEMPTS):
                try:
                    os.replace(temporary, self._path)
                    return
                except PermissionError:
                    # The router reads this file, and on Windows a replace fails while it is open.
                    if attempt == _REPLACE_ATTEMPTS - 1:
                        raise
                    time.sleep(_REPLACE_PAUSE_S)
        finally:
            temporary.unlink(missing_ok=True)
