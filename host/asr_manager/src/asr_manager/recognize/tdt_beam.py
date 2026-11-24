"""Resumable modified beam search for the direct-ONNX Parakeet TDT path.

The search and context-graph semantics intentionally follow sherpa-onnx v1.13.6
``OfflineTransducerModifiedBeamSearchNeMoDecoder`` and ``ContextGraph``.  The
small BPE encoder follows simple-sentencepiece v0.7.  Those projects are
Apache-2.0 licensed; this Python implementation exists because sherpa's public
offline API cannot accept the encoder frames produced by :mod:`enc_pipeline`.

Unlike sherpa's one-shot decoder, :class:`ResumableTdtBeam` keeps hypotheses
whose TDT duration jumps beyond the frames currently available.  A later
``push`` resumes them without replaying earlier encoder frames.

PORTED VERBATIM from the DictationApp repo (``src/asr/tdt_beam.py``); only this
paragraph was added.  INERT IN PR 1: nothing reaches it, because the wire contract
reserves the ``dictionary`` request field for PR 3 and ``/transcribe`` always
decodes greedy (``"decode": "greedy"`` in the response).  ``enc_pipeline`` imports
this module lazily and only when a beam decode is asked for with a non-empty word
list, so an empty Dictionary has zero beam overhead and PR 1 never pays the import.
It is carried now rather than later so PR 3 is purely additive -- wiring the field
through, not porting a decoder.
"""
from __future__ import annotations

from dataclasses import dataclass
import math
from typing import Iterable, Optional

import numpy as np

from .enc_pipeline import BLANK, DURATIONS


class SimpleBpe:
    """The subset of simple-sentencepiece v0.7 used for hotword encoding.

    ``tokens.txt`` contains token IDs where sentencepiece expects scores.  The
    validated Dictionary experiment corrected that by using ``score=-token_id``;
    doing it in memory avoids generating a second vocab file at runtime.
    """

    def __init__(self, tokens: Iterable[str]):
        self.tokens = tuple(str(t) for t in tokens)
        self.unk_id = next(
            (i for i, token in enumerate(self.tokens) if token == "<unk>"), -1)
        self.bytes_offset = next(
            (i for i, token in enumerate(self.tokens) if token == "<0x00>"), -1)
        self._trie: dict = {}
        for token_id, token in enumerate(self.tokens):
            if not token:
                continue
            node = self._trie
            for byte in token.encode("utf-8"):
                node = node.setdefault(byte, {})
            node.setdefault(None, []).append((-float(token_id), token_id))

    def encode(self, text: str) -> list[int]:
        # C++ ``istringstream >> word`` collapses whitespace, then prefixes each
        # word with U+2581 before running byte-oriented DAG segmentation.
        data = "".join("▁" + word for word in str(text).split()).encode("utf-8")
        if not data:
            return []

        # route[i] = (best score from i, next byte offset, token id)
        route: list[tuple[float, int, int]] = [(0.0, -1, 0)] * (len(data) + 1)
        route[len(data)] = (0.0, 0, 0)
        for i in range(len(data) - 1, -1, -1):
            node = self._trie
            best_score = -math.inf
            best_end = -1
            best_token = 0
            end = i
            while end < len(data) and data[end] in node:
                node = node[data[end]]
                end += 1
                for token_score, token_id in node.get(None, ()):
                    score = token_score + route[end][0]
                    if score > best_score or (
                            score == best_score and best_end >= end):
                        best_score, best_end, best_token = score, end, token_id
            # This odd-looking zero-score fallback is source-compatible with
            # simple-sentencepiece's CalcDp for an unmatched byte.
            route[i] = (
                0.0 if best_score == -math.inf else best_score,
                best_end,
                best_token,
            )

        out: list[int] = []
        i = 0
        while i < len(data):
            _score, end, token_id = route[i]
            if end == -1:
                byte = data[i]
                out.append(
                    self.bytes_offset + byte
                    if self.bytes_offset >= 0 else self.unk_id)
                i += 1
            else:
                out.append(token_id)
                i = end
        return out


def hotword_forms(words: Iterable[str]) -> tuple[str, ...]:
    """Bias lowercase/initial-capital forms while preserving explicit casing."""
    out: list[str] = []
    seen: set[str] = set()
    for value in words:
        word = str(value).strip()
        if not word:
            continue
        lower = word.lower()
        for form in (word, lower, lower[:1].upper() + lower[1:]):
            if form not in seen:
                seen.add(form)
                out.append(form)
    return tuple(out)


class ContextState:
    __slots__ = (
        "token", "token_score", "node_score", "output_score", "level",
        "is_end", "next", "fail", "output",
    )

    def __init__(self, token: int, token_score: float, node_score: float,
                 output_score: float, level: int = 0, is_end: bool = False):
        self.token = token
        self.token_score = token_score
        self.node_score = node_score
        self.output_score = output_score
        self.level = level
        self.is_end = is_end
        self.next: dict[int, ContextState] = {}
        self.fail: ContextState
        self.output: Optional[ContextState] = None


