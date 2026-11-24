"""Upstream retry / backoff on transient errors.

Ported verbatim from ``D:/routing_service/sidecar.py`` (``RetryPolicy``,
``parse_retry_after``, ``resolve_max_upstream_retries``, ``RETRYABLE_STATUS``).
Pure + side-effect-free (no sleeping) so it unit-tests deterministically with an
explicit attempt index + injected jitter; the caller wraps it with the actual
``asyncio.sleep``. See plan §4 (RetryPolicy).

Retry ONLY transient upstream statuses (429 rate-limit, 503/529 overload); never
deterministic 4xx like the ContextOverflowError 400 (retrying the identical
payload 400s forever). Keep ``max_retries`` LOW (default 2): opencode's own SDK
also retries 429/529, so unbounded sidecar retries multiply into a storm.
"""
from __future__ import annotations

from typing import Optional

from loguru import logger

# Transient, retryable upstream statuses.
RETRYABLE_STATUS = frozenset({429, 503, 529})

# Absolute ceiling on a single backoff sleep, and on cumulative backoff for one
# request. The cumulative cap protects a per-task deadline: a retry loop must
# never sleep a task into timeout.
_BACKOFF_MAX_SLEEP_S = 30.0
_BACKOFF_MAX_TOTAL_S = 60.0


def parse_retry_after(value: Optional[str], now_epoch: Optional[float] = None) -> Optional[float]:
    """Parse an HTTP ``Retry-After`` header into a delay in seconds.

    Two legal forms per RFC 9110:
      * delta-seconds: ``"5"`` → 5.0
      * HTTP-date:     ``"Wed, 21 Oct 2026 07:28:00 GMT"`` → seconds until then
    Returns None when absent/unparseable (caller falls back to exponential
    backoff). Negative results clamp to 0.
    """
    if not value:
        return None
    value = value.strip()
    try:
        return max(0.0, float(value))
    except ValueError:
        pass
    try:
        import time as _time
        from email.utils import parsedate_to_datetime

        dt = parsedate_to_datetime(value)
        if dt is None:
            return None
        target = dt.timestamp()
        base = now_epoch if now_epoch is not None else _time.time()
        return max(0.0, target - base)
    except (TypeError, ValueError, OverflowError):
        return None


class RetryPolicy:
    """Decides whether/how long to back off for a retryable upstream status.

    Pure and side-effect-free (no sleeping) so it can be unit-tested with an
    explicit ``attempt`` index and injected jitter.
    """

    def __init__(
        self,
        max_retries: int,
        base_delay_s: float = 1.0,
        max_sleep_s: float = _BACKOFF_MAX_SLEEP_S,
        max_total_s: float = _BACKOFF_MAX_TOTAL_S,
    ) -> None:
        self.max_retries = max(0, int(max_retries))
        self.base_delay_s = float(base_delay_s)
        self.max_sleep_s = float(max_sleep_s)
        self.max_total_s = float(max_total_s)

    @property
    def enabled(self) -> bool:
        return self.max_retries > 0

    @staticmethod
    def is_retryable(status: int) -> bool:
        return status in RETRYABLE_STATUS

    def delay_for(
        self,
        attempt: int,
        *,
        retry_after: Optional[float] = None,
        jitter_frac: float = 0.0,
        elapsed_total: float = 0.0,
    ) -> Optional[float]:
        """Seconds to sleep before retry ``attempt`` (0-based: attempt 0 is the
        delay before the FIRST retry), or None to NOT retry (budget exhausted or
        cumulative cap reached).

        * ``retry_after``: when present, wins over exponential backoff (still
          clamped to ``max_sleep_s``).
        * ``jitter_frac``: fraction in [0,1) of extra delay; caller supplies the
          random value so tests are deterministic.
        * ``elapsed_total``: seconds already spent backing off; once it reaches
          ``max_total_s`` we stop retrying.
        """
        if attempt >= self.max_retries:
            return None
        if elapsed_total >= self.max_total_s:
            return None
        if retry_after is not None:
            delay = retry_after
        else:
            delay = self.base_delay_s * (2 ** attempt)
        delay += delay * max(0.0, jitter_frac)
        delay = min(delay, self.max_sleep_s)
        remaining = self.max_total_s - elapsed_total
        if remaining <= 0:
            return None
        return min(delay, remaining)


def resolve_max_upstream_retries(
    arg_value: Optional[int],
    env_value: Optional[str],
    default: int = 2,
) -> int:
    """Precedence: arg → ``LATENTFACTOR_MAX_UPSTREAM_RETRIES`` env → default.
    Invalid env warns + falls back. ``<= 0`` disables retry (transient errors
    bubble straight back to opencode)."""
    if arg_value is not None:
        return max(0, int(arg_value))
    if env_value:
        try:
            return max(0, int(env_value))
        except ValueError:
            logger.warning(
                "invalid LATENTFACTOR_MAX_UPSTREAM_RETRIES={!r}, "
                "falling back to default ({})", env_value, default,
            )
    return default
