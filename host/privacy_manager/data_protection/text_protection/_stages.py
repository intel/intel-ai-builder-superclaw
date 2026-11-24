"""Pipeline stages used by ``ConsistentSanitizer``.

Each stage mutates the per-call ``_SanitizeContext`` in place. The sanitizer
runs these stages in order and records timing around each one.

Stages:
* ``Stage1TokenDetection``: custom terms, regex, PPLX NER, and spaCy spans.
* ``Stage2FinancialDetection``: finance amount and keyword regexes.
"""

from __future__ import annotations

import bisect
import logging
import re
from typing import Any, Dict, List, Optional, Protocol, Set, Tuple, TYPE_CHECKING

from text_protection._detectors import Detector, Stage1Span
from text_protection._ner_postprocessing import (
    is_name_extension as _is_name_extension,
)
from text_protection._pplx_decoder import PII_TYPES as _PPLX_RAW_LABELS


# Regex hits in these categories are format-validated and more precise than
# broad PPLX labels, so they may override an already accepted PPLX span.
_TRUSTED_REGEX_CATEGORIES = frozenset({"ID", "SECRET", "FINANCIAL"})


if TYPE_CHECKING:
    from text_protection.sanitizer import (
        ConsistentSanitizer,
        ReplacementRecord,
        _SanitizeContext,
    )


logger = logging.getLogger(__name__)


class Stage(Protocol):
    name: str
    def run(self, ctx: "_SanitizeContext") -> None: ...


class Stage1TokenDetection:
    """Stage 1: detect and mask token-level PII.

    Workflow:
    1. Run every stage-1 detector on the current text: custom terms, regex,
       PPLX NER, and spaCy.
    2. Drop spans whose label or category is configured to be skipped.
    3. Sort spans by detector priority, label specificity, and start offset.
    4. Resolve overlaps. Higher-priority spans usually win; trusted regex
       identifiers may override broad PPLX spans; lower-priority name spans
       must look like valid name extensions.
    5. Splice placeholders from right to left so earlier offsets stay valid.
    6. Record token replacements and update ``ctx.prev_match`` so later stages
       do not remask text already replaced here.
    """

    name = "stage1"

    def __init__(
        self,
        sanitizer: "ConsistentSanitizer",
        skip_categories: Optional[Set[str]] = None,
        detectors: Optional[List[Detector]] = None,
    ) -> None:
        self._sanitizer = sanitizer
        self._skip_categories = skip_categories
        # ``None`` means use the sanitizer's shared detector list.
        self._detectors = detectors

    def run(self, ctx: "_SanitizeContext") -> None:
        from text_protection.sanitizer import ReplacementRecord

        sanitizer = self._sanitizer
        redacted = ctx.redacted
        detectors = (
            self._detectors
            if self._detectors is not None
            else sanitizer._stage1_detectors
        )
        stage1_spans: List[Stage1Span] = []
        for detector in detectors:
            stage1_spans.extend(detector.collect(redacted))

        skip_categories = self._skip_categories
        label_category_map = sanitizer.LABEL_CATEGORY_MAP

        stage1_spans.sort(key=lambda s: (s[0], s[1], s[2]))
        stage1_records: List[Tuple[int, int, str, str, int]] = []
        stage1_starts: List[int] = []
        for prio, _spec, start, end, label, val in stage1_spans:
            if skip_categories and (
                label in skip_categories
                or label_category_map.get(label, label) in skip_categories
            ):
                continue
            cand_cat = label_category_map.get(label, label)
            n_acc = len(stage1_starts)
            ins = bisect.bisect_left(stage1_starts, start)
            lo = ins
            if lo > 0 and stage1_records[lo - 1][1] > start:
                lo -= 1
            hi = ins
            while hi < n_acc and stage1_starts[hi] < end:
                hi += 1
            if lo < hi:
                can_replace_all = True
                for i in range(lo, hi):
                    a_s, a_e, a_label, _a_val, a_prio = stage1_records[i]
                    a_cat = label_category_map.get(a_label, a_label)
                    # Let precise regex identifiers override broad PPLX spans,
                    # even when both map to the same category. This must run
                    # before the same-category length check below.
                    if (
                        cand_cat in _TRUSTED_REGEX_CATEGORIES
                        and a_label in _PPLX_RAW_LABELS
                    ):
                        continue
                    if a_cat != cand_cat:
                        can_replace_all = False
                        break
                    if (a_e - a_s) >= (end - start):
                        can_replace_all = False
                        break
                    if prio <= a_prio:
                        continue
                    if not (start <= a_s and end >= a_e):
                        can_replace_all = False
                        break
                    if not _is_name_extension(redacted, start, end, a_s, a_e):
                        can_replace_all = False
                        break

                if not can_replace_all:
                    continue
                del stage1_records[lo:hi]
                del stage1_starts[lo:hi]
                ins = lo

            stage1_records.insert(ins, (start, end, label, val, prio))
            stage1_starts.insert(ins, start)

        new_placeholders: Dict[int, str] = {}
        for start, end, label, val, _prio in reversed(stage1_records):
            ph = sanitizer._get_or_create_placeholder(label, val, ctx=ctx)
            redacted = redacted[:start] + ph + redacted[end:]
            new_placeholders[start] = ph
            if ph not in ctx.replacements:
                ctx.replacements[ph] = ReplacementRecord(
                    original=val,
                    redacted=ph,
                    type="token",
                    meta={
                        "label": label,
                        "category": label_category_map.get(label, label),
                    },
                )

        delta = 0
        prev_match: List[Tuple[int, int]] = []
        for start, end, _label, _val, _prio in stage1_records:
            ph = new_placeholders[start]
            new_start = start + delta
            new_end = new_start + len(ph)
            prev_match.append((new_start, new_end))
            delta += len(ph) - (end - start)

        ctx.redacted = redacted
        ctx.prev_match = prev_match


