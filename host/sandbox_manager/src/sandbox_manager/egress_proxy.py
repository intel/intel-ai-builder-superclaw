"""The egress proxy: the network_connector process shell and router traffic leaves through (design 6.4).

It carries `CONNECT host:port` tunnels and plain-HTTP absolute-form requests (`GET http://host/path`),
decrypts nothing, and judges every target with the screen the Connector uses (`egress_guard`), connecting
only to an address that screen judged. The caller is the listener a request arrived on, never a
credential (D1): one port for shell traffic, one for the router. Both kinds of request go through one
decision (`_admit`): screen, allowlist, then route.

Plain HTTP (EG2-4a, `egress_http`): the request is parsed and re-emitted canonically (hop-by-hop and
`Proxy-*` headers dropped, framing re-derived, `Connection: close`), its body streamed, never buffered.
Direct, it is sent in origin form to the vetted address; chained through the upstream proxy, in absolute
form with the vetted address in the URI and `Proxy-Authorization` when the upstream is credentialed.
Only `http://` is carried (`https://` in absolute form is a 400), and ambiguous framing is refused. The
audit line is the same, with `result=forwarded`. Nothing tells a role to use this yet: the broker
exports `HTTPS_PROXY` only, so `http://` requests still go direct unless a client is pointed here.

The mode comes from the sealed configuration. The default, `log_only` (EG2-2), tunnels and forwards
everything that can be reached and audits it, recording what enforce would refuse in
`enforce_would_refuse`. The exceptions are this host's own services and the link-local range, which are
never a destination. `enforce` (EG2-4a, off unless the sealed configuration says so) admits only what the
listener's sealed allowlist lists (`egress_allowlist_match`: exact host or `*.suffix`, and a listed port)
and refuses the rest with a 403 and the audit line `result=refused reason=not_allowlisted`; an address
the screen refuses (an IP literal, a non-public address) is refused with its own reason. With approvals
configured (EG2-4b, `egress_proxy_approval`; enforce only) the shell listener holds an unlisted public target
for the user's approval, per chat, instead of refusing it (`reason` is then `approval_denied`,
`approval_expired`, `approval_unavailable`, `approval_queue_full` or, for a Slack/Telegram-owned session,
`no_interactive_approver`); without them, and on the channel listener, it is refused as before. The allowlist
decides admission; PAC still decides the route of an admitted target.

A host upstream proxy this proxy cannot follow (socks, https) is tunnelled direct in log_only, as before
the proxy existed, with the route and its reason on the audit line; in enforce it is refused
(`upstream_unsupported`). A credentialed one is chained through with Proxy-Authorization. A PAC script
and/or WPAD is evaluated per target (`pac_resolver`, through WinHTTP, with the request's scheme): the
route is the script's, in its order, and a script that cannot be evaluated is direct and audited in
log_only and refused in enforce.

Standard library only: it ships in the Connector's payload.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path
import ipaddress
import json
import re
import socket
import sys
import time
from typing import Any
from urllib.parse import unquote, urlsplit

from . import connector_approval, egress_allowlist_match, egress_guard, egress_http
from .dpapi_secret_file import read_sealed_json
from .egress_allowlist_match import AllowedDestination
from .egress_audit import AuditLog
from .egress_proxy_approval import ASKABLE, STATE_PATH, ShellApprovals, header_value, is_admin_target, phrase
from .pac_resolver import Attempt, PacConfig, PacResolver, decide_pac_route

_MAX_REQUEST_HEAD_BYTES = 8 * 1024
_REQUEST_HEAD_TIMEOUT_S = 30.0
_CONNECT_TIMEOUT_S = 15.0
_RELAY_CHUNK_BYTES = 64 * 1024
# A plain-HTTP response that stops for this long is over; the connection closes after one response anyway.
_RESPONSE_IDLE_TIMEOUT_S = 300.0
_PHRASES = {400: "Bad Request", 414: "URI Too Long"}
MODES = ("log_only", "enforce")
CALLERS = ("shell", "channel")
# Without a sealed allowlist, the only port tunnelled; log_only records anything else as `port_not_allowed`.
_ALLOWED_PORT = 443
_TARGET = re.compile(r"(?P<host>\[[0-9A-Fa-f:.]+\]|[^\s:\[\]/@]+):(?P<port>[0-9]{1,5})")
_MAX_UPSTREAM_CHARS = 4096
# What the audit says when the host names an upstream this proxy cannot chain through.
_ROUTE_REASONS = {"proxy_auto_config": "pac_only"}
# Classes of target no mode lets through: this host's own services and the link-local/metadata ranges.
_ALWAYS_REFUSED = frozenset({"loopback", "link_local", "host_self"})
_HOST_ADDRESS_TTL_S = 30.0
_host_address_cache: tuple[float, frozenset[str]] = (0.0, frozenset())
# Why a configured upstream cannot be chained through. The first five classify a value, in this order.
UPSTREAM_UNSUPPORTED_KINDS = (
    "unsupported_scheme",
    "tls_to_proxy",
    "credentials",
    "missing_port",
    "malformed",
    # These two come from the host's system setting rather than from a value; the isolation report
    # names the same seven kinds.
    "proxy_auto_config",
    "loopback_upstream",
)


class EgressProxy:
    """The two caller listeners and the tunnels behind them."""

    def __init__(
        self,
        *,
        audit: AuditLog,
        upstream: tuple[str, int] | None = None,
        upstream_unsupported: str | None = None,
        upstream_auth: tuple[str, str] | None = None,
        pac: PacResolver | None = None,
        mode: str = "log_only",
        allowlist: dict[str, tuple[AllowedDestination, ...]] | None = None,
        approvals: ShellApprovals | None = None,
    ) -> None:
        if mode not in MODES or (mode == "enforce" and allowlist is None):
            raise ValueError("enforce needs an allowlist, and the mode is log_only or enforce")
        if approvals is not None and mode != "enforce":
            raise ValueError("approvals are asked for in enforce mode only")
        if allowlist is not None and set(allowlist) != set(CALLERS):
            raise ValueError("the allowlist names one list per listener")
        self._approvals = approvals
        self._allowlist = allowlist
        self._audit = audit
        self._upstream = upstream
        self._pac = pac
        self._mode = mode
        self._proxy_authorization = (
            "Basic " + base64.b64encode(f"{upstream_auth[0]}:{upstream_auth[1]}".encode()).decode("ascii")
            if upstream_auth is not None
            else None
        )
        # The kind of upstream the host names and this proxy cannot chain through. In log_only the tunnel
        # goes direct, as it did before the proxy existed, and the audit line says so (route and reason).
        # A script the PAC resolver evaluates is no longer one of those.
        self._upstream_unsupported = (
            upstream_unsupported
            if upstream is None and not (pac is not None and upstream_unsupported == "proxy_auto_config")
            else None
        )
        self._servers: list[asyncio.Server] = []
        self._clients: set[asyncio.StreamWriter] = set()

    async def start(self, *, host: str, shell_port: int, channel_port: int) -> dict[str, int]:
        """Listen for both caller classes; returns the port each one is bound to."""
        bound: dict[str, int] = {}
        for caller, port in (("shell", shell_port), ("channel", channel_port)):
            server = await asyncio.start_server(
                lambda reader, writer, caller=caller: self._serve(caller, reader, writer),
                host,
                port,
                limit=_MAX_REQUEST_HEAD_BYTES,
            )
            self._servers.append(server)
            bound[caller] = server.sockets[0].getsockname()[1]
        return bound

    async def close(self) -> None:
        if self._approvals is not None:
            self._approvals.close()
        for server in self._servers:
            server.close()
        for writer in list(self._clients):
            writer.close()
        for server in self._servers:
            await server.wait_closed()
        self._servers.clear()

    async def _serve(
        self, caller: str, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        received = time.time()
        started = time.monotonic()
        record: dict[str, Any] = {
            "caller": caller,
            "target_host": None,
            "target_port": None,
            "result": "refused",
            "reason": None,
            "enforce_would_refuse": None,
            "bytes_up": 0,
            "bytes_down": 0,
            "route": self._route()[0],
            "route_reason": self._route()[1],
            "target_class": None,
        }
        self._clients.add(writer)
        audited = True
        try:
            audited = await self._handle(record, reader, writer)
        finally:
            self._clients.discard(writer)
            writer.close()
            if audited:
                self._write_audit(record, received, started)

    async def _handle(
        self, record: dict[str, Any], reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> bool:
        """Serve one connection; returns whether it was a request worth an audit line."""
        try:
            head = await asyncio.wait_for(
                reader.readuntil(b"\r\n\r\n"), timeout=_REQUEST_HEAD_TIMEOUT_S
            )
        except asyncio.IncompleteReadError as exc:
            # A connection that closes before sending a byte is a liveness probe, not a request.
            record["reason"] = "invalid_request"
            return bool(exc.partial)
        except (asyncio.LimitOverrunError, asyncio.TimeoutError, ConnectionError):
            record["reason"] = "invalid_request"
            await _answer(writer, 400, "Bad Request")
            return True
        parts = head.split(b"\r\n", 1)[0].decode("latin-1").split(" ")
        if len(parts) != 3 or not parts[2].startswith("HTTP/1."):
            record["reason"] = "invalid_request"
            await _answer(writer, 400, "Bad Request")
            return True
        authorization = header_value(head, "proxy-authorization") if self._approvals is not None else None
        if parts[0] == "CONNECT":
            return await self._handle_connect(record, parts[1], authorization, reader, writer)
        if egress_http.is_absolute_form(parts[1]):
            return await self._handle_http(
                record, (parts[0], parts[1], parts[2]), head, authorization, reader, writer
            )
        if record["caller"] == "shell" and await self._handle_local(parts[0], parts[1], head, reader, writer):
            return False
        # An origin-form request is a request to this proxy itself, which serves nothing.
        record["reason"] = "not_connect"
        await _answer(writer, 405, "Method Not Allowed")
        return True

    async def _handle_local(
        self, method: str, target: str, head: bytes, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> bool:
        """The two origin-form routes the shell listener serves (EG2-4b), neither audited: whether the proxy
        asks for approvals (`GET /v1/approvals/state`, no secret), and the approval admin routes the Sandbox
        Manager's broker uses (the admin secret). Returns whether the request was one of them."""
        if method == "GET" and target == STATE_PATH:
            status, body = 200, json.dumps({"approvals": self._approvals is not None}, separators=(",", ":")).encode("ascii")
        elif self._approvals is not None and is_admin_target(target):
            status, body = await self._approvals.serve_admin(
                method, target, head, reader, lambda event, **fields: _diag(event, **fields)
            )
        else:
            return False
        writer.write(
            f"HTTP/1.1 {status} {phrase(status)}\r\nContent-Type: application/json\r\n"
            f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n".encode("ascii")
            + body
        )
        try:
            await writer.drain()
        except ConnectionError:
            pass
        return True

    async def _handle_connect(
        self,
        record: dict[str, Any],
        authority: str,
        authorization: str | None,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ) -> bool:
        target = _TARGET.fullmatch(authority)
        if target is None or not 1 <= int(target["port"]) <= 65535:
            record["reason"] = "invalid_target"
            await _answer(writer, 400, "Bad Request")
            return True
        admitted = await self._admit(record, writer, target["host"], int(target["port"]), "https", authorization)
        if admitted is None:
            return True
        vetted, addresses, attempts = admitted
        if record.get("approval_id") is not None and _client_gone(reader, writer):
            # The client stopped waiting while the request was held for approval (e.g. curl timed out).
            record["result"], record["reason"] = "client_gone", "client_gone"
            return True
        dialled = await self._dial(record, vetted, addresses, attempts, tunnel=True)
        if dialled is None:
            await _answer(writer, 502, "Bad Gateway")
            return True
        outbound_reader, outbound_writer = await asyncio.open_connection(sock=dialled[0])
        try:
            writer.write(b"HTTP/1.1 200 Connection established\r\n\r\n")
            try:
                await writer.drain()
            except ConnectionError:
                record["result"], record["reason"] = "client_gone", "client_gone"
                return True
            record["result"] = "tunneled"
            record["bytes_up"], record["bytes_down"] = await asyncio.gather(
                _relay(reader, outbound_writer), _relay(outbound_reader, writer)
            )
        finally:
            outbound_writer.close()
        return True

    async def _handle_http(
        self,
        record: dict[str, Any],
        request_line: tuple[str, str, str],
        head: bytes,
        authorization: str | None,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ) -> bool:
        """Forward one plain-HTTP request (EG2-4a); the connection closes after the response."""
        try:
            request = egress_http.parse_request(request_line, head)
        except egress_http.HttpRequestError as exc:
            record["reason"] = exc.reason
            await _answer(writer, exc.status, _PHRASES[exc.status])
            return True
        admitted = await self._admit(record, writer, request.host, request.port, "http", authorization)
        if admitted is None:
            return True
        vetted, addresses, attempts = admitted
        dialled = await self._dial(record, vetted, addresses, attempts, tunnel=False)
        if dialled is None:
            await _answer(writer, 502, "Bad Gateway")
            return True
        outbound, attempt = dialled
        outbound_reader, outbound_writer = await asyncio.open_connection(sock=outbound)
        chained = attempt.upstream is not None
        # Chained, the upstream is asked for the vetted address, as a CONNECT is (D4); the name rides in Host.
        uri = f"http://{egress_http.host_authority(_bracketed(addresses[0]), request.port)}{request.target}"
        outbound_writer.write(
            egress_http.render_head(
                request,
                authority=egress_http.host_authority(request.host, request.port),
                uri=uri if chained else None,
                proxy_authorization=self._proxy_authorization if attempt.upstream == self._upstream else None,
            )
        )
        record["result"] = "forwarded"

        def counted(moved: int) -> None:
            record["bytes_up"] += moved

        body = asyncio.ensure_future(egress_http.relay_body(reader, outbound_writer, request, counted))
        response = asyncio.ensure_future(_relay_response(outbound_reader, writer, record))
        try:
            await asyncio.wait({body, response}, return_when=asyncio.FIRST_COMPLETED)
            if body.done() and not body.cancelled() and body.exception() is not None:
                failure = body.exception()
                record["result"] = "refused"
                record["reason"] = (
                    failure.reason if isinstance(failure, egress_http.HttpRequestError) else "invalid_request"
                )
                return True
            # The origin may answer before it has read the whole body; then the rest is not sent.
            await response
        finally:
            for task in (body, response):
                task.cancel()
            await asyncio.gather(body, response, return_exceptions=True)
            outbound_writer.close()
        return True

    async def _admit(
        self,
        record: dict[str, Any],
        writer: asyncio.StreamWriter,
        host: str,
        port: int,
        scheme: str,
        authorization: str | None = None,
    ) -> tuple[egress_guard.Vetted, tuple[str, ...], tuple[Attempt, ...]] | None:
        """The decision every request goes through: the screen, the allowlist, then the route.

        Answers and returns None when the target is refused or cannot be reached; otherwise the vetted
        target and the ordered attempts to reach it. The allowlist decides admission; PAC still decides
        the route of an admitted target. On the shell listener in enforce mode an unlisted public target
        is held for the user's approval (EG2-4b) before it is refused.
        """
        loop = asyncio.get_running_loop()
        vetted = await loop.run_in_executor(None, egress_guard.vet, host, port)
        record["target_host"], record["target_port"] = vetted.host, port
        # log_only tunnels what enforce would refuse; an IP literal is classified and connected to as the
        # canonical address `vet` parsed, never as the spelling the client sent.
        addresses = vetted.addresses
        target_class = await loop.run_in_executor(None, _target_class, addresses)
        record["target_class"] = target_class
        if target_class in _ALWAYS_REFUSED:
            # This host's own services and the metadata range are not a destination for anyone: the
            # proxy must not be a way into them, whatever the mode.
            record["reason"] = "non_public_address"
            record["enforce_would_refuse"] = "non_public_address"
            await _answer(writer, 403, "Forbidden")
            return None
        allowlist = self._allowlist_refusal(record["caller"], vetted.host, port)
        unsupported = "upstream_unsupported" if self._upstream_unsupported is not None else None
        enforce = vetted.refusal or allowlist or unsupported
        record["enforce_would_refuse"] = enforce
        if self._mode == "enforce":
            # An unlisted name that does not resolve is refused as unlisted; a listed one is a 502 below.
            refused = (None if vetted.refusal == "resolution_failed" else vetted.refusal) or allowlist or unsupported
            if (
                refused is not None
                and refused == allowlist
                and refused in ASKABLE
                and self._approvals is not None
                and record["caller"] == "shell"
                and vetted.refusal is None
                and target_class == "public"
            ):
                decision = await self._approvals.decide(host=vetted.host, port=port, authorization=authorization)
                record["session_ref"] = decision.session_ref
                record["approval_id"] = decision.approval_id
                record["approval_decision"] = decision.decision
                record["grant_scope"] = decision.scope
                refused = unsupported if decision.admitted else decision.reason
            if refused is not None:
                record["reason"] = refused
                await _answer(writer, 403, "Forbidden", f"egress refused: {refused}\n")
                return None
        if not addresses:
            record["result"], record["reason"] = "unreachable", "resolution_failed"
            await _answer(writer, 502, "Bad Gateway")
            return None
        if self._pac is not None:
            decision = decide_pac_route(
                self._mode,
                await loop.run_in_executor(
                    None,
                    self._pac.resolve,
                    addresses[0] if vetted.refusal == "ip_literal" else host.strip("[]"),
                    port,
                    scheme,
                ),
                self._upstream,
            )
            record["enforce_would_refuse"] = enforce or decision.enforce_would_refuse
            if decision.refuse is not None:
                record["route_reason"] = record["reason"] = decision.refuse
                await _answer(writer, 403, "Forbidden")
                return None
            attempts = decision.attempts
        else:
            attempts = (Attempt(self._upstream, *self._route()),)
        record["route"], record["route_reason"] = attempts[0].route, attempts[0].reason
        return vetted, addresses, attempts

    def _allowlist_refusal(self, caller: str, host: str, port: int) -> str | None:
        """Why the allowlist would refuse `host:port` for this listener, or None when it is listed.

        With no allowlist sealed (an older configuration) only the one port the proxy ever tunnelled counts.
        """
        if self._allowlist is None:
            return "port_not_allowed" if port != _ALLOWED_PORT else None
        return egress_allowlist_match.refusal(self._allowlist[caller], host, port)

    async def _dial(
        self,
        record: dict[str, Any],
        vetted: egress_guard.Vetted,
        addresses: tuple[str, ...],
        attempts: tuple[Attempt, ...],
        *,
        tunnel: bool,
    ) -> tuple[socket.socket, Attempt] | None:
        """Connect along the attempts in order: a CONNECT tunnel, or (plain HTTP) a connection to carry the
        request on. Returns the connection and the attempt that made it, or None with the failure audited."""
        loop = asyncio.get_running_loop()
        target = replace(vetted, addresses=addresses, refusal=None)
        for attempt in attempts:
            # Credentials go only to the proxy they were configured for, never to one a script names.
            authorization = self._proxy_authorization if attempt.upstream == self._upstream else None
            try:
                if tunnel or attempt.upstream is None:
                    outbound = await loop.run_in_executor(
                        None,
                        egress_guard.connect_vetted,
                        target,
                        _CONNECT_TIMEOUT_S,
                        attempt.upstream,
                        authorization if tunnel else None,
                    )
                else:
                    outbound = await loop.run_in_executor(
                        None, egress_guard.connect_upstream, attempt.upstream, _CONNECT_TIMEOUT_S
                    )
            except OSError as exc:
                # A failed upstream is a failed tunnel; the next attempt is only what the script listed.
                record["result"] = "unreachable"
                record["reason"] = (
                    "upstream_refused" if isinstance(exc, egress_guard.TunnelRefused) else "connect_failed"
                )
                continue
            record["route"], record["route_reason"] = attempt.route, attempt.reason
            record["result"], record["reason"] = "refused", None
            return outbound, attempt
        return None

    def _route(self) -> tuple[str, str | None]:
        if self._pac is not None:
            return "pac", None
        if self._upstream is not None:
            return ("upstream_credentialed" if self._proxy_authorization else "upstream"), None
        if self._upstream_unsupported is not None:
            return "direct_unsupported_upstream", _ROUTE_REASONS.get(
                self._upstream_unsupported, self._upstream_unsupported
            )
        return "direct", None

    def _write_audit(self, record: dict[str, Any], received: float, started: float) -> None:
        line = {
            **record,
            "time": datetime.fromtimestamp(received, timezone.utc)
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z"),
            "elapsed_ms": round((time.monotonic() - started) * 1000),
            "approval_id": record.get("approval_id"),
        }
        try:
            self._audit.write(line)
        except OSError as exc:
            _diag("audit_write_failed", exception_type=type(exc).__name__)


