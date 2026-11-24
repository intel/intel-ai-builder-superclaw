"""Control-plane endpoint for the auto-router perf_weight dial (plan §12).

``GET /llm-router/v1/perf-weight``  → ``{"perf_weight": float, "supported": bool}``
``PUT /llm-router/v1/perf-weight``  body ``{"perf_weight": 0..1}`` → same shape.

perf_weight is the quality-vs-cost balance for auto routing (higher → cloud,
lower → local). This is management traffic, so it lives on the control plane
(``/llm-router/v1/*``, reached via ServiceHub's proxy), NOT the data-plane
``/v1/chat/completions``.

Persistence: PUT writes the value to the Store config KV (source of truth on 
next start) FIRST, then live-updates the loaded adapter. ``supported`` is 
False when the active router can't take the knob (older adapter) so the UI 
hides the slider; PUT then 409s.
"""
from __future__ import annotations

import asyncio
import threading
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from loguru import logger

from ..common.errors import error_response
from ..common.store import Store, default_db_path

perf_weight_router = APIRouter(prefix="/llm-router/v1", tags=["routing.perf-weight"])

_CONFIG_KEY = "perf_weight"
_UPDATE_LOCK = threading.Lock()


def _adapter() -> Any:
    """Return the process-wide latency-router adapter."""
    from .auto_router.adapter import get_adapter

    return get_adapter()


def _supported(adapter: Any) -> bool:
    """True when the active router can take a live perf_weight update."""
    return hasattr(adapter, "set_perf_weight") and hasattr(adapter, "get_perf_weight")


@perf_weight_router.get("/perf-weight")
async def get_perf_weight(_request: Request) -> JSONResponse:
    adapter = _adapter()
    if not _supported(adapter):
        # Report the persisted/default value with supported=false so the UI can
        # still show state but hides the (non-functional) slider.
        return JSONResponse({"perf_weight": _read_persisted(), "supported": False})
    value = await asyncio.to_thread(adapter.get_perf_weight)
    return JSONResponse({"perf_weight": value, "supported": True})


@perf_weight_router.put("/perf-weight")
async def put_perf_weight(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception as exc:  # noqa: BLE001
        return error_response("invalid_json", f"invalid JSON body: {exc}", status_code=400)
    if not isinstance(body, dict) or "perf_weight" not in body:
        return error_response(
            "invalid_body", "body must be a JSON object with a 'perf_weight' field",
            status_code=422,
        )
    raw = body["perf_weight"]
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        return error_response(
            "invalid_perf_weight", "perf_weight must be a number in [0, 1]",
            status_code=422, details={"perf_weight": raw},
        )
    value = float(raw)
    if not (0.0 <= value <= 1.0):
        return error_response(
            "invalid_perf_weight", "perf_weight must be in [0, 1]",
            status_code=422, details={"perf_weight": value},
        )

    adapter = _adapter()
    if not _supported(adapter):
        return error_response(
            "perf_weight_unsupported",
            "the active router does not support a live perf_weight update",
            status_code=409,
        )

    def apply_update() -> float:
        # Persist FIRST, then live-update under one lock so concurrent PUTs cannot reorder the two writes.
        with _UPDATE_LOCK:
            _write_persisted(value)
            return adapter.set_perf_weight(value)

    applied = await asyncio.to_thread(apply_update)
    logger.info("perf_weight set to {:.3f} (persisted + live)", applied)
    return JSONResponse({"perf_weight": applied, "supported": True})


def _read_persisted() -> float:
    """Best-effort read of the persisted perf_weight, else the adapter default."""
    try:
        store = Store(default_db_path())
        try:
            raw = store.get_config(_CONFIG_KEY)
        finally:
            store.close()
        if raw is not None:
            return max(0.0, min(1.0, float(raw)))
    except Exception:  # noqa: BLE001
        pass
    from .auto_router.adapter import LatencyRouterAdapter

    return LatencyRouterAdapter._DEFAULT_PERF_WEIGHT


def _write_persisted(value: float) -> None:
    store = Store(default_db_path())
    try:
        store.set_config(_CONFIG_KEY, value)
    finally:
        store.close()
