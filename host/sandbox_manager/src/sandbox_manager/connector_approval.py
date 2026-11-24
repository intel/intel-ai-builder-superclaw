"""The Connector's side of egress approvals (EG1-7, design 6.2 and 6.3).

A `fetch_result` for a URL outside the session's list is held here until the Sandbox Manager decides it.
The Sandbox Manager long-polls `GET /v1/admin/approvals`, an operator decides, and it delivers either a
signed grant (`POST /v1/admin/grants`) or an unsigned denial (`POST /v1/admin/decisions`). Only a grant that
passes every check in `grant_checks` releases a request; a denial removes authority and needs only the
admin secret. The admin routes share the Connector's loopback listener (a recorded deviation from design
6.2, which says another port): what keeps them to the Sandbox Manager is the admin secret in the sealed
provider config, and what makes a grant unforgeable is the Ed25519 signature, not the secret.

A request that names its chat's root session is offered `all_for_chat` as well as `once` (#3562). A grant for
the chat releases that request and the chat's other held requests that were offered it, and `chat_grants`
remembers the chat, so the Connector admits the chat's later reads without asking, until the Sandbox Manager
says to forget it (`POST /v1/admin/chat-grants/forget`, unsigned like a denial: it only removes authority).
A forget also re-holds the chat's waiting requests that were offered `all_for_chat` under new approval ids,
so no grant issued for them before the forget, wherever it is or whatever the clocks say, can restore the
chat: a grant naming a retired id is `grant_superseded`, and the user decides again on the new one.

`cryptography` (Ed25519) is the only dependency outside the standard library; the generated contract
modules are not imported, so the Connector ships without Pydantic. `tests/unit/test_connector_approval_contract.py`
holds `grant_is_well_formed` to the generated model.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import secrets
import threading
import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from urllib.parse import parse_qs, urlsplit

from contracts.connector_ipc_data import CONNECTOR_IPC_RULES
from contracts.egress_approval_grant_data import EGRESS_APPROVAL_GRANT_DATA

from .egress_chat_grants import ChatGrants

RULES = EGRESS_APPROVAL_GRANT_DATA["rules"]
ADMIN_ERRORS = EGRESS_APPROVAL_GRANT_DATA["admin_errors"]
ACTION = "connector.fetch_result"
SCOPES = ("once", "all_for_chat")
# "Attached" means the Sandbox Manager long-polled within two long-poll periods.
ATTACH_WINDOW_MS = 2 * RULES["admin_max_wait_ms"]
_POLL_S = 0.05
# An agent can ask about many URLs; each is a prompt in front of the user. The desk holds a few, and a session
# fewer, and answers `approval_required` (not retryable) when it is full, so a flood of asks neither buries the
# user nor crowds out the Connector's other operations.
MAX_HELD = 8
MAX_HELD_PER_SESSION = 2
MAX_REMEMBERED_APPROVAL_IDS = 256
# Approval ids a forget retired: a grant naming one is superseded. Past this many, an id is simply unknown.
MAX_SUPERSEDED_REMEMBERED = 1024
# A list handed to the approver is handed again to a poll that comes back after longer than a poll takes: the
# response may have been lost (a timeout, a restart of the approver's poll), and a list it never saw must not
# be waited on. A poll that follows the last one straight away is the normal case and waits.
RESEND_GAP_MS = 500
# What the user said no to is not asked again at once; a prompt for a request with hardly any time left would
# flash and vanish, so it is not shown.
DENIED_MEMORY_MS = 60_000
MIN_PROMPT_MS = 5_000
_MAX_DENIED_REMEMBERED = 64
# An unauthenticated request leaves one log line this often, not one each.
REJECTION_LOG_INTERVAL_MS = 60_000
_MAX_SAFE_INT = 2**53 - 1
_CORRELATION_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_BASE64URL_32 = re.compile(r"^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$")
_DIGEST = re.compile(r"^[0-9a-f]{64}$")
_SESSION_REF = re.compile(r"^sref_[0-9a-f]{16}$")
_TOKEN = re.compile(r"^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{%d}$" % RULES["signature_chars"])
_GRANT_FIELDS = frozenset(
    {
        "contract_version", "grant_id", "approval_id", "audience", "boot_id", "action",
        "request_digest", "scope", "issued_at_ms", "expires_at_ms",
    }
)
_ADMIN_PREFIX = "/v1/admin/"
# The most the listener reads of an admin request body, whatever it declares: enough to drain a refusal.
MAX_BODY_READ = 16 * RULES["admin_max_request_bytes"]


class GrantRejected(Exception):
    """A grant that failed a check; `reason` is for the Connector's own log, never for the caller."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class ApprovalNotPending(Exception):
    """No request is being held under that approval id: decided, expired, cancelled or never asked."""