async def _relay(source: asyncio.StreamReader, sink: asyncio.StreamWriter) -> int:
    """Copy one direction until it ends, then half-close the other side; returns the bytes moved."""
    moved = 0
    try:
        while data := await source.read(_RELAY_CHUNK_BYTES):
            sink.write(data)
            await sink.drain()
            moved += len(data)
    except OSError:
        # A reset ends a direction the way an EOF does; Windows can report it as a plain OSError.
        pass
    finally:
        try:
            if sink.can_write_eof():
                sink.write_eof()
        except OSError:
            pass
    return moved


async def _relay_response(
    source: asyncio.StreamReader, sink: asyncio.StreamWriter, record: dict[str, Any]
) -> None:
    """Copy the origin's response to the caller until the origin closes; counts into the audit record."""
    try:
        while data := await asyncio.wait_for(source.read(_RELAY_CHUNK_BYTES), _RESPONSE_IDLE_TIMEOUT_S):
            sink.write(data)
            await sink.drain()
            record["bytes_down"] += len(data)
    except (OSError, asyncio.TimeoutError):
        # A reset ends the response the way an EOF does; so does an origin that went quiet.
        pass


def _bracketed(address: str) -> str:
    return f"[{address}]" if ":" in address else address


def _client_gone(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> bool:
    """Whether a client that sent a CONNECT has since closed or reset its side; it sends nothing until the
    proxy answers, so end-of-stream before the answer means it stopped waiting."""
    return reader.at_eof() or reader.exception() is not None or writer.is_closing()


async def _answer(writer: asyncio.StreamWriter, status: int, phrase: str, body: str = "") -> None:
    payload = body.encode("ascii")
    kind = "Content-Type: text/plain\r\n" if payload else ""
    writer.write(
        f"HTTP/1.1 {status} {phrase}\r\n{kind}Content-Length: {len(payload)}\r\nConnection: close\r\n\r\n".encode(
            "ascii"
        )
        + payload
    )
    try:
        await writer.drain()
    except ConnectionError:
        pass


def _diag(event: str, **fields: object) -> None:
    """One structured line for the proxy's tier log; never a secret or a tunnelled byte."""
    parts = " ".join(f"{key}={value}" for key, value in fields.items())
    print(f"egress_proxy event={event} {parts}".rstrip(), file=sys.stderr, flush=True)


def host_addresses() -> frozenset[str]:
    """This host's own addresses as its name resolves them, kept for a short while."""
    global _host_address_cache
    expires, cached = _host_address_cache
    if time.monotonic() < expires:
        return cached
    found: set[str] = set()
    try:
        for record in socket.getaddrinfo(socket.gethostname(), None):
            found.add(str(record[4][0]).split("%", 1)[0])
    except OSError:
        pass
    _host_address_cache = (time.monotonic() + _HOST_ADDRESS_TTL_S, frozenset(found))
    return _host_address_cache[1]


def _classify(address: str) -> str:
    try:
        parsed = ipaddress.ip_address(address.split("%", 1)[0])
    except ValueError:
        return "public"
    original = parsed
    # A translated form (mapped, NAT64, 6to4, Teredo) reaches the IPv4 address it embeds, so that is the
    # one classified; the IPv6 spelling is still checked against this host's own addresses.
    if isinstance(parsed, ipaddress.IPv6Address):
        parsed = egress_guard.embedded_ipv4(parsed) or parsed
    if parsed.is_loopback or parsed.is_unspecified:
        return "loopback"
    if parsed.is_link_local:
        return "link_local"
    if not host_addresses().isdisjoint({str(original), str(parsed)}):
        return "host_self"
    if parsed.is_private and not (parsed.is_multicast or parsed.is_reserved):
        if isinstance(parsed, ipaddress.IPv4Address):
            private = any(parsed in net for net in _PRIVATE_V4)
        else:
            private = parsed in _PRIVATE_V6
        if private:
            return "private"
    return "public" if parsed.is_global and not parsed.is_multicast else "other_non_public"


_PRIVATE_V4 = tuple(ipaddress.ip_network(net) for net in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))
_PRIVATE_V6 = ipaddress.ip_network("fc00::/7")


