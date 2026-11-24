"""Dynamic ServiceHub proxy-prefix routing."""

from __future__ import annotations

from servicehub.proxy.error_normalizer import service_not_found, service_unavailable
from servicehub.supervisor.registry import ServiceInfo, ServiceRegistry


def resolve_service(registry: ServiceRegistry, proxy_prefix: str) -> ServiceInfo:
    service = registry.get_by_prefix(proxy_prefix)
    if service is None:
        raise service_not_found(proxy_prefix)
    if service.state != "running":
        raise service_unavailable(service.name)
    return service
