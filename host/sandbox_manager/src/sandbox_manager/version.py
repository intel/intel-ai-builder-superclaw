"""Runtime app-version resolver.

Resolution order (first hit wins):

1. ``SUPERCLAW_APP_VERSION`` env var — for tests, dev, and CI overrides.
2. ``VERSION`` file next to the executable — written by build-sandbox-manager.ps1
   with the full product version (``x.y.z.<Mdd>``).  Present in PyInstaller
   onedir builds and installer deployments.
3. ``sandbox_manager.__version__`` — static base version from pyproject.toml;
   used during local ``uv run`` development.
"""

from __future__ import annotations

from superclaw_host_observability import resolve_app_version

from . import __version__ as _BASE_VERSION

_cached: str | None = None


def get_app_version() -> str:
    """Return the resolved app version string.

    The result is cached after the first call because none of the sources
    change during a process lifetime.
    """
    global _cached
    if _cached is not None:
        return _cached
    _cached = resolve_app_version(package_version=_BASE_VERSION)
    return _cached
