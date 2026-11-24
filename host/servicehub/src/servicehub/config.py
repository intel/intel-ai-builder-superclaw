"""Process-wide configuration for ServiceHub."""

from __future__ import annotations

import os
import secrets
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Mapping


_DEFAULT_PORT = 0


def default_service_cfg_path() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent / "service_cfg.json"
    return Path(__file__).resolve().parents[2] / "service_cfg.json"


def _default_data_dir(env: Mapping[str, str] | None = None) -> Path:
    source = env if env is not None else os.environ
    base = source.get("LOCALAPPDATA")
    if not base:
        base = str(Path.home() / ".local" / "share")
    return Path(base) / "SuperClaw" / "servicehub"


@dataclass(frozen=True)
class Config:
    port: int
    hub_token: str
    data_dir: Path
    service_cfg_path: Path
    no_spawn: bool
    capability_gating_v1: bool = False
    log_dir: Path = field(init=False)

    def __post_init__(self) -> None:
        object.__setattr__(self, "data_dir", Path(self.data_dir))
        object.__setattr__(self, "service_cfg_path", Path(self.service_cfg_path))
        object.__setattr__(self, "log_dir", Path(self.data_dir) / "logs")

    def ensure_directories(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.log_dir.mkdir(parents=True, exist_ok=True)


def load_config(
    *,
    env: Mapping[str, str] | None = None,
    port: int | None = None,
    hub_token: str | None = None,
    data_dir: Path | str | None = None,
    service_cfg_path: Path | str | None = None,
    no_spawn: bool = False,
) -> Config:
    source = env if env is not None else os.environ
    resolved_data_dir = Path(
        data_dir or source.get("SERVICEHUB_DATA_DIR") or _default_data_dir(source)
    )
    resolved_cfg = Path(
        service_cfg_path
        or source.get("SERVICEHUB_CFG")
        or source.get("SERVICEHUB_SERVICE_CFG")
        or default_service_cfg_path()
    )
    resolved_token = hub_token or source.get("SERVICEHUB_TOKEN") or secrets.token_urlsafe(32)

    config = Config(
        port=port if port is not None else int(source.get("SERVICEHUB_PORT", _DEFAULT_PORT)),
        hub_token=resolved_token,
        data_dir=resolved_data_dir,
        service_cfg_path=resolved_cfg,
        no_spawn=no_spawn,
        capability_gating_v1=_parse_capability_gating_v1(source.get("CAPABILITY_GATING_V1")),
    )
    config.ensure_directories()
    return config


def _parse_capability_gating_v1(value: str | None) -> bool:
    if value is None or value.strip().lower() in {"", "0", "false"}:
        return False
    if value.strip().lower() in {"1", "true"}:
        return True
    raise ValueError("CAPABILITY_GATING_V1 must be one of: 0, 1, false, true")
