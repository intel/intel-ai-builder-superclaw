"""Stage-1 PII detectors.

Each detector returns candidate spans from one source, such as custom terms,
regex, PPLX NER, or spaCy. Stage 1 later merges those spans by priority and
specificity.

Span shape: ``(priority, specificity, start, end, label, value)``.
"""

from __future__ import annotations

import logging
import re
from typing import Dict, Iterable, List, Optional, Protocol, Tuple, TYPE_CHECKING

from text_protection._ner_postprocessing import (
    AMBIGUOUS_NAME_VERBS as _AMBIGUOUS_NAME_VERBS,
    NAME_LEFT_STOP_WORDS as _NAME_LEFT_STOP_WORDS,
    NEVER_PERSON_TOKENS as _NEVER_PERSON_TOKENS,
    ORG_LEADING_STOP_WORDS as _ORG_LEADING_STOP_WORDS,
    extend_person_span_left as _extend_person_span_left,
    extend_person_span_right as _extend_person_span_right,
    is_sentence_start as _is_sentence_start,
    is_spacy_org_false_positive as _is_spacy_org_false_positive,
    is_standalone_line as _is_standalone_line,
    repair_word_boundary_left as _repair_word_boundary_left,
    strip_leading_stop_words as _strip_leading_stop_words,
    strip_person_trailing_stop as _strip_person_trailing_stop,
    trim_span as _trim_span,
)
from common.validators import is_column_identifier as _is_column_identifier
from text_protection._sanitizer_caches import LRUCache


if TYPE_CHECKING:
    from text_protection._pplx_pipeline import PplxNerPipeline


logger = logging.getLogger(__name__)


# (priority, specificity, start, end, label, val)
Stage1Span = Tuple[int, int, int, int, str, str]


class Detector(Protocol):
    """Collector for one source of stage-1 candidate spans."""

    def collect(self, redacted: str) -> Iterable[Stage1Span]: ...


_USE_CAPTURED_GROUP = frozenset({
    "API_KEY", "ZIP_CODE", "ORG_NAME", "ROLE_PERSON", "COUNTY_NAME",
})


class CustomTermDetector:
    """User-defined terms. Priority 0, highest precedence."""

    priority = 0
    specificity = 0

    def __init__(
        self,
        custom_terms: Dict[str, str],
        compile_cache: LRUCache[str, "re.Pattern[str]"],
    ) -> None:
        self._custom_terms = custom_terms
        self._compile_cache = compile_cache

    def collect(self, redacted: str) -> Iterable[Stage1Span]:
        spans: List[Stage1Span] = []
        for term, cat in self._custom_terms.items():
            compiled = self._compile_cache.get(term)
            if compiled is None:
                compiled = re.compile(re.escape(term), flags=re.IGNORECASE)
                self._compile_cache.put(term, compiled)
            for m in compiled.finditer(redacted):
                spans.append((self.priority, self.specificity, m.start(), m.end(), cat, m.group(0)))
        return spans


class RegexDetector:
    """Per-label regex PII patterns. Priority 2."""

    priority = 2

    def __init__(
        self,
        compiled_patterns: Dict[str, "re.Pattern[str]"],
        label_spec: Dict[str, int],
    ) -> None:
        self._compiled = compiled_patterns
        self._label_spec = label_spec

    def collect(self, redacted: str) -> Iterable[Stage1Span]:
        spans: List[Stage1Span] = []
        label_spec = self._label_spec
        for label, compiled in self._compiled.items():
            spec = label_spec.get(label, 9)
            use_group = label in _USE_CAPTURED_GROUP
            for m in compiled.finditer(redacted):
                if use_group and m.lastindex:
                    s, e = m.start(1), m.end(1)
                else:
                    s, e = m.start(), m.end()
                s, e = _trim_span(redacted, s, e)
                if s >= e:
                    continue
                spans.append((self.priority, spec, s, e, label, redacted[s:e]))
        return spans


