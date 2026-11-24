"""What the WFP plan is built from besides the shipped policy: the plan selection and the connector's endpoints (EG2-11).

Contract touched: ``Sandbox`` (egress policy plan, v4). Adapter: ``egress_wfp.plan_install`` is the only caller.

**Selection.** The shipped plan is permissive: presence anchor, no filter. The enforcing reference is chosen by one
internal setting, ``SUPERCLAW_NATIVE_EGRESS_WFP_PLAN=enforcing``, read from this process's environment by tests and
developers. Nothing ships it, and with anything else here no host is read, no name is resolved and no script is
fetched: the permissive path costs nothing and is byte-identical to the plan before this module.

**Connector endpoints.** Only the ``network_connector`` tier needs a way through its internal block: the egress proxy's
own outbound legs and the Connector run as that account, and file_tool, channel and bootstrap reach the network only
through the proxy's loopback listeners. What the connector must reach is the host's upstream proxy (the static one),
the PAC script's own host, and every proxy the script names (``pac_resolver.extract_pac_endpoints``). With none of
them, the connector goes direct and needs no permit: the internal block never matches a public address.

Each endpoint is resolved to IP literals **at plan-build time**, because a WFP filter matches addresses. A DNS or PAC
change therefore changes the plan's digest, and the existing digest marker makes that start provision again (one
elevation). Resolution order never changes the plan: addresses and ports are sorted and de-duplicated. The permit is
the union of the resolved addresses with the resolved ports, a superset of the exact (address, port) pairs but
confined to the proxies' own addresses; loopback, link-local (the metadata address among it), unspecified and
multicast addresses are refused, and so is an endpoint that does not resolve. Bounds are the contract's: at most
8 addresses and 8 ports, else the plan is skipped rather than truncated.

Fail closed, legibly. A PAC setup this side cannot enumerate (a script that builds a proxy name at run time, WPAD with
no script URL, a script that cannot be fetched) skips the enforcing plan with a typed reason instead of enforcing a
connector that could not reach its proxy. Nothing here logs a URL, a host name or a credential.
"""

from __future__ import annotations

import ipaddress
import os
import socket
import subprocess
import time
import urllib.request
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal
from urllib.parse import urlsplit

from contracts.egress_policy_descriptor_data import EGRESS_POLICY_RULES

from ..loopback_ports import tcp_dynamic_port_range
from ..pac_resolver import extract_pac_endpoints

if TYPE_CHECKING:
    from ..upstream_proxy import UpstreamProxy

WfpPlanMode = Literal["permissive", "enforcing"]

#: Internal setting for tests and developers; not a shipped setting. Anything but ``enforcing`` is permissive.
ENV_WFP_PLAN = "SUPERCLAW_NATIVE_EGRESS_WFP_PLAN"

_PAC_FETCH_TIMEOUT_SECONDS = 5.0
_PAC_SCRIPT_MAX_BYTES = 512 * 1024
_RESOLVED_INPUTS_TTL_SECONDS = 60.0
_SC_TIMEOUT_SECONDS = 5.0
_MAX_ADDRESSES = int(EGRESS_POLICY_RULES["upstream_proxy_max_addresses"])
_MAX_PORTS = 1 + int(EGRESS_POLICY_RULES["upstream_proxy_max_additional_ports"])

Endpoint = tuple[str, int]
Resolver = Callable[[str], list[str]]
ScriptFetcher = Callable[[str], str]
EvidenceReader = Callable[[], Mapping[str, Any] | None]


def wfp_plan_mode(env: Mapping[str, str]) -> WfpPlanMode:
    """``enforcing`` only for the internal setting's exact value; every other value is the shipped plan."""
    return "enforcing" if env.get(ENV_WFP_PLAN, "").strip() == "enforcing" else "permissive"


@dataclass(frozen=True)
class WfpPlanInputs:
    """What ``plan_install`` plans from. The default is the shipped permissive plan, which reads nothing."""

    mode: WfpPlanMode = "permissive"
    upstream_proxy: Mapping[str, Any] | None = None
    host_policy_state: Mapping[str, Any] | None = None
    skip_reason: str | None = None
    """Set when the enforcing plan cannot be written truthfully; ``plan_install`` skips with it."""


