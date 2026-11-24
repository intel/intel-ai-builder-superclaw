"""Edge subsystem HTTP API — 5 endpoints under `/llm-router/v1/edge/*`.

Per plan §6.8 / README §7.7:

- GET    /llm-router/v1/edge         — {configured, base_url?, model_name?, embedding_model_name?} (api_key never returned)
- PUT    /llm-router/v1/edge         — body {base_url, api_key, model_name?, embedding_model_name?} → 202 {ok:true}
- DELETE /llm-router/v1/edge         — idempotent, 202 {ok:true}
- POST   /llm-router/v1/edge/test    — probe upstream chat.completions (inline body OR saved config)
- GET    /llm-router/v1/edge/models  — proxy GET <base>/models

``model_name`` and ``embedding_model_name`` are optional; defaults
``Qwen3.8-Flash-Next`` / ``KaLM-embedding-v2.5`` are applied at PUT time and
persisted so subsequent ``GET`` returns the filled values.

Edge chat-completions dispatch happens via ``routing/proxy.py._httpx_chat_completions``
(shared with the local httpx passthrough). Edge embedding for the auto
latency router happens via ``routing/auto_router/embedding_client.py``
using the same ``base_url`` + ``api_key`` and the persisted
``embedding_model_name``. The probes in this module go through
``edge/probe.py`` — a separate httpx client per call so /test and /models
are stateless with respect to the data-plane clients. Undefined subpaths
under ``/llm-router/v1/edge/*`` return the default FastAPI 404.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import urlsplit

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from loguru import logger

from . import config as edge_config
from . import probe as edge_probe
from .bundle_adapter import edge_config_fingerprint, edge_model_selection_fingerprint, parse_model_ids
from ..common.errors import error_response
from ..capability.bundle_registry import load_bundle_registry


edge_router = APIRouter(prefix="/llm-router/v1/edge", tags=["edge"])


_DEFAULT_PORTS = {"http": 80, "https": 443}


def _origin(url: str) -> tuple[str, str, int | None] | None:
    """Return (scheme, host, port) with the scheme's default port filled in, or None if unparseable."""
    try:
        parts = urlsplit(url.strip())
        port = parts.port
    except ValueError:
        return None
    if not parts.hostname:
        return None
    scheme = parts.scheme.lower()
    return scheme, parts.hostname, port if port is not None else _DEFAULT_PORTS.get(scheme)


def _same_origin(url_a: str, url_b: str) -> bool:
    """True when both URLs share scheme, host and port (matches the UI's ``URL.origin``)."""
    origin_a = _origin(url_a)
    return origin_a is not None and origin_a == _origin(url_b)


def _resolve_api_key(submitted: object, base_url: str, saved: dict[str, Any]) -> object:
    """Return the submitted key, or the saved key when the field was left blank.

    The saved key is only reused for the server it was saved for, so changing
    the URL to another host can never send that secret to the new host. Any
    non-blank value (including a wrong type) is returned as-is for the caller
    to validate.
    """
    if submitted is not None and submitted != "":
        return submitted
    if _same_origin(base_url, str(saved.get("base_url", ""))):
        return saved.get("api_key")
    return submitted


@edge_router.get("")
async def get_edge() -> JSONResponse:
    """Return edge config (NEVER the api_key). 200 always — ENOENT → configured:false."""
    cfg = edge_config.get()
    if cfg is None:
        return JSONResponse({"configured": False})
    return JSONResponse(
        {
            "configured": True,
            "base_url": str(cfg.get("base_url", "")),
            "model_name": str(cfg.get("model_name", "")),
            "embedding_model_name": str(cfg.get("embedding_model_name", "")),
            "edge_model_selection_fingerprint": edge_model_selection_fingerprint(cfg),
            # Default True for records written before bypass_proxy existed.
            "bypass_proxy": bool(cfg.get("bypass_proxy", edge_config.DEFAULT_BYPASS_PROXY)),
        }
    )


