"""Per-target upstream resolution for a PAC script or WPAD, the way Windows does it (design D4, EG2-2).

The Sandbox Manager reads the owner's `AutoConfigURL` / auto-detect setting and seals it for the egress
proxy; the proxy asks `PacResolver` which upstream to use for each CONNECT target. Windows evaluates the
script itself (`WinHttpGetProxyForUrl`), so no JavaScript engine ships here. The answer is a PAC proxy list
(`PROXY a:1; HTTPS b:2; DIRECT`) that `parse_proxy_list` reads and `decide_pac_route` turns into ordered
attempts. A failure to fetch or evaluate the script is a typed failure: log_only keeps the direct, audited
route it had before; enforce refuses and never falls back to direct.

Fetching the script is itself egress: the PAC host must be reachable by the network_connector tier.

Standard library only: it ships in the egress proxy's payload.
"""

from __future__ import annotations

from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor, TimeoutError as FutureTimeout
from dataclasses import dataclass
import logging
import re
import sys
import threading
import time
from urllib.parse import urlsplit

logger = logging.getLogger(__name__)

PAC_FAILURE_KINDS = ("pac_none_found", "pac_failed", "pac_timeout", "pac_unsupported_hop")
_DEFAULT_PORTS = {"http": 80, "https": 443, "socks": 1080}
_KEYWORDS = {"PROXY": "http", "HTTP": "http", "HTTPS": "https", "SOCKS": "socks", "SOCKS4": "socks",
             "SOCKS5": "socks"}
PAC_EVALUATION_TIMEOUT_S = 8.0
_POSITIVE_TTL_S = 60.0
_FAILURE_TTL_S = 10.0
# WPAD is not per host: once nothing was detected, nobody is asked again for a while.
_NONE_FOUND_TTL_S = 300.0
_MAX_CACHED_HOSTS = 512
_MAX_PROXY_LIST_CHARS = 4096


@dataclass(frozen=True)
class PacConfig:
    """What the owner's system setting says: a script URL, automatic detection, or both."""

    auto_config_url: str | None
    auto_detect: bool


@dataclass(frozen=True)
class PacHop:
    kind: str
    """`direct`, `http` (plain TCP to the proxy), `https` (TLS to the proxy) or `socks`."""
    host: str | None = None
    port: int | None = None


class PacError(Exception):
    """A failed evaluation; `kind` is one of `PAC_FAILURE_KINDS`, never a URL or a credential."""

    def __init__(self, kind: str) -> None:
        super().__init__(kind)
        self.kind = kind


@dataclass(frozen=True)
class PacAnswer:
    hops: tuple[PacHop, ...] = ()
    failure: str | None = None


@dataclass(frozen=True)
class Attempt:
    upstream: tuple[str, int] | None
    """The proxy to chain through, or None for a direct connection."""
    route: str
    reason: str


@dataclass(frozen=True)
class PacDecision:
    attempts: tuple[Attempt, ...]
    refuse: str | None = None
    """Set when the mode refuses this target: the reason, for the audit line."""
    enforce_would_refuse: str | None = None


Evaluator = Callable[[str, PacConfig], str]


def parse_proxy_list(text: str | None) -> tuple[PacHop, ...]:
    """The hops of a PAC result or of WinHTTP's proxy list, in order; entries it cannot read are dropped.

    Both spellings are accepted: `PROXY a:1; HTTPS b:2; DIRECT` and WinHTTP's `a:1;b:2` /
    `http://a:1 b:2` / `https=b:2`. A name with no port takes the protocol's default.
    """
    if not text or len(text) > _MAX_PROXY_LIST_CHARS:
        return ()
    hops: list[PacHop] = []
    for entry in text.split(";"):
        tokens = entry.split()
        if not tokens:
            continue
        if len(tokens) == 2 and tokens[0].upper() in _KEYWORDS:
            hop = _hop(_KEYWORDS[tokens[0].upper()], tokens[1])
            hops.extend([hop] if hop else [])
            continue
        for token in tokens:
            hop = _winhttp_token(token)
            hops.extend([hop] if hop else [])
    return tuple(hops)


