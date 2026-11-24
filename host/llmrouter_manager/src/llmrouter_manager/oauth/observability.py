"""Langfuse trace/generation wiring for the OAuth (Copilot / Codex) dispatch
chokepoint.

``cloud/dispatch.py`` (the api_key cloud path) already opens a Langfuse trace
+ generation via ``build_trace_and_generation`` before every upstream call and
closes it via ``finalize_generation_and_trace`` after. The OAuth provider
modules never did -- this module is the shared "before the call" half of that
same wiring so both OAuth providers (``providers/openai.py``,
``providers/github_copilot.py``) call it identically instead of each
duplicating the setup. The "after the call" half is
``finalize_generation_and_trace`` / ``lf_generation.end(...)``, called
directly by each provider at its existing success/error points.
"""

from __future__ import annotations

from typing import Any

from ..langfuse_observability.client import build_trace_and_generation


def start_oauth_trace(
    *,
    provider: str,
    model_id: str,
    body: dict[str, Any],
    upstream_kwargs: dict[str, Any],
    req_stream: bool,
    session_id: str | None,
    trace_id: str | None,
    langfuse_trace_id: str | None,
    langfuse_session_id: str | None,
    hdr_phase: str | None,
    call_kind: str | None,
) -> tuple[Any, Any, str]:
    """Open the Langfuse trace + generation for one OAuth dispatch call.

    ``kind="cloud"`` matches the api_key cloud path's tagging -- OAuth is just
    another cloud auth mode, not a distinct dispatch kind. ``langfuse_trace_id``
    falls back to the event-ledger ``trace_id`` when the caller has no
    OpenCode message id to group multiple calls by (see
    ``build_trace_and_generation``'s docstring for the grouping rules).
    """
    return build_trace_and_generation(
        messages=body.get("messages"),
        hdr_phase=hdr_phase,
        call_kind=call_kind,
        trace_id=langfuse_trace_id or trace_id,
        session_id=session_id,
        langfuse_session_id=langfuse_session_id,
        kind="cloud",
        req_stream=req_stream,
        provider=provider,
        model_id=model_id,
        tools_present="tools" in body,
        upstream_payload=upstream_kwargs,
    )
