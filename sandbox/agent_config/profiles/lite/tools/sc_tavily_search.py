"""SuperClaw default web search backend.

This module is intentionally independent so the default websearch agent does
not depend on local file-reader tools.
"""

import json
import os
import re
import sys
from datetime import date
from urllib.parse import urlsplit


_SCORE_THRESHOLD = 0.5
_TOP_K = 8
_DDG_MAX_RESULTS = 10
_DDG_PER_HOST_CAP = 2
_DDG_CATEGORIES = ("text", "news")
_RAW_USE_IF_WORDS_BELOW = 500
_TIME_KEYWORDS = (
    "latest",
    "recent",
    "new",
    "announced",
    "current",
    "today",
    "update",
    "this week",
    "this month",
    "this year",
)
# Deliberately narrower than _TIME_KEYWORDS, and word-boundary matched: rewriting
# a year in the caller's query is destructive, so only unambiguous recency markers
# qualify. "new"/"update"/"announced" are excluded because they also read as
# historical ("what was new in 2019", "security updates in 2023"), and substring
# matching would fire on "news in 2024", "renewable ... 2023", "currency ... 2015".
_RECENCY_MARKER_RE = re.compile(
    r"\b(?:latest|recently|recent|today|currently|current|right now|this (?:week|month|year))\b"
)
_YEAR_IN_QUERY_RE = re.compile(r"\b(20\d{2})\b")
# The UI detects web-search tool output with a startsWith on this exact prefix
# (`isWebSearchToolOutput` in apps/ui/src/app/utils/index.ts) to drive exploration
# grouping and result favicons. Nothing may be emitted ahead of it.
_RESULTS_HEADER_PREFIX = "Web search results for query:"

_BOILERPLATE_MARKERS = (
    "sign in",
    "log in",
    "subscribe to our newsletter",
    "cookie policy",
    "we use cookies",
    "accept cookies",
    "privacy policy",
    "terms of service",
    "all rights reserved",
    "follow us on",
    "skip to main content",
    "back to top",
    "share on facebook",
    "share on twitter",
    "share on linkedin",
)
# A navigation line: three or more short segments split by `|`, `>` or `*`
# ("Home | Products | Support", "Docs > API > Search"). Checked by splitting, not by
# one regex: the previous single pattern nested quantifiers over overlapping classes
# and treated `.` as a separator, so a financial-statement leader line
# ("Total inventories . . . . . $ 2,091") backtracked exponentially - about a minute
# per line at 18 dots - and pinned a Connector search worker past its deadline.
# Dotted leaders are data, not navigation, so `.` no longer separates.
_NAV_SEPARATOR_RE = re.compile(r"[|*>]+")
_NAV_SEGMENT_RE = re.compile(r"[\w\s\-&'.,]+")
_RUNTIME_CONFIG: dict | None = None


def configure_runtime_config(value: dict) -> None:
    global _RUNTIME_CONFIG
    _RUNTIME_CONFIG = value


def _read_tavily_key_from_runtime_config() -> str | None:
    if _RUNTIME_CONFIG is not None:
        key = ((_RUNTIME_CONFIG.get("search") or {}).get("tavilyApiKey") or "").strip()
        return key or None
    explicit_file = os.getenv("SC_RUNTIME_CONFIG_FILE")
    config_dir = (
        os.getenv("SC_RUNTIME_CONFIG_DIR")
        or os.getenv("OPENCODE_CONFIG_DIR")
        or "/config/opencode"
    )
    path = explicit_file or os.path.join(config_dir, "superclaw-runtime-config.json")
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return None
    key = ((data.get("search") or {}).get("tavilyApiKey") or "").strip()
    return key or None


def _host_of(url: str) -> str:
    try:
        return urlsplit(url).netloc.lower()
    except Exception:
        return ""


