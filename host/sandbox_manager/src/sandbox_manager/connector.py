"""Loopback-only authenticated service for Connector-tier network operations."""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import importlib.util
import json
import math
import os
import re
import struct
import sys
import threading
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable

from contracts.connector_ipc_data import CONNECTOR_IPC_CONTRACT_VERSION, CONNECTOR_IPC_RULES

from . import connector_approval, connector_fetch
from .connector_audit import audit_record
from .egress_chat_grants import session_ref
from .dpapi_secret_file import read_sealed_json
from .egress_audit import AuditLog

_MAX_REQUEST_BYTES = 16 * 1024
_MAX_RESPONSE_BYTES = 128 * 1024
_MAX_QUERY_CHARS = 400
_MAX_RESULTS = 8
_MAX_DEADLINE_FUTURE_MS = 120_000
# Callers send exactly `now + _MAX_DEADLINE_FUTURE_MS` from their own clock, and on
# Windows Python 3.12's `time.time()` lags a precise clock by up to one 15.625 ms tick.
_CLOCK_SKEW_TOLERANCE_MS = 1_000
_MAX_REPLAY_ENTRIES = 4096
_MAX_PROVIDER_WORKERS = 8
_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_KEY_ID_RE = re.compile(r"^(?:caller|response)_[a-z0-9]{16}$")
_NONCE_RE = re.compile(r"^[A-Za-z0-9_-]{43}$")
_TAG_RE = re.compile(r"^[0-9a-f]{64}$")
_PROXY_ENV_NAMES = {
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
}
_REQUEST_FIELDS = {
    "contract_version",
    "operation",
    "direction",
    "caller_key_id",
    "boot_id",
    "session_id",
    "request_id",
    "nonce",
    "deadline_ms",
    "body",
    "auth_tag",
}
# Control operations reach no network, and Sandbox Manager polls `health` every half second while it
# waits for readiness, so only the operations that can egress are audited.
_AUDITED_OPERATIONS = frozenset({"search", "fetch_result"})
_SEARCH_QUERY_URL = re.compile(CONNECTOR_IPC_RULES["search_query_url_pattern"])


def _canonical_json(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def _mac_payload(message: dict[str, Any]) -> bytes:
    fields = (
        str(message["contract_version"]),
        message["operation"],
        message["direction"],
        message["caller_key_id"],
        message["boot_id"],
        message["session_id"],
        message["request_id"],
        message["nonce"],
        message.get("response_key_id", ""),
    )
    framed = b"".join(struct.pack(">I", len(encoded)) + encoded for encoded in (v.encode() for v in fields))
    body_digest = hashlib.sha256(_canonical_json(message["body"])).digest()
    return framed + struct.pack(">Q", message["deadline_ms"]) + body_digest


def _decode_key(value: str, label: str) -> bytes:
    try:
        key = base64.b64decode(value, validate=True)
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"{label} is not valid base64") from exc
    if len(key) != 32:
        raise ValueError(f"{label} must decode to 32 bytes")
    return key


def _load_search_module(path: Path, runtime_config: dict[str, Any]):
    spec = importlib.util.spec_from_file_location("sc_connector_search", path)
    if spec is None or spec.loader is None:
        raise ValueError("search module could not be loaded")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if not callable(getattr(module, "search_web_structured", None)):
        raise ValueError("search module lacks search_web_structured")
    configure = getattr(module, "configure_runtime_config", None)
    if not callable(configure):
        raise ValueError("search module lacks configure_runtime_config")
    configure(runtime_config)
    return module


def _diag(event: str, **fields: object) -> None:
    """Emit one structured diagnostic line for the Connector's tier log.

    stderr rather than stdout because that is the right default for a service; both
    streams land in the same tier log, so this is a convention, not a constraint.
    (The constraint is real for the search module, which also runs as a
    `python -c` child whose stdout *is* the tool result.)

    Never carries a secret. Proxy variables are reported by name because a proxy
    URL may embed credentials; exceptions are reported by type because a provider
    exception can quote a request URL that carries the API key.
    """
    parts = " ".join(f"{key}={value}" for key, value in fields.items())
    print(f"connector event={event} {parts}".rstrip(), file=sys.stderr, flush=True)


def _pin_tls_roots() -> str | None:
    """Point TLS verification at `certifi` when nothing else has been chosen.

    The tier account is logged on without a profile, so the Windows CurrentUser
    certificate store is unreadable and `primp` (the HTTP client behind the
    DuckDuckGo fallback) logs `failed to load native root certificate ...
    Access is denied`. `SSL_CERT_FILE` is honoured ahead of the platform store,
    which makes that path unreachable rather than merely survivable.
    """
    if os.environ.get("SSL_CERT_FILE"):
        return os.environ["SSL_CERT_FILE"]
    try:
        import certifi  # noqa: PLC0415
    except ImportError:
        return None
    bundle = certifi.where()
    os.environ["SSL_CERT_FILE"] = bundle
    return bundle


