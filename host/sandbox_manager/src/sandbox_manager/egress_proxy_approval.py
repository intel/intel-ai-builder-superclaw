"""The egress proxy's approval of an unlisted destination on the shell listener (EG2-4b, design 6.3 and 6.4).

In `enforce` mode a destination the shell listener's allowlist does not list is not refused outright: the
request is held, listed on the proxy's admin endpoint for the Sandbox Manager's approval broker, and the
user is asked in the desktop app. The channel listener never asks. Contract: `egress-proxy-approval.ts`; the
wire is the Connector's (`connector_approval`: the same admin routes, secret header, signed one-time grant and
checks), for the `egress_proxy` audience and the action `proxy.connect_unlisted`.

Whose chat a command belongs to is told by the proxy credential the agent plugin put in the command's
`HTTPS_PROXY`: `sc1.<d|c>.<root session id>` and a MAC under `session_key`, which is sealed into this proxy's
configuration and never in the shell's environment. A request with no valid credential is an unknown chat: it
may be approved once and gets no chat-scoped grant. A channel-owned session (Slack, Telegram) has no
interactive approver: it is refused at once. The grants a user gives for a chat live in this process's memory:
a restart of the proxy ends them, and a new chat starts with none. `all_for_chat` covers public hosts only: the
screen that refuses loopback, link-local, host and private addresses runs before this is consulted.

A chat-scoped grant is a UX scope, not a security boundary, like the Connector's web-read grants (#3562):
every chat's commands run as one account in one Job, and code in one chat can drive another through the
runtime's own server. The desktop dialog therefore says the grant covers commands from every chat until
SuperClaw restarts, although it is recorded per chat here. Unlike those grants, which the broker saves, these are never
written down.

Standard library plus `connector_approval` (and through it `cryptography`) and `egress_chat_grants`, which names a chat
and remembers its grant as the Connector does: it ships in the Connector's payload.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import hmac
import json
import re
import secrets
import sys
import threading
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from functools import partial
from typing import Any

from contracts.egress_approval_grant_data import EGRESS_APPROVAL_GRANT_DATA

from . import connector_approval, egress_allowlist_match
from .connector_approval import ApprovalConfig, GrantRejected
from .egress_chat_grants import ChatGrants, session_ref

RULES = EGRESS_APPROVAL_GRANT_DATA["proxy_rules"]
AUDIENCE = "egress_proxy"
ACTION = "proxy.connect_unlisted"
SCOPES = tuple(RULES["scopes_known_chat"])
STATE_PATH = RULES["state_path"]
UNKNOWN_REF = RULES["unknown_session_ref"]
# What the shell listener's allowlist refuses that a user may be asked about; anything else stays refused.
ASKABLE = frozenset({egress_allowlist_match.NOT_ALLOWLISTED, egress_allowlist_match.PORT_NOT_ALLOWED})
# One chat may have this many unanswered prompts; the desk's own cap (8) bounds all chats together.
MAX_HELD_PER_CHAT = 4
_USERNAME = re.compile(
    r"^" + re.escape(RULES["username_prefix"]) + r"\.(?P<flavor>[dc])\.(?P<session>" + RULES["session_id_pattern"][1:-1] + r")$"
)
_FLAVORS = {"d": "desktop", "c": "channel"}
_MAX_HEADER_VALUE = 512
_ADMIN_THREADS = connector_approval.MAX_HELD + 4
_PHRASES = {200: "OK", 400: "Bad Request", 401: "Unauthorized", 404: "Not Found", 409: "Conflict", 413: "Payload Too Large"}


def request_digest(host: str, port: int, ref: str) -> str:
    """The digest of a `proxy.connect_unlisted` request: sha256 of the canonical `{host, port, session_ref}`."""
    canonical = json.dumps({"host": host, "port": port, "session_ref": ref}, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def proxy_grant_is_well_formed(candidate: object) -> bool:
    return connector_approval.grant_shape_is_valid(candidate, AUDIENCE, ACTION, SCOPES)


def header_value(head: bytes, name: str) -> str | None:
    """The value of the one header called `name` in a request head, or None when it is absent, repeated or
    oversized: a header that appears twice is not one this proxy will believe."""
    wanted = name.lower().encode("ascii")
    found: list[bytes] = []
    for line in head.split(b"\r\n")[1:]:
        key, separator, value = line.partition(b":")
        if separator and key.strip().lower() == wanted:
            found.append(value.strip())
    if len(found) != 1 or len(found[0]) > _MAX_HEADER_VALUE:
        return None
    return found[0].decode("latin-1")


@dataclass(frozen=True)
class Chat:
    """Whose command it is: `flavor` is `desktop` or `channel`, `ref` the session's reference."""

    flavor: str
    ref: str


