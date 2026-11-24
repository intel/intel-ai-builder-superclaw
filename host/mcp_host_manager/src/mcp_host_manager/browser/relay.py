"""Relays one client WebSocket to the host Edge's DevTools pipe, filtering every command.

The pipe is one CDP connection and one root session, which the connected client owns. The relay
adds commands of its own, with ids from `RESERVED_ID_BASE` up, and never forwards their responses.

A client reaches only the off-the-record contexts it created on this connection
(`Target.createBrowserContext`), never the default context: on a managed device that context is
signed in to Microsoft 365 through the device's Entra token. Every target, session, window and
download the client may see or name is one the relay has tied to such a context; anything else is
refused, dropped, or (for a default-context target the browser auto-attached) detached by the relay.
"""

from __future__ import annotations

import asyncio
import itertools
import json
import socket
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Protocol, cast

from loguru import logger
from starlette.websockets import WebSocket, WebSocketDisconnect, WebSocketState

from .cdp_filter import (
    RESERVED_ID_BASE,
    AskOrigin,
    BrowserPolicy,
    CdpRules,
    Decision,
    Forward,
    MalformedMessage,
    Refuse,
    ResolveHost,
    decide,
    decide_resolved,
    decision_reads_files,
    error_reply,
    parse_client_message,
    url_scheme,
)

AuditFn = Callable[..., None]
Resolver = Callable[[str], Awaitable[list[str]]]

CLOSE_POLICY_VIOLATION = 1008
CLOSE_GOING_AWAY = 1001
CLOSE_MESSAGE_TOO_BIG = 1009
CLOSE_INTERNAL_ERROR = 1011
MAX_WAITING_DECISIONS = 16
# Context creations one client may have waiting on Edge; Playwright makes one at a time.
MAX_PENDING_CONTEXT_CREATIONS = 4
# Disposed contexts whose targets' teardown events still reach the client.
_RETIRED_CONTEXTS_KEPT = 4
# Client commands one connection may have waiting on Edge's answer.
MAX_IN_FLIGHT_REQUESTS = 256
# Ids on the pipe. A client's own are below RESERVED_ID_BASE and never reach Edge: the relay's own
# commands use [RESERVED_ID_BASE, WIRE_ID_BASE), and each forwarded client command a wire id from
# [WIRE_ID_BASE, _ID_LIMIT), unique on the pipe, so an answer pairs with the connection that asked.
# Chromium reads an id as a signed 32-bit int.
WIRE_ID_BASE = RESERVED_ID_BASE + 2**29
_ID_LIMIT = 2**31
_RESOLVE_TIMEOUT_S = 5.0
# What a client may send on the root (browser) session. The browser target's other commands, such
# as `Fetch.enable` or `Security.setIgnoreCertificateErrors`, act on every context, the default too.
_ROOT_METHODS = frozenset({
    "Browser.getVersion",
    "Browser.setDownloadBehavior",
    "Browser.cancelDownload",
    "Browser.resetPermissions",
    "Browser.getWindowForTarget",
    "Browser.getWindowBounds",
    "Browser.setWindowBounds",
    "Target.createBrowserContext",
    "Target.disposeBrowserContext",
    "Target.getBrowserContexts",
    "Target.createTarget",
    "Target.attachToTarget",
    "Target.activateTarget",
    "Target.closeTarget",
    "Target.getTargetInfo",
    "Target.getTargets",
    "Target.detachFromTarget",
    "Target.sendMessageToTarget",
    "Target.setAutoAttach",
    "Target.setDiscoverTargets",
})
# Commands that act on the default context when they name no `browserContextId`, on any session.
_CONTEXT_METHODS = frozenset({
    "Browser.setDownloadBehavior",
    "Browser.cancelDownload",
    "Browser.grantPermissions",
    "Browser.resetPermissions",
    "Browser.setPermission",
    "Storage.getCookies",
    "Storage.setCookies",
    "Storage.clearCookies",
    "Target.createTarget",
    "Target.disposeBrowserContext",
})


class MessageTooLarge(Exception):
    """The browser sent a CDP message over the size cap; the pipe can no longer be trusted to frame."""


class TransportFull(Exception):
    """The queue to the browser holds its byte cap; the client is sending faster than Edge reads."""


