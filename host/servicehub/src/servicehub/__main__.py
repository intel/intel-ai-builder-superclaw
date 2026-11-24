"""Process entrypoint for ServiceHub."""

from __future__ import annotations

import argparse
import asyncio
import atexit
import dataclasses
import json
import multiprocessing
import socket
import sys
from pathlib import Path
from typing import Sequence

import uvicorn
from loguru import logger
from superclaw_host_observability import install_crash_hooks, resolve_app_version

from servicehub import __version__
from servicehub.app import build_app
from servicehub.common.logging import setup_logging, teardown_logging
from servicehub.config import load_config
from servicehub.proactor_accept import install_accept_reset_guard
from servicehub.singleton import acquire_or_describe_existing, remove_lockfile, write_lockfile


READY_PREFIX = "SERVICEHUB_READY"
REUSE_PREFIX = "REUSE"


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="servicehub")
    parser.add_argument("--port", type=int, default=None)
    parser.add_argument("--hub-token", default=None)
    parser.add_argument("--data-dir", type=Path, default=None)
    parser.add_argument("--service-cfg", type=Path, default=None)
    parser.add_argument("--no-spawn", action="store_true")
    parser.add_argument("--contracts-import-smoke", action="store_true", help=argparse.SUPPRESS)
    return parser.parse_args(argv)


def _find_free_port(start: int) -> int:
    """A requested port is used exactly or not at all.

    The desktop shell picks it from the egress loopback port contract's fixed candidates; a
    ServiceHub that moved on to a neighbour would listen on a port no candidate list names.
    """
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        if start == 0:
            sock.bind(("127.0.0.1", 0))
            return int(sock.getsockname()[1])
        try:
            sock.bind(("127.0.0.1", start))
        except OSError as exc:
            raise RuntimeError(f"requested port {start} is not available") from exc
        return start


def emit_ready_line(*, port: int, token: str) -> str:
    payload = json.dumps({"port": port, "token": token}, separators=(",", ":"))
    return f"{READY_PREFIX} {payload}"


def emit_reuse_line(payload: dict) -> str:
    encoded = json.dumps(payload, separators=(",", ":"))
    return f"{REUSE_PREFIX} {encoded}"


async def serve_with_ready(server: uvicorn.Server, *, port: int, token: str) -> None:
    server_task = asyncio.create_task(server.serve())
    while not server.started and not server.should_exit and not server_task.done():
        await asyncio.sleep(0.01)
    if server.should_exit or server_task.done():
        # Diagnostic (ServiceHub exit-code-1 debugging): uvicorn set should_exit
        # or the serve task finished before `server.started` — almost always a
        # lifespan-startup failure (e.g. a managed child never became ready).
        # A bare `await server_task` here would re-raise the exception with no
        # attribution, or swallow it if uvicorn already consumed it. Inspect the
        # task first and log the concrete cause before propagating, so the
        # reason lands in stderr under this boot_id.
        exc: BaseException | None = None
        if server_task.done() and not server_task.cancelled():
            exc = server_task.exception()
        if exc is not None:
            logger.error(
                "servicehub exited before ready handshake on port={} error_type={} detail={}",
                port,
                type(exc).__name__,
                str(exc),
            )
        else:
            logger.error(
                "servicehub exited before ready handshake on port={} (no task exception; "
                "likely lifespan startup abort — see prior lifespan/child readiness logs)",
                port,
            )
        await server_task
        return
    sys.stdout.write(emit_ready_line(port=port, token=token) + "\n")
    sys.stdout.flush()
    logger.info("servicehub ready port={}", port)
    await server_task


def run(argv: Sequence[str] | None = None) -> None:
    if getattr(sys, "frozen", False):
        multiprocessing.freeze_support()
    install_crash_hooks(
        service="servicehub", release=resolve_app_version(package_version=__version__)
    )
    args = parse_args(argv)
    if args.contracts_import_smoke:
        from contracts.product_profile_descriptor import ProductProfileDescriptor
        from contracts.profile_snapshot import ProfileSnapshot

        if ProductProfileDescriptor.model_fields and ProfileSnapshot.model_fields:
            sys.stdout.write("CONTRACTS_IMPORT_OK\n")
            return
    cfg = None
    logging_configured = False
    is_primary = False
    stage = "load_config"
    service_cfg_hint = str(args.service_cfg) if args.service_cfg is not None else "default"
    try:
        cfg = load_config(
            port=args.port,
            hub_token=args.hub_token,
            data_dir=args.data_dir,
            service_cfg_path=args.service_cfg,
            no_spawn=args.no_spawn,
        )
        service_cfg_hint = str(cfg.service_cfg_path)
        log_path = setup_logging(cfg)
        logging_configured = True
        logger.info(
            "servicehub starting requested_port={} no_spawn={}",
            cfg.port,
            cfg.no_spawn,
        )
        logger.debug(
            "servicehub startup paths data_dir={} service_cfg={} log_file={}",
            cfg.data_dir,
            cfg.service_cfg_path,
            log_path,
        )

        stage = "singleton"
        singleton = acquire_or_describe_existing(cfg.data_dir)
        if not singleton.is_first:
            if singleton.existing:
                sys.stdout.write(
                    emit_reuse_line(
                        {
                            "pid": singleton.existing.get("pid"),
                            "port": singleton.existing.get("port"),
                            "token": singleton.existing.get("token"),
                        }
                    )
                    + "\n"
                )
            else:
                sys.stdout.write(
                    emit_reuse_line({"error": "another ServiceHub is running but lockfile is missing"})
                    + "\n"
                )
            sys.stdout.flush()
            logger.info("servicehub reuse handoff emitted")
            return

        stage = "port_selection"
        port = _find_free_port(cfg.port)
        if port != cfg.port:
            logger.info("servicehub selected free port={} requested_port={}", port, cfg.port)
            cfg = dataclasses.replace(cfg, port=port)
            service_cfg_hint = str(cfg.service_cfg_path)

        stage = "build_app"
        app = build_app(cfg)

        stage = "lockfile"
        write_lockfile(cfg.data_dir, port=cfg.port, token=cfg.hub_token)
        # Only the primary Hub owns the lockfile. REUSE handoff processes return
        # above without setting this, so their `finally` must not delete the
        # still-alive primary's lockfile.
        is_primary = True
        atexit.register(remove_lockfile, cfg.data_dir)
        uv_config = uvicorn.Config(
            app,
            host="127.0.0.1",
            port=cfg.port,
            log_config=None,
            access_log=False,
        )
        server = uvicorn.Server(uv_config)
        if hasattr(app, "state"):
            app.state.request_hub_shutdown = lambda: setattr(server, "should_exit", True)

        stage = "serve"
        logger.info("servicehub serving host=127.0.0.1 port={}", cfg.port)
        install_accept_reset_guard()
        asyncio.run(serve_with_ready(server, port=cfg.port, token=cfg.hub_token))
        logger.info("servicehub stopped")
    except KeyboardInterrupt:
        logger.info("servicehub interrupted")
    except Exception as exc:
        logger.exception(
            "servicehub startup failed stage={} service_cfg={} error_type={}",
            stage,
            service_cfg_hint,
            type(exc).__name__,
        )
        raise
    finally:
        if cfg is not None and is_primary:
            remove_lockfile(cfg.data_dir)
        if logging_configured:
            teardown_logging()


if __name__ == "__main__":  # pragma: no cover
    run()
