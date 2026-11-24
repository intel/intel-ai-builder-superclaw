"""Process entrypoint for mcp_host_manager.

ServiceHub passes only ``--host``/``--port`` on argv and injects ``SERVICEHUB_SERVICE_NAME``,
``SERVICEHUB_INSTANCE_ID`` and ``SERVICEHUB_PROCESS_CREDENTIAL``. The credential is captured and then
removed from the environment, so no host server this gateway starts can inherit it.

Run standalone via::

    uv run python -m mcp_host_manager --host 127.0.0.1 --port 18831
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys

import uvicorn
from fastapi import FastAPI
from loguru import logger
from superclaw_host_observability import install_crash_hooks, resolve_app_version

from . import __version__
from .app import create_app
from .config import RuntimeConfig, default_state_dir

_DEV_SERVICE_NAME = "mcp_host_manager"
_DEV_INSTANCE_ID = "dev-instance"
# The CDP relay's own byte bounds assume no client frame is larger than this.
WS_MAX_SIZE = 32 * 1024 * 1024


def _parse_args(argv: list[str] | None = None) -> RuntimeConfig:
    parser = argparse.ArgumentParser(prog="mcp_host_manager", description="SuperClaw host MCP gateway.")
    parser.add_argument("--port", type=int, required=True, help="TCP port. Fixed by ServiceHub's service_cfg.json.")
    parser.add_argument("--host", type=str, default="127.0.0.1", help="Bind host (default 127.0.0.1).")
    ns = parser.parse_args(argv)
    process_credential = os.environ.get("SERVICEHUB_PROCESS_CREDENTIAL", "")
    if os.environ.get("SERVICEHUB_MANAGED") == "1" and not process_credential:
        parser.error("SERVICEHUB_PROCESS_CREDENTIAL is required in managed mode")
    return RuntimeConfig(
        host=ns.host,
        port=ns.port,
        service_name=os.environ.get("SERVICEHUB_SERVICE_NAME") or _DEV_SERVICE_NAME,
        instance_id=os.environ.get("SERVICEHUB_INSTANCE_ID") or _DEV_INSTANCE_ID,
        process_credential=process_credential,
        state_dir=default_state_dir(),
    )


def build_server(app: FastAPI, cfg: RuntimeConfig) -> uvicorn.Server:
    return uvicorn.Server(
        uvicorn.Config(
            app,
            host=cfg.host,
            port=cfg.port,
            log_config=None,
            access_log=False,
            ws_max_size=WS_MAX_SIZE,
        )
    )


def run() -> None:
    """Entry-point for ``python -m mcp_host_manager`` and for the frozen role dispatch."""
    install_crash_hooks(
        service="mcp_host_manager", release=resolve_app_version(package_version=__version__)
    )
    try:
        sys.stdout.reconfigure(line_buffering=True)  # type: ignore[union-attr]
    except (AttributeError, ValueError):
        pass
    cfg = _parse_args()
    os.environ.pop("SERVICEHUB_PROCESS_CREDENTIAL", None)
    os.environ.pop("SERVICEHUB_MANAGED", None)
    app = create_app(cfg)
    logger.info(
        "service.startup pid={} version={} host={} port={} service={} instance_id={} state_dir={}",
        os.getpid(),
        __version__,
        cfg.host,
        cfg.port,
        cfg.service_name,
        cfg.instance_id,
        cfg.state_dir,
    )
    server = build_server(app, cfg)
    app.state.server = server
    try:
        asyncio.run(server.serve())
    except KeyboardInterrupt:
        pass
    finally:
        logger.info("service.shutdown pid={} version={}", os.getpid(), __version__)


if __name__ == "__main__":  # pragma: no cover
    run()
