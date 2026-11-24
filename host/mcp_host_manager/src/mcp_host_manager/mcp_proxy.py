"""The gateway core: registered servers, their processes, and every runtime JSON-RPC message.

The runtime sees each host server as a remote MCP at ``/mcp-host/mcp/{name}``. ``initialize`` and
``tools/list`` are answered from the stdio server this gateway started; ``tools/call`` is decided
here first: a locked session is refused, a standing grant or the ``auto`` policy lets it through,
anything else waits for the user. Resources and prompts are listed as empty and never proxied:
``resources/read`` or ``prompts/get`` would reach the server without an approval.

A ``tools/call`` that carries a progress token from a client that accepts SSE is streamed
(``stream_call``): a progress notification every keepalive interval keeps the MCP SDK's 60 s
request timer from firing, so the call may wait 10 minutes for the user and then run as long. Any
other ``tools/call`` is answered as JSON and waits at most the no-progress budget. Every call in
flight is tracked by (server, JSON-RPC id), so a client's ``notifications/cancelled`` or a dropped
stream cancels it: a held approval is settled as cancelled and the call is never forwarded, and a
forwarded call is cancelled at the server.
"""

from __future__ import annotations

import asyncio
import hmac
import json
import secrets
import time
from collections.abc import AsyncIterator, Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from itertools import count
from pathlib import Path

from contracts.host_mcp_api_data import HOST_MCP_CALL_REFUSAL_TEXT
from loguru import logger

from . import __version__
from .approval_broker import ApprovalBroker, display_text
from .audit import AuditLog
from .errors import RULES
from .policy import annotations_from_tool, is_read_only, needs_approval, offered_scopes
from .registry import Registry, ServerRecord
from .stdio_host import (
    STARTUP_TIMEOUT_S,
    JsonRpcError,
    RequestCancelled,
    ServerUnavailable,
    StdioServer,
)

SUPPORTED_PROTOCOL_VERSIONS = ("2025-06-18", "2025-03-26", "2024-11-05")
LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0]
FORWARD_TIMEOUT_S = 120.0
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603
_EMPTY_LISTS = {
    "resources/list": "resources",
    "resources/templates/list": "resourceTemplates",
    "prompts/list": "prompts",
}
_BEARER = "Bearer "
_UNKNOWN_SERVER_TOKEN = secrets.token_urlsafe(32)
# windows-mcp yields to the user ~10 s after any physical input (the approval click, typing the chat
# message, touching the mouse), so any forwarded call can fail with these; it is sent again after
# the wait, up to user_control_retries_max times.
_YIELD_CODES = ("USER_CONTROL", "TAKEOVER_PENDING")
_YIELD_WAIT_MAX_S = 15.0
_YIELD_MARGIN_S = 0.5
_RETRY_BUDGET_S = 55.0
LONG_CALL_S: float = RULES["approval_timeout_ms"] / 1000
KEEPALIVE_S: float = RULES["progress_keepalive_ms"] / 1000
NO_PROGRESS_APPROVAL_S: float = RULES["no_progress_approval_timeout_ms"] / 1000
IDLE_STOP_S: float = RULES["idle_stop_ms"] / 1000
_PHASE_MESSAGES = {
    "starting": "Starting on the user's computer",
    "approval": "Waiting for the user to approve this on their computer",
    "running": "Running on the user's computer",
    "waiting": "Waiting for the user to let go of the mouse and keyboard",
}
# How each phase is listed in status.active_calls.
_PHASE_STATES = {
    "starting": "running",
    "approval": "awaiting_approval",
    "running": "running",
    "waiting": "waiting_for_user",
}
_USER_CONTROL_RETRIES: int = RULES["user_control_retries_max"]
_ACTIVE_CALLS_MAX: int = RULES["active_calls_max"]


class ServerLimitReached(Exception):
    pass


class ServerPaused(ServerUnavailable):
    """Stop-all paused the gateway: no server starts until resume."""


@dataclass
class InFlightCall:
    """A ``tools/call`` between its arrival and its answer. ``streamed`` calls are kept alive by
    progress notifications and get the long budget; the rest get the no-progress one.

    ``cancelled`` is set by either kind of cancel (the client's, or the user's from the UI, which
    also sets ``cancelled_by_user``); ``wake`` ends a USER_CONTROL wait early when it is."""

    server: str
    request_id: object
    streamed: bool
    tool: str = ""
    call_id: str = field(default_factory=lambda: "hcall_" + secrets.token_urlsafe(12))
    order: int = 0
    phase: str = "starting"
    cancelled: bool = False
    cancelled_by_user: bool = False
    approval_id: str | None = None
    forwarded: tuple[StdioServer, int] | None = None
    resume_at: float | None = None
    wake: asyncio.Event = field(default_factory=asyncio.Event)


