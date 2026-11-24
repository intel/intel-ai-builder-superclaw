"""Best-effort repair of LLM-emitted JSON.

Weak models violate strict JSON in predictable but *varied* ways, and the exact
shape is not stable across models or runs:

  - wrap the object in a ```json / ``` (or bare ```` ``` ````) code fence
  - prefix prose ("Here is the JSON:") or suffix a trailing note
  - JSONC-style ``// ...`` line comments and ``/* ... */`` block comments
  - trailing commas before ``}`` / ``]``
  - BOM at start of payload
  - smart / fullwidth quotes around strings
  - missing commas between adjacent elements split by newlines
  - unquoted object keys (``{defects: []}``)
  - single-quoted strings (``{'defects': []}``)
  - truncation mid-object when the model hits its token budget

Rather than pattern-matching each specific shape (brittle — the next model
mangles it a *different* way), the strategy here is deliberately GENERAL and
non-destructive:

  1. ``loads_lenient`` tries strict ``json.loads`` FIRST. Well-formed JSON is
     returned untouched — none of the repairs below can ever affect it. This is
     the guarantee that hardening does not regress the pipeline's robustness.
  2. On failure it walks a *validated* repair ladder: it builds a sequence of
     increasingly aggressive candidate strings and returns the FIRST one that
     actually parses. A repair is only ever accepted when it produces valid
     JSON, so an over-eager transform (e.g. a naive single-quote swap that would
     corrupt an apostrophe) simply fails to parse and is skipped rather than
     returning a silently-wrong object.

The core general primitive is balanced-blob extraction: find the first ``{`` /
``[`` and scan to its matching close (respecting string literals and escapes).
That single step subsumes fence-stripping AND prose-stripping regardless of the
exact noise around the JSON, and it recovers truncated objects by closing the
brackets that were left open.
"""

from __future__ import annotations

import json
import re
from typing import Any

_BOM_RE = re.compile(r"^﻿")
_LINE_COMMENT_RE = re.compile(r"(?m)^\s*//.*$")
_BLOCK_COMMENT_RE = re.compile(r"/\*.*?\*/", re.DOTALL)
_TRAILING_COMMA_RE = re.compile(r",(\s*[}\]])")
_QUOTE_TRANSLATIONS = str.maketrans(
    {
        "“": '"',
        "”": '"',
        "„": '"',
        "‟": '"',
        "‘": "'",
        "’": "'",
        "＂": '"',
    },
)
# Insert a missing comma between `]` or `}` or `"` and a following
# `{` / `[` / `"` on a new line.
_MISSING_COMMA_RE = re.compile(r'(["\]\}])\s*\n(\s*)(["\{\[])')
# A bare identifier used as an object key: `{defects: ...}` / `, kind: ...`.
_UNQUOTED_KEY_RE = re.compile(r'([{,]\s*)([A-Za-z_$][A-Za-z0-9_$-]*)(\s*:)')

_OPEN_TO_CLOSE = {"{": "}", "[": "]"}


def _find_json_start(text: str) -> int:
    """Index of the first ``{`` or ``[``; -1 if none."""
    for i, ch in enumerate(text):
        if ch in "{[":
            return i
    return -1


def _scan_balanced(text: str, start: int) -> tuple[int, str]:
    """Scan a JSON value starting at ``text[start]`` (a ``{`` or ``[``).

    Returns ``(end, closers)`` where ``text[start:end]`` is the value and
    ``closers`` is the string of closing chars still needed if the value was
    truncated ("" when balanced). Respects string literals and backslash
    escapes so braces inside strings do not disturb the depth count.
    """
    stack: list[str] = []
    in_str = False
    esc = False
    i = start
    n = len(text)
    while i < n:
        ch = text[i]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
        elif ch == '"':
            in_str = True
        elif ch in _OPEN_TO_CLOSE:
            stack.append(_OPEN_TO_CLOSE[ch])
        elif ch in "}]":
            if stack and stack[-1] == ch:
                stack.pop()
                if not stack:
                    return i + 1, ""
            else:
                # Stray closer that does not match the open stack — stop here
                # and let the caller's parse attempt decide.
                break
        i += 1
    closers = ('"' if in_str else "") + "".join(reversed(stack))
    return n, closers


