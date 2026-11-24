"""API key for the llama-server that LRM spawns.

LRM is both the process that launches llama-server and its only client, so the
key is generated once per LRM process and kept in memory only. The supervisor
hands it to llama-server through ``LLAMA_API_KEY`` rather than ``--api-key``,
which would expose it on the process command line. llama-server's router-mode
child processes inherit that environment, so they enforce the same key.
LRM also verifies at start-up that llama-server enforces the key.
"""

from __future__ import annotations

import asyncio
import secrets

import httpx
from loguru import logger

from ..common.http_client import build_async_client_for_url

KEY_PROBE_ATTEMPTS = 3
KEY_PROBE_RETRY_DELAY_S = 0.5

_API_KEY = secrets.token_urlsafe(32)


class KeyNotEnforcedError(Exception):
    def __init__(self, message: str, *, retryable: bool) -> None:
        super().__init__(message)
        self.retryable = retryable


def llama_api_key() -> str:
    return _API_KEY


def llama_auth_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {_API_KEY}"}


async def verify_key_enforced(host: str, port: int) -> None:
    models_url = f"http://{host}:{port}/v1/models"
    async with build_async_client_for_url(models_url, timeout=2.0) as client:
        for attempt in range(KEY_PROBE_ATTEMPTS):
            try:
                response = await client.get(models_url)
            except httpx.HTTPError as exc:
                if attempt + 1 < KEY_PROBE_ATTEMPTS:
                    await asyncio.sleep(KEY_PROBE_RETRY_DELAY_S)
                    continue
                raise KeyNotEnforcedError(
                    f"could not verify llama-server enforces its API key after "
                    f"{KEY_PROBE_ATTEMPTS} attempts: {exc}",
                    retryable=True,
                ) from exc
            if response.status_code == 401:
                logger.info(
                    "llama-server enforces its API key: unauthenticated GET /v1/models "
                    "returned HTTP 401 (port={})",
                    port,
                )
                return
            raise KeyNotEnforcedError(
                "llama-server is not enforcing its API key: unauthenticated GET "
                f"/v1/models returned HTTP {response.status_code}",
                retryable=False,
            )
