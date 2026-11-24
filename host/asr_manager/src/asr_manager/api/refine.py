"""The optional LLM clean-up routes, under /speech-to-text/v1.

    POST /speech-to-text/v1/refine       -- raw transcript in, cleaned transcript out
    GET  /speech-to-text/v1/refine/model -- can this model's reasoning be disabled?

WHY IT IS A SECOND REQUEST AND NOT PART OF /transcribe. Doing both in one call
would hold the user's words hostage to a cloud round trip: a slow or dead
endpoint would delay, or lose, text the on-device recogniser had already
produced. Split, the renderer gets the transcript at ASR speed and asks for the
polish separately, so every refine failure degrades to "your text, as dictated"
with nothing lost. It also keeps this module's failure modes -- network,
credentials, provider -- out of the decoder's route.

THE PRICE OF SPLITTING, AND WHO PAYS IT. A separate request has no audio, so the
two audio-derived gate rules cannot run here. They run during ``/transcribe``,
which does hold the samples, and ride home as ``refine_gate`` on its response.
This route re-checks only the rule it can (transcript length) and does not trust
the caller's claim to have passed the others -- the caller is a renderer.

Body parsed by hand and errors built through ``errors.error_response`` for the
reasons stated at length in ``api/asr.py``: ServiceHub's proxy discards any body
that is not ``{"error": {"code", "message"}}``, so a pydantic 422 would reach the
UI as an indistinguishable ``upstream_error``.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response

from ..recognize import model_state as ms
from ..refine import client as rc
from ..refine import preference
from ..refine import gate
from ..refine import providers
from .errors import error_response

_PREFIX = "/speech-to-text/v1"

refine_router = APIRouter(prefix=_PREFIX, tags=["refine"])

_MAX_TEXT_CHARS = 20_000
"""Guard on the one free-text field.

``/transcribe`` caps audio at 120 s, which is nowhere near this many characters,
so a body over the cap is not a long dictation -- it is a bug or a probe. Bounded
here rather than left to the model because the cost of an unbounded prompt is
billed."""

_MODES = ("agent", "preset", "local")
"""Accepted ``mode`` values, in the order the error message lists them.

``local`` needs nothing from this route that the other two did not: it is LRM's
``local-model`` alias, so "is a local bundle committed?" is answered by the data
plane (424 ``no_provider_available``, which ``client._upstream_failure`` already
maps to the user-actionable ``refine_no_model``) rather than re-derived here. A
second opinion on that would be a second source of truth about the user's
committed Binding, which this service has no business holding."""


def _validate(body: dict[str, Any]) -> tuple[str, rc.RefineMode]:
    """``(text, mode)`` or raise ``ValueError`` carrying the wire code.

    Fields are checked in a fixed order so a request with two problems always
    reports the same one, which is what makes a client-side test of this contract
    stable.
    """
    text = body.get("text")
    if not isinstance(text, str):
        raise _Invalid("invalid_request", "'text' must be a string")
    if len(text) > _MAX_TEXT_CHARS:
        raise _Invalid(
            "text_too_long",
            f"'text' is {len(text)} characters; the cap is {_MAX_TEXT_CHARS}",
        )

    mode = body.get("mode", "agent")
    if mode not in _MODES:
        raise _Invalid(
            "unsupported_mode", f"'mode' must be one of {', '.join(_MODES)}"
        )

    # `model` IS NO LONGER PART OF THIS CONTRACT, AND A BODY CARRYING ONE IS
    # REFUSED RATHER THAN IGNORED.
    #
    # It used to name the clean-up model for `preset` mode. This port has no
    # caller authentication and this service holds `LRM_HOST_API_KEY`, so that
    # field was an arbitrary-model spend against the user's key -- reproduced on
    # the installed app with no `Authorization` header at all. The model is now
    # host-side state (`refine/preference.py`); see that module for the whole
    # reasoning.
    #
    # REFUSED, not ignored, and the choice matters: silently dropping it would
    # mean a caller that still believes it is choosing gets a different model and
    # no way to find out, which is exactly how "my chosen clean-up model is not
    # being used" becomes unreportable. A loud 400 names the control plane
    # instead. Nothing in the field sends it -- the field ships in this same
    # change -- so there is no compatibility to keep.
    if "model" in body:
        raise _Invalid(
            "model_not_accepted",
            "'model' is not accepted here; set the clean-up model with PUT "
            f"{_PREFIX}/refine/preference",
        )
    return text, mode


class _Invalid(ValueError):
    """A client error, with the wire code it must be reported as."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@refine_router.get("/refine/preference")
async def get_refine_preference() -> Response:
    """The clean-up model the dictation path will actually use.

    A CONTROL-PLANE READ, replacing the renderer's ``localStorage`` copy. The
    settings card needs to show the current choice, and it must show the value
    that will really be sent -- a renderer-held copy could disagree with the file
    this service reads, and the one on screen is the one the user would believe.

    Always 200. A missing file is the ordinary first-run state and answers with
    the dictation default, so the card can render before anything was ever saved.
    """
    return JSONResponse(
        {"model": preference.read_model(), "default": providers.PRESET_MODEL}
    )


