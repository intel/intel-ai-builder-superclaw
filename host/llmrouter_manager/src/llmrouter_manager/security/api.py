"""Control-plane endpoints for Security-tab data-protection settings.

Two GET/PUT pairs under ``/llm-router/v1/data-protection/*``:

* ``/mode``: file protection mode (none, deterministic, hybrid, or llm)
* ``/hybrid-threshold``: hybrid fallback threshold (float in [0, 1])

Update requests write values to the Store config key/value table, then return
the current data-protection setting state.
"""
from __future__ import annotations

from collections.abc import Callable
from typing import Any, Optional

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from loguru import logger

from ..common.errors import error_response
from ..common.store import Store
from .settings import (
    FILE_PROTECTION_MODES,
    STORE_KEY_FILE_PROTECTION_MODE,
    STORE_KEY_HYBRID_THRESHOLD,
    resolve_file_protection_mode,
    resolve_hybrid_threshold,
)


security_router = APIRouter(prefix="/llm-router/v1/data-protection", tags=["security"])
SecurityState = dict[str, Any]


# ── Store helpers ────────────────────────────────────────────────────────────
# Use the process Store already opened at startup. Constructing a new Store
# per read runs schema setup and BEGIN IMMEDIATE, which takes a write lock and
# blocks the event loop.
def _read_config(store: Store, key: str) -> Any:
    """Read a value from the Store config table.

    Read failures are treated as missing values so GET endpoints can fall
    back to defaults instead of failing the whole settings surface.

    Args:
        store (Store): Process Store opened at startup.
        key (str): Store config key to read.

    Returns:
        Any: The stored value, or ``None`` when the key is missing or unreadable.
    """
    try:
        return store.get_config(key)
    except Exception:  # noqa: BLE001
        return None


def _reader(store: Store) -> Callable[[str], Any]:
    """Return a resolver callback bound to one already-open Store."""
    def read(key: str) -> Any:
        return _read_config(store, key)

    return read


def _write_config(store: Store, key: str, value: Any) -> None:
    """Write a value to the Store config table.

    Args:
        store (Store): Process Store opened at startup.
        key (str): Store config key to write.
        value (Any): Value to persist. ``None`` clears the override.
    """
    store.set_config(key, value)


# ── /mode ────────────────────────────────────────────────────────────────────
def _mode_state(store: Store) -> SecurityState:
    """Compose the response body for GET /mode and PUT /mode.

    Args:
        store (Store): Process Store opened at startup.

    Returns:
        SecurityState: Response body containing the stored mode, applied mode,
        source, and support flag.
    """
    read = _reader(store)
    store_raw = read(STORE_KEY_FILE_PROTECTION_MODE)
    applied = resolve_file_protection_mode(store_read=read)
    source = "store" if store_raw is not None else "default"
    return {
        "mode": store_raw,
        "applied": applied,
        "source": source,
        "supported": True,
    }


@security_router.get("/mode")
async def get_mode(request: Request) -> JSONResponse:
    """Return the active file protection mode state.

    Args:
        request (Request): Incoming FastAPI request. Its app state holds the Store.

    Returns:
        JSONResponse: Current mode state for the Settings UI.
    """
    state = _mode_state(request.app.state.store)
    return JSONResponse(state)


