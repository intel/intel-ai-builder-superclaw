"""Plain-HTTP request handling for the egress proxy (design 6.4, EG2-4a): parse, sanitise, stream.

An absolute-form request (`GET http://host[:port]/path HTTP/1.1`) is read here into an `HttpRequest` and
re-emitted canonically, never relayed byte for byte. The proxy decides the framing, so what it forwards
cannot be read differently by the origin than it was read here (request smuggling):

- a request with both `Content-Length` and `Transfer-Encoding`, a repeated or non-numeric
  `Content-Length`, or any `Transfer-Encoding` but `chunked`, is refused;
- hop-by-hop headers, every header a `Connection` header names, and every `Proxy-*` header are dropped
  (so a client's `Proxy-Authorization` never reaches an origin or an upstream), `Host` is rebuilt from the
  request URI, and the connection is closed after the response (`Connection: close`);
- a chunked body is re-framed chunk by chunk (extensions and trailers dropped); a sized body is copied
  for exactly its length. Bodies are streamed in bounded pieces, never buffered whole.

Only `http://` is carried: `https://` in absolute form is a 400 (HTTPS is CONNECT). Credentials in the
URI (`user@host`) are refused rather than forwarded.

Standard library only: it ships in the egress proxy's payload.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from dataclasses import dataclass
import re
from typing import Literal

MAX_URI_CHARS = 2048
MAX_HEADERS = 100
MAX_TRAILER_LINES = 32
CHUNK_BYTES = 64 * 1024
_TOKEN = re.compile(r"[!#$%&'*+\-.^_`|~0-9A-Za-z]+")
_TARGET_CHARS = re.compile(r"[\x21-\x7e]+")
_AUTHORITY = re.compile(r"(?P<host>\[[0-9A-Fa-f:.]+\]|[^\s:\[\]/@?#]+)(?::(?P<port>[0-9]{1,5}))?")
_CONTENT_LENGTH = re.compile(r"[0-9]{1,15}")
_CHUNK_SIZE = re.compile(rb"[0-9A-Fa-f]{1,8}")
_VERSION = re.compile(r"HTTP/1\.[01]")
_CONTROL = re.compile(r"[\x00-\x08\x0a-\x1f\x7f]")
# Headers that describe one hop, not the message (RFC 9110 7.6.1), plus the ones this module re-derives.
_DROPPED = frozenset(
    {
        "connection",
        "keep-alive",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
        "content-length",
        "host",
        "proxy-connection",
    }
)


class HttpRequestError(Exception):
    """A request this proxy will not forward; `reason` goes on the audit line, `status` to the client."""

    def __init__(self, reason: str, status: int = 400) -> None:
        super().__init__(reason)
        self.reason = reason
        self.status = status


@dataclass(frozen=True)
class HttpRequest:
    method: str
    host: str
    port: int
    target: str
    """The path and query, as the origin is asked for it."""
    headers: tuple[tuple[str, str], ...]
    """The end-to-end headers that survive: no hop-by-hop, `Proxy-*`, `Host` or framing header."""
    framing: Literal["none", "length", "chunked"]
    length: int = 0


def is_absolute_form(target: str) -> bool:
    return "://" in target


def parse_request(request_line: tuple[str, str, str], head: bytes) -> HttpRequest:
    """Read an absolute-form request head (the bytes through the blank line); raises `HttpRequestError`."""
    method, uri, version = request_line
    if not _TOKEN.fullmatch(method) or not _VERSION.fullmatch(version):
        raise HttpRequestError("invalid_request")
    if len(uri) > MAX_URI_CHARS:
        raise HttpRequestError("uri_too_long", 414)
    scheme, _, rest = uri.partition("://")
    if scheme.lower() == "https":
        raise HttpRequestError("unsupported_scheme")
    if scheme.lower() != "http" or not _TARGET_CHARS.fullmatch(rest):
        raise HttpRequestError("invalid_target")
    if "#" in rest:
        raise HttpRequestError("invalid_target")
    cut = min((rest.find(mark) for mark in "/?" if mark in rest), default=len(rest))
    authority, target = rest[:cut], rest[cut:] or "/"
    if target.startswith("?"):
        target = "/" + target
    match = _AUTHORITY.fullmatch(authority)
    port = int(match["port"]) if match and match["port"] else 80
    if match is None or not 1 <= port <= 65535:
        raise HttpRequestError("invalid_target")
    headers = _read_headers(head)
    kept, framing, length = _frame(headers)
    return HttpRequest(method, match["host"], port, target, kept, framing, length)


def _read_headers(head: bytes) -> list[tuple[str, str]]:
    text = head.decode("latin-1")
    lines = text[: -len("\r\n\r\n")].split("\r\n")[1:] if text.endswith("\r\n\r\n") else None
    if lines is None or len(lines) > MAX_HEADERS:
        raise HttpRequestError("invalid_request")
    headers: list[tuple[str, str]] = []
    for line in lines:
        name, separator, value = line.partition(":")
        # No obs-fold (a line starting with whitespace), no whitespace before the colon, no bare CR/LF/NUL.
        if not separator or not _TOKEN.fullmatch(name) or _CONTROL.search(value) or "\r" in value:
            raise HttpRequestError("invalid_header")
        headers.append((name, value.strip(" \t")))
    return headers


def _frame(
    headers: list[tuple[str, str]],
) -> tuple[tuple[tuple[str, str], ...], Literal["none", "length", "chunked"], int]:
    names = [name.lower() for name, _ in headers]
    lengths = [value for name, value in headers if name.lower() == "content-length"]
    encodings = [value for name, value in headers if name.lower() == "transfer-encoding"]
    if lengths and encodings:
        raise HttpRequestError("ambiguous_length")
    if len(lengths) > 1 or (lengths and not _CONTENT_LENGTH.fullmatch(lengths[0])):
        raise HttpRequestError("invalid_content_length")
    if len(encodings) > 1 or (encodings and encodings[0].lower() != "chunked"):
        raise HttpRequestError("unsupported_transfer_encoding")
    nominated = {
        token.strip().lower()
        for name, value in headers
        if name.lower() == "connection"
        for token in value.split(",")
        if token.strip()
    }
    kept = tuple(
        (name, value)
        for (name, value), lowered in zip(headers, names, strict=True)
        if lowered not in _DROPPED and lowered not in nominated and not lowered.startswith("proxy-")
    )
    if encodings:
        return kept, "chunked", 0
    if lengths:
        return kept, "length", int(lengths[0])
    return kept, "none", 0


def render_head(request: HttpRequest, *, authority: str, uri: str | None, proxy_authorization: str | None) -> bytes:
    """The head sent on: origin-form when direct (`uri` None), the absolute `uri` when chained."""
    lines = [f"{request.method} {uri or request.target} HTTP/1.1", f"Host: {authority}"]
    lines.extend(f"{name}: {value}" for name, value in request.headers)
    if proxy_authorization is not None:
        lines.append(f"Proxy-Authorization: {proxy_authorization}")
    if request.framing == "length":
        lines.append(f"Content-Length: {request.length}")
    elif request.framing == "chunked":
        lines.append("Transfer-Encoding: chunked")
    lines.append("Connection: close")
    return ("\r\n".join(lines) + "\r\n\r\n").encode("latin-1")


def host_authority(host: str, port: int) -> str:
    """The `Host` value for the request URI's authority: the port is omitted when it is the default."""
    return host if port == 80 else f"{host}:{port}"


