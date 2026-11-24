"""The host's upstream proxy, read once per start for the egress proxy, the Connector and D4 (#78).

What was configured explicitly - per variable, the config store's override, then this process's
environment - comes before the Windows user's manual proxy setting, which comes before none. The system setting is read as
the owner through `WinHttpGetIEProxyConfigForCurrentUser`, the same settings browsers use: a tier account
has no profile to read it from. Whatever the source, the answer is held to one set of rules: an
`http://host:port` upstream (`egress_proxy.upstream_unsupported_kind`), the bypass grammar of
`local_proxy_bypass` (`egress_bypass`), and a typed refusal rather than a direct connection when the
configuration cannot be followed.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
import os
import re

from loguru import logger

from .egress_bypass import local_proxy_bypass
from .egress_proxy import upstream_unsupported_kind
from .pac_resolver import PacConfig

_CONFIGURED_VARIABLES = ("HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY")
# WinINET's own port for a manual proxy entry that names none.
_DEFAULT_SYSTEM_PROXY_PORT = 80
_IPV4_WILDCARD = re.compile(r"(\d{1,3}(?:\.\d{1,3}){0,2})\.\*")


@dataclass(frozen=True)
class SystemProxySettings:
    """The current user's WinINET settings, as WinHTTP reports them."""

    auto_detect: bool
    auto_config_url: str | None
    proxy: str | None
    bypass: str | None


@dataclass(frozen=True)
class UpstreamProxy:
    source: str
    """`configured`, `system` or `none`."""
    url: str | None
    """`http://[user:password@]host:port` when there is an upstream the egress proxy can chain through."""
    unsupported: str | None
    """The kind recorded for an upstream that is credentialed or cannot be followed. A warning in log_only:
    credentialed is chained through, the rest are tunnelled direct and audited; strict refusal is EG2-11."""
    no_proxy: str
    """The loopback entries, the internal ranges, then each bypass entry in the grammar."""
    dropped_bypass_entries: int
    pac: PacConfig | None = None
    """The system script and/or automatic detection, resolved per target by the egress proxy; set beside
    `url` too, which then is the manual proxy Windows keeps as the script's fallback."""

def resolve_upstream(
    setting: Callable[[str], str | None], system: SystemProxySettings | None
) -> UpstreamProxy:
    """One upstream from `setting` (the configured value of a variable) or, failing that, `system`.

    Precedence is per variable, in `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY` order, and `setting` answers
    each from the config store before the environment: so an `HTTPS_PROXY` in the environment comes
    before an `HTTP_PROXY` in the store, as in the container backend.

    With both an auto-config script and a manual proxy set, Windows uses the script and keeps the manual
    proxy as its fallback: `pac` carries the script (and automatic detection) for the egress proxy to
    evaluate per target, and `url` the manual proxy it falls back to. The Connector still takes `url`.
    """
    for name in _CONFIGURED_VARIABLES:
        value = setting(name)
        if value:
            no_proxy, dropped = local_proxy_bypass(setting("NO_PROXY"))
            kind = upstream_unsupported_kind(value)
            return UpstreamProxy(
                "configured", value if kind in (None, "credentials") else None, kind, no_proxy, dropped
            )
    if system is not None:
        pac = (
            PacConfig(system.auto_config_url, system.auto_detect)
            if system.auto_config_url or system.auto_detect
            else None
        )
        candidate = _manual_proxy(system.proxy)
        if candidate is None and system.auto_config_url:
            no_proxy, dropped = local_proxy_bypass(None)
            return UpstreamProxy("system", None, "proxy_auto_config", no_proxy, dropped, pac)
        if candidate is not None:
            no_proxy, dropped = local_proxy_bypass(",".join(_bypass_entries(system.bypass)))
            dropped += _untranslatable_bypass_entries(system.bypass)
            kind = upstream_unsupported_kind(candidate)
            return UpstreamProxy(
                "system",
                candidate if kind in (None, "credentials") else None,
                kind,
                no_proxy,
                dropped,
                pac,
            )
        no_proxy, dropped = local_proxy_bypass(None)
        return UpstreamProxy("none", None, None, no_proxy, dropped, pac)
    no_proxy, dropped = local_proxy_bypass(None)
    return UpstreamProxy("none", None, None, no_proxy, dropped)