def _is_nav_line(text: str) -> bool:
    """Whether a stripped line is a breadcrumb or menu bar; linear in the line length."""
    segments = [segment.strip() for segment in _NAV_SEPARATOR_RE.split(text)]
    return len(segments) >= 3 and all(
        segment and _NAV_SEGMENT_RE.fullmatch(segment) for segment in segments
    )


def _strip_boilerplate(raw: str) -> str:
    if not raw:
        return ""
    out: list[str] = []
    for line in raw.splitlines():
        text = line.strip()
        if not text:
            out.append("")
            continue
        lower = text.lower()
        if len(text) < 80 and any(marker in lower for marker in _BOILERPLATE_MARKERS):
            continue
        if _is_nav_line(text):
            continue
        out.append(line)
    return re.sub(r"\n{3,}", "\n\n", "\n".join(out)).strip()


def _select_content(raw: str, snippet: str) -> tuple[str, str]:
    cleaned = _strip_boilerplate(raw)
    word_count = len(cleaned.split()) if cleaned else 0
    if cleaned and word_count < _RAW_USE_IF_WORDS_BELOW:
        return cleaned, f"raw_content (cleaned, {word_count} words)"
    if snippet:
        suffix = (
            f" [TRUNCATED: full page had {word_count} words, too long; snippet only — "
            f"the source contains more detail than shown]"
            if cleaned
            else ""
        )
        return snippet, f"snippet (Tavily content){suffix}"
    if cleaned:
        return (
            cleaned,
            f"raw_content (cleaned, {word_count} words, no snippet available)",
        )
    return "", "(no content available)"


def _is_time_sensitive(query: str) -> bool:
    q = query.lower()
    if _YEAR_IN_QUERY_RE.search(q):
        return True
    return any(keyword in q for keyword in _TIME_KEYWORDS)


def _has_recency_intent(query: str) -> bool:
    """True when the query asks for fresh/current information, not a named past year."""
    return _RECENCY_MARKER_RE.search(query.lower()) is not None


def _normalize_stale_years_in_recency_query(query: str) -> tuple[str, bool]:
    """Bump past calendar years on recency queries (common local-model mistake).

    Example: "AI news this week 2025" in 2026 becomes "... this week 2026".
    Skips queries without an explicit recency marker, so a historical lookup that
    names its own year ("AI news in 2024") is passed through untouched.
    """
    if not _has_recency_intent(query):
        return query, False
    current_year = date.today().year
    changed = False

    def repl(match: re.Match[str]) -> str:
        nonlocal changed
        year = int(match.group(1))
        if year < current_year:
            changed = True
            return str(current_year)
        return match.group(1)

    return _YEAR_IN_QUERY_RE.sub(repl, query), changed


def _search_result_preamble(
    *,
    as_of: str,
    query: str,
    original_query: str,
    normalized: bool,
) -> str:
    lines = [f"SEARCH_AS_OF: {as_of}"]
    if normalized and query != original_query:
        lines.append(
            f"QUERY_NORMALIZED: {original_query!r} -> {query!r} "
            "(past calendar year on a recency query was replaced with SEARCH_AS_OF year)"
        )
    return "\n".join(lines) + "\n"


def _with_preamble(result: str, preamble: str) -> str:
    """Attach the preamble without displacing the results header.

    Result blocks must keep `_RESULTS_HEADER_PREFIX` on line 1 for the UI, so the
    preamble goes on line 2 there. Status lines (NO_RESULTS / SEARCH_BLOCKED /
    SEARCH_UNAVAILABLE) have no header, so it simply goes first.
    """
    if not result.startswith(_RESULTS_HEADER_PREFIX):
        return preamble + result
    header, newline, rest = result.partition("\n")
    return f"{header}{newline}{preamble}{rest}"