def _apply_proxy_environment(proxy: Any, *, authoritative: bool = False) -> list[str]:
    """Apply an allowlisted proxy map to this process's environment.

    The Connector has no other way to learn the host's egress configuration: the
    isolation broker launches it with a closed declared environment, so an
    unproxied network silently turns every provider call into a timeout. The
    allowlist is what keeps that channel from becoming general environment
    injection. Both callers wrap a refusal in a message that names the carrier.

    `authoritative` says this map is the whole egress configuration, so an
    allowlisted name it omits is cleared rather than left inherited. Only the
    sealed provider config may claim that. It matters on the un-isolated launcher,
    which starts this process with no explicit environment: there, a value the
    owner's resolver *refused* - one with no URL scheme, whose credentials a
    provider may quote back into model-visible text - is still sitting in the
    inherited environment, and refusing it upstream while leaving it live here
    would decide nothing. The bootstrap map is not authoritative: under isolation
    it is a fixed empty map, and clearing on it would undo the sealed one.
    """
    if not isinstance(proxy, dict) or not set(proxy).issubset(_PROXY_ENV_NAMES):
        raise ValueError("proxy fields are not allowlisted")
    # Validate the whole map before mutating anything: a refusal halfway through
    # would leave the environment holding some of a configuration this rejected.
    for value in proxy.values():
        if not isinstance(value, str) or len(value) > 4096:
            raise ValueError("proxy value is invalid")
    if authoritative:
        for name in _PROXY_ENV_NAMES - set(proxy):
            os.environ.pop(name, None)
    for name, value in proxy.items():
        os.environ[name] = value
    return sorted(proxy)


def _read_provider_config(path: Path) -> dict[str, Any]:
    value = read_sealed_json(path)
    # `approval` is written only when the Sandbox Manager has a broker to ask (EG1-7); without it the
    # Connector never holds a request for approval.
    if set(value) - {"approval"} != {"search", "proxy", "audit"} or not isinstance(value["search"], dict):
        raise ValueError("Connector provider configuration fields are invalid")
    connector_approval.approval_config_from(value.get("approval"))
    search = value["search"]
    if set(search) != {"tavilyApiKey"} or not isinstance(search["tavilyApiKey"], str):
        raise ValueError("Connector provider search configuration is invalid")
    audit = value["audit"]
    if (
        not isinstance(audit, dict)
        or set(audit) != {"path"}
        or not isinstance(audit["path"], str)
        or not Path(audit["path"]).is_absolute()
    ):
        raise ValueError("Connector provider audit configuration is invalid")
    return value


