"""Security-related routing settings shared between the manager, the
sandbox-side file-protection tool, and the UI.

Owns two configurable settings (see :mod:`security.settings`):

* ``FILE_PROTECTION_MODE`` — one of ``none | deterministic | hybrid | llm``.
  Selects which file-protection pipeline the sandbox-side tool calls.
* ``FILE_PROTECTION_HYBRID_THRESHOLD`` — float in ``[0.0, 1.0]``. Minimum
  per-column detector confidence below which ``hybrid`` mode falls back
  from the deterministic DPS pipeline to the LLM-driven ``llm_pipeline``.

"""

from .api import security_router
from .settings import (
    FILE_PROTECTION_MODE_DEFAULT,
    FILE_PROTECTION_MODES,
    HYBRID_THRESHOLD_DEFAULT,
    STORE_KEY_FILE_PROTECTION_MODE,
    STORE_KEY_HYBRID_THRESHOLD,
    resolve_file_protection_mode,
    resolve_hybrid_threshold,
)

__all__ = [
    "FILE_PROTECTION_MODES",
    "FILE_PROTECTION_MODE_DEFAULT",
    "HYBRID_THRESHOLD_DEFAULT",
    "STORE_KEY_FILE_PROTECTION_MODE",
    "STORE_KEY_HYBRID_THRESHOLD",
    "resolve_file_protection_mode",
    "resolve_hybrid_threshold",
    "security_router",
]
