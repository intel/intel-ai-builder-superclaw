"""Connect Slack through a prepared app manifest (#3787).

The user pastes a Slack app configuration token. This service uses it to create a Slack app from
SuperClaw's manifest in the user's own workspace, with a redirect URL on a loopback port it is
listening on, and the user approves the install in the browser. Slack redirects back here with a
code, which is exchanged for the bot token. The user then pastes the app-level token (no Slack API
mints one), and both are saved through ``ChannelCredentialService.save_slack``, the save the token
form uses.

The configuration token, the new app's client secret and the bot token are held in this process's
memory for one install only. None is written, logged, audited or answered. The bot token leaves
only through ``save_slack``.

Slack hands out an app's client secret only once, in the ``apps.manifest.create`` answer
(``apps.manifest.update`` does not repeat it), and the secret is not kept. So a reconnect creates a
new app and deletes the one the last install made, after the new install is saved and answered. Only
app ids are stored, and an app id is not a secret. An install that is cancelled or runs out deletes the
app it created, so an abandoned attempt leaves nothing behind in the workspace.
"""

from __future__ import annotations

import http.server
import json
import re
import secrets
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal, Protocol
from urllib.parse import parse_qsl, urlencode, urlsplit

import httpx
from contracts.channel_identity_result import ChannelIdentityResult
from contracts.sandbox_manager_host_api_data import SANDBOX_MANAGER_HOST_API_RULES
from contracts.slack_identity_save_request import SlackIdentitySaveRequest
from contracts.slack_install_complete_request import SlackInstallCompleteRequest
from contracts.slack_install_complete_result import SlackInstallCompleteResult
from contracts.slack_install_start_request import SlackInstallStartRequest
from contracts.slack_install_start_result import SlackInstallStartResult
from contracts.slack_install_status import SlackInstallStatus
from loguru import logger

from .channel_credentials import ChannelCredentialError

_SLACK_API = "https://slack.com/api/"
_AUTHORIZE_PREFIX = "https://slack.com/oauth/v2/authorize?"
_CALLBACK_PATH = "/slack/oauth/callback"
# One app per identity: each workspace's identity has its own bot, and reconnecting one must not delete another's.
_APP_ID_KEY_PREFIX = "channels.slack.manifest_app_id."
# Earlier apps of an identity that are still to be deleted.
_LEFTOVER_APP_IDS_KEY_PREFIX = "channels.slack.leftover_app_ids."
# Long enough for a user who reads the permission screen; an admin-held install never redirects at all.
_INSTALL_SECONDS = 15 * 60
# The complete call runs the update and save_slack (up to 20 s) inside the UI's and ServiceHub's 30 s waits; the
# previous app is deleted after the answer.
_UPDATE_TIMEOUT_S = 4.0
_DELETE_TIMEOUT_S = 5.0
_SLACK_TIMEOUT_S = 15.0
_SLACK_ERROR_NAME = re.compile(r"^[a-z_]{1,64}$")
_APP_ID = re.compile(r"^A[A-Z0-9]{2,31}$")
_TEAM_ID = re.compile(r"^T[A-Z0-9]{2,31}$")
# What apps.manifest.delete answers for an app that does not exist; any other refusal may pass on a later try.
_APP_GONE = frozenset({"app_not_found", "invalid_app_id"})
_TOKEN_REFUSALS = frozenset(
    {"invalid_auth", "not_authed", "token_expired", "token_revoked", "account_inactive", "invalid_token"}
)

Phase = Literal["awaiting_authorization", "exchanging", "awaiting_app_token", "saving", "failed"]


class SlackSave(Protocol):
    def save_slack(self, identity_id: str, request: SlackIdentitySaveRequest) -> ChannelIdentityResult: ...


class ConfigStore(Protocol):
    def get_config(self, key: str, default: Any = None) -> Any: ...

    def set_config(self, key: str, value: Any) -> None: ...