class FinancialRegexDetector:
    """Financial regexes such as FIN_AMOUNT and PERCENT. Priority 2."""

    priority = 2
    specificity = 0

    def __init__(self, compiled_patterns: Dict[str, "re.Pattern[str]"]) -> None:
        self._compiled = compiled_patterns

    def collect(self, redacted: str) -> Iterable[Stage1Span]:
        spans: List[Stage1Span] = []
        for label, compiled in self._compiled.items():
            for m in compiled.finditer(redacted):
                spans.append((self.priority, self.specificity, m.start(), m.end(), label, m.group(0)))
        return spans


class NerDetector:
    """PPLX NER spans. Priority 1, before regex and spaCy.

    PPLX returns repaired spans, so this detector only converts them to the
    stage-1 tuple shape. Format-validated regex categories can still override
    PPLX later; see the trusted-regex rule in ``_stages.py``.
    """

    priority = 1
    specificity = 0

    def __init__(
        self,
        ner_pipeline: Optional["PplxNerPipeline"],
        label_category_map: Dict[str, str],
    ) -> None:
        self._ner = ner_pipeline
        self._label_category_map = label_category_map

    def collect(self, redacted: str) -> Iterable[Stage1Span]:
        spans: List[Stage1Span] = []
        if self._ner is None or not self._ner.available:
            return spans
        triplets = self._ner.collect_spans(redacted, self._label_category_map)
        for s, e, label in triplets:
            spans.append((self.priority, self.specificity, s, e, label, redacted[s:e]))
        return spans


class SpacyDetector:
    """spaCy PERSON/ORG fallback. Priority 3, lowest precedence.

    When ``english_only`` is true, spaCy runs only on English-looking text to
    avoid over-redacting non-English prose. PPLX still runs on all text.
    """

    priority = 3
    specificity = 0

    def __init__(self, nlp: object, use_spacy: bool,
                 english_only: bool = False) -> None:
        self._nlp = nlp
        self._use_spacy = use_spacy
        self._english_only = english_only

    def collect(self, redacted: str) -> Iterable[Stage1Span]:
        spans: List[Stage1Span] = []
        if not (self._use_spacy and self._nlp is not None):
            return spans
        if self._english_only:
            from common.textlang import looks_english
            if not looks_english(redacted):
                return spans
        try:
            doc = self._nlp(redacted)
        except Exception as exc:
            logger.warning("spaCy NER fallback failed: %s", exc)
            return spans
        for ent in doc.ents:
            if ent.label_ not in {"PERSON", "ORG"}:
                continue
            s, e = _trim_span(redacted, ent.start_char, ent.end_char)
            s = _repair_word_boundary_left(redacted, s)
            if s >= e:
                continue
            span_text = redacted[s:e]
            if (
                ent.label_ == "ORG"
                and _is_spacy_org_false_positive(span_text)
            ):
                continue
            if ent.label_ == "PERSON":
                if (
                    span_text in _AMBIGUOUS_NAME_VERBS
                    and _is_sentence_start(redacted, s)
                ):
                    continue
                e = _extend_person_span_right(redacted, s, e, [])
                s = _extend_person_span_left(redacted, s, e, [])
                s = _strip_leading_stop_words(redacted, s, e, _NAME_LEFT_STOP_WORDS)
                e = _strip_person_trailing_stop(redacted, s, e)
                if s >= e:
                    continue
                span_text = redacted[s:e]
                if not all(
                    ch.isalpha() or ch.isspace() or ch in "-'."
                    for ch in span_text
                ):
                    continue
                if (
                    " " not in span_text
                    and span_text in _NEVER_PERSON_TOKENS
                ):
                    continue
                if _is_column_identifier(span_text) and _is_standalone_line(
                    redacted, s, e
                ):
                    continue
            elif ent.label_ == "ORG":
                s = _strip_leading_stop_words(redacted, s, e, _ORG_LEADING_STOP_WORDS)
                if s >= e:
                    continue
                span_text = redacted[s:e]
                if _is_spacy_org_false_positive(span_text):
                    continue
            spans.append((self.priority, self.specificity, s, e, ent.label_, span_text))
        return spans
