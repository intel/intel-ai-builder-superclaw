"""Tabular PII masker — replaces sensitive cell values with consistent placeholders.

The masker is column-aware: callers tell it which columns hold which categories
of PII (e.g. ``{"email": "EMAIL", "name": "PERSON"}``) and the masker replaces
each unique value with ``<CATEGORY_N>``. The same value is always assigned the
same placeholder, even across columns of the same category, so downstream
restoration is unambiguous.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from typing import Callable, Mapping, Optional, Sequence

from common.bucketize import bucket_category, parse_amount
from common.validators import (
    SPAN_PATTERNS,
    iban_ok,
    is_column_identifier,
    looks_like_card,
    span_confirm,
)


def _financial_bucket_category(value: str) -> str:
    """Category for a FINANCIAL cell under bucketize.

    Identifiers (Luhn cards, valid IBANs) are NOT amounts — their digit
    count has no monetary magnitude, so they stay plain ``FINANCIAL``.
    Everything else is parsed as an amount and bucketed; an unparseable
    value also falls back to plain ``FINANCIAL`` (still redacted).
    """
    if looks_like_card(value) or iban_ok(value):
        return "FINANCIAL"
    return bucket_category(parse_amount(value), base="FINANCIAL")


@dataclass
class MaskResult:
    """Output of :func:`mask_records`.

    Attributes:
        rows: Masked records (same shape as the input).
        registry: Forward registry ``{placeholder: original}``.
        columns_masked: Columns that were actually masked (intersection of the
            requested mapping and the columns present in the input).
    """

    rows: list[dict]
    registry: dict[str, str]
    columns_masked: list[str] = field(default_factory=list)


@dataclass
class MaskDataFrameResult:
    """Output of :func:`mask_dataframe`.

    Carries the masked ``DataFrame`` directly so callers can persist it
    without a ``DataFrame -> list[dict] -> DataFrame`` round trip.

    Attributes:
        df: Masked pandas DataFrame (a copy of the input — the original is
            never mutated).
        registry: Forward registry ``{placeholder: original}``.
        columns_masked: Columns that were actually masked.
    """

    df: object  # pandas.DataFrame; typed as object to avoid hard pandas import
    registry: dict[str, str]
    columns_masked: list[str] = field(default_factory=list)

    @property
    def rows(self) -> list[dict]:
        """Convert the masked DataFrame to a list of row dicts.

        Computed lazily so callers that only need the DataFrame avoid the cost.
        """
        return self.df.to_dict(orient="records")


def _is_missing(value: object) -> bool:
    """Treat ``None``, NaN, and empty strings as missing."""
    if value is None:
        return True
    if isinstance(value, float) and value != value:
        return True
    if isinstance(value, str) and not value.strip():
        return True
    return False


def _make_placeholder_factory() -> tuple[
    "object", dict[str, str], dict[tuple[str, str], str], dict[str, int]
]:
    """Build a closure that issues consistent ``<CATEGORY_N>`` placeholders.

    Every value is normalized to Unicode NFC before it becomes a registry
    key. This means two visually-identical strings with different Unicode
    forms (NFC ``é`` vs. NFD ``e`` + combining acute) collapse to one
    placeholder and one registry entry, so downstream restore can find a
    match regardless of which form the LLM echoes back.

    Returns:
        ``(factory, registry, seen, counters)``. ``factory(category, value)``
        returns the placeholder for ``value`` (creating one on first sight).
    """
    counters: dict[str, int] = {}
    seen: dict[tuple[str, str], str] = {}
    registry: dict[str, str] = {}

    def factory(category: str, value: str) -> str:
        # Canonicalize once at the boundary. NFC is idempotent, so calling
        # it on already-normalized text is a no-op.
        value = unicodedata.normalize("NFC", value)
        key = (category, value)
        existing = seen.get(key)
        if existing is not None:
            return existing
        n = counters.get(category, 0) + 1
        counters[category] = n
        ph = f"<{category}_{n}>"
        seen[key] = ph
        registry[ph] = value
        return ph

    return factory, registry, seen, counters


def mask_records(
    records: Sequence[Mapping[str, object]],
    sensitive_columns: Mapping[str, str],
) -> MaskResult:
    """Mask an iterable of dict-like records.

    Used for pure-Python data sources. For pandas DataFrames, prefer
    :func:`mask_dataframe` to avoid the dict round-trip.

    Args:
        records: Iterable of dict-like rows.
        sensitive_columns: Map of ``column_name -> category`` (e.g. ``{"email": "EMAIL"}``).

    Returns:
        :class:`MaskResult` with masked rows and the forward registry.
    """
    placeholder, registry, _seen, _counters = _make_placeholder_factory()
    masked_rows: list[dict] = []
    columns_present: set[str] = set()

    for row in records:
        new_row = dict(row)
        for col, category in sensitive_columns.items():
            if col not in new_row:
                continue
            columns_present.add(col)
            value = new_row[col]
            if _is_missing(value):
                continue
            new_row[col] = placeholder(category, str(value))
        masked_rows.append(new_row)

    return MaskResult(
        rows=masked_rows,
        registry=registry,
        columns_masked=[c for c in sensitive_columns if c in columns_present],
    )


# A span provider takes a free-text string and returns a list of
# (start, end, category, value) hits to mask. The service layer supplies
# a ConsistentSanitizer-backed provider for NER-grade PERSON/ORG; when
# ``None``, ``mask_free_text`` uses only the model-free SPAN_PATTERNS.
SpanProvider = Callable[[str], "list[tuple[int, int, str, str]]"]


# Chars of left context passed to span_confirm for the PHONE anchor boost.
# Sized to cover the intra-paragraph case ("phone:\n    555-1234") and the
# typical form-label layout ("Please call our office\nphone: 555-1234")
# without letting a wildly distant anchor match. 120 chars = ~2 lines of
# prose or a form label + short blurb, well past the 24-char inline limit
# that missed multi-line phone anchors.
_PHONE_CTX_WINDOW = 120


def _regex_spans(
    text: str, *, phone_anchor_boost: bool = False
) -> "list[tuple[int, int, str, str]]":
    """Model-free PII spans within ``text`` via SPAN_PATTERNS.

    Returns non-overlapping (start, end, category, value) hits. Earlier
    (more specific) patterns win overlaps; each candidate is confirmed by
    its validator so loose digit-run patterns don't over-match.

    ``phone_anchor_boost`` (opt-in) lets a phone-shaped span that fails the
    strict is_phone bounds be accepted when a phone anchor word ("phone:",
    "tel", "call", …) immediately precedes it — recovering real phone numbers
    the strict bounds reject, at high precision (the anchor disambiguates).
    """
    claimed: list[tuple[int, int]] = []
    spans: list[tuple[int, int, str, str]] = []

    def _overlaps(s: int, e: int) -> bool:
        return any(s < ce and cs < e for cs, ce in claimed)

    for category, pattern in SPAN_PATTERNS:
        for m in pattern.finditer(text):
            s, e = m.start(), m.end()
            val = m.group(0)
            if _overlaps(s, e):
                continue
            left_ctx = text[max(0, s - _PHONE_CTX_WINDOW):s]
            if not span_confirm(category, val, left_context=left_ctx,
                                phone_anchor_boost=phone_anchor_boost):
                continue
            claimed.append((s, e))
            spans.append((s, e, category, val))
    return spans


def _geo_spans(text: str) -> "list[tuple[int, int, str, str]]":
    """Model-free CITY / COUNTRY spans via the curated geo gazetteer.

    Matches known place-name phrases (longest first, so 'New York' wins over
    'York') on word boundaries, gated on the match being capitalized in the
    source — a lowercase 'nice' / 'turkey' / 'reading' in prose is never
    masked, only the proper-noun 'Nice' / 'Turkey'. COUNTRY is matched before
    CITY so a name that is both resolves to COUNTRY.

    Returns non-overlapping (start, end, category, value) hits. This is a
    high-precision closed-set detector for famous cities/countries that the
    regex patterns and English NER do not catch on their own.
    """
    from file_protection.geo_gazetteer import COUNTRY_PHRASES, CITY_PHRASES

    claimed: list[tuple[int, int]] = []
    spans: list[tuple[int, int, str, str]] = []

    def _overlaps(s: int, e: int) -> bool:
        return any(s < ce and cs < e for cs, ce in claimed)

    for category, phrases in (("COUNTRY", COUNTRY_PHRASES), ("CITY", CITY_PHRASES)):
        for phrase in phrases:
            # Word-boundary, case-insensitive search; require the matched
            # text to START with an uppercase letter so lowercase common-word
            # homographs (nice, reading, mobile) are not masked.
            pattern = re.compile(rf"\b{re.escape(phrase)}\b", re.IGNORECASE)
            for m in pattern.finditer(text):
                s, e = m.start(), m.end()
                matched = m.group(0)
                if not matched[:1].isupper():
                    continue
                if _overlaps(s, e):
                    continue
                claimed.append((s, e))
                spans.append((s, e, category, matched))
    return spans


def make_geo_span_provider(english_only: bool = True) -> SpanProvider:
    """Return a model-free SpanProvider that masks known cities/countries.

    Composable with an NER span provider via :func:`compose_span_providers`
    (or usable standalone).

    ``english_only`` (default True): only emit geo spans when the cell text
    reads as English. On English prose the gazetteer adds place-name recall
    at negligible false-positive cost, but on multilingual finance prose it
    over-fires — the same split as the spaCy language gate, so it reuses the
    same ``common.textlang.looks_english`` heuristic. Set False to run the
    gazetteer on all languages.
    """
    if not english_only:
        return _geo_spans

    from common.textlang import looks_english

    def _english_geo(text: str) -> "list[tuple[int, int, str, str]]":
        # Gate on the whole-cell language, mirroring the spaCy gate: on
        # non-English prose the place-name FPs outweigh the recall, and the
        # multilingual NER already contributes geo there.
        if not looks_english(text):
            return []
        return _geo_spans(text)

    return _english_geo


def compose_span_providers(*providers: Optional[SpanProvider]) -> Optional[SpanProvider]:
    """Combine several span providers into one; ``None`` entries are dropped.

    Returns ``None`` if nothing is left (so the caller's regex-only path is
    unchanged), a single provider unwrapped, or a merging provider that
    concatenates results (the masker de-overlaps them downstream)."""
    active = [p for p in providers if p is not None]
    if not active:
        return None
    if len(active) == 1:
        return active[0]

    def _combined(text: str) -> "list[tuple[int, int, str, str]]":
        out: list[tuple[int, int, str, str]] = []
        for p in active:
            try:
                out.extend(p(text))
            except Exception:
                # A misbehaving provider must never break the others.
                continue
        return out

    return _combined


_MD_TABLE_SEPARATOR_RE = re.compile(r"^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$")


def _markdown_table_header_ranges(text: str) -> "list[tuple[int, int]]":
    """Character ranges of markdown table header rows.

    A header row is a ``|`` line directly followed by a ``| --- | --- |``
    separator line. Its cells are column labels, never PII values.
    """
    ranges: list[tuple[int, int]] = []
    lines = text.splitlines(keepends=True)
    offset = 0
    for i, line in enumerate(lines[:-1]):
        if "|" in line and _MD_TABLE_SEPARATOR_RE.match(lines[i + 1]) and "|" in lines[i + 1]:
            ranges.append((offset, offset + len(line)))
        offset += len(line)
    return ranges


def _mask_free_text_value(
    text: str,
    placeholder,
    span_provider: Optional[SpanProvider],
    *,
    phone_anchor_boost: bool = False,
) -> str:
    """Splice placeholders into a single free-text cell.

    The input is normalized to Unicode NFC before scanning so accented text
    round-trips correctly through downstream LLMs — many models emit NFD
    (``e`` + combining accent) even when given NFC (``é``), and a
    byte-exact restore would then miss the value. NFC in / NFC out means
    the registry key, placeholder splice, and restore search all agree on
    one canonical form.

    Spans are applied right-to-left so earlier offsets stay valid as later
    ones are replaced. ``span_provider`` (NER) is merged with the regex
    spans; regex wins ties on overlap because its formats are exact.
    """
    text = unicodedata.normalize("NFC", text)
    spans = _regex_spans(text, phone_anchor_boost=phone_anchor_boost)
    if span_provider is not None:
        try:
            # ``claimed`` starts with the regex spans and is updated as
            # each provider span is accepted, so provider spans are
            # de-overlapped against BOTH the regex spans AND each other
            # (a provider that returns two overlapping spans would
            # otherwise corrupt the splice).
            claimed = [(s, e) for s, e, _c, _v in spans]
            header_ranges = _markdown_table_header_ranges(text)
            for s, e, category, val in span_provider(text):
                if any(s < ce and cs < e for cs, ce in claimed):
                    continue
                # A header cell shaped like a column name is a label; anything else
                # (a person, a company such as Microsoft) is still PII.
                if is_column_identifier(val) and any(
                    s < he and hs < e for hs, he in header_ranges
                ):
                    continue
                claimed.append((s, e))
                spans.append((s, e, category, val))
        except Exception:
            # A misbehaving provider must never break masking — fall back
            # to the regex-only spans already collected.
            pass
    if not spans:
        return text
    # Apply right-to-left so each splice leaves earlier (lower) offsets
    # valid. Spans are guaranteed pairwise non-overlapping by the checks
    # above, so no splice can slice through a placeholder inserted by a
    # later (higher-offset) span.
    for s, e, category, val in sorted(spans, key=lambda t: t[0], reverse=True):
        ph = placeholder(category, val)
        text = text[:s] + ph + text[e:]
    return text


def _apply_over_uniques(series, fn):
    """Apply ``fn(str_value) -> masked_str`` over a column's UNIQUE values.

    The masking transform is called once per distinct non-missing value
    (in first-appearance order, so placeholder numbering is identical to a
    row-by-row pass) and the result is mapped back onto the full column with
    a single vectorized ``Series.map`` — turning O(rows) Python calls into
    O(distinct values). Missing cells (``None`` / NaN / blank) are preserved
    unchanged.

    Returns a new Series (the input is not mutated). If nothing is maskable,
    the original series is returned as-is.
    """
    value_map: dict = {}
    for v in series.dropna().unique():  # first-appearance order
        s = str(v)
        if not s.strip():
            continue  # blank-after-strip is "missing" — leave untouched
        value_map[v] = fn(s)

    if not value_map:
        return series

    mapped = series.map(value_map)
    # ``map`` yields NaN for keys not in ``value_map`` (missing / blank
    # cells); restore the originals there so blanks never become NaN and
    # untouched values pass through verbatim.
    return mapped.where(mapped.notna(), series)


def mask_dataframe(
    df,
    sensitive_columns: Mapping[str, str],
    *,
    free_text_columns: Sequence[str] = (),
    span_provider: Optional[SpanProvider] = None,
    bucketize_financial: bool = False,
    phone_anchor_boost: bool = False,
) -> MaskDataFrameResult:
    """Mask a pandas DataFrame column-wise without leaving pandas.

    Iterates only the PII columns (untouched columns are passed through by
    reference) and uses ``Series.map`` per column instead of materializing a
    list of row dicts. The input ``df`` is not mutated.

    Args:
        df: Source pandas DataFrame.
        sensitive_columns: Map of ``column_name -> category`` for WHOLE-CELL
            masking (the whole value is one entity).
        free_text_columns: Columns to mask with SUB-CELL span scanning —
            each cell is prose and may contain zero or more PII spans.
            Masked in addition to ``sensitive_columns``; a column in both is
            treated as free text.
        span_provider: Optional callable returning extra NER-grade spans
            per cell (PERSON/ORG). When ``None``, free-text columns use
            only the model-free regex span patterns.
        bucketize_financial: When ``True``, FINANCIAL cells that parse as a
            monetary AMOUNT are masked to a magnitude-labeled placeholder
            (``<FINANCIAL_THOUSANDS_1>``) instead of ``<FINANCIAL_1>``.
            Card numbers / IBANs (identifiers, not amounts) are left as
            plain ``FINANCIAL`` — bucketizing an identifier's digit count
            would be meaningless. The registry still stores the exact value.

    Returns:
        :class:`MaskDataFrameResult` carrying the masked DataFrame and registry.
    """
    placeholder, registry, _seen, _counters = _make_placeholder_factory()

    out = df.copy(deep=False)  # shallow copy: only PII columns get rewritten
    columns_masked: list[str] = []
    free_text_set = set(free_text_columns)

    for col, category in sensitive_columns.items():
        if col not in out.columns or col in free_text_set:
            continue
        columns_masked.append(col)

        bucketize_this = bucketize_financial and category == "FINANCIAL"

        def _mask_value(s: str, _cat: str = category, _bucket: bool = bucketize_this) -> str:
            if _bucket:
                _cat = _financial_bucket_category(s)
            return placeholder(_cat, s)

        # Mask over DISTINCT values then map back: one factory call per unique
        # value rather than one per cell. Placeholder numbering is unchanged
        # because uniques are visited in first-appearance order.
        out[col] = _apply_over_uniques(out[col], _mask_value)

    for col in free_text_columns:
        if col not in out.columns:
            continue
        if col not in columns_masked:
            columns_masked.append(col)

        def _mask_freetext(s: str) -> str:
            return _mask_free_text_value(
                s, placeholder, span_provider,
                phone_anchor_boost=phone_anchor_boost,
            )

        # Distinct prose cells are span-scanned once each; the shared factory
        # still gives identical spans identical placeholders across cells.
        out[col] = _apply_over_uniques(out[col], _mask_freetext)

    return MaskDataFrameResult(df=out, registry=registry, columns_masked=columns_masked)

