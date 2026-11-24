"""Token usage recording hook - writes to SQLite + publishes SSE deltas.

Called from all 4 dispatch call sites in the LRM proxy (cloud + local/edge
x stream/non-stream) after each completion returns. Silent no-op when no
UsageStore is set (early boot, tests that do not need persistence).

Behavior rules (design section 4.1):
- Records ONLY when response.usage is present and non-empty.
- Uses underlying model_id (never alias) as the aggregate PK.
- Token counts come from response.usage only (never inferred).
- Cost is caller-supplied (extracted from LiteLLM _hidden_params or
  computed via litellm.completion_cost); local/edge always 0.
"""

from __future__ import annotations

import time
import uuid
from typing import Any, Literal

from llmrouter_manager.common.usage_store import TokenEvent, UsageStore


Source = Literal["cloud", "local", "edge"]


# Module-level singleton set by app.py at startup via set_store().
# None until then -> record_usage silently no-ops.
_store: UsageStore | None = None


# Debouncer state (design section 7.3): one accumulator bucket per
# (underlying_model, provider, source). Single-thread access via the FastAPI
# event loop; no lock required.
_last_emit_ms: dict[tuple[str, str, str], int] = {}
_pending: dict[tuple[str, str, str], dict] = {}


def set_store(store: UsageStore | None) -> None:
    """Wire the module-level UsageStore. Called once at app startup.

    Pass ``None`` from test teardown to detach.
    """
    global _store
    _store = store


def record_usage(
    response: dict[str, Any] | None,
    source: Source,
    *,
    model_id: str | None,
    provider: str | None,
    alias: str | None = None,
    session_id: str | None = None,
    message_id: str | None = None,
    trace_id: str | None = None,
    response_cost_usd: float = 0.0,
    tool_calls: list[dict[str, Any]] | None = None,
) -> None:
    """Record token usage from a completed dispatch. See module docstring.

    ``tool_calls`` is the merged list a streaming caller accumulated; when
    omitted, the ids are read from ``response["choices"][*]["message"]``.
    """
    if _store is None or response is None or model_id is None:
        return
    usage = response.get("usage") or {}
    if not usage:
        return

    reasoning_tokens = _int_usage_field(usage, "reasoning_tokens")
    if reasoning_tokens == 0:
        reasoning_tokens = _int_usage_field(
            _dict_usage_field(usage, "completion_tokens_details"),
            "reasoning_tokens",
        )
    cache_read_input_tokens = _int_usage_field(usage, "cache_read_input_tokens")
    if cache_read_input_tokens == 0:
        cache_read_input_tokens = _int_usage_field(
            _dict_usage_field(usage, "prompt_tokens_details"),
            "cached_tokens",
        )
    cache_creation_input_tokens = _int_usage_field(usage, "cache_creation_input_tokens")

    event = TokenEvent(
        event_id=str(uuid.uuid4()),
        occurred_at=int(time.time() * 1000),
        session_id=session_id,
        message_id=message_id,
        source=source,
        provider=provider or source,  # aggregate PK requires non-null provider
        underlying_model=model_id,
        alias=alias,
        prompt_tokens=_int_usage_field(usage, "prompt_tokens"),
        completion_tokens=_int_usage_field(usage, "completion_tokens"),
        total_tokens=_int_usage_field(usage, "total_tokens"),
        reasoning_tokens=reasoning_tokens,
        cache_read_input_tokens=cache_read_input_tokens,
        cache_creation_input_tokens=cache_creation_input_tokens,
        cost_usd=float(response_cost_usd),
        trace_id=trace_id,
        tool_call_ids=_tool_call_ids(
            tool_calls if tool_calls is not None else _response_tool_calls(response)
        ),
    )
    _store.insert_event(event)
    _publish_token_usage_delta(event)


def _response_tool_calls(response: dict[str, Any]) -> list[Any]:
    calls: list[Any] = []
    choices = response.get("choices")
    if not isinstance(choices, list):
        return calls
    for choice in choices:
        message = choice.get("message") if isinstance(choice, dict) else None
        if isinstance(message, dict) and isinstance(message.get("tool_calls"), list):
            calls.extend(message["tool_calls"])
    return calls


def _tool_call_ids(tool_calls: list[Any]) -> tuple[str, ...]:
    ids: list[str] = []
    for call in tool_calls:
        call_id = call.get("id") if isinstance(call, dict) else None
        if isinstance(call_id, str) and call_id and call_id not in ids:
            ids.append(call_id)
    return tuple(ids)


def _dict_usage_field(usage: dict[str, Any], key: str) -> dict[str, Any]:
    value = usage.get(key)
    return value if isinstance(value, dict) else {}


def _int_usage_field(usage: dict[str, Any], key: str) -> int:
    value = usage.get(key)
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, (int, float, str)):
        try:
            return int(value)
        except (TypeError, ValueError):
            return 0
    return 0


def _publish_token_usage_delta(event: TokenEvent) -> None:
    """Emit an SSE ``token.usage.delta`` event, debounced <=1/sec per bucket.

    Accumulate the current event into ``_pending[key]``. If the last emission
    for this bucket was under 1 second ago, return (coalesced). Otherwise
    emit the accumulated delta, reset the bucket, and update ``_last_emit_ms``.

    Lazy import of ``publish_sse_event`` avoids the common/api <-> common/usage
    import cycle. See design section 7.3.
    """
    from llmrouter_manager.common.api import publish_sse_event

    key = (
        event.underlying_model,
        event.provider or event.source,
        event.source,
    )
    now_ms = int(time.time() * 1000)
    pending = _pending.setdefault(
        key, {"prompt": 0, "completion": 0, "cost": 0.0}
    )
    pending["prompt"] += event.prompt_tokens
    pending["completion"] += event.completion_tokens
    pending["cost"] += event.cost_usd
    last = _last_emit_ms.get(key, 0)
    if now_ms - last < 1000:
        return
    _last_emit_ms[key] = now_ms
    publish_sse_event(
        "token.usage.delta",
        {
            "occurred_at": now_ms,
            "underlying_model": event.underlying_model,
            "provider": event.provider or event.source,
            "source": event.source,
            "prompt_tokens_delta": pending["prompt"],
            "completion_tokens_delta": pending["completion"],
            "cost_usd_delta": pending["cost"],
        },
    )
    _pending[key] = {"prompt": 0, "completion": 0, "cost": 0.0}
