"""Encoder-frame pipelining ("ENC") for the bundled Parakeet TDT int8 export.

Ported from the DictationApp repo (``src/asr/enc_pipeline.py``). This file is the
OFFLINE arm: ``/transcribe`` is a stateless "audio in, text out" POST and calls
``transcribe_offline``.

The streaming arm -- ``EncStream`` (the live, window-by-window session) and its
incremental decoder ``ResumableTdt`` -- was dropped by the original port and has been
brought back, in ``enc_stream.py`` rather than here (that module's docstring says
why, and what still has to land before anything can feed it). ``resumable_decoder``
below is the factory the two arms share. Of the window-accounting helpers only
``pending_window_work`` came with it; ``worst_pending_window_work`` served upstream's
adaptive-latency UI, which this service has no equivalent of.

What remains is byte-for-byte the source file: every constant, every docstring and
every line of arithmetic on this path is unchanged, because the measurements quoted
below were taken against exactly this code and a "tidied" copy would be a claim
about a different implementation. Three things worth knowing before you touch it:

  * The mel front-end constants (``SR``/``N_FFT``/``WIN``/``HOP``/``N_MEL``,
    ``PREEMPH``, ``LOG_GUARD``) MUST match the NeMo preprocessor the bundled
    encoder was exported with. They are not style.
  * Numbers below that were measured on the *streaming* path no longer describe any
    code in this file; each one now says so. The latency figures for what this
    service does -- one POST, encoded and decoded after the whole utterance has
    arrived -- are in ``host/asr_manager/README.md``, measured end to end through
    ServiceHub.
  * The streaming arm's correctness rests on parity claims stated *between* the two
    arms, so both arms are now in this repo -- this module and ``enc_stream.py`` --
    and ``tests/test_enc_pipeline_parity.py`` compares them in CI. ``decode_tdt``
    below and
    ``ResumableTdt.push`` are line-for-line the same loop on purpose: edit one and
    you must edit both, or that equality silently becomes a claim about two
    different implementations. The real-weights half of the check is upstream's
    ``tools/enc_preset_selftest.py`` and still needs the 630 MB export.

Why this exists
---------------
Every other chunking preset in this app cuts the **audio** and transcribes each
piece independently ("TXT" family): one decode per chunk, prediction state reset
at every boundary, and the pieces joined as strings. That buys latency but it
damages sentence structure, because a chunk decoded on its own does not know it
is mid-sentence and treats its own end as a sentence end.

ENC cuts the **encoder frame sequence** instead:

  * each window is encoded with ``ctx`` seconds of real audio on both sides and
    the edge frames are discarded, so every *kept* encoder frame is the frame the
    whole-clip encoder would have produced,
  * the kept frames are decoded **once**, in a single continuous TDT greedy pass
    whose LSTM prediction state is never reset. One pass over the concatenation,
    NOT one decode per chunk — which is the whole point, and why the punctuation
    numbers below separate ENC from the TXT family.

  (Upstream additionally overlapped both halves with live recording, so the encode
  hid behind capture and the decode was pipelined frame-by-frame. That is the part
  this copy does not have: here the audio is already complete when
  ``transcribe_offline`` is called, so both halves are paid after it arrives.)

Measured on the 10 longest Earnings-22 utterances (30.3-36.4 s, 682 reference
words; HP EliteBook 8 G1i, Core Ultra 7 265U / 31 GB — NOT the 64 GB PTL box, so
the seconds are not comparable with older reports in this repo):

    system                WER     period F1   invented periods   post-stop
    whole (no chunking)   5.33%      74.1              1           4.01 s
    ENC 10 s +/-2.56 s    5.78%      66.7              2           0.57 s
    TXT VAD 7-9 s         7.15%      42.6             14           1.02 s

WER cannot separate the two families at that sample size (the CI95 intervals
overlap heavily), but the punctuation axis separates them by 24 points, and 22 of
24 invented periods sit exactly on a chunk seam. Hence ENC 10 s +/-2.56 s is the
shipped default (config._DEFAULT_CHUNKING).

What the wait actually is, here
------------------------------
Upstream this section decomposed a *post-stop* wait: with capture overlapping the
encode, what remained after the user stopped was one or two undrained windows, and
the bound was independent of recording length. **None of that applies to this
copy.** ``transcribe_offline`` is handed a complete utterance, so every window and
the single decode pass are paid after the audio arrives, and the total is LINEAR in
utterance length — 0.195 s at 3.3 s of audio up to 6.845 s at 120 s, measured end to
end through ServiceHub (the table is in ``host/asr_manager/README.md``).

The part that survives unchanged, because it was never a streaming property: the
decode walks every kept frame, so its cost grows with total length (+0.20-0.30 s per
minute, measured on a 19-minute meeting). On that recording the decode was 59% of
the wait and the encode 38%, which is why the window length is a weaker lever here
than the raw audio length.

Do not restate a bound in seconds from this docstring. The numbers that describe
*this* code are the README's, measured on the shipped POST path; the ones removed
with ``EncStream`` described a capture loop that no longer exists.

WHY LEFT AND RIGHT CONTEXT ARE NOT THE SAME COST
------------------------------------------------
Upstream the two sides cost differently *in latency*: the right context hid behind
live recording and was free for every window capture had already drained, while the
left context was paid after the stop, in the tail the user waits through. **Offline
that distinction is gone** — there is no capture to hide anything behind, so every
window pays both sides. What is left is the compute term, which was never a
streaming property:

    compute per kept second  = (win_s + ctx_l + ctx_r) / win_s   (felt as heat,
                                battery, and headroom on a slow machine)

The asymmetric shape L0.64/R2.56 therefore still earns its place here, but on two
of its three original grounds rather than three: it cuts the compute (1.32x vs
1.51x against the symmetric +/-2.56 at the same 10 s window) and it measured one
error fewer on the 26-clip set (56 vs 58). The third ground — that it also cut the
post-stop feed — was a latency argument about the capture loop and does not
transfer. Symmetry was never motivated by a measurement; it was the obvious first
shape to try. ``ctx_s`` alone was swept, so "how much context" has evidence behind
it while "the same on both sides" was an inherited assumption — the sweep that
separated them is what these two presets come from.

One more result from the 107.85 s preset run (tools/enc_preset_selftest.py), and NOT
something the 30-36 s study could show: at 108 s the whole-clip transcript is visibly
WORSE than ENC's ("cafes, hotels and libraries" -> "UK's hotels and libraries",
"QR code card" -> "Q"). Long-form accuracy is a separate axis from the
chunking-penalty one; n=1, so treat it as a lead, not a result.

Caveats carried over from the study, worth knowing before tuning this:
  * ENC emits **no partial text** — here that is not even a choice, since the whole
    utterance is already complete before decoding starts. Upstream it was a
    deliberate omission: with the decode pipelined, 99% of the words existed before
    the user stopped (measured 2203/2220 on the 19-minute meeting) and nothing
    exposed them, because a partial that may still be revised is a UI contract and
    *committing* a prefix is the thing that costs accuracy.
  * The mel front end here is a numpy reimplementation of NeMo's
    FilterbankFeatures. It is close to, but not bit-identical with, the
    kaldi-native-fbank front end sherpa-onnx uses, so ENC output can differ
    slightly from the TXT presets on the same audio (~0.2 WER pt in the study).
  * Normalisation matters on the WER axis: "running" (causal, statistics over all
    audio so far) is the default; "per-window" is offered because on a separate
    2x2 it was not uniformly worse. Global statistics would be a non-causal
    oracle, so they are deliberately not offered.

Provenance: ported from ``repo/test/parakeet-enc-pipeline-poc`` (``poc.py`` /
``bench_encchunk.py``); see that folder's HANDOFF-punctuation-metric.md and
parakeet-encoder-pipelining-findings.html for the full study.
"""
from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Iterable, Optional

