"""Append-only record of what the user decided through the control plane.

One JSON object per line in ``control-audit.jsonl`` under the manager log directory, which only the
owner account can read. Callers pass identifiers and outcomes; a secret, its length or digest, a URL
or a recipient never goes into a line.

The file records what the user decided, written before the change is made: a line is intent, not
proof that the change happened. A change that then fails leaves its line, and the caller's own error
is what says it failed.
"""

from __future__ import annotations

import json
import threading
from datetime import UTC, datetime
from pathlib import Path

# A secret event names the secret and carries nothing else, so a value cannot be passed by mistake.
_SECRET_EVENTS = frozenset({"secret.saved", "secret.cleared", "secret.migrated"})
_SECRET_NAMES = frozenset({"tavily_api_key", "slack_tokens", "telegram_token"})
# A saved secret paused or resumed: its name and the new state, never the value.
_SECRET_SWITCH_EVENT = "secret.enabled_changed"
# A channel event names the channel and the identity or switch it changed, and carries nothing else.
_CHANNEL_EVENT_FIELDS = {
    "channel.identity_deleted": frozenset({"channel", "identity_id"}),
    "channel.enabled_changed": frozenset({"channel", "enabled"}),
    "channel.identity_enabled_changed": frozenset({"channel", "identity_id", "enabled"}),
    # The operator's own send and binding change (EG2-7): which channel, how it was addressed. Never the text,
    # a peer or a directory.
    "channel.message_sent": frozenset({"channel", "addressed"}),
    "channel.binding_changed": frozenset({"channel", "bound"}),
    # A Slack member approved or removed (#3539): the decision only, never who.
    "channel.sender_changed": frozenset({"channel", "allowed"}),
    # The router database carried from the file_tool tier's directory to the channel tier's (EG2-6).
    "channel.router_db_migrated": frozenset(),
}


def utc_instant(moment: datetime) -> str:
    """RFC 3339 UTC instant with millisecond precision, e.g. ``2026-10-06T18:40:00.000Z``."""
    moment = moment.astimezone(UTC)
    return f"{moment:%Y-%m-%dT%H:%M:%S}.{moment.microsecond // 1000:03d}Z"


class ControlAudit:
    def __init__(self, path: Path) -> None:
        self._path = path
        self._lock = threading.Lock()
        self._directory_made = False

    def record(self, event: str, **fields: str) -> None:
        if event in _SECRET_EVENTS and (
            set(fields) != {"secret"} or fields["secret"] not in _SECRET_NAMES
        ):
            raise ValueError(f"{event} carries only the name of a known secret")
        if event == _SECRET_SWITCH_EVENT and (
            set(fields) != {"secret", "enabled"} or fields["secret"] not in _SECRET_NAMES
        ):
            raise ValueError(f"{event} carries only the name of a known secret and the new state")
        expected = _CHANNEL_EVENT_FIELDS.get(event)
        if expected is not None and set(fields) != expected:
            raise ValueError(f"{event} carries only {sorted(expected)}")
        line = {"ts": utc_instant(datetime.now(UTC)), "event": event, **fields}
        encoded = json.dumps(line, ensure_ascii=False) + "\n"
        with self._lock:
            if not self._directory_made:
                self._path.parent.mkdir(parents=True, exist_ok=True)
                self._directory_made = True
            with self._path.open("a", encoding="utf-8") as stream:
                stream.write(encoded)
