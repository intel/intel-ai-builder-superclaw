"""What the approval routes need from the egress approval broker (EG1-7, #16).

The broker holds the pending queue, signs a grant and delivers it to the verifier that asked. It is
provided behind ``app.state.egress_approval_broker``; until a backend provides one, the routes say
approvals are unavailable.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Literal, Protocol


@dataclass(frozen=True)
class PendingApproval:
    approval_id: str
    audience: str
    action: str
    caller: str
    target: str
    requested_at: datetime
    expires_at: datetime
    # The scopes the user may choose from; None is `once` alone.
    grant_scopes: tuple[str, ...] | None = None
    # The chat the request belongs to, as its verifier names it; None when it names none.
    session_ref: str | None = None


@dataclass(frozen=True)
class ApprovalDecided:
    approval_id: str
    audience: str
    action: str
    outcome: Literal["granted", "denied"]
    # The scope of a grant, for an approval that offered more than once.
    grant_scope: str | None = None


class ApprovalNotFound(Exception):
    """No approval has that id."""


class ApprovalNotPending(Exception):
    """The approval was already decided or has expired."""


class ApprovalScopeNotOffered(Exception):
    """The decision names a grant scope this approval did not offer."""


class ApprovalDeliveryFailed(Exception):
    """The decision could not be delivered to the verifier (the Connector). The approval stays pending."""


class EgressApprovalBroker(Protocol):
    async def pending(self, wait_s: float) -> list[PendingApproval]: ...

    async def decide(self, approval_id: str, approve: bool, grant_scope: str | None = None) -> ApprovalDecided: ...


class EgressChatGrantBroker(Protocol):
    """What the chat-grant routes need: whether a chat (its `session_ref`) is allowed, and the switch."""

    def allows_chat(self, ref: str) -> bool: ...

    async def set_chat_grant(self, ref: str, allow: bool) -> None: ...