class GrantSuperseded(Exception):
    """A grant naming an approval id a forget retired: the request is held again under a new id."""


@dataclass(frozen=True)
class ApprovalConfig:
    """The approval part of the sealed `connector-provider.json`, written by the Sandbox Manager at each start."""

    public_key: str
    boot_id: str
    admin_secret: str


def approval_config_from(value: object) -> ApprovalConfig | None:
    """The `approval` section of the provider config; None when there is none, ValueError when it is wrong."""
    if value is None:
        return None
    if not isinstance(value, dict) or set(value) != {"approval_public_key", "boot_id", "admin_secret"}:
        raise ValueError("Connector provider approval configuration fields are invalid")
    key, boot_id, secret = value["approval_public_key"], value["boot_id"], value["admin_secret"]
    if not (isinstance(key, str) and _BASE64URL_32.fullmatch(key)):
        raise ValueError("Connector provider approval public key is invalid")
    if not (isinstance(boot_id, str) and _CORRELATION_ID.fullmatch(boot_id)):
        raise ValueError("Connector provider approval boot id is invalid")
    if not (isinstance(secret, str) and _BASE64URL_32.fullmatch(secret)):
        raise ValueError("Connector provider approval admin secret is invalid")
    return ApprovalConfig(public_key=key, boot_id=boot_id, admin_secret=secret)


def request_digest(normalized_url: str) -> str:
    """The digest of a `connector.fetch_result` request: sha256 of the normalized URL, lowercase hex."""
    return hashlib.sha256(normalized_url.encode("utf-8")).hexdigest()


def _is_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def grant_is_well_formed(candidate: object) -> bool:
    """The grant's structure and the lifetime bound, as the contract says them (strict, nothing extra)."""
    return grant_shape_is_valid(candidate, "connector", ACTION, SCOPES)


def grant_shape_is_valid(candidate: object, audience: str, action: str, scopes: tuple[str, ...]) -> bool:
    """`grant_is_well_formed` for one audience: its name, its one action and the scopes it may carry."""
    if not isinstance(candidate, dict) or set(candidate) != _GRANT_FIELDS:
        return False
    if not _is_int(candidate["contract_version"]) or candidate["contract_version"] != 1:
        return False
    for name in ("grant_id", "approval_id", "boot_id"):
        value = candidate[name]
        if not (isinstance(value, str) and _CORRELATION_ID.fullmatch(value)):
            return False
    if candidate["audience"] != audience or candidate["action"] != action:
        return False
    digest = candidate["request_digest"]
    if not (isinstance(digest, str) and _DIGEST.fullmatch(digest)):
        return False
    scope = candidate["scope"]
    if not (isinstance(scope, dict) and set(scope) == {"kind"} and scope["kind"] in scopes):
        return False
    issued, expires = candidate["issued_at_ms"], candidate["expires_at_ms"]
    if not (_is_int(issued) and _is_int(expires)):
        return False
    if not (0 < issued <= _MAX_SAFE_INT and 0 < expires <= _MAX_SAFE_INT):
        return False
    return 0 < expires - issued <= RULES["max_lifetime_ms"]


