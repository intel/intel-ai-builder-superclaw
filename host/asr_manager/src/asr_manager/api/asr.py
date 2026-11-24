"""Transcription + model-lifecycle routes, all under /speech-to-text/v1.

    GET  /speech-to-text/v1/download/status -- live download/load progress snapshot
    POST /speech-to-text/v1/download        -- 202; consent-gated download (~630 MB)
    POST /speech-to-text/v1/prepare         -- 202; lazily load when weights present
    POST /speech-to-text/v1/transcribe      -- JSON in, JSON out (frozen contract §6/§7)

The optional LLM clean-up pass that may follow a transcription lives in
``api/refine.py``, not here: it is an outbound cloud call with its own failure
modes, and this module's whole subject is the on-device decoder.

WHY THE BODY IS PARSED BY HAND INSTEAD OF WITH A PYDANTIC MODEL
A declared pydantic body would make FastAPI answer a malformed request with its
own 422 ``{"detail": [...]}``. ServiceHub's proxy replaces any body that is not
``{"error": {"code", "message"}}`` with a generic ``upstream_error``, so every
client mistake would arrive at the UI indistinguishable from a server crash --
and the frozen contract requires SPECIFIC codes (``unsupported_encoding`` vs
``unsupported_sample_rate`` vs ``unsupported_channels``) that a 422 cannot carry
anyway. Parsing here is what lets each field name its own failure.
``app.py`` still registers a ``RequestValidationError`` handler as a backstop for
anything that reaches FastAPI's validation first (e.g. undecodable JSON).

WHY ONE POST AND NO WEBSOCKET
The ENC pipeline emits no partial hypotheses by design: it windows the ENCODER
FRAME SEQUENCE and runs one continuous TDT greedy decode whose LSTM prediction
state is never reset, so there is no intermediate text to stream. Recording lives
in the WebView (``getUserMedia``), so mic permission, the recording UI and cancel
all stay in the App and this service is a stateless audio-in/text-out API.
"""

from __future__ import annotations

import time
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response

from ..recognize import audio as au
from ..recognize import download as dl
from ..recognize import model_state as ms
from ..refine import gate
from .errors import error_response

_PREFIX = "/speech-to-text/v1"

asr_router = APIRouter(prefix=_PREFIX, tags=["asr"])

# The only accepted language. Parakeet TDT 0.6B v2 is an English-only model; it
# does not fail on other speech, it HALLUCINATES English-looking text from it
# (a Mandarin sentence comes back as plausible-looking gibberish). Rejecting an
# explicit non-English request is therefore more honest than serving it. Absent
# means "English" -- the field is optional so the common case sends nothing.
_SUPPORTED_LANGUAGES = ("en",)

# The ENC preset. Fixed, not a request field: the plan's "do not ship" list names
# "multiple engines / backend choice / chunking preset" explicitly -- the user
# should not face these. Values are the validated default preset
# ``enc_w10_l0p64_r2p56_run``: 10 s windows over the encoder frame sequence with
# 0.64 s left and 2.56 s right context and running normalisation statistics.
_WIN_S = 10.0
_CTX_S = 0.64
_CTX_R_S = 2.56
_NORM = "running"

# The two decode modes, reported back in the response so a caller can tell which
# one its request actually got. Which one runs is decided per request by whether
# the ``dictionary`` field carries any usable word -- never by configuration:
# an empty Dictionary must cost exactly what PR 1 cost.
_DECODE_GREEDY = "greedy"
_DECODE_BEAM = "beam"

# Dictionary caps.
#
# Note what these do NOT buy: decode time is flat in dictionary size. 10, 50, 128
# and 256 entries all measure inside each other's noise, because every entry (and
# its up-to-three case variants from ``hotword_forms``) collapses into one
# Aho-Corasick graph walked in one state transition per step, and the cost that
# does show up -- ~1.25x greedy -- is the beam widening to ``max_active_paths``
# hypotheses. See README. So the cap is not a performance tuning knob.
#
# What it bounds is graph construction and memory for a pathological body: a
# pasted 10,000-line word list is not a Dictionary, and refusing it with a named
# code beats building the graph to find out. 250 is well above the plan's use case
# (names, project names and jargon typed in by hand, plus PR 4's auto-suggested
# repo and file names), and inside the measured range above.
_MAX_DICTIONARY_WORDS = 250
# One entry is a name or a short phrase. 100 chars is generous for that and stops
# a whole pasted paragraph from becoming a single "hotword" that can never match.
_MAX_DICTIONARY_ENTRY_CHARS = 100


