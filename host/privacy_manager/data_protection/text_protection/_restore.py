"""Pure restore helper for the sanitizer.

Restoration needs only the replacements mapping — no instance state — so
it lives here as a free function. ``ConsistentSanitizer.restore`` is a
thin wrapper that handles the deprecated mirror-fallback warning before
delegating here.
"""

from __future__ import annotations

import logging
import re
from typing import Dict, List, Optional, TYPE_CHECKING


if TYPE_CHECKING:
    from text_protection.sanitizer import ReplacementRecord


logger = logging.getLogger(__name__)


_RESTORE_ITERATION_CAP = 5


def restore(
    text: str,
    replacements: Dict[str, "ReplacementRecord"],
    mode: str = "original",
) -> str:
    """Restore placeholders in text back to their original or redacted values.

    Sentence placeholders are expanded first since their ``redacted`` form
    may contain token-level placeholders. Token placeholders are then
    resolved iteratively to handle any nesting.

    Args:
        text: The placeholder-containing text to restore.
        replacements: Registry to restore against.
        mode: ``"original"`` to replace placeholders with original values,
            or ``"redacted"`` to expand sentence placeholders to their
            redacted form while keeping token placeholders in place.

    Raises:
        AssertionError: If ``mode`` is not ``"original"`` or ``"redacted"``.
    """
    assert mode in {"original", "redacted"}, "mode must be 'original' or 'redacted'"

    if not replacements:
        return text

    sentence_keys: List[str] = []
    token_keys: List[str] = []
    for k, v in replacements.items():
        if v.type == "sentence":
            sentence_keys.append(k)
        elif v.type == "token":
            token_keys.append(k)

    sentence_keys.sort(key=len, reverse=True)
    token_keys.sort(key=len, reverse=True)

    value_attr = "original" if mode == "original" else "redacted"

    def _make_pattern(keys: List[str]) -> Optional["re.Pattern[str]"]:
        if not keys:
            return None
        return re.compile("|".join(re.escape(k) for k in keys))

    def _sub(m: "re.Match[str]") -> str:
        rec = replacements[m.group(0)]
        return getattr(rec, value_attr)

    restored = text

    sentence_pat = _make_pattern(sentence_keys)
    if sentence_pat is not None:
        restored = sentence_pat.sub(_sub, restored)

    token_pat = _make_pattern(token_keys)
    if token_pat is not None:
        converged = False
        for _ in range(_RESTORE_ITERATION_CAP):
            prev = restored
            restored = token_pat.sub(_sub, restored)
            if restored == prev:
                converged = True
                break
        if not converged and token_pat.search(restored):
            logger.warning(
                "restore() hit %d-iteration cap with placeholders "
                "still present; output may contain unresolved "
                "<CATEGORY_N> tokens", _RESTORE_ITERATION_CAP,
            )

    return restored
