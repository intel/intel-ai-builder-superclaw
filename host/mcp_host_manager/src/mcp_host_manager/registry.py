"""The host server registry: ``servers.json`` in the gateway's state directory.

It holds what the host runs (command and environment values), each server's approval settings, its
runtime token and its ``always`` grants. Environment values are the user's own and live only here:
no API answer carries them. Every change is written whole to a temporary file and moved over the old
one, so a crash leaves the previous registry or the new one, never a torn file.
"""

from __future__ import annotations

import json
import os
import re
import secrets
import tempfile
from collections.abc import Sequence
from dataclasses import asdict, dataclass, field, replace
from pathlib import Path
from typing import TypedDict

from loguru import logger

from .errors import RULES

REGISTRY_FILE = "servers.json"
TOOL_CACHE_MAX_BYTES = 512 * 1024
_VERSION = 1
_NAME = re.compile(RULES["server_name_pattern"])
_TOKEN = re.compile(RULES["token_pattern"])
_ENV_NAME = re.compile(r"[^=\0]+")
_APPROVAL_MODES = frozenset({"prompt", "auto"})
_ARG_MAX: int = RULES["command_arg_max_chars"]
_ENV_MAX_KEYS: int = RULES["environment_max_keys"]
_SERVER_MAX: int = RULES["server_max"]
_BROWSER_PACKAGES: tuple[str, ...] = tuple(RULES["browser_automation_commands"]["packages"])
_BROWSER_BINARIES: frozenset[str] = frozenset(RULES["browser_automation_commands"]["binaries"])
_BROWSER_LAUNCHER_SUFFIX = re.compile(r"\.(exe|cmd|bat|com|ps1|js|cjs|mjs)$")
_BROWSER_ARG_PREFIXES = ("--package=", "-p=", "--from=", "npm:")
_TRAILING_DOTS = re.compile(r"[. ]+$")


class ToolCache(TypedDict):
    """A server's last good ``tools/list`` result and the instructions its ``initialize`` gave."""

    tools: list[dict[str, object]]
    instructions: str | None


@dataclass(frozen=True)
class ServerRecord:
    name: str
    command: tuple[str, ...]
    environment: dict[str, str]
    approval_mode: str
    allow_when_locked: bool
    token: str
    always_grants: tuple[str, ...] = field(default=())
    # The server has yielded the desktop to the user (USER_CONTROL): it operates the user's input.
    computer_use: bool = False


def new_token() -> str:
    return secrets.token_urlsafe(32)


def _normalize_browser_arg(element: str) -> str:
    """The contract's normalization: lowercase, ``\\`` as ``/``, trailing dots and spaces stripped
    (Windows ignores them), and any launcher prefix that carries a package taken off."""
    value = _TRAILING_DOTS.sub("", element.strip().lower().replace("\\", "/"))
    changed = True
    while changed:
        changed = False
        for prefix in _BROWSER_ARG_PREFIXES:
            if value.startswith(prefix):
                value = value[len(prefix) :]
                changed = True
    return value


def _names_package(value: str, package: str) -> bool:
    return (
        value == package
        or value.startswith(package + "@")
        or value.startswith(package + "/")
        or f"/node_modules/{package}/" in value
        or value.endswith(f"/node_modules/{package}")
    )


def is_browser_automation_command(command: Sequence[str]) -> bool:
    """The contract's ``isBrowserAutomationCommand``: an argv element, normalized, names a
    browser-automation package (itself, ``@<version>``, ``/<subpath>``, or through
    ``node_modules``), or its basename without a launcher extension is one of the binaries. Such a
    server is never run on the host: it would bypass the CDP relay and drive the system browser with
    the user's own sign-in."""
    for element in command:
        value = _normalize_browser_arg(element)
        if any(_names_package(value, package) for package in _BROWSER_PACKAGES):
            return True
        basename = value[value.rfind("/") + 1 :]
        if _BROWSER_LAUNCHER_SUFFIX.sub("", basename) in _BROWSER_BINARIES:
            return True
    return False


