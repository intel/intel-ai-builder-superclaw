"""Projection of selected Product Profile bytes into the Connector-owned data root."""

from __future__ import annotations

import os
import hashlib
from pathlib import Path
import shutil
import stat
from uuid import uuid4


class ConnectorProjectionError(RuntimeError):
    pass


def project_connector_search_module(*, profile_root: Path, data_root: Path) -> Path:
    source = profile_root / "tools" / "sc_tavily_search.py"
    _require_plain_chain(profile_root, source)
    _require_plain_file(source)
    destination_dir = data_root / "network_connector" / "superclaw"
    destination_dir.mkdir(parents=True, exist_ok=True)
    _require_plain_chain(data_root, destination_dir)
    destination = destination_dir / source.name
    temporary = destination.with_name(f".{destination.name}.{uuid4().hex}.tmp")
    try:
        shutil.copyfile(source, temporary)
        _require_plain_file(temporary)
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)
    if _sha256(source) != _sha256(destination):
        destination.unlink(missing_ok=True)
        raise ConnectorProjectionError("Connector search module changed during projection")
    return destination


def _require_plain_file(path: Path) -> None:
    try:
        metadata = path.lstat()
    except OSError as exc:
        raise ConnectorProjectionError(f"Connector search module is unavailable: {path}") from exc
    if not stat.S_ISREG(metadata.st_mode) or _is_reparse(path, metadata):
        raise ConnectorProjectionError(f"Connector search module is not a plain file: {path}")


def _require_plain_directory(path: Path) -> None:
    metadata = path.lstat()
    if not stat.S_ISDIR(metadata.st_mode) or _is_reparse(path, metadata):
        raise ConnectorProjectionError(f"Connector projection root is unsafe: {path}")


def _require_plain_chain(root: Path, leaf: Path) -> None:
    try:
        relative = leaf.relative_to(root)
    except ValueError as exc:
        raise ConnectorProjectionError("Connector projection path escapes its governed root") from exc
    current = root
    _require_plain_directory(current)
    for component in relative.parts[:-1]:
        current /= component
        _require_plain_directory(current)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _is_reparse(path: Path, metadata: os.stat_result) -> bool:
    attributes = getattr(metadata, "st_file_attributes", 0)
    reparse = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
    return path.is_symlink() or bool(attributes & reparse)