# -*- mode: python ; coding: utf-8 -*-
#
# PyInstaller onedir spec for the ``privacy_manager`` service.
#
# privacy_manager is an umbrella exe for SuperClaw's security capabilities.
# Today it hosts:
#   * data_protection — vendored DPS (file redaction + text sanitize),
#     served under proxy prefix /data-protection on port 18826
#   * llm_pipeline — LLM-driven file-protection pipeline, folded
#     in as the /v1/file/llm-pipeline route (PR 3)
# Additional security features will land inside this same exe; each will
# register its own route surface on the same port.
#
# Bundles the DPS python packages plus the OpenVINO IR models under
# models/. Models arrive here via LFS at repo checkout time; if the
# .bin blobs are missing (LFS not initialised), the build still produces
# an exe but text-sanitize will refuse to load its NER model at boot.

import hashlib
import os
from pathlib import Path

from PyInstaller.config import CONF
from PyInstaller.utils.hooks import collect_submodules, collect_data_files

block_cipher = None


def _collect_python_tree(source, destination):
    """Expand a source tree into explicit (file, dest_dir) pairs, minus bytecode.

    Handing PyInstaller a directory entry such as ``("common", "common")`` makes
    it collect EVERY file underneath, and the vendored packages below are live
    source trees that developers run pytest against. That had two consequences,
    both measured:

    1. A developer's local ``__pycache__`` shipped into the product - 86 .pyc
       files / 763 KB of someone's build cache, with no runtime purpose (CPython
       validates the source mtime/size before using a cached .pyc, so a stale one
       is simply recompiled).
    2. Worse, the build stopped being reproducible. The expanded file list lands
       in ``Analysis._input_datas``, whose guts check is list equality, so a
       ``__pycache__`` directory appearing or changing invalidated the cached
       module graph and forced the full ~97 s re-analysis. Running pytest once
       under host/privacy_manager was enough to make the next build cold.

    Expanding the trees here keeps both the payload and the Analysis cache key a
    function of the tracked sources only.
    """
    collected = []
    for root, dirs, files in os.walk(source):
        dirs[:] = [d for d in dirs if d != "__pycache__"]
        relative = os.path.relpath(root, source)
        target = destination if relative == "." else os.path.join(destination, relative)
        for name in files:
            if name.endswith((".pyc", ".pyo")):
                continue
            collected.append((os.path.join(root, name), target))
    return collected


# Third-party packages whose submodules are imported lazily (inside functions)
# and therefore missed by PyInstaller's static scan. `python-docx` and
# `openpyxl` are imported deep-inside assert_xml_parsers_hardened() at
# service startup; without a full submodule sweep boot fails with
# ModuleNotFoundError.
_lazy_deep_pkgs = ("docx", "openpyxl", "httpx", "bs4")
_extra_hidden = []
_extra_datas = []
for _pkg in _lazy_deep_pkgs:
    _extra_hidden.extend(collect_submodules(_pkg))
    _extra_datas.extend(collect_data_files(_pkg))