async def resolve_host(host: str) -> list[str]:
    """Every address `host` resolves to (in the executor, not the loop); empty when it does not resolve in time."""
    try:
        infos = await asyncio.wait_for(
            asyncio.get_running_loop().getaddrinfo(host.strip("[]"), None, type=socket.SOCK_STREAM),
            _RESOLVE_TIMEOUT_S,
        )
    except (OSError, TimeoutError, UnicodeError):
        return []
    return [str(info[4][0]) for info in infos]


class OriginApprover(Protocol):
    async def request_origin(self, origin: str) -> bool: ...


class CdpTransport(Protocol):
    def send(self, message: str, *, bounded: bool = True) -> None:
        """Queue a message for the browser. A bounded send raises TransportFull at the byte cap."""
        ...

    async def receive(self) -> str | None:
        """The next message from the browser, or None once the pipe has closed. Raises MessageTooLarge."""
        ...


@dataclass(frozen=True)
class _Request:
    """What the relay keeps of a forwarded client command until Edge answers it: never its payload."""

    key: tuple[str | None, int]
    method: str
    context: str | None
    target: str | None


def _request(message: dict[str, object]) -> _Request:
    params = message.get("params")
    params = params if isinstance(params, dict) else {}
    context, target = params.get("browserContextId"), params.get("targetId")
    return _Request(
        key=_message_key(message),
        method=str(message["method"]),
        context=context if isinstance(context, str) else None,
        target=target if isinstance(target, str) else None,
    )


