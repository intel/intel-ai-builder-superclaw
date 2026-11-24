"""The Connector's own web reads (#14, Connector IPC v2): `fetch_result`.

Every hop is judged by `egress_guard` and connected to the address it judged, through the host's upstream
proxy when one is set (a CONNECT to that same address, as the egress proxy does) and never directly
instead. A request names a URL and nothing else: the method, the headers and what is done with the answer
are decided here.

Standard library only: it ships in the Connector's payload.
"""

from __future__ import annotations

from collections import OrderedDict
from collections.abc import Iterable
from dataclasses import dataclass
from html.parser import HTMLParser
import http.client
import os
import re
import socket
import ssl
import threading
import time
from urllib.parse import SplitResult, quote, urljoin, urlsplit, urlunsplit

from contracts.connector_ipc_data import CONNECTOR_IPC_RULES

from . import __version__
from .egress_guard import EgressRefused, TunnelRefused, connect_vetted, is_dns_name, vet

MAX_BODY_BYTES = 2 * 1024 * 1024
MAX_URL_UNITS = 4096
# A site that refuses non-browser agents gets to refuse this one: the Connector never poses as a browser.
USER_AGENT = f"SuperClaw/{__version__} (+https://aibuilder.intel.com)"
_ALLOWED_PORTS = frozenset(CONNECTOR_IPC_RULES["fetch_allowed_ports"])
_MAX_REDIRECTS = CONNECTOR_IPC_RULES["fetch_max_redirects"]
_DEFAULT_PORTS = {"http": 80, "https": 443}
_REDIRECT_STATUSES = frozenset({301, 302, 303, 307, 308})
_SOCKET_TIMEOUT_S = 30.0
_READ_PIECE_BYTES = 16 * 1024
# What a proxy says to a CONNECT it will not make to this port: forbidden, or not allowed. A 407 wants
# credentials and a 5xx is the proxy failing, so neither says 443 would be any different.
_NO_TO_PORT_80 = frozenset({403, 405})
_PAGE_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5"
# HTTPS first, as the egress proxy reads them: one upstream carries every tunnel.
_PROXY_VARIABLES = ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy")
_HTML_TYPES = frozenset({"text/html", "application/xhtml+xml"})
_TARGET_UNSAFE = re.compile(r"[^\x21-\x7e]")
_REQUEST_URL = re.compile(r"https?://\S+")
_SESSION_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}")
_SKIPPED_ELEMENTS = frozenset({"script", "style", "noscript", "template", "svg", "canvas", "iframe", "object"})
_BLOCK_ELEMENTS = frozenset(
    {
        "address", "article", "aside", "blockquote", "br", "dd", "div", "dl", "dt", "figcaption",
        "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main",
        "nav", "ol", "p", "pre", "section", "table", "td", "th", "title", "tr", "ul",
    }
)


class FetchFailure(Exception):
    """A fetch that ended without a page; `code` is the Connector error code it is answered with."""

    def __init__(self, code: str, retryable: bool, http_status: int | None = None) -> None:
        super().__init__(code)
        self.code = code
        self.retryable = retryable
        self.http_status = http_status


class _PlainHttpTunnelRefused(Exception):
    """The upstream proxy will not tunnel to port 80; the same host may still be reachable on 443."""


@dataclass(frozen=True)
class Response:
    # The URL this hop actually fetched: the https one when the proxy refused the tunnel to 80.
    url: str
    status: int
    location: str | None
    content_type: str | None
    body: bytes
    truncated: bool


@dataclass(frozen=True)
class FetchedPage:
    url: str
    content_type: str | None
    text: str
    truncated: bool
    redirects: int


def utf16_units(value: str) -> int:
    """Length as the TypeScript side measures a string, which is what every contract bound counts."""
    return len(value.encode("utf-16-le", errors="surrogatepass")) // 2


def request_is_valid(body: dict[str, object]) -> bool:
    """A `fetch_result` body of the contract's shape: an http or https URL, and optionally `approver: "none"`
    and the chat's `root_session_id` in the envelope's session id grammar."""
    url = body.get("url")
    approver_ok = "approver" not in body or (
        isinstance(body["approver"], str) and body["approver"] == "none"
    )
    root = body.get("root_session_id")
    root_ok = "root_session_id" not in body or (isinstance(root, str) and _SESSION_ID.fullmatch(root) is not None)
    return (
        set(body) <= {"url", "approver", "root_session_id"}
        and approver_ok
        and root_ok
        and isinstance(url, str)
        and utf16_units(url) <= MAX_URL_UNITS
        and _REQUEST_URL.fullmatch(url) is not None
    )


