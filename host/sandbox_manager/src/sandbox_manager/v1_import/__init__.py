"""One-time import of a SuperClaw 1.x (WSL) install's OpenCode sessions into the native backend."""

from .adapter import import_v1_state_once
from .outcome import V1ImportOutcome, V1ImportReason, V1ImportResult

__all__ = ["V1ImportOutcome", "V1ImportReason", "V1ImportResult", "import_v1_state_once"]