class CdpRelay:
    def __init__(
        self,
        transport: CdpTransport,
        *,
        rules: CdpRules,
        policy: Callable[[], BrowserPolicy],
        approvals: OriginApprover,
        audit: AuditFn,
        resolve: Resolver = resolve_host,
    ) -> None:
        self._transport = transport
        self._rules = rules
        self._policy = policy
        self._approvals = approvals
        self._audit = audit
        self._resolve = resolve
        self._ids = itertools.count(RESERVED_ID_BASE)
        self._pending: dict[int, asyncio.Future[dict[str, object]]] = {}
        self._client: WebSocket | None = None
        self._send_lock = asyncio.Lock()
        # The client's sessions (to its contexts' targets only), by session id.
        self._session_targets: dict[str, str] = {}
        self._closed_targets: set[str] = set()
        self._off_limits: set[str] = set()
        # Each client command taken and not yet answered, by the client's (session, id).
        self._in_flight: dict[tuple[str | None, int], _Request] = {}
        # The same commands once forwarded, by the wire id Edge answers under.
        self._wire: dict[int, _Request] = {}
        self._wire_ids = itertools.count(WIRE_ID_BASE)
        self._default_context: str | None = None
        # Contexts this client created and whose downloads are locked: the only ones it may use.
        self._client_contexts: set[str] = set()
        # Every target the relay has seen, with its browser context (None when Edge named none).
        self._target_contexts: dict[str, str | None] = {}
        self._client_windows: set[int] = set()
        self._client_frames: set[str] = set()
        self._client_downloads: set[str] = set()
        # Contexts the client disposed, oldest first: no longer its to use, but its targets'
        # teardown events still reach it. Only the last few are kept.
        self._retired_contexts: dict[str, None] = {}
        self._waiting_decisions: set[asyncio.Task[None]] = set()
        self._background: set[asyncio.Task[None]] = set()
        # The current client's context creations still waiting on Edge.
        self._creations: set[asyncio.Task[None]] = set()
        self._finished = asyncio.Event()

    @property
    def finished(self) -> bool:
        return self._finished.is_set()

    def detach_client(self) -> WebSocket | None:
        """Stop relaying to and from the client at once; the caller closes it."""
        client, self._client = self._client, None
        return client

    async def run(self) -> int:
        """Pump browser messages until the pipe closes; the close code the client should get.

        The client is left open: the owner closes it only after Edge is disposed, so a client that
        reconnects on the close never finds the old Edge still being torn down.
        """
        close_code = CLOSE_GOING_AWAY
        try:
            while (raw := await self._transport.receive()) is not None:
                await self._on_browser_message(raw)
        except MessageTooLarge:
            logger.error("host browser sent a CDP message over the size cap; dropping the connection")
            self._audit("browser_message_too_large")
            close_code = CLOSE_MESSAGE_TOO_BIG
        finally:
            self._finished.set()
            for future in self._pending.values():
                if not future.done():
                    future.set_exception(ConnectionError("browser pipe closed"))
            self._pending.clear()
        return close_code

    def inject(
        self,
        method: str,
        params: dict[str, object] | None = None,
        *,
        session_id: str | None = None,
        bounded: bool = False,
    ) -> int:
        """Send a relay command. `bounded` is for one a client caused: it raises TransportFull at the
        pipe's byte cap like the client's own traffic, instead of queueing past it."""
        message_id = next(self._ids)
        if message_id >= WIRE_ID_BASE:
            self._ids = itertools.count(RESERVED_ID_BASE)
            message_id = next(self._ids)
        message: dict[str, object] = {"id": message_id, "method": method}
        if params is not None:
            message["params"] = params
        if session_id is not None:
            message["sessionId"] = session_id
        self._transport.send(json.dumps(message), bounded=bounded)
        return message_id

    async def command(
        self, method: str, params: dict[str, object] | None = None, *, timeout: float = 10.0, bounded: bool = False
    ) -> dict[str, object]:
        if self._finished.is_set():
            raise ConnectionError("browser pipe closed")
        future: asyncio.Future[dict[str, object]] = asyncio.get_running_loop().create_future()
        message_id = self.inject(method, params, bounded=bounded)
        self._pending[message_id] = future
        try:
            return await asyncio.wait_for(future, timeout)
        finally:
            self._pending.pop(message_id, None)

    async def serve(self, websocket: WebSocket) -> None:
        """Run one accepted client until it disconnects, misbehaves, or the browser goes away."""
        if self._finished.is_set():
            await _close_quietly(websocket, CLOSE_GOING_AWAY)
            return
        self._client = websocket
        try:
            if not await self._lock_default_context():
                await _close_quietly(websocket, CLOSE_INTERNAL_ERROR)
                return
            while True:
                try:
                    frame = await websocket.receive()
                except (WebSocketDisconnect, RuntimeError):
                    break
                if frame["type"] == "websocket.disconnect" or self._client is not websocket:
                    break
                text = frame.get("text")
                if text is None:
                    data = frame.get("bytes") or b""
                    text = data.decode("utf-8", errors="replace")
                try:
                    message = parse_client_message(text)
                except MalformedMessage:
                    await _close_quietly(websocket, CLOSE_POLICY_VIOLATION)
                    break
                try:
                    await self._on_client_message(websocket, message, text)
                except TransportFull:
                    await self._close_overloaded(websocket)
                    break
        finally:
            self._client = None
            for task in self._waiting_decisions:
                task.cancel()
            self._waiting_decisions.clear()
            if not self._finished.is_set():
                self._release_client_state()

    async def _lock_default_context(self) -> bool:
        """Point the default context's downloads at the downloads folder before any client command."""
        downloads = str(self._policy().downloads_dir)
        try:
            await self.command("Browser.setDownloadBehavior", {"behavior": "allow", "downloadPath": downloads})
            contexts = await self.command("Target.getBrowserContexts")
        except (ConnectionError, TimeoutError) as error:
            logger.error("host browser download lock failed: {}", type(error).__name__)
            return False
        default = contexts.get("defaultBrowserContextId")
        if not isinstance(default, str) or not default:
            logger.error("host browser did not name its default context; refusing the client")
            self._audit("browser_default_context_unknown")
            return False
        self._default_context = default
        return True

    async def _on_client_message(self, websocket: WebSocket, message: dict[str, object], raw: str) -> None:
        method = str(message["method"])
        key = _message_key(message)
        if key in self._in_flight:
            # Answering it would give the client two replies to one id; its first command is untouched.
            self._audit("browser_cdp_blocked", method=method, reason="duplicate_id")
            await self._send_to(websocket, json.dumps(error_reply(message)))
            return
        if len(self._in_flight) >= MAX_IN_FLIGHT_REQUESTS:
            self._audit("browser_cdp_blocked", method=method, reason="too_many_in_flight")
            await self._send_to(websocket, json.dumps(error_reply(message)))
            return
        self._in_flight[key] = _request(message)
        reason = self._stateful_refusal(message)
        if reason == "default_context" and method == "Browser.setDownloadBehavior":
            # Playwright's connectOverCDP sets the default context's downloads and does not connect
            # if that fails. The relay locked them already, so this is answered and never sent.
            self._in_flight.pop(key, None)
            self._audit("browser_cdp_absorbed", method=method, reason=reason)
            reply: dict[str, object] = {"id": message["id"], "result": {}}
            if "sessionId" in message:
                reply["sessionId"] = message["sessionId"]
            await self._send_to(websocket, json.dumps(reply))
            return
        if reason:
            await self._carry_out(websocket, message, raw, Refuse("browser_cdp_blocked", {"method": method, "reason": reason}))
            return
        if decision_reads_files(message):
            # Awaited before the next frame is read, so this client's messages keep their order.
            decision = await asyncio.to_thread(decide, message, self._rules, self._policy())
        else:
            decision = decide(message, self._rules, self._policy())
        if isinstance(decision, (Forward, Refuse)):
            await self._carry_out(websocket, message, raw, decision)
            return
        if len(self._waiting_decisions) >= MAX_WAITING_DECISIONS:
            refusal = Refuse("browser_navigation_blocked", {"method": method, "reason": "too_many_pending"})
            await self._carry_out(websocket, message, raw, refusal)
            return
        task = asyncio.create_task(self._settle(websocket, message, raw, decision))
        self._waiting_decisions.add(task)
        task.add_done_callback(self._waiting_decisions.discard)

    def _stateful_refusal(self, message: dict[str, object]) -> str | None:
        """Refusals that depend on what the relay has seen, which the stateless filter cannot know."""
        method = str(message["method"])
        if "sessionId" in message and not self._is_client_session(message["sessionId"]):
            return "session_not_client_context"
        if self._reaches_off_limits_target(message):
            return "browser_ui_target"
        if "sessionId" not in message and method not in _ROOT_METHODS:
            return "browser_level_method"
        params = message.get("params")
        params = params if isinstance(params, dict) else {}
        if method == "Browser.getWindowForTarget" and "sessionId" not in message and "targetId" not in params:
            # On the root session it would name no client target, and its window must not be learned.
            return "target_not_client_context"
        reason = self._names_foreign(method, params)
        if reason is None and method == "Target.sendMessageToTarget" and isinstance(params.get("message"), str):
            try:
                inner = parse_client_message(params["message"])
            except MalformedMessage:
                return None  # the filter refuses it
            if "sessionId" in inner:
                # The envelope's sessionId or targetId names where it goes; one inside would route
                # on to a session the relay never checked, the client's own or not.
                return "wrapped_session"
            if self._reaches_off_limits_target(inner):
                return "browser_ui_target"
            inner_params = inner.get("params")
            reason = self._names_foreign(str(inner["method"]), inner_params if isinstance(inner_params, dict) else {})
        return reason

    def _names_foreign(self, method: str, params: dict[str, object]) -> str | None:
        """Why the command reaches beyond the client's own contexts: by naming the default context
        (a context method with no `browserContextId` means it), or any context, target, session or
        window the relay has not tied to one of them."""
        if method in _CONTEXT_METHODS or "browserContextId" in params:
            context = params.get("browserContextId")
            if context is None or context == self._default_context:
                return "default_context"
            if not isinstance(context, str) or context not in self._client_contexts:
                return "context_not_client_created"
        if "targetId" in params and not self._is_client_target(params["targetId"]):
            return "target_not_client_context"
        if "sessionId" in params and not self._is_client_session(params["sessionId"]):
            return "session_not_client_context"
        window = params.get("windowId")
        if "windowId" in params and (not isinstance(window, int) or window not in self._client_windows):
            return "window_not_client_context"
        return None

    def _is_client_target(self, target: object) -> bool:
        return isinstance(target, str) and self._target_contexts.get(target) in self._client_contexts

    def _is_client_session(self, session: object) -> bool:
        return isinstance(session, str) and session in self._session_targets

    async def _close_overloaded(self, websocket: WebSocket) -> None:
        logger.warning("host browser client outran the pipe to Edge; closing it")
        self._audit("browser_client_overloaded")
        await _close_quietly(websocket, CLOSE_MESSAGE_TOO_BIG)

    def _next_wire_id(self) -> int:
        """A wire id no forwarded command is waiting under; the range is reused once it runs out."""
        while True:
            wire = next(self._wire_ids)
            if wire >= _ID_LIMIT:
                self._wire_ids = itertools.count(WIRE_ID_BASE)
                continue
            if wire not in self._wire:
                return wire

    async def _close_overloaded_owner(self, owner: WebSocket) -> None:
        """Close the client whose command found the pipe full, if it is still the client."""
        if self._client is owner:
            await self._close_overloaded(owner)

    async def _settle(
        self, websocket: WebSocket, message: dict[str, object], raw: str, pending: AskOrigin | ResolveHost
    ) -> None:
        """Finish a decision that waits on DNS or the user, without holding up other messages."""
        decision: Decision = pending
        if isinstance(decision, ResolveHost):
            decision = decide_resolved(decision, await self._resolve(decision.host), self._policy().origins)
        if isinstance(decision, AskOrigin):
            try:
                approved = await self._approvals.request_origin(decision.origin)
            except Exception as error:  # noqa: BLE001 - any approver failure is a refusal
                logger.warning("host browser origin approval failed: {}", type(error).__name__)
                approved = False
            decision = (
                Forward()
                if approved
                else Refuse("browser_navigation_blocked", {"method": str(message["method"]), "origin": decision.origin})
            )
        if self._client is websocket and isinstance(decision, (Forward, Refuse)):
            try:
                await self._carry_out(websocket, message, raw, decision)
            except TransportFull:
                await self._close_overloaded(websocket)

    async def _carry_out(
        self, websocket: WebSocket, message: dict[str, object], raw: str, decision: Forward | Refuse
    ) -> None:
        if isinstance(decision, Forward) and message["method"] == "Target.createBrowserContext":
            if len(self._creations) < MAX_PENDING_CONTEXT_CREATIONS:
                task = asyncio.create_task(self._create_context(websocket, message))
                creations = self._creations
                for tracked in (self._background, creations):
                    tracked.add(task)
                    task.add_done_callback(tracked.discard)
                return
            decision = Refuse("browser_cdp_blocked", {"method": "Target.createBrowserContext", "reason": "too_many_pending"})
        if isinstance(decision, Forward):
            payload = message if decision.message is None else decision.message
            wire = self._next_wire_id()
            self._wire[wire] = self._in_flight.get(_message_key(message)) or _request(message)
            try:
                self._transport.send(json.dumps({**payload, "id": wire}))
            except TransportFull:
                self._wire.pop(wire, None)
                raise
            return
        self._in_flight.pop(_message_key(message), None)
        self._audit(decision.event, **decision.fields)
        await self._send_to(websocket, json.dumps(error_reply(message)))

    def _release_client_state(self) -> None:
        """Undo what a departed client left attached, so the browser is usable by the next one, and
        dispose of its contexts: the next client gets none of them."""
        for session_id in list(self._session_targets):
            self.inject("Target.detachFromTarget", {"sessionId": session_id})
        self.inject("Target.setAutoAttach", {"autoAttach": False, "waitForDebuggerOnStart": False})
        self.inject("Target.setDiscoverTargets", {"discover": False})
        for context in sorted(self._client_contexts):
            self.inject("Target.disposeBrowserContext", {"browserContextId": context})
        self._forget_targets_of({*self._client_contexts, *self._retired_contexts})
        self._retired_contexts.clear()
        self._in_flight.clear()
        # A late answer to one of its commands now pairs with nothing and is dropped.
        self._wire.clear()
        # Its creations still waiting finish on their own and dispose of what they create.
        self._creations = set()
        self._session_targets.clear()
        self._client_contexts.clear()
        self._client_windows.clear()
        self._client_frames.clear()
        self._client_downloads.clear()

    async def _on_browser_message(self, raw: str) -> None:
        try:
            message = json.loads(raw)
        except (ValueError, RecursionError):
            logger.warning("host browser sent a message that is not JSON")
            return
        if not isinstance(message, dict):
            return
        message_id = message.get("id")
        if isinstance(message_id, int) and message_id >= WIRE_ID_BASE:
            request = self._wire.pop(message_id, None)
            if request is None or message.get("sessionId") != request.key[0]:
                # An answer for a client that has left (or that names another session): no client gets it.
                result = message.get("result")
                if isinstance(result, dict):
                    self._dispose_unowned(result.get("browserContextId"))
                return
            self._in_flight.pop(request.key, None)
            message, raw = _with_client_id(message, raw, message_id, request.key[1])
            answer = self._answer(message, raw, request)
            client = self._client
            if answer is not None and client is not None:
                await self._send_to(client, answer)
            return
        if isinstance(message_id, int) and message_id >= RESERVED_ID_BASE:
            future = self._pending.get(message_id) if "sessionId" not in message else None
            result = message.get("result")
            if future is not None and not future.done():
                if "error" in message or not isinstance(result, dict):
                    future.set_exception(ConnectionError("browser refused a relay command"))
                else:
                    future.set_result(result)
            elif isinstance(result, dict):
                # Nobody waits for it any more (a creation that timed out, say).
                self._dispose_unowned(result.get("browserContextId"))
            return
        if isinstance(message.get("method"), str):
            if not self._observe(message):
                return
        elif isinstance(message_id, int):
            # A client id: the relay never sends one, so this answers nothing anyone sent.
            self._answer(message, raw, None)
            return
        else:
            return
        client = self._client
        if client is not None:
            await self._send_to(client, raw)

    def _answer(self, message: dict[str, object], raw: str, request: _Request | None) -> str | None:
        """The answer the client gets, read with the request it answers: as sent, filtered, or None
        (an answer to nothing this client sent)."""
        result = message.get("result")
        if isinstance(result, dict) and "browserContextId" in result:
            # Only Target.createBrowserContext answers with one, and the relay sends that under its
            # own ids (_create_context), so this context belongs to no client.
            self._dispose_unowned(result["browserContextId"])
            return None if request is None else json.dumps(error_reply(message))
        if request is None:
            return None
        if "error" in message or not isinstance(result, dict):
            return raw
        method = request.method
        # The request's context or target was checked to be the client's before it was sent.
        context, target = request.context, request.target
        if method == "Target.createTarget" and isinstance(result.get("targetId"), str) and context is not None:
            self._target_contexts[result["targetId"]] = context
        elif method == "Target.attachToTarget" and isinstance(result.get("sessionId"), str) and target is not None:
            self._session_targets[result["sessionId"]] = target
        elif (
            method == "Browser.getWindowForTarget"
            and isinstance(result.get("windowId"), int)
            and (self._is_client_target(target) or self._is_client_session(request.key[0]))
        ):
            self._client_windows.add(result["windowId"])
        elif method == "Target.getTargets" and isinstance(result.get("targetInfos"), list):
            infos = [info for info in result["targetInfos"] if isinstance(info, dict) and self._learn_target(info)]
            return json.dumps({**message, "result": {**result, "targetInfos": infos}})
        elif method == "Target.getBrowserContexts":
            listed = result.get("browserContextIds")
            ids = [item for item in listed if isinstance(item, str) and item in self._client_contexts] if isinstance(listed, list) else []
            return json.dumps({**message, "result": {"browserContextIds": ids}})
        elif method == "Target.getTargetInfo":
            info = result.get("targetInfo")
            if not isinstance(info, dict) or (info.get("type") != "browser" and not self._learn_target(info)):
                return json.dumps(error_reply(message))
        elif method == "Target.disposeBrowserContext" and context in self._client_contexts:
            self._retire_context(cast(str, context))
        return raw

    def _retire_context(self, context: str) -> None:
        """A context the client disposed is no longer its own: nothing may name it again, and the
        release does not dispose of it twice. Its targets' teardown events, which Edge sends around
        the disposal, still reach the client until it is among the oldest retired ones."""
        self._client_contexts.discard(context)
        self._retired_contexts[context] = None
        while len(self._retired_contexts) > _RETIRED_CONTEXTS_KEPT:
            oldest = next(iter(self._retired_contexts))
            del self._retired_contexts[oldest]
            self._forget_targets_of({oldest})

    def _forget_targets_of(self, contexts: set[str]) -> None:
        gone = {target for target, context in self._target_contexts.items() if context in contexts}
        for target in gone:
            del self._target_contexts[target]
        self._off_limits -= gone
        self._closed_targets -= gone

    def _learn_target(self, info: dict[str, object]) -> bool:
        """Record the target's context from its `TargetInfo`; whether it is one of the client's."""
        target = info.get("targetId")
        if not isinstance(target, str):
            return False
        context = info.get("browserContextId")
        self._target_contexts[target] = context if isinstance(context, str) else None
        return self._is_client_target(target)

    async def _create_context(self, owner: WebSocket, message: dict[str, object]) -> None:
        """Create the client's context under the relay's own id, so Edge's answer pairs with this
        connection whatever ids a later client reuses; lock its downloads, and only then answer.

        A context whose client left meanwhile, or whose lock failed, is disposed: no client gets it.
        Both commands are sent bounded, as the client's own traffic is: a pipe at its byte cap closes
        the client with 1009.
        """
        params = message.get("params")
        try:
            created = await self.command(
                "Target.createBrowserContext", params if isinstance(params, dict) else None, bounded=True
            )
        except TransportFull:
            await self._close_overloaded_owner(owner)
            return
        except (ConnectionError, TimeoutError):
            created = {}
        context = created.get("browserContextId")
        locked = False
        if isinstance(context, str) and context and context != self._default_context:
            lock = {"behavior": "allow", "downloadPath": str(self._policy().downloads_dir), "browserContextId": context}
            try:
                await self.command("Browser.setDownloadBehavior", lock, bounded=True)
            except TransportFull:
                if not self._finished.is_set():
                    self.inject("Target.disposeBrowserContext", {"browserContextId": context})
                await self._close_overloaded_owner(owner)
                return
            except (ConnectionError, TimeoutError):
                self._audit("browser_context_refused", reason="download_lock_failed")
            else:
                locked = True
        else:
            self._audit("browser_context_refused", reason="create_failed")
            context = None
        current = self._client is owner
        if current:
            self._in_flight.pop(_message_key(message), None)
        if locked and current:
            self._client_contexts.add(cast(str, context))
            reply: dict[str, object] = {"id": message["id"], "result": {"browserContextId": context}}
            if "sessionId" in message:
                reply["sessionId"] = message["sessionId"]
            await self._send_to(owner, json.dumps(reply))
            return
        if context is not None and not self._finished.is_set():
            self.inject("Target.disposeBrowserContext", {"browserContextId": context})
        if current:
            await self._send_to(owner, json.dumps(error_reply(message)))

    def _dispose_unowned(self, context: object) -> None:
        """Dispose of a context an answer names that no one asked for, unless it is in use."""
        if not isinstance(context, str) or not context or self._finished.is_set():
            return
        if context == self._default_context or context in self._client_contexts:
            return
        self._audit("browser_context_disposed", reason="unowned")
        self.inject("Target.disposeBrowserContext", {"browserContextId": context})

    def _observe(self, event: dict[str, object]) -> bool:
        """Record what a browser event says about targets; whether the client may see it.

        Only events about the client's own contexts pass: on its sessions, or Target and download
        events at the root that name its targets. Every other root event is dropped.
        """
        method = event["method"]
        session = event.get("sessionId")
        if "sessionId" in event and not self._is_client_session(session):
            return False
        params = event.get("params")
        params = params if isinstance(params, dict) else {}
        if method == "Target.attachedToTarget":
            return self._on_attached(params, session if isinstance(session, str) else None)
        if method == "Target.detachedFromTarget":
            child = params.get("sessionId")
            return self._is_client_session(child) and self._session_targets.pop(cast(str, child), None) is not None
        if method in ("Target.targetInfoChanged", "Target.targetCreated"):
            info = params.get("targetInfo")
            if not isinstance(info, dict) or not self._learn_target(info):
                return False
            self._check_target(cast(str, info["targetId"]), info.get("url"), is_page=info.get("type") == "page")
            return True
        if method in ("Target.targetDestroyed", "Target.targetCrashed"):
            target_id = params.get("targetId")
            visible = self._is_client_target(target_id) or (
                isinstance(target_id, str) and self._target_contexts.get(target_id) in self._retired_contexts
            )
            if method == "Target.targetDestroyed" and isinstance(target_id, str):
                self._closed_targets.discard(target_id)
                self._off_limits.discard(target_id)
                self._target_contexts.pop(target_id, None)
            return visible
        if method == "Target.receivedMessageFromTarget":
            return self._is_client_session(params.get("sessionId"))
        if method == "Browser.downloadWillBegin":
            frame = params.get("frameId")
            guid = params.get("guid")
            if not (isinstance(frame, str) and (frame in self._client_frames or self._is_client_target(frame))):
                return False
            if isinstance(guid, str):
                self._client_downloads.add(guid)
            return True
        if method == "Browser.downloadProgress":
            guid = params.get("guid")
            return isinstance(guid, str) and guid in self._client_downloads
        if not isinstance(session, str):
            return False
        if method == "Page.frameAttached" and isinstance(params.get("frameId"), str):
            self._client_frames.add(params["frameId"])
        elif method == "Page.frameNavigated":
            frame = params.get("frame")
            if isinstance(frame, dict) and isinstance(frame.get("id"), str):
                self._client_frames.add(frame["id"])
            if isinstance(frame, dict) and "parentId" not in frame:
                target_id = self._session_targets.get(session) or frame.get("id")
                if isinstance(target_id, str):
                    self._check_target(target_id, frame.get("url"), is_page=True)
        return True

    def _on_attached(self, params: dict[str, object], parent: str | None) -> bool:
        """A session to a client target becomes the client's; any other is detached by the relay.

        A default-context target the browser auto-attached may be paused waiting for a debugger
        that will never come, so it is resumed before it is detached.
        """
        info = params.get("targetInfo")
        child = params.get("sessionId")
        if not isinstance(child, str):
            return False
        if isinstance(info, dict) and self._learn_target(info):
            target_id = cast(str, info["targetId"])
            self._session_targets[child] = target_id
            self._check_target(target_id, info.get("url"), is_page=info.get("type") == "page")
            return True
        if params.get("waitingForDebugger") is True:
            self.inject("Runtime.runIfWaitingForDebugger", session_id=child)
        self.inject("Target.detachFromTarget", {"sessionId": child}, session_id=parent)
        return False

    def _check_target(self, target_id: str, url: object, *, is_page: bool) -> None:
        """A target on a blocked scheme (browser UI, an extension) is put out of the client's reach.

        Some of them cannot be closed (the download flyout reports success and stays), so every
        session to it is detached and the client may not attach again or send it anything.
        """
        scheme = url_scheme(url) if isinstance(url, str) else None
        if scheme is None or scheme not in self._rules.blocked_everywhere:
            return
        self._off_limits.add(target_id)
        for session_id, session_target in list(self._session_targets.items()):
            if session_target == target_id:
                self.inject("Target.detachFromTarget", {"sessionId": session_id})
                self._audit("browser_target_detached", scheme=scheme)
        if is_page and target_id not in self._closed_targets:
            self._closed_targets.add(target_id)
            self.inject("Target.closeTarget", {"targetId": target_id})
            self._audit("browser_target_closed", scheme=scheme)

    def _reaches_off_limits_target(self, message: dict[str, object]) -> bool:
        if message["method"] == "Target.detachFromTarget":
            return False
        params = message.get("params")
        params = params if isinstance(params, dict) else {}
        sessions = (message.get("sessionId"), params.get("sessionId"))
        targets = {self._session_targets.get(session) for session in sessions if isinstance(session, str)}
        targets.add(params.get("targetId") if isinstance(params.get("targetId"), str) else None)
        return bool(targets & self._off_limits)

    async def _send_to(self, websocket: WebSocket, text: str) -> None:
        async with self._send_lock:
            if websocket.application_state != WebSocketState.CONNECTED:
                return
            try:
                await websocket.send_text(text)
            except (WebSocketDisconnect, RuntimeError, OSError) as error:
                logger.debug("host browser client send failed: {}", type(error).__name__)


def _message_key(message: dict[str, object]) -> tuple[str | None, int]:
    session = message.get("sessionId")
    return (session if isinstance(session, str) else None, cast(int, message["id"]))


def _with_client_id(message: dict[str, object], raw: str, wire: int, client_id: int) -> tuple[dict[str, object], str]:
    """The answer under the client's id. Chromium writes `{"id":N,` first, so its bytes are kept and
    only that prefix replaced; anything else is serialized again."""
    restored = {**message, "id": client_id}
    prefix = f'{{"id":{wire},'
    if raw.startswith(prefix):
        return restored, f'{{"id":{client_id},' + raw[len(prefix) :]
    return restored, json.dumps(restored)


async def close_quietly(websocket: WebSocket, code: int, reason: str | None = None) -> None:
    await _close_quietly(websocket, code, reason)


async def _close_quietly(websocket: WebSocket, code: int, reason: str | None = None) -> None:
    if WebSocketState.DISCONNECTED in (websocket.application_state, websocket.client_state):
        return
    try:
        await websocket.close(code=code, reason=reason)
    except (WebSocketDisconnect, RuntimeError, OSError) as error:
        logger.debug("host browser client close failed: {}", type(error).__name__)
