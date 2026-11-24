"""Edge endpoint config — single DPAPI-encrypted file on disk.

The full file (including ``api_key``) is encrypted via DPAPI user-scope;
there is no separate plain-text portion. See README §9 + plan §5.

Hot reload: ``routing/primary_bundle.py::resolve_primary`` reads the same file
fresh per request — no service restart needed when the user adds, swaps,
or removes the edge endpoint.

Schema: ``{base_url, api_key, model_name, embedding_model_name, bypass_proxy}``.
``embedding_model_name`` is persisted so the latency router's embedding
client (``routing/auto_router/embedding_client.py``) can call
``<base_url>/embeddings`` on the same edge endpoint without re-asking
the user. ``model_name`` and ``embedding_model_name`` are optional in
``put()`` — defaults are applied and persisted, see the constants + the
handler below.

``bypass_proxy`` (default ``True``) records the user's "bypass HTTP proxy"
choice from the Connect-Edge UI. When set, ``common/http_client.py`` adds the
edge host to the proxy-bypass set so outbound calls to an intranet edge server
skip the corporate proxy (which would otherwise 403 the internal-only host).
It is an opt-out because edge servers are typically intranet endpoints.
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


DEFAULT_MODEL_NAME = "Qwen3.8-Flash-Next"
DEFAULT_EMBEDDING_MODEL_NAME = "KaLM-embedding-v2.5"
DEFAULT_BYPASS_PROXY = True

_VERSION_SEGMENT_RE = re.compile(r"^v\d+$")


def normalize_base_url(base_url: str) -> str:
    """Ensure the URL ends at an OpenAI-style ``/v{n}`` prefix.

    Users routinely paste bare ``host:port`` (which returns 404 on
    ``/chat/completions``) or the full completion endpoint. Idempotent.
    """
    if not isinstance(base_url, str) or not base_url:
        return base_url
    url = base_url.strip().rstrip("/").removesuffix("/chat/completions").rstrip("/")
    if not url:
        return ""
    tail = url.rsplit("/", 1)[-1]
    return url if _VERSION_SEGMENT_RE.fullmatch(tail) else f"{url}/v1"


def _path() -> Path:
    return default_state_root() / "edge.json"


def get() -> dict[str, Any] | None:
    """Return the edge config record, or None when not configured.

    Dict shape: ``{base_url, api_key, model_name, embedding_model_name}``.
    Caller MUST NOT return ``api_key`` over the HTTP API — only the internal
    dispatcher (``routing/primary_bundle.py::resolve_primary``) and the embedding
    client need it.
    """
    payload = read_encrypted_json(_path())
    if not isinstance(payload, dict):
        return None
    return payload


def put(
    base_url: str,
    api_key: str,
    model_name: str = DEFAULT_MODEL_NAME,
    embedding_model_name: str = DEFAULT_EMBEDDING_MODEL_NAME,
    bypass_proxy: bool = DEFAULT_BYPASS_PROXY,
) -> None:
    """Write the edge config (DPAPI-encrypted, atomic). Full replace per plan §6.8.

    ``base_url`` is normalized via ``normalize_base_url`` so a bare
    ``host:port`` gains the required ``/v1`` suffix at rest.
    """
    write_encrypted_json_atomic(
        _path(),
        {
            "base_url": normalize_base_url(base_url),
            "api_key": api_key,
            "model_name": model_name,
            "embedding_model_name": embedding_model_name,
            "bypass_proxy": bool(bypass_proxy),
        },
    )


def delete() -> bool:
    """Remove the edge config file. Idempotent; returns True iff file existed."""
    return delete_state_file(_path())
