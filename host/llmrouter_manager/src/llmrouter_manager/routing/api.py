"""Routing subsystem: `/v1/*` data plane router wiring.

`/v1/chat/completions`, `/v1/models`, `/v1/pii/level` are wired to real
handlers in `routing/proxy.py`. Sandbox and managed host callers authenticate
with the stable LRM inference key.

Note: there is no `/llm-router/v1/routing/*` control plane. `auto` is the
only routing mode and its decision is driven per-request by the latency
router; there is no user-tunable policy state to read or write.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from ..common.errors import error_response
from ..common.model_prefix import suppress_for_this_request
from ..telemetry import withhold_observability_payloads_for_this_request
from .auth import require_host_inference_key, require_inference_key
from .pinned import pinned_chat_completions
from .proxy import (
    _KNOWN_MODEL_ALIASES,
    _resolve_alias,
    chat_completions,
    list_models,
    pii_level,
    session_locality,
)


# A SECOND ROUTER, FOR ONE ROUTE, BECAUSE IT NEEDS A STRONGER CALLER.
#
# Everything on `data_plane_router` accepts the shared inference key, which
# ServiceHub also hands to the sandbox container -- agent code needs it for its
# own turns. That is safe for those routes: the alias route resolves `auto` /
# `local-model` / `cloud-model` against the user's committed selections, so the
# caller cannot pick a model, and usage is recorded against the alias it asked
# for.
#
# `/chat/completions/pinned` is different in kind: it names its own provider,
# model and `usage_alias`. On the shared key, sandboxed code could spend the
# user's cloud credential on any connected model and file it under any label --
# including this feature's own `dictation-refine`, which would make the
# "Dictation clean-up" spend line attributable to anything in the sandbox.
#
# So it requires the host-only key, which ServiceHub withholds from the
# container. Included BEFORE `data_plane_router` in `app.py` so it wins against
# that router's `/chat/{path:path}` catchall; a separate router rather than a
# per-route dependency because a router-level dependency cannot be overridden
# per route, and stacking `require_inference_key` with a stricter check would
# accept the shared key first.
host_data_plane_router = APIRouter(
    prefix="/v1",
    tags=["data-plane"],
    dependencies=[Depends(require_host_inference_key)],
)

host_data_plane_router.add_api_route(
    # A completion against an explicitly named catalog provider + model, for
    # callers whose model is a product decision rather than a user preference
    # (see routing/pinned.py).
    "/chat/completions/pinned",
    pinned_chat_completions,
    methods=["POST"],
    name="pinned_chat_completions",
)


data_plane_router = APIRouter(
    prefix="/v1",
    tags=["data-plane"],
    dependencies=[Depends(require_inference_key)],
)

SUPPRESS_MODEL_PREFIX_HEADER = "X-SuperClaw-Suppress-Model-Prefix"
"""Opt out of the ``[model-id] `` label for one alias-route completion.

For callers that do not render the completion in the chat UI. Dictation
clean-up's ``local`` and ``agent`` modes both go through the alias route and
insert the result straight into the user's composer, where the chat UI's
``stripModelPrefix`` is not there to take the label off again -- so with
``SUPERCLAW_LRM_MODEL_PREFIX=1`` it would be typed out as dictated text.

A HEADER, AND CALLER-CONTROLLABLE ON PURPOSE. Suppressing a debug affordance
grants nothing: worst case the chat UI shows an alias where it could have shown
a concrete model, which is the default state anyway (injection is off unless
opted in). The alternative -- trimming a leading ``[...]`` downstream -- cannot
tell the label from a genuinely dictated "[note] call Ana back".
"""


REQUIRE_ON_DEVICE_HEADER = "X-SuperClaw-Require-On-Device"
"""Refuse the completion unless the resolved upstream runs on this machine.

For a caller that has promised the user their text does not leave the device.
Dictation clean-up's ``local`` mode says exactly that -- "Nothing leaves the
machine and nothing is billed" -- and it asks for the ``local-model`` alias to
get it.

That alias is NOT a guarantee of locality. ``_resolve_alias`` returns kind
``"edge"`` when the committed primary bundle has ``backend == "edge"``, and the
upstream is then a remote server read from the edge config
(``routing/primary_bundle.py``). So on an install bound to an edge bundle, a
mode whose entire proposition is on-device would ship the transcript off the
machine. Raised in review on superclaw#3027.