class ConnectorState:
    def __init__(
        self,
        bootstrap: dict[str, Any],
        runtime_config: dict[str, Any] | None = None,
        provider_config_path: Path | None = None,
        approval: connector_approval.ApprovalConfig | None = None,
        now_ms: Callable[[], int] | None = None,
    ) -> None:
        required = {
            "boot_id",
            "caller_key_id",
            "caller_key_b64",
            "response_key_id",
            "response_key_b64",
            "search_module",
            "proxy",
        }
        if set(bootstrap) != required:
            raise ValueError("bootstrap fields do not match the Connector contract")
        self.boot_id = bootstrap["boot_id"]
        self.caller_key_id = bootstrap["caller_key_id"]
        self.response_key_id = bootstrap["response_key_id"]
        if not _ID_RE.fullmatch(self.boot_id):
            raise ValueError("invalid bootstrap boot_id")
        if not _KEY_ID_RE.fullmatch(self.caller_key_id):
            raise ValueError("invalid bootstrap caller_key_id")
        if not _KEY_ID_RE.fullmatch(self.response_key_id):
            raise ValueError("invalid bootstrap response_key_id")
        self.caller_key = _decode_key(bootstrap["caller_key_b64"], "caller key")
        self.response_key = _decode_key(bootstrap["response_key_b64"], "response key")
        _apply_proxy_environment(bootstrap["proxy"])
        runtime_config = runtime_config or {"search": {"tavilyApiKey": ""}}
        self.search = _load_search_module(Path(bootstrap["search_module"]), runtime_config)
        # Where the Sandbox Manager seals the provider config; read again before each search (EG1-3, #12).
        self._provider_config_path = provider_config_path
        self._search_config: dict[str, Any] = runtime_config["search"]
        self._provider_config_unreadable = False
        # Requests held for approval (EG1-7). None: this Connector was started without an approval section,
        # and a URL outside the session list stays `destination_refused`.
        self.approvals = connector_approval.ApprovalDesk(approval, now_ms=now_ms) if approval else None
        # request id -> (approval id, reason, admitted_by), until the handler writes the audit line that names
        # them. Bounded: a request that never reaches an audit line must not make this grow.
        self.approval_ids: OrderedDict[str, tuple[str | None, str | None, str | None]] = OrderedDict()
        self.nonces: dict[str, int] = {}
        self.active: dict[str, dict[str, Any]] = {}
        self.session_results = connector_fetch.SessionResults()
        self.last_error: str | None = None
        self.lock = threading.Lock()
        self.executor = ThreadPoolExecutor(
            max_workers=_MAX_PROVIDER_WORKERS,
            thread_name_prefix="connector-provider",
        )

    def authenticate(self, request: dict[str, Any]) -> None:
        _validate_request(request)
        if request["boot_id"] != self.boot_id or request["caller_key_id"] != self.caller_key_id:
            raise PermissionError("request key or boot identity does not match")
        expected = hmac.new(self.caller_key, _mac_payload(request), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, request["auth_tag"]):
            raise PermissionError("request authentication failed")
        now_ms = int(time.time() * 1000)
        if request["deadline_ms"] <= now_ms:
            raise TimeoutError("request deadline has expired")
        if request["deadline_ms"] > now_ms + _MAX_DEADLINE_FUTURE_MS + _CLOCK_SKEW_TOLERANCE_MS:
            raise ValueError("request deadline is too far in the future")
        with self.lock:
            self.nonces = {nonce: deadline for nonce, deadline in self.nonces.items() if deadline > now_ms}
            if request["nonce"] in self.nonces:
                raise PermissionError("request nonce was already used")
            if len(self.nonces) >= _MAX_REPLAY_ENTRIES:
                raise PermissionError("request replay cache is full")
            self.nonces[request["nonce"]] = request["deadline_ms"]

    def response(self, request: dict[str, Any], body: dict[str, Any]) -> dict[str, Any]:
        response = {
            "contract_version": CONNECTOR_IPC_CONTRACT_VERSION,
            "operation": request["operation"],
            "direction": "response",
            "caller_key_id": self.caller_key_id,
            "response_key_id": self.response_key_id,
            "boot_id": self.boot_id,
            "session_id": request["session_id"],
            "request_id": request["request_id"],
            "nonce": request["nonce"],
            "deadline_ms": request["deadline_ms"],
            "body": body,
            "auth_tag": "0" * 64,
        }
        response["auth_tag"] = hmac.new(
            self.response_key, _mac_payload(response), hashlib.sha256
        ).hexdigest()
        return response

    def dispatch(self, request: dict[str, Any]) -> dict[str, Any]:
        operation = request["operation"]
        if operation == "health":
            return self.response(request, {"process_ready": True, "network_ready": True})
        if operation == "status":
            with self.lock:
                active_count = len(self.active)
                last_error = self.last_error
            state = "degraded" if last_error else "ready"
            return self.response(
                request,
                {"state": state, "active_requests": active_count, "last_error": last_error},
            )
        if operation == "cancel":
            with self.lock:
                task = self.active.get(request["body"]["target_request_id"])
                if task:
                    task["cancel"].set()
                    future = task.get("future")
                    if future is not None:
                        future.cancel()
            return self.response(request, {"cancelled": task is not None})
        if operation == "fetch_result":
            try:
                return self._fetch_result(request)
            except BaseException:
                # No audit line will name this approval: the handler audits a refusal as if it had no request.
                self.take_approval(request["request_id"])
                raise
        return self._search(request)

    def _provider_finished(self, request_id: str, future: Any) -> None:
        with self.lock:
            task = self.active.get(request_id)
            if task is not None and task.get("future") is future:
                self.active.pop(request_id, None)

    def _refresh_provider_config(self) -> None:
        """Take up a Tavily key the Sandbox Manager sealed after this Connector started.

        Settings saves the key through the host while the backend runs, so a new key must not need a
        restart. A config that cannot be read leaves the key in use; only the search section is taken from
        it, because the proxy and the audit path are the launch's.
        """
        path = self._provider_config_path
        if path is None:
            return
        try:
            search = _read_provider_config(path)["search"]
        except Exception as exc:  # noqa: BLE001 - whatever it was, the key in use stays
            if not self._provider_config_unreadable:
                _diag("provider_config_unreadable", exception_type=type(exc).__name__)
            self._provider_config_unreadable = True
            return
        self._provider_config_unreadable = False
        with self.lock:
            if search == self._search_config:
                return
            self._search_config = search
            self.search.configure_runtime_config({"search": search})
        _diag("provider_config_reloaded", tavily_key="present" if search["tavilyApiKey"] else "absent")

    def _start(
        self, request: dict[str, Any], work: Callable[[threading.Event], Any]
    ) -> tuple[threading.Event, Any] | None:
        """Start `work` on the provider pool as this request's task; None when the Connector is at its limit.

        `work` is handed the event a `cancel` for this request sets.
        """
        with self.lock:
            # A request granted approval already holds its place, and the event a cancel in the gap between the
            # grant and this start has set: it keeps both from the hold to the fetch.
            held = self.active.get(request["request_id"])
            if held is None and len(self.active) >= 64:
                return None
            cancel = held["cancel"] if held is not None else threading.Event()
            task: dict[str, Any] = {"cancel": cancel, "future": None}
            self.active[request["request_id"]] = task
        try:
            future = self.executor.submit(work, cancel)
        except BaseException:
            with self.lock:
                self.active.pop(request["request_id"], None)
            raise
        task["future"] = future
        future.add_done_callback(
            lambda completed: self._provider_finished(request["request_id"], completed)
        )
        return cancel, future

    @staticmethod
    def _wait(request: dict[str, Any], cancel: threading.Event, future: Any) -> tuple[str | None, Any]:
        """The work's result, or the code that ended the wait first; what the work raised is raised here."""
        while True:
            if cancel.is_set():
                future.cancel()
                return "connector_cancelled", None
            remaining = (request["deadline_ms"] - int(time.time() * 1000)) / 1000
            if remaining <= 0:
                # The caller is answered; whatever the work is still doing must stop, not hold its worker.
                cancel.set()
                future.cancel()
                return "connector_timeout", None
            try:
                return None, future.result(timeout=min(0.1, remaining))
            except FutureTimeoutError:
                continue

    def _fitted(self, request: dict[str, Any], body: dict[str, Any], field: str) -> dict[str, Any]:
        """The signed response, with `field` cut to the longest prefix that fits the response bound."""
        response = self.response(request, body)
        if len(_canonical_json(response)) <= _MAX_RESPONSE_BYTES:
            return response
        value = body[field]

        def fits(count: int) -> bool:
            candidate = self.response(request, {**body, field: value[:count], "truncated": True})
            return len(_canonical_json(candidate)) <= _MAX_RESPONSE_BYTES

        # A character or an item costs at least one byte, so no prefix longer than the bound can fit.
        low, high = 0, min(len(value), _MAX_RESPONSE_BYTES)
        while low < high:
            middle = (low + high + 1) // 2
            low, high = (middle, high) if fits(middle) else (low, middle - 1)
        return self.response(request, {**body, field: value[:low], "truncated": True})

    def _search(self, request: dict[str, Any]) -> dict[str, Any]:
        request_id = request["request_id"]
        query = request["body"]["query"]
        if _SEARCH_QUERY_URL.search(query):
            _diag("search_end", request_id=request_id, outcome="search_query_carries_url")
            return self.response(
                request,
                _failure(
                    request,
                    "search_query_carries_url",
                    False,
                    "A web search query cannot contain a URL; search with words instead",
                ),
            )
        self._refresh_provider_config()
        started_ms = int(time.time() * 1000)
        _diag(
            "search_begin",
            request_id=request_id,
            # Length, not text: the query is already in the Runtime's own logs.
            query_chars=len(query),
        )
        try:
            search_args = {"category": request["body"]["category"]} if "category" in request["body"] else {}
            started = self._start(request, lambda _cancel: self.search.search_web_structured(query, **search_args))
            if started is None:
                return self.response(
                    request,
                    _failure(request, "connector_unavailable", True, "Connector request limit reached"),
                )
            outcome, result = self._wait(request, *started)
            if outcome == "connector_cancelled":
                _diag("search_end", request_id=request_id, outcome=outcome)
                return self.response(request, _failure(request, outcome, False, "Web search was cancelled"))
            if outcome == "connector_timeout":
                _diag("search_end", request_id=request_id, outcome=outcome)
                return self.response(request, _failure(request, outcome, True, "Web search timed out"))
            if result["status"] in ("ok", "no_results"):
                rows = []
                for row in result["results"][: request["body"]["max_results"]]:
                    url = str(row.get("url", ""))[:4096]
                    if not url.startswith(("http://", "https://")):
                        continue
                    raw_score = row.get("score")
                    score_percent = (
                        round(float(raw_score) * 100)
                        if type(raw_score) in (int, float)
                        and math.isfinite(float(raw_score))
                        and 0 <= float(raw_score) <= 1
                        else None
                    )
                    rows.append({
                        "title": str(row.get("title", ""))[:512],
                        "url": url,
                        "content": str(row.get("content", ""))[:20_000],
                        "score_percent": score_percent,
                        "source_type": str(row["source_type"])[:512] if row.get("source_type") else None,
                    })
                body = {
                    "provider": result["provider"],
                    "results": rows,
                    "display": _display(request, result),
                    "error": None,
                }
            else:
                code = "connector_unavailable" if result["status"] == "unavailable" else "provider_unreachable"
                body = _failure(request, code, True, result.get("message", "Web search failed"), result)
                # A provider that could not be reached is a degraded Connector, not
                # a quiet success: `status` must be able to say so.
                with self.lock:
                    self.last_error = code
            _diag(
                "search_end",
                request_id=request_id,
                status=result["status"],
                provider=result.get("provider") or "none",
                results=len(body["results"]),
                elapsed_ms=int(time.time() * 1000) - started_ms,
            )
            response = self.response(request, body)
            if len(_canonical_json(response)) > _MAX_RESPONSE_BYTES:
                # The search succeeded and the client still gets an error, so the
                # log above would otherwise read as a success the caller never saw.
                _diag("search_end", request_id=request_id, outcome="response_too_large")
                response = self.response(
                    request,
                    _failure(request, "response_too_large", False, "Connector response exceeded its size limit"),
                )
            elif body["error"] is None:
                # What the caller was shown, and nothing else, is what `fetch_result` may fetch later.
                self.session_results.record(
                    request["session_id"],
                    [row["url"] for row in body["results"]],
                    now_ms=int(time.time() * 1000),
                )
            return response
        except Exception as exc:  # noqa: BLE001
            with self.lock:
                self.last_error = "provider_unreachable"
            # Type only, never the message: a provider exception can quote a
            # request URL that carries the API key.
            _diag("search_error", request_id=request_id, exception_type=type(exc).__name__)
            return self.response(
                request,
                _failure(request, "provider_unreachable", True, "Web search provider is unreachable"),
            )

    def _fetch_result(self, request: dict[str, Any]) -> dict[str, Any]:
        request_id = request["request_id"]
        url = request["body"]["url"]
        if self.session_results.admits(request["session_id"], url, now_ms=int(time.time() * 1000)):
            self._remember_admission(request_id, "search_result")
        else:
            if self.approvals is None:
                _diag("fetch_end", request_id=request_id, outcome="not_a_session_result")
                return self.response(request, _fetch_failure("destination_refused", False))
            answered = self._hold_for_approval(request)
            if answered is not None:
                return answered
        started_ms = int(time.time() * 1000)
        try:
            started = self._start(
                request,
                lambda cancel: connector_fetch.fetch_page(
                    url, deadline_ms=request["deadline_ms"], cancel=cancel
                ),
            )
            if started is None:
                return self.response(request, _fetch_failure("connector_unavailable", True))
            outcome, page = self._wait(request, *started)
        except connector_fetch.FetchFailure as failure:
            if failure.code == "proxy_configuration_error":
                # Every fetch would be refused the same way, so this is the Connector's state, not the page's.
                with self.lock:
                    self.last_error = failure.code
            _diag("fetch_end", request_id=request_id, outcome=failure.code)
            return self.response(request, _fetch_failure(failure.code, failure.retryable, failure.http_status))
        except Exception as exc:  # noqa: BLE001
            # Type only, never the message: an exception can quote the URL.
            _diag("fetch_error", request_id=request_id, exception_type=type(exc).__name__)
            return self.response(request, _fetch_failure("destination_unreachable", True))
        if outcome is not None:
            _diag("fetch_end", request_id=request_id, outcome=outcome)
            return self.response(request, _fetch_failure(outcome, outcome == "connector_timeout"))
        _diag(
            "fetch_end",
            request_id=request_id,
            outcome="ok",
            redirects=page.redirects,
            elapsed_ms=int(time.time() * 1000) - started_ms,
        )
        body = {
            "url": page.url,
            "content_type": page.content_type,
            "text": page.text,
            "truncated": page.truncated,
            "redirects": page.redirects,
            "error": None,
        }
        return self._fitted(request, body, "text")

    def _hold_for_approval(self, request: dict[str, Any]) -> dict[str, Any] | None:
        """Hold a fetch for a URL outside the session's list until it is decided.

        None when it was granted, or its chat was allowed every page, and the fetch goes on; otherwise the
        answer. Nothing about the URL is resolved or connected to while it waits.
        """
        request_id = request["request_id"]
        body = request["body"]
        url = body["url"]
        target = connector_fetch.normalized_url(url)
        # Nobody is asked about a URL that would be refused without a lookup (another port, an address).
        if target is None or connector_fetch.refused_before_asking(url):
            _diag("fetch_end", request_id=request_id, outcome="not_a_session_result")
            return self.response(request, _fetch_failure("destination_refused", False))
        interactive = body.get("approver") != "none"
        # The chat is the root session when the caller named it and someone can be asked; otherwise the
        # request's own session, which is offered `once` alone and no chat grant ever covers.
        root = body.get("root_session_id") if interactive else None
        chat = session_ref(root if root is not None else request["session_id"])
        cancel = threading.Event()
        with self.lock:
            if len(self.active) >= 64:
                return self.response(request, _fetch_failure("connector_unavailable", True))
            self.active[request_id] = {"cancel": cancel, "future": None}
        granted = False
        try:
            approval_id, status = self.approvals.request(
                target,
                connector_approval.request_digest(target),
                request["deadline_ms"],
                request["session_id"],
                chat,
                connector_approval.SCOPES if root is not None else ("once",),
                interactive=interactive,
            )
            if status == "covered":
                # Admitted like a grant: the request keeps its place in `active` for the fetch.
                granted = True
                self._remember_admission(request_id, "all_for_chat")
                _diag("fetch_admitted", request_id=request_id, admitted_by="all_for_chat")
                return None
            reason = _NOT_HELD.get(status)
            self._remember_approval_id(request_id, approval_id, reason)
            if status != "held":
                # Legible, not a mystery 90 seconds: the log and the audit line say why nothing was held.
                _diag(
                    "approval_not_held",
                    request_id=request_id,
                    approval_id=approval_id,
                    reason=reason,
                    **self._not_held_details(status),
                )
                code = {"denied_recently": "approval_denied", "too_late": "approval_expired"}.get(
                    status, "approval_required"
                )
                return self.response(request, _fetch_failure(code, False, approval_id=approval_id))
            outcome, scope, decided_id = self.approvals.wait_decided(approval_id, cancel)
            if decided_id != approval_id:
                # Held again under a new id by a forget: that is the id the decision and the audit name.
                approval_id = decided_id
                self._remember_approval_id(request_id, approval_id)
            granted = outcome == "granted"
        finally:
            if not granted:
                with self.lock:
                    self.active.pop(request_id, None)
        _diag("approval_end", request_id=request_id, approval_id=approval_id, outcome=outcome, scope=scope)
        if outcome == "granted":
            self._remember_admission(request_id, "all_for_chat" if scope == "all_for_chat" else "approval")
            return None
        if outcome == "cancelled":
            return self.response(request, _fetch_failure("connector_cancelled", False))
        code = "approval_denied" if outcome == "denied" else "approval_expired"
        return self.response(request, _fetch_failure(code, False, approval_id=approval_id))

    def _remember_approval_id(self, request_id: str, approval_id: str, reason: str | None = None) -> None:
        with self.lock:
            self.approval_ids[request_id] = (approval_id, reason, None)
            while len(self.approval_ids) > connector_approval.MAX_REMEMBERED_APPROVAL_IDS:
                self.approval_ids.popitem(last=False)

    def _remember_admission(self, request_id: str, admitted_by: str) -> None:
        """What let this fetch through, for its audit line: a search result, an approval or its chat's grant."""
        with self.lock:
            approval_id, reason, _ = self.approval_ids.pop(request_id, (None, None, None))
            self.approval_ids[request_id] = (approval_id, reason, admitted_by)
            while len(self.approval_ids) > connector_approval.MAX_REMEMBERED_APPROVAL_IDS:
                self.approval_ids.popitem(last=False)

    def take_approval(self, request_id: str) -> tuple[str | None, str | None, str | None]:
        """The approval id, the reason and what admitted it, for the audit line of this request, once."""
        with self.lock:
            return self.approval_ids.pop(request_id, (None, None, None))

    def _not_held_details(self, status: str) -> dict[str, int]:
        if status == "unattended":
            return {"attach_window_ms": self.approvals.attach_window_ms}
        if status == "full":
            return {
                "held_cap": connector_approval.MAX_HELD,
                "session_cap": connector_approval.MAX_HELD_PER_SESSION,
            }
        return {}


