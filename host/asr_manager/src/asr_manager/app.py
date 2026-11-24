"""FastAPI app assembly for asr_manager.

- No App bearer middleware. ServiceHub terminates App auth at the proxy, then
  attaches the process credential ``ManagementAuthMiddleware`` requires on every
  route except ``GET /health`` and ``GET /version``.
- ``service_name`` / ``instance_id`` are stashed on ``app.state`` so
  ``GET /speech-to-text/v1/health`` (sub-service contract §5) can echo them.
- Routes: meta (health/status/version/shutdown) + asr (download/status, download,
  prepare, transcribe), all under ``/speech-to-text/v1``.

The two exception handlers below are not boilerplate -- they exist because
ServiceHub's proxy DISCARDS any error body that is not
``{"error": {"code": str, "message": str}}`` and substitutes ``upstream_error``.
Without them, FastAPI's default 422 and any unhandled exception would both reach
the UI as an unactionable generic failure. See ``api/errors.py``.
"""

from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

# Starlette's HTTPException, NOT fastapi's. Starlette's router raises the base class
# for 404/405, and handler lookup walks ``type(exc).__mro__`` -- a handler keyed on
# fastapi's subclass is never reached by it, so every unknown URL would come back as
# the default ``{"detail": "Not Found"}`` and be flattened to ``upstream_error``.
# Registering the base class covers fastapi's subclass too, since that one's MRO
# does include it. (Caught by tests/test_error_envelope.py; the first version of
# this module keyed on the fastapi class and silently did nothing.)
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import __version__
from .api.asr import asr_router
from .api.errors import error_body, error_response
from .api.meta import meta_router
from .api.refine import refine_router
from .auth import ManagementAuthMiddleware
from .config import RuntimeConfig


def build_app(cfg: RuntimeConfig) -> FastAPI:
    app = FastAPI(
        title="SuperClaw ASR Manager",
        version=__version__,
        docs_url="/speech-to-text/docs",
        redoc_url=None,
        openapi_url="/speech-to-text/openapi.json",
    )

    # ServiceHub-injected identity -- echoed by /speech-to-text/v1/health per
    # sub-service contract §5. On app.state so handlers never re-read env.
    app.state.service_name = cfg.service_name
    app.state.instance_id = cfg.instance_id
    app.state.process_credential = cfg.process_credential
    app.add_middleware(ManagementAuthMiddleware, process_credential=cfg.process_credential)

    @app.exception_handler(RequestValidationError)
    async def _on_validation_error(
        request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        """Re-envelope FastAPI's 422.

        ``/transcribe`` parses its own body precisely so it can emit specific codes,
        so this fires only for what reaches FastAPI's validation first (undecodable
        JSON, a bad query/path type). FastAPI would answer
        ``{"detail": [...]}``, which the proxy replaces with ``upstream_error`` --
        the reason is destroyed on the way to the UI. Returning 400 rather than 422
        keeps the contract's status set closed (400/403/413/500/503).
        """
        detail = exc.errors()
        first = detail[0] if detail else {}
        location = ".".join(str(p) for p in first.get("loc", ()) if p != "body")
        message = first.get("msg", "invalid request")
        return error_response(
            400,
            "invalid_request",
            f"{location}: {message}" if location else str(message),
        )

    @app.exception_handler(StarletteHTTPException)
    async def _on_http_exception(
        request: Request, exc: StarletteHTTPException
    ) -> JSONResponse:
        """Normalize any HTTPException (ours or Starlette's 404/405) into the
        envelope. A raw ``detail`` string would be flattened to ``upstream_error``,
        so even a wrong URL should come back as a legible ``not_found``."""
        if isinstance(exc.detail, dict) and "error" in exc.detail:
            return JSONResponse(
                exc.detail, status_code=exc.status_code, headers=exc.headers
            )
        code = {404: "not_found", 405: "method_not_allowed"}.get(
            exc.status_code, "invalid_request" if exc.status_code < 500 else "internal_error"
        )
        return JSONResponse(
            error_body(code, str(exc.detail)),
            status_code=exc.status_code,
            headers=exc.headers,
        )

    app.include_router(meta_router)
    app.include_router(asr_router)
    app.include_router(refine_router)

    return app
