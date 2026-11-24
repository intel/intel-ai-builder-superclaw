"""Host-owned Tavily API key (EG1-3, #12): ``/sandbox-manager/v1/secrets/tavily-api-key``.

The app saves the key here through ServiceHub's ``/sandbox-manager`` forwarding, so it never passes
through a sandbox tier. Every route answers only whether a key is configured and whether it is switched
on. The body is parsed by hand because FastAPI's own validation error would repeat the request - the
key - back to the caller. The store behind ``app.state.tavily_api_key_store`` holds the key; until a
backend provides one, every route says saving is unavailable.
"""

from __future__ import annotations

import asyncio
import json
from typing import Protocol

from contracts.tavily_api_key_enabled_request import TavilyApiKeyEnabledRequest
from contracts.tavily_api_key_save_request import TavilyApiKeySaveRequest
from contracts.tavily_api_key_status import TavilyApiKeyStatus
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from loguru import logger
from pydantic import ValidationError

from ._host_api import NO_STORE_HEADERS, bounded_body, refusal

router = APIRouter()

_PATH = "/secrets/tavily-api-key"
_SECRET = "tavily_api_key"
# The longest key is 256 characters, each at most two in JSON, plus the object around it.
_MAX_BODY_BYTES = 1024


class TavilyApiKeyStore(Protocol):
    def is_configured(self) -> bool: ...

    def is_enabled(self) -> bool: ...

    def set_enabled(self, enabled: bool) -> None: ...

    def save(self, api_key: str) -> None: ...

    def clear(self) -> None: ...


@router.get(_PATH)
async def get_tavily_api_key_status(request: Request) -> JSONResponse:
    store = _store(request)
    if store is None:
        return refusal("tavily_api_key_store_unavailable")
    return await _status(store)


@router.put(_PATH)
async def save_tavily_api_key(request: Request) -> JSONResponse:
    store = _store(request)
    if store is None:
        return refusal("tavily_api_key_store_unavailable")
    raw = await bounded_body(request, _MAX_BODY_BYTES)
    if raw is None:
        return refusal("invalid_request")
    try:
        body = json.loads(raw)
    except ValueError:
        return refusal("invalid_request")
    try:
        save_request = TavilyApiKeySaveRequest.model_validate(body)
    except ValidationError as exc:
        return refusal(_save_refusal_code(exc))
    if (unrecorded := await _record(request, "secret.saved")) is not None:
        return unrecorded
    # DPAPI, fsync and the Connector's re-seal block: keep them off the loop that answers probes.
    await asyncio.to_thread(store.save, save_request.api_key)
    return await _status(store)


@router.put(f"{_PATH}/enabled")
async def set_tavily_api_key_enabled(request: Request) -> JSONResponse:
    """Pause or resume the saved key: it stays in the store, and the Connector is given none while paused."""
    store = _store(request)
    if store is None:
        return refusal("tavily_api_key_store_unavailable")
    raw = await bounded_body(request, _MAX_BODY_BYTES)
    if raw is None:
        return refusal("invalid_request")
    try:
        # Strict: the string "false" must not read as a decision.
        enabled_request = TavilyApiKeyEnabledRequest.model_validate(json.loads(raw), strict=True)
    except (ValueError, ValidationError):
        return refusal("invalid_request")
    if (
        unrecorded := await _record(
            request, "secret.enabled_changed", enabled=str(enabled_request.enabled).lower()
        )
    ) is not None:
        return unrecorded
    await asyncio.to_thread(store.set_enabled, enabled_request.enabled)
    return await _status(store)


@router.delete(_PATH)
async def clear_tavily_api_key(request: Request) -> JSONResponse:
    store = _store(request)
    if store is None:
        return refusal("tavily_api_key_store_unavailable")
    if (unrecorded := await _record(request, "secret.cleared")) is not None:
        return unrecorded
    await asyncio.to_thread(store.clear)
    return await _status(store)


def _store(request: Request) -> TavilyApiKeyStore | None:
    return getattr(request.app.state, "tavily_api_key_store", None)


async def _record(request: Request, event: str, **fields: str) -> JSONResponse | None:
    """Write the audit line before the change. A line that cannot be written stops the change."""
    try:
        await asyncio.to_thread(request.app.state.control_audit.record, event, secret=_SECRET, **fields)
    except OSError as exc:
        logger.error("control audit not written event={} error={}", event, type(exc).__name__)
        return refusal("tavily_api_key_store_unavailable")
    return None


async def _status(store: TavilyApiKeyStore) -> JSONResponse:
    configured = await asyncio.to_thread(store.is_configured)
    enabled = await asyncio.to_thread(store.is_enabled)
    return JSONResponse(
        TavilyApiKeyStatus(configured=configured, enabled=enabled).model_dump(mode="json"),
        headers=NO_STORE_HEADERS,
    )


def _save_refusal_code(exc: ValidationError) -> str:
    errors = exc.errors(include_input=False)
    if all(
        error["loc"] == ("api_key",) and error["type"] == "string_pattern_mismatch"
        for error in errors
    ):
        return "invalid_tavily_api_key"
    return "invalid_request"