import numpy as np

if TYPE_CHECKING:
    # Both only for annotating ``resumable_decoder``'s return. Importing either at
    # runtime would be a cycle: ``enc_stream`` depends on this module, and
    # ``tdt_beam`` does too.
    from .enc_stream import ResumableTdt
    from .tdt_beam import ResumableTdtBeam

# -- front-end constants: these MUST match the NeMo preprocessor the bundled ---
# encoder was exported with. Do not "tidy" them.
SR = 16000
N_FFT, WIN, HOP, N_MEL = 512, 400, 160, 128
PREEMPH = 0.97
LOG_GUARD = 2.0 ** -24
BLANK = 1024                     # TDT blank id == vocab size
DURATIONS = (0, 1, 2, 3, 4)      # TDT duration head classes, in encoder frames
SUB = 8                          # encoder subsampling factor (mel frames -> enc)
NUM_THREADS = 4                  # matches the sherpa-onnx engine's setting


# ---------------------------------------------------------------- features ---
def _mel_fb() -> np.ndarray:
    """librosa.filters.mel(sr=16000, n_fft=512, n_mels=128, htk=False,
    norm='slaney') reimplemented — NeMo's preprocessor uses exactly this."""
    f_sp, min_log_hz = 200.0 / 3.0, 1000.0
    min_log_mel = min_log_hz / f_sp
    logstep = np.log(6.4) / 27.0

    def hz2mel(f):
        f = np.asarray(f, dtype=np.float64)
        return np.where(f < min_log_hz, f / f_sp,
                        min_log_mel + np.log(np.maximum(f, 1e-9) / min_log_hz) / logstep)

    def mel2hz(m):
        m = np.asarray(m, dtype=np.float64)
        return np.where(m < min_log_mel, f_sp * m,
                        min_log_hz * np.exp(logstep * (m - min_log_mel)))

    mel_f = mel2hz(np.linspace(hz2mel(0.0), hz2mel(SR / 2), N_MEL + 2))
    fft_f = np.fft.rfftfreq(N_FFT, 1.0 / SR)
    fb = np.zeros((N_MEL, len(fft_f)))
    for i in range(N_MEL):
        lo, ctr, hi = mel_f[i], mel_f[i + 1], mel_f[i + 2]
        if ctr > lo:
            up = (fft_f - lo) / (ctr - lo)
            fb[i] = np.maximum(0.0, np.minimum(up, (hi - fft_f) / (hi - ctr)))
    fb *= (2.0 / (mel_f[2:N_MEL + 2] - mel_f[:N_MEL]))[:, None]   # slaney norm
    return fb.astype(np.float32)