async def relay_body(
    reader: asyncio.StreamReader,
    writer: asyncio.StreamWriter,
    request: HttpRequest,
    on_bytes: Callable[[int], None],
) -> None:
    """Stream the request body to the origin, reporting each piece moved. Raises `HttpRequestError`."""
    if request.framing == "length":
        await _relay_sized(reader, writer, request.length, on_bytes)
    elif request.framing == "chunked":
        await _relay_chunked(reader, writer, on_bytes)


async def _relay_sized(
    reader: asyncio.StreamReader, writer: asyncio.StreamWriter, length: int, on_bytes: Callable[[int], None]
) -> None:
    remaining = length
    while remaining:
        data = await reader.read(min(CHUNK_BYTES, remaining))
        if not data:
            raise HttpRequestError("truncated_body")
        writer.write(data)
        await writer.drain()
        remaining -= len(data)
        on_bytes(len(data))


async def _relay_chunked(
    reader: asyncio.StreamReader, writer: asyncio.StreamWriter, on_bytes: Callable[[int], None]
) -> None:
    while True:
        try:
            line = await reader.readuntil(b"\r\n")
        except (asyncio.IncompleteReadError, asyncio.LimitOverrunError):
            raise HttpRequestError("invalid_chunk") from None
        size_text = line[:-2].split(b";", 1)[0].strip(b" \t")
        if not _CHUNK_SIZE.fullmatch(size_text):
            raise HttpRequestError("invalid_chunk")
        size = int(size_text, 16)
        # Re-framed: an extension is not forwarded, so the origin cannot read the size line differently.
        writer.write(f"{size:x}\r\n".encode("ascii"))
        if size == 0:
            await _drop_trailers(reader)
            writer.write(b"\r\n")
            await writer.drain()
            return
        await _relay_sized(reader, writer, size, on_bytes)
        try:
            ending = await reader.readexactly(2)
        except asyncio.IncompleteReadError:
            raise HttpRequestError("invalid_chunk") from None
        if ending != b"\r\n":
            raise HttpRequestError("invalid_chunk")
        writer.write(b"\r\n")
        await writer.drain()


async def _drop_trailers(reader: asyncio.StreamReader) -> None:
    for _ in range(MAX_TRAILER_LINES):
        try:
            line = await reader.readuntil(b"\r\n")
        except (asyncio.IncompleteReadError, asyncio.LimitOverrunError):
            raise HttpRequestError("invalid_chunk") from None
        if line == b"\r\n":
            return
    raise HttpRequestError("invalid_chunk")
