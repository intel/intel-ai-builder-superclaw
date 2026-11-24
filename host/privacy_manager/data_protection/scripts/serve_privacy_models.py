"""Serve a privacy models directory over loopback HTTP, as a stand-in model host.

privacy_manager downloads ``<base>/<model>.zip`` for each model in
``protection_service/model_manifest.json``. This serves a directory of those
zips as a stand-in host, so the download path can be exercised end to end.
Build the zips the manifest pins with
``gen_model_manifest.py --zip-dir OUT``, then:

    uv run python scripts/serve_privacy_models.py --root OUT --port 18990
    $env:SUPERCLAW_PRIVACY_MODEL_BASE_URL = "http://127.0.0.1:18990"

Stdlib only. Unlike ``http.server``, it honours ``Range: bytes=N-`` (206 +
Content-Range, 416 past the end), which the downloader's resume relies on.

Fault injection, for exercising the downloader's recovery paths. RELPATH is the
URL path without the leading slash, e.g.
``pplx-pii-masking-ov-int8.zip``:

    --throttle-kbps N        cap every response at N KiB/s
    --drop-after-bytes N     cut the first response longer than N bytes after
                             N bytes (once per server), to exercise resume
    --corrupt RELPATH        flip the middle byte of RELPATH, to exercise hash
                             rejection; --corrupt-count sets how many responses
                             (default 1, 0 = every one)
    --ignore-range           answer every Range request with 200 and the whole
                             file, to exercise the restart-from-zero path
    --status-for REL=CODE    answer REL with HTTP CODE; REL=CODE:N for the
                             first N requests only
"""

from __future__ import annotations

import argparse
import re
import sys
import threading
import time
import urllib.parse
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

_CHUNK = 65_536
_RANGE = re.compile(r"^bytes=(\d+)-(\d*)$")


@dataclass
class Faults:
    throttle_kbps: float = 0.0
    drop_after_bytes: int = 0
    corrupt: dict[str, int] = field(default_factory=dict)
    ignore_range: bool = False
    # relpath -> (status, remaining requests; -1 = every request)
    status_for: dict[str, list[int]] = field(default_factory=dict)
    _dropped: bool = field(default=False, init=False)
    _lock: threading.Lock = field(default_factory=threading.Lock, init=False)

    def take_drop(self, length: int) -> int | None:
        """Body offset to cut this response at, or None."""
        with self._lock:
            if self.drop_after_bytes <= 0 or self._dropped or length <= self.drop_after_bytes:
                return None
            self._dropped = True
            return self.drop_after_bytes

    def take_corrupt(self, rel: str) -> bool:
        with self._lock:
            remaining = self.corrupt.get(rel)
            if remaining is None:
                return False
            if remaining == 0:
                return True
            if remaining == 1:
                del self.corrupt[rel]
            else:
                self.corrupt[rel] = remaining - 1
            return True

    def take_status(self, rel: str) -> int | None:
        with self._lock:
            entry = self.status_for.get(rel)
            if entry is None:
                return None
            code, remaining = entry
            if remaining > 0:
                entry[1] = remaining - 1
                if entry[1] == 0:
                    del self.status_for[rel]
            return code


def make_handler(
    root: Path, faults: Faults, *, quiet: bool = False
) -> type[BaseHTTPRequestHandler]:
    root = root.resolve()

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "superclaw-privacy-model-mock/1.0"

        def do_GET(self) -> None:
            self._serve(head=False)

        def do_HEAD(self) -> None:
            self._serve(head=True)

        def log_message(self, fmt: str, *args: object) -> None:
            if not quiet:
                sys.stderr.write(f"[serve-privacy-models] {self.address_string()} {fmt % args}\n")

        def _serve(self, *, head: bool) -> None:
            rel = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path).lstrip("/")
            target = (root / rel).resolve()
            if root not in target.parents or not target.is_file():
                self.send_error(404)
                return
            forced = faults.take_status(rel)
            if forced is not None:
                self.send_error(forced)
                return

            size = target.stat().st_size
            start, end, status = 0, size - 1, 200
            requested = self.headers.get("Range")
            if requested and not faults.ignore_range:
                match = _RANGE.match(requested.strip())
                if match is None:
                    self.send_error(400, "only 'bytes=N-' and 'bytes=N-M' ranges are supported")
                    return
                start = int(match.group(1))
                if match.group(2):
                    end = min(int(match.group(2)), size - 1)
                if start >= size or start > end:
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{size}")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                status = 206
            length = end - start + 1

            self.send_response(status)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(length))
            self.send_header("Accept-Ranges", "bytes")
            if status == 206:
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.end_headers()
            if head:
                return

            flip_at = size // 2
            if not (start <= flip_at <= end and faults.take_corrupt(rel)):
                flip_at = -1
            drop_at = faults.take_drop(length)
            sent = 0
            with open(target, "rb") as fh:
                fh.seek(start)
                while sent < length:
                    want = min(_CHUNK, length - sent)
                    if drop_at is not None:
                        want = min(want, drop_at - sent)
                    chunk = bytearray(fh.read(want))
                    if not chunk:
                        break
                    offset = start + sent
                    if offset <= flip_at < offset + len(chunk):
                        chunk[flip_at - offset] ^= 0xFF
                    try:
                        self.wfile.write(chunk)
                    except (BrokenPipeError, ConnectionResetError):
                        return
                    sent += len(chunk)
                    if drop_at is not None and sent >= drop_at:
                        self.log_message("dropping %s after %d bytes", rel, sent)
                        self.wfile.flush()
                        self.close_connection = True
                        self.connection.close()
                        return
                    if faults.throttle_kbps > 0:
                        time.sleep(len(chunk) / (faults.throttle_kbps * 1024))

    return Handler


def make_server(
    root: Path, faults: Faults | None = None, *, host: str = "127.0.0.1", port: int = 0,
    quiet: bool = False,
) -> ThreadingHTTPServer:
    """Build (not start) a server. ``port=0`` picks a free port."""
    server = ThreadingHTTPServer((host, port), make_handler(root, faults or Faults(), quiet=quiet))
    server.daemon_threads = True
    return server


def _parse_status(values: list[str]) -> dict[str, list[int]]:
    out: dict[str, list[int]] = {}
    for value in values:
        rel, _, spec = value.partition("=")
        code, _, count = spec.partition(":")
        if not rel or not code.isdigit() or (count and not count.isdigit()):
            raise SystemExit(f"--status-for expects REL=CODE or REL=CODE:N, got {value!r}")
        out[rel] = [int(code), int(count) if count else -1]
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--root", type=Path, required=True, help="directory of <model>.zip to serve")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=18990)
    parser.add_argument("--throttle-kbps", type=float, default=0.0)
    parser.add_argument("--drop-after-bytes", type=int, default=0)
    parser.add_argument("--corrupt", action="append", default=[], metavar="RELPATH")
    parser.add_argument("--corrupt-count", type=int, default=1)
    parser.add_argument("--ignore-range", action="store_true")
    parser.add_argument("--status-for", action="append", default=[], metavar="REL=CODE[:N]")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args(argv)

    faults = Faults(
        throttle_kbps=args.throttle_kbps,
        drop_after_bytes=args.drop_after_bytes,
        corrupt={rel: max(args.corrupt_count, 0) for rel in args.corrupt},
        ignore_range=args.ignore_range,
        status_for=_parse_status(args.status_for),
    )
    server = make_server(args.root, faults, host=args.host, port=args.port, quiet=args.quiet)
    host, port = server.server_address[:2]
    print(f"[serve-privacy-models] serving {args.root.resolve()} at http://{host}:{port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
