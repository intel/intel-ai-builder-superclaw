"""Runtime config dataclass for llmrouter_manager.

- ``process_credential`` authenticates ServiceHub-owned shutdown requests. It
  is not an App bearer and is never exposed through child APIs.
- ``service_name`` / ``instance_id``: sourced from the ServiceHub-injected
  env vars ``SERVICEHUB_SERVICE_NAME`` and ``SERVICEHUB_INSTANCE_ID`` in
  ``__main__.py`` (contract §4). Both are echoed back through
  ``GET /llm-router/v1/health`` (contract §5) so ServiceHub can distinguish
  a fresh spawn from a stale fixed-port squatter.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field


@dataclass(frozen=True)
class RuntimeConfig:
    """Per-process runtime configuration.

    Built from argv + env in `__main__.py`.
    """

    host: str
    port: int
    service_name: str
    instance_id: str
    process_credential: str = ""
    inference_key: str = field(default_factory=lambda: os.environ.get("LRM_API_KEY", ""))
    # The host-only data-plane credential. Withheld from the sandbox container,
    # so a route can require a caller that is demonstrably not sandboxed. Empty
    # in standalone dev mode, where there is no sandbox to distinguish from.
    host_inference_key: str = field(
        default_factory=lambda: os.environ.get("LRM_HOST_API_KEY", "")
    )
