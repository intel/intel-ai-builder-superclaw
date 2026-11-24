"""LiteLLM auth bridge — project the DPAPI-encrypted OAuth session into the
plaintext ``auth.json`` that LiteLLM's ``chatgpt/`` provider reads.

This is the ONLY plaintext token on disk — a *derived cache*. The DPAPI master
(``state/oauth/openai.bin``) stays authoritative and encrypted. Because our
``refresh.ensure_fresh_token`` runs immediately before every projection, the
token we hand LiteLLM is always fresh with a truthful ``exp``, so LiteLLM never
triggers (a) its own refresh → plaintext writeback, or (b) its device-code login
→ headless hang. See the OAuth section (§7.8.1) + state-storage table in
``host/llmrouter_manager/README.md``.

Storage posture: the cache dir lives under ``%LOCALAPPDATA%`` (user-scoped NTFS
ACL by default), is NOT a cloud-synced path, and holds only a derived artifact
we regenerate per request and delete on logout. EFS on this dir is an optional
defense-in-depth step for at-rest coverage.
"""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

from ..common.state import default_state_root
from . import state as oauth_state
from .errors import SessionNotFound

_ENV_VAR = "CHATGPT_TOKEN_DIR"


def _restrict(path: Path, mode: int) -> None:
    """Best-effort tighten permissions on the derived plaintext cache.

    Defense-in-depth beyond the Windows NTFS user-scope ACL (the primary
    boundary): on POSIX this enforces owner-only (0o700 dir / 0o600 file);
    on Windows ``chmod`` is a near-noop, so failures are swallowed.
    """
    try:
        os.chmod(path, mode)
    except OSError:
        pass


def token_dir() -> Path:
    """Dedicated derived-cache dir for LiteLLM's chatgpt auth.json."""
    return default_state_root() / "litellm-chatgpt"


def configure_token_dir() -> Path:
    """Create the cache dir and point ``CHATGPT_TOKEN_DIR`` at it. Called at
    app startup so LiteLLM's Authenticator (constructed per request) reads our
    dir, never ``~/.config/litellm/chatgpt``."""
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


def project_auth_json(provider_id: str = "openai") -> Path:
    """Decrypt the DPAPI master session → write LiteLLM-format ``auth.json``.

    Returns the file path. Raises ``SessionNotFound`` if no session on disk.
    The caller MUST have just run ``refresh.ensure_fresh_token`` so
    ``expires_at`` is truthful (a fake future exp makes LiteLLM trust a dead
    token and 401 silently).
    """
    d = configure_token_dir()
    session = oauth_state.get(provider_id)
    if session is None:
        raise SessionNotFound(f"no oauth session for {provider_id!r}")
    record = {
        "access_token": session.get("access_token", ""),
        "refresh_token": session.get("refresh_token", ""),
        "id_token": session.get("id_token", ""),
        "expires_at": session.get("expires_at"),
        "account_id": session.get("account_hint"),
    }
    path = d / "auth.json"
    _atomic_write(path, json.dumps(record))
    return path


def clear_projected() -> bool:
    """Delete the derived plaintext ``auth.json``. Idempotent; True iff removed.
    Call on logout / session delete so the plaintext cache doesn't outlive the
    DPAPI master."""
    path = token_dir() / "auth.json"
    try:
        path.unlink()
        return True
    except FileNotFoundError:
        return False