def _canonical(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _ed25519():
    """`cryptography`'s Ed25519 pieces, imported when first needed: a Connector with no approval section
    must start even from a payload that lacks the package."""
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

    return InvalidSignature, Ed25519PublicKey


def _b64url_decode(text: str) -> bytes:
    """Strict: what is not exactly what an encoder emits (stray trailing bits) is refused."""
    try:
        data = base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))
    except ValueError:
        raise GrantRejected("malformed_token") from None
    if base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii") != text:
        raise GrantRejected("malformed_token")
    return data


def decode_grant_token(
    token: str, public_key: str, well_formed: Callable[[object], bool] = grant_is_well_formed
) -> dict:
    """The grant in `token`, after the structural checks: signature, schema, canonical form.

    The signature is checked over the payload bytes as received, before they are parsed, and a grant that
    parses but is not in canonical form is refused, so one grant has exactly one valid encoding.
    `well_formed` is the audience's schema check; it defaults to the Connector's.
    """
    if not isinstance(token, str) or len(token) > RULES["max_token_chars"] or not _TOKEN.fullmatch(token):
        raise GrantRejected("malformed_token")
    payload_part, signature_part = token.split(".")
    payload, signature = _b64url_decode(payload_part), _b64url_decode(signature_part)
    invalid_signature, ed25519_public_key = _ed25519()
    try:
        key = ed25519_public_key.from_public_bytes(_b64url_decode(public_key))
        key.verify(signature, RULES["signing_label"].encode("utf-8") + payload)
    except (invalid_signature, ValueError):
        raise GrantRejected("bad_signature") from None
    try:
        text = payload.decode("utf-8")
        parsed = json.loads(text)
    except ValueError:
        raise GrantRejected("invalid_grant") from None
    if not well_formed(parsed):
        raise GrantRejected("invalid_grant")
    if _canonical(parsed) != text:
        raise GrantRejected("not_canonical")
    return parsed


class _Held:
    """One request waiting for a decision. `session_id` is the session that asked, which the per-session cap
    counts by; `session_ref` is its chat, which a grant is for; `scope` is what the grant carried."""

    def __init__(
        self,
        approval_id: str,
        session_id: str,
        session_ref: str,
        target: str,
        digest: str,
        requested_ms: int,
        expires_ms: int,
        *,
        scopes: tuple[str, ...],
    ) -> None:
        self.approval_id = approval_id
        # The id `request` returned, which its waiter looks it up by: a forget changes `approval_id`.
        self.asked_id = approval_id
        self.session_id = session_id
        self.session_ref = session_ref
        self.target = target
        self.digest = digest
        self.requested_ms = requested_ms
        self.expires_ms = expires_ms
        self.scopes = scopes
        self.outcome: str | None = None
        self.scope: str | None = None

    def entry(self) -> dict:
        return {
            "approval_id": self.approval_id,
            "audience": "connector",
            "action": ACTION,
            "caller": "agent",
            "target": self.target,
            "request_digest": self.digest,
            "requested_at_ms": self.requested_ms,
            "expires_at_ms": self.expires_ms,
            "grant_scopes": list(self.scopes),
            "session_ref": self.session_ref,
        }


