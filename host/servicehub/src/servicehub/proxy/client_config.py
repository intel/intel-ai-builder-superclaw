"""Shared httpx client configuration for ServiceHub upstream calls.

ServiceHub polls child services every 5 seconds from the UI/runtime status
surface. Uvicorn also defaults to a 5 second keep-alive timeout. Use a shorter
client-side idle expiry so httpx retires pooled sockets before the child server
does, avoiding stale keep-alive reuse on the next status poll.
"""

from __future__ import annotations

import httpx


_UPSTREAM_KEEPALIVE_EXPIRY_S = 4.0


def default_httpx_limits() -> httpx.Limits:
    return httpx.Limits(
        max_connections=100,
        max_keepalive_connections=20,
        keepalive_expiry=_UPSTREAM_KEEPALIVE_EXPIRY_S,
    )
