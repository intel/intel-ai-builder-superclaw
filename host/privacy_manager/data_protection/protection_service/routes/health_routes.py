"""Health endpoint registration."""

from __future__ import annotations

from fastapi import FastAPI

from protection_service import __version__ as service_version
from protection_service.app_state import ProtectionAppState
from protection_service.schemas import HealthResponse


def register_health_routes(app: FastAPI, state: ProtectionAppState) -> None:
    """Register the ``/health`` endpoint.

    Args:
        app: FastAPI application instance.
        state: App-scoped state containing config and sanitizer.
    """
    config = state.config
    sanitize_mgr = state.sanitize_mgr

    @app.get("/health", response_model=HealthResponse, tags=["system"])
    async def health() -> HealthResponse:
        """Return service readiness and sanitizer health.

        Returns:
            HealthResponse: Current health and readiness status.
        """
        models = sanitize_mgr.models.snapshot()
        return HealthResponse(
            status="ok",
            version=service_version,
            auth_enabled=state.auth_enabled,
            redact_ready=True,
            sanitize_ready=sanitize_mgr.ready,
            sanitize_degraded_reason=sanitize_mgr.degraded_reason,
            sanitize_warming_up=sanitize_mgr.warming_up,
            sanitize_dormant=sanitize_mgr.dormant,
            ner_backend=sanitize_mgr.ner_backend_label(),
            models_state=models["state"],
            models_done_bytes=models["done_bytes"],
            models_total_bytes=models["total_bytes"],
            models_error=models["error"],
        )
