"""Bundled prompts for the sidecar's phase nodes.

Loader: `load_prompt(name)` returns the prompt text for `<name>.md` next
to this file. Tests can override by patching the loader.
"""
from __future__ import annotations

from importlib import resources

_PACKAGE = "hybrid_dr_orchestrator.prompts"


def load_prompt(name: str) -> str:
    """Return the contents of `<name>.md` in the bundled prompts dir.

    Raises FileNotFoundError if missing — refusing to substitute a blank
    or a guessed prompt for a missing one (the wrong-prompt class of bug
    is harder to debug than a hard-fail at startup).
    """
    return resources.files(_PACKAGE).joinpath(f"{name}.md").read_text(encoding="utf-8")


__all__ = ["load_prompt"]
