"""Inject ``[model-id] `` prefix into chat-completion responses.

**Disabled by default.** Set ``SUPERCLAW_LRM_MODEL_PREFIX=1`` to
re-enable. See "Why this is off by default" below.

Prefix format: ``"[<model_id>] "``. The trailing space is consumed by
the consumer-side ``stripModelPrefix()`` so the prefix does not render
in the chat UI but is still readable from raw part data.

Constraints imposed by the consumer regex ``^\\s*\\[([^\\]\\n]+)\\]``:
the captured token must have no whitespace, no ``]``, no ``\\n``, and
be at most 80 characters. Violating ids produce ``None`` from
``format_model_prefix`` and the caller skips injection -- consumers
then fall back to displaying the alias.

Why this is off by default
--------------------------
Injection was restored in #1177 for exactly one consumer: the UI's
``resolveAutoModelID()``, which read the prefix so the token-usage
"By Model" panel could show the model behind an alias (``auto`` /
``local-model`` / ``cloud-model``) instead of the alias itself.

That justification is gone:

* #1320 moved the UI panel onto LRM token-usage events, which carry
  ``underlying_model`` out of band (``apps/ui/src/app/lib/
  lrm-token-usage.ts`` reads ``event.underlying_model``).
  ``resolveAutoModelID`` now has no production caller.
* The concrete model was always available in band anyway, via the
  standard OpenAI ``model`` field that this service passes through
  untouched (see ``routing/proxy.py`` ``result.get("model")``).

Meanwhile the prefix imposed a real cost: seven independent stripper
implementations across ``apps/ui``, ``sandbox/channels``,
``tools/trajectory``, the HDR sidecar and the Gmail pipeline; this
module having to strip its own output back off assistant history
(#1189, compound-prefix echo); and one production break per JSON-only
tool contract that forgot to strip (#1719, email-agent prioritisation
returning ``Score=N/A``).

Provenance is cross-cutting metadata and belongs out of band. The
remaining consumer, the Slack/Telegram model footer, now resolves
``underlying_model`` from ``GET /llm-router/v1/usage/events``
(``sandbox/channels/src/lrm-usage.ts``) and only falls back to the
prefix when that lookup fails.

Note that ``sanitize_assistant_history`` stays unconditional: sessions
recorded while injection was on still carry prefixes in their history,
and leaving them in place lets upstream models echo them back.
"""

from __future__ import annotations

import json
import os
import re
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar


_MAX_TOKEN_LEN = 80

# Opt-in gate. Injection is off unless explicitly enabled.
_ENABLE_ENV_VAR = "SUPERCLAW_LRM_MODEL_PREFIX"
_TRUTHY = frozenset({"1", "true", "yes", "on"})

# Mirror of JS-side `stripModelPrefix` regex; token 2..80 chars, no ws/newline.
_STRIP_PREFIX_RE = re.compile(r"^\s*\[([^\]\s\n]{2,80})\]\s")
_DISTINCTIVE_CHARS = frozenset("-_./:0123456789")


_suppressed: ContextVar[bool] = ContextVar("model_prefix_suppressed", default=False)
"""Per-request opt-out of the ``[model-id] `` label.

WHY A CONTEXTVAR AND NOT A PARAMETER. The label is applied on three dispatch
paths -- the cloud dispatcher (pinned and the ``cloud-model`` alias) and the
local dispatcher (the ``local-model`` alias) -- and two of them live in
``routing/proxy.py``, which is already above the file-size ratchet's threshold
and therefore cannot grow. A context variable reaches all three through the one
function they already call.

Set per request by :func:`suppress_for_this_request`, which routes call instead
of :func:`suppressed_for_request` because a streaming response is read *after*
its handler returns -- see that function for why dropping the reset is both
necessary and safe. Either way it cannot reach an unrelated turn on the same
worker: each request runs in its own task, with its own copy of the context.
"""


