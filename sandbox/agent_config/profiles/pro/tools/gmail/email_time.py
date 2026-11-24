"""
Date / time resolution for the email + calendar agent.
======================================================
Natural-language time handling, the first of two extractions that bring
email_pipeline.py from 2,513 code lines to 1,879: this one took it to 2,035 and
email_senders.py took the rest, which puts it under the ratchet's 2,000 threshold
and off the god-file list. The ratchet forbids growth rather than enforcing a
cap, so both extractions satisfy it by shrinking.

No database, no LLM calls, no configuration. Three functions do read the
environment, and they are the ones to patch when testing: _local_tz() and
_now_local() take the host timezone and wall clock, and get_date_range() builds
its range from arrow's own clock rather than from _now_local(). Everything else
is a value transform over its arguments, which is why most of this module is
cheap to test exhaustively.

All timezone handling follows one convention: relative labels ("today",
"yesterday") are interpreted in the user's *local* timezone so they mean the
user's calendar day, and every TimeRange returned holds naive *UTC* strings for
comparison against the database. _make_local_range() is the boundary where that
conversion happens; _make_range() is for values already in UTC.

Tests: tests/agents/email/test_email_time.py
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Callable, Optional

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Optional third-party: arrow / tzlocal for rich date arithmetic
# ---------------------------------------------------------------------------
try:
    import arrow
    from difflib import get_close_matches
    from tzlocal import get_localzone

    # Maps canonical time-description strings to (shift_kwargs, span_unit)
    _TIME_DESCRIPTIONS: dict[str, tuple[dict, str]] = {
        "today": ({}, "day"),
        "this week": ({}, "week"),
        "this month": ({}, "month"),
        "this quarter": ({}, "quarter"),
        "this year": ({}, "year"),
        "tomorrow": ({"days": +1}, "day"),
        "next week": ({"weeks": +1}, "week"),
        "next month": ({"months": +1}, "month"),
        "next quarter": ({"months": +3}, "quarter"),
        "next year": ({"years": +1}, "year"),
        "yesterday": ({"days": -1}, "day"),
        "last week": ({"weeks": -1}, "week"),
        "last month": ({"months": -1}, "month"),
        "last quarter": ({"months": -3}, "quarter"),
        "last year": ({"years": -1}, "year"),
        "previous week": ({"weeks": -1}, "week"),
        "previous month": ({"months": -1}, "month"),
        "previous quarter": ({"months": -3}, "quarter"),
        "previous year": ({"years": -1}, "year"),
        "past week": ({"weeks": -1}, "week"),
        "past month": ({"months": -1}, "month"),
        "past year": ({"years": -1}, "year"),
    }

    def get_date_range(description: str) -> dict:
        local_tz = str(get_localzone())
        normalized = description.lower().strip()
        canonical = normalized if normalized in _TIME_DESCRIPTIONS else None
        if canonical is None:
            matches = get_close_matches(
                normalized, _TIME_DESCRIPTIONS.keys(), n=1, cutoff=0.72
            )
            canonical = matches[0] if matches else None
        if canonical is None:
            raise ValueError(f"Unrecognized time description: {description!r}")
        shift_kwargs, span_unit = _TIME_DESCRIPTIONS[canonical]
        # Resolve in local timezone (so "today" = user's day), then convert to UTC
        now = arrow.now(local_tz)
        anchor = now.shift(**shift_kwargs) if shift_kwargs else now
        start, end = anchor.span(span_unit)
        return {
            "description": canonical,
            "start": start.to("UTC").strftime("%Y-%m-%d %H:%M:%S"),
            "end": end.to("UTC").strftime("%Y-%m-%d %H:%M:%S"),
            "timezone": "UTC",
        }

    ARROW_AVAILABLE = True

except ImportError:
    ARROW_AVAILABLE = False

    def get_date_range(description: str) -> dict:  # type: ignore[misc]
        raise ImportError(
            "arrow / tzlocal not installed. Run: pip install arrow tzlocal"
        )

_DT_FMT = "%Y-%m-%d %H:%M:%S"
_DAY_NAMES = [
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
]

_TIME_OF_DAY_ANCHORS: dict[str, tuple[int, int]] = {
    "morning": (6, 0),
    "afternoon": (12, 0),
    "evening": (17, 0),
    "night": (20, 0),
    "midnight": (0, 0),
    "noon": (12, 0),
}


@dataclass
class TimeRange:
    start: str
    end: str


@dataclass
class TimeRef:
    type: str
    value: str


_SINCE_HOUR_RE = re.compile(
    r"since\s+(noon|midnight|(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)", re.IGNORECASE
)
_LAST_N_RE = re.compile(
    r"(?:last|past)\s+(\d+)\s+(hour|day|week|month)s?", re.IGNORECASE
)
_ABS_DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}")
_SINCE_DAY_RE = re.compile(
    r"since\s+"
    r"(today\s+morning|today\s+afternoon|today\s+evening|"
    r"this\s+morning|this\s+afternoon|this\s+evening|"
    r"last\s+night|yesterday|today|"
    r"last\s+(?:week|month|year)|this\s+(?:week|month|year)|"
    r"(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))",
    re.IGNORECASE,
)

# ===========================================================================
# Date / time resolution
# ===========================================================================


def _local_tz() -> timezone:
    """Return the system's local timezone as a fixed-offset :class:`timezone`."""
    try:
        from tzlocal import get_localzone

        tz = get_localzone()
        # get_localzone may return a zoneinfo/pytz zone; grab the current
        # UTC offset so we can work with stdlib datetime objects.
        offset = datetime.now(tz).utcoffset()
        return timezone(offset)  # type: ignore[arg-type]
    except Exception:
        # Fallback: compute offset from the C library's local time.
        import time as _time

        utc_offset = timedelta(
            seconds=-_time.timezone if _time.daylight == 0 else -_time.altzone
        )
        return timezone(utc_offset)