def _target_class(addresses: tuple[str, ...]) -> str | None:
    """The worst class among the addresses a target resolves to: one that is refused outranks the rest."""
    classes = {_classify(address) for address in addresses}
    for worst in ("loopback", "host_self", "link_local", "other_non_public", "private", "public"):
        if worst in classes:
            return worst
    return None


def upstream_unsupported_kind(url: str) -> str | None:
    """Why this proxy cannot chain through `url`, or `None` for `http://host:port` with no credentials.

    The first of `UPSTREAM_UNSUPPORTED_KINDS` that applies; never the value, which may carry a password.
    """
    if len(url) > _MAX_UPSTREAM_CHARS or "://" not in url:
        return "malformed"
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        return "malformed"
    if parts.scheme not in ("http", "https"):
        return "unsupported_scheme"
    if parts.scheme == "https":
        return "tls_to_proxy"
    has_credentials = parts.username is not None or parts.password is not None
    # A credentialed URL still has to name a usable address: the credentials are chained through only to one.
    if not parts.hostname or parts.path not in ("", "/") or parts.query or parts.fragment:
        return "malformed"
    if port is None:
        return "missing_port"
    if port == 0:
        return "malformed"
    return "credentials" if has_credentials else None


def parse_upstream(url: str) -> tuple[tuple[str, int], tuple[str, str] | None]:
    """The address and any credentials of an `http://[user[:password]@]host:port` upstream.

    Credentials are percent-decoded and live only in the sealed configuration and this process's memory.
    """
    if upstream_unsupported_kind(url) not in (None, "credentials"):
        raise ValueError("the upstream proxy must be http://host:port")
    parts = urlsplit(url)
    auth = None
    if parts.username is not None or parts.password is not None:
        auth = (unquote(parts.username or ""), unquote(parts.password or ""))
    return (parts.hostname or "", parts.port or 0), auth


