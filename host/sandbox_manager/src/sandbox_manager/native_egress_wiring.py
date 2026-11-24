"""What the Sandbox Manager hands the egress proxy and the Connector, and how it waits for the proxy.

One upstream decision (`upstream_proxy.resolve_upstream`, read once per start) feeds the proxy's sealed
configuration, the Connector's provider configuration and the bypass list bound to the shell and the
router, so the three never disagree about which proxy the host uses. An upstream the host names and
nothing here can follow is recorded by kind; in log_only the proxy tunnels such connections direct, as
before the proxy existed, and audits the route. The Connector is unaffected by the kind.

Leaf module of `native_backend`; contract: `Sandbox` / `OperationRun` egress wiring (design 6.4, EG2-2).
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping
import base64
import hashlib
import hmac
import socket
import time
from typing import Any

from contracts.egress_allowlist_data import EGRESS_ALLOWLIST
from contracts.egress_approval_grant_data import EGRESS_APPROVAL_GRANT_DATA

from .upstream_proxy import UpstreamProxy

# A connect to a loopback port nobody listens on runs to its timeout on Windows instead of failing at
# once, so this sets how often a not-yet-listening proxy is looked at.
LISTENER_PROBE_TIMEOUT_S = 0.05
# The proxy is on the start-up path of every Profile, so its readiness is polled finely.
EGRESS_PROXY_POLL_S = 0.05
# The allowlist carrier each proxy listener serves (contracts `egress-proxy-config.ts`).
_LISTENER_CARRIER = {"shell": "egress_proxy_shell", "channel": "egress_proxy_channel"}
EGRESS_PROXY_DEFAULT_MODE = "log_only"
# Internal switch for tests and local experiments; not a shipped setting. Anything but `enforce` is log_only.
ENV_EGRESS_PROXY_MODE = "SUPERCLAW_NATIVE_EGRESS_PROXY_MODE"


def local_proxy_url(port: int, host: str = "127.0.0.1") -> str:
    """What a file_tool process is told as its proxy: the egress proxy's listener, nothing else."""
    return f"http://{host}:{port}"


def egress_proxy_mode(env: Mapping[str, str]) -> str:
    """`log_only` unless the internal env setting says `enforce` exactly."""
    return "enforce" if env.get(ENV_EGRESS_PROXY_MODE, "").strip() == "enforce" else EGRESS_PROXY_DEFAULT_MODE


def egress_proxy_allowlist(allowlist: Mapping[str, Any] = EGRESS_ALLOWLIST) -> dict[str, list[dict[str, list[Any]]]]:
    """The allowlist contract's entries resolved per proxy listener: the hosts and ports of its carrier.
    Categories carry no hosts and are not part of it."""
    return {
        listener: [
            {"hosts": list(entry["hosts"]), "ports": list(entry["ports"])}
            for entry in allowlist["entries"]
            if entry["carrier"] == carrier
        ]
        for listener, carrier in _LISTENER_CARRIER.items()
    }


def egress_proxy_session_key(caller_key_b64: str) -> str:
    """The key a command's proxy credential is minted and verified with (contract `egress-proxy-approval.ts`):
    HMAC-SHA256 of the Connector's caller key under a fixed label, unpadded base64url. Derived, so the
    caller key itself is never the proxy's secret; the proxy is sealed this and nothing in a shell's
    environment holds it."""
    key = hmac.new(
        base64.b64decode(caller_key_b64),
        EGRESS_APPROVAL_GRANT_DATA["proxy_rules"]["key_label"].encode("utf-8"),
        hashlib.sha256,
    ).digest()
    return base64.urlsafe_b64encode(key).rstrip(b"=").decode("ascii")


def egress_proxy_config(
    decision: UpstreamProxy,
    audit_log: str,
    mode: str = EGRESS_PROXY_DEFAULT_MODE,
    allowlist: Mapping[str, Any] = EGRESS_ALLOWLIST,
    approval: Mapping[str, str] | None = None,
    session_key: str | None = None,
) -> dict[str, Any]:
    """The egress proxy's sealed configuration (contract `EgressProxyConfig`): where it audits, the one
    upstream (credentials stay in this sealed file), the kind recorded for it, the PAC/WPAD setting it
    resolves per target, the mode and the allowlist resolved per listener. The PAC URL lives here only: it
    names an internal host and may carry a credential, so no log line has it.

    `approval` and `session_key` (EG2-4b) are written only in enforce mode, and only together: they make the
    shell listener ask the user about an unlisted destination instead of refusing it."""
    config: dict[str, Any] = {
        "audit": {"path": audit_log},
        "upstream": decision.url,
        "upstream_unsupported": decision.unsupported,
        "pac": (
            {"auto_config_url": decision.pac.auto_config_url, "auto_detect": decision.pac.auto_detect}
            if decision.pac is not None
            else None
        ),
        "mode": mode,
        "allowlist": egress_proxy_allowlist(allowlist),
    }
    if mode == "enforce" and approval is not None and session_key is not None:
        config["approval"] = dict(approval)
        config["session_key"] = session_key
    return config


def connector_proxy_env(
    decision: UpstreamProxy, configured_env: Callable[[], dict[str, str]]
) -> dict[str, str]:
    """The proxy variables the Connector runs with.

    A proxy the host configured keeps the Connector's established variables (`configured_env`); one that
    only the user's Windows setting names becomes the same variables, so the Connector chains through
    what the egress proxy chains through. With none, or one that cannot be followed, the Connector gets
    no variable, which is what the Connector got before the egress proxy existed.
    """
    if decision.source == "configured":
        return configured_env()
    if decision.source == "system" and decision.url is not None:
        return {
            "HTTPS_PROXY": decision.url,
            "https_proxy": decision.url,
            "HTTP_PROXY": decision.url,
            "http_proxy": decision.url,
            "NO_PROXY": decision.no_proxy,
            "no_proxy": decision.no_proxy,
        }
    return {}


def loopback_listener_accepts(port: int) -> bool:
    """Whether something accepts on 127.0.0.1:`port`. A probe sends nothing, so nothing is audited."""
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=LISTENER_PROBE_TIMEOUT_S):
            return True
    except OSError:
        return False


def wait_for_listeners(
    ports: Iterable[int | None],
    *,
    process_alive: Callable[[], bool],
    check_shutdown: Callable[[], None],
    timeout_s: float,
) -> None:
    """Return once every port accepts; raise if the process exits first or `timeout_s` passes."""
    wanted = tuple(ports)
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        check_shutdown()
        if not process_alive():
            raise RuntimeError("egress proxy exited before readiness")
        if all(port is not None and loopback_listener_accepts(port) for port in wanted):
            return
        time.sleep(EGRESS_PROXY_POLL_S)
    raise RuntimeError("egress proxy did not become ready in time")
