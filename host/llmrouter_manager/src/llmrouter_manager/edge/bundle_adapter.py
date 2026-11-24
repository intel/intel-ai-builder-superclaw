"""Trusted Edge Bundle discovery and semantic preparation adapter."""

from __future__ import annotations

import asyncio
import hashlib
import json
import math
import re
from typing import Any
from urllib.parse import urlsplit

import httpx

from ..capability.bundle_lifecycle import pending_state
from ..capability.bundle_registry import BundleEntry, BundleRegistry
from ..common.http_client import build_async_client_for_url
from ..common.operations import OperationPool
from ..common.store import Store
from ..local.operations_bridge import OperationCancelled, OperationHandle
from . import config as edge_config
from .probe import list_edge_models


# Stable step IDs published on metadata.files so the UI's checklist rows
# survive model-id changes (embedding swap, bundle upgrade).
STEP_DISCOVER = "step:discover"
STEP_CHAT = "step:chat"
STEP_EMBEDDING = "step:embedding"


class EdgeDiscoveryError(RuntimeError):
    """``GET <base>/models`` failed. Carries the probe's ``error`` code and a
    secret-free ``detail``; the message names the host and the cause."""

    def __init__(self, *, host: str, error: str, detail: str) -> None:
        self.host = host
        self.error = error
        self.detail = detail
        server = f"Edge server {host}" if host else "Edge server"
        if error == "connection_failed":
            message = f"Can't reach {server}: connection failed"
        elif error == "timeout":
            message = f"Can't reach {server}: timed out"
        elif error == "authentication_failed":
            message = f"{server} rejected the API key"
        else:
            message = f"Edge model discovery failed on {server}: {error or 'unknown error'}"
        super().__init__(message)


# Probe ``error`` codes from ``list_edge_models`` -> step ``error_code``.
_DISCOVERY_PROBE_CODES = {
    "connection_failed": "connection_failed",
    "timeout": "timeout",
    "authentication_failed": "auth_failed",
    "upstream_error": "upstream_error",
    "invalid_json": "invalid_response",
    "invalid_body": "invalid_response",
    "missing_base_url": "not_configured",
    "missing_api_key": "not_configured",
}


_URL_RE = re.compile(r"[A-Za-z][A-Za-z0-9+.-]*://\S+")


def _edge_host(base_url: str) -> str:
    """``host[:port]`` of the Edge URL — no scheme, userinfo, path or query."""
    try:
        parts = urlsplit(base_url)
        host = parts.hostname or ""
        port = parts.port
    except ValueError:
        return ""
    if ":" in host:
        host = f"[{host}]"
    return f"{host}:{port}" if host and port else host


def _discovery_error(config: dict[str, Any], payload: dict[str, Any]) -> EdgeDiscoveryError:
    host = _edge_host(str(config["base_url"]))
    detail = str(payload.get("detail") or "")
    # The upstream may echo the key or a URL back. Neither leaves LRM. A URL is
    # dropped whole: the message already names the configured host, and a URL cut
    # inside its userinfo would otherwise parse as a host and port. URLs go first:
    # masking a key that overlaps one (its scheme, say) would hide it from _URL_RE.
    detail = _URL_RE.sub("<url>", detail)
    api_key = str(config.get("api_key") or "")
    # A transport error can echo the key escaped, e.g. ``b'Bearer <key>\r\n'``.
    for key in dict.fromkeys((api_key, api_key.encode("unicode_escape").decode(), repr(api_key.encode())[2:-1])):
        if not key:
            continue
        detail = detail.replace(key, "***")
        # The probe cuts ``detail`` at 300 chars, which can split an echoed key:
        # mask any trailing key prefix, however short.
        for size in range(len(key) - 1, 0, -1):
            if detail.endswith(key[:size]):
                detail = detail[:-size] + "***"
                break
    return EdgeDiscoveryError(host=host, error=str(payload.get("error") or ""), detail=_short(detail))


