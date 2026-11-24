"""Consent-gated structured crash records for Windows-host Python services."""

from __future__ import annotations

import json
import os
import re
import sys
import threading
import traceback
from collections.abc import Callable
from types import TracebackType
from typing import Any
from urllib.parse import urlsplit

CrashEmitter = Callable[[dict[str, object]], None]

_MAX_ERROR_CHARS = 500
_MAX_STACK_CHARS = 4000
# The lookbehind keeps matching linear: without it the scheme prefix is retried from
# every character of a long run that has no "://". The run may start with digits or
# punctuation (-https://...) so such URLs are consumed and redacted, never skipped.
_URL_RE = re.compile(r"""(?<![A-Za-z0-9+.\-])[A-Za-z0-9+.\-]+://\S+""")
# Anything outside this set in the authority (quotes, commas, ...) means the match ran
# into surrounding text, so it is not trusted to be a host.
_AUTHORITY_RE = re.compile(r"[A-Za-z0-9._~%:\[\]\-]+")
_SAFE_CRASH_URLS = frozenset({
    "http://127.0.0.1:18321/v1/chat/completions",
    "http://127.0.0.1:18321/llm-router/v1/health",
    "http://127.0.0.1:18321/llm-router/v1/status",
    "http://127.0.0.1:18321/llm-router/v1/version",
})
_USER_PATH_PREFIX = r"(?:(?i:[a-z]:[\\/]+Users[\\/]+)|/(?:Users|home)/)"
# An apostrophe is a legal path/URL character (O'Connor), so a closing quote only
# counts when followed by a separator. The match is greedy: when the closing quote
# is ambiguous (Kids' Photos), it runs to the last qualifying quote on the line and
# over-redacts rather than leaks. Unquoted paths run to ": " or end of line.
_USER_PATH_RE = re.compile(
    rf"""(["']){_USER_PATH_PREFIX}[^\r\n]*\1(?=[\s,)\]:;]|$)"""
    rf"""|{_USER_PATH_PREFIX}(?:(?!:(?:\s|$))[^\r\n"])*"""
)
_INSTALLED_SERVICES: set[str] = set()
_PROVIDERS: list[object] = []
# Serializes the check/resolve/swap sequence in install_crash_hooks so concurrent
# callers cannot both pass the "already installed" check or wrap each other's hooks.
_INSTALL_LOCK = threading.Lock()


def _truthy(value: str | None) -> bool:
    return (value or "").strip().lower() in {"1", "true", "yes", "on"}


def _truncate(value: str, max_chars: int) -> str:
    if len(value) <= max_chars:
        return value
    return f"{value[: max_chars - 3]}..."


def _split_url_suffix(candidate: str) -> tuple[str, str]:
    """Split trailing quote/punctuation (and an unmatched ``]``) from a URL match."""
    end = len(candidate)
    while end and candidate[end - 1] in "'\".,;)]>":
        if candidate[end - 1] == "]" and candidate[:end].count("[") >= candidate[:end].count("]"):
            break  # closing bracket of an IPv6 host such as http://[::1]
        end -= 1
    return candidate[:end], candidate[end:]


def scrub_crash_text(value: object, max_chars: int) -> str:
    """Keep approved URL routes only, remove user paths, then bound the output."""
    raw = str(value or "").strip()
    if not raw:
        return "unknown"

    def _scrub_url(url: str) -> str:
        try:
            parts = urlsplit(url)
            authority = parts.netloc.rsplit("@", 1)[-1]
            if not parts.hostname or not _AUTHORITY_RE.fullmatch(authority):
                return "<redacted-url>"
            # Accessing port validates malformed or out-of-range port values.
            parts.port
        except ValueError:
            return "<redacted-url>"
        origin = f"{parts.scheme}://{authority}"
        route = f"{origin}{parts.path}"
        if route in _SAFE_CRASH_URLS:
            return route
        return f"{origin}/<redacted>" if parts.path else origin

    def _strip_url_secrets(match: re.Match[str]) -> str:
        # Only quote/punctuation is re-appended, so no secret can ride along with it.
        url, suffix = _split_url_suffix(match.group(0))
        return _scrub_url(url) + suffix

    scrubbed = _URL_RE.sub(_strip_url_secrets, raw)
    scrubbed = _USER_PATH_RE.sub("~", scrubbed)
    return _truncate(scrubbed, max_chars)


