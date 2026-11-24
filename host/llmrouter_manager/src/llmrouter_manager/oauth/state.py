"""OAuth session storage — DPAPI-encrypted, one file per provider.

Master of record for the OAuth session. Mirrors ``cloud/registry.py`` but with a
tighter ``PROVIDER_ID_PATTERN`` (only the supported OAuth provider set) and a
schema version field. Full-replace on write (never merge partial fields).
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from loguru import logger

from ..common.state import (
    default_state_root,
    delete_state_file,
    read_encrypted_json,
    write_encrypted_json_atomic,
)


# Deliberately tight — only the exact set of OAuth providers this subsystem
# supports. Widen alongside ``constants.OAUTH_PROVIDER_IDS`` when adding one.
PROVIDER_ID_PATTERN = re.compile(r"^(openai|github_copilot)$")

SCHEMA_VERSION = 1


def _oauth_dir() -> Path:
    return default_state_root() / "oauth"


def _oauth_path(provider_id: str) -> Path:
    # Defense-in-depth: filename derives from provider_id, so path-traversal
    # inputs would escape our tree without this check.
    if not PROVIDER_ID_PATTERN.match(provider_id):
        raise ValueError(f"invalid oauth provider_id: {provider_id!r}")
    return _oauth_dir() / f"{provider_id}.bin"


def list_configured() -> list[str]:
    """Return provider_ids with a stored OAuth session, sorted.

    Filters stems through ``PROVIDER_ID_PATTERN`` so a stray/tampered file
    doesn't surface an id that ``get()`` would later reject.
    """
    directory = _oauth_dir()
    if not directory.exists():
        return []
    return sorted(
        entry.stem
        for entry in directory.iterdir()
        if entry.is_file()
        and entry.suffix == ".bin"
        and PROVIDER_ID_PATTERN.match(entry.stem)
    )


def get(provider_id: str) -> dict[str, Any] | None:
    """Read+decrypt the OAuth session. ``None`` when not configured OR unreadable.

    A corrupt / partially-written / undecryptable state file is treated as "no
    session" (returns ``None``, logs a warning) so a single damaged blob cannot
    500 dispatch / health / listing / status-poll paths. Still raises
    ``ValueError`` for an invalid ``provider_id`` (path-traversal guard) -- a
    programming error, not a runtime state condition.
    """
    path = _oauth_path(provider_id)
    try:
        payload = read_encrypted_json(path)
    except Exception as exc:
        logger.warning(
            "[OAuth] unreadable session file provider={} treated as absent: {}",
            provider_id, str(exc)[:200],
        )
        return None
    if not isinstance(payload, dict):
        return None
    return payload


def put(provider_id: str, session: dict[str, Any]) -> None:
    """Write a fresh session (DPAPI-encrypted, atomic). Full replace.

    Stamps ``schema_version`` and ``provider`` on write so a caller that builds
    a partial dict cannot persist a session that ``get()`` later mis-reads or a
    future migration cannot version.
    """
    record = dict(session)
    record["schema_version"] = SCHEMA_VERSION
    record["provider"] = provider_id
    write_encrypted_json_atomic(_oauth_path(provider_id), record)


def delete(provider_id: str) -> bool:
    """Delete the session file. Idempotent; True iff a file was removed."""
    return delete_state_file(_oauth_path(provider_id))
