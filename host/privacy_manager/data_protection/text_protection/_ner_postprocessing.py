"""NER span post-processing utilities for the sanitizer pipeline.

These helpers are pure functions that operate on string offsets — they
have no dependency on the sanitizer instance, ONNX runtime, or spaCy,
which keeps the post-processing rules unit-testable in isolation and the
detection orchestration in the main module uncluttered.

The module also owns the tuning constants (length floors, score
thresholds, stop-word frozensets) that the helpers consume. Anything a
reader needs to understand "what does the post-processing do" lives in
this single file.
"""

from __future__ import annotations

import re
from typing import List, Tuple

# --- NER post-processing tuning constants ---
# Length floors for NER-emitted spans by label family. The int8
# multilingual model frequently emits 1-3 char fragments on words it
# half-recognizes; a floor cuts most fragment-tag false positives.
NUMERIC_SHORT_OK = frozenset({"AGE", "BUILDINGNUM", "SEX", "GENDER"})
NO_SHORT_ESCAPE = frozenset({"CITY", "STREET"})
NER_MIN_LEN = 5
NER_HIGH_CONF_LEN = 4
NER_HIGH_CONF_SCORE = 0.85
NER_MIN_SCORE = 0.60
# Per-label score overrides. BUILDINGNUM consistently mis-fires on
# bare numeric tokens that look address-shaped ('401' HTTP status,
# '7777' card-ending, '99214' CPT). Bumping its floor to 0.85 cuts
# most false positives without losing real building numbers (which
# the model tags with 0.95+ when next to a STREET span).
PER_LABEL_MIN_SCORE = {
    "BUILDINGNUM": 0.85,
}

# Administrative-qualifier prefixes trimmed from CITY spans so the
# canonical city emerges. NER + right-extension may produce 'Port of
# Long Beach', 'City of San Francisco', etc.; the qualifier itself
# is generic English, not PII.
CITY_QUALIFIERS = (
    "Port of ", "City of ", "Town of ", "Village of ",
    "Borough of ", "District of ", "County of ",
    "Republic of ", "State of ", "Commonwealth of ",
)

# Tail tokens that flip a CITY span to ORG. NER routinely tags
# 'Stanford University', 'Mount Sinai Hospital' as CITY because they
# look toponym-shaped; reclassify when the tail token is a clear ORG
# marker.
ORG_SUFFIX_TOKENS = frozenset({
    # Business suffixes
    "Inc", "Inc.", "Corp", "Corp.", "Corporation",
    "LLC", "Ltd", "Ltd.", "Limited",
    "Co", "Co.", "Company",
    "GmbH", "AG", "SA", "BV", "NV", "AB", "Oy", "Plc",
    "Group", "Holdings", "Industries", "Partners",
    "Bank", "Capital", "Foundation", "Trust",
    # Institution / educational / health suffixes.
    "University", "College", "Institute", "Academy",
    "School", "Hospital", "Clinic", "Medical",
    "Center", "Centre", "Church", "Temple", "Mosque",
    "Synagogue", "Cathedral", "Library", "Museum",
    "Stadium", "Theater", "Theatre",
})

# BUILDINGNUM tags only count as real building numbers when within
# this many characters of a STREET span. Without that proximity check
# they're almost always issue / case / account / HTTP-status numbers.
STREET_PROXIMITY_CHARS = 30

# Single-word STREET spans must end in one of these tokens to count.
# A bare word like 'Mount' (NER fragment of 'Mount Sinai Hospital')
# isn't a street; 'Main' isn't either. Real single-word streets are
# vanishingly rare in partner traffic — this is a high-precision
# filter. Multi-word STREET spans bypass this check.
STREET_SUFFIX_TOKENS = frozenset({
    # English
    "st", "st.", "street", "ave", "ave.", "avenue", "rd", "rd.",
    "road", "blvd", "blvd.", "boulevard", "ln", "ln.", "lane",
    "dr", "dr.", "drive", "ct", "ct.", "court", "pl", "pl.",
    "place", "way", "pkwy", "parkway", "hwy", "highway", "terrace",
    "ter", "trail", "trl", "circle", "cir", "square", "sq",
    # German / French / Spanish suffixes seen in real partner traffic
    "strasse", "straße", "str.", "str", "rue", "avenida", "calle",
    "via",
})


