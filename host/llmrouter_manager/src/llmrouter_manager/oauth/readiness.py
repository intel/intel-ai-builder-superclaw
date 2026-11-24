"""Provider-dispatched OAuth readiness for the cloud test / health surfaces.

``openai`` (PKCE) proves readiness by refreshing its access token; Copilot
(device grant) has no refresh token and instead projects its access-token and
derives the short-lived Copilot key off the event loop. Both raise the same
``SessionNotFound`` / ``RefreshRequired`` / ``RefreshTransient`` taxonomy so
callers handle them uniformly.
"""

from __future__ import annotations


async def ensure_ready(provider_id: str) -> None:
    if provider_id == "github_copilot":
        from .providers import github_copilot

        await github_copilot.ensure_ready(provider_id)
        return
    from . import refresh

    await refresh.ensure_fresh_token(provider_id)
