"""ServiceHub entrypoint for the data protection service."""

from __future__ import annotations

import argparse
import ipaddress
import logging
import os
import secrets
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from superclaw_host_observability import install_crash_hooks, resolve_app_version

from protection_service import __version__
from protection_service.model_activation import (
    existing_models_present,
    prepare_models,
    unsupported_model_paths,
)
from protection_service.schemas import PrivacyModelsStatusResponse

_PROXY_PREFIX = "/data-protection"
_DEV_SERVICE_NAME = "privacy_manager"
_DEV_INSTANCE_ID = "dev-instance"


def _security_log_dir() -> Path:
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(base) / "SuperClaw" / "security" / "logs"
    import tempfile
    return Path(tempfile.gettempdir()) / "SuperClaw-security" / "logs"


def _setup_security_logging() -> None:
    log_dir = _security_log_dir()
    log_dir.mkdir(parents=True, exist_ok=True)
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    boot_id = (os.environ.get("SUPERCLAW_BOOT_ID") or "").strip() or "-"
    formatter = logging.Formatter(
        f"%(asctime)s.%(msecs)03dZ [%(levelname)s] "
        f"boot_id={boot_id} %(name)s: %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S",
    )
    formatter.converter = time.gmtime
    handler = logging.FileHandler(log_dir / f"privacy_manager_{today}.log", encoding="utf-8")
    handler.setFormatter(formatter)
    handler.setLevel(logging.INFO)
    stream_handler = logging.StreamHandler(sys.stdout)
    stream_handler.setFormatter(formatter)
    stream_handler.setLevel(logging.INFO)

    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.addHandler(stream_handler)
    root.setLevel(logging.INFO)
    for logger_name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        target = logging.getLogger(logger_name)
        target.handlers.clear()
        target.propagate = True
        target.setLevel(logging.INFO)


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="privacy_manager")
    parser.add_argument("--host", default=os.environ.get("SUPERCLAW_SERVICE_HOST", "127.0.0.1"))
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("SUPERCLAW_SERVICE_PORT", "18826")),
    )
    return parser.parse_args(argv)


def _resolve_config_path() -> Path:
    """Directory containing the vendored DPS tree (where the installer seeds
    `config.yaml`, and where `config.yaml.example` lives for dev fallback).

    This file is `data_protection/protection_service/servicehub_entry.py`, so
    ``parent.parent`` is `data_protection/` in BOTH layouts this service runs
    in, which is why there is no `sys.frozen` branch here (see PATCHES.md
    Patch 2 for why the old branch existed and why it collapsed):

    - Source/dev: `__file__` is the real file on disk under `data_protection/`.
    - Frozen (`privacy_manager.exe`): PyInstaller collects `protection_service`
      as a proper package one level below the bundle root
      (`privacy_manager.spec`), so `__file__` resolves under
      `sys._MEIPASS/protection_service/...` and ``parent.parent`` is
      `sys._MEIPASS` — the same directory the old code computed explicitly
      via `sys._MEIPASS`.

    If `protection_service/` is ever moved to a different nesting depth,
    update the `.parent` chain here — `tests/test_servicehub_entry.py`
    fails loudly if this stops pointing at the DPS root.
    """
    return Path(__file__).resolve().parent.parent / "config.yaml"


def _resolve_data_plane_key(managed: bool, process_credential: str) -> str:
    """Resolve startup auth without allowing inherited env to override managed state."""
    if managed:
        if not process_credential:
            raise RuntimeError("SERVICEHUB_PROCESS_CREDENTIAL is required in managed mode")
        from protection_service.data_plane_key import load_or_create_data_plane_key

        return load_or_create_data_plane_key()

    from protection_service.data_plane_key import load_standalone_data_plane_key

    return load_standalone_data_plane_key()