a = Analysis(
    ["_pyinstaller_entry.py"],
    pathex=["."],
    binaries=[],
    datas=[
        # Entry / module files.
        ("__main__.py", "."),
        ("config.yaml.example", "."),
        # The OpenVINO IR models are downloaded at runtime, verified against
        # protection_service/model_manifest.json.
    ]
    # Vendored DPS packages. Expanded file-by-file rather than as directory
    # entries so a developer's __pycache__ neither ships nor invalidates the
    # Analysis cache - see _collect_python_tree.
    + _collect_python_tree("common", "common")
    + _collect_python_tree("file_protection", "file_protection")
    + _collect_python_tree("text_protection", "text_protection")
    + _collect_python_tree("protection_service", "protection_service")
    # LLM pipeline folded into this exe. Bundle the package root files plus
    # sub-packages under the 'llm_pipeline/' destination so 'from llm_pipeline...'
    # imports work at runtime via sys._MEIPASS.
    + [
        ("../llm_pipeline/__init__.py", "llm_pipeline"),
        ("../llm_pipeline/__main__.py", "llm_pipeline"),
    ]
    + _collect_python_tree("../llm_pipeline/api", "llm_pipeline/api")
    + _collect_python_tree("../llm_pipeline/utils", "llm_pipeline/utils")
    + _collect_python_tree("../llm_pipeline/src", "llm_pipeline/src")
    + _extra_datas,
    hiddenimports=[
        # superclaw_host_observability is imported inside main() for crash hook
        # installation; PyInstaller's static analysis cannot see function-body
        # imports, so it must be listed explicitly here.
        "superclaw_host_observability",
        # protection_service/server.py, common/, file_protection/ and
        # text_protection/ are bundled as loose `datas` (not analyzed by
        # PyInstaller's Analysis), so their third-party imports are invisible
        # to modulegraph and must be listed explicitly here.
        "fastapi",
        "starlette",
        "multipart",
        # file_protection/rewrite.py imports rapidfuzz for its opt-in fuzzy
        # query-rewrite tier; same "loose datas, invisible to modulegraph"
        # reasoning as fastapi/starlette above.
        "rapidfuzz",
        # llm_pipeline/utils/logger.py imports loguru directly; also
        # bundled as loose `datas`, so it's invisible to modulegraph too.
        "loguru",
        # uvicorn's async plumbing — same list llm_pipeline uses.
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
        # File backend deps. docx/openpyxl/httpx/bs4 are swept in via
        # collect_submodules above (they import submodules lazily inside
        # function bodies, so PyInstaller's static scan misses them).
        "pandas",
        "pyarrow",
        # Text backend -- ONNX/OpenVINO stack.
        "onnxruntime",
        "openvino",
        "transformers",
        "tokenizers",
        "spacy",
    ] + _extra_hidden,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # The shared host/.venv (built by `uv sync --all-packages`) physically
        # contains every sibling service's dependency stack, and PyInstaller's
        # Analysis runs against that shared venv — so anything without an
        # explicit exclude leaks into this bundle. Each entry below was checked
        # twice:
        #   1. absent from the protection-service + llm-pipeline transitive
        #      runtime closure in host/uv.lock (following `dependencies` +
        #      requested extras, never dev-dependencies), and
        #   2. zero references in host/privacy_manager (recursive grep).
        # Measured saving: 59.9 MB of the 1205 MB _internal tree.
        #
        # jieba (~30 MB): no longer in host/uv.lock (it came in via misaki[zh],
        # dropped from tts_manager in #3724); kept as a defensive exclude for a
        # stale venv. The spaCy NER fallback here loads en_core_web_sm and is
        # hard-gated to English (see common/textlang.py and the
        # redact_spacy_english_only / text_spacy_english_only config defaults);
        # non-English PII is covered by the multilingual OpenVINO/ONNX NER, which
        # does not tokenize through jieba. No Chinese spaCy pipeline is ever
        # loaded, so jieba has no runtime entry point.
        "jieba",
        # babel (~29 MB): reachable only via segments -> csvw -> babel, none of
        # which are in this closure.
        "babel",
        # tiktoken: declared by litellm / llmrouter-manager, not by this service.
        "tiktoken",
        # Not a real exclusion. PyInstaller appends "__main__" to this very list
        # in place (`excludes += ("__main__",)` in depend/analysis.py mutates the
        # caller's list) and only afterwards writes the finished Analysis guts to
        # Analysis-00.toc. A spec that omits it therefore hands the un-mutated
        # list to the next build, `_check_guts_eq` reports "Building because
        # excludes changed", and the whole 114 s module-graph analysis re-runs
        # even when nothing changed. Naming it here makes the two lists identical
        # so the cached analysis is actually reusable. Empty-excludes specs are
        # immune because `excludes or ()` turns [] into a tuple, which `+=`
        # copies instead of mutating.
        "__main__",
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

# PyInstaller's torch hook preserves the wheel's complete third-party license
# tree under ``torch-<version>.dist-info/licenses/third_party``. Advanced
# Installer first extracts LZMA payloads below a per-user staging directory;
# preserving the nested Kineto tree can therefore exceed legacy MAX_PATH even
# when the final Program Files path would fit. Keep every license file, flatten
# it under a stable hash, and emit a manifest mapping it to the original path.
_shortened_datas = []
_license_manifest = []
for _destination, _source, _type_code in a.datas:
    _parts = _destination.replace("\\", "/").split("/")
    if (
        len(_parts) >= 4
        and _parts[0].startswith("torch-")
        and _parts[0].endswith(".dist-info")
        and _parts[1:3] == ["licenses", "third_party"]
    ):
        _original_destination = _destination.replace("\\", "/")
        _digest = hashlib.sha256(_original_destination.encode("utf-8")).hexdigest()[:16]
        _destination = f"_licenses/torch/{_digest}-{_parts[-1]}"
        _license_manifest.append(f"{_destination}\t{_original_destination}")
    _shortened_datas.append((_destination, _source, _type_code))

if _license_manifest:
    _manifest_path = Path(CONF["workpath"]) / "torch-third-party-licenses.txt"
    _manifest_path.parent.mkdir(parents=True, exist_ok=True)
    _manifest_path.write_text(
        "Packaged path\tOriginal wheel path\n" + "\n".join(sorted(_license_manifest)) + "\n",
        encoding="utf-8",
    )
    _shortened_datas.append(
        ("_licenses/torch/MANIFEST.txt", str(_manifest_path), "DATA")
    )
a.datas = _shortened_datas

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="privacy_manager",
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
    name="privacy_manager",
)