def normalized_url(url: str) -> str | None:
    """The form a search result and a fetch request are matched in.

    Scheme and host are case-folded, a default port and the fragment dropped. Path and query are kept
    exactly: they are the server's to interpret, and two spellings of them may be two pages.
    """
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        return None
    scheme = parts.scheme.lower()
    host = parts.hostname
    if scheme not in _DEFAULT_PORTS or not host or parts.username is not None or parts.password is not None:
        return None
    authority = host if port in (None, _DEFAULT_PORTS[scheme]) else f"{host}:{port}"
    query = f"?{parts.query}" if parts.query else ""
    return f"{scheme}://{authority}{parts.path or '/'}{query}"


class SessionResults:
    """The URLs each session's searches returned: until EG1-7, the only ones `fetch_result` fetches."""

    def __init__(
        self,
        *,
        limit: int = CONNECTOR_IPC_RULES["fetch_session_results_max"],
        ttl_ms: int = CONNECTOR_IPC_RULES["fetch_session_result_ttl_ms"],
    ) -> None:
        self._limit = limit
        self._ttl_ms = ttl_ms
        self._sessions: dict[str, OrderedDict[str, int]] = {}
        self._lock = threading.Lock()

    def record(self, session_id: str, urls: Iterable[str], *, now_ms: int) -> None:
        with self._lock:
            self._expire(now_ms)
            entries = self._sessions.setdefault(session_id, OrderedDict())
            for url in urls:
                key = normalized_url(url)
                if key is None:
                    continue
                entries.pop(key, None)
                entries[key] = now_ms + self._ttl_ms
                while len(entries) > self._limit:
                    entries.popitem(last=False)

    def admits(self, session_id: str, url: str, *, now_ms: int) -> bool:
        key = normalized_url(url)
        with self._lock:
            self._expire(now_ms)
            expiry = self._sessions.get(session_id, {}).get(key) if key is not None else None
            return expiry is not None and expiry > now_ms

    def _expire(self, now_ms: int) -> None:
        for session_id in list(self._sessions):
            entries = self._sessions[session_id]
            while entries and next(iter(entries.values())) <= now_ms:
                entries.popitem(last=False)
            if not entries:
                del self._sessions[session_id]


def upstream_proxy() -> tuple[str, int] | None:
    """The host's upstream proxy as the Connector's environment carries it, or None for none.

    The egress proxy's rule: `http://host:port` and nothing else. Anything else is a configuration this
    client cannot tunnel through, and refusing is the only answer that is not a direct connection.
    """
    value = ""
    for name in _PROXY_VARIABLES:
        value = os.environ.get(name, "").strip()
        if value:
            break
    if not value:
        return None
    parts = urlsplit(value)
    try:
        port = parts.port
    except ValueError:
        port = None
    if (
        parts.scheme != "http"
        or parts.username is not None
        or parts.password is not None
        or not parts.hostname
        or port is None
        or parts.path not in ("", "/")
        or parts.query
        or parts.fragment
    ):
        raise FetchFailure("proxy_configuration_error", False)
    return parts.hostname, port


def _tls_context() -> ssl.SSLContext:
    # `SSL_CERT_FILE` is what `connector._pin_tls_roots` points at certifi: a tier logged on without a
    # profile cannot read the Windows certificate store.
    return ssl.create_default_context(cafile=os.environ.get("SSL_CERT_FILE") or None)


def _wrap_tls(connection: socket.socket, server_hostname: str) -> socket.socket:
    return _tls_context().wrap_socket(connection, server_hostname=server_hostname)


class _PinnedConnection(http.client.HTTPConnection):
    """HTTP/1.1 over the one socket this module opened to a judged address; it never opens another."""

    def __init__(self, host: str, connection: socket.socket, timeout: float) -> None:
        super().__init__(host, timeout=timeout)
        self.sock = connection

    def connect(self) -> None:
        raise ConnectionError("a pinned connection does not reconnect")


def _escaped(part: str) -> str:
    return _TARGET_UNSAFE.sub(lambda match: quote(match.group(), safe=""), part)


def _redirect_target(base: str, location: str) -> str:
    """The URL a redirect names, percent-encoded so the answered `url` still fits the contract's `\\S+`."""
    try:
        parts = urlsplit(urljoin(base, location))
    except ValueError:
        raise FetchFailure("destination_refused", False) from None
    if _TARGET_UNSAFE.search(parts.netloc):
        raise FetchFailure("destination_refused", False)
    return urlunsplit(
        (parts.scheme, parts.netloc, _escaped(parts.path), _escaped(parts.query), _escaped(parts.fragment))
    )


