"""The host's channel credential service (EG2-6).

Slack and Telegram tokens used to be saved by openwork-server, which runs as the file_tool tier - the
tier the agent runs as - into a file that tier could read. They are saved here instead: this process
writes the router's ``opencode-router.json`` in the channel tier's data directory as the owner, and
drives the running router over its loopback health endpoint with the control token it minted for it.
The token therefore passes through no tier that runs the agent.

The service is attached while the backend runs and detached when it stops, so that a request that
arrives with no router to tell about is refused rather than half done. A token is held in memory only
for the length of one call, is written to the one file and sent in the one request that needs it, and
appears in no log line, audit line, error or response; failures log the type of the exception and
nothing it says, because an HTTP client's message can quote the URL or body.
"""

from __future__ import annotations

import re
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
from contracts.channel_enabled_request import ChannelEnabledRequest
from contracts.channel_enabled_result import ChannelEnabledResult
from contracts.channel_binding_request import ChannelBindingRequest
from contracts.channel_binding_result import ChannelBindingResult
from contracts.channel_identity_enabled_request import ChannelIdentityEnabledRequest
from contracts.channel_identity_result import ChannelIdentityResult
from contracts.channel_send_request import ChannelSendRequest
from contracts.channel_send_result import ChannelSendResult
from contracts.slack_identity_save_request import SlackIdentitySaveRequest
from contracts.slack_senders_result import SlackSendersResult
from contracts.telegram_identity_save_request import TelegramIdentitySaveRequest
from loguru import logger
from pydantic import ValidationError

from .channel_config import (
    ChannelConfigError,
    RouterConfigFile,
    saved_slack_identity,
    saved_telegram_identity,
    with_channel_enabled,
    with_slack_identity,
    with_telegram_identity,
    without_identity,
)

_IDENTITY_ID = re.compile(r"^[A-Za-z0-9_.-]{1,48}$")
_SLACK_ERROR_NAME = re.compile(r"^[a-z_]{1,64}$")
# Slack verification makes two calls to slack.com through the proxy; applying only starts an adapter.
_VERIFY_TIMEOUT_S = 15.0
_APPLY_TIMEOUT_S = 5.0
# A send waits for the channel's own answer, one call per bound conversation.
_SEND_TIMEOUT_S = 30.0
_MAX_FAILURES = 256
# The bounds of the senders contract.
_MAX_SENDERS = 4096
_MAX_PENDING_SENDERS = 256


class ChannelCredentialError(Exception):
    """A refusal the routes answer with ``code``. Nothing the caller sent is in it."""

    def __init__(
        self,
        code: str,
        *,
        scope: str | None = None,
        reason: str | None = None,
        slack_error: str | None = None,
    ) -> None:
        super().__init__(code)
        self.code = code
        self.scope = scope
        self.reason = reason
        self.slack_error = slack_error


@dataclass(frozen=True)
class _Attachment:
    config: RouterConfigFile
    port: int
    control_token: str
    workspace: Path


@dataclass(frozen=True)
class _RouterAnswer:
    """What the router said, reduced to what the caller needs; ``body`` is its JSON object or empty."""

    status: int | None
    body: dict[str, Any]


