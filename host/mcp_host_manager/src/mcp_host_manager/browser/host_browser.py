"""The visible host browser: its persisted configuration, the Edge it launches, and the CDP relay."""

from __future__ import annotations

import asyncio
import contextlib
import hmac
import json
import os
import re
import secrets
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from contracts.host_mcp_api_data import HOST_MCP_RULES
from loguru import logger
from starlette.websockets import WebSocket

from .cdp_filter import BrowserPolicy, CdpRules, OriginDecision, OriginPolicy, http_origin
from .edge import HostBrowserUnavailable, default_user_data_dir, launch_edge
from .identity_guard import (
    INPRIVATE_POLICY,
    IdentityFinding,
    PolicyUnreadable,
    ProfileUnreadable,
    find_identity,
    inprivate_disabled_by_policy,
)
from .relay import AuditFn, CdpRelay, OriginApprover, Resolver, close_quietly, resolve_host

CONFIG_FILE = "browser.json"
CLOSE_POLICY_VIOLATION = 1008
CLOSE_INTERNAL_ERROR = 1011
CLOSE_TRY_AGAIN_LATER = 1013
_GRACEFUL_CLOSE_S = 1.0
_PUMP_DRAIN_S = 2.0
_VERSION_TIMEOUT_S = 15.0
# Implicit sign-in landed in Preferences about 2 s after launch on an Entra-joined test machine and in
# Local State about 11 s after; a client is served only once the profile has stayed clean this long.
IDENTITY_SETTLE_S = 10.0
_IDENTITY_SETTLE_POLL_S = 0.5
IDENTITY_WATCH_S = 2.0
IDENTITY_REFUSAL = "the host browser is refused: Edge signed its profile in to a user account"
INPRIVATE_DISABLED = "the host browser is unavailable: Edge policy turns InPrivate off (InPrivateModeAvailability=1)"
INPRIVATE_POLICY_UNREADABLE = "the host browser is unavailable: Edge's InPrivateModeAvailability policy could not be read"
INPRIVATE_UNAVAILABLE = "the host browser is unavailable: Edge did not open an InPrivate (off-the-record) context"
PAUSED_REASON = "the host gateway is paused; resume it to use the browser"
# Consecutive polls that found a profile file present but unreadable before the guard gives up.
PROFILE_UNREADABLE_POLLS_MAX = 5
_ORIGIN_DEFAULTS: tuple[OriginDecision, ...] = ("allow", "ask", "deny")
_WINDOWS_ABSOLUTE_PATH = re.compile(r'[A-Za-z]:\\[^\x00-\x1f\x7f-\x9f<>:"|?*]*')
_RESERVED_DEVICE_NAMES = frozenset(HOST_MCP_RULES["windows_reserved_device_names"])


class BrowserProcess(Protocol):
    pid: int

    def start(self, loop: asyncio.AbstractEventLoop) -> None: ...

    def send(self, message: str) -> None: ...

    async def receive(self) -> str | None: ...

    def wait_exit(self, timeout_s: float) -> bool: ...

    def kill(self) -> None: ...

    def close(self) -> None: ...


@dataclass(frozen=True)
class BrowserConfig:
    relay_token: str
    downloads_dir: Path
    upload_roots: tuple[Path, ...]
    origins: OriginPolicy

    def to_json(self) -> dict[str, object]:
        return {
            "relay_token": self.relay_token,
            "downloads_dir": str(self.downloads_dir),
            "upload_roots": [str(root) for root in self.upload_roots],
            "origin_policy": {
                "default": self.origins.default,
                "allow": sorted(self.origins.allow),
                "deny": sorted(self.origins.deny),
            },
        }

    @classmethod
    def from_json(cls, data: object) -> BrowserConfig:
        """The saved config, validated as strictly as the API request; raises ValueError otherwise."""
        if not isinstance(data, dict):
            raise ValueError("browser config is not an object")
        token, roots = data["relay_token"], data["upload_roots"]
        if not isinstance(token, str) or not re.fullmatch(HOST_MCP_RULES["token_pattern"], token):
            raise ValueError("browser config relay token does not match the token pattern")
        if not isinstance(roots, list) or len(roots) > HOST_MCP_RULES["upload_roots_max"]:
            raise ValueError("browser config upload roots are not a short list")
        return cls(
            relay_token=token,
            downloads_dir=_windows_absolute_path(data["downloads_dir"]),
            upload_roots=tuple(_windows_absolute_path(root) for root in roots),
            origins=_validated_origin_policy(data["origin_policy"]),
        )


