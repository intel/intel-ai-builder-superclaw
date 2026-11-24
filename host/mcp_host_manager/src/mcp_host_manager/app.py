"""FastAPI app assembly for mcp_host_manager.

Management plane, ``/mcp-host/v1/*``: ServiceHub-forwarded only (``auth.py``), except ``health``,
``summary`` and ``shutdown``. Data plane: ``/mcp-host/mcp/{name}`` (the server's runtime bearer token)
and ``/mcp-host/cdp/{relay_token}`` (the relay token in the path, checked by the host browser).

Every error is the contract's ``{"error": {"code", "message"}}`` with its fixed sentence; a malformed
request is 400, never FastAPI's 422, because ServiceHub replaces any other error body with
``upstream_error``.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import secrets
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from encodings import idna as idna_codec
from pathlib import Path
from string import hexdigits
from typing import Protocol
from urllib.parse import urlsplit

from contracts.host_browser_config_request import HostBrowserConfigRequest
from contracts.host_mcp_approval_decision_request import Decision, HostMcpApprovalDecisionRequest
from contracts.host_mcp_pending_approval_list import HostMcpPendingApprovalList
from contracts.host_mcp_server_register_request import HostMcpServerRegisterRequest
from fastapi import FastAPI, Request, WebSocket
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from loguru import logger
from pydantic import ValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import __version__
from .approval_broker import (
    ApprovalBroker,
    ApprovalNotFound,
    ApprovalNotPending,
    ApprovalScopeNotOffered,
)
from .audit import AuditLog
from .auth import PROCESS_CREDENTIAL_HEADER, ForwardedCredentialMiddleware
from .browser import HostBrowser
from .config import RuntimeConfig
from .errors import NO_STORE_HEADERS, RULES, error_body, refusal
from .mcp_proxy import (
    FORWARD_TIMEOUT_S,
    INVALID_REQUEST,
    HostGateway,
    ServerLimitReached,
    progress_token,
    rpc_error,
)
from .registry import Registry, is_browser_automation_command
from .session_guard import is_session_locked
from .sse import SseResponse, accepts_event_stream, json_rpc_response
from .stdio_host import STARTUP_TIMEOUT_S

PREFIX: str = RULES["proxy_prefix"]
_V1 = PREFIX + "/v1"
_PARSE_ERROR = -32700
_MANAGEMENT_BODY_MAX = 512 * 1024
_RUNTIME_BODY_MAX = 10 * 1024 * 1024
_WAIT_MS = re.compile(r"[0-9]{1,9}")
_APPROVAL_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}")
_NAME = re.compile(RULES["server_name_pattern"])
_RESERVED_DEVICE_NAMES = frozenset(RULES["windows_reserved_device_names"])
_DEFAULT_PORTS = {"http": 80, "https": 443}
_PATH_SEPARATORS = re.compile(r"[\\/]")
_TRY_AGAIN_LATER = 1013


class Browser(Protocol):
    """What ``browser.HostBrowser`` offers the app."""

    def configure(self, request: dict[str, object]) -> dict[str, object]: ...

    async def unconfigure(self) -> dict[str, object]: ...

    def view(self) -> dict[str, object]: ...

    async def stop(self) -> bool: ...

    def json_version(self, relay_token: str) -> dict[str, object] | None: ...

    async def serve_relay(self, websocket: WebSocket, relay_token: str) -> None: ...

    async def aclose(self) -> None: ...


BrowserFactory = Callable[..., Browser]


async def _bounded_body(request: Request, limit: int) -> bytes | None:
    """The request body, or None if it is larger than ``limit`` bytes (never read past it)."""
    declared = request.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > limit:
        return None
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > limit:
            return None
        chunks.append(chunk)
    return b"".join(chunks)


def _ok(body: dict[str, object]) -> JSONResponse:
    return JSONResponse(body, headers=NO_STORE_HEADERS)


def _plain_windows_path(path: str) -> bool:
    """The contract's segment rules: Windows strips a trailing dot or space, and a device name opens a
    device, so such a segment names something other than what it reads. Windows also separates on
    ``/``, so a segment is whatever lies between either separator."""
    for segment in (part for part in _PATH_SEPARATORS.split(path[3:]) if part):
        if segment in (".", "..") or segment.endswith((".", " ")):
            return False
        if segment.split(".")[0].rstrip().upper() in _RESERVED_DEVICE_NAMES:
            return False
    return True


def _canonical_origin(origin: str) -> bool:
    """The origin as a WHATWG URL parser would write it: no port over 65535, no default port written
    out, a host ending in a number only as a dotted quad (``http://127.1`` is rewritten), and no
    ``xn--`` label that is not valid punycode for the label it decodes to."""
    parts = urlsplit(origin)
    try:
        port = parts.port
    except ValueError:
        return False
    if port is not None and port == _DEFAULT_PORTS.get(parts.scheme):
        return False
    host = parts.hostname or ""
    if not all(_punycode_round_trips(label) for label in host.split(".")):
        return False
    last = host.rsplit(".", 1)[-1]
    if last.isdigit() or (last.startswith("0x") and all(char in hexdigits for char in last[2:])):
        quad = host.split(".")
        return len(quad) == 4 and all(
            part.isdigit() and str(int(part)) == part and int(part) <= 255 for part in quad
        )
    return True


def _punycode_round_trips(label: str) -> bool:
    if not label.startswith("xn--"):
        return True
    """The full-name codec splits on the IDNA dot separators (U+3002, U+FF0E, U+FF61) as well as
    ``.``, so a label that decodes to one of them re-encodes as two labels and is refused."""
    try:
        decoded = idna_codec.ToUnicode(label)
        return decoded != label and decoded.encode("idna").decode("ascii") == label
    except UnicodeError:
        return False


def _browser_request_is_valid(body: HostBrowserConfigRequest) -> bool:
    paths = ([body.downloads_dir] if body.downloads_dir else []) + [root.root for root in body.upload_roots or []]
    origins = [*body.origin_policy.allow, *body.origin_policy.deny] if body.origin_policy else []
    return all(_plain_windows_path(path) for path in paths) and all(_canonical_origin(o) for o in origins)


def create_app(
    config: RuntimeConfig,
    *,
    session_locked: Callable[[], bool] = is_session_locked,
    browser_factory: BrowserFactory | None = None,
    approval_timeout_ms: int | None = None,
    startup_timeout_s: float = STARTUP_TIMEOUT_S,
    forward_timeout_s: float = FORWARD_TIMEOUT_S,
    server_cwd: Path | None = None,
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
) -> FastAPI:
    """Build the app. Tests inject the lock check, a fake browser, short timeouts, and a simulated
    clock and sleep for the approval waits and the progress keepalive."""
    state_dir = config.state_dir
    audit = AuditLog(state_dir)
    broker = ApprovalBroker(timeout_ms=approval_timeout_ms, sleep=sleep)
    registry = Registry(state_dir)
    gateway = HostGateway(
        registry=registry,
        audit=audit,
        broker=broker,
        session_locked=session_locked,
        startup_timeout_s=startup_timeout_s,
        forward_timeout_s=forward_timeout_s,
        cwd=server_cwd,
        clock=clock,
        sleep=sleep,
        idle_sleep=sleep,
    )
    runtime_url_prefix: str = (
        RULES["runtime_url_prefix"] if config.port == RULES["port"] else f"http://127.0.0.1:{config.port}{PREFIX}/mcp/"
    )
    factory: BrowserFactory = browser_factory or (lambda **fields: HostBrowser(**fields, paused=lambda: gateway.paused))  # type: ignore[arg-type]
    browser = factory(state_dir=state_dir, approvals=broker, audit=audit.record, port=config.port)

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        yield
        await gateway.aclose()
        await browser.aclose()

    app = FastAPI(
        title="SuperClaw host MCP gateway",
        version=__version__,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )
    app.state.service_name = config.service_name
    app.state.instance_id = config.instance_id
    app.state.process_credential = config.process_credential
    app.state.gateway = gateway
    app.state.broker = broker
    app.state.audit = audit
    app.state.browser = browser
    app.add_middleware(ForwardedCredentialMiddleware, process_credential=config.process_credential)

    @app.exception_handler(RequestValidationError)
    async def _on_validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
        return refusal("invalid_request")

    @app.exception_handler(OSError)
    async def _on_os_error(request: Request, exc: OSError) -> Response:
        # A registry or audit write that failed. The contract has no code for it, so the answer is a
        # bare 500 that ServiceHub reports as an upstream error; only the type is logged.
        logger.error("request failed on a file write path={} error={}", request.url.path, type(exc).__name__)
        return Response(status_code=500, headers=NO_STORE_HEADERS)

    @app.exception_handler(StarletteHTTPException)
    async def _on_http_exception(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        return JSONResponse(
            error_body("invalid_request"),
            status_code=exc.status_code,
            headers={**(exc.headers or {}), **NO_STORE_HEADERS},
        )

    # Unguarded

    @app.get(_V1 + "/health")
    async def health(request: Request) -> dict[str, object]:
        return {
            "service": request.app.state.service_name,
            "status": "ok",
            "pid": os.getpid(),
            "instance_id": request.app.state.instance_id,
            "version": __version__,
        }

    @app.get(_V1 + "/summary")
    async def summary() -> JSONResponse:
        return _ok(
            {
                "host_server_count": gateway.running_count(),
                "host_browser_active": bool(browser.view()["active"]),
            }
        )

    @app.post(_V1 + "/shutdown")
    async def shutdown(request: Request) -> JSONResponse:
        """Graceful shutdown (sub-service contract §7). ServiceHub calls it directly with the process
        credential; an empty expected credential denies everything."""
        expected = request.app.state.process_credential
        supplied = request.headers.getlist(PROCESS_CREDENTIAL_HEADER)
        if (
            not expected
            or len(supplied) != 1
            or not secrets.compare_digest(expected.encode(), supplied[0].encode())
        ):
            return JSONResponse(
                {"error": {"code": "shutdown_forbidden", "message": "a valid process credential is required"}},
                status_code=403,
            )
        server = getattr(request.app.state, "server", None)
        if server is None:
            return JSONResponse({"state": "stopping", "detail": "no supervisor attached"})
        server.should_exit = True
        return JSONResponse({"state": "stopping"})

    # Servers

    @app.get(_V1 + "/servers")
    async def list_servers() -> JSONResponse:
        return _ok({"servers": gateway.views()})

    @app.put(_V1 + "/servers/{name}")
    async def register_server(name: str, request: Request) -> JSONResponse:
        if not _NAME.fullmatch(name):
            return refusal("invalid_request")
        raw = await _bounded_body(request, _MANAGEMENT_BODY_MAX)
        if raw is None:
            return refusal("invalid_request")
        try:
            body = HostMcpServerRegisterRequest.model_validate_json(raw, strict=True)
        except ValidationError:
            return refusal("invalid_request")
        command = [item.root for item in body.command]
        environment = dict(body.environment or {})
        if (
            len(environment) > RULES["environment_max_keys"]
            or any("\0" in text for text in [*command, *environment, *environment.values()])
            or any(not key.strip() for key in environment)
        ):
            return refusal("invalid_request")
        if is_browser_automation_command(command):
            return refusal("host_mcp_browser_automation_refused")
        try:
            record = await gateway.register(
                name,
                command=command,
                environment=environment,
                approval_mode=(
                    body.approval_mode.value if body.approval_mode is not None else RULES["default_approval_mode"]
                ),
                allow_when_locked=bool(body.allow_when_locked),
            )
        except ServerLimitReached:
            return refusal("host_mcp_server_limit")
        return _ok(
            {
                "server": gateway.view(record),
                "runtime": {
                    "url": runtime_url_prefix + record.name,
                    "headers": {"Authorization": f"Bearer {record.token}"},
                },
            }
        )

    @app.delete(_V1 + "/servers/{name}")
    async def delete_server(name: str) -> JSONResponse:
        if not await gateway.delete(name):
            return refusal("host_mcp_server_not_found")
        return _ok({"ok": True})

    @app.delete(_V1 + "/servers/{name}/grants")
    async def clear_grants(name: str) -> JSONResponse:
        if not await gateway.clear_grants(name):
            return refusal("host_mcp_server_not_found")
        return _ok({"ok": True})

    # Approvals

    @app.get(_V1 + "/approvals")
    async def list_approvals(request: Request) -> JSONResponse:
        wait_ms = request.query_params.get("wait_ms", "0")
        if not _WAIT_MS.fullmatch(wait_ms):
            return refusal("invalid_request")
        pending = await broker.pending(min(int(wait_ms), RULES["approvals_max_wait_ms"]) / 1000)
        entries = []
        for approval in pending[: RULES["pending_max"]]:
            entry = approval.view()
            try:
                HostMcpPendingApprovalList.model_validate({"approvals": [entry]})
            except ValidationError:
                logger.error("pending approval left out of the list id={}", approval.approval_id)
                continue
            entries.append(entry)
        return _ok({"approvals": entries})

    @app.post(_V1 + "/approvals/{approval_id}/decision")
    async def decide(approval_id: str, request: Request) -> JSONResponse:
        if not _APPROVAL_ID.fullmatch(approval_id):
            return refusal("invalid_request")
        raw = await _bounded_body(request, 1024)
        if raw is None:
            return refusal("invalid_request")
        try:
            body = HostMcpApprovalDecisionRequest.model_validate_json(raw, strict=True)
        except ValidationError:
            return refusal("invalid_request")
        approve = body.decision is Decision.approve
        scope = body.grant_scope.value if body.grant_scope is not None else None
        if not approve and scope is not None:
            return refusal("invalid_request")
        try:
            outcome = broker.decide(approval_id, approve, scope)
        except ApprovalNotFound:
            return refusal("approval_not_found")
        except ApprovalNotPending:
            return refusal("approval_not_pending")
        except ApprovalScopeNotOffered:
            return refusal("approval_scope_not_offered")
        audit.record("approval_decided", approval_id=approval_id, decision=body.decision.value, grant_scope=outcome.scope)
        if approve:
            return _ok(
                {"approval_id": approval_id, "decision": "approve", "outcome": "granted", "grant_scope": outcome.scope}
            )
        return _ok({"approval_id": approval_id, "decision": "deny", "outcome": "denied"})

    # Status and stop

    @app.get(_V1 + "/status")
    async def status() -> JSONResponse:
        view = browser.view()
        return _ok(
            {
                "server_count": len(registry),
                "running_count": gateway.running_count(),
                "browser_configured": bool(view["configured"]),
                "browser_active": bool(view["active"]),
                "session_locked": session_locked(),
                "paused": gateway.paused,
                "active_calls": gateway.active_calls(),
            }
        )

    @app.post(_V1 + "/stop-all")
    async def stop_all() -> JSONResponse:
        stopped = await gateway.stop_all()
        browser_stopped = await browser.stop()
        return _ok({"stopped_servers": stopped, "browser_stopped": browser_stopped})

    @app.post(_V1 + "/resume")
    async def resume() -> JSONResponse:
        gateway.resume()
        return _ok({"ok": True})

    @app.post(_V1 + "/calls/{call_id}/cancel")
    async def cancel_call(call_id: str) -> JSONResponse:
        if not _APPROVAL_ID.fullmatch(call_id) or not gateway.cancel_by_user(call_id):
            return refusal("host_mcp_call_not_found")
        return _ok({"ok": True})

    # Browser

    @app.put(_V1 + "/browser")
    async def configure_browser(request: Request) -> JSONResponse:
        raw = await _bounded_body(request, _MANAGEMENT_BODY_MAX)
        if raw is None:
            return refusal("invalid_request")
        try:
            body = HostBrowserConfigRequest.model_validate_json(raw, strict=True)
        except ValidationError:
            return refusal("invalid_request")
        if not _browser_request_is_valid(body):
            return refusal("invalid_request")
        return _ok(browser.configure(body.model_dump(mode="json", exclude_none=True)))

    @app.get(_V1 + "/browser")
    async def browser_view() -> JSONResponse:
        return _ok(browser.view())

    @app.delete(_V1 + "/browser")
    async def unconfigure_browser() -> JSONResponse:
        return _ok(await browser.unconfigure())

    @app.post(_V1 + "/browser/stop")
    async def stop_browser() -> JSONResponse:
        await browser.stop()
        return _ok(browser.view())

    # Data plane

    @app.post(PREFIX + "/mcp/{name}")
    async def runtime_mcp(name: str, request: Request) -> Response:
        record = gateway.authenticate(name, request.headers.getlist("authorization"))
        if record is None:
            return refusal("runtime_token_invalid")
        raw = await _bounded_body(request, _RUNTIME_BODY_MAX)
        if raw is None:
            return refusal("invalid_request")
        try:
            message = json.loads(raw)
        except (ValueError, RecursionError):
            return JSONResponse(rpc_error(None, _PARSE_ERROR, "Parse error"), status_code=400)
        if isinstance(message, list):
            return JSONResponse(rpc_error(None, INVALID_REQUEST, "Batch requests are not supported"), status_code=400)
        if progress_token(message) is not None and accepts_event_stream(request.headers.getlist("accept")):
            return SseResponse(gateway.stream_call(record, message))
        answer = await gateway.handle(record, message)
        if answer is None:
            return Response(status_code=202)
        error = answer.get("error")
        invalid = isinstance(error, dict) and error.get("code") == INVALID_REQUEST
        return json_rpc_response(answer, status_code=400 if invalid else 200)

    @app.api_route(PREFIX + "/mcp/{name}", methods=["GET", "DELETE"])
    async def runtime_mcp_other(name: str) -> JSONResponse:
        return JSONResponse(error_body("invalid_request"), status_code=405, headers={"Allow": "POST"})

    @app.get(PREFIX + "/cdp/{relay_token}/json/version")
    @app.get(PREFIX + "/cdp/{relay_token}/json/version/")
    async def cdp_json_version(relay_token: str) -> JSONResponse:
        version = browser.json_version(relay_token)
        if version is None:
            return JSONResponse(error_body("invalid_request"), status_code=404, headers=NO_STORE_HEADERS)
        return _ok(version)

    @app.websocket(PREFIX + "/cdp/{relay_token}")
    async def cdp_relay(websocket: WebSocket, relay_token: str) -> None:
        if gateway.paused:
            # Try again later: the browser stays stopped (no Edge starts) until the user resumes.
            await websocket.close(code=_TRY_AGAIN_LATER)
            return
        await browser.serve_relay(websocket, relay_token)

    return app