@refine_router.put("/refine/preference")
async def put_refine_preference(request: Request) -> Response:
    """Set the clean-up model.

    THE ONLY WAY IN. ``/refine`` refuses a model in its body; this is where the
    choice is made, and it is a deliberate separation: the field that decides
    what gets spent does not travel on the dictation path. Every route here
    requires the process credential only ServiceHub holds
    (``ManagementAuthMiddleware``), so a local process that skips the proxy is
    refused with 401 (#3351).

    Rejects rather than coercing: a write is an explicit user action, so
    answering "stored" while keeping something else would make the picker look
    like it had forgotten the choice.
    """
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001 -- any JSON failure is one client error
        return error_response(400, "invalid_request", "request body must be JSON")
    if not isinstance(body, dict):
        return error_response(400, "invalid_request", "request body must be a JSON object")

    try:
        stored = preference.write_model(body.get("model"))
    except preference.PreferenceError as exc:
        return error_response(400, exc.code, exc.message)
    except OSError as exc:
        # The state file could not be written -- a disk or permissions problem,
        # not anything the caller sent. 500 and named, because a silent 200 here
        # would report a choice as saved and then serve the old one forever.
        print(f"[asr-manager] ERROR: could not persist the clean-up model: {exc}", flush=True)
        return error_response(
            500, "preference_write_failed", f"could not save the clean-up model: {exc}"
        )

    return JSONResponse({"model": stored, "default": providers.PRESET_MODEL})


@refine_router.get("/refine/model")
async def refine_model(provider: str = "", model: str = "") -> Response:
    """Whether ``provider``/``model``'s reasoning can be switched off.

    EXISTS SO THE TABLE HAS ONE HOME. The UI needs this before the user dictates
    -- at the moment they turn clean-up on -- to offer switching to a model whose
    reasoning can be disabled. The alternative was a second copy of
    ``providers._CANNOT_DISABLE_PREFIXES`` in TypeScript, which would be a fourth
    source of model truth in this repo and would drift the first time either side
    was edited alone.

    No arguments means "describe the dictation model", so the caller can render
    the recommendation without hardcoding the preset's provider and model id --
    changing the preset must not need a matching UI change.

    Always 200. "I do not know this model" is a real, useful answer
    (``unknown``), not an error, and a failure here must never be able to block
    the settings page from rendering.
    """
    target_provider = provider.strip() or providers.PRESET_PROVIDER
    target_model = model.strip() or providers.PRESET_MODEL
    support = providers.reasoning_support(target_provider, target_model)
    return JSONResponse(
        {
            "provider": target_provider,
            "model": target_model,
            "reasoning_support": support.value,
            # What to offer instead when `reasoning_support` is "no". Sent on
            # every response, not just the bad one, so the caller can build its
            # copy from one shape.
            "recommended": {
                "provider": providers.PRESET_PROVIDER,
                "model": providers.PRESET_MODEL,
            },
        }
    )


@refine_router.post("/refine")
async def refine(request: Request) -> Response:
    """Clean up one transcript."""
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001 -- any JSON failure is one client error
        return error_response(400, "invalid_request", "request body must be JSON")
    if not isinstance(body, dict):
        return error_response(400, "invalid_request", "request body must be a JSON object")

    try:
        text, mode = _validate(body)
    except _Invalid as exc:
        return error_response(400, exc.code, exc.message)

    if not rc.is_configured():
        # 424 rather than 501: the capability is absent on THIS install because
        # nothing upstream is wired, which is a precondition failure the UI can
        # explain ("clean-up is unavailable") instead of a feature that does not
        # exist in the build.
        return error_response(
            424,
            "refine_not_configured",
            "LLM clean-up is not available on this install",
        )

    # Rule 3 of the gate. Short text on real sound is a real short utterance, so
    # the honest answer is 200 with the text unchanged -- not an error, and not a
    # model call. `refined: false` is what lets the caller tell "we chose not to"
    # from "it came back identical".
    text_verdict = gate.text_verdict(text)
    if not text_verdict.may_refine:
        return JSONResponse(
            {
                "text": text,
                "refined": False,
                "reason": text_verdict.reason,
                "model": "",
                "prompt_id": "",
                "served_by": "",
            }
        )

    # A refine is user activity on this service exactly as a transcription is:
    # without this, a long dictation session that keeps the cloud busy would let
    # the idle timer unload the ASR model between utterances.
    ms.mark_activity()

    try:
        result = await rc.refine(text, mode)
    except rc.RefineError as exc:
        # Logged host-side with the code so a field report can be triaged; the
        # client gets the same string, for the reason api/asr.py states -- a
        # local single-user service has no exposure to leak and an opaque 502
        # would be untriageable.
        print(f"[asr-manager] refine failed: {exc.code}: {exc.message}", flush=True)
        return error_response(exc.status, exc.code, exc.message)
    except Exception as exc:  # noqa: BLE001 -- see below
        # A bug in the client, not a failure it anticipated. Caught broadly for
        # the same reason `_transcribe_locked` catches broadly: an exception that
        # escapes here reaches Starlette's default 500, whose body is not this
        # service's `{"error": {"code", "message"}}` envelope -- so ServiceHub's
        # normalizer discards it and the UI sees a generic `upstream_error` with
        # the type and message destroyed. A distinct code (`refine_crashed`, not
        # the `refine_*` codes the client raises) is what keeps "our bug" legible
        # against "the provider failed" in a field report.
        print(
            f"[asr-manager] ERROR: refine crashed: {type(exc).__name__}: {exc}",
            flush=True,
        )
        return error_response(
            500, "refine_crashed", f"clean-up failed: {type(exc).__name__}: {exc}"
        )

    return JSONResponse(
        {
            "text": result.text,
            "refined": True,
            "reason": "ok",
            "model": result.model,
            "prompt_id": result.prompt_id,
            "served_by": result.served_by,
        }
    )
