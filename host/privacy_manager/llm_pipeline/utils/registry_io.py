"""Shared helpers for writing reversible PII mask registries."""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Mapping

from llm_pipeline.utils.paths import reject_reparse_components


def write_registry_json(
    registry: Mapping[str, str],
    output_path: Path,
    *,
    indent: int = 2,
    ensure_ascii: bool = False,
    mode: int = 0o600,
) -> int:
    """Write a placeholder registry JSON file and return bytes written.

    The registry maps masked placeholders back to original values, so the file
    is sensitive. The parent directory is created when needed, and the file is
    opened with owner-only permissions on POSIX. Windows ignores the mode bits
    and relies on the parent directory ACL.
    """
    reject_reparse_components(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(registry, ensure_ascii=ensure_ascii, indent=indent)
    data = payload.encode("utf-8")

    fd = os.open(str(output_path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    try:
        with os.fdopen(fd, "wb", closefd=True) as registry_file:
            registry_file.write(data)
    except BaseException:
        try:
            output_path.unlink()
        except OSError:
            pass
        raise
    return len(data)
