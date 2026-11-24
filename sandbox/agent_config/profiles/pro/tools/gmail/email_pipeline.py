"""
Natural Language Email + Calendar Agent Pipeline
================================================
Processes natural-language queries against a local email SQLite database,
delegating summarisation, prioritisation, drafting, and planning to an LLM.
"""

from __future__ import annotations

# ---------------------------------------------------------------------------
# Standard-library imports
# ---------------------------------------------------------------------------
import argparse
import json
import logging
import os
import re
import sqlite3
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Optional

# ---------------------------------------------------------------------------
# Third-party imports
# ---------------------------------------------------------------------------
import requests
from dotenv import load_dotenv

load_dotenv(override=True)

# The scripts import each other as top-level modules. The Windows-native agent Python
# runs under a ._pth file, which leaves the script directory off sys.path (EG1-8).
sys.path.insert(0, str(Path(__file__).resolve().parent))

from gmail_common import (
    GMAIL_PAUSED_MESSAGE,
    clean_body_text,
    decode_gmail_body,
    gmail_paused,
    is_supported_inbox_message,
    save_credentials,
    supported_inbox_query,
)


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO, format="%(asctime)s  %(levelname)-8s  %(message)s"
)
log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Local imports  (after logging is configured so import errors surface cleanly)
# ---------------------------------------------------------------------------
from email_prompts import (  # noqa: E402
    ACTION_ITEMS_SYSTEM,
    CLASSIFIER_SYSTEM,
    COMBINED_PRIORITIZE_SYSTEM,
    COMBINED_SUMMARIZE_SYSTEM,
    DAILY_PLAN_SYSTEM,
    DRAFT_SYSTEM,
    DRAFT_WITH_INSTRUCTIONS_SYSTEM,
    MEETING_PREP_SYSTEM,
    PRIORITIZE_SYSTEM,
    SCORE_PROMPT_TEMPLATE,
    SEND_INTENT_CLASSIFIER_SYSTEM,
    SUMMARIZE_CALENDAR_SYSTEM,
    SUMMARIZE_SYSTEM,
    UNREAD_SUMMARY_SYSTEM,
)

from email_time import (  # noqa: E402
    _DT_FMT,
    _get_calendar_time_range,
    _utc_to_local_str,
    TimeRange,
    TimeRef,
    resolve_time,
)

from email_senders import (  # noqa: E402
    _DEFAULT_FUZZY_THRESHOLD,
    FUZZY_BACKEND,
    SenderFilter,
    build_sender_filter,
    fuzzy_filter_by_sender,
    fuzzy_ratio,
)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Intent normalisation map used by the LLM classifier
_INTENT_ALIASES: dict[str, str] = {
    "count": "count",
    "fetch": "show",
    "show": "show",
    "summarise": "summarize",
    "summarize": "summarize",
    "prioritise": "prioritize",
    "prioritize": "prioritize",
    "rank": "prioritize",
    "score": "prioritize",
    "draft": "draft",
    "reply": "draft",
    "compose": "draft",
    "send": "send_email",
    "send_email": "send_email",
    "reply_email": "reply_email",
    "send_meeting_invite": "send_meeting_invite",
}

_COUNT_WORDS: dict[str, int] = {
    "one": 1,
    "two": 2,
    "three": 3,
    "four": 4,
    "five": 5,
    "six": 6,
    "seven": 7,
    "eight": 8,
    "nine": 9,
    "ten": 10,
    "eleven": 11,
    "twelve": 12,
    "thirteen": 13,
    "fourteen": 14,
    "fifteen": 15,
    "sixteen": 16,
    "seventeen": 17,
    "eighteen": 18,
    "nineteen": 19,
    "twenty": 20,
}

# Default limits / thresholds (overridden by init_config)
_DEFAULT_MAX_RETRIES = 3
_DEFAULT_REQUEST_TIMEOUT = 120
_DEFAULT_MAX_TOKENS = 4096
_DEFAULT_MICRO_BATCH_SIZE = 10
_DEFAULT_SCORE_MAX_TOKENS = 4096
_DEFAULT_DRAFT_WORKERS = 4
_DEFAULT_CHAT_COMPLETIONS = "/chat/completions"

# DB schema strings (used as context for the SQL-generation prompt)


# ---------------------------------------------------------------------------
# Runtime configuration  (populated by init_config; avoids raw globals)
# ---------------------------------------------------------------------------
@dataclass
class _Config:
    completions_url: str = ""
    model_name: str = ""
    api_key: Optional[str] = None
    request_timeout: int = _DEFAULT_REQUEST_TIMEOUT
    max_tokens: int = _DEFAULT_MAX_TOKENS
    max_retries: int = _DEFAULT_MAX_RETRIES
    fuzzy_threshold: float = _DEFAULT_FUZZY_THRESHOLD
    micro_batch_size: int = _DEFAULT_MICRO_BATCH_SIZE
    score_max_tokens: int = _DEFAULT_SCORE_MAX_TOKENS
    draft_workers: int = _DEFAULT_DRAFT_WORKERS
    db_path: Path = field(
        default_factory=lambda: Path(__file__).resolve().parent / "email.db"
    )
    owner: str = ""


_cfg = _Config()


# ---------------------------------------------------------------------------
# Data models
# ---------------------------------------------------------------------------
@dataclass
class CalendarEvent:
    id: int
    email_id: str
    conversation_id: str
    subject: str
    organizer: str
    required_attendees: str
    start_time: str
    end_time: str
    location: str
    body: str
    is_recurring: int


@dataclass
class Email:
    id: int
    email_id: str
    conversation_id: str
    subject: str
    from_name: str
    from_email: str
    to_recipients: str
    cc_recipients: str
    received_time: str
    body: str
    unread: int
    original_importance: int
    priority_score: int = 0
    summary: str = ""


@dataclass
class SenderRef:
    type: str
    value: str


@dataclass
class FilterCriteria:
    intent: str
    sender: SenderRef = field(default_factory=lambda: SenderRef("none", ""))
    time: TimeRef = field(default_factory=lambda: TimeRef("none", ""))
    top_k: int = 5
    unread_only: Optional[bool] = None
    importance: Optional[int] = None
    subject_keywords: list[str] = field(default_factory=list)
    body_keywords: list[str] = field(default_factory=list)
    to_contains: str = ""
    cc_contains: str = ""
    latest_first: bool = False


# ---------------------------------------------------------------------------
# Compiled regex constants
# ---------------------------------------------------------------------------
_CALENDAR_INTENT_PATTERNS: list[tuple[re.Pattern, str]] = [
    (re.compile(r"\bconflict\w*\b", re.IGNORECASE), "conflicts"),
    (re.compile(r"\boverlap\w*\b", re.IGNORECASE), "conflicts"),
    (re.compile(r"\bclash\w*\b", re.IGNORECASE), "conflicts"),
    (re.compile(r"\baction\s+item\w*\b", re.IGNORECASE), "action_items"),
    (re.compile(r"\btodo\w*\b", re.IGNORECASE), "action_items"),
    (re.compile(r"\btask\w*\b", re.IGNORECASE), "action_items"),
    (re.compile(r"\bhow\s+many\s+meeting\w*\b", re.IGNORECASE), "count"),
    (re.compile(r"\bnumber\s+of\s+meeting\w*\b", re.IGNORECASE), "count"),
    (re.compile(r"\bcount\s+.*meeting\w*\b", re.IGNORECASE), "count"),
    (re.compile(r"\bsummar\w+\b", re.IGNORECASE), "summarize"),
    (re.compile(r"\boverview\b", re.IGNORECASE), "summarize"),
    (re.compile(r"\blist\b", re.IGNORECASE), "show"),
    (re.compile(r"\bshow\b", re.IGNORECASE), "show"),
    (re.compile(r"\bfetch\b", re.IGNORECASE), "show"),
    (re.compile(r"\bwhat\s+.*meeting\w*\b", re.IGNORECASE), "show"),
]

_CALENDAR_TIME_PATTERNS: list[tuple[re.Pattern, str]] = [
    (re.compile(r"\btoday\b", re.IGNORECASE), "today"),
    (re.compile(r"\btomorrow\b", re.IGNORECASE), "tomorrow"),
    (re.compile(r"\bthis\s+week\b", re.IGNORECASE), "this week"),
    (re.compile(r"\bnext\s+week\b", re.IGNORECASE), "next week"),
    (re.compile(r"\byesterday\b", re.IGNORECASE), "yesterday"),
    (re.compile(r"\blast\s+week\b", re.IGNORECASE), "last week"),
]

_CALENDAR_TRIGGER_RE = re.compile(
    r"\b(meeting\w*|calendar|appointment\w*|schedul\w*|conflict\w*|action\s+item\w*|"
    r"how\s+many\s+meeting\w*|summarize\s+my\s+meeting\w*)\b",
    re.IGNORECASE,
)

_COMBINED_EMAIL_CALENDAR_RE = re.compile(
    r"(?:"
    r"\b(?:email\w*|inbox|message\w*)\b.{0,60}\b(?:calendar|meeting\w*|appointment\w*|schedul\w*)\b"
    r"|"
    r"\b(?:calendar|meeting\w*|appointment\w*|schedul\w*)\b.{0,60}\b(?:email\w*|inbox|message\w*)\b"
    r")",
    re.IGNORECASE | re.DOTALL,
)

_DAILY_PLAN_RE = re.compile(
    r"\b(daily\s+plan|focus(ed)?\s+plan|plan\s+(my\s+)?day|today['\u2019s]*\s+plan|"
    r"plan\s+from\s+(my\s+)?(tasks?|calendar)|build\s+(a\s+)?plan)\b",
    re.IGNORECASE,
)

_UNREAD_SUMMARY_RE = re.compile(
    r"\b(summarize\s+unread|unread\s+summar\w*|unread\s+message\w*|"
    r"draft\s+(short\s+)?repl\w+\s+to\s+unread|unread\s+.*draft|"
    r"what\s+(are\s+)?my\s+unread)\b",
    re.IGNORECASE,
)

_MEETING_PREP_RE = re.compile(
    r"\b(meeting\s+prep\w*|prep\w*\s+(for\s+)?(tomorrow['\u2019s]*\s+)?meeting\w*|"
    r"prep\s+bullet\w*|prepare\s+for\s+(tomorrow['\u2019s]*\s+)?meeting\w*|"
    r"tomorrow['\u2019s]*\s+meeting\s+prep)\b",
    re.IGNORECASE,
)

# Write-action patterns (send email, reply, meeting invite)
_SEND_EMAIL_RE = re.compile(
    r"\b(send\s+(a\s+)?(new\s+)?email|compose\s+and\s+send|write\s+and\s+send|"
    r"send\s+(a\s+)?message\s+to|email\s+\S+@\S+|"
    r"send\s+\S+\s+(an?\s+)?email)\b",
    re.IGNORECASE,
)

