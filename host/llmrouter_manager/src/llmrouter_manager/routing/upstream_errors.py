"""Translate a non-200 local/edge upstream response into an OpenAI ``error`` object.

Pure: no I/O. Used by both the streaming and non-streaming dispatch paths in
``routing/proxy.py`` so the two deliver the same envelope.
"""

from __future__ import annotations

import json
from typing import Any


def upstream_error_object(
    body_text: str, status_code: int, model_id: str, source: str
) -> dict[str, Any]:
    """Return a classifiable ``error`` object for a non-200 upstream response.

    llama.cpp's hard context rejection (``exceed_context_size_error``) is
    authoritative: unlike the router's conservative request-size estimate, it
    proves the rendered prompt did not fit. Translate that shape into an
    actionable terminal error for both streaming and non-streaming clients.

    It is NOT translated to ``context_length_exceeded`` (opencode's
    compact-and-retry trigger). That would be the nicer outcome IF opencode
    classifies in-band SSE errors the same way it classifies an HTTP 400, but
    opencode's runtime is a pinned binary here and its provider/error.ts is not
    vendored, so that is unverified; guessing wrong trades a legible error for a
    silent compaction loop.

    An Edge 404 means the server no longer serves the saved model, e.g. after
    ``superclaw-ctl upgrade`` swapped Qwen3-Coder-Next for Qwen3.8-Flash-Next.
    The URL and model were probed at connect time, so the fix is to reconnect
    from Settings, which picks a trusted model the server serves.

    Every other status keeps its existing shape.
    """
    if "exceed_context_size_error" in body_text:
        detail = body_text.strip()
        try:
            parsed = json.loads(body_text)
            if isinstance(parsed, dict):
                error = parsed.get("error")
                if isinstance(error, dict):
                    message = error.get("message")
                    if isinstance(message, str) and message:
                        detail = message
        except (ValueError, TypeError):
            pass
        return {
            "message": (
                f"This conversation is larger than {model_id!r} can hold. Start "
                f"a new session, increase the model's context size in Settings, "
                f"or switch to a model with a larger context window. "
                f"(server: {detail[:200]})"
            ),
            "type": "invalid_request_error",
            "code": "context_overflow_unrecoverable",
        }
    if source == "edge" and status_code == 404:
        return {
            "message": (
                f"The Edge server no longer serves {model_id!r}. Reconnect in "
                f"Settings → Edge to pick a model it serves. "
                f"(server: {body_text.strip()[:200]})"
            ),
            "type": "invalid_request_error",
            "code": "edge_model_not_served",
        }
    return {
        "message": body_text[:500],
        "type": "upstream_error",
        "code": status_code,
    }
