"""The SSRF screen the Connector and the egress proxy share (design section 6.2).

A request names a host. `vet` resolves it once and judges every address the name resolved to;
`connect_vetted` then connects only to an address that was judged, so a second resolution cannot change
the answer (DNS rebinding). Ports, allowlists and approvals belong to the caller: this module answers
whether a host may be reached at all.

Standard library only: it ships in the Connector's payload, which carries no third-party packages.
"""

from __future__ import annotations

from dataclasses import dataclass
import ipaddress
import re
import socket

_LABEL = re.compile(r"(?!-)[a-z0-9-]{1,63}(?<!-)")
# Top-level domains are alphabetic or IDNA-encoded, never numeric, which is also what keeps every
# shorthand spelling of an IPv4 address (`127.1`, `0x7f000001`, `2130706433`) from passing as a name.
_TOP_LABEL = re.compile(r"[a-z]{2,63}|xn--[a-z0-9-]{1,59}")
_NAT64_WELL_KNOWN = ipaddress.IPv6Network("64:ff9b::/96")
_MAX_RESPONSE_HEAD_BYTES = 8 * 1024


class EgressRefused(Exception):
    """A connection to a host `vet` refused; `reason` is the refusal."""

    def __init__(self, reason: str) -> None:
        super().__init__(f"egress refused: {reason}")
        self.reason = reason


class TunnelRefused(ConnectionError):
    """The upstream proxy answered the CONNECT, and the answer was no; `status` is what it said."""

    def __init__(self, status: int) -> None:
        super().__init__(f"the upstream proxy refused the tunnel with status {status}")
        self.status = status


@dataclass(frozen=True)
class Vetted:
    """One resolution of one host, and the decision made on it.

    `refusal` is None or one of `invalid_host` (not an ASCII DNS name), `ip_literal` (an address, however
        spelled; `addresses` is then its one canonical form), `resolution_failed` (no address), `non_public_address` (some address is not public).
    """

    host: str
    port: int
    addresses: tuple[str, ...]
    refusal: str | None


def vet(host: str, port: int) -> Vetted:
    """Resolve `host` once and judge every address it resolved to; any non-public one refuses it."""
    name = host.lower().removesuffix(".")
    if not _is_dns_name(name):
        literal = parse_ip_literal(name)
        if literal is None:
            return Vetted(name, port, (), "invalid_host")
        # The refusal carries the canonical address, so a caller that tunnels it anyway (log_only) connects
        # to the address it classified and not to a spelling the socket layer would read differently.
        return Vetted(name, port, (str(literal),), "ip_literal")
    try:
        records = socket.getaddrinfo(name, port, type=socket.SOCK_STREAM)
    except (OSError, UnicodeError):
        return Vetted(name, port, (), "resolution_failed")
    addresses = tuple(dict.fromkeys(str(record[4][0]) for record in records))
    if not addresses:
        return Vetted(name, port, (), "resolution_failed")
    if not all(_is_public(ipaddress.ip_address(address)) for address in addresses):
        return Vetted(name, port, addresses, "non_public_address")
    return Vetted(name, port, addresses, None)


def connect_vetted(
    vetted: Vetted,
    timeout: float,
    upstream: tuple[str, int] | None = None,
    proxy_authorization: str | None = None,
) -> socket.socket:
    """Connect to an address `vet` judged, never to the name; refuse whatever `vet` refused.

    With `upstream`, the host's upstream proxy is asked for a tunnel to that same address (D4), so the
    proxy's own resolution has nothing to rebind; TLS still checks the name, through SNI. A refused or
    failed tunnel is a failed connection: there is no direct fallback. `proxy_authorization` is the
    value of a `Proxy-Authorization` header for that proxy; it is sent on the CONNECT and nowhere else.
    """
    if vetted.refusal is not None:
        raise EgressRefused(vetted.refusal)
    failure: OSError = ConnectionError("no vetted address to connect to")
    for address in vetted.addresses:
        try:
            if upstream is None:
                return socket.create_connection((address, vetted.port), timeout=timeout)
            return _tunnel(upstream, address, vetted.port, timeout, proxy_authorization)
        except OSError as exc:
            failure = exc
    raise failure


