"""Value validators shared by the file-pipeline detector and masker.

Each validator answers one question: "does this single string look like a
value of category X, with enough structural certainty that flagging its
column as PII is safe?" They are deliberately conservative on the
positive side (a false *positive* here over-masks and degrades the
downstream analysis) but never on the negative side for high-confidence
formats — a value that passes a checksum (Luhn, IBAN mod-97) is treated
as certain.

This module is dependency-light (stdlib only) and lives in ``common`` so
BOTH backends can share it without the file backend pulling in the heavy
``text_protection`` ML stack. The text backend's regex tables in
``text_protection._sanitizer_constants`` remain the authority for
free-text span *detection*; this module is the authority for tabular
*column classification* where we can validate whole-cell values.

Category vocabulary is the canonical set used across the service:
``PERSON EMAIL PHONE URL DATETIME ID ORG FINANCIAL SECRET STREET
BUILDINGNUM ZIPCODE CITY AGE SEX GENDER COUNTRY COUNTY``. The file
detector may emit a few aliases (``ADDRESS``, ``ACCOUNT``, ``ID_NUM``);
:func:`canonical_category` maps them onto the canonical set
so operators see one vocabulary regardless of which pipeline produced a
placeholder.
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Callable

# --------------------------------------------------------------------------
# Taxonomy alignment
# --------------------------------------------------------------------------

# File-pipeline aliases -> canonical category. Applied at the boundary so
# the registry the client receives uses the same names the text pipeline
# emits. Restore is unaffected (it maps placeholder -> value regardless of
# category), but a shared vocabulary lets operators reason about one set.
_CATEGORY_ALIASES: dict[str, str] = {
    "ID_NUM": "ID",
    "ACCOUNT": "FINANCIAL",
    "ADDRESS": "STREET",
    "POSTCODE": "ZIPCODE",
    "ZIP": "ZIPCODE",
}


def canonical_category(category: str) -> str:
    """Map a file-pipeline category alias to the canonical name."""
    return _CATEGORY_ALIASES.get(category.upper(), category.upper())


# --------------------------------------------------------------------------
# Regexes (anchored — these validate a WHOLE cell value, not a span)
# --------------------------------------------------------------------------

_EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$")
_URL_RE = re.compile(r"^https?://[^\s]+$", re.IGNORECASE)
_SSN_RE = re.compile(r"^\d{3}-\d{2}-\d{4}$")
_IPV4_RE = re.compile(r"^(?:\d{1,3}\.){3}\d{1,3}$")
_IPV6_RE = re.compile(r"^(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}$")
_POSTCODE_RE = re.compile(
    r"^\d{5}(?:-\d{4})?$|^[A-Z]\d[A-Z]\s?\d[A-Z]\d$", re.IGNORECASE
)
# Two-to-four capitalized tokens; each token may carry an internal
# apostrophe / hyphen (O'Brien, Jean-Luc). No corporate suffix (that's
# handled as a negative signal by the caller).
_PERSON_RE = re.compile(r"^[A-Z][a-z'\-]+(?:\s+[A-Z][a-z'\-]+){1,3}$")
# Tightened generic ID: an explicit alpha prefix + digits, OR a pure
# digit run of a plausible identifier length. Bare 6-12 digit runs are
# too easily order numbers / quantities, so we require either the alpha
# prefix or a length outside the "small integer" range handled by the
# caller's cardinality signal.
_GENERIC_ID_RE = re.compile(r"^(?:[A-Z]{2,4}[-_]?\d{4,}|\d{7,})$", re.IGNORECASE)
# ISO-4217 currency codes glued directly to a bare amount ("USD150000",
# "EUR2500") match the alpha-prefixed ID shape but are monetary amounts, not
# identifiers — masking them as ID is over-redaction (and mis-categorized).
# A real prefixed ID uses a separator (INV-150000) or a non-currency prefix,
# so this guard costs no ID recall. Matched case-insensitively, prefix only
# (a separator like "USD-150000" is a deliberate ID and is NOT excluded).
_CURRENCY_PREFIX_RE = re.compile(
    r"^(?:USD|EUR|GBP|JPY|CNY|CHF|CAD|AUD|NZD|HKD|SGD|SEK|NOK|INR|RUB|BRL|"
    r"ZAR|KRW|MXN|TRY|AED)\d+$",
    re.IGNORECASE,
)
_IBAN_RE = re.compile(r"^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$")

# Corporate suffixes that mark an ORG value (used as a PERSON negative
# signal and a weak ORG positive signal).
_ORG_SUFFIX_RE = re.compile(
    r"\b(?:inc|inc\.|llc|ltd|ltd\.|corp|corp\.|co|co\.|gmbh|plc|"
    r"industries|holdings|group|partners|associates|company|"
    r"limited|incorporated|corporation)\b",
    re.IGNORECASE,
)


# --------------------------------------------------------------------------
# Checksum validators
# --------------------------------------------------------------------------


def luhn_ok(digits: str) -> bool:
    """Verify a credit-card-style number with the Luhn checksum."""
    if not digits.isdigit() or len(digits) < 13:
        return False
    s = 0
    parity = len(digits) % 2
    for i, ch in enumerate(digits):
        d = int(ch)
        if i % 2 == parity:
            d *= 2
            if d > 9:
                d -= 9
        s += d
    return s % 10 == 0


def looks_like_card(value: str) -> bool:
    digits = re.sub(r"[\s\-]", "", value)
    return digits.isdigit() and 13 <= len(digits) <= 19 and luhn_ok(digits)


def iban_ok(value: str) -> bool:
    """Validate an IBAN with the ISO 13616 mod-97 checksum.

    Format check first, then move the 4-char country+check prefix to the
    end, map letters to numbers (A=10 … Z=35), and require the big
    integer mod 97 == 1.
    """
    v = re.sub(r"\s", "", value).upper()
    if not _IBAN_RE.match(v) or not (15 <= len(v) <= 34):
        return False
    rearranged = v[4:] + v[:4]
    digits = "".join(
        str(int(ch, 36)) if ch.isalpha() else ch for ch in rearranged
    )
    try:
        return int(digits) % 97 == 1
    except ValueError:
        return False


# --------------------------------------------------------------------------
# Format validators
# --------------------------------------------------------------------------


def is_email(v: str) -> bool:
    return bool(_EMAIL_RE.match(v))


def is_url(v: str) -> bool:
    return bool(_URL_RE.match(v))


def is_ssn(v: str) -> bool:
    return bool(_SSN_RE.match(v))


def is_ipv4(v: str) -> bool:
    if not _IPV4_RE.match(v):
        return False
    return all(0 <= int(octet) <= 255 for octet in v.split("."))


def is_ipv6(v: str) -> bool:
    return bool(_IPV6_RE.match(v)) and v.count(":") >= 2


def is_postcode(v: str) -> bool:
    return bool(_POSTCODE_RE.match(v))


# A bare 5-digit run is indistinguishable from an amount, quantity or ID, so
# inside free text it only counts as a postcode with a left-context anchor.
_ZIP_CONTEXT_RE = re.compile(
    r"(?:\b(?:zip\s*code|postal\s*code|postcode|zip)[\s*_]*[:=#]?[\s*_]*$"
    r"|(?-i:\b(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA"
    r"|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT"
    r"|VT|VA|WA|WV|WI|WY|DC)[\s*_]*,?[\s*_]*$)"
    r"|(?-i:[A-Z][a-z]+,[\s*_]*$))",
    re.IGNORECASE,
)


def is_postcode_in_context(v: str, left_context: str = "") -> bool:
    """Postcode shape check; a bare 5-digit value also needs a left anchor.

    ZIP+4 and the Canadian ``A1A 1A1`` shape are unambiguous on shape alone.
    """
    if not _POSTCODE_RE.match(v):
        return False
    if len(v) != 5 or not v.isdigit():
        return True
    return bool(_ZIP_CONTEXT_RE.search(left_context))


_NAME_PREFIX_RE = re.compile(r"^(?:Mc|Mac|De|Di|Du|La|Le|Van|Von|O')[A-Z]")


def is_camelcase_identifier(text: str) -> bool:
    """True for a single token like ``SaleData`` (lower-to-upper inside).

    Real surnames with an internal capital start with a known prefix
    (McDonald, DeShawn, O'Brien), so those are spared.
    """
    if " " in text or not re.search(r"[a-z][A-Z]", text):
        return False
    return not _NAME_PREFIX_RE.match(text)


# Generic data-column words; a compound token is a label only if every part is one.
_COLUMN_WORDS = frozenset(
    "order date data sale sales man item unit units price amt amount qty quantity "
    "total region manager id no num number count type status name cost rate "
    "product customer category time year month day value code desc description "
    "revenue profit discount tax stock store ship shipping report summary dept "
    "department".split()
)
_COLUMN_PART_RE = re.compile(r"[A-Z][a-z]*|[a-z]+")


def is_column_identifier(text: str) -> bool:
    """A CamelCase or snake_case token made only of generic column words.

    ``SalesMan`` and ``Sale_amt`` qualify; ``OpenAI`` and ``JoAnne`` do not.
    """
    if not re.fullmatch(r"[A-Za-z_]+", text):
        return False
    if not (is_camelcase_identifier(text) or "_" in text):
        return False
    parts = _COLUMN_PART_RE.findall(text)
    return bool(parts) and all(p.lower() in _COLUMN_WORDS for p in parts)


def is_person_like(v: str) -> bool:
    """Two-to-four capitalized tokens, no corporate suffix."""
    return bool(_PERSON_RE.match(v)) and not _ORG_SUFFIX_RE.search(v)


def is_org_like(v: str) -> bool:
    """A multi-token value ending in / containing a corporate suffix."""
    return bool(_ORG_SUFFIX_RE.search(v))


# Generic formal-document / contract boilerplate that NER (esp. spaCy ORG)
# routinely mis-tags as an organization in dense financial docs. Lowercased;
# matched as a case-insensitive substring so "Resolution Time: Service
# Provider" is caught via "service provider". Deliberately SMALL and generic —
# only terms that are never themselves a company name. Operators extend this
# via ``sanitize.redact_org_boilerplate_terms``.
_ORG_BOILERPLATE_DEFAULT: frozenset[str] = frozenset({
    "service provider", "performance standards", "performance metrics",
    "resilience metrics", "resolution time", "response time",
    "service level", "service levels", "terms and conditions",
    "table of contents", "executive summary", "scope of work",
    "statement of work", "key performance", "vendor", "supplier",
})

# Minimum length for a SINGLE all-caps token to be treated as a screaming
# header rather than a company acronym (spares IBM/NASA/HSBC-style 2-5 char
# acronyms; catches VENDOR/CONFIDENTIAL-style headers).
_ORG_HEADER_MIN_CAPS_LEN = 6


def is_org_boilerplate(value: str, extra_terms: "tuple[str, ...]" = ()) -> bool:
    """True if an ORG span value is generic document boilerplate, not a name.

    Two signals: an ALL-CAPS "screaming header" shape (multi-word, or a single
    token >= 6 chars so common acronyms survive), or a case-insensitive match
    against the boilerplate gazetteer. A value carrying a corporate suffix
    (Inc/Ltd/LLC/...) is NEVER boilerplate — that protects real registered
    entities. Used only by the file span provider's opt-in ORG guard.
    """
    v = value.strip()
    if not v:
        return False
    # Never suppress something that looks like a real registered company.
    if is_org_like(v):
        return False
    letters = [c for c in v if c.isalpha()]
    if letters and all(c.isupper() for c in letters):
        # All-caps: drop if multi-word or a long single token.
        if " " in v or len(letters) >= _ORG_HEADER_MIN_CAPS_LEN:
            return True
    norm = re.sub(r"\s+", " ", v.lower())
    terms = _ORG_BOILERPLATE_DEFAULT.union(t.lower() for t in extra_terms)
    return any(term in norm for term in terms)


def is_generic_id(v: str) -> bool:
    if _CURRENCY_PREFIX_RE.match(v):
        return False  # "USD150000" is a monetary amount, not an identifier
    return bool(_GENERIC_ID_RE.match(v))


# Phone: require a plausible digit count (7-15 per E.164) after stripping
# separators, AND phone-like punctuation — a leading '+' or at least one
# separator (space / hyphen / dot / parens). A bare digit run like
# "1000001" is an identifier/quantity, not a phone number, so we don't
# claim it (that avoids swallowing low-cardinality numeric enums and
# order numbers as PHONE).
_PHONE_SHAPE_RE = re.compile(r"^\+?[\d\s\-().]{7,}$")
_PHONE_PUNCT_RE = re.compile(r"[\s\-().]")


def is_phone(v: str) -> bool:
    if not _PHONE_SHAPE_RE.match(v):
        return False
    # An ISO / slashed calendar date ("2022-12-15", "12/03/2024") satisfies
    # the phone shape (7-8 digits + separators) but is never a phone number.
    # Reject it here so a date in prose isn't masked as PHONE — a pure
    # over-redaction with no offsetting recall (a real phone never parses
    # as a calendar date).
    if is_datetime(v):
        return False
    digit_count = sum(c.isdigit() for c in v)
    if not (7 <= digit_count <= 15):
        return False
    # Require a '+' prefix or interior separator so a bare digit run
    # doesn't read as a phone number.
    return v.startswith("+") or bool(_PHONE_PUNCT_RE.search(v))


# Anchor words that, when they immediately precede a phone-shaped value,
# confirm it is a phone number even if the strict digit bounds don't hold
# (international grouping / extensions push the count outside 7-15, or a
# short local number). Matched against the LEFT context window, case-insens.
_PHONE_ANCHOR_RE = re.compile(
    r"(?:phone|tel|telephone|mobile|cell|cellphone|fax|call|contact|"
    r"whatsapp|hotline|dial)\b[\s:.#]*$",
    re.IGNORECASE,
)
# With an anchor present we widen the digit bound (some real numbers with
# country + area + extension exceed 15), but keep a sane ceiling so an
# anchor doesn't turn an arbitrary long digit run into a phone.
_PHONE_ANCHOR_MAX_DIGITS = 17


def is_phone_with_context(value: str, left_context: str = "") -> bool:
    """Phone confirmation with an optional left-context anchor boost.

    Returns True if ``value`` passes the strict :func:`is_phone`, OR a phone
    anchor word ("phone:", "tel", "call", "fax", …) immediately precedes it
    and the value is a plausible phone shape with 6-17 digits. The anchor is
    strong, unambiguous evidence, so this recovers real phones the strict
    bounds reject without opening the door to bare digit runs. A calendar
    date is still rejected even with an anchor."""
    if is_phone(value):
        return True
    if not left_context or not _PHONE_ANCHOR_RE.search(left_context):
        return False
    if not _PHONE_SHAPE_RE.match(value) or is_datetime(value):
        return False
    digit_count = sum(c.isdigit() for c in value)
    if not (6 <= digit_count <= _PHONE_ANCHOR_MAX_DIGITS):
        return False
    return value.startswith("+") or bool(_PHONE_PUNCT_RE.search(value))


# Datetime / DOB: try a handful of common unambiguous formats. We do NOT
# use dateutil (extra dep) — a curated format list keeps false positives
# down (a bare "2020" or "12" won't parse).
_DATE_FORMATS = (
    "%Y-%m-%d", "%d/%m/%Y", "%m/%d/%Y", "%d-%m-%Y", "%m-%d-%Y",
    "%Y/%m/%d", "%d %b %Y", "%d %B %Y", "%b %d, %Y", "%B %d, %Y",
    "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S",
)


def is_datetime(v: str) -> bool:
    v = v.strip()
    # Reject bare integers / floats that strptime("%Y...") would accept
    # loosely on some platforms; require at least one separator.
    if not any(sep in v for sep in ("-", "/", " ", ":", ",")):
        return False
    for fmt in _DATE_FORMATS:
        try:
            datetime.strptime(v, fmt)
            return True
        except ValueError:
            continue
    return False


# --------------------------------------------------------------------------
# Detector registry — (category, predicate, weight, reason)
# --------------------------------------------------------------------------
#
# ``weight`` expresses per-hit certainty for the evidence-scoring model in
# detect.py. Checksum-backed detectors (card, IBAN, SSN, email) carry the
# highest weight; shape-only detectors (person, phone) carry less because
# they collide with non-PII more often. Ordering also matters as a
# tiebreak: narrower detectors precede the looser PHONE / ID patterns so a
# column of SSNs isn't first claimed by the phone matcher.

# --------------------------------------------------------------------------
# Span patterns — for sub-cell scanning of FREE-TEXT columns
# --------------------------------------------------------------------------
#
# Unlike the anchored validators above (which check a whole cell), these
# find PII *within* a longer string (a notes / comments / description
# cell). They are intentionally a conservative, high-precision subset:
# formats that are unambiguous inside prose. PERSON / ORG are NOT here —
# they need NER, which is the opt-in sanitizer route wired from the
# service layer (file_protection stays model-free). Categories are canonical.
#
# Ordered longest-/most-specific-first so overlapping matches resolve to
# the more specific category (email before URL, card before generic id).

SPAN_PATTERNS: tuple[tuple[str, "re.Pattern[str]"], ...] = (
    # HIGHEST PRIORITY — neutralize any substring that already LOOKS like
    # one of our placeholders (``<EMAIL_1>`` etc.) appearing literally in
    # the source prose. Left verbatim, it would collide with the
    # restore-time regex and be wrongly substituted. Masking it to a fresh
    # <TOKEN_n> placeholder makes the cell round-trip exactly — the same
    # protection the whole-cell masker gets for free by masking the entire
    # opaque value. Matches the restore pattern in file_protection.restore.
    ("TOKEN", re.compile(r"<[A-Za-z_]+_\d+>")),
    ("EMAIL", re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")),
    # URL: stop at whitespace AND at markup/quote delimiters (``<>"'``) so a
    # URL embedded in HTML/JSON prose (``href="https://x/y">``) doesn't
    # swallow the trailing ``"`` / ``>`` into the span, and don't END on
    # sentence punctuation (``. , ; : ! ? ) ] }``) so "see https://x.com/p."
    # masks the URL, not the closing period. Both trims keep the span
    # aligned to the true URL boundary. ``is_url`` re-confirms the trimmed
    # span.
    ("URL", re.compile(
        r"https?://[^\s<>\"']*[^\s<>\"'.,;:!?)\]}]", re.IGNORECASE
    )),
    # IBAN: 2-letter country + 2 check digits + 11-30 alphanumerics. Confirmed
    # by iban_ok (mod-97). Listed before the card pattern so an IBAN's leading
    # letters anchor the whole token rather than a digit run inside it.
    ("FINANCIAL", re.compile(r"\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b")),
    ("FINANCIAL", re.compile(
        # card-ish digit run; Luhn re-checked below. Must start and end on
        # a digit so a trailing space/hyphen isn't swallowed into the span
        # (which would corrupt restore and eat the following separator).
        r"\b\d(?:[ -]?\d){12,18}\b"
    )),
    ("ID", re.compile(r"\b\d{3}-\d{2}-\d{4}\b")),  # SSN
    ("ID", re.compile(r"\b[A-Z]{2,4}[-_]?\d{4,}\b")),  # alpha-prefixed ID (INV-1234)
    # ZIPCODE before PHONE: a US 5(-4) or CA postcode. Confirmed by
    # is_postcode, so a valid postcode claims its span first; a non-postcode
    # digit-run fails confirm (claims nothing) and falls through to PHONE.
    ("ZIPCODE", re.compile(
        r"\b\d{5}(?:-\d{4})?\b|\b[A-Z]\d[A-Z]\s?\d[A-Z]\d\b"
    )),
    # DATETIME before PHONE: an ISO / slashed / dashed calendar date (a date
    # of birth, transaction date, etc. is PII). Confirmed by is_datetime, so a
    # non-date digit run fails confirm and falls through to PHONE. Placed
    # BEFORE the loose PHONE pattern because an ISO date ("2022-12-15") also
    # satisfies the phone shape — without this it would be masked, but under
    # the wrong PHONE category. Numeric-month forms only; textual-month prose
    # ("March 5, 2020") is left to NER, which is on by default.
    ("DATETIME", re.compile(
        r"\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2})?\b"   # ISO date / datetime
        r"|\b\d{1,2}[/-]\d{1,2}[/-]\d{4}\b"                  # d/m/Y or m/d/Y
        r"|\b\d{4}/\d{2}/\d{2}\b"                            # Y/m/d
    )),
    ("PHONE", re.compile(
        r"(?<![\w.])\+?\d(?:[\d\s\-().]{5,}\d)(?![\w])"
    )),
    ("URL", re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")),  # IPv4
)

# Span matches for these categories are only accepted if they also pass
# the corresponding checksum/shape validator — kills false positives from
# the loose digit-run patterns above.
_SPAN_CONFIRM: dict[str, Callable[[str], bool]] = {
    # FINANCIAL spans may be a Luhn-valid card OR a mod-97-valid IBAN.
    "FINANCIAL": lambda v: looks_like_card(v) or iban_ok(v),
    "PHONE": is_phone,
    "URL": lambda v: is_url(v) or is_ipv4(v),
    "ID": lambda v: is_ssn(v) or is_generic_id(v),
    "ZIPCODE": is_postcode,
    "DATETIME": is_datetime,
}


# Characters of left context to inspect for a PHONE anchor word.
_PHONE_CONTEXT_WINDOW = 24


def span_confirm(
    category: str,
    value: str,
    *,
    left_context: str | None = None,
    phone_anchor_boost: bool = False,
) -> bool:
    """Validate a candidate span for categories that need confirmation.

    ``left_context`` is the text immediately preceding the span; when
    ``phone_anchor_boost`` is True a PHONE candidate that fails the strict
    :func:`is_phone` is re-checked against a preceding anchor word ("phone:",
    "tel", "call", …). Both default off so existing callers are unchanged.
    """
    if category == "PHONE" and phone_anchor_boost:
        return is_phone_with_context(value, left_context or "")
    if category == "ZIPCODE":
        return is_postcode_in_context(value, left_context or "")
    check = _SPAN_CONFIRM.get(category)
    return check(value) if check is not None else True


ContentDetector = tuple[str, Callable[[str], bool], float, str]

CONTENT_DETECTORS: tuple[ContentDetector, ...] = (
    ("EMAIL",     is_email,        1.00, "email regex"),
    ("URL",       is_url,          0.95, "URL regex"),
    ("FINANCIAL", looks_like_card, 1.00, "Luhn-checked card number"),
    ("FINANCIAL", iban_ok,         1.00, "IBAN mod-97 checksum"),
    ("ID",        is_ssn,          1.00, "SSN-shape regex"),
    ("URL",       is_ipv4,         0.90, "IPv4 address"),
    ("URL",       is_ipv6,         0.90, "IPv6 address"),
    ("DATETIME",  is_datetime,     0.80, "date/datetime parse"),
    ("PHONE",     is_phone,        0.75, "phone digit-count regex"),
    ("ID",        is_generic_id,   0.70, "generic ID pattern"),
    ("ZIPCODE",   is_postcode,     0.70, "postcode pattern"),
    ("ORG",       is_org_like,     0.65, "corporate suffix"),
    ("PERSON",    is_person_like,  0.55, "capitalized-name pattern"),
)