_REPLY_SEND_RE = re.compile(
    r"\b("
    r"send\s+(a\s+)?(response|reply)"
    r"|respond\s+to"
    r"|reply\s+to\s+.+\s+(saying|indicating|telling|letting|informing|asking|requesting|mentioning|notifying|confirming|declining|accepting)"
    r"|reply\s+(saying|indicating|telling|letting|informing|asking|requesting|mentioning|notifying|confirming|declining|accepting|and\s+)"
    r"|send\s+.+\s+(a\s+)?response"
    r"|send\s+(this|the|that)\s+(reply|response)"
    r"|write\s+back\s+to"
    r"|reply\s+to\s+\S+.*\b(email|message|request)\b"
    r"|decline\s+(the\s+)?(meeting|invitation|invite|request)"
    r"|accept\s+(the\s+)?(meeting|invitation|invite|request)"
    r"|tell\s+(them|him|her|the\w*)\s+"
    r")\b",
    re.IGNORECASE,
)

_DRAFT_PREFIX_RE = re.compile(
    r"\b(draft|compose|write|prepare)\s+(a\s+)?", re.IGNORECASE
)

_MEETING_INVITE_RE = re.compile(
    r"\b(send\s+(a\s+)?(\w+\s+)*meeting\s+invite|schedule\s+(a\s+)?(\w+\s+)*meeting|"
    r"set\s+up\s+(a\s+)?(\w+\s+)*meeting|invite\s+.+\s+to\s+(a\s+)?(\w+\s+)*meeting|"
    r"send\s+(a\s+)?(calendar\s+)?invite|book\s+(a\s+)?(\w+\s+)*meeting|"
    r"create\s+(a\s+)?(\w+\s+)*meeting\s+invite)\b",
    re.IGNORECASE,
)

_LATEST_KEYWORDS_RE = re.compile(
    r"\b(latest|most\s+recent|newest|recent\s+emails?|recent\s+\d+)\b",
    re.IGNORECASE,
)

_EMAIL_COUNT_RE = re.compile(
    r"\b(?:(?:latest|newest|most\s+recent|recent|top)\s+)?"
    r"(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|"
    r"thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)"
    r"\s+(?:emails?|messages?)\b",
    re.IGNORECASE,
)

_EMAIL_LATEST_COUNT_RE = re.compile(
    r"\b"
    r"(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|"
    r"thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)"
    r"\s+(?:latest|newest|most\s+recent)\s+(?:emails?|messages?|ones)\b",
    re.IGNORECASE,
)

_EMAIL_COUNT_QUERY_RE = re.compile(
    r"(?:"
    r"\bhow\s+many\b(?=[^?.!]*\b(?:emails?|messages?|inbox)\b)"
    r"|\b(?:number|total)\s+of\b(?=[^?.!]*\b(?:emails?|messages?)\b)"
    r"|\bcount\b(?=[^?.!]*\b(?:emails?|messages?)\b)"
    r"|\b(?:emails?|messages?)\s+(?:count|total)\b"
    r")",
    re.IGNORECASE,
)

_COUNT_LIST_REQUEST_RE = re.compile(
    r"\b(?:list|show|display|fetch)\b",
    re.IGNORECASE,
)

# Regex to detect reply-style instructions embedded in a prompt that the LLM
# classifier may incorrectly route to the generic "draft" intent.
_REPLY_INSTRUCTION_RE = re.compile(
    r"\b("
    r"(?:saying|telling|informing|notifying|letting\s+\w+\s+know)\s+(?:that\s+|him\s+|her\s+|them\s+)?"
    r"|(?:I\s+(?:can'?t|cannot|won'?t|will\s+not|am\s+not\s+able|will\s+be\s+late|will\s+be\s+unable))"
    r"|declin\w*\s+(?:the\s+)?(?:meeting|invitation|invite|request)"
    r"|accept\w*\s+(?:the\s+)?(?:meeting|invitation|invite|request)"
    r"|ask\s+(?:for|about|if|whether|to\s+reschedule)"
    r"|reschedule\s+(?:the\s+)?(?:meeting|call|sync)"
    r"|tell\s+(?:them|him|her)\s+(?:that\s+|I)"
    r"|(?:reply|respond)\s+(?:saying|and|with)"
    r")",
    re.IGNORECASE,
)


# ===========================================================================
# Configuration / initialisation
# ===========================================================================


def _load_owner_from_db(db_path: Path) -> str:
    """Read the owner row from the DB; returns empty string on failure."""
    conn: Optional[sqlite3.Connection] = None
    try:
        conn = sqlite3.connect(db_path)
        row = conn.execute("SELECT name, email_id FROM owner WHERE id = 1").fetchone()
        if row:
            return f"{row[0]} ({row[1]})"
    except Exception:
        pass
    finally:
        if conn is not None:
            conn.close()
    return ""


def init_config(
    db_path: Optional[str] = None,
    fuzzy_threshold: float = _DEFAULT_FUZZY_THRESHOLD,
) -> None:
    """Populate the module-level *_cfg* singleton from environment variables."""
    # LRM_API_BASE_URL points at LLMRouter Manager (host, :18321). Email content
    # is sensitive, so force the local alias.
    _cfg.completions_url = (
        os.getenv("LRM_API_BASE_URL", "").rstrip("/") + "/v1" + _DEFAULT_CHAT_COMPLETIONS
    )
    _cfg.api_key = os.getenv("LRM_API_KEY", "")
    _cfg.model_name = os.getenv("LRM_LOCAL_MODEL", "local-model")
    _cfg.request_timeout = _DEFAULT_REQUEST_TIMEOUT
    _cfg.max_tokens = _DEFAULT_MAX_TOKENS
    _cfg.micro_batch_size = _DEFAULT_MICRO_BATCH_SIZE
    _cfg.score_max_tokens = _DEFAULT_SCORE_MAX_TOKENS
    _cfg.draft_workers = _DEFAULT_DRAFT_WORKERS
    _cfg.fuzzy_threshold = fuzzy_threshold

    if db_path:
        _cfg.db_path = Path(db_path)

    _cfg.owner = _load_owner_from_db(_cfg.db_path)

    log.info("Model          : %s", _cfg.model_name)
    log.info("Endpoint       : %s", _cfg.completions_url)
    log.info("Email DB     : %s", _cfg.db_path)
    log.info("FuzzyLib       : %s", FUZZY_BACKEND)
    log.info("FuzzyThreshold : %s", _cfg.fuzzy_threshold)
    log.info(
        "Batch          : %d emails, Drafters: %d, Timeout: %ds",
        _cfg.micro_batch_size,
        _cfg.draft_workers,
        _cfg.request_timeout,
    )


# ===========================================================================
# LLM helpers
# ===========================================================================


def _inject_nothink(messages: list[dict]) -> list[dict]:
    """Append '/nothink' to the first system message if not already present."""
    messages = [m.copy() for m in messages]
    for m in messages:
        if m["role"] == "system" and not m["content"].rstrip().endswith("/nothink"):
            m["content"] = m["content"].rstrip() + " /nothink"
            break
    return messages


def _strip_think_tags(text: str) -> str:
    return re.sub(r"<think>[\s\S]*?</think>\s*", "", text, flags=re.DOTALL).strip()


def call_llm(
    messages: list[dict],
    temperature: float = 0.2,
    max_tokens: Optional[int] = None,
) -> str:
    """Send *messages* to the configured LLM and return the text response."""
    messages = _inject_nothink(messages)
    payload = {
        "model": _cfg.model_name,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens or _cfg.max_tokens,
    }
    headers: dict[str, str] = {"Content-Type": "application/json"}
    if _cfg.api_key:
        headers["Authorization"] = f"Bearer {_cfg.api_key}"

    for attempt in range(1, _cfg.max_retries + 1):
        try:
            # egress-surface: gmail_lrm_chat
            resp = requests.post(
                _cfg.completions_url,
                json=payload,
                headers=headers,
                timeout=_cfg.request_timeout,
            )
            resp.raise_for_status()
            content = resp.json()["choices"][0]["message"]["content"]
            return _strip_think_tags(content)
        except (requests.RequestException, KeyError) as exc:
            log.warning("LLM attempt %d/%d failed: %s", attempt, _cfg.max_retries, exc)
            if attempt == _cfg.max_retries:
                raise
            time.sleep(2**attempt)

    raise RuntimeError("LLM call failed after all retries")


def parse_json_response(text: str) -> object:
    """Strip Markdown fences from *text* and parse JSON."""
    text = text.strip()
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    match = re.search(r"(\{[\s\S]*\}|\[[\s\S]*\])", text)
    return json.loads(match.group(1) if match else text)


def _parse_count_token(token: str) -> Optional[int]:
    try:
        return int(token)
    except ValueError:
        return _COUNT_WORDS.get(token.lower())


def _extract_explicit_top_k(prompt: str) -> Optional[int]:
    latest_match = _EMAIL_LATEST_COUNT_RE.search(prompt)
    if latest_match:
        count = _parse_count_token(latest_match.group(1))
        return count if count and count > 0 else None

    match = _EMAIL_COUNT_RE.search(prompt)
    if not match:
        return None
    count = _parse_count_token(match.group(1))
    return count if count and count > 0 else None


def _is_email_count_query(prompt: str) -> bool:
    return bool(_EMAIL_COUNT_QUERY_RE.search(prompt))


def _count_query_wants_listing(prompt: str) -> bool:
    return _is_email_count_query(prompt) and bool(_COUNT_LIST_REQUEST_RE.search(prompt))


def _infer_email_intent_from_prompt(prompt: str) -> Optional[str]:
    prompt_lower = prompt.lower()
    if _is_email_count_query(prompt):
        return "count"
    if re.search(r"\b(prioriti[sz]e|rank|score|urgent)\b", prompt_lower):
        return "prioritize"
    if re.search(r"\bsummari[sz]e|summary|summarise\b", prompt_lower):
        return "summarize"
    if re.search(r"\b(draft|reply|compose)\b", prompt_lower):
        return "draft"
    if re.search(r"\b(show|fetch|list|display|get)\b", prompt_lower):
        return "show"
    return None


# ===========================================================================
# Text / string utilities
# ===========================================================================


def _fmt_dt(s: str) -> str:
    """Return the HH:MM portion of a datetime string."""
    return s[11:16]


# ===========================================================================
# Intent / time detection
# ===========================================================================


def _detect_calendar_intent(prompt: str) -> str:
    for pattern, tag in _CALENDAR_INTENT_PATTERNS:
        if pattern.search(prompt):
            return tag
    return "show"


def _detect_calendar_time(prompt: str) -> str:
    for pattern, label in _CALENDAR_TIME_PATTERNS:
        if pattern.search(prompt):
            return label
    return "today"


def is_calendar_prompt(prompt: str) -> bool:
    return bool(_CALENDAR_TRIGGER_RE.search(prompt))


def _is_combined_email_calendar(prompt: str) -> bool:
    return bool(_COMBINED_EMAIL_CALENDAR_RE.search(prompt))


def _detect_composite_intent(prompt: str) -> Optional[str]:
    """Return a composite task label, or *None* for plain email/calendar queries."""
    if _DAILY_PLAN_RE.search(prompt):
        return "daily_plan"
    if _UNREAD_SUMMARY_RE.search(prompt):
        return "summarize_unread"
    if _MEETING_PREP_RE.search(prompt):
        return "meeting_prep"
    return None