# Sentence-leading capitalized words that are common English verbs /
# imperatives, NOT first names. Used by left-extension to refuse
# absorbing a sentence-start word ONLY when it matches one of these.
# Anything not in this list (typical first names like "Jane", "John",
# "Maria") gets absorbed even at sentence start, which is the right
# call for line-leading résumé / vCard inputs.
SENTENCE_START_VERBS = frozenset({
    "Email", "Send", "Tell", "Call", "Contact", "Reach", "Reply",
    "Mail", "Forward", "Fwd", "Reply", "Re",
    "Please", "Kindly", "Thank", "Thanks", "Regards",
    "Best", "Sincerely", "Respectfully",
    "Bill", "Mark", "Ship", "Pay", "Charge", "Issue",
    "Confirm", "Confirmed", "Cancel", "Cancelled",
    "From", "To", "Subject", "Date", "Sent",
    "Find", "See", "Note", "Notice", "Refer", "Review",
    "Deliver", "Pick", "Drop", "Give", "Take", "Get",
    "Order", "Schedule", "Book", "Reserve", "Update",
    "Stop", "Start", "Begin", "Continue", "Resume",
    "Open", "Close", "Approve", "Reject", "Sign",
    "Submit", "Upload", "Download", "Save", "Delete",
})


# Capitalized words we never want to absorb into a PERSON span. Surnames
# that happen to match (people named "Friday", "Bank", etc.) lose a few
# extra characters from their placeholder — that's fine. Over-extension
# in the other direction (absorbing a day, business suffix, or short
# acronym) would mask non-PII and is what we're guarding against.
NAME_EXTENSION_STOP_WORDS = frozenset({
    "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
    "AI", "IT", "HR", "IP", "PR", "QA", "VP", "SVP", "EVP",
    "CEO", "CFO", "CTO", "COO", "CIO", "CMO", "CHRO",
    "Inc", "Inc.", "Corp", "Corp.", "LLC", "Ltd", "Ltd.",
    "Industries", "Holdings", "Group", "Bank", "Capital", "Partners",
    "Jr", "Jr.", "Sr", "Sr.", "II", "III", "IV",
    # Administrative-subdivision qualifiers. These follow real
    # toponyms ("Cook County", "Westminster Borough") and are
    # never part of a PERSON name.
    "County", "Borough", "Parish", "District", "Province",
    "Prefecture", "Canton", "Region", "Township", "Municipality",
    "Shire",
    # Document / legal reference labels. NER occasionally tags
    # "Schedule A", "Exhibit B", "Article III" as PERSON because
    # they look like name + initial.
    "Schedule", "Exhibit", "Article", "Section", "Appendix",
    "Annex", "Attachment", "Clause", "Form",
    # Email / message conventions that follow capitalized verbs at
    # sentence start in business prose.
    "Re", "Re:", "Fwd", "Fwd:",
})

# Cap on how far rightward we extend a single PERSON span. A real
# multi-token name almost always fits in three additional words
# (e.g. "Mary Jane Watson", "John Quincy Adams").
NAME_EXTENSION_MAX_WORDS = 3


# Single capitalized words that are common English verbs / nouns
# also valid as short personal names. spaCy frequently mis-tags
# them as PERSON when they sit at sentence start ("Bill to:",
# "Mark the date", "Send Pat").
AMBIGUOUS_NAME_VERBS = frozenset({
    "Bill", "Mark", "Pat", "Rich", "Will", "Send", "Tell",
    "Drew", "Frank",
    "Email", "Phone", "Address", "Mobile", "Tel", "Fax",
    "Subject", "From", "To", "Re", "Fwd", "Reply",
    "Note", "Notes", "Dear", "Hi", "Hello", "Hey",
})


