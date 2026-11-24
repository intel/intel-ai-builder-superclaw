"""FastAPI app assembly for ServiceHub."""

from __future__ import annotations

import asyncio
import time
from contextlib import asynccontextmanager
from collections.abc import Awaitable, Callable

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send
from loguru import logger

from servicehub import __version__
from servicehub.app_routes import events, meta, operations, preflight, readiness, sandbox, status, system
from servicehub.auth.bearer import (
    is_whitelisted,
    require_hub_token,
    require_hub_token_for_request,
)
from servicehub.config import Config
from servicehub.capability import api as capability_api
from servicehub.capability.lifecycle import CapabilityLifecycle
from servicehub.model_binding_activation import api as model_binding_activation_api
from servicehub.events.ring_buffer import EventRingBuffer
from servicehub.operations.tracker import OperationTracker
from servicehub.proxy.forwarder import ProxyForwarder, normalized_upstream_path
from servicehub.proxy.error_normalizer import service_dormant, service_not_found, service_start_failed
from servicehub.proxy.router import resolve_service
from servicehub.proxy.service_client import ServiceClient
from servicehub.app_readiness.refresher import RuntimeEvidenceRefresher
from servicehub.app_readiness.store import ReadinessStore
from servicehub.adapters.privacy_model_boot import reconcile_retained_file_protection
from servicehub.supervisor.process_manager import ProcessManager
from servicehub.supervisor.watchdog import Watchdog


class ProxyFallbackMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self._app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self._app(scope, receive, send)
            return

        responder = _FallbackResponder(send)
        await self._app(scope, receive, responder.send)
        # A 404 means "the hub has no such route" only when the router matched nothing. A
        # route that matched and answered 404 itself - e.g. the LRM preflight gate below
        # forwarding an upstream `route_not_found` verbatim - has already read the request,
        # and proxying it a second time would both discard that answer and hang: the ASGI
        # `receive` channel yields the request once, and a second read blocks until the
        # response completes, which cannot happen while this call is still producing it.
        if not responder.should_proxy or _router_matched(scope):
            await responder.flush()
            return

        request = Request(scope, receive)
        app = request.app
        if _is_restricted_internal_path(normalized_upstream_path(request)):
            response = JSONResponse(
                status_code=404,
                content={"error": {"code": "not_found", "message": "Not found."}},
            )
            await response(scope, receive, send)
            return
        prefix = _first_path_segment(scope.get("path", ""))
        if prefix is None:
            await responder.flush()
            return
        if prefix in _HUB_OWNED_PREFIXES:
            await responder.flush()
            return
        try:
            if not is_whitelisted(request.url.path):
                await require_hub_token_for_request(request)
            process_manager = app.state.process_manager
            service = process_manager.registry.get_by_prefix(prefix)
            if service is None:
                entry = process_manager.entry_by_prefix(prefix)
                if entry is None:
                    raise service_not_found(prefix)
                if entry.startup != "on_demand":
                    raise service_not_found(prefix)
                if request.url.path.endswith(("/v1/health", "/v1/version")):
                    raise service_dormant(entry.name)
                try:
                    service = await process_manager.ensure_started(entry.name)
                except Exception:
                    logger.exception("on-demand child failed to start name={}", entry.name)
                    raise service_start_failed(entry.name) from None
            service = resolve_service(process_manager.registry, prefix)
            response = await app.state.proxy_forwarder.forward(request, service)
        except HTTPException as exc:
            response = _http_exception_response(exc)
        await response(scope, receive, send)


class _FallbackResponder:
    def __init__(self, send: Send) -> None:
        self._send = send
        self._messages: list[dict[str, object]] = []
        self.should_proxy = False

    async def send(self, message: dict[str, object]) -> None:
        if message["type"] == "http.response.start" and message["status"] == 404:
            self.should_proxy = True
        self._messages.append(message)

    async def flush(self) -> None:
        for message in self._messages:
            await self._send(message)


def _router_matched(scope: Scope) -> bool:
    """True when the router dispatched to a route rather than 404ing itself.

    Starlette's `Route.matches` puts `endpoint` into the matched child scope and FastAPI's
    `APIRoute` adds `route`; the router merges those into the live scope this middleware
    still holds, so their absence once the app has run is what identifies the router's own
    "Not Found" as opposed to a 404 a route chose to return.
    """
    return scope.get("route") is not None or scope.get("endpoint") is not None


def _first_path_segment(path: str) -> str | None:
    parts = [part for part in path.split("/") if part]
    if not parts:
        return None
    return f"/{parts[0]}"


_HUB_OWNED_PREFIXES = frozenset({"/app"})


def _is_restricted_internal_path(path: str) -> bool:
    segments = [segment for segment in path.split("/") if segment]
    return segments[:3] in (
        ["sandbox-manager", "v1", "internal"],
        ["data-protection", "v1", "internal"],
    )


