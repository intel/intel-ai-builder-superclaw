"""The Sandbox Manager's approval broker for the Connector and the router (EG1-7, EG2-7, design 6.3).

It long-polls each verifier's admin endpoint for the requests it holds, lets the routes list them all in one
list, and on a decision either signs a one-time grant with this start's Ed25519 key or sends an unsigned
denial to the verifier that listed the approval. The private key is generated at construction and lives in
memory only: a restart of the Sandbox Manager makes every grant it ever signed useless, because each verifier
is told a new public key and a new `boot_id` with its sealed config. What goes into that config is
`provider_config(audience)`: the public key, the `boot_id` and that verifier's own admin secret. The two
verifiers share the key and the boot, never the secret: whoever holds the Connector's can deny nothing the
router holds.

The signing and the HTTP to the Connector run in worker threads, so a route awaiting this broker never does
them on the event loop. The target the Connector lists is kept as it is: the route cleans it for display,
and the grant is over the Connector's digest of the real one, copied, never computed here.

Chat grants (#3562): the chats the user allowed every web page for, by `session_ref`, saved in the Sandbox
Manager's store, oldest first, at most `MAX_CHATS`. A held entry of an allowed chat that offers `all_for_chat`
is answered with that scope here (an auto-answer) and never listed; the Connector still checks the grant. A
restarted Connector has forgotten its chat grants, so it holds the chat's next request for this broker to
answer. `generation` moves on every attach and detach; each chat's revision moves where it says +1 below, and
its ack count only where a forget is accepted.

    on                      add, +1, save. Save fails: logged; on now, off after a restart.
    bound drops a chat      (on, dialog record, rollback) the dropped chat +1 and a forget; a failed forget is
                            logged and the chat stays dropped.
    off, chat on            save without it, remove, +1, forget. Save fails: raise, nothing changes.
    off, chat already off   save the list as it is (a drop at the bound may not have been saved; save fails:
                            raise, nothing changes), forget (the Connector may know a chat this broker does
                            not); never adds; the revision stays. While a dialog grant for it is on its way,
                            its off count +1.
    forget accepted (off)   by a replaced Connector, or with the revision moved since it was sent (a newer on
                            or dialog grant): ignored. Else ack count +1 (the revision stays); converge: if a
                            rollback put the chat back, save without it, remove. Save fails: raise, still on.
    forget failed (off)     raise. Rollback (add, save) only if this off removed the chat and generation,
                            revision and ack count are unchanged. Save fails: logged; on now, off after restart.
    dialog all_for_chat,    revision and off count unchanged since delivery began: add, +1, save (save fails:
      delivered             logged; on now, off after a restart). Either moved, chat off, generation unchanged:
                            forget again, a cleanup; the delivered decision still succeeds. A failed one is
                            logged and never raises; the chat stays off only if a forget sent after the grant
                            was taken by this Connector (which then took the grant first), else it is put back
                            like a rollback, since the Connector admits it.
    auto-answer             never sent while a forget of the chat is on its way (one put back by a failed forget
                            while another is still out): the Connector may take that forget before or after the
                            grant. The request is listed for the user.
    auto-answer, delivered  records nothing; if the chat is off now and generation unchanged, whatever took it
                            off, forget again as above.
    all_for_chat grant,     (its answer lost) records nothing; if the chat is off here and generation unchanged,
      outcome unknown       forget (failure logged); the decision fails. A refusal stays a plain failure:
                            nothing recorded or retired, the request still listed (`grant_superseded` too).
    attach / detach         chats kept; what the Connector held is forgotten.
    start                   load the valid unique refs, newest `MAX_CHATS`, saved back if that changed them
                            (save fails: logged); unreadable or not a list: logged, none.
"""

from __future__ import annotations

import asyncio
import base64
import json
import re
import secrets
import sqlite3
import threading
import time
from collections import OrderedDict
from collections.abc import Callable
from datetime import UTC, datetime
from http.client import HTTPConnection, HTTPException
from typing import Any, Protocol

from contracts.connector_admin_pending_list import ConnectorAdminPendingList
from contracts.egress_approval_grant import EgressApprovalGrant
from contracts.egress_approval_grant_data import EGRESS_APPROVAL_GRANT_DATA
from contracts.egress_proxy_admin_pending_list import EgressProxyAdminPendingList
from contracts.egress_proxy_approval_grant import EgressProxyApprovalGrant
from contracts.router_admin_pending_list import RouterAdminPendingList
from contracts.router_approval_grant import RouterApprovalGrant
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from loguru import logger
from pydantic import ValidationError

from .egress_approvals import (
    ApprovalDecided,
    ApprovalDeliveryFailed,
    ApprovalNotFound,
    ApprovalNotPending,
    ApprovalScopeNotOffered,
    PendingApproval,
)
from .egress_chat_grants import ChatGrants
from .store import Store

