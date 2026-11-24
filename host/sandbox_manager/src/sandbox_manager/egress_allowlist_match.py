"""Which destinations an egress carrier lets through without asking (design 6.4, EG2-4a).

The Sandbox Manager resolves the egress allowlist contract (`contracts.egress_allowlist_data`) into one
list of `AllowedDestination` per proxy listener and seals it into the proxy's configuration; the proxy
never imports the contract. A host pattern is an exact name or `*.suffix`: the suffix has to match on a
label boundary and a wildcard never covers the bare suffix. Matching is case-insensitive, ignores a
trailing dot and compares IDNA (A-label) forms. An IP literal, in any spelling, never matches a host
pattern. The destination's port has to be one the same entry lists.

Standard library only: it ships in the egress proxy's payload.
"""

from __future__ import annotations

from dataclasses import dataclass

from . import egress_guard

NOT_ALLOWLISTED = "not_allowlisted"
PORT_NOT_ALLOWED = "port_not_allowed"


@dataclass(frozen=True)
class AllowedDestination:
    """One allowlist entry: host patterns that share the ports they may be reached on."""

    hosts: tuple[str, ...]
    ports: frozenset[int]


def normalise_host(host: str) -> str | None:
    """The lowercase A-label form of `host` without a trailing dot, or None when it is not a name."""
    name = host.strip().lower().removesuffix(".")
    if not name:
        return None
    try:
        return name.encode("idna").decode("ascii")
    except UnicodeError:
        return None


def parse_allowlist(value: object) -> tuple[AllowedDestination, ...]:
    """Read one listener's sealed list (`[{"hosts": [...], "ports": [...]}]`); raises ValueError."""
    if not isinstance(value, list):
        raise ValueError("egress proxy allowlist is invalid")
    entries: list[AllowedDestination] = []
    for item in value:
        if not isinstance(item, dict) or set(item) != {"hosts", "ports"}:
            raise ValueError("egress proxy allowlist is invalid")
        hosts, ports = item["hosts"], item["ports"]
        if (
            not isinstance(hosts, list)
            or not hosts
            or not all(isinstance(host, str) for host in hosts)
            or not isinstance(ports, list)
            or not ports
            or not all(type(port) is int and 1 <= port <= 65535 for port in ports)
        ):
            raise ValueError("egress proxy allowlist is invalid")
        patterns = [_pattern(host) for host in hosts]
        entries.append(AllowedDestination(tuple(patterns), frozenset(ports)))
    return tuple(entries)


def _pattern(host: str) -> str:
    wildcard = host.startswith("*.")
    name = normalise_host(host[2:] if wildcard else host)
    if name is None or "*" in name or egress_guard.parse_ip_literal(name) is not None:
        raise ValueError("egress proxy allowlist is invalid")
    return "*." + name if wildcard else name


def refusal(entries: tuple[AllowedDestination, ...], host: str, port: int) -> str | None:
    """None when `host:port` is listed; `port_not_allowed` when the host is listed on other ports only;
    `not_allowlisted` otherwise."""
    name = normalise_host(host)
    if name is None or egress_guard.parse_ip_literal(name) is not None:
        return NOT_ALLOWLISTED
    host_listed = False
    for entry in entries:
        if any(_matches(pattern, name) for pattern in entry.hosts):
            if port in entry.ports:
                return None
            host_listed = True
    return PORT_NOT_ALLOWED if host_listed else NOT_ALLOWLISTED


def _matches(pattern: str, name: str) -> bool:
    if pattern.startswith("*."):
        return name.endswith(pattern[1:]) and len(name) > len(pattern) - 1
    return pattern == name
