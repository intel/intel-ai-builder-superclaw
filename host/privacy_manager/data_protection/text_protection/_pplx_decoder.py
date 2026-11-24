"""BIOES Viterbi decoder for the PPLX PII-masking model.

Uses NumPy instead of torch to keep dependencies lighter. Decoding is plain
array math and does not need autograd or training support.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

PII_TYPES = [
    "private_person",
    "private_email",
    "private_phone",
    "private_address",
    "private_url",
    "private_date",
    "account_number",
    "secret",
    "other_pii",
]
# Checkpoint label order: O + 9 PII types x {B, I, E, S} = 37 labels.
BIOES_LABELS = ["O"] + [f"{tag}-{t}" for t in PII_TYPES for tag in "BIES"]


@dataclass
class PredictedSpan:
    start: int   # character offset in source text
    end: int
    label: str   # e.g. "private_person"
    score: float


def strip_span_whitespace(text: str, spans: list[PredictedSpan]) -> list[PredictedSpan]:
    """Trim whitespace that token offsets may include around a predicted span."""
    out: list[PredictedSpan] = []
    for s in spans:
        new_start, new_end = s.start, s.end
        while new_start < new_end and text[new_start] in (" ", "\t", "\n"):
            new_start += 1
        while new_end > new_start and text[new_end - 1] in (" ", "\t", "\n"):
            new_end -= 1
        if new_start < new_end:
            out.append(PredictedSpan(new_start, new_end, s.label, s.score))
    return out


class ViterbiDecoder:
    """Constrained BIOES Viterbi decoder.

    ``b_bias`` and ``e_bias`` adjust span entry/exit scores. The checkpoint has
    no custom values, so both default to 0.0.
    """

    def __init__(self, labels: list[str], b_bias: float = 0.0, e_bias: float = 0.0):
        self.labels = labels
        self.num_labels = len(labels)
        self.label2id = {label: idx for idx, label in enumerate(labels)}
        self.id2label = {idx: label for idx, label in enumerate(labels)}
        self.pii_types = [label[2:] for label in labels if label.startswith("S-")]
        self.b_bias = float(b_bias)
        self.e_bias = float(e_bias)
        self.transition_mask = self._build_transition_mask()

    def _build_transition_mask(self) -> np.ndarray:
        """Return a mask of valid BIOES tag transitions."""
        n, l2i = self.num_labels, self.label2id
        mask = np.zeros((n, n), dtype=bool)
        end_states = {l2i["O"]}    # states a span can end on (O, E-*, S-*)
        begin_states = {l2i["O"]}  # states valid after a boundary (O, B-*, S-*)
        for pii_type in self.pii_types:
            b, i = l2i[f"B-{pii_type}"], l2i[f"I-{pii_type}"]
            e, s = l2i[f"E-{pii_type}"], l2i[f"S-{pii_type}"]
            end_states |= {e, s}
            begin_states |= {b, s}
            mask[b, i] = mask[b, e] = True   # B -> I/E of same type
            mask[i, i] = mask[i, e] = True   # I -> I/E of same type
        for from_state in end_states:
            for to_state in begin_states:
                mask[from_state, to_state] = True
        return mask

    def _build_transition_scores(self) -> np.ndarray:
        """Return transition scores, with impossible transitions set to -inf."""
        n, l2i = self.num_labels, self.label2id
        scores = np.full((n, n), -np.inf)
        scores[self.transition_mask] = 0.0
        for pii_type in self.pii_types:
            b, e = l2i[f"B-{pii_type}"], l2i[f"E-{pii_type}"]
            for from_s in range(n):
                if scores[from_s, b] > -np.inf:
                    scores[from_s, b] += self.b_bias   # entering B states
            for to_s in range(n):
                if scores[e, to_s] > -np.inf:
                    scores[e, to_s] += self.e_bias     # leaving E states
        return scores

    def decode(
        self,
        logits: np.ndarray,
        offset_mapping: list[tuple[int, int]],
        text: str | None = None,
    ) -> list[PredictedSpan]:
        """Decode one token sequence into character spans.

        Args:
            logits: ``[tokens, labels]`` score array.
            offset_mapping: Character offsets for each token.
            text: Source text used to trim span-boundary whitespace.
        """
        logits = np.asarray(logits, dtype=np.float64)
        T, C = logits.shape
        assert C == self.num_labels

        trans = self._build_transition_scores()  # [C, C]

        viterbi_scores = np.full((T, C), -np.inf)
        backpointers = np.zeros((T, C), dtype=np.int64)

        # First token can start outside a span, begin a span, or be a single-token span.
        start_mask = np.full((C,), -np.inf)
        for label, idx in self.label2id.items():
            if label == "O" or label.startswith("B-") or label.startswith("S-"):
                start_mask[idx] = 0.0
        viterbi_scores[0] = logits[0] + start_mask

        for t in range(1, T):
            # Shape [previous_label, next_label].
            scores_t = viterbi_scores[t - 1][:, None] + trans
            backpointers[t] = np.argmax(scores_t, axis=0)
            viterbi_scores[t] = logits[t] + np.max(scores_t, axis=0)

        # Final token must be outside a span, end a span, or be a single-token span.
        end_mask = np.full((C,), -np.inf)
        for label, idx in self.label2id.items():
            if label == "O" or label.startswith("E-") or label.startswith("S-"):
                end_mask[idx] = 0.0
        best_last = int(np.argmax(viterbi_scores[T - 1] + end_mask))

        path = [best_last]
        for t in range(T - 1, 0, -1):
            path.append(int(backpointers[t, path[-1]]))
        path.reverse()

        spans = self._path_to_spans(path, logits, offset_mapping)
        if text is not None:
            spans = strip_span_whitespace(text, spans)
        return spans

    @staticmethod
    def _sigmoid(x: float) -> float:
        return float(1.0 / (1.0 + np.exp(-x)))

    def _path_to_spans(
        self,
        path: list[int],
        logits: np.ndarray,
        offset_mapping: list[tuple[int, int]],
    ) -> list[PredictedSpan]:
        spans: list[PredictedSpan] = []
        T = len(path)
        t = 0
        while t < T:
            label = self.id2label[path[t]]
            char_start, char_end = offset_mapping[t]

            if label.startswith("S-"):
                pii_type = label[2:]
                score = self._sigmoid(float(logits[t, path[t]]))
                if char_start < char_end:
                    spans.append(PredictedSpan(char_start, char_end, pii_type, score))
                t += 1

            elif label.startswith("B-"):
                pii_type = label[2:]
                span_start, span_end = char_start, char_end
                tok_scores = [float(logits[t, path[t]])]
                t += 1
                while t < T:
                    inner = self.id2label[path[t]]
                    if inner == f"I-{pii_type}":
                        _, span_end = offset_mapping[t]
                        tok_scores.append(float(logits[t, path[t]]))
                        t += 1
                    elif inner == f"E-{pii_type}":
                        _, span_end = offset_mapping[t]
                        tok_scores.append(float(logits[t, path[t]]))
                        t += 1
                        break
                    else:
                        break
                if span_start < span_end:
                    score = self._sigmoid(float(np.mean(tok_scores)))
                    spans.append(PredictedSpan(span_start, span_end, pii_type, score))

            else:
                t += 1

        return spans