@edge_router.put("")
async def put_edge(request: Request, probe: bool = True) -> JSONResponse:
    """Replace edge config (DPAPI-encrypted, atomic). Full replace per plan §6.8.

    Normalizes ``base_url`` and probes the upstream before persist (opt out
    ``?probe=false``). Probe failure returns ``401 invalid_api_key`` or
    ``502 upstream_unreachable`` without persisting. Mirrors ``PUT
    /cloud/providers/{id}`` (README §7.8).
    """
    try:
        body = await request.json()
    except Exception as exc:
        return error_response(
            "invalid_json",
            "request body is not valid JSON",
            status_code=400,
            details={"detail": str(exc)[:200]},
        )
    if not isinstance(body, dict):
        return error_response(
            "invalid_body", "request body must be a JSON object", status_code=400
        )

    base_url = body.get("base_url")
    if not isinstance(base_url, str) or not base_url:
        return error_response(
            "missing_base_url", "base_url is required", status_code=422
        )
    # A blank api_key on an in-place edit reuses the saved key, same as POST /edge/test.
    submitted_key = body.get("api_key")
    saved_snapshot = edge_config.get() or {}
    api_key = _resolve_api_key(submitted_key, base_url, saved_snapshot)
    reused_saved_key = api_key != submitted_key
    if not isinstance(api_key, str) or not api_key:
        return error_response(
            "missing_api_key", "api_key is required", status_code=422
        )

    model_name_raw = body.get("model_name")
    if model_name_raw is None or model_name_raw == "":
        model_name = edge_config.DEFAULT_MODEL_NAME
    elif isinstance(model_name_raw, str):
        model_name = model_name_raw
    else:
        return error_response(
            "invalid_model_name", "model_name must be a string", status_code=422
        )

    embedding_model_name_raw = body.get("embedding_model_name")
    if embedding_model_name_raw is None or embedding_model_name_raw == "":
        embedding_model_name = edge_config.DEFAULT_EMBEDDING_MODEL_NAME
    elif isinstance(embedding_model_name_raw, str):
        embedding_model_name = embedding_model_name_raw
    else:
        return error_response(
            "invalid_embedding_model_name",
            "embedding_model_name must be a string",
            status_code=422,
        )

    # bypass_proxy is opt-out (default True): edge servers are intranet
    # endpoints that a corporate proxy typically cannot reach / 403s. Omission
    # means "use default" so older UIs that don't send the field keep working.
    bypass_proxy_raw = body.get("bypass_proxy")
    if bypass_proxy_raw is None:
        bypass_proxy = edge_config.DEFAULT_BYPASS_PROXY
    elif isinstance(bypass_proxy_raw, bool):
        bypass_proxy = bypass_proxy_raw
    else:
        return error_response(
            "invalid_bypass_proxy", "bypass_proxy must be a boolean", status_code=422
        )

    normalized_base_url = edge_config.normalize_base_url(base_url)
    if not normalized_base_url:
        return error_response(
            "missing_base_url", "base_url is required", status_code=422
        )

    trusted_edge_bundles = load_bundle_registry().by_backend("edge")
    if model_name not in {bundle.chat_model_id for bundle in trusted_edge_bundles}:
        return error_response(
            "unsupported_edge_model",
            "The selected Edge chat model is not a reviewed trusted Bundle. Contact the product maintainer to request support.",
            status_code=422,
            details={"model_name": model_name, "supported_models": [bundle.chat_model_id for bundle in trusted_edge_bundles]},
        )

    if probe:
        result = await edge_probe.probe_edge(
            base_url=normalized_base_url,
            api_key=api_key,
            model_name=model_name,
            bypass_proxy=bypass_proxy,
        )
        if result.get("status") != "ok":
            probe_error = str(result.get("error", "probe_failed"))
            detail = str(result.get("detail", ""))[:300]
            if probe_error == "authentication_failed":
                status_code, code, message = (
                    401,
                    "invalid_api_key",
                    "edge upstream rejected the api_key",
                )
            elif probe_error == "model_not_found":
                status_code, code, message = (
                    422,
                    "edge_model_not_found",
                    "The Edge endpoint does not serve the selected chat model.",
                )
            else:
                status_code, code, message = (
                    502,
                    "upstream_unreachable",
                    "could not reach edge upstream",
                )
            logger.warning(
                "config.change kind=edge action=put_rejected base_url={} probe_error={} detail={}",
                normalized_base_url,
                probe_error,
                detail,
            )
            return error_response(
                code,
                message,
                status_code=status_code,
                details={
                    "probe_error": probe_error,
                    "detail": detail,
                    "latency_ms": result.get("latency_ms"),
                },
            )

    async with request.app.state.edge_config_lock:
        # The saved record was read before the probe's network wait. If a DELETE
        # or another PUT changed any part of it meanwhile, writing our copy back
        # would resurrect a deleted secret or overwrite a newer config, so refuse.
        if reused_saved_key:
            current = edge_config.get() or {}
            if current != saved_snapshot:
                return error_response(
                    "edge_config_changed",
                    "edge config changed during the request; re-enter the api_key and retry",
                    status_code=409,
                )
        # Before the write, naming the config this save writes: a release replay keeps
        # edge.json only while it holds that config, so a failed or interrupted write
        # cannot leave the released server and key behind.
        request.app.state.store.retain_edge_config_after_release(
            edge_config_fingerprint({
                "base_url": edge_config.normalize_base_url(normalized_base_url),
                "api_key": api_key,
                "bypass_proxy": bool(bypass_proxy),
            })
        )
        edge_config.put(
            base_url=normalized_base_url,
            api_key=api_key,
            model_name=model_name,
            embedding_model_name=embedding_model_name,
            bypass_proxy=bypass_proxy,
        )
    logger.info(
        "config.change kind=edge action=put base_url={} model_name={} embedding_model_name={} bypass_proxy={} api_key_set=1",
        normalized_base_url,
        model_name,
        embedding_model_name,
        bypass_proxy,
    )
    return JSONResponse(
        {
            "ok": True,
            "edge_model_selection_fingerprint": edge_model_selection_fingerprint(
                {"model_name": model_name}
            ),
        },
        status_code=202,
    )


