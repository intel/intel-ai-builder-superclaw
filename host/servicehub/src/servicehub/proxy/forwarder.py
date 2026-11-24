"""HTTP forwarding for ServiceHub control-plane proxy routes."""

from __future__ import annotations

import hashlib
import hmac
from collections.abc import Callable, Mapping

import httpx
from contracts.sandbox_manager_host_api_data import SANDBOX_MANAGER_HOST_API_RULES
from fastapi import Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from starlette.background import BackgroundTask

from servicehub.common.errors import error_body
from servicehub.proxy.client_config import default_httpx_limits
from servicehub.proxy.error_normalizer import normalize_upstream_error, upstream_exception
from servicehub.supervisor.registry import ServiceInfo


_MAX_BODY_BYTES = 10 * 1024 * 1024
_FORWARDED_CREDENTIAL_HEADER: str = SANDBOX_MANAGER_HOST_API_RULES["forwarded_credential_header"]
FORWARDED_CREDENTIAL_HEADER = _FORWARDED_CREDENTIAL_HEADER
_FORWARDED_CREDENTIAL_LABEL = SANDBOX_MANAGER_HOST_API_RULES["forwarded_credential_label"].encode()
_HOP_BY_HOP_HEADERS = frozenset(
    {
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
    }
)
_REQUEST_HEADER_DENYLIST = _HOP_BY_HOP_HEADERS | {
    "authorization",
    "host",
    "x-superclaw-process-credential",
    _FORWARDED_CREDENTIAL_HEADER.lower(),
}
_REQUEST_HEADER_DENYLIST = _REQUEST_HEADER_DENYLIST | {"content-length"}
_RESPONSE_HEADER_DENYLIST = _HOP_BY_HOP_HEADERS | {"content-length"}
_DEFAULT_PROXY_TIMEOUT = httpx.Timeout(connect=2.0, read=30.0, write=10.0, pool=5.0)
# Updating llama-server's launch-time context size restarts the model. LRM allows
# up to 60s for health plus 300s for model loading, so this control-plane call
# cannot use the generic 30s proxy read timeout.
_LOCAL_CTX_UPDATE_TIMEOUT = httpx.Timeout(
    connect=2.0, read=420.0, write=10.0, pool=5.0
)

PROCESS_CREDENTIAL_HEADER = "X-SuperClaw-Process-Credential"

# Mirrors llmrouter_manager.common.management_auth.MANAGEMENT_PREFIXES
_MANAGEMENT_PREFIXES: dict[str, tuple[str, ...]] = {
    "llmrouter_manager": (
        "/llm-router/v1/cloud/",
        "/llm-router/v1/capability/",
        "/llm-router/v1/edge/",
        "/llm-router/v1/telemetry/",
        "/llm-router/v1/oauth/",
    ),
    # Each child also serves /docs and /openapi.json outside /v1/; its middleware gates them too.
    "asr_manager": ("/speech-to-text/v1/", "/speech-to-text/docs", "/speech-to-text/openapi.json"),
    "tts_manager": ("/tts-narration/v1/", "/tts-narration/docs", "/tts-narration/openapi.json"),
    "privacy_manager": ("/data-protection/v1/models/",),
}
# Under a management prefix but never given the credential: /shutdown stays Hub-internal (not
# reachable through the proxy), and the children leave /health and /version open.
_NO_CREDENTIAL_PATHS = frozenset(
    f"{prefix}/v1/{leaf}"
    for prefix in ("/speech-to-text", "/tts-narration")
    for leaf in ("health", "version", "shutdown")
)

_DATA_PROTECTION_PREFIX = "/llm-router/v1/data-protection/"
_DATA_PROTECTION_OPEN_GET = frozenset({
    "/llm-router/v1/data-protection/mode",
    "/llm-router/v1/data-protection/hybrid-threshold",
})

# A write under these needs the process credential, a read does not (#3665). The llmrouter_manager
# entry mirrors llmrouter_manager.common.management_auth.MUTATION_GATED_PREFIXES; privacy_manager's
# local-read grant is how the App records the user's Deny, and the runtime must not be able to.
_MUTATION_GATED_PREFIXES: dict[str, tuple[str, ...]] = {
    "privacy_manager": ("/data-protection/v1/file/local-read/grant",),
    "llmrouter_manager": (
        "/llm-router/v1/local",
        "/llm-router/v1/perf-weight",
        "/llm-router/v1/models",
        "/llm-router/v1/model-selections",
        "/llm-router/v1/inference-servers",
        "/llm-router/v1/usage",
        "/llm-router/v1/operations",
    ),
}
_READ_METHODS = frozenset({"GET", "HEAD"})


