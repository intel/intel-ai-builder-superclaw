"""Cloud-model singleton — which {provider, model} backs the ``cloud-model`` alias.

On-disk shape matches what ``routing.proxy._load_cloud_model_config`` reads:
``{provider, model, max_tokens?, context_limit?}``. ``base_url`` is NOT stored
here — it lives in the per-provider registry record and is joined at read
time. Hot reload: dispatch reads this file fresh per request.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from ..common.state import (
    default_state_root,
    delete_state_file,
    read_json,
    write_json_atomic,
)


def _path() -> Path:
    return default_state_root() / "cloud-model.json"


def get() -> dict[str, Any] | None:
    """Return the cloud-model record, or None when not configured."""
    payload = read_json(_path())
    if not isinstance(payload, dict):
        return None
    return payload


def put(
    provider: str,
    model: str,
    max_tokens: int | None = None,
    context_limit: int | None = None,
    auth_mode: str | None = None,
) -> None:
    """Write the cloud-model record atomically. Hot-reloaded by dispatch."""
    payload: dict[str, Any] = {"provider": provider, "model": model}
    if max_tokens is not None:
        payload["max_tokens"] = int(max_tokens)
    if context_limit is not None:
        payload["context_limit"] = int(context_limit)
    if auth_mode is not None:
        payload["auth_mode"] = auth_mode
    write_json_atomic(_path(), payload)


def delete() -> bool:
    """Remove the cloud-model record. Idempotent; returns True iff file existed."""
    return delete_state_file(_path())
