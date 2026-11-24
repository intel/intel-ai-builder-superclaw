"""Edge upstream probes — POST /chat/completions test + GET /models list.

Mirrors the read-only probe surface ``cloud/health.py::probe_provider``
provides for cloud providers, but targets the raw OpenAI-compatible edge
endpoint directly via httpx (no LiteLLM adapter — edge is a user-deployed
OpenAI-compat server, not one of the ~30 catalogued cloud providers).

Two probes exposed:

- ``probe_edge(base_url, api_key, model_name)`` — POST ``<base>/chat/completions``
  with a 1-token dummy prompt. Returns ``{status, latency_ms, error?, detail?,
  note?, http_status?}``. ``status`` is ``"ok"`` when the endpoint is reachable
  and authenticated (a 404 or "model not found" upstream response still
  classifies as ``ok`` — that's a model-selection concern, not an
  auth/connectivity concern; the ``note`` field surfaces the distinction).
- ``list_edge_models(base_url, api_key)`` — GET ``<base>/models``. Returns
  ``(http_status, body)``. When ``http_status == 200`` the body is the
  upstream JSON payload verbatim (OpenAI spec: ``{"object":"list", "data":[...]}``).
  Any non-2xx from the upstream gets normalized to ``502`` with a
  ``{"error": ..., "http_status": ..., "detail": ...}`` envelope.

Both probes honor the ``SUPERCLAW_INSECURE_TLS`` escape hatch via
``common/env_resolve.py::tls_verify()``.
"""

from __future__ import annotations

import time
from typing import Any

import httpx

from ..common.http_client import build_async_client_for_url


PROBE_TIMEOUT_SECONDS = 10.0
LIST_MODELS_TIMEOUT_SECONDS = 10.0


def _classify_http_status(status: int) -> str:
    """Map an upstream HTTP status to a stable ``error`` code string."""
    if status in (401, 403):
        return "authentication_failed"
    if 500 <= status < 600:
        return "upstream_error"
    return "probe_failed"


def _classify_exception(exc: BaseException) -> str:
    """Map an httpx transport exception to a stable ``error`` code string."""
    if isinstance(exc, httpx.TimeoutException):
        return "timeout"
    if isinstance(exc, (httpx.ConnectError, httpx.NetworkError, httpx.RemoteProtocolError)):
        return "connection_failed"
    return "probe_failed"


def _extract_error_message(resp: httpx.Response) -> str:
    """Pull a useful message from an OpenAI-style error response body.

    OpenAI-compat servers return ``{"error": {"message": "...", "type": "..."}}``;
    some return ``{"error": "string"}``; some return ``{"detail": "..."}`` (FastAPI
    default). Fall through to raw text when the shape is unfamiliar.
    """
    try:
        data = resp.json()
    except Exception:
        return (resp.text or f"HTTP {resp.status_code}")[:300]
    if isinstance(data, dict):
        err = data.get("error")
        if isinstance(err, dict) and "message" in err:
            return str(err["message"])
        if isinstance(err, str):
            return err
        if "detail" in data:
            return str(data["detail"])
    return str(data)[:300]


