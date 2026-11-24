"""Deterministic post-decode repairs for PPLX span boundaries/labels (target for chinese text)

PPLX's Viterbi decoder sometimes gets CJK/digit/punctuation junctions wrong:
- leading-digit truncation on phone/account_number/private_date spans
- over-capture of address filler words and phone label words
- account_number spans that actually contain a CJK character (e.g. vehicle plates)
- overlapping spans introduced by the repairs above
"""
from __future__ import annotations

import re
from dataclasses import replace

from text_protection._pplx_decoder import PredictedSpan

DIGIT_TRUNCATION_LABELS = {"private_phone", "account_number", "private_date"}
CN_MOBILE_RE = re.compile(r"(?:\+?86[- ]?)?1[3-9]\d{9}")
CN_PUNCT = "，。；：、,.;: \t\n"
ADDRESS_PREFIX_RE = re.compile(r"^.{0,6}?(?:住在|现住|家住|址在|位于|地址是|地址为|地址：|地址:)")
CJK_RE = re.compile(r"[\u4e00-\u9fff]")


def repair_digit_boundary(
    text: str, spans: list[PredictedSpan], max_extend: int = 3
) -> list[PredictedSpan]:
    """Repair digit spans that started too late.

    PPLX can begin phone, account, or date spans after the first few digits.
    This extends the span left across a nearby digit run. Phone spans are only
    extended when the resulting text still matches the Chinese mobile pattern.
    """
    repaired = []
    for s in spans:
        if s.label in DIGIT_TRUNCATION_LABELS and 0 < s.start < len(text) and text[s.start].isdigit():
            new_start = s.start
            steps = 0

            while new_start > 0 and text[new_start - 1].isdigit() and steps < max_extend:
                new_start -= 1
                steps += 1

            if new_start != s.start:
                candidate = text[new_start:s.end]
                # phone must validate against the mobile pattern; account/date accept the digit-run extension as-is
                if s.label != "private_phone" or CN_MOBILE_RE.search(candidate):
                    if s.label == "private_phone":
                        m = CN_MOBILE_RE.search(candidate)
                        new_start = new_start + m.start()
                    s = replace(s, start=new_start)

        repaired.append(s)  # keep every span, fixed or not

    return repaired


def trim_boundary_noise(text: str, spans: list[PredictedSpan]) -> list[PredictedSpan]:
    """Trim extra words or punctuation captured around addresses and phones.

    Address spans may include leading prompt words such as "address is" or
    trailing punctuation. Phone spans may include label text before the actual
    number. This keeps only the entity value while preserving the original label.
    """
    trimmed = []
    for s in spans:
        start, end = s.start, s.end

        if s.label == "private_address":
            m = ADDRESS_PREFIX_RE.match(text[start:end])
            if m:
                start += m.end()
            while end > start and text[end - 1] in CN_PUNCT:
                end -= 1

        elif s.label == "private_phone":
            digit_start = start
            while digit_start < end and not text[digit_start].isdigit():
                digit_start += 1
            candidate = text[digit_start:end]
            m = CN_MOBILE_RE.search(candidate)
            if m:
                start, end = digit_start + m.start(), digit_start + m.end()

        trimmed.append(replace(s, start=start, end=end) if (start, end) != (s.start, s.end) else s)
    return trimmed


def trim_account_number_cjk(text: str, spans: list[PredictedSpan]) -> list[PredictedSpan]:
    """Remove CJK characters from the edges of account-number spans.

    PPLX may include adjacent Chinese characters in an ``account_number`` span,
    for example around vehicle plates or mixed text. This trims only the span
    boundary; the label stays ``account_number``.
    """
    trimmed = []
    for s in spans:
        if s.label == "account_number":
            start, end = s.start, s.end
            while start < end and CJK_RE.match(text[start]):
                start += 1
            while end > start and CJK_RE.match(text[end - 1]):
                end -= 1
            if (start, end) != (s.start, s.end):
                s = replace(s, start=start, end=end)
        trimmed.append(s)
    return trimmed


def _span_is_valid(text: str, span: PredictedSpan) -> bool:
    """Return whether a repaired span still satisfies label-specific checks."""
    if span.label == "private_phone":
        return bool(CN_MOBILE_RE.fullmatch(text[span.start:span.end]))
    return True


def resolve_overlaps(text: str, spans: list[PredictedSpan]) -> list[PredictedSpan]:
    """Remove same-label overlaps introduced by earlier repairs.

    The Viterbi decoder itself emits non-overlapping spans. If repairs create an
    overlap, keep the span that passes validation; if both pass or both fail,
    keep the longer span.
    """
    drop: set[int] = set()
    for i, a in enumerate(spans):
        for j in range(i + 1, len(spans)):
            b = spans[j]
            if a.label != b.label or i in drop or j in drop:
                continue
            if a.start < b.end and b.start < a.end:
                a_ok, b_ok = _span_is_valid(text, a), _span_is_valid(text, b)
                if a_ok != b_ok:
                    drop.add(j if a_ok else i)
                else:
                    drop.add(i if (a.end - a.start) < (b.end - b.start) else j)
    return [s for k, s in enumerate(spans) if k not in drop]


def apply_pplx_repairs(text: str, spans: list[PredictedSpan]) -> list[PredictedSpan]:
    """Apply all deterministic PPLX span repairs in dependency order.

    The order matters: first widen truncated digit spans, then trim noisy
    boundaries, then remove CJK edges from account numbers, and finally clean
    up any overlaps created by those edits.
    """
    spans = repair_digit_boundary(text, spans)
    spans = trim_boundary_noise(text, spans)
    spans = trim_account_number_cjk(text, spans)
    spans = resolve_overlaps(text, spans)
    return spans
