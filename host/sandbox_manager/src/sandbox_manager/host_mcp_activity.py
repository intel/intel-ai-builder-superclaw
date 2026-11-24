"""What the host MCP gateway says runs outside the sandbox, for the isolation report.

Contract touched: ``HostMcpSummary`` (``host-mcp-api.ts``), read from the gateway's unguarded
``GET /mcp-host/v1/summary``, and the report's ``host_mcp_execution_enabled`` warning.

The answer never fails open. A valid summary, zero or not, replaces the last one. So does finding
nothing listening on the gateway's port. A timeout, a malformed answer or any other failure keeps
the last answer, so a warning about servers running on the host is not dropped because a read was slow.

Windows does not report a connect to a closed loopback port as refused until its SYN retries run out,
which takes seconds, so on Windows "nothing listens" comes from the TCP listener table instead, before
any connect. Each read has a total deadline, so a gateway that answers one byte at a time cannot hold
the worker. Only the first read of this process blocks the report; after that the report takes the
last answer and a stale one is refreshed in the background.
"""

from __future__ import annotations

import ctypes
import socket
import sys
import threading
import time
from collections.abc import Callable

from contracts.host_mcp_api_data import HOST_MCP_RULES
from contracts.host_mcp_summary import HostMcpSummary
from loguru import logger
from pydantic import ValidationError

from .native_isolation.isolation_report_producer import HostMcpActivity

#: How long an answer is served before it is read again.
MAX_AGE_SECONDS = 2.0
#: The whole read, connect to last byte.
READ_DEADLINE_SECONDS = 0.4
_HOST = "127.0.0.1"
_SUMMARY_PATH = f"{HOST_MCP_RULES['proxy_prefix']}/v1/summary"
_ANSWER_MAX_BYTES = 4096


class HostMcpUnavailable(Exception):
    """The read said nothing about what runs on the host: a timeout, a refusal to answer, a bad answer."""


class HostMcpGone(Exception):
    """Nothing listens on the gateway's port."""


def _nothing_listens_windows(port: int) -> bool:
    """True only when the IPv4 listener table has no socket on ``port``; False when it cannot tell."""
    get_table = ctypes.WinDLL("iphlpapi").GetExtendedTcpTable  # type: ignore[attr-defined]
    af_inet, tcp_table_basic_listener, error_insufficient_buffer = 2, 0, 122
    size = ctypes.c_ulong(0)
    for _ in range(3):
        buffer = ctypes.create_string_buffer(max(size.value, 4))
        result = get_table(buffer, ctypes.byref(size), False, af_inet, tcp_table_basic_listener, 0)
        if result == error_insufficient_buffer:
            continue
        if result != 0:
            return False
        rows = (ctypes.c_uint32 * (1 + 5 * ctypes.c_uint32.from_buffer(buffer).value)).from_buffer(buffer)
        local_ports = (socket.ntohs(rows[1 + 5 * row + 2] & 0xFFFF) for row in range(rows[0]))
        return port not in local_ports
    return False


def _nothing_listens(port: int) -> bool:
    if sys.platform != "win32":
        return False
    try:
        return _nothing_listens_windows(port)
    except OSError:
        return False


def _exchange(port: int, deadline_s: float) -> bytes:
    """The raw answer to one GET, read until the server closes, within ``deadline_s`` in total."""
    deadline = time.monotonic() + deadline_s
    request = (
        f"GET {_SUMMARY_PATH} HTTP/1.1\r\nHost: {_HOST}:{port}\r\nAccept: application/json\r\n"
        "Connection: close\r\n\r\n"
    ).encode("ascii")
    with socket.create_connection((_HOST, port), timeout=deadline_s) as connection:
        connection.settimeout(max(deadline - time.monotonic(), 0.001))
        connection.sendall(request)
        answer = bytearray()
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("read deadline")
            connection.settimeout(remaining)
            chunk = connection.recv(_ANSWER_MAX_BYTES + 1)
            if not chunk:
                return bytes(answer)
            answer += chunk
            if len(answer) > 2 * _ANSWER_MAX_BYTES:
                raise HostMcpUnavailable("answer over the size cap")


