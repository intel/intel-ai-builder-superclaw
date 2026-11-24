"""App-scoped state container passed to route registration functions."""

from __future__ import annotations

from dataclasses import dataclass, field
from protection_service.auth import AuthDependency

from protection_service.config import AppConfig
from protection_service.pii_registry_store import PiiRegistryStore
from protection_service.redacts_store import RedactsStore
from protection_service.sanitize_state import SanitizeManager


@dataclass
class ProtectionAppState:
    """Holds all app-scoped resources shared across route handlers.

    Attributes:
        config: Runtime configuration for auth, redaction, and sanitizer behavior.
        redacts_store: Registry file store with TTL-based sweeper.
        sanitize_mgr: Text sanitizer state and NER model provider.
        pii_registry_store: SQLite-backed PII session/operation metadata store.
        auth_dep: FastAPI auth dependency callable returned by ``make_auth_dependency``.
        llm_client: initialized LLM client for the protect/LLM-pipeline endpoints.
    """

    config: AppConfig
    redacts_store: RedactsStore
    sanitize_mgr: SanitizeManager
    pii_registry_store: PiiRegistryStore
    auth_dep: AuthDependency
    auth_enabled: bool
    llm_client: object | None = field(default=None)