def _http_exception_response(exc: HTTPException) -> JSONResponse:
    if isinstance(exc.detail, dict) and "error" in exc.detail:
        return JSONResponse(
            status_code=exc.status_code,
            content=exc.detail,
            headers=exc.headers,
        )
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": {"code": "http_error", "message": str(exc.detail)}},
        headers=exc.headers,
    )


def build_app(
    cfg: Config, *, capability: CapabilityLifecycle | None = None
) -> FastAPI:
    cfg.ensure_directories()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        try:
            lifespan_t0 = time.monotonic()

            def elapsed_ms(start: float) -> int:
                return round((time.monotonic() - start) * 1000)

            logger.info("servicehub lifespan starting no_spawn={}", cfg.no_spawn)
            spawn_ms = 0
            if not cfg.no_spawn:
                spawn_t0 = time.monotonic()
                await app.state.process_manager.spawn_all()
                spawn_ms = elapsed_ms(spawn_t0)
                app.state.background_tasks.append(
                    asyncio.create_task(
                        reconcile_retained_file_protection(
                            app.state.process_manager.registry,
                            app.state.service_client,
                        ),
                        name="servicehub.privacy-model-boot",
                    )
                )
                app.state.watchdog_task = asyncio.create_task(app.state.watchdog.run())
                app.state.background_tasks.append(
                    asyncio.create_task(
                        app.state.readiness_refresher.run(),
                        name="servicehub.app-readiness-refresher",
                    )
                )
            elif cfg.service_cfg_path.is_file():
                # Dev/test no-spawn callers may construct a Hub without a service
                # config. Load declarations when present so catalog/proxy behavior
                # still matches normal mode, without changing that existing seam.
                app.state.process_manager.load_declarations()
            coordinator = getattr(getattr(app.state, "capability", None), "model_binding_activation_coordinator", None)
            recover_ms = 0
            if coordinator is not None:
                logger.info("servicehub lifespan recovering Model Binding Activation coordinator")
                recover_t0 = time.monotonic()
                await coordinator.recover()
                recover_ms = elapsed_ms(recover_t0)
            capability_lifecycle = getattr(app.state, "capability", None)
            reconcile_ms = 0
            if capability_lifecycle is not None and cfg.capability_gating_v1:
                reconcile_t0 = time.monotonic()
                reconcile_outcome = await capability_lifecycle.reconcile_active_profile_against_artifacts()
                reconcile_ms = elapsed_ms(reconcile_t0)
                logger.info("servicehub lifespan capability reconcile outcome={}", reconcile_outcome)
            # uvicorn sets `server.started` only after this phase returns, so
            # `total_ms` is how long the Hub could serve but was not allowed to.
            logger.info(
                "startup.lifespan.complete total_ms={} spawn_ms={} recover_ms={} reconcile_ms={}",
                elapsed_ms(lifespan_t0),
                spawn_ms,
                recover_ms,
                reconcile_ms,
            )
            logger.info("servicehub lifespan ready")
            yield
        except BaseException as exc:
            # Diagnostic (ServiceHub exit-code-1 debugging): a startup failure
            # here (e.g. a managed child like llmrouter_manager never becoming
            # ready, so spawn_all() raises) propagates out of the lifespan and
            # aborts uvicorn startup — but nothing logged WHY, so the host-side
            # tauri.log only showed the last `readiness.first_probe` then a bare
            # exit-code-1. Log the full traceback before re-raising so the cause
            # reaches stderr → tauri logs under this boot_id. Catch
            # BaseException (not just Exception) so a startup KeyboardInterrupt/
            # cancellation is still attributed; it is re-raised unchanged.
            #
            # `GeneratorExit` is excluded: it is the normal @asynccontextmanager
            # teardown signal (the `yield` above being closed), not a startup
            # failure, and must propagate silently.
            if not isinstance(exc, GeneratorExit):
                logger.exception(
                    "servicehub lifespan startup failed error_type={}",
                    type(exc).__name__,
                )
            raise
        finally:
            logger.info("servicehub lifespan shutting down")
            process_manager = getattr(app.state, "process_manager", None)
            if process_manager is not None:
                process_manager.begin_shutdown()
            watchdog = getattr(app.state, "watchdog", None)
            if watchdog is not None:
                watchdog.stop()
            readiness_refresher = getattr(app.state, "readiness_refresher", None)
            if readiness_refresher is not None:
                readiness_refresher.stop()
            background_tasks = getattr(app.state, "background_tasks", [])
            for task in list(background_tasks):
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
                except Exception as exc:
                    logger.warning(
                        "background task cleanup failed task={} error_type={} detail={}",
                        task.get_name(),
                        type(exc).__name__,
                        str(exc),
                    )
            watchdog_task = getattr(app.state, "watchdog_task", None)
            if watchdog_task is not None:
                watchdog_task.cancel()
                try:
                    await watchdog_task
                except asyncio.CancelledError:
                    pass
                except Exception as exc:
                    logger.warning(
                        "watchdog task cleanup failed error_type={} detail={}",
                        type(exc).__name__,
                        str(exc),
                    )
            capability_lifecycle = getattr(app.state, "capability", None)
            if capability_lifecycle is not None:
                await _close_resource("capability lifecycle", capability_lifecycle.aclose)
            proxy_forwarder = getattr(app.state, "proxy_forwarder", None)
            if proxy_forwarder is not None:
                await _close_resource("proxy forwarder", proxy_forwarder.aclose)
            service_client = getattr(app.state, "service_client", None)
            if service_client is not None:
                await _close_resource("service client", service_client.aclose)
            restricted_sandbox = getattr(
                app.state, "restricted_sandbox_lifecycle_client", None
            )
            if capability_lifecycle is None and restricted_sandbox is not None:
                await _close_resource("restricted sandbox client", restricted_sandbox.aclose)
            if not cfg.no_spawn:
                await _close_resource("process manager", app.state.process_manager.shutdown_all)

    process_manager = ProcessManager(cfg)
    readiness_store = ReadinessStore(process_manager=process_manager)
    process_manager.set_health_recorder(readiness_store.record_child_health)
    app = FastAPI(
        title="SuperClaw ServiceHub",
        version=__version__,
        dependencies=[Depends(require_hub_token)],
        lifespan=lifespan,
    )
    app.state.config = cfg
    app.state.process_manager = process_manager
    app.state.proxy_forwarder = ProxyForwarder(
        process_credential=lambda service: process_manager.current_process_credential(
            service.name, expected_instance_id=service.instance_id
        )
    )
    app.state.service_client = ServiceClient(
        process_credential=lambda service: process_manager.current_process_credential(
            service.name, expected_instance_id=service.instance_id
        )
    )
    app.state.operation_tracker = OperationTracker()
    app.state.event_buffer = EventRingBuffer()
    app.state.event_tickets = {}
    app.state.active_event_streams = 0
    app.state.max_event_streams = 10
    app.state.background_tasks = []
    app.state.drain_background_tasks_for_tests = False
    app.state.operation_poll_interval_s = 0.5
    app.state.request_hub_shutdown = None
    app.state.readiness_store = readiness_store
    app.state.watchdog = Watchdog(
        registry=process_manager.registry,
        trigger_self_heal=process_manager.trigger_self_heal,
        record_health=readiness_store.record_child_health,
    )
    app.state.readiness_refresher = RuntimeEvidenceRefresher(
        registry=process_manager.registry,
        service_client=app.state.service_client,
        store=readiness_store,
    )
    app.include_router(meta.router)
    app.include_router(status.router)
    app.include_router(readiness.router)
    app.include_router(preflight.router)
    app.include_router(preflight.lrm_preflight_router)
    app.include_router(system.router)
    app.include_router(operations.router)
    app.include_router(events.router)
    app.include_router(sandbox.router)
    app.state.capability = capability or CapabilityLifecycle.create(cfg.data_dir)
    app.state.capability.wire_model_binding_activation_coordinator(
        registry=process_manager.registry,
        background_tasks=app.state.background_tasks,
        sandbox_credential_supplier=lambda: process_manager.current_process_credential(
            "sandbox_manager"
        ),
        lrm_credential_supplier=lambda service: process_manager.current_process_credential(
            service.name, expected_instance_id=service.instance_id
        ),
    )
    app.state.restricted_sandbox_lifecycle_client = (
        app.state.capability.restricted_sandbox_lifecycle_client
    )

    async def active_bundle_id() -> str | None:
        active = await app.state.capability.profile_store.get_active()
        if active is None or active.primary_bundle is None:
            return None
        return active.primary_bundle.bundle_id

    process_manager.set_active_bundle_id_supplier(active_bundle_id)

    if cfg.capability_gating_v1:
        app.include_router(capability_api.router)
    app.include_router(model_binding_activation_api.router)
    app.add_middleware(ProxyFallbackMiddleware)

    @app.exception_handler(HTTPException)
    async def http_exception_handler(
        request: Request, exc: HTTPException
    ) -> JSONResponse:
        return _http_exception_response(exc)

    return app


async def _close_resource(name: str, closer: Callable[[], Awaitable[None]]) -> None:
    try:
        await closer()
    except Exception as exc:
        logger.warning(
            "{} cleanup failed error_type={} detail={}",
            name,
            type(exc).__name__,
            str(exc),
        )