def _upstream_address(url: str | None) -> tuple[str, int] | None:
    if url is None:
        return None
    return parse_upstream(url)[0]


def _read_config(path: Path) -> dict[str, Any]:
    value = read_sealed_json(path)
    if set(value) - {"pac", "mode", "allowlist", "approval", "session_key"} != {"audit", "upstream", "upstream_unsupported"}:
        raise ValueError("egress proxy configuration fields are invalid")
    audit = value["audit"]
    if (
        not isinstance(audit, dict)
        or set(audit) != {"path"}
        or not isinstance(audit["path"], str)
        or not Path(audit["path"]).is_absolute()
    ):
        raise ValueError("egress proxy audit configuration is invalid")
    if value["upstream"] is not None and not isinstance(value["upstream"], str):
        raise ValueError("egress proxy upstream configuration is invalid")
    unsupported = value["upstream_unsupported"]
    # Beside an upstream the only kind that may stand is `credentials`: it is recorded, and chained through.
    if unsupported is not None and (
        unsupported not in UPSTREAM_UNSUPPORTED_KINDS
        or (value["upstream"] is not None and unsupported != "credentials")
    ):
        raise ValueError("egress proxy upstream configuration is invalid")
    if value["upstream"] is not None:
        parse_upstream(value["upstream"])
    _pac_config(value.get("pac"))
    _enforcement_config(value.get("mode", "log_only"), value.get("allowlist"))
    _approvals_config(value.get("mode", "log_only"), value.get("approval"), value.get("session_key"))
    return value