@contextmanager
def suppressed_for_request() -> Iterator[None]:
    """Suppress the label for the duration of one request.

    For callers that insert the completion somewhere other than the chat UI --
    dictation clean-up puts it straight into the user's composer, and the chat
    UI's own ``stripModelPrefix`` is not there to take the label off again.

    Exempting here rather than trimming in the caller is deliberate: a
    downstream strip of a leading ``[...]`` cannot tell this label from text the
    user genuinely produced, e.g. a dictated "[note] call Ana back".
    """
    token = _suppressed.set(True)
    try:
        yield
    finally:
        _suppressed.reset(token)


def suppress_for_this_request() -> None:
    """Suppress the label for this request INCLUDING its response body.

    WHY NOT :func:`suppressed_for_request`. That is a context manager, and a
    streaming endpoint returns *before* its body runs: Starlette's
    ``request_response`` awaits ``response(scope, receive, send)`` after the
    handler has returned, so a ``with`` block wrapped around the handler has
    already reset the ContextVar by the time ``StreamingResponse`` iterates its
    generator -- and both streaming injection sites call
    :func:`format_model_prefix` from inside that generator
    (``routing/proxy.py``'s SSE loop and ``cloud/dispatch.py``'s). So with
    ``stream: true`` the label came back despite the opt-out, on the alias route
    and the pinned route alike. Raised by Copilot on superclaw#3027.

    NO RESET, AND THAT IS THE POINT. An ASGI server runs each request in its own
    task, and a task receives a *copy* of the context, so a ``set`` with no
    matching ``reset`` expires when that request's task does. There is nothing
    for it to leak into: the next request starts from its own copy, where the
    ``False`` default applies. That invariant is load-bearing rather than
    incidental -- it is the whole reason this can drop the ``with`` block -- so
    ``test_the_suppression_does_not_leak_to_the_next_request`` pins it directly
    instead of trusting it.

    :func:`suppressed_for_request` stays for callers that genuinely want a
    bounded block; the unit test of the injection sites is one.
    """
    _suppressed.set(True)


def is_injection_enabled() -> bool:
    """Return True when ``SUPERCLAW_LRM_MODEL_PREFIX`` opts injection in.

    Read from the environment on every call rather than cached at import
    time, so a restart is enough to flip it and tests can monkeypatch it.
    """
    return os.environ.get(_ENABLE_ENV_VAR, "").strip().lower() in _TRUTHY


def format_model_prefix(model_id: str) -> str | None:
    """Return ``"[<id>] "`` for a valid ``model_id``, else ``None``.

    Returns ``None`` when injection is disabled (the default), which
    makes every call site skip injection via its existing ``None``
    branch -- no separate opt-out path is needed.

    Also returns ``None`` while :func:`suppressed_for_request` is active. That
    is how a caller whose completion is not chat text opts out of the label on
    EVERY dispatch path at once -- the alias route's local and cloud branches
    both reach injection through this function, and `routing/proxy.py` is over
    `scripts/ci/file_size_ratchet.mjs`'s threshold, so it cannot grow to carry
    a parameter of its own.
    """
    if _suppressed.get():
        return None
    if not is_injection_enabled():
        return None
    if not isinstance(model_id, str):
        return None
    token = model_id.strip()
    if not token or len(token) > _MAX_TOKEN_LEN:
        return None
    if any(ch.isspace() for ch in token) or "]" in token or "\n" in token:
        return None
    return f"[{token}] "


def _prepend_to_content(
    container: object, node_key: str, prefix: str
) -> bool:
    """Mutate ``container["choices"][0][node_key]["content"]`` in place.

    Returns True when a non-empty string content was found and prefixed,
    False for any malformed shape or missing / non-string / empty content
    (tool-call-only responses have ``content=None`` -- injecting there
    would fabricate a text part).
    """
    if not isinstance(container, dict):
        return False
    choices = container.get("choices")
    if not isinstance(choices, list) or not choices:
        return False
    first = choices[0]
    if not isinstance(first, dict):
        return False
    node = first.get(node_key)
    if not isinstance(node, dict):
        return False
    content = node.get("content")
    if not isinstance(content, str) or not content:
        return False
    node["content"] = prefix + content
    return True


