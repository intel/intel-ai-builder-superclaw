# -*- mode: python ; coding: utf-8 -*-
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_submodules


block_cipher = None

hiddenimports = (
    collect_submodules("llmrouter_manager")
    + collect_submodules("litellm")
    + collect_submodules("tiktoken_ext")
    # opentelemetry registers providers/exporters/samplers via entry_points at
    # runtime; PyInstaller static analysis cannot follow these dynamic lookups,
    # so we collect all submodules and enumerate the OTLP exporter targets used
    # directly in telemetry/runtime.py.
    + collect_submodules("opentelemetry")
    # huggingface_hub (local/downloader.py) has lazy backend paths that need
    # explicit collection in a frozen bundle.
    + collect_submodules("huggingface_hub")
    + [
        "joblib",
        "numpy",
        "scipy",
        "sklearn",
        # opentelemetry entry_points targets (sdk + otlp exporters)
        "opentelemetry.sdk.trace",
        "opentelemetry.sdk.trace.export",
        "opentelemetry.sdk.trace.sampling",
        "opentelemetry.sdk._logs",
        "opentelemetry.sdk._logs.export",
        "opentelemetry.sdk.metrics",
        "opentelemetry.sdk.metrics.export",
        "opentelemetry.sdk.resources",
        "opentelemetry.exporter.otlp.proto.http.trace_exporter",
        "opentelemetry.exporter.otlp.proto.http._log_exporter",
        "opentelemetry.exporter.otlp.proto.http.metric_exporter",
        "uvicorn.logging",
        "uvicorn.loops",
        "uvicorn.loops.auto",
        "uvicorn.loops.asyncio",
        "uvicorn.protocols",
        "uvicorn.protocols.http",
        "uvicorn.protocols.http.auto",
        "uvicorn.protocols.http.h11_impl",
        "uvicorn.protocols.websockets",
        "uvicorn.protocols.websockets.auto",
        "uvicorn.lifespan",
        "uvicorn.lifespan.on",
        "win32crypt",
        "pywintypes",
        # wmi is a pyproject.toml explicit dep (local/hardware.py hardware probe);
        # COM-based, not auto-discovered by PyInstaller.
        "wmi",
    ]
)

a = Analysis(
    ["_pyinstaller_entry.py"],
    pathex=[str(Path("src").resolve())],
    binaries=[],
    datas=[
        ("src/llmrouter_manager/data", "llmrouter_manager/data"),
        # Serving-policy data assets read at runtime by routing/policy/
        # (model_profiles.json + prompts/*.txt for the model-aware transform).
        # These are non-code files, so PyInstaller needs them declared here.
        (
            "src/llmrouter_manager/routing/policy/model_profiles.json",
            "llmrouter_manager/routing/policy",
        ),
        (
            "src/llmrouter_manager/routing/policy/prompts",
            "llmrouter_manager/routing/policy/prompts",
        ),
        # Trained-artefact companion consumed by the auto-router's
        # LatentFactorRouter (defines the local panel + capability scaling).
        # Without this the router falls back to empty _LOCAL_MODELS at runtime,
        # so _match_local_alias returns None for every configured model and
        # the "configured local model ... did not match" warning fires on
        # every route, disabling local exclusions.
        (
            "src/llmrouter_manager/routing/auto_router/latentfactorrouter/pool_metadata.json",
            "llmrouter_manager/routing/auto_router/latentfactorrouter",
        ),
    ]
    + collect_data_files("litellm"),
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    # The shared host/.venv (built by `uv sync --all-packages`) physically
    # contains every sibling service's dependency stack, and PyInstaller's
    # Analysis runs against that shared venv — so anything without an explicit
    # exclude leaks into this bundle. Each entry below was checked twice:
    #   1. absent from llmrouter-manager's transitive runtime closure in
    #      host/uv.lock (following `dependencies` + requested extras, never
    #      dev-dependencies), and
    #   2. zero references in host/llmrouter_manager/src (recursive grep).
    # Measured saving: ~151 MB of the 422 MB _internal tree.
    excludes=[
        # torch: llmrouter-lib is installed --no-deps (#825); the inference path
        # is stubbed by routing/auto_router/_runtime_stubs.py.
        "torch",
        # pyarrow (~80 MB): declared by protection-service / llm-pipeline for
        # .parquet IO. pandas here is used for plain DataFrame work only.
        "pyarrow",
        # transformers (~35 MB): declared by protection-service. This service
        # declares `tokenizers` alone.
        "transformers",
        # babel (~29 MB): reachable only via segments -> csvw -> babel, none of
        # which are in this closure.
        "babel",
        # lxml (~7 MB): pulled by python-docx, a protection-service dependency.
        "lxml",
        # safetensors: pulled by transformers / optimum-intel, neither declared
        # here.
        "safetensors",
        # Not a real exclusion. PyInstaller appends "__main__" to this very list
        # in place (`excludes += ("__main__",)` in depend/analysis.py mutates the
        # caller's list) and only afterwards writes the finished Analysis guts to
        # Analysis-00.toc. A spec that omits it therefore hands the un-mutated
        # list to the next build, `_check_guts_eq` reports "Building because
        # excludes changed", and the whole module-graph analysis re-runs even when
        # nothing changed. Naming it here makes the two lists identical so the
        # cached analysis is actually reusable.
        "__main__",
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)
def _is_runtime_data(data):
    destination = "/" + data[0].replace(chr(92), "/").strip("/") + "/"
    return (
        not data[0].startswith("torch-")
        # LiteLLM ships offline guardrail evaluation inputs/results as package
        # data. They are not read by the runtime and create unnecessarily deep
        # installer paths, so keep them out of the production onedir bundle.
        and "/guardrail_benchmarks/" not in destination
    )


a.datas = [data for data in a.datas if _is_runtime_data(data)]
pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="llmrouter_manager",
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
    name="llmrouter_manager",
)
