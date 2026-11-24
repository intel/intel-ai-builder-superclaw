"""Pending approvals for host tool calls and host browser origins.

A held request waits here until the user decides through ``/mcp-host/v1/approvals`` (ServiceHub
forwarded only) or the timeout passes, which counts as a denial. Everything a card shows is built
here from what the gateway saw, cleaned of control, format and surrogate characters and cut to the
contract's length in UTF-16 code units; nothing the runtime wrote about a call is shown.
"""

from __future__ import annotations

import asyncio
import json
import secrets
import time
import unicodedata
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime

from .audit import utc_instant
from .errors import RULES

TEXT_MAX_UNITS: int = RULES["text_max_utf16_units"]
ORIGIN_SCOPES: tuple[str, ...] = ("once", "until_restart")
_ELLIPSIS = "\u2026"
_NOTHING_VISIBLE = "(no readable text)"
_REMEMBERED = 1024
_SCAN_MAX_CHARS = 64 * 1024
_PREVIEW_MAX_CHARS = 8 * 1024
_PREVIEW_ENCODER = json.JSONEncoder(ensure_ascii=False, separators=(",", ":"))
_DROPPED_CATEGORIES = frozenset({"Cc", "Cf", "Cs"})


class ApprovalNotFound(Exception):
    pass


class ApprovalNotPending(Exception):
    pass


class ApprovalScopeNotOffered(Exception):
    pass


def utf16_units(text: str) -> int:
    return len(text.encode("utf-16-le", "surrogatepass")) // 2


def display_text(text: str, *, more: bool = False) -> str:
    """Plain text for the user: control, format and surrogate characters out, whitespace runs as one
    space, and no ellipsis of its own, so the ellipsis that ends a shortened text cannot come from it.

    Scanning stops as soon as the visible text is over the limit, and after ``_SCAN_MAX_CHARS``
    characters in any case, so a huge string costs no more than a short one. ``more`` says the text
    was already cut before it got here, which ends it with the ellipsis too.
    """
    kept: list[str] = []
    units = 0
    space = False
    over = more
    for index, char in enumerate(text):
        if index >= _SCAN_MAX_CHARS:
            over = True
            break
        if char == _ELLIPSIS or unicodedata.category(char) in _DROPPED_CATEGORIES:
            continue
        if char.isspace():
            space = bool(kept)
            continue
        if space:
            kept.append(" ")
            units += 1
            space = False
        kept.append(char)
        units += utf16_units(char)
        if units > TEXT_MAX_UNITS:
            over = True
            break
    if not kept:
        return _NOTHING_VISIBLE + (_ELLIPSIS if over else "")
    if not over:
        return "".join(kept)
    shortened: list[str] = []
    room = TEXT_MAX_UNITS - utf16_units(_ELLIPSIS)
    for char in kept:
        room -= utf16_units(char)
        if room < 0:
            break
        shortened.append(char)
    return "".join(shortened) + _ELLIPSIS


def arguments_preview(arguments: object) -> str | None:
    """Compact JSON of a call's arguments as display text; None when there are none. Serialization
    stops after ``_PREVIEW_MAX_CHARS``: the card shows at most 512 UTF-16 units of it anyway."""
    if arguments is None or arguments == {} or arguments == []:
        return None
    chunks: list[str] = []
    size = 0
    more = False
    try:
        for chunk in _PREVIEW_ENCODER.iterencode(arguments):
            chunks.append(chunk)
            size += len(chunk)
            if size > _PREVIEW_MAX_CHARS:
                more = True
                break
    except RecursionError:
        # The pure-Python encoder nests deeper per level than the parser that accepted the
        # arguments; what was written so far is the preview.
        more = True
    return display_text("".join(chunks)[:_PREVIEW_MAX_CHARS], more=more)


@dataclass(frozen=True)
class Outcome:
    """``granted`` with the chosen scope, ``denied``, ``timeout`` or ``cancelled``."""

    decision: str
    scope: str | None = None


@dataclass
class PendingApproval:
    approval_id: str
    kind: str
    grant_scopes: tuple[str, ...]
    requested_at: datetime
    expires_at: datetime
    future: asyncio.Future[Outcome]
    display: dict[str, object] = field(default_factory=dict)
    server: str | None = None

    def view(self) -> dict[str, object]:
        return {
            "kind": self.kind,
            "approval_id": self.approval_id,
            "requested_at": utc_instant(self.requested_at),
            "expires_at": utc_instant(self.expires_at),
            "grant_scopes": list(self.grant_scopes),
            **{key: value for key, value in self.display.items() if value is not None},
        }


