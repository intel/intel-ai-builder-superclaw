"""Lightweight, dependency-free exception types shared across layers.

Kept separate from ``sanitizer`` so the service layer (``server.py``)
can catch sanitizer-raised errors WITHOUT importing the heavy ML module
(which pulls numpy + spacy + onnxruntime at import time). Anything in here
must stay import-cheap: stdlib only.

Error envelope
--------------
Every error across both pipelines uses ONE structured envelope:

    {"detail": {"error": "<code>", "message": "<text>", ...extra}}

``ServiceError`` is the single carrier. A handler registered in
``server.py`` renders any ``ServiceError`` (and the ``HTTPException``
raised for FastAPI-native cases) into that shape. Raise a
``ServiceError`` anywhere — including from the sanitizer manager — and the
envelope is guaranteed consistent.
"""

from __future__ import annotations

from typing import Any


class ServiceError(Exception):
    """Base for all application errors that map to a structured HTTP body.

    Carries the HTTP status, a stable machine ``code``, a human
    ``message``, and optional ``extra`` fields merged into the ``detail``
    object (e.g. ``suggestions``, ``size_bytes``). The server's exception
    handler turns this into
    ``{"detail": {"error": code, "message": message, **extra}}``.
    """

    status_code: int = 400
    code: str = "error"

    def __init__(
        self,
        message: str,
        *,
        status_code: int | None = None,
        code: str | None = None,
        extra: dict[str, Any] | None = None,
    ) -> None:
        self.message = message
        if status_code is not None:
            self.status_code = status_code
        if code is not None:
            self.code = code
        self.extra: dict[str, Any] = extra or {}
        super().__init__(message)

    def to_detail(self) -> dict[str, Any]:
        """Render the ``detail`` payload for the HTTP response body."""
        return {"error": self.code, "message": self.message, **self.extra}


class EntityBudgetExceeded(ServiceError):
    """A single sanitize() call tried to register more NEW entities than
    its per-request budget (``sanitize.max_entities_per_request``) allows.

    Raised mid-call so peak in-call memory is bounded, not just the
    persistent session registry. Maps to HTTP 413 with code
    ``entity_budget_exceeded``.

    NB: subclasses ``ServiceError`` (not ``RuntimeError``) so the
    sanitizer manager's ``except RuntimeError`` arms never swallow it.
    """

    status_code = 413
    code = "entity_budget_exceeded"

    def __init__(self, budget: int) -> None:
        self.budget = budget
        super().__init__(
            f"single request exceeded max_entities_per_request={budget}; "
            "split the input into smaller chunks or raise the cap",
            extra={"budget": budget},
        )


class SanitizerUnavailable(ServiceError):
    """The text-sanitize pipeline is not ready (models missing, GPU driver,
    ``sanitize.enabled: false``, or a load failure). Maps to HTTP 503."""

    status_code = 503
    code = "sanitizer_unavailable"


class SanitizerWarmingUp(SanitizerUnavailable):
    """The sanitizer is still loading its models after start-up and did not
    finish within the request's wait. Maps to HTTP 503; retrying succeeds once
    the warm-up completes."""

    code = "sanitizer_warming_up"


class PiiModelNotReady(SanitizerUnavailable):
    """The PII model is still downloading, failed to download, is being
    activated, or is installed but NER did not load. Maps to HTTP 503:
    requests that need NER fail closed until NER is active."""

    code = "pii_model_not_ready"


class InvalidCategory(ServiceError):
    """A request named a PII category that doesn't exist after
    normalization. Maps to HTTP 400."""

    status_code = 400
    code = "invalid_category"


class SanitizeFailed(ServiceError):
    """An unexpected failure inside the sanitize pipeline. Maps to HTTP 500."""

    status_code = 500
    code = "sanitize_failed"


class RestoreFailed(ServiceError):
    """An unexpected failure inside rich-mode restore. Maps to HTTP 500."""

    status_code = 500
    code = "restore_failed"