class ChannelCredentialService:
    def __init__(self, *, transport: httpx.BaseTransport | None = None) -> None:
        self._transport = transport
        self._lock = threading.RLock()
        # Saving, switching and deleting an identity each verify, write and apply; one at a time, so the router is
        # given the tokens that are on disk.
        self._identity_change = threading.Lock()
        self._attachment: _Attachment | None = None

    def attach(self, *, config_path: Path, router_port: int, control_token: str, workspace: Path) -> None:
        with self._lock:
            self._attachment = _Attachment(RouterConfigFile(config_path), router_port, control_token, workspace)

    def detach(self) -> None:
        with self._lock:
            self._attachment = None

    @property
    def attached(self) -> bool:
        return self._attachment is not None

    def save_slack(self, identity_id: str, request: SlackIdentitySaveRequest) -> ChannelIdentityResult:
        with self._identity_change:
            return self._save_slack(identity_id, request)

    def _save_slack(self, identity_id: str, request: SlackIdentitySaveRequest) -> ChannelIdentityResult:
        attachment = self._require(identity_id)
        enabled = True if request.enabled is None else request.enabled
        directory = request.directory or str(attachment.workspace)
        payload = {
            "id": identity_id,
            "botToken": request.bot_token,
            "appToken": request.app_token,
            "enabled": enabled,
            "directory": directory,
        }

        # The router asks Slack whether the pair is real, so a mistyped token is refused before it is kept.
        answer = self._call(attachment, "POST", "/identities/slack/verify", payload, _VERIFY_TIMEOUT_S)
        if answer.status is None or not 200 <= answer.status < 300:
            raise _slack_refusal(answer)

        self._edit(
            attachment,
            lambda config: with_slack_identity(
                config, identity_id, request.bot_token, request.app_token, enabled, directory
            ),
        )
        return self._applied(
            attachment, "slack", identity_id, "POST", "/identities/slack", payload, answer_key="slack"
        )

    def set_slack_identity_enabled(
        self, identity_id: str, request: ChannelIdentityEnabledRequest
    ) -> ChannelIdentityResult:
        """Switch one saved Slack bot off or on with its kept tokens; only switching on asks Slack."""
        with self._identity_change:
            return self._set_slack_identity_enabled(identity_id, request)

    def _set_slack_identity_enabled(
        self, identity_id: str, request: ChannelIdentityEnabledRequest
    ) -> ChannelIdentityResult:
        attachment = self._require(identity_id)
        with self._lock:
            try:
                saved = saved_slack_identity(attachment.config.read(), identity_id)
            except ChannelConfigError as exc:
                raise ChannelCredentialError(exc.code) from None
        if saved is None:
            raise ChannelCredentialError("channel_identity_not_found")
        bot_token, app_token, saved_directory = saved
        directory = saved_directory or str(attachment.workspace)
        payload = {
            "id": identity_id,
            "botToken": bot_token,
            "appToken": app_token,
            "enabled": request.enabled,
            "directory": directory,
        }
        if request.enabled:
            answer = self._call(attachment, "POST", "/identities/slack/verify", payload, _VERIFY_TIMEOUT_S)
            if answer.status is None or not 200 <= answer.status < 300:
                raise _slack_refusal(answer)

        self._edit(
            attachment,
            lambda config: with_slack_identity(
                config, identity_id, bot_token, app_token, request.enabled, directory
            ),
        )
        return self._applied(
            attachment, "slack", identity_id, "POST", "/identities/slack", payload, answer_key="slack"
        )

    def save_telegram(self, identity_id: str, request: TelegramIdentitySaveRequest) -> ChannelIdentityResult:
        attachment = self._require(identity_id)
        enabled = True if request.enabled is None else request.enabled
        directory = request.directory or str(attachment.workspace)
        access = request.access.value if request.access is not None else None
        self._edit(
            attachment,
            lambda config: with_telegram_identity(
                config, identity_id, request.token, enabled, directory, access, request.pairing_code_hash
            ),
        )
        payload: dict[str, Any] = {
            "id": identity_id,
            "token": request.token,
            "enabled": enabled,
            "directory": directory,
        }
        if access is not None:
            payload["access"] = access
        if request.pairing_code_hash is not None:
            payload["pairingCodeHash"] = request.pairing_code_hash
        return self._applied(
            attachment, "telegram", identity_id, "POST", "/identities/telegram", payload, answer_key="telegram"
        )

    def set_telegram_identity_enabled(
        self, identity_id: str, request: ChannelIdentityEnabledRequest
    ) -> ChannelIdentityResult:
        """Switch one saved Telegram bot off or on with its kept token, access and pairing code."""
        with self._identity_change:
            attachment = self._require(identity_id)
            with self._lock:
                try:
                    saved = saved_telegram_identity(attachment.config.read(), identity_id)
                except ChannelConfigError as exc:
                    raise ChannelCredentialError(exc.code) from None
            if saved is None:
                raise ChannelCredentialError("channel_identity_not_found")
            token, saved_directory, access, pairing_code_hash = saved
            directory = saved_directory or str(attachment.workspace)
            self._edit(
                attachment,
                lambda config: with_telegram_identity(
                    config, identity_id, token, request.enabled, directory, access, pairing_code_hash
                ),
            )
            payload: dict[str, Any] = {
                "id": identity_id,
                "token": token,
                "enabled": request.enabled,
                "directory": directory,
                "access": access,
            }
            if pairing_code_hash is not None:
                payload["pairingCodeHash"] = pairing_code_hash
            return self._applied(
                attachment, "telegram", identity_id, "POST", "/identities/telegram", payload, answer_key="telegram"
            )

    def delete_identity(self, channel: str, identity_id: str) -> ChannelIdentityResult:
        with self._identity_change:
            return self._delete_identity(channel, identity_id)

    def _delete_identity(self, channel: str, identity_id: str) -> ChannelIdentityResult:
        attachment = self._require(identity_id)
        deleted = False

        def remove(config: dict[str, Any]) -> dict[str, Any]:
            nonlocal deleted
            edited, deleted = without_identity(config, channel, identity_id)
            return edited

        if attachment.config.path.exists():
            self._edit(attachment, remove)
        result = self._applied(
            attachment, channel, identity_id, "DELETE", f"/identities/{channel}/{identity_id}", None, answer_key=channel
        )
        return result.model_copy(update={"deleted": deleted})

    def set_enabled(self, channel: str, request: ChannelEnabledRequest) -> ChannelEnabledResult:
        attachment = self._require(None)
        clear_token = bool(request.clear_token)
        self._edit(
            attachment,
            lambda config: with_channel_enabled(config, channel, request.enabled, clear_token=clear_token),
        )
        return ChannelEnabledResult.model_validate(
            {"channel": channel, "enabled": request.enabled, "persisted": True}
        )

    def send_message(self, channel: str, request: ChannelSendRequest) -> ChannelSendResult:
        """The operator's own send, with the router's admin token: never held for approval (EG2-7)."""
        attachment = self._require(request.identity_id)
        payload: dict[str, Any] = {"channel": channel, "text": request.text}
        if request.identity_id is not None:
            payload["identityId"] = request.identity_id
        if request.directory is not None:
            payload["directory"] = request.directory
        if request.peer_id is not None:
            payload["peerId"] = request.peer_id
        if request.auto_bind:
            payload["autoBind"] = True
        answer = self._call(attachment, "POST", "/send", payload, _SEND_TIMEOUT_S)
        _require_router_success(answer)
        return _send_result(channel, answer.body)

    def set_binding(self, channel: str, request: ChannelBindingRequest) -> ChannelBindingResult:
        """Bind a conversation to a workspace directory, or unbind it when no directory is given."""
        attachment = self._require(request.identity_id)
        payload: dict[str, Any] = {"channel": channel, "peerId": request.peer_id}
        if request.identity_id is not None:
            payload["identityId"] = request.identity_id
        if request.directory is not None:
            payload["directory"] = request.directory
        _require_router_success(self._call(attachment, "POST", "/bindings", payload, _APPLY_TIMEOUT_S))
        return ChannelBindingResult.model_validate(
            {"channel": channel, "peer_id": request.peer_id, "bound": request.directory is not None}
        )

    def list_slack_senders(self) -> SlackSendersResult:
        """Who the Slack bot answers (#3539), read from the router with its control token."""
        attachment = self._require(None)
        answer = self._call(attachment, "GET", "/slack/senders", None, _APPLY_TIMEOUT_S)
        _require_router_success(answer)
        return _senders_result(answer.body)

    def set_slack_sender(self, user_id: str, allowed: bool) -> SlackSendersResult:
        """Approve (``allowed``) or remove a Slack member; the router answers the list as it now stands."""
        attachment = self._require(None)
        answer = self._call(
            attachment, "POST", "/slack/senders", {"userId": user_id, "allowed": allowed}, _APPLY_TIMEOUT_S
        )
        # The environment approves this member, and only the environment can take it back.
        if answer.status == 409:
            raise ChannelCredentialError("slack_sender_env_managed")
        _require_router_success(answer)
        return _senders_result(answer.body)

    def _require(self, identity_id: str | None) -> _Attachment:
        attachment = self._attachment
        if attachment is None:
            raise ChannelCredentialError("channel_credentials_unavailable")
        if identity_id is not None and (identity_id == "env" or not _IDENTITY_ID.fullmatch(identity_id)):
            raise ChannelCredentialError("invalid_channel_identity")
        return attachment

    def _edit(self, attachment: _Attachment, change: Any) -> None:
        with self._lock:
            try:
                attachment.config.write(change(attachment.config.read()))
            except ChannelConfigError as exc:
                raise ChannelCredentialError(exc.code) from None
            except OSError as exc:
                logger.error("channel config not written exception_type={}", type(exc).__name__)
                raise ChannelCredentialError("channel_config_unreadable") from None

    def _applied(
        self,
        attachment: _Attachment,
        channel: str,
        identity_id: str,
        method: str,
        path: str,
        payload: dict[str, Any] | None,
        *,
        answer_key: str,
    ) -> ChannelIdentityResult:
        answer = self._call(attachment, method, path, payload, _APPLY_TIMEOUT_S)
        error: str | None = None
        starting = False
        if answer.status is None:
            error = "router_unreachable"
        elif not 200 <= answer.status < 300:
            error = "router_rejected"
        else:
            section = answer.body.get(answer_key)
            if isinstance(section, dict) and section.get("applied") is False:
                # The router waits only briefly for a bot to start; one still starting is not a refusal.
                if section.get("starting") is True and not section.get("error"):
                    starting = True
                else:
                    error = "router_rejected"
        result: dict[str, Any] = {
            "channel": channel,
            "identity_id": identity_id,
            "persisted": True,
            "applied": error is None and not starting,
        }
        if error is not None:
            result["apply_error"] = error
        return ChannelIdentityResult.model_validate(result)

    def _call(
        self,
        attachment: _Attachment,
        method: str,
        path: str,
        payload: dict[str, Any] | None,
        timeout: float,
    ) -> _RouterAnswer:
        headers = {"Authorization": f"Bearer {attachment.control_token}"}
        try:
            with httpx.Client(transport=self._transport, timeout=timeout) as client:
                response = client.request(
                    method,
                    f"http://127.0.0.1:{attachment.port}{path}",
                    json=payload,
                    headers=headers,
                )
        except httpx.HTTPError as exc:
            # The exception's own text can quote the URL or the body, so only its type is kept.
            logger.warning(
                "channel router call failed method={} path={} exception_type={}",
                method,
                _loggable_path(path),
                type(exc).__name__,
            )
            return _RouterAnswer(None, {})
        try:
            parsed = response.json()
        except ValueError:
            parsed = {}
        return _RouterAnswer(response.status_code, parsed if isinstance(parsed, dict) else {})


