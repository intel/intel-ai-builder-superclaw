"""
FastAPI app factory for the ``privacy_manager`` data-protection service.

* ``constants``          — module-level constants and defaults
* ``request_limits``     — request body-size limits
* ``app_state``          — ``ProtectionAppState`` dataclass
* ``io/``                — path mapping, upload storage, validation, registry, and session utilities
* ``redaction/``         — column detection, tabular/document/file redaction workers, and restore handlers
* ``routes/``            — FastAPI route registration per endpoint group

Endpoint groups exposed:
* ``/v1/file/*``            — detect and mask PII in tabular and document files
* ``/v1/text/*``            — redact free-form text and manage sanitizer config
* ``/v1/restore``           — reverse placeholders from file or text redaction
* ``/v1/session/*``         — session-scoped query rewrite and response restore
* ``/v1/file/protect``      — mode-aware file pipeline (fetches settings from llmrouter)
* ``/v1/file/llm-pipeline`` — direct legacy LLM pipeline path
"""

from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from file_protection.documents import assert_xml_parsers_hardened

from protection_service import __version__ as service_version
from protection_service.app_state import ProtectionAppState
from protection_service.auth import make_auth_dependency
from protection_service.config import AppConfig
from protection_service.constants import FRAMING_SLACK_BYTES, MIN_BODY_CAP_BYTES
from protection_service.pii_registry_store import PiiRegistryStore
from protection_service.request_limits import BodySizeLimitMiddleware
from protection_service.redacts_store import RedactsStore
from protection_service.sanitize_state import SanitizeManager
from common.errors import ServiceError

from protection_service.routes import protect_routes
from protection_service.routes.file_routes import register_file_routes
from protection_service.routes.health_routes import register_health_routes
from protection_service.routes.protect_routes import register_protect_routes
from protection_service.routes.restore_routes import register_restore_routes
from protection_service.routes.review_routes import register_review_routes
from protection_service.routes.session_routes import register_session_routes
from protection_service.routes.text_routes import register_text_routes
from protection_service.routes.local_read_routes import register_local_read_routes


logger = logging.getLogger(__name__)
PROTECTION_MODE_POLL_SECONDS = 5.0


async def _warm_when_protection_is_enabled(sanitize_mgr: SanitizeManager) -> None:
    """Poll the existing LRM mode read until protection needs the sanitizer."""
    while sanitize_mgr.dormant:
        mode, _ = await protect_routes.fetch_file_protection_settings()
        if mode != "none":
            logger.info(
                "Data-protection mode is %s; starting sanitizer warm-up",
                mode,
            )
            sanitize_mgr.start_initialize()
            return
        await asyncio.sleep(PROTECTION_MODE_POLL_SECONDS)


def create_app(config: AppConfig, data_plane_key: str | None = None) -> FastAPI:
    """Create the data-protection FastAPI app.

    Initialises shared resources, attaches middleware and exception handlers,
    then delegates all route registration to dedicated route modules.

    Args:
        config: Runtime configuration for auth, redaction, sanitizer,
            and retention behavior.

    Returns:
        FastAPI: Configured app with middleware, exception handlers, and routes.
    """
    redacts_store = RedactsStore(
        redacts_dir=config.redact.redacts_dir,
        max_ttl_seconds=config.redact.max_ttl_seconds,
    )
    sanitize_mgr = SanitizeManager(config.sanitize)
    pii_registry_store = PiiRegistryStore(
        config.redact.redacts_dir.parent / "pii_session_registry.db",
        ttl_seconds=config.redact.max_ttl_seconds,
    )
    auth_dep = make_auth_dependency(config, data_plane_key)
    watch_protection_mode = os.environ.get("SERVICEHUB_MANAGED") == "1"
    state = ProtectionAppState(
        config=config,
        redacts_store=redacts_store,
        sanitize_mgr=sanitize_mgr,
        pii_registry_store=pii_registry_store,
        auth_dep=auth_dep,
        auth_enabled=bool(data_plane_key or config.auth.token),
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        """Initialize and close app-scoped protection resources.

        Args:
            app: FastAPI application instance.

        Yields:
            None: Control while the app is running.
        """
        # Verify XML parsers still reject entity expansion before accepting uploads.
        assert_xml_parsers_hardened()
        # The sanitizer stays dormant here: the first request that needs it
        # (or a file preflight) starts its background warm-up.
        # One sweeper handles registry expiry, sanitizer cache expiry, and
        # PII session operation row expiry.
        redacts_store.add_sweep_hook(sanitize_mgr.sweep_caches)
        redacts_store.add_sweep_hook(pii_registry_store.sweep_expired)
        redacts_store.sweep_once()  # startup sweep (reaps redact files + cache)
        sweeper = asyncio.create_task(redacts_store.sweeper_loop(interval_seconds=60))
        mode_watcher = (
            asyncio.create_task(_warm_when_protection_is_enabled(sanitize_mgr))
            if watch_protection_mode
            else None
        )
        try:
            yield
        finally:
            tasks = [t for t in (mode_watcher, sweeper) if t is not None]
            for task in tasks:
                task.cancel()
            # return_exceptions: a failed watcher must not skip the cleanup below
            await asyncio.gather(*tasks, return_exceptions=True)
            # Flush sanitizer cache writes before shutdown
            sanitize_mgr.close()
            pii_registry_store.close()

    app = FastAPI(
        title="protection-service",
        version=service_version,
        lifespan=lifespan,
    )
    app.state.sanitize_mgr = sanitize_mgr

    # Enforce body size before Pydantic or multipart parsing can buffer input.
    body_cap = max(
        config.redact.max_source_bytes + FRAMING_SLACK_BYTES,
        MIN_BODY_CAP_BYTES,
    )
    app.add_middleware(BodySizeLimitMiddleware, max_bytes=body_cap)

    # ServiceError already carries the shared error envelope.
    @app.exception_handler(ServiceError)
    async def _service_error_handler(_req: Request, exc: ServiceError) -> JSONResponse:
        """Convert ServiceError into the shared JSON error envelope.

        Args:
            _req: Incoming request, unused.
            exc: Service-level exception.

        Returns:
            JSONResponse: Error response with the service error envelope.
        """
        return JSONResponse(status_code=exc.status_code, content={"detail": exc.to_detail()})

    # Normalize all HTTPException responses to ``detail.error/message``.
    @app.exception_handler(HTTPException)
    async def _http_exception_handler(_req: Request, exc: HTTPException) -> JSONResponse:
        """Normalize HTTPException into the shared JSON error envelope.

        Args:
            _req: Incoming request, unused.
            exc: FastAPI HTTP exception.

        Returns:
            JSONResponse: Normalized error response.
        """
        detail = exc.detail
        if isinstance(detail, dict) and "error" in detail and "message" in detail:
            body = detail
        else:
            body = {
                "error": "http_error",
                "message": str(detail) if detail else exc.__class__.__name__,
            }
        return JSONResponse(
            status_code=exc.status_code,
            content={"detail": body},
            headers=exc.headers,
        )

    register_health_routes(app, state)
    register_file_routes(app, state)
    register_text_routes(app, state)
    register_restore_routes(app, state)
    register_session_routes(app, state)
    register_protect_routes(app, state)
    register_review_routes(app, state)
    register_local_read_routes(app, state)

    return app
