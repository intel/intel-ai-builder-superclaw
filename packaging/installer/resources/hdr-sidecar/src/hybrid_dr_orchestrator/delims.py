"""Shared delimiter normalization for weak-model output parsing.

Weak on-device models routinely mangle the ``===KEYWORD===`` delimiters the HDR
node parsers rely on: they drop the leading ``===``, pad to ``====KEYWORD====``,
underscore-prefix (``_KEYWORD===``), space the rails (``== KEYWORD ==``), or
lowercase. Every such variant slips past the strict per-node regex and the
``re.sub(r"===\\s*KEYWORD\\s*===", "")`` fallback, leaking a stray delimiter
fragment into the parsed content (the same class of bug found in polish.py for
issue #1633, confirmed present in section_write / fill / conclusion by the
node-parser probe).

``normalize_delims`` rewrites any delimiter-shaped LINE to its canonical form
BEFORE parsing, so mangled output parses identically to well-formed output.
"""
from __future__ import annotations

import re

__all__ = ["normalize_delims"]


def _keyword_regex(keyword: str) -> str:
    # Allow spaces or underscores between the words of a multi-word keyword
    # (e.g. "EXECUTIVE_CONTENT" also matches "EXECUTIVE CONTENT").
    parts = re.split(r"[_ ]+", keyword)
    return r"[ _]?".join(re.escape(p) for p in parts)


def normalize_delims(text: str, keywords) -> str:
    """Rewrite mangled/partial ``===KEYWORD===`` delimiter LINES to canonical.

    ``keywords`` is an iterable of delimiter keywords (e.g. ["SECTION", "END"]).
    Pass more-specific keywords first when any keyword is a substring of another
    so the specific one wins (e.g. "GAP_CONTENT" before "CONTENT").
    """
    for kw in keywords:
        pattern = re.compile(
            r"^[ \t]*[=_]*[ \t]*" + _keyword_regex(kw) + r"[ \t]*=+[ \t]*$",
            re.IGNORECASE | re.MULTILINE,
        )
        text = pattern.sub("===" + kw.upper() + "===", text)
    return text