def _require_router_success(answer: _RouterAnswer) -> None:
    """A router that cannot be reached is a retry; one that refused the request is not."""
    if answer.status is None or answer.status >= 500:
        raise ChannelCredentialError("channel_router_unreachable")
    if not 200 <= answer.status < 300:
        raise ChannelCredentialError("channel_router_rejected")


def _clip(value: object, limit: int) -> str | None:
    return value[:limit] if isinstance(value, str) else None


def _count(value: object) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def _senders_result(body: dict[str, Any]) -> SlackSendersResult:
    """The router's list in the contract's shape. A body that is not a list is a refusal, never an empty list."""
    allowed, pending = body.get("allowed"), body.get("pending")
    if not isinstance(allowed, list) or not isinstance(pending, list):
        raise ChannelCredentialError("channel_router_rejected")
    result: dict[str, Any] = {"allowed": [], "pending": []}
    for item in allowed[:_MAX_SENDERS]:
        if isinstance(item, dict) and item.get("userId") and item.get("source") in ("app", "env"):
            if (user_id := _clip(item["userId"], 256)) is not None:
                result["allowed"].append({"user_id": user_id, "source": item["source"]})
    for item in pending[:_MAX_PENDING_SENDERS]:
        if not isinstance(item, dict):
            continue
        user_id = _clip(item.get("userId"), 256)
        identity_id = _clip(item.get("identityId"), 256)
        first, last, attempts = _count(item.get("firstSeenAt")), _count(item.get("lastSeenAt")), _count(item.get("attempts"))
        if user_id and identity_id is not None and first is not None and last is not None and attempts is not None:
            result["pending"].append(
                {"user_id": user_id, "identity_id": identity_id, "first_seen_at": first, "last_seen_at": last, "attempts": attempts}
            )
    try:
        return SlackSendersResult.model_validate(result)
    except ValidationError:
        raise ChannelCredentialError("channel_router_rejected") from None


