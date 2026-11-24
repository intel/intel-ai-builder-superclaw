"""OAuth exception taxonomy. Exceptions never carry token material; provider
error bodies are truncated at the raise site to bound leakage."""

from __future__ import annotations


class OAuthError(Exception):
    """Base class for oauth/* errors. Never instantiated directly."""


class OAuthProviderUnsupported(OAuthError):
    """Provider id is not one of the supported OAuth providers."""


class NoCallbackPort(OAuthError):
    """All ports in the configured callback range are in use."""


class ProviderRejected(OAuthError):
    """Token endpoint (authorization_code exchange) returned non-2xx.

    ``detail`` carries the truncated provider error body — never headers,
    cookies, or the code_verifier.
    """

    def __init__(self, *, http_status: int, detail: str) -> None:
        super().__init__(f"provider rejected token exchange (http {http_status})")
        self.http_status = http_status
        self.detail = detail[:500]


class RefreshRequired(OAuthError):
    """Refresh token is dead — the user must re-run the login flow. Caller
    surfaces HTTP 401 ``oauth_reauth_required``."""


class RefreshTransient(RefreshRequired):
    """Refresh failed for a transient reason (network error / provider 5xx), not
    a dead token. A retry may succeed, so callers surface HTTP 502 instead of
    401 and do NOT prompt re-login. Subclasses ``RefreshRequired`` so existing
    graceful-degradation handlers still treat oauth as temporarily unavailable."""


class SessionNotFound(OAuthError):
    """No OAuth session stored for the requested provider."""