@asr_router.get("/download/status")
async def download_status() -> dict[str, object]:
    """Live download/load progress -- and the UI's WAKE + READINESS endpoint.

    ``/health`` and ``/version`` are whitelisted by the hub and do NOT cold-start
    an ``on_demand`` child (they answer ``service_dormant`` 503), so this is the
    first call the UI makes: it starts the process and, once answered, reports
    both ``weights_present`` (show the consent dialog or not) and ``model_loaded``
    (record now or call /prepare first). One endpoint, one poll loop.
    """
    return ms.dl_snapshot()


@asr_router.post("/download")
async def download() -> JSONResponse:
    """Consent-gated on-demand model download (~630 MB). Idempotent: a second POST
    while a download is in flight just returns the live snapshot.

    Returns 202 immediately; the fetch and load run on a background thread. The
    native imports that load needs were warmed at startup on the main thread (see
    ``__main__.run``) -- doing it here would run on the event-loop thread and
    starve ``/health`` until the watchdog killed the child.
    """
    ms.mark_activity()
    return JSONResponse(dl.start_download_if_idle(), status_code=202)


@asr_router.post("/prepare")
async def prepare() -> JSONResponse:
    """Lazy residency + the activity ping. Loads already-downloaded weights into
    RAM; a no-op reporting ``needs_download`` when they are absent (fetching is the
    consent flow's job, not this route's).

    The UI POSTs here when the voice-input page opens or the mic is armed, which is
    what makes "no dictation" -- rather than "no page open" -- start the idle
    countdown, and what moves the multi-second model load off the critical path so
    the first transcribe is fast.
    """
    ms.mark_activity()
    return JSONResponse(dl.start_prepare_if_idle(), status_code=202)


def _field(body: dict[str, Any], name: str) -> Any:
    value = body.get(name)
    return value


def _validate(body: dict[str, Any]) -> tuple[str, str, int]:
    """Field validation in the frozen contract's order. Returns
    ``(audio_b64, encoding, sample_rate)``; raises :class:`au.AudioError`.

    Order matters and is part of the contract: a request that gets several fields
    wrong must always be told about the same one first, or a client author fixes
    fields in a different order than the next person debugging the same payload.
    """
    for name in ("audio", "encoding", "sample_rate", "channels"):
        if body.get(name) is None:
            raise au.AudioError(400, "invalid_request", f"'{name}' is required")

    encoding = _field(body, "encoding")
    if not isinstance(encoding, str) or encoding not in au.SUPPORTED_ENCODINGS:
        raise au.AudioError(
            400,
            "unsupported_encoding",
            f"'encoding' must be one of {', '.join(au.SUPPORTED_ENCODINGS)}, "
            f"got {encoding!r}",
        )

    sample_rate = _field(body, "sample_rate")
    # `is True` excludes bool: `True == 1` in Python, so a JSON `true` would
    # otherwise sail through an `isinstance(x, int)` check.
    if sample_rate is True or sample_rate is False or sample_rate != ms.SAMPLE_RATE:
        raise au.AudioError(
            400,
            "unsupported_sample_rate",
            f"'sample_rate' must be exactly {ms.SAMPLE_RATE}, got {sample_rate!r}; "
            f"resample in the capture path (the UI's AudioContext is opened at "
            f"{ms.SAMPLE_RATE} Hz)",
        )

    channels = _field(body, "channels")
    if channels is True or channels is False or channels != 1:
        raise au.AudioError(
            400, "unsupported_channels", f"'channels' must be exactly 1, got {channels!r}"
        )

    language = body.get("language")
    if language is not None:
        if not isinstance(language, str) or language.strip().lower() not in _SUPPORTED_LANGUAGES:
            raise au.AudioError(
                400,
                "unsupported_language",
                f"local recognition is English only ({'/'.join(_SUPPORTED_LANGUAGES)}); "
                f"got {language!r}. Switch to cloud mode for other languages.",
            )

    dictionary = _validate_dictionary(body.get("dictionary"))

    # Any OTHER unknown key is still ignored, never rejected -- the stacked order
    # means a UI built against a newer draft may send a field this host has not
    # grown yet, and a 400 there would break the mic for a forward-looking client.
    return _field(body, "audio"), encoding, int(sample_rate), dictionary