# Single-word PERSON spans rejected REGARDLESS of position.
NEVER_PERSON_TOKENS = frozenset({
    # Operating systems / mobile / desktop platforms
    "Android", "iOS", "iPadOS", "watchOS", "tvOS", "macOS",
    "Windows", "Linux", "Ubuntu", "Debian", "Fedora", "CentOS",
    "ChromeOS", "Solaris",
    # Browsers
    "Chrome", "Firefox", "Safari", "Edge", "Opera", "Brave", "Vivaldi",
    # Device / hardware product names (single-word)
    "Pixel", "iPhone", "iPad", "Galaxy", "Surface", "Echo",
    "Kindle", "Roku", "Xbox", "PlayStation", "Switch",
    # Programming languages / runtimes
    "Python", "Java", "Ruby", "Rust", "Swift", "Kotlin", "Scala",
    "Go", "Node", "Deno", "Django", "Flask", "Rails",
})


SPACY_ORG_STOP_WORDS = frozenset({
    "SSN", "DOB", "MRN", "IBAN", "ID", "API", "MAC", "URL", "JWT",
    "CEO", "CFO", "CTO", "COO", "VP", "SVP", "EVP", "HR", "IT",
    "BS", "BA", "MS", "MA", "MBA", "PhD", "MD", "JD", "DDS",
    "GPA", "SAT", "ACT", "GRE", "GMAT", "LSAT", "TOEFL", "IELTS",
    "Q1", "Q2", "Q3", "Q4", "FY", "YTD", "QTD", "MTD",
    "Driver", "User", "Subject", "From", "To", "Re", "Fwd",
    "Phone", "Email", "Address", "Mobile", "Cell", "Fax",
    "Tel", "Telephone", "Mail", "Web", "Website", "Site",
    "Date", "Time", "Name", "Title", "Role",
    "Patient", "Customer", "Member", "Holder", "Owner",
    "Bill", "Pay", "Pickup", "Delivery", "Shipping",
    "Status", "Total", "Subtotal", "Tax", "Discount",
    "Note", "Notes", "Comment", "Comments", "Reason",
    "Limit", "Limits", "Cap", "Caps", "Threshold", "Thresholds",
    "Balance", "Quota", "Budget", "Forecast", "Target",
    "Score", "Result", "Results", "Summary", "Overview",
    "Page", "Section", "Chapter", "Item", "Items",
    "Quantity", "Amount", "Count", "Number", "Volume",
    "Rate", "Rates", "Fee", "Fees", "Cost", "Costs", "Price", "Prices",
    "Kunde", "Anschrift", "Geburtsdatum", "Telefon", "Email",
    "PI", "PA", "RN", "RA", "TA", "GA", "MD", "DO", "DDS", "DVM",
    "DECLINED", "APPROVED", "REJECTED", "PENDING", "CONFIRMED",
    "CANCELLED", "EXPIRED", "ACTIVE", "INACTIVE", "PROCESSING",
    "COMPLETED", "FAILED", "SUCCESS", "ERROR",
    "Department", "Chair", "Head", "Lead", "Top", "Senior", "Junior",
    "Principal", "Assistant", "Associate", "Deputy", "Vice",
})


# Matches US visa-class codes: B1, B2, H1B, H2A, F1, F2, J1, J2, L1A,
# L1B, E1, E2, O1, K1, K3, etc.
VISA_CLASS_RE = re.compile(r"^[BHFJLEKO]\d[A-Z]?$", re.IGNORECASE)


