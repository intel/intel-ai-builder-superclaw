"""Runtime config dataclass for asr_manager.

- ``process_credential`` authenticates every ServiceHub-owned request except
  ``GET /health`` and ``GET /version`` (``auth.py``). It is not an App bearer and is never exposed through child APIs.
- ``service_name`` / ``instance_id`` come from the ServiceHub-injected env vars
  ``SERVICEHUB_SERVICE_NAME`` / ``SERVICEHUB_INSTANCE_ID`` (sub-service contract
  §4), read in ``__main__.py`` and echoed back by
  ``GET /speech-to-text/v1/health`` (§5).
- ``threads`` is the onnxruntime intra-op thread cap. ServiceHub passes only
  ``--host`` / ``--port`` on argv, so it comes from ``PARAKEET_ASR_THREADS`` or,
  unset, from ``__main__._default_threads()``: half the physical cores clamped to
  [2, 6]. Deliberately a fraction of the machine rather than a constant -- a
  dictation transcribe runs while the user is still looking at the composer and the
  local llama-server may be mid-generation, and "4" would mean 2% of a workstation
  but 100% of a 4-core Lite box. See the measured thread sweep in ``__main__.py``.
- Idle auto-unload is env-only (no argv): ``PARAKEET_ASR_IDLE_UNLOAD_SECONDS``
  (default 900) sets how long the resident model may sit idle before it is
  dropped; the next ``/prepare`` or ``/transcribe`` reloads it. Not stored here
  because it drives a background thread in ``recognize.model_state``, not
  per-request state.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class RuntimeConfig:
    """Per-process runtime configuration. Built from argv + env in ``__main__.py``."""

    host: str
    port: int
    service_name: str
    instance_id: str
    threads: int = 4
    process_credential: str = ""