@security_router.put("/mode")
async def put_mode(request: Request) -> JSONResponse:
    """Persist or clear the file protection mode override.

    Args:
        request (Request): Incoming FastAPI request containing a JSON body with
            ``mode`` set to a supported mode or ``null``.

    Returns:
        JSONResponse: Updated mode state, or a structured validation error.
    """
    try:
        body = await request.json()
    except Exception as exc:  # noqa: BLE001
        return error_response("invalid_json", f"invalid JSON body: {exc}", status_code=400)
    if not isinstance(body, dict) or "mode" not in body:
        return error_response(
            "invalid_body",
            "body must be a JSON object with a 'mode' field (or 'mode': null to clear)",
            status_code=422,
        )
    raw = body["mode"]
    if raw is None:
        _write_config(request.app.state.store, STORE_KEY_FILE_PROTECTION_MODE, None)
        logger.info("security: FILE_PROTECTION_MODE Store override cleared")
        state = _mode_state(request.app.state.store)
        return JSONResponse(state)
    if not isinstance(raw, str) or raw.strip().lower() not in FILE_PROTECTION_MODES:
        return error_response(
            "invalid_mode",
            f"mode must be one of {list(FILE_PROTECTION_MODES)} or null",
            status_code=422, details={"mode": raw},
        )
    normalized = raw.strip().lower()
    _write_config(request.app.state.store, STORE_KEY_FILE_PROTECTION_MODE, normalized)
    logger.info("security: FILE_PROTECTION_MODE set to {!r} (Store)", normalized)
    state = _mode_state(request.app.state.store)
    return JSONResponse(state)


# ── /hybrid-threshold ────────────────────────────────────────────────────────


def _threshold_state(store: Store) -> SecurityState:
    """Compose the response body for GET and PUT /hybrid-threshold.

    Args:
        store (Store): Process Store opened at startup.

    Returns:
        SecurityState: Response body containing the stored threshold, applied
        threshold, source, and support flag.
    """
    read = _reader(store)
    store_raw = read(STORE_KEY_HYBRID_THRESHOLD)
    applied = resolve_hybrid_threshold(store_read=read)
    source = "store" if store_raw is not None else "default"
    persisted: Optional[float] = None
    if store_raw is not None:
        try:
            persisted = float(store_raw)
        except (TypeError, ValueError):
            persisted = None
    return {
        "threshold": persisted,
        "applied": applied,
        "source": source,
        "supported": True,
    }


@security_router.get("/hybrid-threshold")
async def get_hybrid_threshold(request: Request) -> JSONResponse:
    """Return the active hybrid fallback threshold state.

    Args:
        request (Request): Incoming FastAPI request. Its app state holds the Store.

    Returns:
        JSONResponse: Current hybrid threshold state for the Settings UI.
    """
    state = _threshold_state(request.app.state.store)
    return JSONResponse(state)


@security_router.put("/hybrid-threshold")
async def put_hybrid_threshold(request: Request) -> JSONResponse:
    """Persist or clear the hybrid fallback threshold override.

    Args:
        request (Request): Incoming FastAPI request containing a JSON body with
            ``threshold`` set to a number in [0, 1] or ``null``.

    Returns:
        JSONResponse: Updated threshold state, or a structured validation error.
    """
    try:
        body = await request.json()
    except Exception as exc:  # noqa: BLE001
        return error_response("invalid_json", f"invalid JSON body: {exc}", status_code=400)
    if not isinstance(body, dict) or "threshold" not in body:
        return error_response(
            "invalid_body",
            "body must be a JSON object with a 'threshold' field (float in [0,1], or null to clear)",
            status_code=422,
        )
    raw = body["threshold"]
    if raw is None:
        _write_config(request.app.state.store, STORE_KEY_HYBRID_THRESHOLD, None)
        logger.info("security: FILE_PROTECTION_HYBRID_THRESHOLD Store override cleared")
        state = _threshold_state(request.app.state.store)
        return JSONResponse(state)
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        return error_response(
            "invalid_threshold",
            "threshold must be a number in [0, 1] or null",
            status_code=422, details={"threshold": raw},
        )
    value = float(raw)
    if not (0.0 <= value <= 1.0):
        return error_response(
            "invalid_threshold",
            "threshold must be in [0, 1]",
            status_code=422, details={"threshold": value},
        )
    _write_config(request.app.state.store, STORE_KEY_HYBRID_THRESHOLD, value)
    logger.info("security: FILE_PROTECTION_HYBRID_THRESHOLD set to {:.3f} (Store)", value)
    state = _threshold_state(request.app.state.store)
    return JSONResponse(state)
