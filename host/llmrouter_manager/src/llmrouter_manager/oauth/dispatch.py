"""OAuth dispatch facade — routes by provider_id to the provider module.

Router-level branching (API-key vs OAuth cloud-model) happens in
``routing/proxy.py`` before we get here. Provider modules are imported LAZILY so
an import error is scoped to the dispatch call, not startup.
"""

from __future__ import annotations

from typing import Any

from fastapi.responses import JSONResponse, StreamingResponse

from .errors import OAuthProviderUnsupported


async def call(
    provider_id: str,
    model_id: str,
    body: dict[str, Any],
    *,
    alias: str | None = None,
    session_id: str | None = None,
    message_id: str | None = None,
    trace_id: str | None = None,
    langfuse_trace_id: str | None = None,
    langfuse_session_id: str | None = None,
    hdr_phase: str | None = None,
    call_kind: str | None = None,
) -> JSONResponse | StreamingResponse:
    """Dispatch a chat completion via the provider's OAuth path.

    The provider module owns the chokepoint (refresh → project auth.json →
    litellm) and returns a standard error envelope on user-facing failure.

    ``langfuse_trace_id`` / ``langfuse_session_id`` / ``hdr_phase`` /
    ``call_kind`` are the Langfuse grouping/session context computed once in
    ``routing/proxy.py`` and already forwarded to the api_key cloud path
    (``cloud/dispatch.py``); forwarded here too so OAuth calls open a Langfuse
    trace/generation the same way instead of being invisible in Langfuse.
    """
    if provider_id == "openai":
        from .providers import openai as openai_provider

        return await openai_provider.call(
            model_id,
            body,
            alias=alias,
            session_id=session_id,
            message_id=message_id,
            trace_id=trace_id,
            langfuse_trace_id=langfuse_trace_id,
            langfuse_session_id=langfuse_session_id,
            hdr_phase=hdr_phase,
            call_kind=call_kind,
        )

    if provider_id == "github_copilot":
        from .providers import github_copilot as copilot_provider

        return await copilot_provider.call(
            model_id,
            body,
            alias=alias,
            session_id=session_id,
            message_id=message_id,
            trace_id=trace_id,
            langfuse_trace_id=langfuse_trace_id,
            langfuse_session_id=langfuse_session_id,
            hdr_phase=hdr_phase,
            call_kind=call_kind,
        )

    raise OAuthProviderUnsupported(
        f"no dispatch implementation for oauth provider {provider_id!r}"
    )


async def list_models(provider_id: str) -> list[str]:
    """Subscription model ids for an OAuth provider. Empty for unknown ids.

    Fetched live (plan-tier aware) via the provider using a fresh access token.
    Readiness failures (``SessionNotFound``, ``RefreshRequired``,
    ``RefreshTransient``) propagate up so the endpoint layer can surface
    them as structured error responses instead of a silent empty list.
    """
    if provider_id == "github_copilot":
        from .providers import github_copilot as copilot_provider

        return await copilot_provider.list_models(provider_id)
    if provider_id != "openai":
        return []
    from . import refresh, state as oauth_state
    from .providers import openai as openai_provider

    access_token = await refresh.ensure_fresh_token(provider_id)
    session = oauth_state.get(provider_id) or {}
    account_hint = session.get("account_hint")
    return await openai_provider.list_models(
        access_token, str(account_hint) if account_hint else None
    )
