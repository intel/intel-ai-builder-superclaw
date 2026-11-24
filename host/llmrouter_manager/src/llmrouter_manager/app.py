"""FastAPI app assembly for llmrouter_manager.

- The stable inference bearer protects `/v1/*`. ServiceHub injects a separate
  process credential for shutdown and inference-key handoff.
- ``service_name`` / ``instance_id`` are stashed on ``app.state`` so
  ``GET /llm-router/v1/health`` (contract §5) can echo them.
- Router wiring: CORS, meta + ServiceHub template, operations, local
  namespace stubs (llama-server lifecycle not yet wired), edge, cloud, and
  the ``/v1/*`` data plane.
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI
from loguru import logger

from . import __version__
from .cloud.api import (
    catalog_router as cloud_catalog_router,
    model_router as cloud_model_router,
    providers_router as cloud_providers_router,
)
from .capability.api import capability_router
from .capability.bundle_lifecycle import (
    reset_uncatalogued_bindings,
    restore_interrupted_local_bundle,
)
from .common.api import (
    hub_template_router,
    meta_router,
    operations_router,
)
from .common.cors import install_cors
from .common.event_store import EventStore
from .common.events import set_store as _set_event_store
from .common.operations import OperationPool
from .common.store import default_db_path
from .common.usage import set_store as _set_usage_store
from .common.usage_api import usage_router
from .common.usage_store import UsageStore
from .common.management_auth import ManagementAuthMiddleware
from .config import RuntimeConfig
from .edge.api import edge_router
from .local.api import (
    inference_servers_router,
    model_selections_router,
    models_router,
    system_router,
)
from .local.deps import (
    LocalDeps,
    attach_local_deps,
    build_default_local_deps,
    get_eligibility,
)
from .local.inference_logic import get_downloader, resume_local_if_ready
from .oauth import copilot_bridge, litellm_bridge
from .oauth.api import oauth_router
from .routing.api import data_plane_router, host_data_plane_router
from .routing.auth import InferenceAuthError, inference_auth_error_response
# NOTE: `routing.auto_router.adapter` is imported lazily inside `_prewarm` (and
# in proxy.py's auto branch) — importing it here would pull joblib/numpy/scipy/
# sklearn into every LRM start, ~hundreds of MB of commit charge that a
# single-slot install never uses. Memory matters most on 16 GB SKUs (WCL).
from .routing.local_ctx_api import local_ctx_router
from .routing.local_admission import LocalRequestAdmission
from .routing.perf_weight_api import perf_weight_router
from .security import security_router
from .telemetry import is_debug_observability_enabled
from .telemetry.api import telemetry_router
from .telemetry import config as telemetry_config
from .telemetry.runtime import TelemetryRuntime


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("lifespan starting")
    # Synchronous and first: prewarm, BootResume, the restore below and the
    # first capability read must never see a Bundle the catalogue dropped.
    reset_uncatalogued_bindings(app.state)
    app.state.prewarm_done = asyncio.Event()
    telemetry_enabled = is_debug_observability_enabled()

    if telemetry_enabled and (
        not hasattr(app.state, "telemetry_runtime") or app.state.telemetry_runtime is None
    ):
        runtime = TelemetryRuntime(
            telemetry_config.load_config(),
            service_name=app.state.service_name,
            service_version=__version__,
            service_instance_id=app.state.instance_id,
        )
        runtime.configure_process_env()
        app.state.telemetry_runtime = runtime
    if telemetry_enabled and app.state.telemetry_runtime is not None:
        app.state.telemetry_runtime.start()

    async def _prewarm() -> None:
        try:
            # Import the auto-router stack ONLY when `auto` can actually use it.
            # `_resolve_alias` invokes the router solely when BOTH slots are
            # configured (proxy.py); with a single slot `auto` just serves that
            # slot. On such installs — edge-only or cloud-only, which is the
            # expected shape on 16 GB WCL — importing joblib/numpy/scipy/sklearn
            # costs hundreds of MB of commit for a code path that never runs.
            # Deferred, not removed: if a second slot is configured later, the
            # first `auto` request imports it inside its own timeout budget.
            from .routing.proxy import _load_cloud_model_config, _resolve_alias

            cloud_cfg = _load_cloud_model_config()
            _kind, local_cfg, _reason = _resolve_alias("local-model", app_state=app.state)
            if cloud_cfg is None or local_cfg is None:
                logger.info(
                    "[LatencyRouter] prewarm skipped: single-slot configuration "
                    "(cloud={}, local={}) — auto serves the configured slot and the "
                    "router stack stays unimported",
                    cloud_cfg is not None,
                    local_cfg is not None,
                )
                return

            from .routing.auto_router.adapter import prewarm_adapter

            prewarm_failure = await asyncio.to_thread(prewarm_adapter)
        except Exception:
            logger.opt(exception=True).warning(
                "[LatencyRouter] prewarm raised unexpectedly — auto will fall back to cloud-model"
            )
        else:
            if prewarm_failure is not None:
                logger.warning(
                    "[LatencyRouter] prewarm failed ({}): {} — auto will fall back to cloud-model",
                    prewarm_failure.error,
                    prewarm_failure.hint,
                )
        finally:
            app.state.prewarm_done.set()

    async def _resume_local() -> None:
        # Boot resume: spawn the active Local Bundle iff its GGUFs are already on
        # disk. Edge or absent Primary Bundles stay inert; boot never starts a
        # fresh download. Fire-and-forget so a
        # slow spawn never delays the app coming up; the data plane + in-app
        # trigger work regardless.
        try:
            await get_eligibility(app.state)
            result = await resume_local_if_ready(app.state)
        except Exception:
            logger.opt(exception=True).warning(
                "[BootResume] local resume raised unexpectedly — start the local model in-app"
            )
        else:
            if result.state == "skipped":
                logger.info("[BootResume] local not resumed: {}", result.reason)
            else:
                logger.info(
                    "[BootResume] local resume: state={} operation_id={}",
                    result.state,
                    result.operation_id,
                )

    async def _prewarm_hf_endpoint() -> None:
        # Resolve and cache the HF endpoint at startup so the first download's
        # asyncio.to_thread(_effective_hf_endpoint) is a no-op. Without this,
        # the endpoint probe (up to ~3s + thread-pool queuing) runs during the
        # first prepare POST, which arrives within ServiceHub's 15s deadline
        # window and can cause a safe_error → recovery_required on first boot.
        try:
            await asyncio.to_thread(get_downloader(app.state)._effective_hf_endpoint)
        except Exception:
            logger.opt(exception=True).warning(
                "[HFEndpoint] prewarm raised unexpectedly — first download will re-probe"
            )

    prewarm_task = asyncio.create_task(_prewarm())
    hf_endpoint_task = asyncio.create_task(_prewarm_hf_endpoint())
    resume_task = asyncio.create_task(_resume_local())
    await restore_interrupted_local_bundle(app.state)
    logger.info("lifespan ready")
    try:
        yield
    finally:
        logger.info("lifespan shutting down")
        for _task in (prewarm_task, hf_endpoint_task, resume_task):
            if not _task.done():
                _task.cancel()
                with suppress(asyncio.CancelledError):
                    await _task
        # Read only once boot resume has stopped: it can create this child while
        # the cancellations above are being awaited.
        deferred_resume_task = getattr(app.state, "_deferred_resume_task", None)
        if deferred_resume_task is not None and not deferred_resume_task.done():
            deferred_resume_task.cancel()
            with suppress(asyncio.CancelledError):
                await deferred_resume_task
        bundle_tasks = tuple(getattr(app.state, "bundle_prepare_tasks", set()))
        for task in bundle_tasks:
            if not task.done():
                task.cancel()
        for task in bundle_tasks:
            with suppress(asyncio.CancelledError):
                await task
        # Close the shared local-subsystem Store opened in build_app. The
        # llama-server process (if any) is reaped by the module-level
        # kill-on-close Job Object when this process exits.
        store = getattr(app.state, "store", None)
        if store is not None:
            with suppress(Exception):
                store.close()
        # Close telemetry client
        if telemetry_enabled and app.state.telemetry_runtime is not None:
            await asyncio.to_thread(app.state.telemetry_runtime.shutdown)

        # Close the token usage store (design 2026-07-09 section 8).
        usage_store = getattr(app.state, "usage_store", None)
        if usage_store is not None:
            with suppress(Exception):
                _set_usage_store(None)
                usage_store.close()

        # Close the diagnostic event store (2026-09-11 design §4).
        event_store = getattr(app.state, "event_store", None)
        if event_store is not None:
            with suppress(Exception):
                _set_event_store(None)
                event_store.close()


def build_app(cfg: RuntimeConfig, *, local_deps: LocalDeps | None = None) -> FastAPI:
    """Construct the FastAPI app and wire middleware + routers.

    ServiceHub identity (`service_name`, `instance_id`) is stashed on
    `app.state` so the health handler can return the exact values injected
    at spawn time (contract §4 / §5).

    `local_deps` injects a fake local subsystem (registry / store / supervisor
    / downloader / hardware) for tests; production passes `None` and the real
    subsystem is built via `build_default_local_deps()`. The WMI hardware probe
    is deferred (lazy) so construction never touches WMI — see `local/deps.py`.
    """
    if not cfg.inference_key:
        raise ValueError("LRM inference key is required")

    app = FastAPI(
        title="SuperClaw LLMRouter Manager",
        version=__version__,
        docs_url="/llm-router/docs",
        redoc_url=None,
        openapi_url="/llm-router/openapi.json",
        lifespan=lifespan,
    )

    # ServiceHub-injected identity — echoed by /llm-router/v1/health per
    # contract §5. Stored on app.state so handlers can read them without
    # re-parsing env at request time.
    app.state.service_name = cfg.service_name
    app.state.instance_id = cfg.instance_id
    app.state.process_credential = cfg.process_credential
    app.state.inference_key = cfg.inference_key
    # NO `or cfg.inference_key` FALLBACK. "No host key" must not quietly mean
    # "use the shared one": that is the pre-split behaviour, i.e. the sandbox
    # back on the pinned route, reached by a missing env var rather than by a
    # decision. `__main__` sets this explicitly in both modes -- from the
    # persisted record when managed, mirrored from the shared key only in
    # standalone dev, where there is no sandbox to exclude. Empty here means
    # misconfigured, and `require_host_inference_key` refuses.
    app.state.host_inference_key = cfg.host_inference_key
    app.state.operation_pool = OperationPool()
    app.state.bundle_prepare_tasks = set()
    app.state.bundle_prepare_recovery_lock = asyncio.Lock()
    app.state.local_request_admission = LocalRequestAdmission()
    app.state.model_binding_activation_lock = asyncio.Lock()
    app.state.edge_config_lock = asyncio.Lock()

    # Token usage persistence (design 2026-07-09 section 8). Shared DB with
    # common/store.py via default_db_path(); WAL mode handles concurrent readers.
    usage_store = UsageStore(default_db_path())
    _set_usage_store(usage_store)
    app.state.usage_store = usage_store

    # Typed diagnostic events, beside token_events in the same DB
    # (2026-09-11 benchmark-error-observability design §4). token_events is
    # usage-only: a turn that times out mid-stream writes nothing there, so the
    # failure exists only as a GAP between two rows. This table makes failures
    # queryable. error/fatal rows are written unconditionally — never gated on
    # SUPERCLAW_DEBUG_OBSERVABILITY.
    event_store = EventStore(default_db_path())
    _set_event_store(event_store)
    app.state.event_store = event_store

    # Local llama-server subsystem: registry + shared Store + role-facade
    # supervisor + downloader, unpacked onto flat app.state attributes read by
    # the local endpoints and inference_logic.ensure_model_servers_ready.
    # Injected by tests; built for real in production. No WMI probe here.
    attach_local_deps(app.state, local_deps or build_default_local_deps())

    # LRM internal state telemetry - debug observability flag on only
    if is_debug_observability_enabled():
        telemetry_runtime = TelemetryRuntime(
            telemetry_config.load_config(),
            service_name=cfg.service_name,
            service_version=__version__,
            service_instance_id=cfg.instance_id,
        )
        telemetry_runtime.configure_process_env()
        app.state.telemetry_runtime = telemetry_runtime
    else:
        app.state.telemetry_runtime = None

    install_cors(app)
    app.add_middleware(ManagementAuthMiddleware, process_credential=cfg.process_credential)
    app.add_exception_handler(InferenceAuthError, inference_auth_error_response)

    # Liveness / ServiceHub template (all under /llm-router/v1/*, no auth)
    app.include_router(meta_router)
    app.include_router(hub_template_router)

    # Operations (cross-cutting under /llm-router/v1)
    app.include_router(operations_router)
    app.include_router(capability_router)

    # Local subsystem (4 namespaces)
    app.include_router(system_router)
    app.include_router(models_router)
    app.include_router(model_selections_router)
    app.include_router(inference_servers_router)

    # Edge
    app.include_router(edge_router)

    # Cloud (catalog + providers + model singleton)
    app.include_router(cloud_catalog_router)
    app.include_router(cloud_providers_router)
    app.include_router(cloud_model_router)

    # OAuth (ChatGPT/Codex + GitHub Copilot via LiteLLM). Point each LiteLLM
    # Authenticator at our derived-cache dir BEFORE any request — else it reads
    # the wrong dir and can fall into the headless device-code login trap.
    litellm_bridge.configure_token_dir()
    copilot_bridge.configure_token_dir()
    app.include_router(oauth_router)

    # Debug-only telemetry control plane; do not expose in normal/release runs.
    if is_debug_observability_enabled():
        app.include_router(telemetry_router)

    # Control-plane perf_weight dial (quality-vs-cost balance; plan §12)
    app.include_router(perf_weight_router)

    # Control-plane local llama-server ctx-size override (experiment knob;
    # UI visibility is gated by VITE_SHOW_LOCAL_CTX_SLIDER in the frontend build).
    app.include_router(local_ctx_router)

    # Security-tab knobs: file protection mode, hybrid-fallback threshold. All persist to Store, honor env overrides.
    app.include_router(security_router)

    # /v1/* authenticated inference data plane.
    # Before the shared-key router: its `/chat/{path:path}` catchall would
    # otherwise answer `/chat/completions/pinned` first.
    app.include_router(host_data_plane_router)
    app.include_router(data_plane_router)

    # /llm-router/v1/usage/* (design 2026-07-09 section 6)
    app.include_router(usage_router)

    return app
