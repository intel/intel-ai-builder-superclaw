"""Process-wide configuration.

All ENV reads happen when :func:`load_config` is called, from the ``env``
mapping passed to it (defaulting to ``os.environ``); each call re-reads the
environment.
Tests should construct :class:`Config` directly and inject it via
``app.state.config`` instead of mutating environment variables.

ENV reference (see ``tasks/model_manager_todo.md`` §0.2):

Shared / model-manager
* (control-plane port comes from the ``--port`` CLI flag, not an env var;
  ServiceHub assigns it from ``service_cfg.json``)
* ``SANDBOX_MANAGER_HOST``                 default ``127.0.0.1`` (control-plane
  bind address; the ``--host`` CLI flag overrides it).  Set ``127.0.0.1`` to
  restrict it to host loopback only; ServiceHub always passes
  ``--host 127.0.0.1``.
* ``SANDBOX_MANAGER_DATA_DIR``             default ``%LOCALAPPDATA%\\SuperClaw\\sandbox_manager``
* ``SANDBOX_MANAGER_LOG_DIR``              default ``<DATA_DIR>\\logs``
* ``HF_ENDPOINT``                          default ``https://huggingface.co``

SANDBOX (native backend) — JSON-configured via ``sandbox.default.json``
* ``SANDBOX_CONFIG``    optional path to a JSON file that overrides the bundled
                     ``data/sandbox.default.json``.  If unset, the runtime also
                     checks ``<DATA_DIR>/sandbox.json`` before falling back to the
                     bundled default.  All SANDBOX knobs live in that JSON; no
                     individual ENV variables are defined for SANDBOX settings.
                     Keys this version does not read are ignored, so an older
                     override file still loads.

JSON schema (see ``data/sandbox.default.json`` for the full example):
  sandbox_port              int   the native OpenWork server's loopback port
  workspace_container_path  str   the runtime-side workspace path reported by
                                  ``GET /agent/sandbox/config`` (default: ``/workspace``)
"""

from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


# ---- Shared defaults -------------------------------------------------------

_DEFAULT_HF_ENDPOINT = "https://huggingface.co"
_DEFAULT_PORT = 18821
# Control-plane bind address for standalone dev runs.  Under ServiceHub the Hub
# always passes ``--host 127.0.0.1``.
_DEFAULT_HOST = "127.0.0.1"


def _get_runtime_data_dir() -> Path:
    """Return the directory containing bundled data/ and inference/ at runtime.

    - Source mode: host/sandbox_manager/ (parents[2] from config.py)
    - Frozen onedir mode: ``sys._MEIPASS`` — the PyInstaller runtime resource
      root. Under PyInstaller 6.x onedir this is the ``_internal`` directory next
      to sandbox-manager.exe, where bundled ``datas`` (e.g. data/) are placed.
      (Pre-6.x onedir put datas next to the exe, so this equalled the exe dir;
      ``_MEIPASS`` is correct for both layouts.)
    """
    if getattr(sys, "frozen", False):
        # PyInstaller sets sys._MEIPASS to the bundled-resource root; fall back to
        # the exe directory only if it is somehow unset.
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    # Source: config.py is at host/sandbox_manager/src/sandbox_manager/config.py
    # parents[2] = host/sandbox_manager
    return Path(__file__).resolve().parents[2]


def _bundled_sandbox_json() -> Path:
    """Return the path to the bundled SANDBOX default JSON (ships with the package)."""
    return _get_runtime_data_dir() / "data" / "sandbox.default.json"


def _default_data_dir() -> Path:
    base = os.environ.get("LOCALAPPDATA")
    if not base:
        # Fallback for non-Windows test runners — never used in production
        base = str(Path.home() / ".local" / "share")
    return Path(base) / "SuperClaw" / "sandbox_manager"


def _load_sandbox_json(data_dir: Path, env: dict[str, str]) -> dict[str, Any]:
    """Load SANDBOX config from JSON.

    Priority (highest → lowest):
    1. ``SANDBOX_CONFIG`` env var — explicit path
    2. ``<DATA_DIR>/sandbox.json`` — user-local override
    3. ``data/sandbox.default.json`` — bundled repo default
    """
    candidates: list[Path] = []

    explicit = env.get("SANDBOX_CONFIG")
    if explicit:
        candidates.append(Path(explicit))

    candidates.append(data_dir / "sandbox.json")
    candidates.append(_bundled_sandbox_json())

    for path in candidates:
        if path.exists():
            with path.open(encoding="utf-8-sig") as fh:
                return json.load(fh)

    raise FileNotFoundError(
        f"No SANDBOX config JSON found. Tried: {[str(p) for p in candidates]}"
    )


