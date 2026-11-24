"""Egress approvals (EG1-7, #16): steps 2 and 3 of section 6.3 of the egress design.

``GET /sandbox-manager/v1/egress/approvals`` lists what is waiting, oldest first, and
``POST .../{approval_id}/decision`` hands the user's answer to the broker behind
``app.state.egress_approval_broker``. The app reaches both through ServiceHub's ``/sandbox-manager``
forwarding, so neither passes through openwork-server or a sandbox tier.

What the user reads is what they approve: ``target``, the one free-text field, loses control and
format characters - a bidi override can make one host render as another - and is cut to the
contract's length in UTF-16 code units, which is how the frontend schema counts it.
"""

from __future__ import annotations

import asyncio
import json
import re
import unicodedata
from typing import Any

from contracts.egress_approval_decision_request import (
    Decision,
    EgressApprovalDecisionRequest,
)
from contracts.egress_approval_decision_result import EgressApprovalDecisionResult
from contracts.egress_pending_approval_list import EgressPendingApprovalList
from contracts.sandbox_manager_host_api_data import SANDBOX_MANAGER_HOST_API_RULES
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from loguru import logger
from pydantic import ValidationError

from ...control_audit import utc_instant
from ...egress_approvals import (
    ApprovalDeliveryFailed,
    ApprovalNotFound,
    ApprovalNotPending,
    ApprovalScopeNotOffered,
    EgressApprovalBroker,
    PendingApproval,
)
from ._host_api import NO_STORE_HEADERS, bounded_body, refusal

router = APIRouter()

_PATH = "/egress/approvals"
_MAX_WAIT_MS: int = SANDBOX_MANAGER_HOST_API_RULES["egress_approvals_max_wait_ms"]
_MAX_LISTED: int = SANDBOX_MANAGER_HOST_API_RULES["egress_pending_approvals_max"]
_TARGET_MAX_UNITS: int = SANDBOX_MANAGER_HOST_API_RULES["egress_approval_text_max_utf16_units"]
# The result is one variant per decision, and each carries the same approval_id rule.
_APPROVAL_ID = re.compile(
    next(iter(EgressApprovalDecisionResult.model_json_schema()["$defs"].values()))["properties"][
        "approval_id"
    ]["pattern"]
)
# {"decision": "approve", "grant_scope": "all_for_chat"} is the longest body a decision has; this leaves
# room for whitespace.
_MAX_BODY_BYTES = 256
_WAIT_MS = re.compile(r"[0-9]{1,9}")
_ELLIPSIS = "\u2026"
_NOTHING_VISIBLE = "(no readable text)"
_WHITESPACE = re.compile(r"\s+")


@router.get(_PATH)
async def list_pending_approvals(request: Request) -> JSONResponse:
    broker = _broker(request)
    if broker is None:
        return refusal("egress_approvals_unavailable")
    wait_ms = request.query_params.get("wait_ms", "0")
    if not _WAIT_MS.fullmatch(wait_ms):
        return refusal("invalid_request")
    pending = await broker.pending(min(int(wait_ms), _MAX_WAIT_MS) / 1000)
    oldest_first = sorted(pending, key=lambda approval: approval.requested_at)[:_MAX_LISTED]
    entries = []
    for approval in oldest_first:
        entry = _listed(approval)
        try:
            EgressPendingApprovalList.model_validate({"approvals": [entry]})
        except ValidationError:
            # One entry outside the contract must not hide the others. Only its id is logged.
            logger.error("pending approval left out of the list id={}", entry["approval_id"])
            continue
        entries.append(entry)
    listed = EgressPendingApprovalList.model_validate({"approvals": entries})
    return JSONResponse(listed.model_dump(mode="json", exclude_none=True), headers=NO_STORE_HEADERS)