def _target(url: str) -> tuple[str, str, int, str]:
    """Scheme, host, port and request target of a URL this module may connect to; refused otherwise."""
    try:
        parts: SplitResult = urlsplit(url)
        port = parts.port
        target = (parts.path or "/") + (f"?{parts.query}" if parts.query else "")
        target = _escaped(target)
    except ValueError:
        raise FetchFailure("destination_refused", False) from None
    scheme = parts.scheme.lower()
    host = parts.hostname
    if (
        scheme not in _DEFAULT_PORTS
        or not host
        or parts.username is not None
        or parts.password is not None
        or utf16_units(url) > MAX_URL_UNITS
    ):
        raise FetchFailure("destination_refused", False)
    port = _DEFAULT_PORTS[scheme] if port is None else port
    if port not in _ALLOWED_PORTS:
        raise FetchFailure("destination_refused", False)
    return scheme, host, port, target


# Names that are reserved or only mean something inside a network: a single label, and these suffixes. They
# pass `is_dns_name`, so `vet` would look them up and refuse the answer; nobody is asked about them first.
_LOCAL_SUFFIXES = (
    ".localhost", ".local", ".internal", ".lan", ".localdomain", ".home.arpa", ".invalid", ".test", ".onion",
)


def refused_before_asking(url: str) -> bool:
    """Whether the URL would be refused before anything is resolved, so nobody is asked to approve it.

    Another port than 80 or 443, a scheme or host this module will not connect to, every spelling of an
    address (which `vet` refuses without a lookup), `localhost`, a single label and the local suffixes above.
    It looks at the URL only: no DNS, no socket.
    """
    try:
        _scheme, host, _port, _target_path = _target(url)
    except FetchFailure:
        return True
    name = host.lower().removesuffix(".")
    return not is_dns_name(host) or "." not in name or name.endswith(_LOCAL_SUFFIXES)


def _timeout(deadline_ms: int) -> float:
    return max(0.05, min(_SOCKET_TIMEOUT_S, (deadline_ms - time.time() * 1000) / 1000))


def _open(scheme: str, host: str, port: int, *, timeout: float, upstream: tuple[str, int] | None) -> socket.socket:
    judged = vet(host, port)
    if judged.refusal == "resolution_failed":
        raise FetchFailure("destination_unreachable", True)
    if judged.refusal is not None:
        raise FetchFailure("destination_refused", False)
    try:
        connection = connect_vetted(judged, timeout, upstream)
    except EgressRefused:
        raise FetchFailure("destination_refused", False) from None
    except TunnelRefused as refused:
        if scheme == "http" and port == 80 and upstream is not None and refused.status in _NO_TO_PORT_80:
            raise _PlainHttpTunnelRefused() from None
        raise FetchFailure("destination_unreachable", True) from None
    except OSError:
        raise FetchFailure("destination_unreachable", True) from None
    if scheme == "http":
        return connection
    try:
        return _wrap_tls(connection, host)
    except OSError:
        connection.close()
        raise FetchFailure("destination_unreachable", True) from None


def media_type(header: str | None) -> tuple[str | None, str | None]:
    """The media type, lower-cased and without parameters, and the declared charset, of a Content-Type."""
    if not header:
        return None, None
    media, _, parameters = header.partition(";")
    charset = None
    for parameter in parameters.split(";"):
        name, _, value = parameter.partition("=")
        if name.strip().lower() == "charset":
            charset = value.strip().strip("\"'").lower() or None
    return media.strip().lower() or None, charset


def _readable(media: str | None) -> bool:
    return (
        media is None
        or media.startswith("text/")
        or media in ("application/json", "application/xml")
        or media.endswith(("+json", "+xml"))
    )


def _read_body(
    answer: http.client.HTTPResponse, connection: socket.socket, *, deadline_ms: int, cancel: threading.Event
) -> bytes:
    """Up to `MAX_BODY_BYTES` + 1 bytes, read a piece at a time.

    A page that sends a byte just inside every socket timeout never trips one, so the request deadline and
    the cancel event are checked between pieces, and each read waits no longer than the deadline allows.
    """
    pieces: list[bytes] = []
    size = 0
    # The last piece of a body closes the response, and its socket with it.
    while size <= MAX_BODY_BYTES and not answer.isclosed():
        if cancel.is_set():
            raise FetchFailure("connector_cancelled", False)
        remaining = (deadline_ms - time.time() * 1000) / 1000
        if remaining <= 0:
            raise FetchFailure("connector_timeout", True)
        connection.settimeout(min(_SOCKET_TIMEOUT_S, remaining))
        try:
            piece = answer.read1(min(_READ_PIECE_BYTES, MAX_BODY_BYTES + 1 - size))
        except TimeoutError:
            if remaining < _SOCKET_TIMEOUT_S:
                # It was the deadline that ran out, not the page that went quiet.
                raise FetchFailure("connector_timeout", True) from None
            raise
        if not piece:
            break
        pieces.append(piece)
        size += len(piece)
    return b"".join(pieces)