class ProxyForwarder:
    def __init__(
        self,
        client: httpx.AsyncClient | None = None,
        *,
        process_credential: Callable[[ServiceInfo], str | None] | None = None,
    ) -> None:
        self._owns_client = client is None
        self._client = client or httpx.AsyncClient(
            trust_env=False,
            timeout=_DEFAULT_PROXY_TIMEOUT,
            limits=default_httpx_limits(),
        )
        self._process_credential = process_credential

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def forward(self, request: Request, service: ServiceInfo) -> Response:
        body = await request.body()
        if len(body) > _MAX_BODY_BYTES:
            return JSONResponse(
                status_code=413,
                content=error_body(
                    "request_too_large", "Control-plane request body exceeds 10 MiB"
                ),
            )

        headers = _filter_headers(request.headers, _REQUEST_HEADER_DENYLIST)
        credential = self._process_credential(service) if self._process_credential else None
        if credential:
            headers[_FORWARDED_CREDENTIAL_HEADER] = forwarded_credential(credential)
        headers.update(_management_credential(request, service))
        upstream_request = self._client.build_request(
            method=request.method,
            url=_target_url(request, service),
            headers=headers,
            content=body,
            timeout=_proxy_timeout(request),
        )
        try:
            upstream = await self._client.send(upstream_request, stream=True)
        except httpx.HTTPError as exc:
            return upstream_exception(exc, service.name)

        response_headers = _filter_headers(upstream.headers, _RESPONSE_HEADER_DENYLIST)
        if upstream.status_code >= 400:
            content = await upstream.aread()
            await upstream.aclose()
            return normalize_upstream_error(
                service_name=service.name,
                status_code=upstream.status_code,
                content=content,
                headers=response_headers,
            )

        if upstream.is_stream_consumed:
            return Response(
                content=upstream.content,
                status_code=upstream.status_code,
                headers=response_headers,
                media_type=response_headers.get("content-type"),
            )

        return StreamingResponse(
            upstream.aiter_raw(),
            status_code=upstream.status_code,
            headers=response_headers,
            background=BackgroundTask(upstream.aclose),
        )


def forwarded_credential(process_credential: str) -> str:
    """HMAC-SHA256 keyed with a child's process credential over the contract label, as hex.

    A child compares it with the value it derives itself to tell a request ServiceHub forwarded,
    after checking the hub token, from one that reached its port directly. It is derived so a
    forwarded request never carries the process credential, and like it is never logged.
    """
    return hmac.new(
        process_credential.encode(), _FORWARDED_CREDENTIAL_LABEL, hashlib.sha256
    ).hexdigest()


def _target_url(request: Request, service: ServiceInfo) -> str:
    url = f"http://127.0.0.1:{service.port}{request.url.path}"
    if request.url.query:
        return f"{url}?{request.url.query}"
    return url


def normalized_upstream_path(request: Request) -> str:
    """Return the path semantics httpx will use for the upstream request."""
    return httpx.URL(f"http://service.invalid{request.url.path}").path


def _proxy_timeout(request: Request) -> httpx.Timeout:
    if (
        request.method == "PUT"
        and normalized_upstream_path(request) == "/llm-router/v1/local/ctx-size"
    ):
        return _LOCAL_CTX_UPDATE_TIMEOUT
    return _DEFAULT_PROXY_TIMEOUT


def _filter_headers(headers: Mapping[str, str], denylist: frozenset[str]) -> dict[str, str]:
    return {name: value for name, value in headers.items() if name.lower() not in denylist}


def is_management_path(service_name: str, path: str, method: str = "GET") -> bool:
    """Whether a ``method`` request to ``path`` on ``service_name`` must carry the process credential."""
    if path in _NO_CREDENTIAL_PATHS:
        return False
    if service_name == "llmrouter_manager" and (
        path.startswith(_DATA_PROTECTION_PREFIX) or path == _DATA_PROTECTION_PREFIX.rstrip("/")
    ):
        return not (method.upper() == "GET" and path in _DATA_PROTECTION_OPEN_GET)
    if method.upper() not in _READ_METHODS and any(
        path == p or path.startswith(p + "/") for p in _MUTATION_GATED_PREFIXES.get(service_name, ())
    ):
        return True
    prefixes = _MANAGEMENT_PREFIXES.get(service_name, ())
    return any(path.startswith(p) or path == p.rstrip("/") for p in prefixes)


def _management_credential(request: Request, service: ServiceInfo) -> dict[str, str]:
    # Scoped to management prefixes: same credential unlocks /internal/inference-key and /shutdown
    path = normalized_upstream_path(request)
    if not is_management_path(service.name, path, request.method):
        return {}
    process_manager = getattr(request.app.state, "process_manager", None)
    if process_manager is None:
        return {}
    credential = process_manager.current_process_credential(
        service.name, expected_instance_id=service.instance_id
    )
    return {PROCESS_CREDENTIAL_HEADER: credential} if credential else {}
