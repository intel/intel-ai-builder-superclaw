"""Source file path validation for the data-protection service."""

from __future__ import annotations

import os
from pathlib import Path

from fastapi import HTTPException, status

from protection_service.io.workspace_paths import resolve_workspace_path_to_host


def validate_source_path(source: str, redact_cfg: object = None) -> Path:
    """Validate and resolve a caller-provided source file path.

    Translates container ``/workspace/...`` paths to the Windows host path,
    enforces configured allow-list roots, and rejects files that exceed the
    size limit.

    Both the surface path (symlinks not followed) and the canonical resolved
    path (symlinks followed) must fall inside configured roots to block both
    path-traversal attacks (``..`` in the surface path) and symlink attacks
    (symlink inside the root pointing outside it).

    Args:
        source: Caller-provided source path.
        redact_cfg: Optional redact configuration with ``source_roots`` and
            ``max_source_bytes`` attributes.

    Returns:
        Path: Resolved and validated source file path.

    Raises:
        HTTPException: HTTP 400 if the path is invalid, missing, not a regular
            file, or outside configured roots; HTTP 413 if the file exceeds
            ``max_source_bytes``.
    """
    source = resolve_workspace_path_to_host(source)

    # Lexical form (.. collapsed, symlinks NOT followed) for the allow-list
    # surface check. Do NOT expand ~ on the lexical form — an unexpanded ~
    # in raw input can point anywhere.
    try:
        lexical = Path(os.path.abspath(os.path.expanduser(source)))
    except (TypeError, ValueError) as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": "source_invalid", "message": "Source path is invalid."},
        ) from exc

    # resolve() collapses .. and follows symlinks so the allow-list check
    # sees the true target, not just the surface path.
    resolved_path = Path(source).expanduser().resolve()
    if not resolved_path.exists():
        # Generic message — leaking the resolved path would expose the service
        # filesystem layout (username, deploy directory, etc.).
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": "source_not_found", "message": "Source file not found."},
        )
    if not resolved_path.is_file():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": "source_not_a_file", "message": "Source is not a regular file."},
        )

    roots: tuple[Path, ...] = ()
    max_bytes = 0
    if redact_cfg is not None:
        roots = getattr(redact_cfg, "source_roots", ())
        max_bytes = int(getattr(redact_cfg, "max_source_bytes", 0) or 0)

    if roots:
        def _under_any(candidate: Path) -> bool:
            for root in roots:
                try:
                    candidate.relative_to(root)
                    return True
                except ValueError:
                    continue
            return False

        if not (_under_any(lexical) and _under_any(resolved_path)):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={
                    "error": "source_outside_allowed_roots",
                    "message": "Source path is not under any configured redact.source_roots entry.",
                },
            )

    if max_bytes > 0:
        try:
            size = resolved_path.stat().st_size
        except OSError as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={"error": "source_stat_failed", "message": "Could not stat source file."},
            ) from exc
        if size > max_bytes:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail={
                    "error": "source_too_large",
                    "message": (
                        f"Source file is {size} bytes, exceeds configured "
                        f"redact.max_source_bytes={max_bytes}."
                    ),
                },
            )

    return resolved_path


def parse_kv_form_string(spec: str) -> dict[str, str]:
    """Parse a ``key=value,key=value`` string into a dict.

    Chunks without ``=`` are silently skipped. Whitespace around keys and
    values is stripped.

    Args:
        spec: Comma-separated ``key=value`` pairs,
            e.g. ``"email=EMAIL, name=PERSON"``.

    Returns:
        dict[str, str]: Mapping of column name to category label.
    """
    out: dict[str, str] = {}
    for chunk in spec.split(","):
        chunk = chunk.strip()
        if "=" not in chunk:
            continue
        key, value = chunk.split("=", 1)
        out[key.strip()] = value.strip()
    return out
