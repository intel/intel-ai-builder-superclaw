"""The provision pipe's on-the-wire shapes, as the unprivileged owner side speaks them.

This is the Python half of the broker's ``provision_session::wire`` module.
The two implementations have to agree byte for byte on what the HMAC covers, so both pin the same
fixed vector: ``tests/unit/test_broker_client_provision_wire.py`` here, and
``src/provision_session/wire/tests.rs`` there.
Neither implementation is the definition of "canonical"; those bytes are.

# Why the canonical form is spelled out rather than left to the serializer

``json.dumps`` defaults would produce spaces after separators, would escape every non-ASCII character
and would emit members in insertion order.
The broker canonicalizes with sorted keys, no spaces and UTF-8, so a request built here and a request
parsed there authenticate the same bytes only if this module states all three explicitly.
``ensure_ascii=False`` is the one that is easy to lose: a workspace path with a non-ASCII component
would still round-trip as JSON, and the MAC would silently stop matching.

# What the HMAC is and is not

It is frame integrity plus session binding: every frame is tied to one attempt's random key, one owner
SID, and one nonce that is never accepted twice.
It is not the identity boundary.
What binds the peers is this process creating the pipe as its first instance, accepting only the
process id of the elevated broker it launched, and the elevated broker accepting only a pipe whose
server process runs as the owner SID it was asked to provision for.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import secrets
from collections.abc import Mapping
from typing import Any

PROVISION_CONTRACT_VERSION = 1

#: Bytes of little-endian length prefix in front of every frame body (broker ``frame.rs``).
FRAME_PREFIX_BYTES = 4

AUTH_KEY_BYTES = 32
NONCE_BYTES = 16
NONCE_MIN_LEN = 16
NONCE_MAX_LEN = 128

MAX_PATH_SET_BYTES = 64 * 1024
MAX_ACL_PLAN_BYTES = 256 * 1024
MAX_WFP_PLAN_BYTES = 256 * 1024
_ENVELOPE_OVERHEAD_BUDGET = 32 * 1024
MAX_PROVISION_FRAME_BYTES = (
    MAX_PATH_SET_BYTES + MAX_ACL_PLAN_BYTES + _ENVELOPE_OVERHEAD_BUDGET
)
MAX_FRAMES_PER_CONNECTION = 4

TO_BROKER = "to_broker"
TO_OWNER = "to_owner"

_ENVELOPE_MEMBERS = frozenset({"version", "owner_sid", "nonce", "frame", "mac"})
_FRAME_MEMBERS: dict[str, frozenset[str]] = {
    "provision": frozenset({"op", "path_set", "acl_plan"}),
    "applied": frozenset({"op", "path_set_digest", "acl_plan_digest", "observation"}),
    "refused": frozenset({"op", "reason"}),
    "wfp_plan": frozenset({"op", "wfp_plan"}),
    "wfp_installed": frozenset({"op", "wfp_plan_digest"}),
    "wfp_refused": frozenset({"op", "reason"}),
}
_FRAME_DIRECTIONS = {
    "provision": TO_BROKER,
    "applied": TO_OWNER,
    "refused": TO_OWNER,
    "wfp_plan": TO_BROKER,
    "wfp_installed": TO_OWNER,
    "wfp_refused": TO_OWNER,
}

#: The closed refusal vocabulary, mirroring ``ProvisionRefusal``; both are pinned to
#: ``BrokerProvisionRefusalReasonSchema`` in ``shared/contracts``. A reason outside this set is a frame
#: this side does not understand, not a refusal it can report.
REFUSAL_REASONS = frozenset(
    {
        "owner_binding_invalid",
        "path_set_shape_invalid",
        "plan_shape_invalid",
        "coverage_bound_exceeded",
        "reparse_point_in_path",
        "managed_path_refused",
        "descriptor_not_the_shipped_policy",
        "managed_root_not_authorized",
        "provision_precondition_missing",
        "win32_permission_denied",
        # Only ``--provision-identities-and-session`` answers it: the identity step failed, and nothing
        # was recorded or applied.
        "tier_identity_provision_failed",
    }
)


#: Why the elevated side did not install the WFP plan, mirroring `WfpInstallRefusal`. A WFP refusal never
#: fails a provision: the ACL receipt has already been answered.
WFP_REFUSAL_REASONS = frozenset(
    {
        "wfp_plan_shape_invalid",
        "wfp_plan_owner_mismatch",
        "wfp_objects_not_installable",
        "wfp_apply_refused",
        "wfp_engine_unavailable",
    }
)


class ProvisionWireError(Exception):
    """A provision frame was refused. ``code`` mirrors the broker's own refusal codes."""

    def __init__(self, code: str, detail: str = "") -> None:
        self.code = code
        self.detail = detail
        super().__init__(f"{code}: {detail}" if detail else code)