async def probe_edge(
    base_url: str, api_key: str, model_name: str, *, bypass_proxy: bool = True
) -> dict[str, Any]:
    """Probe ``<base>/chat/completions`` with a 1-token dummy prompt.

    Returns ``{status: "ok"|"error", latency_ms, error?, detail?, note?, http_status?}``.

    Classification rules (mirrors ``cloud/health.py::probe_provider``):

    - 2xx → ``ok``.
    - 4xx that looks like model-not-found (either HTTP 404 or a body message
      containing ``"not found"`` / ``"does not exist"``) → ``error`` with
      ``error="model_not_found"``. A passing connectivity probe must not be
      presented as a usable model selection.
    - 401 / 403 → ``error, authentication_failed``.
    - Other 4xx / 5xx → ``error, upstream_error``.
    - Timeout → ``error, timeout``.
    - Connection refused / DNS failure → ``error, connection_failed``.
    """
    if not base_url:
        return {"status": "error", "error": "missing_base_url", "latency_ms": 0}
    if not api_key:
        return {"status": "error", "error": "missing_api_key", "latency_ms": 0}

    url = f"{base_url.rstrip('/')}/chat/completions"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    body = {
        "model": model_name or "unknown",
        "messages": [{"role": "user", "content": "."}],
        "max_tokens": 1,
    }

    start = time.monotonic()
    try:
        async with build_async_client_for_url(
            url, force_bypass=bypass_proxy, timeout=PROBE_TIMEOUT_SECONDS
        ) as client:
            resp = await client.post(url, json=body, headers=headers)
    except Exception as exc:
        latency = int((time.monotonic() - start) * 1000)
        return {
            "status": "error",
            "latency_ms": latency,
            "error": _classify_exception(exc),
            "detail": str(exc)[:300],
        }

    latency = int((time.monotonic() - start) * 1000)

    if 200 <= resp.status_code < 300:
        return {"status": "ok", "latency_ms": latency}

    detail = _extract_error_message(resp)
    detail_l = detail.lower()

    # Model-not-found means the endpoint is reachable but cannot serve the
    # selected model. Keep that distinct from a usable Edge model; upstream
    # HTTP errors also include 401/403, which the auth branch reports below.
    if resp.status_code == 404 or "not found" in detail_l or "does not exist" in detail_l:
        return {
            "status": "error",
            "latency_ms": latency,
            "error": "model_not_found",
            "note": "model_not_found",
            "http_status": resp.status_code,
            "detail": detail[:300],
        }

    return {
        "status": "error",
        "latency_ms": latency,
        "error": _classify_http_status(resp.status_code),
        "http_status": resp.status_code,
        "detail": detail[:300],
    }


async def list_edge_models(
    base_url: str, api_key: str, *, bypass_proxy: bool = True
) -> tuple[int, dict[str, Any]]:
    """Proxy ``GET <base>/models``. Returns ``(http_status, body)``.

    Success (``http_status == 200``): body is the upstream JSON verbatim,
    which per OpenAI spec is ``{"object": "list", "data": [{"id": ..., ...}, ...]}``.

    Failure paths (all return ``(502, {...})``):

    - Missing base_url / api_key → 400 with ``missing_*`` code (caught before
      network call).
    - Transport failure (timeout, refused, DNS) → 502 with ``timeout`` /
      ``connection_failed``.
    - Non-2xx upstream → 502 with ``upstream_error`` / ``authentication_failed`` /
      ``probe_failed`` per ``_classify_http_status`` + ``http_status`` field
      carrying the actual upstream code + normalized ``detail``.
    - Non-JSON success body → 502 with ``invalid_json``.
    """
    if not base_url:
        return 400, {"error": "missing_base_url"}
    if not api_key:
        return 400, {"error": "missing_api_key"}

    url = f"{base_url.rstrip('/')}/models"
    headers = {"Authorization": f"Bearer {api_key}"}

    try:
        async with build_async_client_for_url(
            url, force_bypass=bypass_proxy, timeout=LIST_MODELS_TIMEOUT_SECONDS
        ) as client:
            resp = await client.get(url, headers=headers)
    except Exception as exc:
        return 502, {
            "error": _classify_exception(exc),
            "detail": str(exc)[:300],
        }

    if 200 <= resp.status_code < 300:
        try:
            payload = resp.json()
        except Exception as exc:
            return 502, {"error": "invalid_json", "detail": str(exc)[:200]}
        if not isinstance(payload, dict):
            return 502, {
                "error": "invalid_body",
                "detail": f"expected JSON object, got {type(payload).__name__}",
            }
        return 200, payload

    detail = _extract_error_message(resp)
    return 502, {
        "error": _classify_http_status(resp.status_code),
        "http_status": resp.status_code,
        "detail": detail[:300],
    }
