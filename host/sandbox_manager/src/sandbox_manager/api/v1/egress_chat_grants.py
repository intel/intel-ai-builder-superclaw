"""Chat grants (#3562): the "Allowed for this chat" switch, which lets a chat read every web page unasked.

``PUT /sandbox-manager/v1/egress/chat-grants/{root_session_id}`` with ``{"allow": bool}`` hands the switch to
the broker behind ``app.state.egress_approval_broker``; ``GET`` on the same path reads it. Both answer
``{root_session_id, session_ref, allowed}``. The app reaches them through ServiceHub's ``/sandbox-manager``
forwarding, behind the forwarded credential, as it reaches the approval routes.

The chat is its root session. The Sandbox Manager computes its ``session_ref`` here, and only that goes to
the broker or into an audit line: the root session id is answered back to the app and recorded nowhere.
"""

from __future__ import annotations

import asyncio
import json
import re

from contracts.egress_chat_grant_request import EgressChatGrantRequest
from contracts.egress_chat_grant_status import EgressChatGrantStatus
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from loguru import logger
from pydantic import ValidationError

from ...egress_approvals import ApprovalDeliveryFailed, EgressChatGrantBroker
from ...egress_chat_grants import session_ref
from ._host_api import NO_STORE_HEADERS, bounded_body, refusal

router = APIRouter()

_PATH = "/egress/chat-grants/{root_session_id}"
_ROOT_SESSION_ID = re.compile(EgressChatGrantStatus.model_json_schema()["properties"]["root_session_id"]["pattern"])
# {"allow": false} and room for whitespace.
_MAX_BODY_BYTES = 64


@router.get(_PATH)
async def read_chat_grant(root_session_id: str, request: Request) -> JSONResponse:
    broker = _broker(request)
    if broker is None:
        return refusal("egress_approvals_unavailable")
    if not _ROOT_SESSION_ID.fullmatch(root_session_id):
        return refusal("invalid_request")
    ref = session_ref(root_session_id)
    return _status(root_session_id, ref, await asyncio.to_thread(broker.allows_chat, ref))


@router.put(_PATH)
async def set_chat_grant(root_session_id: str, request: Request) -> JSONResponse:
    broker = _broker(request)
    if broker is None:
        return refusal("egress_approvals_unavailable")
    if not _ROOT_SESSION_ID.fullmatch(root_session_id):
        return refusal("invalid_request")
    raw = await bounded_body(request, _MAX_BODY_BYTES)
    if raw is None:
        return refusal("invalid_request")
    try:
        # Strict: a "true" or a 1 is not a yes.
        allow = EgressChatGrantRequest.model_validate(json.loads(raw), strict=True).allow
    except (ValueError, ValidationError):
        return refusal("invalid_request")
    ref = session_ref(root_session_id)
    # The switch is on record before the broker is asked: a line that cannot be written stops it.
    if not await _record(request, "chat_grant.set", session_ref=ref, allowed=allow):
        return refusal("egress_approvals_unavailable")
    try:
        await broker.set_chat_grant(ref, allow)
    except ApprovalDeliveryFailed as exc:
        # Switching off did not reach the Connector, which would still admit the chat's pages: still on.
        await _record(request, "chat_grant.set_failed", session_ref=ref, allowed=allow, error=type(exc).__name__)
        return refusal("approval_delivery_failed")
    return _status(root_session_id, ref, await asyncio.to_thread(broker.allows_chat, ref))


def _status(root_session_id: str, ref: str, allowed: bool) -> JSONResponse:
    status = EgressChatGrantStatus.model_validate(
        {"root_session_id": root_session_id, "session_ref": ref, "allowed": allowed}
    )
    return JSONResponse(status.model_dump(mode="json"), headers=NO_STORE_HEADERS)


async def _record(request: Request, event: str, **fields: str | bool) -> bool:
    """Append an audit line off the event loop; False if it could not be written."""
    try:
        await asyncio.to_thread(request.app.state.control_audit.record, event, **fields)
    except OSError as exc:
        logger.error("control audit not written event={} error={}", event, type(exc).__name__)
        return False
    return True


def _broker(request: Request) -> EgressChatGrantBroker | None:
    return getattr(request.app.state, "egress_approval_broker", None)