def _extract_json_blob(text: str) -> str:
    """Return the first balanced ``{...}`` / ``[...]`` substring.

    Strips any surrounding code fence, prose prefix, or trailing note in one
    general step. If no ``{``/``[`` is present the text is returned unchanged;
    if a blob starts but is truncated, everything from the first bracket to the
    end is returned (bracket-closing is handled separately on the ladder).
    """
    start = _find_json_start(text)
    if start < 0:
        return text
    end, closers = _scan_balanced(text, start)
    if closers:
        return text[start:]
    return text[start:end]


def _close_truncated(text: str) -> str | None:
    """Recover a truncated object by closing brackets left open at EOF.

    Returns the closed candidate, or ``None`` when the text is not truncated
    (nothing to close) or has no JSON start.
    """
    start = _find_json_start(text)
    if start < 0:
        return None
    end, closers = _scan_balanced(text, start)
    if not closers:
        return None
    blob = text[start:end]
    # A dangling ``, `` or a partial ``"key":`` with no value would break the
    # parse even after closing; drop a trailing comma and any dangling
    # ``"key":`` / bare token so the close lands on a complete value.
    blob = re.sub(r",\s*$", "", blob)
    blob = re.sub(r'"[^"\n]*"\s*:\s*$', "", blob)
    blob = re.sub(r",\s*$", "", blob)
    return blob + closers


def _quote_unquoted_keys(text: str) -> str:
    return _UNQUOTED_KEY_RE.sub(r'\1"\2"\3', text)


def _swap_single_quotes(text: str) -> str:
    return text.replace("'", '"')


def repair(text: str) -> str:
    """Conservative repair bundle: extraction + comments + commas + quotes.

    Applied only after strict parsing fails (via :func:`loads_lenient`), so it
    never touches already-valid JSON. Idempotent on an already-clean object.
    """
    cleaned = _BOM_RE.sub("", text)
    cleaned = _extract_json_blob(cleaned)
    cleaned = _BLOCK_COMMENT_RE.sub("", cleaned)
    cleaned = _LINE_COMMENT_RE.sub("", cleaned)
    cleaned = cleaned.translate(_QUOTE_TRANSLATIONS)
    cleaned = _TRAILING_COMMA_RE.sub(r"\1", cleaned)
    cleaned = _MISSING_COMMA_RE.sub(r"\1,\n\2\3", cleaned)
    return cleaned


def _candidates(text: str) -> list[str]:
    """Increasingly aggressive repair candidates, least-destructive first."""
    base = repair(text)
    out = [
        base,
        _quote_unquoted_keys(base),
        _swap_single_quotes(base),
        _quote_unquoted_keys(_swap_single_quotes(base)),
    ]
    closed = _close_truncated(text)
    if closed is not None:
        out.append(closed)
        out.append(_quote_unquoted_keys(closed))
        out.append(_quote_unquoted_keys(_swap_single_quotes(closed)))
    return out


def loads_lenient(text: str) -> Any:
    """Parse LLM JSON, tolerating the mangling weak models introduce.

    Strict JSON parses on the first attempt and is returned unchanged. On
    failure, each repair candidate is validated by an actual parse and the
    first that succeeds is returned; if none parse, the conservative repair's
    ``JSONDecodeError`` is raised so callers see a meaningful error.
    """
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    for candidate in _candidates(text):
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            continue
    # Nothing parsed — re-raise from the conservative repair for a clean error.
    return json.loads(repair(text))


__all__ = ["loads_lenient", "repair"]