class ContextGraph:
    """Aho-Corasick context graph compatible with sherpa-onnx v1.13.6."""

    def __init__(self, token_ids: Iterable[Iterable[int]],
                 context_score: float = 1.0):
        self.context_score = float(context_score)
        self.root = ContextState(-1, 0.0, 0.0, 0.0)
        self.root.fail = self.root
        self._build([tuple(int(t) for t in seq) for seq in token_ids])

    def _build(self, sequences: list[tuple[int, ...]]) -> None:
        for sequence in sequences:
            if not sequence:
                continue
            node = self.root
            score = self.context_score
            for index, token in enumerate(sequence):
                is_end = index == len(sequence) - 1
                child = node.next.get(token)
                if child is None:
                    node_score = node.node_score + score
                    child = ContextState(
                        token, score, node_score,
                        node_score if is_end else 0.0,
                        index + 1, is_end)
                    node.next[token] = child
                else:
                    child.token_score = max(score, child.token_score)
                    child.node_score = node.node_score + child.token_score
                    child.is_end = is_end or child.is_end
                    child.output_score = (
                        child.node_score if child.is_end else 0.0)
                node = child
        self._fill_fail_output()

    def _fill_fail_output(self) -> None:
        queue = list(self.root.next.values())
        for child in queue:
            child.fail = self.root
        cursor = 0
        while cursor < len(queue):
            current = queue[cursor]
            cursor += 1
            for token, child in current.next.items():
                fail = current.fail
                if token in fail.next:
                    fail = fail.next[token]
                else:
                    fail = fail.fail
                    while token not in fail.next:
                        fail = fail.fail
                        if fail.token == -1:
                            break
                    if token in fail.next:
                        fail = fail.next[token]
                child.fail = fail
                output = fail
                while not output.is_end:
                    output = output.fail
                    if output.token == -1:
                        output = None
                        break
                child.output = output
                if output is not None:
                    child.output_score += output.output_score
                queue.append(child)

    def forward(self, state: ContextState, token: int,
                strict: bool = False) -> tuple[float, ContextState]:
        if token in state.next:
            node = state.next[token]
            score = node.token_score
        else:
            node = state.fail
            while token not in node.next:
                node = node.fail
                if node.token == -1:
                    break
            if token in node.next:
                node = node.next[token]
            score = node.node_score - state.node_score

        if not strict and node.output_score != 0.0:
            output_score = (
                node.node_score if node.is_end
                else node.output.node_score if node.output is not None
                else node.node_score
            )
            return score + output_score - node.node_score, self.root
        return score + node.output_score, node

    def finalize_score(self, state: ContextState) -> float:
        """Refund an unfinished hotword prefix at end-of-input."""
        return -state.node_score


@dataclass(frozen=True)
class BeamHypothesis:
    tokens: tuple[int, ...]
    log_prob: float
    state: tuple[np.ndarray, np.ndarray]
    context_state: Optional[ContextState]
    frame_offset: int = 0
    num_symbols: int = 0


def _log_softmax(values: np.ndarray) -> np.ndarray:
    values = np.asarray(values, dtype=np.float32).copy()
    maximum = np.max(values)
    offset = maximum + np.log(np.sum(np.exp(values - maximum), dtype=np.float32))
    values -= offset
    return values