def _failure_reason(exc: Exception) -> str:
    """A durable, non-empty reason. Transport timeouts stringify to ``""``, which
    would otherwise be lost and fall back to the generic "preparing bundle"."""
    return str(exc).strip() or type(exc).__name__


def classify_probe_failure(exc: Exception) -> tuple[str, str]:
    """Map a probe exception to ``(code, detail)`` — ``code`` drives the UI's
    localized message via ``capability.probe_error.{code}``; ``detail`` is a
    ≤300-char free-text supplement rendered under the row."""
    if isinstance(exc, EdgeDiscoveryError):
        return _DISCOVERY_PROBE_CODES.get(exc.error, "upstream_error"), exc.detail or _short(str(exc))
    if isinstance(exc, httpx.TimeoutException):
        return "timeout", "Read timeout after 10s"
    if isinstance(exc, (httpx.ConnectError, httpx.NetworkError, httpx.RemoteProtocolError)):
        return "connection_failed", _short(str(exc)) or "Could not reach edge server"
    if isinstance(exc, httpx.HTTPStatusError):
        status = exc.response.status_code
        detail = _short(str(exc))
        if status in (401, 403):
            return "auth_failed", detail or f"HTTP {status}"
        if status == 404:
            return "model_not_found", detail or "HTTP 404"
        if 500 <= status < 600:
            return "upstream_error", detail or f"HTTP {status}"
        return "unknown", detail or f"HTTP {status}"
    text = str(exc)
    lowered = text.lower()
    if "complete trusted bundle" in lowered:
        return "bundle_mismatch", _short(text) or "Edge does not expose the trusted bundle"
    if "malformed" in lowered or "invalid" in lowered or "896" in text:
        return "invalid_response", _short(text) or "Probe returned an invalid response"
    if "changed during preparation" in lowered:
        return "config_changed", _short(text) or "Edge config changed mid-prepare"
    if "not configured" in lowered:
        return "not_configured", _short(text) or "Edge is not configured"
    return "unknown", _short(text) or type(exc).__name__


def _short(text: str) -> str:
    return text.strip()[:300]