def _cache_size(cache: ToolCache) -> int:
    return len(json.dumps(cache, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def _tool_cache_from(value: object) -> ToolCache | None:
    """A stored tool cache, or None unless it has the shape ``set_tool_cache`` writes."""
    if not isinstance(value, dict) or set(value) != {"tools", "instructions"}:
        return None
    tools, instructions = value["tools"], value["instructions"]
    if not isinstance(tools, list) or not all(
        isinstance(tool, dict) and isinstance(tool.get("name"), str) and tool["name"] for tool in tools
    ):
        return None
    if instructions is not None and not isinstance(instructions, str):
        return None
    cache: ToolCache = {"tools": tools, "instructions": instructions}
    try:
        if _cache_size(cache) > TOOL_CACHE_MAX_BYTES:
            return None
    except (TypeError, ValueError, RecursionError):
        return None
    return cache


def _strings(value: object) -> bool:
    return isinstance(value, list) and all(isinstance(item, str) for item in value)


def _record_from(entry: object) -> ServerRecord | None:
    """A stored entry as a record, or None unless every field has the shape registration gives it.
    The file is the gateway's own, but a hand edit or a torn older format must not turn into a
    command nobody registered (a string command would otherwise split into characters)."""
    if not isinstance(entry, dict):
        return None
    name, command, environment = entry.get("name"), entry.get("command"), entry.get("environment", {})
    token, mode, locked = entry.get("token"), entry.get("approval_mode"), entry.get("allow_when_locked")
    grants = entry.get("always_grants", [])
    computer_use = entry.get("computer_use", False)
    if not isinstance(computer_use, bool):
        return None
    if not (
        isinstance(name, str)
        and _NAME.fullmatch(name)
        and _strings(command)
        and command
        and all(argument and len(argument) <= _ARG_MAX and "\0" not in argument for argument in command)
        and isinstance(environment, dict)
        and len(environment) <= _ENV_MAX_KEYS
        and all(
            isinstance(key, str)
            and _ENV_NAME.fullmatch(key)
            and key.strip()
            and isinstance(value, str)
            and "\0" not in value
            for key, value in environment.items()
        )
        and mode in _APPROVAL_MODES
        and isinstance(locked, bool)
        and isinstance(token, str)
        and _TOKEN.fullmatch(token)
        and _strings(grants)
        and all(grant and "\0" not in grant for grant in grants)
    ):
        return None
    return ServerRecord(
        name=name,
        command=tuple(command),
        environment=dict(environment),
        approval_mode=mode,
        allow_when_locked=locked,
        token=token,
        always_grants=tuple(grants),
        computer_use=computer_use,
    )


class Registry:
    def __init__(self, state_dir: Path) -> None:
        self._path = state_dir / REGISTRY_FILE
        self._records: dict[str, ServerRecord] = {}
        self._caches: dict[str, ToolCache] = {}
        self._load()

    def _load(self) -> None:
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return
        except (OSError, ValueError, RecursionError) as exc:
            logger.error("host MCP registry unreadable; starting empty error={}", type(exc).__name__)
            return
        entries = raw.get("servers") if isinstance(raw, dict) else None
        if not isinstance(entries, list):
            logger.error("host MCP registry has no server list; starting empty")
            return
        for index, entry in enumerate(entries):
            if len(self._records) >= _SERVER_MAX:
                logger.error(
                    "host MCP registry has more than {} servers; entries from index={} skipped", _SERVER_MAX, index
                )
                break
            record = _record_from(entry)
            if record is None or record.name in self._records:
                name = entry.get("name") if isinstance(entry, dict) else None
                logger.error(
                    "host MCP registry entry skipped index={} name={}",
                    index,
                    name if isinstance(name, str) and _NAME.fullmatch(name) else "(unusable)",
                )
                continue
            if is_browser_automation_command(record.command):
                logger.error(
                    "host MCP registry entry skipped: a browser automation server cannot run on the host name={}",
                    record.name,
                )
                continue
            self._records[record.name] = record
            cache = _tool_cache_from(entry.get("tool_cache")) if isinstance(entry, dict) else None
            if cache is not None:
                self._caches[record.name] = cache
            elif isinstance(entry, dict) and entry.get("tool_cache") is not None:
                logger.warning("host MCP registry tool cache ignored name={}", record.name)

    def _save(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "version": _VERSION,
            "servers": [
                {
                    **asdict(record),
                    "command": list(record.command),
                    "always_grants": list(record.always_grants),
                    **({"tool_cache": self._caches[record.name]} if record.name in self._caches else {}),
                }
                for record in self._records.values()
            ],
        }
        descriptor, temporary = tempfile.mkstemp(
            dir=self._path.parent, prefix=f".{REGISTRY_FILE}.", suffix=".tmp"
        )
        temporary_path = Path(temporary)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, indent=2, sort_keys=True)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary_path, self._path)
        except BaseException:
            temporary_path.unlink(missing_ok=True)
            raise

    def get(self, name: str) -> ServerRecord | None:
        return self._records.get(name)

    def all(self) -> list[ServerRecord]:
        return list(self._records.values())

    def __len__(self) -> int:
        return len(self._records)

    def put(
        self,
        name: str,
        *,
        command: tuple[str, ...],
        environment: dict[str, str],
        approval_mode: str,
        allow_when_locked: bool,
    ) -> tuple[ServerRecord, ServerRecord | None]:
        """Register or replace ``name``; returns the new record and the one it replaced.

        A replacement keeps the token, and keeps the ``always`` grants only when the command is the
        same: a grant was given to a program, not to a name.
        """
        previous = self._records.get(name)
        record = ServerRecord(
            name=name,
            command=command,
            environment=dict(environment),
            approval_mode=approval_mode,
            allow_when_locked=allow_when_locked,
            token=previous.token if previous else new_token(),
            always_grants=previous.always_grants if previous and previous.command == command else (),
            computer_use=bool(previous and previous.command == command and previous.computer_use),
        )
        self._records[name] = record
        # The cached tool list describes a program, so a new command has none.
        old_cache = self._caches.pop(name, None) if previous is None or previous.command != command else None
        try:
            self._save()
        except OSError:
            self._restore(name, previous)
            if old_cache is not None:
                self._caches[name] = old_cache
            raise
        return record, previous

    def delete(self, name: str) -> ServerRecord | None:
        previous = self._records.pop(name, None)
        if previous is not None:
            old_cache = self._caches.pop(name, None)
            try:
                self._save()
            except OSError:
                self._restore(name, previous)
                if old_cache is not None:
                    self._caches[name] = old_cache
                raise
        return previous

    def tool_cache(self, name: str) -> ToolCache | None:
        """The server's last good ``tools/list`` and instructions, or None."""
        return self._caches.get(name)

    def set_tool_cache(self, name: str, tools: list[dict[str, object]], instructions: str | None) -> bool:
        """Remember what the running server listed; True when that changed what is stored. A list
        over the size bound is not kept, and drops an older one, which it would contradict."""
        if name not in self._records:
            return False
        cache: ToolCache = {"tools": tools, "instructions": instructions}
        if _cache_size(cache) > TOOL_CACHE_MAX_BYTES:
            logger.warning("host MCP tool list too large to cache name={}", name)
            cache_changed = self._caches.pop(name, None) is not None
        elif self._caches.get(name) == cache:
            return False
        else:
            self._caches[name] = cache
            cache_changed = True
        if cache_changed:
            try:
                self._save()
            except OSError as exc:
                logger.error("host MCP tool cache not saved name={} error={}", name, type(exc).__name__)
        return cache_changed

    def add_always_grant(self, name: str, tool: str) -> None:
        record = self._records.get(name)
        if record is None or tool in record.always_grants:
            return
        self._replace(record, replace(record, always_grants=(*record.always_grants, tool)))

    def mark_computer_use(self, name: str) -> None:
        """Remember that the server operates the user's input; kept until its command changes."""
        record = self._records.get(name)
        if record is None or record.computer_use:
            return
        self._replace(record, replace(record, computer_use=True))

    def clear_always_grants(self, name: str) -> None:
        record = self._records.get(name)
        if record is None or not record.always_grants:
            return
        self._replace(record, replace(record, always_grants=()))

    def _replace(self, previous: ServerRecord, record: ServerRecord) -> None:
        self._records[record.name] = record
        try:
            self._save()
        except OSError:
            self._restore(record.name, previous)
            raise

    def _restore(self, name: str, previous: ServerRecord | None) -> None:
        if previous is None:
            self._records.pop(name, None)
        else:
            self._records[name] = previous
