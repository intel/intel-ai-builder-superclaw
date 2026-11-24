"""Local HTTP callback server (stdlib http.server, thread-per-flow).

Captures ``?code=...&state=...`` (or ``?error=...``) from the provider's
authorize redirect, signals the waiting flow via a ``threading.Event``, and
shows a minimal close-this-window page. Bound to ``127.0.0.1`` only.
"""

from __future__ import annotations

import http.server
import threading
from typing import Optional
from urllib.parse import parse_qs, urlparse

from .constants import OPENAI
from .errors import NoCallbackPort


_CLOSE_HTML = (
    b"<!doctype html><html><head><meta charset=utf-8>"
    b"<title>SuperClaw OAuth</title></head>"
    b"<body style=\"font-family:system-ui,sans-serif;"
    b"text-align:center;padding-top:5em;color:#111\">"
    b"<h1>You can close this window.</h1>"
    b"<p style=\"color:#666\">SuperClaw received the OAuth callback."
    b" Return to the app to continue.</p></body></html>"
)


class _CallbackHandler(http.server.BaseHTTPRequestHandler):
    """Silent handler — writes closing HTML, signals holder, returns.

    Subclassed per-server to inject a fresh state dict per flow.
    """

    server_state: dict = {}

    def do_GET(self) -> None:  # noqa: N802 — http.server API
        parsed = urlparse(self.path)
        if parsed.path != OPENAI.callback_path:
            self.send_response(404)
            self.end_headers()
            return

        query = parse_qs(parsed.query)
        code = _first(query.get("code"))
        state = _first(query.get("state"))
        error = _first(query.get("error"))

        # Only record the FIRST callback delivery; a duplicate GET (prefetch,
        # refresh) is answered 200 but does not overwrite the recorded result.
        holder = self.server_state
        if holder.get("result") is None:
            holder["result"] = (code, state, error)
            holder["event"].set()

        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(_CLOSE_HTML)

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        return  # silence stderr — FastAPI logger owns output


def _first(xs: Optional[list[str]]) -> Optional[str]:
    return xs[0] if xs else None


class _NoReuseHTTPServer(http.server.HTTPServer):
    """HTTPServer that does NOT set SO_REUSEADDR — so a second bind on a held
    port fails cleanly (the 'bind fails = port taken' signal we probe on)."""

    allow_reuse_address = False


def start(port_range: range = OPENAI.callback_port_range) -> tuple[int, dict]:
    """Bind a callback server on a free port in ``port_range``.

    Returns ``(port, state_holder)``. ``state_holder`` keys: ``event`` (set on
    first callback), ``result`` (``(code, state, error)``), ``httpd``, ``thread``.
    Caller MUST call ``stop(state_holder)`` to release the port.
    """
    state_holder: dict = {"result": None, "event": threading.Event()}
    handler_cls = type(
        "_BoundCallbackHandler", (_CallbackHandler,), {"server_state": state_holder}
    )
    # Bind directly in the probe loop (no separate probe socket) to close the
    # TOCTOU race where the probe socket closes and another process grabs the
    # port before HTTPServer rebinds.
    port: Optional[int] = None
    httpd: Optional[http.server.HTTPServer] = None
    for candidate in port_range:
        try:
            httpd = _NoReuseHTTPServer(("127.0.0.1", candidate), handler_cls)
            port = candidate
            break
        except OSError:
            continue
    if httpd is None or port is None:
        raise NoCallbackPort(f"no free port in {port_range.start}-{port_range.stop - 1}")
    thread = threading.Thread(
        target=httpd.serve_forever, name=f"oauth-callback-{port}", daemon=True
    )
    thread.start()
    state_holder["httpd"] = httpd
    state_holder["thread"] = thread
    return port, state_holder


def stop(state_holder: dict) -> None:
    """Shut down the callback server. Idempotent."""
    httpd = state_holder.get("httpd")
    if httpd is not None:
        try:
            httpd.shutdown()
        except Exception:
            pass
        try:
            httpd.server_close()
        except Exception:
            pass
        state_holder["httpd"] = None
    thread = state_holder.get("thread")
    if thread is not None and thread.is_alive():
        thread.join(timeout=2.0)