def _summary_body(answer: bytes) -> bytes:
    head, separator, body = answer.partition(b"\r\n\r\n")
    if not separator:
        raise HostMcpUnavailable("incomplete answer")
    lines = head.decode("latin-1").split("\r\n")
    status = lines[0].split(" ", 2)
    if len(status) < 2 or not status[0].startswith("HTTP/1.") or status[1] != "200":
        raise HostMcpUnavailable(f"status {status[1] if len(status) > 1 else '?'}")
    headers = {
        name.strip().lower(): value.strip()
        for name, _, value in (line.partition(":") for line in lines[1:])
    }
    if "chunked" in headers.get("transfer-encoding", "").lower():
        raise HostMcpUnavailable("chunked answer")
    length = headers.get("content-length")
    if length is not None:
        if not length.isdigit() or int(length) != len(body):
            raise HostMcpUnavailable("body does not match its length")
    if len(body) > _ANSWER_MAX_BYTES:
        raise HostMcpUnavailable("answer over the size cap")
    return body


def read_summary(
    port: int = HOST_MCP_RULES["port"], deadline_s: float = READ_DEADLINE_SECONDS
) -> HostMcpActivity:
    """The gateway's summary. Raises HostMcpGone when nothing listens, HostMcpUnavailable otherwise."""
    if _nothing_listens(port):
        raise HostMcpGone("no listener")
    try:
        answer = _exchange(port, deadline_s)
    except ConnectionRefusedError:
        raise HostMcpGone("connection refused") from None
    except OSError as exc:
        raise HostMcpUnavailable(type(exc).__name__) from None
    try:
        summary = HostMcpSummary.model_validate_json(_summary_body(answer), strict=True)
    except ValidationError:
        raise HostMcpUnavailable("not a summary") from None
    return HostMcpActivity(
        host_server_count=summary.host_server_count,
        host_browser_active=summary.host_browser_active,
    )


def _in_background(refresh: Callable[[], None]) -> None:
    threading.Thread(target=refresh, name="host-mcp-summary", daemon=True).start()


class HostMcpActivityCache:
    """The last authoritative answer: a summary, or None when nothing listens or nothing was learned yet."""

    def __init__(
        self,
        read: Callable[[], HostMcpActivity] = read_summary,
        clock: Callable[[], float] = time.monotonic,
        start: Callable[[Callable[[], None]], None] = _in_background,
    ) -> None:
        self._read = read
        self._clock = clock
        self._start = start
        self._lock = threading.Lock()
        self._value: HostMcpActivity | None = None
        self._taken_at: float | None = None
        self._refreshing = False
        self._failure_logged = False

    def current(self) -> HostMcpActivity | None:
        with self._lock:
            taken_at = self._taken_at
            if taken_at is not None and (self._refreshing or self._clock() - taken_at < MAX_AGE_SECONDS):
                return self._value
            first = taken_at is None
            self._refreshing = True
        if first:
            self._refresh()
        else:
            self._start(self._refresh)
        with self._lock:
            return self._value

    def _refresh(self) -> None:
        with self._lock:
            value = self._value
        try:
            value = self._read()
        except HostMcpGone as exc:
            # Nothing listens, so the gateway process is gone, and its kill-on-close Jobs took every host server with it.
            value = None
            self._log_failure(exc, "reporting nothing on the host")
        except HostMcpUnavailable as exc:
            self._log_failure(exc, "keeping the last answer")
        else:
            self._failure_logged = False
        finally:
            with self._lock:
                self._value = value
                self._taken_at = self._clock()
                self._refreshing = False

    def _log_failure(self, exc: Exception, outcome: str) -> None:
        if not self._failure_logged:
            logger.debug("host-mcp-summary: event=unavailable reason={}; {}", exc, outcome)
            self._failure_logged = True