def slack_app_manifest(redirect_url: str, *, finished: bool = True) -> dict[str, Any]:
    """SuperClaw's app: a bot user the router can DM and mention over Socket Mode, installed through ``redirect_url``.

    The app is created unfinished, with Socket Mode off and so no events (Slack refuses events with neither Socket
    Mode nor a request URL). Switching Socket Mode on in the app's settings then offers an app-level token with
    ``connections:write`` already chosen, which is the token the user pastes. Finishing adds both back.
    """
    settings: dict[str, Any] = {
        "interactivity": {"is_enabled": False},
        "org_deploy_enabled": False,
        "socket_mode_enabled": finished,
        "token_rotation_enabled": False,
    }
    if finished:
        settings["event_subscriptions"] = {"bot_events": list(SANDBOX_MANAGER_HOST_API_RULES["slack_app_bot_events"])}
    return {
        "display_information": {"name": "SuperClaw"},
        "features": {
            # Without the messages tab Slack tells the user that sending messages to this app is turned off.
            "app_home": {"home_tab_enabled": False, "messages_tab_enabled": True, "messages_tab_read_only_enabled": False},
            "bot_user": {"display_name": "SuperClaw", "always_online": True},
        },
        "oauth_config": {
            "redirect_urls": [redirect_url],
            "scopes": {"bot": list(SANDBOX_MANAGER_HOST_API_RULES["slack_app_bot_scopes"])},
        },
        "settings": settings,
    }


@dataclass
class _Install:
    # The secrets are left out of the repr, which a traceback or a log line could otherwise print.
    identity_id: str
    configuration_token: str = field(repr=False)
    app_id: str
    client_id: str
    client_secret: str = field(repr=False)
    state: str = field(repr=False)
    redirect_url: str
    server: http.server.HTTPServer
    expires_at: float
    phase: Phase = "awaiting_authorization"
    # Offered again by status() so the page can show the link after it is reopened.
    authorize_url: str | None = field(default=None, repr=False)
    bot_token: str | None = field(default=None, repr=False)
    # The workspace the install went to, from the exchange: the app's settings pages are addressed by it.
    team_id: str | None = None
    # Set once Socket Mode and the events are added, so a retried paste does not ask Slack again.
    finished: bool = False
    failure: str | None = None
    timer: threading.Timer | None = None


