"""Resolve the Privacy data-plane credential injected into the sandbox roles."""

from __future__ import annotations

import os


_SERVICEHUB_MANAGED_KEY_ENV = "SERVICEHUB_MANAGED_PRIVACY_API_KEY"
_STANDALONE_KEY_ENV = "DATA_PROTECTION_API_KEY"


def resolve_privacy_api_key(*, managed: bool) -> str:
    """Return the mode-appropriate data-plane key or fail closed."""
    env_name = _SERVICEHUB_MANAGED_KEY_ENV if managed else _STANDALONE_KEY_ENV
    key = (os.environ.get(env_name) or "").strip()
    if not key:
        raise RuntimeError(
            f"Privacy data-plane credential is unavailable: {env_name} is required"
        )
    return key
