"""
LLM Pipeline service entry point.

Spawned by ServiceHub on port 18825. Conforms to the ServiceHub sub-service contract:

Args:
    --port (int, required): TCP port to listen on.
    --host (str, optional): Bind address. Defaults to 127.0.0.1 (loopback only).

Usage:
    uv run python -u -m llm_pipeline --port <port>
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import multiprocessing
import os
import sys
import time

import uvicorn
from superclaw_host_observability import install_crash_hooks, resolve_app_version

from llm_pipeline.api.server import create_app

logger = logging.getLogger("llm_pipeline")


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="llm_pipeline",
        description="SuperClaw LLM Pipeline service.",
    )
    parser.add_argument(
        "--port",
        type=int,
        required=True,
        help="TCP port to listen on.",
    )
    parser.add_argument(
        "--host",
        type=str,
        default="127.0.0.1",
        help="Bind host (default 127.0.0.1 — loopback only per ServiceHub contract).",
    )
    return parser.parse_args(argv)


async def _serve(
    args: argparse.Namespace,
    *,
    service_name: str,
    instance_id: str,
) -> None:
    app = create_app(service_name=service_name, instance_id=instance_id)
    config = uvicorn.Config(
        app,
        host=args.host,
        port=args.port,
        log_config=None,
        access_log=False,
    )
    server = uvicorn.Server(config)
    app.state.server = server
    await server.serve()


# Dev defaults when ServiceHub env vars are absent (standalone runs).
_DEV_SERVICE_NAME = "llm_pipeline"
_DEV_INSTANCE_ID = "dev-instance"
_SERVICE_VERSION = "0.1.0"


def main(argv: list[str] | None = None) -> None:
    if getattr(sys, "frozen", False):
        multiprocessing.freeze_support()
    service_name = os.environ.get("SERVICEHUB_SERVICE_NAME") or _DEV_SERVICE_NAME
    install_crash_hooks(
        service=service_name, release=resolve_app_version(package_version=_SERVICE_VERSION)
    )
    args = _parse_args(argv)
    # Startup-logging unification (2026-07-21 §4.3): include the launch boot_id in
    # every line so protected_file_guard logs correlate with tauri.log /
    # servicehub.log under the same key. Kept on stdlib logging (no loguru dep)
    # per the reviewed scope; only the format string gains the boot_id field.
    boot_id = (os.environ.get("SUPERCLAW_BOOT_ID") or "").strip() or "-"
    formatter = logging.Formatter(
        f"%(asctime)s.%(msecs)03dZ [%(levelname)s] "
        f"boot_id={boot_id} %(name)s: %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S",
    )
    formatter.converter = time.gmtime
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(formatter)
    logging.basicConfig(level=logging.INFO, handlers=[handler], force=True)

    instance_id = os.environ.get("SERVICEHUB_INSTANCE_ID") or _DEV_INSTANCE_ID

    logger.info(
        "service.startup service=%s instance_id=%s host=%s port=%d",
        service_name,
        instance_id,
        args.host,
        args.port,
    )
    asyncio.run(_serve(args, service_name=service_name, instance_id=instance_id))


if __name__ == "__main__":
    main()