# ===========================================================================
# Sender matching
# ===========================================================================


def resolve_sender(criteria: FilterCriteria) -> Optional[SenderFilter]:
    sr = criteria.sender
    if sr.type == "none" or not sr.value:
        return None

    resolved_value = sr.value

    if sr.type in ("name", "alias"):
        resolved_value = _fuzzy_resolve_sender_name(sr.value) or sr.value
    elif sr.type == "domain":
        resolved_value = sr.value if sr.value.startswith("@") else f"@{sr.value}"

    return build_sender_filter(resolved_value, fuzzy_threshold=_cfg.fuzzy_threshold)


def _fuzzy_resolve_sender_name(name: str) -> Optional[str]:
    """Look up the best-matching email address for a display name in ai_inbox."""
    conn: Optional[sqlite3.Connection] = None
    try:
        conn = sqlite3.connect(_cfg.db_path)
        rows = conn.execute(
            "SELECT DISTINCT from_email, from_name FROM ai_inbox"
        ).fetchall()
    except Exception as exc:
        log.warning("DB sender lookup failed: %s; using raw sender value", exc)
        return None
    finally:
        if conn is not None:
            conn.close()

    best_email: Optional[str] = None
    best_score = 0.0
    for db_email, db_name in rows:
        score = max(fuzzy_ratio(name, db_name or ""), fuzzy_ratio(name, db_email or ""))
        if score > best_score:
            best_score = score
            best_email = db_email

    if best_email and best_score >= _cfg.fuzzy_threshold:
        log.info(
            "Sender '%s' resolved to '%s' (score=%.1f)", name, best_email, best_score
        )
        return best_email

    log.info(
        "Sender '%s' not confidently resolved (best=%.1f); using raw value",
        name,
        best_score,
    )
    return None


# ===========================================================================
# Database helpers
# ===========================================================================


def _db_connect() -> sqlite3.Connection:
    if not _cfg.db_path.exists():
        raise FileNotFoundError(f"Database not found: {_cfg.db_path}")
    conn = sqlite3.connect(_cfg.db_path)
    conn.row_factory = sqlite3.Row
    return conn


def fetch_calendar_events(time_range: TimeRange) -> list[CalendarEvent]:
    conn = _db_connect()
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS ai_calendar (
                id INTEGER PRIMARY KEY AUTOINCREMENT, email_id TEXT UNIQUE,
                conversation_id TEXT, subject TEXT, organizer TEXT,
                required_attendees TEXT, start_time DATETIME, end_time DATETIME,
                location TEXT, body TEXT, is_recurring INTEGER
            )
            """)
        conn.commit()
        rows = conn.execute(
            """
            SELECT id, email_id, conversation_id, subject, organizer,
                   required_attendees, start_time, end_time, location, body, is_recurring
            FROM   ai_calendar
            WHERE  start_time >= ? AND start_time <= ?
            ORDER  BY start_time ASC
            """,
            (time_range.start, time_range.end),
        ).fetchall()
    finally:
        conn.close()

    return [
        CalendarEvent(
            id=row["id"],
            email_id=row["email_id"] or "",
            conversation_id=row["conversation_id"] or "",
            subject=row["subject"] or "",
            organizer=row["organizer"] or "",
            required_attendees=row["required_attendees"] or "",
            start_time=row["start_time"] or "",
            end_time=row["end_time"] or "",
            location=row["location"] or "",
            body=row["body"] or "",
            is_recurring=row["is_recurring"] or 0,
        )
        for row in rows
    ]


# Meeting-related keywords used to find invite emails that didn't land on the calendar
_MEETING_EMAIL_KEYWORDS = [
    # Generic
    "meeting",
    "invite",
    "calendar",
    "conference call",
    "dial-in",
    "rsvp",
    "join the meeting",
    "let's meet",
    "sync up",
    # Platforms
    "teams meeting",
    "zoom",
    "webex",
    "google meet",
    "gotomeeting",
    "bluejeans",
    "chime",
    "slack huddle",
    "whereby",
    "ringcentral",
    "skype",
    # Invite formats
    ".ics",
    "accept this invitation",
    # Meeting types
    "standup",
    "stand-up",
    "1:1",
    "one-on-one",
    "kickoff",
    "kick-off",
    "huddle",
    "townhall",
    "town hall",
    "all-hands",
    "office hours",
    "retrospective",
    "retro",
    "sprint planning",
    "daily scrum",
    # Scheduling tools
    "calendly",
    "doodle",
    "when2meet",
]


def fetch_meeting_emails(time_range: TimeRange) -> list[Email]:
    """Search ai_inbox for emails that look like meeting invites within a time range."""
    keyword_clauses = " OR ".join(
        ["LOWER(subject) LIKE ? OR LOWER(body) LIKE ?"] * len(_MEETING_EMAIL_KEYWORDS)
    )
    params: list[str] = []
    for kw in _MEETING_EMAIL_KEYWORDS:
        pattern = f"%{kw}%"
        params.extend([pattern, pattern])

    sql = (
        f"SELECT * FROM ai_inbox "
        f"WHERE received_time >= ? AND received_time <= ? "
        f"AND ({keyword_clauses}) "
        f"ORDER BY received_time DESC LIMIT 50"
    )
    params_full = [time_range.start, time_range.end] + params
    log.info("Meeting email SQL: %s", sql)
    log.info("Meeting email params (time): %s -> %s", time_range.start, time_range.end)
    return run_sql(sql, params_full)


def run_sql(sql: str, params: Optional[list] = None) -> list[Email]:
    conn = _db_connect()
    try:
        rows = conn.execute(sql, params or []).fetchall()
    except sqlite3.Error as exc:
        raise RuntimeError(
            f"SQL error: {exc}\nQuery: {sql}\nParams: {params}"
        ) from exc
    finally:
        conn.close()

    return [
        Email(
            id=row["id"] or 0,
            email_id=row["email_id"] or "",
            conversation_id=row["conversation_id"] or "",
            subject=row["subject"] or "",
            from_name=row["from_name"] or "",
            from_email=row["from_email"] or "",
            to_recipients=row["to_recipients"] or "",
            cc_recipients=row["cc_recipients"] or "",
            received_time=_utc_to_local_str(row["received_time"] or ""),
            body=row["body"] or "",
            unread=row["unread"] or 0,
            original_importance=row["original_importance"] or 1,
        )
        for row in rows
    ]


def run_count_sql(sql: str, params: Optional[list] = None) -> int:
    conn = _db_connect()
    try:
        row = conn.execute(sql, params or []).fetchone()
    except sqlite3.Error as exc:
        raise RuntimeError(
            f"SQL error: {exc}\nQuery: {sql}\nParams: {params}"
        ) from exc
    finally:
        conn.close()
    return int(row[0]) if row else 0


def _sender_count_requires_fuzzy_filter(sender_filter: Optional[SenderFilter]) -> bool:
    return sender_filter is not None and not sender_filter.email_exact


def count_matching_emails(
    criteria: FilterCriteria,
    sender_filter: Optional[SenderFilter],
    time_range: Optional[TimeRange],
) -> int:
    """Count all matching emails without inheriting listing limits."""
    if _sender_count_requires_fuzzy_filter(sender_filter):
        sql, params = build_sql(criteria, sender_filter, time_range, limit_override=0)
        emails = run_sql(sql, params)
        return len(fuzzy_filter_by_sender(emails, sender_filter))

    sql, params = build_count_sql(criteria, sender_filter, time_range)
    return run_count_sql(sql, params)


def fetch_count_listing_emails(
    criteria: FilterCriteria,
    sender_filter: Optional[SenderFilter],
    time_range: Optional[TimeRange],
) -> list[Email]:
    """Fetch a limited listing for a mixed count + list request."""
    if _sender_count_requires_fuzzy_filter(sender_filter):
        sql, params = build_sql(criteria, sender_filter, time_range, limit_override=0)
        emails = fuzzy_filter_by_sender(run_sql(sql, params), sender_filter)
        return emails[: criteria.top_k]

    sql, params = build_sql(criteria, sender_filter, time_range)
    return run_sql(sql, params)[: criteria.top_k]


# ===========================================================================
# Live Gmail API fallback (query beyond local cache)
# ===========================================================================


def _build_gmail_query(
    criteria: FilterCriteria, time_range: Optional[TimeRange]
) -> str:
    """
    Convert FilterCriteria into a Gmail search query string (the 'q' parameter).

    Gmail search operators:
      from:, to:, cc:, subject:, after:, before:, is:unread, label:important
    """
    parts: list[str] = []

    # Sender filter
    if criteria.sender.type != "none" and criteria.sender.value:
        val = criteria.sender.value
        if criteria.sender.type == "email":
            parts.append(f"from:{val}")
        elif criteria.sender.type == "domain":
            domain = val if val.startswith("@") else f"@{val}"
            parts.append(f"from:{domain}")
        else:
            # name or alias — use as-is, Gmail does fuzzy name matching
            parts.append(f"from:{val}")

    # Time range
    if time_range:
        # Gmail uses after:/before: with epoch seconds or YYYY/MM/DD
        try:
            start_dt = datetime.strptime(time_range.start, "%Y-%m-%d %H:%M:%S")
            parts.append(
                f"after:{int(start_dt.replace(tzinfo=timezone.utc).timestamp())}"
            )
        except (ValueError, TypeError):
            pass
        try:
            end_dt = datetime.strptime(time_range.end, "%Y-%m-%d %H:%M:%S")
            parts.append(
                f"before:{int(end_dt.replace(tzinfo=timezone.utc).timestamp())}"
            )
        except (ValueError, TypeError):
            pass

    # Subject keywords
    for kw in criteria.subject_keywords:
        parts.append(f"subject:{kw}")

    # Body keywords (Gmail uses plain terms for body search)
    for kw in criteria.body_keywords:
        parts.append(f"{kw}")

    # Unread
    if criteria.unread_only is True:
        parts.append("is:unread")
    elif criteria.unread_only is False:
        parts.append("is:read")

    # Importance
    if criteria.importance == 2:
        parts.append("label:important")

    # To/CC
    if criteria.to_contains:
        parts.append(f"to:{criteria.to_contains}")
    if criteria.cc_contains:
        parts.append(f"cc:{criteria.cc_contains}")

    return " ".join(parts)


def _gmail_live_query(
    criteria: FilterCriteria, time_range: Optional[TimeRange], max_results: int = 20
) -> list[Email]:
    """
    Query Gmail API directly using messages.list(q=...) and return Email objects.

    Falls back gracefully: returns empty list if authentication or API calls fail.
    """
    import base64
    import email as email_lib
    from google.oauth2.credentials import Credentials
    from google.auth.transport.requests import Request
    from googleapiclient.discovery import build
    from googleapiclient.errors import HttpError

    q = _build_gmail_query(criteria, time_range)
    if not q.strip():
        log.info("Live Gmail fallback: empty query, skipping.")
        return []

    log.info("Live Gmail fallback query: q=%r (max_results=%d)", q, max_results)

    # Locate token.json: prefer GMAIL_DATA_DIR, then script's own directory
    gmail_data_dir = Path(os.environ.get("GMAIL_DATA_DIR", ""))
    if not gmail_data_dir.is_dir():
        gmail_data_dir = Path(__file__).resolve().parent
    if not gmail_data_dir.is_dir():
        gmail_data_dir = _cfg.db_path.parent

    token_file = gmail_data_dir / "token.json"

    if gmail_paused(token_file):
        log.warning("Live Gmail fallback: %s", GMAIL_PAUSED_MESSAGE)
        return []
    if not token_file.exists():
        log.warning("Live Gmail fallback: token.json not found at %s", token_file)
        return []

    try:
        creds = Credentials.from_authorized_user_file(str(token_file))
        if creds and creds.refresh_token and (
            not creds.valid or creds.expired or creds.expiry is None
        ):
            creds.refresh(Request())
            _save_google_credentials(token_file, creds)

        # egress-surface: gmail_google_apis
        service = build("gmail", "v1", credentials=creds)

        result = (
            service.users()
            .messages()
            .list(
                userId="me",
                q=supported_inbox_query(q),
                maxResults=max_results,
                labelIds=["INBOX"],
            )
            .execute()
        )

        messages = result.get("messages", [])
        if not messages:
            log.info("Live Gmail fallback: no results for q=%r", q)
            return []

        emails: list[Email] = []
        for stub in messages:
            try:
                msg = (
                    service.users()
                    .messages()
                    .get(userId="me", id=stub["id"], format="full")
                    .execute()
                )

                headers = msg.get("payload", {}).get("headers", [])
                label_ids = msg.get("labelIds", [])
                if not is_supported_inbox_message(label_ids):
                    continue

                def _get_header(name):
                    for h in headers:
                        if h["name"].lower() == name.lower():
                            return h["value"]
                    return ""

                from_raw = _get_header("From")
                from_name, from_addr = email_lib.utils.parseaddr(from_raw)

                subject = _get_header("Subject") or ""
                to_raw = _get_header("To")
                cc_raw = _get_header("Cc")

                # Parse date
                internal_date = msg.get("internalDate", "")
                received_str = ""
                if internal_date:
                    try:
                        epoch_ms = int(internal_date)
                        dt = datetime.fromtimestamp(
                            epoch_ms / 1000, tz=timezone.utc
                        ).replace(tzinfo=None)
                        received_str = dt.strftime("%Y-%m-%d %H:%M:%S")
                    except (ValueError, TypeError):
                        pass

                # Decode body
                body_text = _decode_gmail_body(msg.get("payload", {}))

                unread = 1 if "UNREAD" in label_ids else 0
                importance = 2 if "IMPORTANT" in label_ids else 1

                def _format_recipients(raw):
                    if not raw:
                        return ""
                    parsed = email_lib.utils.getaddresses([raw])
                    return "; ".join(name or addr for name, addr in parsed)

                emails.append(
                    Email(
                        id=0,  # Not from local DB
                        email_id=stub["id"],
                        conversation_id=msg.get("threadId", stub["id"]),
                        subject=subject,
                        from_name=from_name.strip(),
                        from_email=from_addr.strip().lower(),
                        to_recipients=_format_recipients(to_raw),
                        cc_recipients=_format_recipients(cc_raw),
                        received_time=_utc_to_local_str(received_str),
                        body=_clean_body(body_text),
                        unread=unread,
                        original_importance=importance,
                    )
                )
            except Exception as e:
                log.warning(
                    "Live Gmail fallback: failed to fetch message %s: %s", stub["id"], e
                )
                continue

        log.info("Live Gmail fallback: retrieved %d emails.", len(emails))
        return emails

    except Exception as e:
        log.warning("Live Gmail fallback failed: %s", e)
        return []


def _decode_gmail_body(payload: dict) -> str:
    """Recursively extract plain-text body from a Gmail API message payload."""
    return decode_gmail_body(payload)


def _save_google_credentials(token_file: Path, creds) -> None:
    """Persist refreshed Google OAuth credentials to token.json atomically."""
    save_credentials(creds, token_file)


def _clean_body(text: str) -> str:
    """Normalize whitespace in body text."""
    return clean_body_text(text)


# ===========================================================================
# Query extraction and SQL generation
# ===========================================================================


def extract_structured_query(prompt: str) -> FilterCriteria:
    """Ask the LLM to parse the user's prompt into a FilterCriteria."""
    messages = [
        {"role": "system", "content": CLASSIFIER_SYSTEM},
        {"role": "user", "content": prompt},
    ]
    try:
        raw = call_llm(messages, temperature=0.0, max_tokens=400)
        data = parse_json_response(raw)
    except Exception as exc:
        log.warning("Classifier LLM call failed (%s); using safe defaults", exc)
        data = {}
    if not isinstance(data, dict):
        log.warning("Classifier returned non-object JSON; using safe defaults")
        data = {}

    # --- safe extraction helpers -------------------------------------------
    def _str(d: dict, *keys: str, default: str = "") -> str:
        for k in keys:
            d = d.get(k, {}) if isinstance(d, dict) else {}
        return d if isinstance(d, str) else default

    def _int(d: dict, key: str, default: Optional[int] = None) -> Optional[int]:
        v = d.get(key)
        try:
            return int(v) if v is not None else default
        except (TypeError, ValueError):
            return default

    def _bool_or_none(d: dict, key: str) -> Optional[bool]:
        v = d.get(key)
        return v if isinstance(v, bool) else None

    def _strlist(d: dict, key: str) -> list[str]:
        v = d.get(key, [])
        return [str(x) for x in v] if isinstance(v, list) else []

    # -----------------------------------------------------------------------

    raw_intent = _str(data, "intent").lower()
    llm_intent = _INTENT_ALIASES.get(raw_intent)
    prompt_intent = _infer_email_intent_from_prompt(prompt)
    if prompt_intent and (llm_intent in (None, "show") or prompt_intent == "prioritize"):
        intent = prompt_intent
    else:
        intent = llm_intent or prompt_intent or "show"
    raw_imp = _int(data, "importance")
    importance = raw_imp if raw_imp in (0, 1, 2) else None
    sender_data = data.get("sender", {})
    time_data = data.get("time", {})
    raw_top_k = _int(data, "top_k")
    explicit_top_k = _extract_explicit_top_k(prompt)
    top_k = (
        explicit_top_k
        if explicit_top_k is not None
        else raw_top_k
        if raw_top_k is not None
        else _default_top_k_for_intent(intent)
    )

    return FilterCriteria(
        intent=intent,
        sender=SenderRef(
            type=_str(sender_data, "type") or "none",
            value=_str(sender_data, "value"),
        ),
        time=TimeRef(
            type=_str(time_data, "type") or "none",
            value=_str(time_data, "value"),
        ),
        top_k=max(1, top_k),
        unread_only=_bool_or_none(data, "unread_only"),
        importance=importance,
        subject_keywords=_strlist(data, "subject_keywords"),
        body_keywords=_strlist(data, "body_keywords"),
        to_contains=_str(data, "to_contains"),
        cc_contains=_str(data, "cc_contains"),
        latest_first=bool(_LATEST_KEYWORDS_RE.search(prompt)),
    )


