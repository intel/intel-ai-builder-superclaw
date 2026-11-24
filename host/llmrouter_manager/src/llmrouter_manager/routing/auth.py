"""Authentication dependency for the LRM inference data plane."""

from __future__ import annotations

import secrets

from fastapi import Request
from fastapi.responses import JSONResponse

from ..common.errors import error_response


class InferenceAuthError(Exception):
    """Raised before a data-plane handler runs when bearer auth fails."""


def inference_auth_error_response(
    _request: Request, _exc: InferenceAuthError
) -> JSONResponse:
    return error_response(
        "invalid_inference_credential",
        "A valid LRM inference credential is required",
        status_code=401,
        headers={"WWW-Authenticate": "Bearer"},
    )


def _bearer(request: Request) -> str:
    scheme, _, supplied = request.headers.get("Authorization", "").partition(" ")
    if scheme.lower() != "bearer":
        return ""
    return supplied


def require_inference_key(request: Request) -> None:
    """Any data-plane caller: the shared key, or the host-only key.

    The host key is accepted here as well as on the privileged routes so a host
    service needs to carry exactly one credential. Treating it as a superset is
    what keeps the split invisible to every caller that does not need it.
    """
    expected = getattr(request.app.state, "inference_key", "")
    if not expected:
        raise RuntimeError("LRM inference key is not configured")
    host_expected = getattr(request.app.state, "host_inference_key", "") or expected

    supplied = _bearer(request)
    if not supplied:
        raise InferenceAuthError
    if secrets.compare_digest(expected, supplied):
        return
    if secrets.compare_digest(host_expected, supplied):
        return
    raise InferenceAuthError


def require_host_inference_key(request: Request) -> None:
    """A caller that is demonstrably NOT the sandbox.

    ServiceHub withholds the host key from the sandboxed agent (see
    ``common/inference_key.py``), so this is the only thing standing between
    agent-authored code and a route that names its own provider, model and
    usage label. The shared key is rejected here even though it is a valid
    data-plane credential -- that is the entire point.

    Deliberately NOT a distinction based on where the request came from: the
    sandboxed agent reaches LRM on ``127.0.0.1`` just as the host services do, so
    a loopback or source-address check fails open in exactly the configuration
    where it would need to hold.
    """
    expected = getattr(request.app.state, "host_inference_key", "")
    if not expected:
        # FAILS CLOSED, and this is the important line in the file. Falling back
        # to the shared key here would make a missing credential equivalent to
        # the pre-split behaviour -- the sandbox admitted again, by a missing env
        # var rather than by a decision, with nothing on screen or in the log to
        # say the boundary had stopped existing. A partial rollout, a dropped
        # env var or a stale ServiceHub must cost this route, not the user's
        # cloud credential.
        raise InferenceAuthError

    supplied = _bearer(request)
    if not supplied or not secrets.compare_digest(expected, supplied):
        raise InferenceAuthError
