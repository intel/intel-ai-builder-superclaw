"""Cloud provider model discovery helpers."""

from __future__ import annotations

# pyright: reportMissingImports=false

import asyncio
from typing import Any

import httpx


LIST_MODELS_TIMEOUT_SECONDS = 10.0


def _classify_http_status(status: int) -> str:
    if status in (401, 403):
        return "invalid_api_key" if status == 401 else "permission_denied"
    if 500 <= status < 600:
        return "upstream_error"
    return "model_list_failed"


def _classify_exception(exc: BaseException) -> str:
    if isinstance(exc, httpx.TimeoutException):
        return "timeout"
    if isinstance(exc, (httpx.ConnectError, httpx.NetworkError, httpx.RemoteProtocolError, httpx.RequestError)):
        return "connection_failed"
    return "model_list_failed"


def _extract_error_message(resp: httpx.Response) -> str:
    try:
        data = resp.json()
    except Exception:
        return resp.text[:300]

    if isinstance(data, dict):
        error = data.get("error")
        if isinstance(error, dict):
            message = error.get("message")
            if isinstance(message, str):
                return message[:300]
        if isinstance(error, str):
            return error[:300]
        detail = data.get("detail")
        if isinstance(detail, str):
            return detail[:300]
    return str(data)[:300]


async def list_models_from_provider_endpoint(
    *,
    models_url: str,
    api_key: str,
    protocol: str,
) -> tuple[str, int, dict[str, Any]]:
    if not models_url:
        return "error", 400, {"error": "missing_models_url"}
    if not api_key:
        return "error", 400, {"error": "missing_api_key"}

    if protocol == "google":
        headers = {"x-goog-api-key": api_key}
    elif protocol == "anthropic":
        headers = {"x-api-key": api_key, "anthropic-version": "2023-06-01"}
    else:
        headers = {"Authorization": f"Bearer {api_key}"}

    try:
        resp = await asyncio.to_thread(
            httpx.get,
            models_url,
            headers=headers,
            timeout=LIST_MODELS_TIMEOUT_SECONDS,
        )
    except Exception as exc:
        status = 504 if isinstance(exc, httpx.TimeoutException) else 502
        return "error", status, {
            "error": _classify_exception(exc),
            "detail": str(exc)[:300],
        }

    if 200 <= resp.status_code < 300:
        try:
            payload = resp.json()
        except Exception as exc:
            return "error", 502, {"error": "invalid_response", "detail": str(exc)[:200]}
        if not isinstance(payload, dict):
            return "error", 502, {
                "error": "invalid_body",
                "detail": f"expected JSON object, got {type(payload).__name__}",
            }
        if protocol == "google":
            models = payload.get("models")
            if not isinstance(models, list):
                return "error", 502, {
                    "error": "invalid_body",
                    "detail": "expected Google models response models to be a list",
                }
            data = [
                {"id": str(model.get("name", "")).removeprefix("models/")}
                for model in models
                if isinstance(model, dict)
                and "generateContent" in model.get("supportedGenerationMethods", [])
                and model.get("name")
            ]
        else:
            data = payload.get("data")
        if not isinstance(data, list):
            return "error", 502, {
                "error": "invalid_body",
                "detail": "expected provider models response data to be a list",
            }
        payload["data"] = data
        payload["source"] = "provider_endpoint"
        return "ok", 200, payload

    if resp.status_code in (404, 405):
        return "unsupported", resp.status_code, {
            "error": "models_endpoint_unsupported",
            "http_status": resp.status_code,
            "detail": _extract_error_message(resp),
        }

    detail = _extract_error_message(resp)
    invalid_key = "api key not valid" in detail.lower() or "invalid api key" in detail.lower()
    status = 401 if invalid_key else resp.status_code if resp.status_code in (401, 403) else 502
    return "error", status, {
        "error": "invalid_api_key" if invalid_key else _classify_http_status(resp.status_code),
        "http_status": resp.status_code,
        "detail": detail,
    }