def _validate_dictionary(raw: Any) -> tuple[str, ...]:
    """The ``dictionary`` request field -> the word tuple the beam biases toward.

    Absent or empty means greedy: the field is optional and an empty list is the
    normal state of a user who never opened the Dictionary card, so neither may
    cost anything.

    Unlike the other fields, a malformed value here now 400s where PR 1 silently
    ignored it. That change is deliberate and it is the whole point of the field
    becoming real: silently dropping a Dictionary produces a *correct-looking*
    transcript that simply does not contain the user's project name, which is
    exactly the failure the Dictionary exists to prevent and is indistinguishable
    from the model mishearing. A 400 is legible; a quiet downgrade is not.

    Casing is preserved rather than normalised. ``hotword_forms`` already expands
    each entry into its verbatim, lowercase and Capitalised variants, so
    lowercasing here would throw away the one form the user typed on purpose
    (``NVMe``, ``LLMRouter``) and gain nothing.
    """
    if raw is None:
        return ()
    # `str` first: a bare string is iterable, so without this check "Intel" would
    # be accepted as the five hotwords I, n, t, e, l.
    if isinstance(raw, str) or not isinstance(raw, list):
        raise au.AudioError(
            400,
            "invalid_dictionary",
            f"'dictionary' must be an array of strings, got {type(raw).__name__}",
        )
    if len(raw) > _MAX_DICTIONARY_WORDS:
        raise au.AudioError(
            400,
            "dictionary_too_large",
            f"'dictionary' holds at most {_MAX_DICTIONARY_WORDS} entries, got {len(raw)}",
        )

    words: list[str] = []
    seen: set[str] = set()
    for index, entry in enumerate(raw):
        if not isinstance(entry, str):
            raise au.AudioError(
                400,
                "invalid_dictionary",
                f"'dictionary[{index}]' must be a string, got {type(entry).__name__}",
            )
        word = entry.strip()
        # Blanks and duplicates are dropped rather than rejected: they are what a
        # text box produces, not a client bug, and the UI already trims. Dropping
        # keeps a trailing empty row from breaking a recording.
        if not word or word in seen:
            continue
        if len(word) > _MAX_DICTIONARY_ENTRY_CHARS:
            raise au.AudioError(
                400,
                "dictionary_entry_too_long",
                f"'dictionary[{index}]' is {len(word)} characters; the limit is "
                f"{_MAX_DICTIONARY_ENTRY_CHARS}",
            )
        seen.add(word)
        words.append(word)
    return tuple(words)