def _get_proxy_settings() -> dict:
    http = (
        os.getenv("http_proxy")
        or os.getenv("HTTP_PROXY")
        or os.getenv("all_proxy")
        or os.getenv("ALL_PROXY")
    )
    https = (
        os.getenv("https_proxy")
        or os.getenv("HTTPS_PROXY")
        or os.getenv("all_proxy")
        or os.getenv("ALL_PROXY")
    )
    settings: dict = {}
    if http:
        settings["http"] = http
    if https:
        settings["https"] = https
    return settings


def _diag(provider: str, outcome: str, **fields: object) -> None:
    """Record one provider attempt on stderr.

    stderr, never stdout: on the non-Connector path this module runs as a
    ``python -c`` child whose stdout *is* the tool result, and the caller only
    reads stderr when the call fails. Carries no query text, no URLs and no
    exception message - a provider exception can quote a request URL that embeds
    the API key.
    """
    parts = " ".join(f"{key}={value}" for key, value in fields.items())
    print(
        f"websearch event=provider_attempt provider={provider} outcome={outcome} {parts}".rstrip(),
        file=sys.stderr,
        flush=True,
    )


def _ddg_client_kwargs() -> dict:
    """Build the DuckDuckGo client's transport settings explicitly.

    `ddgs` only reads its own ``DDGS_PROXY`` variable, so the standard proxy
    variables reach it today only through its Rust HTTP client's environment
    fallback. Passing ``proxy`` directly removes that dependency.

    ``verify`` forwards ``SSL_CERT_FILE`` when the host set one, because this
    client reads the platform certificate store directly and ignores that
    variable. It is deliberately NOT defaulted to certifi: the platform store is
    the only place a corporate TLS-interception root lives, so replacing it would
    break exactly the proxied hosts this transport work exists for. The Connector
    sets ``SSL_CERT_FILE`` itself, for a tier account whose store is unreadable.
    """
    kwargs: dict = {}
    proxy_settings = _get_proxy_settings()
    proxy = proxy_settings.get("https") or proxy_settings.get("http")
    if proxy:
        kwargs["proxy"] = proxy
    cert_file = os.getenv("SSL_CERT_FILE")
    if cert_file:
        kwargs["verify"] = cert_file
    return kwargs


def _force_os_dns_resolver_on_primp() -> None:
    """Make every ``primp.Client`` in this process resolve host names via the OS.

    primp's built-in resolver sends each DNS query from a UDP socket of its own,
    bound to 0.0.0.0. On Windows, a non-loopback bind by an executable that no
    firewall rule covers raises a Windows Defender Firewall prompt naming that
    executable. Only an explicit ``dns_resolver="system"`` makes primp call
    getaddrinfo, which the OS answers without this process binding a socket:
    primp's documentation calls the default, ``None``, the system resolver as
    well, but ``None`` keeps the built-in one. ``ddgs`` exposes no resolver
    option, so the setting is made where primp reads it, and forced rather than
    defaulted so that no caller can bring the binds back. ``primp.AsyncClient``
    is left alone: ddgs builds one only for its DHT network, which needs an
    ``api_url`` this module never passes.
    """
    try:
        import primp  # noqa: PLC0415
    except ImportError:
        # A ddgs that does not build on primp has no primp client to configure.
        return
    if getattr(primp.Client, "_resolves_through_the_os", False):
        return
    # primp before 1.3.0 has no dns_resolver and would reject it in every client.
    if "dns_resolver" not in (getattr(primp.Client, "__text_signature__", None) or ""):
        return

    class _OsResolvedClient(primp.Client):
        _resolves_through_the_os = True

        def __new__(cls, *args: object, **kwargs: object) -> "_OsResolvedClient":
            kwargs["dns_resolver"] = "system"
            return super().__new__(cls, *args, **kwargs)

    primp.Client = _OsResolvedClient


