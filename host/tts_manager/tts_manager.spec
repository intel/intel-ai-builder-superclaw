# -*- mode: python ; coding: utf-8 -*-
#
# PyInstaller onedir spec for the ``tts_manager`` service.
#
# tts_manager is the native-Windows-host Kokoro-82M TTS narration service, a
# ServiceHub child served under proxy prefix /tts-narration on port 18827. Native
# host synthesis is RTF ~0.35.
#
# Inference runs on onnxruntime, driven by kokoro_helper.py — NO PyTorch, and no
# kokoro-onnx (it imports the GPL-3.0 phonemizer/espeak-ng stack). The transformer
# POS-tagger chain (spacy-curated-transformers -> curated-transformers -> torch) is
# an optional misaki path reached only by en.G2P(trf=True); kokoro_helper.py uses
# trf=False, and the workspace root pins those two packages to
# `sys_platform == 'never'`, so torch never enters the closure.
#
# BUT the host uv workspace is shared: privacy_manager pins CPU `torch` (plus
# `transformers`, `tensorflow`, `sklearn`), so those packages are physically
# present in host/.venv. `excludes=[...]` below keeps torch's *module graph* out,
# and hook-torch.py confirmed-absent proves torch's code/binaries are not
# collected. The subtle trap is metadata: `hook-transformers.py` walks
# transformers' dependency table and `copy_metadata('torch')`s the
# torch-*.dist-info folder — including torch's deeply nested bundled third-party
# license tree — straight into a.datas, which `excludes` does NOT prevent. That
# path (…\torch-*.dist-info\licenses\third_party\kineto\…\duktape-1.5.2) blows
# past Windows MAX_PATH and fails the build with WinError 206. So we (1) exclude
# the whole unused ML stack (transformers/tensorflow/sklearn/torch*) so their
# metadata-copying hooks never run, and (2) defensively strip any leftover
# torch/transformers/tensorflow *.dist-info entries from a.datas after Analysis.
#
# The ~350 MB Kokoro model (kokoro-v1.0.onnx + voices-v1.0.bin) is intentionally
# NOT bundled: it is consent-downloaded at runtime to a host dir
# (%LOCALAPPDATA%\SuperClaw\kokoro). Only voices.json (the small voice registry)
# ships in the bundle.

from pathlib import Path

from PyInstaller.utils.hooks import (
    collect_data_files,
    collect_submodules,
    copy_metadata,
)


block_cipher = None

hiddenimports = (
    collect_submodules("tts_manager")
    # ONNX runtime: lazy backend/session paths need explicit collection in a
    # frozen bundle.
    + collect_submodules("onnxruntime")
    # misaki English G2P only — narration is English-only. This leaves out
    # misaki.espeak (its GPL-3.0 espeak-ng backend, which imports phonemizer) and
    # the ja/ko/vi/he/zh G2Ps.
    + collect_submodules(
        "misaki",
        filter=lambda name: name in {"misaki", "misaki.data", "misaki.en", "misaki.token"},
    )
    # spaCy + the bundled English pipeline (en_core_web_sm) load their factories
    # and language data via dynamic imports / entry_points.
    + collect_submodules("spacy")
    + collect_submodules("en_core_web_sm")
    + [
        "numpy",
        "scipy",
        "scipy.io",
        "scipy.io.wavfile",
        # superclaw_host_observability is imported for crash-hook installation
        # inside run(); PyInstaller cannot see the function-body import.
        "superclaw_host_observability",
        "loguru",
        "click",
        "fastapi",
        "starlette",
        "pydantic",
        "anyio",
        # uvicorn's async plumbing (same explicit list the other host children use).
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
    ]
)

