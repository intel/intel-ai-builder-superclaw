"""Runtime OTEL wiring for llmrouter_manager telemetry control plane."""

from __future__ import annotations

import os
import threading
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Literal, cast

import requests
from loguru import logger
from opentelemetry._logs import SeverityNumber
from opentelemetry.exporter.otlp.proto.http._log_exporter import OTLPLogExporter
from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.metrics import Counter, Histogram, Meter
from opentelemetry.sdk._logs import LoggerProvider
from opentelemetry.sdk._logs.export import (
    BatchLogRecordProcessor,
    LogRecordExporter,
    LogRecordExportResult,
)
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import (
    MetricExportResult,
    MetricsData,
    PeriodicExportingMetricReader,
)
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.sampling import TraceIdRatioBased
from opentelemetry.sdk.trace.export import (
    BatchSpanProcessor,
    SpanExportResult,
    SpanExporter,
)
from opentelemetry.trace import Tracer

from ..common.http_client import resolve_httpx_proxy


SignalName = Literal["traces", "metrics", "logs"]


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _count_metric_points(data: MetricsData) -> int:
    count = 0
    for resource_metrics in data.resource_metrics:
        for scope_metrics in resource_metrics.scope_metrics:
            for metric in scope_metrics.metrics:
                points = getattr(metric.data, "data_points", None)
                if points is not None:
                    count += len(points)
    return count


def _build_resource(
    *,
    service_name: str,
    service_version: str,
    service_instance_id: str,
) -> Resource:
    return Resource.create(
        {
            "service.name": service_name,
            "service.version": service_version,
            "service.instance.id": service_instance_id,
        }
    )


def _build_requests_session_for_endpoint(
    endpoint: str, *, intranet_server: bool
) -> requests.Session:
    session = requests.Session()
    session.trust_env = False
    proxy = resolve_httpx_proxy(endpoint, force_bypass=intranet_server)
    if proxy:
        session.proxies.update({"http": proxy, "https": proxy})
    return session


@dataclass
class _RuntimeCounters:
    dropped_spans: int = 0
    dropped_metrics: int = 0
    dropped_logs: int = 0
    exporter_state: str = "disabled"
    last_export_error: str | None = None


class _RuntimeState:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._counters = _RuntimeCounters()

    def snapshot(self) -> _RuntimeCounters:
        with self._lock:
            return _RuntimeCounters(
                dropped_spans=self._counters.dropped_spans,
                dropped_metrics=self._counters.dropped_metrics,
                dropped_logs=self._counters.dropped_logs,
                exporter_state=self._counters.exporter_state,
                last_export_error=self._counters.last_export_error,
            )

    def mark_configured(self) -> None:
        with self._lock:
            self._counters.exporter_state = "initialized"
            self._counters.last_export_error = None

    def mark_disabled(self) -> None:
        with self._lock:
            self._counters.exporter_state = "disabled"
            self._counters.last_export_error = None

    def mark_misconfigured(self, message: str) -> None:
        with self._lock:
            self._counters.exporter_state = "misconfigured"
            self._counters.last_export_error = message

    def record_success(self) -> None:
        with self._lock:
            self._counters.exporter_state = "healthy"
            self._counters.last_export_error = None

    def record_error(self, signal: SignalName, message: str, dropped: int) -> None:
        with self._lock:
            self._counters.exporter_state = "error"
            self._counters.last_export_error = f"{signal}: {message}"
            if signal == "traces":
                self._counters.dropped_spans += dropped
            elif signal == "metrics":
                self._counters.dropped_metrics += dropped
            else:
                self._counters.dropped_logs += dropped


@dataclass
class _LlmRequestMetrics:
    requests_total: Counter
    request_duration_ms: Histogram
    ttft_ms: Histogram
    decode_window_ms: Histogram
    decode_tps: Histogram
    prompt_tokens_total: Counter
    completion_tokens_total: Counter

    def record(
        self,
        *,
        source: str,
        model_id: str,
        stream: bool,
        status_code: int,
        duration_ms: int,
        prompt_tokens: int | None = None,
        completion_tokens: int | None = None,
        ttft_ms: int | None = None,
        decode_window_ms: int | None = None,
    ) -> None:
        attributes = {
            "source": source,
            "model": model_id,
            "stream": stream,
            "status_class": _status_class(status_code),
        }
        self.requests_total.add(1, attributes)
        self.request_duration_ms.record(duration_ms, attributes)
        if prompt_tokens is not None:
            self.prompt_tokens_total.add(prompt_tokens, attributes)
        if completion_tokens is not None:
            self.completion_tokens_total.add(completion_tokens, attributes)
        if ttft_ms is not None:
            self.ttft_ms.record(ttft_ms, attributes)
        if decode_window_ms is not None:
            self.decode_window_ms.record(decode_window_ms, attributes)
            if completion_tokens is not None and decode_window_ms > 0:
                self.decode_tps.record(
                    completion_tokens / (decode_window_ms / 1000.0),
                    attributes,
                )


