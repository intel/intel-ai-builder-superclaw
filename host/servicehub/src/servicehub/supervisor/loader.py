"""Load and validate ServiceHub child-service registry configuration."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from jsonschema import ValidationError, validate


RestartPolicy = Literal["never", "on-failure", "always"]
StartupPolicy = Literal["required", "on_demand"]
BindHost = Literal["127.0.0.1", "0.0.0.0"]
_VALID_RESTART_POLICIES = {"never", "on-failure", "always"}
_VALID_BIND_HOSTS = {"127.0.0.1", "0.0.0.0"}
_VALID_STARTUP_POLICIES = {"required", "on_demand"}
_VALID_EXE_NAME = re.compile(r"^[A-Za-z0-9_.-]+\.exe$")


class ConfigError(ValueError):
    """Raised when ``service_cfg.json`` is missing or invalid."""


@dataclass(frozen=True)
class ServiceEntry:
    name: str
    entrypoint: str
    proxy_prefix: str
    port: int
    bind_host: BindHost = "127.0.0.1"
    data_plane: dict = field(default_factory=lambda: {"enabled": False})
    launch: dict[str, str] = field(default_factory=dict)
    env: dict[str, str] = field(default_factory=dict)
    depends_on: list[str] = field(default_factory=list)
    restart_policy: RestartPolicy = "on-failure"
    ready_timeout_s: float = 15.0
    shutdown_grace_s: float = 10.0
    startup: StartupPolicy = "required"


def _schema_path(config_path: Path) -> Path:
    candidate = config_path.with_name("service_cfg.schema.json")
    if candidate.exists():
        return candidate
    return Path(__file__).resolve().parents[3] / "service_cfg.schema.json"


def _load_json(path: Path) -> dict:
    try:
        with path.open(encoding="utf-8-sig") as handle:
            data = json.load(handle)
    except FileNotFoundError as exc:
        raise ConfigError(f"service_cfg.json not found: {path}") from exc
    except json.JSONDecodeError as exc:
        raise ConfigError(f"service_cfg.json is malformed JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise ConfigError("service_cfg.json root must be an object")
    return data


def _validate_schema(data: dict, config_path: Path) -> None:
    schema_path = _schema_path(config_path)
    if not schema_path.exists():
        return
    try:
        schema = _load_json(schema_path)
        validate(instance=data, schema=schema)
    except ValidationError as exc:
        path = ".".join(str(part) for part in exc.path)
        if path == "services" and exc.validator == "minItems":
            raise ConfigError("service_cfg.json must contain at least one service") from exc
        if path.endswith("proxy_prefix"):
            raise ConfigError(f"service_cfg proxy_prefix is invalid: {exc.message}") from exc
        if path.endswith("port"):
            raise ConfigError(f"service_cfg port is invalid: {exc.message}") from exc
        if path.endswith("bind_host"):
            raise ConfigError(f"service_cfg bind_host is invalid: {exc.message}") from exc
        if path.endswith("data_plane"):
            raise ConfigError(f"service_cfg data_plane is invalid: {exc.message}") from exc
        if path.endswith("launch") or "launch" in path:
            raise ConfigError(f"service_cfg launch is invalid: {exc.message}") from exc
        if path.endswith("restart_policy"):
            raise ConfigError(f"service_cfg restart_policy is invalid: {exc.message}") from exc
        if path.endswith("startup"):
            raise ConfigError(f"service_cfg startup is invalid: {exc.message}") from exc
        raise ConfigError(f"service_cfg schema validation failed: {exc.message}") from exc


def _parse_entries(data: dict) -> list[ServiceEntry]:
    services = data.get("services")
    if not isinstance(services, list) or not services:
        raise ConfigError("service_cfg.json must contain at least one service")

    entries: list[ServiceEntry] = []
    names: set[str] = set()
    prefixes: set[str] = set()
    ports: set[int] = set()
    for raw in services:
        if not isinstance(raw, dict):
            raise ConfigError("each service entry must be an object")
        name = raw.get("name")
        entrypoint = raw.get("entrypoint")
        proxy_prefix = raw.get("proxy_prefix")
        port = raw.get("port")
        bind_host = raw.get("bind_host", "127.0.0.1")
        if not isinstance(name, str) or not name:
            raise ConfigError("service name is required")
        if name in names:
            raise ConfigError(f"duplicate service name: {name}")
        names.add(name)
        if not isinstance(entrypoint, str) or not entrypoint:
            raise ConfigError(f"service {name} entrypoint is required")
        if not isinstance(proxy_prefix, str) or not proxy_prefix.startswith("/"):
            raise ConfigError(f"service {name} proxy_prefix must start with '/'")
        if proxy_prefix in prefixes:
            raise ConfigError(f"duplicate proxy_prefix: {proxy_prefix}")
        prefixes.add(proxy_prefix)
        if not isinstance(port, int) or port < 1024 or port > 65535:
            raise ConfigError(f"service {name} port must be an integer in 1024..65535")
        if port in ports:
            raise ConfigError(f"duplicate service port: {port}")
        ports.add(port)
        if bind_host not in _VALID_BIND_HOSTS:
            raise ConfigError(f"service {name} bind_host is invalid: {bind_host}")
        data_plane = raw.get("data_plane") or {"enabled": False}
        if not isinstance(data_plane, dict) or not isinstance(data_plane.get("enabled", False), bool):
            raise ConfigError(f"service {name} data_plane is invalid")
        if bind_host == "0.0.0.0" and data_plane.get("enabled") is not True:
            raise ConfigError(f"service {name} bind_host 0.0.0.0 requires data_plane.enabled=true")
        env = raw.get("env") or {}
        launch = raw.get("launch") or {}
        if not isinstance(launch, dict):
            raise ConfigError(f"service {name} launch is invalid")
        launch_kind = launch.get("kind")
        if launch_kind is not None and launch_kind not in {"module", "exe", "role"}:
            raise ConfigError(f"service {name} launch kind is invalid: {launch_kind}")
        exe_name = launch.get("exe_name")
        if exe_name is not None and (
            not isinstance(exe_name, str) or _VALID_EXE_NAME.fullmatch(exe_name) is None
        ):
            raise ConfigError(f"service {name} launch exe_name is invalid")
        # `role` means several services share ONE multi-role exe that selects its
        # role from `--service <name>`. The shared exe name is therefore the only
        # thing that says which bundle to launch, so unlike `exe` (where it falls
        # back to `<entrypoint>.exe`) it cannot be inferred and must be declared.
        if launch_kind == "role" and exe_name is None:
            raise ConfigError(f"service {name} launch kind 'role' requires exe_name")
        depends_on = raw.get("depends_on") or []
        restart_policy = raw.get("restart_policy", "on-failure")
        if restart_policy not in _VALID_RESTART_POLICIES:
            raise ConfigError(f"service {name} restart_policy is invalid: {restart_policy}")
        startup = raw.get("startup", "required")
        if startup not in _VALID_STARTUP_POLICIES:
            raise ConfigError(f"service {name} startup is invalid: {startup}")

        entries.append(
            ServiceEntry(
                name=name,
                entrypoint=entrypoint,
                proxy_prefix=proxy_prefix,
                port=port,
                bind_host=bind_host,
                data_plane=dict(data_plane),
                launch={str(k): str(v) for k, v in launch.items()},
                env=dict(env),
                depends_on=list(depends_on),
                restart_policy=restart_policy,
                ready_timeout_s=float(raw.get("ready_timeout_s", 15.0)),
                shutdown_grace_s=float(raw.get("shutdown_grace_s", 10.0)),
                startup=startup,
            )
        )

    return entries


def _topo_sort(entries: list[ServiceEntry]) -> list[ServiceEntry]:
    by_name = {entry.name: entry for entry in entries}
    for entry in entries:
        for dep in entry.depends_on:
            if dep not in by_name:
                raise ConfigError(f"service {entry.name} has unknown dependency: {dep}")
            if by_name[dep].startup == "on_demand":
                raise ConfigError(
                    f"service {entry.name} cannot depend on on-demand service: {dep}"
                )

    ordered: list[ServiceEntry] = []
    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(name: str) -> None:
        if name in visited:
            return
        if name in visiting:
            raise ConfigError(f"dependency cycle detected at service: {name}")
        visiting.add(name)
        entry = by_name[name]
        for dep in entry.depends_on:
            visit(dep)
        visiting.remove(name)
        visited.add(name)
        ordered.append(entry)

    for entry in entries:
        visit(entry.name)
    return ordered


def load_service_config(path: Path) -> list[ServiceEntry]:
    data = _load_json(path)
    _validate_schema(data, path)
    return _topo_sort(_parse_entries(data))