class SlackInstallService:
    def __init__(
        self,
        *,
        credentials: SlackSave,
        store: ConfigStore,
        transport: httpx.BaseTransport | None = None,
        clock: Callable[[], float] = time.time,
        install_seconds: float = _INSTALL_SECONDS,
    ) -> None:
        self._credentials = credentials
        self._store = store
        self._transport = transport
        self._clock = clock
        self._install_seconds = install_seconds
        self._lock = threading.RLock()
        # Start, complete and cancel each span Slack calls. Run one at a time, so none can replace or delete an
        # install another is still creating or saving.
        self._operation = threading.Lock()
        self._install: _Install | None = None

    def start(self, request: SlackInstallStartRequest) -> SlackInstallStartResult:
        """Create the app and start listening for its install; any install already under way is abandoned."""
        with self._operation:
            return self._start(request)

    def _start(self, request: SlackInstallStartRequest) -> SlackInstallStartResult:
        self._abandon()
        try:
            server = _NoReuseHTTPServer(("127.0.0.1", 0), _CallbackHandler)
        except OSError as exc:
            logger.warning("slack install port not bound exception_type={}", type(exc).__name__)
            raise ChannelCredentialError("slack_install_port_unavailable") from None
        redirect_url = f"http://127.0.0.1:{server.server_address[1]}{_CALLBACK_PATH}"
        try:
            created = self._slack(
                "apps.manifest.create",
                {"manifest": json.dumps(slack_app_manifest(redirect_url, finished=False))},
                bearer=request.configuration_token,
            )
            install = self._installation(request, created, redirect_url, server)
        except BaseException:
            server.server_close()
            raise

        authorize = urlsplit(created["oauth_authorize_url"])
        query = dict(parse_qsl(authorize.query))
        query.update({"redirect_uri": redirect_url, "state": install.state})
        authorize_url = authorize._replace(query=urlencode(query)).geturl()
        install.authorize_url = authorize_url

        server.slack_install = self  # type: ignore[attr-defined]
        server.slack_state = install.state  # type: ignore[attr-defined]
        threading.Thread(target=server.serve_forever, name="slack-install-callback", daemon=True).start()
        install.timer = threading.Timer(self._install_seconds, self._expire, args=(install,))
        install.timer.daemon = True
        with self._lock:
            self._install = install
        install.timer.start()
        logger.info("slack install started app_id={} port={}", install.app_id, server.server_address[1])
        return SlackInstallStartResult.model_validate(
            {"app_id": install.app_id, "authorize_url": authorize_url, "expires_at": _instant(install.expires_at)}
        )

    def status(self) -> SlackInstallStatus:
        with self._lock:
            install = self._install
            if install is None:
                return SlackInstallStatus.model_validate({"state": "none"})
            # The exchange and the save are moments inside a call; to the app nothing has moved on yet.
            state = {"exchanging": "awaiting_authorization", "saving": "awaiting_app_token"}.get(
                install.phase, install.phase
            )
            body: dict[str, Any] = {"state": state, "app_id": install.app_id}
            if install.team_id is not None:
                body["team_id"] = install.team_id
            if state == "awaiting_authorization":
                body["authorize_url"] = install.authorize_url
            if state == "failed":
                body["failure"] = install.failure
            else:
                body["expires_at"] = _instant(install.expires_at)
            return SlackInstallStatus.model_validate(body)

    def complete(self, request: SlackInstallCompleteRequest) -> SlackInstallCompleteResult:
        """Save the held bot token with the app-level token; then delete the app the last install made."""
        with self._operation:
            return self._complete(request)

    def _complete(self, request: SlackInstallCompleteRequest) -> SlackInstallCompleteResult:
        with self._lock:
            install = self._install
            if install is None or install.phase != "awaiting_app_token" or install.bot_token is None:
                raise ChannelCredentialError("slack_install_not_ready")
            bot_token = install.bot_token
            # While saving, running out must not delete the app being saved.
            install.phase = "saving"
        try:
            # Before the save, so the bot never runs without its events.
            if not install.finished:
                self._finish_app(install)
                install.finished = True
            identity = self._credentials.save_slack(
                install.identity_id,
                SlackIdentitySaveRequest.model_validate(
                    {
                        "bot_token": bot_token,
                        "app_token": request.app_token,
                        **({} if request.enabled is None else {"enabled": request.enabled}),
                        **({} if request.directory is None else {"directory": request.directory}),
                    }
                ),
            )
        except BaseException:
            # A refused app-level token leaves the install waiting, so the user can paste again, unless it ran out
            # meanwhile: the expiry timer skipped it while saving and will not fire again.
            with self._lock:
                if self._install is install and install.phase == "saving":
                    if self._clock() >= install.expires_at:
                        self._fail(install, "expired")
                    else:
                        install.phase = "awaiting_app_token"
            raise
        # Saved: from here on nothing may delete this app, so it leaves the service before any bookkeeping.
        with self._lock:
            if self._install is install:
                self._install = None
        self._stop(install)
        key = _APP_ID_KEY_PREFIX + install.identity_id
        previous = self._store.get_config(key)
        self._store.set_config(key, install.app_id)
        # Recorded before the delete is tried, so one that fails, or is cut off by a quit, is tried again next time.
        leftover_key = _LEFTOVER_APP_IDS_KEY_PREFIX + install.identity_id
        stored = self._store.get_config(leftover_key, [])
        leftovers = [app for app in stored if isinstance(app, str)] if isinstance(stored, list) else []
        if isinstance(previous, str) and previous not in leftovers:
            leftovers.append(previous)
        leftovers = [app for app in leftovers if app != install.app_id]
        if leftovers != stored:
            self._store.set_config(leftover_key, leftovers)
        if leftovers:
            threading.Thread(
                target=self._delete_leftovers,
                args=(install.configuration_token, leftover_key),
                name="slack-install-delete-previous",
                daemon=True,
            ).start()
        previous_app = "pending" if leftovers else "none"
        logger.info("slack install saved app_id={} previous_app={}", install.app_id, previous_app)
        return SlackInstallCompleteResult.model_validate(
            {"identity": identity.model_dump(mode="json"), "app_id": install.app_id, "previous_app": previous_app}
        )

    def _delete_leftovers(self, configuration_token: str, key: str) -> None:
        # Under the operation lock, so no connect rewrites the list meanwhile. The list is read here, not handed
        # over: workers can take the lock out of order, and an older one must not write back a list a newer one
        # has already changed.
        with self._operation:
            stored = self._store.get_config(key, [])
            app_ids = [app for app in stored if isinstance(app, str)] if isinstance(stored, list) else []
            kept = [app_id for app_id in app_ids if not self._delete_app(configuration_token, app_id)]
            self._store.set_config(key, kept)
        logger.info("slack previous apps deleted={} kept={}", len(app_ids) - len(kept), len(kept))

    def cancel(self) -> SlackInstallStatus:
        with self._operation:
            self._abandon()
        return SlackInstallStatus.model_validate({"state": "none"})

    def close(self) -> None:
        """Stop listening at shutdown. The app is left: there may be no network to delete it with."""
        with self._lock:
            install, self._install = self._install, None
        if install is not None:
            self._stop(install)

    def handle_callback(self, expected_state: str, query: dict[str, str]) -> bytes:
        """The page the browser shows after Slack's redirect. Nothing from the request is put into it."""
        with self._lock:
            install = self._install
            if install is None or install.state != expected_state or install.phase != "awaiting_authorization":
                return _page("This install link is no longer active. Start again from SuperClaw.")
            if not secrets.compare_digest(query.get("state", ""), install.state):
                # A stale tab or another page: refused, and the install that is waiting goes on waiting.
                logger.warning("slack install redirect refused reason=state_mismatch app_id={}", install.app_id)
                return _page("This install link is no longer active. Start again from SuperClaw.")
            if query.get("error") or not query.get("code"):
                self._fail(install, "denied")
                return _page("The install was not approved. Return to SuperClaw to try again.")
            install.phase = "exchanging"
        try:
            exchanged = self._slack(
                "oauth.v2.access",
                {
                    "client_id": install.client_id,
                    "client_secret": install.client_secret,
                    "code": query["code"],
                    "redirect_uri": install.redirect_url,
                },
            )
        except ChannelCredentialError:
            exchanged = {}
        bot_token = exchanged.get("access_token") if exchanged.get("token_type") == "bot" else None
        with self._lock:
            # Cancelled, replaced or run out during the exchange: that ending stands.
            if self._install is not install or install.phase != "exchanging":
                return _page("This install link is no longer active. Start again from SuperClaw.")
            if not exchanged.get("ok") or not isinstance(bot_token, str) or not bot_token:
                logger.warning(
                    "slack install exchange failed app_id={} slack_error={}",
                    install.app_id,
                    _slack_error(exchanged),
                )
                self._fail(install, "exchange_failed")
                return _page("Slack did not complete the install. Return to SuperClaw to try again.")
            install.bot_token = bot_token
            team = exchanged.get("team")
            team_id = team.get("id") if isinstance(team, dict) else None
            install.team_id = team_id if isinstance(team_id, str) and _TEAM_ID.fullmatch(team_id) else None
            install.phase = "awaiting_app_token"
        threading.Thread(target=self._stop_server, args=(install,), daemon=True).start()
        logger.info("slack install approved app_id={}", install.app_id)
        return _approved_page(install.app_id, install.team_id)

    def _installation(
        self,
        request: SlackInstallStartRequest,
        created: dict[str, Any],
        redirect_url: str,
        server: http.server.HTTPServer,
    ) -> _Install:
        if not created.get("ok"):
            error = _slack_error(created)
            logger.warning("slack app not created slack_error={}", error)
            if error in _TOKEN_REFUSALS:
                raise ChannelCredentialError("slack_configuration_token_rejected", slack_error=error)
            raise ChannelCredentialError("slack_app_not_created", slack_error=error)
        credentials = created.get("credentials")
        app_id = created.get("app_id")
        authorize_url = created.get("oauth_authorize_url")
        if not (
            isinstance(app_id, str)
            and _APP_ID.fullmatch(app_id)
            and isinstance(credentials, dict)
            and isinstance(credentials.get("client_id"), str)
            and isinstance(credentials.get("client_secret"), str)
            and isinstance(authorize_url, str)
            and authorize_url.startswith(_AUTHORIZE_PREFIX)
        ):
            logger.warning("slack app create answer unreadable")
            raise ChannelCredentialError("slack_app_not_created")
        return _Install(
            identity_id=request.identity_id,
            configuration_token=request.configuration_token,
            app_id=app_id,
            client_id=credentials["client_id"],
            client_secret=credentials["client_secret"],
            state=secrets.token_urlsafe(32),
            redirect_url=redirect_url,
            server=server,
            expires_at=self._clock() + self._install_seconds,
        )

    def _expire(self, install: _Install) -> None:
        with self._lock:
            if self._install is not install or install.phase in ("failed", "saving"):
                return
            self._fail(install, "expired")
        logger.info("slack install expired app_id={}", install.app_id)

    def _fail(self, install: _Install, failure: str) -> None:
        """Called with the lock held. The failure stays readable until the next start or cancel."""
        install.phase = "failed"
        install.failure = failure
        install.bot_token = None
        threading.Thread(target=self._discard, args=(install,), daemon=True).start()

    def _abandon(self) -> None:
        with self._lock:
            install, self._install = self._install, None
        if install is None:
            return
        self._stop(install)
        if install.phase != "failed":
            self._delete_app(install.configuration_token, install.app_id)

    def _discard(self, install: _Install) -> None:
        self._stop_server(install)
        self._delete_app(install.configuration_token, install.app_id)

    def _stop(self, install: _Install) -> None:
        if install.timer is not None:
            install.timer.cancel()
        install.bot_token = None
        self._stop_server(install)

    @staticmethod
    def _stop_server(install: _Install) -> None:
        try:
            install.server.shutdown()
            install.server.server_close()
        except OSError as exc:
            logger.warning("slack install listener not closed exception_type={}", type(exc).__name__)

    def _finish_app(self, install: _Install) -> None:
        """Turn Socket Mode on and add the events; the scopes are unchanged, so the install stands."""
        try:
            answer = self._slack(
                "apps.manifest.update",
                {"app_id": install.app_id, "manifest": json.dumps(slack_app_manifest(install.redirect_url))},
                bearer=install.configuration_token,
                timeout=_UPDATE_TIMEOUT_S,
            )
        except _SlackTimedOut:
            # Slack was slow, not out of reach; the user can paste again, and the update is asked for again.
            raise ChannelCredentialError("slack_app_not_finished") from None
        if not answer.get("ok") or answer.get("permissions_updated") is not False:
            logger.warning(
                "slack app not finished app_id={} slack_error={} permissions_updated={}",
                install.app_id,
                _slack_error(answer),
                answer.get("permissions_updated") is True,
            )
            raise ChannelCredentialError("slack_app_not_finished")

    def _delete_app(self, configuration_token: str, app_id: str) -> bool:
        try:
            answer = self._slack(
                "apps.manifest.delete", {"app_id": app_id}, bearer=configuration_token, timeout=_DELETE_TIMEOUT_S
            )
        except ChannelCredentialError:
            return False
        if answer.get("ok"):
            return True
        error = _slack_error(answer)
        if error in _APP_GONE:
            # Deleted in Slack already, so there is nothing left to retry.
            logger.info("slack app already gone app_id={} slack_error={}", app_id, error)
            return True
        logger.warning("slack app not deleted app_id={} slack_error={}", app_id, error)
        return False

    def _slack(
        self, method: str, fields: dict[str, str], *, bearer: str | None = None, timeout: float = _SLACK_TIMEOUT_S
    ) -> dict[str, Any]:
        headers = {"Authorization": f"Bearer {bearer}"} if bearer else {}
        try:
            with httpx.Client(transport=self._transport, timeout=timeout) as client:
                response = client.post(f"{_SLACK_API}{method}", data=fields, headers=headers)
            body = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            # The exception's own text can quote the request, so only its type is kept.
            logger.warning("slack call failed method={} exception_type={}", method, type(exc).__name__)
            if isinstance(exc, httpx.ReadTimeout):
                raise _SlackTimedOut("slack_unreachable") from None
            raise ChannelCredentialError("slack_unreachable") from None
        return body if isinstance(body, dict) else {}