def _safe_detail(detail: str, *secrets: str) -> str:
    """Provider failure text reaches the model and the UI, so it may carry neither
    a secret nor an unbounded response body.

    A proxy URL is a secret here as much as the API key is: it may embed
    ``user:password@``, and a client that failed to reach its proxy tends to quote
    the URL it tried. Redaction runs before truncation so no partial secret can
    survive the bound.
    """
    redacted = detail
    for secret in secrets:
        if secret:
            redacted = redacted.replace(secret, "<redacted>")
    return redacted[:200] if len(redacted) <= 200 else redacted[:200] + "..."


def _tavily_search(query: str, api_key: str) -> tuple[dict | None, str | None]:
    """Returns (results, why_not). Every no-result path reports a distinct reason so
    the caller can say which one happened instead of guessing "not configured"."""
    try:
        from tavily import TavilyClient  # noqa: PLC0415
    except ImportError:
        return None, (
            "the Python package tavily-python is not installed in the interpreter that "
            "runs sc_search_web (on the Windows native backend, run "
            "scripts/native-backend/build-native-backend.ps1 and restart the backend, or "
            "point OPENCODE_PYTHON at a venv that has it)"
        )

    # Resolved before the try so the handler below can always redact it.
    proxy_settings = _get_proxy_settings()
    try:
        # egress-surface: sc_search_web_tavily_direct
        client = TavilyClient(api_key=api_key)
        if proxy_settings and hasattr(client, "session"):
            client.session.trust_env = True
            client.session.proxies.update(proxy_settings)
        results = client.search(
            query=query,
            max_results=_TOP_K,
            include_answer=False,
            include_raw_content=True,
        )
    except Exception as exc:
        _diag("tavily", "error", exception_type=type(exc).__name__)
        # The proxy is a secret too: a client that could not reach it tends to
        # quote the URL it tried, and that URL may embed `user:password@`.
        detail = _safe_detail(
            f"{type(exc).__name__}: {exc}", api_key, *proxy_settings.values()
        )
        return None, f"the Tavily request failed ({detail})"

    if isinstance(results, dict) and results.get("error"):
        return None, (
            "Tavily returned an error "
            f"({_safe_detail(str(results['error']), api_key, *proxy_settings.values())})"
        )

    rows = (results or {}).get("results") or []
    passing = [row for row in rows if (row.get("score") or 0) >= _SCORE_THRESHOLD]
    # Best-available fallback: when nothing clears the threshold but Tavily did
    # return rows, keep the top results by score instead of returning nothing.
    filtered = passing if passing else list(rows)
    filtered.sort(key=lambda row: -(row.get("score") or 0))

    seen_urls: set[str] = set()
    host_counts: dict[str, int] = {}
    top: list[dict] = []
    for row in filtered:
        url = (row.get("url") or "").strip()
        if not url or url in seen_urls:
            continue
        host = _host_of(url)
        if host and host_counts.get(host, 0) >= _DDG_PER_HOST_CAP:
            continue
        seen_urls.add(url)
        host_counts[host] = host_counts.get(host, 0) + 1
        top.append(row)
        if len(top) >= _TOP_K:
            break

    if not top:
        _diag("tavily", "empty", rows=len(rows))
        return None, "Tavily returned no usable results"
    _diag("tavily", "ok", rows=len(top))

    structured_results: list[dict] = []
    for row in top:
        body, source_type = _select_content(
            row.get("raw_content") or "",
            (row.get("content") or "").strip(),
        )
        structured_results.append(
            {
                "url": (row.get("url") or "").strip(),
                "title": (row.get("title") or "").strip() or "(no title)",
                "content": body,
                "score": row.get("score") or 0.0,
                "source_type": source_type,
            }
        )
    return {
        "status": "ok",
        "provider": "tavily",
        "query": query,
        "results": structured_results,
    }, None


