"""A JSON-RPC response sent as MCP Streamable HTTP's ``text/event-stream`` answer to one POST.

Each message is one ``event: message`` frame whose ``data`` is the JSON, which is what the MCP SDK's
``StreamableHTTPClientTransport`` dispatches; the stream ends after the last message. Starlette's
``StreamingResponse`` notices a client that went away only when a write fails, and does not close
its iterator then, so this response watches for ``http.disconnect`` itself and always closes the
message stream: closing it is what cancels a held call.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
from collections.abc import AsyncIterator

from loguru import logger
from starlette.responses import Response
from starlette.types import Receive, Scope, Send

_HEADERS = [
    (b"content-type", b"text/event-stream"),
    (b"cache-control", b"no-store"),
    (b"x-accel-buffering", b"no"),
]
_INTERNAL_ERROR = -32603
_EVENT_STREAM_RANGES = ("text/event-stream", "text/*", "*/*")


def accepts_event_stream(accept_headers: list[str]) -> bool:
    """Whether the ``Accept`` header makes ``text/event-stream`` acceptable. Its quality comes from the
    most specific listed range (``text/event-stream``, then ``text/*``, then ``*/*``; RFC 9110
    §12.5.1) and q=0 rejects it. A range whose q is not a number is ignored."""
    qualities: dict[str, float] = {}
    for header in accept_headers:
        for item in header.split(","):
            media, *parameters = (part.strip().lower() for part in item.split(";"))
            if media not in _EVENT_STREAM_RANGES:
                continue
            quality = next((p.split("=", 1)[1] for p in parameters if p.startswith("q=")), "1")
            try:
                qualities[media] = max(float(quality), qualities.get(media, float("-inf")))
            except ValueError:
                continue
    return next((qualities[media] > 0 for media in _EVENT_STREAM_RANGES if media in qualities), False)


def encode_message(message: dict[str, object]) -> str:
    """The message as ASCII JSON. A server's result may carry a JSON-escaped lone surrogate, which
    survives json.loads but cannot be encoded as UTF-8, so non-ASCII stays escaped."""
    try:
        return json.dumps(message, separators=(",", ":"), allow_nan=False)
    except (ValueError, TypeError, RecursionError):
        return json.dumps(
            {
                "jsonrpc": "2.0",
                "id": message.get("id"),
                "error": {"code": _INTERNAL_ERROR, "message": "The result could not be encoded as JSON."},
            }
        )


def json_rpc_response(message: dict[str, object], status_code: int = 200) -> Response:
    return Response(encode_message(message), status_code=status_code, media_type="application/json")


def frame(message: dict[str, object]) -> bytes:
    return f"event: message\ndata: {encode_message(message)}\n\n".encode("ascii")


class SseResponse(Response):
    def __init__(self, messages: AsyncIterator[dict[str, object]]) -> None:
        super().__init__(status_code=200, media_type="text/event-stream")
        self._messages = messages

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        async def pump() -> None:
            await send({"type": "http.response.start", "status": 200, "headers": _HEADERS})
            async with contextlib.aclosing(self._messages) as messages:  # type: ignore[type-var]
                async for message in messages:
                    await send({"type": "http.response.body", "body": frame(message), "more_body": True})
            await send({"type": "http.response.body", "body": b"", "more_body": False})

        async def watch() -> None:
            while (await receive())["type"] != "http.disconnect":
                pass

        pumping = asyncio.ensure_future(pump())
        watching = asyncio.ensure_future(watch())
        try:
            await asyncio.wait({pumping, watching}, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for task in (pumping, watching):
                task.cancel()
            await asyncio.gather(pumping, watching, return_exceptions=True)
            # The stream is closed even when the pump never started it, so a cancelled call settles.
            with contextlib.suppress(RuntimeError):
                await self._messages.aclose()  # type: ignore[attr-defined]
        if not pumping.cancelled():
            error = pumping.exception()
            if isinstance(error, OSError):
                logger.info("runtime SSE client went away before the response was sent")
            elif error is not None:
                raise error
        if self.background is not None:
            await self.background()
