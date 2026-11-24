"""``POST /v1/chat/completions/pinned`` -- a completion against a NAMED provider.

WHY A SECOND COMPLETION ROUTE EXISTS. ``/v1/chat/completions`` is the agent data
plane and deliberately hides the upstream: it takes one of three aliases
(``auto`` / ``local-model`` / ``cloud-model``), resolves it against the user's
committed selections, and rebuilds the LiteLLM kwargs from a short allow-list so
no unknown body member reaches a provider. Those are the right properties for
the agent, and they make it unusable for a caller that must name its own
provider, model and endpoint-routing preference -- such a request either fails
the alias check or has its extra members silently dropped.

That caller is dictation clean-up (``asr_manager``'s ``refine`` client): one
short, non-interactive, latency-measured transformation whose model is a product
decision, not a user preference. Rather than widen the alias route -- which would
make "which model answers an agent turn" caller-controllable, the exact property
the alias indirection buys -- this route is the narrow, explicit alternative.

WHO MAY CALL IT. The host-only data-plane credential, never the shared one --
``routing/api.py`` mounts this on a router gated by
``require_host_inference_key``. The shared inference key is handed to the
sandbox container so agent code can run its own turns, and on that key this
route would let agent-authored code name any connected provider and model and
file the spend under any ``usage_alias``, including dictation clean-up's own
``dictation-refine``. The alias route has no such exposure: it resolves
``auto`` / ``local-model`` / ``cloud-model`` against the user's committed
selections, so its caller cannot choose a model.

That is the one thing the paragraph below originally missed, and it mattered
because the rationale here *names* the property being protected -- "which model
answers an agent turn must not be caller-controllable" -- and then this route
was reachable by the one caller the property exists to constrain. Raised in
review on superclaw#3027; see ``common/inference_key.py`` for the key pair.

WHAT IT STILL DOES NOT DO. The credential never leaves the service: the caller
names a *catalog provider id* and LRM resolves the stored key for it. So a
pinned request can only ever spend a credential the user already connected, to a
provider the product ships support for. Everything after validation is the
ordinary cloud dispatch path, which is why this module is small: error mapping,
the mandatory-reasoning retry, streaming and usage accounting are all
``cloud/dispatch.py``'s, unchanged.

WHY ITS OWN MODULE. ``routing/proxy.py`` is at the edge of
``scripts/ci/file_size_ratchet.mjs``'s 2000-line limit; a file that is already
near the cap must not be the default home for new handlers. Nothing here needs
proxy's internals beyond the ``LLMConfig`` dataclass, which is imported.
"""

from __future__ import annotations

import time
from typing import Any

from fastapi import Request
from fastapi.responses import JSONResponse

from ..cloud.catalog import get_provider_base_url, is_catalog_provider
from ..cloud.dispatch import _call_via_litellm
from ..cloud.registry import PROVIDER_ID_PATTERN, get as get_provider_record
from ..common.errors import error_response
from ..common.model_prefix import suppress_for_this_request
from .proxy import LLMConfig


def _invalid(code: str, message: str) -> JSONResponse:
    """A 400 with its own machine code.

    Every shape failure below gets a distinct code rather than one shared
    ``invalid_request``: the caller maps "you sent the wrong thing" (a bug in
    the caller, not actionable by the user) and "nothing is configured to serve
    this" (424, the user can connect a key) to completely different UI, and a
    single code would make the two indistinguishable in a log.

    400 and not the control plane's 422: this is the ``/v1`` data plane, which
    words body-shape failures as 400 (``proxy.py``'s ``invalid_model`` /
    ``invalid_body``), and a caller should not have to learn two conventions for
    the same namespace.
    """
    return error_response(code, message, status_code=400)


