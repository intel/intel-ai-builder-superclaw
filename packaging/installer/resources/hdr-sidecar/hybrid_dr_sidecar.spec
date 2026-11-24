# -*- mode: python ; coding: utf-8 -*-

from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_submodules


block_cipher = None

package_root = Path("src").resolve()

hiddenimports = []
for package in (
    "hybrid_dr_orchestrator",
    "uvicorn",
    "anyio",
    "ddgs",
    "langgraph",
    "langchain_core",
):
    hiddenimports.extend(collect_submodules(package))

datas = collect_data_files(
    "hybrid_dr_orchestrator",
    includes=["pipeline_config.json", "prompts/*.md"],
)

a = Analysis(
    ["src/hybrid_dr_orchestrator/__main__.py"],
    pathex=[str(package_root)],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["pytest", "mypy", "ruff", "readline"],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="hybrid-dr-sidecar",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    # Strip debug symbols from collected C extensions while retaining dynamic
    # symbols required for imports and dlopen.
    strip=True,
    upx=False,
    upx_exclude=[],
    name="hybrid-dr-sidecar",
)
