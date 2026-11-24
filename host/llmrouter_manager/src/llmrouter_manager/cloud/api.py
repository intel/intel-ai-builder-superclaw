"""Cloud subsystem HTTP API — catalog + provider registry + cloud-model singleton.

Endpoints per plan §6.10 / README §8.8:

- GET    /llm-router/v1/cloud/catalog                — shipped catalog (no internal fields)
- GET    /llm-router/v1/cloud/providers              — configured ids only
- GET    /llm-router/v1/cloud/providers/{id}         — single (no apikey)
- PUT    /llm-router/v1/cloud/providers/{id}         — replace
- DELETE /llm-router/v1/cloud/providers/{id}         — 409 if cloud-model refs
- POST   /llm-router/v1/cloud/providers/{id}/test    — probe (inline or saved)
- GET    /llm-router/v1/cloud/model                  — 404 if not configured
- PUT    /llm-router/v1/cloud/model                  — 422 if provider not configured
- DELETE /llm-router/v1/cloud/model                  — idempotent
- GET    /llm-router/v1/cloud/model/health           — probe selected cloud-model
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from loguru import logger

from . import cloud_model, health, model_catalog, model_discovery, registry
from .catalog import (
    get_litellm_provider,
    get_provider_base_url,
    get_provider_models_protocol,
    get_provider_models_url,
    get_models_dev_provider,
    is_catalog_provider,
    public_catalog,
)
from ..common.errors import error_response
from ..oauth.constants import OAUTH_PROVIDER_IDS


# --- catalog ---------------------------------------------------------------

catalog_router = APIRouter(
    prefix="/llm-router/v1/cloud/catalog", tags=["cloud.catalog"]
)


@catalog_router.get("")
async def get_catalog() -> JSONResponse:
    return JSONResponse(public_catalog())


# --- providers -------------------------------------------------------------

providers_router = APIRouter(
    prefix="/llm-router/v1/cloud/providers", tags=["cloud.providers"]
)


def _provider_view(provider_id: str, record: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": provider_id,
        "api_key_set": bool(record.get("api_key")),
    }


def _unsupported_provider_response(provider_id: str) -> JSONResponse:
    return error_response(
        "unsupported_provider",
        f"provider {provider_id!r} is not supported",
        status_code=422,
    )


def _oauth_provider_response(provider_id: str) -> JSONResponse:
    return error_response(
        "oauth_provider_unsupported",
        f"provider {provider_id!r} is not a supported oauth provider",
        status_code=422,
    )


@providers_router.get("")
async def list_providers() -> JSONResponse:
    items: list[dict[str, Any]] = []
    for pid in registry.list_configured():
        if not is_catalog_provider(pid):
            continue
        record = registry.get(pid)
        if record is None:
            continue
        items.append(_provider_view(pid, record))
    return JSONResponse(items)


@providers_router.get("/{provider_id}")
async def get_provider(provider_id: str) -> JSONResponse:
    if not registry.PROVIDER_ID_PATTERN.match(provider_id):
        return error_response(
            "invalid_provider_id",
            f"provider id {provider_id!r} is not a valid identifier",
            status_code=422,
        )
    if not is_catalog_provider(provider_id):
        return _unsupported_provider_response(provider_id)
    record = registry.get(provider_id)
    if record is None:
        return error_response(
            "not_configured",
            f"provider {provider_id!r} is not configured",
            status_code=404,
        )
    return JSONResponse(_provider_view(provider_id, record))


async def _read_json_body(request: Request) -> tuple[dict[str, Any] | None, JSONResponse | None]:
    """Parse request body as JSON object; return (body, None) or (None, error_response)."""
    try:
        body = await request.json()
    except Exception as exc:
        return None, error_response(
            "invalid_json",
            "request body is not valid JSON",
            status_code=400,
            details={"detail": str(exc)[:200]},
        )
    if not isinstance(body, dict):
        return None, error_response(
            "invalid_body", "request body must be a JSON object", status_code=400
        )
    return body, None


@providers_router.put("/{provider_id}")
async def put_provider(
    provider_id: str, request: Request, probe: bool = True
) -> JSONResponse:
    """Persist provider credentials, running the ``/models`` probe first (opt out with ``?probe=false``)."""
    if not registry.PROVIDER_ID_PATTERN.match(provider_id):
        return error_response(
            "invalid_provider_id",
            f"provider id {provider_id!r} is not a valid identifier",
            status_code=422,
        )
    if not is_catalog_provider(provider_id):
        return _unsupported_provider_response(provider_id)
    body, err = await _read_json_body(request)
    if err is not None:
        return err
    assert body is not None
    api_key = body.get("api_key")
    if not isinstance(api_key, str) or not api_key:
        return error_response(
            "missing_api_key", "api_key is required", status_code=422
        )
    base_url = get_provider_base_url(provider_id)

    if probe:
        result = await health.probe_provider(
            api_key=api_key,
            models_url=get_provider_models_url(provider_id),
            models_protocol=get_provider_models_protocol(provider_id),
        )
        if result.get("status") != "ok":
            probe_error = str(result.get("error", "probe_failed"))
            detail = str(result.get("detail", ""))[:300]
            if probe_error == "authentication_failed":
                status_code, code, message = (
                    401,
                    "invalid_api_key",
                    f"provider {provider_id!r} rejected the api_key",
                )
            else:
                status_code, code, message = (
                    502,
                    "upstream_unreachable",
                    f"could not reach provider {provider_id!r} to verify api_key",
                )
            logger.warning(
                "config.change kind=cloud.provider action=put_rejected provider={} probe_error={} detail={}",
                provider_id,
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

    registry.put(provider_id, api_key=api_key)
    logger.info(
        "config.change kind=cloud.provider action=put provider={} api_key_set=1",
        provider_id,
    )
    return JSONResponse({"ok": True})


@providers_router.delete("/{provider_id}")
async def delete_provider(provider_id: str) -> JSONResponse:
    if not registry.PROVIDER_ID_PATTERN.match(provider_id):
        return error_response(
            "invalid_provider_id",
            f"provider id {provider_id!r} is not a valid identifier",
            status_code=422,
        )
    if not is_catalog_provider(provider_id):
        return _unsupported_provider_response(provider_id)
    cm = cloud_model.get()
    if isinstance(cm, dict) and cm.get("provider") == provider_id:
        return error_response(
            "in_use",
            f"provider {provider_id!r} is referenced by the cloud-model",
            status_code=409,
            details={"referenced_by": "cloud-model"},
        )
    registry.delete(provider_id)
    logger.info(
        "config.change kind=cloud.provider action=delete provider={}",
        provider_id,
    )
    return JSONResponse({"ok": True})


@providers_router.post("/{provider_id}/test")
async def test_provider(provider_id: str, request: Request) -> JSONResponse:
    if not registry.PROVIDER_ID_PATTERN.match(provider_id):
        return error_response(
            "invalid_provider_id",
            f"provider id {provider_id!r} is not a valid identifier",
            status_code=422,
        )
    if not is_catalog_provider(provider_id) and provider_id not in OAUTH_PROVIDER_IDS:
        return _unsupported_provider_response(provider_id)

    # Inline body is optional: empty body / no body → use saved config.
    inline: dict[str, Any] = {}
    raw = await request.body()
    if raw:
        try:
            parsed = await request.json()
            if isinstance(parsed, dict):
                inline = parsed
        except Exception:
            return error_response(
                "invalid_json", "request body is not valid JSON", status_code=400
            )

    api_key = inline.get("api_key") if inline else None
    model_raw = inline.get("model") if inline else None
    model = model_raw.strip() if isinstance(model_raw, str) else ""
    saved = registry.get(provider_id) if is_catalog_provider(provider_id) else None
    if provider_id in OAUTH_PROVIDER_IDS and (
        provider_id == "github_copilot" or (not api_key and saved is None)
    ):
        from ..oauth import readiness as oauth_readiness, state as oauth_state
        from ..oauth.errors import RefreshRequired, SessionNotFound

        if oauth_state.get(provider_id) is None:
            return error_response(
                "not_configured",
                f"provider {provider_id!r} is not configured",
                status_code=400,
            )
        if model:
            probe = await health.probe_model(
                provider_id=provider_id,
                model_id=model,
                auth_mode="oauth",
                api_key="",
                base_url=None,
            )
            return JSONResponse(
                {"auth_mode": "oauth", "provider": provider_id, **probe}
            )
        try:
            await oauth_readiness.ensure_ready(provider_id)
        except (SessionNotFound, RefreshRequired):
            return error_response(
                "provider_not_configured",
                f"oauth session for {provider_id!r} needs re-login",
                status_code=502,
                details={"provider": provider_id, "auth_mode": "oauth"},
                extra={"status": "error"},
            )
        return JSONResponse(
            {"status": "ok", "auth_mode": "oauth", "provider": provider_id}
        )

    if not api_key:
        if saved is None:
            return error_response(
                "not_configured",
                f"provider {provider_id!r} is not configured",
                status_code=400,
            )
        api_key = api_key or saved.get("api_key")

    if not api_key:
        return error_response(
            "missing_api_key", "api_key is required", status_code=400
        )

    result = await health.probe_provider(
        api_key=str(api_key),
        models_url=get_provider_models_url(provider_id),
        models_protocol=get_provider_models_protocol(provider_id),
    )
    if result.get("status") == "ok" and model:
        result = await health.probe_model(
            provider_id=provider_id,
            model_id=model,
            auth_mode="api_key",
            api_key=str(api_key),
            base_url=get_provider_base_url(provider_id),
        )
    return JSONResponse(result)



@providers_router.get("/{provider_id}/models")
async def list_provider_models(provider_id: str) -> JSONResponse:
    """List models available from a configured cloud provider.

    First tries OpenAI-compatible ``GET <base>/models``. Providers that do not
    expose that endpoint can fall back to LiteLLM's scoped model discovery.
    """
    if not registry.PROVIDER_ID_PATTERN.match(provider_id):
        return error_response(
            "invalid_provider_id",
            f"provider id {provider_id!r} is not a valid identifier",
            status_code=422,
        )
    if not is_catalog_provider(provider_id) and provider_id not in OAUTH_PROVIDER_IDS:
        return _unsupported_provider_response(provider_id)

    record = registry.get(provider_id)
    if record is None:
        # OAuth-connected providers have no api-key registry entry, and the
        # Codex subscription backend exposes no /models endpoint - surface the
        # subscription model list fetched live (plan-tier aware) from the Codex
        # models endpoint via oauth_dispatch.list_models() instead of 404.
        from ..oauth import dispatch as oauth_dispatch, state as oauth_state
        from ..oauth.errors import RefreshRequired, RefreshTransient, SessionNotFound
        try:
            has_oauth = oauth_state.get(provider_id) is not None
        except ValueError:
            has_oauth = False
        if has_oauth:
            try:
                models = await oauth_dispatch.list_models(provider_id)
            except SessionNotFound as exc:
                return error_response(
                    "oauth_session_missing",
                    f"OAuth session for {provider_id!r} is missing or incomplete. Re-run login.",
                    status_code=401,
                    details={"provider": provider_id, "reason": str(exc)[:200]},
                )
            except RefreshTransient as exc:
                return error_response(
                    "oauth_refresh_unavailable",
                    f"OAuth token refresh for {provider_id!r} failed transiently; retry shortly.",
                    status_code=502,
                    details={"provider": provider_id, "reason": str(exc)[:200]},
                )
            except RefreshRequired as exc:
                return error_response(
                    "oauth_reauth_required",
                    f"OAuth token for {provider_id!r} is no longer valid; re-run login.",
                    status_code=401,
                    details={"provider": provider_id, "reason": str(exc)[:200]},
                )
            return JSONResponse(
                {
                    "provider": provider_id,
                    "source": "oauth",
                    "data": [
                        {
                            "id": model_id,
                            "name": model_id,
                            "release_date": "",
                        }
                        for model_id in models
                    ],
                }
            )
        return error_response(
            "not_configured",
            f"provider {provider_id!r} is not configured",
            status_code=404,
        )

    api_key = str(record.get("api_key", ""))
    outcome, status, body = await model_discovery.list_models_from_provider_endpoint(
        models_url=get_provider_models_url(provider_id),
        api_key=api_key,
        protocol=get_provider_models_protocol(provider_id),
    )
    if outcome == "ok":
        live_model_ids = [
            str(model.get("id"))
            for model in body.get("data", [])
            if isinstance(model, dict) and isinstance(model.get("id"), str)
        ]
        try:
            catalog = await model_catalog.get_catalog()
        except Exception:
            return JSONResponse(
                {
                    "provider": provider_id,
                    "source": "provider_endpoint",
                    "data": [
                        {"id": model_id, "name": model_id, "release_date": ""}
                        for model_id in live_model_ids
                    ],
                },
                status_code=status,
            )
        return JSONResponse(
            {
                "provider": provider_id,
                "source": "catalog+provider_endpoint",
                "data": model_catalog.picker_models(
                    catalog=catalog,
                    catalog_provider=get_models_dev_provider(provider_id),
                    live_model_ids=set(live_model_ids),
                ),
            },
            status_code=status,
        )
    return error_response(
        str(body.get("error", "model_list_failed")),
        f"failed to list models for provider {provider_id!r}",
        status_code=status,
        details={key: value for key, value in body.items() if key != "error"},
    )

# --- cloud-model singleton -------------------------------------------------

model_router = APIRouter(
    prefix="/llm-router/v1/cloud/model", tags=["cloud.model"]
)


@model_router.get("")
async def get_cloud_model() -> JSONResponse:
    cm = cloud_model.get()
    if cm is None:
        return error_response(
            "not_configured",
            "no cloud-model is configured",
            status_code=404,
            extra={"ok": False},
        )
    provider_id = str(cm.get("provider", ""))
    provider_rec = registry.get(provider_id) or {}
    return JSONResponse(
        {
            "provider": provider_id,
            "model": str(cm.get("model", "")),
            "max_tokens": int(cm.get("max_tokens", 4096)),
            "context_limit": int(cm.get("context_limit", 196608)),
            "auth_mode": str(cm.get("auth_mode", "api_key")),
        }
    )


@model_router.put("")
async def put_cloud_model(request: Request) -> JSONResponse:
    body, err = await _read_json_body(request)
    if err is not None:
        return err
    assert body is not None
    provider = body.get("provider")
    model = body.get("model")
    if not isinstance(provider, str) or not provider:
        return error_response(
            "missing_provider", "provider is required", status_code=422
        )
    if not isinstance(model, str) or not model:
        return error_response(
            "missing_model", "model is required", status_code=422
        )

    auth_mode_raw = body.get("auth_mode", "api_key")
    if auth_mode_raw not in ("api_key", "oauth"):
        return error_response(
            "invalid_auth_mode",
            "auth_mode must be 'api_key' or 'oauth'",
            status_code=422,
            details={"auth_mode": auth_mode_raw},
        )
    auth_mode = auth_mode_raw
    if auth_mode == "oauth":
        # OAuth credential lives in state/oauth/<provider>.bin, not the API-key
        # registry. oauth_state.get applies PROVIDER_ID_PATTERN (path-traversal defense).
        from ..oauth import state as oauth_state
        if provider not in OAUTH_PROVIDER_IDS:
            return _oauth_provider_response(provider)
        try:
            has_session = oauth_state.get(provider) is not None
        except ValueError:
            has_session = False
        if not has_session:
            return error_response(
                "provider_not_configured",
                f"no oauth session for provider {provider!r}; run login first",
                status_code=422,
            )
    elif not is_catalog_provider(provider):
        return _unsupported_provider_response(provider)
    elif registry.get(provider) is None:
        return error_response(
            "provider_not_configured",
            f"provider {provider!r} is not configured",
            status_code=422,
        )

    max_tokens_raw = body.get("max_tokens")
    context_limit_raw = body.get("context_limit")
    cloud_model.put(
        provider=provider,
        model=model,
        max_tokens=(
            int(max_tokens_raw)
            if isinstance(max_tokens_raw, (int, float))
            else None
        ),
        context_limit=(
            int(context_limit_raw)
            if isinstance(context_limit_raw, (int, float))
            else None
        ),
        auth_mode=auth_mode,
    )
    logger.info(
        "config.change kind=cloud.model action=put provider={} model={} auth_mode={}",
        provider,
        model,
        auth_mode,
    )
    return JSONResponse({"ok": True}, status_code=202)


@model_router.delete("")
async def delete_cloud_model() -> JSONResponse:
    cloud_model.delete()
    logger.info("config.change kind=cloud.model action=delete")
    return JSONResponse({"ok": True})


@model_router.get("/health")
async def cloud_model_health() -> JSONResponse:
    cm = cloud_model.get()
    if cm is None:
        return error_response(
            "not_configured",
            "no cloud-model is configured",
            status_code=404,
            extra={"status": "error"},
        )
    provider_id = str(cm.get("provider", ""))
    if str(cm.get("auth_mode", "api_key")) == "oauth":
        # OAuth cloud-model has no api-key registry entry; health = the oauth
        # session exists and its token is fresh/refreshable.
        from ..oauth import readiness as oauth_readiness
        from ..oauth.errors import RefreshRequired, SessionNotFound
        try:
            await oauth_readiness.ensure_ready(provider_id)
        except (SessionNotFound, RefreshRequired):
            return error_response(
                "provider_not_configured",
                f"oauth session for {provider_id!r} is missing or needs re-login",
                status_code=502,
                details={"provider": provider_id, "auth_mode": "oauth"},
                extra={"status": "error"},
            )
        return JSONResponse(
            {
                "provider": provider_id,
                "model": str(cm.get("model", "")),
                "auth_mode": "oauth",
                "status": "ok",
            }
        )
    if not is_catalog_provider(provider_id):
        return _unsupported_provider_response(provider_id)
    provider_rec = registry.get(provider_id)
    if not provider_rec:
        return error_response(
            "provider_not_configured",
            f"provider {provider_id!r} is not configured",
            status_code=502,
            details={"provider": provider_id},
            extra={"status": "error"},
        )
    result = await health.probe_provider(
        api_key=str(provider_rec.get("api_key", "")),
        models_url=get_provider_models_url(provider_id),
        models_protocol=get_provider_models_protocol(provider_id),
    )
    return JSONResponse(
        {
            "provider": provider_id,
            "model": str(cm.get("model", "")),
            **result,
        }
    )