@dataclass
class _Running:
    process: BrowserProcess
    relay: CdpRelay
    ready: asyncio.Future[None]
    pump: asyncio.Task[None] | None = None
    guard: asyncio.Task[None] | None = None


def default_projects_root() -> Path:
    return Path.home() / "SuperClawProjects"


class HostBrowser:
    def __init__(
        self,
        *,
        state_dir: Path,
        approvals: OriginApprover,
        audit: AuditFn,
        port: int,
        user_data_dir: Path | None = None,
        paused: Callable[[], bool] = lambda: False,
    ) -> None:
        self._config_path = state_dir / CONFIG_FILE
        self._paused = paused
        self._approvals = approvals
        self._audit = audit
        self._port = port
        self._user_data_dir = user_data_dir or default_user_data_dir()
        self._rules = CdpRules.from_contract()
        self._config = _load_config(self._config_path)
        self._running: _Running | None = None
        self._lock = asyncio.Lock()
        self._client_connected = False
        self._version: dict[str, object] = {}
        self._spawn: Callable[[Path], BrowserProcess] = launch_edge
        self._resolve: Resolver = resolve_host
        self._inprivate_disabled: Callable[[], bool] = inprivate_disabled_by_policy
        self._find_identity: Callable[[Path], IdentityFinding | None] = find_identity
        self._settle_s = IDENTITY_SETTLE_S
        self._watch_s = IDENTITY_WATCH_S
        # Set when Edge turned out to carry an identity; every connection is refused until the
        # configuration is written again.
        self._refusal: str | None = None

    def configure(self, request: dict[str, object]) -> dict[str, object]:
        root = default_projects_root()
        downloads = request.get("downloads_dir")
        roots = request.get("upload_roots")
        config = BrowserConfig(
            relay_token=self._config.relay_token if self._config else secrets.token_urlsafe(32),
            downloads_dir=Path(downloads) if isinstance(downloads, str) else root / "downloads",
            upload_roots=(
                tuple(Path(item) for item in roots if isinstance(item, str)) if isinstance(roots, list) else (root,)
            ),
            origins=_origin_policy(request.get("origin_policy")),
        )
        config.downloads_dir.mkdir(parents=True, exist_ok=True)
        _write_atomic(self._config_path, config.to_json())
        self._config = config
        self._refusal = None
        return self.view()

    async def unconfigure(self) -> dict[str, object]:
        """Forget the configuration, then stop Edge, in one hold of the lock.

        The config goes first, so a relay already accepted cannot launch Edge again, and nothing
        awaits between clearing it and dropping the running Edge, so no view is unconfigured but active.
        """
        async with self._lock:
            self._config = None
            self._refusal = None
            self._config_path.unlink(missing_ok=True)
            stopped = await self._stop_locked()
        if stopped is not None:
            self._audit("browser_stopped", pid=stopped)
        return self.view()

    def view(self) -> dict[str, object]:
        return {
            "configured": self._config is not None,
            "active": self._running is not None,
            "cdp_endpoint": self._endpoint(),
        }

    async def stop(self) -> bool:
        async with self._lock:
            stopped = await self._stop_locked()
        if stopped is None:
            return False
        self._audit("browser_stopped", pid=stopped)
        return True

    async def _stop_locked(self, *, graceful: bool = True) -> int | None:
        """Stop the running Edge, if any, and return its pid. The caller holds the lock."""
        running, self._running = self._running, None
        if running is None:
            return None
        _end_guard(running)
        if graceful and not running.relay.finished:
            running.relay.inject("Browser.close")
        await asyncio.to_thread(_shut_down if graceful else _kill, running.process)
        if running.pump is not None:
            try:
                await asyncio.wait_for(running.pump, _PUMP_DRAIN_S)
            except TimeoutError:
                logger.error("host browser relay did not drain after Edge was stopped")
        await asyncio.to_thread(running.process.close)
        return running.process.pid

    def json_version(self, relay_token: str) -> dict[str, object] | None:
        if not self._token_matches(relay_token):
            return None
        version = self._version
        return {
            "Browser": version.get("product", "Edg"),
            "Protocol-Version": version.get("protocolVersion", "1.3"),
            "User-Agent": version.get("userAgent", ""),
            "V8-Version": version.get("jsVersion", ""),
            "WebKit-Version": version.get("revision", ""),
            "webSocketDebuggerUrl": self._endpoint(),
        }

    async def serve_relay(self, websocket: WebSocket, relay_token: str) -> None:
        if not self._token_matches(relay_token):
            await websocket.close(code=CLOSE_POLICY_VIOLATION)
            return
        if self._client_connected:
            await websocket.accept()
            await websocket.close(code=CLOSE_TRY_AGAIN_LATER)
            return
        self._client_connected = True
        try:
            await websocket.accept()
            try:
                relay = await self._ensure_running()
            except HostBrowserUnavailable as error:
                if self._paused():
                    await websocket.close(code=CLOSE_TRY_AGAIN_LATER, reason=PAUSED_REASON)
                    return
                logger.warning("host browser could not start: {}", error)
                self._audit("browser_unavailable")
                await websocket.close(code=CLOSE_INTERNAL_ERROR, reason=str(error)[:120])
                return
            await relay.serve(websocket)
        finally:
            self._client_connected = False

    async def aclose(self) -> None:
        await self.stop()

    def _endpoint(self) -> str | None:
        if self._config is None:
            return None
        return f"ws://127.0.0.1:{self._port}/mcp-host/cdp/{self._config.relay_token}"

    def _token_matches(self, relay_token: str) -> bool:
        expected = self._config.relay_token if self._config else secrets.token_urlsafe(32)
        matches = hmac.compare_digest(relay_token.encode("utf-8", "replace"), expected.encode("utf-8"))
        return matches and self._config is not None

    def _policy(self) -> BrowserPolicy:
        config = self._config
        if config is None:
            return BrowserPolicy(
                downloads_dir=default_projects_root() / "downloads",
                upload_roots=(),
                origins=OriginPolicy(default="deny"),
            )
        return BrowserPolicy(downloads_dir=config.downloads_dir, upload_roots=config.upload_roots, origins=config.origins)

    async def _ensure_running(self) -> CdpRelay:
        """The relay to a running Edge whose profile carries no identity and which opens InPrivate
        contexts; launches Edge if none is running.

        The gateway's pause is checked before every step that could start Edge and after every
        await, so a stop-all that lands while this runs never leaves Edge running.
        """
        async with self._lock:
            if self._config is None:
                raise HostBrowserUnavailable("the host browser is not configured")
            if self._refusal is not None:
                raise HostBrowserUnavailable(self._refusal)
            self._raise_if_paused()
            launched = self._running is None or self._running.relay.finished
            if launched:
                await self._retire_finished_locked()
                try:
                    disabled = await asyncio.to_thread(self._inprivate_disabled)
                except PolicyUnreadable as error:
                    logger.warning("host browser InPrivate policy unreadable: {}", error)
                    self._audit("browser_inprivate_unavailable", source="policy:unreadable")
                    raise HostBrowserUnavailable(INPRIVATE_POLICY_UNREADABLE) from error
                if disabled:
                    self._audit("browser_inprivate_unavailable", source=f"policy:{INPRIVATE_POLICY}")
                    raise HostBrowserUnavailable(INPRIVATE_DISABLED)
                self._raise_if_paused()
                process = await asyncio.to_thread(self._spawn, self._user_data_dir)
                loop = asyncio.get_running_loop()
                process.start(loop)
                relay = CdpRelay(
                    process,
                    rules=self._rules,
                    policy=self._policy,
                    approvals=self._approvals,
                    audit=self._audit,
                    resolve=self._resolve,
                )
                self._running = _Running(process=process, relay=relay, ready=loop.create_future())
                self._running.pump = asyncio.create_task(self._pump(self._running))
                self._running.guard = asyncio.create_task(self._guard(self._running))
                self._audit("browser_launched", pid=process.pid)
                if self._paused():
                    await self._stop_locked(graceful=False)
                    self._audit("browser_stopped", pid=process.pid)
                    raise HostBrowserUnavailable(PAUSED_REASON)
            running = self._running
            assert running is not None  # set above, or checked running under the lock
        if launched:
            try:
                self._version = await running.relay.command("Browser.getVersion", timeout=_VERSION_TIMEOUT_S)
            except (ConnectionError, TimeoutError) as error:
                await self.stop()
                raise HostBrowserUnavailable("Edge did not answer on the DevTools pipe") from error
            await self._probe_inprivate(running.relay)
            await self._stop_if_paused()
        await asyncio.shield(running.ready)
        await self._stop_if_paused()
        return running.relay

    async def _probe_inprivate(self, relay: CdpRelay) -> None:
        """Open and dispose of one off-the-record context: clients get nothing else, so an Edge that
        cannot open one is stopped and reported unavailable."""
        try:
            created = await relay.command("Target.createBrowserContext", timeout=_VERSION_TIMEOUT_S)
        except (ConnectionError, TimeoutError):
            created = {}
        context = created.get("browserContextId")
        if not isinstance(context, str):
            if self._refusal is not None:
                raise HostBrowserUnavailable(self._refusal)  # the guard killed Edge meanwhile
            self._audit("browser_inprivate_unavailable", source="edge:create_browser_context_failed")
            await self.stop()
            raise HostBrowserUnavailable(INPRIVATE_UNAVAILABLE)
        relay.inject("Target.disposeBrowserContext", {"browserContextId": context})

    async def _retire_finished_locked(self) -> None:
        """An Edge whose pipe closed but which is still being disposed: let its pump finish, and stop
        it outright if that takes too long, so a new launch never shares the profile with it."""
        stale = self._running
        if stale is None:
            return
        if stale.pump is not None:
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(asyncio.shield(stale.pump), _PUMP_DRAIN_S)
        if self._running is stale:
            stopped = await self._stop_locked(graceful=False)
            if stopped is not None:
                self._audit("browser_stopped", pid=stopped)

    def _raise_if_paused(self) -> None:
        if self._paused():
            raise HostBrowserUnavailable(PAUSED_REASON)

    async def _stop_if_paused(self) -> None:
        if self._paused():
            await self.stop()
            raise HostBrowserUnavailable(PAUSED_REASON)

    async def _guard(self, running: _Running) -> None:
        """Check the profile for an identity: through the settle window before the first client,
        then for as long as Edge runs. Any finding ends Edge and refuses the browser."""
        loop = asyncio.get_running_loop()
        settled_at = loop.time() + self._settle_s
        unreadable_polls = 0
        try:
            while True:
                try:
                    finding = await asyncio.to_thread(self._inspect)
                except ProfileUnreadable as error:
                    unreadable_polls += 1
                    logger.warning("host browser profile unreadable on poll {}: {}", unreadable_polls, error)
                    if unreadable_polls >= PROFILE_UNREADABLE_POLLS_MAX:
                        await self._refuse_running(running, IdentityFinding(source="profile:unreadable"))
                        return
                else:
                    unreadable_polls = 0
                    if finding is not None:
                        await self._refuse_running(running, finding)
                        return
                    if not running.ready.done() and loop.time() >= settled_at:
                        running.ready.set_result(None)
                await asyncio.sleep(self._watch_s if running.ready.done() else _IDENTITY_SETTLE_POLL_S)
        finally:
            _fail_ready(running, "Edge stopped before it was checked")

    def _inspect(self) -> IdentityFinding | None:
        return self._find_identity(self._user_data_dir)

    def _refuse(self, finding: IdentityFinding) -> None:
        self._refusal = IDENTITY_REFUSAL
        self._audit("browser_refused_identity", source=finding.source, domain=finding.domain)
        logger.error("host browser refused: it carries a user identity (source={} domain={})", finding.source, finding.domain)

    async def _refuse_running(self, running: _Running, finding: IdentityFinding) -> None:
        """Stop relaying, kill Edge, and only then tell anyone waiting, so no client sees the refusal
        while the signed-in browser still runs."""
        self._refuse(finding)
        client = running.relay.detach_client()
        async with self._lock:
            stopped = await self._stop_locked(graceful=False) if self._running is running else None
        if stopped is not None:
            self._audit("browser_stopped", pid=stopped)
        _fail_ready(running, IDENTITY_REFUSAL)
        if client is not None:
            await close_quietly(client, CLOSE_INTERNAL_ERROR, IDENTITY_REFUSAL[:120])

    async def _pump(self, running: _Running) -> None:
        """Relay until the pipe closes; then dispose of Edge before the client hears of it.

        No lock here: `_stop_locked` waits for this task while holding it. Ownership is decided
        without an await in between, and `_running` stays set until Edge is disposed, so a client
        that reconnects meanwhile finds a finished relay and `_ensure_running` stops it first.
        """
        close_code = await running.relay.run()
        client = running.relay.detach_client()
        if self._running is running:
            _end_guard(running)
            self._audit("browser_exited", pid=running.process.pid)
            await asyncio.to_thread(_dispose, running.process)
            if self._running is running:
                self._running = None
            # Only an Edge that exited by itself is reported here; a stop or a refusal took it
            # and gives the waiting client its own reason.
            _fail_ready(running, "Edge exited")
        if client is not None:
            await close_quietly(client, close_code)