_FB = _mel_fb()
_WINDOW = np.hanning(WIN + 1)[:WIN].astype(np.float32)   # torch.hann_window(periodic)


def logmel(wav: np.ndarray) -> np.ndarray:
    """Un-normalised log-mel [128, T] matching NeMo FilterbankFeatures."""
    x = np.asarray(wav, dtype=np.float32).flatten()
    if len(x) < N_FFT:
        x = np.pad(x, (0, N_FFT - len(x)))
    x = np.concatenate([x[:1], x[1:] - PREEMPH * x[:-1]])          # preemphasis
    pad = N_FFT // 2
    x = np.pad(x, (pad, pad), mode="reflect")                      # center=True
    n = 1 + (len(x) - N_FFT) // HOP
    frames = np.lib.stride_tricks.sliding_window_view(x, N_FFT)[::HOP][:n]
    frames = frames.copy()
    frames[:, :WIN] *= _WINDOW                                     # win_length 400
    frames[:, WIN:] = 0.0
    spec = np.abs(np.fft.rfft(frames, N_FFT, axis=1)).astype(np.float32) ** 2
    return np.log(spec @ _FB.T + LOG_GUARD).T.astype(np.float32)


def norm_stats(mel: np.ndarray):
    """Per-feature mean/std over a whole array (used for one window, or a clip)."""
    return mel.mean(1, keepdims=True), mel.std(1, keepdims=True)


def running_stats(mel: np.ndarray, hi: int):
    """Per-feature mean/std over mel[:, :hi] — causal: all audio heard so far.

    This is what "running" normalisation means: a window is normalised with the
    statistics of everything up to its own right edge, which a live stream can
    actually compute (unlike whole-clip statistics, which need the future)."""
    s = mel[:, :max(1, hi)]
    return s.mean(1, keepdims=True), s.std(1, keepdims=True)


def apply_norm(mel, mean, std) -> np.ndarray:
    return ((mel - mean) / (std + 1e-5)).astype(np.float32)


