"""Column-level PII auto-detection.

Three-signal offline detector. No model downloads, no network calls.

  - **Tier 1 (header):** substring match on column names against a curated
    keyword map, plus *negative* signals that suppress ambiguous matches
    (``product_name`` should not read as PERSON just because it contains
    "name").
  - **Tier 2 (content):** sample distinct non-null cell values per column
    and accumulate weighted votes across validators (checksum-backed
    formats weigh more than shape-only patterns), so a column that is
    mostly one format still surfaces at a confidence scaled to its hit
    ratio.
  - **Tier 3 (structural):** cheap signals derived from the frame itself —
    per-column uniqueness ratio and cross-column co-occurrence (e.g.
    ``first_name`` + ``last_name`` corroborate each other; a
    low-cardinality column is unlikely to be an ID).

Each column yields a ``ColumnSuggestion`` with a confidence in ``[0, 1]``,
the signals that fired, and human-readable reasons. Categories are emitted
in the canonical vocabulary (see ``validators.canonical_category``).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Iterable, Mapping, Optional, Protocol, Sequence

from file_protection.gazetteer import has_known_first_name
from common.validators import (
    CONTENT_DETECTORS,
    canonical_category,
    is_org_like,
    is_person_like,
)

# --------------------------------------------------------------------------
# Tier 1 — header heuristics
# --------------------------------------------------------------------------

# Mapping of category -> ordered list of (substring, confidence) pairs. The
# first matching substring wins; substrings should be lowercase. Confidence
# expresses how unambiguous the column-name signal alone is — "ssn" → 0.99
# because there is no other plausible meaning, "name" → 0.6 because it could
# be a product name. Categories use the canonical vocabulary.

HEADER_HINTS: dict[str, tuple[tuple[str, float], ...]] = {
    "EMAIL": (
        ("email", 0.99), ("e_mail", 0.99), ("e-mail", 0.99),
        ("mail", 0.85),
    ),
    "PHONE": (
        ("phone", 0.95), ("mobile", 0.95), ("tel", 0.85),
        ("fax", 0.9), ("contact_number", 0.9),
    ),
    "ID": (
        ("ssn", 0.99), ("social_security", 0.99),
        ("nric", 0.99), ("passport", 0.95), ("national_id", 0.95),
        ("tax_id", 0.95), ("taxid", 0.95), ("driver_license", 0.95),
        ("license_no", 0.85), ("id_number", 0.9), ("id_num", 0.9),
        ("identity", 0.8),
    ),
    "PERSON": (
        ("full_name", 0.95), ("first_name", 0.95), ("last_name", 0.95),
        ("given_name", 0.95), ("surname", 0.95), ("contact_name", 0.95),
        ("contact_person", 0.9), ("customer_name", 0.85), ("user_name", 0.7),
        ("name", 0.6),
    ),
    "ORG": (
        ("company_name", 0.95), ("organization", 0.95), ("organisation", 0.95),
        ("employer", 0.85), ("company", 0.8), ("account_name", 0.7),
        ("vendor", 0.65), ("supplier", 0.65),
    ),
    "STREET": (
        ("street_address", 0.95), ("street", 0.85), ("address_line", 0.95),
        ("address", 0.85),
    ),
    "ZIPCODE": (
        ("postal_code", 0.9), ("postcode", 0.9), ("zip_code", 0.9), ("zip", 0.7),
    ),
    "CITY": (
        ("city", 0.55),
    ),
    "FINANCIAL": (
        ("account_no", 0.9), ("account_number", 0.9), ("acct_no", 0.85),
        ("iban", 0.99), ("swift", 0.85), ("card_number", 0.95),
        ("credit_card", 0.95),
    ),
    "URL": (
        ("url", 0.85), ("website", 0.7), ("homepage", 0.7),
    ),
}

# Negative header signals: a substring that, when present, strongly
# suggests the column is NOT the mapped category even if a positive hint
# also matched. Keyed by the category being *suppressed*. This is what
# stops ``product_name`` / ``file_name`` / ``brand_name`` from reading as
# PERSON off the bare "name" substring.
NEGATIVE_HEADER_HINTS: dict[str, tuple[str, ...]] = {
    "PERSON": (
        "product", "file", "brand", "field", "column", "table", "domain",
        "host", "server", "service", "event", "project", "class", "type",
        "code", "tag", "role", "group", "team", "path", "screen", "page",
        "node", "job", "task", "model", "device", "app", "package",
    ),
    "ORG": (
        "product", "file", "brand", "event", "project",
    ),
}


def _normalize_header(name: str) -> str:
    """Lowercase + replace spaces / hyphens with underscores for matching."""
    return re.sub(r"[\s\-]+", "_", str(name).strip().lower())


def _is_negatively_suppressed(normalized_header: str, category: str) -> bool:
    """True if ``category`` is vetoed for this header by a negative signal.

    Applies regardless of whether the category was proposed by the header
    or the content signal — a column literally named ``product_name`` must
    never be classified PERSON even if its values look name-like. Compared
    against the canonical category so aliases resolve consistently.
    """
    for suppressed_cat, negatives in NEGATIVE_HEADER_HINTS.items():
        if canonical_category(suppressed_cat) != canonical_category(category):
            continue
        if any(neg in normalized_header for neg in negatives):
            return True
    return False


def _header_signal(column: str) -> tuple[str, float, str] | None:
    """Return ``(category, confidence, reason)`` if any header hint matches.

    Applies negative signals: if the best positive category is suppressed
    by a negative substring in the same header, that category is skipped
    and the next-best positive (if any) is considered.
    """
    norm = _normalize_header(column)
    ranked: list[tuple[str, float, str]] = []
    for category, hints in HEADER_HINTS.items():
        for substring, confidence in hints:
            if substring in norm:
                ranked.append((category, confidence, f"header contains '{substring}'"))
                break  # first hint per category wins
    if not ranked:
        return None
    ranked.sort(key=lambda t: t[1], reverse=True)
    for category, confidence, reason in ranked:
        negatives = NEGATIVE_HEADER_HINTS.get(category, ())
        hit = next((neg for neg in negatives if neg in norm), None)
        if hit is not None:
            continue  # suppressed — this header word overrides the hint
        return category, confidence, reason
    return None


# --------------------------------------------------------------------------
# Tier 2 — content sniffing (evidence-scoring)
# --------------------------------------------------------------------------

# A category needs at least this fraction of sampled values to hit before
# it is even considered a candidate. Set below 1.0 so a column that is
# mostly (but not entirely) one format still surfaces; the confidence
# returned scales with the actual hit ratio and detector weight, so a weak
# hit stays weak rather than being silently dropped.
DEFAULT_CONTENT_MIN_RATIO = 0.5


def _content_signal(
    values: Sequence[str],
    *,
    min_ratio: float = DEFAULT_CONTENT_MIN_RATIO,
) -> tuple[str, float, str] | None:
    """Score ``values`` against every detector and return the best category.

    Every detector votes; hits are aggregated per category (a category may
    have several detectors, e.g. card + IBAN both map to FINANCIAL). The
    winning category is the one with the highest ``ratio * weight``
    product, provided its raw hit ratio clears ``min_ratio``. Confidence is
    that product, capped at 0.99 so a corroborating header can still nudge
    it upward.
    """
    if not values:
        return None

    n = len(values)
    # Accumulate hits per category as a UNION of value indices across all
    # detectors mapping to that category. A category like FINANCIAL has two
    # detectors (Luhn card + IBAN); a column that is 30% cards and 25%
    # IBANs scores on the combined 55% coverage rather than the single best
    # detector's 30%, so it isn't dropped below the min_ratio gate.
    # Weight/reason track the highest-weight detector that contributed.
    hit_indices: dict[str, set[int]] = {}
    best_detector: dict[str, tuple[float, str]] = {}  # category -> (weight, reason)
    for category, predicate, weight, reason in CONTENT_DETECTORS:
        matched = {i for i, v in enumerate(values) if predicate(v)}
        if not matched:
            continue
        hit_indices.setdefault(category, set()).update(matched)
        prev = best_detector.get(category)
        if prev is None or weight > prev[0]:
            best_detector[category] = (weight, reason)

    best_per_category: dict[str, tuple[float, float, str]] = {
        category: (len(idx) / n, best_detector[category][0], best_detector[category][1])
        for category, idx in hit_indices.items()
    }

    # Gazetteer refinement for PERSON: the "capitalized-name" regex is the
    # weakest detector (it also matches "Blue Widget"). If a PERSON hit is
    # corroborated by known given names, BOOST its weight. We deliberately
    # do NOT damp when no known name is found: the gazetteer is
    # Western-skewed and necessarily partial, so "no known first name" is
    # NOT evidence against personhood — damping there would suppress
    # legitimate non-Western name columns (a recall hole and a bias). The
    # negative-header signal and structural cardinality handle the
    # "product/place name" false positives instead.
    if "PERSON" in best_per_category:
        ratio, weight, reason = best_per_category["PERSON"]
        person_values = [v for v in values if is_person_like(v)]
        if person_values:
            known = sum(1 for v in person_values if has_known_first_name(v))
            known_frac = known / len(person_values)
            if known_frac >= 0.5:
                weight = min(1.0, weight + 0.25)
                reason = f"{reason} (gazetteer-corroborated first names)"
                best_per_category["PERSON"] = (ratio, weight, reason)

    best: tuple[str, float, str] | None = None
    best_score = 0.0
    for category, (ratio, weight, reason) in best_per_category.items():
        if ratio < min_ratio:
            continue
        score = min(0.99, ratio * weight)
        if best is None or score > best_score:
            best = (
                category,
                score,
                f"{ratio * 100:.0f}% of {n} sampled values match {reason}",
            )
            best_score = score
    return best


# --------------------------------------------------------------------------
# Tier 3 — structural signals
# --------------------------------------------------------------------------

# A column whose distinct-value ratio is below this is "low cardinality"
# (categorical-looking) and unlikely to be a per-row identifier. Used to
# suppress spurious ID / FINANCIAL classifications on enum-like columns.
_LOW_CARDINALITY_RATIO = 0.2

# Identifier-ish categories that a low-cardinality column probably is NOT.
_HIGH_CARDINALITY_CATEGORIES = frozenset({"ID", "EMAIL", "FINANCIAL"})

# Header-substring families that, when two sibling columns are present,
# corroborate each other (both are almost certainly PERSON).
_PERSON_PARTNER_SUBSTRINGS = ("first_name", "last_name", "given_name", "surname")


def _series_uniqueness_ratio(series) -> float:
    """Distinct / total over the FULL non-null column (not the sample).

    Must be computed on the raw column: the Tier-2 sample is already
    de-duplicated, so measuring uniqueness on it would always read ~1.0
    and defeat the low-cardinality signal.
    """
    cleaned = series.dropna()
    total = len(cleaned)
    if total == 0:
        return 0.0
    return cleaned.astype(str).str.strip().nunique() / total


# A column is "free text" when its values are prose-like: multi-word on
# average and NOT cleanly matching a single structured format. Such
# columns (notes, comments, description) carry PII *inside* cells rather
# than as whole-cell values, so they get sub-cell span scanning instead
# of whole-cell classification.
_FREETEXT_MIN_MEAN_TOKENS = 4.0


def is_free_text_column(values: Sequence[str]) -> bool:
    """Heuristic: does this column hold prose rather than structured values?"""
    if not values:
        return False
    mean_tokens = sum(v.count(" ") + 1 for v in values) / len(values)
    if mean_tokens < _FREETEXT_MIN_MEAN_TOKENS:
        return False
    # If the column cleanly matches a single structured format at high
    # ratio, it's structured, not free text (a full_name column averages
    # 2-3 tokens and wouldn't reach here anyway, but guard regardless).
    structured = _content_signal(values, min_ratio=0.8)
    return structured is None


# --------------------------------------------------------------------------
# Suggestions API
# --------------------------------------------------------------------------


@dataclass
class ColumnSuggestion:
    """One column's classification.

    Attributes:
        column: The column name as it appears in the source.
        category: PII category (``EMAIL``, ``PERSON``, …) or ``None`` when
            the column does not look like PII.
        confidence: Final confidence in ``[0.0, 1.0]``.
        sources: Which signals fired (``"header"``, ``"content"``,
            ``"structural"``).
        reasons: Human-readable explanations per signal.
    """

    column: str
    category: str | None
    confidence: float
    sources: list[str] = field(default_factory=list)
    reasons: list[str] = field(default_factory=list)

    @property
    def is_pii(self) -> bool:
        return self.category is not None


def _sample_string_values(series, sample_size: int) -> list[str]:
    """Pick up to ``sample_size`` DISTINCT non-null, non-empty string values.

    Sampling distinct values (rather than a fixed-seed random row sample)
    means a format that appears rarely in a large column is still seen by
    the detector — a card column that's 1% populated in a 1M-row file no
    longer hides from a 200-row sample. Order is preserved so the sample
    is deterministic without an RNG seed.
    """
    cleaned = series.dropna()
    if len(cleaned) == 0:
        return []
    seen: set[str] = set()
    out: list[str] = []
    for v in cleaned:
        s = str(v).strip()
        if not s or s in seen:
            continue
        seen.add(s)
        out.append(s)
        if len(out) >= sample_size:
            break
    return out


def _apply_structural(
    suggestion: ColumnSuggestion,
    *,
    uniqueness: float,
    person_partner_present: bool,
) -> None:
    """Adjust a suggestion in place using frame-level structural signals."""
    if suggestion.category is None:
        return

    # Low-cardinality columns are unlikely to be per-row identifiers.
    if (
        suggestion.category in _HIGH_CARDINALITY_CATEGORIES
        and uniqueness < _LOW_CARDINALITY_RATIO
    ):
        suggestion.confidence = round(suggestion.confidence * 0.6, 4)
        suggestion.sources.append("structural")
        suggestion.reasons.append(
            f"low cardinality ({uniqueness:.0%} distinct) — unlikely a "
            f"per-row {suggestion.category}; confidence damped"
        )

    # A PERSON column corroborated by a sibling first/last-name column is
    # near-certain — nudge confidence up.
    if suggestion.category == "PERSON" and person_partner_present:
        boosted = min(0.99, suggestion.confidence + 0.1)
        if boosted > suggestion.confidence:
            suggestion.confidence = round(boosted, 4)
            suggestion.sources.append("structural")
            suggestion.reasons.append(
                "sibling first/last-name column corroborates PERSON"
            )


# --------------------------------------------------------------------------
# Optional Tier-4 — NER-backed entity classification (injected)
# --------------------------------------------------------------------------
#
# The model-free tiers above are exact and cheap for FORMAT categories
# (email/phone/card/…). They are weakest for the SOFT NAMED-ENTITY types —
# PERSON / ORG / CITY / COUNTRY / COUNTY — where the only signals are a
# title-case regex and a partial first-name gazetteer. Those are exactly
# what a NER model is trained for.
#
# ``file_protection`` stays model-free: it never imports the ML stack. The
# service layer injects an ``EntityColumnClassifier`` (backed by the text
# pipeline's NER model) via the ``entity_classifier`` argument. When none
# is supplied, behavior is identical to the pure-heuristic detector.

# The only categories NER is allowed to influence. Format categories are
# left entirely to regex/checksums — NER is worse and slower for them.
SOFT_ENTITY_CATEGORIES: frozenset[str] = frozenset(
    {"PERSON", "ORG", "CITY", "COUNTRY", "COUNTY"}
)

# Format categories NER must never override — regex/checksums own these.
# Used by the "all" NER scope to skip columns already confidently
# classified as a structured format.
_FORMAT_CATEGORIES: frozenset[str] = frozenset(
    {"EMAIL", "PHONE", "URL", "ID", "FINANCIAL", "ZIPCODE", "DATETIME", "SECRET"}
)


class EntityColumnClassifier(Protocol):
    """Classify a sampled column as a soft named-entity type, or abstain.

    Given a list of stringified column values, return
    ``(canonical_category, confidence)`` when the column reads as one of
    :data:`SOFT_ENTITY_CATEGORIES`, or ``None`` to abstain. Implementations
    MUST NOT raise — a broken classifier should abstain, not break
    detection. ``confidence`` is in ``[0, 1]``.
    """

    def __call__(self, values: Sequence[str]) -> Optional[tuple[str, float]]: ...


# Values that already cleanly match a structured FORMAT (email, phone,
# card, …) aren't entity candidates — no point paying for NER on an email
# column. A soft-entity regex hit (e.g. the title-case PERSON pattern) is
# NOT "structured" here: those are precisely the ambiguous cases NER is
# meant to adjudicate, so they must remain candidates.
def _has_structured_content(values: Sequence[str]) -> bool:
    hit = _content_signal(values, min_ratio=0.8)
    return hit is not None and canonical_category(hit[0]) in _FORMAT_CATEGORIES


def _is_ner_candidate(
    suggestion: ColumnSuggestion,
    normalized_header: str,
    values: Sequence[str],
) -> bool:
    """Is this column ambiguous enough to be worth a NER pass?

    Default policy (``ner_scope="ambiguous"``): run NER only where the
    cheap tiers are uncertain about a soft-entity type, so cost is bounded
    to the few genuinely-unclear columns:

      * already flagged as a soft-entity type but with low confidence, OR
      * unflagged, textual (not a clean structured format), and either the
        header hints a soft-entity type or the values look name/word-like.

    Columns that are confidently classified, or that are clean structured
    formats, are skipped.
    """
    if not values:
        return False
    # A confident soft-entity classification needs no help.
    if (
        suggestion.category in SOFT_ENTITY_CATEGORIES
        and suggestion.confidence >= 0.9
    ):
        return False
    # An ambiguous soft-entity flag — let NER confirm/deny.
    if suggestion.category in SOFT_ENTITY_CATEGORIES:
        return True
    # A confident NON-soft classification (email/phone/…) is regex's turf.
    if suggestion.category is not None:
        return False
    # Unflagged: only bother if it's free of a clean structured format AND
    # looks like it could hold names/words (header hint or word-shaped).
    if _has_structured_content(values):
        return False
    header_hint = any(
        sub in normalized_header
        for cat in SOFT_ENTITY_CATEGORIES
        for sub, _conf in HEADER_HINTS.get(cat, ())
        if sub in normalized_header
    )
    word_shaped = sum(
        1 for v in values if v[:1].isalpha()
    ) >= max(1, len(values) // 2)
    return header_hint or word_shaped


def _apply_entity_classifier(
    suggestion: ColumnSuggestion,
    values: Sequence[str],
    classifier: EntityColumnClassifier,
    *,
    min_confidence: float,
) -> None:
    """Merge a NER verdict into ``suggestion`` in place (a weighted voter).

    NER may only assign / strengthen a soft-entity category. It never
    overrides a confident non-entity (format) classification. A verdict
    that agrees with the existing category boosts confidence; a verdict on
    an unflagged column sets it.
    """
    try:
        verdict = classifier(values)
    except Exception:
        return  # a broken classifier abstains — never breaks detection
    if verdict is None:
        return
    cat, conf = verdict
    cat = canonical_category(cat)
    if cat not in SOFT_ENTITY_CATEGORIES or conf <= 0.0:
        return

    if suggestion.category == cat:
        boosted = min(0.99, max(suggestion.confidence, conf) + 0.05)
        if boosted > suggestion.confidence:
            suggestion.confidence = round(boosted, 4)
            suggestion.sources.append("ner")
            suggestion.reasons.append(f"NER corroborates {cat} ({conf:.2f})")
    elif suggestion.category is None:
        suggestion.category = cat
        suggestion.confidence = round(conf, 4)
        suggestion.sources.append("ner")
        suggestion.reasons.append(f"NER classified column as {cat} ({conf:.2f})")
    elif suggestion.category in SOFT_ENTITY_CATEGORIES:
        # Heuristic guessed a DIFFERENT soft-entity type (e.g. the
        # title-case regex said PERSON but NER says CITY). NER is the
        # authority for disambiguating soft entities, so a confident
        # verdict overrides a weak heuristic guess.
        if conf > suggestion.confidence:
            old = suggestion.category
            suggestion.category = cat
            suggestion.confidence = round(conf, 4)
            suggestion.sources.append("ner")
            suggestion.reasons.append(
                f"NER reclassified {old} -> {cat} ({conf:.2f})"
            )
    # If NER disagrees with a confident FORMAT category (email/phone/…) we
    # leave it — regex/checksums outrank NER there (and such columns aren't
    # sent to NER in the first place).


def suggest_sensitive_columns(
    df,
    *,
    sample_size: int = 200,
    # Columns whose combined confidence falls below this are returned
    # unflagged (``category=None``). Soft-entity detections (PERSON, ORG)
    # land in the mid-confidence band, so keeping the gate at 0.5 admits
    # them while staying above the benign band; lower it to widen recall,
    # raise it to demand stronger evidence. Callers override per request.
    min_confidence: float = 0.5,
    content_min_ratio: float = DEFAULT_CONTENT_MIN_RATIO,
    entity_classifier: Optional[EntityColumnClassifier] = None,
    ner_scope: str = "ambiguous",
) -> list[ColumnSuggestion]:
    """Detect PII columns in a pandas DataFrame.

    Args:
        df: Source DataFrame.
        sample_size: Max DISTINCT non-null values per column to scan in
            Tier 2. Larger values raise confidence at higher CPU cost.
        min_confidence: Suggestions below this are returned with
            ``category=None`` (i.e. "not flagged"). Useful for previewing.
        content_min_ratio: Minimum fraction of sampled values a detector
            must hit before its category is considered (Tier 2). Lower it
            to surface partially-populated columns.
        entity_classifier: Optional NER-backed classifier (injected by the
            service layer). When ``None``, detection is purely heuristic —
            identical to the model-free behavior. Only influences the soft
            named-entity categories (see :data:`SOFT_ENTITY_CATEGORIES`).
        ner_scope: ``"ambiguous"`` (default) runs the classifier only on
            heuristically-uncertain columns (bounded cost); ``"all"`` runs
            it on every string column that isn't a clean structured format.
            Ignored when ``entity_classifier`` is ``None``.

    Returns:
        One :class:`ColumnSuggestion` per column. Order matches ``df.columns``.
    """
    normalized_headers = {col: _normalize_header(col) for col in df.columns}
    # Precompute cross-column co-occurrence: does the frame have at least
    # two distinct person-partner columns? (first_name AND last_name, etc.)
    person_partner_columns = [
        col for col, norm in normalized_headers.items()
        if any(sub in norm for sub in _PERSON_PARTNER_SUBSTRINGS)
    ]
    has_person_partners = len(person_partner_columns) >= 2

    suggestions: list[ColumnSuggestion] = []
    for col in df.columns:
        header = _header_signal(col)
        values = _sample_string_values(df[col], sample_size)
        content = _content_signal(values, min_ratio=content_min_ratio)
        uniqueness = _series_uniqueness_ratio(df[col])

        # Merge logic:
        #   header + content agree   → boost confidence (capped at 0.99)
        #   header alone             → take its confidence
        #   content alone            → take its confidence
        #   header + content disagree → trust content (data > naming)
        #   nothing                  → no PII

        category: str | None = None
        confidence = 0.0
        sources: list[str] = []
        reasons: list[str] = []

        if header and content:
            if canonical_category(header[0]) == canonical_category(content[0]):
                category = canonical_category(content[0])
                confidence = min(0.99, max(header[1], content[1]) + 0.05)
                sources = ["header", "content"]
                reasons = [header[2], content[2]]
            else:
                category = canonical_category(content[0])
                confidence = content[1]
                sources = ["content"]
                reasons = [
                    content[2],
                    f"header suggested {canonical_category(header[0])} "
                    f"({header[2]}) but content disagrees",
                ]
        elif header:
            category, confidence, reason = header
            category = canonical_category(category)
            sources = ["header"]
            reasons = [reason]
        elif content:
            category, confidence, reason = content
            category = canonical_category(category)
            sources = ["content"]
            reasons = [reason]

        # Negative-header veto: applies to WHICHEVER signal proposed the
        # category. Stops a name-like ``product_name`` / ``file_name``
        # column from being flagged PERSON off its content regex even
        # after the header signal itself was suppressed.
        if category is not None and _is_negatively_suppressed(
            normalized_headers[col], category
        ):
            reasons.append(
                f"category {category} vetoed by negative header signal "
                f"in '{col}'"
            )
            category = None
            confidence = 0.0
            sources = []

        suggestion = ColumnSuggestion(
            column=col,
            category=category,
            confidence=confidence,
            sources=sources,
            reasons=reasons,
        )

        # Tier 3 — structural adjustments (may raise or damp confidence).
        partner_for_this = (
            has_person_partners
            and any(
                sub in normalized_headers[col]
                for sub in _PERSON_PARTNER_SUBSTRINGS
            )
        )
        _apply_structural(
            suggestion,
            uniqueness=uniqueness,
            person_partner_present=partner_for_this,
        )

        # Tier 4 — optional NER classifier for soft named-entity types.
        # Runs only when injected, and (in the default "ambiguous" scope)
        # only on columns the cheap tiers were unsure about. "all" scope
        # runs it on any non-structured string column.
        if entity_classifier is not None:
            run_ner = (
                _is_ner_candidate(suggestion, normalized_headers[col], values)
                if ner_scope != "all"
                else (values and not _has_structured_content(values)
                      and suggestion.category not in _FORMAT_CATEGORIES)
            )
            if run_ner:
                _apply_entity_classifier(
                    suggestion, values, entity_classifier,
                    min_confidence=min_confidence,
                )
                # NER may have set a category on a column the negative
                # header vetoes (e.g. product_name); re-apply the veto.
                if suggestion.category is not None and _is_negatively_suppressed(
                    normalized_headers[col], suggestion.category
                ):
                    suggestion.category = None
                    suggestion.confidence = 0.0

        # Final threshold gate (after all signals have been combined).
        if suggestion.category is not None and suggestion.confidence < min_confidence:
            suggestion.category = None

        suggestions.append(suggestion)
    return suggestions


# Detectors whose single-value false-positive rate is effectively zero:
# a value that passes a Luhn / IBAN mod-97 / SSN-shape / email check is
# almost certainly that thing. Used by the masker's full-column safety
# net so a format that a *sample* missed (e.g. a card number in 1% of a
# million-row column) still gets caught before the file reaches an LLM.
_CERTAINTY_CATEGORIES = frozenset({"EMAIL", "FINANCIAL", "ID"})
_CERTAINTY_DETECTORS = tuple(
    (cat, pred)
    for cat, pred, weight, _reason in CONTENT_DETECTORS
    if cat in _CERTAINTY_CATEGORIES and weight >= 1.0
)


def strict_column_category(values: Iterable[str]) -> str | None:
    """Return a canonical category if ANY value passes a certainty detector.

    A single-value scan over the whole (not sampled) column using only
    checksum- or format-certain detectors. Returns the first category
    whose detector fires, or ``None``. Because these detectors don't
    false-positive on individual values, "any hit" is a safe trigger —
    this is a recall safety net, biased toward not leaking PII.
    """
    for v in values:
        s = str(v).strip()
        if not s:
            continue
        for category, predicate in _CERTAINTY_DETECTORS:
            if predicate(s):
                return canonical_category(category)
    return None


def to_sensitive_columns(suggestions: Iterable[ColumnSuggestion]) -> dict[str, str]:
    """Compact ``suggest_sensitive_columns`` output into a ``sensitive_columns`` mapping."""
    return {s.column: s.category for s in suggestions if s.is_pii}


def merge_suggestions(
    suggestions: Iterable[ColumnSuggestion],
    overrides: Mapping[str, str | None] | None = None,
) -> dict[str, str]:
    """Combine detector output with explicit user overrides.

    Args:
        suggestions: Output of :func:`suggest_sensitive_columns`.
        overrides: Map of ``column -> category``. ``None`` as a value
            means "force this column to NOT be masked even if detected".

    Returns:
        Final ``sensitive_columns`` mapping.
    """
    out = to_sensitive_columns(suggestions)
    if not overrides:
        return out
    for col, category in overrides.items():
        if category is None:
            out.pop(col, None)
        else:
            out[col] = category
    return out
