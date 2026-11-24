"""Pure helpers for LRM inference-servers read endpoints.

Read-only, live: list, logs, probes. No lifecycle actions here.
- Roles: ``chat`` and ``embedding`` (the two role facades over the shared
  :class:`~llmrouter_manager.local.supervisor.RouterSupervisor`).
- ``list`` / ``probes`` reflect the supervisor's per-role snapshot; a
  never-started supervisor reports ``state="stopped"`` with all optional
  fields ``None``.
- Logs: reads from ``LRM_LOG_DIR`` env var or ``default_state_root().parent / "logs"``;
  missing file returns empty lines. ``tail`` is clamped to 1–1000, default 100.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from ..common.state import default_state_root
from .llama_metrics import scrape_llama_metrics

VALID_ROLES: tuple[str, ...] = ("chat", "embedding")

_TAIL_DEFAULT = 100
_TAIL_MAX = 1000


# ---------------------------------------------------------------------------
# list
# ---------------------------------------------------------------------------


def list_servers(app_state: Any) -> list[dict[str, Any]]:
    """Return the live per-role snapshot from the router supervisor.

    Maps the supervisor's ``role_snapshot`` shape onto the public wire shape
    (``uptime`` → ``uptime_seconds``, dropping the internal
    ``restart_attempts`` / ``last_error`` / ``log_path`` fields). A
    never-started supervisor yields ``state="stopped"`` with the nullable
    fields all ``None``.
    """
    supervisor = app_state.supervisor
    servers: list[dict[str, Any]] = []
    for role in VALID_ROLES:
        snap = supervisor[role].snapshot()
        servers.append(
            {
                "role": snap["role"],
                "state": snap["state"],
                "model_id": snap["model_id"],
                "port": snap["port"],
                "pid": snap["pid"],
                "uptime_seconds": snap["uptime"],
            }
        )
    return servers


# ---------------------------------------------------------------------------
# logs
# ---------------------------------------------------------------------------


def _log_dir() -> Path:
    env = os.environ.get("LRM_LOG_DIR")
    if env:
        return Path(env)
    return default_state_root().parent / "logs"


def _clamp_tail(n: int) -> int:
    return max(1, min(n, _TAIL_MAX))


def get_server_logs(role: str, tail: int = _TAIL_DEFAULT) -> dict[str, Any]:
    """Return the last ``tail`` (clamped) lines from the role's log file."""
    clamped = _clamp_tail(tail)
    log_file = _log_dir() / f"llama-{role}.log"
    try:
        text = log_file.read_text(encoding="utf-8", errors="replace")
    except FileNotFoundError:
        return {"lines": [], "tail": clamped}

    all_lines = [ln for ln in text.splitlines() if ln]
    return {"lines": all_lines[-clamped:], "tail": clamped}


# ---------------------------------------------------------------------------
# probes
# ---------------------------------------------------------------------------


def get_server_probes(role: str, app_state: Any) -> dict[str, Any]:
    """Return a live probe response derived from the supervisor snapshot.

    ``healthy`` is ``True`` only when the role's llama-server is serving
    (``state == "ready"``); ``status`` echoes the raw role state so a
    starting / rerouted / errored server is distinguishable from stopped.
    """
    snap = app_state.supervisor[role].snapshot()
    state = snap["state"]
    result: dict[str, Any] = {"role": role, "healthy": state == "ready", "status": state}
    model_id = snap.get("model_id")
    port = snap.get("port")
    if state != "ready":
        result["metrics_status"] = "unavailable"
        result["metrics_error"] = "server not ready"
        return result
    if not isinstance(model_id, str) or not model_id:
        result["metrics_status"] = "unavailable"
        result["metrics_error"] = "missing model id"
        return result
    if not isinstance(port, int):
        result["metrics_status"] = "unavailable"
        result["metrics_error"] = "missing port"
        return result

    try:
        result["metrics"] = scrape_llama_metrics(f"http://127.0.0.1:{port}", model_id=model_id)
        result["metrics_status"] = "ready"
    except Exception as exc:  # noqa: BLE001
        result["metrics_status"] = "error"
        result["metrics_error"] = type(exc).__name__
    return result
