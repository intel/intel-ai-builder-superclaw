"""Fetch the privacy models into the per-user models directory.

privacy_manager downloads the PPLX PII model
after install, one zip per model, from ``<base>/<model_name>.zip``. The zip
holds the model's files under a top-level ``<model_name>/`` folder.
``model_manifest.json`` pins the zip's size and sha256 and every file's
relative path, size and sha256 (regenerate it with
``scripts/gen_model_manifest.py``).

Integrity rules, the same as asr_manager's Parakeet download:

* The zip is checked against its pinned sha256, computed over the whole
  file, including bytes kept from an earlier attempt.
* The pinned size is a hard ceiling while streaming, so a source that never
  stops sending cannot fill the disk before the hash check fails.
* An interrupted transfer resumes the ``.download`` part-file with an HTTP
  Range request. A server that ignores the Range, or answers with a
  different range, restarts that file from byte 0. A 416 discards the
  part-file.
* Only the files the manifest lists are extracted, each to the path the
  manifest gives (never one taken from the zip), and each is checked against
  its pinned size and sha256.
* A model is assembled in ``<model>.partial/`` and renamed into place only
  after every file verified, so a directory under the final name is always
  complete.

Transport: TLS verification is always on. ``SUPERCLAW_PRIVACY_MODEL_BASE_URL``
overrides the base URL. It must be https, except that plain http is allowed
for a loopback host so a local mock (``scripts/serve_privacy_models.py``) can
stand in for the real host. Redirects are held to the same rule.

Proxy routing comes from the ``*_PROXY`` variables: aibuilder.intel.com is
public and goes through the corporate proxy even though ``NO_PROXY`` lists
``.intel.com``, a ``NO_PROXY`` host is tried directly first, and when one route
does not connect the other is tried. A loopback host is always reached
directly.
"""

from __future__ import annotations

import base64
import hashlib
import http.client
import ipaddress
import json
import logging
import os
import shutil
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
import zlib
from collections.abc import Callable
from dataclasses import dataclass
from email.message import Message
from pathlib import Path, PurePosixPath
from typing import IO

logger = logging.getLogger(__name__)

DEFAULT_BASE_URL = "https://aibuilder.intel.com/models"
BASE_URL_ENV = "SUPERCLAW_PRIVACY_MODEL_BASE_URL"

# Written last into a model directory; its revision ties the directory to the
# manifest it was verified against.
MARKER_NAME = ".superclaw-model.json"

MANIFEST_PATH = Path(__file__).with_name("model_manifest.json")

# Read timeout per chunk, not per file: the PII weights are 570 MiB.
_READ_TIMEOUT_S = 60
_CHUNK_BYTES = 262_144
# Each attempt resumes from the bytes already on disk, so six attempts are six
# chances to finish one file, not six full transfers.
_MAX_ATTEMPTS = 6
_RETRY_DELAYS_S = (0, 1, 2, 5, 10, 30)
# The file is not there, or not for us; retrying cannot change that.
_PERMANENT_HTTP_STATUSES = frozenset({401, 403, 404, 410})
_USER_AGENT = "superclaw-privacy/1.0"
# Public hosts with an intel.com name: reached through the proxy even when
# NO_PROXY lists .intel.com.
_PUBLIC_INTEL_HOST_SUFFIXES = ("aibuilder.intel.com",)

_sleep = time.sleep

# Proxy route (None = direct) that last worked, per scheme://host:port.
_working_routes: dict[str, str | None] = {}


class DownloadError(RuntimeError):
    """A model could not be fetched or verified."""


class _LocalUnpackError(DownloadError):
    """Unpacking a verified zip failed on the local disk, not because the zip is bad."""


@dataclass(frozen=True)
class ModelFile:
    path: str
    size: int
    sha256: str


@dataclass(frozen=True)
class ModelSpec:
    name: str
    revision: str
    files: tuple[ModelFile, ...]
    archive: ModelFile

    @property
    def total_bytes(self) -> int:
        """Bytes to transfer: the zip."""
        return self.archive.size


