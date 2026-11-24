"""FastAPI app assembly for tts_manager.

- No App bearer middleware. ServiceHub terminates App auth at the proxy, then
  attaches the process credential ``ManagementAuthMiddleware`` requires on every
  route except ``GET /health`` and ``GET /version``.
- ``service_name`` / ``instance_id`` are stashed on ``app.state`` so
  ``GET /tts-narration/v1/health`` (contract §5) can echo them.
- Routes: meta (health/version/shutdown) + tts (download-status/download/
  prepare/tts), all under ``/tts-narration/v1``.
"""

from __future__ import annotations

from fastapi import FastAPI

from . import __version__
from .api.meta import meta_router
from .api.tts import tts_router
from .auth import ManagementAuthMiddleware
from .config import RuntimeConfig


def build_app(cfg: RuntimeConfig) -> FastAPI:
    app = FastAPI(
        title="SuperClaw TTS Manager",
        version=__version__,
        docs_url="/tts-narration/docs",
        redoc_url=None,
        openapi_url="/tts-narration/openapi.json",
    )

    # ServiceHub-injected identity — echoed by /tts-narration/v1/health per
    # contract §5. Stored on app.state so handlers read them without re-parsing env.
    app.state.service_name = cfg.service_name
    app.state.instance_id = cfg.instance_id
    app.state.process_credential = cfg.process_credential
    app.add_middleware(ManagementAuthMiddleware, process_credential=cfg.process_credential)

    app.include_router(meta_router)
    app.include_router(tts_router)

    return app