RULES = EGRESS_APPROVAL_GRANT_DATA["rules"]
CHAT_GRANTS_CONFIG_KEY = "egress_chat_grants"
_AUDIENCES = ("connector", "router", "egress_proxy")
# What each verifier lists, and the grant it is sent: the contract's own model for its audience.
_PENDING_LISTS = {
    "connector": ConnectorAdminPendingList,
    "router": RouterAdminPendingList,
    "egress_proxy": EgressProxyAdminPendingList,
}
_GRANTS = {"connector": EgressApprovalGrant, "router": RouterApprovalGrant, "egress_proxy": EgressProxyApprovalGrant}
_WHO = {"connector": "the Connector", "router": "the router", "egress_proxy": "the egress proxy"}
_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_SESSION_REF = re.compile(r"^sref_[0-9a-f]{16}$")
_UNREADABLE = object()
_HOST = "127.0.0.1"
_POLL_BACKOFF_S = 1.0
_POLL_BACKOFF_MAX_S = 30.0
_REMEMBERED = 1024
_REQUEST_TIMEOUT_S = 10.0
# The Connector is the less trusted side of this conversation: what it sends is bounded before it is read,
# and one entry it lists badly costs that entry, not the list.
_POLL_ANSWER_MAX_BYTES = RULES["admin_max_pending"] * 4608 + 1024
_POST_ANSWER_MAX_BYTES = 4096
_CLOCK_WINDOW_MS = 10 * 60 * 1000
# The Sandbox Manager and the Connector share one host clock; an entry a few seconds ahead is rounding, minutes
# ahead is a claim to a hold that would outlast the request.
_FUTURE_SKEW_MS = 5_000


class _Unauthorized(Exception):
    """The Connector refused the admin secret."""


class ChatSwitchedOff(Exception):
    """An answer for a chat whose switch went off before it was signed."""


class ChatStore(Protocol):
    """Where the broker keeps the allowed chats between starts: `session_ref`s, oldest first."""

    def load(self) -> object: ...

    def save(self, refs: list[str]) -> None: ...


class ConfigChatStore:
    """The allowed chats under one key of the Sandbox Manager's `config` table."""

    def __init__(self, store: Store) -> None:
        self._store = store

    def load(self) -> object:
        return self._store.get_config(CHAT_GRANTS_CONFIG_KEY)

    def save(self, refs: list[str]) -> None:
        self._store.set_config(CHAT_GRANTS_CONFIG_KEY, refs)


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


