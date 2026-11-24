"""Kokoro-82M inference wrapper for the resident TTS narration service.

ONNX RUNTIME, NO PYTORCH. This drives the Kokoro ONNX export on onnxruntime instead
of the PyTorch ``kokoro`` package: torch's Linux wheel dragged ~2.5 GB of CUDA libs
into the backend image, and even the CPU wheel is ~450 MB. onnxruntime is ~40 MB and
produces byte-comparable audio. Text -> phonemes uses misaki (the same G2P as
before, so pronunciation quality is unchanged).

NO GPL. The ``kokoro-onnx`` package is deliberately not used: it imports
``phonemizer-fork`` and ``espeakng-loader`` (both GPL-3.0) at module scope even
though phonemes always come from misaki. The few steps it performed for us --
phoneme -> token ids, chunking at 510 phonemes, one session run per chunk, and
silence trimming -- live here instead. misaki's English path can optionally pull a
transformer POS tagger (spacy-curated-transformers -> torch); we use
``G2P(trf=False)`` (the small spaCy model) so torch stays out of the environment
entirely.

    model = KokoroTTS.from_pretrained(threads=6, local_dir="/data/kokoro/Kokoro-82M")
    wavs, sr = model.generate(text="Hello", voice="af_heart", lang_code="a")

Design notes:
- Kokoro is a *preset-voice* model (voice packs like ``af_heart`` /
  ``bf_emma``); it does NOT do reference-audio voice cloning. ``voice`` is a
  Kokoro voice-pack id and ``lang_code`` is a single-letter Kokoro language code
  (a=US-en, b=UK-en). The ONNX voices file bundles every pack, so there are
  no per-voice ``.pt`` files to manage.
- Narration is English-only. One misaki English G2P is created per accent and
  cached; a single ONNX session is shared by both (the weights load only once).

Model acquisition (see docs/model-download-china.md):
- The two model files (``kokoro-v1.0.onnx`` ~325 MB + ``voices-v1.0.bin`` ~27 MB)
  are consent-gated and downloaded on demand by server.py; this wrapper only ever
  loads them from ``local_dir``. There is no online-download fallback in the
  resident service — a missing file raises so the server reports "needs_download".

threads: onnxruntime is pinned to a modest intra-op thread count. On hybrid
P/E-core laptops, letting it grab every logical core causes oversubscription and
makes synthesis look several times slower.
"""

# Third-party code in this file:
#
# split_phonemes() and the session inputs in KokoroTTS._synthesize_chunk() are
# adapted from kokoro-onnx 0.5.0 (kokoro_onnx/__init__.py,
# https://github.com/thewh1teagle/kokoro-onnx). The phoneme vocabulary in
# kokoro_vocab.json is copied from its kokoro_onnx/config.json:
#
#   MIT License
#
#   Copyright (c) 2025 github.com/thewh1teagle
#
#   Permission is hereby granted, free of charge, to any person obtaining a copy
#   of this software and associated documentation files (the "Software"), to deal
#   in the Software without restriction, including without limitation the rights
#   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
#   copies of the Software, and to permit persons to whom the Software is
#   furnished to do so, subject to the following conditions:
#
#   The above copyright notice and this permission notice shall be included in all
#   copies or substantial portions of the Software.
#
#   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
#   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
#   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
#   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
#   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
#   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
#   SOFTWARE.
#
# trim_silence() is adapted from librosa's effects.trim(), feature.rms(),
# util.frame() and core.power_to_db(), by way of kokoro-onnx 0.5.0's
# kokoro_onnx/trim.py (https://github.com/librosa/librosa):
#
#   Copyright (c) 2013--2023, librosa development team.
#
#   Permission to use, copy, modify, and/or distribute this software for any
#   purpose with or without fee is hereby granted, provided that the above
#   copyright notice and this permission notice appear in all copies.
#
#   THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
#   REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
#   AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
#   OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF
#   USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
#   TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE
#   OF THIS SOFTWARE.

from __future__ import annotations

import json
import os
import re
import threading
from pathlib import Path
from typing import Any

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view

# Phoneme -> token id table of Kokoro-82M (see the attribution inside the file).
VOCAB: dict[str, int] = json.loads(
    Path(__file__).with_name("kokoro_vocab.json").read_text(encoding="utf-8")
)["vocab"]

# Kokoro's native sample rate.
SAMPLE_RATE = 24000

