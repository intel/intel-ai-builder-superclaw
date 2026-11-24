"""Normalize upstream proxy errors into ServiceHub's error envelope."""

from __future__ import annotations

import json
from collections.abc import Mapping

import httpx
from fastapi import HTTPException, status
from fastapi.responses import JSONResponse, Response
from loguru import logger

from servicehub.common.errors import error_body


def service_not_found(proxy_prefix: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail=error_body(
            "service_not_found", f"No ServiceHub service is registered for {proxy_prefix}"
        ),
    )


def service_unavailable(service_name: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail=error_body(
            "service_unavailable", f"Service {service_name} is not currently available"
        ),
    )


def service_dormant(service_name: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail=error_body(
            "service_dormant",
            f"Service {service_name} is available on demand but has not been started",
        ),
    )


def service_start_failed(service_name: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail=error_body(
            "service_start_failed", f"Service {service_name} could not be started"
        ),
    )


def upstream_exception(exc: httpx.HTTPError, service_name: str) -> JSONResponse:
    logger.warning(
        "upstream request failed service={} error_type={}",
        service_name,
        type(exc).__name__,
    )
    if isinstance(exc, httpx.TimeoutException):
        return JSONResponse(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            content=error_body(
                "gateway_timeout", f"Timed out while contacting service {service_name}"
            ),
        )
    return JSONResponse(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        content=error_body(
            "service_unavailable", f"Unable to contact service {service_name}"
        ),
    )


def normalize_upstream_error(
    *,
    service_name: str,
    status_code: int,
    content: bytes,
    headers: Mapping[str, str],
) -> Response:
    envelope = _standard_error_envelope(content)
    if envelope is not None:
        return Response(
            content=json.dumps(envelope).encode("utf-8"),
            status_code=status_code,
            headers=dict(headers),
            media_type=headers.get("content-type"),
        )

    logger.warning(
        "upstream response error service={} status_code={} content_type={} standardized=false",
        service_name,
        status_code,
        headers.get("content-type", "unknown"),
    )

    return JSONResponse(
        status_code=status_code,
        content=error_body("upstream_error", "Upstream service returned an error"),
        headers=dict(headers),
    )


def _standard_error_envelope(content: bytes) -> dict[str, object] | None:
    try:
        payload = json.loads(content.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    error = payload.get("error")
    if not isinstance(error, dict):
        detail = payload.get("detail")
        if isinstance(detail, dict):
            error = detail.get("error")
    if not isinstance(error, dict):
        return None
    if not isinstance(error.get("code"), str) or not isinstance(error.get("message"), str):
        return None
    return {"error": error}
