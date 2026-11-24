"""Shared helper for emitting per-request LLM telemetry metrics.

Used by both ``cloud/dispatch.py`` and ``routing/proxy.py`` after each
completion (streaming or not) returns or fails, so the two call sites stay
in sync instead of drifting as separate copies.
"""

from __future__ import annotations

from typing import Any

from .usage import Source


def emit_llm_request_metrics(
    telemetry_runtime: Any | None,
    *,
    source: Source,
    model_id: str,
    stream: bool,
    status_code: int,
    duration_ms: int,
    prompt_tokens: int | None = None,
    completion_tokens: int | None = None,
    ttft_ms: int | None = None,
    decode_window_ms: int | None = None,
) -> None:
    recorder = getattr(telemetry_runtime, "record_llm_request_metrics", None)
    if recorder is None:
        return
    recorder(
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
