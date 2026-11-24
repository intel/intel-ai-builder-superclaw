"""Telemetry control-plane namespace for llmrouter_manager."""

from __future__ import annotations

import os
from contextvars import ContextVar


def is_debug_observability_enabled() -> bool:
    """Return whether LRM debug observability is enabled for this process."""
    return (os.environ.get("SUPERCLAW_DEBUG_OBSERVABILITY") or "").strip() == "1"


_withhold_payloads: ContextVar[bool] = ContextVar(
    "observability_withhold_payloads", default=False
)
"""Whether this request's CONTENT may be exported to the observability backend.

Set only for a request that asked for an on-device guarantee; see
:func:`withhold_observability_payloads_for_this_request`.
"""


def withhold_observability_payloads_for_this_request() -> None:
    """Keep this request's content out of the observability export.

    WHAT THIS CLOSES. Debug observability exports FOUR transcript-derived
    values per call -- the trace name, the trace input, the generation input
    (``langfuse_observability/client.py``'s ``build_trace_and_generation``) and
    the completion (``finalize_generation_and_trace``) -- and the local/edge
    dispatcher calls it with the real body
    (``routing/proxy.py``: ``build_trace_and_generation(messages=messages, ...,
    upstream_payload=llm_body)``). ``X-SuperClaw-Require-On-Device`` constrains
    where INFERENCE goes; it said nothing about telemetry. So with
    ``SUPERCLAW_DEBUG_OBSERVABILITY=1`` and a remote Langfuse configured, a
    dictation whose whole proposition is "nothing leaves this machine" had its
    text exported off the machine by a second path. Raised by Copilot on
    superclaw#3027, against that exact UI copy.

    NOT GATED ON THE EXPORT BEING ENABLED. The flag is set whenever the caller
    demanded on-device, whether or not observability happens to be on in this
    process, because the alternative is a guarantee that depends on an env var
    read somewhere else.

    WHY CONTENT ONLY. The trace still exists, with its model, latency, token
    counts and metadata -- those are not derived from what the user said, and
    losing them would trade a real debugging tool for nothing. What is withheld
    is exactly the payloads.

    NO RESET, for the reason :func:`model_prefix.suppress_for_this_request`
    gives: the streaming finalize runs after the handler returns, so a scoped
    block would be out of scope by the time the output is exported. Each request
    is its own task with its own context copy, so the set dies with the request.
    """
    _withhold_payloads.set(True)


def observability_payloads_withheld() -> bool:
    """Whether this request's content must stay out of the export."""
    return _withhold_payloads.get()