class ApprovalBroker:
    """``timeout_ms`` is the longest any request waits (the contract's 10 minutes by default); a
    request may ask for less. ``sleep`` times the waits, so tests can run them on a simulated clock."""

    def __init__(
        self,
        *,
        timeout_ms: int | None = None,
        max_pending: int | None = None,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self._timeout_s = (timeout_ms if timeout_ms is not None else RULES["approval_timeout_ms"]) / 1000
        self._no_progress_timeout_s = RULES["no_progress_approval_timeout_ms"] / 1000
        self._max_pending = max_pending if max_pending is not None else RULES["pending_max"]
        self._sleep = sleep
        self._pending: dict[str, PendingApproval] = {}
        self._gone: OrderedDict[str, None] = OrderedDict()
        self._changed: asyncio.Condition | None = None
        self._origins_until_restart: set[str] = set()

    def _condition(self) -> asyncio.Condition:
        if self._changed is None:
            self._changed = asyncio.Condition()
        return self._changed

    async def request_tool_call(
        self,
        *,
        server: str,
        tool: str,
        title: str | None,
        annotations: dict[str, bool | None],
        arguments: object,
        grant_scopes: tuple[str, ...],
        timeout_s: float | None = None,
        on_pending: Callable[[str], None] | None = None,
    ) -> tuple[str | None, Outcome]:
        """Hold a tool call for the user; returns the approval id (None when refused at the bound)
        and the outcome. ``on_pending`` gets the id as soon as the request is listed, so the caller
        can cancel it while it waits."""
        return await self._request(
            kind="tool_call",
            grant_scopes=grant_scopes,
            server=server,
            timeout_s=timeout_s,
            on_pending=on_pending,
            display={
                "server": server,
                "tool": display_text(tool),
                "title": display_text(title) if title else None,
                "annotations": annotations,
                "arguments_preview": arguments_preview(arguments),
            },
        )

    async def request_origin(self, origin: str) -> bool:
        """Ask the user about a browser navigation to ``origin``; True when allowed. A held
        navigation has no progress keepalive, so it waits the no-progress budget only."""
        if origin in self._origins_until_restart:
            return True
        _, outcome = await self._request(
            kind="browser_origin",
            grant_scopes=ORIGIN_SCOPES,
            server=None,
            timeout_s=self._no_progress_timeout_s,
            on_pending=None,
            display={"origin": display_text(origin)},
        )
        if outcome.decision == "granted" and outcome.scope == "until_restart":
            self._origins_until_restart.add(origin)
        return outcome.decision == "granted"

    async def _request(
        self,
        *,
        kind: str,
        grant_scopes: tuple[str, ...],
        server: str | None,
        display: dict[str, object],
        timeout_s: float | None,
        on_pending: Callable[[str], None] | None,
    ) -> tuple[str | None, Outcome]:
        if len(self._pending) >= self._max_pending:
            return None, Outcome("denied")
        wait_s = self._timeout_s if timeout_s is None else min(timeout_s, self._timeout_s)
        now = datetime.now(UTC)
        approval_id = "hmcp_" + secrets.token_urlsafe(18)
        loop = asyncio.get_running_loop()
        pending = PendingApproval(
            approval_id=approval_id,
            kind=kind,
            grant_scopes=grant_scopes,
            requested_at=now,
            expires_at=datetime.fromtimestamp(now.timestamp() + wait_s, UTC),
            future=loop.create_future(),
            display=display,
            server=server,
        )
        self._pending[approval_id] = pending
        if on_pending is not None:
            on_pending(approval_id)
        await self._notify()
        timer = asyncio.ensure_future(self._sleep(wait_s))
        try:
            # Waiting never cancels the future, and no await separates the check below from
            # settling it, so a decision either lands first and is the outcome, or finds the
            # request settled as timed out and is refused.
            await asyncio.wait({pending.future, timer}, return_when=asyncio.FIRST_COMPLETED)
            if not pending.future.done():
                pending.future.set_result(Outcome("timeout"))
            outcome = pending.future.result()
        finally:
            timer.cancel()
            self._retire(approval_id)
        return approval_id, outcome

    def cancel(self, approval_id: str) -> bool:
        """Settle a pending approval as ``cancelled`` (its requester went away); a decision that
        comes later is refused as not pending. False when it was not pending."""
        pending = self._pending.get(approval_id)
        if pending is None or pending.future.done():
            return False
        pending.future.set_result(Outcome("cancelled"))
        self._retire(approval_id)
        return True

    async def _notify(self) -> None:
        condition = self._condition()
        async with condition:
            condition.notify_all()

    def _retire(self, approval_id: str) -> None:
        if self._pending.pop(approval_id, None) is not None:
            self._gone[approval_id] = None
            while len(self._gone) > _REMEMBERED:
                self._gone.popitem(last=False)

    async def pending(self, wait_s: float) -> list[PendingApproval]:
        """What is waiting, oldest first; waits up to ``wait_s`` for the first one when none is."""
        deadline = time.monotonic() + max(wait_s, 0.0)
        condition = self._condition()
        async with condition:
            while not self._pending:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                try:
                    await asyncio.wait_for(condition.wait(), remaining)
                except TimeoutError:
                    break
        return sorted(self._pending.values(), key=lambda approval: approval.requested_at)

    def decide(self, approval_id: str, approve: bool, grant_scope: str | None) -> Outcome:
        pending = self._pending.get(approval_id)
        if pending is None:
            if approval_id in self._gone:
                raise ApprovalNotPending
            raise ApprovalNotFound
        if pending.future.done():
            raise ApprovalNotPending
        if datetime.now(UTC) >= pending.expires_at:
            pending.future.set_result(Outcome("timeout"))
            self._retire(approval_id)
            raise ApprovalNotPending
        scope = grant_scope or "once"
        if approve and scope not in pending.grant_scopes:
            raise ApprovalScopeNotOffered
        outcome = Outcome("granted", scope) if approve else Outcome("denied")
        pending.future.set_result(outcome)
        self._retire(approval_id)
        return outcome

    def deny_all(self, server: str | None = None) -> int:
        """Deny every pending approval, browser origins included; with ``server``, only that
        server's tool calls. Returns how many."""
        denied = 0
        for pending in list(self._pending.values()):
            if server is not None and (pending.kind != "tool_call" or pending.server != server):
                continue
            if not pending.future.done():
                pending.future.set_result(Outcome("denied"))
                denied += 1
            self._retire(pending.approval_id)
        return denied
