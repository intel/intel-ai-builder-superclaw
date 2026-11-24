"""Telemetry control-plane endpoints under ``/llm-router/v1/telemetry/*``."""

from __future__ import annotations

import asyncio
from typing import Literal

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from loguru import logger
from pydantic import BaseModel, ValidationError

from ..common.errors import error_response
from . import config as telemetry_config
from .runtime import SignalName, TelemetryRuntime


telemetry_router = APIRouter(prefix="/llm-router/v1/telemetry", tags=["telemetry"])

class _TracesBody(BaseModel):
    enabled: bool = False
    sample_ratio: float = 1.0


class _MetricsBody(BaseModel):
    enabled: bool = False
    export_interval_ms: int = 10000


class _LogsBody(BaseModel):
    enabled: bool = False
    level: Literal["debug", "info", "warning", "error"] = "info"


class _ExporterBody(BaseModel):
    kind: Literal["otlp_http"] = "otlp_http"
    endpoint: str | None = None
    intranet_server: bool = False


class _TelemetryConfigBody(BaseModel):
    enabled: bool = False
    traces: _TracesBody = _TracesBody()
    metrics: _MetricsBody = _MetricsBody()
    logs: _LogsBody = _LogsBody()
    exporter: _ExporterBody = _ExporterBody()


class _TestExportBody(BaseModel):
    signals: list[SignalName]


@telemetry_router.get("/config")
async def get_telemetry_config() -> JSONResponse:
    return JSONResponse(telemetry_config.load_config())


@telemetry_router.put("/config")
async def put_telemetry_config(request: Request) -> JSONResponse:
    body, err = await _read_config_body(request)
    if err is not None:
        return err
    assert body is not None

    telemetry_config.put_config(body)
    await asyncio.to_thread(_runtime(request).reload, body)
    logger.info(
        "config.change kind=telemetry action=put enabled={} traces_enabled={} metrics_enabled={} logs_enabled={} exporter_kind={} intranet_server={}",
        body["enabled"],
        body["traces"]["enabled"],
        body["metrics"]["enabled"],
        body["logs"]["enabled"],
        body["exporter"]["kind"],
        body["exporter"]["intranet_server"],
    )
    return JSONResponse({"ok": True, "applied": True})


@telemetry_router.get("/status")
async def get_telemetry_status(request: Request) -> JSONResponse:
    runtime = _runtime(request)
    return JSONResponse(
        runtime.status_snapshot(last_applied_at=telemetry_config.load_last_applied_at())
    )


@telemetry_router.post("/test-export")
async def test_telemetry_export(
    request: Request, body: _TestExportBody
) -> JSONResponse:
    runtime = _runtime(request)
    logger.info("telemetry.test_export action=request signals={}", body.signals)
    try:
        results = await asyncio.to_thread(runtime.test_export, body.signals)
    except RuntimeError as exc:
        logger.warning(
            "telemetry.test_export action=rejected signals={} reason={}",
            body.signals,
            str(exc),
        )
        return error_response(
            "telemetry_unavailable",
            str(exc),
            status_code=409,
        )
    ok = all(status == "sent" for status in results.values())
    logger.info(
        "telemetry.test_export action=result ok={} signals={}",
        ok,
        results,
    )
    return JSONResponse({"ok": ok, "signals": results})


@telemetry_router.post("/flush")
async def flush_telemetry(request: Request) -> JSONResponse:
    runtime = _runtime(request)
    snapshot = runtime.status_snapshot(last_applied_at=telemetry_config.load_last_applied_at())
    if not bool(snapshot["enabled"]):
        logger.warning("telemetry.flush action=rejected reason=disabled")
        return error_response(
            "telemetry_unavailable",
            "telemetry is disabled",
            status_code=409,
        )
    logger.info("telemetry.flush action=request")
    ok = await asyncio.to_thread(runtime.force_flush)
    logger.info("telemetry.flush action=result ok={}", ok)
    return JSONResponse({"ok": ok})


@telemetry_router.post("/reset")
async def reset_telemetry_config(request: Request) -> JSONResponse:
    default_config = telemetry_config.default_config()
    telemetry_config.put_config(default_config)
    await asyncio.to_thread(_runtime(request).reload, default_config)
    logger.info("config.change kind=telemetry action=reset")
    return JSONResponse({"ok": True, "applied": True})


def _runtime(request: Request) -> TelemetryRuntime:
    runtime = getattr(request.app.state, "telemetry_runtime", None)
    if runtime is not None:
        return runtime
    raise RuntimeError("telemetry runtime is not attached")


async def _read_config_body(
    request: Request,
) -> tuple[dict[str, object] | None, JSONResponse | None]:
    try:
        raw = await request.json()
    except Exception as exc:
        return None, error_response(
            "invalid_json",
            "request body is not valid JSON",
            status_code=400,
            details={"detail": str(exc)[:200]},
        )
    if not isinstance(raw, dict):
        return None, error_response(
            "invalid_body", "request body must be a JSON object", status_code=400
        )

    try:
        parsed = _TelemetryConfigBody.model_validate(raw)
    except ValidationError as exc:
        return None, error_response(
            "invalid_telemetry_config",
            "telemetry config failed schema validation",
            status_code=422,
            details={"errors": exc.errors()},
        )

    dumped = parsed.model_dump(mode="python")
    rule_error = _validate_config_rules(dumped)
    if rule_error is not None:
        return None, rule_error
    return dumped, None


def _validate_config_rules(config: dict[str, object]) -> JSONResponse | None:
    enabled = bool(config.get("enabled", False))
    traces = _nested_dict(config, "traces")
    metrics = _nested_dict(config, "metrics")
    logs = _nested_dict(config, "logs")
    exporter = _nested_dict(config, "exporter")

    sample_ratio = traces.get("sample_ratio")
    if not isinstance(sample_ratio, (int, float)) or sample_ratio < 0 or sample_ratio > 1:
        return error_response(
            "invalid_telemetry_config",
            "traces.sample_ratio must be between 0 and 1",
            status_code=422,
        )

    export_interval_ms = metrics.get("export_interval_ms")
    if not isinstance(export_interval_ms, int) or export_interval_ms <= 0:
        return error_response(
            "invalid_telemetry_config",
            "metrics.export_interval_ms must be a positive integer",
            status_code=422,
        )

    signals_enabled = any(
        bool(section.get("enabled", False)) for section in (traces, metrics, logs)
    )
    if signals_enabled and not enabled:
        return error_response(
            "invalid_telemetry_config",
            "enabled must be true when any telemetry signal is enabled",
            status_code=422,
        )

    endpoint = exporter.get("endpoint")
    if signals_enabled:
        if exporter.get("kind") != "otlp_http":
            return error_response(
                "invalid_telemetry_config",
                "exporter.kind must be 'otlp_http' when telemetry is enabled",
                status_code=422,
            )
        if not isinstance(endpoint, str) or not endpoint:
            return error_response(
                "invalid_telemetry_config",
                "exporter.endpoint is required when telemetry is enabled",
                status_code=422,
            )

    if endpoint is not None and not isinstance(endpoint, str):
        return error_response(
            "invalid_telemetry_config",
            "exporter.endpoint must be a string or null",
            status_code=422,
        )
    return None


def _nested_dict(config: dict[str, object], key: str) -> dict[str, object]:
    value = config.get(key)
    if isinstance(value, dict):
        return value
    return {}
