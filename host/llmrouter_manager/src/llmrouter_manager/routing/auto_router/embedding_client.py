"""Edge embedding client — calls ``<edge_base_url>/embeddings`` via httpx.

Used by the latency router's ``auto`` path (``routing/auto_router/adapter.py``)
to embed user queries before the router scores candidate backends. Only the
edge embedding path is supported today; the local llama-cpp embedding
endpoint will extend the same interface once its lifecycle wires in.

Exposes a ``batch(queries)`` method matching the contract the latency router
internally expects (``self.embedder.batch(queries) -> list[list[float]]``),
so it can be monkey-patched onto a ``LatentFactorRouter`` instance without
modifying the imported router code.
"""

from __future__ import annotations

from types import TracebackType
from typing import Any

import httpx

from ...common.http_client import build_client_for_url


# Auto-routing is a per-request decision boundary — fail fast so the proxy
# can gracefully fall back to cloud-model rather than blocking a user request
# for the full chat-completion budget.
_DEFAULT_TIMEOUT = httpx.Timeout(connect=2.0, read=5.0, write=2.0, pool=2.0)


class EdgeEmbeddingClient:
    """Thin httpx wrapper exposing ``batch(queries) -> list[list[float]]``."""

    def __init__(
        self,
        base_url: str,
        api_key: str,
        model_name: str,
        timeout: httpx.Timeout | float = _DEFAULT_TIMEOUT,
        is_local: bool = False,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model_name = model_name
        self.is_local = is_local
        self._client = build_client_for_url(self.base_url, timeout=timeout)

    def batch(self, queries: list[str]) -> list[list[float]]:
        url = f"{self.base_url}/embeddings"
        headers: dict[str, str] = {"Content-Type": "application/json"}
        # Empty api_key means "skip Authorization".
        # httpx rejects "Bearer " (empty value after the space) as an illegal header.
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        body: dict[str, Any] = {"model": self.model_name, "input": queries}
        # llama-server-specific: `truncate=true` asks it to truncate inputs longer
        # than the embedding model's context window instead of returning HTTP 400.
        # KaLM-embedding-v2.5 has an 8192-token limit; _extract_query_text does
        # not cap length, so an unusually long routing_text would otherwise
        # surface as router_route_failed -> cloud fallback. NOT sent on edge/cloud
        # paths — OpenAI's embeddings API rejects unknown JSON fields with 400.
        if self.is_local:
            body["truncate"] = True
        resp = self._client.post(url, json=body, headers=headers)
        resp.raise_for_status()
        payload = resp.json()

        # Validate response shape — the router uses these embeddings for a
        # routing decision, so silent shape drift would misroute rather than
        # fail cleanly through the adapter's RouterFailure path.
        data = payload.get("data")
        if not isinstance(data, list):
            raise ValueError(f"embeddings response missing 'data' list: {payload!r}")
        if len(data) != len(queries):
            raise ValueError(
                f"embeddings count mismatch: got {len(data)}, expected {len(queries)}"
            )
        embeddings: list[list[float]] = []
        for i, item in enumerate(data):
            if not isinstance(item, dict) or "embedding" not in item:
                raise ValueError(
                    f"embeddings response item {i} missing 'embedding': {item!r}"
                )
            embeddings.append(item["embedding"])
        return embeddings

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "EdgeEmbeddingClient":
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        self.close()
