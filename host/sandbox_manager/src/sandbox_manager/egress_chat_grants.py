"""The chats a user allowed every web page for (#3562, design 6.3): `all_for_chat`, in memory.

A chat is its root session; a subagent's session rolls up to it. `session_ref` is the only form of a session
id that reaches an audit line, a digest or the desktop app, and is computed from the label the contract
publishes (`egress-approval-grant.ts`), which is the egress proxy's too, so both name one chat alike.

The Connector's copy lasts until the Connector restarts; the Sandbox Manager's broker saves its own list in
its store, so the user's choice outlives a restart until it is switched off. A new chat starts with none. It
is a UX scope, not a security boundary: the session ids come from code that holds the caller key.

Standard library plus the generated contract data: it ships in the Connector's payload, which has no Pydantic.
"""

from __future__ import annotations

import hashlib
import threading
from collections import OrderedDict

from contracts.egress_approval_grant_data import EGRESS_APPROVAL_GRANT_DATA

LABEL = EGRESS_APPROVAL_GRANT_DATA["session_ref"]["label"]
MAX_CHATS = 256


def session_ref(session_id: str) -> str:
    """`sref_` and the first 16 hex characters of sha256(label + session id), over UTF-8."""
    digest = hashlib.sha256((LABEL + session_id).encode("utf-8")).hexdigest()
    return f"sref_{digest[:16]}"


class ChatGrants:
    """What the user allowed for a chat. Chats are bounded; at the bound the oldest chat's grant is forgotten,
    which asks again and never allows more. Called from the Connector's worker threads."""

    def __init__(self) -> None:
        self._chats: OrderedDict[str, None] = OrderedDict()
        self._lock = threading.Lock()

    def covers(self, ref: str) -> str | None:
        """The scope that lets this chat's request through, or None."""
        with self._lock:
            return "all_for_chat" if ref in self._chats else None

    def add(self, ref: str, scope: str) -> None:
        if scope != "all_for_chat":
            return
        with self._lock:
            self._chats.pop(ref, None)
            self._chats[ref] = None
            while len(self._chats) > MAX_CHATS:
                self._chats.popitem(last=False)

    def refs(self) -> list[str]:
        """The allowed chats, oldest first."""
        with self._lock:
            return list(self._chats)

    def forget(self, ref: str) -> None:
        """The user switched the chat off: its next request is asked about again. Unknown chats are fine."""
        with self._lock:
            self._chats.pop(ref, None)
