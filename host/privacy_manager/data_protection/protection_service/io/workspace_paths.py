"""Workspace path mapping and source log metadata utilities."""

from __future__ import annotations

import re
from datetime import datetime
from pathlib import Path

from llm_pipeline.utils.paths import reject_reparse_components

from protection_service.constants import (
    DATA_PROTECTION_WORKSPACE,
    WORKSPACE_CONTAINER_PREFIX,
    WORKSPACE_ROOT,
)

# Matches the "<stem>/<timestamp>/" folder pair produced by
# build_workspace_masked_output_path, e.g. "masked_datasets/customers/20260615_112233/".
_MASKED_DATASET_RE = re.compile(r"masked_datasets/([^/]+)/(\d{8}_\d{6})/")


def resolve_workspace_path_to_host(source_file_path: str) -> str:
    """Map a container ``/workspace/...`` path to the Windows host path.

    Args:
        source_file_path: Source path provided by a caller.

    Returns:
        str: Windows-host path for sandbox workspace paths, or the original
        path when no mapping applies.
    """
    normalized = source_file_path.replace("\\", "/").strip()
    if normalized == WORKSPACE_CONTAINER_PREFIX:
        return str(WORKSPACE_ROOT)
    if normalized.startswith(WORKSPACE_CONTAINER_PREFIX + "/"):
        relative = normalized[len(WORKSPACE_CONTAINER_PREFIX) + 1:]
        return str(WORKSPACE_ROOT / relative)
    if normalized.startswith("workspace/"):
        relative = normalized[len("workspace/"):]
        return str(WORKSPACE_ROOT / relative)
    return source_file_path


def build_workspace_masked_output_path(source: Path, masked_suffix: str) -> tuple[Path, str]:
    """Build the host path of a masked output file.

    Mirrors the llm_pipeline layout::

        ~/SuperClawProjects/data_protection_workspace/masked_datasets/<stem>/<YYYYMMDD_HHMMSS>/<stem>_masked<ext>

    Native agents read the host path directly, so it is returned twice.

    Args:
        source: Original source file path on the Windows host.
        masked_suffix: Suffix to use for the masked output file.

    Returns:
        tuple[Path, str]: Host destination and the path agents use (the same).
    """
    # Local system time, matching llm_pipeline's generate_timestamp().
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    folder = DATA_PROTECTION_WORKSPACE / "masked_datasets" / source.stem / timestamp
    dest = folder / f"{source.stem}_masked{masked_suffix}"
    reject_reparse_components(dest)
    folder.mkdir(parents=True, exist_ok=True)
    return dest, str(dest)


def mirror_masked_output_to_registry_path(masked_container_path: str) -> Path | None:
    """Build a mask-registry destination that mirrors a DPS masked-output path.

    Extracts the ``<stem>/<timestamp>`` pair a masked path was built with (see
    ``build_workspace_masked_output_path``) and reuses it under
    ``mask_registries/`` instead of ``masked_datasets/``, so DPS's registry
    lands next to its masked dataset -- matching the llm_pipeline layout.

    Args:
        masked_container_path: Sandbox-visible masked path, e.g.
            ``/workspace/data_protection_workspace/masked_datasets/<stem>/<timestamp>/<stem>_masked.csv``.

    Returns:
        Path | None: Host destination path for the mirrored registry file, or
        None if ``masked_container_path`` doesn't match the expected layout.
    """
    match = _MASKED_DATASET_RE.search(masked_container_path.replace("\\", "/"))
    if not match:
        return None
    stem, timestamp = match.group(1), match.group(2)
    folder = DATA_PROTECTION_WORKSPACE / "mask_registries" / stem / timestamp
    dest = folder / f"{stem}_mask_registry.json"
    reject_reparse_components(dest)
    folder.mkdir(parents=True, exist_ok=True)
    return dest


def summarize_source_for_logs(source: str | Path) -> tuple[str, int | None, bool]:
    """Return non-sensitive source metadata for structured logs.

    Args:
        source: Source path to summarize without logging the full path.

    Returns:
        tuple[str, int | None, bool]: File extension, file size in bytes when
            available, and whether the caller used a sandbox-facing workspace path.
    """
    raw = str(source)
    normalized = raw.replace("\\", "/").strip()
    path = Path(raw)
    size: int | None = None
    try:
        if path.is_file():
            size = path.stat().st_size
    except OSError:
        size = None
    is_workspace_path = (
        normalized == WORKSPACE_CONTAINER_PREFIX
        or normalized.startswith(WORKSPACE_CONTAINER_PREFIX + "/")
        or normalized.startswith("workspace/")
    )
    return path.suffix.lower() or "<none>", size, is_workspace_path