def _default_top_k_for_intent(intent: str) -> int:
    if intent in ("summarize", "prioritize", "draft"):
        return 50
    return 20


def _build_email_where(
    criteria: FilterCriteria,
    sender_filter: Optional[SenderFilter],
    time_range: Optional[TimeRange],
) -> tuple[list[str], list]:
    where_clauses: list[str] = []
    params: list = []

    if criteria.unread_only is True:
        where_clauses.append("unread = 1")
    elif criteria.unread_only is False:
        where_clauses.append("unread = 0")

    if criteria.importance is not None:
        where_clauses.append("original_importance = ?")
        params.append(criteria.importance)

    for kw in criteria.subject_keywords:
        kw_lower = f"%{kw.lower()}%"
        where_clauses.append("(LOWER(subject) LIKE ? OR LOWER(body) LIKE ?)")
        params.extend([kw_lower, kw_lower])

    for kw in criteria.body_keywords:
        where_clauses.append("LOWER(body) LIKE ?")
        params.append(f"%{kw.lower()}%")

    if criteria.to_contains:
        where_clauses.append("LOWER(to_recipients) LIKE ?")
        params.append(f"%{criteria.to_contains.lower()}%")

    if criteria.cc_contains:
        where_clauses.append("LOWER(cc_recipients) LIKE ?")
        params.append(f"%{criteria.cc_contains.lower()}%")

    if time_range:
        where_clauses.append("received_time >= ?")
        where_clauses.append("received_time <= ?")
        params.extend([time_range.start, time_range.end])

    if sender_filter and sender_filter.sql_clauses:
        where_clauses.append("(" + " OR ".join(sender_filter.sql_clauses) + ")")
        params.extend(sender_filter.sql_params)
        log.debug("Injected sender SQL : %s", sender_filter.sql_clauses)
        log.debug("Sender params       : %s", sender_filter.sql_params)

    return where_clauses, params


def build_sql(
    criteria: FilterCriteria,
    sender_filter: Optional[SenderFilter],
    time_range: Optional[TimeRange],
    *,
    limit_override: Optional[int] = None,
) -> tuple[str, list]:
    """Build a SQLite SELECT statement deterministically from *criteria*.

    Avoids delegating SQL generation to the LLM, which can hallucinate WHERE
    clauses from unrelated tokens (e.g. treating intent labels as keywords).
    Sender clauses are injected after the base query is constructed.
    """
    where_clauses, params = _build_email_where(criteria, sender_filter, time_range)
    sql = "SELECT * FROM ai_inbox"
    if where_clauses:
        sql += " WHERE " + " AND ".join(where_clauses)
    if criteria.latest_first:
        sql += " ORDER BY received_time DESC"
    limit = limit_override if limit_override is not None else criteria.top_k
    if limit > 0:
        sql += f" LIMIT {limit}"

    log.info("Generated SQL: %s", sql)
    log.info("Params       : %s", params)
    return sql, params


def build_count_sql(
    criteria: FilterCriteria,
    sender_filter: Optional[SenderFilter],
    time_range: Optional[TimeRange],
) -> tuple[str, list]:
    where_clauses, params = _build_email_where(criteria, sender_filter, time_range)
    sql = "SELECT COUNT(*) AS count FROM ai_inbox"
    if where_clauses:
        sql += " WHERE " + " AND ".join(where_clauses)
    log.info("Generated count SQL: %s", sql)
    log.info("Count params       : %s", params)
    return sql, params


# ===========================================================================
# Email batch processing (scoring)
# ===========================================================================


def _score_batch(batch: list[Email]) -> list[dict]:
    user_content = "\n".join(
        f"--- Id={e.id} ---\nBody:\n{e.body[:600]}\n" for e in batch
    )
    messages = [
        {"role": "system", "content": SCORE_PROMPT_TEMPLATE.format(owner=_cfg.owner)},
        {"role": "user", "content": user_content},
    ]
    raw = call_llm(messages, temperature=0.1, max_tokens=_cfg.score_max_tokens)
    return parse_json_response(raw)