def _winhttp_token(token: str) -> PacHop | None:
    if token.upper() == "DIRECT":
        return PacHop("direct")
    protocol, separator, server = token.partition("=")
    if separator and "://" not in protocol:
        # `https=host:port` names the proxy for one scheme; only web schemes are a CONNECT upstream.
        if protocol.lower() not in ("http", "https"):
            return PacHop("socks") if protocol.lower().startswith("socks") else None
        return _hop("http", server)
    scheme, scheme_separator, rest = token.partition("://")
    if scheme_separator:
        kind = {"http": "http", "https": "https"}.get(scheme.lower(), "socks")
        return _hop(kind, rest)
    return _hop("http", token)


def _hop(kind: str, server: str) -> PacHop | None:
    server = server.strip().rstrip("/")
    host, separator, port = server.rpartition(":")
    if separator and port.isdigit() and (":" not in host or host.endswith("]")):
        number = int(port)
    else:
        host, number = server, _DEFAULT_PORTS[kind]
    host = host.strip("[]") if host.startswith("[") else host
    if not host or not 1 <= number <= 65535:
        return None
    return PacHop(kind, host, number)


class PacResolver:
    """Resolves an upstream per target through `evaluator`, caching per host and port and bounding each evaluation."""

    def __init__(
        self,
        config: PacConfig,
        evaluator: Evaluator | None = None,
        *,
        timeout_s: float = PAC_EVALUATION_TIMEOUT_S,
        ttl_s: float = _POSITIVE_TTL_S,
        failure_ttl_s: float = _FAILURE_TTL_S,
        none_found_ttl_s: float = _NONE_FOUND_TTL_S,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._config = config
        self._evaluator = evaluator or winhttp_evaluator()
        self._timeout_s = timeout_s
        self._ttls = (ttl_s, failure_ttl_s, none_found_ttl_s)
        self._clock = clock
        self._lock = threading.Lock()
        self._cache: dict[tuple[str, int, str], tuple[float, PacAnswer]] = {}
        self._none_found_until = 0.0
        self._inflight: dict[tuple[str, int, str], Future[PacAnswer]] = {}
        # A hung evaluation holds its thread; the pool is small and a failure is cached, so it cannot grow.
        self._pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="pac")

    def resolve(self, host: str, port: int | None = None, scheme: str = "https") -> PacAnswer:
        """The answer for `host`; blocks for at most the timeout, so call it from a thread."""
        port = port if port is not None else (80 if scheme == "http" else 443)
        # The script is evaluated on the full URL, so a scheme or port the URL carries can change the answer.
        key = (host.lower(), port, scheme)
        with self._lock:
            now = self._clock()
            if now < self._none_found_until:
                return PacAnswer(failure="pac_none_found")
            cached = self._cache.get(key)
            if cached is not None and now < cached[0]:
                return cached[1]
            future = self._inflight.get(key)
            if future is None:
                future = self._pool.submit(self._evaluate, host, port, scheme)
                self._inflight[key] = future
        try:
            answer = future.result(timeout=self._timeout_s)
        except FutureTimeout:
            answer = PacAnswer(failure="pac_timeout")
        except Exception as exc:  # noqa: BLE001 - an evaluator must never take a tunnel down with it
            logger.warning(
                "pac-resolver: call=resolve event=unexpected_exception exception_type=%s",
                type(exc).__name__,
            )
            answer = PacAnswer(failure="pac_failed")
        with self._lock:
            self._inflight.pop(key, None)
            self._remember(key, answer)
        return answer

    def _evaluate(self, host: str, port: int, scheme: str) -> PacAnswer:
        try:
            authority = f"[{host}]" if ":" in host else host
            default = 80 if scheme == "http" else 443
            text = self._evaluator(
                f"{scheme}://{authority}:{port}/" if port != default else f"{scheme}://{authority}/",
                self._config,
            )
        except PacError as exc:
            return PacAnswer(failure=exc.kind)
        hops = parse_proxy_list(text)
        if not hops:
            logger.warning(
                "pac-resolver: call=evaluate event=empty_proxy_list scheme=%s port=%s", scheme, port
            )
            return PacAnswer(failure="pac_failed")
        return PacAnswer(hops)

    def _remember(self, key: tuple[str, int, str], answer: PacAnswer) -> None:
        ttl, failure_ttl, none_found_ttl = self._ttls
        now = self._clock()
        if answer.failure == "pac_none_found":
            self._none_found_until = now + none_found_ttl
            return
        if len(self._cache) >= _MAX_CACHED_HOSTS:
            self._cache.clear()
        self._cache[key] = (now + (failure_ttl if answer.failure else ttl), answer)

    def close(self) -> None:
        self._pool.shutdown(wait=False, cancel_futures=True)


