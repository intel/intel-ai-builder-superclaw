"""PII sanitize / restore hook seam — inert per #681.

The live PII layer is the `protected-file-*` agent chain, not this module.
The previous full sanitize/restore/nonce implementation had no callers in
`routing/proxy.py` or anywhere else in the package and was removed after
verification. The public API is preserved as a no-op stub so a future
revival can wire real behavior without touching call sites.

If restoring PII detection, revive the implementation behind an explicit
feature flag (e.g. `OPENWORK_PII_DETECTOR_URL`) and add tests covering
streaming SSE tool-call reconstruction, nonce lifecycle, and fail-open
semantics on detector outage.
"""

from __future__ import annotations

from typing import Any


def pii_sanitize(text: str) -> tuple[str, dict[str, Any]]:
    """Return (text, {}) — sanitization is disabled per #681."""
    return text, {}


def restore_text(text: str, nonces: dict[str, Any]) -> str:
    """Return text unchanged — restoration is disabled per #681."""
    return text