def _register_servicehub_routes(
    app: FastAPI,
    *,
    service_name: str,
    instance_id: str,
    process_credential: str,
    data_plane_key: str,
) -> None:
    """Register ServiceHub control routes and the credential handoff endpoint."""

    def _require_process_credential(request: Request) -> None:
        supplied = request.headers.get("X-SuperClaw-Process-Credential", "")
        if not process_credential or not secrets.compare_digest(process_credential, supplied):
            raise HTTPException(status_code=403, detail="servicehub_process_credential_forbidden")

    @app.get(f"{_PROXY_PREFIX}/v1/health", tags=["system"])
    async def _servicehub_health(request: Request) -> JSONResponse:
        body: dict[str, object] = {
            "service": service_name,
            "status": "ok",
            "pid": os.getpid(),
            "instance_id": instance_id,
        }
        sanitize_mgr = getattr(request.app.state, "sanitize_mgr", None)
        reason = sanitize_mgr.restart_reason if sanitize_mgr is not None else None
        if reason is None:
            return JSONResponse(body)
        return JSONResponse({**body, "status": "error", "reason": reason}, status_code=503)

    @app.get(
        f"{_PROXY_PREFIX}/v1/models/status",
        response_model=PrivacyModelsStatusResponse,
        tags=["system"],
    )
    async def _privacy_models_status(
        request: Request, response: Response
    ) -> PrivacyModelsStatusResponse:
        _require_process_credential(request)
        response.headers["Cache-Control"] = "no-store"
        sanitize_mgr = request.app.state.sanitize_mgr
        models = sanitize_mgr.models.snapshot()
        if not sanitize_mgr.sanitize_enabled:
            models_state = "disabled"
            models_error = "Privacy model preparation is disabled by configuration."
        elif unsupported_model_paths(sanitize_mgr.config, sanitize_mgr.models):
            models_state = "unsupported"
            models_error = "Configured privacy model paths are not supported by verified model delivery."
        else:
            models_state = models["state"]
            models_error = models["error"]
        models_present = await run_in_threadpool(existing_models_present, sanitize_mgr)
        return PrivacyModelsStatusResponse(
            models_state=models_state,
            models_done_bytes=models["done_bytes"],
            models_total_bytes=models["total_bytes"],
            models_error=models_error,
            models_present=models_present,
        )

    @app.post(f"{_PROXY_PREFIX}/v1/models/prepare", tags=["system"])
    async def _prepare_privacy_models(request: Request) -> JSONResponse:
        _require_process_credential(request)
        state = await run_in_threadpool(prepare_models, request.app.state.sanitize_mgr)
        return JSONResponse({"state": state}, headers={"Cache-Control": "no-store"})

    @app.get(f"{_PROXY_PREFIX}/v1/internal/data-plane-key", tags=["system"])
    async def _get_data_plane_key(request: Request) -> JSONResponse:
        client_host = request.client.host if request.client is not None else ""
        try:
            is_loopback = ipaddress.ip_address(client_host).is_loopback
        except ValueError:
            is_loopback = client_host == "testclient"
        supplied = request.headers.get("X-SuperClaw-Process-Credential", "")
        if (
            not is_loopback
            or not process_credential
            or not secrets.compare_digest(process_credential, supplied)
        ):
            raise HTTPException(status_code=403, detail="data_plane_key_forbidden")
        if not data_plane_key:
            raise HTTPException(status_code=503, detail="data_plane_key_unavailable")
        return JSONResponse(
            {"api_key": data_plane_key}, headers={"Cache-Control": "no-store"}
        )

    @app.post(f"{_PROXY_PREFIX}/v1/shutdown", tags=["system"])
    async def _servicehub_shutdown(request: Request) -> dict[str, str]:
        supplied = request.headers.get("X-SuperClaw-Process-Credential", "")
        if not process_credential or not secrets.compare_digest(process_credential, supplied):
            raise HTTPException(status_code=403, detail="shutdown_forbidden")
        server = getattr(request.app.state, "server", None)
        if server is not None:
            server.should_exit = True
        return {"state": "stopping"}


def main() -> int:
    args = _parse_args()
    _setup_security_logging()

    service_name = os.environ.get("SERVICEHUB_SERVICE_NAME") or _DEV_SERVICE_NAME
    release = resolve_app_version(package_version=__version__)
    install_crash_hooks(service=service_name, release=release)

    import uvicorn

    from protection_service.config import load_config
    from protection_service.server import create_app

    instance_id = os.environ.get("SERVICEHUB_INSTANCE_ID") or _DEV_INSTANCE_ID
    process_credential = os.environ.get("SERVICEHUB_PROCESS_CREDENTIAL", "")
    managed = os.environ.get("SERVICEHUB_MANAGED") == "1"
    data_plane_key = _resolve_data_plane_key(managed, process_credential)

    config_path = _resolve_config_path()
    config = load_config(config_path if config_path.is_file() else None)
    app = create_app(config, data_plane_key)
    # Routes that change global state (e.g. /v1/text/custom-level) check it besides the data-plane key.
    app.state.process_credential = process_credential
    _register_servicehub_routes(
        app,
        service_name=service_name,
        instance_id=instance_id,
        process_credential=process_credential,
        data_plane_key=data_plane_key,
    )
    os.environ.pop("SERVICEHUB_PROCESS_CREDENTIAL", None)
    os.environ.pop("SERVICEHUB_MANAGED", None)

    uv_config = uvicorn.Config(
        app,
        host=args.host,
        port=args.port,
        log_level="info",
        log_config=None,
        access_log=False,
    )
    server = uvicorn.Server(uv_config)
    app.state.server = server
    server.run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