def decide_pac_route(
    mode: str, answer: PacAnswer, static_upstream: tuple[str, int] | None
) -> PacDecision:
    """Turn a PAC answer into ordered attempts; the one place log_only and enforce differ.

    A proxy the PAC names is chained through and DIRECT is direct, in the order the script gave. Failing
    to evaluate it falls back to the manual proxy Windows keeps beside a script when there is one;
    otherwise log_only goes direct (audited, as before this existed) and enforce refuses. No PAC found by
    automatic detection alone is the answer "no proxy", as it is for Windows, in both modes.
    """
    failure = answer.failure
    if failure is None:
        attempts: list[Attempt] = []
        for hop in answer.hops:
            if hop.kind == "direct":
                attempts.append(Attempt(None, "direct_pac", "pac_direct"))
            elif hop.kind == "http" and hop.host and hop.port:
                attempts.append(Attempt((hop.host, hop.port), "upstream_pac", "pac_proxy"))
            # `https` (TLS to the proxy) and `socks` hops cannot be chained through; the next one is tried.
        if attempts:
            return PacDecision(tuple(attempts))
        failure = "pac_unsupported_hop"
    if static_upstream is not None:
        return PacDecision((Attempt(static_upstream, "upstream_pac", failure),))
    if failure == "pac_none_found":
        return PacDecision((Attempt(None, "direct_pac", failure),))
    if mode == "enforce":
        return PacDecision((), refuse=failure, enforce_would_refuse=failure)
    return PacDecision(
        (Attempt(None, "direct_unsupported_upstream", failure),), enforce_would_refuse=failure
    )


def winhttp_evaluator() -> Evaluator:
    """An evaluator that asks Windows (`pac_winhttp`); on any other platform it always fails."""
    if sys.platform != "win32":

        def unavailable(url: str, config: PacConfig) -> str:
            raise PacError("pac_failed")

        return unavailable
    from .pac_winhttp import WinHttpEvaluator  # noqa: PLC0415

    return WinHttpEvaluator().proxy_for_url


@dataclass(frozen=True)
class PacEndpoints:
    """What a WFP plan can allow narrowly for a PAC setup (D4): the script's own host and every static proxy."""

    pac_host: tuple[str, int] | None
    proxies: tuple[tuple[str, int], ...]
    incomplete: bool
    """True when the script builds a proxy name at run time, so the list may not be everything it can name."""


_STRING_LITERAL = re.compile(r"\"((?:[^\"\\\n]|\\.)*)\"|'((?:[^'\\\n]|\\.)*)'")
_PROXY_LITERAL = re.compile(r"\s*(?:PROXY|HTTPS?|SOCKS[45]?)\s|\s*DIRECT\s*(?:;|$)", re.IGNORECASE)
_BARE_KEYWORD = re.compile(r"\s*(?:PROXY|HTTPS?|SOCKS[45]?)\s*", re.IGNORECASE)


def extract_pac_endpoints(auto_config_url: str | None, script: str | None) -> PacEndpoints:
    """The PAC host:port and the static `PROXY`/`HTTPS` host:port candidates in the script text.

    Read at provision from the script's string literals. Only plain-TCP and TLS proxies are listed;
    SOCKS and DIRECT are not a destination this proxy chains to. Order is first appearance.
    """
    pac_host: tuple[str, int] | None = None
    if auto_config_url:
        try:
            parts = urlsplit(auto_config_url)
            if parts.hostname and parts.scheme in ("http", "https"):
                pac_host = (parts.hostname, parts.port or (443 if parts.scheme == "https" else 80))
        except ValueError:
            pac_host = None
    found: dict[tuple[str, int], None] = {}
    incomplete = False
    for match in _STRING_LITERAL.finditer(script or ""):
        literal = match.group(1) if match.group(1) is not None else match.group(2)
        if not _PROXY_LITERAL.match(literal):
            continue
        if _BARE_KEYWORD.fullmatch(literal):
            incomplete = True
            continue
        for hop in parse_proxy_list(literal):
            if hop.kind in ("http", "https") and hop.host and hop.port:
                found[(hop.host, hop.port)] = None
    return PacEndpoints(pac_host, tuple(found), incomplete)
