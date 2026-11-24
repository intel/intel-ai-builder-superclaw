"""ServiceHub-owned event stream routes."""

from __future__ import annotations

import json
import secrets
from collections.abc import AsyncIterator
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import StreamingResponse

from servicehub.common.errors import error_body
from servicehub.events.ring_buffer import EventRecord


router = APIRouter(prefix="/app")
_MAX_EVENT_STREAMS = 10
_EVENT_TICKET_TTL_SECONDS = 15


@router.get("/events")
async def app_events(request: Request, since: str | None = None) -> StreamingResponse:
    _consume_ticket_if_present(request)
    cursor = _parse_cursor(since)
    event_buffer = request.app.state.event_buffer
    if cursor is None:
        cursor = await event_buffer.oldest_replay_cursor()
    elif await event_buffer.is_expired(cursor):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=error_body(
                "event_cursor_expired",
                "Requested event cursor is older than the ServiceHub event buffer",
            ),
        )
    return StreamingResponse(
        _stream_events(request=request, cursor=cursor),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/events/tickets")
async def create_event_ticket(request: Request) -> dict[str, object]:
    ticket = secrets.token_urlsafe(24)
    expires_at = datetime.now(timezone.utc) + timedelta(seconds=_EVENT_TICKET_TTL_SECONDS)
    request.app.state.event_tickets[ticket] = expires_at
    return {
        "ticket": ticket,
        "expires_at": expires_at.isoformat(timespec="seconds").replace("+00:00", "Z"),
        "ttl_s": _EVENT_TICKET_TTL_SECONDS,
    }


def _consume_ticket_if_present(request: Request) -> None:
    ticket = request.query_params.get("ticket")
    if ticket is None:
        return
    tickets: dict[str, datetime] = request.app.state.event_tickets
    expires_at = tickets.pop(ticket, None)
    now = datetime.now(timezone.utc)
    _prune_expired_tickets(tickets, now)
    if expires_at is None or expires_at <= now:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=error_body("invalid_event_ticket", "Event stream ticket is invalid or expired"),
        )


def _prune_expired_tickets(tickets: dict[str, datetime], now: datetime) -> None:
    for ticket, expires_at in list(tickets.items()):
        if expires_at <= now:
            tickets.pop(ticket, None)


def _parse_cursor(raw: str | None) -> int | None:
    if raw is None or raw == "":
        return None
    try:
        cursor = int(raw)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=error_body("invalid_event_cursor", "Event cursor must be a non-negative integer"),
        ) from exc
    if cursor < 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=error_body("invalid_event_cursor", "Event cursor must be a non-negative integer"),
        )
    return cursor


async def _stream_events(request: Request, cursor: int) -> AsyncIterator[bytes]:
    event_buffer = request.app.state.event_buffer
    keepalive_s = float(getattr(request.app.state, "event_keepalive_s", 15.0))
    test_limit = getattr(request.app.state, "event_stream_test_limit", None)
    active_streams = getattr(request.app.state, "active_event_streams", 0)
    max_streams = int(getattr(request.app.state, "max_event_streams", _MAX_EVENT_STREAMS))
    if active_streams >= max_streams:
        yield _format_event(
            EventRecord(
                cursor=cursor,
                event_type="error",
                service="servicehub",
                payload={"error": {"code": "too_many_event_streams", "message": "Too many active event streams"}},
            )
        )
        return
    request.app.state.active_event_streams = active_streams + 1
    emitted = 0
    try:
        while True:
            if await request.is_disconnected():
                return
            events = await event_buffer.wait_for_events_after(cursor, timeout_s=keepalive_s)
            if not events:
                yield b": keepalive\n\n"
                continue
            for event in events:
                yield _format_event(event)
                cursor = event.cursor
                emitted += 1
                if isinstance(test_limit, int) and emitted >= test_limit:
                    return
    finally:
        request.app.state.active_event_streams = max(0, request.app.state.active_event_streams - 1)


def _format_event(event: EventRecord) -> bytes:
    data = json.dumps(event.as_dict(), separators=(",", ":"))
    return f"id: {event.cursor}\nevent: {event.event_type}\ndata: {data}\n\n".encode("utf-8")


_ALLOWED_OPERATION_PROGRESS_KEYS = frozenset({"operation_id", "state", "pct", "message"})


def sanitize_event_payload(payload: dict[str, object]) -> dict[str, object]:
    return {
        key: value
        for key, value in payload.items()
        if key in _ALLOWED_OPERATION_PROGRESS_KEYS and isinstance(value, str | int | float | bool | type(None))
    }