def score_emails(emails: list[Email]) -> list[Email]:
    if not emails:
        return emails

    total_batches = (len(emails) + _cfg.micro_batch_size - 1) // _cfg.micro_batch_size
    log.info(
        "Scoring %d emails in %d micro-batches of %d",
        len(emails),
        total_batches,
        _cfg.micro_batch_size,
    )

    lookup = {e.id: e for e in emails}
    failed = 0

    for idx in range(total_batches):
        batch = emails[idx * _cfg.micro_batch_size : (idx + 1) * _cfg.micro_batch_size]
        log.info(
            "  Batch %d/%d  (emails %d-%d)",
            idx + 1,
            total_batches,
            batch[0].id,
            batch[-1].id,
        )
        try:
            for item in _score_batch(batch):
                eid = item.get("id")
                if eid in lookup:
                    lookup[eid].priority_score = item.get("priority_score", 0)
                    lookup[eid].summary = item.get("summary", lookup[eid].subject)
        except Exception as exc:
            log.error("  Batch %d failed: %s", idx + 1, exc)
            failed += len(batch)

    # Apply fallback defaults for any emails that were not scored
    for e in emails:
        if not e.priority_score:
            e.priority_score = 50
            e.summary = e.subject

    log.info("Scoring complete. %d succeeded, %d failed.", len(emails) - failed, failed)
    return emails


# ===========================================================================
# Shared batch-processing helper
# ===========================================================================


def _process_in_batches(
    emails: list[Email],
    label: str,
    build_entries: Callable[[list[Email]], list[str]],
    build_messages: Callable[[list[str]], list[dict]],
    temperature: float,
    max_tokens: int,
) -> list[str]:
    """Run an LLM call over *emails* in micro-batches; return one string per batch."""
    total = (len(emails) + _cfg.micro_batch_size - 1) // _cfg.micro_batch_size
    log.info(
        "%s %d emails in %d micro-batches of %d",
        label,
        len(emails),
        total,
        _cfg.micro_batch_size,
    )
    outputs: list[str] = []

    for idx in range(total):
        batch = emails[idx * _cfg.micro_batch_size : (idx + 1) * _cfg.micro_batch_size]
        log.info(
            "  Batch %d/%d  (emails %d-%d)", idx + 1, total, batch[0].id, batch[-1].id
        )
        entries = build_entries(batch)
        messages = build_messages(entries)
        try:
            outputs.append(
                call_llm(messages, temperature=temperature, max_tokens=max_tokens)
            )
        except Exception as exc:
            log.error("  Batch %d failed: %s", idx + 1, exc)
            outputs.append(f"[Batch {idx + 1} failed]")

    return outputs


# ===========================================================================
# Email actions
# ===========================================================================


def _format_email_listing(emails: list[Email], header: str) -> str:
    if not emails:
        return "No emails matched your query."
    lines = [header]
    for e in emails:
        unread_tag = "  [UNREAD]" if e.unread else ""
        match_tag = (
            f"  Match={getattr(e, '_match_score', '?')}%"
            if hasattr(e, "_match_score")
            else ""
        )
        gmail_id_line = (
            f"  Gmail ID: {e.email_id}\n" if e.email_id else ""
        )
        lines.append(
            f"  [{e.id}]{unread_tag}{match_tag}\n"
            f"{gmail_id_line}"
            f"  From    : {e.from_name} <{e.from_email}>\n"
            f"  Subject : {e.subject}\n"
            f"  Received: {e.received_time}\n"
            f"  Body    : {e.body.replace(chr(10), ' ')}\n"
        )
    return "\n".join(lines)


def action_show(emails: list[Email], _prompt: str) -> str:
    return _format_email_listing(emails, f"Found {len(emails)} email(s):\n")


def _format_count_response(
    total_count: int,
    listed_emails: Optional[list[Email]] = None,
) -> str:
    count_line = f"You have {total_count} email(s) matching your query."
    if listed_emails is None:
        return count_line

    if not listed_emails:
        return count_line + "\n\nNo matching emails are available to list."

    listing = _format_email_listing(
        listed_emails,
        f"Showing {len(listed_emails)} matching email(s):\n",
    )
    return f"{count_line}\n\n{listing}"


def action_summarize(emails: list[Email], original_prompt: str) -> str:
    if not emails:
        return "No emails matched your query."

    def build_entries(batch: list[Email]) -> list[str]:
        return [
            f"[ID={e.id}] From: {e.from_name} <{e.from_email}> | "
            f"Received: {e.received_time} | Subject: {e.subject}\n"
            f"Body: {e.body[:800]}"
            for e in batch
        ]

    def build_messages(entries: list[str]) -> list[dict]:
        return [
            {"role": "system", "content": SUMMARIZE_SYSTEM},
            {
                "role": "user",
                "content": f"Request: {original_prompt}\n\nEmails:\n\n"
                + "\n\n---\n\n".join(entries),
            },
        ]

    parts = _process_in_batches(
        emails,
        "Summarizing",
        build_entries,
        build_messages,
        temperature=0.3,
        max_tokens=2048,
    )
    return "\n\n".join(parts)


def action_prioritize(emails: list[Email], _prompt: str) -> str:
    if not emails:
        return "No emails matched your query."

    id_map: dict[int, dict] = {}

    def build_entries(batch: list[Email]) -> list[str]:
        return [
            f"ID={e.id} | From: {e.from_name} <{e.from_email}>\n"
            f"Subject: {e.subject}\nBody: {e.body[:600]}"
            for e in batch
        ]

    def build_messages(entries: list[str]) -> list[dict]:
        return [
            {"role": "system", "content": PRIORITIZE_SYSTEM},
            {
                "role": "user",
                "content": "Score and rank:\n\n" + "\n\n---\n\n".join(entries),
            },
        ]

    total = (len(emails) + _cfg.micro_batch_size - 1) // _cfg.micro_batch_size
    log.info(
        "Prioritizing %d emails in %d micro-batches of %d",
        len(emails),
        total,
        _cfg.micro_batch_size,
    )

    for idx in range(total):
        batch = emails[idx * _cfg.micro_batch_size : (idx + 1) * _cfg.micro_batch_size]
        entries = build_entries(batch)
        messages = build_messages(entries)
        log.info(
            "  Batch %d/%d  (emails %d-%d)", idx + 1, total, batch[0].id, batch[-1].id
        )
        try:
            raw = call_llm(messages, temperature=0.1, max_tokens=2048)
            results = parse_json_response(raw)
            for r in results:
                eid = r.get("id")
                if eid is not None:
                    id_map[eid] = r
        except Exception as exc:
            log.error("  Batch %d failed: %s", idx + 1, exc)

    ranked = sorted(
        emails,
        key=lambda e: id_map.get(e.id, {}).get("priority_score", 0),
        reverse=True,
    )
    lines = [
        f"  #{i + 1}  [Score={id_map.get(e.id, {}).get('priority_score', 'N/A')}]  "
        f"{e.from_name or e.from_email} - {e.subject}\n"
        f"         {id_map.get(e.id, {}).get('reason', '')}"
        for i, e in enumerate(ranked)
    ]
    return "Prioritized emails:\n" + "\n".join(lines)


def _extract_reply_instruction(prompt: str) -> Optional[str]:
    """Extract the user's explicit reply instruction from a prompt, if present.

    Returns the instruction string or None if the prompt is a generic draft request.
    """
    if not _REPLY_INSTRUCTION_RE.search(prompt):
        return None
    # The whole prompt IS the instruction context — return it so the LLM can
    # condition on the user's stated intent rather than guessing.
    return prompt


def action_draft(emails: list[Email], _prompt: str) -> str:
    if not emails:
        return "No emails matched your query."

    user_instruction = _extract_reply_instruction(_prompt)
    has_instruction = user_instruction is not None

    log.info(
        "Drafting replies for %d emails (instruction-aware=%s) with %d workers...",
        len(emails),
        has_instruction,
        _cfg.draft_workers,
    )
    if has_instruction:
        log.info("  User reply instruction: %s", user_instruction)

    # Choose prompt template based on whether the user provided instructions
    system_prompt = (
        DRAFT_WITH_INSTRUCTIONS_SYSTEM.format(owner=_cfg.owner)
        if has_instruction
        else DRAFT_SYSTEM.format(owner=_cfg.owner)
    )

    def _draft_one(email: Email) -> tuple[int, str]:
        user_content = (
            f"Original email:\nFrom: {email.from_name} <{email.from_email}>\n"
            f"Subject: {email.subject}\nBody:\n{email.body[:1000]}"
        )
        if has_instruction:
            user_content += f"\n\nUser's reply instruction: {user_instruction}"

        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ]
        header = (
            f"--- Draft reply | ID={email.id} | {email.from_name} - {email.subject} ---"
        )
        log.debug(
            "  Draft LLM prompt for email %d: system=%s, user_content_len=%d",
            email.id,
            "DRAFT_WITH_INSTRUCTIONS" if has_instruction else "DRAFT_SYSTEM",
            len(user_content),
        )
        try:
            draft = call_llm(
                messages, temperature=0.4 if has_instruction else 0.6, max_tokens=512
            )
            return email.id, f"{header}\n{draft}"
        except Exception as exc:
            log.error("  Failed to draft for email %d: %s", email.id, exc)
            return email.id, f"{header}\n[DRAFT FAILED]"

    outputs: list[tuple[int, str]] = []
    with ThreadPoolExecutor(max_workers=_cfg.draft_workers) as pool:
        for email_id, output in (
            f.result() for f in as_completed(pool.submit(_draft_one, e) for e in emails)
        ):
            outputs.append((email_id, output))

    outputs.sort(key=lambda x: x[0])
    return "\n\n".join(text for _, text in outputs)


def action_daily_plan(emails: list[Email], original_prompt: str) -> str:
    """Build a time-blocked daily plan combining today's emails and calendar."""
    time_range = _get_calendar_time_range("today")
    try:
        events = fetch_calendar_events(time_range)
    except Exception as exc:
        log.error("Could not fetch calendar for daily plan: %s", exc)
        events = []

    meetings_block = (
        "\n".join(
            f"  {_fmt_dt(ev.start_time)}–{_fmt_dt(ev.end_time)}  {ev.subject}"
            + (f"  @ {ev.location}" if ev.location else "")
            for ev in events
        )
        or "  (No meetings today)"
    )

    emails_block = (
        "\n".join(
            f"  - {'[UNREAD] ' if e.unread else ''}{e.from_name or e.from_email}: {e.subject}"
            f"\n    {e.body[:120].replace(chr(10), ' ')}"
            for e in emails[:20]
        )
        or "  (No open email tasks)"
    )

    messages = [
        {"role": "system", "content": DAILY_PLAN_SYSTEM.format(owner=_cfg.owner)},
        {
            "role": "user",
            "content": (
                f"Request: {original_prompt}\n\n"
                f"TODAY'S CALENDAR:\n{meetings_block}\n\n"
                f"OPEN EMAIL TASKS:\n{emails_block}"
            ),
        },
    ]
    try:
        result = call_llm(messages, temperature=0.3, max_tokens=1024)
        return f"Your focused plan for today:\n\n{result}"
    except Exception as exc:
        log.error("Daily plan LLM call failed: %s", exc)
        return (
            f"Could not generate plan (LLM unavailable).\n\n"
            f"Calendar:\n{meetings_block}\n\nOpen tasks:\n{emails_block}"
        )