# ----------------------------------------------------------------- windows ---
def plan(n_mel_frames: int, win_f: int, ctx_f: int, ctx_r_f: Optional[int] = None):
    """Yield (mel_lo, mel_hi, drop_left_enc, keep_enc, is_final) per window.

    Centres tile [0, n) in win_f steps; both centre length and ctx are multiples
    of SUB so every kept encoder frame maps 1:1 onto a whole-clip encoder frame.

    ``ctx_f`` is the LEFT context; ``ctx_r_f`` the right one, defaulting to
    ``ctx_f`` — that default IS the symmetric ±ctx family. Keeping them separate
    matters because they are paid at different moments, not just in different
    amounts (see "WHY LEFT AND RIGHT CONTEXT ARE NOT THE SAME COST" in the module
    docstring). The SUB-alignment invariant is unaffected: ``drop`` needs
    ``s - lo`` to be a multiple of SUB, and that depends on the LEFT context only,
    which ``frames_for`` has already snapped.
    """
    out = []
    if ctx_r_f is None:
        ctx_r_f = ctx_f
    starts = list(range(0, n_mel_frames, win_f))
    for i, s in enumerate(starts):
        e = min(s + win_f, n_mel_frames)
        lo = max(0, s - ctx_f)
        hi = min(n_mel_frames, e + ctx_r_f)
        # trim to a multiple of SUB so encoder length == (hi-lo)//SUB exactly
        span = ((hi - lo) // SUB) * SUB
        hi = lo + span
        if hi <= s:
            continue
        drop = (s - lo) // SUB
        keep = max(0, min((e - s) // SUB, span // SUB - drop))
        out.append((lo, hi, drop, keep, i == len(starts) - 1))
    return out


def frames_for(seconds: float) -> int:
    """Seconds -> mel frames, snapped DOWN to a multiple of SUB (see plan())."""
    return int(round(seconds * 100)) // SUB * SUB


# ------------------------------------------------------------------ runtime ---
class OrtParakeet:
    """The bundled encoder/decoder/joiner ONNX trio driven directly through ONNX
    Runtime, so the caller gets the encoder frames the black-box recogniser hides.

    Construction reads every weight file, so the plaintext of the external
    edition's encrypted assets can be removed as soon as __init__ returns (same
    contract sherpa-onnx's recogniser has).
    """

    def __init__(self, model_dir: Path, files: tuple, num_threads: int = NUM_THREADS):
        import onnxruntime as ort

        enc_f, dec_f, joi_f, tok_f = (Path(model_dir) / f for f in files)

        def sess(path: Path):
            o = ort.SessionOptions()
            o.intra_op_num_threads = num_threads
            o.inter_op_num_threads = 1
            o.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
            return ort.InferenceSession(str(path), o,
                                        providers=["CPUExecutionProvider"])

        self.enc = sess(enc_f)
        self.dec = sess(dec_f)
        self.joi = sess(joi_f)
        self.tokens = self._load_tokens(tok_f)
        # The decoder's two LSTM state inputs are named by the exporter
        # ("states.1" / "onnx::Slice_3" in the int8 export). Discover them from
        # the graph rather than hard-coding: the external build renames every
        # non-interface symbol, and a future re-export could rename these too.
        names = [i.name for i in self.dec.get_inputs()]
        self._state_names = [n for n in names
                             if n not in ("targets", "target_length")]
        if len(self._state_names) != 2:
            raise RuntimeError(
                f"unexpected decoder inputs {names!r}: need targets, "
                "target_length and exactly two state tensors")
        # The joiner takes the encoder frame and the prediction-network output.
        self._joi_names = [i.name for i in self.joi.get_inputs()]

    @staticmethod
    def _load_tokens(path: Path) -> list:
        toks = {}
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                parts = line.rstrip("\n").rsplit(" ", 1)
                if len(parts) == 2:
                    toks[int(parts[1])] = parts[0]
        return [toks.get(i, "") for i in range(max(toks) + 1)] if toks else []

    # -- encoder ------------------------------------------------------------
    def encode(self, mel_norm: np.ndarray) -> np.ndarray:
        """[128, T] normalised log-mel -> [1024, T//8] encoder frames."""
        x = np.ascontiguousarray(mel_norm[None], dtype=np.float32)
        ln = np.array([mel_norm.shape[1]], dtype=np.int64)
        out, _ = self.enc.run(None, {"audio_signal": x, "length": ln})
        return out[0]

    # -- decoder / joiner ---------------------------------------------------
    def _zero_state(self):
        z = np.zeros((2, 1, 640), dtype=np.float32)
        return z, z.copy()

    def _pred(self, label: int, state):
        h, c = state
        feeds = {"targets": np.array([[label]], dtype=np.int32),
                 "target_length": np.array([1], dtype=np.int32),
                 self._state_names[0]: h, self._state_names[1]: c}
        out = self.dec.run(None, feeds)
        g = out[0][:, :, :1]                       # [1, 640, 1]
        return g, (out[2], out[3])

    def decode_tdt(self, enc: np.ndarray, max_sym: int = 10) -> str:
        """TDT greedy over the WHOLE encoder sequence in one continuous pass.

        The prediction state is never reset, which is the property the TXT family
        cannot have (it decodes each audio chunk from a fresh state) and the
        reason ENC does not invent a sentence end at every seam.
        """
        T = enc.shape[1]
        if T == 0:
            return ""
        state = self._zero_state()
        g, state_next = self._pred(BLANK, state)   # SOS = blank -> zero embedding
        hyp: list = []
        t = sym = 0
        while t < T:
            f = np.ascontiguousarray(enc[None, :, t:t + 1])       # [1, 1024, 1]
            logits = self.joi.run(None, {self._joi_names[0]: f,
                                         self._joi_names[1]: g})[0][0, 0, 0]
            k = int(np.argmax(logits[:BLANK + 1]))
            d = DURATIONS[int(np.argmax(logits[BLANK + 1:]))]
            if k != BLANK:
                hyp.append(k)
                state = state_next
                g, state_next = self._pred(k, state)
                sym += 1
            else:
                sym = 0
            if d > 0:
                t += d
                sym = 0
            elif k == BLANK or sym >= max_sym:
                t += 1
                sym = 0
        return self._detokenize(hyp)

    def _detokenize(self, hyp: list) -> str:
        return "".join(self.tokens[i] for i in hyp).replace("▁", " ").strip()

    def resumable_decoder(
        self, max_sym: int = 10, *, mode: str = "greedy",
        dictionary_words: Iterable[str] = (),
    ) -> ResumableTdt | ResumableTdtBeam:
        """Create one incremental decoder without touching the ONNX sessions.

        ``greedy`` is the :class:`enc_stream.ResumableTdt` path exactly. ``beam``
        selects the Dictionary-aware decoder only when words exist; an enabled
        but empty Dictionary therefore has zero beam overhead.

        A UNION, not a Protocol, and the difference is load-bearing: both arms have
        ``push`` and ``text``, but only ``ResumableTdtBeam`` has ``finish``. That is
        why ``EncStream.finish`` reaches for it with ``getattr(self._dec, "finish",
        None)`` and falls back to ``.text``. A Protocol declaring ``finish`` would
        typecheck a call that raises on the greedy path.

        Imported late for the same reason ``_decode_frames`` imports ``tdt_beam``
        late: ``enc_stream`` depends on this module, so a top-level runtime import
        here would be a cycle (see the ``TYPE_CHECKING`` block above).
        """
        words = tuple(dictionary_words)
        if mode == "beam" and words:
            from .tdt_beam import ResumableTdtBeam
            return ResumableTdtBeam(self, words, max_symbols_per_frame=max_sym)
        from .enc_stream import ResumableTdt
        return ResumableTdt(self, max_sym)


# --------------------------------------------------------------- offline run ---
def _decode_frames(runner: OrtParakeet, enc: np.ndarray,
                   decode_mode: str = "greedy", dictionary_words=()) -> str:
    words = tuple(dictionary_words)
    if decode_mode == "beam" and words:
        from .tdt_beam import decode_tdt_beam
        return decode_tdt_beam(runner, enc, words)
    return runner.decode_tdt(enc)


def transcribe_offline(runner: OrtParakeet, audio: np.ndarray, sample_rate: int,
                       win_s: float, ctx_s: float, norm: str = "running",
                       ctx_r_s: Optional[float] = None,
                       decode_mode: str = "greedy",
                       dictionary_words=()) -> str:
    """Whole-buffer ENC: window the mel, encode each window, ONE decode.

    The only entry point this service has: ``/transcribe`` hands over a complete
    utterance and gets text back. Upstream this was the offline arm of a pair and
    was documented as producing the same text as the live streaming arm for the
    same audio, verified by that repo's parity tests; the streaming arm is not in
    this copy, so the claim is now about upstream rather than about anything here.
    """
    audio = np.asarray(audio, dtype=np.float32).flatten()
    if sample_rate != SR:
        audio = _resample(audio, sample_rate)
    if len(audio) == 0:
        return ""
    mel = logmel(audio)
    win_f, ctx_f = frames_for(win_s), frames_for(ctx_s)
    ctx_r_f = ctx_f if ctx_r_s is None else frames_for(ctx_r_s)
    if win_f <= 0:                                    # "whole clip" degenerate
        return _decode_frames(
            runner, runner.encode(apply_norm(mel, *norm_stats(mel))),
            decode_mode, dictionary_words)
    frames = []
    for lo, hi, drop, keep, _final in plan(mel.shape[1], win_f, ctx_f, ctx_r_f):
        sl = mel[:, lo:hi]
        stats = norm_stats(sl) if norm == "window" else running_stats(mel, hi)
        e = runner.encode(apply_norm(sl, *stats))
        frames.append(e[:, drop:drop + keep] if keep else e[:, drop:])
    if not frames:
        return ""
    return _decode_frames(
        runner, np.concatenate(frames, axis=1),
        decode_mode, dictionary_words)


def _resample(audio: np.ndarray, sr: int) -> np.ndarray:
    """To 16 kHz. soxr when available (what the study used), else linear."""
    if sr == SR:
        return audio
    try:
        import soxr
        return soxr.resample(audio, sr, SR, quality="soxr_hq").astype(np.float32)
    except Exception:
        n = int(round(len(audio) * SR / float(sr)))
        if n <= 0:
            return np.zeros(0, dtype=np.float32)
        x = np.linspace(0.0, len(audio) - 1, n)
        return np.interp(x, np.arange(len(audio)), audio).astype(np.float32)