def canonical_json(value: Any) -> bytes:
    """The exact bytes both implementations sign and digest.

    The encode is guarded because this runs on frames a peer sent. ``json.loads`` accepts ``\\udcff`` and
    hands back a lone surrogate, which ``ensure_ascii=False`` then cannot encode - and a ``UnicodeEncodeError``
    escaping from here would leave the pipe as an unhandled exception instead of a refusal.
    """
    try:
        text = json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        )
        return text.encode("utf-8")
    except (TypeError, ValueError, UnicodeError) as exc:
        raise ProvisionWireError(
            "invalid_json", f"a payload has no canonical form: {exc}"
        ) from exc


def normalized_digest(value: Any) -> str:
    """The digest a receipt reports for one payload: sha256 over its canonical bytes, hex."""
    return hashlib.sha256(canonical_json(value)).hexdigest()


def new_auth_key() -> bytes:
    return secrets.token_bytes(AUTH_KEY_BYTES)


def new_nonce() -> str:
    return secrets.token_hex(NONCE_BYTES)


def new_pipe_id() -> str:
    """A random pipe id inside the character set the broker's ``provision_pipe_name`` accepts."""
    return secrets.token_hex(NONCE_BYTES)


def provision_frame(
    path_set: Mapping[str, object], acl_plan: Mapping[str, object]
) -> dict[str, object]:
    return {"op": "provision", "path_set": dict(path_set), "acl_plan": dict(acl_plan)}


def wfp_plan_frame(wfp_plan: Mapping[str, object]) -> dict[str, object]:
    return {"op": "wfp_plan", "wfp_plan": dict(wfp_plan)}


def frame_prefix(body: bytes) -> bytes:
    return len(body).to_bytes(FRAME_PREFIX_BYTES, "little")


def declared_frame_len(prefix: bytes, max_frame_bytes: int) -> int:
    """The body length a prefix declares, refusing an empty or oversize frame before any read."""
    length = int.from_bytes(prefix, "little")
    if length == 0:
        raise ProvisionWireError("invalid_field", "a frame declared a zero-length body")
    if length > max_frame_bytes:
        raise ProvisionWireError(
            "request_oversized", f"a frame declared {length} bytes"
        )
    return length


class ProvisionSession:
    """One side's view of a provision connection: the shared key, the owner, the nonces seen."""

    def __init__(self, key: bytes, owner_sid: str) -> None:
        if len(key) != AUTH_KEY_BYTES:
            raise ValueError("a provision auth key is exactly 32 bytes")
        self._key = key
        self._owner_sid = owner_sid
        self._seen_nonces: set[str] = set()
        self._frames_seen = 0

    def seal(self, frame: Mapping[str, object], nonce: str | None = None) -> bytes:
        """Wraps ``frame`` in a signed envelope and returns the envelope's body bytes."""
        chosen = new_nonce() if nonce is None else nonce
        _check_frame_shape(frame)
        _check_payload_sizes(frame)
        _check_nonce(chosen)
        envelope = {
            "version": PROVISION_CONTRACT_VERSION,
            "owner_sid": self._owner_sid,
            "nonce": chosen,
            "frame": dict(frame),
        }
        envelope["mac"] = hmac.new(
            self._key, _authenticated_bytes(envelope), hashlib.sha256
        ).hexdigest()
        body = canonical_json(envelope)
        if len(body) > MAX_PROVISION_FRAME_BYTES:
            raise ProvisionWireError("request_oversized", "the sealed envelope is too large")
        return body

    def open(self, body: bytes, expected_from: str) -> dict[str, object]:
        """Authenticates one frame body and returns the frame.

        The order is the broker's order, and it is load-bearing: everything a frame's own bytes can
        decide is decided before the replay set is touched, so a peer cannot fill that set with nonces
        from frames that were never valid.
        """
        self._frames_seen += 1
        if self._frames_seen > MAX_FRAMES_PER_CONNECTION:
            raise ProvisionWireError(
                "frame_limit_exceeded", "more frames than the conversation needs"
            )
        if len(body) > MAX_PROVISION_FRAME_BYTES:
            raise ProvisionWireError("request_oversized", f"{len(body)} bytes")
        try:
            envelope = json.loads(body.decode("utf-8"))
        except (UnicodeError, json.JSONDecodeError) as exc:
            raise ProvisionWireError("invalid_json", str(exc)) from exc
        if not isinstance(envelope, dict) or set(envelope) != _ENVELOPE_MEMBERS:
            raise ProvisionWireError("invalid_json", "the envelope has unexpected members")
        frame = envelope["frame"]
        _check_frame_shape(frame)
        # `isinstance(True, int)` is true and `True == 1`, so a version of JSON `true` would otherwise be
        # read as version 1. The broker's parser is typed and would never accept it.
        version = envelope["version"]
        if isinstance(version, bool) or version != PROVISION_CONTRACT_VERSION:
            raise ProvisionWireError("unsupported_version", f"version {version!r}")
        nonce = envelope["nonce"]
        _check_nonce(nonce)
        if envelope["owner_sid"] != self._owner_sid:
            raise ProvisionWireError("owner_mismatch", "the frame names another owner")
        _verify_mac(self._key, envelope)
        if _FRAME_DIRECTIONS[frame["op"]] != expected_from:
            raise ProvisionWireError(
                "frame_wrong_direction", f"a {frame['op']} frame arrived from the wrong peer"
            )
        _check_payload_sizes(frame)
        if nonce in self._seen_nonces:
            raise ProvisionWireError("nonce_replayed", "this nonce already arrived")
        self._seen_nonces.add(nonce)
        return frame