# The two ONNX model files shipped by the kokoro-onnx project (model-files-v1.0).
_ONNX_MODEL_FILENAME = "kokoro-v1.0.onnx"
_ONNX_VOICES_FILENAME = "voices-v1.0.bin"

# The model's context is 512 tokens, two of which are the start/end pad token 0.
MAX_PHONEME_LENGTH = 510

os.environ.setdefault("PYTHONUTF8", "1")

# Kokoro single-letter lang_code -> (misaki backend, british flag). Narration is
# English-only; anything else falls back to American English. api/tts.py rejects
# Chinese (z) and Japanese (j) before they reach here.
_LANG_TO_MISAKI = {
    "a": ("en", False),  # American English
    "b": ("en", True),   # British English
}


def tokenize(phonemes: str) -> list[int]:
    """Phoneme string -> Kokoro token ids. Characters outside the vocab are dropped."""
    return [VOCAB[p] for p in phonemes if p in VOCAB]


def split_phonemes(phonemes: str) -> list[str]:
    """Split a phoneme string into chunks shorter than ``MAX_PHONEME_LENGTH``,
    breaking at punctuation where possible (same chunking kokoro-onnx 0.5 used)."""
    chunks: list[str] = []
    current = ""
    for part in re.split(r"([.,!?;])", phonemes):
        part = part.strip()
        if not part:
            continue
        if len(current) + len(part) + 1 >= MAX_PHONEME_LENGTH:
            chunks.append(current.strip())
            current = part
        elif part in ".,!?;":
            current += part
        elif current:
            current += " " + part
        else:
            current = part
    if current:
        chunks.append(current.strip())
    return chunks


