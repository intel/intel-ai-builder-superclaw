"""Tool-call hardening retry policy — bounded corrective re-dispatch.

Symmetric with ``retry.py`` but on a different axis. ``retry.py`` retries on a
transient HTTP status (429/503/529); this module retries on an application-level
signal: a weak model's malformed tool call that the pure layers in
``common.tools`` cannot repair locally (a hallucinated tool name, or no tool
call when one was needed). The structured correction is appended to
``messages`` and the request is re-dispatched upstream under a low budget. Never
mix the two axes (transient backoff vs semantic correction).
"""
from __future__ import annotations

from loguru import logger

from ...common.tools import (
    harden_nonstreaming_result,
    repair_nonstreaming_result_in_place,
)


def resolve_hardening_max_retries(
    arg_value: int | None,
    env_value: str | None,
    default: int = 1,
) -> int:
    """Precedence: arg -> ``LRM_TOOLCALL_HARDENING_MAX_RETRIES`` env -> default.

    Bounds the corrective re-dispatch loop. Keep it LOW (default 1): each retry
    is a full upstream round-trip, and a weak model that hallucinated once often
    hallucinates again, so a high budget just multiplies latency. ``<= 0``
    disables the loop (a single pass still repairs JSON/numbers/args in place;
    only the tool-name / no-tool re-dispatch is skipped). Invalid env warns +
    falls back. Mirrors ``retry.resolve_max_upstream_retries``.
    """
    if arg_value is not None:
        return max(0, int(arg_value))
    if env_value:
        try:
            return max(0, int(env_value))
        except ValueError:
            logger.warning(
                "invalid LRM_TOOLCALL_HARDENING_MAX_RETRIES={!r}, falling back to default ({})",
                env_value, default,
            )
    return default


def _final_repair(result: dict, tools: list | None, body: dict) -> None:
    """Run the B-stage in-place repairs on whatever result we ended up with."""
    choices = result.get("choices") if isinstance(result, dict) else None
    if isinstance(choices, list):
        repair_nonstreaming_result_in_place(choices, tools, body)


async def harden_with_retries(
    result: dict,
    body: dict,
    tools: list | None,
    redispatch,
    *,
    max_retries: int,
    requesting_agent: str | None = None,
) -> dict:
    """Harden a non-streaming result, re-dispatching upstream under a bounded
    budget when a layer cannot repair locally.

    ``redispatch`` is an ``async`` callable taking a request body and returning
    the next upstream result (the proxy injects a closure over its httpx/local
    dispatch). When ``harden_nonstreaming_result`` reports ``needs_retry`` (an
    invalid tool name, or an M3 no-tool refusal), the structured correction is
    appended to ``messages`` (and ``force_tool_choice`` pinned, when set) and the
    request is re-dispatched. When the budget runs out, a final B-stage in-place
    repair drops/repairs whatever remains and the best-effort result is returned
    (never an error, so the caller's normal error path stays in charge).
    
    ``requesting_agent`` enables agent-specific hardening behavior (e.g.
    protected-file-agent gets unconditional M3 retry for multi-tool workflows).
    """
    current_result = result
    current_body = body
    for attempt in range(max_retries + 1):
        outcome = harden_nonstreaming_result(
            current_result, tools, current_body, current_body.get("messages"),
            requesting_agent=requesting_agent
        )
        if not outcome.needs_retry:
            return outcome.result
        if attempt >= max_retries:
            _final_repair(current_result, tools, current_body)
            logger.info(
                "[tool-call-hardening] retry budget ({}) exhausted; applied final repairs",
                max_retries,
            )
            return current_result
        logger.info(
            "[tool-call-hardening] corrective re-dispatch {}/{}", attempt + 1, max_retries
        )
        current_body = {
            **current_body,
            "messages": [
                *(current_body.get("messages") or []),
                {"role": "system", "content": outcome.retry_message},
            ],
        }
        if outcome.force_tool_choice:
            current_body["tool_choice"] = outcome.force_tool_choice
        redispatched = await redispatch(current_body)
        if not isinstance(redispatched, dict):
            _final_repair(current_result, tools, current_body)
            return current_result
        current_result = redispatched
    return current_result
