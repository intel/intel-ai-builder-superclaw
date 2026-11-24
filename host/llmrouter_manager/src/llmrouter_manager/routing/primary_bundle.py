"""Committed Primary Bundle resolution for the Chat data plane.

Embedding is not exposed as an OpenAI-compatible data-plane endpoint: the only
in-product embedding consumer is the AutoRoute latency router, which embeds
query text through its own in-process client (``auto_router/embedding_client.py``)
rather than crossing an HTTP surface. ``resolve_primary`` remains the single
committed-bundle resolver shared by the chat path.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, Literal

from ..edge import config as edge_config
from ..edge.bundle_adapter import edge_config_fingerprint
from ..local import mock_bundle
from ..local.llama_auth import llama_api_key


@dataclass(frozen=True)
class PrimaryUpstream:
    backend: Literal["llama", "edge"]
    bundle_id: str
    model_id: str
    base_url: str
    api_key: str
    bundle_revision: int
    # The id to put on the wire when it differs from the served id above.
    # Empty means "same as model_id", which is the case for every real
    # upstream. Only the dev-only Bundle mock sets it, because its remote
    # endpoint knows the model by a different name (an OpenRouter slug) than
    # the Bundle does. Keeping the two apart preserves the documented
    # record_usage invariant in ``routing/proxy.py``: usage is attributed to
    # the SERVED id, never to a wire value, or one model's spend splits across
    # several unstable keys in the usage aggregate's primary key.
    upstream_model_id: str = ""

    @property
    def binding_revision(self) -> int:
        """Canonical revision name; bundle_revision remains a compatibility alias."""
        return self.bundle_revision


def resolve_primary(
    app_state: Any,
    *,
    role: Literal["chat", "embedding"],
) -> PrimaryUpstream | None:
    lifecycle = app_state.store.get_bundle_lifecycle()
    primary = lifecycle.get("primary_bundle")
    if not isinstance(primary, dict) or primary.get("state") != "ready":
        return None
    model_id = primary.get(f"{role}_model_id")
    if not isinstance(model_id, str) or not model_id:
        return None
    backend = primary.get("backend")
    if backend == "llama":
        bundle_id = str(primary["bundle_id"])
        # Dev-only: the chat role of a mocked Bundle is served by a remote
        # OpenAI-compatible endpoint instead of llama-server. Only ``model_id``
        # changes -- it is the upstream *wire* name, so the Bundle keeps its own
        # id everywhere it is displayed. The embedding role is never mocked and
        # falls through to the real local server below.
        if role == "chat":
            mock = mock_bundle.config()
            if mock is not None and mock.bundle_id == bundle_id:
                return PrimaryUpstream(
                    backend="llama",
                    bundle_id=bundle_id,
                    # Served id stays the Bundle's own model, so usage,
                    # telemetry and the response body all read qwen3.8-27b.
                    model_id=model_id,
                    upstream_model_id=mock.upstream_model_id,
                    base_url=mock.base_url,
                    api_key=mock.api_key,
                    bundle_revision=int(primary["bundle_revision"]),
                )
        # One router-mode llama-server hosts both committed roles.
        port = int(os.environ.get("LLAMA_ROUTER_PORT", "18103"))
        return PrimaryUpstream(
            backend="llama",
            bundle_id=bundle_id,
            model_id=model_id,
            base_url=f"http://127.0.0.1:{port}/v1",
            api_key=llama_api_key(),
            bundle_revision=int(primary["bundle_revision"]),
        )
    if backend == "edge":
        config = edge_config.get()
        if config is None:
            return None
        expected_fingerprint = app_state.store.get_edge_config_fingerprint()
        if (
            not isinstance(expected_fingerprint, str)
            or edge_config_fingerprint(config) != expected_fingerprint
        ):
            return None
        return PrimaryUpstream(
            backend="edge",
            bundle_id=str(primary["bundle_id"]),
            model_id=model_id,
            base_url=str(config.get("base_url", "")),
            api_key=str(config.get("api_key", "")),
            bundle_revision=int(primary["bundle_revision"]),
        )
    return None