@dataclass(frozen=True)
class Config:
    # ---- Shared / model-manager ----
    port: int
    data_dir: Path
    log_dir: Path
    hf_endpoint: str

    # ---- SANDBOX (native backend) — populated from JSON ----
    sandbox_port: int
    # Defaults to "/workspace" so older test fixtures and config files continue
    # to work without modification.  load_config() always populates this from
    # the sandbox JSON (using the same "/workspace" fallback when absent).
    sandbox_workspace_container_path: str = "/workspace"

    # Control-plane bind address for the uvicorn server.  Defaulted here (rather
    # than a required field) so direct Config(...) constructions in tests keep
    # working; load_config() always resolves it from the CLI flag / env var.
    host: str = _DEFAULT_HOST
    managed: bool = False
    process_credential: str = field(default="", repr=False)

    # Derived sub-directories (created on load)
    manager_log_dir: Path = field(init=False)
    resources_dir: Path = field(init=False)
    sandbox_log_dir: Path = field(init=False)
    # sandbox sub-directories: runtime logs (runtime-*.log) and install logs (install-attempt-*.log)
    sandbox_runtime_log_dir: Path = field(init=False)
    sandbox_install_log_dir: Path = field(init=False)

    def __post_init__(self) -> None:
        # frozen=True forbids attribute assignment, so go through object.__setattr__
        object.__setattr__(self, "manager_log_dir", self.log_dir / "manager")
        object.__setattr__(self, "resources_dir", self.data_dir / "resources")
        object.__setattr__(self, "sandbox_log_dir", self.log_dir / "sandbox")
        object.__setattr__(self, "sandbox_runtime_log_dir", self.log_dir / "sandbox" / "runtime")
        object.__setattr__(self, "sandbox_install_log_dir", self.log_dir / "sandbox" / "install")


def load_config(
    env: dict[str, str] | None = None,
    *,
    port: int | None = None,
    host: str | None = None,
) -> Config:
    """Build a :class:`Config` from the environment and SANDBOX JSON.

    The control-plane ``port`` is passed explicitly (from the ``--port`` CLI flag
    resolved in :func:`sandbox_manager.main.run`); it is **not** read from the
    environment. When omitted (tests / programmatic construction) it defaults to
    :data:`_DEFAULT_PORT`.

    The control-plane bind ``host`` is resolved with the precedence
    CLI ``--host`` (the ``host`` argument) > ``SANDBOX_MANAGER_HOST`` env var >
    :data:`_DEFAULT_HOST` (``127.0.0.1``).

    Side effects (intentional, called exactly once from :mod:`sandbox_manager.main`):

    * Creates ``<DATA_DIR>/{resources,logs/{manager,sandbox}}``
    * Writes ``HF_ENDPOINT`` back to :data:`os.environ` if not already set
      (so any subprocess — e.g. the PII detector — inherits the mirror).
    """
    env = env if env is not None else dict(os.environ)

    resolved_port = port if port is not None else _DEFAULT_PORT
    resolved_host = host if host is not None else (
        env.get("SANDBOX_MANAGER_HOST") or _DEFAULT_HOST
    )
    data_dir = Path(env.get("SANDBOX_MANAGER_DATA_DIR") or _default_data_dir())
    log_dir = Path(env.get("SANDBOX_MANAGER_LOG_DIR") or (data_dir / "logs"))
    hf_endpoint = env.get("HF_ENDPOINT") or _DEFAULT_HF_ENDPOINT
    managed = env.get("SERVICEHUB_MANAGED") == "1"
    process_credential = env.get("SERVICEHUB_PROCESS_CREDENTIAL", "")
    if managed and not process_credential:
        raise ValueError("SERVICEHUB_PROCESS_CREDENTIAL is required in managed mode")

    # SANDBOX — load from JSON (no individual ENV vars)
    sandbox = _load_sandbox_json(data_dir, env)

    cfg = Config(
        port=resolved_port,
        data_dir=data_dir,
        log_dir=log_dir,
        hf_endpoint=hf_endpoint,
        host=resolved_host,
        managed=managed,
        process_credential=process_credential,
        sandbox_port=int(sandbox["sandbox_port"]),
        sandbox_workspace_container_path=sandbox.get(
            "workspace_container_path", "/workspace"
        ),
    )

    # Materialize directory tree
    for d in (
        cfg.manager_log_dir,
        cfg.resources_dir,
        cfg.sandbox_log_dir,
        cfg.sandbox_runtime_log_dir,
        cfg.sandbox_install_log_dir,
    ):
        d.mkdir(parents=True, exist_ok=True)

    # Re-export HF mirror so huggingface_hub and any subprocess inherit it
    os.environ.setdefault("HF_ENDPOINT", cfg.hf_endpoint)

    return cfg