class ResumableTdtBeam:
    """Source-faithful NeMo/TDT modified beam search over incremental frames."""

    def __init__(self, runner, dictionary_words: Iterable[str],
                 max_active_paths: int = 4, hotwords_score: float = 1.0,
                 max_symbols_per_frame: int = 10, blank_penalty: float = 0.0):
        self._r = runner
        self.max_active_paths = max(1, int(max_active_paths))
        self.hotwords_score = float(hotwords_score)
        self.max_symbols_per_frame = max(1, int(max_symbols_per_frame))
        self.blank_penalty = float(blank_penalty)

        bpe = SimpleBpe(runner.tokens)
        sequences = [
            ids for ids in (bpe.encode(form) for form in hotword_forms(
                dictionary_words))
            if ids and all(token >= 0 for token in ids)
        ]
        self.context_graph = (
            ContextGraph(sequences, self.hotwords_score) if sequences else None)
        root = self.context_graph.root if self.context_graph is not None else None
        self.unk_id = bpe.unk_id
        self._hyps = [
            BeamHypothesis((), 0.0, runner._zero_state(), root)
        ]
        self._buf: Optional[np.ndarray] = None
        self._base = 0
        self.n = 0
        self.max_buffer_frames = 0
        self._finished = False
        self._final_tokens: Optional[tuple[int, ...]] = None

    def push(self, enc: np.ndarray) -> None:
        if self._finished:
            raise RuntimeError("cannot push encoder frames after finish()")
        enc = np.asarray(enc, dtype=np.float32)
        if enc.ndim != 2:
            raise ValueError(f"encoder frames must be [dim, time], got {enc.shape}")
        if enc.shape[1]:
            self._buf = (
                np.ascontiguousarray(enc) if self._buf is None
                else np.concatenate([self._buf, enc], axis=1)
            )
            self.n += enc.shape[1]
            self.max_buffer_frames = max(
                self.max_buffer_frames, self._buf.shape[1])
        if self._buf is None:
            return

        while min(h.frame_offset for h in self._hyps) < self.n:
            min_frame = min(h.frame_offset for h in self._hyps)
            candidates: list[BeamHypothesis] = []
            for hyp in self._hyps:
                if hyp.frame_offset > min_frame:
                    candidates.append(hyp)
                    continue
                if hyp.num_symbols >= self.max_symbols_per_frame:
                    candidates.append(BeamHypothesis(
                        hyp.tokens, hyp.log_prob, hyp.state, hyp.context_state,
                        hyp.frame_offset + 1, 0))
                    continue
                candidates.extend(self._expand(hyp))
            if not candidates:
                break
            # std::partial_sort in the reference ranks only by raw score.  Python's
            # stable sort gives deterministic ties without changing non-tie order.
            candidates.sort(key=lambda hyp: hyp.log_prob, reverse=True)
            self._hyps = candidates[:self.max_active_paths]

        # No active path can read frames before this point again.  Duration
        # overshoot can put every path beyond n, in which case all available
        # frames are safely dropped and the absolute cursor remains ahead.
        keep_at = min(min(h.frame_offset for h in self._hyps), self.n)
        drop = keep_at - self._base
        if drop > 0:
            self._buf = np.ascontiguousarray(self._buf[:, drop:])
            self._base = keep_at

    def _expand(self, hyp: BeamHypothesis) -> list[BeamHypothesis]:
        r = self._r
        index = hyp.frame_offset - self._base
        frame = np.ascontiguousarray(self._buf[None, :, index:index + 1])
        last_token = hyp.tokens[-1] if hyp.tokens else BLANK
        decoder_out, next_state = r._pred(last_token, hyp.state)
        logits = r.joi.run(
            None,
            {r._joi_names[0]: frame, r._joi_names[1]: decoder_out},
        )[0][0, 0, 0]

        token_logits = np.asarray(logits[:BLANK + 1], dtype=np.float32).copy()
        if self.blank_penalty > 0.0:
            token_logits[BLANK] -= self.blank_penalty
        token_log_probs = _log_softmax(token_logits)

        graph = self.context_graph
        if graph is not None and hyp.context_state is not None:
            for token in hyp.context_state.next:
                if 0 <= token < len(token_log_probs):
                    token_log_probs[token] += self.hotwords_score

        top_tokens = sorted(
            range(len(token_log_probs)),
            key=lambda token: float(token_log_probs[token]),
            reverse=True,
        )[:self.max_active_paths]

        duration_logits = np.asarray(logits[BLANK + 1:], dtype=np.float32)
        if len(duration_logits):
            duration_log_probs = _log_softmax(duration_logits)
            duration_index = int(np.argmax(duration_log_probs))
            predicted_skip = (
                DURATIONS[duration_index]
                if duration_index < len(DURATIONS) else duration_index)
            duration_log_prob = float(duration_log_probs[duration_index])
        else:  # Defensive non-TDT fallback; production Parakeet always has bins.
            predicted_skip = 1
            duration_log_prob = 0.0

        out: list[BeamHypothesis] = []
        for token in top_tokens:
            score = (
                hyp.log_prob + float(token_log_probs[token])
                + duration_log_prob)
            if token == BLANK or token == self.unk_id:
                out.append(BeamHypothesis(
                    hyp.tokens, score, hyp.state, hyp.context_state,
                    hyp.frame_offset + max(1, predicted_skip), 0))
                continue

            context_state = hyp.context_state
            if graph is not None and context_state is not None:
                context_score, context_state = graph.forward(
                    context_state, token, strict=False)
                score += context_score
            out.append(BeamHypothesis(
                hyp.tokens + (token,), score, next_state, context_state,
                hyp.frame_offset + predicted_skip,
                0 if predicted_skip > 0 else hyp.num_symbols + 1,
            ))
        return out

    def finish(self) -> str:
        if self._final_tokens is None:
            best = max(
                self._hyps,
                key=lambda hyp: (
                    hyp.log_prob
                    + (self.context_graph.finalize_score(hyp.context_state)
                       if self.context_graph is not None
                       and hyp.context_state is not None else 0.0)
                ),
            )
            self._final_tokens = best.tokens
        self._finished = True
        return self._r._detokenize(list(self._final_tokens))

    @property
    def text(self) -> str:
        if self._final_tokens is not None:
            return self._r._detokenize(list(self._final_tokens))
        best = max(self._hyps, key=lambda hyp: hyp.log_prob)
        return self._r._detokenize(list(best.tokens))


def decode_tdt_beam(runner, enc: np.ndarray, dictionary_words: Iterable[str],
                    **kwargs) -> str:
    """One-shot beam decode through the same resumable state machine."""
    decoder = ResumableTdtBeam(runner, dictionary_words, **kwargs)
    decoder.push(enc)
    return decoder.finish()
