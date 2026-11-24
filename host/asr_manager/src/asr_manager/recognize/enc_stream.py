"""The streaming arm of the ENC pipeline: encode (and decode) DURING recording.

Ported back from the DictationApp repo (``src/asr/enc_pipeline.py``), which is where
both arms still live together. The original SuperClaw port deliberately dropped this
half -- 469 lines, taking that file from 965 to 436 -- because ``/transcribe`` is a
stateless "audio in, text out" POST and nothing reached it. Its parity claims were
left pointing at upstream, which this repo could not verify. That is what this module
and ``tests/test_enc_pipeline_parity.py`` fix.

WHY A SEPARATE MODULE, when upstream has one file. Two reasons, neither cosmetic:
``enc_pipeline.py`` is byte-for-byte upstream's on every line of arithmetic (its own
docstring demands that, because the measurements quoted there were taken against
exactly that code), and the combined file would be ~900 lines against this repo's
800-line cap. The import direction is enc_stream -> enc_pipeline, matching the way
``tdt_beam`` already depends on it, so there is no cycle.

NOTHING CALLS THIS YET, AND THAT IS NOT AN OVERSIGHT. Encoding during recording needs
the audio to ARRIVE during recording, and today the UI captures PCM in the browser
process and ships one base64 POST after the user stops (``apps/ui/src/features/
voice-input/pcm-capture.ts``, buffered to ``MAX_AUDIO_SECONDS``). Feeding this class
needs an incremental wire surface -- a session id plus chunked uploads -- and the
frozen stage-0 transcribe contract (§2, §10) registers no such endpoint and forbids
inventing one. So this module is the engine half, landed and verified first, exactly
as the boundary rule asks: contract tests before the contract change.

What it buys once it IS wired, measured upstream on a 19.13-minute meeting at
``enc_w10_c2p56_run``: post-stop 1.30 s, of which the final window's encode is 81%,
against this repo's measured 6.845 s for 120 s of audio -- which is LINEAR in length
(see "Post-stop latency is LINEAR in utterance length" in ``host/asr_manager/
README.md``). The streaming wait is essentially flat instead, because every window
except the one or two the stop position leaves pending was already encoded and
decoded while the user was still talking. One or two, not "all but the last" -- that
bound is set by ``pending_window_work``, not by the recording length, and the
difference is the whole subject of the note in ``EncStream``'s docstring.

Provenance of every number in this file: it was measured UPSTREAM, on upstream's
capture loop, not here. Nothing in this repo has a capture loop to hide the encode
behind yet. Re-measure before quoting any of it as a SuperClaw figure.
"""
from __future__ import annotations

import threading
from typing import Optional

import numpy as np

from .enc_pipeline import (
    BLANK,
    DURATIONS,
    HOP,
    SR,
    SUB,
    OrtParakeet,
    _decode_frames,
    apply_norm,
    frames_for,
    logmel,
    norm_stats,
    plan,
    running_stats,
    transcribe_offline,
)

# Mel frames whose values still depend on the reflect-padding at the end of the
# audio captured SO FAR. While streaming we must not encode (or take running
# statistics) over frames that the final, complete mel would compute differently.
# N_FFT//2 = 256 samples of padding = 1.6 hops, so 8 frames is a wide margin.
_EDGE_MARGIN = 8

# Frames dropped from the FRONT of an incremental mel slice (see
# EncStream._extend_mel). Frame j of a slice reads slice samples starting at
# j*HOP - N_FFT//2, so j >= 2 already excludes both the slice's own reflected head
# and slice sample 0, the one sample preemphasis gets wrong without its predecessor.
# 4 is the same kind of margin _EDGE_MARGIN is.
_SLICE_LEAD = 4

# Decode each window while the user is still speaking (see ResumableTdt) instead of
# decoding the whole frame sequence at stop. ON upstream since 2026-09-16, for every
# preset and every build: the text is byte-identical either way, so this is a latency
# change only. Kept as a switch because it is the one knob that decides WHERE the
# decode CPU is spent, which is what a probe or a bug report may need to flip:
# EncStream(..., pipeline=False) restores the unpipelined behaviour exactly.
PIPELINE_DECODE = True