def get(
    url: str,
    *,
    deadline_ms: int,
    cancel: threading.Event,
    upstream: tuple[str, int] | None,
    accept: str,
) -> Response:
    """One GET, one hop. The body is read, up to `MAX_BODY_BYTES`, only for a 2xx answer of a readable type.

    An http URL whose tunnel to 80 the upstream proxy refuses is asked for over https instead: the same
    host, judged again for 443, connected at a judged address and checked against its own certificate.
    An absolute-form GET would have to give up either the pin or the Host (RFC 9112 section 3.2.2).
    """
    if cancel.is_set():
        raise FetchFailure("connector_cancelled", False)
    scheme, host, port, target = _target(url)
    timeout = _timeout(deadline_ms)
    try:
        connection = _open(scheme, host, port, timeout=timeout, upstream=upstream)
    except _PlainHttpTunnelRefused:
        # `vet` passed, so `host` is a DNS name here: an address literal, whose brackets `hostname` strips,
        # was refused before any tunnel was asked for.
        parts = urlsplit(url)
        url = urlunsplit(("https", host, parts.path, parts.query, ""))
        scheme, host, port, target = _target(url)
        connection = _open(scheme, host, port, timeout=timeout, upstream=upstream)
    client = _PinnedConnection(host, connection, timeout)
    try:
        client.putrequest("GET", target, skip_host=True, skip_accept_encoding=True)
        client.putheader("Host", host if port == _DEFAULT_PORTS[scheme] else f"{host}:{port}")
        client.putheader("User-Agent", USER_AGENT)
        client.putheader("Accept", accept)
        client.putheader("Accept-Encoding", "identity")
        client.putheader("Connection", "close")
        client.endheaders()
        answer = client.getresponse()
        content_type = answer.getheader("Content-Type")
        body, truncated = b"", False
        if 200 <= answer.status < 300 and _readable(media_type(content_type)[0]):
            body = _read_body(answer, connection, deadline_ms=deadline_ms, cancel=cancel)
            truncated = len(body) > MAX_BODY_BYTES
        return Response(
            url, answer.status, answer.getheader("Location"), content_type, body[:MAX_BODY_BYTES], truncated
        )
    except (http.client.HTTPException, OSError, ValueError):
        raise FetchFailure("destination_unreachable", True) from None
    finally:
        client.close()


def fetch_page(url: str, *, deadline_ms: int, cancel: threading.Event) -> FetchedPage:
    """`fetch_result`'s fetch: at most `fetch_max_redirects` redirects, every hop judged again."""
    upstream = upstream_proxy()
    current, redirects = url, 0
    while True:
        response = get(current, deadline_ms=deadline_ms, cancel=cancel, upstream=upstream, accept=_PAGE_ACCEPT)
        current = response.url
        if response.status in _REDIRECT_STATUSES and response.location:
            if redirects == _MAX_REDIRECTS:
                raise FetchFailure("redirect_limit_exceeded", False)
            current, redirects = _redirect_target(current, response.location), redirects + 1
            continue
        if not 200 <= response.status < 300:
            retryable = response.status in (408, 429) or response.status >= 500
            raise FetchFailure("destination_http_error", retryable, response.status)
        media, charset = media_type(response.content_type)
        if not _readable(media) or (media is not None and utf16_units(media) > 255):
            raise FetchFailure("unsupported_content_type", False)
        text = _decode(response.body, charset)
        if media in _HTML_TYPES:
            text = _html_text(text)
        return FetchedPage(current, media, text, response.truncated, redirects)


def _decode(body: bytes, charset: str | None) -> str:
    try:
        return body.decode(charset or "utf-8", errors="replace")
    except LookupError:
        return body.decode("utf-8", errors="replace")


class _TextOfHtml(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._skipping = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in _SKIPPED_ELEMENTS:
            self._skipping += 1
        elif tag in _BLOCK_ELEMENTS:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in _SKIPPED_ELEMENTS:
            self._skipping = max(0, self._skipping - 1)
        elif tag in _BLOCK_ELEMENTS:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if not self._skipping:
            self.parts.append(data)


def _html_text(markup: str) -> str:
    """The text a reader sees: no script, style or other non-rendered content, one line per block."""
    parser = _TextOfHtml()
    parser.feed(markup)
    parser.close()
    lines = (" ".join(line.split()) for line in "".join(parser.parts).splitlines())
    return "\n".join(line for line in lines if line)