def _approvals_config(mode: object, approval: object, session_key: object) -> ShellApprovals | None:
    """The shell listener's approvals (EG2-4b): present only in enforce mode, with the verifier section and the
    session key together. Anything else that names one of them is a refusal to start."""
    if approval is None and session_key is None:
        return None
    if mode != "enforce" or approval is None or session_key is None:
        raise ValueError("egress proxy approval configuration needs enforce mode, a verifier section and a session key")
    config = connector_approval.approval_config_from(approval)
    if (
        config is None
        or not isinstance(session_key, str)
        or not connector_approval._BASE64URL_32.fullmatch(session_key)
    ):
        raise ValueError("egress proxy approval configuration is invalid")
    return ShellApprovals(config=config, session_key=session_key)


def _enforcement_config(mode: object, allowlist: object) -> tuple[str, dict[str, tuple[AllowedDestination, ...]] | None]:
    """The sealed mode and per-listener allowlist; either may be absent from an older configuration
    (log_only, no allowlist). enforce without an allowlist is a refusal to start."""
    if mode not in MODES:
        raise ValueError("egress proxy mode is invalid")
    if allowlist is None:
        if mode == "enforce":
            raise ValueError("egress proxy enforce mode needs an allowlist")
        return str(mode), None
    if not isinstance(allowlist, dict) or set(allowlist) != set(CALLERS):
        raise ValueError("egress proxy allowlist is invalid")
    return str(mode), {caller: egress_allowlist_match.parse_allowlist(allowlist[caller]) for caller in CALLERS}


