"""Text redaction route registration."""

from __future__ import annotations

import logging
import secrets
import uuid

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool

from common.errors import (
    EntityBudgetExceeded,
    InvalidCategory,
    SanitizeFailed,
    SanitizerUnavailable,
)
from protection_service.app_state import ProtectionAppState
from protection_service.io.session_utils import scope_session_id
from protection_service.schemas import (
    CategoriesResponse,
    CustomPiiLevelRequest,
    CustomPiiLevelResponse,
    ReplacementInfo,
    SanitizeRequest,
    SanitizeResponse,
)

logger = logging.getLogger(__name__)

PROCESS_CREDENTIAL_HEADER = "X-SuperClaw-Process-Credential"


def require_process_credential(request: Request) -> None:
    """Refuse a request that does not carry this service's ServiceHub process credential.

    Fails closed: with no credential configured (a standalone run) nothing matches, as in LLM Router
    and Sandbox Manager. A managed privacy_manager refuses to start without one.
    """
    expected = getattr(request.app.state, "process_credential", "")
    supplied = request.headers.get(PROCESS_CREDENTIAL_HEADER, "")
    # bytes: compare_digest raises TypeError on a str with non-ASCII characters, which would be a 500
    if not expected or not secrets.compare_digest(expected.encode(), supplied.encode()):
        raise HTTPException(status_code=403, detail="custom_level_forbidden")


def register_text_routes(app: FastAPI, state: ProtectionAppState) -> None:
    """Register ``/v1/text/*`` endpoints.

    Args:
        app: FastAPI application instance.
        state: App-scoped state.
    """
    config = state.config
    sanitize_mgr = state.sanitize_mgr
    auth_dep = state.auth_dep

    @app.post(
        "/v1/text/redact",
        response_model=SanitizeResponse,
        dependencies=[Depends(auth_dep)],
        tags=["text"],
    )
    async def redact_text(req: SanitizeRequest, http_req: Request) -> SanitizeResponse:
        """Redact sensitive entities from free-form text.

        Args:
            req: Text redaction request.
            http_req: HTTP request used to scope session ids.

        Returns:
            SanitizeResponse: Redacted text and replacement records.

        Raises:
            SanitizerUnavailable: If the sanitizer is not ready.
            PiiModelNotReady: If the PII model is not installed or NER did not load.
            InvalidCategory: If requested categories are invalid.
            SanitizeFailed: If sanitization fails unexpectedly.
        """
        # sensitivity_level=="none" bypass: return text unchanged. Checked
        # before wait_ready() so a true no-op request never triggers the
        # sanitizer's one-time cold load (see WS-A: lazy load, never unload).
        if req.sensitivity_level and req.sensitivity_level.strip().lower() in ("none", "no"):
            return SanitizeResponse(redacted=req.text, replacements={})

        ready = await run_in_threadpool(sanitize_mgr.wait_ready)
        if not ready and sanitize_mgr.sanitize_enabled:
            # Without a sanitizer there is no NER either.
            sanitize_mgr.require_ner_loaded()
        if not ready:
            raise SanitizerUnavailable(
                f"Sanitizer not initialized: {sanitize_mgr.degraded_reason or 'unknown reason'}"
            )

        # Fail closed: without NER this would mask regex and spaCy hits only.
        sanitize_mgr.require_ner_loaded()

        try:
            skip = sanitize_mgr.resolve_skip(
                sensitivity_level=req.sensitivity_level,
                skip_categories=req.skip_categories,
                custom_mask_categories=req.custom_mask_categories,
            )
        except ValueError as exc:
            raise InvalidCategory(str(exc)) from exc

        scoped_sid = scope_session_id(req.session_id, config, http_req)

        try:
            redacted, replacements = await run_in_threadpool(
                sanitize_mgr.sanitize,
                text=req.text,
                session_id=scoped_sid,
                custom_terms=req.custom_terms,
                skip_categories=skip,
                bucketize_financial=req.bucketize_financial,
            )
        except EntityBudgetExceeded:
            raise  # ServiceError -> handled by the global envelope handler (413)
        except RuntimeError as exc:
            raise SanitizerUnavailable(str(exc)) from exc
        except Exception as exc:
            # Do not log the exception text or stack: sanitizer failures can
            # include PII in exception args or frame locals.
            correlation_id = uuid.uuid4().hex[:12]
            logger.error(
                "Sanitization failed (correlation_id=%s exc_type=%s)",
                correlation_id, exc.__class__.__name__,
            )
            raise SanitizeFailed(
                f"Sanitization failed: {exc.__class__.__name__} "
                f"(correlation_id={correlation_id})"
            ) from exc

        return SanitizeResponse(
            redacted=redacted,
            replacements={
                k: ReplacementInfo(
                    original=v.original,
                    redacted=v.redacted,
                    type=v.type,
                    meta=v.meta,
                )
                for k, v in replacements.items()
            },
        )

    @app.get("/v1/text/categories", response_model=CategoriesResponse, tags=["text"])
    async def list_categories(_: None = Depends(auth_dep)) -> CategoriesResponse:
        """List supported text-redaction categories.

        Args:
            _: Auth dependency result, unused.

        Returns:
            CategoriesResponse: Supported category metadata.
        """
        return CategoriesResponse(**sanitize_mgr.categories())

    # Both checks are route dependencies, so they run before FastAPI validates the body. A well-formed
    # JSON body of the wrong shape gets 401 or 403, not 422; syntactically invalid JSON is still
    # rejected while the body is parsed, which happens before any dependency.
    @app.post(
        "/v1/text/custom-level",
        response_model=CustomPiiLevelResponse,
        dependencies=[Depends(auth_dep), Depends(require_process_credential)],
        tags=["text"],
    )
    async def set_custom_level(req: CustomPiiLevelRequest) -> CustomPiiLevelResponse:
        """Set a custom text-redaction PII level.

        This rewrites the global mask set, so it also needs the process credential: the data-plane
        key alone is in the runtime's environment, where a file_tool process could otherwise turn
        masking off for every caller (#3665).

        Args:
            req: Requested category mask configuration.

        Returns:
            CustomPiiLevelResponse: Applied custom level configuration.

        Raises:
            InvalidCategory: If requested categories are invalid.
        """
        try:
            result = sanitize_mgr.set_custom_level(req.mask_categories)
        except ValueError as exc:
            raise InvalidCategory(str(exc)) from exc
        return CustomPiiLevelResponse(**result)