Enforced HERE, not in the UI: a readiness probe in the renderer cannot make
this guarantee, because the binding can change between the probe and the
request, and because a caller that forgets to probe gets no protection at all.
A refusal costs the clean-up and nothing else -- `asr_manager` falls back to the
raw transcript, which is the correct outcome for "we could not do this
privately".
"""


async def _on_device_refusal(request: Request) -> JSONResponse | None:
    """A 424 when the caller demanded on-device and ITS OWN target is remote.

    RESOLVES THE ALIAS THE REQUEST NAMES, NOT ``local-model``. The first version
    of this guard resolved ``local-model`` unconditionally and checked that
    kind, which answers the wrong question: with a local primary committed, a
    ``model: "cloud-model"`` request carrying the header passed the guard and
    went to the cloud anyway. Nothing in the product did that -- ``asr_manager``
    sends the header only in ``local`` mode, where the body is ``local-model``
    -- but a boundary guard exists precisely for the caller who gets it wrong,
    so one that validates a different target than it dispatches is worse than
    none: it reports a guarantee it never checked. Raised by Copilot on
    superclaw#3027.

    A KIND OF ``"local"`` IS NOT ENOUGH; THE RESOLUTION MUST NAME AN UPSTREAM.
    ``_resolve_alias("auto")`` with both slots configured returns
    ``("local", None, "auto_route_requires_classification")`` -- a sentinel
    meaning "ask the latency router", not a local target. Checking the kind
    alone therefore admitted ``model: "auto"`` (and a body omitting ``model``,
    which defaults to it), after which ``chat_completions`` runs the classifier
    and may pick ``cloud-model`` -- or falls back to it unconditionally when the
    router times out or raises. So the one target whose decision had not been
    made yet was the one the guard waved through. Requiring ``cfg is not None``
    makes ``auto`` unsatisfiable here, which is the correct answer: a caller
    demanding on-device must name ``local-model`` and not delegate the choice.
    Raised by Copilot on superclaw#3027.

    Reading the body here is safe: Starlette caches it on first read, so
    ``chat_completions``'s own ``await request.json()`` returns the same bytes
    rather than an exhausted stream.

    Every shape failure returns ``None`` and defers to the handler, which owns
    the vocabulary for them -- a malformed body is its 400 ``InvalidBody``, and
    an unknown alias its 400 ``invalid_model``. Answering those with a 424 here
    would tell the caller to configure an on-device model when their actual
    problem is a typo.

    WHAT THIS STILL DOES NOT CLOSE. ``chat_completions`` resolves the alias
    again further down, so a committed-binding change landing between these two
    resolutions would dispatch against a resolution this guard never saw. The
    window is one event-loop hop wide and needs a concurrent selection write to
    exploit, but it is real. Closing it means the check sharing the resolution
    dispatch uses, i.e. living inside ``chat_completions`` -- and ``proxy.py`` is
    over ``scripts/ci/file_size_ratchet.mjs``'s threshold, where the rule is that
    a file may be edited but must not come out longer. Buying those lines by
    trimming comments elsewhere in it would game a gate whose whole point is to
    force decomposition, so this is recorded rather than smuggled in: it wants
    the planned ``proxy.py`` split, not a workaround.
    """
    if request.headers.get(REQUIRE_ON_DEVICE_HEADER, "").strip() != "1":
        return None
    try:
        body: Any = await request.json()
    except ValueError:
        return None
    if not isinstance(body, dict):
        return None
    # Same default and same vocabulary as the handler, so an omitted `model`
    # gets checked as the `auto` the handler will dispatch -- not skipped.
    alias = str(body.get("model", "auto"))
    if alias not in _KNOWN_MODEL_ALIASES:
        return None

    kind, cfg, reason = _resolve_alias(
        alias, app_state=getattr(request.app, "state", None)
    )
    if kind == "local" and cfg is not None:
        return None
    # Includes the not-configured and not-yet-decided cases: "there is no
    # on-device model", "the target points somewhere remote" and "the target
    # will be chosen later" are all failures of the same promise, and the
    # caller's remedy is identical -- name a local model, or take the raw
    # transcript. `reason` is carried through only when there is no upstream,
    # which is where `'local'` on its own would read as a contradiction.
    detail = (
        f"resolves to '{kind}'"
        if cfg is not None
        else f"resolves to no on-device upstream ({reason or kind})"
    )
    return error_response(
        "on_device_required",
        f"this request requires an on-device model, and {alias!r} {detail}",
        status_code=424,
    )


async def chat_completions_entry(request: Request) -> Any:
    """``chat_completions``, plus the two per-request caller guarantees.

    Wrapped here rather than inside the handler because ``routing/proxy.py`` is
    already above ``scripts/ci/file_size_ratchet.mjs``'s threshold and cannot
    grow -- and because the label suppression has to cover the LOCAL dispatch
    branch too, which the handler reaches further down.
    """
    refusal = await _on_device_refusal(request)
    if refusal is not None:
        return refusal
    # ON-DEVICE IS A PROMISE ABOUT THE TEXT, NOT JUST ABOUT THE ROUTE. The
    # refusal above only constrains where inference goes; debug observability is
    # a SECOND way off the machine, and it exports the messages and the
    # completion verbatim. So the same header also withholds this request's
    # content from that export. Set unconditionally on the header rather than
    # only when the export is enabled -- a guarantee that depends on an env var
    # read in another module is not one.
    if request.headers.get(REQUIRE_ON_DEVICE_HEADER, "").strip() == "1":
        withhold_observability_payloads_for_this_request()
    # Set, not scoped to a `with` block: the handler can return a
    # `StreamingResponse` whose generator -- and therefore whose
    # `format_model_prefix` call -- runs after this function has returned. See
    # `suppress_for_this_request` for why dropping the reset is safe.
    if request.headers.get(SUPPRESS_MODEL_PREFIX_HEADER, "").strip() == "1":
        suppress_for_this_request()
    return await chat_completions(request)


data_plane_router.add_api_route(
    "/chat/completions",
    chat_completions_entry,
    methods=["POST"],
    name="chat_completions",
)
data_plane_router.add_api_route(
    "/models",
    list_models,
    methods=["GET"],
    name="list_models",
)
data_plane_router.add_api_route(
    "/pii/level",
    pii_level,
    methods=["GET"],
    name="pii_level",
)
data_plane_router.add_api_route(
    "/session/{session_id}/locality",
    session_locality,
    methods=["GET"],
    name="session_locality",
)


@data_plane_router.api_route(
    "/{path:path}",
    methods=["GET", "POST", "PUT", "DELETE", "PATCH"],
)
async def data_plane_catchall(path: str, request: Request) -> JSONResponse:
    full_path = f"/v1/{path}" if path else "/v1"
    return error_response(
        "not_found",
        f"{request.method} {full_path} is not a known data-plane route",
        status_code=404,
        details={
            "namespace": "/v1",
            "path": full_path,
            "method": request.method,
        },
    )
