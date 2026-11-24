"""HTTP implementation of the restricted SandboxManager runtime boundary.

The client carries no App credentials and targets only fixed deployment and
runtime status paths over loopback.
"""

from __future__ import annotations

from collections.abc import Callable

import httpx

from contracts.product_profile_runtime_status import ProductProfileRuntimeStatus
from contracts.runtime_deployment_spec import RuntimeDeploymentSpec
from contracts.runtime_instance_evidence import RuntimeInstanceEvidence

from servicehub.adapters.restricted_sandbox_lifecycle_client import (
    RestrictedSandboxResponse,
    RestrictedSandboxRuntimeUnavailable,
)
from servicehub.proxy.forwarder import FORWARDED_CREDENTIAL_HEADER, forwarded_credential

_RUNTIME_PROFILE_PATH = "/sandbox-manager/v1/capability/runtime-profile"
_RUNTIME_DEPLOYMENT_PATH = "/sandbox-manager/v1/capability/runtime-deployment"
_INTERNAL_RUNTIME_DEPLOYMENT_PATH = "/sandbox-manager/v1/internal/capability/runtime-deployment"
_RUNTIME_INSTANCE_PATH = "/sandbox-manager/v1/capability/runtime-instance"
_RUNTIME_INFRASTRUCTURE_PREPARATIONS_PATH = (
    "/sandbox-manager/v1/internal/capability/runtime-infrastructure/preparations"
)
_PROCESS_CREDENTIAL_HEADER = "X-SuperClaw-Process-Credential"
_OWT_PATH = "/sandbox-manager/v1/internal/agent/sandbox/tokens/current"
_RUNTIME_CONVERGENCE_PATH = "/sandbox-manager/v1/internal/agent/sandbox/provisions"
_CLEANUP_RUN_PATH = "/sandbox-manager/v1/internal/workspace/cleanup/run-now"
_CLEANUP_SETTINGS_PATH = "/sandbox-manager/v1/internal/workspace/cleanup/settings"
_REQUEST_TIMEOUT = httpx.Timeout(connect=2.0, read=30.0, write=10.0, pool=5.0)


class HttpRestrictedSandboxLifecycleClient:
    """HTTP client for the restricted SandboxManager runtime boundary."""

    def __init__(
        self,
        *,
        base_url: str,
        credential_supplier: Callable[[], str | None] = lambda: None,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._credential_supplier = credential_supplier
        self._owns_client = client is None
        self._client = client or httpx.AsyncClient(trust_env=False, timeout=_REQUEST_TIMEOUT)

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    def set_credential_supplier(self, supplier: Callable[[], str | None]) -> None:
        self._credential_supplier = supplier

    async def get_runtime_profile(self) -> ProductProfileRuntimeStatus:
        response = await self._client.get(
            f"{self._base_url}{_RUNTIME_PROFILE_PATH}", headers=self._forwarded_headers()
        )
        if response.status_code == 503 and _error_code(response) == "runtime_profile_unavailable":
            raise RestrictedSandboxRuntimeUnavailable("runtime_profile_unavailable")
        response.raise_for_status()
        return ProductProfileRuntimeStatus.model_validate_json(response.content, strict=True)

    async def prepare_runtime_infrastructure(self) -> None:
        response = await self._client.post(
            f"{self._base_url}{_RUNTIME_INFRASTRUCTURE_PREPARATIONS_PATH}",
            headers=self._credential_headers(),
        )
        response.raise_for_status()

    async def persist_runtime_deployment(
        self, deployment: RuntimeDeploymentSpec
    ) -> RuntimeDeploymentSpec:
        response = await self._client.put(
            f"{self._base_url}{_INTERNAL_RUNTIME_DEPLOYMENT_PATH}",
            json=deployment.model_dump(mode="json"),
            headers=self._credential_headers(),
        )
        response.raise_for_status()
        return RuntimeDeploymentSpec.model_validate_json(response.content, strict=True)

    async def get_runtime_deployment(self) -> RuntimeDeploymentSpec:
        response = await self._client.get(
            f"{self._base_url}{_RUNTIME_DEPLOYMENT_PATH}", headers=self._forwarded_headers()
        )
        response.raise_for_status()
        return RuntimeDeploymentSpec.model_validate_json(response.content, strict=True)

    async def revoke_runtime_deployment(self, deployment: RuntimeDeploymentSpec) -> None:
        response = await self._client.request(
            "DELETE",
            f"{self._base_url}{_INTERNAL_RUNTIME_DEPLOYMENT_PATH}",
            json=deployment.model_dump(mode="json"),
            headers=self._credential_headers(),
        )
        response.raise_for_status()

    async def get_runtime_instance_evidence(self) -> RuntimeInstanceEvidence:
        response = await self._client.get(
            f"{self._base_url}{_RUNTIME_INSTANCE_PATH}", headers=self._forwarded_headers()
        )
        response.raise_for_status()
        return RuntimeInstanceEvidence.model_validate_json(response.content, strict=True)

    async def get_owt_token(self) -> dict[str, object]:
        response = await self._client.get(
            f"{self._base_url}{_OWT_PATH}", headers=self._credential_headers()
        )
        response.raise_for_status()
        return response.json()

    async def converge_runtime(self, *, rearm: bool = False) -> RestrictedSandboxResponse:
        # `rearm` is a user Retry: SandboxManager asks again after a refused provision.
        response = await self._client.post(
            f"{self._base_url}{_RUNTIME_CONVERGENCE_PATH}",
            headers=self._credential_headers(),
            **({"params": {"rearm": "true"}} if rearm else {}),
        )
        response.raise_for_status()
        return RestrictedSandboxResponse(
            status_code=response.status_code,
            payload=response.json(),
        )

    async def run_workspace_cleanup(self, payload: dict[str, object]) -> dict[str, object]:
        response = await self._client.post(
            f"{self._base_url}{_CLEANUP_RUN_PATH}",
            json=payload,
            headers=self._credential_headers(),
        )
        response.raise_for_status()
        return response.json()

    async def set_workspace_cleanup_settings(
        self, payload: dict[str, object]
    ) -> dict[str, object]:
        response = await self._client.post(
            f"{self._base_url}{_CLEANUP_SETTINGS_PATH}",
            json=payload,
            headers=self._credential_headers(),
        )
        response.raise_for_status()
        return response.json()

    def _credential_headers(self) -> dict[str, str]:
        credential = self._credential_supplier()
        if not credential:
            raise RestrictedSandboxRuntimeUnavailable("sandbox_manager_process_unavailable")
        return {_PROCESS_CREDENTIAL_HEADER: credential}

    def _forwarded_headers(self) -> dict[str, str]:
        # The public routes need ServiceHub's forwarded credential, not the process credential.
        credential = self._credential_supplier()
        return {FORWARDED_CREDENTIAL_HEADER: forwarded_credential(credential)} if credential else {}

def _error_code(response: httpx.Response) -> str | None:
    try:
        payload = response.json()
    except ValueError:
        return None
    if not isinstance(payload, dict):
        return None
    detail = payload.get("detail", payload)
    if not isinstance(detail, dict):
        return None
    error = detail.get("error")
    if not isinstance(error, dict):
        return None
    code = error.get("code")
    return code if isinstance(code, str) else None
