"""
Sender matching and scoring for the email agent.
================================================
The pure half of sender resolution, split out of email_pipeline.py as the second
of two extractions; it takes that file from 2,035 code lines to 1,879, under the
ratchet's 2,000 threshold and off the god-file list. Everything here is a value
transform: a raw sender query in, a SenderFilter or a 0-100 score out. No
database, no configuration, no LLM.

The config-and-database half stays in email_pipeline.py on purpose.
resolve_sender() reads the _cfg singleton for its threshold and
_fuzzy_resolve_sender_name() queries ai_inbox, so importing them here would mean
either dragging configuration into a pure module or creating an import cycle.

A SenderFilter carries two independent mechanisms, and both must agree for an
email to match: SQL clauses that cheaply narrow the candidate rows, and a fuzzy
score compared against fuzzy_threshold. An exact address pins the threshold to
100 so only that address can pass.

Tests: tests/agents/email/test_email_senders.py
"""

from __future__ import annotations

import logging
import re
import unicodedata
from dataclasses import dataclass
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    # Email is the pipeline's database row type; only needed for annotations,
    # which `from __future__ import annotations` keeps as strings at runtime.
    from email_pipeline import Email

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Optional third-party: fuzzy matching
# ---------------------------------------------------------------------------
try:
    from rapidfuzz import fuzz as _rfuzz

    def fuzzy_ratio(a: str, b: str) -> float:
        return _rfuzz.token_set_ratio(a, b)

    FUZZY_BACKEND = "rapidfuzz"

except ImportError:
    from difflib import SequenceMatcher

    def fuzzy_ratio(a: str, b: str) -> float:  # type: ignore[misc]
        r1 = SequenceMatcher(None, a.lower(), b.lower()).ratio() * 100
        r2 = SequenceMatcher(None, b.lower(), a.lower()).ratio() * 100
        return max(r1, r2)

    FUZZY_BACKEND = "difflib"

_DEFAULT_FUZZY_THRESHOLD = 72.0


@dataclass
class SenderFilter:
    raw_query: str
    is_email: bool
    email_exact: str
    email_local: str
    email_domain: str
    name_tokens: set[str]
    sql_clauses: list[str]
    sql_params: list[str]
    fuzzy_threshold: float


def _strip_accents(text: str) -> str:
    return "".join(
        c for c in unicodedata.normalize("NFD", text) if unicodedata.category(c) != "Mn"
    )


def _normalise(text: str) -> str:
    text = _strip_accents(text.lower())
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


def name_to_tokens(raw_name: str) -> set[str]:
    return set(_normalise(raw_name).split())


def email_to_name_tokens(email_addr: str) -> set[str]:
    local = email_addr.split("@")[0].lower()
    return {t for t in re.split(r"[._\-+]", local) if t}


def name_match_score(query_tokens: set[str], candidate_name: str) -> float:
    if not query_tokens or not candidate_name:
        return 0.0
    candidate_tokens = name_to_tokens(candidate_name)
    if not candidate_tokens:
        return 0.0
    if query_tokens.issubset(candidate_tokens):
        return 100.0
    exact_hits = query_tokens & candidate_tokens
    if exact_hits:
        return 60.0 + 30.0 * len(exact_hits) / len(query_tokens)
    prefix_hits = sum(
        1 for qt in query_tokens if any(ct.startswith(qt) for ct in candidate_tokens)
    )
    if prefix_hits == len(query_tokens):
        return 80.0
    return fuzzy_ratio(
        " ".join(sorted(query_tokens)), " ".join(sorted(candidate_tokens))
    )


def build_sender_filter(
    raw_query: str, fuzzy_threshold: float = _DEFAULT_FUZZY_THRESHOLD
) -> SenderFilter:
    q = raw_query.strip()
    is_email = bool(re.search(r"[@.]", q)) and " " not in q
    email_exact = email_local = email_domain = ""
    name_tokens: set[str] = set()
    sql_clauses: list[str] = []
    sql_params: list[str] = []
    seen: set[tuple[str, str]] = set()

    def _add(clause: str, param: str) -> None:
        key = (clause, param)
        if key not in seen:
            seen.add(key)
            sql_clauses.append(clause)
            sql_params.append(param)

    if is_email and "@" in q:
        email_exact = q.lower()
        email_local, email_domain = q.lower().split("@", 1)
        name_tokens = email_to_name_tokens(q)
        sql_clauses.append("LOWER(from_email) = ?")
        sql_params.append(email_exact)
        fuzzy_threshold = 100.0
    elif is_email:
        email_local = q.lower()
        name_tokens = email_to_name_tokens(q)
        _add("LOWER(from_email) LIKE ?", f"%{email_local}%")
        for token in name_tokens:
            if len(token) >= 2:
                _add("LOWER(from_name) LIKE ?", f"%{token}%")
    else:
        name_tokens = name_to_tokens(q)
        for token in name_tokens:
            if len(token) < 2:
                continue
            _add("LOWER(from_name) LIKE ?", f"%{token}%")
            _add("LOWER(from_email) LIKE ?", f"%{token}%")

    return SenderFilter(
        raw_query=q,
        is_email=is_email,
        email_exact=email_exact,
        email_local=email_local,
        email_domain=email_domain,
        name_tokens=name_tokens,
        sql_clauses=sql_clauses,
        sql_params=sql_params,
        fuzzy_threshold=fuzzy_threshold,
    )


def sender_score(sf: SenderFilter, email: Email) -> float:
    candidate_email = (email.from_email or "").lower()
    candidate_name = email.from_name or ""

    if sf.email_exact:
        return 100.0 if candidate_email == sf.email_exact else 0.0

    scores: list[float] = []
    if sf.email_local and sf.email_local in candidate_email:
        scores.append(88.0)

    if sf.name_tokens:
        email_tokens = email_to_name_tokens(candidate_email)
        if sf.name_tokens.issubset(email_tokens):
            scores.append(95.0)
        elif sf.name_tokens & email_tokens:
            overlap = len(sf.name_tokens & email_tokens) / len(sf.name_tokens)
            scores.append(60.0 + 30.0 * overlap)
        scores.append(name_match_score(sf.name_tokens, candidate_name))

    normalised_query = (
        " ".join(sorted(sf.name_tokens)) if sf.name_tokens else _normalise(sf.raw_query)
    )
    normalised_candidate = _normalise(candidate_name)
    scores.append(fuzzy_ratio(normalised_query, normalised_candidate))

    return max(scores)


def fuzzy_filter_by_sender(
    emails: list[Email], sf: Optional[SenderFilter]
) -> list[Email]:
    if sf is None:
        return emails

    matched: list[Email] = []
    for e in emails:
        score = sender_score(sf, e)
        if score >= sf.fuzzy_threshold:
            try:
                object.__setattr__(e, "_match_score", round(score, 1))
            except (AttributeError, TypeError):
                pass
            matched.append(e)

    matched.sort(key=lambda e: getattr(e, "_match_score", 0), reverse=True)
    log.info(
        "Fuzzy sender filter '%s': %d rows -> %d matched (threshold=%s, backend=%s)",
        sf.raw_query,
        len(emails),
        len(matched),
        sf.fuzzy_threshold,
        FUZZY_BACKEND,
    )
    return matched
