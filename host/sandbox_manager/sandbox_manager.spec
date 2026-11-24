# sandbox_manager.spec
# -*- mode: python ; coding: utf-8 -*-
import os
from pathlib import Path

block_cipher = None

# Entry point: _pyinstaller_entry.py (top-level shim that imports sandbox_manager.main:run)
# Using a shim avoids "attempted relative import" errors that occur when
# PyInstaller treats a package module as a top-level script.
a = Analysis(
    ['_pyinstaller_entry.py'],
    pathex=[str(Path('src').resolve())],
    binaries=[],
    datas=[
        # Bundle data/ directory into the onedir root
        ('data', 'data'),
    ],
    hiddenimports=[
        'uvicorn.logging',
        'uvicorn.loops',
        'uvicorn.loops.auto',
        'uvicorn.loops.asyncio',
        'uvicorn.protocols',
        'uvicorn.protocols.http',
        'uvicorn.protocols.http.auto',
        'uvicorn.protocols.http.h11_impl',
        'uvicorn.protocols.websockets',
        'uvicorn.protocols.websockets.auto',
        'uvicorn.lifespan',
        'uvicorn.lifespan.on',
        'uvicorn._types',
        'anyio',
        'anyio._backends._asyncio',
        'wmi',
        'win32api',
        'win32con',
        'win32security',
        'win32crypt',
        'pywintypes',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # The shared host/.venv (built by `uv sync --all-packages`) physically
        # contains every sibling service's dependency stack, and PyInstaller's
        # Analysis runs against that shared venv - so anything without an
        # explicit exclude leaks into this bundle. Checked twice:
        #   1. numpy is absent from sandbox-manager's transitive runtime closure
        #      in host/uv.lock (its dependants there are blis,
        #      llm-pipeline, llmrouter-manager, nncf, onnxruntime, openvino,
        #      optimum, pandas, protection-service, scikit-learn, scipy, spacy,
        #      thinc, transformers, tts-manager - not this service), and
        #   2. nothing in host/sandbox_manager/src imports it.
        # Measured saving: ~26 MB of the 54 MB _internal tree.
        'numpy',
        # Not a real exclusion. PyInstaller appends "__main__" to this very list
        # in place (`excludes += ("__main__",)` in depend/analysis.py mutates the
        # caller's list) and only afterwards writes the finished Analysis guts to
        # Analysis-00.toc. A spec that omits it therefore hands the un-mutated
        # list to the next build, `_check_guts_eq` reports "Building because
        # excludes changed", and the whole module-graph analysis re-runs even when
        # nothing changed. Naming it here makes the two lists identical so the
        # cached analysis is actually reusable.
        '__main__',
    ],
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
    name='sandbox_manager',
    # PyInstaller's run_d bootloader can stall in Py_InitializeFromConfig when
    # a force-killed packaged child is relaunched under local-35B memory pressure.
    # Application-level Debug logging is configured separately and remains on.
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
    strip=False,
    upx=False,
    upx_exclude=[],
    name='sandbox_manager',
)