def action_summarize_unread_and_draft(emails: list[Email], original_prompt: str) -> str:
    """Summarize each unread email and generate a short draft reply."""
    unread = [e for e in emails if e.unread]
    if not unread:
        return "No unread emails matched your query."
    log.info("Summarizing + drafting replies for %d unread email(s)…", len(unread))

    entries = [
        f"[{i}] From: {e.from_name} <{e.from_email}>\n"
        f"    Subject: {e.subject}\n"
        f"    Body excerpt: {e.body[:500].replace(chr(10), ' ')}"
        for i, e in enumerate(unread, 1)
    ]
    messages = [
        {"role": "system", "content": UNREAD_SUMMARY_SYSTEM.format(owner=_cfg.owner)},
        {
            "role": "user",
            "content": f"Request: {original_prompt}\n\nUnread emails:\n\n"
            + "\n\n".join(entries),
        },
    ]
    try:
        result = call_llm(
            messages, temperature=0.4, max_tokens=min(2048, len(unread) * 300)
        )
        return f"Unread email summaries & draft replies ({len(unread)} messages):\n\n{result}"
    except Exception as exc:
        log.error("Unread summary/draft LLM call failed: %s", exc)
        lines = [f"Unread emails ({len(unread)}) — LLM unavailable, showing list:\n"]
        lines += [f"  [{e.id}] {e.from_name} — {e.subject}" for e in unread]
        return "\n".join(lines)


def action_meeting_prep(emails: list[Email], original_prompt: str) -> str:
    """Generate prep bullet points for meetings in the requested time period."""
    time_label = _detect_calendar_time(original_prompt)
    # Default to tomorrow when no explicit time reference is present
    if time_label == "today" and not re.search(
        r"\btoday\b", original_prompt, re.IGNORECASE
    ):
        time_label = "tomorrow"

    time_range = _get_calendar_time_range(time_label)
    try:
        events = fetch_calendar_events(time_range)
    except Exception as exc:
        log.error("Could not fetch calendar for meeting prep: %s", exc)
        return f"Could not retrieve calendar for {time_label}: {exc}"

    if not events:
        return f"No meetings found for {time_label} — nothing to prepare for."
    log.info("Generating prep bullets for %d meeting(s) (%s)…", len(events), time_label)

    entries = [
        f"Meeting: {ev.subject}\n"
        f"Time: {_fmt_dt(ev.start_time)}–{_fmt_dt(ev.end_time)}\n"
        f"Organizer: {ev.organizer}\n"
        f"Attendees: {ev.required_attendees[:200]}\n"
        f"Agenda/Notes: {ev.body[:500] or '(none provided)'}"
        for ev in events
    ]
    messages = [
        {"role": "system", "content": MEETING_PREP_SYSTEM.format(owner=_cfg.owner)},
        {
            "role": "user",
            "content": (
                f"Request: {original_prompt}\n\n"
                f"Meetings for {time_label}:\n\n" + "\n\n---\n\n".join(entries)
            ),
        },
    ]
    try:
        result = call_llm(
            messages, temperature=0.3, max_tokens=min(4096, len(events) * 400)
        )
        return f"Meeting prep for {time_label} ({len(events)} meeting(s)):\n\n{result}"
    except Exception as exc:
        log.error("Meeting prep LLM call failed: %s", exc)
        lines = [f"Meetings for {time_label} ({len(events)}) — LLM unavailable:\n"]
        lines += [f"  {_fmt_dt(ev.start_time)} {ev.subject}" for ev in events]
        return "\n".join(lines)


# ===========================================================================
# Gmail write actions (send, reply, meeting invite)
# ===========================================================================


def _is_send_action(prompt: str) -> Optional[str]:
    """Detect if the prompt is a write/send action. Returns action type or None."""
    if _MEETING_INVITE_RE.search(prompt):
        log.info("  _is_send_action: matched _MEETING_INVITE_RE")
        return "send_meeting_invite"
    if _REPLY_SEND_RE.search(prompt):
        if _DRAFT_PREFIX_RE.match(prompt.strip()):
            log.info(
                "  _is_send_action: _REPLY_SEND_RE matched but prompt has draft prefix — treating as draft"
            )
            return None
        log.info("  _is_send_action: matched _REPLY_SEND_RE")
        return "reply_email"
    if _SEND_EMAIL_RE.search(prompt):
        log.info("  _is_send_action: matched _SEND_EMAIL_RE")
        return "send_email"
    log.info("  _is_send_action: no regex match")
    return None


_WRITE_ACTION_TOOL = {
    "send_email": "email_send",
    "reply_email": "email_reply",
    "send_meeting_invite": "schedule_meeting",
}


def _write_action_guidance(action: str) -> str:
    tool_name = _WRITE_ACTION_TOOL.get(action, "the appropriate write tool")
    if action == "send_email":
        hint = (
            "Resolve the recipient email address first (use run_email_pipeline "
            "to search if needed), then call `email_send` with explicit `to`, "
            "`subject`, and `body` arguments."
        )
    elif action == "reply_email":
        hint = (
            "Look up the original Gmail message ID first (use run_email_pipeline "
            "to list emails from the sender), then call `email_reply` with "
            "explicit `original_message_id` and `body` arguments."
        )
    elif action == "send_meeting_invite":
        hint = (
            "Resolve attendee email addresses and the meeting time first, then "
            "call `schedule_meeting` with explicit `attendees`, `subject`, and "
            "`start_time` arguments."
        )
    else:
        hint = "Call the dedicated write tool with explicit arguments."
    return (
        f"WRITE_ACTION_REQUIRES_CONFIRMATION: This prompt requests a write action "
        f"({action}). Write actions are not executed by run_email_pipeline; they "
        f"must go through the `{tool_name}` tool, which asks the user to confirm "
        f"the resolved recipient/details before sending. {hint}"
    )


def _parse_send_intent(prompt: str) -> dict:
    """Use LLM to classify the send action and extract parameters."""
    messages = [
        {"role": "system", "content": SEND_INTENT_CLASSIFIER_SYSTEM},
        {"role": "user", "content": prompt},
    ]
    try:
        raw = call_llm(messages, temperature=0.0, max_tokens=400)
        data = parse_json_response(raw)
        if not isinstance(data, dict):
            data = {}
    except Exception as exc:
        log.warning("Send intent classifier failed: %s", exc)
        data = {}
    return data


def _resolve_recipient_email(recipient: str) -> Optional[str]:
    """If recipient is already an email, return it. Otherwise try to look up from DB."""
    if not recipient:
        return None
    # Already an email address
    if "@" in recipient:
        return recipient.strip()
    # Try to find in the DB by name
    try:
        with _db_connect() as conn:
            row = conn.execute(
                "SELECT from_email FROM ai_inbox WHERE LOWER(from_name) LIKE ? LIMIT 1",
                (f"%{recipient.lower()}%",),
            ).fetchone()
            if row:
                return row["from_email"]
    except Exception:
        pass
    return None


def _find_latest_email_from_sender(sender: str) -> Optional[dict]:
    """Find the latest email from a sender in the local DB, returning id and email_id."""
    try:
        with _db_connect() as conn:
            # Try exact email match first
            if "@" in sender:
                row = conn.execute(
                    "SELECT id, email_id, subject, from_name, from_email, body "
                    "FROM ai_inbox WHERE LOWER(from_email) = ? "
                    "ORDER BY received_time DESC LIMIT 1",
                    (sender.lower(),),
                ).fetchone()
            else:
                row = conn.execute(
                    "SELECT id, email_id, subject, from_name, from_email, body "
                    "FROM ai_inbox WHERE LOWER(from_name) LIKE ? "
                    "ORDER BY received_time DESC LIMIT 1",
                    (f"%{sender.lower()}%",),
                ).fetchone()
            if row:
                return {
                    "id": row["id"],
                    "email_id": row["email_id"],
                    "subject": row["subject"],
                    "from_name": row["from_name"],
                    "from_email": row["from_email"],
                    "body": row["body"],
                }
    except Exception:
        pass
    return None


def action_send_email(user_prompt: str) -> str:
    """Route new-email writes to the ask-gated TypeScript tool."""
    return _write_action_guidance("send_email")


def action_reply_email(user_prompt: str) -> str:
    """Route reply writes to the ask-gated TypeScript tool."""
    return _write_action_guidance("reply_email")


def action_send_meeting_invite(user_prompt: str) -> str:
    """Route meeting-invite writes to the ask-gated TypeScript tool."""
    return _write_action_guidance("send_meeting_invite")


# ===========================================================================
# Calendar actions
# ===========================================================================


def _fmt_event_header(ev: CalendarEvent) -> str:
    recur = "  [Recurring]" if ev.is_recurring else ""
    loc = f"  @ {ev.location}" if ev.location else ""
    return (
        f"  [{ev.id}] {ev.start_time} - {ev.end_time}{recur}\n"
        f"       Subject   : {ev.subject}\n"
        f"       Organizer : {ev.organizer}{loc}"
    )


def _fmt_meeting_email(e: Email) -> str:
    """Format a meeting-invite email for calendar-style display."""
    return (
        f"  [Email #{e.id}] {e.received_time}  (from inbox)\n"
        f"       Subject : {e.subject}\n"
        f"       From    : {e.from_name} <{e.from_email}>\n"
        f"       Preview : {e.body[:200].strip()}"
    )


def _meeting_email_section(meeting_emails: list[Email]) -> str:
    """Return a formatted section for meeting-invite emails, or empty string."""
    if not meeting_emails:
        return ""
    lines = [f"\nMeeting-related emails found in inbox ({len(meeting_emails)}):\n"]
    lines += [_fmt_meeting_email(e) for e in meeting_emails]
    return "\n".join(lines)


def calendar_action_show(
    events: list[CalendarEvent],
    time_label: str,
    meeting_emails: list[Email] | None = None,
) -> str:
    parts: list[str] = []
    if events:
        lines = [f"Calendar meetings for {time_label} ({len(events)} total):\n"]
        lines += [_fmt_event_header(ev) for ev in events]
        parts.append("\n".join(lines))
    if meeting_emails:
        parts.append(_meeting_email_section(meeting_emails))
    if not parts:
        return f"No meetings found for {time_label}."
    return "\n".join(parts)


def calendar_action_count(
    events: list[CalendarEvent],
    time_label: str,
    meeting_emails: list[Email] | None = None,
) -> str:
    parts = [f"You have {len(events)} calendar meeting(s) for {time_label}."]
    if meeting_emails:
        parts.append(
            f"Additionally, {len(meeting_emails)} meeting-related email(s) found in your inbox."
        )
    return "\n".join(parts)


