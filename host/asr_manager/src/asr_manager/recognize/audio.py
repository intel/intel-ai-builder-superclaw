"""Wire audio -> float32 mono samples, with the contract's validation attached.

The transcribe request carries base64 audio in a JSON body (frozen contract §6).
That is not a preference: ``requestServiceHubJson`` and ``requestServiceHubBinary``
in the UI's shared transport both hard-code ``Content-Type: application/json`` and
``JSON.stringify(body)``, so raw bytes or multipart would require editing a shared
module that belongs to no single PR. Base64 costs +33% over loopback, which is the
cheaper trade.

Two accepted encodings:

  ``pcm_s16le``  headerless little-endian signed 16-bit. What the UI sends (it has
                 the Int16 buffer already; adding a RIFF header in JS would be
                 work for nothing).
  ``wav``        RIFF/WAVE container, PCM 16-bit only. Exists so ``curl`` and the
                 PR 1 acceptance evidence can post a real file.

Every failure here maps to one contract error code and nothing else; the caller
turns :class:`AudioError` straight into the error envelope. Parsing therefore never
raises a bare exception for a malformed body -- an unlabelled 500 would be
indistinguishable from an inference crash to the UI, which switches on ``.code``.

WHY THE SAMPLE RATE IS REJECTED RATHER THAN RESAMPLED
``transcribe_offline`` *would* resample (``_resample``, soxr or linear), and the
mel front end is pinned to 16 kHz by constants that must match the NeMo
preprocessor. Accepting 44.1 kHz and quietly resampling turns a UI capture bug into
"recognition is a bit worse" -- an untraceable symptom nobody files. Rejecting it
keeps the host and the browser capture path testably aligned: the UI asserts
``ctx.sampleRate === 16000`` and fails loudly if the platform refuses.
"""

from __future__ import annotations

import base64
import binascii
import io
import wave
from dataclasses import dataclass

import numpy as np

from . import model_state as ms

# Max accepted audio duration. The binding constraint is NOT memory or model
# quality, it is ServiceHub's proxy: `_DEFAULT_PROXY_TIMEOUT` is a hard-coded 30 s
# upstream read timeout with a single per-path exemption that is not ours, so a
# request whose inference outruns 30 s comes back as the hub's 504 no matter what
# this service does. On the measured box the ENC path runs at RTF ~0.058
# (1.36 s for a 23.3 s clip); a Lite-class machine may be 3-4x slower, so
# 120 s x RTF 0.25 ~= 30 s is already the edge. Raising this cap requires a
# per-path timeout exemption in servicehub first -- a cross-PR change.
#
# 120 s of pcm_s16le @16 kHz mono is 3.84 MB raw -> ~5.12 MB base64, comfortably
# under the hub forwarder's 10 MiB body limit, so the cap the user hits is this
# one (a legible `audio_too_long`) rather than the hub's opaque 413.
MAX_AUDIO_SECONDS = 120.0
MAX_SAMPLES = int(MAX_AUDIO_SECONDS * ms.SAMPLE_RATE)

SUPPORTED_ENCODINGS = ("pcm_s16le", "wav")

# int16 -> float32. The UI multiplies by 32768 on the way out
# (`Math.round(f * 32768)` clamped to [-32768, 32767]), so this is its exact
# inverse and the round trip is lossless for every representable sample.
_INT16_FULL_SCALE = 32768.0


class AudioError(Exception):
    """A request-level audio failure carrying its contract error code.

    ``status`` and ``code`` come straight from frozen contract §8a; the route does
    no mapping of its own, so the wire codes cannot drift from the table.
    """

    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


@dataclass(frozen=True)
class DecodedAudio:
    samples: np.ndarray   # float32, mono, 16 kHz, in [-1, 1)
    sample_rate: int

    @property
    def seconds(self) -> float:
        return len(self.samples) / float(self.sample_rate)


