"""Query rewriter — replaces real entity values with their registered placeholders.

Used before sending a user prompt to a downstream model so that real PII does
not leak into the prompt. Operates on a forward registry produced by the
masker. Runs up to three tiers, each considering only entities the prior tier
missed:

1. Exact, case-sensitive substring match (longest-first, single-pass
   alternation regex — avoids partial collisions like ``"Berlin"`` matching
   before ``"Berlin Auto Parts Inc."``, and avoids re-scanning a span this
   pass already replaced).
2. Case-insensitive exact substring match. Always runs. Catches casing drift
   such as ``"ALICE"`` or ``"alice"`` against a registry original of
   ``"Alice"``.
3. Fuzzy single-token match via ``rapidfuzz``. Opt-in (``fuzzy_enabled``).
   Catches typos/misspellings of single-word entities (e.g. ``"Alise"``
   against registry ``"Alice"``). Multi-word originals (e.g. company names)
   are not fuzzy-matched — tiers 1-2 are expected to catch those, since a
   fuzzy phrase match has a much higher false-positive cost.

Each tier operates on the previous tier's output, so a placeholder emitted
by an earlier tier is never re-scanned by a later one (placeholders like
``<PERSON_1>`` do not coincidentally match real entity values).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Mapping

from file_protection.registry import invert_registry

try:
    from rapidfuzz import fuzz as _rapidfuzz_fuzz
except ImportError:  # pragma: no cover - rapidfuzz is a declared dependency
    _rapidfuzz_fuzz = None

# Minimum token length considered for fuzzy matching. Shorter tokens (e.g.
# "the", "and") produce too many high-scoring coincidental matches against
# short registry entries.
_FUZZY_MIN_TOKEN_LEN = 4

# A whole word/underscore/digit run of at least _FUZZY_MIN_TOKEN_LEN
# characters. Used to find fuzzy-match candidates and to skip tokens that are
# already bracketed placeholders (e.g. <PERSON_1>).
_TOKEN_RE = re.compile(rf"\b\w{{{_FUZZY_MIN_TOKEN_LEN},}}\b")


@dataclass
class RewriteResult:
    rewritten: str
    substitutions: int


def _is_already_placeholder(text: str, start: int, end: int) -> bool:
    """True if the token at ``[start, end)`` is already bracketed, e.g. ``<PERSON_1>``."""
    return start > 0 and end < len(text) and text[start - 1] == "<" and text[end] == ">"


def _case_insensitive_pass(
    query: str, inv: Mapping[str, str], candidates: list[str]
) -> tuple[str, int, set[str]]:
    """Replace remaining originals in ``query`` ignoring case, longest-first.

    Returns:
        tuple: Rewritten text, substitution count, and the set of registry
        originals that had at least one match (used to exclude them from the
        next tier).
    """
    ordered = sorted(candidates, key=len, reverse=True)
    pattern = re.compile("|".join(re.escape(c) for c in ordered), re.IGNORECASE)
    count = 0
    matched_originals: set[str] = set()

    def _sub(match: "re.Match[str]") -> str:
        nonlocal count
        count += 1
        matched_text = match.group(0)
        for orig in ordered:
            if orig.lower() == matched_text.lower():
                matched_originals.add(orig)
                return inv[orig]
        return matched_text  # unreachable: pattern was built from `ordered`

    out = pattern.sub(_sub, query)
    return out, count, matched_originals


def _fuzzy_pass(
    query: str,
    inv: Mapping[str, str],
    candidates: list[str],
    threshold: float,
) -> tuple[str, int]:
    """Best-effort single-token fuzzy match for remaining originals.

    Only considers single-word registry originals of at least
    ``_FUZZY_MIN_TOKEN_LEN`` characters, and skips tokens that are already
    bracketed placeholders. No-ops if ``rapidfuzz`` is not installed.
    """
    if _rapidfuzz_fuzz is None or not candidates:
        return query, 0
    single_word = [c for c in candidates if " " not in c and len(c) >= _FUZZY_MIN_TOKEN_LEN]
    if not single_word:
        return query, 0

    count = 0
    pieces: list[str] = []
    last = 0
    for m in _TOKEN_RE.finditer(query):
        if _is_already_placeholder(query, m.start(), m.end()):
            continue
        token = m.group(0)
        best_orig: str | None = None
        best_score = 0.0
        for orig in single_word:
            score = _rapidfuzz_fuzz.ratio(token.lower(), orig.lower())
            if score > best_score:
                best_score = score
                best_orig = orig
        if best_orig is not None and best_score >= threshold:
            pieces.append(query[last : m.start()])
            pieces.append(inv[best_orig])
            last = m.end()
            count += 1
    pieces.append(query[last:])
    return "".join(pieces), count


def rewrite_query(
    query: str,
    registry: Mapping[str, str],
    *,
    inverted: Mapping[str, str] | None = None,
    fuzzy_enabled: bool = False,
    fuzzy_threshold: float = 92.0,
) -> RewriteResult:
    """Replace original entity values in ``query`` with their placeholders.

    Args:
        query: Original user query (free-form text).
        registry: Forward registry ``{placeholder: original}`` produced by the
            masker.
        inverted: Optional pre-computed ``{original: placeholder}`` map. Pass
            this when rewriting many queries against the same registry to skip
            the inversion cost. If omitted, it is built from ``registry``.
        fuzzy_enabled: Enable the fuzzy (tier 3) pass. Off by default.
        fuzzy_threshold: Minimum rapidfuzz ``ratio()`` score (0-100) for a
            fuzzy match to be accepted. Ignored when ``fuzzy_enabled`` is False.

    Returns:
        :class:`RewriteResult` containing the rewritten query and the number
        of substitutions made. If no entity values appear in the query, the
        rewritten query equals the original.
    """
    if not isinstance(query, str):
        raise TypeError(f"query must be str; got {type(query).__name__}")

    if not registry and not inverted:
        return RewriteResult(rewritten=query, substitutions=0)

    inv: Mapping[str, str] = inverted if inverted is not None else invert_registry(registry)

    # Tier 1: exact, case-sensitive substring match. Only entities that
    # actually appear in `query` matter — avoids compiling a giant alternation
    # when most entities are absent (the common case for short user queries).
    exact_candidates = [orig for orig in inv if orig and orig in query]
    matched: set[str] = set(exact_candidates)
    substitutions = 0
    out = query

    if exact_candidates:
        # Longest-first alternation. Python's regex engine tries alternatives
        # left-to-right and commits to the first match, so sorting by length
        # descending ensures "Berlin Auto Parts Inc." beats a shorter "Berlin"
        # at the same position.
        ordered = sorted(exact_candidates, key=len, reverse=True)
        pattern = re.compile("|".join(re.escape(c) for c in ordered))

        def _sub(match: "re.Match[str]") -> str:
            nonlocal substitutions
            substitutions += 1
            # ``inv[match.group(0)]`` is guaranteed to exist: the alternation
            # was built from ``ordered`` which came from ``inv`` keys.
            return inv[match.group(0)]

        out = pattern.sub(_sub, out)

    # Tier 2: case-insensitive exact match, for entities Tier 1 missed. Always on.
    ci_candidates = [orig for orig in inv if orig and orig not in matched]
    if ci_candidates:
        out, ci_count, ci_matched = _case_insensitive_pass(out, inv, ci_candidates)
        substitutions += ci_count
        matched.update(ci_matched)

    # Tier 3: fuzzy, single-word, opt-in.
    if fuzzy_enabled:
        fuzzy_candidates = [orig for orig in inv if orig and orig not in matched]
        if fuzzy_candidates:
            out, fuzzy_count = _fuzzy_pass(out, inv, fuzzy_candidates, fuzzy_threshold)
            substitutions += fuzzy_count

    return RewriteResult(rewritten=out, substitutions=substitutions)