def edge_config_fingerprint(config: dict[str, Any]) -> str:
    facts = {
        "base_url": config.get("base_url"),
        "api_key": config.get("api_key"),
        "bypass_proxy": config.get("bypass_proxy", True),
    }
    return hashlib.sha256(
        json.dumps(facts, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def edge_model_selection_fingerprint(config: dict[str, Any]) -> str:
    facts = {"model_name": config.get("model_name")}
    return hashlib.sha256(
        json.dumps(facts, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def parse_model_ids(payload: dict[str, Any]) -> frozenset[str]:
    """Extract model IDs from an edge ``/models`` response.

    Accepts two shapes:

    - OpenAI list envelope: ``{"object": "list", "data": [{"id": ...}, ...]}``.
    - Bare-list envelope: ``{"models": ["id", ...]}`` — some OpenAI-compatible
      internal gateways (observed on Intel's "superrouter"-style edge proxy)
      serve this instead of the OpenAI shape. Both are just "the endpoint
      told us its model IDs"; the envelope shape is otherwise irrelevant to
      bundle matching.
    """
    ids: list[str] = []
    if payload.get("object") == "list" and isinstance(payload.get("data"), list):
        for item in payload["data"]:
            if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not item["id"]:
                raise ValueError("Edge /models contains an invalid model entry")
            ids.append(item["id"])
    elif isinstance(payload.get("models"), list):
        for item in payload["models"]:
            if not isinstance(item, str) or not item:
                raise ValueError("Edge /models contains an invalid model entry")
            ids.append(item)
    else:
        raise ValueError("Edge /models response must be an OpenAI model list")
    if len(ids) != len(set(ids)):
        raise ValueError("Edge /models contains duplicate model IDs")
    return frozenset(ids)


async def _probe_chat(config: dict[str, Any], model_id: str) -> None:
    url = f"{str(config['base_url']).rstrip('/')}/chat/completions"
    headers = {"Authorization": f"Bearer {config['api_key']}"}
    body = {"model": model_id, "messages": [{"role": "user", "content": "."}], "max_tokens": 1}
    async with build_async_client_for_url(
        url, force_bypass=bool(config.get("bypass_proxy", True)), timeout=10.0
    ) as client:
        response = await client.post(url, json=body, headers=headers)
    response.raise_for_status()
    payload = response.json()
    choices = payload.get("choices") if isinstance(payload, dict) else None
    message = choices[0].get("message") if isinstance(choices, list) and choices and isinstance(choices[0], dict) else None
    if (
        not isinstance(message, dict)
        or message.get("role") != "assistant"
        or not isinstance(message.get("content"), str)
        or payload.get("model") not in {None, model_id}
    ):
        raise ValueError("Edge Chat probe returned malformed choices")


async def _probe_embedding(config: dict[str, Any], model_id: str) -> None:
    url = f"{str(config['base_url']).rstrip('/')}/embeddings"
    headers = {"Authorization": f"Bearer {config['api_key']}"}
    async with build_async_client_for_url(
        url, force_bypass=bool(config.get("bypass_proxy", True)), timeout=10.0
    ) as client:
        response = await client.post(url, json={"model": model_id, "input": ["."]}, headers=headers)
    response.raise_for_status()
    payload = response.json()
    data = payload.get("data") if isinstance(payload, dict) else None
    vector = data[0].get("embedding") if isinstance(data, list) and len(data) == 1 and isinstance(data[0], dict) else None
    if (
        not isinstance(vector, list)
        or len(vector) != 896
        or any(not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value) for value in vector)
        or (payload.get("model") is not None and payload.get("model") != model_id)
    ):
        raise ValueError("Edge Embedding probe returned an invalid 896-dimensional vector")


def classify_edge_failure(exc: Exception) -> str | None:
    """Map a probe exception to a structured, secret-free reason code.

    Returns None when the failure cannot be confidently classified — callers
    fall back to the free-text reason for display.
    """
    if isinstance(exc, EdgeDiscoveryError):
        if exc.error in ("connection_failed", "timeout"):
            return "url_unreachable"
        if exc.error == "authentication_failed":
            return "invalid_api_key"
        return "bundle_incomplete"
    if isinstance(exc, httpx.HTTPStatusError):
        status = exc.response.status_code
        if status in (401, 403):
            return "invalid_api_key"
        if status == 404:
            return "model_not_found"
        if 500 <= status < 600:
            return "url_unreachable"
    if isinstance(exc, (httpx.TimeoutException, httpx.NetworkError, httpx.RemoteProtocolError, httpx.ProxyError)):
        return "url_unreachable"
    text = str(exc)
    if "complete trusted Bundle" in text:
        # Discovery answered, but the server no longer lists the Bundle's models.
        return "model_not_found"
    return None


async def prepare_edge_bundle(
    *,
    bundle: BundleEntry,
    bundle_registry: BundleRegistry,
    store: Store,
    operation_pool: OperationPool,
    operation_id: str,
    prepare_token: str,
    edge_config_lock: asyncio.Lock,
) -> None:
    handle = OperationHandle(
        operation_pool,
        operation_id,
        lambda state, pct, message: store.update_preparation_progress(
            operation_id, state=state, pct=pct, message=message
        ),
    )
    config = edge_config.get()
    if config is None:
        store.transition_pending_bundle(
            prepare_token=prepare_token,
            pending_bundle=pending_state(bundle, "error", "Edge is not configured"),
        )
        await handle.error("Edge is not configured")
        return
    fingerprint = edge_config_fingerprint(config)
    model_selection_fingerprint = edge_model_selection_fingerprint(config)
    claimed_model_selection_fingerprint = (
        store.get_pending_edge_model_selection_fingerprint()
    )
    if (
        claimed_model_selection_fingerprint is None
        or claimed_model_selection_fingerprint != model_selection_fingerprint
    ):
        store.transition_pending_bundle(
            prepare_token=prepare_token,
            pending_bundle=pending_state(
                bundle, "error", "Edge configuration changed during preparation"
            ),
        )
        await handle.error("Edge configuration changed during preparation")
        return
    await handle.set_files(
        [
            {"id": STEP_DISCOVER, "label": "discover", "role": "probe", "done": 0, "total": 1, "state": "pending"},
            {"id": STEP_CHAT, "label": bundle.chat_model_id, "role": "chat", "done": 0, "total": 1, "state": "pending"},
            {"id": STEP_EMBEDDING, "label": bundle.embedding_model_id, "role": "embedding", "done": 0, "total": 1, "state": "pending"},
        ]
    )
    active_step: str | None = None
    try:
        await handle.raise_if_cancelled()
        active_step = STEP_DISCOVER
        await handle.file_progress(STEP_DISCOVER, done=0, total=1, state="running")
        await handle.message("discovering models on Edge server")
        status, payload = await list_edge_models(
            str(config["base_url"]), str(config["api_key"]), bypass_proxy=bool(config.get("bypass_proxy", True))
        )
        if status != 200:
            raise _discovery_error(config, payload)
        matched = bundle_registry.match_edge_models(
            parse_model_ids(payload), bundle_id=bundle.bundle_id
        )
        if matched is None:
            raise RuntimeError("Edge does not expose the complete trusted Bundle")
        await handle.file_progress(STEP_DISCOVER, done=1, total=1, state="complete")

        active_step = STEP_CHAT
        await handle.file_progress(STEP_CHAT, done=0, total=1, state="running")
        await handle.message("probing Edge Chat semantics")
        await _probe_chat(config, bundle.chat_model_id)
        await handle.file_progress(STEP_CHAT, done=1, total=1, state="complete")
        await handle.raise_if_cancelled()

        active_step = STEP_EMBEDDING
        await handle.file_progress(STEP_EMBEDDING, done=0, total=1, state="running")
        await handle.message("probing Edge Embedding semantics")
        await _probe_embedding(config, bundle.embedding_model_id)
        await handle.file_progress(STEP_EMBEDDING, done=1, total=1, state="complete")
        async with edge_config_lock:
            current = edge_config.get()
            if (
                current is None
                or edge_config_fingerprint(current) != fingerprint
                or edge_model_selection_fingerprint(current)
                != model_selection_fingerprint
            ):
                raise RuntimeError("Edge configuration changed during preparation")
            await handle.raise_if_cancelled()
            if not store.bind_pending_edge_config(
                prepare_token=prepare_token, fingerprint=fingerprint
            ):
                raise RuntimeError("Edge preparation is no longer active")
        store.transition_pending_bundle(
            prepare_token=prepare_token, pending_bundle=pending_state(bundle, "prepared")
        )
        await handle.done(message="Edge Bundle prepared")
    except OperationCancelled:
        store.transition_pending_bundle(prepare_token=prepare_token, pending_bundle=None)
    except asyncio.CancelledError:
        store.transition_pending_bundle(
            prepare_token=prepare_token,
            pending_bundle=pending_state(bundle, "error", "Edge preparation interrupted"),
        )
        raise
    except Exception as exc:
        reason = _failure_reason(exc)
        code, detail = classify_probe_failure(exc)
        if active_step is not None:
            await handle.file_progress(
                active_step,
                done=0,
                total=1,
                state="error",
                error_code=code,
                error_detail=detail,
            )
        store.set_preparation_reason_code(operation_id, classify_edge_failure(exc))
        store.transition_pending_bundle(
            prepare_token=prepare_token,
            pending_bundle=pending_state(bundle, "error", reason),
        )
        await handle.error(reason)