def calendar_action_conflicts(
    events: list[CalendarEvent],
    time_label: str,
    meeting_emails: list[Email] | None = None,
) -> str:
    if len(events) < 2:
        return (
            f"No conflicting meetings for {time_label} (fewer than 2 meetings found)."
        )

    def _to_dt(s: str) -> Optional[datetime]:
        try:
            return datetime.strptime(s, _DT_FMT)
        except ValueError:
            return None

    conflicts: list[tuple[CalendarEvent, CalendarEvent]] = []
    for i, a in enumerate(events):
        for b in events[i + 1 :]:
            a_start, a_end = _to_dt(a.start_time), _to_dt(a.end_time)
            b_start, b_end = _to_dt(b.start_time), _to_dt(b.end_time)
            if None in (a_start, a_end, b_start, b_end):
                continue
            if a_start < b_end and b_start < a_end:
                conflicts.append((a, b))

    if not conflicts:
        return f"No conflicting meetings found for {time_label}."

    lines = [f"Found {len(conflicts)} conflict(s) for {time_label}:\n"]
    for idx, (a, b) in enumerate(conflicts, 1):
        lines.append(
            f"  Conflict #{idx}:\n"
            f"    A: [{a.id}] {a.subject}  ({a.start_time} - {a.end_time})\n"
            f"    B: [{b.id}] {b.subject}  ({b.start_time} - {b.end_time})"
        )
    return "\n".join(lines)


def calendar_action_action_items(
    events: list[CalendarEvent],
    time_label: str,
    original_prompt: str,
    meeting_emails: list[Email] | None = None,
) -> str:
    if not events and not meeting_emails:
        return f"No meetings found for {time_label} - no action items to extract."

    entries = [
        f"[Meeting {ev.id}] {ev.subject}  ({ev.start_time})\n"
        f"Agenda/Notes: {ev.body[:600] or '(no agenda provided)'}"
        for ev in events
    ]
    if meeting_emails:
        entries += [
            f"[Meeting Email #{e.id}] {e.subject}  (received {e.received_time})\n"
            f"From: {e.from_name} <{e.from_email}>\n"
            f"Body: {e.body[:600]}"
            for e in meeting_emails
        ]
    messages = [
        {"role": "system", "content": ACTION_ITEMS_SYSTEM},
        {
            "role": "user",
            "content": (
                f"Request: {original_prompt}\n\n"
                "Extract action items from the following meetings:\n\n"
                + "\n\n---\n\n".join(entries)
            ),
        },
    ]
    try:
        result = call_llm(messages, temperature=0.2, max_tokens=1024)
        return f"Action items for {time_label}:\n\n{result}"
    except Exception as exc:
        log.error("LLM call for action items failed: %s", exc)
        lines = [
            f"Action items for {time_label} (LLM unavailable - showing meeting list):\n"
        ]
        lines += [_fmt_event_header(ev) for ev in events]
        return "\n".join(lines)


def calendar_action_summarize(
    events: list[CalendarEvent],
    time_label: str,
    original_prompt: str,
    meeting_emails: list[Email] | None = None,
) -> str:
    if not events and not meeting_emails:
        return f"No meetings found for {time_label} - nothing to summarize."

    entries = [
        f"[{ev.id}] {ev.subject} ({ev.start_time} - {ev.end_time})\n"
        f"Organizer: {ev.organizer}\n"
        f"Attendees: {ev.required_attendees[:200]}\n"
        f"Agenda: {ev.body[:400] or '(none)'}"
        for ev in events
    ]
    if meeting_emails:
        entries += [
            f"[Meeting Email #{e.id}] {e.subject} (received {e.received_time})\n"
            f"From: {e.from_name} <{e.from_email}>\n"
            f"Body: {e.body[:400]}"
            for e in meeting_emails
        ]
    messages = [
        {"role": "system", "content": SUMMARIZE_CALENDAR_SYSTEM},
        {
            "role": "user",
            "content": (
                f"Request: {original_prompt}\n\n"
                f"Meetings for {time_label}:\n\n" + "\n\n---\n\n".join(entries)
            ),
        },
    ]
    try:
        result = call_llm(messages, temperature=0.3, max_tokens=1024)
        return f"Calendar summary for {time_label}:\n\n{result}"
    except Exception as exc:
        log.error("LLM call for calendar summary failed: %s", exc)
        return calendar_action_show(events, time_label)


# Calendar action dispatch
# All callables share the (events, time_label, prompt, meeting_emails) signature.
_CALENDAR_ACTION_MAP: dict[str, Callable] = {
    "show": lambda evs, lbl, prompt, me: calendar_action_show(evs, lbl, me),
    "count": lambda evs, lbl, prompt, me: calendar_action_count(evs, lbl, me),
    "conflicts": lambda evs, lbl, prompt, me: calendar_action_conflicts(evs, lbl, me),
    "action_items": calendar_action_action_items,
    "summarize": calendar_action_summarize,
}


# ===========================================================================
# Combined (email + calendar) actions
# ===========================================================================


def action_combined_summarize(
    emails: list[Email],
    events: list[CalendarEvent],
    time_label: str,
    original_prompt: str,
) -> str:
    """Produce a unified summary of emails and calendar events."""
    email_entries = [
        f"[Email ID={e.id}] From: {e.from_name} <{e.from_email}> | "
        f"Received: {e.received_time} | Subject: {e.subject}\n"
        f"Body: {e.body[:600]}"
        for e in emails[:30]
    ]
    calendar_entries = [
        f"[Meeting ID={ev.id}] {ev.subject} ({_fmt_dt(ev.start_time)}–{_fmt_dt(ev.end_time)})\n"
        f"Organizer: {ev.organizer} | Attendees: {ev.required_attendees[:150]}\n"
        f"Agenda: {ev.body[:300] or '(none)'}"
        for ev in events
    ]
    emails_block = "\n\n---\n\n".join(email_entries) or "(No emails)"
    calendar_block = "\n\n---\n\n".join(calendar_entries) or "(No meetings)"

    messages = [
        {
            "role": "system",
            "content": COMBINED_SUMMARIZE_SYSTEM.format(owner=_cfg.owner),
        },
        {
            "role": "user",
            "content": (
                f"Request: {original_prompt}\n\n"
                f"EMAILS ({len(emails)} total):\n\n{emails_block}\n\n"
                f"CALENDAR EVENTS for {time_label} ({len(events)} total):\n\n{calendar_block}"
            ),
        },
    ]
    try:
        result = call_llm(messages, temperature=0.3, max_tokens=2048)
        return f"Email + Calendar summary for {time_label}:\n\n{result}"
    except Exception as exc:
        log.error("Combined summarize LLM call failed: %s", exc)
        email_out = (
            action_summarize(emails, original_prompt) if emails else "(No emails)"
        )
        return f"=== EMAIL SUMMARY ===\n{email_out}\n\n=== CALENDAR ===\n{calendar_action_show(events, time_label)}"


def action_combined_prioritize(
    emails: list[Email],
    events: list[CalendarEvent],
    time_label: str,
    original_prompt: str,
) -> str:
    """Produce a unified ranked priority list across emails and calendar events."""
    email_entries = [
        f"[Email] ID={e.id} | From: {e.from_name} <{e.from_email}>\n"
        f"Subject: {e.subject}\nBody: {e.body[:400]}"
        for e in emails[:30]
    ]
    calendar_entries = [
        f"[Meeting] ID={ev.id} | {ev.subject} ({_fmt_dt(ev.start_time)}–{_fmt_dt(ev.end_time)})\n"
        f"Organizer: {ev.organizer}\nAgenda: {ev.body[:300] or '(none)'}"
        for ev in events
    ]
    all_entries = email_entries + calendar_entries
    if not all_entries:
        return f"No emails or meetings found for {time_label}."

    messages = [
        {
            "role": "system",
            "content": COMBINED_PRIORITIZE_SYSTEM.format(owner=_cfg.owner),
        },
        {
            "role": "user",
            "content": (
                f"Request: {original_prompt}\n\n"
                f"Time period: {time_label}\n\n" + "\n\n---\n\n".join(all_entries)
            ),
        },
    ]
    try:
        result = call_llm(messages, temperature=0.1, max_tokens=2048)
        return f"Prioritized tasks from email + calendar for {time_label}:\n\n{result}"
    except Exception as exc:
        log.error("Combined prioritize LLM call failed: %s", exc)
        email_out = (
            action_prioritize(emails, original_prompt) if emails else "(No emails)"
        )
        cal_out = (
            calendar_action_action_items(events, time_label, original_prompt)
            if events
            else f"No meetings for {time_label}."
        )
        return f"=== EMAIL PRIORITIES ===\n{email_out}\n\n=== CALENDAR ACTION ITEMS ===\n{cal_out}"


def action_combined_show(
    emails: list[Email],
    events: list[CalendarEvent],
    time_label: str,
    original_prompt: str,
) -> str:
    """Show emails and calendar events side by side."""
    email_out = action_show(emails, original_prompt) if emails else "No emails found."
    cal_out = calendar_action_show(events, time_label)
    return f"=== EMAILS ===\n{email_out}\n\n=== CALENDAR ({time_label}) ===\n{cal_out}"


# ===========================================================================
# Agent entry points
# ===========================================================================


def _fetch_emails(criteria: FilterCriteria) -> list[Email]:
    """Execute the full email-retrieval pipeline and return a filtered list.

    Falls back to a live Gmail API query when the local cache returns no results
    and the criteria contains meaningful filters (sender, keywords, etc.).
    """
    sender_filter = resolve_sender(criteria)
    time_range = resolve_time(criteria.time)
    sql, params = build_sql(criteria, sender_filter, time_range)
    emails = run_sql(sql, params)
    if sender_filter:
        emails = fuzzy_filter_by_sender(emails, sender_filter)

    # Live Gmail API fallback: if the local cache returned nothing and the query
    # has meaningful filters, try querying Gmail directly.
    if not emails and _has_meaningful_filters(criteria):
        log.info("Cache miss — attempting live Gmail API fallback.")
        emails = _gmail_live_query(criteria, time_range, max_results=criteria.top_k)
        if emails:
            log.info("Live Gmail fallback returned %d results.", len(emails))

    return emails[: criteria.top_k]


def _has_meaningful_filters(criteria: FilterCriteria) -> bool:
    """Return True if the criteria has at least one filter worth querying the API for."""
    if criteria.sender.type != "none" and criteria.sender.value:
        return True
    if criteria.subject_keywords or criteria.body_keywords:
        return True
    if criteria.to_contains or criteria.cc_contains:
        return True
    return False