# Why a request was not held for the approver, as the log and the audit line say it.
_NOT_HELD = {
    "no_approver": "no_interactive_approver",
    "unattended": "no_approver_attached",
    "full": "desk_full",
    "denied_recently": "denied_recently",
    "too_late": "too_little_time",
}


def _fetch_failure(
    code: str, retryable: bool, http_status: int | None = None, *, approval_id: str | None = None
) -> dict[str, Any]:
    error: dict[str, Any] = {"code": code, "retryable": retryable}
    if approval_id is not None:
        error["approval_id"] = approval_id
    return {"error": error, "http_status": http_status}


def _display(
    request: dict[str, Any],
    result: dict[str, Any] | None = None,
    failure_message: str | None = None,
) -> dict[str, Any]:
    result = result or {}
    query = str(result.get("query", request["body"].get("query", "")))[:_MAX_QUERY_CHARS]
    original_query = str(result.get("original_query", query))[:_MAX_QUERY_CHARS]
    return {
        "query": query,
        "original_query": original_query,
        "as_of": str(result.get("as_of", time.strftime("%Y-%m-%d")))[:10],
        "query_normalized": bool(result.get("query_normalized", False)),
        "failure_message": (failure_message or result.get("message"))[:4096]
        if (failure_message or result.get("message"))
        else None,
    }


