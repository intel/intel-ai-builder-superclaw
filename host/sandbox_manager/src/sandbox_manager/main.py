"""Process entrypoint for sandbox-manager.

Boot sequence:

1. Parse the required ``--port`` flag (assigned by ServiceHub) and load
   :class:`Config` (creating data dirs).
2. Open the SQLite store, create :class:`RunManager`, and wire the
   Windows-native SANDBOX lifecycle.
3. Start uvicorn on ``--port``. The bind host is resolved by
   :func:`sandbox_manager.config.load_config` (CLI ``--host`` > env
   ``SANDBOX_MANAGER_HOST`` > default ``127.0.0.1``). The ServiceHub sub-service
   contract requires loopback-only binding; the Hub always
   passes ``--host 127.0.0.1`` explicitly, and the standalone default now
   matches it. The port is never self-allocated: if it is already bound,
   startup fails fast.

ServiceHub owns process supervision and readiness — the sub-service does not
print a handshake line or maintain a singleton/lockfile of its own.  It exits
on ServiceHub's ``POST /sandbox-manager/v1/shutdown`` (graceful) or SIGINT.

The optional ``--reload`` flag is a **standalone dev** inner-loop switch (see
README §4.1 and :mod:`sandbox_manager.dev_reload`): instead of serving, the
process supervises a worker generation of *this same* entry point and restarts it
when the package source changes. ServiceHub and the packaged exe never pass it,
so the serve path below is unchanged.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import os
import sys
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI
from loguru import logger
from superclaw_host_observability import install_crash_hooks

from . import __version__
from .api import health as health_api
from .api import v1 as v1_api
from .api.forwarded_auth import ForwardedCredentialMiddleware
from .api.process_auth import (
    ManagedPublicMutationRejected,
    managed_public_mutation_rejected,
)
from .common.logging import setup_logging
from .config import Config, load_config
from .channel_credentials import ChannelCredentialService
from .slack_install import SlackInstallService
from .control_audit import ControlAudit
from .libreoffice_install import install_libreoffice
from .version import get_app_version
from .native_backend import NativeBackendLifecycle
from .owt_cache import OwtCache
from .runs import RunManager
from .store import RUNTIME_DEPLOYMENT_CONFIG_KEY, Store
from .egress_approval_broker import ConfigChatStore, ConnectorApprovalBroker
from .tavily_api_key_store import TavilyApiKeyFileStore
from .workspace_cleanup_job import WorkspaceCleanupJob


# Selected the retired WSL/Docker backend. Native is the only backend now, so a
# leftover value (an old troubleshooting tip, an inherited shell) selects nothing;
# it is named once in the log so the case stays legible.
_RETIRED_BACKEND_MODE_ENV = "SUPERCLAW_BACKEND_MODE"


def warn_retired_backend_mode() -> None:
    """Log one warning when the retired backend-mode variable is still set."""
    value = os.environ.get(_RETIRED_BACKEND_MODE_ENV)
    if value is not None:
        logger.warning(
            "ignoring {}={!r}: the Windows-native backend is the only backend",
            _RETIRED_BACKEND_MODE_ENV,
            value,
        )


def build_app(cfg: Config) -> FastAPI:
    """Construct the FastAPI app and wire shared state.

    Exposed via ``app.state``:

    * ``config``               – :class:`Config`
    * ``store``                – :class:`Store`
    * ``run_manager``          – :class:`RunManager`
    * ``owt_cache``            – :class:`OwtCache`
    * ``lifecycle``            – :class:`NativeBackendLifecycle`
    * ``control_audit``        – :class:`ControlAudit`
    """
    # Ensure file logging is wired up regardless of how the app was constructed
    # (run() entry-point, pytest, uvicorn factory, etc.). Idempotent.
    setup_logging(cfg)

    app = FastAPI(title="SuperClaw Sandbox Manager", version=__version__)
    app.add_exception_handler(
        ManagedPublicMutationRejected,
        managed_public_mutation_rejected,
    )
    app.add_middleware(ForwardedCredentialMiddleware, process_credential=cfg.process_credential)

    store = Store(cfg.data_dir / "sbms.db")
    # Clear any runs that were left in pending/running state by a previous
    # process.  Those background tasks no longer exist; leaving them as
    # running would cause ensure_ready / download / etc. to deduplicate onto
    # zombie run_ids and never schedule real work.
    _stale = store.reset_stale_runs()
    if _stale:
        logger.info("reset {} stale run(s) from previous process", _stale)
    run_manager = RunManager(store)

    # SANDBOX components
    owt_cache = OwtCache()
    warn_retired_backend_mode()
    control_audit = ControlAudit(cfg.manager_log_dir / "control-audit.jsonl")
    # In the Sandbox Manager's own data directory, which no tier account is granted (EG1-3, #12).
    tavily_api_key_store = TavilyApiKeyFileStore(
        cfg.data_dir / "secrets" / "tavily-api-key.bin", audit=control_audit
    )
    egress_approval_broker = ConnectorApprovalBroker(audit=control_audit.record, chat_store=ConfigChatStore(store))
    # Slack and Telegram tokens are saved here, not by openwork-server, so no tier that runs the agent sees them.
    channel_credentials = ChannelCredentialService()
    slack_install = SlackInstallService(credentials=channel_credentials, store=store)
    lifecycle = NativeBackendLifecycle(
        cfg=cfg,
        store=store,
        run_manager=run_manager,
        owt_cache=owt_cache,
        tavily_api_key_store=tavily_api_key_store,
        egress_approval_broker=egress_approval_broker,
        channel_credentials=channel_credentials,
        control_audit=control_audit,
    )

    @asynccontextmanager
    async def _lifespan(_app: FastAPI):
        logger.info("lifespan starting")

        # Resume durable Deployment, never a retired ProfileSnapshot. The
        # public adapter deduplicates this wake with concurrent API requests.
        async def _resume_native_backend() -> None:
            try:
                await lifecycle.complete_outstanding_cleanup()
                if store.get_config(RUNTIME_DEPLOYMENT_CONFIG_KEY) is None:
                    logger.info("native backend: no committed Runtime Deployment yet; awaiting persist")
                    return
                logger.info("native backend: committed Runtime Deployment found; resuming backend tree")
                await lifecycle.ensure_runtime_deployment()
            except Exception:
                logger.opt(exception=True).warning("native backend resume failed")

        asyncio.create_task(_resume_native_backend(), name="bm.resume_native_backend")
        cleanup_job = WorkspaceCleanupJob(
            data_dir=cfg.data_dir,
            store=store,
        )
        asyncio.create_task(
            cleanup_job.loop(),
            name="bm.workspace_cleanup",
        )
        # Trigger a cleanup pass shortly after any top-level run completes so
        # intermediate files are removed promptly rather than waiting up to 24h.
        run_manager.register_completion_callback(cleanup_job.schedule_soon)
        logger.info("lifespan ready")
        try:
            yield
        finally:
            logger.info("lifespan shutting down")
            # §7 SANDBOX shutdown
            with contextlib.suppress(Exception):
                await lifecycle.shutdown()
            slack_install.close()
            store.close()

    app.router.lifespan_context = _lifespan

    app.state.config = cfg
    app.state.process_credential = cfg.process_credential
    app.state.store = store
    app.state.run_manager = run_manager
    app.state.owt_cache = owt_cache
    app.state.lifecycle = lifecycle
    app.state.control_audit = control_audit
    app.state.tavily_api_key_store = tavily_api_key_store
    app.state.egress_approval_broker = egress_approval_broker
    # The Office preview's LibreOffice, installed through winget after the user agreed.
    app.state.optional_package_installer = install_libreoffice
    app.state.channel_credentials = channel_credentials
    app.state.slack_install = slack_install

    app.include_router(health_api.router)
    app.include_router(v1_api.router)

    return app


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    """Parse CLI arguments.

    ``--port`` is **required**: ServiceHub assigns the control-plane port from
    ``service_cfg.json`` and passes it explicitly. The sub-service never
    self-allocates a port (see the ServiceHub sub-service contract).
    """
    parser = argparse.ArgumentParser(prog="sandbox-manager")
    parser.add_argument(
        "--port",
        type=int,
        required=True,
        help="TCP port for the control-plane HTTP server (assigned by ServiceHub)",
    )
    parser.add_argument(
        "--host",
        type=str,
        default=None,
        help=(
            "Bind address for the control-plane HTTP server. Overrides the "
            "SANDBOX_MANAGER_HOST env var; falls back to 127.0.0.1 (the contract "
            "requires loopback-only binding)."
        ),
    )
    parser.add_argument(
        "--reload",
        action="store_true",
        help=(
            "Standalone-dev only: watch this package's source tree and restart "
            "the control plane on a change, instead of serving in this process. "
            "Not used by ServiceHub or the packaged exe, and rejected in a "
            "frozen build."
        ),
    )
    return parser.parse_args(argv)


def run(argv: list[str] | None = None) -> None:  # entry-point for ``python -m sandbox_manager``
    install_crash_hooks(service="sandbox_manager", release=get_app_version())
    args = _parse_args(argv)
    cfg = load_config(port=args.port, host=args.host)
    os.environ.pop("SERVICEHUB_PROCESS_CREDENTIAL", None)
    os.environ.pop("SERVICEHUB_MANAGED", None)
    setup_logging(cfg)

    if args.reload:
        # Standalone dev only: supervise + restart a worker generation of this
        # same entry point instead of serving here. Imported lazily so the
        # packaged serve path never pulls the watcher (or watchfiles) in.
        from .dev_reload import watch_and_serve

        # The packaged service deliberately has no console sink (ServiceHub
        # captures its stdio); a supervisor whose restart lines only reached a
        # log file would be useless, so add one for this mode alone.
        logger.add(sys.stderr, level="INFO", diagnose=False)
        watch_and_serve(
            port=cfg.port,
            host=cfg.host,
            process_credential=cfg.process_credential,
        )
        return

    app = build_app(cfg)

    uv_config = uvicorn.Config(
        app,
        host=cfg.host,
        port=cfg.port,
        log_config=None,  # don't override our loguru sinks
        access_log=False,
    )
    server = uvicorn.Server(uv_config)
    # Expose the server so POST /sandbox-manager/v1/shutdown can flip
    # ``should_exit`` for a graceful ServiceHub-initiated drain + exit.
    app.state.server = server
    try:
        asyncio.run(server.serve())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":  # pragma: no cover
    run()