# --------------------------------------------------------------------------
# Manifest
# --------------------------------------------------------------------------


def load_manifest(path: Path = MANIFEST_PATH) -> dict[str, ModelSpec]:
    """Parse the pinned manifest. Raises ValueError on a malformed entry."""
    raw = json.loads(path.read_text(encoding="utf-8"))
    return parse_manifest(raw)


def parse_manifest(raw: dict) -> dict[str, ModelSpec]:
    specs: dict[str, ModelSpec] = {}
    for name, entry in (raw.get("models") or {}).items():
        if not _is_plain_name(name):
            raise ValueError(f"model name {name!r} is not a plain directory name")
        files = []
        for item in entry["files"]:
            rel = str(item["path"])
            parts = PurePosixPath(rel).parts
            if not parts or rel.startswith("/") or any(p in ("", ".", "..") for p in parts):
                raise ValueError(f"{name}: file path {rel!r} is not a relative path")
            if ":" in rel or "\\" in rel or rel == MARKER_NAME:
                raise ValueError(f"{name}: file path {rel!r} is not allowed")
            files.append(
                ModelFile(path=rel, size=int(item["size"]), sha256=_valid_sha256(name, rel, item["sha256"]))
            )
        archive = ModelFile(
            path=archive_name(name),
            size=int(entry["archive"]["size"]),
            sha256=_valid_sha256(name, "archive", entry["archive"]["sha256"]),
        )
        specs[name] = ModelSpec(
            name=name, revision=str(entry["revision"]), files=tuple(files), archive=archive
        )
    return specs


def _valid_sha256(model: str, what: str, value: object) -> str:
    sha = str(value).lower()
    if len(sha) != 64 or any(c not in "0123456789abcdef" for c in sha):
        raise ValueError(f"{model}: {what} has no valid sha256")
    return sha


def archive_name(model: str) -> str:
    return f"{model}.zip"


def _is_plain_name(name: str) -> bool:
    return bool(name) and name not in (".", "..") and not any(c in name for c in "/\\:")


# --------------------------------------------------------------------------
# Source policy
# --------------------------------------------------------------------------


def resolve_base_url() -> str:
    """Base URL to download from, validated. Raises DownloadError."""
    url = (os.environ.get(BASE_URL_ENV) or "").strip() or DEFAULT_BASE_URL
    check_url_allowed(url)
    return url.rstrip("/")


def check_url_allowed(url: str) -> None:
    """Allow https anywhere, plain http only to a loopback host."""
    parsed = urllib.parse.urlsplit(url)
    scheme = parsed.scheme.lower()
    if scheme == "https" and parsed.hostname:
        return
    if scheme == "http" and _is_loopback(parsed.hostname):
        return
    raise DownloadError(
        f"refusing model source {url!r}: use https, or http to 127.0.0.1 / "
        f"localhost / ::1 (set {BASE_URL_ENV})"
    )


def _is_loopback(host: str | None) -> bool:
    if not host:
        return False
    if host.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def archive_url(base_url: str, model: str) -> str:
    return f"{base_url}/{urllib.parse.quote(archive_name(model))}"


# --------------------------------------------------------------------------
# Proxy routes
# --------------------------------------------------------------------------


def proxy_routes(url: str) -> list[str | None]:
    """Proxy URLs to try for ``url``, preferred first; ``None`` is direct."""
    parsed = urllib.parse.urlsplit(url)
    if _is_loopback(parsed.hostname):
        return [None]
    if parsed.scheme.lower() == "https":
        names = ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy")
    else:
        names = ("HTTP_PROXY", "http_proxy")
    proxy = next((os.environ[n] for n in names if os.environ.get(n)), None)
    if not proxy:
        return [None]
    host = (parsed.hostname or "").lower()
    public = any(host == s or host.endswith(f".{s}") for s in _PUBLIC_INTEL_HOST_SUFFIXES)
    if not public and urllib.request.proxy_bypass_environment(host):
        return [None, proxy]
    return [proxy, None]