def trim_silence(
    audio: np.ndarray,
    top_db: float = 60.0,
    frame_length: int = 2048,
    hop_length: int = 512,
) -> np.ndarray:
    """Drop leading and trailing audio more than ``top_db`` below the loudest frame.

    Same result as ``librosa.effects.trim`` with its defaults (centered RMS frames,
    reference = the loudest frame), which kokoro-onnx applied to every chunk.
    """
    padded = np.pad(audio, frame_length // 2)
    frames = sliding_window_view(padded, frame_length)[::hop_length]
    rms = np.sqrt(np.mean(np.square(frames, dtype=np.float32), axis=-1))
    power = np.square(rms)
    ref = np.max(rms) ** 2
    db = 10.0 * np.log10(np.maximum(1e-10, power)) - 10.0 * np.log10(np.maximum(1e-10, ref))
    loud = np.flatnonzero(db > -top_db)
    if loud.size == 0:
        return audio[:0]
    start = int(loud[0]) * hop_length
    end = min(audio.shape[-1], (int(loud[-1]) + 1) * hop_length)
    return audio[start:end]


class KokoroTTS:
    """Resident Kokoro-82M pipeline holder (onnxruntime + misaki G2P)."""

    def __init__(
        self,
        repo_id: str = "hexgrad/Kokoro-82M",
        threads: int = 6,
        local_dir: str | None = None,
    ) -> None:
        self.repo_id = repo_id
        self.threads = int(threads) if threads else 0
        self.local_dir = Path(local_dir).expanduser() if local_dir else None
        self._g2ps: dict[str, Any] = {}
        self._session: Any = None
        self._input_ids = False
        self._voices: Any = None
        self._lock = threading.Lock()

    @classmethod
    def from_pretrained(
        cls,
        repo_id: str = "hexgrad/Kokoro-82M",
        threads: int = 6,
        local_dir: str | None = None,
        hf_endpoint: str | None = None,
        **_: Any,
    ) -> "KokoroTTS":
        # hf_endpoint is accepted for signature compatibility with the old torch
        # helper but unused: the ONNX model is loaded only from local files.
        model = cls(repo_id=repo_id, threads=threads, local_dir=local_dir)
        model._build_session()
        # Warm the default English G2P so the first request is fast and any init
        # failure surfaces during the server's loading phase.
        model._get_g2p("a")
        return model

    def _local_files(self) -> tuple[Path, Path] | None:
        """Return (model.onnx, voices.bin) if a complete local_dir was given."""
        if self.local_dir is None:
            return None
        model = self.local_dir / _ONNX_MODEL_FILENAME
        voices = self.local_dir / _ONNX_VOICES_FILENAME
        if model.is_file() and voices.is_file():
            return model, voices
        return None

    def _build_session(self) -> None:
        import onnxruntime

        local = self._local_files()
        if local is None:
            # No complete local model. The resident service consent-gates the
            # download (POST /tts/download), so this must NOT reach the network —
            # fail loudly so the server reports "needs_download" and the UI shows
            # the consent dialog.
            where = self.local_dir if self.local_dir is not None else "(no local_dir)"
            raise RuntimeError(
                f"Kokoro ONNX model not present in {where} "
                f"(need {_ONNX_MODEL_FILENAME} + {_ONNX_VOICES_FILENAME}); "
                f"download must be consented first."
            )
        model_path, voices_path = local
        # Pin onnxruntime threads to avoid P/E-core oversubscription.
        so = onnxruntime.SessionOptions()
        if self.threads > 0:
            so.intra_op_num_threads = self.threads
            so.inter_op_num_threads = 1
        sess = onnxruntime.InferenceSession(
            str(model_path),
            sess_options=so,
            providers=["CPUExecutionProvider"],
        )
        # Newer exports name the token input `input_ids` and take an int32 speed.
        self._input_ids = "input_ids" in {i.name for i in sess.get_inputs()}
        self._session = sess
        # One (510, 1, 256) style array per voice pack, read lazily per voice.
        self._voices = np.load(str(voices_path))

    def _synthesize_chunk(self, phonemes: str, style: np.ndarray, speed: float) -> np.ndarray:
        tokens = tokenize(phonemes[:MAX_PHONEME_LENGTH])
        # The voice pack holds one style vector per token count.
        voice = style[len(tokens)]
        padded = np.array([[0, *tokens, 0]], dtype=np.int64)
        if self._input_ids:
            inputs = {
                "input_ids": padded,
                "style": np.asarray(voice, dtype=np.float32),
                "speed": np.array([speed], dtype=np.int32),
            }
        else:
            inputs = {
                "tokens": padded,
                "style": voice,
                "speed": np.array([speed], dtype=np.float32),
            }
        return self._session.run(None, inputs)[0]

    def _get_g2p(self, lang_code: str):
        lang_code = (lang_code or "a").strip()[:1] or "a"
        _, british = _LANG_TO_MISAKI.get(lang_code, ("en", False))
        key = "b" if british else "a"
        with self._lock:
            g2p = self._g2ps.get(key)
            if g2p is not None:
                return g2p
            from misaki import en
            # trf=False uses the small en_core_web_sm spaCy model rather than
            # the transformer POS tagger, keeping torch out of the env.
            g2p = en.G2P(trf=False, british=british)
            self._g2ps[key] = g2p
            return g2p

    def _phonemize(self, text: str, lang_code: str) -> str:
        """Grapheme -> phoneme via misaki."""
        g2p = self._get_g2p(lang_code)
        result = g2p(text)
        # misaki en.G2P returns (phonemes, tokens). Normalize to a string.
        if isinstance(result, tuple):
            result = result[0]
        return str(result or "")

    def generate(
        self,
        text: str,
        voice: str,
        lang_code: str,
        speed: float = 1.0,
    ) -> tuple[list[np.ndarray], int]:
        """Synthesize ``text`` with a Kokoro voice pack.

        Returns ``(wavs, sample_rate)`` where ``wavs`` is a list with a single
        float32 waveform (mono), matching the shape the server expects.
        """
        try:
            speed = float(speed)
        except (TypeError, ValueError):
            speed = 1.0
        if speed <= 0:
            speed = 1.0

        phonemes = self._phonemize(text, lang_code)
        if not phonemes.strip():
            return [], SAMPLE_RATE

        if not 0.5 <= speed <= 2.0:
            raise ValueError(f"speed must be between 0.5 and 2.0, got {speed}")
        if voice not in self._voices:
            raise ValueError(f"voice {voice!r} not found in {_ONNX_VOICES_FILENAME}")
        style = self._voices[voice]

        # The server serializes calls under its own INFERENCE_LOCK, so the single
        # session is never run concurrently.
        parts = [
            trim_silence(self._synthesize_chunk(chunk, style, speed))
            for chunk in split_phonemes(phonemes)
        ]
        audio = np.concatenate(parts).astype(np.float32, copy=False)
        if audio.size == 0:
            return [], SAMPLE_RATE
        return [audio], SAMPLE_RATE
