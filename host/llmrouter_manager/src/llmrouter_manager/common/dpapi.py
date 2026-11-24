"""Windows DPAPI user-scope wrapper.

Per R10 of the LLMRouter Manager redesign: CRYPTPROTECT_LOCAL_MACHINE is NOT
used; encryption is bound to the launching Windows user account. Runs on
Windows only — non-Windows callers get a RuntimeError so tests can skip
explicitly rather than silently no-oping a security primitive.
"""

from __future__ import annotations

import sys


def _require_windows() -> None:
    if sys.platform != "win32":
        raise RuntimeError(
            f"DPAPI is Windows-only (running on {sys.platform!r}). "
            "Skip DPAPI-backed tests on non-Windows hosts."
        )


def protect(plaintext: bytes) -> bytes:
    _require_windows()
    if not isinstance(plaintext, (bytes, bytearray)):
        raise TypeError(f"protect() expects bytes, got {type(plaintext).__name__}")
    import win32crypt

    blob = win32crypt.CryptProtectData(bytes(plaintext), "", None, None, None, 0)
    return bytes(blob)


def unprotect(ciphertext: bytes) -> bytes:
    _require_windows()
    if not isinstance(ciphertext, (bytes, bytearray)):
        raise TypeError(f"unprotect() expects bytes, got {type(ciphertext).__name__}")
    import win32crypt

    _description, plaintext = win32crypt.CryptUnprotectData(
        bytes(ciphertext), None, None, None, 0
    )
    return bytes(plaintext)