class ApprovalDesk:
    """The requests being held, who may release them, and whether anyone is there to ask."""

    def __init__(
        self,
        config: ApprovalConfig,
        *,
        now_ms: Callable[[], int] | None = None,
        hold_ms: int = CONNECTOR_IPC_RULES["approval_hold_ms"],
        attach_window_ms: int = ATTACH_WINDOW_MS,
    ) -> None:
        _ed25519()  # fail at start, not at the first grant, if approvals are configured but the package is not
        self.config = config
        self.attach_window_ms = attach_window_ms
        self._now = now_ms or (lambda: int(time.time() * 1000))
        self._hold_ms = hold_ms
        self._condition = threading.Condition()
        self._held: dict[str, _Held] = {}
        self._used: dict[str, int] = {}
        self._last_poll_ms: int | None = None
        # The ids the approver was last given: a poll returns early only when the list is not that one.
        self._last_returned: tuple[str, ...] | None = ()
        self._last_returned_ms: int | None = None
        self._denied_until: dict[str, int] = {}
        self._rejection_logged_ms: int | None = None
        self._superseded: OrderedDict[str, None] = OrderedDict()
        # A request held again under a new id, by the id its waiter knows, until the waiter is done. Only the
        # waiter looks here: a grant or a denial naming that id finds nothing held under it.
        self._aliases: dict[str, _Held] = {}
        self.chat_grants = ChatGrants()

    def request(
        self,
        target: str,
        digest: str,
        deadline_ms: int,
        session_id: str,
        session_ref: str,
        scopes: tuple[str, ...] = ("once",),
        *,
        interactive: bool = True,
    ) -> tuple[str, str]:
        """Hold a request for approval: its id, and what became of it.

        `held`, which is listed for the approver; `covered`, not held because its chat was already allowed
        every page and the request goes on; or not held: `no_approver` (the request declared that
        nobody can be asked), `denied_recently` (the user said no to this URL
        a minute ago), `too_late` (hardly any of the request's own deadline is left), `unattended` (nobody is
        polling) or `full`. The hold is the shorter of `approval_hold_ms` and what is left of the deadline.
        The per-session cap counts by `session_id`, the session that asked, so parallel sub-agents of one chat
        each have their own; `session_ref` is the chat a grant for the request is for; `scopes` are what that
        grant may carry.
        """
        approval_id = "approval-" + secrets.token_urlsafe(12)
        if not interactive:
            return approval_id, "no_approver"
        with self._condition:
            # Under the lock `accept_grant` records a chat grant with, so a grant that lands just before this
            # hold is seen. First, because the other checks are about asking, and nobody is asked here.
            if "all_for_chat" in scopes and self.chat_grants.covers(session_ref) is not None:
                return approval_id, "covered"
            now = self._now()
            self._denied_until = {url: until for url, until in self._denied_until.items() if until > now}
            if target in self._denied_until:
                return approval_id, "denied_recently"
            if deadline_ms - now < MIN_PROMPT_MS:
                return approval_id, "too_late"
            attached = self._last_poll_ms is not None and now - self._last_poll_ms <= self.attach_window_ms
            if not attached:
                return approval_id, "unattended"
            waiting = [held for held in self._held.values() if held.outcome is None]
            if (
                len(waiting) >= MAX_HELD
                or sum(held.session_id == session_id for held in waiting) >= MAX_HELD_PER_SESSION
            ):
                return approval_id, "full"
            self._held[approval_id] = _Held(
                approval_id,
                session_id,
                session_ref,
                target,
                digest,
                now,
                min(now + self._hold_ms, deadline_ms),
                scopes=scopes,
            )
            self._condition.notify_all()
        return approval_id, "held"

    def wait(self, approval_id: str, cancel: threading.Event) -> str:
        """Block until the request is decided, expires or is cancelled: granted, denied, expired or cancelled."""
        return self.wait_decided(approval_id, cancel)[0]

    def wait_decided(self, approval_id: str, cancel: threading.Event) -> tuple[str, str | None, str]:
        """`wait`, the scope a grant carried, and the id the request was decided under: a forget may have held
        it again under a new one."""
        with self._condition:
            held = self._held.get(approval_id) or self._aliases[approval_id]
            try:
                while held.outcome is None:
                    if cancel.is_set():
                        held.outcome = "cancelled"
                    elif self._now() >= held.expires_ms:
                        held.outcome = "expired"
                    else:
                        self._condition.wait(timeout=_POLL_S)
            finally:
                if self._held.get(held.approval_id) is held:
                    del self._held[held.approval_id]
                if self._aliases.get(held.asked_id) is held:
                    del self._aliases[held.asked_id]
                self._condition.notify_all()
            return held.outcome, held.scope if held.outcome == "granted" else None, held.approval_id

    def forget_chat(self, ref: str) -> None:
        """The Sandbox Manager switched the chat off: forget it, and hold its undecided requests that were offered
        `all_for_chat` again under new ids, retiring the old ones, so that no grant issued before now names one.
        A request whose time has run out is held again too, with its own times: the clock may go back before its
        waiter sees it expire. Under the lock `accept_grant` checks and records a grant with."""
        with self._condition:
            self.chat_grants.forget(ref)
            for old_id, held in list(self._held.items()):
                if held.outcome is None and held.session_ref == ref and "all_for_chat" in held.scopes:
                    held.approval_id = "approval-" + secrets.token_urlsafe(12)
                    del self._held[old_id]
                    self._held[held.approval_id] = held
                    self._aliases[held.asked_id] = held
                    self._superseded[old_id] = None
                    while len(self._superseded) > MAX_SUPERSEDED_REMEMBERED:
                        self._superseded.popitem(last=False)
            self._condition.notify_all()

    def pending(self, wait_ms: int) -> list[dict]:
        """What is held, oldest first. Counts as a poll.

        Returns at once when the list is not the one the approver was last given, or when `wait_ms` is spent;
        otherwise it waits for a request to be held, decided or to expire. An approver that long-polls with
        nothing changed therefore sleeps in here instead of spinning: it does not get the same list back
        immediately, every time, for as long as a request is held.
        """
        limit = min(max(wait_ms, 0), RULES["admin_max_wait_ms"]) / 1000
        end = time.monotonic() + limit
        with self._condition:
            self._last_poll_ms = self._now()
            self._condition.notify_all()
            if self._last_returned_ms is not None and self._last_poll_ms - self._last_returned_ms > RESEND_GAP_MS:
                self._last_returned = None  # nothing equals None: the list goes out again
            while True:
                now = self._now()
                waiting = sorted(
                    (held for held in self._held.values() if held.outcome is None and now < held.expires_ms),
                    key=lambda held: (held.requested_ms, held.approval_id),
                )
                ids = tuple(held.approval_id for held in waiting)
                remaining = end - time.monotonic()
                if ids != self._last_returned or remaining <= 0:
                    break
                self._condition.wait(timeout=min(_POLL_S, remaining))
            self._last_returned = ids
            self._last_poll_ms = self._last_returned_ms = self._now()
            return [held.entry() for held in waiting[: RULES["admin_max_pending"]]]

    def should_log_rejection(self) -> bool:
        """Whether an unauthenticated admin request gets a log line: the first, then one a minute."""
        with self._condition:
            now = self._now()
            if self._rejection_logged_ms is not None and now - self._rejection_logged_ms < REJECTION_LOG_INTERVAL_MS:
                return False
            self._rejection_logged_ms = now
            return True

    def accept_grant(self, token: str) -> None:
        """Release the request a valid grant names, checking in the order the contract publishes.

        After the structural checks of `decode_grant_token` (token form, signature, schema, canonical form,
        audience): `boot_id`, `time_window`, then `approval_id` as the lookup key (ApprovalNotPending when
        nothing is held under it, GrantSuperseded when a forget retired it), then the digest against that
        request's, then `scope` against the scopes it was offered, then `once_unused`, last because it consumes
        the grant. GrantRejected carries the name of the first check that failed.

        `all_for_chat` also records the chat and releases its other held requests that were offered it, so
        the user is not asked again for requests held alongside this one.
        """
        grant = decode_grant_token(token, self.config.public_key)
        with self._condition:
            now = self._now()
            if grant["boot_id"] != self.config.boot_id:
                raise GrantRejected("boot_id")
            if not grant["issued_at_ms"] <= now < grant["expires_at_ms"]:
                raise GrantRejected("time_window")
            held = self._held.get(grant["approval_id"])
            if held is None and grant["approval_id"] in self._superseded:
                raise GrantSuperseded
            if held is None or held.outcome is not None or now >= held.expires_ms:
                raise ApprovalNotPending
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
                self.chat_grants.add(held.session_ref, held.scope)
                for other in self._held.values():
                    if (
                        other.outcome is None
                        and other.session_ref == held.session_ref
                        and "all_for_chat" in other.scopes
                        and now < other.expires_ms
                    ):
                        other.scope = "all_for_chat"
                        other.outcome = "granted"
            self._condition.notify_all()

    def deny(self, approval_id: str) -> None:
        with self._condition:
            held = self._held.get(approval_id)
            if held is None or held.outcome is not None:
                raise ApprovalNotPending
            held.outcome = "denied"
            if len(self._denied_until) < _MAX_DENIED_REMEMBERED:
                self._denied_until[held.target] = self._now() + DENIED_MEMORY_MS
            self._condition.notify_all()


