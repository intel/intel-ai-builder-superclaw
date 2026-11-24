"""Request size limits for the data-protection service."""

from __future__ import annotations

from typing import Any, Awaitable, Callable, TypeAlias

_ASGIScope: TypeAlias = dict[str, Any]
_ASGIMessage: TypeAlias = dict[str, Any]
_ASGIReceive: TypeAlias = Callable[[], Awaitable[_ASGIMessage]]
_ASGISend: TypeAlias = Callable[[_ASGIMessage], Awaitable[None]]
_ASGIApp: TypeAlias = Callable[[_ASGIScope, _ASGIReceive, _ASGISend], Awaitable[None]]


class BodyTooLarge(Exception):
    """Internal signal used to convert an oversized streamed body into HTTP 413."""


class BodySizeLimitMiddleware:
    """Reject HTTP request bodies larger than a configured byte cap.

    Args:
        app: Downstream ASGI application.
        max_bytes: Maximum allowed request body size in bytes.
    """

    def __init__(self, app: _ASGIApp, max_bytes: int) -> None:
        """Initialize the body-size limiter.

        Args:
            app: Downstream ASGI application.
            max_bytes: Maximum allowed request body size in bytes.
        """
        self._app = app
        self._max_bytes = int(max_bytes)

    async def __call__(
        self,
        scope: _ASGIScope,
        receive: _ASGIReceive,
        send: _ASGISend,
    ) -> None:
        """Process one ASGI request and reject oversized bodies.

        Args:
            scope: ASGI connection scope.
            receive: ASGI receive callable.
            send: ASGI send callable.
        """
        if scope.get("type") != "http":
            await self._app(scope, receive, send)
            return

        headers = {
            k.decode("latin-1").lower(): v.decode("latin-1")
            for k, v in scope.get("headers", [])
        }
        content_length = headers.get("content-length")
        if content_length is not None:
            try:
                declared = int(content_length)
            except ValueError:
                await self._reject(send, "malformed_content_length")
                return
            if declared > self._max_bytes:
                await self._reject(send, "body_too_large")
                return

        received = 0
        max_bytes = self._max_bytes

        async def _capped_receive() -> _ASGIMessage:
            """Read one request message while enforcing the body cap.

            Returns:
                _ASGIMessage: Next ASGI request message.

            Raises:
                BodyTooLarge: If the streamed body exceeds the byte cap.
            """
            nonlocal received
            message = await receive()
            if message.get("type") == "http.request":
                body = message.get("body") or b""
                received += len(body)
                if received > max_bytes:
                    # Stop before downstream parsers can buffer the oversized body.
                    raise BodyTooLarge()
            return message

        try:
            await self._app(scope, _capped_receive, send)
        except BodyTooLarge:
            await self._reject(send, "body_too_large")

    async def _reject(self, send: _ASGISend, error_code: str) -> None:
        """Send a JSON HTTP 413 rejection response.

        Args:
            send: ASGI send callable.
            error_code: Stable error code included in the response body.
        """
        body = (
            b'{"detail":{"error":"' + error_code.encode("ascii")
            + b'","message":"Request body exceeds the configured maximum."}}'
        )
        await send({
            "type": "http.response.start",
            "status": 413,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode("ascii")),
            ],
        })
        await send({
            "type": "http.response.body",
            "body": body,
            "more_body": False,
        })