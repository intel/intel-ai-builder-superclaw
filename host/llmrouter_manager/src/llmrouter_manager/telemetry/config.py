"""Telemetry desired-config persistence for llmrouter_manager."""

from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..common.state import default_state_root, write_json_atomic, read_json


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _path() -> Path:
    return default_state_root() / "telemetry.json"


def _default_exporter_endpoint() -> str | None:
    endpoint = (os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT") or "").strip()
    if not endpoint:
        return None
    return endpoint.rstrip("/")


def _is_loopback_endpoint(endpoint: str | None) -> bool:
    """True only when the endpoint targets a loopback address (local dev collector)."""
    if not endpoint:
        return False
    import ipaddress
    from urllib.parse import urlparse
    host = (urlparse(endpoint).hostname or "").lower()
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def default_config() -> dict[str, object]:
    default_endpoint = _default_exporter_endpoint()
    default_debug_traces = default_endpoint is not None
    return {
        "enabled": default_debug_traces,
        "traces": {"enabled": default_debug_traces, "sample_ratio": 1.0},
        "metrics": {"enabled": False, "export_interval_ms": 10000},
        "logs": {"enabled": False, "level": "info"},
        "exporter": {
            "kind": "otlp_http",
            "endpoint": default_endpoint,
            "intranet_server": _is_loopback_endpoint(default_endpoint),
        },
    }


def _default_record() -> dict[str, object]:
    return {
        "config": default_config(),
        "runtime": {"last_applied_at": None},
    }


def load_record() -> dict[str, object]:
    payload = read_json(_path())
    if not isinstance(payload, dict):
        return _default_record()

    config = payload.get("config")
    runtime = payload.get("runtime")
    if not isinstance(config, dict) or not isinstance(runtime, dict):
        return _default_record()

    last_applied_at = runtime.get("last_applied_at")
    if last_applied_at is not None and not isinstance(last_applied_at, str):
        last_applied_at = None

    return {
        "config": config,
        "runtime": {"last_applied_at": last_applied_at},
    }


def load_config() -> dict[str, object]:
    record = load_record()
    config = record.get("config")
    if isinstance(config, dict):
        return config
    return default_config()


def load_last_applied_at() -> str | None:
    record = load_record()
    runtime = record.get("runtime")
    if not isinstance(runtime, dict):
        return None
    value = runtime.get("last_applied_at")
    return value if isinstance(value, str) else None


def put_config(config: dict[str, Any]) -> None:
    write_json_atomic(
        _path(),
        {
            "config": config,
            "runtime": {"last_applied_at": _utc_now_iso()},
        },
    )