async def pinned_chat_completions(request: Request) -> Any:
    """Dispatch one completion to an explicitly named catalog provider + model.

    Returns dispatch's own result: the upstream JSON dict for a non-streaming
    call, a ``StreamingResponse`` when the body asked to stream, or dispatch's
    error envelope when the upstream failed.
    """
    try:
        body: Any = await request.json()
    except ValueError as exc:
        # ValueError and not a bare except: ``request.json()`` raises
        # json.JSONDecodeError (a ValueError subclass) on a malformed body, and
        # a client disconnect must stay an error, not become a 400.
        return error_response(
            "invalid_json",
            "request body is not valid JSON",
            status_code=400,
            details={"detail": str(exc)[:200]},
        )
    if not isinstance(body, dict):
        return _invalid("invalid_body", "request body must be a JSON object")

    provider = body.get("provider")
    if not isinstance(provider, str) or not PROVIDER_ID_PATTERN.match(provider):
        # Checked before any lookup because the provider id becomes a filename
        # in the credential store; ``registry.get`` would raise ValueError (a
        # 500) rather than answer, and a path-traversal attempt deserves a
        # crisp 400.
        return _invalid(
            "invalid_provider_id",
            f"provider {provider!r} is not a valid provider id",
        )
    if not is_catalog_provider(provider):
        # Pattern-valid but unknown: there is no base url and no LiteLLM adapter
        # name for it, so there is nothing to dispatch to.
        return _invalid(
            "unsupported_provider", f"provider {provider!r} is not supported"
        )

    model = body.get("model")
    if not isinstance(model, str) or not model:
        # An empty model id would build the LiteLLM target "<provider>/" and
        # fail upstream as a 502, hiding a caller bug behind an outage.
        return _invalid("invalid_model", "model must be a non-empty string")

    messages = body.get("messages")
    if not isinstance(messages, list) or not messages:
        # Rejected here rather than upstream for the same reason: dispatch
        # defaults a missing ``messages`` to ``[]`` and the provider's own 400
        # would come back as this service's 502.
        return _invalid("invalid_messages", "messages must be a non-empty list")

    provider_routing = body.get("provider_routing")
    if provider_routing is not None and not isinstance(provider_routing, dict):
        # Absent is legal and means "upstream chooses" -- only a present-but-
        # wrong-shape block is an error. See ``_build_litellm_kwargs`` for why
        # an empty routing object is not the same as no routing object.
        return _invalid(
            "invalid_provider_routing", "provider_routing must be a JSON object"
        )

    record = get_provider_record(provider)
    api_key = str(record.get("api_key", "")).strip() if isinstance(record, dict) else ""
    if not api_key:
        # Same status and code as the alias route's "no backend for this slot":
        # a config error, not a transient fault, so retrying can never help.
        # 424 is also the one status the dictation caller turns into a
        # user-actionable message, so it must not be collapsed into the 400s
        # above -- a blank stored key counts as unconfigured for exactly that
        # reason (dispatching it yields a 401 that reads as an outage).
        return error_response(
            "no_provider_available",
            f"provider {provider!r} is not configured",
            status_code=424,
            details={
                "provider": provider,
                "hint": (
                    "Connect the provider via PUT "
                    "/llm-router/v1/cloud/providers/{id}."
                ),
            },
        )

    usage_alias = body.get("usage_alias")

    cfg = LLMConfig(
        name="pinned",
        provider=provider,
        model_id=model,
        base_url=get_provider_base_url(provider) or "",
        api_key=api_key,
        # max_tokens is only the fallback for a body that omits it; a pinned
        # caller sizes its own budget. Left at the dataclass default rather than
        # read from the user's cloud-model record, which describes the agent's
        # model and has nothing to say about this request.
    )

    # No `[model-id] ` label on this route's completions: a pinned caller is
    # by definition not the chat UI, so nothing downstream strips it off again
    # and it would be inserted as if the user had dictated it.
    #
    # Set rather than scoped: `_call_via_litellm` returns a lazy
    # `StreamingResponse` when the caller asked to stream, and its generator
    # calls `format_model_prefix` after this function has returned -- so a
    # `with` block here reset the suppression before it was ever read, and a
    # streaming pinned completion got the label anyway. See
    # `suppress_for_this_request`.
    suppress_for_this_request()
    return await _call_via_litellm(
        cfg,
        body,
        # Honoured rather than forced to False: a caller that asked to stream
        # and got a single JSON object back would mis-parse it. Dictation does
        # not stream, so in practice this is always the non-streaming path.
        req_stream=bool(body.get("stream")),
        telemetry_runtime=getattr(request.app.state, "telemetry_runtime", None),
        request_started_at=time.monotonic(),
        # Lands in the usage ledger's free-text ``alias`` column so this
        # caller's spend is separable from agent spend. It cannot ride on
        # ``source``, which ``common/usage_store.py`` CHECK-constrains to
        # cloud|local|edge -- a pinned call IS a cloud call.
        alias=usage_alias if isinstance(usage_alias, str) and usage_alias else None,
    )
