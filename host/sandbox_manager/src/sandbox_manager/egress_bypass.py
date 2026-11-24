"""The bypass list Sandbox Manager binds as `local_proxy_bypass` for the runtime, the router and openwork-server.

The broker validates the bound value with this same grammar (`catalog_roles/proxy_environment.rs`)
and refuses the whole start for one entry outside it, so a host entry that does not pass is
dropped here instead of passed on.
"""

from __future__ import annotations

import ipaddress
import re

LOOPBACK_ENTRIES = ("127.0.0.1", "localhost", "::1")
# Internal ranges stay off the proxy: it judges only public targets, and a connection to the
# private network has to keep working as it did before the proxy existed. No IPv6 range: httpx
# 0.28 reads an IPv6 CIDR in NO_PROXY as a URL it cannot parse and then builds no client at all,
# whatever the proxy settings.
INTERNAL_RANGES = (
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "169.254.0.0/16",
)
MAX_BYPASS_LIST_CHARS = 4096
_LABEL = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?")
_ADDRESS_CHARACTERS = frozenset("0123456789abcdefABCDEF:.")


def bypass_list(host_value: str | None, *, always: tuple[str, ...] = ()) -> tuple[str, int]:
    """The loopback entries, the `always` entries, then each host entry the grammar accepts and
    that is not an IPv6 CIDR (see `INTERNAL_RANGES`); and how many host entries were dropped.

    A list longer than the bound keeps only the loopback and `always` entries, which are the part a
    caller must never lose.
    """
    fixed = (*LOOPBACK_ENTRIES, *always)
    entries = list(fixed)
    kept = len(entries)
    dropped = 0
    for raw in (host_value or "").split(","):
        entry = raw.strip()
        if not entry or entry in fixed:
            continue
        if _is_bypass_entry(entry) and not _is_ipv6_network(entry):
            entries.append(entry)
        else:
            dropped += 1
    value = ",".join(entries)
    if len(value) > MAX_BYPASS_LIST_CHARS:
        return ",".join(entries[:kept]), dropped + len(entries) - kept
    return value, dropped


def local_proxy_bypass(host_value: str | None) -> tuple[str, int]:
    """The list a file_tool process is bound: loopback, the internal ranges, then the host's own."""
    return bypass_list(host_value, always=INTERNAL_RANGES)


def _is_bypass_entry(entry: str) -> bool:
    """A name or a domain suffix of at least two labels, an address, or a CIDR no wider than
    /8 for IPv4 or /7 for IPv6.

    Two labels because curl, Python and Go all treat a bare `com` as that domain and every
    subdomain of it, so a one-label entry would send a whole top-level domain around the proxy.
    """
    if not entry.isascii():
        return False
    if _is_multi_label_name(entry.removeprefix(".")):
        return True
    address, _, prefix = entry.partition("/")
    if not address or not set(address) <= _ADDRESS_CHARACTERS:
        return False
    try:
        parsed = ipaddress.ip_address(address)
    except ValueError:
        return False
    widest, bits = (8, 32) if parsed.version == 4 else (7, 128)
    if "/" not in entry:
        return True
    # The length check comes first: int() refuses a string of more than 4,300 digits.
    return prefix.isdigit() and len(prefix) <= 3 and widest <= int(prefix) <= bits


def _is_ipv6_network(entry: str) -> bool:
    return ":" in entry and "/" in entry


def _is_multi_label_name(name: str) -> bool:
    labels = name.split(".")
    return len(labels) >= 2 and all(_LABEL.fullmatch(label) for label in labels)