# Role-prefix words to strip / not absorb when extending a PERSON
# span LEFTWARD.
NAME_LEFT_STOP_WORDS = frozenset({
    "Plaintiff", "Defendant", "Sender", "Recipient", "Beneficiary",
    "Customer", "Buyer", "Seller", "Vendor", "Client",
    "Patient", "Suspect", "Witness", "Owner", "Holder", "Member",
    "Carrier", "Shipper", "Consignee",
    "Subject", "From", "To", "Re", "Fwd",
    "Petitioner", "Respondent", "Donor", "Sponsor", "Applicant",
    "Donee", "Trustee", "Guarantor", "Cosigner",
    "Author", "Editor", "Reviewer", "Reporter",
    "Elector", "Voter", "Citizen", "Resident",
    "CEO", "CEOs", "CFO", "CFOs", "CTO", "CTOs", "COO", "COOs",
    "CIO", "CIOs", "CMO", "CMOs", "CHRO", "CHROs", "CRO", "CROs",
    "VP", "VPs", "SVP", "SVPs", "EVP", "EVPs",
    "President", "Presidents", "Director", "Directors",
    "Manager", "Managers", "Officer", "Officers",
    "Founder", "Founders", "Partner", "Partners",
    "Chair", "Chairs", "Chairman", "Chairwoman", "Chairperson",
    "Chief", "Head", "Lead",
    "Hi", "Hello", "Hey", "Greetings", "Dear", "Howdy",
    "Cheers", "Bonjour", "Hola", "Salaam", "Shalom",
    "Mr", "Mr.", "Ms", "Ms.", "Mrs", "Mrs.", "Dr", "Dr.",
    "Prof", "Prof.", "Mx", "Mx.", "Sir", "Madam", "Lady", "Lord",
})


# Role-prefix words to strip from the START of a spaCy ORG span.
ORG_LEADING_STOP_WORDS = frozenset({
    "Plaintiff", "Defendant", "Sender", "Recipient", "Beneficiary",
    "Customer", "Buyer", "Seller", "Vendor", "Client",
    "Carrier", "Shipper", "Consignee",
})


COMPOUND_CONNECTIVES = frozenset({
    "of", "de", "du", "da", "di", "del", "della", "von", "van",
    "der", "den", "the", "of the",
})


MIDDLE_INITIAL_RE = re.compile(r"[A-Z]\.(?:\s*[A-Z]\.)*")


# Cap on number of distinct compound-CITY prefixes the propagator
# will scan with. Bounds worst-case behavior on pathological inputs
# where a document contains many distinct compound toponyms.
COMPOUND_CITY_PREFIX_LIMIT = 16


_LABEL_LEFT_RE = re.compile(r"^[\s#*_>-]*$")
_LABEL_RIGHT_RE = re.compile(r"^[\s*_]*$")


def is_standalone_line(text: str, start: int, end: int) -> bool:
    """True if ``text[start:end]`` is the only content on its line (a title or heading).

    Prose such as ``Hello JoAnne, welcome`` and table cells are not standalone.
    """
    line_start = text.rfind("\n", 0, start) + 1
    line_end = text.find("\n", end)
    if line_end == -1:
        line_end = len(text)
    return bool(
        _LABEL_LEFT_RE.match(text[line_start:start])
        and _LABEL_RIGHT_RE.match(text[end:line_end])
    )


def is_spacy_org_false_positive(text: str) -> bool:
    """Return True if a spaCy ORG span is almost certainly junk.

    Called after _trim_span — `text` is already whitespace-stripped.
    """
    stripped = text.strip()
    if not stripped:
        return True
    if stripped in SPACY_ORG_STOP_WORDS:
        return True
    if len(stripped) <= 5 and stripped.isupper():
        return True
    if not stripped[0].isupper():
        return True
    if all(ch.isdigit() or ch.isspace() for ch in stripped):
        return True
    if " " in stripped:
        last_token = stripped.rsplit(maxsplit=1)[-1]
        if last_token in SPACY_ORG_STOP_WORDS:
            return True
        first_token = stripped.split(maxsplit=1)[0]
        if first_token in SPACY_ORG_STOP_WORDS:
            return True
        if first_token == "Visa" and VISA_CLASS_RE.match(last_token):
            return True
    return False


