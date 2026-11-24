"""input_local phase node — walk local data paths, emit L-NNN.md sheets.

Runs with empty data_paths are a no-op. Runs with local inputs read each
provided file directly and recurse through each provided directory, then emit
one L-NNN.md per file with a text preview. File-type-specific extractors
(csv / xlsx / docx / pptx / pdf) are deferred — v1 emits raw-text previews,
the filler / writer can still cite filenames.

Managed (Native) mode never recurses and never opens a path by name alone: it reads only the
files ``managed_paths.authorize_data_paths`` recorded, each through ``open_authorized``, which
refuses a handle whose identity changed since validation.
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO

from ..managed_paths import AuthorizedFile, DataPathRefusal, open_authorized
from ..state import Phase, PipelineState


class InputLocalError(Exception):
    """input_local-phase failure."""


@dataclass(frozen=True)
class InputLocalContext:
    data_paths: list[Path]
    """Files or directories to ingest. Empty means no local data."""

    local_insights_dir: Path

    max_files: int = 50
    preview_bytes: int = 4000

    managed_files: tuple[AuthorizedFile, ...] | None = None
    """Managed mode's validated files. When set, ``data_paths`` is ignored."""


_TEXT_EXTS = {".md", ".txt", ".json", ".csv", ".log", ".yaml", ".yml"}


def _slug_for_file(path: Path) -> str:
    base = re.sub(r"[^a-zA-Z0-9_-]+", "_", path.stem).strip("_")
    return base or "file"


def _preview_text(path: Path, max_bytes: int) -> str:
    """Best-effort text preview. Binary files get a one-line notice."""
    if path.suffix.lower() not in _TEXT_EXTS:
        return f"(non-text file; type={path.suffix or 'unknown'}; size={path.stat().st_size} bytes)"
    try:
        body = path.read_text(encoding="utf-8", errors="replace")
    except Exception as e:
        return f"(unreadable: {e})"
    return body[:max_bytes]


def _managed_preview(path: Path, stream: BinaryIO, max_bytes: int) -> str:
    if path.suffix.lower() not in _TEXT_EXTS:
        size = os.fstat(stream.fileno()).st_size
        return f"(non-text file; type={path.suffix or 'unknown'}; size={size} bytes)"
    # Four bytes per character bounds the read; the decoded text is cut to the same preview.
    body = stream.read(max_bytes * 4).decode("utf-8", errors="replace")
    return body.replace("\r\n", "\n")[:max_bytes]


def _run_managed(
    state: PipelineState, ctx: InputLocalContext, files: tuple[AuthorizedFile, ...],
) -> dict[str, Any]:
    previews: list[tuple[Path, str]] = []
    for authorized in files[: ctx.max_files]:
        try:
            with open_authorized(authorized) as stream:
                previews.append(
                    (authorized.path, _managed_preview(authorized.path, stream, ctx.preview_bytes))
                )
        except DataPathRefusal as refusal:
            raise InputLocalError(str(refusal)) from None

    ctx.local_insights_dir.mkdir(parents=True, exist_ok=True)
    artifacts: dict[str, str] = dict(state.artifacts)
    for i, (file_path, preview) in enumerate(previews, start=1):
        wid = f"L-{i:03d}"
        body = (
            f"title: {file_path.name}\n"
            f"url: file://{file_path}\n"
            f"slug: {_slug_for_file(file_path)}\n\n"
            f"{preview}\n"
        )
        out = ctx.local_insights_dir / f"{wid}.md"
        out.write_text(body, encoding="utf-8")
        artifacts[f"{wid}.md"] = str(out)

    return {
        "current_phase": Phase.INPUT_WEB,
        "completed_phases": [*state.completed_phases, Phase.INPUT_LOCAL],
        "artifacts": artifacts,
        "extras": {**state.extras, "input_local_file_count": len(previews)},
    }


def run_input_local(state: PipelineState, ctx: InputLocalContext) -> dict[str, Any]:
    if ctx.managed_files:
        return _run_managed(state, ctx, ctx.managed_files)
    if not ctx.data_paths or ctx.managed_files is not None:
        # No-local path — emit nothing, advance to input_web.
        return {
            "current_phase": Phase.INPUT_WEB,
            "completed_phases": [*state.completed_phases, Phase.INPUT_LOCAL],
            "extras": {**state.extras, "input_local_file_count": 0},
        }

    files_by_key: dict[str, Path] = {}
    for input_path in ctx.data_paths:
        if not input_path.exists():
            raise InputLocalError(f"local data path does not exist: {input_path}")
        if input_path.is_file():
            try:
                files_by_key[str(input_path.resolve())] = input_path
            except OSError:
                files_by_key[str(input_path)] = input_path
            continue
        if input_path.is_dir():
            for p in input_path.rglob("*"):
                if not p.is_file():
                    continue
                try:
                    files_by_key[str(p.resolve())] = p
                except OSError:
                    files_by_key[str(p)] = p
            continue
        raise InputLocalError(f"local data path is neither file nor directory: {input_path}")

    files = sorted(files_by_key.values(), key=lambda p: str(p))[: ctx.max_files]

    ctx.local_insights_dir.mkdir(parents=True, exist_ok=True)
    artifacts: dict[str, str] = dict(state.artifacts)
    for i, file_path in enumerate(files, start=1):
        wid = f"L-{i:03d}"
        slug = _slug_for_file(file_path)
        preview = _preview_text(file_path, ctx.preview_bytes)
        body = (
            f"title: {file_path.name}\n"
            f"url: file://{file_path}\n"
            f"slug: {slug}\n\n"
            f"{preview}\n"
        )
        out = ctx.local_insights_dir / f"{wid}.md"
        out.write_text(body, encoding="utf-8")
        artifacts[f"{wid}.md"] = str(out)

    return {
        "current_phase": Phase.INPUT_WEB,
        "completed_phases": [*state.completed_phases, Phase.INPUT_LOCAL],
        "artifacts": artifacts,
        "extras": {**state.extras, "input_local_file_count": len(files)},
    }


__all__ = ["InputLocalContext", "InputLocalError", "run_input_local"]
