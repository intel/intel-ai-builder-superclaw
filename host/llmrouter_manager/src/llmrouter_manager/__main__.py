"""Process entrypoint for llmrouter_manager.

Boot sequence:

1. Parse argv (``--port``, ``--host``).
2. Read ServiceHub-injected env vars ``SERVICEHUB_SERVICE_NAME`` and
   ``SERVICEHUB_INSTANCE_ID`` (contract §4). When run standalone (no
   ServiceHub parent), both fall back to dev-friendly defaults.
3. Build FastAPI app via ``app.build_app(config)``.
4. Configure logging (stdlib file sink + stdout).
5. Store the ``uvicorn.Server`` on ``app.state.server`` so the
   ``POST /llm-router/v1/shutdown`` handler can trigger a graceful exit.
6. ``asyncio.run(server.serve())``.

Contract shape:

- No ``--token`` argv; the process credential is environment-only
  (contract §2 / §8); the trust boundary is the bind interface plus
  ServiceHub proxy gating.
- No ``LLMROUTER_READY {...}`` stdout handshake (contract §2 / §11);
  ServiceHub decides readiness via ``GET /llm-router/v1/health`` polling.
- Default ``--host`` is ``127.0.0.1``. Every caller (ServiceHub, the sandbox
  runtime, privacy_manager) is on the same machine, so the listener is
  loopback-only; cloud and capability management routes additionally require
  the ServiceHub process credential (issue #3007).

Run via::

    $env:LRM_API_KEY="dev-only-secret"
    uv run python -u -m llmrouter_manager --port 18321

``python -u`` (or ``PYTHONUNBUFFERED=1``) is recommended — the file logger
flushes per record but stdout logging benefits from line-buffered mode when
a supervisor tails it.
"""

from __future__ import annotations

import argparse
import asyncio
import multiprocessing
import os
import sys

import uvicorn
from loguru import logger
from superclaw_host_observability import install_crash_hooks, resolve_app_version

from . import __version__
from .app import build_app
from .common.inference_key import load_or_create_inference_keys
from .common.logging import setup_logging
from .config import RuntimeConfig


# Dev defaults applied when the corresponding env var is missing (i.e. when
# the process is run standalone via `uv run`, not under ServiceHub). Using
# stable strings keeps `/llm-router/v1/health` deterministic in dev.
_DEV_SERVICE_NAME = "llmrouter_manager"
_DEV_INSTANCE_ID = "dev-instance"


def _parse_args(argv: list[str] | None = None) -> RuntimeConfig:
    parser = argparse.ArgumentParser(
        prog="llmrouter_manager",
        description="SuperClaw LLMRouter Manager.",
    )
    parser.add_argument(
        "--port",
        type=int,
        required=True,
        help="TCP port to listen on. Fixed by ServiceHub's service_cfg.json.",
    )
    parser.add_argument(
        "--host",
        type=str,
        default="127.0.0.1",
        help="Bind host (default 127.0.0.1; every caller is on the same machine).",
    )
    ns = parser.parse_args(argv)

    service_name = os.environ.get("SERVICEHUB_SERVICE_NAME") or _DEV_SERVICE_NAME
    instance_id = os.environ.get("SERVICEHUB_INSTANCE_ID") or _DEV_INSTANCE_ID
    process_credential = os.environ.get("SERVICEHUB_PROCESS_CREDENTIAL", "")
    managed = os.environ.get("SERVICEHUB_MANAGED") == "1"
    if managed:
        if not process_credential:
            parser.error("SERVICEHUB_PROCESS_CREDENTIAL is required in managed mode")
        inference_key, host_inference_key = load_or_create_inference_keys()
    else:
        inference_key = os.environ.get("LRM_API_KEY", "").strip()
        if not inference_key:
            parser.error("LRM_API_KEY is required in standalone mode")
        # Standalone dev has no sandbox, so there is nothing to withhold the
        # host key from; the one supplied key serves both planes.
        host_inference_key = inference_key

    return RuntimeConfig(
        host=ns.host,
        port=ns.port,
        service_name=service_name,
        instance_id=instance_id,
        process_credential=process_credential,
        inference_key=inference_key,
        host_inference_key=host_inference_key,
    )


def run() -> None:
    """Entry-point for `python -m llmrouter_manager`."""
    if getattr(sys, "frozen", False):
        multiprocessing.freeze_support()
    install_crash_hooks(
        service="llmrouter_manager", release=resolve_app_version(package_version=__version__)
    )
    # Belt-and-suspenders for unbuffered stdout in case the parent forgot `-u`.
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except (AttributeError, ValueError):
        pass

    cfg = _parse_args()
    os.environ.pop("SERVICEHUB_PROCESS_CREDENTIAL", None)
    os.environ.pop("SERVICEHUB_MANAGED", None)
    app = build_app(cfg)

    setup_logging()

    logger.info(
        "service.startup pid={} version={} host={} port={} service={} instance_id={}",
        os.getpid(),
        __version__,
        cfg.host,
        cfg.port,
        cfg.service_name,
        cfg.instance_id,
    )

    uv_config = uvicorn.Config(
        app,
        host=cfg.host,
        port=cfg.port,
        log_config=None,
        access_log=False,
    )
    server = uvicorn.Server(uv_config)
    # Store the server on app.state so `POST /llm-router/v1/shutdown`
    # (contract §7) can flip `should_exit` for a graceful drain + exit.
    app.state.server = server

    try:
        asyncio.run(server.serve())
    except KeyboardInterrupt:
        pass
    finally:
        logger.info(
            "service.shutdown pid={} version={}",
            os.getpid(),
            __version__,
        )


if __name__ == "__main__":  # pragma: no cover
    run()
