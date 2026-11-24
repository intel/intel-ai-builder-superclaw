"""Cloud provider registry — per-provider API-key CRUD.

Each configured provider is one DPAPI-encrypted file under
``state/providers/<id>.bin``. The provider id is part of the on-disk
filename, so it must pass ``PROVIDER_ID_PATTERN`` validation before any
file I/O (bounds path traversal — see README §3.2).
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from ..common.state import (
    default_state_root,
    delete_state_file,
    read_encrypted_json,
    write_encrypted_json_atomic,
)


PROVIDER_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")


def _providers_dir() -> Path:
    return default_state_root() / "providers"


def _provider_path(provider_id: str) -> Path:
    # Defense-in-depth: the provider id becomes a filename, so bounds
    # path traversal in case a future caller forgets the API-layer check.
    if not PROVIDER_ID_PATTERN.match(provider_id):
        raise ValueError(f"invalid provider_id: {provider_id!r}")
    return _providers_dir() / f"{provider_id}.bin"


def list_configured() -> list[str]:
    """Return ids of providers with a stored config on disk, sorted."""
    directory = _providers_dir()
    if not directory.exists():
        return []
    return sorted(
        entry.stem
        for entry in directory.iterdir()
        if entry.is_file() and entry.suffix == ".bin"
    )


def get(provider_id: str) -> dict[str, Any] | None:
    """Read+decrypt provider config. Returns None when not configured."""
    payload = read_encrypted_json(_provider_path(provider_id))
    if not isinstance(payload, dict):
        return None
    return payload


def put(provider_id: str, api_key: str) -> None:
    """Write provider credentials (DPAPI-encrypted). Full replace per plan §6.10."""
    write_encrypted_json_atomic(
        _provider_path(provider_id),
        {"api_key": api_key},
    )


def delete(provider_id: str) -> bool:
    """Delete provider config file. Returns True iff a file was removed."""
    return delete_state_file(_provider_path(provider_id))