def inject_into_non_streaming_result(result: object, prefix: str) -> bool:
    """Prepend prefix to ``result["choices"][0]["message"]["content"]``."""
    return _prepend_to_content(result, "message", prefix)


def inject_into_streaming_chunk(chunk: object, prefix: str) -> bool:
    """Prepend prefix to ``chunk["choices"][0]["delta"]["content"]``."""
    return _prepend_to_content(chunk, "delta", prefix)


def inject_into_sse_bytes(chunk_bytes: bytes, prefix: str) -> bytes | None:
    """Rewrite the first content-bearing ``data:`` line to prepend ``prefix``.

    The caller MUST pass a complete SSE event (bytes terminated by
    ``\\n\\n`` or ``\\r\\n\\r\\n``). If a ``data:`` line is split across
    raw transport chunks, the caller must buffer those chunks together
    before calling -- retrying with only the next chunk cannot recover
    a split line. See ``routing/proxy.py::_stream`` for the buffering
    implementation.

    Returns modified event bytes on success. Returns ``None`` when the
    event has no injectable content (role-init, finish, tool_calls,
    malformed JSON, or a codepoint straddling the tail). All
    non-modified lines are preserved byte-for-byte, including trailing
    ``\\r`` on SSE wire endings.
    """
    try:
        text = chunk_bytes.decode("utf-8")
    except UnicodeDecodeError:
        return None
    lines = text.split("\n")
    for idx, line in enumerate(lines):
        stripped = line.rstrip("\r")
        if not stripped.startswith("data: "):
            continue
        payload = stripped[6:]
        if payload == "[DONE]":
            continue
        try:
            event = json.loads(payload)
        except (ValueError, TypeError):
            continue
        if not inject_into_streaming_chunk(event, prefix):
            continue
        new_payload = json.dumps(event, separators=(",", ":"), ensure_ascii=False)
        new_line = f"data: {new_payload}"
        if line.endswith("\r"):
            new_line += "\r"
        lines[idx] = new_line
        return "\n".join(lines).encode("utf-8")
    return None


def strip_model_prefix(text: str) -> str:
    """Strip leading ``[<model-id>] `` prefixes; loops for legacy compound
    history from before ``sanitize_assistant_history`` shipped. Only strips
    model-shaped tokens (letter + structural char / digit) so legitimate
    bracket prose (``[Note] ...``, ``[1] ...``) survives. Mirrors the JS
    ``stripModelPrefix`` in apps/ui, sandbox/channels, tools/trajectory.
    """
    result = text
    while True:
        match = _STRIP_PREFIX_RE.match(result)
        if match is None:
            return result
        token = match.group(1)
        has_letter = any("a" <= ch.lower() <= "z" for ch in token)
        has_distinctive = any(ch in _DISTINCTIVE_CHARS for ch in token)
        if not (has_letter and has_distinctive):
            return result
        result = result[match.end():]


def sanitize_assistant_history(messages: object) -> None:
    """Strip leading model prefixes from every assistant message IN PLACE.
    Breaks the feedback loop where opencode history contains prior
    LRM-injected ``[<model>] `` prefixes and the upstream LLM echoes them
    into new responses. Handles string content and content-block lists;
    non-assistant roles left untouched.
    """
    if not isinstance(messages, list):
        return
    for msg in messages:
        if not isinstance(msg, dict) or msg.get("role") != "assistant":
            continue
        content = msg.get("content")
        if isinstance(content, str):
            msg["content"] = strip_model_prefix(content)
        elif isinstance(content, list):
            for block in content:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "text":
                    text_val = block.get("text")
                    if isinstance(text_val, str):
                        block["text"] = strip_model_prefix(text_val)