def _looks_blocked(exc: Exception) -> bool:
    """True when a DDG exception looks like rate-limiting / CAPTCHA / challenge.

    Distinguishes a *blocked* provider (results exist but we were denied) from a
    genuine empty result set, so the caller can emit SEARCH_BLOCKED instead of
    NO_RESULTS. Phrase markers use substring match; HTTP status codes use a
    word-boundary regex so a bare "202"/"403"/"429" does NOT match unrelated
    digits (years like 2026, line numbers, ids, byte counts).
    """
    text = f"{type(exc).__name__} {exc}".lower()
    phrase_markers = (
        "ratelimit",
        "rate limit",
        "rate-limit",
        "captcha",
        "challenge",
        "blocked",
        "forbidden",
        "too many requests",
        "unusual traffic",
    )
    if any(marker in text for marker in phrase_markers):
        return True
    # HTTP status codes that indicate a denied/challenged request. Require an
    # HTTP-ish context word next to the code so a bare "202" in "line 202" /
    # "col 202" / "2026" does not false-positive. Matches e.g. "http 429",
    # "status 403", "error 202", "429 too many", "403 forbidden".
    return re.search(
        r"(?:\b(?:http|https|status|statuscode|status_code|code|error|err|response|resp|got|returned|http/\d\.\d)\b[^\d]{0,6}(?:202|403|429)\b"
        r"|\b(?:202|403|429)\b[^\d]{0,12}(?:forbidden|too\s*many|rate|blocked|challenge|captcha|unauthorized))",
        text,
    ) is not None