def _route_key(url: str) -> str:
    parsed = urllib.parse.urlsplit(url)
    return f"{parsed.scheme}://{parsed.netloc}".lower()


def _ordered_routes(url: str) -> list[str | None]:
    routes = proxy_routes(url)
    key = _route_key(url)
    if key in _working_routes and _working_routes[key] in routes:
        routes.remove(_working_routes[key])
        routes.insert(0, _working_routes[key])
    return routes


def _proxy_label(proxy: str) -> str:
    """``host:port`` of a proxy URL: what a log line may say about it, never user:password."""
    parts = urllib.parse.urlsplit(proxy if "://" in proxy else f"http://{proxy}")
    return parts.netloc.rsplit("@", 1)[-1]


def _route_via_proxy(req: urllib.request.Request, proxy: str) -> None:
    """Send ``req`` through ``proxy`` (an https target is tunnelled).

    Set on the request rather than through ``ProxyHandler``, whose
    ``proxy_open`` drops the proxy for any host ``NO_PROXY`` matches.
    """
    parts = urllib.parse.urlsplit(proxy if "://" in proxy else f"http://{proxy}")
    # urllib fills in Host from req.host before it opens the request, after
    # set_proxy has replaced that with the proxy's. A CDN rejects the proxy's name.
    req.add_unredirected_header("Host", req.host)
    if parts.username:
        creds = f"{urllib.parse.unquote(parts.username)}:{urllib.parse.unquote(parts.password or '')}"
        # Unredirected: a redirect to a loopback host leaves the proxy, and must not carry this.
        req.add_unredirected_header(
            "Proxy-Authorization", "Basic " + base64.b64encode(creds.encode()).decode()
        )
    req.set_proxy(_proxy_label(proxy), parts.scheme or "http")


class _SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    def __init__(self, proxy: str | None) -> None:
        super().__init__()
        self._proxy = proxy

    def redirect_request(
        self,
        req: urllib.request.Request,
        fp: IO[bytes],
        code: int,
        msg: str,
        headers: Message,
        newurl: str,
    ) -> urllib.request.Request | None:
        check_url_allowed(newurl)
        new = super().redirect_request(req, fp, code, msg, headers, newurl)
        if new is not None and self._proxy and not _is_loopback(urllib.parse.urlsplit(newurl).hostname):
            _route_via_proxy(new, self._proxy)
        return new


def _open(
    req: urllib.request.Request, ctx: ssl.SSLContext | None, proxy: str | None
) -> http.client.HTTPResponse:
    """Open ``req`` directly or through ``proxy``, with TLS verification and
    safe redirects. The environment's proxy settings are not consulted here:
    :func:`proxy_routes` already decided."""
    if proxy:
        _route_via_proxy(req, proxy)
    handlers: list[urllib.request.BaseHandler] = [
        _SafeRedirectHandler(proxy),
        urllib.request.ProxyHandler({}),
    ]
    if ctx is not None:
        handlers.append(urllib.request.HTTPSHandler(context=ctx))
    return urllib.request.build_opener(*handlers).open(req, timeout=_READ_TIMEOUT_S)


# --------------------------------------------------------------------------
# Verification
# --------------------------------------------------------------------------


def _sha256_of(path: Path, hasher: hashlib._Hash | None = None) -> hashlib._Hash:
    hasher = hasher if hasher is not None else hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(_CHUNK_BYTES), b""):
            hasher.update(chunk)
    return hasher


def already_verified(target: Path, sha_expected: str, size_expected: int) -> bool:
    """True when ``target`` exists with the pinned size AND sha256."""
    try:
        if not target.is_file() or target.stat().st_size != size_expected:
            return False
        return _sha256_of(target).hexdigest() == sha_expected
    except OSError:
        return False