class _SlackTimedOut(ChannelCredentialError):
    """Slack took the request and did not answer in time; to every other caller, unreachable."""


class _NoReuseHTTPServer(http.server.ThreadingHTTPServer):
    # Threaded so a connection the browser opens and leaves idle cannot hold up the redirect or shutdown().
    allow_reuse_address = False


class _CallbackHandler(http.server.BaseHTTPRequestHandler):
    timeout = 10

    def do_GET(self) -> None:  # noqa: N802 - http.server API
        url = urlsplit(self.path)
        if url.path != _CALLBACK_PATH:
            self.send_response(404)
            self.end_headers()
            return
        service: SlackInstallService = self.server.slack_install  # type: ignore[attr-defined]
        page = service.handle_callback(self.server.slack_state, dict(parse_qsl(url.query)))  # type: ignore[attr-defined]
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(page)

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002 - http.server API
        return


_PAGE_HEAD = (
    "<!doctype html><html><head><meta charset=utf-8><title>SuperClaw</title></head>"
    '<body style="font-family:system-ui,sans-serif;text-align:center;padding-top:5em">'
)


def _page(sentence: str) -> bytes:
    return (_PAGE_HEAD + f"<p>{sentence}</p><p>You can close this tab.</p></body></html>").encode()


def _socket_mode_url(app_id: str, team_id: str | None) -> str:
    """The app's Socket Mode page, or its Basic Information page when Slack did not name the workspace."""
    if team_id is None:
        return f"https://api.slack.com/apps/{app_id}/general"
    return f"https://app.slack.com/app-settings/{team_id}/{app_id}/socket-mode"


