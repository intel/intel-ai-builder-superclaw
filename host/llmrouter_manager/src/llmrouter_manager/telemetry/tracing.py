"""Small tracing helpers for low-intrusion LRM instrumentation."""

from __future__ import annotations

from collections.abc import Mapping
from contextlib import contextmanager
import hashlib
import secrets
from typing import Any, Iterator

from fastapi import Request
from opentelemetry import trace
from opentelemetry.context import Context
from opentelemetry.trace import (
    NonRecordingSpan,
    Span,
    SpanContext,
    Status,
    StatusCode,
    TraceFlags,
    TraceState,
    Tracer,
)



def get_telemetry_tracer(request: Request, scope_name: str) -> Tracer | None:
    runtime = getattr(request.app.state, "telemetry_runtime", None)
    if runtime is None or not hasattr(runtime, "get_tracer"):
        return None
    tracer = runtime.get_tracer(scope_name)
    if tracer is None:
        return None
    return tracer


def derive_trace_id_from_session_id(session_id: str) -> int | None:
    _session_id = session_id.strip()
    if not _session_id:
        return None
    digest = hashlib.sha256(_session_id.encode("utf-8")).digest()
    trace_id = int.from_bytes(digest[:16], "big")
    return trace_id or 1


def root_context_from_session(session_id: str) -> Context | None:
    trace_id = derive_trace_id_from_session_id(session_id)
    if trace_id is None:
        return None
    span_id = secrets.randbits(64) or 1
    span_context = SpanContext(
        trace_id=trace_id,
        span_id=span_id,
        is_remote=True,
        trace_flags=TraceFlags(TraceFlags.SAMPLED),
        trace_state=TraceState(),
    )
    return trace.set_span_in_context(NonRecordingSpan(span_context))


def child_context(parent_span: Span | None, fallback: Context | None = None) -> Context | None:
    if parent_span is None:
        return fallback
    return trace.set_span_in_context(parent_span, fallback)


def start_span(
    tracer: Tracer | None,
    name: str,
    *,
    context: Context | None = None,
    attributes: Mapping[str, Any] | None = None,
) -> Span | None:
    if tracer is None:
        return None
    span = tracer.start_span(name, context=context)
    if attributes:
        set_attributes(span, attributes)
    return span


def set_attributes(span: Span | None, attributes: Mapping[str, Any]) -> None:
    if span is None:
        return
    for key, value in attributes.items():
        if value is None:
            continue
        if isinstance(value, (bool, int, float, str)):
            span.set_attribute(key, value)


def add_event(
    span: Span | None,
    name: str,
    attributes: Mapping[str, Any] | None = None,
) -> None:
    if span is None:
        return
    if attributes is None:
        span.add_event(name)
        return
    safe_attributes: dict[str, bool | int | float | str] = {}
    for key, value in attributes.items():
        if isinstance(value, (bool, int, float, str)):
            safe_attributes[key] = value
    span.add_event(name, safe_attributes)


def mark_error(span: Span | None, message: str) -> None:
    if span is None:
        return
    span.set_status(Status(StatusCode.ERROR, message))


def record_exception(span: Span | None, exc: BaseException) -> None:
    if span is None:
        return
    span.record_exception(exc)
    mark_error(span, type(exc).__name__)


def end_span(span: Span | None) -> None:
    if span is None:
        return
    span.end()


@contextmanager
def span_scope(
    tracer: Tracer | None,
    name: str,
    *,
    context: Context | None = None,
    attributes: Mapping[str, Any] | None = None,
) -> Iterator[Span | None]:
    span = start_span(tracer, name, context=context, attributes=attributes)
    try:
        with use_span(span):
            yield span
    except Exception as exc:
        record_exception(span, exc)
        raise
    finally:
        end_span(span)


@contextmanager
def use_span(span: Span | None) -> Iterator[None]:
    if span is None:
        yield
        return
    with trace.use_span(span, end_on_exit=False):
        yield