def _local_to_utc(dt: datetime) -> datetime:
    """Convert a naive *local-time* datetime to a naive UTC datetime."""
    aware = dt.replace(tzinfo=_local_tz())
    return aware.astimezone(timezone.utc).replace(tzinfo=None)


def _utc_to_local_str(utc_str: str) -> str:
    """Convert a UTC timestamp string to a human-readable local-time string.

    Input format: ``YYYY-MM-DD HH:MM:SS`` (naive UTC from DB).
    Output format: ``YYYY-MM-DD HH:MM:SS`` in the user's local timezone.

    Returns the original string unchanged if parsing fails.
    """
    if not utc_str:
        return utc_str
    try:
        utc_dt = datetime.strptime(utc_str, _DT_FMT).replace(tzinfo=timezone.utc)
        local_dt = utc_dt.astimezone(_local_tz())
        return local_dt.strftime(_DT_FMT)
    except (ValueError, TypeError):
        return utc_str


def _now_local() -> datetime:
    """Return the current time in the user's local timezone (naive)."""
    return datetime.now(_local_tz()).replace(tzinfo=None)


def _today_midnight(now: datetime) -> datetime:
    return now.replace(hour=0, minute=0, second=0, microsecond=0)


def _make_range(start: datetime, end: datetime) -> TimeRange:
    """Create a TimeRange from naive *UTC* datetimes."""
    return TimeRange(start=start.strftime(_DT_FMT), end=end.strftime(_DT_FMT))


def _make_local_range(start: datetime, end: datetime) -> TimeRange:
    """Create a TimeRange by converting naive *local-time* boundaries to UTC."""
    return _make_range(_local_to_utc(start), _local_to_utc(end))


def _end_of_day(dt: datetime) -> datetime:
    return dt.replace(hour=23, minute=59, second=59, microsecond=0)


def _resolve_relative_no_arrow(val: str, now: datetime) -> Optional[TimeRange]:
    """Resolve a plain relative time label without the *arrow* library.

    ``now`` is in the user's **local** timezone (naive).  The returned
    :class:`TimeRange` contains **UTC** strings suitable for DB queries.
    """
    v = val.lower().strip()
    today = _today_midnight(now)

    resolutions: dict[str, Callable[[], TimeRange]] = {
        "today": lambda: _make_local_range(today, now),
        "yesterday": lambda: _make_local_range(
            today - timedelta(days=1), today - timedelta(seconds=1)
        ),
        "this week": lambda: _make_local_range(
            today - timedelta(days=today.weekday()),
            _end_of_day(today - timedelta(days=today.weekday()) + timedelta(days=6)),
        ),
        "past week": lambda: _make_local_range(today - timedelta(days=7), now),
        "last week": lambda: _make_local_range(
            today - timedelta(days=today.weekday() + 7),
            _end_of_day(today - timedelta(days=today.weekday() + 1)),
        ),
        "this month": lambda: _make_local_range(today.replace(day=1), now),
        "last month": lambda: _make_local_range(
            (today.replace(day=1) - timedelta(seconds=1)).replace(
                day=1, hour=0, minute=0, second=0
            ),
            today.replace(day=1) - timedelta(seconds=1),
        ),
        "this year": lambda: _make_local_range(today.replace(month=1, day=1), now),
        "last year": lambda: _make_local_range(
            today.replace(year=today.year - 1, month=1, day=1),
            today.replace(month=1, day=1) - timedelta(seconds=1),
        ),
    }

    fn = resolutions.get(v)
    return fn() if fn else None