def _approved_page(app_id: str, team_id: str | None) -> bytes:
    """The one step left, told here because Slack's settings page does not say which token SuperClaw needs.

    ``app_id`` and ``team_id`` matched ``_APP_ID`` and ``_TEAM_ID``, so they are safe in the link.
    """
    return (
        _PAGE_HEAD
        + "<h2>SuperClaw is installed in your workspace</h2>"
        + "<p>One step left: create an app-level token so SuperClaw can connect.</p>"
        + '<ol style="display:inline-block;text-align:left;line-height:1.6">'
        + "<li>Click <b>Open Socket Mode settings</b> below (or <b>Socket Mode</b> in the app's sidebar) and turn on"
        + " <b>Enable Socket Mode</b>.</li>"
        + "<li>Give the token any name and click <b>Generate</b>. The <b>connections:write</b> scope is"
        + " already chosen.</li>"
        + "<li>Copy the token that starts with <b>xapp-</b> and paste it into SuperClaw.</li>"
        + "</ol>"
        + f'<p><a href="{_socket_mode_url(app_id, team_id)}" style="display:inline-block;'
        + "padding:0.6em 1.2em;background:#4a154b;color:#fff;border-radius:6px;text-decoration:none\">"
        + "Open Socket Mode settings</a></p>"
        + "</body></html>"
    ).encode()


def _slack_error(answer: dict[str, Any]) -> str | None:
    error = answer.get("error")
    return error if isinstance(error, str) and _SLACK_ERROR_NAME.fullmatch(error) else None


def _instant(seconds: float) -> str:
    return datetime.fromtimestamp(int(seconds), UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
