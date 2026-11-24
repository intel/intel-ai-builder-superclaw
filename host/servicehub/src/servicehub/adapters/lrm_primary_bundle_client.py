"""Typed B4 client for the narrow primary-bundle lifecycle."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
import json

from contracts.primary_bundle_abort_request import PrimaryBundleAbortRequest
from contracts.primary_bundle_abort_response import PrimaryBundleAbortResponse
from contracts.primary_bundle_commit_request import PrimaryBundleCommitRequest
from contracts.primary_bundle_commit_response import PrimaryBundleCommitResponse
from contracts.primary_bundle_lifecycle_readback import PrimaryBundleLifecycleReadback
from contracts.primary_bundle_prepare_request import PrimaryBundlePrepareRequest
from contracts.primary_bundle_prepare_response import PrimaryBundlePrepareResponse
from contracts.primary_bundle_release_request import PrimaryBundleReleaseRequest
from contracts.primary_bundle_release_response import PrimaryBundleReleaseResponse
from contracts.prepared_model_binding import PreparedModelBinding
import httpx
from loguru import logger
from pydantic import BaseModel, ValidationError

from servicehub.adapters.lrm_bundle_client import (
    _MAX_RESPONSE_BYTES,
    LrmCredentialSupplier,
    _credential_headers,
    _read_response,
)
from servicehub.proxy.client_config import default_httpx_limits
from servicehub.supervisor.registry import ServiceInfo

_REQUEST_DEADLINE_S = 15.0
# Local commit may load a candidate and restore the previous worker on failure.
_COMMIT_REQUEST_DEADLINE_S = 660.0
_B4_ERROR_CODES = frozenset({
    "lrm_bundle_revision_conflict",
    "bundle_candidate_changed",
    "download_confirmation_required",
    "connect_intent_required",
    "idempotency_conflict",
    "preparation_recovery_required",
    "pending_bundle_recovery_required",
    "preparation_identity_mismatch",
    "primary_bundle_prepare_in_progress",
    "pending_bundle_conflict",
    "disconnect_not_available",
})


@dataclass(frozen=True)
class LrmPrimaryBundleSuccess:
    payload: PrimaryBundlePrepareResponse | PrimaryBundleLifecycleReadback | PrimaryBundleAbortResponse | PrimaryBundleCommitResponse | PreparedModelBinding | PrimaryBundleReleaseResponse


@dataclass(frozen=True)
class LrmPrimaryBundleFailure:
    code: str
    expected_bundle_revision: int | None = None
    actual_bundle_revision: int | None = None


LrmPrimaryBundleResult = LrmPrimaryBundleSuccess | LrmPrimaryBundleFailure


class LrmPrimaryBundleClient:
    """Own B4 transport without forwarding App credentials or raw errors."""

    def __init__(
        self,
        client: httpx.AsyncClient | None = None,
        *,
        credential_supplier: LrmCredentialSupplier = lambda _service: None,
    ) -> None:
        self._owns_client = client is None
        self._client = client or httpx.AsyncClient(
            trust_env=False,
            timeout=httpx.Timeout(connect=2.0, read=30.0, write=10.0, pool=5.0),
            limits=default_httpx_limits(),
        )
        self._credential_supplier = credential_supplier

    def set_credential_supplier(self, supplier: LrmCredentialSupplier) -> None:
        self._credential_supplier = supplier

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def prepare(self, service: ServiceInfo, command: PrimaryBundlePrepareRequest) -> LrmPrimaryBundleResult:
        return await self._request(
            service,
            "POST",
            "/v1/capability/primary-bundle/preparations",
            command,
            PrimaryBundlePrepareResponse,
            (200, 202),
        )

    async def get_preparation(self, service: ServiceInfo, prepare_operation_id: str) -> LrmPrimaryBundleResult:
        return await self._request(
            service,
            "GET",
            f"/v1/capability/primary-bundle/preparations/{prepare_operation_id}",
            None,
            PrimaryBundleLifecycleReadback,
            (200,),
        )

    async def resume_preparation(self, service: ServiceInfo, prepare_operation_id: str) -> LrmPrimaryBundleResult:
        return await self._request(
            service,
            "POST",
            f"/v1/capability/primary-bundle/preparations/{prepare_operation_id}/resume",
            None,
            PrimaryBundleLifecycleReadback,
            (200,),
        )

    async def get_prepared_model_binding(
        self, service: ServiceInfo, prepare_operation_id: str
    ) -> LrmPrimaryBundleResult:
        return await self._request(
            service,
            "GET",
            f"/v1/capability/primary-bundle/preparations/{prepare_operation_id}/model-binding",
            None,
            PreparedModelBinding,
            (200,),
        )

    async def abort(self, service: ServiceInfo, command: PrimaryBundleAbortRequest) -> LrmPrimaryBundleResult:
        return await self._request(
            service,
            "POST",
            "/v1/capability/primary-bundle/aborts",
            command,
            PrimaryBundleAbortResponse,
            (200,),
        )

    async def commit(self, service: ServiceInfo, command: PrimaryBundleCommitRequest) -> LrmPrimaryBundleResult:
        return await self._request(
            service,
            "POST",
            "/v1/capability/primary-bundle/commits",
            command,
            PrimaryBundleCommitResponse,
            # LRM may acknowledge an idempotent replay with 202 while returning
            # the same strict commit receipt. The caller still read-backs B3.
            (200, 202),
            deadline_s=_COMMIT_REQUEST_DEADLINE_S,
        )

    async def release(self, service: ServiceInfo, command: PrimaryBundleReleaseRequest) -> LrmPrimaryBundleResult:
        return await self._request(
            service,
            "POST",
            "/v1/capability/primary-bundle/releases",
            command,
            PrimaryBundleReleaseResponse,
            (200,),
        )

    async def get_commit(
        self, service: ServiceInfo, *, correlation_operation_id: str, idempotency_key: str
    ) -> LrmPrimaryBundleResult:
        return await self._request(
            service,
            "GET",
            f"/v1/capability/primary-bundle/commits/{correlation_operation_id}?idempotency_key={idempotency_key}",
            None,
            PrimaryBundleCommitResponse,
            (200,),
        )

    async def _request(
        self,
        service: ServiceInfo,
        method: str,
        path: str,
        command: BaseModel | None,
        response_type: type[BaseModel],
        success_statuses: tuple[int, ...],
        *,
        deadline_s: float | None = None,
    ) -> LrmPrimaryBundleResult:
        endpoint = f"http://127.0.0.1:{service.port}{service.proxy_prefix}{path}"
        request_deadline_s = deadline_s or _REQUEST_DEADLINE_S
        try:
            async with asyncio.timeout(request_deadline_s):
                async with self._client.stream(
                    method,
                    endpoint,
                    json=command.model_dump(mode="json", exclude_none=True) if command else None,
                    headers=_credential_headers(self._credential_supplier, service),
                    timeout=httpx.Timeout(
                        connect=2.0,
                        read=request_deadline_s,
                        write=10.0,
                        pool=5.0,
                    ),
                ) as response:
                    content = await _read_response(response)
        except (TimeoutError, httpx.HTTPError, ValueError):
            return LrmPrimaryBundleFailure("safe_error")
        if response.status_code in success_statuses:
            try:
                payload = response_type.model_validate_json(content, strict=True)
            except ValidationError:
                logger.error(
                    "[switch-debug] readback ValidationError: path={} status={} type={} raw={}",
                    path,
                    response.status_code,
                    response_type.__name__,
                    content[:800],
                )
                return LrmPrimaryBundleFailure("safe_error")
            return LrmPrimaryBundleSuccess(payload)
        return _error_result(content, response.status_code)


def _error_result(content: bytes, status_code: int) -> LrmPrimaryBundleFailure:
    if status_code != 409:
        return LrmPrimaryBundleFailure("safe_error")
    try:
        payload = json.loads(content)
        error = payload["error"]
        code = error["code"]
        if not isinstance(code, str) or code not in _B4_ERROR_CODES:
            raise ValueError
        details = error.get("details")
        if not isinstance(details, dict):
            details = {}
        expected = details.get("expected_bundle_revision")
        actual = details.get("actual_bundle_revision")
        return LrmPrimaryBundleFailure(
            code,
            expected if isinstance(expected, int) else None,
            actual if isinstance(actual, int) else None,
        )
    except (KeyError, TypeError, ValueError, json.JSONDecodeError):
        return LrmPrimaryBundleFailure("safe_error")