@dataclass(frozen=True)
class ConnectorEndpoints:
    """The connector's resolved endpoints: sorted, unique, and every refusal by kind (never by name)."""

    addresses: tuple[str, ...]
    ports: tuple[int, ...]
    refused: tuple[str, ...]

    def upstream_proxy(self) -> dict[str, Any] | None:
        """The planner's ``upstream_proxy`` input, or None when no endpoint survived."""
        if not self.addresses:
            return None
        return {
            "addresses": list(self.addresses),
            "port": self.ports[0],
            "additional_ports": list(self.ports[1:]),
        }

    @property
    def over_limit(self) -> bool:
        return len(self.addresses) > _MAX_ADDRESSES or len(self.ports) > _MAX_PORTS


def static_upstream_endpoint(upstream: UpstreamProxy) -> Endpoint | None:
    """The host:port of the configured or manual upstream (``http://[user:password@]host:port``), or None."""
    if not upstream.url:
        return None
    try:
        parts = urlsplit(upstream.url)
        host, port = parts.hostname, parts.port
    except ValueError:
        return None
    if not host:
        return None
    return host, port or (443 if parts.scheme == "https" else 80)


def connector_candidates(
    upstream: UpstreamProxy, script: str | None
) -> tuple[tuple[Endpoint, ...], bool]:
    """Every endpoint the connector may need, in first-appearance order, and whether the list may be partial.

    The static upstream, the PAC script's own host, then each proxy the script names. Partial when the script
    builds a proxy name at run time, or when automatic detection is on with no script URL to read.
    """
    found: dict[Endpoint, None] = {}
    static = static_upstream_endpoint(upstream)
    if static is not None:
        found[static] = None
    incomplete = False
    pac = upstream.pac
    if pac is not None:
        if not pac.auto_config_url:
            incomplete = True
        else:
            endpoints = extract_pac_endpoints(pac.auto_config_url, script)
            incomplete = endpoints.incomplete
            if endpoints.pac_host is not None:
                found[endpoints.pac_host] = None
            for proxy in endpoints.proxies:
                found[proxy] = None
    return tuple(found), incomplete


def unreachable_kind(address: ipaddress.IPv4Address | ipaddress.IPv6Address) -> str | None:
    """Why a connector permit for this address is refused, or None. The metadata address is link-local."""
    if address.is_loopback:
        return "loopback"
    if address.is_link_local:
        return "link_local"
    if address.is_unspecified:
        return "unspecified"
    if address.is_multicast:
        return "multicast"
    return None


def resolve_connector_endpoints(
    candidates: tuple[Endpoint, ...], resolve: Resolver
) -> ConnectorEndpoints:
    """Resolves each endpoint to IP literals and drops what the plan refuses, recording the kinds.

    An endpoint with no surviving address contributes no port either, so a refused or unresolvable proxy
    opens nothing.
    """
    addresses: set[ipaddress.IPv4Address | ipaddress.IPv6Address] = set()
    ports: set[int] = set()
    refused: set[str] = set()
    for host, port in candidates:
        survivors: set[ipaddress.IPv4Address | ipaddress.IPv6Address] = set()
        try:
            literals = [host] if _is_literal(host) else resolve(host)
        except OSError:
            refused.add("unresolved")
            continue
        for text in literals:
            try:
                parsed = ipaddress.ip_address(text.partition("%")[0])
            except ValueError:
                refused.add("not_an_address")
                continue
            if isinstance(parsed, ipaddress.IPv6Address) and parsed.ipv4_mapped is not None:
                parsed = parsed.ipv4_mapped
            kind = unreachable_kind(parsed)
            if kind is not None:
                refused.add(kind)
            else:
                survivors.add(parsed)
        if not survivors:
            if not literals:
                refused.add("unresolved")
            continue
        addresses |= survivors
        ports.add(port)
    ordered = sorted(addresses, key=lambda address: (address.version, int(address)))
    return ConnectorEndpoints(
        tuple(str(address) for address in ordered), tuple(sorted(ports)), tuple(sorted(refused))
    )


def _is_literal(host: str) -> bool:
    try:
        ipaddress.ip_address(host.partition("%")[0])
    except ValueError:
        return False
    return True


def system_resolver(host: str) -> list[str]:
    """The host's TCP addresses from the system resolver, in the order it gave them."""
    return [str(info[4][0]) for info in socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)]


def fetch_pac_script(url: str) -> str:
    """The script at ``url``, read directly (never through a proxy), bounded in time and size.

    Raises ``OSError`` for anything that is not a complete script: a scheme other than http(s), a failure,
    or a body over the bound.
    """
    if urlsplit(url).scheme not in ("http", "https"):
        raise OSError("the PAC URL is not http or https")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(url, timeout=_PAC_FETCH_TIMEOUT_SECONDS) as response:  # noqa: S310 - scheme checked above
        body = response.read(_PAC_SCRIPT_MAX_BYTES + 1)
    if len(body) > _PAC_SCRIPT_MAX_BYTES:
        raise OSError("the PAC script is over the size bound")
    return body.decode("utf-8", errors="replace")