def _status_class(status_code: int) -> str:
    if 200 <= status_code < 300:
        return "2xx"
    if 400 <= status_code < 500:
        return "4xx"
    if 500 <= status_code < 600:
        return "5xx"
    return "unknown"


class _TrackingSpanExporter(SpanExporter):
    def __init__(self, delegate: SpanExporter, state: _RuntimeState) -> None:
        self._delegate = delegate
        self._state = state

    def export(self, spans: Sequence[object]) -> SpanExportResult:
        try:
            result = self._delegate.export(spans)
        except Exception as exc:
            logger.error(
                "telemetry.export signal=traces state=error dropped_spans={} error_type={} error={}",
                len(spans),
                type(exc).__name__,
                str(exc)[:300],
            )
            self._state.record_error("traces", str(exc), len(spans))
            return SpanExportResult.FAILURE
        if result == SpanExportResult.SUCCESS:
            self._state.record_success()
        else:
            logger.warning(
                "telemetry.export signal=traces state=non_success dropped_spans={} result={}",
                len(spans),
                result,
            )
            self._state.record_error("traces", str(result), len(spans))
        return result

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        return self._delegate.force_flush(timeout_millis)

    def shutdown(self) -> None:
        self._delegate.shutdown()


class _TrackingMetricExporter(OTLPMetricExporter):
    def __init__(self, *args: Any, state: _RuntimeState, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._state = state

    def export(
        self, metrics_data: MetricsData, timeout_millis: float | None = 10000, **kwargs: Any
    ) -> MetricExportResult:
        points = _count_metric_points(metrics_data)
        try:
            result = cast(
                MetricExportResult,
                super().export(metrics_data, timeout_millis=timeout_millis, **kwargs),
            )
        except Exception as exc:
            logger.error(
                "telemetry.export signal=metrics state=error dropped_metrics={} error_type={} error={}",
                points,
                type(exc).__name__,
                str(exc)[:300],
            )
            self._state.record_error("metrics", str(exc), points)
            return MetricExportResult.FAILURE
        if result == MetricExportResult.SUCCESS:
            self._state.record_success()
        else:
            logger.warning(
                "telemetry.export signal=metrics state=non_success dropped_metrics={} result={}",
                points,
                result,
            )
            self._state.record_error("metrics", str(result), points)
        return result


class _TrackingLogExporter(LogRecordExporter):
    def __init__(self, delegate: OTLPLogExporter, state: _RuntimeState) -> None:
        self._delegate = delegate
        self._state = state

    def export(self, batch: Sequence[object]) -> LogRecordExportResult:
        try:
            result = self._delegate.export(batch)
        except Exception as exc:
            logger.error(
                "telemetry.export signal=logs state=error dropped_logs={} error_type={} error={}",
                len(batch),
                type(exc).__name__,
                str(exc)[:300],
            )
            self._state.record_error("logs", str(exc), len(batch))
            return LogRecordExportResult.FAILURE
        if result == LogRecordExportResult.SUCCESS:
            self._state.record_success()
        else:
            logger.warning(
                "telemetry.export signal=logs state=non_success dropped_logs={} result={}",
                len(batch),
                result,
            )
            self._state.record_error("logs", str(result), len(batch))
        return result

    def force_flush(self, timeout_millis: int = 10000) -> bool:
        return self._delegate.force_flush(timeout_millis)

    def shutdown(self) -> None:
        self._delegate.shutdown()


class TelemetryRuntime:
    def __init__(
        self,
        config: dict[str, object],
        *,
        service_name: str,
        service_version: str,
        service_instance_id: str,
    ) -> None:
        self._config = config
        self._service_name = service_name
        self._service_version = service_version
        self._service_instance_id = service_instance_id
        self._boot_at = _utc_now_iso()
        self._state = _RuntimeState()
        self._started = False
        self._tracer_provider: TracerProvider | None = None
        self._meter_provider: MeterProvider | None = None
        self._logger_provider: LoggerProvider | None = None
        self._tracer: Tracer | None = None
        self._meter: Meter | None = None
        self._logger = None
        self._test_counter: Counter | None = None
        self._llm_request_metrics: _LlmRequestMetrics | None = None

    def configure_process_env(self) -> None:
        exporter = self._nested_dict(self._config, "exporter")
        endpoint = exporter.get("endpoint")
        if isinstance(endpoint, str) and endpoint:
            os.environ["OTEL_EXPORTER_OTLP_ENDPOINT"] = endpoint.rstrip("/")
            return
        os.environ.pop("OTEL_EXPORTER_OTLP_ENDPOINT", None)

    def start(self) -> None:
        if self._started:
            return
        self._started = True
        logger.info("telemetry.runtime action=start")
        self._start_current_config()

    def reload(self, config: dict[str, object]) -> None:
        logger.info("telemetry.runtime action=reload")
        self.shutdown()
        self._config = config
        self._state = _RuntimeState()
        self._boot_at = _utc_now_iso()
        self.configure_process_env()
        self._started = True
        self._start_current_config()

    def _start_current_config(self) -> None:
        self._tracer_provider = None
        self._meter_provider = None
        self._logger_provider = None
        self._tracer = None
        self._meter = None
        self._logger = None
        self._test_counter = None
        self._llm_request_metrics = None

        if not bool(self._config.get("enabled", False)):
            logger.info("telemetry.runtime action=disabled reason=config_disabled")
            self._state.mark_disabled()
            return

        exporter = self._nested_dict(self._config, "exporter")
        endpoint = exporter.get("endpoint")
        if not isinstance(endpoint, str) or not endpoint:
            logger.warning(
                "telemetry.runtime action=misconfigured reason=missing_endpoint"
            )
            self._state.mark_misconfigured("telemetry enabled but exporter.endpoint is empty")
            return

        resource = _build_resource(
            service_name=self._service_name,
            service_version=self._service_version,
            service_instance_id=self._service_instance_id,
        )
        session = _build_requests_session_for_endpoint(
            endpoint,
            intranet_server=bool(exporter.get("intranet_server", False)),
        )
        self._state.mark_configured()

        traces_cfg = self._nested_dict(self._config, "traces")
        if bool(traces_cfg.get("enabled", False)):
            span_exporter = _TrackingSpanExporter(
                OTLPSpanExporter(session=session), self._state
            )
            provider = TracerProvider(
                resource=resource,
                sampler=TraceIdRatioBased(float(traces_cfg.get("sample_ratio", 1.0))),
            )
            provider.add_span_processor(BatchSpanProcessor(span_exporter))
            self._tracer_provider = provider
            self._tracer = provider.get_tracer("llmrouter_manager.telemetry")

        metrics_cfg = self._nested_dict(self._config, "metrics")
        if bool(metrics_cfg.get("enabled", False)):
            metric_exporter = _TrackingMetricExporter(session=session, state=self._state)
            export_interval_ms = int(metrics_cfg.get("export_interval_ms", 10000))
            reader = PeriodicExportingMetricReader(
                exporter=metric_exporter,
                export_interval_millis=export_interval_ms,
            )
            provider = MeterProvider(resource=resource, metric_readers=[reader])
            self._meter_provider = provider
            self._meter = provider.get_meter("llmrouter_manager.telemetry")
            self._test_counter = self._meter.create_counter(
                "superclaw_lrm_test_export_total"
            )
            self._llm_request_metrics = _LlmRequestMetrics(
                requests_total=self._meter.create_counter("sc_llm_requests_total"),
                request_duration_ms=self._meter.create_histogram(
                    "sc_llm_request_duration_ms"
                ),
                ttft_ms=self._meter.create_histogram("sc_llm_ttft_ms"),
                decode_window_ms=self._meter.create_histogram("sc_llm_decode_window_ms"),
                decode_tps=self._meter.create_histogram("sc_llm_decode_tps"),
                prompt_tokens_total=self._meter.create_counter(
                    "sc_llm_prompt_tokens_total"
                ),
                completion_tokens_total=self._meter.create_counter(
                    "sc_llm_completion_tokens_total"
                ),
            )

        logs_cfg = self._nested_dict(self._config, "logs")
        if bool(logs_cfg.get("enabled", False)):
            log_exporter = _TrackingLogExporter(
                OTLPLogExporter(session=session), self._state
            )
            provider = LoggerProvider(resource=resource)
            provider.add_log_record_processor(BatchLogRecordProcessor(log_exporter))
            self._logger_provider = provider
            self._logger = provider.get_logger("llmrouter_manager.telemetry")

        logger.info(
            "telemetry.runtime action=initialized endpoint={} intranet_server={} traces_enabled={} metrics_enabled={} logs_enabled={}",
            endpoint,
            bool(exporter.get("intranet_server", False)),
            bool(traces_cfg.get("enabled", False)),
            bool(metrics_cfg.get("enabled", False)),
            bool(logs_cfg.get("enabled", False)),
        )

    def shutdown(self) -> None:
        logger.info("telemetry.runtime action=shutdown")
        if self._logger_provider is not None:
            self._logger_provider.shutdown()
        if self._meter_provider is not None:
            self._meter_provider.shutdown()
        if self._tracer_provider is not None:
            self._tracer_provider.shutdown()
        self._logger_provider = None
        self._meter_provider = None
        self._tracer_provider = None
        self._tracer = None
        self._meter = None
        self._logger = None
        self._test_counter = None

    def status_snapshot(self, *, last_applied_at: str | None) -> dict[str, object]:
        counters = self._state.snapshot()
        enabled = bool(self._config.get("enabled", False))
        traces_cfg = self._nested_dict(self._config, "traces")
        metrics_cfg = self._nested_dict(self._config, "metrics")
        logs_cfg = self._nested_dict(self._config, "logs")
        return {
            "enabled": enabled,
            "effective": {
                "traces_enabled": enabled and bool(traces_cfg.get("enabled", False)),
                "metrics_enabled": enabled and bool(metrics_cfg.get("enabled", False)),
                "logs_enabled": enabled and bool(logs_cfg.get("enabled", False)),
            },
            "runtime": {
                "last_applied_at": last_applied_at,
                "last_restart_at": self._boot_at,
                "exporter_state": counters.exporter_state,
                "last_export_error": counters.last_export_error,
                "dropped_spans": counters.dropped_spans,
                "dropped_metrics": counters.dropped_metrics,
                "dropped_logs": counters.dropped_logs,
            },
        }

    def test_export(self, signals: list[SignalName]) -> dict[str, str]:
        if not bool(self._config.get("enabled", False)):
            raise RuntimeError("telemetry is disabled")

        results: dict[str, str] = {}
        for signal in signals:
            if signal == "traces":
                if self._tracer is None:
                    results[signal] = "disabled"
                    continue
                with self._tracer.start_as_current_span("llmrouter_manager.telemetry.test") as span:
                    span.set_attribute("superclaw.synthetic", True)
                    span.set_attribute("superclaw.signal", "traces")
                results[signal] = "sent"
                continue

            if signal == "metrics":
                if self._test_counter is None:
                    results[signal] = "disabled"
                    continue
                self._test_counter.add(
                    1,
                    {
                        "superclaw.synthetic": True,
                        "superclaw.signal": "metrics",
                    },
                )
                results[signal] = "sent"
                continue

            if self._logger is None:
                results[signal] = "disabled"
                continue
            self._logger.emit(
                severity_number=SeverityNumber.INFO,
                severity_text="INFO",
                body="llmrouter_manager synthetic telemetry test",
                attributes={
                    "superclaw.synthetic": True,
                    "superclaw.signal": "logs",
                },
            )
            results[signal] = "sent"

        self.force_flush(signals)
        return results

    def force_flush(self, signals: Sequence[SignalName] | None = None) -> bool:
        selected = set(signals or ["traces", "metrics", "logs"])
        logger.info(
            "telemetry.flush action=begin signals={}",
            sorted(selected),
        )
        ok = True
        if "traces" in selected and self._tracer_provider is not None:
            ok = self._tracer_provider.force_flush() and ok
        if "metrics" in selected and self._meter_provider is not None:
            ok = self._meter_provider.force_flush() and ok
        if "logs" in selected and self._logger_provider is not None:
            ok = self._logger_provider.force_flush() and ok
        if not ok:
            logger.warning("telemetry.flush action=end ok=0 signals={}", sorted(selected))
        else:
            logger.info("telemetry.flush action=end ok=1 signals={}", sorted(selected))
        return ok

    def get_tracer(self, scope_name: str) -> Tracer | None:
        if self._tracer_provider is None:
            return None
        return self._tracer_provider.get_tracer(scope_name)

    def record_llm_request_metrics(
        self,
        *,
        source: str,
        model_id: str,
        stream: bool,
        status_code: int,
        duration_ms: int,
        prompt_tokens: int | None = None,
        completion_tokens: int | None = None,
        ttft_ms: int | None = None,
        decode_window_ms: int | None = None,
    ) -> None:
        metrics = self._llm_request_metrics
        if metrics is None:
            return
        metrics.record(
            source=source,
            model_id=model_id,
            stream=stream,
            status_code=status_code,
            duration_ms=duration_ms,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            ttft_ms=ttft_ms,
            decode_window_ms=decode_window_ms,
        )

    @staticmethod
    def _nested_dict(config: dict[str, object], key: str) -> dict[str, object]:
        value = config.get(key)
        if isinstance(value, dict):
            return value
        return {}