def _error(code: str) -> tuple[int, dict]:
    return ADMIN_ERRORS[code]["status"], {"error": {"code": code, "message": ADMIN_ERRORS[code]["message"]}}


def is_admin_path(target: str) -> bool:
    return target.startswith(_ADMIN_PREFIX)


def handle_admin(
    desk: ApprovalDesk,
    *,
    method: str,
    target: str,
    secret: str | None,
    content_length: int | None,
    body: bytes,
    log: Callable[..., None],
) -> tuple[int, dict]:
    """Answer one admin request. The secret is judged first, in constant time, before the body is looked at.

    `body` is what the listener read of the request (at most `MAX_BODY_READ` bytes, drained so that an early
    refusal does not reset the connection under a client that is still sending).
    """
    if secret is None or not hmac.compare_digest(secret.encode("utf-8", "replace"), desk.config.admin_secret.encode()):
        if desk.should_log_rejection():
            log("admin_rejected", reason="authentication")
        return _error("admin_authentication_failed")
    parts = urlsplit(target)
    if method == "GET" and parts.path == _ADMIN_PREFIX + "approvals":
        query = parse_qs(parts.query, keep_blank_values=True)
        wait = query.get("wait_ms", ["0"])
        if set(query) - {"wait_ms"} or len(wait) != 1 or not re.fullmatch(r"[0-9]{1,9}", wait[0]):
            return _error("invalid_request")
        return 200, {"approvals": desk.pending(int(wait[0]))}
    if method == "POST" and parts.path == _ADMIN_PREFIX + "chat-grants/forget":
        parsed = _json_object(content_length, body)
        ref = parsed.get("session_ref") if parsed is not None else None
        if parsed is None or set(parsed) != {"session_ref"} or not (isinstance(ref, str) and _SESSION_REF.fullmatch(ref)):
            return _error("invalid_request")
        desk.forget_chat(ref)
        return 200, {"accepted": True}
    if method == "POST" and parts.path in (_ADMIN_PREFIX + "grants", _ADMIN_PREFIX + "decisions"):
        parsed = _json_object(content_length, body)
        if parsed is None:
            return _error("invalid_request")
        if parts.path.endswith("/grants"):
            if set(parsed) != {"grant"} or not isinstance(parsed["grant"], str):
                return _error("invalid_request")
            try:
                desk.accept_grant(parsed["grant"])
            except GrantRejected as rejected:
                log("grant_rejected", reason=rejected.reason)
                return _error("grant_rejected")
            except ApprovalNotPending:
                return _error("approval_not_pending")
            except GrantSuperseded:
                log("grant_superseded")
                return _error("grant_superseded")
            return 200, {"accepted": True}
        approval_id = parsed.get("approval_id")
        if (
            set(parsed) != {"approval_id", "decision"}
            or parsed["decision"] != "denied"
            or not (isinstance(approval_id, str) and _CORRELATION_ID.fullmatch(approval_id))
        ):
            return _error("invalid_request")
        try:
            desk.deny(approval_id)
        except ApprovalNotPending:
            return _error("approval_not_pending")
        return 200, {"accepted": True}
    return 404, {"error": {"code": "invalid_request", "message": ADMIN_ERRORS["invalid_request"]["message"]}}


def _json_object(content_length: int | None, body: bytes) -> dict | None:
    """The request body as a JSON object, or None. A body over the contract's cap is refused unread."""
    if content_length is None or not 0 <= content_length <= RULES["admin_max_request_bytes"]:
        return None
    try:
        value = json.loads(body[:content_length])
    except ValueError:
        return None
    return value if isinstance(value, dict) else None
