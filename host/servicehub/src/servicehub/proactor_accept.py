"""Keep ServiceHub listening when a client resets a connection before it is accepted.

On Windows, asyncio's Proactor loop closes the listening socket when an accept fails with any
``OSError`` (``BaseProactorEventLoop._start_serving``, unchanged through CPython 3.15). A client
that resets its connection before the accept completes fails it with ERROR_NETNAME_DELETED, so
one dropped connection leaves ServiceHub running and reporting ready with nothing listening.
ServiceHub needs the Proactor loop for its child subprocesses, so the accept itself retries.
"""

from __future__ import annotations

import asyncio
import socket
import sys
from typing import Any

from loguru import logger

_ERROR_NETNAME_DELETED = 64
_installed = False


def install_accept_reset_guard() -> None:
    """Make Proactor accepts wait for the next connection when a client resets mid-accept."""
    global _installed
    if sys.platform != "win32" or _installed:
        return
    from asyncio import windows_events

    original = windows_events.IocpProactor.accept

    def accept(self: windows_events.IocpProactor, listener: socket.socket) -> asyncio.Future[Any]:
        outer: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
        current: asyncio.Future[Any]

        def attempt() -> None:
            nonlocal current
            current = original(self, listener)
            current.add_done_callback(settle)

        def settle(inner: asyncio.Future[Any]) -> None:
            if outer.done():
                if not inner.cancelled() and inner.exception() is None:
                    inner.result()[0].close()
                return
            if inner.cancelled():
                outer.cancel()
                return
            exc = inner.exception()
            if exc is None:
                outer.set_result(inner.result())
            elif isinstance(exc, OSError) and exc.winerror == _ERROR_NETNAME_DELETED:
                logger.warning("servicehub accept skipped a connection its client reset")
                try:
                    attempt()
                except OSError as retry_exc:
                    outer.set_exception(retry_exc)
            else:
                outer.set_exception(exc)

        outer.add_done_callback(lambda done: current.cancel() if done.cancelled() else None)
        attempt()
        return outer

    windows_events.IocpProactor.accept = accept  # type: ignore[method-assign]
    _installed = True