def run_calendar_agent(user_prompt: str) -> str:
    log.info("Calendar prompt: %s", user_prompt)
    intent = _detect_calendar_intent(user_prompt)
    time_label = _detect_calendar_time(user_prompt)
    time_range = _get_calendar_time_range(time_label)
    log.info(
        "Calendar intent=%r  time=%r  range=%s -> %s",
        intent, time_label, time_range.start, time_range.end,
    )

    try:
        events = fetch_calendar_events(time_range)
    except FileNotFoundError as exc:
        return str(exc)
    except Exception as exc:
        log.error("Calendar DB fetch failed: %s", exc)
        return f"Could not retrieve calendar data: {exc}"

    # Also search inbox for meeting-invite emails (Teams, Zoom, etc.)
    # that may not have been added to the calendar.
    email_time_range = resolve_time(TimeRef("relative", time_label)) or time_range
    try:
        meeting_emails = fetch_meeting_emails(email_time_range)
    except Exception as exc:
        log.warning("Meeting email search failed: %s", exc)
        meeting_emails = []

    log.info("Calendar events fetched: %d", len(events))
    log.info("Meeting-related emails found: %d", len(meeting_emails))
    action_fn = _CALENDAR_ACTION_MAP.get(intent, _CALENDAR_ACTION_MAP["show"])
    return action_fn(events, time_label, user_prompt, meeting_emails)


def run_combined_agent(user_prompt: str) -> str:
    """Handle prompts that ask about both email and calendar."""
    log.info("Prompt: %s", user_prompt)
    log.info("Combined email + calendar intent detected")

    time_label = _detect_calendar_time(user_prompt)
    cal_time_range = _get_calendar_time_range(time_label)
    log.info(
        "Time label: %r  range: %s -> %s",
        time_label, cal_time_range.start, cal_time_range.end,
    )

    try:
        events = fetch_calendar_events(cal_time_range)
    except Exception as exc:
        log.error("Calendar fetch failed in combined agent: %s", exc)
        events = []
    log.info("Calendar events fetched: %d", len(events))

    criteria = extract_structured_query(user_prompt)
    if criteria.time.type == "none":
        criteria.time = TimeRef("relative", time_label)
    if criteria.top_k < 20 and criteria.intent in ("prioritize", "summarize"):
        criteria.top_k = 50

    try:
        emails = _fetch_emails(criteria)
    except Exception as exc:
        log.error("Email fetch failed in combined agent: %s", exc)
        emails = []
    log.info("Emails fetched: %d", len(emails))

    if criteria.intent == "summarize":
        return action_combined_summarize(emails, events, time_label, user_prompt)
    if criteria.intent == "prioritize":
        return action_combined_prioritize(emails, events, time_label, user_prompt)
    return action_combined_show(emails, events, time_label, user_prompt)


def _run_composite_agent(composite: str, user_prompt: str) -> str:
    """Handle composite intents (daily_plan, summarize_unread, meeting_prep)."""
    log.info("Prompt: %s", user_prompt)
    log.info("Composite intent detected: %r", composite)

    if composite == "summarize_unread":
        criteria = extract_structured_query(user_prompt)
        criteria.unread_only = True
        criteria.top_k = max(criteria.top_k, 50)
        emails = _fetch_emails(criteria)
        log.info("Unread emails fetched: %d", len(emails))

    elif composite == "daily_plan":
        criteria = extract_structured_query(user_prompt)
        criteria.top_k = 20
        criteria.time = TimeRef("relative", "today")
        try:
            emails = _fetch_emails(criteria)
        except Exception:
            emails = []
        log.info("Emails fetched for plan: %d", len(emails))

    else:
        # meeting_prep fetches calendar internally
        emails = []

    action_fn = _EMAIL_ACTION_MAP[composite]
    return action_fn(emails, user_prompt)


def run_agent(user_prompt: str) -> str:
    """Main dispatch: send actions → combined → composite → calendar → email.

    Includes a reply-intent safety net: if the LLM classifier routes to 'draft'
    but the prompt contains explicit reply instructions, reroute to reply_email.
    """
    log.info("=== run_agent START ===")
    log.info("  User prompt: %s", user_prompt)

    # Check for write/send actions first (send email, reply, meeting invite)
    send_action = _is_send_action(user_prompt)
    log.info("  _is_send_action result: %s", send_action)
    if send_action:
        return _write_action_guidance(send_action)

    if _is_combined_email_calendar(user_prompt):
        return run_combined_agent(user_prompt)

    composite = _detect_composite_intent(user_prompt)
    if composite:
        return _run_composite_agent(composite, user_prompt)

    if is_calendar_prompt(user_prompt):
        return run_calendar_agent(user_prompt)

    # Standard email pipeline
    log.info("Prompt: %s", user_prompt)
    criteria = extract_structured_query(user_prompt)
    log.info(
        "  Classified intent: %r (raw from LLM → normalised)",
        criteria.intent,
    )
    log.info(
        "Parsed: intent=%r  sender=%s  time=%s  top_k=%d  "
        "unread_only=%s  importance=%s  subject_kw=%s  body_kw=%s",
        criteria.intent, criteria.sender, criteria.time, criteria.top_k,
        criteria.unread_only, criteria.importance,
        criteria.subject_keywords, criteria.body_keywords,
    )

    # --- Reply-intent safety net -------------------------------------------
    # If the classifier resolved to 'draft' but the user's prompt contains
    # explicit reply instructions (decline, reschedule, "saying I can't", etc.),
    # route to the email_reply tool via guidance.
    if criteria.intent == "draft" and _REPLY_INSTRUCTION_RE.search(user_prompt):
        log.info(
            "  SAFETY NET: intent was 'draft' but prompt contains reply "
            "instructions — returning guidance for email_reply tool"
        )
        return _write_action_guidance("reply_email")
    # -----------------------------------------------------------------------

    sender_filter = resolve_sender(criteria)
    if sender_filter:
        log.info(
            "Sender filter: '%s' | tokens=%s",
            sender_filter.raw_query, sender_filter.name_tokens,
        )

    time_range = resolve_time(criteria.time)
    if time_range:
        log.info("Time range: %s -> %s", time_range.start, time_range.end)

    if _is_email_count_query(user_prompt):
        total_count = count_matching_emails(criteria, sender_filter, time_range)
        listed_emails = (
            fetch_count_listing_emails(criteria, sender_filter, time_range)
            if _count_query_wants_listing(user_prompt)
            else None
        )
        log.info(
            "Count query answered over full filtered dataset: total=%d listed=%s",
            total_count,
            len(listed_emails) if listed_emails is not None else "none",
        )
        return _format_count_response(total_count, listed_emails)

    sql, params = build_sql(criteria, sender_filter, time_range)
    emails = run_sql(sql, params)
    log.info("Rows from DB: %d", len(emails))

    # If no results and we had keyword filters, retry with a broader query
    # (drop subject/body keywords, keep time/unread/importance/sender constraints)
    if not emails and (criteria.subject_keywords or criteria.body_keywords):
        log.info("Zero results with keyword filters; retrying without keywords")
        broad_criteria = FilterCriteria(
            intent=criteria.intent,
            sender=criteria.sender,
            time=criteria.time,
            top_k=criteria.top_k,
            unread_only=criteria.unread_only,
            importance=criteria.importance,
            subject_keywords=[],
            body_keywords=[],
            to_contains=criteria.to_contains,
            cc_contains=criteria.cc_contains,
            latest_first=criteria.latest_first,
        )
        sql, params = build_sql(broad_criteria, sender_filter, time_range)
        emails = run_sql(sql, params)
        if emails:
            log.info("Rows from DB (broad retry): %d", len(emails))

    if sender_filter:
        emails = fuzzy_filter_by_sender(emails, sender_filter)
        log.info("After fuzzy filter: %d", len(emails))

    # Live Gmail API fallback: if cache is still empty after retries and we have
    # meaningful filters, query Gmail API directly.
    if not emails and _has_meaningful_filters(criteria):
        log.info("Cache exhausted — attempting live Gmail API fallback in run_agent.")
        emails = _gmail_live_query(criteria, time_range, max_results=criteria.top_k)
        if emails:
            log.info("Live Gmail fallback returned %d results.", len(emails))

    total_matched = len(emails)
    emails = emails[: criteria.top_k]
    if total_matched > criteria.top_k:
        log.info("Showing top %d of %d matched emails", criteria.top_k, total_matched)

    action_fn = _EMAIL_ACTION_MAP.get(criteria.intent, action_show)
    log.info("  Chosen action: %s (intent=%r)", action_fn.__name__, criteria.intent)
    log.info("Action: %s", criteria.intent)
    return action_fn(emails, user_prompt)


# Email action dispatch map (defined after all action functions)
_EMAIL_ACTION_MAP: dict[str, Callable] = {
    "show": action_show,
    "fetch": action_show,
    "summarize": action_summarize,
    "prioritize": action_prioritize,
    "draft": action_draft,
    "daily_plan": action_daily_plan,
    "summarize_unread": action_summarize_unread_and_draft,
    "meeting_prep": action_meeting_prep,
}


# ===========================================================================
# CLI entry point
# ===========================================================================

_BANNER = """
Natural Language Email + Calendar Agent v2

Email examples:
  - Fetch the latest 10 emails
  - Show latest emails
  - Fetch the latest email from John Doe
  - Summarize emails from john.doe@example.com for this week
  - Summarize emails about Superbuilder since last week
  - Show emails since yesterday / since noon
  - Prioritize emails from John Doe this month
  - Draft a reply to the most recent email from John Doe
  - Fetch emails CC'd to John Doe this month

Send/Reply examples:
  - Send a new email to john.doe@example.com asking about the status of superbuilder v3.0
  - Send a response to the latest email from John Doe indicating that I am out of office
  - Reply to the latest email from John Doe saying I will review it by Friday

Meeting invite examples:
  - Send a meeting invite to john.doe@example.com at 10:00 am tomorrow for one hour
  - Schedule a meeting with john.doe@example.com next Monday at 2pm for 30 minutes
  - Book a meeting with the team at 3pm tomorrow to discuss project updates

Calendar examples:
  - List conflicting meetings for today
  - Are there any action items for me for today's meetings?
  - How many meetings do I have tomorrow?
  - Summarize my meetings for today

Combined email + calendar examples:
  - Summarize my email and calendar today
  - Prioritize my tasks from email and calendar today
  - Show my emails and meetings for this week
  - What are the most urgent items from my email and calendar today?

Productivity examples:
  - Build a focused plan from my tasks and calendar
  - Summarize my unread messages and draft short replies
  - Generate prep bullets for tomorrow's meetings
"""


def _build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Natural Language Email + Calendar Agent"
    )
    parser.add_argument(
        "--db-path", default=None, help="Path to the email SQLite database"
    )
    parser.add_argument(
        "--prompt",
        default=None,
        help="Run a single prompt non-interactively, then exit",
    )
    parser.add_argument(
        "--fuzzy-threshold",
        type=float,
        default=_DEFAULT_FUZZY_THRESHOLD,
        help="Minimum fuzzy match score 0-100",
    )
    return parser


def main() -> None:
    args = _build_arg_parser().parse_args()
    init_config(db_path=args.db_path, fuzzy_threshold=args.fuzzy_threshold)

    if args.prompt:
        print("\n" + run_agent(args.prompt) + "\n")
        return

    print(_BANNER)

    while True:
        try:
            user_input = input("You: ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\nGoodbye!")
            break
        if not user_input:
            continue
        if user_input.lower() in ("exit", "quit", "q"):
            print("Goodbye!")
            break
        print("\n" + run_agent(user_input) + "\n")


if __name__ == "__main__":
    main()