def _failure(
    request: dict[str, Any],
    code: str,
    retryable: bool,
    message: str,
    result: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "provider": None,
        "results": [],
        "display": _display(request, result, message),
        "error": {"code": code, "retryable": retryable},
    }


def _validate_request(request: Any) -> None:
    if not isinstance(request, dict) or set(request) != _REQUEST_FIELDS:
        raise ValueError("request envelope fields do not match the contract")
    if request["contract_version"] != CONNECTOR_IPC_CONTRACT_VERSION or request["direction"] != "request":
        raise ValueError("unsupported contract version or direction")
    for field in ("boot_id", "session_id", "request_id"):
        if not isinstance(request[field], str) or not _ID_RE.fullmatch(request[field]):
            raise ValueError(f"invalid {field}")
    if not isinstance(request["caller_key_id"], str) or not _KEY_ID_RE.fullmatch(request["caller_key_id"]):
        raise ValueError("invalid caller_key_id")
    if not isinstance(request["nonce"], str) or not _NONCE_RE.fullmatch(request["nonce"]):
        raise ValueError("invalid nonce")
    if not isinstance(request["auth_tag"], str) or not _TAG_RE.fullmatch(request["auth_tag"]):
        raise ValueError("invalid auth_tag")
    if type(request["deadline_ms"]) is not int or request["deadline_ms"] <= 0:
        raise ValueError("invalid deadline_ms")
    operation = request["operation"]
    body = request["body"]
    if operation in ("health", "status") and body == {}:
        return
    if (
        operation == "search"
        and isinstance(body, dict)
        and set(body) in ({"query", "max_results"}, {"query", "max_results", "category"})
        and body.get("category", "text") in ("text", "news")
    ):
        query = body["query"]
        maximum = body["max_results"]
        if isinstance(query, str) and query.strip() and len(query) <= _MAX_QUERY_CHARS and type(maximum) is int and 1 <= maximum <= _MAX_RESULTS:
            return
    if operation == "cancel" and isinstance(body, dict) and set(body) == {"target_request_id"}:
        target = body["target_request_id"]
        if isinstance(target, str) and _ID_RE.fullmatch(target):
            return
    if operation == "fetch_result" and isinstance(body, dict) and connector_fetch.request_is_valid(body):
        return
    raise ValueError("operation and body do not match the contract")


