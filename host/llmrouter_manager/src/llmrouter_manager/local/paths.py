"""Resolve the bundled ``llama-server.exe`` across frozen and dev layouts.

The inference bundle ships **exe-adjacent** at the PyInstaller onedir root
(``<root>/inference/llama-win-sycl/``, "mechanism B" — copied by the build
script, *not* through the spec's ``datas``/``_MEIPASS``). In a dev checkout it
lives at ``host/llmrouter_manager/inference/llama-win-sycl/``.

This mirrors ``sandbox_manager``'s multi-candidate resolver: probe every known
layout and return the first that exists, else raise a clear error listing what
was searched.
"""

from __future__ import annotations

import sys
from pathlib import Path

# Relative to a layout base (onedir root, or the repo service dir).
_BUNDLE_SUBPATH = Path("inference") / "llama-win-sycl"
_LLAMA_SERVER = "llama-server.exe"


def _frozen_base() -> Path:
    """Onedir root — exe-adjacent. ``sys.executable`` is the frozen launcher."""
    return Path(sys.executable).resolve().parent


def _dev_base() -> Path:
    """Repo service dir ``host/llmrouter_manager/`` (contains ``src/`` + ``inference/``).

    ``__file__`` == ``.../host/llmrouter_manager/src/llmrouter_manager/local/paths.py``;
    ``parents[3]`` climbs local → llmrouter_manager → src → llmrouter_manager.
    """
    return Path(__file__).resolve().parents[3]


def candidate_inference_dirs() -> list[Path]:
    """Every layout where the ``llama-win-sycl`` bundle may live, in priority order."""
    bases: list[Path] = []
    if getattr(sys, "frozen", False):
        bases.append(_frozen_base())
    bases.append(_dev_base())
    # De-dup while preserving order (frozen base can equal dev base in odd setups).
    seen: set[Path] = set()
    dirs: list[Path] = []
    for base in bases:
        candidate = base / _BUNDLE_SUBPATH
        if candidate not in seen:
            seen.add(candidate)
            dirs.append(candidate)
    return dirs


def inference_dir() -> Path:
    """Return the first existing ``llama-win-sycl`` directory.

    Raises ``FileNotFoundError`` (listing every searched path) if none exists.
    """
    for candidate in candidate_inference_dirs():
        if candidate.is_dir():
            return candidate
    searched = ", ".join(str(d) for d in candidate_inference_dirs())
    raise FileNotFoundError(
        f"llama-server inference bundle not found; searched: {searched}"
    )


def llama_server_exe() -> Path:
    """Return the path to the bundled ``llama-server.exe``.

    Raises ``FileNotFoundError`` (listing every searched path) if absent.
    """
    for candidate in candidate_inference_dirs():
        exe = candidate / _LLAMA_SERVER
        if exe.is_file():
            return exe
    searched = ", ".join(str(d / _LLAMA_SERVER) for d in candidate_inference_dirs())
    raise FileNotFoundError(f"{_LLAMA_SERVER} not found; searched: {searched}")
