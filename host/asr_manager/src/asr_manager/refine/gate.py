"""Whether one dictation is worth sending to the clean-up LLM.

THE PROBLEM THIS SOLVES. On a silent or near-silent recording -- mic muted, hot
key tapped by accident, a sub-second blip -- Parakeet still emits *something*,
usually a short filler like "ok", "you" or "thank you". Hand that to a clean-up
model and it has no real content to work with, so it **hallucinates**: it invents
a whole plausible paragraph or numbered list out of nothing and that lands in the
user's composer as if they had dictated it. Guarding this is not an optimisation;
an unguarded refine turns a mis-click into fabricated text.

Ported from ``voice-dictation-team/src/llm_gate.py``, which is where the three
rules and their thresholds were tuned. Two deliberate differences:

  * The VAD variant is NOT ported. That app runs Silero VAD for its own chunking
    and got the speech-presence rule for free; asr_manager has no VAD, and adding
    one to decide whether to spend a cloud call would be a new model download for
    a guard the amplitude floor already covers.
  * The rules are split across two call sites instead of one (see below), because
    in SuperClaw the audio and the decision to refine are one round trip apart.

WHY THE SPLIT. ``/transcribe`` holds the decoded audio; ``/refine`` holds only
the transcript, by design -- re-uploading hundreds of KB of PCM just to re-derive
a peak amplitude would double the dictation's bytes on the wire. So the two
audio-derived rules are evaluated during transcription by :func:`audio_verdict`
and their one-word answer rides home in the ``/transcribe`` response; the
text-derived rule is evaluated by :func:`text_verdict` inside ``/refine``, where
the text is. Neither half trusts the other: ``/refine`` re-checks the text rule
even though the caller was told it may refine, because the caller is the renderer
and the renderer can be wrong.

THE RULES. A dictation must clear all three to reach the model:

  1. **Audio duration** -- at least ``min_audio_s`` seconds. A short clip is not
     worth a cloud call. (audio side)
  2. **Audio amplitude** -- peak |amplitude| above ``min_peak`` OR RMS above
     ``min_rms``. Below both, the clip is silence. (audio side)
  3. **Text length** -- the trimmed transcript has at least ``min_chars``
     characters. "ok" (2) is dropped. (text side)

ONLY RULE 2 DELIVERS NOTHING. Amplitude is the one rule that is *diagnostic of
absence*: below both floors there was no sound, so whatever the decoder emitted
it did not come from the user, and inserting it would put words in their mouth.

Rules 1 and 3 both mean "real sound, too little of it to be worth a model call",
so both deliver the raw ASR text and merely skip the model. Duration used to
return ``EMPTY`` and that was wrong: ``min_audio_s`` is 1.0 s and a clearly
spoken "yes", "no" or "stop" fits inside it comfortably, so the rule discarded
correctly recognised words. Worse, ``/transcribe`` reports this verdict
unconditionally, so it discarded them even with clean-up switched OFF -- a
default-off feature silently changing what dictation inserts. A sub-second tap
whose filler now reaches the composer is the behaviour that shipped before this
gate existed; losing a real word is not.

That is why :class:`Action` has three members and not two.

Samples arrive float32 mono in [-1, 1) (``recognize/audio.py``), so the
amplitude thresholds are in that scale: speech peaks at 0.1-0.9 while a silent
clip's peak floor is typically well under 0.02.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

import numpy as np


class Action(str, Enum):
    """What to do with one dictation.

    A ``str`` enum so the value can go straight into a JSON response without a
    conversion step at every call site.
    """

    REFINE = "refine"
    """Send it to the clean-up model."""

    ASR_ONLY = "asr_only"
    """Deliver the raw ASR text unchanged; skip the model."""

    EMPTY = "empty"
    """Not speech. Deliver nothing -- see the hallucination note above."""


@dataclass(frozen=True)
class Verdict:
    action: Action
    reason: str
    """Short, human-readable, and carried all the way to the ``/transcribe``
    response. It is the only way a field report can distinguish "the LLM was
    off" from "the gate judged your clip silent", which otherwise look identical
    from the composer: text appears un-polished either way."""

    @property
    def may_refine(self) -> bool:
        return self.action is Action.REFINE

    @property
    def is_speech(self) -> bool:
        return self.action is not Action.EMPTY


# Defaults as tuned in the reference app. Exposed as module constants because
# ``config.py`` overrides them from the environment and the tests assert against
# the same names.
DEFAULT_MIN_CHARS = 3
DEFAULT_MIN_AUDIO_S = 1.0
DEFAULT_MIN_PEAK = 0.02
DEFAULT_MIN_RMS = 0.005

_STATS_CHUNK = 1 << 20
"""Samples per pass (~65 s at 16 kHz) when scanning a long clip.

