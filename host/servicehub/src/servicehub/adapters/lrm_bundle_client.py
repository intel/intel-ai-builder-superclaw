"""Read-only typed client for LRM's B3 primary-bundle capability endpoint."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
import json
import re

from contracts.primary_bundle import PrimaryBundleCapability
import httpx
from loguru import logger
from pydantic import ValidationError

from servicehub.proxy.client_config import default_httpx_limits
from servicehub.supervisor.registry import ServiceInfo

_ALLOWED_REASON_CODES = frozenset({
    "hardware_evidence_unknown",
    "unsupported_local_hardware",
    "no_compute_compatible_local_bundle",
})
_MAX_RESPONSE_BYTES = 1024 * 1024
_REQUEST_DEADLINE_S = 10.0
_UTC_TIMESTAMP = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z$"
)
_PROCESS_CREDENTIAL_HEADER = "X-SuperClaw-Process-Credential"

LrmCredentialSupplier = Callable[[ServiceInfo], str | None]


@dataclass(frozen=True)
class LrmBundleCapabilityResult:
    capability: PrimaryBundleCapability

    @property
    def bundle_revision(self) -> int:
        """LRM's lifecycle revision; set even when no Bundle is committed (e.g. after a release)."""
        if self.capability.bundle_revision is not None:
            return self.capability.bundle_revision
        primary = self.capability.primary_bundle
        return primary.bundle_revision if primary is not None else 0


@dataclass(frozen=True)
class LrmBundleUnavailable:
    pass


@dataclass(frozen=True)
class LrmBundleMalformed:
    pass


LrmBundleReadResult = LrmBundleCapabilityResult | LrmBundleUnavailable | LrmBundleMalformed


class LrmBundleClient:
    """Own the narrow B3 read boundary without forwarding App credentials."""

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

    async def get_primary_bundle(
        self, service: ServiceInfo
    ) -> LrmBundleReadResult:
        endpoint = _endpoint(service)
        try:
            async with asyncio.timeout(_REQUEST_DEADLINE_S):
                async with self._client.stream(
                    "GET",
                    endpoint,
                    headers=_credential_headers(self._credential_supplier, service),
                ) as response:
                    if response.status_code != 200:
                        _log_status(service, endpoint, response.status_code)
                        return LrmBundleUnavailable()
                    content = await _read_response(response)
        except (TimeoutError, httpx.TimeoutException) as exc:
            _log_failure(service, endpoint, "timeout", exc)
            return LrmBundleUnavailable()
        except ValueError as exc:
            _log_failure(service, endpoint, "malformed", exc)
            return LrmBundleMalformed()
        except httpx.HTTPError as exc:
            _log_failure(service, endpoint, "unavailable", exc)
            return LrmBundleUnavailable()
        try:
            payload = json.loads(content)
            if (
                not isinstance(payload, dict)
                or _contains_null(payload)
                or not _is_utc_timestamp(payload.get("observed_at"))
            ):
                raise ValueError("payload violates the B3 wire schema")
            capability = PrimaryBundleCapability.model_validate_json(content, strict=True)
        except (json.JSONDecodeError, ValidationError, ValueError) as exc:
            _log_failure(service, endpoint, "malformed", exc)
            return LrmBundleMalformed()
        if (
            not set(capability.reasons).issubset(_ALLOWED_REASON_CODES)
            or not _has_consistent_capability_facts(capability)
        ):
            _log_status(service, endpoint, response.status_code, "semantic_invalid")
            return LrmBundleMalformed()
        return LrmBundleCapabilityResult(capability)


async def _read_response(response: httpx.Response) -> bytes:
    chunks: list[bytes] = []
    size = 0
    async for chunk in response.aiter_bytes():
        size += len(chunk)
        if size > _MAX_RESPONSE_BYTES:
            raise ValueError("LRM B3 response exceeds the size limit")
        chunks.append(chunk)
    return b"".join(chunks)


def _contains_null(value: object) -> bool:
    if value is None:
        return True
    if isinstance(value, dict):
        return any(_contains_null(item) for item in value.values())
    if isinstance(value, list):
        return any(_contains_null(item) for item in value)
    return False


def _is_utc_timestamp(value: object) -> bool:
    if not isinstance(value, str) or _UTC_TIMESTAMP.fullmatch(value) is None:
        return False
    try:
        datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError:
        return False
    return True


def _has_consistent_capability_facts(capability: PrimaryBundleCapability) -> bool:
    ceiling = capability.hardware_capability_ceiling
    if capability.cloud_only_product_profile_id == "lite":
        return (
            ceiling is None
            and capability.recommended_bundle_id is None
            and (capability.primary_bundle is None or capability.primary_bundle.backend.value == "edge")
            and all(bundle.backend.value == "edge" for bundle in capability.supported_bundles)
            and capability.supported_bundle_ids == [
                bundle.bundle_id for bundle in capability.supported_bundles
            ]
        )
    if ceiling is None:
        return True
    return (
        "hardware_evidence_unknown" not in capability.reasons
        and ceiling.bundle_id in capability.supported_bundle_ids
        and capability.recommended_bundle_id == ceiling.bundle_id
    )


def _endpoint(service: ServiceInfo) -> str:
    return (
        f"http://127.0.0.1:{service.port}{service.proxy_prefix}"
        "/v1/capability/primary-bundle"
    )


def _log_failure(
    service: ServiceInfo, endpoint: str, status_class: str, exc: Exception
) -> None:
    logger.warning(
        "LRM capability-read failed service={} method=GET endpoint={} status_class={} error_type={}",
        service.name,
        endpoint,
        status_class,
        type(exc).__name__,
    )


def _log_status(
    service: ServiceInfo,
    endpoint: str,
    status_code: int,
    status_class: str | None = None,
) -> None:
    logger.warning(
        "LRM capability-read failed service={} method=GET endpoint={} status_class={} error_type=none",
        service.name,
        endpoint,
        status_class or f"{status_code // 100}xx",
    )


def _credential_headers(
    supplier: LrmCredentialSupplier, service: ServiceInfo
) -> dict[str, str]:
    credential = supplier(service)
    return {_PROCESS_CREDENTIAL_HEADER: credential} if credential else {}
