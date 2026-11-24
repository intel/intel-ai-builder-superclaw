"""Request token counter for the context-cap guard.

Ported from ``D:/routing_service/sidecar.py`` (``_token_len`` /
``_request_token_len``). Prefers a vendored tokenizer.json (byte-exact for the
Qwen family that backs the local pool) when the router exposes one, else
tiktoken ``cl100k_base``, else a chars/4 heuristic. The counter is cached after
first use.

When callers omit ``tokenizer_file`` (the proxy hot path does), we resolve to
the package-vendored ``llmrouter_manager/data/tokenizer.json`` — the same Qwen
tokenizer routing_service ships next to its router. This keeps the context-cap
guard byte-exact against the serving model instead of falling back to tiktoken,
which under-counts multilingual/Qwen text and lets over-cap requests slip past.

Kept import-light: the ``tokenizers`` / ``tiktoken`` imports happen lazily inside
the builder so importing this module never drags them in.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Callable, Optional

from loguru import logger

# Package-vendored tokenizer.json path. Resolves at both dev-time (source tree)
# and runtime (PyInstaller _MEIPASS extraction), because ``data/`` is bundled
# via ``llmrouter_manager.spec`` datas. ``parents[2]`` climbs:
#   policy/ -> routing/ -> llmrouter_manager/
_DEFAULT_TOKENIZER_FILE = str(
    Path(__file__).resolve().parents[2] / "data" / "tokenizer.json"
)

_counter: Optional[Callable[[str], int]] = None

# Content-part types whose payload is a NON-TEXT modality — an inline base64
# data URL or a remote URL the upstream fetches. Such a part is rendered as a
# roughly FIXED number of modality tokens, so BOTH naive readings are wrong, in
# opposite and unsafe directions:
#
#   * counting the serialized block verbatim overestimates by ~3 orders of
#     magnitude (a 1 MB inline PNG reads as ~350k tokens against the ~1.1k the
#     server actually charges). On an ``auto`` request that fake overflow makes
#     the over-limit block ESCALATE to cloud (``proxy.py`` ``allow_escalate``) —
#     i.e. an attachment could push local work to cloud purely as a counting
#     artifact, which is the one failure the local-first guarantee cannot absorb;
#   * counting only the URL underestimates a remote image to ~15 tokens.
#
# ``file`` / ``input_file`` are deliberately NOT here: a document part can expand
# to arbitrarily many TEXT tokens upstream, so verbatim serialization (the
# over-count direction) stays the safe default for those.
_MODALITY_PART_TYPES = frozenset({
    "image",
    "image_url",
    "input_image",
    "audio",
    "input_audio",
})

# Flat per-part estimate for a modality part. Generous on purpose: a high-detail
# image tile costs ~1.1k tokens on the OpenAI vision models, so 2048 keeps the
# tally on the over-count side (consistent with the rest of this counter) while
# staying O(1) and bounded — the property that makes the fake-overflow escalation
# above impossible.
_MODALITY_PART_TOKENS = 2048


def _resolve_tokenizer_file(tokenizer_file: Optional[str]) -> Optional[str]:
    """Return the tokenizer path to use, preferring caller-supplied then vendored."""
    if tokenizer_file:
        return tokenizer_file
    if Path(_DEFAULT_TOKENIZER_FILE).exists():
        return _DEFAULT_TOKENIZER_FILE
    return None


def _build_counter(tokenizer_file: Optional[str]) -> Callable[[str], int]:
    """Build the best available token counter (called once, then cached)."""
    if tokenizer_file:
        try:
            from tokenizers import Tokenizer

            tk = Tokenizer.from_file(tokenizer_file)
            # The vendored tokenizer.json may carry truncation.max_length baked
            # in (authored for embedding inputs). For request-length measurement
            # we need the FULL count, so disable truncation up front — otherwise
            # every request over the cap reports as exactly max_length and the
            # guard never trips.
            tk.no_truncation()
            logger.info(
                "token counter: tokenizers.Tokenizer from {} (truncation disabled)",
                tokenizer_file,
            )
            return lambda s: len(tk.encode(s, add_special_tokens=False).ids)
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "failed to load {} via tokenizers ({}); falling back to tiktoken",
                tokenizer_file, exc,
            )
    try:
        import tiktoken

        enc = tiktoken.get_encoding("cl100k_base")
        logger.info("token counter: tiktoken cl100k_base")
        return lambda s: len(enc.encode(s, disallowed_special=()))
    except Exception:  # noqa: BLE001
        logger.warning("token counter: chars/4 heuristic (no tokenizer libs)")
        return lambda s: (len(s) + 3) // 4


def _token_len(text: str, tokenizer_file: Optional[str] = None) -> int:
    global _counter
    resolved = _resolve_tokenizer_file(tokenizer_file)
    if _counter is None or getattr(_token_len, "_tokenizer_file", None) != resolved:
        _counter = _build_counter(resolved)
        setattr(_token_len, "_tokenizer_file", resolved)
    try:
        return _counter(text)
    except Exception:  # noqa: BLE001
        return (len(text) + 3) // 4


def _serialized_token_len(obj: Any, tokenizer_file: Optional[str]) -> int:
    """Token length of an arbitrary structure, serialized.

    ``ensure_ascii=False`` is REQUIRED, not cosmetic. The default ``True`` escapes
    every non-ASCII codepoint to a 6-character ``\\uXXXX`` sequence BEFORE
    tokenization, so a CJK payload is measured at ~10x its real cost (measured
    against the vendored tokenizer: 1120 characters of Chinese in a ``tool_result``
    part → 520 tokens as text, 5341 with ``ensure_ascii=True``, 541 with it off).
    That over-count is not a harmless safety margin:

      * ``decide_over_limit`` compacts, and then ESCALATES an ``auto`` request to
        the cloud slot — the exact "local work leaves the box because of a counting
        artifact" failure ``_MODALITY_PART_TYPES`` above exists to prevent, just
        reached through text instead of an image;
      * ``resolve_output_ceiling`` subtracts this number from the window, so an
        inflated count collapses the per-turn output ceiling toward its floor and
        truncates the deliverable it was added to protect.

    The ``str()`` fallback matters for the opposite reason: dropping a block that
    failed to serialize would UNDER-count, and under-counting is the direction that
    lets the guard pass a prompt the upstream then rejects with
    ``exceed_context_size``.
    """
    try:
        return _token_len(json.dumps(obj, default=str, ensure_ascii=False), tokenizer_file)
    except Exception:  # noqa: BLE001
        return _token_len(str(obj), tokenizer_file)


def _part_token_len(part: Any, tokenizer_file: Optional[str]) -> int:
    """Token length of ONE content part.

    A text-shaped part counts its ``text``; a NON-TEXT modality part (image /
    audio) counts a flat :data:`_MODALITY_PART_TOKENS`; ANY OTHER shape
    (tool_result / tool-result / redacted / provider-specific block, or a bare
    string) is serialized whole so its payload is NOT dropped.

    This matters because a tool-heavy agent turn carries its bulk in tool-RESULT
    parts (file reads, sub-agent ``<task_result>``s), not in ``text`` parts. A
    counter that reads only ``part["text"]`` silently misses those — undercounting
    a ~100k-token prompt as ~32k, so the context-cap guard never compacts and the
    request hard-crashes the upstream with ``exceed_context_size``.

    A non-dict part is counted unless it is ``None``. Only ``None`` means "absent":
    a bare ``0`` or ``False`` is still rendered by the chat template, and treating
    every falsy value as empty would re-introduce the under-count this function
    exists to remove.
    """
    if not isinstance(part, dict):
        return 0 if part is None else _token_len(str(part), tokenizer_file)
    ptype = part.get("type")
    if ptype in ("text", "input_text", "output_text", None) and isinstance(part.get("text"), str):
        return _token_len(part["text"], tokenizer_file)
    if isinstance(ptype, str) and ptype.strip().lower() in _MODALITY_PART_TYPES:
        return _MODALITY_PART_TOKENS
    # Unknown/structured part (tool result, file part, etc.): count the whole
    # serialized block so nothing escapes the tally.
    return _serialized_token_len(part, tokenizer_file)


def request_token_len(payload: dict[str, Any], tokenizer_file: Optional[str] = None) -> int:
    """Token length of the WHOLE request the upstream will see.

    Sums message content (string, or EVERY content part incl. tool results),
    assistant ``tool_calls`` (name + arguments), ``tool_call_id`` / ``name``,
    tool/function schemas (re-tokenized by the upstream as part of the prompt),
    and a small per-message overhead.

    Counting the full message — not just ``text`` parts — is essential: a
    tool-heavy turn's bulk lives in tool-result parts and ``tool_calls``, which
    the upstream renders into the prompt and which a text-only tally would miss.
    """
    total = 0
    for m in payload.get("messages", []) or []:
        if not isinstance(m, dict):
            continue
        content = m.get("content", "")
        if isinstance(content, str):
            total += _token_len(content, tokenizer_file)
        elif isinstance(content, list):
            for part in content:
                total += _part_token_len(part, tokenizer_file)
        # Assistant tool-call payloads (function name + arguments JSON) are part
        # of the rendered prompt on the next turn but live OUTSIDE `content`.
        tool_calls = m.get("tool_calls")
        if isinstance(tool_calls, list):
            for tc in tool_calls:
                if isinstance(tc, dict):
                    total += _serialized_token_len(tc, tokenizer_file)
        # ``tool_call_id`` / ``name`` are rendered by the chat template wherever
        # they appear (``tool_call_id`` on a tool-role reply; ``name`` also on a
        # named user/assistant message), so they are tallied for every role.
        for key in ("tool_call_id", "name"):
            value = m.get(key)
            if isinstance(value, str) and value:
                total += _token_len(value, tokenizer_file)
        # ~4 tokens of role/formatting overhead per message.
        total += 4
    tools = payload.get("tools") or payload.get("functions")
    if tools:
        # Same helper as the parts/tool_calls sites above, for both of its
        # properties: no ASCII escaping (a non-ASCII tool description would
        # otherwise measure ~10x) and no silent drop on a serialization failure.
        total += _serialized_token_len(tools, tokenizer_file)
    return total


def _reset_counter_for_tests() -> None:
    """Clear the cached counter (test hook only)."""
    global _counter
    _counter = None
