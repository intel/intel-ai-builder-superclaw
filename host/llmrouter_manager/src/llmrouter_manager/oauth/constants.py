"""OpenAI (ChatGPT / Codex subscription) OAuth PKCE constants.

Scope: ``openai`` only. The ``client_id`` is the public Codex CLI identifier —
the only ``originator`` OpenAI's Hydra whitelists for this app (other values get
``authorize_hydra_invalid_request`` at /authorize).

This module carries ONLY the PKCE login/refresh flow config. The Codex Responses
API wire details (endpoint, beta headers, instructions, Chat<->Responses
translation) are LiteLLM's ``chatgpt/`` provider's job — not ours.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Literal


OAUTH_PROVIDER_IDS: tuple[str, ...] = ("openai", "github_copilot")
"""Providers this subsystem supports."""


@dataclass(frozen=True)
class ProviderOAuthConfig:
    """Static OAuth config for one provider. Immutable, module-level.

    ``flow_kind`` selects the login mechanism:

    - ``"pkce"`` — authorization-code + browser redirect + localhost callback
      (``authorize_url`` / ``callback_path`` / ``callback_port_range`` /
      ``exchange_content_type`` apply). SuperClaw owns the ``refresh_token`` grant.
    - ``"device"`` — RFC 8628 device-authorization grant: no redirect, no PKCE,
      no callback server. ``device_code_url`` + ``token_url`` (poll) apply. The
      GitHub access token is long-lived (no ``refresh_token`` rotation), so the
      PKCE-only fields are unused/empty for device providers.
    """

    provider_id: Literal["openai", "github_copilot"]
    client_id: str
    authorize_url: str
    token_url: str
    scopes: str
    callback_path: str
    exchange_content_type: Literal["form", "json"]
    refresh_content_type: Literal["form", "json"]
    flow_kind: Literal["pkce", "device"] = "pkce"
    # Device-flow (RFC 8628) only: the device_authorization endpoint.
    device_code_url: str = ""
    # Extra query params on the authorize URL beyond the PKCE standard set.
    extra_authorize_params: dict[str, str] = field(default_factory=dict)
    # OpenAI's app registration hard-codes http://localhost:1455/auth/callback,
    # so the callback port is fixed. If 1455 is busy the user must free it.
    callback_port_range: range = range(1455, 1456)


OPENAI = ProviderOAuthConfig(
    provider_id="openai",
    client_id="app_EMoamEEZ73f0CkXaXp7hrann",
    authorize_url="https://auth.openai.com/oauth/authorize",
    token_url="https://auth.openai.com/oauth/token",
    scopes="openid profile email offline_access",
    callback_path="/auth/callback",
    exchange_content_type="form",
    refresh_content_type="json",
    extra_authorize_params={
        "id_token_add_organizations": "true",
        "codex_cli_simplified_flow": "true",
        "originator": "codex_cli_rs",
    },
    callback_port_range=range(1455, 1456),
)


GITHUB_COPILOT = ProviderOAuthConfig(
    provider_id="github_copilot",
    # Overridable via GITHUB_COPILOT_CLIENT_ID (matches LiteLLM's own env knob)
    # so deployments can swap the OAuth app without a code change.
    client_id=os.getenv("GITHUB_COPILOT_CLIENT_ID", "Iv1.b507a08c87ecfe98"),
    authorize_url="",
    token_url="https://github.com/login/oauth/access_token",
    scopes="read:user",
    callback_path="",
    exchange_content_type="form",
    refresh_content_type="form",
    flow_kind="device",
    device_code_url="https://github.com/login/device/code",
)


def get_provider(provider_id: str) -> ProviderOAuthConfig:
    """Return the static config for ``provider_id`` or raise ``KeyError``."""
    if provider_id == "openai":
        return OPENAI
    if provider_id == "github_copilot":
        return GITHUB_COPILOT
    raise KeyError(f"unsupported oauth provider: {provider_id!r}")


# --- Flow tunables (conservative defaults, kept in one place) ---

REFRESH_SKEW_SECONDS = 60
"""Refresh the access token when this many seconds (or fewer) remain before
``expires_at``. Matches Codex CLI's default; tight enough not to miss the window
under normal cadence, loose enough to avoid double-refreshing on bursts."""

FLOW_EXPIRY_SECONDS = 600
"""Cancel an awaiting-callback flow after this many seconds. Ten minutes covers a
browser auth incl. MFA without holding the callback port indefinitely."""

# ID-token claim namespace under which OpenAI encodes ChatGPT-specific fields
# (chatgpt_account_id, chatgpt_plan_type). Used to derive the account hint that
# LiteLLM sends as the ``ChatGPT-Account-Id`` header.
OPENAI_ID_TOKEN_AUTH_NAMESPACE = "https://api.openai.com/auth"


# Codex model-list endpoint. Authoritative per-account list (respects plan
# tier), fetched live with the OAuth access token; response is
# ``{"models": [{"slug", "visibility", ...}]}``. NOT OpenAI-compatible /v1/models.
# This is the ONLY model source — no hardcoded fallback (any static list goes
# stale immediately; e.g. the live endpoint already serves gpt-5.6-* models
# neither LiteLLM's registry nor a hardcoded list knows about).
OPENAI_CODEX_MODELS_URL = "https://chatgpt.com/backend-api/codex/models"

# GitHub Copilot device-flow poll cadence bounds. GitHub returns an ``interval``
# in the device-code response; we clamp it into this range so a hostile/absent
# value cannot busy-spin or stall the poll loop.
COPILOT_POLL_MIN_INTERVAL = 5
COPILOT_POLL_MAX_INTERVAL = 30

# Copilot OpenAI-compatible model list, fetched live with the derived Copilot
# API key. Falls back to LiteLLM's ``github_copilot_models`` registry on failure.
COPILOT_MODELS_URL = "https://api.githubcopilot.com/models"
