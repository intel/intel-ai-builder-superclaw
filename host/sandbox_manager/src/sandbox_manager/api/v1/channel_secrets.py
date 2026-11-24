"""Host-owned channel credentials (EG2-6): ``/sandbox-manager/v1/channels/...``.

The app saves Slack and Telegram tokens here through ServiceHub's ``/sandbox-manager`` forwarding, so a
token never passes through the file_tool tier that runs the agent; the router runs in the channel tier
and reads them from its own data directory. Every route answers with outcomes only. The bodies are
parsed by hand, for the reason ``runtime_secrets`` gives: FastAPI's validation error would repeat the
request - the token - back to the caller.

``app.state.channel_credentials`` is the service behind the routes; until a backend attaches one, every
route says saving is unavailable. The routes also carry the Slack sender approvals (#3539): the router's
control token stays in this process, so the app lists and decides senders here, never through openwork-server.
"""

from __future__ import annotations

import asyncio
import json
import re
from typing import Any, Protocol

from contracts.channel_binding_request import ChannelBindingRequest
from contracts.channel_binding_result import ChannelBindingResult
from contracts.channel_enabled_request import ChannelEnabledRequest
from contracts.channel_enabled_result import ChannelEnabledResult
from contracts.channel_identity_enabled_request import ChannelIdentityEnabledRequest
from contracts.channel_identity_result import ChannelIdentityResult
from contracts.channel_send_request import ChannelSendRequest
from contracts.channel_send_result import ChannelSendResult
from contracts.slack_identity_save_request import SlackIdentitySaveRequest
from contracts.slack_install_complete_request import SlackInstallCompleteRequest
from contracts.slack_install_start_request import SlackInstallStartRequest
from contracts.slack_sender_decision_request import SlackSenderDecisionRequest
from contracts.slack_senders_result import SlackSendersResult
from contracts.telegram_identity_save_request import TelegramIdentitySaveRequest
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from loguru import logger
from pydantic import BaseModel, ValidationError

from ...channel_credentials import ChannelCredentialError
from ._host_api import NO_STORE_HEADERS, bounded_body, refusal

router = APIRouter()

_CHANNELS = frozenset({"slack", "telegram"})
# Two 512-character tokens, each at most twice that in JSON, a directory and the object around them.
_MAX_BODY_BYTES = 4096
_TOKEN_FIELDS = frozenset({"bot_token", "app_token", "token", "configuration_token"})
# 20,000 characters of text, each at worst a six-byte escape, and the object around them.
_MAX_SEND_BODY_BYTES = 128 * 1024
# `SlackSenderUserIdSchema` in shared/contracts: a member id only, so nothing else reaches the router's body.
_SLACK_USER_ID = re.compile(r"[UW][A-Z0-9]{1,63}")


class ChannelCredentials(Protocol):
    def save_slack(self, identity_id: str, request: SlackIdentitySaveRequest) -> ChannelIdentityResult: ...

    def set_slack_identity_enabled(
        self, identity_id: str, request: ChannelIdentityEnabledRequest
    ) -> ChannelIdentityResult: ...

    def save_telegram(
        self, identity_id: str, request: TelegramIdentitySaveRequest
    ) -> ChannelIdentityResult: ...

    def set_telegram_identity_enabled(
        self, identity_id: str, request: ChannelIdentityEnabledRequest
    ) -> ChannelIdentityResult: ...

    def delete_identity(self, channel: str, identity_id: str) -> ChannelIdentityResult: ...

    def set_enabled(self, channel: str, request: ChannelEnabledRequest) -> ChannelEnabledResult: ...

    def send_message(self, channel: str, request: ChannelSendRequest) -> ChannelSendResult: ...

    def set_binding(self, channel: str, request: ChannelBindingRequest) -> ChannelBindingResult: ...

    def list_slack_senders(self) -> SlackSendersResult: ...

    def set_slack_sender(self, user_id: str, allowed: bool) -> SlackSendersResult: ...


@router.put("/channels/slack/identities/{identity_id}")
async def save_slack_identity(identity_id: str, request: Request) -> JSONResponse:
    service = _service(request)
    if service is None:
        return refusal("channel_credentials_unavailable")
    parsed = await _parse(request, SlackIdentitySaveRequest)
    if isinstance(parsed, JSONResponse):
        return parsed
    if (unrecorded := await _record(request, "secret.saved", secret="slack_tokens")) is not None:
        return unrecorded
    return await _run(service.save_slack, identity_id, parsed)


