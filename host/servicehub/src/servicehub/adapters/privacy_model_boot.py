"""Reconcile retained File Protection state before ServiceHub serves the app."""

from __future__ import annotations

from loguru import logger

from servicehub.proxy.service_client import (
    ServiceClient,
    ServiceClientError,
    ServiceClientResult,
)
from servicehub.supervisor.registry import ServiceRegistry

_LRM_SERVICE = "llmrouter_manager"
_PRIVACY_SERVICE = "privacy_manager"
_MODE_PATH = "/v1/data-protection/mode"
_MODELS_STATUS_PATH = "/v1/models/status"


def _payload(result: ServiceClientResult | ServiceClientError) -> dict[str, object]:
    if (
        isinstance(result, ServiceClientResult)
        and result.status_code == 200
        and isinstance(result.payload, dict)
    ):
        return result.payload
    return {}


async def reconcile_retained_file_protection(
    registry: ServiceRegistry,
    client: ServiceClient,
) -> None:
    """Turn off retained File Protection when its verified models are missing.

    Best effort: Privacy Manager never downloads without consent, so a failure here
    only leaves the stale setting on.
    """
    lrm = registry.get(_LRM_SERVICE)
    privacy = registry.get(_PRIVACY_SERVICE)
    if lrm is None or privacy is None:
        return
    mode = _payload(await client.request_json(lrm, "GET", _MODE_PATH))
    if mode.get("applied", "none") == "none":
        return
    status = _payload(await client.request_json(privacy, "GET", _MODELS_STATUS_PATH))
    if status.get("models_present") is not False:
        return
    updated = _payload(
        await client.request_json(lrm, "PUT", _MODE_PATH, json_body={"mode": "none"})
    )
    if updated.get("applied") == "none":
        logger.info("Disabled retained File Protection: privacy models are missing or unverified")
    else:
        logger.warning("Could not disable retained File Protection with missing privacy models")