def read_host_policy_state() -> Mapping[str, Any] | None:
    """The host evidence the enforcing plan needs, as far as an unelevated process can read it.

    The filtering engine's state and the IPv4 TCP dynamic range are read here. Other sublayers at our weight are
    not readable without the elevation the broker already has, so none is claimed; the broker re-verifies all four
    preconditions against the engine before it writes anything, and that check is the authoritative one.
    """
    try:
        dynamic = tcp_dynamic_port_range()
    except RuntimeError:
        return None
    return {
        "base_filtering_engine_running": _filtering_engine_running(),
        "tcp_dynamic_port_ranges": [
            {"address_family": "ipv4", "first": dynamic.start, "last": dynamic.stop - 1}
        ],
        "other_sublayers_at_our_weight": [],
    }


def _filtering_engine_running() -> bool:
    sc = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "sc.exe"
    try:
        completed = subprocess.run(
            [str(sc), "query", "BFE"],
            capture_output=True,
            timeout=_SC_TIMEOUT_SECONDS,
            check=True,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.SubprocessError):
        return False
    # The state is a number and a word on one line; the number is not localized, the word may be.
    return any(
        line.strip().startswith("STATE") and ": 4 " in line + " "
        for line in completed.stdout.decode("ascii", errors="replace").splitlines()
    )


def build_plan_inputs(
    upstream: UpstreamProxy,
    *,
    fetch_script: ScriptFetcher = fetch_pac_script,
    resolve: Resolver = system_resolver,
    read_evidence: EvidenceReader = read_host_policy_state,
) -> WfpPlanInputs:
    """The enforcing plan's inputs for one upstream decision, or the typed reason they cannot be had."""
    script: str | None = None
    pac = upstream.pac
    if pac is not None and pac.auto_config_url:
        try:
            script = fetch_script(pac.auto_config_url)
        except OSError:
            return WfpPlanInputs(mode="enforcing", skip_reason="pac_script_unavailable")
    candidates, incomplete = connector_candidates(upstream, script)
    if incomplete:
        return WfpPlanInputs(mode="enforcing", skip_reason="pac_endpoints_incomplete")
    endpoints = resolve_connector_endpoints(candidates, resolve)
    if endpoints.over_limit:
        return WfpPlanInputs(mode="enforcing", skip_reason="connector_endpoints_over_limit")
    if candidates and not endpoints.addresses:
        return WfpPlanInputs(mode="enforcing", skip_reason="connector_endpoints_unreachable")
    evidence = read_evidence()
    if evidence is None:
        # read_host_policy_state returns None only when the host's dynamic range cannot be read.
        return WfpPlanInputs(mode="enforcing", skip_reason="loopback_dynamic_range_unavailable")
    return WfpPlanInputs(
        mode="enforcing", upstream_proxy=endpoints.upstream_proxy(), host_policy_state=evidence
    )


_upstream_reader: Callable[[], UpstreamProxy] | None = None
_cached: tuple[float, WfpPlanInputs] | None = None


def use_upstream_reader(reader: Callable[[], UpstreamProxy] | None) -> None:
    """Registers where the enforcing plan reads this start's upstream decision. Nothing else reads it."""
    global _upstream_reader, _cached
    _upstream_reader = reader
    _cached = None


def current_plan_inputs(
    env: Mapping[str, str] | None = None,
    *,
    clock: Callable[[], float] = time.monotonic,
    build: Callable[[UpstreamProxy], WfpPlanInputs] = build_plan_inputs,
) -> WfpPlanInputs:
    """The inputs for this process: permissive without touching anything, or the enforcing ones, cached briefly.

    The cache is for the few plan builds one start makes (the due check, the install, the readback). It is short
    on purpose: a DNS change is a plan change, and the next start must see it.
    """
    global _cached
    if wfp_plan_mode(os.environ if env is None else env) != "enforcing":
        return WfpPlanInputs()
    now = clock()
    if _cached is not None and now < _cached[0]:
        return _cached[1]
    if _upstream_reader is None:
        return WfpPlanInputs(mode="enforcing", skip_reason="upstream_decision_unavailable")
    inputs = build(_upstream_reader())
    _cached = (now + _RESOLVED_INPUTS_TTL_SECONDS, inputs)
    return inputs