@router.post(_PATH + "/{approval_id}/decision")
async def decide_approval(approval_id: str, request: Request) -> JSONResponse:
    broker = _broker(request)
    if broker is None:
        return refusal("egress_approvals_unavailable")
    if not _APPROVAL_ID.fullmatch(approval_id):
        return refusal("invalid_request")
    raw = await bounded_body(request, _MAX_BODY_BYTES)
    if raw is None:
        return refusal("invalid_request")
    try:
        body = json.loads(raw)
    except ValueError:
        return refusal("invalid_request")
    try:
        decision_request = EgressApprovalDecisionRequest.model_validate(body)
    except ValidationError:
        return refusal("invalid_request")
    decision = decision_request.decision
    scope = decision_request.grant_scope.value if decision_request.grant_scope is not None else None
    # The contract's refinement, which the generated model cannot carry: a denial has no scope.
    if decision is Decision.deny and scope is not None:
        return refusal("invalid_request")
    scope_fields = {"grant_scope": scope} if scope is not None else {}
    # The click is on record before the broker is asked: a line that cannot be written stops it.
    if not await _record(
        request, "approval.decision", approval_id=approval_id, decision=decision.value, **scope_fields
    ):
        return refusal("egress_approvals_unavailable")
    try:
        # A decision without a scope is asked of the broker as it always was.
        decided = await (
            broker.decide(approval_id, decision is Decision.approve)
            if scope is None
            else broker.decide(approval_id, decision is Decision.approve, scope)
        )
    except ApprovalNotFound:
        return refusal("approval_not_found")
    except ApprovalNotPending:
        return refusal("approval_not_pending")
    except ApprovalScopeNotOffered:
        return refusal("invalid_request")
    except ApprovalDeliveryFailed as exc:
        # The approval is still pending: the user may press again. Not a settled answer.
        await _record(
            request,
            "approval.decision_failed",
            approval_id=approval_id,
            decision=decision.value,
            error=type(exc).__name__,
        )
        return refusal("approval_delivery_failed")
    except Exception as exc:
        # A decision line with no outcome would be ambiguous: say the broker failed, then fail.
        await _record(
            request,
            "approval.decision_failed",
            approval_id=approval_id,
            decision=decision.value,
            error=type(exc).__name__,
        )
        raise
    # The decision has been taken: if its outcome line cannot be written, say so and still answer.
    granted_scope = {"grant_scope": s} if (s := getattr(decided, "grant_scope", None)) is not None else {}
    await _record(
        request,
        "approval.decided",
        approval_id=decided.approval_id,
        audience=decided.audience,
        action=decided.action,
        decision=decision.value,
        outcome=decided.outcome,
        **granted_scope,
    )
    result = EgressApprovalDecisionResult.model_validate(
        {
            "approval_id": decided.approval_id,
            "decision": decision.value,
            "outcome": decided.outcome,
            **granted_scope,
        }
    )
    return JSONResponse(result.model_dump(mode="json", exclude_none=True), headers=NO_STORE_HEADERS)


async def _record(request: Request, event: str, **fields: str) -> bool:
    """Append an audit line off the event loop; False if it could not be written."""
    try:
        await asyncio.to_thread(request.app.state.control_audit.record, event, **fields)
    except OSError as exc:
        logger.error("control audit not written event={} error={}", event, type(exc).__name__)
        return False
    return True


def _broker(request: Request) -> EgressApprovalBroker | None:
    return getattr(request.app.state, "egress_approval_broker", None)


def _listed(approval: PendingApproval) -> dict[str, Any]:
    return {
        "approval_id": approval.approval_id,
        "audience": approval.audience,
        "action": approval.action,
        "caller": approval.caller,
        "target": _display_text(approval.target),
        "requested_at": utc_instant(approval.requested_at),
        "expires_at": utc_instant(approval.expires_at),
        **({"grant_scopes": list(scopes)} if (scopes := getattr(approval, "grant_scopes", None)) else {}),
        **({"session_ref": ref} if (ref := getattr(approval, "session_ref", None)) else {}),
    }


def _display_text(text: str) -> str:
    """Plain text for the user: control and format characters out, whitespace runs (line and
    paragraph separators included) as one space, and no ellipsis of its own, so the ellipsis that
    ends a shortened text cannot come from the text."""
    kept = "".join(
        char for char in text if unicodedata.category(char) not in ("Cc", "Cf") and char != _ELLIPSIS
    )
    plain = _WHITESPACE.sub(" ", kept).strip()
    if not plain:
        return _NOTHING_VISIBLE
    if _utf16_units(plain) <= _TARGET_MAX_UNITS:
        return plain
    shortened: list[str] = []
    room = _TARGET_MAX_UNITS - _utf16_units(_ELLIPSIS)
    for char in plain:
        room -= _utf16_units(char)
        if room < 0:
            break
        shortened.append(char)
    return "".join(shortened) + _ELLIPSIS


def _utf16_units(text: str) -> int:
    return len(text.encode("utf-16-le")) // 2
