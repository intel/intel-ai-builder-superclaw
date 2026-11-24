"""PKCE helpers (RFC 7636 S256) + CSRF state token. Stdlib only."""

from __future__ import annotations

import base64
import hashlib
import secrets


def generate_verifier() -> str:
    """PKCE code_verifier: 43 chars, URL-safe base64 of 32 random bytes."""
    return base64.urlsafe_b64encode(secrets.token_bytes(32)).decode("ascii").rstrip("=")


def generate_challenge(verifier: str) -> str:
    """PKCE code_challenge (S256): base64url(sha256(verifier)), padding stripped."""
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


def generate_state() -> str:
    """CSRF state token: 64 hex chars (32 random bytes), independent of the verifier."""
    return secrets.token_hex(32)