def pending_window_work(dur_s: float, win_s: float, ctx_left_s: float,
                        ctx_right_s: float) -> tuple[int, float, tuple[float, ...]]:
    """Exact ENC work still pending if capture stops at ``dur_s``.

    Returns ``(window_count, total_feed_seconds, feeds_per_window)``. The
    arithmetic intentionally mirrors :meth:`EncStream._drain`: a non-final window
    is already complete only after its centre, right context and ``_EDGE_MARGIN``
    have arrived. ``finish()`` then re-plans against the final mel length and
    encodes every window that failed that gate.

    This helper exists so latency claims and the parity tests cannot quietly return
    to the old, incorrect "only the final window remains" approximation -- which
    every version of upstream's docstrings and release notes carried before it was
    retracted. A user who stops just after a window boundary leaves TWO windows,
    each paying its own context.
    """
    duration = max(0.0, float(dur_s))
    m_available = int(duration * SR) // HOP
    n_final = m_available + 1
    win_f = frames_for(win_s)
    ctx_left_f = frames_for(ctx_left_s)
    ctx_right_f = frames_for(ctx_right_s)
    if win_f <= 0 or n_final <= 0:
        return 0, 0.0, ()
    feeds = tuple(
        (hi - lo) / 100.0
        for index, (lo, hi, _drop, _keep, _final) in enumerate(
            plan(n_final, win_f, ctx_left_f, ctx_right_f)
        )
        if (index * win_f + win_f + ctx_right_f + _EDGE_MARGIN) > m_available
    )
    return len(feeds), float(sum(feeds)), feeds


class ResumableTdt:
    """``OrtParakeet.decode_tdt``, resumable: frames may arrive in pieces.

    This is NOT segmented decoding. The prediction state, the hypothesis and the
    frame cursor ``t`` carry straight through, so the joiner sees exactly the frames
    ``decode_tdt`` would see, in the same order, with the same prediction network
    output -- the arithmetic is identical and so is the text. What makes that
    possible is that the greedy loop is strictly causal: ``t`` only ever increases
    and each step reads exactly ``buf[:, t]`` plus state from earlier steps, so a
    frame can be consumed the moment it exists.

    Verified rather than assumed, upstream: byte equality against the one-shot decode
    over 44/44 cells in the POC harness, 2 presets x 3 rounds on a 19.13-minute
    meeting (2220/2221 words identical), and -- with real int8 weights, all 9 shipped
    ENC presets on a 107.85 s clip -- ``tools/enc_preset_selftest.py`` reported
    offline == streaming for 9/9. In THIS repo the equality is pinned by
    ``tests/test_enc_pipeline_parity.py`` against a fake runner, which covers the
    window plan and the normalisation statistics but NOT the int8 numerics; the
    real-weights half still needs the export and is not claimed here.

    That check is only meaningful because the loop below is a line-for-line copy of
    ``decode_tdt``'s -- if you edit one, edit both, or the equality silently becomes
    a claim about two different implementations.

    Buffer policy: consumed frames are dropped, so a push copies only the new
    window and the buffer stays bounded by one window (measured peak 125 frames).
    Keeping the whole sequence and re-concatenating on every push instead -- what
    the POC did -- is O(T^2): 1.3-4.6 s of pure memcpy over 19 minutes, which is a
    property of that buffer policy and not a cost of pipelining.

    Gotcha worth keeping: a TDT duration jump can put ``t`` PAST the frames that
    exist, so the absolute frame count ``n`` is tracked separately from ``_base``,
    the absolute index of ``_buf[:, 0]``. Deriving one from the other misplaces
    every later frame.
    """

    def __init__(self, runner: OrtParakeet, max_sym: int = 10) -> None:
        self._r = runner
        self._max_sym = max_sym
        self._state = runner._zero_state()
        # SOS = blank -> zero embedding, exactly as decode_tdt starts.
        self._g, self._state_next = runner._pred(BLANK, self._state)
        self._hyp: list = []
        self._buf: Optional[np.ndarray] = None   # frames [1024, n - base]
        self._base = 0        # absolute index of _buf[:, 0]
        self._sym = 0
        self.n = 0            # absolute number of frames pushed so far
        self.t = 0            # absolute frame the loop is at

    def push(self, enc: np.ndarray) -> None:
        """Append encoder frames and consume everything now decodable."""
        if enc.shape[1]:
            self._buf = (enc if self._buf is None
                         else np.concatenate([self._buf, enc], axis=1))
            self.n += enc.shape[1]
        if self._buf is None:
            return
        r, joi = self._r, self._r.joi
        while self.t < self.n:
            i = self.t - self._base
            f = np.ascontiguousarray(self._buf[None, :, i:i + 1])   # [1, 1024, 1]
            logits = joi.run(None, {r._joi_names[0]: f,
                                    r._joi_names[1]: self._g})[0][0, 0, 0]
            k = int(np.argmax(logits[:BLANK + 1]))
            d = DURATIONS[int(np.argmax(logits[BLANK + 1:]))]
            if k != BLANK:
                self._hyp.append(k)
                self._state = self._state_next
                self._g, self._state_next = r._pred(k, self._state)
                self._sym += 1
            else:
                self._sym = 0
            if d > 0:
                self.t += d
                self._sym = 0
            elif k == BLANK or self._sym >= self._max_sym:
                self.t += 1
                self._sym = 0
        keep_from = min(self.t, self.n) - self._base    # never re-read; see docstring
        if keep_from > 0:
            self._buf = np.ascontiguousarray(self._buf[:, keep_from:])
            self._base += keep_from

    @property
    def text(self) -> str:
        """The transcript of everything pushed so far. No commit happens, so a later
        push can still extend it -- it can never rewrite what is already here, which
        is what makes it safe to read at any time."""
        return self._r._detokenize(self._hyp)


