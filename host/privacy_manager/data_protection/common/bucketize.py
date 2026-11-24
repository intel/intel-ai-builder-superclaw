"""Magnitude bucketization for financial amounts.

When enabled, a detected monetary amount is redacted to a placeholder
whose *label* carries the order of magnitude — e.g. ``$5,234`` becomes
``<FINANCIAL_THOUSANDS_1>`` — while the registry still holds the exact
original value so ``/v1/restore`` returns ``$5,234`` unchanged.

Rationale: an LLM often needs the *scale* of a figure to reason ("is this
a big deal?") but never the exact digits. Bucketizing the placeholder
label leaks only the power-of-ten, not the value.

This module is pure and dependency-free (stdlib only) so BOTH pipelines
share one parser + bucket table. It does NOT decide *whether* to
bucketize (that's the caller's knob) — it only maps an amount string to a
``(bucket_name, magnitude)`` pair and builds the labeled category.

Bucket scheme — powers of ten, named for the largest that fits:

    < 10            ONES
    10 .. 99        TENS
    100 .. 999      HUNDREDS
    1e3 .. 1e6-1    THOUSANDS
    1e6 .. 1e9-1    MILLIONS
    1e9 .. 1e12-1   BILLIONS
    >= 1e12         TRILLIONS

A value we can't parse to a number falls back to the un-bucketed
``FINANCIAL`` category so it is still redacted (never silently dropped).
"""

from __future__ import annotations

import re
from typing import Optional

# Magnitude-word and single-letter suffixes -> multiplier.
_MAGNITUDE_WORDS: dict[str, float] = {
    "thousand": 1e3, "k": 1e3,
    "million": 1e6, "m": 1e6, "mm": 1e6,
    "billion": 1e9, "b": 1e9, "bn": 1e9,
    "trillion": 1e12, "t": 1e12,
}

# Ordered high-to-low so the first threshold a value clears wins.
_BUCKETS: tuple[tuple[str, float], ...] = (
    ("TRILLIONS", 1e12),
    ("BILLIONS", 1e9),
    ("MILLIONS", 1e6),
    ("THOUSANDS", 1e3),
    ("HUNDREDS", 1e2),
    ("TENS", 1e1),
    ("ONES", 0.0),
)

# The set of bucket names, exposed so callers (category validation,
# placeholder-shape checks) can recognize a bucketized FINANCIAL label.
BUCKET_NAMES: frozenset[str] = frozenset(name for name, _ in _BUCKETS)

# Strip these before numeric parsing: currency symbols/codes and grouping.
_CURRENCY_RE = re.compile(
    r"(?i)\b(?:USD|EUR|GBP|JPY|CHF|CAD|AUD|HKD|CNY)\b|[\$€£¥]"
)
_MAGNITUDE_TAIL_RE = re.compile(
    r"(?i)\s*(thousand|million|billion|trillion|mm|bn|[mbkt])\s*$"
)
# A bare number with optional decimal, after separators are removed.
_NUMBER_RE = re.compile(r"\d+(?:\.\d+)?")


def parse_amount(text: str) -> Optional[float]:
    """Parse a monetary amount string to a float, or ``None`` if unparseable.

    Handles currency prefixes ("$", "USD "), thousands separators
    ("12,500,000" or "12 500 000"), decimals, and magnitude words /
    letters ("5M", "2 million", "12.5 trillion"). Returns the absolute
    numeric value; a leading sign is ignored (magnitude only).
    """
    if not text:
        return None
    s = text.strip()

    # Extract a trailing magnitude word/letter BEFORE stripping currency,
    # so a lone "M"/"K" attached to the number (e.g. "$5M") is captured.
    multiplier = 1.0
    m = _MAGNITUDE_TAIL_RE.search(s)
    if m:
        word = m.group(1).lower()
        mult = _MAGNITUDE_WORDS.get(word)
        # A trailing single letter is only a magnitude if it's a known one
        # (M/B/K/T); otherwise leave the string alone.
        if mult is not None:
            multiplier = mult
            s = s[: m.start()]

    s = _CURRENCY_RE.sub("", s)
    # Remove thousands separators (comma or whitespace between digit groups).
    s = re.sub(r"(?<=\d)[,\s](?=\d)", "", s)

    num_match = _NUMBER_RE.search(s)
    if not num_match:
        return None
    try:
        value = float(num_match.group(0))
    except ValueError:
        return None
    return value * multiplier


def bucket_for(value: float) -> str:
    """Return the bucket NAME for a non-negative numeric ``value``."""
    v = abs(value)
    for name, threshold in _BUCKETS:
        if v >= threshold:
            return name
    return "ONES"  # unreachable (ONES threshold is 0.0) — defensive


def bucket_category(value: Optional[float], base: str = "FINANCIAL") -> str:
    """Build the bucketized category label for a parsed amount.

    ``bucket_category(5234)`` -> ``"FINANCIAL_THOUSANDS"``. When ``value``
    is ``None`` (unparseable), returns the plain ``base`` category so the
    amount is still redacted without a magnitude suffix.
    """
    if value is None:
        return base
    return f"{base}_{bucket_for(value)}"


def bucketize_label(amount_text: str, base: str = "FINANCIAL") -> tuple[str, dict]:
    """Convenience: parse ``amount_text`` and return ``(category, meta)``.

    ``meta`` carries ``bucket`` (name or ``None``) and ``magnitude`` (the
    bucket's lower power-of-ten threshold, or ``None``) for observability
    and for a possible future bucket-restore mode. The exact value is NOT
    put in meta here — the caller records the original separately so
    restore stays exact.
    """
    value = parse_amount(amount_text)
    if value is None:
        return base, {"bucket": None, "magnitude": None}
    name = bucket_for(value)
    magnitude = next(thr for n, thr in _BUCKETS if n == name)
    return f"{base}_{name}", {"bucket": name, "magnitude": magnitude}
