"""Local-LLM runtime configuration for llmrouter_manager.

Re-homes the fields ``backend_manager``'s ``Config`` exposed for the local
subsystem onto LRM conventions: ``LRM_*`` env vars + the per-user state root
from :mod:`llmrouter_manager.common.state`.

Backend-manager kept everything under ``%LOCALAPPDATA%/SuperClaw/scbms``; LRM
keeps its local artifacts as siblings of the DPAPI state root, i.e. under
``%LOCALAPPDATA%/SuperClaw/llmrouter_manager/`` (``default_state_root()`` is the
``state`` subdir; ``.parent`` is that service base).

The llama-server binary is deliberately **not** a field here: it is resolved
fail-fast at spawn time via :func:`llmrouter_manager.local.paths.llama_server_exe`
(raises a clear error listing searched paths), so constructing a ``LocalConfig``
never touches the filesystem and works in unit tests without the bundle.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from ..common.state import default_state_root

_DEFAULT_LLAMA_ROUTER_PORT = 18103
# Decision #5 (2026-07-07 restore plan): LRM reaches llama-server on loopback;
# sandbox roles never reach it directly, so 127.0.0.1 (not 0.0.0.0) is the
# bind host and the old llama-server firewall rule is unnecessary.
_DEFAULT_LLAMA_BIND_HOST = "127.0.0.1"
_DEFAULT_HF_ENDPOINT = "https://huggingface.co"


def _service_base() -> Path:
    """``%LOCALAPPDATA%/SuperClaw/llmrouter_manager/`` (parent of the state root)."""
    return default_state_root().parent


@dataclass(frozen=True)
class LocalConfig:
    """Resolved paths + knobs for the local llama-server subsystem."""

    llama_bind_host: str
    llama_router_port: int
    hf_endpoint: str
    model_registry_override: Path | None
    data_dir: Path
    models_dir: Path
    llama_log_dir: Path
    registry_dir: Path


def load_local_config(env: dict[str, str] | None = None) -> LocalConfig:
    """Build a :class:`LocalConfig` from the environment + state root.

    Pure: reads env and computes paths but does not create directories or probe
    the filesystem. Consumers ``mkdir(parents=True, exist_ok=True)`` when they
    actually write.
    """
    env = env if env is not None else dict(os.environ)

    data_dir = _service_base()

    models_raw = env.get("LRM_MODEL_DIR")
    models_dir = Path(models_raw) if models_raw else data_dir / "models"

    logs_raw = env.get("LRM_LOG_DIR")
    logs_root = Path(logs_raw) if logs_raw else data_dir / "logs"

    override_raw = env.get("LRM_MODEL_REGISTRY_OVERRIDE")
    override = Path(override_raw) if override_raw else None

    try:
        router_port = int(env.get("LLAMA_ROUTER_PORT", _DEFAULT_LLAMA_ROUTER_PORT))
    except ValueError:
        router_port = _DEFAULT_LLAMA_ROUTER_PORT

    return LocalConfig(
        llama_bind_host=env.get("LLAMA_BIND_HOST") or _DEFAULT_LLAMA_BIND_HOST,
        llama_router_port=router_port,
        hf_endpoint=env.get("HF_ENDPOINT") or _DEFAULT_HF_ENDPOINT,
        model_registry_override=override,
        data_dir=data_dir,
        models_dir=models_dir,
        llama_log_dir=logs_root / "llama-server",
        registry_dir=data_dir / "registry",
    )