def _channel() -> str:
    value = (os.getenv("SUPERCLAW_BUILD_CHANNEL") or "dev").strip().lower()
    return value if value in {"stable", "beta", "dev"} else "dev"


def build_crash_record(
    *,
    service: str,
    release: str,
    exception_type: type[BaseException],
    exception: BaseException,
    traceback_value: TracebackType | None,
) -> dict[str, object]:
    """Build the production crash-log allowlist; never use this as metric labels."""
    stack = scrub_crash_text(
        "".join(traceback.format_exception(exception_type, exception, traceback_value)),
        _MAX_STACK_CHARS,
    )
    record: dict[str, object] = {
        "event_name": "crash_reported",
        "release": release.strip() or "unknown",
        "runtime": "python",
        "service": service.strip() or "unknown",
        "channel": _channel(),
        "outcome": "failed",
        "error_class": scrub_crash_text(exception_type.__name__, 120),
        "error": scrub_crash_text(exception, _MAX_ERROR_CHARS),
    }
    if stack != "unknown":
        record["stack"] = stack

    bundle_id = (os.getenv("SUPERCLAW_BUNDLE_ID") or "").strip()
    if bundle_id:
        record["bundle_id"] = bundle_id
    install_id = (os.getenv("SUPERCLAW_INSTALL_ID") or "").strip()
    if install_id:
        record["install_id"] = install_id
    instance_id = (os.getenv("SERVICEHUB_INSTANCE_ID") or "").strip()
    if instance_id:
        record["servicehub_instance_id"] = instance_id
    return record


def _full_telemetry_crash_export_enabled() -> bool:
    return _truthy(os.getenv("SUPERCLAW_FULL_TELEMETRY"))


def _build_otlp_session(endpoint: str) -> "requests.Session":
    """Build a requests.Session with correct proxy for the OTLP endpoint.

    Mirrors the LRM http_client logic: public AWS endpoints that carry an
    intel.com DNS name must not be matched by NO_PROXY=intel.com.
    """
    import ipaddress
    import urllib.parse
    import requests

    _PUBLIC_OTLP_HOSTS: frozenset[str] = frozenset({
        "telemetry-dev.aibuilder.intel.com",
        "telemetry.aibuilder.intel.com",
    })

    def _resolve_proxy(url: str) -> str | None:
        host = (urllib.parse.urlparse(url).hostname or "").lower()
        if host in _PUBLIC_OTLP_HOSTS:
            # Public AWS endpoint: never bypass, use configured proxy.
            pass
        else:
            # Loopback/private targets and NO_PROXY — direct connection (trust_env=False).
            if host in {"localhost", "host.docker.internal"}:
                return None
            try:
                ip = ipaddress.ip_address(host)
                if ip.is_loopback or ip.is_private:
                    return None
            except ValueError:
                pass
            no_proxy = os.environ.get("NO_PROXY") or os.environ.get("no_proxy") or ""
            for token in (t.strip().lower() for t in no_proxy.split(",") if t.strip()):
                if token.startswith("."):
                    if host == token[1:] or host.endswith(token):
                        return None
                elif host == token or host.endswith("." + token):
                    return None

        scheme = urllib.parse.urlparse(url).scheme.lower()
        if scheme == "https":
            return (os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
                    or os.environ.get("HTTP_PROXY") or os.environ.get("http_proxy"))
        return os.environ.get("HTTP_PROXY") or os.environ.get("http_proxy")

    session = requests.Session()
    session.trust_env = False
    proxy = _resolve_proxy(endpoint)
    if proxy:
        session.proxies.update({"http": proxy, "https": proxy})
    return session