def progress_token(message: object) -> str | int | None:
    """The progress token of a ``tools/call`` request, when it has a usable one."""
    if not isinstance(message, dict) or message.get("method") != "tools/call":
        return None
    request_id = message.get("id")
    if isinstance(request_id, bool) or not isinstance(request_id, (str, int)):
        return None
    params = message.get("params")
    meta = params.get("_meta") if isinstance(params, dict) else None
    token = meta.get("progressToken") if isinstance(meta, dict) else None
    if isinstance(token, bool) or not isinstance(token, (str, int)):
        return None
    return token


def rpc_error(request_id: object, code: int, message: str) -> dict[str, object]:
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


def _rpc_result(request_id: object, result: object) -> dict[str, object]:
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def refusal_result(reason: str) -> dict[str, object]:
    return {"content": [{"type": "text", "text": HOST_MCP_CALL_REFUSAL_TEXT[reason]}], "isError": True}


def _tool_title(tool: dict[str, object]) -> str | None:
    annotations = tool.get("annotations")
    title = annotations.get("title") if isinstance(annotations, dict) else None
    if not isinstance(title, str) or not title:
        title = tool.get("title")
    return title if isinstance(title, str) and title else None


def _yield_wait_s(result: object) -> float | None:
    """The ``wait_seconds`` of an error tool result in which the server says it yielded the desktop
    to the user, when that wait is in (0, 15]; None for anything else."""
    if not isinstance(result, dict) or result.get("isError") is not True:
        return None
    content = result.get("content")
    if not isinstance(content, list):
        return None
    for item in content:
        if not isinstance(item, dict) or item.get("type") != "text" or not isinstance(item.get("text"), str):
            continue
        try:
            body = json.loads(item["text"])
        except ValueError:
            continue
        if not isinstance(body, dict) or body.get("code") not in _YIELD_CODES:
            continue
        status = body.get("status")
        if not isinstance(status, dict):
            continue
        wait = status.get("wait_seconds")
        if isinstance(wait, (int, float)) and not isinstance(wait, bool) and 0 < wait <= _YIELD_WAIT_MAX_S:
            return float(wait)
    return None


