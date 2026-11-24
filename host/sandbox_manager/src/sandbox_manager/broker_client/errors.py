"""Typed refusals for broker client operations."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class BrokerRefusalReason(str, Enum):
    broker_not_found = "broker_not_found"
    launcher_not_found = "launcher_not_found"
    launch_refused = "launch_refused"
    owner_sid_unavailable = "owner_sid_unavailable"
    tier_identity_missing = "tier_identity_missing"
    provision_refused = "provision_refused"
    provision_elevation_failed = "provision_elevation_failed"
    provision_connect_timeout = "provision_connect_timeout"
    provision_frame_timeout = "provision_frame_timeout"
    provision_broker_exited = "provision_broker_exited"
    # The launcher found a bound root that no longer carries the provisioned access control. The client
    # may provision once and retry; it may not launch, and the launcher cannot repair.
    provision_required = "provision_required"
    # The user dismissed the elevation prompt. Distinct from a failure, because there is nothing to
    # diagnose and nothing to retry without asking again.
    provision_elevation_declined = "provision_elevation_declined"
    # A frame or a peer on the provision pipe was refused: wrong process, wrong owner, bad MAC, replayed
    # nonce, unknown field, oversize payload.
    provision_pipe_refused = "provision_pipe_refused"


@dataclass(frozen=True)
class BrokerClientRefusalItem:
    reason: BrokerRefusalReason
    detail: str
    # The elevated broker's own closed refusal word (``provision_wire.REFUSAL_REASONS``) when it answered
    # the provision pipe with ``refused``; ``None`` for every refusal this client raised itself. ``detail``
    # is free text and must not be classified on.
    broker_refusal: str | None = None


class BrokerClientRefusal(Exception):
    items: tuple[BrokerClientRefusalItem, ...]

    def __init__(self, items: tuple[BrokerClientRefusalItem, ...]) -> None:
        self.items = items
        super().__init__(self.readable_message())

    @classmethod
    def single(
        cls, reason: BrokerRefusalReason, detail: str, *, broker_refusal: str | None = None
    ) -> BrokerClientRefusal:
        return cls(
            (BrokerClientRefusalItem(reason=reason, detail=detail, broker_refusal=broker_refusal),)
        )

    def readable_message(self) -> str:
        parts = [f"{item.reason.value}: {item.detail}" for item in self.items]
        return "; ".join(parts)


class WorkspaceAclRefusal(BrokerClientRefusal):
    """A combined first-start provision that failed anywhere but its tier-identity step.

    Raised so the caller reports it exactly as it reports the separate workspace ACL step, with the same
    recovery codes.
    """


def refusal_reason_word(error: BaseException | None) -> str | None:
    """The stable ``BrokerRefusalReason`` word behind ``error``, else ``None``.

    This is the only part of a refusal that leaves the process in runtime evidence: ``detail`` is free
    text that can carry paths, SIDs and the elevated helper's own words, and is never returned.
    Follows ``__cause__``/``__context__`` because the native backend re-raises a refusal as a
    ``RuntimeError`` that carries only text. A new ``BrokerRefusalReason`` also needs ServiceHub's copy
    and the activation contract's reason enum; ``test_broker_client_errors`` pins the three together.
    """
    seen: set[int] = set()
    while error is not None and id(error) not in seen:
        seen.add(id(error))
        if isinstance(error, BrokerClientRefusal) and error.items:
            return error.items[0].reason.value
        error = error.__cause__ or error.__context__
    return None