@router.put("/channels/{channel}/identities/{identity_id}/enabled")
async def set_channel_identity_enabled(channel: str, identity_id: str, request: Request) -> JSONResponse:
    service = _service(request)
    if service is None:
        return refusal("channel_credentials_unavailable")
    if channel not in _CHANNELS:
        return refusal("invalid_request")
    parsed = await _parse(request, ChannelIdentityEnabledRequest)
    if isinstance(parsed, JSONResponse):
        return parsed
    if (
        unrecorded := await _record(
            request,
            "channel.identity_enabled_changed",
            channel=channel,
            identity_id=identity_id,
            enabled=str(parsed.enabled).lower(),
        )
    ) is not None:
        return unrecorded
    switch = service.set_slack_identity_enabled if channel == "slack" else service.set_telegram_identity_enabled
    return await _run(switch, identity_id, parsed)


@router.put("/channels/telegram/identities/{identity_id}")
async def save_telegram_identity(identity_id: str, request: Request) -> JSONResponse:
    service = _service(request)
    if service is None:
        return refusal("channel_credentials_unavailable")
    parsed = await _parse(request, TelegramIdentitySaveRequest)
    if isinstance(parsed, JSONResponse):
        return parsed
    if (unrecorded := await _record(request, "secret.saved", secret="telegram_token")) is not None:
        return unrecorded
    return await _run(service.save_telegram, identity_id, parsed)


@router.delete("/channels/{channel}/identities/{identity_id}")
async def delete_channel_identity(channel: str, identity_id: str, request: Request) -> JSONResponse:
    service = _service(request)
    if service is None:
        return refusal("channel_credentials_unavailable")
    if channel not in _CHANNELS:
        return refusal("invalid_request")
    if (
        unrecorded := await _record(
            request, "channel.identity_deleted", channel=channel, identity_id=identity_id
        )
    ) is not None:
        return unrecorded
    return await _run(service.delete_identity, channel, identity_id)


@router.put("/channels/{channel}/enabled")
async def set_channel_enabled(channel: str, request: Request) -> JSONResponse:
    service = _service(request)
    if service is None:
        return refusal("channel_credentials_unavailable")
    if channel not in _CHANNELS:
        return refusal("invalid_request")
    parsed = await _parse(request, ChannelEnabledRequest)
    if isinstance(parsed, JSONResponse):
        return parsed
    if parsed.clear_token and channel != "telegram":
        return refusal("invalid_request")
    if (
        unrecorded := await _record(
            request, "channel.enabled_changed", channel=channel, enabled=str(parsed.enabled).lower()
        )
    ) is not None:
        return unrecorded
    return await _run(service.set_enabled, channel, parsed)


@router.post("/channels/{channel}/send")
async def send_channel_message(channel: str, request: Request) -> JSONResponse:
    """The operator's own send (EG2-7): the router's admin token, so it is never held for approval."""
    service = _service(request)
    if service is None:
        return refusal("channel_credentials_unavailable")
    if channel not in _CHANNELS:
        return refusal("invalid_request")
    parsed = await _parse(request, ChannelSendRequest, _MAX_SEND_BODY_BYTES)
    if isinstance(parsed, JSONResponse):
        return parsed
    if parsed.directory is None and parsed.peer_id is None:
        return refusal("invalid_request")
    addressed = "both" if parsed.directory and parsed.peer_id else "peer" if parsed.peer_id else "directory"
    if (
        unrecorded := await _record(request, "channel.message_sent", channel=channel, addressed=addressed)
    ) is not None:
        return unrecorded
    return await _run(service.send_message, channel, parsed)


@router.put("/channels/{channel}/bindings")
async def set_channel_binding(channel: str, request: Request) -> JSONResponse:
    service = _service(request)
    if service is None:
        return refusal("channel_credentials_unavailable")
    if channel not in _CHANNELS:
        return refusal("invalid_request")
    parsed = await _parse(request, ChannelBindingRequest)
    if isinstance(parsed, JSONResponse):
        return parsed
    if (
        unrecorded := await _record(
            request, "channel.binding_changed", channel=channel, bound=str(parsed.directory is not None).lower()
        )
    ) is not None:
        return unrecorded
    return await _run(service.set_binding, channel, parsed)


@router.get("/channels/slack/senders")
async def list_slack_senders(request: Request) -> JSONResponse:
    """Who the Slack bot answers (#3539). The router's control token stays here, never in openwork-server."""
    service = _service(request)
    if service is None:
        return refusal("channel_credentials_unavailable")
    return await _run(service.list_slack_senders)