def extend_person_span_right(
    text: str,
    start: int,
    end: int,
    blocking_spans: List[Tuple[int, int]],
) -> int:
    """Walk rightward from ``end`` and return the new span end."""
    cursor = end
    absorbed = 0
    text_len = len(text)
    _WORD_END = " \t\n\r,;:!?()\""
    while absorbed < NAME_EXTENSION_MAX_WORDS:
        if cursor >= text_len or text[cursor] != " ":
            return cursor
        next_start = cursor + 1
        if next_start >= text_len:
            return cursor

        i = next_start
        while i < text_len and text[i] not in _WORD_END:
            i += 1
        word = text[next_start:i]

        if not word:
            return cursor
        if not (word[0].isalpha() and word[0].isupper()):
            return cursor
        if not all(c.isalpha() or c in "-'." for c in word):
            return cursor
        if word in NAME_EXTENSION_STOP_WORDS:
            return cursor
        apos_idx = word.find("'")
        if apos_idx >= 0 and apos_idx + 1 < len(word) and word[apos_idx + 1].islower():
            return cursor

        if any(max(next_start, b_s) < min(i, b_e) for b_s, b_e in blocking_spans):
            return cursor

        cursor = i
        absorbed += 1
    return cursor


def is_name_extension(
    text: str, outer_start: int, outer_end: int, inner_start: int, inner_end: int
) -> bool:
    """Return True when outer extends inner rightward by a name fragment only."""
    if outer_start < inner_start:
        return False

    if inner_end < outer_end:
        right = text[inner_end:outer_end]
        if not (
            len(right) >= 2
            and right.startswith(" ")
            and right[1].isalpha()
            and right[1].isupper()
            and all(c.isalpha() or c in "-'." for c in right[1:])
        ):
            return False

    return True


def repair_word_boundary_right(text: str, end: int) -> int:
    """If a span ends mid-word, walk end RIGHT to the nearest boundary."""
    n = len(text)
    if end >= n:
        return end

    def is_intra_word(ch: str) -> bool:
        return ch.isalnum() or ch in "-'"

    if not is_intra_word(text[end]):
        return end
    new_end = end
    limit = min(n, end + 20)
    while new_end < limit and is_intra_word(text[new_end]):
        new_end += 1
    return new_end


def repair_word_boundary_left(text: str, start: int) -> int:
    """If a NER span starts mid-word, walk start LEFT to the nearest boundary."""
    if start <= 0:
        return start

    def is_intra_word(ch: str) -> bool:
        return ch.isalnum() or ch in "-'"

    if not is_intra_word(text[start - 1]):
        return start
    new_start = start
    limit = max(0, start - 20)
    while new_start > limit and is_intra_word(text[new_start - 1]):
        new_start -= 1
    return new_start


def is_sentence_start(text: str, pos: int) -> bool:
    """Return True if pos is at the start of a sentence (or input)."""
    i = pos
    while i > 0 and text[i - 1] in " \t":
        i -= 1
    if i == 0:
        return True
    return text[i - 1] in ".!?\n\r"


def extend_city_span_right(
    text: str,
    start: int,
    end: int,
    blocking_spans: List[Tuple[int, int]],
) -> int:
    """Walk rightward from end absorbing compound-CITY tokens."""
    cursor = end
    absorbed = 0
    text_len = len(text)
    while absorbed < NAME_EXTENSION_MAX_WORDS:
        if cursor >= text_len or text[cursor] != " ":
            return cursor
        next_start = cursor + 1
        if next_start >= text_len:
            return cursor
        i = next_start
        while i < text_len and text[i] not in " \t\n\r,.;:":
            i += 1
        word = text[next_start:i]
        if not word:
            return cursor
        if word.lower() in COMPOUND_CONNECTIVES:
            if i >= text_len or text[i] != " ":
                return cursor
            j = i + 1
            k = j
            while k < text_len and text[k] not in " \t\n\r,.;:":
                k += 1
            after_conn = text[j:k]
            if not after_conn or not (after_conn[0].isalpha() and after_conn[0].isupper()):
                return cursor
            if any(max(next_start, b_s) < min(k, b_e) for b_s, b_e in blocking_spans):
                return cursor
            cursor = k
            absorbed += 2
            continue
        if not (word[0].isalpha() and word[0].isupper()):
            return cursor
        if not all(c.isalpha() or c in "-'." for c in word):
            return cursor
        if any(max(next_start, b_s) < min(i, b_e) for b_s, b_e in blocking_spans):
            return cursor
        cursor = i
        absorbed += 1
    return cursor


