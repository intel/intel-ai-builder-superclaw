"""Synthesis + model-lifecycle routes, all under /tts-narration/v1.

    GET  /tts-narration/v1/download/status — live download/load progress snapshot
    POST /tts-narration/v1/download        — 202; consent-gated on-demand download (~350 MB)
    POST /tts-narration/v1/prepare         — 202; lazily load the model when weights present
    POST /tts-narration/v1/tts             — audio/wav (body: {"text","voice"?,"language"?,"speed"?})

Ported from ``sandbox/tts_service/server.py`` (stdlib http.server) to FastAPI.
Synthesis stays serialized under ``model_state.INFERENCE_LOCK`` (KModel is not
thread-safe); Starlette runs the sync ``_synthesize`` in a threadpool.
"""

from __future__ import annotations

import io
import os
import time

from fastapi import APIRouter
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

from ..synth import download as dl
from ..synth import model_state as ms

_PREFIX = "/tts-narration/v1"

# Per-request text cap. One huge request would hold the global inference lock for
# minutes and stall every other caller.
_MAX_TEXT_CHARS = 4000

# The voice registry (voices.json) ships in the package root beside voices.py.
_REF_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_DEFAULT_VOICE = "default"

tts_router = APIRouter(prefix=_PREFIX, tags=["tts"])


# Chinese ("z") and Japanese ("j") are intentionally absent: narration is
# English-only and this build ships no G2P for either, so neither the aliases nor
# the one-letter allowlist accept them — such a request falls back rather than
# reaching a synth that can't serve it.
_UNSUPPORTED_LANG_CODES = {
    "z": "Chinese not available in this build",
    "j": "Japanese not available in this build",
}

_LANGUAGE_ALIASES = {
    "english": "a", "en": "a", "英文": "a", "英语": "a", "american": "a", "us": "a",
    "british": "b", "uk": "b", "英式": "b",
}


def _language_to_lang_code(language: str, fallback: str) -> str:
    key = str(language).strip().lower()
    if not key:
        return fallback
    if len(key) == 1 and key in {"a", "b", "e", "f", "h", "i", "p"}:
        return key
    return _LANGUAGE_ALIASES.get(key, fallback)


def _wav_bytes(wav, sr: int) -> bytes:
    import numpy as np
    from scipy.io import wavfile

    wav = np.asarray(wav, dtype=np.float32)
    peak = float(np.abs(wav).max()) if len(wav) else 0.0
    if peak > 0:
        wav = wav / peak * 0.95
    wav_int16 = np.clip(wav * 32767, -32768, 32767).astype(np.int16)
    buf = io.BytesIO()
    wavfile.write(buf, int(sr), wav_int16)
    return buf.getvalue()


class TtsBody(BaseModel):
    text: str = ""
    voice: str | None = None
    language: str | None = None
    speed: float | int | str | None = None


@tts_router.get("/download/status")
async def download_status() -> dict[str, object]:
    return ms.dl_snapshot()


@tts_router.post("/download")
async def download() -> JSONResponse:
    """Consent-gated on-demand model download. The UI POSTs here after the user
    confirms the ~350 MB download; idempotent (a second POST while a download is in
    flight just returns the live status)."""
    # Returns immediately. The model load runs on the background thread that
    # start_download_if_idle() starts; the native imports it needs were already
    # warmed at startup on the main thread (see __main__.run). Warming synchronously
    # here would run on the event-loop thread and starve /health until the watchdog
    # killed the child, so it must not happen in this handler.
    ms.mark_activity()
    return JSONResponse(dl.start_download_if_idle(), status_code=202)


@tts_router.post("/prepare")
async def prepare() -> JSONResponse:
    """Lazy residency: load the already-downloaded model into RAM on demand. The
    UI POSTs here when narration is turned on so the model is warm before the first
    sentence. If weights are absent this is a no-op reporting needs_download."""
    # Returns immediately. The model load runs on the background thread that
    # start_prepare_if_idle() starts; the native imports it needs were already
    # warmed at startup on the main thread (see __main__.run). Warming synchronously
    # here would run on the event-loop thread and starve /health until the watchdog
    # killed the child, so it must not happen in this handler.
    #
    # /prepare is also the 🔊-icon activation signal: the UI POSTs here when the
    # user turns narration on OR re-activates it. Bumping activity here (even when
    # the model is already resident and this is a no-op load) is what makes "no
    # click on the TTS icon" the thing that starts the idle-unload countdown.
    ms.mark_activity()
    return JSONResponse(dl.start_prepare_if_idle(), status_code=202)