def _shut_down(process: BrowserProcess) -> None:
    process.wait_exit(_GRACEFUL_CLOSE_S)
    process.kill()


def _kill(process: BrowserProcess) -> None:
    process.kill()


def _fail_ready(running: _Running, reason: str) -> None:
    if running.ready.done():
        return
    running.ready.set_exception(HostBrowserUnavailable(reason))
    running.ready.exception()  # retrieved here, so a launch nobody waits on does not log it


def _end_guard(running: _Running) -> None:
    if running.guard is not None and running.guard is not asyncio.current_task():
        running.guard.cancel()


def _dispose(process: BrowserProcess) -> None:
    process.kill()
    process.close()


def _origin_policy(value: object) -> OriginPolicy:
    if not isinstance(value, dict):
        return OriginPolicy()
    default = value.get("default")
    allow, deny = value.get("allow"), value.get("deny")
    return OriginPolicy(
        default=next((option for option in _ORIGIN_DEFAULTS if option == default), "allow"),
        allow=frozenset(item for item in allow if isinstance(item, str)) if isinstance(allow, list) else frozenset(),
        deny=frozenset(item for item in deny if isinstance(item, str)) if isinstance(deny, list) else frozenset(),
    )


def _load_config(path: Path) -> BrowserConfig | None:
    try:
        return BrowserConfig.from_json(json.loads(path.read_text(encoding="utf-8")))
    except FileNotFoundError:
        return None
    except (OSError, ValueError, KeyError, RecursionError) as error:
        logger.error("host browser config is unreadable or invalid, treating the browser as not set up: {}", error)
        return None


