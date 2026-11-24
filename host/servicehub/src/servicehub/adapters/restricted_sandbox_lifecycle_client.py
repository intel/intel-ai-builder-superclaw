"""Narrow runtime lifecycle boundary; never forwards App credentials or arbitrary routes."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from contracts.product_profile_runtime_status import ProductProfileRuntimeStatus
from contracts.runtime_deployment_spec import RuntimeDeploymentSpec
from contracts.runtime_instance_evidence import RuntimeInstanceEvidence


class RestrictedSandboxFeatureNotReady(RuntimeError):
    """The C2 restricted credential and lifecycle producer are not installed."""


class RestrictedSandboxRuntimeUnavailable(RuntimeError):
    """The Runtime is explicitly absent."""


@dataclass(frozen=True)
class RestrictedSandboxResponse:
    status_code: int
    payload: dict[str, object]


class RestrictedSandboxLifecycleClient(Protocol):
    async def aclose(self) -> None: ...

    async def prepare_runtime_infrastructure(self) -> None: ...

    async def persist_runtime_deployment(
        self, deployment: RuntimeDeploymentSpec
    ) -> RuntimeDeploymentSpec: ...

    async def get_runtime_deployment(self) -> RuntimeDeploymentSpec: ...

    async def revoke_runtime_deployment(self, deployment: RuntimeDeploymentSpec) -> None: ...

    async def get_runtime_instance_evidence(self) -> RuntimeInstanceEvidence: ...

    async def get_runtime_profile(self) -> ProductProfileRuntimeStatus: ...

    async def get_owt_token(self) -> dict[str, object]: ...

    async def converge_runtime(self, *, rearm: bool = False) -> RestrictedSandboxResponse: ...

    async def run_workspace_cleanup(self, payload: dict[str, object]) -> dict[str, object]: ...

    async def set_workspace_cleanup_settings(
        self, payload: dict[str, object]
    ) -> dict[str, object]: ...


class UnavailableRestrictedSandboxLifecycleClient:
    """Fail closed until SandboxManager exposes the restricted runtime contract."""

    async def aclose(self) -> None:
        return None

    async def get_runtime_profile(self) -> ProductProfileRuntimeStatus:
        raise RestrictedSandboxFeatureNotReady("feature_not_ready")

    async def prepare_runtime_infrastructure(self) -> None:
        raise RestrictedSandboxFeatureNotReady("feature_not_ready")

    async def persist_runtime_deployment(
        self, deployment: RuntimeDeploymentSpec
    ) -> RuntimeDeploymentSpec:
        raise RestrictedSandboxFeatureNotReady("feature_not_ready")

    async def get_runtime_deployment(self) -> RuntimeDeploymentSpec:
        raise RestrictedSandboxFeatureNotReady("feature_not_ready")

    async def revoke_runtime_deployment(self, deployment: RuntimeDeploymentSpec) -> None:
        raise RestrictedSandboxFeatureNotReady("feature_not_ready")

    async def get_runtime_instance_evidence(self) -> RuntimeInstanceEvidence:
        raise RestrictedSandboxFeatureNotReady("feature_not_ready")

    async def get_owt_token(self) -> dict[str, object]:
        raise RestrictedSandboxFeatureNotReady("feature_not_ready")

    async def converge_runtime(self, *, rearm: bool = False) -> RestrictedSandboxResponse:
        raise RestrictedSandboxFeatureNotReady("feature_not_ready")

    async def run_workspace_cleanup(self, payload: dict[str, object]) -> dict[str, object]:
        raise RestrictedSandboxFeatureNotReady("feature_not_ready")

    async def set_workspace_cleanup_settings(
        self, payload: dict[str, object]
    ) -> dict[str, object]:
        raise RestrictedSandboxFeatureNotReady("feature_not_ready")
