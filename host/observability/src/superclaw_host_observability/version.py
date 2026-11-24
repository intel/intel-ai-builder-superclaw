"""Shared app-version resolver for host services' crash/telemetry reporting.

Resolution order (first hit wins):

1. ``SUPERCLAW_APP_VERSION`` env var - tests, dev, and CI overrides.
2. ``VERSION`` file next to the frozen executable - written by the packaging
   scripts with the full product version (``x.y.z.<Mdd>``). Present in
   PyInstaller onedir builds and installer deployments.
3. The caller's own static ``package_version`` - used during local
   ``uv run`` development, before any VERSION file exists.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path


def resolve_app_version(*, package_version: str, exe_dir: Path | None = None) -> str:
    """Return the resolved product version string.

    ``exe_dir`` defaults to the directory containing ``sys.executable`` when
    running as a frozen PyInstaller build; pass it explicitly in tests.
    """
    env = os.environ.get("SUPERCLAW_APP_VERSION", "").strip()
    if env:
        return env

    if exe_dir is None:
        exe_dir = Path(sys.executable).parent if getattr(sys, "frozen", False) else None

    if exe_dir is not None:
        version_path = exe_dir / "VERSION"
        try:
            # utf-8-sig tolerates a BOM if the VERSION writer added one.
            content = version_path.read_text(encoding="utf-8-sig").strip()
            if content:
                return content
        except OSError:
            pass

    return package_version
