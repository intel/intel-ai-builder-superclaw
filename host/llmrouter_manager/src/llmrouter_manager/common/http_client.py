"""HTTP client helpers with CIDR-aware proxy bypass for private targets.

httpx inherits proxy env vars, but Python's standard proxy-bypass handling does
not reliably honor CIDR-shaped ``NO_PROXY`` entries such as ``10.0.0.0/8``.
LRM talks to private edge / local endpoints frequently, so we resolve proxies
ourselves and force direct connections for private targets.

Bypass sources, in order (any match → direct connection, no proxy):
  1. private/loopback target IP (``_is_private_host``)
  2. ``NO_PROXY`` env tokens (exact host, ``.suffix``, or CIDR)
  3. the configured edge endpoint host when its ``bypass_proxy`` flag is set
     (``_edge_bypass_host``) — replicates the legacy "bypass HTTP proxy"
     checkbox so an intranet edge server reached by hostname is not routed
     through (and 403'd by) the corporate proxy.

``_PUBLIC_HOST_SUFFIXES`` overrides all of the above: our own AWS-hosted
endpoints carry an ``intel.com`` DNS name but are public, so the corporate
``NO_PROXY=.intel.com`` must not force a blocked direct connection to them.

Proxy env can also be present but unusable (a host off the corporate network),
so :func:`proxy_routes` offers both routes to callers that can retry.
"""

from __future__ import annotations

import ipaddress
import os
import urllib.parse
from typing import Any

import httpx

from .env_resolve import tls_verify


_PRIVATE_CIDRS = tuple(
    ipaddress.ip_network(raw)
    for raw in (
        "127.0.0.0/8",
        "10.0.0.0/8",
        "172.16.0.0/12",
        "192.168.0.0/16",
        "169.254.0.0/16",
        "::1/128",
        "fc00::/7",
        "fe80::/10",
    )
)

# Public AWS endpoints that carry an intel.com DNS name but are not internal.
# Suffix-matched (the domain plus any subdomain): the family spans models/CDN,
# telemetry, feedback and staging, and listing them one at a time means another
# corporate-host outage every time a new one is missed.
_PUBLIC_HOST_SUFFIXES: tuple[str, ...] = ("aibuilder.intel.com",)


def _is_public_host(host: str) -> bool:
    normalized = (host or "").strip().lower().strip("[]")
    if not normalized:
        return False
    return any(
        normalized == suffix or normalized.endswith(f".{suffix}")
        for suffix in _PUBLIC_HOST_SUFFIXES
    )


def _is_private_host(host: str) -> bool:
    normalized = (host or "").strip().lower().strip("[]")
    if not normalized:
        return False
    if normalized in {"localhost", "host.docker.internal"}:
        return True
    try:
        ip = ipaddress.ip_address(normalized)
    except ValueError:
        return normalized.endswith(".local")
    return any(ip in network for network in _PRIVATE_CIDRS)


def _parse_no_proxy_tokens() -> list[str]:
    raw = os.environ.get("NO_PROXY") or os.environ.get("no_proxy") or ""
    return [token.strip().lower() for token in raw.split(",") if token.strip()]


def _matches_no_proxy(host: str, token: str) -> bool:
    if token == "*":
        return True

    host_only = host.strip().lower().strip("[]")
    token_only = token.strip().lower()
    if not host_only or not token_only:
        return False

    if token_only.startswith("."):
        bare = token_only[1:]
        return host_only == bare or host_only.endswith(token_only)

    if "/" in token_only:
        try:
            return ipaddress.ip_address(host_only) in ipaddress.ip_network(token_only, strict=False)
        except ValueError:
            return False

    return host_only == token_only


def _edge_bypass_host() -> str | None:
    """Return the edge host to bypass the proxy for, or None.

    Mirrors the legacy "bypass HTTP proxy" checkbox (default on): when the user
    configures an edge endpoint with ``bypass_proxy`` set, its host must skip
    the corporate proxy — intranet edge servers (reached by a hostname that may
    resolve to a changing private IP) are otherwise 403'd by the proxy.

    Read fresh per call (edge config hot-reloads; no restart on connect/swap).
    Imported lazily to avoid a ``common -> edge`` import at module load.
    """
    try:
        from ..edge import config as edge_config  # local import: avoid cycle

        cfg = edge_config.get()
    except Exception:
        return None
    if not isinstance(cfg, dict):
        return None
    if not cfg.get("bypass_proxy", edge_config.DEFAULT_BYPASS_PROXY):
        return None
    base_url = cfg.get("base_url")
    if not isinstance(base_url, str) or not base_url:
        return None
    return urllib.parse.urlparse(base_url).hostname or None


def should_bypass_proxy(url: str, *, force_bypass: bool | None = None) -> bool:
    """Return True when the proxy should be skipped for ``url``.

    ``force_bypass`` is an explicit override for callers that already know the
    user's intent but cannot rely on saved state — notably the Connect-Edge
    "Test Connection" probe, which runs BEFORE the edge config is saved (so
    ``_edge_bypass_host`` can't see it yet). ``True`` forces a direct
    connection; ``False`` forces proxy use; ``None`` (default) uses the normal
    auto-detection below.
    """
    if force_bypass is not None:
        return force_bypass
    parsed = urllib.parse.urlparse(url)
    host = parsed.hostname or ""
    if _is_public_host(host):
        return False
    if _is_private_host(host):
        return True
    if any(_matches_no_proxy(host, token) for token in _parse_no_proxy_tokens()):
        return True
    # Honor the user's per-edge "bypass HTTP proxy" choice (default on) even
    # when the edge host is a public-looking hostname that resolves to an
    # intranet IP and isn't listed in NO_PROXY.
    edge_host = _edge_bypass_host()
    if edge_host and host and host.strip().lower().strip("[]") == edge_host.strip().lower().strip("[]"):
        return True
    return False


def _proxy_for_scheme(scheme: str) -> str | None:
    if scheme == "https":
        return os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy") or os.environ.get("HTTP_PROXY") or os.environ.get("http_proxy")
    if scheme == "http":
        return os.environ.get("HTTP_PROXY") or os.environ.get("http_proxy")
    return None


def resolve_httpx_proxy(url: str, *, force_bypass: bool | None = None) -> str | None:
    parsed = urllib.parse.urlparse(url)
    if should_bypass_proxy(url, force_bypass=force_bypass):
        return None
    return _proxy_for_scheme(parsed.scheme.lower())


def proxy_routes(url: str) -> list[bool]:
    """``force_bypass`` values to try for *url*, preferred route first.

    Proxy env outlives the network it describes: a host carried off the corporate
    network still advertises a proxy that no longer answers, and a transfer that
    only honors the preferred route hangs there with zero bytes. So offer the
    other route as a fallback — unless no proxy is configured, where both routes
    would be the same direct connection.
    """
    if _proxy_for_scheme(urllib.parse.urlparse(url).scheme.lower()) is None:
        return [True]
    preferred = should_bypass_proxy(url)
    return [preferred, not preferred]


def build_async_client_for_url(
    url: str, *, force_bypass: bool | None = None, **kwargs: Any
) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        verify=tls_verify(),
        trust_env=False,
        proxy=resolve_httpx_proxy(url, force_bypass=force_bypass),
        **kwargs,
    )


def build_client_for_url(
    url: str, *, force_bypass: bool | None = None, **kwargs: Any
) -> httpx.Client:
    return httpx.Client(
        verify=tls_verify(),
        trust_env=False,
        proxy=resolve_httpx_proxy(url, force_bypass=force_bypass),
        **kwargs,
    )