def _windows_absolute_path(value: object) -> Path:
    """The contract's `HostWindowsAbsolutePathSchema`: drive-absolute, no device or dot segments."""
    if not isinstance(value, str) or not _WINDOWS_ABSOLUTE_PATH.fullmatch(value):
        raise ValueError("browser config path is not a drive-absolute Windows path")
    for segment in (part for part in value[3:].split("\\") if part):
        base = segment.split(".")[0].rstrip().upper()
        if segment in (".", "..") or segment.endswith((".", " ")) or base in _RESERVED_DEVICE_NAMES:
            raise ValueError("browser config path has a dot, trailing-space or device segment")
    return Path(value)


def _validated_origin_policy(value: object) -> OriginPolicy:
    if not isinstance(value, dict) or value.get("default") not in _ORIGIN_DEFAULTS:
        raise ValueError("browser config origin policy is malformed")
    lists: list[frozenset[str]] = []
    for name in ("allow", "deny"):
        origins = value.get(name)
        if not isinstance(origins, list) or not all(
            isinstance(origin, str) and http_origin(origin) == origin for origin in origins
        ):
            raise ValueError(f"browser config origin policy {name} list is not canonical origins")
        lists.append(frozenset(origins))
    return OriginPolicy(default=value["default"], allow=lists[0], deny=lists[1])


def _write_atomic(path: Path, data: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2)
        handle.flush()
        os.fsync(handle.fileno())
    temporary.replace(path)
