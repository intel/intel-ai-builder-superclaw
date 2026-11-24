"""Runtime config dataclass for tts_manager.

- ``process_credential`` authenticates every ServiceHub-owned request except
  ``GET /health`` and ``GET /version`` (``auth.py``). It is not an App bearer and is never exposed through child APIs.
- ``service_name`` / ``instance_id`` are sourced from the ServiceHub-injected
  env vars ``SERVICEHUB_SERVICE_NAME`` / ``SERVICEHUB_INSTANCE_ID`` in
  ``__main__.py`` (contract §4) and echoed back through
  ``GET /tts-narration/v1/health`` (contract §5).
- ``threads`` is the onnxruntime intra-op thread cap. ServiceHub passes only
  ``--host`` / ``--port`` on argv, so the cap comes from the env var
  ``KOKORO_TTS_THREADS`` (default 6), read in ``__main__.py``.
- Idle auto-unload is likewise env-only (no argv): ``KOKORO_TTS_IDLE_UNLOAD_SECONDS``
  (default 3600) sets how long the resident model may sit idle before it is
  dropped to reclaim RAM; the next request reloads it. Not stored on this config
  because it drives a background thread in ``model_state``, not per-request state.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class RuntimeConfig:
    """Per-process runtime configuration. Built from argv + env in `__main__.py`."""

    host: str
    port: int
    service_name: str
    instance_id: str
    threads: int = 6
    process_credential: str = ""