def _ddg_search(query: str, category: str | None = None) -> dict:
    try:
        from ddgs import DDGS  # noqa: PLC0415
    except ImportError:
        # Says nothing about Tavily: only search_web_structured knows that state,
        # and it replaces this message before the model ever sees it.
        return {
            "status": "unavailable",
            "provider": None,
            "query": query,
            "results": [],
            "message": (
                f"SEARCH_UNAVAILABLE: no web search backend produced results for query {query!r}. "
                "The DuckDuckGo fallback library is not installed. "
                "Do NOT fabricate results — tell the user web search is unavailable."
            ),
        }
    _force_os_dns_resolver_on_primp()

    if category in _DDG_CATEGORIES:
        # Caller-chosen vertical: no keyword guessing, and text gets no recency filter.
        # Keep news to one week for freshness; empty news falls back to unfiltered text for older events.
        use_news = category == "news"
        timelimit = None
        news_timelimit = "w"
    else:
        use_news = _is_time_sensitive(query)
        timelimit = "y" if use_news else None
        news_timelimit = timelimit
    # Track whether any attempt was denied (rate-limited / CAPTCHA / challenge)
    # so an empty result set can be reported as BLOCKED rather than NO_RESULTS.
    blocked = {"hit": False}
    # Track attempts that failed for any other reason. NO_RESULTS asserts to the
    # model that the web really was searched, so it must be unreachable whenever a
    # call did not come back: a timeout, a DNS or TLS error, or a missing proxy
    # produces zero rows without searching anything, and reporting that as a
    # genuine empty result is how the model ends up telling the user "nothing was
    # found" about a query the network never saw.
    failures: list[str] = []
    # Track whether any attempt DID come back, which is what makes an empty result
    # genuine. Two attempts run (news then text) and a failure in one says nothing
    # about the other: DDG's news engine failing while text answers is an ordinary
    # outcome. Without this, "news raised, text returned nothing" would report
    # SEARCH_FAILED -- claiming the network was never reached when it was, which is
    # the same lie as NO_RESULTS-on-timeout pointing the other way. Whatever a
    # provider actually says wins over what a sibling attempt failed to say.
    reached = {"hit": False}

    client_kwargs = _ddg_client_kwargs()

    def _run(kind: str) -> list[dict]:
        try:
            # egress-surface: sc_search_web_ddgs_direct
            ddgs = DDGS(timeout=15, **client_kwargs)
            if kind == "news":
                raw = ddgs.news(
                    query=query,
                    region="wt-wt",
                    safesearch="moderate",
                    max_results=_DDG_MAX_RESULTS,
                    timelimit=news_timelimit,
                )
                # The provider answered. Set before the rows are mapped, not after:
                # `ddgs` returns a materialised list, so the response is already in
                # hand by this line, and a failure while mapping it is a malformed
                # payload rather than a network that was never reached. Below that
                # distinction is the difference between NO_RESULTS and SEARCH_FAILED,
                # and SEARCH_FAILED tells the model nothing was searched.
                reached["hit"] = True
                mapped = [
                    {
                        "title": row.get("title", ""),
                        "url": row.get("url", ""),
                        "snippet": row.get("body", ""),
                    }
                    for row in raw
                ]
                _diag("ddgs-news", "ok" if mapped else "empty", rows=len(mapped))
                return mapped

            kwargs: dict = dict(
                query=query,
                region="wt-wt",
                safesearch="moderate",
                max_results=_DDG_MAX_RESULTS,
            )
            if timelimit:
                kwargs["timelimit"] = timelimit
            raw = ddgs.text(**kwargs)
            # Answered; see the news branch for why this precedes the mapping.
            reached["hit"] = True
            mapped = [
                {
                    "title": row.get("title", ""),
                    "url": row.get("href", ""),
                    "snippet": row.get("body", ""),
                }
                for row in raw
            ]
            _diag("ddgs-text", "ok" if mapped else "empty", rows=len(mapped))
            return mapped
        except Exception as exc:  # noqa: BLE001
            _diag(f"ddgs-{kind}", "error", exception_type=type(exc).__name__)
            if _looks_blocked(exc):
                blocked["hit"] = True
            else:
                detail = _safe_detail(
                    f"{type(exc).__name__}: {exc}", client_kwargs.get("proxy", "")
                )
                # Both attempts usually fail the same way when egress is the cause;
                # repeating one sentence twice only spends the model's attention.
                if detail not in failures:
                    failures.append(detail)
            return []

    rows: list[dict] = _run("news") if use_news else []
    if not rows:
        rows = _run("text")
    if not rows:
        # An attempt that came back empty settles the question: the web was
        # searched. Only when nothing came back at all may this report a denial or
        # a transport failure.
        if blocked["hit"] and not reached["hit"]:
            return {
                "status": "blocked",
                "provider": None,
                "query": query,
                "results": [],
                "message": (
                    f"SEARCH_BLOCKED: the search provider rate-limited or blocked this request "
                    f"(CAPTCHA / challenge) for query {query!r}. Results are unavailable this attempt — "
                    "this is NOT the same as 'no results exist'. Do NOT fabricate an answer; retry later "
                    "or tell the user the search was blocked."
                ),
            }
        if failures and not reached["hit"]:
            return {
                "status": "failed",
                "provider": None,
                "query": query,
                "results": [],
                "message": (
                    f"SEARCH_FAILED: the web search could not be completed for query {query!r} — the "
                    f"search provider could not be reached ({'; '.join(failures)}). Nothing was "
                    "searched, so this is NOT an empty result and it says nothing about whether the "
                    "information exists. Do NOT fabricate an answer and do NOT tell the user that "
                    "nothing was found; tell them the web search failed to reach the network."
                ),
            }
        return {
            "status": "no_results",
            "provider": "ddgs",
            "query": query,
            "results": [],
            "message": (
                f"NO_RESULTS: the web was searched successfully but returned no relevant pages for "
                f"query {query!r}. This is a genuine empty result (not a failure). Do NOT fabricate — "
                "report that nothing was found, or try a narrower/different query."
            ),
        }

    seen_urls: set[str] = set()
    host_counts: dict[str, int] = {}
    top: list[dict] = []
    for row in rows:
        url = (row.get("url") or "").strip()
        if not url or url in seen_urls:
            continue
        host = _host_of(url)
        if host and host_counts.get(host, 0) >= _DDG_PER_HOST_CAP:
            continue
        seen_urls.add(url)
        host_counts[host] = host_counts.get(host, 0) + 1
        top.append(row)
        if len(top) >= _TOP_K:
            break

    if not top:
        return {
            "status": "no_results",
            "provider": "ddgs",
            "query": query,
            "results": [],
            "message": (
                f"NO_RESULTS: the web was searched successfully but returned no usable pages for "
                f"query {query!r}. This is a genuine empty result (not a failure). Do NOT fabricate — "
                "report that nothing was found, or try a narrower/different query."
            ),
        }

    results = [
        {
            "url": row.get("url", ""),
            "title": row.get("title", "") or "(no title)",
            "content": row.get("snippet", ""),
        }
        for row in top
    ]
    return {
        "status": "ok",
        "provider": "ddgs",
        "query": query,
        "results": results,
    }


