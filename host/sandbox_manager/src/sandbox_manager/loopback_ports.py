"""Fixed loopback ports for the roles Sandbox Manager numbers (design D3, #20).

A persistent WFP filter can name a port only if the port is the same on every start, so each role takes
the first usable one of its four contract candidates, in order. When all four are unusable the role
refuses to start, with a reason per candidate in the contract's shape; there is no random fallback.
"""

from __future__ import annotations

import errno
import os
from pathlib import Path
import re
import socket
import struct
import subprocess
import sys

from contracts.egress_loopback_ports_data import (
    EGRESS_LOOPBACK_PORT_CONTRACT_VERSION,
    EGRESS_LOOPBACK_PORT_RULES,
)
from contracts.egress_port_allocation_refusal import EgressPortAllocationRefusal

_WSAEACCES = 10013
_WSAEADDRINUSE = 10048
_NETSH_TIMEOUT_S = 10

# GetExtendedTcpTable: AF_INET/AF_INET6, TCP_TABLE_OWNER_PID_LISTENER, and the row layouts of
# MIB_TCPROW_OWNER_PID (24 bytes) and MIB_TCP6ROW_OWNER_PID (56 bytes); the port is network order.
_AF_INET = 2
_AF_INET6 = 23
_TCP_LISTENER = 3
_ERROR_INSUFFICIENT_BUFFER = 122
_TCP4_ROW_SIZE, _TCP4_PORT_OFFSET = 24, 8
_TCP6_ROW_SIZE, _TCP6_PORT_OFFSET = 56, 20
_TABLE_READ_ATTEMPTS = 5


class FixedPortsUnavailable(RuntimeError):
    """Every fixed candidate for one role is unusable; `refusal` says why, candidate by candidate."""

    def __init__(self, refusal: EgressPortAllocationRefusal) -> None:
        reasons = ", ".join(
            f"{candidate.port} {candidate.unavailable_because.value}" for candidate in refusal.candidates
        )
        super().__init__(f"no fixed loopback port is usable for {refusal.placeholder.value}: {reasons}")
        self.refusal = refusal


def allocate_fixed_port(
    placeholder: str, *, dynamic_range: range, reserved: frozenset[int] = frozenset()
) -> int:
    """The first usable candidate for `placeholder`, in contract order.

    `reserved` names ports another role of this start will listen on but may not be listening on
    yet, so a probe would call them free; each is `in_use`.
    """
    unavailable = []
    for port in EGRESS_LOOPBACK_PORT_RULES["fixed_port_candidates"][placeholder]:
        reason = (
            "in_use"
            if port in reserved
            else candidate_unavailable_because(port, dynamic_range=dynamic_range)
        )
        if reason is None:
            return port
        unavailable.append({"port": port, "unavailable_because": reason})
    raise FixedPortsUnavailable(
        EgressPortAllocationRefusal.model_validate(
            {
                "contract_version": EGRESS_LOOPBACK_PORT_CONTRACT_VERSION,
                "reason": "fixed_port_candidates_unavailable",
                "placeholder": placeholder,
                "candidates": unavailable,
            }
        )
    )


def candidate_unavailable_because(port: int, *, dynamic_range: range) -> str | None:
    """Why `port` cannot be used, or None when it can.

    Nothing here binds or listens on a non-loopback address: a wildcard bind raises the Windows
    Firewall prompt and briefly opens the port on external interfaces. A listener on any address,
    the wildcard included, is read from the OS listening table instead, because on Windows a plain
    wildcard listener does not stop a `127.0.0.1` bind. The table says `in_use`; the one
    `127.0.0.1` bind then reports a port the table cannot explain, an exclusive holder or a
    host-reserved range, as `bind_access_denied`.
    """
    if port in dynamic_range:
        return "inside_dynamic_port_range"
    if port in listening_tcp_ports():
        return "in_use"
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        try:
            probe.bind(("127.0.0.1", port))
        except OSError as exc:
            code = getattr(exc, "winerror", None) or exc.errno
            if code in (_WSAEADDRINUSE, errno.EADDRINUSE):
                return "in_use"
            if code not in (_WSAEACCES, errno.EACCES):
                raise
            return "bind_access_denied"
    return None


def listening_tcp_ports() -> frozenset[int]:
    """Every local TCP port with a listener on any address, IPv4 and IPv6, read from the OS table.

    `GetExtendedTcpTable` is read-only. Off Windows there is no such table and the set is empty,
    which leaves the `127.0.0.1` bind as the only probe.
    """
    if sys.platform != "win32":
        return frozenset()
    import ctypes

    iphlpapi = ctypes.WinDLL("iphlpapi")
    ports: set[int] = set()
    for family, row_size, port_offset in (
        (_AF_INET, _TCP4_ROW_SIZE, _TCP4_PORT_OFFSET),
        (_AF_INET6, _TCP6_ROW_SIZE, _TCP6_PORT_OFFSET),
    ):
        size = ctypes.c_ulong(0)
        status = iphlpapi.GetExtendedTcpTable(None, ctypes.byref(size), False, family, _TCP_LISTENER, 0)
        for _attempt in range(_TABLE_READ_ATTEMPTS):
            buffer = ctypes.create_string_buffer(size.value)
            status = iphlpapi.GetExtendedTcpTable(
                buffer, ctypes.byref(size), False, family, _TCP_LISTENER, 0
            )
            if status != _ERROR_INSUFFICIENT_BUFFER:
                break
        if status != 0:
            raise RuntimeError(f"the OS listening table could not be read: error {status}")
        (count,) = struct.unpack_from("<I", buffer, 0)
        for index in range(count):
            (raw,) = struct.unpack_from("<I", buffer, 4 + index * row_size + port_offset)
            ports.add(((raw & 0xFF) << 8) | ((raw >> 8) & 0xFF))
    return frozenset(ports)

def tcp_dynamic_port_range() -> range:
    """The host's IPv4 TCP dynamic port range, read now rather than assumed.

    IPv4 only: every port this module hands out is bound on `127.0.0.1`.
    """
    netsh = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "netsh.exe"
    try:
        completed = subprocess.run(
            [str(netsh), "interface", "ipv4", "show", "dynamicport", "tcp"],
            capture_output=True,
            timeout=_NETSH_TIMEOUT_S,
            check=True,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        return parse_dynamic_port_range(completed.stdout.decode("ascii", errors="replace"))
    except (OSError, subprocess.SubprocessError, ValueError) as exc:
        raise RuntimeError(
            f"the host's TCP dynamic port range could not be read: {type(exc).__name__}"
        ) from exc


def parse_dynamic_port_range(text: str) -> range:
    """The range in one `netsh ... show dynamicport tcp` output.

    Read by position, because `netsh` translates its labels: the last number on each of the first two
    lines after the rule is the start and the count.
    """
    _header, rule, after = text.partition("---")
    lines = [line for line in after.splitlines() if line.strip().strip("-")]
    values = [re.findall(r"\d+", line) for line in lines[:2]]
    if not rule or len(values) != 2 or not all(values):
        raise ValueError("the dynamic port range output has no start and count")
    start, count = int(values[0][-1]), int(values[1][-1])
    if not 1 <= start <= 65535 or count < 1 or start + count - 1 > 65535:
        raise ValueError("the dynamic port range is outside the TCP port space")
    return range(start, start + count)