@tts_router.post("/tts")
async def tts(body: TtsBody) -> Response:
    # A synthesis request before the model is resident: the UI should have gated on
    # /health, but be explicit rather than 500 from a None model.
    if not ms.is_loaded():
        # Self-heal the idle-unload transition. The idle monitor can drop a
        # previously-loaded model while narration is still toggled ON in the UI;
        # the UI only POSTs /prepare on toggle-on and reconnect, NOT per turn, so
        # without this a post-idle reply would 503 forever and narration would be
        # silently dead until the user toggled off/on. When the weights are on
        # disk, kick the SAME lazy reload /prepare uses (non-blocking, background
        # thread) so residency comes back on its own; this request still 503s (the
        # load takes a few seconds), but the narrator's later segments/turns
        # succeed once it lands. mark_activity() keeps the freshly-reloaded model
        # from being re-unloaded by the next monitor tick. When weights are ABSENT
        # this is a no-op (start_prepare_if_idle reports needs_download) — the cold
        # "never downloaded" case is unchanged.
        if ms.model_present():
            ms.mark_activity()
            # Weights are on disk but a PREVIOUS load already failed (corrupt or
            # truncated ONNX files — model_present() is a pure is_file() check, so
            # it stays True for a broken download). dl_begin_if_idle refuses
            # downloading/verifying/loading but NOT "error", so without this guard
            # every segment of every reply (a dozen+ per turn) would re-kick a load
            # that rebuilds and re-fails the onnxruntime session. Don't retry
            # per-segment; leave recovery to the user-driven /prepare|/download path
            # and report the error state distinctly.
            if ms.dl_state_get("state") == "error":
                print(
                    "[tts-manager] /tts on unloaded model; last load ERRORED "
                    "(weights likely corrupt) — not retrying per-segment; "
                    "re-enable narration or re-download to retry",
                    flush=True,
                )
                return JSONResponse(
                    {"error": "model load previously failed; re-enable narration to retry"},
                    status_code=503,
                )
            # This is the one self-heal branch that fires AFTER a user-visible
            # degradation (the idle monitor dropped a model while narration was
            # still ON). Log it so an installed-build "narration went silent then
            # recovered" report has a trace in the child log, not just a 503 the
            # client swallows.
            print(
                "[tts-manager] /tts on unloaded model; weights present — kicking "
                "lazy reload (idle-unload self-heal); this request 503s, later "
                "segments land once residency returns",
                flush=True,
            )
            dl.start_prepare_if_idle()
            # Weights ARE on disk — this 503 is transient (a reload is now in
            # flight after an idle-unload), not the cold "never downloaded" case.
            # Report it distinctly so logs/UI don't misread a self-healing reload
            # as a missing download.
            return JSONResponse(
                {"error": "model reloading after idle unload; retry shortly"},
                status_code=503,
            )
        return JSONResponse(
            {"error": "model not loaded; weights not downloaded yet"}, status_code=503
        )

    # Every synthesis is activity — resets the idle-unload timer so an actively
    # narrating session never has its model pulled out from under it.
    ms.mark_activity()

    text = str(body.text or "").strip()
    if not text:
        return JSONResponse({"error": "text must be a non-empty string"}, status_code=400)
    if len(text) > _MAX_TEXT_CHARS:
        return JSONResponse(
            {"error": f"text too long (max {_MAX_TEXT_CHARS} chars)"}, status_code=413
        )

    from ..voices import get_voice_info

    try:
        voice_id, lang_code, _ = get_voice_info(_REF_DIR, body.voice or _DEFAULT_VOICE)
    except ValueError as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)

    if body.language:
        lang_code = _language_to_lang_code(str(body.language), lang_code)
    # Defensive: no Chinese or Japanese voice or alias is shipped, but a raw
    # `zf_*`/`jf_*` voice id passed straight through get_voice_info still resolves
    # to "z"/"j". Refuse it rather than reading CJK text through English G2P.
    if lang_code in _UNSUPPORTED_LANG_CODES:
        return JSONResponse(
            {"error": _UNSUPPORTED_LANG_CODES[lang_code]}, status_code=400
        )

    try:
        speed = float(body.speed) if body.speed is not None else 1.0
    except (TypeError, ValueError):
        speed = 1.0
    # Reject NaN/inf and non-positive rates before the model sees them. A NaN
    # comparison is always False, so this one check clamps NaN, ±inf, zero, and
    # negatives back to the default.
    if not (0 < speed < 10_000):
        speed = 1.0

    import anyio

    return await anyio.to_thread.run_sync(_synthesize, text, voice_id, lang_code, speed)


def _synthesize(text: str, voice_id: str, lang_code: str, speed: float) -> Response:
    """Blocking synthesis body — runs in a threadpool. Serializes on the global
    inference lock (KModel is not thread-safe)."""
    import numpy as np

    t0 = time.monotonic()
    if ms.get_model() is None:
        return JSONResponse(
            {"error": "model not loaded; weights not downloaded yet"}, status_code=503
        )
    try:
        with ms.INFERENCE_LOCK:
            # Re-fetch _MODEL INSIDE the lock — do not reuse the reference from the
            # gate check above. unload_model_locked() nulls _MODEL while holding
            # INFERENCE_LOCK, so a request that passed the check but then blocked
            # here must observe the drop and 503 cleanly rather than run generate()
            # on a session the unload has retired. This is the invariant
            # unload_model_locked()'s docstring relies on; capturing before the lock
            # would run on a stale reference (safe only by refcount today, a
            # use-after-free the moment unload does real teardown).
            model = ms.get_model()
            if model is None:
                return JSONResponse(
                    {"error": "model unloaded while request was queued; retry shortly"},
                    status_code=503,
                )
            wavs, sr = model.generate(text=text, voice=voice_id, lang_code=lang_code, speed=speed)
    except Exception as exc:  # noqa: BLE001
        return JSONResponse(
            {"error": f"generation failed: {type(exc).__name__}: {exc}"}, status_code=500
        )

    if not wavs:
        return JSONResponse({"error": "model returned no audio"}, status_code=500)

    data = _wav_bytes(wavs[0], sr)
    synth_s = time.monotonic() - t0
    audio_s = len(np.asarray(wavs[0])) / sr if sr else 0.0
    rtf = (synth_s / audio_s) if audio_s else 0.0
    return Response(
        content=data,
        media_type="audio/wav",
        headers={
            "X-Synth-Seconds": f"{synth_s:.3f}",
            "X-Audio-Seconds": f"{audio_s:.3f}",
            "X-RTF": f"{rtf:.3f}",
        },
    )