Dictation is capped well under this, so the common case is the single-pass
branch and is computed exactly as the reference app computes it. The chunked
branch exists so that cap rising later cannot turn this guard into a
whole-recording float64 temporary.
"""


def amplitude_stats(samples: np.ndarray | None) -> tuple[float, float]:
    """``(peak |amplitude|, RMS)`` of a mono float array; ``(0.0, 0.0)`` when empty."""
    if samples is None:
        return 0.0, 0.0
    flat = np.asarray(samples, dtype=np.float32).ravel()
    if flat.size == 0:
        return 0.0, 0.0
    if flat.size <= _STATS_CHUNK:
        return float(np.max(np.abs(flat))), float(np.sqrt(np.mean(np.square(flat))))
    peak = 0.0
    sum_squares = 0.0
    for start in range(0, flat.size, _STATS_CHUNK):
        chunk = np.asarray(flat[start : start + _STATS_CHUNK], dtype=np.float64)
        peak = max(peak, float(np.max(np.abs(chunk))))
        sum_squares += float(np.dot(chunk, chunk))
    return peak, float(np.sqrt(sum_squares / flat.size))


def audio_verdict(
    samples: np.ndarray | None,
    audio_s: float,
    *,
    min_audio_s: float = DEFAULT_MIN_AUDIO_S,
    min_peak: float = DEFAULT_MIN_PEAK,
    min_rms: float = DEFAULT_MIN_RMS,
) -> Verdict:
    """Rules 1 and 2 -- everything decidable from the audio alone.

    Returns ``REFINE`` to mean "the audio raises no objection", NOT "definitely
    refine": rule 3 has not run yet, and the caller may have the feature off
    entirely. ``/transcribe`` reports this verdict unconditionally rather than
    only when refine is enabled, so toggling the setting does not change what
    the recogniser says about a clip.

    Only the amplitude rule can return ``EMPTY``. The duration rule returns
    ``ASR_ONLY`` -- see the module docstring for why throwing a one-second "yes"
    away is a bug and not a guard.
    """
    short = audio_s < min_audio_s
    peak, rms = amplitude_stats(samples)

    # Amplitude is evaluated FIRST now, and unconditionally -- it used to be
    # skipped for short clips. It is the only rule entitled to deliver nothing,
    # so a clip that is both short and silent must land on ``EMPTY`` rather than
    # on the duration rule's weaker verdict and have its filler inserted. The
    # extra pass costs one scan of at most ``min_audio_s`` of audio.
    if peak < min_peak and rms < min_rms:
        reason = f"silent (peak {peak:.3f} < {min_peak}, rms {rms:.3f} < {min_rms})"
        if short:
            # Both fired, so name both: "silent" alone about a 0.2 s clip sends
            # the reader of a field report hunting a mic fault that is not there.
            reason = f"audio {audio_s:.2f}s < {min_audio_s:.2f}s, {reason}"
        return Verdict(Action.EMPTY, reason)

    if short:
        return Verdict(Action.ASR_ONLY, f"audio {audio_s:.2f}s < {min_audio_s:.2f}s")

    return Verdict(Action.REFINE, "audio ok")


def text_verdict(text: str, *, min_chars: int = DEFAULT_MIN_CHARS) -> Verdict:
    """Rule 3 -- the only rule ``/refine`` can evaluate for itself.

    ``ASR_ONLY``, never ``EMPTY``: reaching here means the audio rules already
    passed, so there WAS real sound. A short transcript on real sound is a real
    short utterance, and throwing the user's "yes" away would be a bug, not a
    guard.
    """
    length = len(text.strip())
    if length < min_chars:
        return Verdict(Action.ASR_ONLY, f"transcript {length} chars < {min_chars}")
    return Verdict(Action.REFINE, "ok")