def _handler(state: ConnectorState, audit: AuditLog):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            if state.approvals is not None and connector_approval.is_admin_path(self.path):
                self._admin("GET")
                return
            self.send_error(404)

        def _admin(self, method: str) -> None:
            """The Sandbox Manager's routes (EG1-7). Control, not egress: no audit line of their own."""
            declared = self.headers.get("Content-Length")
            # `isdigit()` alone takes U+00B2, which `int()` refuses: an unauthenticated request must not raise.
            numeric = bool(declared) and declared.isascii() and declared.isdigit()
            length = int(declared) if numeric and not self.headers.get("Transfer-Encoding") else None
            body = self.rfile.read(min(length, connector_approval.MAX_BODY_READ)) if method == "POST" and length else b""
            status, answer = connector_approval.handle_admin(
                state.approvals,
                method=method,
                target=self.path,
                secret=self.headers.get(connector_approval.RULES["admin_secret_header"]),
                content_length=length if method == "POST" else None,
                body=body,
                log=_diag,
            )
            payload = _canonical_json(answer)
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def do_POST(self) -> None:  # noqa: N802
            received = time.time()
            started = time.monotonic()
            if state.approvals is not None and connector_approval.is_admin_path(self.path):
                self._admin("POST")
                return
            if self.path != "/v1/connector" or self.headers.get("Transfer-Encoding"):
                self._audit(received, started, 404, None)
                self.send_error(404)
                return
            try:
                length = int(self.headers.get("Content-Length", "-1"))
            except ValueError:
                length = -1
            if length < 0 or length > _MAX_REQUEST_BYTES:
                self._audit(received, started, 413, None)
                self.send_error(413)
                return
            try:
                request = json.loads(self.rfile.read(length))
                state.authenticate(request)
                response = state.dispatch(request)
                payload = _canonical_json(response)
            except TimeoutError as exc:
                self._reject(408, exc, received, started, length)
                return
            except PermissionError as exc:
                self._reject(401, exc, received, started, length)
                return
            except (ValueError, json.JSONDecodeError, UnicodeDecodeError) as exc:
                self._reject(400, exc, received, started, length)
                return
            if request["operation"] in _AUDITED_OPERATIONS:
                self._audit(received, started, 200, length, request, response, len(payload))
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def _reject(
            self, status: int, exc: Exception, received: float, started: float, length: int
        ) -> None:
            # Only the fixed messages raised by this module are logged verbatim; a
            # decoder's message can quote request bytes.
            own = type(exc) in (ValueError, PermissionError, TimeoutError)
            _diag("request_rejected", status=status, reason=str(exc) if own else type(exc).__name__)
            self._audit(received, started, status, length)
            self.send_error(status)

        def _audit(
            self,
            received: float,
            started: float,
            status: int,
            request_bytes: int | None,
            request: dict[str, Any] | None = None,
            response: dict[str, Any] | None = None,
            response_bytes: int | None = None,
        ) -> None:
            # The audit is tier self-report, not a gate: a full disk must not fail the request.
            try:
                audit.write(
                    audit_record(
                        **(
                            dict(
                                zip(
                                    ("approval_id", "reason", "admitted_by"),
                                    state.take_approval(request["request_id"]),
                                )
                            )
                            if request
                            else {}
                        ),
                        received=received,
                        started=started,
                        http_status=status,
                        request_bytes=request_bytes,
                        request=request,
                        response=response,
                        response_bytes=response_bytes,
                    )
                )
            except OSError as exc:
                _diag("audit_write_failed", exception_type=type(exc).__name__)

        def log_message(self, _format: str, *_args: Any) -> None:
            return

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", required=True)
    parser.add_argument("--port", required=True, type=int)
    parser.add_argument("--runtime-config-file", required=True)
    args = parser.parse_args()
    if args.host != "127.0.0.1" or not 1 <= args.port <= 65535:
        parser.error("Connector must bind to 127.0.0.1 and a non-zero TCP port")
    runtime_config_file = Path(args.runtime_config_file)
    if not runtime_config_file.is_file():
        parser.error("Connector runtime config file is unavailable")
    try:
        provider_config = _read_provider_config(runtime_config_file)
    except Exception as exc:  # noqa: BLE001
        raise SystemExit(f"invalid Connector provider configuration: {exc}") from None
    try:
        audit = AuditLog(Path(provider_config["audit"]["path"]))
    except OSError as exc:
        raise SystemExit(f"Connector audit log is unavailable: {exc}") from None
    # Before the search module is loaded, so its clients see a settled environment.
    # Not load-bearing -- they read it per call -- but it keeps the order obvious.
    try:
        proxy_names = _apply_proxy_environment(
            provider_config["proxy"], authoritative=True
        )
    except Exception as exc:  # noqa: BLE001
        raise SystemExit(f"invalid Connector provider configuration: {exc}") from None
    cert_file = _pin_tls_roots()
    # The search module's contract is `{"search": {...}}`; `proxy` is the
    # Connector's own concern and is applied above, not handed on.
    runtime_config = {"search": provider_config["search"]}
    bootstrap_line = sys.stdin.buffer.readline(_MAX_REQUEST_BYTES + 1)
    if not bootstrap_line or len(bootstrap_line) > _MAX_REQUEST_BYTES:
        raise SystemExit("missing or oversized Connector bootstrap")
    try:
        state = ConnectorState(
            json.loads(bootstrap_line),
            runtime_config,
            provider_config_path=runtime_config_file,
            approval=connector_approval.approval_config_from(provider_config.get("approval")),
        )
    except Exception as exc:  # noqa: BLE001
        raise SystemExit(f"invalid Connector bootstrap: {exc}") from None
    _diag(
        "ready",
        port=args.port,
        # Names only: a proxy URL may carry `user:password@`.
        proxy_vars=",".join(proxy_names) or "none",
        tavily_key="present" if runtime_config["search"]["tavilyApiKey"] else "absent",
        ssl_cert_file="set" if cert_file else "unset",
    )
    server = ThreadingHTTPServer((args.host, args.port), _handler(state, audit))
    server.daemon_threads = True
    try:
        server.serve_forever()
    finally:
        audit.close()


if __name__ == "__main__":
    main()