def _pac_config(value: object) -> PacConfig | None:
    """The sealed PAC/WPAD setting, or None for none; a malformed one is a refusal to start."""
    if value is None:
        return None
    if not isinstance(value, dict) or set(value) != {"auto_config_url", "auto_detect"}:
        raise ValueError("egress proxy PAC configuration is invalid")
    url, detect = value["auto_config_url"], value["auto_detect"]
    if (
        not isinstance(detect, bool)
        or (url is not None and (not isinstance(url, str) or not url or len(url) > _MAX_UPSTREAM_CHARS))
        or (url is None and not detect)
    ):
        raise ValueError("egress proxy PAC configuration is invalid")
    return PacConfig(url, detect)


async def _serve_forever(proxy: EgressProxy, args: argparse.Namespace, upstream: str, mode: str) -> None:
    ports = await proxy.start(host=args.host, shell_port=args.shell_port, channel_port=args.channel_port)
    _diag(
        "ready",
        shell_port=ports["shell"],
        channel_port=ports["channel"],
        mode=mode,
        upstream=upstream,
    )
    await asyncio.Event().wait()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", required=True)
    parser.add_argument("--shell-port", required=True, type=int)
    parser.add_argument("--channel-port", required=True, type=int)
    parser.add_argument("--config-file", required=True)
    args = parser.parse_args()
    if args.host != "127.0.0.1" or not all(
        1 <= port <= 65535 for port in (args.shell_port, args.channel_port)
    ):
        parser.error("the egress proxy must listen on 127.0.0.1 and two non-zero TCP ports")
    try:
        config = _read_config(Path(args.config_file))
        upstream, upstream_auth = (
            parse_upstream(config["upstream"]) if config["upstream"] is not None else (None, None)
        )
    except Exception as exc:  # noqa: BLE001
        raise SystemExit(f"invalid egress proxy configuration: {exc}") from None
    unsupported = config["upstream_unsupported"]
    try:
        audit = AuditLog(Path(config["audit"]["path"]))
    except OSError as exc:
        raise SystemExit(f"egress proxy audit log is unavailable: {exc}") from None
    pac_config = _pac_config(config.get("pac"))
    mode, allowlist = _enforcement_config(config.get("mode", "log_only"), config.get("allowlist"))
    resolver = PacResolver(pac_config) if pac_config is not None else None
    proxy = EgressProxy(
        audit=audit,
        upstream=upstream,
        upstream_unsupported=unsupported,
        upstream_auth=upstream_auth,
        pac=resolver,
        mode=mode,
        allowlist=allowlist,
        approvals=_approvals_config(mode, config.get("approval"), config.get("session_key")),
    )
    if upstream is not None:
        described = "credentialed" if upstream_auth is not None else "configured"
    elif unsupported is not None:
        described = f"unsupported:{unsupported}"
    else:
        described = "none"
    if resolver is not None:
        # Never the script URL: it names an internal host.
        described += "+pac" + ("+wpad" if pac_config and pac_config.auto_detect else "")
    try:
        asyncio.run(_serve_forever(proxy, args, described, mode))
    finally:
        audit.close()
        if resolver is not None:
            resolver.close()


if __name__ == "__main__":
    main()