def connect_upstream(upstream: tuple[str, int], timeout: float) -> socket.socket:
    """A plain connection to the host's upstream proxy, for a request it will forward (not a tunnel)."""
    return socket.create_connection(upstream, timeout=timeout)


def is_dns_name(host: str) -> bool:
    """Whether `vet` would resolve `host`; anything else (an address in any spelling) it refuses unresolved."""
    return _is_dns_name(host.lower().removesuffix("."))


def is_public_literal(host: str) -> bool:
    """Whether `host` is an IP literal for a public address, in any spelling `parse_ip_literal` accepts."""
    address = parse_ip_literal(host)
    return address is not None and _is_public(address)


def parse_ip_literal(host: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    """The canonical address `host` spells, or None when it is not an IP literal.

    The one parser every decision about a literal goes through. Besides the standard forms it takes the
    shorthand, octal, hexadecimal and single-integer IPv4 spellings (`127.1`, `0177.0.0.1`, `0x7f000001`,
    `2130706433`) that the platform's resolver reads as an address, so classifying and connecting use the
    address the socket layer would reach.
    """
    candidate = host[1:-1] if host.startswith("[") and host.endswith("]") else host
    try:
        return ipaddress.ip_address(candidate)
    except ValueError:
        pass
    try:
        return ipaddress.IPv4Address(socket.inet_aton(candidate))
    except (OSError, UnicodeError, ValueError):
        return None


def _is_dns_name(name: str) -> bool:
    if not name or len(name) > 253 or not name.isascii():
        return False
    labels = name.split(".")
    return all(_LABEL.fullmatch(label) for label in labels) and bool(_TOP_LABEL.fullmatch(labels[-1]))


def _is_public(address: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    # `is_global` alone is not enough: Python counts multicast as global, the deprecated site-local
    # `fec0::/10` as global, and a NAT64 address as global whatever IPv4 address it embeds.
    if address.is_multicast or not address.is_global:
        return False
    if isinstance(address, ipaddress.IPv6Address):
        if address.is_site_local:
            return False
        embedded = embedded_ipv4(address)
        if embedded is not None:
            return _is_public(embedded)
    return True


def embedded_ipv4(address: ipaddress.IPv6Address) -> ipaddress.IPv4Address | None:
    """The IPv4 address a translator or relay forwards to, for the IPv6 forms that carry one."""
    if address.ipv4_mapped is not None:
        return address.ipv4_mapped
    if address.sixtofour is not None:
        return address.sixtofour
    if address.teredo is not None:
        return address.teredo[1]
    if address in _NAT64_WELL_KNOWN:
        return ipaddress.IPv4Address(int(address) & 0xFFFFFFFF)
    return None


def _tunnel(
    upstream: tuple[str, int],
    address: str,
    port: int,
    timeout: float,
    proxy_authorization: str | None = None,
) -> socket.socket:
    authority = f"[{address}]:{port}" if ":" in address else f"{address}:{port}"
    connection = socket.create_connection(upstream, timeout=timeout)
    try:
        authorization = f"Proxy-Authorization: {proxy_authorization}\r\n" if proxy_authorization else ""
        connection.sendall(
            f"CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n{authorization}\r\n".encode("ascii")
        )
        status = _response_status(connection)
        if status != 200:
            raise TunnelRefused(status)
    except BaseException:
        connection.close()
        raise
    return connection


def _response_status(connection: socket.socket) -> int:
    """Read the proxy's response head byte by byte, so nothing the tunnel carries afterwards is consumed."""
    head = b""
    while not head.endswith(b"\r\n\r\n"):
        if len(head) >= _MAX_RESPONSE_HEAD_BYTES:
            raise ConnectionError("the upstream proxy's response head exceeded its bound")
        byte = connection.recv(1)
        if not byte:
            raise ConnectionError("the upstream proxy closed the connection before answering")
        head += byte
    parts = head.split(b"\r\n", 1)[0].split(b" ", 2)
    if len(parts) < 2 or not parts[0].startswith(b"HTTP/") or not parts[1].isdigit():
        raise ConnectionError("the upstream proxy's response is not HTTP")
    return int(parts[1])
