"""Main text sanitizer API and lifecycle.

``ConsistentSanitizer`` combines regex rules, PPLX NER, and spaCy fallback NER.
Create one instance per process and
reuse it: model sessions, tokenizers, compiled regexes, and constants are
read-only after initialization.

Each ``sanitize()`` call uses its own ``_SanitizeContext`` for mutable state, so
concurrent calls do not share pipeline state. The legacy instance mirrors
(``self.replacements``, ``self.entity_registry``, ``self._counters``) hold only
the most recent call and are kept for backwards compatibility; concurrent
callers should use the values returned by ``sanitize()``.

This module owns model/config lifecycle, public methods, and shared helpers.
Detection details live in sibling modules: ``_detectors``, ``_stages``,
``_pplx_pipeline``, and ``_restore``.
"""

import asyncio
import bisect
import logging
import os
import re
import threading
import time
import warnings
from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional, Set, Tuple

# Silence transformers warnings about missing PyTorch/TensorFlow. We only use
# AutoTokenizer, so those frameworks are intentionally absent.
os.environ.setdefault("TRANSFORMERS_NO_ADVISORY_WARNINGS", "1")
os.environ.setdefault("TRANSFORMERS_VERBOSITY", "error")

import spacy  # noqa: E402

from text_protection.onnx_providers import (  # noqa: E402
    DeviceUnavailableError,
    resolve_providers,
)
from text_protection._sanitizer_constants import (  # noqa: E402
    FINANCIAL_KEYWORDS as _CONST_FINANCIAL_KEYWORDS,
    FINANCIAL_PATTERNS as _CONST_FINANCIAL_PATTERNS,
    LABEL_CATEGORY_MAP as _CONST_LABEL_CATEGORY_MAP,
    MEDIUM_SKIP_CATEGORIES as _CONST_MEDIUM_SKIP_CATEGORIES,
    TOKEN_PATTERNS as _CONST_TOKEN_PATTERNS,
)
from text_protection._sanitizer_caches import CacheBackend, LRUCache  # noqa: E402
from text_protection._pplx_pipeline import PplxNerPipeline  # noqa: E402
from text_protection._detectors import (  # noqa: E402
    CustomTermDetector,
    Detector,
    FinancialRegexDetector,
    NerDetector,
    RegexDetector,
    SpacyDetector,
)
from text_protection._stages import (  # noqa: E402
    Stage,
    Stage1TokenDetection,
    Stage2FinancialDetection,
)
from text_protection._restore import restore as _restore_text  # noqa: E402


logger = logging.getLogger(__name__)


# Tokenizer files required next to an OpenVINO IR model.
_REQUIRED_OV_TOKENIZER_FILES = ("tokenizer.json", "tokenizer_config.json")


def _is_ov_model_present(path: str) -> bool:
    """Return True only for a complete OpenVINO-IR-only model directory."""
    from text_protection._openvino_backend import is_ov_ir_dir

    if not is_ov_ir_dir(path):
        return False
    return all(
        os.path.isfile(os.path.join(path, name))
        and os.path.getsize(os.path.join(path, name)) > 0
        for name in _REQUIRED_OV_TOKENIZER_FILES
    )


# Re-export for old callers; service code can import the lightweight source.
from common.errors import EntityBudgetExceeded  # noqa: E402


@dataclass
class ReplacementRecord:
    original: str
    redacted: str
    type: str  # 'token' or 'sentence'
    meta: dict = field(default_factory=dict)


@dataclass
class _SanitizeContext:
    """Mutable state for one ``sanitize()`` call."""

    redacted: str
    replacements: Dict[str, ReplacementRecord] = field(default_factory=dict)
    entity_registry: Dict[str, Dict[str, str]] = field(default_factory=dict)
    counters: Dict[str, int] = field(default_factory=dict)
    prev_match: List[Tuple[int, int]] = field(default_factory=list)
    metrics: Dict[str, Any] = field(default_factory=dict)
    # New entities registered by this call; existing session entities do not count.
    new_entities: int = 0
    # Per-call bucketize setting resolved from defaults and request override.
    bucketize_financial: bool = False
    # FIN_AMOUNT handling for Stage 2: mask, bucketize, or leave amounts unmasked.
    fin_amount_mode: str = "mask"