class Stage2FinancialDetection:
    """Stage 2: detect and mask finance-specific token spans.

    Workflow:
    1. Scan the stage-1-redacted text for compiled financial amount patterns
       and finance keywords.
    2. Ignore matches that overlap ``ctx.prev_match`` from earlier stages.
    3. Apply ``fin_amount_mode`` for monetary amounts: leave them unmasked,
       bucketize them by magnitude, or mask them as plain FINANCIAL values.
    4. Splice placeholders into the text and record token replacements.
    5. Merge the new placeholder ranges back into ``ctx.prev_match`` for any
       later stage.
    """

    name = "stage2"

    def __init__(self, sanitizer: "ConsistentSanitizer") -> None:
        self._sanitizer = sanitizer

    def run(self, ctx: "_SanitizeContext") -> None:
        from text_protection.sanitizer import ReplacementRecord
        from common.bucketize import bucketize_label

        sanitizer = self._sanitizer
        compiled_patterns: List[Tuple[str, "re.Pattern[str]"]] = [
            (label, compiled)
            for label, compiled in sanitizer._compiled_financial_patterns.items()
        ]
        compiled_patterns.extend(
            ("FIN_TERM", compiled)
            for compiled in sanitizer._compiled_financial_keywords.values()
        )

        for placeholder_label, compiled in compiled_patterns:
            redacted = ctx.redacted
            matches = list(compiled.finditer(redacted))
            if not matches:
                continue
            new_inserts: List[Tuple[int, int, str]] = []
            for m in sorted(matches, key=lambda x: x.start(), reverse=True):
                start, end = m.span()
                if sanitizer.previous_matched(start, end, ctx.prev_match):
                    continue
                val = m.group(0)
                # FIN_AMOUNT modes: off leaves amounts unmasked, bucketize keeps
                # magnitude only, and mask uses a plain FINANCIAL placeholder.
                # Other finance labels are not affected by fin_amount_mode.
                if placeholder_label == "FIN_AMOUNT" and ctx.fin_amount_mode == "off":
                    continue
                bucket_meta: dict = {}
                effective_label = placeholder_label
                if placeholder_label == "FIN_AMOUNT" and ctx.fin_amount_mode == "bucketize":
                    bucket_category, bucket_meta = bucketize_label(val, base="FINANCIAL")
                    effective_label = bucket_category
                ph = sanitizer._get_or_create_placeholder(effective_label, val, ctx=ctx)
                redacted = redacted[:start] + ph + redacted[end:]
                new_inserts.append((start, end, ph))
                if ph not in ctx.replacements:
                    meta = {
                        "label": placeholder_label,
                        "category": "FINANCIAL" if bucket_meta else (
                            sanitizer.LABEL_CATEGORY_MAP.get(
                                placeholder_label, placeholder_label
                            )
                        ),
                    }
                    if bucket_meta:
                        meta["bucket"] = bucket_meta.get("bucket")
                        meta["magnitude"] = bucket_meta.get("magnitude")
                    ctx.replacements[ph] = ReplacementRecord(
                        original=val,
                        redacted=ph,
                        type="token",
                        meta=meta,
                    )

            if not new_inserts:
                continue

            new_inserts_asc = sorted(new_inserts, key=lambda t: t[0])
            merged: List[Tuple[int, int]] = []
            old = list(ctx.prev_match)
            old_idx = 0
            delta = 0
            for ins_s, ins_e, ph in new_inserts_asc:
                while old_idx < len(old) and old[old_idx][1] <= ins_s:
                    os, oe = old[old_idx]
                    merged.append((os + delta, oe + delta))
                    old_idx += 1
                new_start = ins_s + delta
                new_end = new_start + len(ph)
                merged.append((new_start, new_end))
                delta += len(ph) - (ins_e - ins_s)
            while old_idx < len(old):
                os, oe = old[old_idx]
                merged.append((os + delta, oe + delta))
                old_idx += 1

            ctx.redacted = redacted
            ctx.prev_match = merged