class HostGateway:
    def __init__(
        self,
        *,
        registry: Registry,
        audit: AuditLog,
        broker: ApprovalBroker,
        session_locked: Callable[[], bool],
        startup_timeout_s: float = STARTUP_TIMEOUT_S,
        forward_timeout_s: float = FORWARD_TIMEOUT_S,
        cwd: Path | None = None,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        keepalive_s: float = KEEPALIVE_S,
        idle_stop_s: float = IDLE_STOP_S,
        idle_sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self._registry = registry
        self._audit = audit
        self._broker = broker
        self._session_locked = session_locked
        self._startup_timeout_s = startup_timeout_s
        self._forward_timeout_s = forward_timeout_s
        self._clock = clock
        self._sleep = sleep
        self._keepalive_s = keepalive_s
        self._idle_stop_s = idle_stop_s
        self._idle_sleep = idle_sleep
        # tools/call in flight per server, and the timer that stops a server once that count is 0.
        self._busy: dict[str, int] = {}
        self._idle_timers: dict[str, asyncio.Task[None]] = {}
        self._in_flight: dict[tuple[str, object], InFlightCall] = {}
        self._calls_by_id: dict[str, InFlightCall] = {}
        self._call_order = count(1)
        self._settling: set[asyncio.Task[object]] = set()
        self._cwd = cwd if cwd is not None else Path.home()
        self._servers: dict[str, StdioServer] = {record.name: self._new_server(record) for record in registry.all()}
        # (server, tool) -> whether the tool was read-only when the user granted it.
        self._until_restart: dict[tuple[str, str], bool] = {}
        self._mutations = asyncio.Lock()
        # Moved before a stop-all, a shutdown or a delete waits for the lock: a register holding it
        # then skips its restart instead of making them wait out a handshake.
        self._stop_epoch = 0
        self._delete_epochs: dict[str, int] = {}
        # Set by stop-all, cleared only by resume; held in memory, so a gateway restart clears it.
        # While set, no server starts and every tools/call is refused as stopped_by_user.
        self.paused = False
        self._pause_signal = asyncio.Event()

    def _new_server(self, record: ServerRecord) -> StdioServer:
        def remember(tools: list[dict[str, object]], instructions: str | None) -> None:
            current = self._registry.get(record.name)
            if current is not None and current.command == record.command:
                self._registry.set_tool_cache(record.name, tools, instructions)

        return StdioServer(
            record.name,
            record.command,
            record.environment,
            startup_timeout_s=self._startup_timeout_s,
            cwd=self._cwd,
            on_tools=remember,
        )

    # On-demand lifetime

    def _known_tools(self, name: str) -> tuple[list[dict[str, object]], str | None] | None:
        """What can be said about a server's tools without starting it: the live list of a running
        server, else the last good list kept in the registry, else what a stopped server last listed."""
        server = self._servers.get(name)
        if server is not None and server.state == "running" and not server.tools_stale:
            return server.tools, server.instructions
        cached = self._registry.tool_cache(name)
        if cached is not None:
            return cached["tools"], cached["instructions"]
        if server is not None and server.tools:
            return server.tools, server.instructions
        return None

    def _call_started(self, name: str) -> None:
        self._busy[name] = self._busy.get(name, 0) + 1
        timer = self._idle_timers.pop(name, None)
        if timer is not None:
            timer.cancel()

    def _call_ended(self, name: str) -> None:
        self._busy[name] = max(self._busy.get(name, 0) - 1, 0)
        self._arm_idle(name)

    def _arm_idle(self, name: str) -> None:
        """(Re)start the idle timer of a running server with no call in flight."""
        timer = self._idle_timers.pop(name, None)
        if timer is not None:
            timer.cancel()
        server = self._servers.get(name)
        if self._busy.get(name, 0) or server is None or server.state not in ("running", "starting"):
            return
        self._idle_timers[name] = asyncio.ensure_future(self._stop_when_idle(name, server))

    async def _stop_when_idle(self, name: str, server: StdioServer) -> None:
        await self._idle_sleep(self._idle_stop_s)
        if self._idle_timers.get(name) is asyncio.current_task():
            del self._idle_timers[name]
        if self._busy.get(name, 0) or self._servers.get(name) is not server or server.state != "running":
            return
        await server.stop()
        self._audit.record("server_idle_stopped", server=name)

    def server(self, name: str) -> StdioServer | None:
        return self._servers.get(name)

    # Management plane

    def view(self, record: ServerRecord) -> dict[str, object]:
        server = self._servers.get(record.name)
        state = server.state if server is not None else "stopped"
        view: dict[str, object] = {
            "name": record.name,
            "command": list(record.command),
            "environment_keys": sorted(record.environment),
            "approval_mode": record.approval_mode,
            "allow_when_locked": record.allow_when_locked,
            "state": state,
            "always_grants": [display_text(tool) for tool in record.always_grants],
        }
        if state == "failed" and server is not None and server.error_code:
            view["error_code"] = server.error_code
        return view

    def views(self) -> list[dict[str, object]]:
        return [self.view(record) for record in self._registry.all()]

    def running_count(self) -> int:
        return sum(1 for server in self._servers.values() if server.state == "running")

    async def register(
        self,
        name: str,
        *,
        command: Sequence[str],
        environment: dict[str, str],
        approval_mode: str,
        allow_when_locked: bool,
    ) -> ServerRecord:
        """Register or replace ``name``; a running server restarts with the new config. Raises
        ServerLimitReached, or OSError when the registry could not be written.

        The restart runs under the mutation lock, so an overlapping PUT sees the server it left
        running. A delete or stop-all does not wait out its handshake: each stops servers before
        taking the lock, which fails the handshake at once."""
        async with self._mutations:
            if self._registry.get(name) is None and len(self._registry) >= RULES["server_max"]:
                raise ServerLimitReached
            record, previous = self._registry.put(
                name,
                command=tuple(command),
                environment=environment,
                approval_mode=approval_mode,
                allow_when_locked=allow_when_locked,
            )
            command_changed = previous is not None and previous.command != record.command
            if command_changed:
                self._forget_until_restart(name)
                self._broker.deny_all(server=name)
            old = self._servers.get(name)
            was_live = old is not None and old.state in ("running", "starting")
            server = self._servers[name] = self._new_server(record)
            epochs = (self._stop_epoch, self._delete_epochs.get(name, 0))
            if old is not None:
                await old.stop()
            self._audit.record(
                "server_registered",
                server=name,
                replaced=previous is not None,
                command_changed=command_changed,
                approval_mode=approval_mode,
                allow_when_locked=allow_when_locked,
            )
            if was_live and not self.paused and epochs == (self._stop_epoch, self._delete_epochs.get(name, 0)):
                try:
                    await server.start()
                except ServerUnavailable:
                    pass
                self._arm_idle(name)
        return record

    async def delete(self, name: str) -> bool:
        self._delete_epochs[name] = self._delete_epochs.get(name, 0) + 1
        live = self._servers.get(name)
        if live is not None:
            await live.stop()
        async with self._mutations:
            record = self._registry.delete(name)
            if record is None:
                return False
            server = self._servers.pop(name, None)
            self._forget_until_restart(name)
            self._broker.deny_all(server=name)
            if server is not None:
                await server.stop()
            self._audit.record("server_deleted", server=name)
            return True

    async def clear_grants(self, name: str) -> bool:
        async with self._mutations:
            if self._registry.get(name) is None:
                return False
            self._registry.clear_always_grants(name)
            self._forget_until_restart(name)
            self._audit.record("grants_cleared", server=name)
            return True

    async def stop_all(self) -> int:
        """Stop every server and pause until ``resume``: held approvals are denied, a pending retry
        wait ends, and no server starts and no call is forwarded meanwhile."""
        self.paused = True
        self._pause_signal.set()
        self._stop_epoch += 1
        denied = self._broker.deny_all()
        stopped = await self._stop_every()
        async with self._mutations:
            stopped += await self._stop_every()
            self._audit.record("stop_all", stopped_servers=stopped, denied_approvals=denied)
            return stopped

    def resume(self) -> None:
        """End the pause stop-all began; servers start again on their next call."""
        if self.paused:
            self.paused = False
            self._pause_signal = asyncio.Event()
        self._audit.record("resumed")

    async def _wait_to_retry(self, seconds: float, call: InFlightCall) -> None:
        """Sleep out a USER_CONTROL yield; a stop-all or a cancel of the call ends it at once."""
        if self.paused or call.cancelled:
            return
        sleeper = asyncio.ensure_future(self._sleep(seconds))
        paused = asyncio.ensure_future(self._pause_signal.wait())
        cancelled = asyncio.ensure_future(call.wake.wait())
        try:
            await asyncio.wait({sleeper, paused, cancelled}, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for waiter in (sleeper, paused, cancelled):
                waiter.cancel()

    async def aclose(self) -> None:
        self._stop_epoch += 1
        for timer in self._idle_timers.values():
            timer.cancel()
        self._idle_timers.clear()
        await self._stop_every()
        async with self._mutations:
            await self._stop_every()

    async def _stop_every(self) -> int:
        stopped = 0
        for server in list(self._servers.values()):
            if server.state in ("running", "starting") and await server.stop():
                stopped += 1
            elif server.state == "failed":
                await server.stop()
        return stopped

    def _forget_until_restart(self, name: str) -> None:
        self._until_restart = {grant: ro for grant, ro in self._until_restart.items() if grant[0] != name}

    # Data plane

    def authenticate(self, name: str, authorization: Sequence[str]) -> ServerRecord | None:
        """The server whose runtime token was presented, or None. An unknown name is compared
        against a throwaway token, so the answer and its timing say nothing about which names exist."""
        record = self._registry.get(name)
        expected = record.token if record is not None else _UNKNOWN_SERVER_TOKEN
        supplied = authorization[0] if len(authorization) == 1 else ""
        token = supplied[len(_BEARER) :] if supplied.startswith(_BEARER) else ""
        matched = hmac.compare_digest(token.encode("utf-8"), expected.encode("utf-8"))
        return record if matched and record is not None else None

    async def handle(self, record: ServerRecord, message: object) -> dict[str, object] | None:
        """Answer one JSON-RPC message; None for a notification or a response (HTTP 202)."""
        if not isinstance(message, dict):
            return rpc_error(None, INVALID_REQUEST, "Invalid Request")
        method = message.get("method")
        if method == "notifications/cancelled" and "id" not in message:
            params = message.get("params")
            cancelled = params.get("requestId") if isinstance(params, dict) else None
            if not isinstance(cancelled, bool) and isinstance(cancelled, (str, int)):
                self.cancel_call(record.name, cancelled)
            return None
        if not isinstance(method, str) or "id" not in message:
            return None
        request_id = message["id"]
        if isinstance(request_id, bool) or not isinstance(request_id, (str, int)):
            return rpc_error(None, INVALID_REQUEST, "Invalid Request")
        params = message.get("params", {})
        if params is None:
            params = {}
        if not isinstance(params, dict):
            return rpc_error(request_id, INVALID_PARAMS, "Invalid params")
        if method == "ping":
            return _rpc_result(request_id, {})
        if method in _EMPTY_LISTS:
            return _rpc_result(request_id, {_EMPTY_LISTS[method]: []})
        if method == "initialize":
            return await self._initialize(record, request_id, params)
        if method == "tools/list":
            live = self._servers.get(record.name)
            if not self.paused and live is not None and live.state == "running" and live.tools_stale:
                await live.refresh_tools()
            known = self._known_tools(record.name)
            if known is not None or self.paused:
                # Answered without starting the server: the runtime connecting is not a use of it.
                # While paused the runtime keeps the tools it last saw, so its next call gets the
                # clear refusal.
                return _rpc_result(request_id, {"tools": known[0] if known is not None else []})
            try:
                server = await self._running(record)
            except ServerUnavailable:
                return rpc_error(request_id, INTERNAL_ERROR, HOST_MCP_CALL_REFUSAL_TEXT["server_unavailable"])
            self._arm_idle(record.name)
            return _rpc_result(request_id, {"tools": server.tools})
        if method == "tools/call":
            if (record.name, request_id) in self._in_flight:
                return rpc_error(request_id, INVALID_REQUEST, "duplicate request id")
            call = self._track(record.name, request_id, streamed=False, tool=params.get("name"))
            try:
                return await self._call_tool(record, request_id, params, call)
            finally:
                self._untrack(call)
        return rpc_error(request_id, METHOD_NOT_FOUND, "Method not found")

    async def stream_call(self, record: ServerRecord, message: dict[str, object]) -> AsyncIterator[dict[str, object]]:
        """Answer a ``tools/call`` that has a progress token as a stream of messages: a
        ``notifications/progress`` every keepalive interval while the call waits or runs, then the
        response. Closing the stream before the response (the client went away) cancels the call."""
        token = progress_token(message)
        request_id = message["id"]
        params = message.get("params")
        if (record.name, request_id) in self._in_flight:
            # The id names the call a cancel is for, so a second call under it is refused rather
            # than taking the first one's place.
            yield rpc_error(request_id, INVALID_REQUEST, "duplicate request id")
            return
        call = self._track(
            record.name, request_id, streamed=True, tool=params.get("name") if isinstance(params, dict) else None
        )
        task = asyncio.ensure_future(self._call_tool(record, request_id, params if isinstance(params, dict) else {}, call))
        progress = 0
        try:
            while not task.done():
                timer = asyncio.ensure_future(self._sleep(self._keepalive_s))
                try:
                    await asyncio.wait({task, timer}, return_when=asyncio.FIRST_COMPLETED)
                finally:
                    timer.cancel()
                if task.done():
                    break
                progress += 1
                yield {
                    "jsonrpc": "2.0",
                    "method": "notifications/progress",
                    "params": {"progressToken": token, "progress": progress, "message": _PHASE_MESSAGES[call.phase]},
                }
            yield task.result()
        finally:
            if not task.done():
                self.cancel_call(record.name, request_id, call)
                self._settling.add(task)
                task.add_done_callback(self._settling.discard)
            self._untrack(call)

    def cancel_call(self, server: str, request_id: object, call: InFlightCall | None = None) -> bool:
        """Cancel the ``tools/call`` in flight for ``server`` with ``request_id``. One waiting for the
        user has its approval settled as cancelled and is never forwarded; one waiting out a
        USER_CONTROL yield is never sent again; one already forwarded is cancelled at the server,
        and its answer does not wait for the server. False when no such call is in flight."""
        call = call or self._in_flight.get((server, request_id))
        if call is None or call.cancelled:
            return False
        call.cancelled = True
        call.wake.set()
        if call.approval_id is not None:
            self._broker.cancel(call.approval_id)
        if call.forwarded is not None:
            child, child_id = call.forwarded
            child.cancel_request(child_id)
        return True

    def cancel_by_user(self, call_id: str) -> bool:
        """The user's cancel of one call listed in ``active_calls``; its runtime is answered
        ``cancelled_by_user``. False when no such call is in flight."""
        call = self._calls_by_id.get(call_id)
        if call is None or call.cancelled:
            return False
        state = _PHASE_STATES[call.phase]
        call.cancelled_by_user = True
        self.cancel_call(call.server, call.request_id, call)
        self._audit.record(
            "tool_call_cancelled", server=call.server, tool=display_text(call.tool), call_id=call_id, state=state
        )
        return True

    def active_calls(self) -> list[dict[str, object]]:
        """The calls in flight for ``status.active_calls``, newest first, at most the contract's 16."""
        now = self._clock()
        listed = []
        for call in sorted(self._calls_by_id.values(), key=lambda c: c.order, reverse=True)[:_ACTIVE_CALLS_MAX]:
            record = self._registry.get(call.server)
            waiting = call.phase == "waiting" and call.resume_at is not None
            listed.append(
                {
                    "call_id": call.call_id,
                    "server": call.server,
                    "tool": display_text(call.tool or "(unnamed)"),
                    "state": _PHASE_STATES[call.phase],
                    "resume_in_ms": max(0, int((call.resume_at - now) * 1000)) if waiting else None,  # type: ignore[operator]
                    "computer_use": bool(record and record.computer_use),
                }
            )
        return listed

    def _track(self, server: str, request_id: object, *, streamed: bool, tool: object = None) -> InFlightCall:
        call = InFlightCall(
            server=server,
            request_id=request_id,
            streamed=streamed,
            tool=tool if isinstance(tool, str) else "",
            order=next(self._call_order),
        )
        self._in_flight[(server, request_id)] = call
        self._calls_by_id[call.call_id] = call
        return call

    def _untrack(self, call: InFlightCall) -> None:
        if self._in_flight.get((call.server, call.request_id)) is call:
            del self._in_flight[(call.server, call.request_id)]
        self._calls_by_id.pop(call.call_id, None)

    async def _running(self, record: ServerRecord) -> StdioServer:
        """The started server for ``record``. Only the server registered with that command and token
        is started or handed out; one that was deleted, replaced or dropped from the gateway while it
        started is stopped again, so no process outlives the server object that owns it."""
        current = self._still_registered(record)
        if current is None:
            raise ServerUnavailable("the server is no longer registered")
        if self.paused:
            raise ServerPaused("the user stopped the host tools")
        server = self._servers.get(record.name)
        if server is None:
            server = self._servers[record.name] = self._new_server(current)
        await server.start()
        if self.paused:
            await server.stop()
            raise ServerPaused("the user stopped the host tools while the server started")
        if self._servers.get(record.name) is not server:
            await server.stop()
            raise ServerUnavailable("the server was replaced while it started")
        if self._still_registered(record) is None:
            raise ServerUnavailable("the server changed while it started")
        return server

    async def _initialize(self, record: ServerRecord, request_id: object, params: dict[str, object]) -> dict[str, object]:
        known = self._known_tools(record.name)
        server = self._servers.get(record.name)
        retry = server is not None and server.state in ("failed", "starting") and not self._locked_out(record)
        instructions: str | None
        if (known is not None and not retry) or self.paused:
            # Answered without starting anything: the server starts on its first call. While paused
            # the runtime stays connected and its calls get the stopped_by_user refusal. A server that
            # failed is started again, so the runtime's reconnect is a real retry, and one starting is
            # waited for, so a concurrent reconnect does not report success before that start ends.
            instructions = known[1] if known is not None else None
        else:
            try:
                server = await self._running(record)
            except ServerUnavailable:
                return rpc_error(request_id, INTERNAL_ERROR, HOST_MCP_CALL_REFUSAL_TEXT["server_unavailable"])
            self._arm_idle(record.name)
            instructions = server.instructions
        requested = params.get("protocolVersion")
        result: dict[str, object] = {
            "protocolVersion": requested if requested in SUPPORTED_PROTOCOL_VERSIONS else LATEST_PROTOCOL_VERSION,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": f"superclaw-host-{record.name}", "version": __version__},
        }
        if instructions:
            result["instructions"] = instructions
        return _rpc_result(request_id, result)

    async def _call_tool(
        self, record: ServerRecord, request_id: object, params: dict[str, object], call: InFlightCall
    ) -> dict[str, object]:
        """A call in flight holds its server's idle timer off; when the last one ends it is armed."""
        self._call_started(record.name)
        try:
            return await self._run_call(record, request_id, params, call)
        finally:
            self._call_ended(record.name)

    async def _run_call(
        self, record: ServerRecord, request_id: object, params: dict[str, object], call: InFlightCall
    ) -> dict[str, object]:
        received_at = self._clock()
        # A streamed call is kept alive, so it may wait for the user and run for the long budget; any
        # other call must be answered before the client's 60 s request timer fires.
        approval_timeout_s = LONG_CALL_S if call.streamed else NO_PROGRESS_APPROVAL_S
        forward_timeout_s = LONG_CALL_S if call.streamed else self._forward_timeout_s
        retry_budget_s = LONG_CALL_S if call.streamed else _RETRY_BUDGET_S
        tool_name = params.get("name")
        arguments = params.get("arguments")
        if not isinstance(tool_name, str) or not tool_name or (arguments is not None and not isinstance(arguments, dict)):
            return rpc_error(request_id, INVALID_PARAMS, "Invalid params")
        server_name = record.name
        # Exactly one `tool_call` line per call, its decision; what ends a call after it was allowed
        # (a cancel, a stop, an unavailable server) is a `tool_call_ended` line.
        decided = False

        def refused(reason: str, decision: str, approval_id: str | None = None) -> dict[str, object]:
            # A call that a stop-all denied, or whose server it killed, is told the user stopped it;
            # one the user cancelled from the UI is told that.
            if self.paused and reason in ("denied", "server_unavailable"):
                reason, decision = "stopped_by_user", "stopped"
            elif call.cancelled_by_user and reason in ("cancelled", "denied", "server_unavailable"):
                reason, decision = "cancelled_by_user", "cancelled_by_user"
            if decided:
                self._audit.record(
                    "tool_call_ended",
                    server=server_name,
                    tool=display_text(tool_name),
                    outcome=decision,
                    approval_id=approval_id,
                )
            else:
                self._record_call(server_name, tool_name, decision, approval_id)
            return _rpc_result(request_id, refusal_result(reason))

        # Paused: refused before anything can start a server.
        if self.paused:
            return refused("stopped_by_user", "stopped")
        # Every await below can outlive a delete, a re-PUT or a lock: what decides is the record
        # as it is after each one, and a server whose command or token changed is refused.
        if self._locked_out(record):
            return refused("session_locked", "locked")
        try:
            server = await self._running(record)
        except ServerUnavailable:
            return refused("server_unavailable", "unavailable")
        if call.cancelled:
            return refused("cancelled", "cancelled")
        current = self._still_registered(record)
        if current is None:
            return refused("server_unavailable", "unavailable")
        if server.tools_stale or server.tool(tool_name) is None:
            await server.refresh_tools()
            if call.cancelled:
                return refused("cancelled", "cancelled")
            current = self._still_registered(record)
            if current is None:
                return refused("server_unavailable", "unavailable")
        tool = server.tool(tool_name)
        if tool is None:
            return rpc_error(request_id, INVALID_PARAMS, "Unknown tool")

        annotations = annotations_from_tool(tool)
        read_only = is_read_only(annotations)
        granted_read_only = self._until_restart.get((server_name, tool_name))
        approval_id: str | None = None
        if tool_name in current.always_grants and read_only:
            decision = "granted_always"
        elif granted_read_only is not None and (read_only or not granted_read_only):
            # A grant given to a read-only tool lapses when the tool stops claiming to be one; a
            # grant given knowing the tool writes stays.
            decision = "granted_until_restart"
        elif not needs_approval(current.approval_mode, annotations):
            decision = "auto"
        else:
            if call.cancelled:
                return refused("cancelled", "cancelled")
            scopes = offered_scopes(annotations)
            call.phase = "approval"

            def listed(pending_id: str) -> None:
                call.approval_id = pending_id

            approval_id, outcome = await self._broker.request_tool_call(
                server=server_name,
                tool=tool_name,
                title=_tool_title(tool),
                annotations=annotations.as_dict(),
                arguments=arguments,
                grant_scopes=scopes,
                timeout_s=approval_timeout_s,
                on_pending=listed,
            )
            if outcome.decision == "cancelled" or call.cancelled:
                return refused("cancelled", "cancelled", approval_id)
            if outcome.decision == "timeout":
                return refused("approval_timeout", "timeout", approval_id)
            if outcome.decision != "granted":
                return refused("denied", "denied", approval_id)
            current = self._still_registered(record)
            if current is None:
                return refused("server_unavailable", "unavailable", approval_id)
            scope = outcome.scope or "once"
            if scope == "until_restart":
                self._until_restart[(server_name, tool_name)] = read_only
            elif scope == "always" and "always" in scopes:
                try:
                    self._registry.add_always_grant(server_name, tool_name)
                except OSError as exc:
                    logger.error("always grant not saved server={} error={}", server_name, type(exc).__name__)
            decision = f"granted_{scope}"
        if self._locked_out(current):
            return refused("session_locked", "locked", approval_id)
        self._record_call(server_name, tool_name, decision, approval_id)
        decided = True

        async def still_authorized(current: ServerRecord) -> bool:
            """A call the user approved in the dialog stays approved; one let through by a standing
            grant or the auto policy is sent again only while that still lets it through."""
            if approval_id is not None:
                return True
            live = self._servers.get(server_name)
            if live is None:
                return False
            if live.tools_stale:
                await live.refresh_tools()
            tool_now = live.tool(tool_name)
            if tool_now is None:
                return False
            annotations_now = annotations_from_tool(tool_now)
            read_only_now = is_read_only(annotations_now)
            if decision == "granted_always":
                return tool_name in current.always_grants and read_only_now
            if decision == "granted_until_restart":
                granted = self._until_restart.get((server_name, tool_name))
                return granted is not None and (read_only_now or not granted)
            return decision == "auto" and not needs_approval(current.approval_mode, annotations_now)

        call_params: dict[str, object] = {"name": tool_name}
        if arguments is not None:
            call_params["arguments"] = arguments

        async def forward(current: ServerRecord) -> dict[str, object]:
            try:
                server = await self._running(current)
                latest = self._still_registered(record)
                if latest is None:
                    raise ServerUnavailable("the server changed while the call waited")
                if self._locked_out(latest):
                    return refused("session_locked", "locked", approval_id)
                if call.cancelled:
                    return refused("cancelled", "cancelled", approval_id)
                call.phase = "running"

                def sent(child_id: int) -> None:
                    call.forwarded = (server, child_id)

                result = await server.request("tools/call", call_params, forward_timeout_s, on_sent=sent)
            except RequestCancelled:
                return refused("cancelled", "cancelled", approval_id)
            except ServerUnavailable:
                return refused("server_unavailable", "unavailable", approval_id)
            except JsonRpcError as exc:
                return {"jsonrpc": "2.0", "id": request_id, "error": exc.as_error()}
            finally:
                call.forwarded = None
            return _rpc_result(request_id, result)

        if call.cancelled:
            return refused("cancelled", "cancelled", approval_id)
        answer = await forward(current)
        for attempt in range(1, _USER_CONTROL_RETRIES + 1):
            wait_s = _yield_wait_s(answer.get("result"))
            if wait_s is None:
                break
            self._mark_computer_use(server_name)
            if self._clock() - received_at + wait_s + _YIELD_MARGIN_S >= retry_budget_s:
                break
            call.phase, call.resume_at = "waiting", self._clock() + wait_s + _YIELD_MARGIN_S
            try:
                await self._wait_to_retry(wait_s + _YIELD_MARGIN_S, call)
            finally:
                call.resume_at = None
            if self.paused:
                return refused("stopped_by_user", "stopped", approval_id)
            if call.cancelled:
                return refused("cancelled", "cancelled", approval_id)
            current = self._still_registered(record)
            if current is None:
                return refused("server_unavailable", "unavailable", approval_id)
            if self._locked_out(current):
                return refused("session_locked", "locked", approval_id)
            if not await still_authorized(current):
                return refused("denied", "denied", approval_id)
            if call.cancelled:
                return refused("cancelled", "cancelled", approval_id)
            self._audit.record(
                "tool_call_retried",
                server=server_name,
                tool=display_text(tool_name),
                approval_id=approval_id,
                reason="user_control",
                attempt=attempt,
            )
            answer = await forward(current)
        return answer

    def _mark_computer_use(self, name: str) -> None:
        try:
            self._registry.mark_computer_use(name)
        except OSError as exc:
            logger.error("computer_use mark not saved server={} error={}", name, type(exc).__name__)

    def _still_registered(self, record: ServerRecord) -> ServerRecord | None:
        """The current record for ``record``'s server, or None if it was deleted or now runs another
        command or token."""
        current = self._registry.get(record.name)
        if current is None or (current.command, current.token) != (record.command, record.token):
            return None
        return current

    def _locked_out(self, record: ServerRecord) -> bool:
        return not record.allow_when_locked and self._session_locked()

    def _record_call(self, server: str, tool: str, decision: str, approval_id: str | None) -> None:
        self._audit.record(
            "tool_call",
            server=server,
            tool=display_text(tool),
            decision=decision,
            approval_id=approval_id,
        )
