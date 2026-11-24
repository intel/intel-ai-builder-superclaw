"""LiteLLM auth bridge for GitHub Copilot — project the DPAPI-encrypted OAuth
session into the plaintext ``access-token`` file LiteLLM's ``github_copilot``
Authenticator reads.

We project the long-lived GitHub access token (atomically + non-empty) so
LiteLLM's ``get_access_token`` reads the file and never falls into its headless
device-code ``_login``; LiteLLM then derives the short-lived Copilot key itself.

Security: this is a LONG-LIVED ``gho_*`` token, and LiteLLM also writes
``api-key.json`` plaintext in the same dir. Both are disposable caches under
``%LOCALAPPDATA%`` (user-scoped ACL), deleted on logout; the DPAPI
``state/oauth/github_copilot.bin`` stays authoritative.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

from ..common.state import default_state_root
from . import state as oauth_state
from .errors import SessionNotFound

_ENV_VAR = "GITHUB_COPILOT_TOKEN_DIR"
_ACCESS_TOKEN_FILE = "access-token"
_API_KEY_FILE = "api-key.json"


def _restrict(path: Path, mode: int) -> None:
    try:
        os.chmod(path, mode)
    except OSError:
        pass


def token_dir() -> Path:
    return default_state_root() / "litellm-github-copilot"


def configure_token_dir() -> Path:
    """Create the cache dir and point ``GITHUB_COPILOT_TOKEN_DIR`` at it.

    Called at app startup so LiteLLM's per-request ``Authenticator`` reads our
    dir, never ``~/.config/litellm/github_copilot``.
    """
    d = token_dir()
    d.mkdir(parents=True, exist_ok=True)
    _restrict(d, 0o700)
    os.environ[_ENV_VAR] = str(d)
    return d


def _atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    _restrict(path.parent, 0o700)
    fd, tmp_name = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=str(path.parent))
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
        _restrict(path, 0o600)
    except BaseException:
        try:
            tmp.unlink()
        except FileNotFoundError:
            pass
        raise


def project_access_token(provider_id: str = "github_copilot") -> Path:
    """Decrypt the DPAPI session → atomically write LiteLLM's ``access-token``.

    Refuses to write an empty token: an empty/missing file is exactly what makes
    LiteLLM's ``get_access_token`` fall through to the device-code ``_login``, so
    a partial session must surface as ``SessionNotFound`` rather than a silent
    headless-login trap.
    """
    d = configure_token_dir()
    session = oauth_state.get(provider_id)
    if session is None:
        raise SessionNotFound(f"no oauth session for {provider_id!r}")
    access_token = session.get("access_token")
    if not isinstance(access_token, str) or not access_token:
        raise SessionNotFound(f"oauth session for {provider_id!r} is missing access_token")
    path = d / _ACCESS_TOKEN_FILE
    _atomic_write(path, access_token)
    return path


def clear_projected() -> bool:
    """Delete both derived plaintext files (``access-token`` + ``api-key.json``).

    Idempotent; True iff at least one file was removed. MUST NOT run while a
    dispatch is in flight — deleting ``access-token`` mid-request re-arms
    LiteLLM's ``_login``. The dispatch chokepoint serializes against this.
    """
    d = token_dir()
    removed = False
    for name in (_ACCESS_TOKEN_FILE, _API_KEY_FILE):
        try:
            (d / name).unlink()
            removed = True
        except FileNotFoundError:
            pass
    return removed