@edge_router.delete("")
async def delete_edge(request: Request) -> JSONResponse:
    """Idempotent delete. 202 always (per §6.8)."""
    async with request.app.state.edge_config_lock:
        edge_config.delete()
    logger.info("config.change kind=edge action=delete")
    return JSONResponse({"ok": True}, status_code=202)


@edge_router.post("/test")
async def test_edge(request: Request) -> JSONResponse:
    """Probe the edge upstream. Symmetric with ``POST /cloud/providers/{id}/test``.

    Two calling modes (mirrors ``cloud/api.py::test_provider``):

    1. **Empty body / no body** → use the saved edge config
       (``state/edge.json`` via ``edge_config.get()``). 400
       ``not_configured`` if no saved config.
    2. **Inline body** ``{base_url?, api_key?, model_name?}`` → any provided
       fields override saved values (fall back to saved for anything
       missing). Enables pre-save "Test Connection" UI flows without
       persisting a bad config.

    Returns the ``probe_edge`` envelope: ``{status, latency_ms, error?,
    detail?, note?, http_status?}``. ``status == "ok"`` covers both genuine
    success and "endpoint alive but model_name not found" (with
    ``note="model_not_found"``), because /test's job is to validate auth +
    connectivity, not model selection.
    """
    inline: dict[str, Any] = {}
    raw = await request.body()
    if raw:
        try:
            parsed = await request.json()
        except Exception as exc:
            return error_response(
                "invalid_json",
                "request body is not valid JSON",
                status_code=400,
                details={"detail": str(exc)[:200]},
            )
        if isinstance(parsed, dict):
            inline = parsed
        else:
            return error_response(
                "invalid_body",
                "request body must be a JSON object",
                status_code=400,
            )

    saved = edge_config.get() or {}
    if not inline and not saved:
        return error_response(
            "not_configured", "no edge config is saved", status_code=400
        )

    base_url = inline.get("base_url") or saved.get("base_url") or ""
    model_name = (
        inline.get("model_name")
        or saved.get("model_name")
        or edge_config.DEFAULT_MODEL_NAME
    )

    if not isinstance(base_url, str) or not base_url:
        return error_response(
            "missing_base_url", "base_url is required", status_code=422
        )
    api_key = _resolve_api_key(inline.get("api_key"), base_url, saved)
    if not isinstance(api_key, str) or not api_key:
        return error_response(
            "missing_api_key", "api_key is required", status_code=422
        )
    if not isinstance(model_name, str):
        return error_response(
            "invalid_model_name", "model_name must be a string", status_code=422
        )

    # The probe runs BEFORE the config is saved, so the proxy-bypass intent must
    # ride on the request (falling back to the saved flag, then the opt-out
    # default). Without this, testing an intranet edge behind a corporate proxy
    # 403s even though the eventual saved config would have bypassed it.
    bypass_proxy_raw = inline.get("bypass_proxy")
    if isinstance(bypass_proxy_raw, bool):
        bypass_proxy = bypass_proxy_raw
    elif bypass_proxy_raw is not None:
        return error_response(
            "invalid_bypass_proxy", "bypass_proxy must be a boolean", status_code=422
        )
    else:
        bypass_proxy = bool(saved.get("bypass_proxy", edge_config.DEFAULT_BYPASS_PROXY))

    normalized_base_url = edge_config.normalize_base_url(base_url)
    # Trusted-model discovery and the automatic fallback below apply only to
    # inline "Test Connection" requests. A bodyless request is a saved-config
    # health check (loadLocalModelHealth / the status dashboard): it must probe
    # the configured model as-is and never fall back to a different served
    # model, or it would report another model's health as the saved model's.
    models: list[str] = []
    if inline:
        discovered = await _trusted_served_models(normalized_base_url, api_key, bypass_proxy)
        if discovered is None:
            # The model list could not be read (unreachable, auth, or malformed
            # response); fall through so probe_edge surfaces the real error.
            pass
        elif discovered:
            models = discovered
            if model_name not in models:
                model_name = models[0]
        else:
            # Server reachable but serving no trusted Chat+Embedding pair: there
            # is nothing to probe. Return the empty-picker outcome so the UI
            # shows the no-supported-model message, rather than probing an
            # absent saved/default model and reporting model_not_found.
            return JSONResponse({"status": "ok", "models": []})
    result = await edge_probe.probe_edge(
        base_url=normalized_base_url,
        api_key=api_key,
        model_name=model_name,
        bypass_proxy=bypass_proxy,
    )
    return JSONResponse({**result, "models": models})