def decode_base64(value: str) -> bytes:
    """Strict base64 -> bytes. Anything else is ``invalid_request``.

    ``validate=True`` is the point: the permissive default silently DISCARDS
    characters outside the alphabet, so a truncated or whitespace-mangled payload
    would decode to plausible-looking garbage and be transcribed as noise instead
    of reported as the client bug it is.

    An EMPTY string is not rejected here. ``""`` is valid base64 for zero bytes, and
    zero bytes is zero samples, so it belongs to ``empty_audio`` in
    :func:`decode_audio` -- the same code a client gets for a recording that
    captured nothing. Calling it ``invalid_request`` instead would make "the user
    tapped the mic and said nothing" look like a malformed request to a UI that
    switches on ``.code``.
    """
    if not isinstance(value, str):
        raise AudioError(400, "invalid_request", "'audio' must be a base64 string")
    try:
        return base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise AudioError(
            400, "invalid_request", f"'audio' is not valid base64: {exc}"
        ) from exc


def _samples_from_pcm_s16le(raw: bytes) -> np.ndarray:
    if len(raw) % 2:
        # A half sample means the client mis-assembled its Int16 buffer. Truncating
        # would hide that and still transcribe; say so instead.
        raise AudioError(
            400,
            "invalid_request",
            f"pcm_s16le payload must be a whole number of 16-bit samples "
            f"(got {len(raw)} bytes)",
        )
    pcm = np.frombuffer(raw, dtype="<i2")
    return (pcm.astype(np.float32) / _INT16_FULL_SCALE).copy()


def _samples_from_wav(raw: bytes, declared_rate: int) -> np.ndarray:
    """Parse a RIFF/WAVE PCM-16 container with the stdlib ``wave`` module.

    stdlib rather than scipy: it is the only WAV reader this service needs, it
    keeps scipy out of asr_manager's dependency closure, and it rejects
    non-PCM/compressed content by itself.
    """
    try:
        with wave.open(io.BytesIO(raw), "rb") as wav:
            channels = wav.getnchannels()
            sample_width = wav.getsampwidth()
            framerate = wav.getframerate()
            frames = wav.readframes(wav.getnframes())
    except (wave.Error, EOFError) as exc:
        raise AudioError(
            400, "invalid_request", f"'audio' is not a readable RIFF/WAVE file: {exc}"
        ) from exc

    if sample_width != 2:
        raise AudioError(
            400,
            "unsupported_encoding",
            f"wav must be PCM 16-bit; this file is {sample_width * 8}-bit",
        )
    if channels != 1:
        raise AudioError(
            400, "unsupported_channels", f"wav must be mono; header says {channels} channels"
        )
    if framerate != ms.SAMPLE_RATE:
        raise AudioError(
            400,
            "unsupported_sample_rate",
            f"wav header sample rate must be {ms.SAMPLE_RATE} Hz, got {framerate}",
        )
    if framerate != declared_rate:
        # Both are 16000 by the checks above and the field validation, so this can
        # only fire if one of those ever loosens. Keep it: a header/body
        # disagreement is exactly the ambiguity the contract makes an error.
        raise AudioError(
            400,
            "unsupported_sample_rate",
            f"wav header sample rate ({framerate}) disagrees with the request "
            f"'sample_rate' ({declared_rate})",
        )
    return _samples_from_pcm_s16le(frames)


def decode_audio(audio_b64: str, encoding: str, declared_rate: int) -> DecodedAudio:
    """Validate + decode the request's audio into 16 kHz mono float32.

    Raises :class:`AudioError` with the contract code for every rejection. The
    duration cap is checked AFTER decoding (the base64 length alone cannot
    distinguish a long recording from a padded one), which is why the contract
    tells the UI to stop recording at 120 s client-side: a user who reaches the
    server-side 413 has already lost their audio.
    """
    raw = decode_base64(audio_b64)
    if encoding == "pcm_s16le":
        samples = _samples_from_pcm_s16le(raw)
    elif encoding == "wav":
        samples = _samples_from_wav(raw, declared_rate)
    else:  # pragma: no cover -- the route validates the field first
        raise AudioError(
            400,
            "unsupported_encoding",
            f"'encoding' must be one of {', '.join(SUPPORTED_ENCODINGS)}",
        )

    if len(samples) > MAX_SAMPLES:
        raise AudioError(
            413,
            "audio_too_long",
            f"audio is {len(samples) / ms.SAMPLE_RATE:.1f}s; the limit is "
            f"{MAX_AUDIO_SECONDS:.0f}s",
        )
    if len(samples) == 0:
        raise AudioError(400, "empty_audio", "audio decoded to zero samples")
    return DecodedAudio(samples=samples, sample_rate=ms.SAMPLE_RATE)
