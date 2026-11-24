"""PPLX NER pipeline using OpenVINO IR inference.

This replaces the old xlm-roberta NER stage for free-form text. The PPLX model
ships only as OpenVINO IR, so inference always goes through ``openvino.Core``;
there is no ONNX fallback. Non-OpenVINO device routes still use OpenVINO's CPU
plugin for this model.

Inputs longer than ``_MAX_TOKENS`` are truncated. Chunking is not implemented
yet because BIOES Viterbi decoding depends on the whole sequence.
"""

from __future__ import annotations

import logging
import os
import threading
from typing import Any, Dict, List, Optional, Set, Tuple

import numpy as np

from text_protection._pplx_decoder import BIOES_LABELS, PredictedSpan, ViterbiDecoder
from text_protection._pplx_repairs import apply_pplx_repairs
from text_protection._sanitizer_caches import CacheBackend, LRUCache


logger = logging.getLogger(__name__)


class PplxNerPipeline:
    """Runs PPLX inference, Viterbi decoding, repairs, and caching.

    Use :meth:`create`; failed model loads return ``None`` so regex detection
    can continue without the NER model.
    """

    # Single-window only for now.
    _MAX_TOKENS = 4096

    def __init__(
        self,
        *,
        session: Any,
        tokenizer: Any,
        viterbi: ViterbiDecoder,
        cache_size: int,
        metrics_lock: threading.Lock,
        operational_metrics: Dict[str, int],
        entity_cache: Optional[CacheBackend] = None,
        backend_label: str = "unknown",
    ) -> None:
        self._session = session
        self._backend_label = backend_label
        self._tokenizer = tokenizer
        self._viterbi = viterbi
        self._entity_cache: CacheBackend[
            Tuple[int, str], Tuple[Tuple[str, int, int, float], ...]
        ] = entity_cache if entity_cache is not None else LRUCache(cache_size)
        self._metrics_lock = metrics_lock
        self._operational_metrics = operational_metrics

    # ------------------------------------------------------------------
    # Construction
    # ------------------------------------------------------------------

    @classmethod
    def create(
        cls,
        *,
        pplx_model_path: str,
        cache_size: int,
        metrics_lock: threading.Lock,
        operational_metrics: Dict[str, int],
        entity_cache: Optional[CacheBackend] = None,
        resolved: Any = None,
    ) -> Optional["PplxNerPipeline"]:
        """Load the PPLX OpenVINO IR model, returning ``None`` on failure.

        ``resolved`` selects the OpenVINO device when routing chose GPU/NPU.
        Otherwise this IR-only model uses OpenVINO CPU.
        """
        ov_target = "CPU"
        cache_dir = None
        if resolved is not None and resolved.providers:
            if resolved.providers[0] == "OpenVINOExecutionProvider":
                from text_protection._openvino_backend import device_from_resolved

                ov_target = device_from_resolved(resolved)
                if resolved.provider_options:
                    cache_dir = (resolved.provider_options[0] or {}).get("cache_dir")

        try:
            from text_protection._openvino_backend import load_ov_pplx

            session, tokenizer = load_ov_pplx(pplx_model_path, ov_target, cache_dir)
            viterbi = ViterbiDecoder(BIOES_LABELS)
        except Exception as exc:
            logger.warning("PPLX model load failed; continuing without it: %s", exc)
            return None

        backend_label = f"OpenVINO:{ov_target}"
        logger.info("PPLX backend: %s", backend_label)

        return cls(
            session=session,
            tokenizer=tokenizer,
            viterbi=viterbi,
            cache_size=cache_size,
            metrics_lock=metrics_lock,
            operational_metrics=operational_metrics,
            entity_cache=entity_cache,
            backend_label=backend_label,
        )

    @property
    def available(self) -> bool:
        return self._tokenizer is not None and self._session is not None

    @property
    def backend_label(self) -> str:
        """Loaded backend label for diagnostics, e.g. ``OpenVINO:CPU``."""
        return self._backend_label

    # ------------------------------------------------------------------
    # Inference
    # ------------------------------------------------------------------

    def run(self, text: str) -> List[PredictedSpan]:
        """Run tokenization, OpenVINO inference, Viterbi decode, and repairs."""
        if not self.available:
            return []

        try:
            enc = self._tokenizer(
                text,
                return_tensors="np",
                return_offsets_mapping=True,
                truncation=True,
                max_length=self._MAX_TOKENS,
            )
        except Exception as exc:
            logger.warning("PPLX tokenization failed: %s", exc)
            return []

        input_ids = enc["input_ids"]
        if input_ids.shape[1] >= self._MAX_TOKENS:
            logger.warning(
                "PPLX input truncated to %d tokens; chunking is not implemented yet",
                self._MAX_TOKENS,
            )

        try:
            logits, _sensitivity_logits = self._session.run(
                None,
                {
                    "input_ids": input_ids.astype(np.int64),
                    "attention_mask": enc["attention_mask"].astype(np.int64),
                },
            )
        except Exception as exc:
            logger.warning("PPLX inference failed: %s", exc)
            return []

        offsets = [tuple(o) for o in enc["offset_mapping"][0].tolist()]
        spans = self._viterbi.decode(logits[0].astype(np.float64), offsets, text=text)
        return apply_pplx_repairs(text, spans)

    def run_cached(self, text: str) -> List[PredictedSpan]:
        """Return cached spans when possible; otherwise run inference."""
        if not self.available:
            return []
        if os.environ.get("PII_DISABLE_NER_CACHE", "").lower() in {"1", "true", "yes"}:
            return self.run(text)
        key = (len(text), text)
        cached = self._entity_cache.get(key)
        if cached is not None:
            with self._metrics_lock:
                self._operational_metrics["ner_cache_hits"] += 1
            return [
                PredictedSpan(start=s, end=e, label=label, score=score)
                for label, s, e, score in cached
            ]
        with self._metrics_lock:
            self._operational_metrics["ner_cache_misses"] += 1
        spans = self.run(text)
        self._entity_cache.put(
            key,
            tuple((s.label, s.start, s.end, s.score) for s in spans),
        )
        return spans

    def clear_cache(self) -> None:
        self._entity_cache.clear()

    # ------------------------------------------------------------------
    # Stage-1 entry points matching the old NerPipeline surface.
    # ------------------------------------------------------------------

    def collect_spans(
        self,
        redacted: str,
        label_category_map: Dict[str, str],
    ) -> List[Tuple[int, int, str]]:
        """Return ``(start, end, label)`` triples for stage-1 detection.

        ``label_category_map`` is kept for compatibility with the old NER
        interface; PPLX spans are already decoded and repaired here.
        """
        _ = label_category_map
        return [(s.start, s.end, s.label) for s in self.run_cached(redacted)]

    def collect_spans_scored(
        self,
        redacted: str,
        label_category_map: Dict[str, str],
    ) -> List[Tuple[int, int, str, float]]:
        """Return stage-1 spans with confidence scores."""
        _ = label_category_map
        return [(s.start, s.end, s.label, s.score) for s in self.run_cached(redacted)]