datas = (
    [
        # Voice registry read at runtime by voices.load_voices() at
        # tts_manager/voices.json (sibling of voices.py). Non-code file, so it
        # must be declared here to land in the bundle.
        ("src/tts_manager/voices.json", "tts_manager"),
        # Kokoro phoneme vocabulary; kokoro_helper reads it beside its __file__.
        ("src/tts_manager/kokoro_vocab.json", "tts_manager"),
    ]
    # spaCy language data + the en_core_web_sm model files (config, vocab, ner,
    # tok2vec, etc). Without these the English G2P loses its pipeline at runtime,
    # so an English synth in the packaged smoke test is the canary for a miss here.
    + collect_data_files("spacy")
    + collect_data_files("en_core_web_sm")
    # English pronunciation dictionaries only (no ja_words.txt / vi_*.json).
    + collect_data_files("misaki", includes=["data/us_*.json", "data/gb_*.json"])
    # en_core_web_sm dist-info metadata. misaki's English G2P (en.py) guards its
    # spacy.load with `if not spacy.util.is_package("en_core_web_sm"):
    # spacy.cli.download(...)`. is_package() calls importlib.metadata.distribution(),
    # which needs the *.dist-info folder — collect_data_files brings the model DATA
    # but NOT its metadata, so in the frozen bundle is_package() returns False and
    # misaki tries to pip/spacy-DOWNLOAD the 12 MB model over the network. On the
    # Intel proxy that DNS lookup hangs, freezing the model load at "loading" with
    # no error. Copying the metadata makes is_package() True → download is skipped.
    + copy_metadata("en_core_web_sm")
)

# No dynamic libraries are collected beyond what the hooks find.
binaries = []

a = Analysis(
    ["_pyinstaller_entry.py"],
    pathex=[str(Path("src").resolve())],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    # The shared host/.venv physically contains torch + the rest of
    # privacy_manager's ML stack. tts_manager uses none of it (onnxruntime +
    # misaki G2P(trf=False) + the tok2vec en_core_web_sm model). Excluding these
    # keeps their module graphs out AND stops their PyInstaller hooks (notably
    # hook-transformers.py's copy_metadata('torch')) from ever running. See the
    # header comment for why the metadata copy — not the module — is the failure.
    excludes=[
        "torch",
        "torchgen",
        "transformers",
        "tensorflow",
        "sklearn",
        "curated_transformers",
        "spacy_curated_transformers",
        # pandas (~13 MB) + pyarrow (~81 MB) are llmrouter_manager's deps, NOT
        # tts_manager's — they are absent from this service's dependency closure
        # (verified: nothing in tts_manager's code or its transitive deps —
        # spacy/thinc/misaki/… — does an unguarded import of
        # either). They only exist physically in the SHARED host/.venv, and
        # PyInstaller's stdlib hooks (hook-pandas.py, hook-pyarrow.py) plus a
        # guarded optional import edge pull ~94 MB of Apache Arrow / pandas into
        # the bundle for no runtime benefit. Excluding them keeps their module
        # graphs (and those hooks) out. Any real dependant would fail its lock
        # here, not at runtime — tts_manager has none.
        "pandas",
        "pyarrow",
        # lxml (~7 MB): reachable only via python-docx, a protection-service
        # dependency. It is absent from tts_manager's transitive runtime closure
        # in host/uv.lock (python-docx is its sole dependant there), and nothing
        # in this service's code imports it. Same "shared venv leaks into the
        # bundle" mechanism as pandas / pyarrow above.
        "lxml",
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

# Belt-and-suspenders: even with the excludes above, a stray hook could still
# copy_metadata() one of the unused ML packages. Drop any *.dist-info / egg-info
# data entry belonging to torch/transformers/tensorflow so their nested
# third-party license trees can never re-introduce the WinError 206 path blow-up.
# Matches the DEST path (first tuple element) case-insensitively.
_METADATA_PREFIXES = ("torch", "transformers", "tensorflow")


def _is_unused_ml_metadata(dest: str) -> bool:
    head = dest.replace("\\", "/").split("/", 1)[0].lower()
    if not (head.endswith(".dist-info") or head.endswith(".egg-info")):
        return False
    name = head.rsplit("-", 1)[0] if "-" in head else head
    name = name.rsplit(".", 1)[0]
    return name.startswith(_METADATA_PREFIXES)


_before = len(a.datas)
a.datas = [entry for entry in a.datas if not _is_unused_ml_metadata(entry[0])]
_removed = _before - len(a.datas)
if _removed:
    print(f"[tts_manager.spec] stripped {_removed} unused-ML metadata data entr"
          f"{'y' if _removed == 1 else 'ies'} (torch/transformers/tensorflow)")

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="tts_manager",
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
    name="tts_manager",
)