class ConnectorApprovalBroker:
    def __init__(
        self,
        *,
        now_ms: Callable[[], int] | None = None,
        sleep: Callable[[float], object] | None = None,
        audit: Callable[..., None] | None = None,
        chat_store: ChatStore | None = None,
    ) -> None:
        """`audit` is the control audit's `record`: an answer for a chat grant is written there as the
        routes write a user's decision, and is not given if its decision line cannot be written.
        `chat_store` keeps the allowed chats between starts; without one they last for this start."""
        self._key = Ed25519PrivateKey.generate()
        self._public_key = _b64url(
            self._key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
        )
        self._boot_id = "sm-boot-" + secrets.token_urlsafe(12)
        self._admin_secrets = {audience: _b64url(secrets.token_bytes(32)) for audience in _AUDIENCES}
        self._now = now_ms or (lambda: int(time.time() * 1000))
        self._sleep = sleep or time.sleep
        self._condition = threading.Condition()
        self._held: dict[str, dict[str, Any]] = {}
        self._deciding: set[str] = set()
        # Ids that were held and no longer are: a late decision on them is "not pending", not "not found".
        self._gone: OrderedDict[str, str] = OrderedDict()
        self._ports: dict[str, int | None] = {audience: None for audience in _AUDIENCES}
        # Per verifier, moves on with every attach and detach: a delivery or a forget started under another
        # generation was answered by a verifier that is gone. Chat grants are the Connector's only.
        self._generations = {audience: 0 for audience in _AUDIENCES}
        # Moves on with every allow-all the Connector or the egress proxy took: a list either answered to a poll
        # that started before then may still name requests that grant released.
        self._released = 0
        self._audit = audit
        self._chat_store = chat_store
        self._chats = ChatGrants()
        # Moves on with every change the user makes to a chat (on, a switch-off that took it off, a dialog's
        # all_for_chat), across Connectors: what lands or fails later does not undo a newer choice.
        self._revisions: dict[str, int] = {}
        # Moves on with every forget the current Connector took while the revision stayed what it was when the
        # forget was sent. Only a failed forget's rollback reads it: the Connector no longer admits the chat, so an
        # older rollback must not put it back; a newer choice stands.
        self._acks: dict[str, int] = {}
        # Per chat, forgets numbered as they are sent, and the highest number the current Connector took. A grant
        # the Connector answered 200 to was taken before any forget sent after it: a forget taken first holds the
        # request again under a new id, and the grant is refused.
        self._forgets_sent: dict[str, int] = {}
        self._forget_taken: dict[str, int] = {}
        # Forgets on their way, per chat. The Connector may take one before or after a grant sent meanwhile, and
        # its answer cannot say which, so no answer for the chat is sent until they have all answered.
        self._forgets_on_way: dict[str, int] = {}
        # Dialog all_for_chat grants on their way, per chat, and how often a chat that was not on was switched off
        # while one was: such a switch-off outranks the grant without moving the revision, so it cannot cancel an
        # earlier switch-off's rollback.
        self._in_flight: dict[str, int] = {}
        self._offs: dict[str, int] = {}
        # Held ids being answered for their chat, which `pending` does not list; and ids whose answer for
        # their chat failed, which are the user's from then on.
        self._for_chat: set[str] = set()
        self._left_to_user: set[str] = set()
        self._load_chats()

    def _load_chats(self) -> None:
        """The saved chats, valid and unique, the newest `MAX_CHATS`; saved back when that changed them. A value
        that cannot be read is logged, never echoed, and loads as none."""
        if self._chat_store is None:
            return
        try:
            saved = self._chat_store.load()
        except ValueError:  # the stored text is not JSON
            saved = _UNREADABLE
        if saved is None:
            return
        entries = saved if isinstance(saved, list) else []
        if not isinstance(saved, list):
            logger.warning(
                "egress approvals: the saved chat grants are not a list event=chat_grant outcome=load_malformed"
            )
        refs = [ref for ref in entries if isinstance(ref, str) and _SESSION_REF.fullmatch(ref)]
        if len(refs) != len(entries):
            logger.warning(
                "egress approvals: saved chat grants that are not session refs were skipped "
                "event=chat_grant outcome=load_skipped skipped={}",
                len(entries) - len(refs),
            )
        for ref in refs:
            self._chats.add(ref, "all_for_chat")
        if self._chats.refs() != saved:
            self._save_chats()

    def provider_config(self, audience: str = "connector") -> dict[str, str]:
        """The approval section the backend seals into that verifier's config: the Connector's
        `connector-provider.json`, or the router's `opencode-router.json`."""
        return {
            "approval_public_key": self._public_key,
            "boot_id": self._boot_id,
            "admin_secret": self._admin_secrets[audience],
        }

    def attach(self, port: int, audience: str = "connector") -> None:
        """Start asking the verifier of `audience` listening on `port` what it holds."""
        with self._condition:
            self._generations[audience] += 1
            generation = self._generations[audience]
            self._ports[audience] = port
            self._forget(audience)
        threading.Thread(
            target=self._poll_loop,
            args=(audience, generation, port),
            name=f"egress-approval-poller-{audience}",
            daemon=True,
        ).start()

    def detach(self, audience: str | None = None) -> None:
        """Stop asking one verifier, or all. What it held is gone with it: a restart forgets its requests."""
        with self._condition:
            for name in _AUDIENCES if audience is None else (audience,):
                self._generations[name] += 1
                self._ports[name] = None
                self._forget(name)
            self._condition.notify_all()

    def _forget(self, audience: str) -> None:
        """Called with the lock held: drop what `audience` listed, and what was decided of it. The allowed
        chats are the user's, not the Connector's, and stay."""
        for approval_id in [key for key, entry in self._held.items() if entry["audience"] == audience]:
            del self._held[approval_id]
            self._for_chat.discard(approval_id)
            self._left_to_user.discard(approval_id)
        for approval_id in [key for key, owner in self._gone.items() if owner == audience]:
            del self._gone[approval_id]

    async def pending(self, wait_s: float) -> list[PendingApproval]:
        return await asyncio.to_thread(self._pending, wait_s)

    async def decide(self, approval_id: str, approve: bool, grant_scope: str | None = None) -> ApprovalDecided:
        return await asyncio.to_thread(self._decide, approval_id, approve, grant_scope)

    def allows_chat(self, ref: str) -> bool:
        with self._condition:
            return self._chats.covers(ref) is not None

    async def set_chat_grant(self, ref: str, allow: bool) -> None:
        """Switch a chat on or off. Off is saved first, then tells the Connector to forget it;
        ApprovalDeliveryFailed when it could not be saved, and nothing changed, or when the Connector was not
        told, and the chat then stays on, since the Connector would still admit its pages."""
        await asyncio.to_thread(self._set_chat_grant, ref, allow)

    def _pending(self, wait_s: float) -> list[PendingApproval]:
        end = time.monotonic() + max(wait_s, 0.0)
        with self._condition:
            while True:
                live = [entry for entry in self._live() if entry["approval_id"] not in self._for_chat]
                remaining = end - time.monotonic()
                if live or remaining <= 0:
                    break
                self._condition.wait(timeout=remaining)
            return [_pending_approval(entry) for entry in live]

    def _live(self) -> list[dict[str, Any]]:
        now = self._now()
        live = [entry for entry in self._held.values() if now < entry["expires_at_ms"]]
        # One list from two verifiers: oldest first, as each lists its own.
        return sorted(live, key=lambda entry: entry["requested_at_ms"])

    def _decide(
        self, approval_id: str, approve: bool, grant_scope: str | None = None, *, for_chat: bool = False
    ) -> ApprovalDecided:
        with self._condition:
            entry = self._held.get(approval_id)
            if entry is None:
                if approval_id in self._gone:
                    raise ApprovalNotPending
                raise ApprovalNotFound
            now = self._now()
            if now >= entry["expires_at_ms"]:
                self._retire(approval_id)
                raise ApprovalNotPending
            # Being answered for its chat: not settled yet, since if that answer fails the approval is the
            # user's again, so the user is told to try again, and the prompt stays.
            if not for_chat and approval_id in self._for_chat:
                raise ApprovalDeliveryFailed("the approval is being answered for its chat")
            # Being decided already, by the user or by an answer for its chat: if that delivery fails, the
            # approval must still be pending for the user, so it is not retired here.
            if approval_id in self._deciding:
                raise ApprovalNotPending
            # Only an approval that lists scopes offers more than once; a scope it did not offer is refused
            # before anything is signed.
            scope = grant_scope or "once"
            if approve and scope not in (entry.get("grant_scopes") or ["once"]):
                raise ApprovalScopeNotOffered
            # An answer for a chat that was switched off after its entry was claimed, or that a forget is on its
            # way for, is the user's to give.
            if for_chat and (
                self._chats.covers(entry["session_ref"]) is None or self._forgets_on_way.get(entry["session_ref"])
            ):
                raise ChatSwitchedOff
            self._deciding.add(approval_id)
            audience = entry["audience"]
            port = self._ports[audience]
            secret = self._admin_secrets[audience]
            # What an allow-all releases at its verifier: the chat's requests that verifier holds now that offered
            # it. One listed after it was sent, or by another Connector, is not known to be released; one held by
            # the other verifier is not released at all.
            releases = (
                [
                    other_id
                    for other_id, other in self._held.items()
                    if other["audience"] == audience
                    and other.get("session_ref") == entry["session_ref"]
                    and "all_for_chat" in (other.get("grant_scopes") or ())
                ]
                if approve and scope == "all_for_chat"
                else []
            )
            ref = entry.get("session_ref")
            # A switch-off or a new Connector while the grant is on its way must not be undone when it lands.
            generation, revision, offs = self._generations[audience], self._revisions.get(ref, 0), self._offs.get(ref, 0)
            forgets_sent = self._forgets_sent.get(ref, 0)
            # The "Allowed for this chat" switch is the Connector's: the egress proxy keeps its own allow-all.
            chat_switch = audience == "connector"
            dialog_chat_grant = chat_switch and approve and scope == "all_for_chat" and not for_chat
            if dialog_chat_grant:
                self._in_flight[ref] = self._in_flight.get(ref, 0) + 1
        posting = False
        try:
            if port is None:
                raise ApprovalDeliveryFailed(f"{_WHO[audience]} is not attached")
            if approve:
                issued = now
                grant = _GRANTS[audience].model_validate(
                    {
                        "contract_version": 1,
                        "grant_id": "grant-" + secrets.token_urlsafe(16),
                        "approval_id": approval_id,
                        "audience": entry["audience"],
                        "boot_id": self._boot_id,
                        "action": entry["action"],
                        "request_digest": entry["request_digest"],
                        "scope": {"kind": scope},
                        "issued_at_ms": issued,
                        "expires_at_ms": min(entry["expires_at_ms"], issued + RULES["max_lifetime_ms"]),
                    }
                ).model_dump(mode="json")
                signed = self._sign(grant)
                posting = True
                status = self._post(port, secret, "/v1/admin/grants", {"grant": signed})
            else:
                status = self._post(
                    port, secret, "/v1/admin/decisions", {"approval_id": approval_id, "decision": "denied"}
                )
        except BaseException:
            with self._condition:
                self._deciding.discard(approval_id)
                if dialog_chat_grant:
                    self._delivered(ref)
                # The Connector may have taken an all_for_chat grant whose answer was lost, and would admit the
                # chat's pages: unless the chat is on here, it is told to forget it. A new Connector never knew it.
                unknown = (
                    chat_switch
                    and posting
                    and scope == "all_for_chat"
                    and self._generations[audience] == generation
                    and self._chats.covers(ref) is None
                )
                revision, acks = self._revisions.get(ref, 0), self._acks.get(ref, 0)
            if (
                unknown
                and port is not None
                and not self._forget_at_connector(generation, revision, acks, port, ref, removed=False)
            ):
                logger.warning(
                    "egress approvals: a chat grant whose delivery is unknown may still be allowed "
                    "event=chat_grant outcome=forget_failed"
                )
            raise
        forget_again, acks = False, 0
        evicted: list[tuple[str, int, int]] = []
        with self._condition:
            self._deciding.discard(approval_id)
            if dialog_chat_grant:
                self._delivered(ref)
            # A replaced Connector's answer is about its own requests; the new one may reuse the ids.
            if status in (200, 404) and self._generations[audience] == generation:
                self._retire(approval_id)
            if status == 200 and approve and scope == "all_for_chat" and self._generations[audience] == generation:
                for other_id in releases:
                    self._retire(other_id)
                self._released += 1
            if chat_switch and status == 200 and approve and scope == "all_for_chat":
                if for_chat:
                    # Records nothing. Whatever took the chat off meanwhile (a switch-off, or a forget taken after
                    # a rollback, which moves neither count), the Connector recorded it with this grant.
                    if self._generations[audience] == generation and self._chats.covers(ref) is None:
                        forget_again, revision, acks = True, self._revisions.get(ref, 0), self._acks.get(ref, 0)
                elif self._revisions.get(ref, 0) == revision and self._offs.get(ref, 0) == offs:
                    # The user's choice, whichever Connector took it.
                    evicted = self._add_chat(ref)
                    self._revise(ref)
                    self._save_chats()
                elif self._generations[audience] == generation and self._chats.covers(ref) is None:
                    forget_again, revision, acks = True, self._revisions.get(ref, 0), self._acks.get(ref, 0)
            # A forget the current Connector took that was sent after this grant came after the grant there too.
            forgotten_since = self._forget_taken.get(ref, 0) > forgets_sent
            now_generation, now_port = self._generations["connector"], self._ports["connector"]
        self._forget_evicted(evicted, now_generation, now_port)
        # Switched off meanwhile: the Connector recorded the chat when it took the grant, which may have been
        # after it forgot it. A new Connector never knew it. If this forget fails, the chat stays off here only
        # when a forget sent after the grant was taken; otherwise the Connector admits it, and it is back on here.
        if (
            forget_again
            and port is not None
            and not self._forget_at_connector(generation, revision, acks, port, ref, removed=not forgotten_since)
        ):
            logger.warning(
                "egress approvals: a chat switched off while its grant was delivered may still be allowed "
                "by the Connector "
                "event=chat_grant outcome=forget_failed"
            )
        if status == 404:
            raise ApprovalNotPending
        if status != 200:
            raise ApprovalDeliveryFailed(f"{_WHO[audience]} answered {status}")
        granted_scope = scope if approve and entry.get("grant_scopes") else None
        return ApprovalDecided(
            approval_id, entry["audience"], entry["action"], "granted" if approve else "denied", granted_scope
        )

    def _retire(self, approval_id: str) -> None:
        """Called with the lock held: this approval is no longer pending."""
        retired = self._held.pop(approval_id, None)
        if retired is not None:
            self._gone[approval_id] = retired["audience"]
            while len(self._gone) > _REMEMBERED:
                self._gone.popitem(last=False)
        self._for_chat.discard(approval_id)
        self._left_to_user.discard(approval_id)
        self._condition.notify_all()

    def _set_chat_grant(self, ref: str, allow: bool) -> None:
        if allow:
            with self._condition:
                evicted = self._add_chat(ref)
                self._revise(ref)
                self._save_chats()
                claimed = self._claim_for_chats()
                generation, port = self._generations["connector"], self._ports["connector"]
            self._forget_evicted(evicted, generation, port)
            self._answer_for_chats(claimed)
            return
        with self._condition:
            # A chat that is already off keeps its revision, so an earlier switch-off whose forget fails still
            # puts the chat back, since the Connector would still admit it. A dialog grant for it on its way is
            # outranked through the off count, which only that grant reads.
            removed = self._chats.covers(ref) is not None
            # Saved before anything changes, even for a chat already off here: off here and on in the store (a
            # drop at the bound whose save failed) would come back on after a restart.
            if not self._save_chats(self._without(ref)):
                raise ApprovalDeliveryFailed("the switch-off could not be saved")
            if removed:
                self._chats.forget(ref)
                self._revise(ref)
            elif self._in_flight.get(ref):
                self._offs[ref] = self._offs.get(ref, 0) + 1
            generation, port = self._generations["connector"], self._ports["connector"]
            revision, acks = self._revisions.get(ref, 0), self._acks.get(ref, 0)
        if port is None:
            return  # no Connector, so none that remembers the chat
        # Sent even for a chat that is off here: the Connector may know a chat this broker does not.
        if not self._forget_at_connector(generation, revision, acks, port, ref, removed=removed):
            raise ApprovalDeliveryFailed("the chat is still allowed")

    def _forget_at_connector(
        self, generation: int, revision: int, acks: int, port: int, ref: str, *, removed: bool
    ) -> bool:
        """Tell the Connector to forget a chat; False when the chat is still on here afterwards. When it was not
        told and `removed` (this switch-off is what took the chat off), the chat is back on here too, since the
        Connector would still admit its pages; unless that Connector is gone and the new one never knew it, or the
        chat has changed or another forget was taken since. `revision` and `acks` are the chat's when it began."""
        with self._condition:
            number = self._forgets_sent[ref] = self._forgets_sent.get(ref, 0) + 1
            self._forgets_on_way[ref] = self._forgets_on_way.get(ref, 0) + 1
        try:
            status = self._post(port, self._admin_secrets["connector"], "/v1/admin/chat-grants/forget", {"session_ref": ref})
        except ApprovalDeliveryFailed:
            status = None
        evicted: list[tuple[str, int, int]] = []
        with self._condition:
            left = self._forgets_on_way[ref] - 1
            if left:
                self._forgets_on_way[ref] = left
            else:
                del self._forgets_on_way[ref]
            current = self._generations["connector"] == generation
            unchanged = current and self._revisions.get(ref, 0) == revision
            if status == 200 and current:
                self._forget_taken[ref] = max(self._forget_taken.get(ref, 0), number)
            if status == 200:
                # A replaced Connector's answer says nothing about the one attached now, and one from before a
                # newer allow says nothing about that allow, which the Connector may admit.
                if not unchanged:
                    return True
                # The Connector no longer admits the chat: an earlier switch-off whose forget is still on its way
                # must not put it back, and one that already did is undone.
                self._acks[ref] = self._acks.get(ref, 0) + 1
                if self._chats.covers(ref) is not None:
                    if not self._save_chats(self._without(ref)):
                        return False  # still on here and in the store, so its next request is answered
                    self._chats.forget(ref)
                return True
            if removed and unchanged and self._acks.get(ref, 0) == acks:
                evicted = self._add_chat(ref)
                # A failed save leaves it on for this start and off after a restart.
                self._save_chats()
        self._forget_evicted(evicted, generation, port)
        return False

    def _without(self, ref: str) -> list[str]:
        return [chat for chat in self._chats.refs() if chat != ref]

    def _add_chat(self, ref: str) -> list[tuple[str, int, int]]:
        """Called with the lock held: allow `ref`. Returns the chats the bound dropped, each with the revision it
        moved to and its acks, for `_forget_evicted`."""
        before = self._chats.refs()
        self._chats.add(ref, "all_for_chat")
        kept = set(self._chats.refs())
        return [(chat, self._revise(chat), self._acks.get(chat, 0)) for chat in before if chat not in kept]

    def _forget_evicted(self, evicted: list[tuple[str, int, int]], generation: int, port: int | None) -> None:
        """Outside the lock: the Connector would still admit a dropped chat's pages, so it is told to forget it.
        A forget that fails is logged; the chat stays dropped."""
        if port is None:
            return
        for ref, revision, acks in evicted:
            if not self._forget_at_connector(generation, revision, acks, port, ref, removed=False):
                logger.warning(
                    "egress approvals: a chat dropped at the bound may still be allowed by the Connector "
                    "event=chat_grant outcome=forget_failed"
                )

    def _delivered(self, ref: str) -> None:
        """Called with the lock held: a dialog all_for_chat grant for `ref` is no longer on its way."""
        left = self._in_flight[ref] - 1
        if left:
            self._in_flight[ref] = left
        else:
            del self._in_flight[ref]

    def _revise(self, ref: str) -> int:
        """Called with the lock held: the user changed the chat, or the bound dropped it."""
        self._revisions[ref] = self._revisions.get(ref, 0) + 1
        return self._revisions[ref]

    def _save_chats(self, refs: list[str] | None = None) -> bool:
        """Called with the lock held, so saves land in the order of the changes: `refs`, or the chats as they
        are. False, and logged, when it could not be saved."""
        if self._chat_store is None:
            return True
        try:
            self._chat_store.save(self._chats.refs() if refs is None else refs)
        except sqlite3.Error as exc:
            logger.error(
                "egress approvals: the chat grants were not saved event=chat_grant outcome=save_failed error={}",
                type(exc).__name__,
            )
            return False
        return True

    def _claim_for_chats(self) -> list[dict[str, Any]]:
        """Called with the lock held: the held entries this broker answers for their chat, hidden from `pending`."""
        claimed = []
        for approval_id, entry in self._held.items():
            if (
                approval_id not in self._for_chat
                and approval_id not in self._deciding
                and approval_id not in self._left_to_user
                and entry["audience"] == "connector"
                and "all_for_chat" in (entry.get("grant_scopes") or ())
                and self._chats.covers(entry["session_ref"]) is not None
                and not self._forgets_on_way.get(entry["session_ref"])
            ):
                self._for_chat.add(approval_id)
                claimed.append(entry)
        return claimed

    def _answer_for_chats(self, claimed: list[dict[str, Any]]) -> None:
        """One grant per chat: the Connector releases that chat's other held requests that offer the scope
        (`ApprovalDesk.accept_grant`), and `_decide` retires them with it, from the Connector it went to. When
        that grant fails, they are the user's."""
        by_chat: dict[str, list[dict[str, Any]]] = {}
        for entry in claimed:
            by_chat.setdefault(entry["session_ref"], []).append(entry)
        for entries in by_chat.values():
            for index, entry in enumerate(entries):
                outcome = self._answer_for_chat(entry["approval_id"])
                if outcome == "not_pending":
                    continue
                if outcome == "failed":
                    with self._condition:
                        for other in entries[index + 1 :]:
                            self._for_chat.discard(other["approval_id"])
                            self._left_to_user.add(other["approval_id"])
                        self._condition.notify_all()
                break

    def _answer_for_chat(self, approval_id: str) -> str:
        """`granted`; `not_pending` (it ended meanwhile); or `failed`, which leaves it to the user."""
        fields = {"approval_id": approval_id, "decision": "approve", "grant_scope": "all_for_chat", "via": "chat_grant"}
        outcome = "failed"
        try:
            self._record("approval.decision", **fields)
        except OSError as exc:
            logger.error("control audit not written event=approval.decision error={}", type(exc).__name__)
            return self._leave_to_user(approval_id)
        try:
            decided = self._decide(approval_id, True, "all_for_chat", for_chat=True)
        except (ApprovalNotFound, ApprovalNotPending) as exc:
            outcome = "not_pending"
            self._record_failure(fields, exc)
        except Exception as exc:  # noqa: BLE001 - the poll thread answers the next chat whatever this one raised
            self._record_failure(fields, exc)
        else:
            outcome = "granted"
            try:
                self._record(
                    "approval.decided",
                    approval_id=approval_id,
                    audience=decided.audience,
                    action=decided.action,
                    decision="approve",
                    outcome=decided.outcome,
                    grant_scope="all_for_chat",
                    via="chat_grant",
                )
            except OSError as exc:
                logger.error("control audit not written event=approval.decided error={}", type(exc).__name__)
        if outcome == "failed":
            return self._leave_to_user(approval_id)
        if outcome == "not_pending":
            with self._condition:
                self._for_chat.discard(approval_id)
                self._condition.notify_all()
        return outcome

    def _leave_to_user(self, approval_id: str) -> str:
        with self._condition:
            self._for_chat.discard(approval_id)
            self._left_to_user.add(approval_id)
            self._condition.notify_all()
        return "failed"

    def _record(self, event: str, **fields: str) -> None:
        if self._audit is not None:
            self._audit(event, **fields)

    def _record_failure(self, fields: dict[str, str], exc: BaseException) -> None:
        try:
            self._record("approval.decision_failed", **fields, error=type(exc).__name__)
        except OSError as failed:
            logger.error("control audit not written event=approval.decision_failed error={}", type(failed).__name__)

    def _sign(self, grant: dict[str, Any]) -> str:
        payload = _canonical(grant)
        signature = self._key.sign(RULES["signing_label"].encode("utf-8") + payload)
        return f"{_b64url(payload)}.{_b64url(signature)}"

    def _post(self, port: int, secret: str, path: str, body: dict[str, Any]) -> int:
        try:
            connection = HTTPConnection(_HOST, port, timeout=_REQUEST_TIMEOUT_S)
            response = None
            try:
                connection.request(
                    "POST",
                    path,
                    body=json.dumps(body).encode("utf-8"),
                    headers={"Content-Type": "application/json", RULES["admin_secret_header"]: secret},
                )
                response = connection.getresponse()
                if len(response.read(_POST_ANSWER_MAX_BYTES + 1)) > _POST_ANSWER_MAX_BYTES:
                    raise ApprovalDeliveryFailed("the Connector's answer is over the size cap")
                return response.status
            finally:
                # The response holds the socket: closing only the connection leaves it open, and the
                # Connector writing to it, until the response is collected.
                if response is not None:
                    response.close()
                connection.close()
        except (OSError, HTTPException):
            raise ApprovalDeliveryFailed("the Connector could not be reached") from None

    def _poll_loop(self, audience: str, generation: int, port: int) -> None:
        pause = _POLL_BACKOFF_S
        last_failure: str | None = None
        dropped = False
        while True:
            with self._condition:
                if generation != self._generations[audience]:
                    return
                released = self._released
            # After a dropped list, ask again at once: the Connector would wait, having answered that one.
            wait_ms = 0 if dropped else RULES["admin_max_wait_ms"]
            dropped = False
            try:
                entries = self._get_pending(audience, port, wait_ms)
            except _Unauthorized:
                failure = "unauthorized"
            except Exception as exc:  # noqa: BLE001 - this thread must outlive whatever the verifier sends
                # An answer nested past the recursion limit, a type nobody listed: the type is logged, the
                # loop goes on. A poll thread that died silently would leave the Connector unattended.
                failure = type(exc).__name__
            else:
                failure = None
            if failure is not None:
                with self._condition:
                    if generation != self._generations[audience]:
                        return
                # One line per run of the same failure, not one a second: a dead Connector or a wrong secret
                # would otherwise fill the log.
                if failure != last_failure:
                    last_failure = failure
                    logger.warning(
                        "egress approvals: {}'s approval list could not be read event=poll outcome={}",
                        _WHO[audience],
                        f"unauthorized ({_WHO[audience]} does not accept this start's admin secret)"
                        if failure == "unauthorized"
                        else f"failed exception_type={failure}",
                    )
                self._sleep(pause)
                pause = min(pause * 2, _POLL_BACKOFF_MAX_S)
                continue
            pause, last_failure = _POLL_BACKOFF_S, None
            with self._condition:
                if generation != self._generations[audience]:
                    return
                if audience != "router" and released != self._released:
                    dropped = True
                    continue
                listed = {entry["approval_id"]: entry for entry in entries}
                for approval_id in [
                    held for held, entry in self._held.items() if entry["audience"] == audience and held not in listed
                ]:
                    self._retire(approval_id)
                for approval_id, entry in listed.items():
                    if approval_id not in self._gone:
                        self._held.setdefault(approval_id, entry)
                # Claimed before anyone is woken, so `pending` never shows them.
                claimed = self._claim_for_chats()
                self._condition.notify_all()
            self._answer_for_chats(claimed)

    def _get_pending(self, audience: str, port: int, wait_ms: int) -> list[dict[str, Any]]:
        connection = HTTPConnection(_HOST, port, timeout=wait_ms / 1000 + _REQUEST_TIMEOUT_S)
        response = None
        try:
            connection.request(
                "GET",
                f"/v1/admin/approvals?wait_ms={wait_ms}",
                headers={RULES["admin_secret_header"]: self._admin_secrets[audience]},
            )
            response = connection.getresponse()
            if response.status == 401:
                raise _Unauthorized
            if response.status != 200:
                raise ValueError("the Connector refused the poll")
            raw = response.read(_POLL_ANSWER_MAX_BYTES + 1)
            if len(raw) > _POLL_ANSWER_MAX_BYTES:
                raise ValueError("the Connector's answer is over the size cap")
        finally:
            if response is not None:
                response.close()
            connection.close()
        payload = json.loads(raw)
        listed = payload.get("approvals") if isinstance(payload, dict) else None
        if not isinstance(listed, list):
            raise ValueError("the Connector's answer is not an object with a list of approvals")
        if audience == "connector":
            return self._acceptable(listed)
        return self._acceptable_for(audience, listed)

    def _acceptable(self, listed: list[Any]) -> list[dict[str, Any]]:
        """What the Connector listed that is well formed and sane (see `_acceptable_for`)."""
        return self._acceptable_for("connector", listed)

    def _acceptable_for(self, audience: str, listed: list[Any]) -> list[dict[str, Any]]:
        """The entries  that are well formed and sane, at most the contract's 64; a bad one is logged by id."""
        now = self._now()
        accepted: list[dict[str, Any]] = []
        for raw in listed:
            if len(accepted) >= RULES["admin_max_pending"]:
                break
            try:
                _PENDING_LISTS[audience].model_validate({"approvals": [raw]})
                # The contract's refinement, which the generated model cannot carry: once is always offered.
                if audience in ("connector", "egress_proxy") and "once" not in raw["grant_scopes"]:
                    raise ValueError("the entry does not offer once")
                requested, expires = raw["requested_at_ms"], raw["expires_at_ms"]
                if not (
                    0 < expires - requested <= RULES["max_lifetime_ms"]
                    and -_CLOCK_WINDOW_MS <= requested - now <= _FUTURE_SKEW_MS
                ):
                    raise ValueError("the entry's times are not plausible")
            except (ValidationError, ValueError, KeyError, TypeError):
                identifier = raw.get("approval_id") if isinstance(raw, dict) else None
                # The id when it is one, never the target or anything else the entry says.
                logger.warning(
                    "egress approvals: an entry {} listed was skipped event=poll outcome=entry_skipped "
                    "approval_id={}",
                    _WHO[audience],
                    identifier if isinstance(identifier, str) and _ID.fullmatch(identifier) else "(unusable)",
                )
                continue
            accepted.append(raw)
        return accepted


def _pending_approval(entry: dict[str, Any]) -> PendingApproval:
    return PendingApproval(
        approval_id=entry["approval_id"],
        audience=entry["audience"],
        action=entry["action"],
        caller=entry["caller"],
        target=entry["target"],
        requested_at=datetime.fromtimestamp(entry["requested_at_ms"] / 1000, UTC),
        expires_at=datetime.fromtimestamp(entry["expires_at_ms"] / 1000, UTC),
        grant_scopes=tuple(entry["grant_scopes"]) if entry.get("grant_scopes") else None,
        session_ref=entry.get("session_ref"),
    )
