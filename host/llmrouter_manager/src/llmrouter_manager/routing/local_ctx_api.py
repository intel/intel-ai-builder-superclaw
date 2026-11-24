"""Control-plane endpoint for the local llama-server ``-c`` context-size
override — an internal experiment knob so operators can sweep context sizes
without rebuilding the installer or editing the shipping registry.

``GET /llm-router/v1/local/ctx-size``  → LocalCtxSize (persisted override +
                                          value currently applied to
                                          llama-server + which layer it came
                                          from + support flag)
``PUT /llm-router/v1/local/ctx-size``  body LocalCtxSizeUpdate (``ctx_size:
                                          int|null``) → same shape

Precedence (highest wins):
  1. env ``LATENTFACTOR_LOCAL_CTX``
  2. Store ``local_ctx_size_override``  (this endpoint's persistence)
  3. booster ``tuned_args.ctx_size``
  4. registry ``entry.default_ctx``

``-c`` is a llama-server launch flag — there's no runtime API to change it.
So the PUT handler **awaits ``supervisor[ROLE_CHAT].restart()``** after
persisting, and only returns 200 once the supervisor is ``ready`` again.
The response carries ``restarted: true`` on success. That takes 30-60s of
cold-load; the UI disables the panel while the request is in flight.

Edge server is NOT touched by this endpoint — override only applies to the
local llama-server route the ``chat`` role facade owns.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from loguru import logger

from ..common.errors import error_response
from ..common.store import Store, default_db_path
from ..local.registry import ROLE_CHAT

local_ctx_router = APIRouter(prefix="/llm-router/v1", tags=["routing.local-ctx-size"])

_CONFIG_KEY = "local_ctx_size_override"
_ACTIVE_TUNING_FILENAME = "active-llm-tuning.json"

# Sane bounds for a llama-server ``-c`` override. Must stay in lockstep with the
# UI slider (apps/ui/src/app/components/local-ctx-size-slider.tsx MIN_CTX/MAX_CTX)
# so a value the UI accepts is a value the API accepts. The upper bound also
# caps a wedged-boot scenario: without it, a direct-API caller could persist a
# ctx too big for llama-server to start, and each boot would re-attempt the
# failing ``-c`` until someone cleared the Store key. Values outside the range
# are rejected by the PUT and silently discarded by the on-boot read (so an
# already-poisoned Store auto-heals to the registry default).
MIN_CTX_SIZE = 1024
MAX_CTX_SIZE = 262144


def is_valid_persisted_ctx_size(value: int | None) -> bool:
    """True when ``value`` is a positive int in ``[MIN_CTX_SIZE, MAX_CTX_SIZE]``.

    Shared with ``local/supervisor.py::_read_store_ctx_override`` so the boot-time
    read and the endpoint validator apply exactly the same bounds — no way for
    the two to drift."""
    return isinstance(value, int) and not isinstance(value, bool) \
        and MIN_CTX_SIZE <= value <= MAX_CTX_SIZE


def _read_persisted() -> Optional[int]:
    """Read the Store override. Returns None when unset, unreachable, or
    out of range — an out-of-range value (from before bounds were enforced,
    or from an older build) is treated as unset so the boot cycle falls back
    to registry ``default_ctx`` instead of retrying a failing ``-c``."""
    try:
        store = Store(default_db_path())
        try:
            raw = store.get_config(_CONFIG_KEY)
        finally:
            store.close()
    except Exception:  # noqa: BLE001
        return None
    if raw is None:
        return None
    try:
        n = int(raw)
    except (TypeError, ValueError):
        logger.warning("bad Store[{}]={!r}; treating as unset", _CONFIG_KEY, raw)
        return None
    if not is_valid_persisted_ctx_size(n):
        logger.warning(
            "out-of-range Store[{}]={} (allowed {}-{}); treating as unset",
            _CONFIG_KEY, n, MIN_CTX_SIZE, MAX_CTX_SIZE,
        )
        return None
    return n


def _write_persisted(value: Optional[int]) -> None:
    """Persist (or clear) the override. ``None`` sets the key to JSON null so the
    next supervisor cycle falls back to registry ``default_ctx``."""
    store = Store(default_db_path())
    try:
        if value is None:
            store.set_config(_CONFIG_KEY, None)
        else:
            store.set_config(_CONFIG_KEY, int(value))
    finally:
        store.close()


def _read_applied(app_state: Any) -> Optional[int]:
    """Read the ctx llama-server is currently running with, from
    ``active-llm-tuning.json`` (published by supervisor after every restart).
    Returns None when the file is missing (supervisor not yet started)."""
    local_config = getattr(app_state, "local_config", None)
    data_dir = getattr(local_config, "data_dir", None)
    if data_dir is None:
        return None
    path = Path(data_dir) / _ACTIVE_TUNING_FILENAME
    if not path.is_file():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return None
    v = payload.get("ctx_size")
    try:
        n = int(v)
    except (TypeError, ValueError):
        return None
    return n if n > 0 else None


def _resolve_source(
    persisted: Optional[int],
    applied: Optional[int],
    env_value: Optional[str],
) -> str:
    """Which precedence layer does ``applied`` correspond to? Best-effort
    labelling for UI ("using env override" / "using saved override" / etc.).
    Returns 'unknown' when we can't reconcile the values (e.g. supervisor
    isn't running yet, or the file lags a restart)."""
    if applied is None:
        return "unknown"
    if env_value:
        try:
            if int(env_value) == applied:
                return "env"
        except (TypeError, ValueError):
            pass
    if persisted is not None:
        if persisted == applied:
            return "store"
        # An override is persisted but the running value is smaller — the
        # booster shrank it as a hardware safety net.
        if applied < persisted:
            return "booster"
        # applied > persisted: file lags the persisted value (stale
        # active-llm-tuning.json across a restart), or something else set
        # ctx_size out-of-band. Don't lie about the source.
        return "unknown"
    # No persisted override → the registry default won.
    return "registry"