def _authenticated_bytes(envelope: Mapping[str, object]) -> bytes:
    """The exact bytes the MAC covers: the envelope minus its own ``mac``, canonicalized."""
    return canonical_json(
        {
            "version": envelope["version"],
            "owner_sid": envelope["owner_sid"],
            "nonce": envelope["nonce"],
            "frame": envelope["frame"],
        }
    )


def _verify_mac(key: bytes, envelope: Mapping[str, object]) -> None:
    supplied = envelope["mac"]
    if not isinstance(supplied, str):
        raise ProvisionWireError("invalid_hmac", "the mac is not a string")
    try:
        supplied_bytes = bytes.fromhex(supplied)
    except ValueError as exc:
        raise ProvisionWireError("invalid_hmac", "the mac is not hex") from exc
    expected = hmac.new(key, _authenticated_bytes(envelope), hashlib.sha256).digest()
    if not hmac.compare_digest(expected, supplied_bytes):
        raise ProvisionWireError("invalid_hmac", "the mac does not cover these bytes")


def _check_nonce(nonce: object) -> None:
    # Byte length, not `len(nonce)`: the Rust peer's `frame::validate_nonce` bounds `str::len`, which
    # counts UTF-8 bytes. A codepoint count agrees with that for the hex nonces either side actually
    # generates, but would disagree with it for a multi-byte string near the boundary.
    if not isinstance(nonce, str):
        raise ProvisionWireError("invalid_field", "the nonce is outside the allowed length")
    try:
        nonce_len = len(nonce.encode("utf-8"))
    except UnicodeEncodeError as exc:
        raise ProvisionWireError("invalid_json", "the nonce is not valid UTF-8") from exc
    if not NONCE_MIN_LEN <= nonce_len <= NONCE_MAX_LEN:
        raise ProvisionWireError("invalid_field", "the nonce is outside the allowed length")


def _check_frame_shape(frame: object) -> None:
    if not isinstance(frame, dict):
        raise ProvisionWireError("invalid_json", "the frame is not an object")
    operation = frame.get("op")
    if not isinstance(operation, str) or operation not in _FRAME_MEMBERS:
        raise ProvisionWireError("invalid_json", f"unknown frame op {operation!r}")
    if set(frame) != _FRAME_MEMBERS[operation]:
        raise ProvisionWireError(
            "invalid_json", f"a {operation} frame has unexpected members"
        )
    if operation == "provision":
        for member in ("path_set", "acl_plan"):
            if not isinstance(frame[member], dict):
                raise ProvisionWireError("invalid_json", f"{member} is not an object")
    if operation == "applied":
        for member in ("path_set_digest", "acl_plan_digest"):
            if not _is_sha256_hex(frame[member]):
                raise ProvisionWireError("invalid_json", f"{member} is not a digest")
        if not isinstance(frame["observation"], dict):
            raise ProvisionWireError("invalid_json", "observation is not an object")
    if operation == "refused":
        # The type test comes first: a JSON reason of ``[]`` or ``{}`` is unhashable, and asking a
        # frozenset whether it contains one raises ``TypeError`` rather than refusing the frame.
        reason = frame["reason"]
        if not isinstance(reason, str) or reason not in REFUSAL_REASONS:
            raise ProvisionWireError(
                "invalid_json", f"unknown refusal reason {reason!r}"
            )
    if operation == "wfp_plan" and not isinstance(frame["wfp_plan"], dict):
        raise ProvisionWireError("invalid_json", "wfp_plan is not an object")
    if operation == "wfp_installed" and not _is_sha256_hex(frame["wfp_plan_digest"]):
        raise ProvisionWireError("invalid_json", "wfp_plan_digest is not a digest")
    if operation == "wfp_refused":
        reason = frame["reason"]
        if not isinstance(reason, str) or reason not in WFP_REFUSAL_REASONS:
            raise ProvisionWireError(
                "invalid_json", f"unknown wfp refusal reason {reason!r}"
            )


def _is_sha256_hex(value: object) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(character in "0123456789abcdef" for character in value)
    )


def _check_payload_sizes(frame: Mapping[str, object]) -> None:
    if frame.get("op") == "wfp_plan":
        if len(canonical_json(frame["wfp_plan"])) > MAX_WFP_PLAN_BYTES:
            raise ProvisionWireError("wfp_plan_oversized", "the WFP plan is over its own bound")
        return
    if frame.get("op") != "provision":
        return
    if len(canonical_json(frame["path_set"])) > MAX_PATH_SET_BYTES:
        raise ProvisionWireError("path_set_oversized", "the path set is over its own bound")
    if len(canonical_json(frame["acl_plan"])) > MAX_ACL_PLAN_BYTES:
        raise ProvisionWireError("acl_plan_oversized", "the plan is over its own bound")
