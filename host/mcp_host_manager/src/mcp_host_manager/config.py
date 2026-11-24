"""Runtime config for mcp_host_manager, built from argv and the ServiceHub-injected environment."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

STATE_DIR_ENV = "MCP_HOST_MANAGER_STATE_DIR"


def default_state_dir() -> Path:
    """``MCP_HOST_MANAGER_STATE_DIR``, else ``%LOCALAPPDATA%\\SuperClaw\\mcp_host_manager``.

    Never under a workspace: the registry holds the commands the host runs, and a tier can write
    its workspace.
    """
    override = os.environ.get(STATE_DIR_ENV)
    if override:
        return Path(override)
    local_app_data = os.environ.get("LOCALAPPDATA")
    base = Path(local_app_data) if local_app_data else Path.home() / "AppData" / "Local"
    return base / "SuperClaw" / "mcp_host_manager"


@dataclass(frozen=True)
class RuntimeConfig:
    host: str
    port: int
    service_name: str
    instance_id: str
    process_credential: str
    state_dir: Path