def extend_person_span_left(
    text: str,
    start: int,
    end: int,
    blocking_spans: List[Tuple[int, int]],
) -> int:
    """Walk leftward from start absorbing capitalized name fragments."""
    cursor = start
    absorbed = 0
    _SEP_CHARS = (" ", "\t")
    while absorbed < NAME_EXTENSION_MAX_WORDS:
        if cursor <= 0 or text[cursor - 1] not in _SEP_CHARS:
            return cursor
        word_end = cursor - 1
        if word_end <= 0:
            return cursor
        _WORD_BREAK = " \t\n\r\"'`(),;:"
        i = word_end
        while i > 0 and text[i - 1] not in _WORD_BREAK:
            i -= 1
        word = text[i:word_end]
        if not word:
            return cursor
        if not (word[0].isalpha() and word[0].isupper()):
            return cursor
        if not all(c.isalpha() or c in "-'." for c in word):
            return cursor
        if word in NAME_EXTENSION_STOP_WORDS or word in NAME_LEFT_STOP_WORDS:
            return cursor
        apos_idx = word.find("'")
        if apos_idx >= 0 and apos_idx + 1 < len(word) and word[apos_idx + 1].islower():
            return cursor
        if any(max(i, b_s) < min(word_end, b_e) for b_s, b_e in blocking_spans):
            return cursor
        if is_sentence_start(text, i) and word in SENTENCE_START_VERBS:
            return cursor
        cursor = i
        absorbed += 1
    return cursor


def strip_leading_stop_words(
    text: str, start: int, end: int, stop_words: frozenset
) -> int:
    """Drop leading stop-list tokens from a span."""
    for _ in range(2):
        cursor = start
        while cursor < end and text[cursor] in " \t\n\r":
            cursor += 1
        token_start = cursor
        while cursor < end and text[cursor] not in " \t\n\r,;:":
            cursor += 1
        token = text[token_start:cursor]
        if not token or token not in stop_words:
            return start
        new_start = cursor
        while new_start < end and text[new_start] in " \t\n\r":
            new_start += 1
        if new_start >= end:
            return start
        start = new_start
    return start


def is_person_merge_bridge(gap: str) -> bool:
    """Return True when gap is content that can sit between two same-category tokens."""
    if len(gap) > 7:
        return False
    stripped = gap.strip()
    if not stripped:
        return True
    if stripped in {"-", "'"}:
        return True
    if stripped.lower() in COMPOUND_CONNECTIVES:
        return True
    return bool(MIDDLE_INITIAL_RE.fullmatch(stripped))


def strip_person_trailing_stop(text: str, start: int, end: int) -> int:
    """Trim trailing tokens from a PERSON span when they're stop-list tokens."""
    for _ in range(2):
        cursor = end
        while cursor > start and text[cursor - 1] in " \t\n\r,.;:!?":
            cursor -= 1
        token_end = cursor
        while cursor > start and text[cursor - 1] not in " \t\n\r":
            cursor -= 1
        token = text[cursor:token_end]
        if not token or token not in NAME_EXTENSION_STOP_WORDS:
            return end
        new_end = cursor
        while new_end > start and text[new_end - 1] in " \t\n\r":
            new_end -= 1
        if new_end <= start:
            return end
        end = new_end
    return end


def trim_span(text: str, start: int, end: int) -> Tuple[int, int]:
    """Shrink [start:end) so it doesn't capture leading/trailing whitespace or punctuation."""
    while start < end and text[start] in " \t\n\r":
        start += 1
    while end > start and text[end - 1] in " \t\n\r,.;:!?\"'()[]":
        end -= 1
    return start, end