@router.put("/channels/slack/senders/{user_id}")
async def set_slack_sender(user_id: str, request: Request) -> JSONResponse:
    service = _service(request)
    if service is None:
        return refusal("channel_credentials_unavailable")
    if not _SLACK_USER_ID.fullmatch(user_id):
        return refusal("invalid_request")
    # Strict: the string "false" must not read as a decision.
    parsed = await _parse(request, SlackSenderDecisionRequest, strict=True)
    if isinstance(parsed, JSONResponse):
        return parsed
    # The decision is audited and the member is not: a Slack id is not a secret, but nothing needs it here.
    if (
        unrecorded := await _record(
            request, "channel.sender_changed", channel="slack", allowed=str(parsed.allowed).lower()
        )
    ) is not None:
        return unrecorded
    return await _run(service.set_slack_sender, user_id, parsed.allowed)


@router.post("/channels/slack/install")
async def start_slack_install(request: Request) -> JSONResponse:
    """Create SuperClaw's Slack app in the user's workspace and wait for its install (#3787)."""
    installer = _installer(request)
    credentials = _service(request)
    if installer is None or credentials is None or not getattr(credentials, "attached", True):
        return refusal("channel_credentials_unavailable")
    parsed = await _parse(request, SlackInstallStartRequest)
    if isinstance(parsed, JSONResponse):
        return parsed
    if (unrecorded := await _record(request, "channel.slack_install_started", channel="slack")) is not None:
        return unrecorded
    return await _run(installer.start, parsed)


@router.get("/channels/slack/install")
async def slack_install_status(request: Request) -> JSONResponse:
    installer = _installer(request)
    if installer is None:
        return refusal("channel_credentials_unavailable")
    return await _run(installer.status)


@router.post("/channels/slack/install/complete")
async def complete_slack_install(request: Request) -> JSONResponse:
    installer = _installer(request)
    if installer is None:
        return refusal("channel_credentials_unavailable")
    parsed = await _parse(request, SlackInstallCompleteRequest)
    if isinstance(parsed, JSONResponse):
        return parsed
    if (unrecorded := await _record(request, "secret.saved", secret="slack_tokens")) is not None:
        return unrecorded
    return await _run(installer.complete, parsed)


@router.delete("/channels/slack/install")
async def cancel_slack_install(request: Request) -> JSONResponse:
    installer = _installer(request)
    if installer is None:
        return refusal("channel_credentials_unavailable")
    if (unrecorded := await _record(request, "channel.slack_install_cancelled", channel="slack")) is not None:
        return unrecorded
    return await _run(installer.cancel)


def _service(request: Request) -> ChannelCredentials | None:
    return getattr(request.app.state, "channel_credentials", None)


def _installer(request: Request) -> Any:
    return getattr(request.app.state, "slack_install", None)


async def _parse(request: Request, model: type[BaseModel], limit: int = _MAX_BODY_BYTES, strict: bool = False) -> Any:
    """The validated body, or the refusal to send instead; neither echoes what was sent."""
    raw = await bounded_body(request, limit)
    if raw is None:
        return refusal("invalid_request")
    try:
        body = json.loads(raw)
    except ValueError:
        return refusal("invalid_request")
    try:
        return model.model_validate(body, strict=strict)
    except ValidationError as exc:
        errors = exc.errors(include_input=False)
        if errors and all(
            error["type"] == "string_pattern_mismatch" and error["loc"] and error["loc"][0] in _TOKEN_FIELDS
            for error in errors
        ):
            return refusal("invalid_channel_token")
        return refusal("invalid_request")


async def _record(request: Request, event: str, **fields: str) -> JSONResponse | None:
    """Write the audit line before the change. A line that cannot be written stops the change."""
    try:
        await asyncio.to_thread(request.app.state.control_audit.record, event, **fields)
    except OSError as exc:
        logger.error("control audit not written event={} error={}", event, type(exc).__name__)
        return refusal("channel_credentials_unavailable")
    return None


async def _run(call: Any, *arguments: Any) -> JSONResponse:
    # The router's Slack check and the file write block: keep them off the loop that answers probes.
    try:
        result = await asyncio.to_thread(call, *arguments)
    except ChannelCredentialError as error:
        return refusal(
            error.code,
            scope=error.scope,
            reason=error.reason,
            slack_error=error.slack_error,
        )
    return JSONResponse(result.model_dump(mode="json", exclude_none=True), headers=NO_STORE_HEADERS)
