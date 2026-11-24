"""Internal JSON client for ServiceHub aggregate routes."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import httpx
from loguru import logger

from servicehub.proxy.client_config import default_httpx_limits
from servicehub.proxy.forwarder import (
    FORWARDED_CREDENTIAL_HEADER,
    PROCESS_CREDENTIAL_HEADER,
    forwarded_credential,
    is_management_path,
)
from servicehub.supervisor.registry import ServiceInfo

# Internal routes only ServiceHub's own calls reach; the proxy never adds the credential to them.
_INTERNAL_CREDENTIAL_PREFIXES: dict[str, tuple[str, ...]] = {
    "sandbox_manager": ("/sandbox-manager/v1/internal/operations/",),
}


@dataclass(frozen=True)
class ServiceClientResult:
    status_code: int
    payload: Any


@dataclass(frozen=True)
class ServiceClientError:
    code: str
    message: str

    def as_dict(self) -> dict[str, str]:
        return {"code": self.code, "message": self.message}


class ServiceClient:
    def __init__(
        self,
        client: httpx.AsyncClient | None = None,
        *,
        process_credential: Callable[[ServiceInfo], str | None] | None = None,
    ) -> None:
        self._process_credential = process_credential
        self._owns_client = client is None
        self._client = client or httpx.AsyncClient(
            trust_env=False,
            timeout=httpx.Timeout(connect=2.0, read=30.0, write=10.0, pool=5.0),
            limits=default_httpx_limits(),
        )

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    def _credential_headers(self, service: ServiceInfo, method: str, relative_path: str) -> dict[str, str]:
        # Same scoping as the proxy: every request carries the forwarded credential, and only
        # management paths and ServiceHub's own internal calls get the child's process credential.
        if self._process_credential is None:
            return {}
        credential = self._process_credential(service)
        if not credential:
            return {}
        headers = {FORWARDED_CREDENTIAL_HEADER: forwarded_credential(credential)}
        path = _target_path(service, relative_path)
        internal = path.startswith(_INTERNAL_CREDENTIAL_PREFIXES.get(service.name, ()))
        if internal or is_management_path(service.name, path, method):
            headers[PROCESS_CREDENTIAL_HEADER] = credential
        return headers

    async def request_json(
        self,
        service: ServiceInfo,
        method: str,
        relative_path: str,
        *,
        json_body: object | None = None,
    ) -> ServiceClientResult | ServiceClientError:
        try:
            response = await self._client.request(
                method,
                _target_url(service, relative_path),
                headers=self._credential_headers(service, method, relative_path),
                json=json_body,
            )
        except httpx.TimeoutException as exc:
            logger.warning(
                "upstream request failed service={} method={} path={} error_type={}",
                service.name,
                method,
                relative_path,
                type(exc).__name__,
            )
            return ServiceClientError(
                "gateway_timeout", f"Timed out while contacting service {service.name}"
            )
        except httpx.HTTPError as exc:
            logger.warning(
                "upstream request failed service={} method={} path={} error_type={}",
                service.name,
                method,
                relative_path,
                type(exc).__name__,
            )
            return ServiceClientError(
                "service_unavailable", f"Unable to contact service {service.name}"
            )
        try:
            payload: Any = response.json()
        except ValueError:
            payload = None
        return ServiceClientResult(status_code=response.status_code, payload=payload)


def _target_path(service: ServiceInfo, relative_path: str) -> str:
    if not relative_path.startswith("/"):
        relative_path = f"/{relative_path}"
    return f"{service.proxy_prefix}{relative_path}"


def _target_url(service: ServiceInfo, relative_path: str) -> str:
    return f"http://127.0.0.1:{service.port}{_target_path(service, relative_path)}"
