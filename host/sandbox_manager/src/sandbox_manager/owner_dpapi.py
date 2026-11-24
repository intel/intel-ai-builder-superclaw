"""Owner-scope DPAPI sealing and an atomic file write, for the secrets the Sandbox Manager itself holds.

The seal is the calling account's own DPAPI scope, so a copy of a sealed file is useless to any other
account. These were the helpers of the Slack channel secret store, which the Windows-native-only
refactor removed; the Tavily key store (EG1-3, #12) is the one user of the seal now, and the v1 session
import also writes its attempt record with `atomic_write`.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path


def protect_for_owner(plaintext: bytes) -> bytes:
    import win32crypt

    return bytes(win32crypt.CryptProtectData(plaintext, "", None, None, None, 0))


def unprotect_for_owner(ciphertext: bytes) -> bytes:
    import win32crypt

    _description, plaintext = win32crypt.CryptUnprotectData(
        ciphertext, None, None, None, 0
    )
    return bytes(plaintext)


def atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(
        prefix=f"{path.name}.", suffix=".tmp", dir=str(path.parent)
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
