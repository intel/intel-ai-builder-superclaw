"""Shared accumulator for re-assembling a full answer out of streamed chunks.

Any streaming dispatch path that re-emits upstream SSE chunks untouched (so
the client sees them as they arrive) still needs the FULL assembled answer at
the end, purely for Langfuse tracing (the generation/trace output). This is
that accumulation logic, factored out so each streaming call site (cloud
LiteLLM, OAuth Copilot, OAuth Codex) doesn't re-implement its own copy.
"""

from __future__ import annotations

from typing import Any


def accumulate_stream_delta(
    chunk_dict: dict[str, Any],
    *,
    answer_parts: list[str],
    tool_call_parts: dict[int, dict[str, Any]],
) -> str | None:
    """Fold one streamed chat-completion chunk's ``delta`` into the running
    accumulators. Returns this chunk's ``finish_reason`` (usually ``None``
    until the last chunk).
    """
    choices = chunk_dict.get("choices") or [{}]
    delta = choices[0].get("delta") or {}
    delta_content = delta.get("content")
    if delta_content:
        answer_parts.append(delta_content)
    for tc in delta.get("tool_calls") or []:
        idx = tc.get("index", 0)
        slot = tool_call_parts.setdefault(idx, {"id": None, "name": None, "args": []})
        if tc.get("id"):
            slot["id"] = tc["id"]
        fn = tc.get("function") or {}
        if fn.get("name"):
            slot["name"] = fn["name"]
        if fn.get("arguments"):
            slot["args"].append(fn["arguments"])
    return choices[0].get("finish_reason")


def merged_tool_calls(tool_call_parts: dict[int, dict[str, Any]]) -> list[dict[str, Any]] | None:
    """Build the OpenAI-shaped ``tool_calls`` list from accumulated parts, or
    ``None`` when no tool call was streamed."""
    if not tool_call_parts:
        return None
    return [
        {
            "id": slot["id"] or "",
            "type": "function",
            "function": {"name": slot["name"] or "", "arguments": "".join(slot["args"])},
        }
        for _, slot in sorted(tool_call_parts.items())
    ]