class EncStream:
    """Live ENC session: encode AND decode each window during recording; at stop
    only one or two windows are left (encode them, finish the one decode pass, done).

    Usage (from whatever holds the session, once the wire surface exists):
        st = EncStream(runner, sample_rate, win_s, ctx_s, norm)
        st.feed(block)   # repeatedly, as chunks arrive
        text = st.finish()

    A window is encoded as soon as all the audio it needs has arrived -- that is
    ``win + ctx_right`` seconds past its own start. Note which context appears
    where: the right one only delays when a window can be encoded (free, it happens
    during recording), the left one is inside the tail the user waits through.

    NOT "only the final partial window is left". That claim was retracted upstream
    and ``pending_window_work`` exists to keep it retracted: the second-to-last
    window only drains once ``ctx_right`` + ``_EDGE_MARGIN`` past its end has
    arrived, so stopping just after a boundary leaves TWO windows, each paying its
    own context. Measured over every stop phase: for win 10 s / L0.64 / R2.56 the
    one-window case maxes at 10.64 s of feed (the old published bound) but the real
    worst case is 16.40 s -- 1.54x it.

    What the post-stop wait is, measured UPSTREAM and not here. On a 19.13-minute
    meeting at ``enc_w10_c2p56_run`` an earlier unpipelined version measured 5.92 s,
    split: ``decode_tdt`` over every kept frame 2.42 s (41%), encoding the final
    window 1.58 s (27%), building the mel 1.91 s (32%). Pipelining the decode
    (``ResumableTdt``, via ``_keep``) took the post-stop decode from 2.02 s over
    14349 frames to 0.019 s over 99 -- the final window only -- for 3.6 s of
    background decode across the 19 minutes (RTF 0.003), byte-identical text, and 99%
    of the words already available before the stop. Making the mel incremental
    (``_extend_mel``) took its post-stop term to 0.16-0.26 s. With both in, that
    recording waits **1.30 s**, of which the final window's encode is 81%.

    Two things those measurements do NOT cover, so do not claim them: whether the
    background decode slows the background encode (upper bound +14%, but the load
    spread between rounds was wider than the difference -- not distinguishable), and
    the abort path, where that background CPU is spent on a transcript nobody reads
    (a discarded recording used to pay no decode at all).

    The decode term is NOISE-DOMINATED on that hardware: identical input, identical
    2225-word output, measured anywhere from 2.06 s to 10.36 s across passes. Compare
    arms in one process, interleaved, and take the minimum; do not read a single pass
    as a result. And do not restate the bound as a formula in seconds -- re-run the
    probe on the shipped path instead.

    Agreement with ``transcribe_offline`` -- what is exact and what is not:

      * The window PLAN is exact. For every window that is not the last, ``plan()``
        computes ``hi = e + ctx_r_f`` independently of the total length, so encoding
        it early selects the identical mel range; the remaining windows are planned
        once, at finish(), from the final length. Same windows, same kept-frame
        counts, same total frame sequence length. This is the part that could
        actually break, and ``tests/test_enc_pipeline_parity.py`` asserts it exactly.
      * The mel VALUES are equal only to float32 rounding (measured max relative
        difference 2.9e-7). Cause: ``logmel``'s final ``spec @ _FB.T`` is a BLAS
        matmul whose tiling -- and therefore its float32 summation order -- depends
        on how many frames are in the batch, and a live buffer has fewer frames than
        the finished recording. The STFT frames and the power spectrum ARE
        bit-identical; only the mel projection differs. That is ~3 orders of
        magnitude below the int8 quantisation of the weights. Do not "fix" it by
        replacing the matmul with a loop; that trades a real speed cost for
        precision the model cannot use.
      * On a LONG recording that rounding does move words, and this is a property of
        the pipeline, not of _extend_mel. On the 19-minute meeting the difference is
        1.907e-06 = 2**-19, one float32 ULP near 1.0, and it moves 3 word regions out
        of 2227 (0.27%). Three upstream controls place the blame: with the projection
        in float64 a slice and the whole recording agree BIT FOR BIT; sweeping
        _SLICE_LEAD over 2/4/8/64 does not change the difference at all; and batching
        that one matmul into 2 row-groups with NO slicing anywhere reproduces the same
        1.907e-06 and moves 15 word regions. Against a float64-mel reference
        transcript the whole-recording path is 1.12% away and the incremental path
        0.94% -- i.e. the increment is if anything slightly CLOSER, and neither output
        is privileged. State it that way: the change is smaller than the float32 noise
        the offline path already had, not "bit-exact".
    """

    def __init__(self, runner: OrtParakeet, sample_rate: int, win_s: float,
                 ctx_s: float, norm: str = "running",
                 ctx_r_s: Optional[float] = None,
                 pipeline: Optional[bool] = None,
                 decode_mode: str = "greedy",
                 dictionary_words: tuple = ()) -> None:
        self._runner = runner
        self._sr = int(sample_rate)
        self._win_f = frames_for(win_s)
        self._ctx_f = frames_for(ctx_s)              # left
        self._ctx_r_f = (self._ctx_f if ctx_r_s is None else frames_for(ctx_r_s))
        self._norm = norm
        self._dictionary_words = tuple(dictionary_words)
        self._decode_mode = (
            "beam" if decode_mode == "beam" and self._dictionary_words
            else "greedy")
        # Only the audio the next mel increment reads is kept (see _trim_audio),
        # addressed by absolute sample index via _audio_base, so audio memory
        # stays bounded however long the recording runs.
        self._buf: list = []
        self._audio_base = 0
        self._n_samples = 0
        self._frames: list = []      # kept encoder frames, in order
        self._next_win = 0           # index of the first window not yet encoded
        self._mel: Optional[np.ndarray] = None   # [128, T] of TRUSTED frames
        self._lock = threading.Lock()
        # Resampling per block would break continuity, so a non-16 kHz stream
        # just buffers and runs the offline path at finish(). Correct, but the
        # encode cost is no longer hidden behind recording.
        self._passthrough = self._sr != SR or self._win_f <= 0
        # Pipelined decode. Off for the passthrough path (nothing is produced until
        # finish() there, so there is nothing to pipeline) and off for a runner that
        # does not offer a resumable decoder -- the parity tests' FakeRunner, which
        # must keep exercising the one-shot path it was written against.
        self._pipeline = ((PIPELINE_DECODE if pipeline is None else pipeline)
                          and not self._passthrough
                          and hasattr(runner, "resumable_decoder"))
        self._dec: Optional[object] = None   # built on the first window
        self._n_frames = 0        # kept encoder frames handed on so far

    def feed(self, block: np.ndarray) -> None:
        """Append captured audio and encode every window that is now complete."""
        b = np.asarray(block, dtype=np.float32).flatten()
        if len(b) == 0:
            return
        with self._lock:
            self._buf.append(b)
            self._n_samples += len(b)
            if not self._passthrough:
                self._drain()

    def _audio(self) -> np.ndarray:
        """Audio held: absolute samples [_audio_base, _n_samples)."""
        if len(self._buf) > 1:
            self._buf = [np.concatenate(self._buf)]
        return self._buf[0] if self._buf else np.zeros(0, dtype=np.float32)

    def _trim_audio(self) -> None:
        """Drop audio no later mel increment reads: the next one starts
        _SLICE_LEAD frames before the last trusted frame (see _extend_mel). The
        mel itself is kept whole -- running normalisation reads all of it."""
        n_have = 0 if self._mel is None else self._mel.shape[1]
        if n_have < _SLICE_LEAD:
            return            # still in the first pass, which reads from sample 0
        keep_from = (n_have - _SLICE_LEAD) * HOP
        cut = keep_from - self._audio_base
        if cut > 0:
            self._buf = [self._audio()[cut:].copy()]
            self._audio_base = keep_from

    def _extend_mel(self, final: bool = False) -> np.ndarray:
        """The log-mel of everything captured so far, extended INCREMENTALLY.

        The naive version is ``logmel(self._audio())`` on every drain, which is
        O(T^2). Measured upstream on a 19-minute meeting, both versions in one
        process with the arm order swapped between rounds: the non-encode part of the
        recording-period wall -- essentially all logmel -- was 76-160 s and became
        7.6-13.6 s, and the mel inside finish(), where the user is waiting for it,
        was 1.22-1.67 s and became 0.16-0.26 s. Worse for shorter windows, which
        drain more often: the 5 s preset saved 146 s of the 19 minutes.
        ``runner.encode`` time is unchanged within 1.5% between the two versions,
        which is the control that says only the mel moved.

        Why an increment is exact, not an approximation: frame k reads original
        samples ``[k*HOP - N_FFT//2, k*HOP + N_FFT//2)``, so a frame far enough from
        the end of the captured audio cannot change when more audio arrives -- which
        is the same fact _EDGE_MARGIN already relies on. New frames are computed from
        a SLICE that starts _SLICE_LEAD frames early, on a HOP boundary, and those
        lead frames are dropped, so neither the slice's own reflect-padded head nor
        its first (mis-preemphasised) sample can reach a frame we keep.
        ``final=True`` computes to the true end of the audio, where the real end
        padding applies.

        Memory: the mel is kept -- 128 floats per 10 ms, 59 MB for 19 minutes. Not a
        regression against the naive version, which allocated that same array
        transiently on every single drain.
        """
        x = self._audio()
        if self._mel is None or self._mel.shape[1] < _SLICE_LEAD:
            # First pass. The true start-of-signal reflect padding exists only here,
            # and a short recording that never drained has to stay byte-identical to
            # the logmel(whole) path, so keep exactly what logmel returns.
            # _trim_audio has not cut anything yet, so x starts at sample 0.
            mel = logmel(x)
            self._mel = (mel if final else
                         mel[:, :max(0, mel.shape[1] - _EDGE_MARGIN)])
        else:
            n_have = self._mel.shape[1]
            n_want = 1 + self._n_samples // HOP - (0 if final else _EDGE_MARGIN)
            if n_want > n_have:
                a = (n_have - _SLICE_LEAD) * HOP
                tail = logmel(x[a - self._audio_base:])[:, _SLICE_LEAD:]
                self._mel = np.concatenate(
                    [self._mel, tail[:, :n_want - n_have]], axis=1)
        self._trim_audio()
        return self._mel

    def _keep(self, enc: np.ndarray) -> None:
        """Take one window's kept encoder frames. Caller holds ``self._lock``.

        Pipelined, this is where the decode happens -- during recording, inside
        feed(). Not pipelined, the frames pile up for the one decode at finish().
        Everything upstream of here (the window plan, the mel, the normalisation
        statistics, the encode call) is identical either way, which is what keeps
        the two modes byte-identical.
        """
        self._n_frames += enc.shape[1]
        if not self._pipeline:
            self._frames.append(enc)
            return
        if self._dec is None:
            if self._decode_mode == "beam":
                self._dec = self._runner.resumable_decoder(
                    mode="beam", dictionary_words=self._dictionary_words)
            else:
                # Preserve compatibility with simple stand-in runners and keep
                # the greedy factory call byte-for-byte on its default path.
                self._dec = self._runner.resumable_decoder()
        self._dec.push(enc)

    def _drain(self) -> None:
        """Encode any window whose full right context (plus the padding margin)
        has arrived, and (pipelined) decode it. Cheap no-op until then."""
        s = self._next_win * self._win_f
        # The RIGHT context is what decides when a window becomes encodable: it is
        # the only part of the window that is still in the future at time s + win.
        need_frames = s + self._win_f + self._ctx_r_f + _EDGE_MARGIN
        # mel frames available ~= samples / HOP; check before paying for logmel.
        if self._n_samples // HOP < need_frames:
            return
        mel = self._extend_mel()
        n_trust = mel.shape[1]          # _extend_mel already dropped the edge margin
        while True:
            s = self._next_win * self._win_f
            e = s + self._win_f                       # not the last window
            lo = max(0, s - self._ctx_f)
            hi = e + self._ctx_r_f
            if hi > n_trust:
                break
            span = ((hi - lo) // SUB) * SUB
            hi = lo + span
            if hi <= s:
                break
            drop = (s - lo) // SUB
            keep = max(0, min((e - s) // SUB, span // SUB - drop))
            sl = mel[:, lo:hi]
            stats = (norm_stats(sl) if self._norm == "window"
                     else running_stats(mel, hi))
            enc = self._runner.encode(apply_norm(sl, *stats))
            self._keep(enc[:, drop:drop + keep] if keep else enc[:, drop:])
            self._next_win += 1

    def finish(self) -> str:
        """Encode the remaining (final) window(s) and finish the single decode.

        Pipelined, "finish the decode" means the final window's frames only -- 99 of
        14349 on upstream's 19-minute meeting -- because every earlier frame was
        decoded as it was produced. The decode is still ONE pass; this is the tail of
        it, not a second one.
        """
        with self._lock:
            if self._n_samples == 0:
                return ""
            if self._passthrough:
                # Never drained, so nothing was trimmed: this is the whole audio.
                return transcribe_offline(
                    self._runner, self._audio(), self._sr,
                    self._win_f / 100.0, self._ctx_f / 100.0, self._norm,
                    ctx_r_s=self._ctx_r_f / 100.0,
                    decode_mode=self._decode_mode,
                    dictionary_words=self._dictionary_words)
            mel = self._extend_mel(final=True)
            for i, (lo, hi, drop, keep, _f) in enumerate(
                    plan(mel.shape[1], self._win_f, self._ctx_f, self._ctx_r_f)):
                if i < self._next_win:
                    continue                  # already encoded during recording
                sl = mel[:, lo:hi]
                stats = (norm_stats(sl) if self._norm == "window"
                         else running_stats(mel, hi))
                enc = self._runner.encode(apply_norm(sl, *stats))
                self._keep(enc[:, drop:drop + keep] if keep else enc[:, drop:])
                self._next_win = i + 1
            if not self._n_frames:
                return ""
            if self._pipeline:
                if self._dec is None:
                    return ""
                finish = getattr(self._dec, "finish", None)
                return finish() if callable(finish) else self._dec.text
            return _decode_frames(
                self._runner, np.concatenate(self._frames, axis=1),
                self._decode_mode, self._dictionary_words)