def size_mismatches(spec: ModelSpec, directory: Path) -> list[tuple[str, int, int]] | None:
    """``(path, pinned, actual)`` for each file of the wrong size, or ``None``
    when a pinned file is missing from ``directory``."""
    out: list[tuple[str, int, int]] = []
    try:
        for f in spec.files:
            path = directory / f.path
            if not path.is_file():
                return None
            actual = path.stat().st_size
            if actual != f.size:
                out.append((f.path, f.size, actual))
    except OSError:
        return None
    return out


def dir_matches(spec: ModelSpec, directory: Path) -> bool:
    """Every pinned file exists in ``directory`` with its pinned size.

    A size check, not a hash: cheap enough for every start-up, and it tells a
    real model from a git-LFS pointer checkout.
    """
    return size_mismatches(spec, directory) == []


def dir_hashes_match(spec: ModelSpec, directory: Path) -> bool:
    """Every pinned file in ``directory`` has its pinned sha256 (and size)."""
    try:
        return all(
            already_verified(directory.joinpath(*PurePosixPath(f.path).parts), f.sha256, f.size)
            for f in spec.files
        )
    except OSError:
        return False


def is_installed(spec: ModelSpec, directory: Path) -> bool:
    """``directory`` was assembled by :func:`download_model` for this revision."""
    try:
        marker = json.loads((directory / MARKER_NAME).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    return marker.get("revision") == spec.revision and dir_matches(spec, directory)


# --------------------------------------------------------------------------
# Transfer
# --------------------------------------------------------------------------


def _content_range_start(resp: http.client.HTTPResponse) -> int | None:
    headers = getattr(resp, "headers", None)
    value = headers.get("Content-Range") if headers is not None else None
    if not value:
        return None
    try:
        return int(str(value).split(" ", 1)[1].split("-", 1)[0])
    except (IndexError, ValueError):
        return None


class _LocalFileError(Exception):
    """Reading or writing the part-file failed (disk full, permission)."""


def _resume_point(tmp: Path, size_expected: int) -> tuple[int, hashlib._Hash]:
    """Bytes already in the part-file, and a hasher fed with them."""
    try:
        have = tmp.stat().st_size if tmp.is_file() else 0
        if have > size_expected:
            tmp.unlink(missing_ok=True)
            have = 0
        hasher = hashlib.sha256()
        if have:
            hasher = _sha256_of(tmp, hasher)
            logger.info("Resuming %s at %.1f MiB", tmp.name, have / 1_048_576)
    except OSError as exc:
        raise _LocalFileError(exc) from exc
    return have, hasher


def _open_part_file(tmp: Path, *, append: bool) -> IO[bytes]:
    try:
        return open(tmp, "ab" if append else "wb")
    except OSError as exc:
        raise _LocalFileError(exc) from exc


def _write(fh: IO[bytes], chunk: bytes) -> None:
    try:
        fh.write(chunk)
    except OSError as exc:
        raise _LocalFileError(exc) from exc


def _download_one(
    target: Path,
    url: str,
    sha_expected: str,
    size_expected: int,
    on_bytes: Callable[[int], None],
    ctx: ssl.SSLContext | None,
) -> int:
    """Stream one file to ``target`` and verify it. Returns its size.

    Resumable: a ``.download`` part-file survives a network failure and the
    next attempt asks for ``Range: bytes=<have>-``. A hash mismatch or a size
    overrun proves the bytes on disk wrong, so those discard the part-file.
    A connection or timeout failure moves to the next proxy route; the route
    that completes a file is tried first for the next one. A local disk error
    is retried on the same route. ``on_bytes`` receives this file's byte count
    so far. Raises DownloadError when every attempt failed.
    """
    tmp = target.with_name(target.name + ".download")
    routes = _ordered_routes(url)
    route_index = 0
    last_error = "no attempt made"
    for attempt in range(_MAX_ATTEMPTS):
        delay = _RETRY_DELAYS_S[min(attempt, len(_RETRY_DELAYS_S) - 1)]
        if attempt and delay:
            _sleep(delay)
        route = routes[route_index % len(routes)]
        try:
            have, hasher = _resume_point(tmp, size_expected)
            headers = {"User-Agent": _USER_AGENT}
            if have:
                headers["Range"] = f"bytes={have}-"
            on_bytes(have)
            if have == size_expected and hasher.hexdigest() == sha_expected:
                # A whole, verified part-file whose rename never ran: ask the host for nothing
                # (a Range at the end of the file is a 416, which would discard these bytes).
                try:
                    os.replace(tmp, target)
                except OSError as exc:
                    raise _LocalFileError(exc) from exc
                return have
            done = have
            with _open(urllib.request.Request(url, headers=headers), ctx, route) as resp:
                resuming = have > 0 and resp.status == 206
                if resuming and _content_range_start(resp) not in (None, have):
                    tmp.unlink(missing_ok=True)
                    on_bytes(0)
                    last_error = f"{url} answered the Range request with another range"
                    continue
                if have and not resuming:
                    logger.info(
                        "%s ignored the Range request (HTTP %s); restarting %s",
                        url, resp.status, target.name,
                    )
                    hasher = hashlib.sha256()
                    done = 0
                    on_bytes(0)
                oversize = False
                with _open_part_file(tmp, append=resuming) as fh:
                    while True:
                        chunk = resp.read(_CHUNK_BYTES)
                        if not chunk:
                            break
                        if done + len(chunk) > size_expected:
                            oversize = True
                            break
                        _write(fh, chunk)
                        hasher.update(chunk)
                        done += len(chunk)
                        on_bytes(done)
            if oversize:
                last_error = f"{url} sent more than the pinned {size_expected} bytes"
                logger.warning("%s; discarding %s", last_error, tmp.name)
                tmp.unlink(missing_ok=True)
                on_bytes(0)
                # Not a lost connection: this host serves another object than the one pinned
                # (a stale CDN copy, say). Trying again at once would pull the same bytes, so
                # fail this attempt and leave the next one to the delivery back-off.
                raise DownloadError(last_error)
            if done != size_expected or hasher.hexdigest() != sha_expected:
                if done < size_expected:
                    last_error = f"{url} ended after {done} of {size_expected} bytes"
                    logger.warning("%s; will resume", last_error)
                    continue
                last_error = f"checksum mismatch for {target.name} from {url}"
                logger.warning("%s; discarding the file and fetching it again", last_error)
                tmp.unlink(missing_ok=True)
                on_bytes(0)
                continue
            try:
                os.replace(tmp, target)
            except OSError as exc:
                raise _LocalFileError(exc) from exc
            _working_routes[_route_key(url)] = route
            return done
        except DownloadError:
            raise
        except _LocalFileError as exc:
            # The source is fine; switching proxy route would not help.
            last_error = f"cannot write {tmp}: {exc.__cause__}"
            logger.warning("Model download: %s", last_error)
        except urllib.error.HTTPError as exc:
            exc.close()
            last_error = f"HTTP {exc.code} from {url}"
            logger.warning("Model download failed: %s", last_error)
            if exc.code in _PERMANENT_HTTP_STATUSES:
                raise DownloadError(last_error) from exc
            if exc.code == 416:
                tmp.unlink(missing_ok=True)
                on_bytes(0)
        except (urllib.error.URLError, OSError, http.client.HTTPException) as exc:
            last_error = f"{type(exc).__name__}: {exc}"
            logger.warning(
                "Model download from %s %s failed: %s", url,
                f"via proxy {_proxy_label(route)}" if route else "directly", last_error,
            )
            route_index += 1
    raise DownloadError(last_error)


def download_model(
    spec: ModelSpec,
    base_url: str,
    models_dir: Path,
    *,
    on_progress: Callable[[int], None] = lambda _done: None,
    on_phase: Callable[[str], None] = lambda _phase: None,
    ctx: ssl.SSLContext | None = None,
) -> Path:
    """Download, verify and install one model. Returns its directory.

    A zip already in ``models_dir`` with the pinned hash is not fetched again,
    so a retry after a failed unpack costs no transfer. ``on_progress``
    receives the zip's transferred byte count; ``on_phase`` receives
    ``"verifying"`` while existing bytes are hashed or the zip is unpacked and
    ``"downloading"`` while bytes move.
    """
    for stale in models_dir.glob(f"{spec.name}.stale-*"):
        shutil.rmtree(stale, ignore_errors=True)
    final = models_dir / spec.name
    partial = models_dir / f"{spec.name}.partial"
    archive = models_dir / spec.archive.path
    on_phase("verifying")
    if already_verified(archive, spec.archive.sha256, spec.archive.size):
        on_progress(spec.archive.size)
    else:
        archive.unlink(missing_ok=True)
        on_phase("downloading")
        _download_one(
            archive,
            archive_url(base_url, spec.name),
            spec.archive.sha256,
            spec.archive.size,
            on_progress,
            ctx,
        )
    on_phase("verifying")
    shutil.rmtree(partial, ignore_errors=True)
    partial.mkdir(parents=True)
    try:
        _extract(spec, archive, partial)
    except _LocalUnpackError:
        # A full disk or a denied write says nothing about the zip, which is verified:
        # keep it, so the next attempt unpacks it again instead of transferring it.
        shutil.rmtree(partial, ignore_errors=True)
        raise
    except DownloadError:
        archive.unlink(missing_ok=True)
        shutil.rmtree(partial, ignore_errors=True)
        raise
    (partial / MARKER_NAME).write_text(
        json.dumps({"model": spec.name, "revision": spec.revision}), encoding="utf-8"
    )
    _install(partial, final)
    try:
        archive.unlink(missing_ok=True)
    except OSError as exc:
        # The model is installed. A scanner holding the zip must not turn that into a failed
        # download, which would skip the activation that follows.
        logger.warning("Privacy model zip %s was not removed after install: %s", archive, exc)
    logger.info("Privacy model %s (revision %s) installed at %s", spec.name, spec.revision, final)
    return final


def _extract(spec: ModelSpec, archive: Path, partial: Path) -> None:
    """Write each manifest file from ``archive`` into ``partial``, verified.

    Destinations come from the manifest, not from the zip, so a crafted entry
    name cannot write outside ``partial``. Entries the manifest does not list
    are ignored.
    """
    try:
        with zipfile.ZipFile(archive) as zf:
            members = {info.filename: info for info in zf.infolist()}
            for f in spec.files:
                member = f"{spec.name}/{f.path}"
                info = members.get(member)
                if info is None:
                    raise DownloadError(f"{archive.name} has no {member}")
                target = partial.joinpath(*PurePosixPath(f.path).parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                hasher = hashlib.sha256()
                written = 0
                with zf.open(info) as src, open(target, "wb") as dst:
                    for chunk in iter(lambda: src.read(_CHUNK_BYTES), b""):
                        written += len(chunk)
                        if written > f.size:
                            break
                        dst.write(chunk)
                        hasher.update(chunk)
                if written != f.size or hasher.hexdigest() != f.sha256:
                    raise DownloadError(
                        f"{member} in {archive.name} does not match its pinned size and sha256"
                    )
    except DownloadError:
        raise
    except OSError as exc:
        raise _LocalUnpackError(f"cannot unpack {archive.name}: {type(exc).__name__}: {exc}") from exc
    except (zipfile.BadZipFile, zlib.error, RuntimeError) as exc:
        raise DownloadError(f"cannot unpack {archive.name}: {type(exc).__name__}: {exc}") from exc


def _install(partial: Path, final: Path) -> None:
    """Rename ``partial`` to ``final``, replacing a stale ``final``."""
    if not final.exists():
        os.replace(partial, final)
        return
    stale = final.with_name(f"{final.name}.stale-{os.getpid()}-{time.monotonic_ns()}")
    os.replace(final, stale)
    os.replace(partial, final)
    shutil.rmtree(stale, ignore_errors=True)