class ConsistentSanitizer:
    # ---------------------------------------------------------------------------
    # Class-level constants are available without constructing the sanitizer.
    # ---------------------------------------------------------------------------
    TOKEN_PATTERNS: Dict[str, str] = _CONST_TOKEN_PATTERNS
    FINANCIAL_PATTERNS: Dict[str, str] = _CONST_FINANCIAL_PATTERNS
    FINANCIAL_KEYWORDS: List[str] = _CONST_FINANCIAL_KEYWORDS

    LABEL_CATEGORY_MAP: Dict[str, str] = _CONST_LABEL_CATEGORY_MAP
    MEDIUM_SKIP_CATEGORIES: Set[str] = _CONST_MEDIUM_SKIP_CATEGORIES

    # Stage-1 specificity scores; lower values win same-priority conflicts.
    _LABEL_SPEC: Dict[str, int] = {
        "SSN": 0,
        "EMAIL": 0,
        "CREDITCARDNUM": 0,
        "IBAN": 0,
        "ISO_DATE": 0,
        "PHONE": 0,
        "ID_NUM": 0,
        "URL": 1,
        "ACCOUNT": 2,
        "ZIP_CODE": 2,
        "JSON_CITY": 0,
        "ORG_NAME": 0,
        "ORG_GAZETTEER": 0,
        "CITY_GAZETTEER": 0,
        "ROLE_PERSON": 1,
        "SEX_VALUE": 0,
        "GENDER_VALUE": 0,
        "COUNTRY_NAME": 0,
        "COUNTY_NAME": 0,
    }

    # Stage1Span: (priority, specificity, start, end, label, val).
    Stage1Span = Tuple[int, int, int, int, str, str]

    def __init__(
        self,
        use_spacy: bool = True,
        spacy_english_only: bool = False,
        fin_amount_mode: str = "mask",
        custom_terms: Optional[Dict[str, str]] = None,
        ner_model_path: str = "./models/pplx-pii-masking-ov-int8",
        device: str = "AUTO",
        ov_cache_dir: Optional[str] = "./.ov_cache",
        *,
        bucketize_financial: bool = False,
        ner_cache_size: int = 256,
        custom_term_cache_size: int = 1024,
        max_input_chars: int = 1_000_000,
        max_entities_per_request: int = 5_000,
        ner_cache_backend: Optional[CacheBackend] = None,
        keep_legacy_mirrors: bool = True,
    ):
        """Initialize models, regexes, detectors, caches, and defaults.

        A missing PPLX model disables the NER tier. Regex detection and spaCy
        fallback can still run.
        """
        self.use_spacy = use_spacy
        self.spacy_english_only = spacy_english_only
        self.custom_terms = custom_terms or {}

        cache_dir_abs: Optional[str] = None
        if ov_cache_dir:
            os.makedirs(ov_cache_dir, exist_ok=True)
            cache_dir_abs = os.path.abspath(ov_cache_dir)

        try:
            resolved = resolve_providers(device, ov_cache_dir=cache_dir_abs)
        except DeviceUnavailableError:
            raise
        logger.info("ONNX Runtime providers: %s", resolved.description)

        # Shared counters for cache telemetry.
        self._metrics_lock = threading.Lock()
        self._operational_metrics: Dict[str, int] = {
            "ner_cache_hits": 0,
            "ner_cache_misses": 0,
        }

        self._ner: Optional[PplxNerPipeline] = PplxNerPipeline.create(
            pplx_model_path=ner_model_path,
            cache_size=ner_cache_size,
            metrics_lock=self._metrics_lock,
            operational_metrics=self._operational_metrics,
            entity_cache=ner_cache_backend,
            resolved=resolved,
        )

        # Legacy mirrors populated after each sanitize call when enabled.
        self.replacements: Dict[str, ReplacementRecord] = {}
        self.entity_registry: Dict[str, Dict[str, str]] = {}
        self._counters: Dict[str, int] = {}

        # Load spaCy model if requested and available.
        if self.use_spacy:
            try:
                self.nlp = spacy.load("en_core_web_sm")
            except OSError:
                self.nlp = None
                self.use_spacy = False
        else:
            self.nlp = None

        # Instance aliases preserve the older public surface.
        self.token_patterns = self.TOKEN_PATTERNS
        self.financial_patterns = self.FINANCIAL_PATTERNS
        self.financial_keywords = self.FINANCIAL_KEYWORDS

        # Compile patterns once and reuse them across calls.
        self._compiled_token_patterns: Dict[str, "re.Pattern[str]"] = {
            label: re.compile(pat, flags=re.IGNORECASE)
            for label, pat in self.token_patterns.items()
        }
        self._compiled_financial_patterns: Dict[str, "re.Pattern[str]"] = {
            label: re.compile(pat, flags=re.IGNORECASE)
            for label, pat in self.financial_patterns.items()
        }
        self._compiled_financial_keywords: Dict[str, "re.Pattern[str]"] = {
            kw: re.compile(rf"\b{re.escape(kw)}\b", flags=re.IGNORECASE)
            for kw in self.financial_keywords
        }
        self._custom_term_re_cache: LRUCache[str, "re.Pattern[str]"] = LRUCache(
            custom_term_cache_size
        )

        # Protects publishing the legacy mirrors.
        self._mirror_lock = threading.Lock()

        # Default bucketize policy; per-call overrides live on the context.
        self._bucketize_financial = bucketize_financial
        # FIN_AMOUNT mode. Legacy bucketize_financial=True forces bucketize.
        _mode = str(fin_amount_mode or "mask").lower()
        if _mode not in ("mask", "off", "bucketize"):
            _mode = "mask"
        if bucketize_financial and _mode == "mask":
            _mode = "bucketize"
        self._fin_amount_mode = _mode

        if max_input_chars < 1:
            raise ValueError(f"max_input_chars must be >= 1, got {max_input_chars}")
        self._max_input_chars = max_input_chars

        if max_entities_per_request < 1:
            raise ValueError(
                f"max_entities_per_request must be >= 1, got {max_entities_per_request}"
            )
        self._max_entities_per_request = max_entities_per_request

        # Keep old instance mirrors unless callers opt out for concurrency/throughput.
        self._keep_legacy_mirrors = keep_legacy_mirrors

        # Detector order is stable for readability; priority controls merge order.
        self._stage1_detectors: List[Detector] = [
            CustomTermDetector(self.custom_terms, self._custom_term_re_cache),
            RegexDetector(self._compiled_token_patterns, self._LABEL_SPEC),
            FinancialRegexDetector(self._compiled_financial_patterns),
            NerDetector(self._ner, self.LABEL_CATEGORY_MAP),
            SpacyDetector(self.nlp, self.use_spacy,
                          english_only=self.spacy_english_only),
        ]

    # ------------------------------------------------------------------
    # Backwards-compatible accessors for inference helpers
    # ------------------------------------------------------------------

    def _run_ner(self, text: str) -> List[Any]:
        """Run PPLX NER and return ``PredictedSpan`` objects.

        Kept as a compatibility shim; implementation lives in
        ``PplxNerPipeline``.
        """
        if self._ner is None:
            return []
        return self._ner.run(text)

    def _run_ner_cached(self, text: str) -> List[Any]:
        if self._ner is None:
            return []
        return self._ner.run_cached(text)

    def ner_backend_label(self) -> str:
        """Return the loaded NER backend label, or ``none`` when unavailable."""
        if self._ner is None:
            return "none"
        return getattr(self._ner, "backend_label", "unknown")

    def ner_scored_spans(self, text: str) -> List[Tuple[int, int, str, float]]:
        """Return NER spans as ``(start, end, category, score)``.

        Categories are canonicalized through ``LABEL_CATEGORY_MAP``. Returns an
        empty list when NER is unavailable.
        """
        if self._ner is None or not self._ner.available:
            return []
        out: List[Tuple[int, int, str, float]] = []
        for s, e, label, score in self._ner.collect_spans_scored(
            text, self.LABEL_CATEGORY_MAP
        ):
            out.append((s, e, self.LABEL_CATEGORY_MAP.get(label, label), score))
        return out

    def _canon(self, entity_group: str) -> str:
        return self.LABEL_CATEGORY_MAP.get(entity_group, entity_group)

    # ------------------------------------------------------------------
    # Utility helpers
    # ------------------------------------------------------------------

    def _normalize_value(self, value: str) -> str:
        """Normalize a string for consistent registry lookup."""
        v = value.strip()
        v = re.sub(r"\s+", " ", v)
        v = v.strip(" ,.;:()[]\"'")
        v = re.sub(r"(?u)[^-\w@.\s$£€¥₹₽¢₩₪]", "", v)
        return v

    def _get_or_create_placeholder(
        self,
        category: str,
        value: str,
        is_normalized: bool = False,
        ctx: Optional["_SanitizeContext"] = None,
    ) -> str:
        """Return the existing placeholder or create a new one for a value."""
        # Local binding avoids repeated attribute lookups in this hot path.
        label_map = self.LABEL_CATEGORY_MAP
        cat = label_map.get(category, category)

        if ctx is not None:
            registry = ctx.entity_registry
            counters = ctx.counters
        else:
            registry = self.entity_registry
            counters = self._counters

        cat_registry = registry.get(cat)
        if cat_registry is None:
            cat_registry = {}
            registry[cat] = cat_registry

        norm = self._normalize_value(value) if is_normalized else value

        # Existing entity: reuse the same placeholder.
        existing = cat_registry.get(norm)
        if existing is not None:
            return existing

        # Enforce the per-request budget before mutating context state.
        if ctx is not None:
            if ctx.new_entities >= self._max_entities_per_request:
                raise EntityBudgetExceeded(self._max_entities_per_request)
            ctx.new_entities += 1

        cnt = counters.get(cat, 0) + 1
        counters[cat] = cnt
        placeholder = f"<{cat}_{cnt}>"
        cat_registry[norm] = placeholder
        return placeholder

    def previous_matched(
        self, start: int, end: int, prev_match: List[Tuple[int, int]]
    ) -> bool:
        """Return true when a candidate span overlaps an existing placeholder."""
        n = len(prev_match)
        if n == 0:
            return False
        idx = bisect.bisect_right(prev_match, (start, end))
        if idx > 0 and prev_match[idx - 1][1] > start:
            return True
        if idx < n and prev_match[idx][0] < end:
            return True
        return False

    def update_prev_match(
        self,
        text: str,
        replacements: Optional[Dict[str, ReplacementRecord]] = None,
    ) -> List[Tuple[int, int]]:
        """Rebuild placeholder offsets by scanning text once.

        Kept for compatibility; the main pipeline updates ``ctx.prev_match``
        incrementally as it inserts placeholders.
        """
        replacements = replacements if replacements is not None else self.replacements
        if not replacements:
            return []
        keys = sorted(replacements.keys(), key=len, reverse=True)
        joined = "|".join(re.escape(k) for k in keys)
        return [(m.start(), m.end()) for m in re.finditer(joined, text)]

    # ------------------------------------------------------------------
    # Main sanitize
    # ------------------------------------------------------------------

    def sanitize(
        self,
        text: str,
        session_entity_registry: Optional[Dict] = None,
        session_counters: Optional[Dict] = None,
        skip_categories: Optional[Set[str]] = None,
        bucketize_financial: Optional[bool] = None,
        custom_terms: Optional[Mapping[str, str]] = None,
    ) -> Tuple[str, Dict[str, "ReplacementRecord"], Dict, Dict]:
        """Return redacted text, replacements, registry, and counters.

        ``bucketize_financial`` overrides the instance default for this call.
        ``custom_terms`` adds per-call terms without mutating the shared
        sanitizer configuration.
        """
        ctx = self._sanitize_impl(
            text,
            session_entity_registry=session_entity_registry,
            session_counters=session_counters,
            skip_categories=skip_categories,
            bucketize_financial=bucketize_financial,
            custom_terms=custom_terms,
        )
        updated_registry = {k: dict(v) for k, v in ctx.entity_registry.items()}
        updated_counters = dict(ctx.counters)
        return ctx.redacted, dict(ctx.replacements), updated_registry, updated_counters

    def sanitize_with_metrics(
        self,
        text: str,
        session_entity_registry: Optional[Dict] = None,
        session_counters: Optional[Dict] = None,
        skip_categories: Optional[Set[str]] = None,
        bucketize_financial: Optional[bool] = None,
        custom_terms: Optional[Mapping[str, str]] = None,
    ) -> Tuple[str, Dict[str, "ReplacementRecord"], Dict, Dict, Dict[str, Any]]:
        """Same as ``sanitize()`` but also returns per-stage metrics."""
        ctx = self._sanitize_impl(
            text,
            session_entity_registry=session_entity_registry,
            session_counters=session_counters,
            skip_categories=skip_categories,
            bucketize_financial=bucketize_financial,
            custom_terms=custom_terms,
        )
        updated_registry = {k: dict(v) for k, v in ctx.entity_registry.items()}
        updated_counters = dict(ctx.counters)
        return (
            ctx.redacted,
            dict(ctx.replacements),
            updated_registry,
            updated_counters,
            dict(ctx.metrics),
        )

    # ------------------------------------------------------------------
    # Async surface
    # ------------------------------------------------------------------
    # Async wrappers run the blocking pipeline in a worker thread. Returned
    # values are thread-safe; legacy instance mirrors are still last-call only.

    async def asanitize(
        self,
        text: str,
        session_entity_registry: Optional[Dict] = None,
        session_counters: Optional[Dict] = None,
        skip_categories: Optional[Set[str]] = None,
    ) -> Tuple[str, Dict[str, "ReplacementRecord"], Dict, Dict]:
        """Async wrapper around :meth:`sanitize`."""
        return await asyncio.to_thread(
            self.sanitize,
            text,
            session_entity_registry,
            session_counters,
            skip_categories,
        )

    async def asanitize_with_metrics(
        self,
        text: str,
        session_entity_registry: Optional[Dict] = None,
        session_counters: Optional[Dict] = None,
        skip_categories: Optional[Set[str]] = None,
    ) -> Tuple[str, Dict[str, "ReplacementRecord"], Dict, Dict, Dict[str, Any]]:
        """Async wrapper around :meth:`sanitize_with_metrics`."""
        return await asyncio.to_thread(
            self.sanitize_with_metrics,
            text,
            session_entity_registry,
            session_counters,
            skip_categories,
        )

    async def asanitize_batch(
        self,
        texts: List[str],
        *,
        session_entity_registry: Optional[Dict] = None,
        session_counters: Optional[Dict] = None,
        skip_categories: Optional[Set[str]] = None,
        share_registry: bool = False,
    ) -> List[Tuple[str, Dict[str, "ReplacementRecord"], Dict, Dict]]:
        """Async wrapper around :meth:`sanitize_batch`."""
        return await asyncio.to_thread(
            lambda: self.sanitize_batch(
                texts,
                session_entity_registry=session_entity_registry,
                session_counters=session_counters,
                skip_categories=skip_categories,
                share_registry=share_registry,
            )
        )

    def _build_stages(
        self,
        original_text: str,
        skip_categories: Optional[Set[str]],
        custom_terms: Optional[Mapping[str, str]] = None,
    ) -> List[Stage]:
        """Build stage objects for one sanitize call."""
        detectors: Optional[List[Detector]] = None
        if custom_terms:
            # Snapshot terms so concurrent calls cannot see each other's overrides.
            merged = {**self.custom_terms, **custom_terms}
            detectors = [
                CustomTermDetector(merged, self._custom_term_re_cache)
                if isinstance(d, CustomTermDetector)
                else d
                for d in self._stage1_detectors
            ]
        return [
            Stage1TokenDetection(
                self, skip_categories=skip_categories, detectors=detectors
            ),
            Stage2FinancialDetection(self),
        ]

    def _sanitize_impl(
        self,
        text: str,
        *,
        session_entity_registry: Optional[Dict] = None,
        session_counters: Optional[Dict] = None,
        skip_categories: Optional[Set[str]] = None,
        bucketize_financial: Optional[bool] = None,
        custom_terms: Optional[Mapping[str, str]] = None,
    ) -> "_SanitizeContext":
        """Run all stages and return the completed per-call context."""
        text_len = len(text)
        if text_len > self._max_input_chars:
            raise ValueError(
                f"Input text length {text_len:,} exceeds max_input_chars "
                f"({self._max_input_chars:,}). Split the input or raise "
                f"the cap via ConsistentSanitizer(max_input_chars=...)."
            )

        if session_entity_registry is not None:
            entity_registry = {
                k: dict(v) for k, v in session_entity_registry.items()
            }
            counters = dict(session_counters) if session_counters else {}
        else:
            entity_registry = {}
            counters = {}

        _bucketize = (
            self._bucketize_financial
            if bucketize_financial is None
            else bucketize_financial
        )
        # Resolve this call's FIN_AMOUNT mode.
        _mode = self._fin_amount_mode
        if _bucketize and _mode == "mask":
            _mode = "bucketize"
        ctx = _SanitizeContext(
            redacted=text,
            entity_registry=entity_registry,
            counters=counters,
            bucketize_financial=_bucketize,
            fin_amount_mode=_mode,
        )
        ctx.metrics["timings_ms"] = {}
        ctx.metrics["detection_counts"] = {}

        stages = self._build_stages(text, skip_categories, custom_terms)
        t_start = time.perf_counter()
        t_prev = t_start
        for stage in stages:
            stage.run(ctx)
            t_now = time.perf_counter()
            ctx.metrics["timings_ms"][stage.name] = (t_now - t_prev) * 1000.0
            t_prev = t_now
        ctx.metrics["timings_ms"]["total"] = (t_prev - t_start) * 1000.0
        ctx.metrics["detection_counts"]["total"] = len(ctx.replacements)

        if self._keep_legacy_mirrors:
            with self._mirror_lock:
                self.replacements = dict(ctx.replacements)
                self.entity_registry = {k: dict(v) for k, v in ctx.entity_registry.items()}
                self._counters = dict(ctx.counters)
        return ctx

    def get_health_metrics(self) -> Dict[str, int]:
        """Return a snapshot of operational counters."""
        with self._metrics_lock:
            return dict(self._operational_metrics)

    def clear_caches(self) -> None:
        """Clear the NER entity cache."""
        if self._ner is not None:
            self._ner.clear_cache()

    def sanitize_batch(
        self,
        texts: List[str],
        *,
        session_entity_registry: Optional[Dict] = None,
        session_counters: Optional[Dict] = None,
        skip_categories: Optional[Set[str]] = None,
        share_registry: bool = False,
    ) -> List[Tuple[str, Dict[str, "ReplacementRecord"], Dict, Dict]]:
        """Sanitize multiple texts, optionally sharing placeholder state.

        The method pre-warms NER and spaCy caches before processing
        each text. With ``share_registry=True``, each result feeds its registry
        and counters into the next text so placeholders stay consistent.
        """
        if not texts:
            return []

        # Pre-warm the NER cache.
        if self._ner is not None and self._ner.available:
            for text in texts:
                try:
                    self._ner.run_cached(text)
                except Exception as exc:
                    logger.warning("NER pre-warm failed: %s", exc)

        if self.use_spacy and self.nlp is not None:
            try:
                for _ in self.nlp.pipe(texts, batch_size=8):
                    pass
            except Exception as exc:
                logger.warning("spaCy pre-warm failed: %s", exc)

        results: List[Tuple[str, Dict[str, "ReplacementRecord"], Dict, Dict]] = []
        running_registry = session_entity_registry
        running_counters = session_counters

        for text in texts:
            redacted, replacements, updated_registry, updated_counters = self.sanitize(
                text,
                session_entity_registry=running_registry,
                session_counters=running_counters,
                skip_categories=skip_categories,
            )
            results.append((redacted, replacements, updated_registry, updated_counters))
            if share_registry:
                running_registry = updated_registry
                running_counters = updated_counters

        return results

    def restore(
        self,
        text: str,
        mode: str = "original",
        replacements: Optional[Dict[str, ReplacementRecord]] = None,
    ) -> str:
        """Restore placeholders using an explicit replacement registry.

        Omitting ``replacements`` falls back to the deprecated last-call mirror.
        Pass the registry returned by ``sanitize()`` for thread-safe restore.
        """
        if replacements is None:
            if not self._keep_legacy_mirrors:
                raise ValueError(
                    "restore() called without `replacements`, but this "
                    "sanitizer was constructed with keep_legacy_mirrors="
                    "False. Pass the registry returned by sanitize() "
                    "explicitly."
                )
            warnings.warn(
                "ConsistentSanitizer.restore() called without an explicit "
                "`replacements` argument. The instance mirror is shared "
                "across all sanitize() calls and is overwritten on every "
                "request — under concurrency this returns text restored "
                "against the WRONG registry. Pass the registry returned "
                "by sanitize() explicitly, or construct the sanitizer "
                "with keep_legacy_mirrors=False to forbid this path. "
                "The fallback will be removed in a future release.",
                DeprecationWarning,
                stacklevel=2,
            )
            with self._mirror_lock:
                replacements = dict(self.replacements)

        return _restore_text(text, replacements, mode=mode)