class SessionCredentials:
    """Reads the proxy credential: which root session a command belongs to, or None for an unknown chat."""

    def __init__(self, session_key: str) -> None:
        self._key = base64.urlsafe_b64decode(session_key + "=" * (-len(session_key) % 4))

    def identify(self, authorization: str | None) -> Chat | None:
        if authorization is None:
            return None
        scheme, _, encoded = authorization.partition(" ")
        if scheme.lower() != "basic":
            return None
        try:
            decoded = base64.b64decode(encoded.strip(), validate=True).decode("utf-8")
        except (binascii.Error, UnicodeDecodeError):
            return None
        username, separator, password = decoded.partition(":")
        match = _USERNAME.fullmatch(username)
        if not separator or match is None:
            return None
        mac = hmac.new(self._key, (RULES["mac_label"] + username).encode("utf-8"), hashlib.sha256).digest()
        expected = base64.urlsafe_b64encode(mac).rstrip(b"=").decode("ascii")
        if not hmac.compare_digest(expected.encode("ascii"), password.encode("utf-8", "replace")):
            return None
        return Chat(_FLAVORS[match["flavor"]], session_ref(match["session"]))


class _ProxyHeld(connector_approval._Held):
    def entry(self) -> dict:
        listed = {**super().entry(), "audience": AUDIENCE, "action": ACTION, "caller": "shell"}
        # A command whose chat could not be told names none.
        if self.session_ref == UNKNOWN_REF:
            del listed["session_ref"]
        return listed


class ProxyApprovalDesk(connector_approval.ApprovalDesk):
    """The Connector's desk for the proxy: the same hold, long-poll, signature and one-time checks, a grant
    that carries a scope, and a listed entry that says which scopes may be chosen."""

    def request_hold(
        self, host: str, port: int, ref: str, scopes: tuple[str, ...]
    ) -> tuple[str, str]:
        """Hold `host:port` for the chat `ref`: the approval id and `held`, or why it is not held
        (`unattended`, `full`, `denied_recently`)."""
        approval_id = "approval-" + secrets.token_urlsafe(12)
        target = f"{host}:{port}"
        with self._condition:
            now = self._now()
            self._denied_until = {key: until for key, until in self._denied_until.items() if until > now}
            if f"{ref}|{target}" in self._denied_until:
                return approval_id, "denied_recently"
            attached = self._last_poll_ms is not None and now - self._last_poll_ms <= self.attach_window_ms
            if not attached:
                return approval_id, "unattended"
            waiting = [held for held in self._held.values() if held.outcome is None]
            if (
                len(waiting) >= connector_approval.MAX_HELD
                or sum(held.session_id == ref for held in waiting) >= MAX_HELD_PER_CHAT
            ):
                return approval_id, "full"
            self._held[approval_id] = _ProxyHeld(
                approval_id, ref, ref, target, request_digest(host, port, ref), now, now + self._hold_ms, scopes=scopes
            )
            self._condition.notify_all()
        return approval_id, "held"

    def deny(self, approval_id: str) -> None:
        """A denial is remembered for the chat that was refused, not for every chat."""
        with self._condition:
            held = self._held.get(approval_id)
            if held is None or held.outcome is not None:
                raise connector_approval.ApprovalNotPending
            held.outcome = "denied"
            if len(self._denied_until) < 64:
                self._denied_until[f"{held.session_id}|{held.target}"] = self._now() + connector_approval.DENIED_MEMORY_MS
            self._condition.notify_all()

    def accept_grant(self, token: str) -> None:
        """The Connector's checks in the contract's order, and then the scope: one the user was not offered
        for this request is refused."""
        grant = connector_approval.decode_grant_token(token, self.config.public_key, proxy_grant_is_well_formed)
        with self._condition:
            now = self._now()
            if grant["boot_id"] != self.config.boot_id:
                raise GrantRejected("boot_id")
            if not grant["issued_at_ms"] <= now < grant["expires_at_ms"]:
                raise GrantRejected("time_window")
            held = self._held.get(grant["approval_id"])
            if held is None or held.outcome is not None or now >= held.expires_ms:
                raise connector_approval.ApprovalNotPending
            if grant["request_digest"] != held.digest:
                raise GrantRejected("request_digest")
            if grant["scope"]["kind"] not in held.scopes:
                raise GrantRejected("scope")
            self._used = {grant_id: until for grant_id, until in self._used.items() if until > now}
            if grant["grant_id"] in self._used:
                raise GrantRejected("once_unused")
            self._used[grant["grant_id"]] = grant["expires_at_ms"]
            held.scope = grant["scope"]["kind"]
            held.outcome = "granted"
            if held.scope == "all_for_chat":
                # Everything for this chat also answers what the chat is already waiting on, so the user is
                # not asked again for requests held alongside this one.
                for other in self._held.values():
                    if (
                        other.outcome is None
                        and other.session_id == held.session_id
                        and isinstance(other, _ProxyHeld)
                        and "all_for_chat" in other.scopes
                    ):
                        other.scope = "all_for_chat"
                        other.outcome = "granted"
            self._condition.notify_all()


@dataclass(frozen=True)
class Decision:
    """What became of a request for an unlisted destination; `reason` is set when it is refused."""

    admitted: bool
    reason: str | None
    session_ref: str
    decision: str
    scope: str | None = None
    approval_id: str | None = None


_HOLD_REFUSALS = {"unattended": "approval_unavailable", "full": "approval_queue_full", "denied_recently": "approval_denied"}
_OUTCOME_REFUSALS = {"denied": "approval_denied", "expired": "approval_expired", "cancelled": "approval_unavailable"}