def _model_gate() -> JSONResponse | None:
    """503 (with the right code) when no runner is resident, else ``None``.

    Four genuinely different situations the UI must act on differently, which is
    why they are four codes and not one "model not ready":

    ``model_not_downloaded``  no weights -> open the consent dialog.
    ``model_loading``         a download/verify/load is in flight -> keep polling
                              ``/download/status``; retrying is pointless but the
                              wait is bounded and self-resolving.
    ``model_load_failed``     weights on disk but the last load FAILED (a
                              truncated or corrupt file -- ``model_present()`` is
                              a pure ``is_file()`` check). Deliberately does NOT
                              kick a retry: ``dl_begin_if_idle`` refuses
                              downloading/verifying/loading but not ``error``, so
                              a self-heal here would rebuild and re-fail an
                              onnxruntime session on every request. Recovery is
                              user-driven: POST /download from this state
                              re-verifies each file's sha256 and re-fetches the bad
                              one (``download.start_download_if_idle``), so the
                              [重新下載] button this code tells the UI to show is a
                              real way out and not a loop.
    ``model_unloaded``        weights on disk, nothing wrong -- the idle monitor
                              dropped residency. Kick the SAME background load
                              ``/prepare`` uses and tell the client to retry. This
                              is the self-heal that keeps the mic working after a
                              15-minute pause without the UI having to know the
                              model was ever unloaded.

    ORDER MATTERS: in-flight BEFORE weights-present. ``model_present()`` is True
    only once ALL FOUR files have landed, so for almost the whole of a first
    download it is False while the state is ``downloading`` -- checking presence
    first answered ``model_not_downloaded`` mid-download, which is the code that
    tells the UI to open the consent dialog. Re-asking a user to consent to a
    ~630 MB download that is already running at 80% is the worst of the four
    answers, and it is the one the old order gave most often.
    """
    if ms.is_loaded():
        return None

    state = ms.dl_state_get("state")
    if state in ("downloading", "verifying", "loading"):
        return error_response(
            503,
            "model_loading",
            f"the speech model is {state}; poll "
            f"/speech-to-text/v1/download/status and retry when it is ready",
        )

    # Nothing in flight, so absent files really do mean "never downloaded" -- and a
    # failed download that left files missing is that too, not ``model_load_failed``.
    if not ms.model_present():
        return error_response(
            503,
            "model_not_downloaded",
            "the speech model has not been downloaded yet; POST "
            "/speech-to-text/v1/download after the user consents (~630 MB)",
        )

    if state == "error":
        print(
            "[asr-manager] /transcribe on unloaded model; last load ERRORED "
            "(weights likely corrupt) -- not retrying per-request; re-download to "
            "recover",
            flush=True,
        )
        return error_response(
            503,
            "model_load_failed",
            "the speech model failed to load (the downloaded files may be "
            "corrupt); re-download the model to retry",
        )

    # Weights present, nothing in flight, nothing failed: an idle unload. Kick the
    # reload and report a transient, distinctly-coded 503.
    ms.mark_activity()
    dl.start_prepare_if_idle()
    print(
        "[asr-manager] /transcribe on unloaded model; weights present -- kicking "
        "lazy reload (idle-unload self-heal); this request 503s, retry shortly",
        flush=True,
    )
    return error_response(
        503,
        "model_unloaded",
        "the speech model was unloaded after being idle and is reloading now; "
        "retry in a few seconds",
    )


@asr_router.post("/transcribe")
async def transcribe(request: Request) -> Response:
    """Transcribe one whole utterance. Frozen contract §6 in, §7 out."""
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001 -- any JSON failure is one client error
        return error_response(400, "invalid_request", "request body must be JSON")
    if not isinstance(body, dict):
        return error_response(400, "invalid_request", "request body must be a JSON object")

    try:
        audio_b64, encoding, sample_rate, dictionary = _validate(body)
        decoded = au.decode_audio(audio_b64, encoding, sample_rate)
    except au.AudioError as exc:
        return error_response(exc.status, exc.code, exc.message)

    gate = _model_gate()
    if gate is not None:
        return gate

    # Every transcription is activity -- an actively dictating user never has the
    # model pulled out from under them.
    ms.mark_activity()

    import anyio

    return await anyio.to_thread.run_sync(_transcribe_locked, decoded, dictionary)