async def _trusted_served_models(
    base_url: str, connection_key: str, bypass_proxy: bool
) -> list[str] | None:
    """Trusted Edge chat ids whose full chat+embedding pair the server serves, highest priority first.

    Returns ``None`` when the server's model list could not be read (non-200 or
    a malformed body), so the caller can tell a discovery *failure* apart from a
    server that is reachable but serves no trusted pair (an empty list).
    """
    status, body = await edge_probe.list_edge_models(base_url=base_url, api_key=connection_key, bypass_proxy=bypass_proxy)
    if status != 200:
        return None
    try:
        served = parse_model_ids(body)
    except ValueError:
        return None
    bundles = sorted(load_bundle_registry().by_backend("edge"), key=lambda bundle: bundle.priority, reverse=True)
    return [
        bundle.chat_model_id
        for bundle in bundles
        if bundle.chat_model_id in served and bundle.embedding_model_id in served
    ]


@edge_router.get("/models")
async def list_models_at_edge() -> JSONResponse:
    """Proxy ``GET <edge.base_url>/models`` — lists real models the upstream serves.

    Contract:

    - No saved edge config → ``400 {"error":"not_configured"}``.
    - Upstream 2xx with JSON body → ``200`` with body verbatim (OpenAI spec:
      ``{"object":"list","data":[{"id":..., ...}, ...]}``).
    - Upstream non-2xx / timeout / connection error → ``502`` with
      ``{"error": ..., "http_status?": ..., "detail?": ...}`` — code from
      ``probe.py::_classify_http_status`` / ``_classify_exception``.
    - Upstream 2xx with non-JSON body → ``502 invalid_json``.
    """
    cfg = edge_config.get()
    if cfg is None:
        return error_response(
            "not_configured", "no edge config is saved", status_code=400
        )

    status, body = await edge_probe.list_edge_models(
        base_url=str(cfg.get("base_url", "")),
        api_key=str(cfg.get("api_key", "")),
        bypass_proxy=bool(cfg.get("bypass_proxy", edge_config.DEFAULT_BYPASS_PROXY)),
    )
    return JSONResponse(body, status_code=status)