def _supervisor_supported(app_state: Any) -> bool:
    """True when the supervisor exposes a ``restart()`` coroutine on the chat
    facade — false for unusual deployments / test fakes without one."""
    supervisor = getattr(app_state, "supervisor", None)
    if supervisor is None:
        return False
    facade = supervisor.get(ROLE_CHAT) if hasattr(supervisor, "get") else None
    return facade is not None and hasattr(facade, "restart")


@local_ctx_router.get("/local/ctx-size")
async def get_local_ctx_size(request: Request) -> JSONResponse:
    persisted = _read_persisted()
    applied = _read_applied(request.app.state)
    source = _resolve_source(
        persisted, applied, os.environ.get("LATENTFACTOR_LOCAL_CTX"),
    )
    return JSONResponse({
        "ctx_size": persisted,
        "applied": applied,
        "source": source,
        "supported": _supervisor_supported(request.app.state),
    })


@local_ctx_router.put("/local/ctx-size")
async def put_local_ctx_size(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception as exc:  # noqa: BLE001
        return error_response("invalid_json", f"invalid JSON body: {exc}", status_code=400)
    if not isinstance(body, dict) or "ctx_size" not in body:
        return error_response(
            "invalid_body",
            f"body must be a JSON object with a 'ctx_size' field "
            f"(int in [{MIN_CTX_SIZE}, {MAX_CTX_SIZE}] or null)",
            status_code=422,
        )
    raw = body["ctx_size"]
    if raw is None:
        new_value: Optional[int] = None
    else:
        if isinstance(raw, bool) or not isinstance(raw, int):
            return error_response(
                "invalid_ctx_size",
                f"ctx_size must be an integer in [{MIN_CTX_SIZE}, {MAX_CTX_SIZE}] "
                f"or null",
                status_code=422, details={"ctx_size": raw},
            )
        if not is_valid_persisted_ctx_size(raw):
            return error_response(
                "invalid_ctx_size",
                f"ctx_size must be in [{MIN_CTX_SIZE}, {MAX_CTX_SIZE}] "
                f"(or null to clear the override)",
                status_code=422, details={"ctx_size": raw},
            )
        new_value = int(raw)

    if not _supervisor_supported(request.app.state):
        return error_response(
            "supervisor_unavailable",
            "the local chat supervisor is not exposed by this deployment",
            status_code=409,
        )

    # Persist FIRST so a supervisor restart failure below still leaves the
    # right override on disk for the next boot cycle.
    try:
        _write_persisted(new_value)
    except Exception as exc:  # noqa: BLE001
        logger.exception("failed to persist local ctx-size override")
        return error_response(
            "persist_failed",
            f"failed to persist ctx_size override: {exc}",
            status_code=500,
            extra={
                "ctx_size": new_value,
                "applied": _read_applied(request.app.state),
                "source": "unknown",
                "restarted": False,
                "supported": True,
            },
        )

    # Cycle llama-server so the new -c takes effect. `-c` is a launch-time
    # flag; there is no runtime API alternative. The chat facade's restart()
    # rebuilds the INI (via _chat_section_options → resolve_ctx_size_env →
    # our new Store lookup) and re-spawns the process. Takes 30-60s cold.
    supervisor = request.app.state.supervisor
    facade = supervisor[ROLE_CHAT]
    try:
        await facade.restart()
    except Exception as exc:  # noqa: BLE001
        logger.exception("supervisor.restart() after ctx-size PUT failed")
        return error_response(
            "restart_failed",
            f"supervisor restart failed: {exc}",
            status_code=500,
            extra={
                "ctx_size": new_value,
                "applied": _read_applied(request.app.state),
                "source": "unknown",
                "restarted": False,
                "supported": True,
            },
        )

    # llama-server now runs with the new -c. The routing proxy caches the probed
    # local n_ctx (used to derive the context cap for the compaction guard, and
    # read by the read-guard plugin over /v1/models); drop it so the very next
    # chat request re-probes the new window instead of using the old cached value.
    try:
        from .proxy import invalidate_local_n_ctx_cache
        invalidate_local_n_ctx_cache()
        logger.info("invalidated cached local n_ctx after ctx-size change -> {}", new_value)
    except Exception as exc:  # noqa: BLE001
        logger.warning("could not invalidate local n_ctx cache after ctx-size PUT: {}", exc)

    applied = _read_applied(request.app.state)
    source = _resolve_source(
        new_value, applied, os.environ.get("LATENTFACTOR_LOCAL_CTX"),
    )
    logger.info(
        "local ctx-size override set to {} (persisted + supervisor restarted; applied={})",
        new_value, applied,
    )
    return JSONResponse({
        "ctx_size": new_value,
        "applied": applied,
        "source": source,
        "restarted": True,
        "supported": True,
    })