def _resolve_since_day(since_phrase: str, now: datetime) -> Optional[TimeRange]:
    """Resolve a 'since <phrase>' day expression to a TimeRange ending *now*.

    ``now`` is in the user's **local** timezone (naive).  The returned
    :class:`TimeRange` contains **UTC** strings.
    """
    p = since_phrase.lower().strip()
    today = _today_midnight(now)

    if p == "yesterday":
        return _make_local_range(today - timedelta(days=1), now)
    if p == "today":
        return _make_local_range(today, now)

    for tod, (h, mn) in _TIME_OF_DAY_ANCHORS.items():
        if p in (f"today {tod}", f"this {tod}"):
            anchor = today.replace(hour=h, minute=mn, second=0, microsecond=0)
            return _make_local_range(anchor, now)

    if p == "last night":
        anchor = (today - timedelta(days=1)).replace(
            hour=_TIME_OF_DAY_ANCHORS["night"][0],
            minute=_TIME_OF_DAY_ANCHORS["night"][1],
            second=0,
            microsecond=0,
        )
        return _make_local_range(anchor, now)

    period_tr = _resolve_relative_no_arrow(p, now)
    if period_tr:
        # period_tr is already in UTC; override end with UTC-converted local now
        now_utc = _local_to_utc(now)
        return TimeRange(start=period_tr.start, end=now_utc.strftime(_DT_FMT))

    if p in _DAY_NAMES:
        days_back = (now.weekday() - _DAY_NAMES.index(p)) % 7
        return _make_local_range(today - timedelta(days=days_back), now)

    return None


def resolve_time(time_ref: TimeRef) -> Optional[TimeRange]:
    """Convert a *TimeRef* to an absolute *TimeRange*.

    Relative labels (``today``, ``yesterday``, etc.) are interpreted in
    the user's **local** timezone so that "today" means the user's calendar
    day.  The returned :class:`TimeRange` always contains **UTC** strings
    for comparison against the database.
    """
    if time_ref.type == "none" or not time_ref.value:
        return None

    now = _now_local()
    now_utc = _local_to_utc(now)
    val = time_ref.value.strip()

    # "since <clock time>" — clock times are in the user's local timezone
    m = _SINCE_HOUR_RE.search(val)
    if m:
        token = m.group(1).lower()
        if token == "noon":
            start = now.replace(hour=12, minute=0, second=0, microsecond=0)
        elif token == "midnight":
            start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        else:
            hour = int(m.group(2))
            minute = int(m.group(3)) if m.group(3) else 0
            ampm = (m.group(4) or "").lower()
            if ampm == "pm" and hour != 12:
                hour += 12
            elif ampm == "am" and hour == 12:
                hour = 0
            start = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
        return _make_local_range(start, now)

    # "since <day phrase>"
    m2 = _SINCE_DAY_RE.search(val)
    if m2:
        tr = _resolve_since_day(m2.group(1).strip(), now)
        if tr:
            log.info(
                "Resolved 'since %s' -> %s -> %s", m2.group(1).strip(), tr.start, tr.end
            )
            return tr

    # "last N hours/days/weeks/months"
    m3 = _LAST_N_RE.search(val)
    if m3:
        n = int(m3.group(1))
        unit = m3.group(2).lower()
        delta = {
            "hour": timedelta(hours=n),
            "day": timedelta(days=n),
            "week": timedelta(weeks=n),
            "month": timedelta(days=30 * n),
        }[unit]
        return _make_range(now_utc - delta, now_utc)

    # Absolute ISO dates — already calendar-day boundaries, treat as UTC
    if _ABS_DATE_RE.search(val):
        dates = _ABS_DATE_RE.findall(val)
        if len(dates) >= 2:
            return TimeRange(start=f"{dates[0]} 00:00:00", end=f"{dates[1]} 23:59:59")
        return TimeRange(start=f"{dates[0]} 00:00:00", end=f"{dates[0]} 23:59:59")

    # Pure-Python relative label fallback
    tr = _resolve_relative_no_arrow(val, now)
    if tr:
        log.info("Resolved relative time '%s' via pure-Python fallback", val)
        return tr

    # Arrow library fallback
    if ARROW_AVAILABLE:
        try:
            dr = get_date_range(val)
            return TimeRange(start=dr["start"], end=dr["end"])
        except Exception:
            pass

    log.warning("Could not resolve time reference: '%s'", val)
    return None


def _get_calendar_time_range(label: str) -> TimeRange:
    """Map a calendar time label such as 'tomorrow' or 'next week' to a TimeRange.

    Labels are interpreted in the user's local timezone, then converted to UTC.
    """
    now = _now_local()
    today = _today_midnight(now)

    # Calendar queries must span the full day so that future meetings are included.
    # "today" / "this month" / "this year" must not be capped at the current time.
    if label == "today":
        return _make_local_range(today, _end_of_day(today))

    if label == "this month":
        if today.month == 12:
            last_day = today.replace(day=31)
        else:
            last_day = today.replace(month=today.month + 1, day=1) - timedelta(days=1)
        return _make_local_range(today.replace(day=1), _end_of_day(last_day))

    if label == "this year":
        return _make_local_range(
            today.replace(month=1, day=1), _end_of_day(today.replace(month=12, day=31))
        )

    tr = _resolve_relative_no_arrow(label, now)
    if tr:
        return tr

    if label == "tomorrow":
        start = today + timedelta(days=1)
        return _make_local_range(start, _end_of_day(start))

    if label == "next week":
        days_until_monday = (7 - today.weekday()) % 7 or 7
        start = today + timedelta(days=days_until_monday)
        return _make_local_range(start, _end_of_day(start + timedelta(days=6)))

    # Default: full day today
    return _make_local_range(today, _end_of_day(today))