class ShellApprovals:
    """The shell listener's approval of unlisted destinations: credentials, grants and the desk."""

    def __init__(self, *, config: ApprovalConfig, session_key: str, desk: ProxyApprovalDesk | None = None) -> None:
        self.desk = desk or ProxyApprovalDesk(config, hold_ms=RULES["hold_ms"])
        self._credentials = SessionCredentials(session_key)
        self._grants = ChatGrants()
        self._pool = ThreadPoolExecutor(max_workers=_ADMIN_THREADS, thread_name_prefix="egress-proxy-approval")
        self._inflight: dict[str, asyncio.Future[Decision]] = {}
        # The wait tasks, held until done: the event loop keeps only weak references to tasks.
        self._waits: set[asyncio.Task[None]] = set()
        self._cancel = threading.Event()

    def close(self) -> None:
        self._cancel.set()
        self._pool.shutdown(wait=False, cancel_futures=True)

    async def decide(self, *, host: str, port: int, authorization: str | None) -> Decision:
        """Decide a request the allowlist did not list. `host` is the canonical name of a public target."""
        chat = self._credentials.identify(authorization)
        if chat is not None and chat.flavor == "channel":
            return Decision(False, "no_interactive_approver", chat.ref, "refused")
        ref = chat.ref if chat is not None else UNKNOWN_REF
        if chat is not None:
            covered = self._grants.covers(ref)
            if covered is not None:
                return Decision(True, None, ref, "allowed", covered)
        digest = request_digest(host, port, ref)
        waiting = self._inflight.get(digest)
        if waiting is None:
            scopes = tuple(RULES["scopes_known_chat"] if chat is not None else RULES["scopes_unknown_chat"])
            approval_id, status = self.desk.request_hold(host, port, ref, scopes)
            if status != "held":
                return Decision(False, _HOLD_REFUSALS[status], ref, "refused", approval_id=approval_id)
            waiting = asyncio.get_running_loop().create_future()
            self._inflight[digest] = waiting
            task = asyncio.ensure_future(self._await(digest, waiting, approval_id, host, port, ref, chat is not None))
            self._waits.add(task)
            task.add_done_callback(self._wait_done)
        # Requests for the same site from the same chat that arrive while one is held share its answer.
        return await asyncio.shield(waiting)

    def _wait_done(self, task: asyncio.Task[None]) -> None:
        self._waits.discard(task)
        if not task.cancelled() and task.exception() is not None:
            # The shared answer was already resolved as a refusal in `_await`; say why on the tier log.
            print(
                f"egress-proxy event=approval_wait_failed exception_type={type(task.exception()).__name__}",
                file=sys.stderr,
                flush=True,
            )

    async def _await(
        self, digest: str, answer: asyncio.Future[Decision], approval_id: str, host: str, port: int, ref: str, known: bool
    ) -> None:
        # Whatever ends the wait, every request sharing `answer` gets a decision: an unexpected error is a
        # refusal, never a hang until each client gives up.
        result = Decision(False, "approval_unavailable", ref, "refused", None, approval_id)
        try:
            outcome, scope, _decided_id = await asyncio.get_running_loop().run_in_executor(
                self._pool, self.desk.wait_decided, approval_id, self._cancel
            )
            if outcome == "granted":
                if known and scope is not None:
                    self._grants.add(ref, scope)
                result = Decision(True, None, ref, "approved", scope, approval_id)
            else:
                result = Decision(False, _OUTCOME_REFUSALS[outcome], ref, outcome, None, approval_id)
        except (RuntimeError, KeyError):
            pass
        finally:
            self._inflight.pop(digest, None)
            if not answer.done():
                answer.set_result(result)

    async def serve_admin(
        self, method: str, target: str, head: bytes, reader: asyncio.StreamReader, log: Callable[..., None]
    ) -> tuple[int, bytes]:
        """One request on the admin routes: the status and the JSON body. The secret is judged before any
        body is read, as the Connector does."""
        length_text = header_value(head, "content-length")
        length = int(length_text) if length_text is not None and length_text.isdigit() else None
        body = b""
        if method == "POST" and length:
            try:
                body = await asyncio.wait_for(
                    reader.readexactly(min(length, connector_approval.MAX_BODY_READ)), timeout=10.0
                )
            except (asyncio.IncompleteReadError, asyncio.TimeoutError, ConnectionError):
                body = b""
        status, answer = await asyncio.get_running_loop().run_in_executor(
            self._pool,
            partial(
                connector_approval.handle_admin,
                self.desk,
                method=method,
                target=target,
                secret=header_value(head, RULES_SECRET_HEADER),
                content_length=length,
                body=body,
                log=log,
            ),
        )
        return status, json.dumps(answer, separators=(",", ":")).encode("utf-8")


RULES_SECRET_HEADER = connector_approval.RULES["admin_secret_header"]


def is_admin_target(target: str) -> bool:
    return connector_approval.is_admin_path(target)


def phrase(status: int) -> str:
    return _PHRASES.get(status, "Error")
