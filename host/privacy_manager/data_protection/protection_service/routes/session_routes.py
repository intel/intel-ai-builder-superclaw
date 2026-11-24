"""Session query-rewrite and response-restore route registration."""

from __future__ import annotations

import hashlib
import logging

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool

from file_protection.rewrite import rewrite_query

from protection_service.app_state import ProtectionAppState
from protection_service.io.registry_delivery import (
    load_placeholder_registry,
    restore_text_from_registry,
)
from protection_service.io.session_utils import scope_session_id
from protection_service.schemas import (
    QueryRewriteRequest,
    QueryRewriteResponse,
    SessionRestoreRequest,
    SessionRestoreResponse,
)

logger = logging.getLogger(__name__)


def register_session_routes(app: FastAPI, state: ProtectionAppState) -> None:
    """Register ``/v1/session/*`` endpoints.

    Args:
        app: FastAPI application instance.
        state: App-scoped state.
    """
    config = state.config
    pii_registry_store = state.pii_registry_store
    auth_dep = state.auth_dep

    @app.post(
        "/v1/session/query/rewrite",
        response_model=QueryRewriteResponse,
        dependencies=[Depends(auth_dep)],
        tags=["session"],
        summary="Replace real entity values in a user query with their PII placeholders.",
    )
    async def session_query_rewrite(
        req: QueryRewriteRequest, http_req: Request,
    ) -> QueryRewriteResponse:
        """Rewrite a query by replacing real values with PII placeholders.

        Args:
            req: Query rewrite request.
            http_req: HTTP request used to scope session ids.

        Returns:
            QueryRewriteResponse: Rewritten query and substitution count.

        Raises:
            HTTPException: If no matching operation or registry exists.
        """
        scoped_sid = scope_session_id(req.session_id, config, http_req)
        record = (
            pii_registry_store.get_operation(scoped_sid, req.operation_id)
            if req.operation_id
            else pii_registry_store.get_latest_operation(scoped_sid, pipeline="file")
        )
        logger.info(
            "data_protection endpoint=session.query_rewrite step=lookup "
            "operation_id=%s explicit_op=%s found=%s registry_path_set=%s",
            req.operation_id or "none",
            bool(req.operation_id),
            record is not None,
            bool(record and record.registry_path),
        )
        if record is None:
            raise HTTPException(
                status_code=404,
                detail={
                    "error": "operation_not_found",
                    "message": "No matching PII operation found for this session.",
                },
            )
        if record.registry_path is None:
            # No registry (e.g. mode=none or LLM pipeline without registry path).
            logger.info(
                "data_protection endpoint=session.query_rewrite step=completed "
                "operation_id=%s substitutions=0 reason=no_registry",
                req.operation_id or "none",
            )
            return QueryRewriteResponse(rewritten_query=req.query, substitutions=0)
        try:
            registry = await run_in_threadpool(load_placeholder_registry, record.registry_path)
            logger.info(
                "data_protection endpoint=session.query_rewrite step=registry_loaded "
                "operation_id=%s keys=%s",
                req.operation_id or "none", len(registry),
            )
        except (FileNotFoundError, ValueError) as exc:
            logger.warning(
                "data_protection endpoint=session.query_rewrite step=registry_load_failed "
                "operation_id=%s exc_type=%s exc=%s",
                req.operation_id or "none", exc.__class__.__name__, str(exc)[:200],
            )
            raise HTTPException(
                status_code=404,
                detail={
                    "error": "registry_expired",
                    "message": "Registry file has expired or been removed.",
                },
            )
        result = rewrite_query(
            req.query,
            registry,
            fuzzy_enabled=config.redact.query_rewrite_fuzzy_enabled,
            fuzzy_threshold=config.redact.query_rewrite_fuzzy_threshold,
        )
        logger.info(
            "data_protection endpoint=session.query_rewrite step=completed "
            "operation_id=%s substitutions=%s fuzzy_enabled=%s",
            req.operation_id or "none", result.substitutions,
            config.redact.query_rewrite_fuzzy_enabled,
        )
        return QueryRewriteResponse(
            rewritten_query=result.rewritten,
            substitutions=result.substitutions,
        )

    @app.post(
        "/v1/session/response/restore",
        response_model=SessionRestoreResponse,
        dependencies=[Depends(auth_dep)],
        tags=["session"],
        summary="Restore PII placeholders in an agent response back to real values.",
    )
    async def session_response_restore(
        req: SessionRestoreRequest, http_req: Request,
    ) -> SessionRestoreResponse:
        """Restore PII placeholders in an agent response for user display.

        Args:
            req: Response restore request.
            http_req: HTTP request used to scope session ids.

        Returns:
            SessionRestoreResponse: Restored response and replacement counts.

        Raises:
            HTTPException: If no matching operation or registry exists.
        """
        scoped_sid = scope_session_id(req.session_id, config, http_req)
        record = (
            pii_registry_store.get_operation(scoped_sid, req.operation_id)
            if req.operation_id
            else pii_registry_store.get_latest_operation(scoped_sid, pipeline="file")
        )
        logger.info(
            "data_protection endpoint=session.response_restore step=lookup "
            "operation_id=%s explicit_op=%s found=%s registry_path_set=%s",
            req.operation_id or "none",
            bool(req.operation_id),
            record is not None,
            bool(record and record.registry_path),
        )
        if record is None:
            raise HTTPException(
                status_code=404,
                detail={
                    "error": "operation_not_found",
                    "message": "No matching PII operation found for this session.",
                },
            )
        if record.registry_path is None:
            # No registry — return text unchanged.
            logger.info(
                "data_protection endpoint=session.response_restore step=completed "
                "operation_id=%s substitutions=0 reason=no_registry",
                req.operation_id or "none",
            )
            return SessionRestoreResponse(final_text=req.text, replacements=0)
        try:
            registry = await run_in_threadpool(load_placeholder_registry, record.registry_path)
            logger.info(
                "data_protection endpoint=session.response_restore step=registry_loaded "
                "operation_id=%s keys=%s",
                req.operation_id or "none", len(registry),
            )
        except (FileNotFoundError, ValueError) as exc:
            logger.warning(
                "data_protection endpoint=session.response_restore step=registry_load_failed "
                "operation_id=%s exc_type=%s exc=%s",
                req.operation_id or "none", exc.__class__.__name__, str(exc)[:200],
            )
            raise HTTPException(
                status_code=404,
                detail={
                    "error": "registry_expired",
                    "message": "Registry file has expired or been removed.",
                },
            )
        
        # Log the masked text shape only; the value itself carries PII placeholders,
        # and after restore below it carries the raw PII values — never write either.
        logger.info(
            "data_protection endpoint=session.response_restore step=before_restore "
            "operation_id=%s text_length=%d text_sha256_12=%s",
            req.operation_id or "none",
            len(req.text),
            hashlib.sha256(req.text.encode("utf-8", errors="replace")).hexdigest()[:12],
        )

        restored_text, restored_count, restored_unmatched = await run_in_threadpool(
            restore_text_from_registry, req.text, registry
        )
        logger.info(
            "data_protection endpoint=session.response_restore step=completed "
            "operation_id=%s substitutions=%s unmatched=%s",
            req.operation_id or "none", restored_count, len(restored_unmatched),
        )

        # After restore, `restored_text` contains the raw PII values that the
        # data-protection service exists to keep out of logs. Emit shape only.
        logger.info(
            "data_protection endpoint=session.response_restore step=after_restore "
            "operation_id=%s text_length=%d text_sha256_12=%s",
            req.operation_id or "none",
            len(restored_text),
            hashlib.sha256(restored_text.encode("utf-8", errors="replace")).hexdigest()[:12],
        )

        return SessionRestoreResponse(
            final_text=restored_text,
            replacements=restored_count,
            unmatched_placeholders=restored_unmatched,
        )