def _manual_proxy(value: str | None) -> str | None:
    """The one upstream a manual setting names, as a URL: its https entry, else its http one, else the
    entry for every protocol. A setting with only a SOCKS entry names that, so it is refused rather
    than read as no proxy; one with only an FTP entry names no web proxy at all."""
    entries = [entry.strip() for entry in (value or "").split(";") if entry.strip()]
    if not entries:
        return None
    by_protocol = {}
    for entry in entries:
        protocol, separator, server = entry.partition("=")
        if separator:
            by_protocol[protocol.strip().lower()] = server.strip()
    if not by_protocol:
        server = entries[0]
    else:
        # An entry the user cleared (`https=`) is no entry at all.
        server = by_protocol.get("https") or by_protocol.get("http") or ""
        if not server:
            socks = by_protocol.get("socks")
            return f"socks://{socks}" if socks else None
    if "://" in server:
        return server
    host, separator, port = server.rpartition(":")
    if not separator or not port.isdigit():
        return f"http://{server}:{_DEFAULT_SYSTEM_PROXY_PORT}"
    return f"http://{host}:{port}"


def _split_bypass(value: str | None) -> list[str]:
    return [entry for entry in re.split(r"[;\s]+", value or "") if entry]


def _bypass_entry(entry: str) -> str | None:
    """A manual bypass entry in `NO_PROXY` form, or None for one that has no such form."""
    if entry.lower() == "<local>":
        # One-label names, which the bypass grammar refuses: an entry for them would send a whole
        # top-level domain around the proxy in curl, Python and Go.
        return None
    if entry.startswith("*."):
        return entry[1:]
    wildcard = _IPV4_WILDCARD.fullmatch(entry)
    if wildcard:
        octets = wildcard.group(1).split(".")
        prefix = 8 * len(octets)
        return ".".join(octets + ["0"] * (4 - len(octets))) + f"/{prefix}"
    if "*" in entry:
        return None
    return entry


def _bypass_entries(value: str | None) -> list[str]:
    return [translated for translated in map(_bypass_entry, _split_bypass(value)) if translated]


def _untranslatable_bypass_entries(value: str | None) -> int:
    return sum(_bypass_entry(entry) is None for entry in _split_bypass(value))


def read_system_proxy() -> SystemProxySettings | None:
    """The current user's proxy settings, or None where there are none to read.

    Not elevated and not the tier's: the Sandbox Manager runs as the owner, whose settings these are.
    """
    if os.name != "nt":
        return None
    import ctypes  # noqa: PLC0415
    from ctypes import wintypes  # noqa: PLC0415

    class _IeProxyConfig(ctypes.Structure):
        _fields_ = [
            ("fAutoDetect", wintypes.BOOL),
            ("lpszAutoConfigUrl", ctypes.c_void_p),
            ("lpszProxy", ctypes.c_void_p),
            ("lpszProxyBypass", ctypes.c_void_p),
        ]

    winhttp = ctypes.WinDLL("winhttp", use_last_error=True)  # type: ignore[attr-defined]
    winhttp.WinHttpGetIEProxyConfigForCurrentUser.argtypes = [ctypes.POINTER(_IeProxyConfig)]
    winhttp.WinHttpGetIEProxyConfigForCurrentUser.restype = wintypes.BOOL
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)  # type: ignore[attr-defined]
    kernel32.GlobalFree.argtypes = [ctypes.c_void_p]
    kernel32.GlobalFree.restype = ctypes.c_void_p

    config = _IeProxyConfig()
    if not winhttp.WinHttpGetIEProxyConfigForCurrentUser(ctypes.byref(config)):
        # The code only: a setting's value may carry a password, and there is none to quote anyway.
        logger.warning(
            "native-backend: the user's proxy settings could not be read error={}; read as no setting",
            ctypes.get_last_error(),
        )
        return None
    values = []
    for pointer in (config.lpszAutoConfigUrl, config.lpszProxy, config.lpszProxyBypass):
        values.append(ctypes.wstring_at(pointer) or None if pointer else None)
        if pointer:
            kernel32.GlobalFree(pointer)
    auto_config_url, proxy, bypass = values
    return SystemProxySettings(bool(config.fAutoDetect), auto_config_url, proxy, bypass)
