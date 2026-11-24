"""Web search clients for native Connector and container direct-provider paths."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import re
import secrets
import struct
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol, runtime_checkable
from urllib.parse import urlsplit

import anyio
import httpx

from .connector_reader import (
    MAX_CONFIG_BYTES,
    ConnectorConfigUnavailable,
    read_sealed_connector_config,
)

logger = logging.getLogger("uvicorn.error")


@dataclass(frozen=True)
class SearchHit:
    title: str
    url: str
    snippet: str


@runtime_checkable
class SearchClient(Protocol):
    """Stable interface across production / test."""

    async def search(self, query: str, *, max_results: int = 5) -> list[SearchHit]: ...

    async def aclose(self) -> None: ...


# The Connector IPC version, which the envelopes and the client configuration both carry. This package
# cannot import `contracts`, so a test holds this to the generated schemas instead.
CONNECTOR_IPC_CONTRACT_VERSION = 2

_CONNECTOR_CONFIG_FIELDS = {
    "contract_version",
    "endpoint",
    "boot_id",
    "caller_key_id",
    "caller_key_b64",
    "response_key_id",
    "response_key_b64",
}
_CONNECTOR_RESPONSE_FIELDS = {
    "contract_version",
    "operation",
    "direction",
    "caller_key_id",
    "response_key_id",
    "boot_id",
    "session_id",
    "request_id",
    "nonce",
    "deadline_ms",
    "body",
    "auth_tag",
}
_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_CALLER_KEY_ID_RE = re.compile(r"^caller_[a-z0-9]{16}$")
_RESPONSE_KEY_ID_RE = re.compile(r"^response_[a-z0-9]{16}$")
_TAG_RE = re.compile(r"^[0-9a-f]{64}$")
_MAX_CONNECTOR_CONFIG_BYTES = MAX_CONFIG_BYTES
_MAX_CONNECTOR_RESPONSE_BYTES = 128 * 1024
_MAX_CONNECTOR_RESULTS = 8
_MAX_CONNECTOR_QUERY_CHARS = 400
_CONNECTOR_ERROR_CODES = {
    "connector_unavailable",
    "connector_timeout",
    "connector_cancelled",
    "provider_unreachable",
    "proxy_configuration_error",
    "response_too_large",
    "invalid_request",
    "authentication_failed",
    "replay_detected",
}
_DEGRADABLE_CONNECTOR_ERROR_CODES = {
    "connector_unavailable",
    "connector_timeout",
    "provider_unreachable",
    "proxy_configuration_error",
}


class ConnectorSearchError(RuntimeError):
    def __init__(self, code: str, *, retryable: bool, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable


@dataclass(frozen=True)
class _ConnectorConfig:
    endpoint: str
    boot_id: str
    caller_key_id: str
    caller_key: bytes
    response_key_id: str
    response_key: bytes


def _canonical_json(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def _connector_mac_payload(message: dict[str, Any]) -> bytes:
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
    encoded_fields = (value.encode() for value in fields)
    framed = b"".join(struct.pack(">I", len(value)) + value for value in encoded_fields)
    body_digest = hashlib.sha256(_canonical_json(message["body"])).digest()
    return framed + struct.pack(">Q", message["deadline_ms"]) + body_digest


def _decode_connector_key(value: Any, label: str) -> bytes:
    if not isinstance(value, str):
        raise ValueError(f"Connector {label} is invalid")
    try:
        decoded = base64.b64decode(value, validate=True)
    except Exception as exc:
        raise ValueError(f"Connector {label} is invalid") from exc
    if len(decoded) != 32:
        raise ValueError(f"Connector {label} is invalid")
    return decoded


# The Sandbox Manager seals this file once per boot and starts and stops HDR with the Connector,
# so one unseal serves /readyz and every run; a rewritten file is unsealed again (#3978).
_SEALED_CONFIG_LOCK = threading.Lock()
_SEALED_CONFIG: tuple[tuple[object, ...], _ConnectorConfig] | None = None


def _load_connector_config(
    path: Path,
    *,
    reader_python: Path | None = None,
    reader_root: Path | None = None,
) -> _ConnectorConfig:
    if (reader_python is None) != (reader_root is None):
        raise ValueError("Connector reader configuration is invalid")
    if reader_python is not None and reader_root is not None:
        if not reader_python.is_absolute() or not reader_root.is_absolute() or not path.is_absolute():
            raise ValueError("Connector reader configuration is invalid")
        return _load_sealed_config(path, reader_python, reader_root)
    try:
        raw = path.read_bytes()
    except OSError as exc:
        raise ConnectorConfigUnavailable("Connector client configuration is unavailable") from exc
    return _parse_connector_config(raw)


def _load_sealed_config(path: Path, reader_python: Path, reader_root: Path) -> _ConnectorConfig:
    global _SEALED_CONFIG
    with _SEALED_CONFIG_LOCK:
        try:
            stat = path.stat()
        except OSError:
            raise ConnectorConfigUnavailable("Connector client configuration is unavailable") from None
        key = (path, reader_python, reader_root, stat.st_ino, stat.st_size, stat.st_mtime_ns)
        if _SEALED_CONFIG is not None and _SEALED_CONFIG[0] == key:
            return _SEALED_CONFIG[1]
        config = _parse_connector_config(read_sealed_connector_config(reader_python, reader_root, path))
        _SEALED_CONFIG = (key, config)
        return config


def _parse_connector_config(raw: bytes) -> _ConnectorConfig:
    if not raw or len(raw) > _MAX_CONNECTOR_CONFIG_BYTES:
        raise ValueError("Connector client configuration is invalid")
    try:
        value = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("Connector client configuration is invalid") from exc
    if not isinstance(value, dict) or set(value) != _CONNECTOR_CONFIG_FIELDS:
        raise ValueError("Connector client configuration is invalid")

    try:
        endpoint = urlsplit(value["endpoint"])
        port = endpoint.port
    except (TypeError, ValueError) as exc:
        raise ValueError("Connector client configuration is invalid") from exc
    if (
        endpoint.scheme != "http"
        or endpoint.hostname != "127.0.0.1"
        or port is None
        or endpoint.path != "/v1/connector"
        or endpoint.username is not None
        or endpoint.password is not None
        or endpoint.query
        or endpoint.fragment
    ):
        raise ValueError("Connector client configuration is invalid")
    if (
        type(value["contract_version"]) is not int
        or value["contract_version"] != CONNECTOR_IPC_CONTRACT_VERSION
    ):
        raise ValueError("Connector client configuration is invalid")
    if not isinstance(value["boot_id"], str) or not _ID_RE.fullmatch(value["boot_id"]):
        raise ValueError("Connector client configuration is invalid")
    if not isinstance(value["caller_key_id"], str) or not _CALLER_KEY_ID_RE.fullmatch(
        value["caller_key_id"]
    ):
        raise ValueError("Connector client configuration is invalid")
    if not isinstance(value["response_key_id"], str) or not _RESPONSE_KEY_ID_RE.fullmatch(
        value["response_key_id"]
    ):
        raise ValueError("Connector client configuration is invalid")
    return _ConnectorConfig(
        endpoint=value["endpoint"],
        boot_id=value["boot_id"],
        caller_key_id=value["caller_key_id"],
        caller_key=_decode_connector_key(value["caller_key_b64"], "caller key"),
        response_key_id=value["response_key_id"],
        response_key=_decode_connector_key(value["response_key_b64"], "response key"),
    )


class ConnectorSearchClient:
    """Authenticated native client for the fixed Connector search operation."""

    def __init__(
        self,
        *,
        config_path: Path,
        session_id: str,
        timeout_s: float = 30.0,
        transport: httpx.AsyncBaseTransport | None = None,
        reader_python: Path | None = None,
        reader_root: Path | None = None,
    ) -> None:
        if not _ID_RE.fullmatch(session_id):
            raise ValueError("Connector session identity is invalid")
        if not 0 < timeout_s <= 120:
            raise ValueError("Connector timeout must be between 0 and 120 seconds")
        self._config = _load_connector_config(
            config_path,
            reader_python=reader_python,
            reader_root=reader_root,
        )
        self._session_id = session_id
        self._timeout_s = timeout_s
        self._transport = transport

    async def search(self, query: str, *, max_results: int = 5) -> list[SearchHit]:
        query = query.strip()
        if not query:
            return []
        if len(query) > _MAX_CONNECTOR_QUERY_CHARS:
            query = query[: _MAX_CONNECTOR_QUERY_CHARS - 3] + "..."
        maximum = max(1, min(max_results, _MAX_CONNECTOR_RESULTS))
        if maximum != max_results:
            logger.warning(
                "hybrid_dr.connector_search.max_results_clamped requested=%s effective=%s",
                max_results,
                maximum,
            )
        request = self._request("search", {"query": query, "max_results": maximum})
        message = await self._exchange(request)
        body = self._verify_response(request, message, "search")
        return _parse_connector_body(body)

    async def health(self) -> bool:
        request = self._request("health", {})
        message = await self._exchange(request)
        body = self._verify_response(request, message, "health")
        if (
            not isinstance(body, dict)
            or set(body) != {"process_ready", "network_ready"}
            or type(body["process_ready"]) is not bool
            or type(body["network_ready"]) is not bool
        ):
            raise ConnectorSearchError(
                "invalid_request", retryable=False, message="Connector health body is invalid"
            )
        return body["process_ready"] and body["network_ready"]

    async def _exchange(self, request: dict[str, Any]) -> Any:
        payload = _canonical_json(request)
        if len(payload) > 16 * 1024:
            raise ConnectorSearchError(
                "invalid_request", retryable=False, message="Connector request is too large"
            )

        try:
            timeout = httpx.Timeout(self._timeout_s)
            # egress-surface: hdr_connector_search
            async with (
                httpx.AsyncClient(
                    timeout=timeout,
                    trust_env=False,
                    transport=self._transport,
                ) as client,
                client.stream(
                    "POST",
                    self._config.endpoint,
                    content=payload,
                    headers={"Content-Type": "application/json"},
                ) as response,
            ):
                if response.status_code < 200 or response.status_code >= 300:
                    raise _http_status_error(response.status_code)
                chunks: list[bytes] = []
                size = 0
                async for chunk in response.aiter_bytes():
                    size += len(chunk)
                    if size > _MAX_CONNECTOR_RESPONSE_BYTES:
                        raise ConnectorSearchError(
                            "response_too_large",
                            retryable=False,
                            message="Connector response exceeded 128 KiB",
                        )
                    chunks.append(chunk)
        except ConnectorSearchError:
            raise
        except httpx.TimeoutException as exc:
            raise ConnectorSearchError(
                "connector_timeout", retryable=True, message="Connector request timed out"
            ) from exc
        except httpx.HTTPError as exc:
            raise ConnectorSearchError(
                "connector_unavailable", retryable=True, message="Connector is unavailable"
            ) from exc

        try:
            message = json.loads(b"".join(chunks))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ConnectorSearchError(
                "invalid_request", retryable=False, message="Connector response is not valid JSON"
            ) from exc
        return message

    async def aclose(self) -> None:
        return None

    def _request(self, operation: str, body: dict[str, Any]) -> dict[str, Any]:
        request = {
            "contract_version": CONNECTOR_IPC_CONTRACT_VERSION,
            "operation": operation,
            "direction": "request",
            "caller_key_id": self._config.caller_key_id,
            "boot_id": self._config.boot_id,
            "session_id": self._session_id,
            "request_id": f"{operation}-{uuid.uuid4()}",
            "nonce": base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode(),
            "deadline_ms": int(time.time() * 1000) + round(self._timeout_s * 1000),
            "body": body,
            "auth_tag": "0" * 64,
        }
        request["auth_tag"] = hmac.new(
            self._config.caller_key,
            _connector_mac_payload(request),
            hashlib.sha256,
        ).hexdigest()
        return request

    def _verify_response(
        self,
        request: dict[str, Any],
        message: Any,
        operation: str,
    ) -> Any:
        if not isinstance(message, dict) or set(message) != _CONNECTOR_RESPONSE_FIELDS:
            raise ConnectorSearchError(
                "invalid_request", retryable=False, message="Connector response envelope is invalid"
            )
        expected_fields = {
            "contract_version": CONNECTOR_IPC_CONTRACT_VERSION,
            "operation": operation,
            "direction": "response",
            "caller_key_id": self._config.caller_key_id,
            "response_key_id": self._config.response_key_id,
            "boot_id": self._config.boot_id,
            "session_id": request["session_id"],
            "request_id": request["request_id"],
            "nonce": request["nonce"],
            "deadline_ms": request["deadline_ms"],
        }
        if any(message.get(field) != value for field, value in expected_fields.items()):
            raise ConnectorSearchError(
                "authentication_failed",
                retryable=False,
                message="Connector response does not match its request",
            )
        tag = message.get("auth_tag")
        if not isinstance(tag, str) or not _TAG_RE.fullmatch(tag):
            raise ConnectorSearchError(
                "authentication_failed",
                retryable=False,
                message="Connector response authentication is invalid",
            )
        expected_tag = hmac.new(
            self._config.response_key,
            _connector_mac_payload(message),
            hashlib.sha256,
        ).hexdigest()
        if not hmac.compare_digest(tag, expected_tag):
            raise ConnectorSearchError(
                "authentication_failed",
                retryable=False,
                message="Connector response authentication failed",
            )
        return message["body"]


class DegradingConnectorSearchClient:
    """Keep transient Connector search failures local to one HDR query."""

    def __init__(self, *, connector: SearchClient) -> None:
        self._connector = connector

    async def search(self, query: str, *, max_results: int = 5) -> list[SearchHit]:
        try:
            return await self._connector.search(query, max_results=max_results)
        except ConnectorSearchError as exc:
            if not exc.retryable or exc.code not in _DEGRADABLE_CONNECTOR_ERROR_CODES:
                raise
            query_fp = hashlib.sha256(query.encode("utf-8", errors="replace")).hexdigest()[:12]
            logger.warning(
                "hybrid_dr.connector_search.degraded code=%s query_fp=%s",
                exc.code,
                query_fp,
            )
            return []

    async def aclose(self) -> None:
        await self._connector.aclose()


def _parse_connector_body(body: Any) -> list[SearchHit]:
    if not isinstance(body, dict) or set(body) != {"provider", "results", "display", "error"}:
        raise ConnectorSearchError(
            "invalid_request", retryable=False, message="Connector response body is invalid"
        )
    _validate_connector_display(body["display"])
    error = body["error"]
    if error is not None:
        if (
            not isinstance(error, dict)
            or set(error) != {"code", "retryable"}
            or error["code"] not in _CONNECTOR_ERROR_CODES
            or type(error["retryable"]) is not bool
            or body["provider"] is not None
            or body["results"] != []
        ):
            raise ConnectorSearchError(
                "invalid_request", retryable=False, message="Connector error body is invalid"
            )
        failure_message = body["display"]["failure_message"]
        raise ConnectorSearchError(
            error["code"],
            retryable=error["retryable"],
            message=failure_message or "Connector search failed",
        )
    if body["provider"] not in ("tavily", "ddgs") or not isinstance(body["results"], list):
        raise ConnectorSearchError(
            "invalid_request", retryable=False, message="Connector success body is invalid"
        )
    if len(body["results"]) > _MAX_CONNECTOR_RESULTS:
        raise ConnectorSearchError(
            "response_too_large", retryable=False, message="Connector returned too many results"
        )
    hits: list[SearchHit] = []
    for row in body["results"]:
        if not isinstance(row, dict) or set(row) != {
            "title",
            "url",
            "content",
            "score_percent",
            "source_type",
        }:
            raise ConnectorSearchError(
                "invalid_request", retryable=False, message="Connector search result is invalid"
            )
        title, url, content = row["title"], row["url"], row["content"]
        score_percent = row["score_percent"]
        source_type = row["source_type"]
        parsed_url = urlsplit(url) if isinstance(url, str) else None
        if (
            not isinstance(title, str)
            or len(title) > 512
            or not isinstance(url, str)
            or len(url) > 4096
            or parsed_url is None
            or parsed_url.scheme not in ("http", "https")
            or not parsed_url.hostname
            or not isinstance(content, str)
            or len(content) > 20_000
            or not (
                score_percent is None or (type(score_percent) is int and 0 <= score_percent <= 100)
            )
            or not (
                source_type is None or (isinstance(source_type, str) and len(source_type) <= 512)
            )
        ):
            raise ConnectorSearchError(
                "invalid_request", retryable=False, message="Connector search result is invalid"
            )
        hits.append(SearchHit(title=title, url=url, snippet=content))
    return hits


def _validate_connector_display(display: Any) -> None:
    if not isinstance(display, dict) or set(display) != {
        "query",
        "original_query",
        "as_of",
        "query_normalized",
        "failure_message",
    }:
        raise ConnectorSearchError(
            "invalid_request", retryable=False, message="Connector display body is invalid"
        )
    failure_message = display["failure_message"]
    if (
        not isinstance(display["query"], str)
        or len(display["query"]) > 400
        or not isinstance(display["original_query"], str)
        or len(display["original_query"]) > 400
        or not isinstance(display["as_of"], str)
        or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", display["as_of"])
        or type(display["query_normalized"]) is not bool
        or not (
            failure_message is None
            or (isinstance(failure_message, str) and len(failure_message) <= 4096)
        )
    ):
        raise ConnectorSearchError(
            "invalid_request", retryable=False, message="Connector display body is invalid"
        )


def _http_status_error(status_code: int) -> ConnectorSearchError:
    if status_code == 401:
        return ConnectorSearchError(
            "authentication_failed",
            retryable=False,
            message="Connector request authentication failed",
        )
    if status_code == 408:
        return ConnectorSearchError(
            "connector_timeout", retryable=True, message="Connector request timed out"
        )
    if status_code in (400, 413):
        return ConnectorSearchError(
            "invalid_request",
            retryable=False,
            message=f"Connector rejected the request with HTTP {status_code}",
        )
    return ConnectorSearchError(
        "connector_unavailable",
        retryable=status_code >= 500,
        message=f"Connector request failed with HTTP {status_code}",
    )


class TavilySearchClient:
    """Async httpx client for Tavily /search. Production passes the API key
    explicitly from the sidecar request."""

    def __init__(
        self,
        *,
        api_key: str | None = None,
        endpoint: str = "https://api.tavily.com/search",
        timeout_s: float = 30.0,
    ) -> None:
        self._endpoint = endpoint
        self._api_key = (api_key or "").strip()
        # egress-surface: hdr_tavily_search_direct
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(timeout_s))

    async def search(self, query: str, *, max_results: int = 5) -> list[SearchHit]:
        if not self._api_key:
            raise RuntimeError("tavily_api_key missing from sidecar request; cannot search")
        # egress-surface: hdr_tavily_search_direct
        resp = await self._client.post(
            self._endpoint,
            json={
                "api_key": self._api_key,
                "query": query,
                "max_results": max_results,
                "include_answer": False,
                "include_raw_content": False,
            },
        )
        resp.raise_for_status()
        data = resp.json()
        out: list[SearchHit] = []
        for r in data.get("results") or []:
            out.append(
                SearchHit(
                    title=str(r.get("title") or ""),
                    url=str(r.get("url") or ""),
                    snippet=str(r.get("content") or r.get("snippet") or ""),
                )
            )
        return out

    async def aclose(self) -> None:
        await self._client.aclose()


class DuckDuckGoSearchClient:
    """DuckDuckGo/DDGS fallback search client.

    Import ddgs lazily so tests and Tavily-only environments can import this
    module even if the optional package is unavailable.
    """

    _TIME_KEYWORDS = ("latest", "recent", "new", "announced", "current", "today", "update")

    def __init__(self, *, timeout_s: float = 15.0, per_host_cap: int = 2) -> None:
        self._timeout_s = timeout_s
        self._per_host_cap = per_host_cap

    async def search(self, query: str, *, max_results: int = 5) -> list[SearchHit]:
        query = query.strip()
        if not query:
            return []
        if len(query) > 400:
            query = query[:397] + "..."

        return await anyio.to_thread.run_sync(self._search_sync, query, max_results)

    def _search_sync(self, query: str, max_results: int) -> list[SearchHit]:
        try:
            from ddgs import DDGS
        except Exception:
            return []

        use_news = self._is_time_sensitive(query)
        rows = self._run_ddgs(DDGS, query, "news" if use_news else "text", max_results)
        if not rows:
            rows = self._run_ddgs(DDGS, query, "text" if use_news else "news", max_results)
        if not rows:
            rows = self._run_ddgs(DDGS, query, "text", max_results, backend="brave")
        return self._dedupe(rows, max_results)

    def _run_ddgs(
        self,
        ddgs_cls: type[Any],
        query: str,
        kind: str,
        max_results: int,
        *,
        backend: str | None = None,
    ) -> list[SearchHit]:
        timelimit = "y" if self._is_time_sensitive(query) else None
        try:
            # egress-surface: hdr_ddgs_search_direct
            ddgs = ddgs_cls(timeout=self._timeout_s)
            if kind == "news":
                raw = ddgs.news(
                    query=query,
                    region="wt-wt",
                    safesearch="moderate",
                    max_results=max_results,
                    timelimit=timelimit,
                )
                return [
                    SearchHit(
                        title=str(row.get("title") or ""),
                        url=str(row.get("url") or ""),
                        snippet=str(row.get("body") or ""),
                    )
                    for row in raw
                ]

            kwargs: dict[str, object] = {
                "query": query,
                "region": "wt-wt",
                "safesearch": "moderate",
                "max_results": max_results,
            }
            if backend:
                kwargs["backend"] = backend
            if timelimit:
                kwargs["timelimit"] = timelimit
            raw = ddgs.text(**kwargs)
            return [
                SearchHit(
                    title=str(row.get("title") or ""),
                    url=str(row.get("href") or ""),
                    snippet=str(row.get("body") or ""),
                )
                for row in raw
            ]
        except Exception:
            return []

    def _dedupe(self, hits: list[SearchHit], max_results: int) -> list[SearchHit]:
        seen_urls: set[str] = set()
        host_counts: dict[str, int] = {}
        out: list[SearchHit] = []
        for hit in hits:
            url = hit.url.strip()
            if not url or url in seen_urls:
                continue
            host = self._host_of(url)
            if host and host_counts.get(host, 0) >= self._per_host_cap:
                continue
            seen_urls.add(url)
            host_counts[host] = host_counts.get(host, 0) + 1
            out.append(hit)
            if len(out) >= max_results:
                break
        return out

    def _is_time_sensitive(self, query: str) -> bool:
        q = query.lower()
        if re.search(r"\b20\d{2}\b", q):
            return True
        return any(keyword in q for keyword in self._TIME_KEYWORDS)

    def _host_of(self, url: str) -> str:
        try:
            return urlsplit(url).netloc.lower()
        except Exception:
            return ""

    async def aclose(self) -> None:
        return None


class FallbackSearchClient:
    """Use primary search first, then fallback on missing config, errors, or empty results."""

    def __init__(self, *, primary: SearchClient, fallback: SearchClient) -> None:
        self._primary = primary
        self._fallback = fallback

    async def search(self, query: str, *, max_results: int = 5) -> list[SearchHit]:
        try:
            hits = await self._primary.search(query, max_results=max_results)
            if hits:
                return hits
        except Exception:
            pass
        try:
            return await self._fallback.search(query, max_results=max_results)
        except Exception:
            return []

    async def aclose(self) -> None:
        await self._primary.aclose()
        await self._fallback.aclose()


class MockSearchClient:
    """In-memory canned-response search client for tests."""

    def __init__(self, *, queries: dict[str, list[SearchHit]] | None = None) -> None:
        self._queries: dict[str, list[SearchHit]] = dict(queries or {})
        self.calls: list[str] = []

    def queue(self, query: str, hits: list[SearchHit]) -> None:
        self._queries[query] = hits

    async def search(self, query: str, *, max_results: int = 5) -> list[SearchHit]:
        self.calls.append(query)
        return self._queries.get(query, [])[:max_results]

    async def aclose(self) -> None:
        return None


__all__ = [
    "ConnectorSearchClient",
    "ConnectorSearchError",
    "DegradingConnectorSearchClient",
    "DuckDuckGoSearchClient",
    "FallbackSearchClient",
    "MockSearchClient",
    "SearchClient",
    "SearchHit",
    "TavilySearchClient",
]
