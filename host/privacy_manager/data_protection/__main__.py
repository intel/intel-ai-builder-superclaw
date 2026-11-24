"""Compatibility entrypoint for the frozen privacy_manager bundle.

ServiceHub's dev-mode launch (`-m protection_service.servicehub_entry`) no
longer goes through this module — it used to run as `-m data_protection`
and broke under `pnpm dev` (see PATCHES.md Patch 2). This file now exists
only for the frozen `privacy_manager.exe`: `_pyinstaller_entry.py` loads
it explicitly by file path (not via `-m`), so it still needs to exist here
and re-export `main`. The frozen privacy_manager bundle also includes the
merged llm_pipeline package.
"""

from protection_service.servicehub_entry import main
