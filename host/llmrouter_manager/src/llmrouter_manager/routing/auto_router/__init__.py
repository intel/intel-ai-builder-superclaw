"""Auto router package — wraps the trained latency router for `auto` dispatch.

CRITICAL: `_runtime_stubs` must execute BEFORE any `from .latentfactorrouter.*`
import path runs `from llmrouter.* import ...` at module-load time. It installs
fake `torch` + `llmrouter.{models,utils,data}` modules into ``sys.modules`` when
the real upstream packages are absent. The stubs are sufficient for the
inference-time path (LRM never calls the trainer). See ``_runtime_stubs.py``
for the audit trail it prints to stderr at first import.
"""

from __future__ import annotations

# Order matters: stubs must install before any latentfactorrouter import.
from . import _runtime_stubs  # noqa: F401  side-effect import (intentional)
