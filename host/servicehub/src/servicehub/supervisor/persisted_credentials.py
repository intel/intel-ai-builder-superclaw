"""Read-only access to the child credentials LRM and Privacy Manager persist.

ServiceHub hands these keys to dependents at spawn. Both are stable records the
providers own and only write on first start or migration, so on a warm start they
can be read before either provider is running. The providers' own record readers
parse them; nothing here creates or migrates a record. A key read here is still
checked against the provider's authenticated handoff once it is ready (see
``ProcessManager.spawn_service``).
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field

from loguru import logger


@dataclass(frozen=True)
class PersistedCredentials:
    lrm_api_key: str | None = field(default=None, repr=False)
    privacy_data_plane_key: str | None = field(default=None, repr=False)


def read_persisted_credentials() -> PersistedCredentials:
    """Blocking (file I/O and DPAPI); call it off the event loop."""
    return PersistedCredentials(
        lrm_api_key=_read("llmrouter_manager", _read_lrm_shared_key),
        privacy_data_plane_key=_read("privacy_manager", _read_privacy_data_plane_key),
    )


def _read_lrm_shared_key() -> str | None:
    from llmrouter_manager.common.inference_key import read_inference_keys

    keys = read_inference_keys()
    return None if keys is None else keys[0]


def _read_privacy_data_plane_key() -> str | None:
    from protection_service.data_plane_key import read_data_plane_key

    return read_data_plane_key()


def _read(provider: str, reader: Callable[[], str | None]) -> str | None:
    try:
        key = reader()
    # Any failure, an ImportError in a source run included, only means the
    # dependent waits for the provider's handoff as it would without this read.
    except Exception as exc:
        logger.info(
            "persisted credential unreadable provider={} error_type={}",
            provider,
            type(exc).__name__,
        )
        return None
    if key is None:
        logger.info("persisted credential absent provider={}", provider)
    return key
