"""State persistence — legacy `pipeline_state.json` shape on disk so the
existing opencode plugins / monitor scripts keep working during the
strangler-fig migration window.

Format on disk matches the current SuperClaw pipeline_state.json
exactly (see `state.PipelineState.to_legacy_dict`). The full sidecar
state (with extras / phase_status) is kept in memory; downstream
checkpointing can switch to LangGraph's built-in sqlite saver when
needed.
"""
from __future__ import annotations

import json
from pathlib import Path

from .state import PipelineState


LEGACY_FILENAME = "pipeline_state.json"


def save_legacy(state: PipelineState, local_intermediate_dir: Path) -> Path:
    """Write the state in the legacy on-disk shape. Returns the path
    written. Creates the directory if missing."""
    local_intermediate_dir.mkdir(parents=True, exist_ok=True)
    path = local_intermediate_dir / LEGACY_FILENAME
    # Atomic-ish write: temp file + rename
    tmp = path.with_suffix(".json.tmp")
    tmp.write_bytes(json.dumps(state.to_legacy_dict(), indent=2).encode("utf-8"))
    tmp.replace(path)
    return path


def load_legacy(local_intermediate_dir: Path) -> PipelineState | None:
    """Inverse of save_legacy. Returns None when the file is missing —
    that's a "fresh session" signal, not an error."""
    path = local_intermediate_dir / LEGACY_FILENAME
    if not path.exists():
        return None
    raw = json.loads(path.read_text(encoding="utf-8"))
    return PipelineState.from_legacy_dict(raw)


__all__ = ["LEGACY_FILENAME", "load_legacy", "save_legacy"]
