"""Resolve the LRM credential the native backend hands to its Runtime."""

from __future__ import annotations

import os
from urllib.parse import urlparse

from .store import Store


LRM_PORT = 18321
_SERVICEHUB_MANAGED_KEY_ENV = "SERVICEHUB_MANAGED_LRM_API_KEY"
_MANAGED_HOSTS = frozenset({"127.0.0.1", "localhost"})


def _is_managed_base_url(base_url: str) -> bool:
    parsed = urlparse(base_url)
    try:
        port = parsed.port
    except ValueError:
        return False
    return (
        parsed.scheme.lower() == "http"
        and (parsed.hostname or "").lower() in _MANAGED_HOSTS
        and port == LRM_PORT
        and parsed.path.rstrip("/") in ("", "/v1")
        and not parsed.params
        and not parsed.query
        and not parsed.fragment
    )


def resolve_lrm_api_key(store: Store) -> str:
    """Select the key paired with the configured LRM endpoint."""
    base_url_override = os.environ.get("LRM_API_BASE_URL")
    managed_key = os.environ.get(_SERVICEHUB_MANAGED_KEY_ENV)
    if managed_key and (
        not base_url_override or _is_managed_base_url(base_url_override)
    ):
        key = managed_key
    else:
        process_key = os.environ.get("LRM_API_KEY")
        stored_key = store.get_config("LRM_API_KEY")
        key = process_key or (str(stored_key) if stored_key else "unused")

    local_lrm = not base_url_override or _is_managed_base_url(base_url_override)
    if local_lrm and key == "unused":
        raise RuntimeError(
            "LRM inference credential is unavailable; start SandboxManager "
            "through ServiceHub or set LRM_API_KEY"
        )
    return key