def _build_otlp_emitter(*, service: str, release: str) -> CrashEmitter | None:
    if not _full_telemetry_crash_export_enabled():
        return None
    endpoint = (os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT") or "").strip()
    if not endpoint:
        return None

    exporter: tuple[Any, Any] | None = None
    init_lock = threading.Lock()

    def _get_exporter() -> tuple[Any, Any]:
        nonlocal exporter
        current = exporter
        if current is not None:
            return current
        with init_lock:
            if exporter is None:
                # Keep host-service startup on the stdlib-only path. Importing and
                # constructing the OTLP SDK here avoids paging its dependency graph
                # into every frozen child while a local 35B worker owns most system
                # commit. A fatal exception is the first point where the exporter is
                # actually needed.
                from opentelemetry.exporter.otlp.proto.http._log_exporter import (
                    OTLPLogExporter,
                )
                from opentelemetry.sdk._logs import LoggerProvider
                from opentelemetry.sdk._logs.export import SimpleLogRecordProcessor
                from opentelemetry.sdk.resources import Resource

                new_provider = LoggerProvider(
                    resource=Resource.create(
                        {
                            "service.name": service,
                            "service.version": release,
                            "service.instance.id": os.getenv(
                                "SERVICEHUB_INSTANCE_ID", "unknown"
                            ),
                        }
                    )
                )
                new_provider.add_log_record_processor(
                    SimpleLogRecordProcessor(
                        OTLPLogExporter(session=_build_otlp_session(endpoint))
                    )
                )
                _PROVIDERS.append(new_provider)
                # Published as one tuple so readers never see a half-built pair.
                exporter = (new_provider, new_provider.get_logger("superclaw.host.crash"))
            return exporter

    def _emit(record: dict[str, object]) -> None:
        from opentelemetry._logs import SeverityNumber

        provider, otel_logger = _get_exporter()
        otel_logger.emit(
            severity_number=SeverityNumber.FATAL,
            severity_text="FATAL",
            body=json.dumps(record, separators=(",", ":"), ensure_ascii=True),
            attributes={
                "superclaw.event_name": "crash_reported",
                "superclaw.release": release,
                "superclaw.runtime": "python",
                "superclaw.service": service,
                "superclaw.channel": _channel(),
            },
        )
        provider.force_flush()

    return _emit


def install_crash_hooks(
    *,
    service: str,
    release: str,
    emitter: CrashEmitter | None = None,
) -> bool:
    """Install process/thread hooks once while preserving Python's fatal behavior."""
    normalized_service = service.strip() or "unknown"
    with _INSTALL_LOCK:
        return _install_locked(normalized_service, release, emitter)


def _install_locked(
    normalized_service: str,
    release: str,
    emitter: CrashEmitter | None,
) -> bool:
    if normalized_service in _INSTALLED_SERVICES:
        return False

    resolved_emitter = emitter or _build_otlp_emitter(
        service=normalized_service,
        release=release,
    )
    if resolved_emitter is None:
        return False

    previous_sys_hook = sys.excepthook
    previous_thread_hook = threading.excepthook

    def _emit(
        exception_type: type[BaseException],
        exception: BaseException,
        traceback_value: TracebackType | None,
    ) -> None:
        try:
            resolved_emitter(
                build_crash_record(
                    service=normalized_service,
                    release=release,
                    exception_type=exception_type,
                    exception=exception,
                    traceback_value=traceback_value,
                )
            )
        except Exception:
            pass

    def _sys_hook(
        exception_type: type[BaseException],
        exception: BaseException,
        traceback_value: TracebackType | None,
    ) -> None:
        _emit(exception_type, exception, traceback_value)
        previous_sys_hook(exception_type, exception, traceback_value)

    def _thread_hook(args: threading.ExceptHookArgs) -> None:
        _emit(args.exc_type, args.exc_value, args.exc_traceback)
        previous_thread_hook(args)

    sys.excepthook = _sys_hook
    threading.excepthook = _thread_hook
    _INSTALLED_SERVICES.add(normalized_service)
    return True
