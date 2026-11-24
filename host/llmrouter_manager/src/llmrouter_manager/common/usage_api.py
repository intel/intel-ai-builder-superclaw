"""FastAPI router for /llm-router/v1/usage/* endpoints.

Three endpoints (design section 6):
- GET  /llm-router/v1/usage         - cross-session aggregate (optionally grouped).
- GET  /llm-router/v1/usage/events  - paginated per-request events.
- DELETE /llm-router/v1/usage       - truncate both tables (idempotent).

No auth (ServiceHub sub-service contract).
"""

from __future__ import annotations

from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse

from .errors import error_response
from .usage_store import UsageStore


usage_router = APIRouter(prefix="/llm-router/v1/usage", tags=["usage"])


def _store(request: Request) -> UsageStore | None:
    return getattr(request.app.state, "usage_store", None)


def _no_store_error() -> JSONResponse:
    return error_response(
        "usage_store_unavailable",
        "usage store not initialized",
        status_code=500,
    )


@usage_router.get("", response_model=None)
async def get_usage(
    request: Request,
    group_by: str = Query(
        "none",
        description=(
            "none | model | provider | source | alias. `alias` rows come from "
            "the capped token_events trail, so they can sum to less than "
            "`total`; see UsageStore.query_aggregate."
        ),
    ),
) -> dict | JSONResponse:
    store = _store(request)
    if store is None:
        return _no_store_error()
    try:
        return store.query_aggregate(group_by=group_by)  # type: ignore[arg-type]
    except ValueError as exc:
        return error_response("invalid_group_by", str(exc), status_code=400)
    except Exception as exc:
        return error_response(
            "usage_store_error", str(exc)[:500], status_code=500
        )


@usage_router.get("/events", response_model=None)
async def get_usage_events(
    request: Request,
    session_id: str | None = Query(None),
    message_id: str | None = Query(None),
    since_ms: int | None = Query(None),
    limit: int = Query(100, ge=1, le=1000),
) -> dict | JSONResponse:
    store = _store(request)
    if store is None:
        return _no_store_error()
    try:
        events, next_cursor = store.query_events(
            session_id=session_id,
            message_id=message_id,
            since_ms=since_ms,
            limit=limit,
        )
    except ValueError as exc:
        return error_response("invalid_query", str(exc), status_code=400)
    except Exception as exc:
        return error_response(
            "usage_store_error", str(exc)[:500], status_code=500
        )
    payload: dict = {"events": events}
    if next_cursor is not None:
        payload["next_since_ms"] = next_cursor
    return payload


@usage_router.delete("", response_model=None)
async def delete_usage(request: Request) -> dict | JSONResponse:
    store = _store(request)
    if store is None:
        return _no_store_error()
    try:
        store.truncate()
    except Exception as exc:
        return error_response(
            "usage_store_error", str(exc)[:500], status_code=500
        )
    return {"cleared": True}
