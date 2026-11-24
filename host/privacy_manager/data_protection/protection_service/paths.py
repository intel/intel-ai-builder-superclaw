"""Cross-platform path resolution for runtime artifacts.

The redacts directory holds path-mode masked CSV files (one per
``/v1/file/redact`` request that asked for ``return_mode: path``). On Windows
we want a writable, per-user, non-roaming location that backup/sync tools
generally leave alone -- that's ``%LOCALAPPDATA%\\protection_service\\redacts``.
On Linux/macOS we follow the XDG convention.
"""

from __future__ import annotations

import logging
import os
import sys
import tempfile
import uuid
from pathlib import Path

logger = logging.getLogger(__name__)

APP_NAME = "protection_service"
SUBDIR = "redacts"
MODELS_DIR_ENV = "SUPERCLAW_PRIVACY_MODELS_DIR"


def default_redacts_dir() -> Path:
    """Resolve a writable per-user redacts directory.

    Resolution order:
        1. ``PII_APP_REDACTS_DIR`` env var (also honored by the CLI flag).
        2. Per-user app data:
             - Windows: ``%LOCALAPPDATA%\\protection_service\\redacts``
             - Linux:   ``$XDG_DATA_HOME/protection_service/redacts`` or
                        ``~/.local/share/protection_service/redacts``
             - macOS:   ``~/Library/Application Support/protection_service/redacts``
        3. Tempdir fallback (``%TEMP%\\protection_service\\redacts``).

    The directory is created on first call. If creation fails (read-only
    FS, permissions), we fall through to the next candidate.
    """
    override = os.environ.get("PII_APP_REDACTS_DIR")
    if override:
        return _ensure_dir(Path(override).expanduser())

    candidate = _platform_appdata_dir()
    if candidate is not None:
        try:
            return _ensure_dir(candidate)
        except OSError:
            pass

    return _ensure_dir(Path(tempfile.gettempdir()) / APP_NAME / SUBDIR)


def _platform_appdata_dir() -> Path | None:
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA")
        if base:
            return Path(base) / APP_NAME / SUBDIR
        return None

    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / APP_NAME / SUBDIR

    xdg = os.environ.get("XDG_DATA_HOME")
    base = Path(xdg) if xdg else Path.home() / ".local" / "share"
    return base / APP_NAME / SUBDIR


def _ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def default_ov_cache_dir() -> Path:
    """Per-user OpenVINO kernel cache directory.

    The service runs unelevated, so a cache next to the installed exe (under
    Program Files) cannot be created on a clean install.
    """
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(base) / "SuperClaw" / "privacy_manager" / "ov_cache"
    return Path(tempfile.gettempdir()) / "SuperClaw-privacy_manager" / "ov_cache"


def default_models_dir() -> Path:
    """Per-user directory the PII and finance models are downloaded into.

    ``SUPERCLAW_PRIVACY_MODELS_DIR`` overrides it. Otherwise it sits next to
    the OpenVINO cache, for the same reason: the installed exe directory is
    not writable by the unelevated service.
    """
    override = (os.environ.get(MODELS_DIR_ENV) or "").strip()
    if override:
        return Path(override).expanduser()
    return default_ov_cache_dir().parent / "models"


def resolve_ov_cache_dir(configured: str | None, exe_dir: Path) -> Path | None:
    """Return a writable OpenVINO cache directory, or ``None`` for no cache.

    ``configured`` unset means ``default_ov_cache_dir()``; a relative value
    resolves against ``exe_dir``. A directory that cannot be created or
    written returns ``None``: OpenVINO then recompiles each launch, which is
    slower but keeps the NER model, whereas handing it the directory makes
    the model load fail.
    """
    path = Path(configured) if configured else default_ov_cache_dir()
    if not path.is_absolute():
        path = exe_dir / path
    # Not tempfile: on Windows its retry loop treats a denied create in an
    # existing directory as a name collision and never gives up.
    probe = path / f".write-probe-{uuid.uuid4().hex}"
    try:
        path.mkdir(parents=True, exist_ok=True)
        probe.open("xb").close()
        probe.unlink()
    except OSError as exc:
        logger.warning(
            "OpenVINO cache dir %s is not writable (%s); loading without a cache",
            path, exc.__class__.__name__,
        )
        return None
    return path