def _send_result(channel: str, body: dict[str, Any]) -> ChannelSendResult:
    """What the router reported, cut to the contract's bounds; a field it did not send is left out."""
    result: dict[str, Any] = {
        "channel": channel,
        "directory": _clip(body.get("directory"), 1024) or "",
        "attempted": body.get("attempted") if isinstance(body.get("attempted"), int) else 0,
        "sent": body.get("sent") if isinstance(body.get("sent"), int) else 0,
    }
    for source, target, limit in (("identityId", "identity_id", 48), ("peerId", "peer_id", 256), ("reason", "reason", 512)):
        if (value := _clip(body.get(source), limit)) is not None:
            result[target] = value
    failures = body.get("failures")
    if isinstance(failures, list):
        result["failures"] = [
            {
                "identity_id": _clip(item.get("identityId"), 48) or "",
                "peer_id": _clip(item.get("peerId"), 256) or "",
                "error": _clip(item.get("error"), 512) or "",
            }
            for item in failures[:_MAX_FAILURES]
            if isinstance(item, dict)
        ]
    return ChannelSendResult.model_validate(result)


def _loggable_path(path: str) -> str:
    return path.rsplit("/", 1)[0] if path.count("/") > 2 else path


def _slack_refusal(answer: _RouterAnswer) -> ChannelCredentialError:
    """The refusal for a verification the router did not accept: Slack said no, or could not be asked."""
    body = answer.body
    scope = body.get("scope") if body.get("scope") in ("bot", "app") else None
    reason = body.get("reason") if body.get("reason") in ("invalid", "unreachable") else None
    name = body.get("slackError")
    slack_error = name if isinstance(name, str) and _SLACK_ERROR_NAME.fullmatch(name) else None
    code = "slack_credentials_rejected" if answer.status == 400 else "slack_verification_unavailable"
    return ChannelCredentialError(code, scope=scope, reason=reason, slack_error=slack_error)