def search_web_structured(query: str, category: str | None = None) -> dict:
    # `category` ("text"/"news") routes only the DuckDuckGo fallback; Tavily ignores it.
    original_query = (query or "").strip()
    if not original_query:
        return {
            "status": "invalid_request",
            "provider": None,
            "query": "",
            "results": [],
            "message": "ERROR: search_web called with empty query",
        }
    query = original_query
    if len(query) > 400:
        query = query[:397] + "..."

    query, year_normalized = _normalize_stale_years_in_recency_query(query)
    as_of = date.today().isoformat()
    api_key = _read_tavily_key_from_runtime_config()
    tavily_failure: str | None = None
    if api_key:
        result, tavily_failure = _tavily_search(query, api_key)
        if result is not None:
            result.update(
                as_of=as_of,
                original_query=original_query,
                query_normalized=year_normalized,
            )
            return result

    ddg_result = _ddg_search(query, category)
    if ddg_result["status"] == "unavailable":
        tavily_state = (
            f"A Tavily API key is saved in SuperClaw runtime settings, but {tavily_failure}"
            if api_key
            else "No Tavily API key is saved in SuperClaw runtime settings"
        )
        ddg_result["message"] = (
            f"SEARCH_UNAVAILABLE: no web search backend produced results for query {query!r}. "
            f"{tavily_state}. The DuckDuckGo fallback library is not installed either. "
            "Do NOT fabricate results — tell the user web search is unavailable.\n"
        )
    elif api_key and tavily_failure and ddg_result["status"] != "ok":
        # Every non-ok outcome used to hide this: a saved key that stopped working
        # looked exactly like "the user never configured Tavily", so nobody could
        # tell a degraded install from a quiet one.
        ddg_result["message"] = (
            ddg_result["message"].rstrip() + f"\nTAVILY_FALLBACK_REASON: {tavily_failure}"
        )
    ddg_result.update(
        as_of=as_of,
        original_query=original_query,
        query_normalized=year_normalized,
    )
    return ddg_result


def format_search_result(result: dict) -> str:
    if result["status"] == "invalid_request":
        return result["message"]

    preamble = _search_result_preamble(
        as_of=result["as_of"],
        query=result["query"],
        original_query=result["original_query"],
        normalized=result["query_normalized"],
    )
    if result["status"] != "ok":
        return _with_preamble(result["message"], preamble)

    provider_label = "Tavily" if result["provider"] == "tavily" else "DuckDuckGo"
    blocks: list[str] = [
        f"{_RESULTS_HEADER_PREFIX} {result['query']!r} [via {provider_label}]\n"
    ]
    for index, row in enumerate(result["results"], 1):
        block = (
            f"=== RESULT {index} ===\n"
            f"URL: {row['url']}\n"
            f"TITLE: {row['title']}\n"
        )
        if result["provider"] == "tavily":
            block += (
                f"SCORE: {row['score']:.2f}\n"
                f"SOURCE_TYPE: {row['source_type']}\n"
            )
        blocks.append(block + f"CONTENT:\n{row['content']}\n")
    return _with_preamble("\n".join(blocks), preamble)


def search_web(query: str, category: str | None = None) -> str:
    return format_search_result(search_web_structured(query, category))