def _transcribe_locked(decoded: au.DecodedAudio, dictionary: tuple[str, ...]) -> Response:
    """Blocking decode -- runs in Starlette's threadpool, serialized on
    ``INFERENCE_LOCK``.

    The lock is not optional. One ``OrtParakeet`` owns three ONNX sessions and the
    greedy TDT pass carries LSTM prediction state plus a frame cursor across the
    whole utterance, so two concurrent requests on one runner would interleave
    joiner calls against the same prediction state and corrupt BOTH transcripts --
    silently, as plausible wrong words rather than an error. Serializing means a
    second concurrent request waits; with a ~1.4 s decode and a single human
    speaking into one composer, that queue is theoretical.
    """
    # Greedy unless this request actually carries a word. `_decode_frames` makes
    # the same check before importing `tdt_beam`, so an empty Dictionary pays
    # neither the beam nor the import -- but deciding it here too is what lets the
    # response report the mode honestly instead of echoing what was asked for.
    decode_mode = _DECODE_BEAM if dictionary else _DECODE_GREEDY
    t0 = time.monotonic()
    try:
        with ms.INFERENCE_LOCK:
            # Re-read the runner INSIDE the lock; never reuse the reference the
            # gate check saw. ``unload_model_locked()`` nulls the runner while
            # holding this same lock, so a request that passed the gate and then
            # blocked here must observe the drop and 503 cleanly instead of
            # decoding against retired sessions. This re-read is the invariant
            # ``unload_model_locked``'s docstring depends on.
            runner = ms.get_runner()
            if runner is None:
                # Same self-heal as the gate's idle-unload branch, for the same
                # reason: "retry shortly" is only honest if something is actually
                # reloading. Without the kick, this request burns a 503 and the
                # NEXT one is the first to start the load -- two round trips and a
                # multi-second load before the user's second attempt can work.
                # Safe to start while holding INFERENCE_LOCK: the background load
                # takes _MODEL_LOAD_LOCK, never this one, so it waits for the
                # in-flight unload to finish rather than deadlocking with it.
                ms.mark_activity()
                dl.start_prepare_if_idle()
                return error_response(
                    503,
                    "model_unloaded",
                    "the speech model was unloaded while this request was queued "
                    "and is reloading now; retry in a few seconds",
                )
            from ..recognize.enc_pipeline import transcribe_offline

            text = transcribe_offline(
                runner,
                decoded.samples,
                decoded.sample_rate,
                win_s=_WIN_S,
                ctx_s=_CTX_S,
                ctx_r_s=_CTX_R_S,
                norm=_NORM,
                decode_mode=decode_mode,
                dictionary_words=dictionary,
            )
    except Exception as exc:  # noqa: BLE001
        # Log the full type/message host-side; the client gets the same string
        # because a local, single-user service has no exposure to leak and an
        # opaque 500 would make a field report untriageable.
        print(
            f"[asr-manager] ERROR: transcription failed: {type(exc).__name__}: {exc}",
            flush=True,
        )
        return error_response(
            500, "transcribe_failed", f"transcription failed: {type(exc).__name__}: {exc}"
        )

    transcribe_s = time.monotonic() - t0
    audio_s = decoded.seconds
    rtf = (transcribe_s / audio_s) if audio_s else 0.0
    text = (text or "").strip()

    # The audio-derived half of the refine gate, decided HERE because this is the
    # only place that holds the decoded samples. `/refine` is a separate request
    # and gets only the transcript, so re-deriving a peak amplitude there would
    # mean re-uploading the whole clip. Reported unconditionally -- this service
    # does not know whether the caller has clean-up switched on, and a recogniser
    # whose answer changed with an unrelated UI setting would be a worse contract
    # than one extra object on every response. See `refine/gate.py`.
    gate_verdict = gate.audio_verdict(decoded.samples, audio_s)

    # Empty transcript is a SUCCESS (200 with ""), not an error: silence, a
    # mis-click or a cough are all normal outcomes of pressing a mic button, and
    # the UI simply leaves the composer untouched. Making it a 4xx/5xx would put
    # an error banner in front of a user who merely said nothing.
    return JSONResponse(
        {
            "text": text,
            "language": "en",
            "audio_seconds": round(audio_s, 3),
            "transcribe_seconds": round(transcribe_s, 3),
            "rtf": round(rtf, 4),
            "model": ms.MODEL_ID,
            # Now genuinely per-request. No new field was added to carry the
            # Dictionary's effect: `"beam"` already means "a non-empty dictionary
            # reached the decoder", which is the one thing a caller needs to tell
            # "my words never arrived" from "they arrived and did not win".
            "decode": decode_mode,
            # Additive to frozen contract §7: a caller that predates clean-up
            # ignores it, and a caller that wants it needs no second round trip
            # (and no second upload) to learn whether this clip is worth one.
            "refine_gate": {
                "action": gate_verdict.action.value,
                "reason": gate_verdict.reason,
            },
        },
        headers={
            # Same three numbers as the body, as headers, so the latency budget can
            # be read off a `curl -I`-style trace (and from a streamed proxy log)
            # without parsing JSON. Mirrors tts_manager's X-Synth-Seconds/X-RTF.
            "X-Audio-Seconds": f"{audio_s:.3f}",
            "X-Transcribe-Seconds": f"{transcribe_s:.3f}",
            "X-RTF": f"{rtf:.4f}",
        },
    )
