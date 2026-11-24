# -*- mode: python ; coding: utf-8 -*-
#
# Merged PyInstaller onedir spec for ServiceHub and the four host services it
# supervises: llmrouter_manager, sandbox_manager, privacy_manager, tts_manager.
#
# Rationale and the role-dispatch contract are documented in
# `_pyinstaller_entry.py`. This file is only about assembling the union.
#
# The output is `superclaw-services.exe` inside the payload directory
# `build\<Configuration>\servicehub\`. The two names are deliberately different: the
# DIRECTORY is what the Rust shell resolves and what the installer synchronizes into
# APPDIR\servicehub, while the IMAGE NAME is what an operator sees five copies of in
# Task Manager, so it names the bundle rather than only its supervisor role. The exe
# also carries a version resource whose FileDescription is "SuperClaw Services",
# which is the string Task Manager shows in place of the image name.
#
# Because ServiceHub and its children are now ONE PyInstaller application rather
# than five independent ones, `child_argv` spawns children as `sys.executable`
# and `ProcessManager` no longer needs the PowerShell broker, `_PYI_*` stripping,
# or the DLL-directory reset that independent sibling apps required.
#
# Every path here is derived from SPECPATH (PyInstaller injects it as the spec's
# own directory). The five original specs each ran with their own service
# directory as cwd and used relative paths like "src/..." or "models/..."; a
# single merged spec has one cwd, so every one of those had to be rebased.

import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path

from PyInstaller.utils.hooks import (
    collect_data_files,
    collect_submodules,
    copy_metadata,
    get_package_paths,
)
from PyInstaller.utils.win32.versioninfo import (
    FixedFileInfo,
    StringFileInfo,
    StringStruct,
    StringTable,
    VarFileInfo,
    VarStruct,
    VSVersionInfo,
)

block_cipher = None


# -- build phase timing ------------------------------------------------------
# build-superclaw.ps1 publishes SUPERCLAW_BUILD_TIMING_DIR, every build script drops
# one JSON row per step into it, and the root script aggregates them into the summary
# table (packaging/installer/build-timing.ps1).
#
# From the shell this entire build is ONE row -- `pyinstaller servicehub` -- and it is
# where most of a Debug build's wall clock goes. Before the merge each service had its
# own build step and therefore its own row; folding the five into one Analysis removed
# every per-service boundary the shell could see, so that row now says nothing about
# which service or which phase spent the time. The boundaries only exist here.
#
# Marks are INTERVALS between successive calls rather than wrappers: spec top-level
# code runs strictly in order, so `_phases.done(label)` attributes everything since
# the previous mark to `label`. That costs one line per boundary instead of
# re-indenting every collection block into a context manager.
#
# Timing must never break a build, so a recording failure is reported and swallowed.
_TIMING_DIR = os.environ.get("SUPERCLAW_BUILD_TIMING_DIR", "").strip()


class _PhaseTimer:
    """Sequential stopwatch writing one timing row per marked interval."""

    def __init__(self, scope: str = "pyinstaller") -> None:
        self._scope = scope
        self._mark = datetime.now(timezone.utc)

    def done(self, label: str) -> None:
        end = datetime.now(timezone.utc)
        seconds = (end - self._mark).total_seconds()
        print(f"[superclaw_services.spec] phase {label}: {seconds:.1f}s")
        if _TIMING_DIR:
            self._write(label, self._mark, end, seconds)
        self._mark = end

    def _write(self, label: str, start: datetime, end: datetime, seconds: float) -> None:
        # Same one-file-per-row contract as Write-BuildTiming: several processes record
        # concurrently, and one file per row needs no cross-process locking.
        record = {
            "label": label,
            "scope": self._scope,
            "status": "ok",
            "processId": os.getpid(),
            "start": start.isoformat(),
            "end": end.isoformat(),
            "seconds": round(seconds, 2),
        }
        name = (
            f"{start:%Y%m%dT%H%M%S}{start.microsecond // 1000:03d}"
            f"-{uuid.uuid4().hex[:8]}.json"
        )
        try:
            directory = Path(_TIMING_DIR)
            directory.mkdir(parents=True, exist_ok=True)
            (directory / name).write_text(json.dumps(record), encoding="utf-8")
        except OSError as exc:
            print(f"[superclaw_services.spec] could not record timing for {label}: {exc}")


_phases = _PhaseTimer()


def _without_tests(name):
    """collect_submodules filter dropping a package's own test suite.

    `collect_submodules("spacy", filter=_without_tests)` returns 916 modules, 350 of them under
    `spacy.tests` -- and every one is handed to Analysis as a hidden import, which
    then parses its bytecode and follows its imports. On disk that tree is only
    1.4 MB (it compiles into the PYZ), so the cost is not size, it is the
    module-graph traversal that dominates a cold build. Nothing at runtime imports
    a package's tests; filtering here is cheaper and quieter than listing them in
    `excludes`, which would leave "hidden import not found" warnings behind.
    """
    return ".tests" not in name and ".test_" not in name and ".conftest" not in name

HOST = Path(SPECPATH).parent
REPO = HOST.parent
SEC = HOST / "privacy_manager" / "data_protection"
PIPE = HOST / "privacy_manager" / "llm_pipeline"
LRM = HOST / "llmrouter_manager"
TTS = HOST / "tts_manager"
ASR = HOST / "asr_manager"
MCPH = HOST / "mcp_host_manager"
SBX = HOST / "sandbox_manager"
HUB = HOST / "servicehub"

for _required in (SEC, PIPE, LRM, TTS, ASR, MCPH, SBX, HUB):
    if not _required.is_dir():
        raise SystemExit(f"[superclaw_services.spec] missing service tree: {_required}")


def _tree(source, destination, *, only_python=False):
    """Expand a source tree into explicit (file, dest_dir) pairs, minus bytecode.

    Handing PyInstaller a directory entry collects EVERY file underneath. For the
    privacy_manager trees, which are live source that developers run pytest
    against, that shipped 86 .pyc files of local build cache into the product and
    -- worse -- put `__pycache__` into `Analysis._input_datas`, whose guts check is
    list equality, so running pytest once invalidated the cached module graph and
    forced a full cold re-analysis. Expanding here keeps both the payload and the
    Analysis cache key a function of the tracked sources only.
    """
    collected = []
    source = Path(source)
    for root, dirs, files in os.walk(source):
        dirs[:] = [d for d in dirs if d != "__pycache__"]
        relative = os.path.relpath(root, source)
        target = destination if relative == "." else os.path.join(destination, relative)
        for name in files:
            if name.endswith((".pyc", ".pyo")):
                continue
            if only_python and not name.endswith(".py"):
                continue
            collected.append((os.path.join(root, name), target))
    return collected


# -- hiddenimports -----------------------------------------------------------
# Union of the four specs. Kept grouped by originating service so a future
# addition lands in the right place and an obsolete entry can be traced back.

_uvicorn_async_plumbing = [
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

# privacy_manager: its packages ship as loose `datas` (not analyzed), so every
# third-party import inside them is invisible to modulegraph.
_security_hidden = [
    "superclaw_host_observability",
    "superclaw_host_observability.log_masking",
    "fastapi",
    "starlette",
    "multipart",
    "rapidfuzz",
    "loguru",
    "pandas",
    "pyarrow",
    "onnxruntime",
    "openvino",
    "transformers",
    "tokenizers",
    "spacy",
] + _uvicorn_async_plumbing

# Lazily imported deep inside assert_xml_parsers_hardened() at service startup.
_security_lazy_pkgs = ("docx", "openpyxl", "httpx", "bs4")
_security_lazy_hidden = []
_security_lazy_datas = []
for _pkg in _security_lazy_pkgs:
    _security_lazy_hidden.extend(collect_submodules(_pkg, filter=_without_tests))
    _security_lazy_datas.extend(collect_data_files(_pkg))
# `_security_hidden` above is a literal list and free; this interval is the lazy
# packages' submodule walk plus everything the spec did before it (path checks).
_phases.done("hiddenimports privacy_manager")

_llmrouter_hidden = (
    collect_submodules("llmrouter_manager", filter=_without_tests)
    + collect_submodules("litellm", filter=_without_tests)
    + collect_submodules("tiktoken_ext", filter=_without_tests)
    + collect_submodules("opentelemetry", filter=_without_tests)
    + collect_submodules("huggingface_hub", filter=_without_tests)
    + [
        "joblib",
        "numpy",
        "scipy",
        "sklearn",
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
        "win32crypt",
        "pywintypes",
        "wmi",
    ]
    + _uvicorn_async_plumbing
)
_phases.done("hiddenimports llmrouter_manager")

_MISAKI_ENGLISH = {"misaki", "misaki.data", "misaki.en", "misaki.token"}

_tts_hidden = (
    collect_submodules("tts_manager", filter=_without_tests)
    + collect_submodules("onnxruntime", filter=_without_tests)
    # Narration is English-only: only the modules misaki.en imports. This leaves
    # out misaki.espeak (its GPL-3.0 espeak-ng backend, which imports phonemizer)
    # and the ja/ko/vi/he/zh G2Ps.
    + collect_submodules("misaki", filter=lambda name: name in _MISAKI_ENGLISH)
    + collect_submodules("spacy", filter=_without_tests)
    + collect_submodules("en_core_web_sm", filter=_without_tests)
    + [
        "numpy",
        "scipy",
        "scipy.io",
        "scipy.io.wavfile",
        "superclaw_host_observability",
        "loguru",
        "click",
        "fastapi",
        "starlette",
        "pydantic",
        "anyio",
    ]
    + _uvicorn_async_plumbing
)
_phases.done("hiddenimports tts_manager")

# asr_manager: Parakeet TDT 0.6B v2 int8 driven through onnxruntime DIRECTLY.
#
# NO sherpa-onnx entry, deliberately -- and this is the one place a reader will
# expect one, because the plan's packaging bullet says "sherpa-onnx and
# onnxruntime DLLs". sherpa-onnx is not a dependency of asr_manager at all: its
# public offline API returns only final text and cannot hand back the encoder
# frame sequence that the ENC pipeline windows and decodes, which is the whole
# point of that pipeline. asr_manager therefore runs the three ONNX graphs
# (encoder/decoder/joiner) itself, and the native payload that has to ship is
# exactly onnxruntime's -- already collected here and by privacy_manager/tts.
# Adding sherpa-onnx would ship a second, unused inference runtime (and a second
# copy of onnxruntime's DLLs) for nothing. onnxruntime's own DLLs
# (onnxruntime.dll / onnxruntime_providers_shared.dll, and the capi extension)
# come in through PyInstaller's onnxruntime hook via these submodules, which is
# how tts_manager and privacy_manager already get them; there is no manual DLL
# list to add.
#
# `numpy` is listed even though it is reached through normal imports: the model
# loader and the mel front end are the only consumers, both behind deferred
# imports in `model_state`, so making it explicit costs nothing and survives a
# refactor of those call sites. torch is NOT here and must never be -- the whole
# bundle's torch exclude (~361 MB) depends on nothing in the workspace pulling it.
_asr_hidden = (
    collect_submodules("asr_manager", filter=_without_tests)
    + collect_submodules("onnxruntime", filter=_without_tests)
    + [
        "numpy",
        "superclaw_host_observability",
        "loguru",
        "fastapi",
        "starlette",
        "anyio",
        # model_state/download reach these lazily: the ENC pipeline and the beam
        # decoder are imported on first model load, and the HF endpoint resolver on
        # first download, so modulegraph sees no static edge from the entry script.
        "asr_manager.recognize.enc_pipeline",
        "asr_manager.recognize.enc_stream",
        "asr_manager.recognize.tdt_beam",
        "llmrouter_manager.local.hf_endpoint",
    ]
    + _uvicorn_async_plumbing
)
_phases.done("hiddenimports asr_manager")

# mcp_host_manager: stdlib (ctypes for the Job and session checks), fastapi, loguru and
# the generated contracts (collected under servicehub below). The CDP relay is a
# WebSocket, and uvicorn resolves its WebSocket protocol from a string at serve time,
# so the protocol module and `websockets` are named rather than left to modulegraph.
_mcp_host_hidden = (
    collect_submodules("mcp_host_manager", filter=_without_tests)
    + collect_submodules("websockets", filter=_without_tests)
    + [
        "superclaw_host_observability",
        "fastapi",
        "starlette",
        "loguru",
        "anyio",
        "uvicorn.protocols.websockets.websockets_sansio_impl",
    ]
    + _uvicorn_async_plumbing
)
_phases.done("hiddenimports mcp_host_manager")

# sandbox_manager contributes a literal list only -- its own modules are reached
# through the analyzed entry script, so there is nothing to collect and no phase.
_sandbox_hidden = [
    "uvicorn._types",
    "anyio",
    "anyio._backends._asyncio",
    "wmi",
    "win32api",
    "win32con",
    "win32security",
    "pywintypes",
] + _uvicorn_async_plumbing

# servicehub: `contracts` is repo source (shared/contracts/generated/python), not a
# third-party wheel, and the Hub reaches parts of both trees dynamically.
_servicehub_hidden = (
    collect_submodules("servicehub", filter=_without_tests)
    + collect_submodules("contracts", filter=_without_tests)
    + ["jsonschema", "httpx", "loguru", "superclaw_host_observability"]
    + _uvicorn_async_plumbing
)
_phases.done("hiddenimports servicehub")

hiddenimports = sorted(
    set(
        _security_hidden
        + _security_lazy_hidden
        + _llmrouter_hidden
        + _tts_hidden
        + _asr_hidden
        + _mcp_host_hidden
        + _sandbox_hidden
        + _servicehub_hidden
        # The dispatcher reaches each role through importlib, which
        # modulegraph cannot follow.
        + [
            "protection_service.servicehub_entry",
            "sandbox_manager.main",
            "servicehub.__main__",
            "asr_manager.__main__",
            "mcp_host_manager.__main__",
        ]
    )
)

# -- datas -------------------------------------------------------------------
# Destination namespaces do NOT collide: privacy_manager owns the bundle root,
# llmrouter_manager owns llmrouter_manager/, tts_manager owns tts_manager/,
# sandbox_manager owns data/.
#
# The PII and finance models are not bundled: privacy_manager downloads them
# into %LOCALAPPDATA%\SuperClaw\privacy_manager\models, verified against
# protection_service/model_manifest.json (shipped below).

datas = (
    # privacy_manager --------------------------------------------------------
    [
        (str(SEC / "__main__.py"), "."),
        (str(SEC / "config.yaml.example"), "."),
    ]
    + _tree(SEC / "common", "common")
    + _tree(SEC / "file_protection", "file_protection")
    + _tree(SEC / "text_protection", "text_protection")
    + _tree(SEC / "protection_service", "protection_service")
    + [
        (str(PIPE / "__init__.py"), "llm_pipeline"),
        (str(PIPE / "__main__.py"), "llm_pipeline"),
    ]
    + _tree(PIPE / "api", "llm_pipeline/api")
    + _tree(PIPE / "utils", "llm_pipeline/utils")
    + _tree(PIPE / "src", "llm_pipeline/src")
    + _security_lazy_datas
    # llmrouter_manager -------------------------------------------------------
    + [
        (str(LRM / "src" / "llmrouter_manager" / "data"), "llmrouter_manager/data"),
        (
            str(LRM / "src" / "llmrouter_manager" / "routing" / "policy" / "model_profiles.json"),
            "llmrouter_manager/routing/policy",
        ),
        (
            str(LRM / "src" / "llmrouter_manager" / "routing" / "policy" / "prompts"),
            "llmrouter_manager/routing/policy/prompts",
        ),
        (
            str(
                LRM
                / "src"
                / "llmrouter_manager"
                / "routing"
                / "auto_router"
                / "latentfactorrouter"
                / "pool_metadata.json"
            ),
            "llmrouter_manager/routing/auto_router/latentfactorrouter",
        ),
    ]
    + collect_data_files("litellm")
    # tts_manager -------------------------------------------------------------
    + [
        (str(TTS / "src" / "tts_manager" / "voices.json"), "tts_manager"),
        # Kokoro phoneme vocabulary; kokoro_helper reads it beside its __file__.
        (str(TTS / "src" / "tts_manager" / "kokoro_vocab.json"), "tts_manager"),
    ]
    # asr_manager -------------------------------------------------------------
    # The dictation clean-up pass reads both of these from disk, relative to
    # `refine/__file__`, so `collect_submodules` does NOT bring them: that
    # collects .py modules only, never package data.
    #
    # The two fail DIFFERENTLY if omitted, which is why both are listed rather
    # than trusting the graceful one to cover the pair:
    #   * `prompts/` is mandatory. `refine.prompt.system_prompt()` raises
    #     PromptError on OSError and the route turns that into a 500 -- so a
    #     build missing it would refine nothing, in the installed app only,
    #     while `uv run` stayed green. Exactly the green-on-build /
    #     broken-when-installed class AGENTS.md §9a exists for.
    #   * `endpoints.json` is optional by design (`refine.providers._measured()`
    #     degrades to {} and routing falls back to the provider's own
    #     balancing), so omitting it would cost latency silently rather than
    #     break anything. Shipped anyway: it is the measured default.
    + [
        (
            str(ASR / "src" / "asr_manager" / "refine" / "prompts"),
            "asr_manager/refine/prompts",
        ),
        (
            str(ASR / "src" / "asr_manager" / "refine" / "endpoints.json"),
            "asr_manager/refine",
        ),
    ]
    + collect_data_files("spacy")
    + collect_data_files("en_core_web_sm")
    # English pronunciation dictionaries only (no ja_words.txt / vi_*.json).
    + collect_data_files("misaki", includes=["data/us_*.json", "data/gb_*.json"])
    + copy_metadata("en_core_web_sm")
    # sandbox_manager ---------------------------------------------------------
    + [
        (str(SBX / "data"), "data"),
    ]
    # servicehub --------------------------------------------------------------
    # service_cfg.json / .schema.json are ALSO copied to the exe-sibling root by
    # build-servicehub.ps1, because `config.default_service_cfg_path` resolves
    # them at `Path(sys.executable).parent` while PyInstaller 6.x puts spec datas
    # under _internal/. Both copies are load-bearing: the bundled one keeps the
    # schema available to a spec-only consumer, the sibling one is what the Hub
    # actually reads.
    + [
        (str(HUB / "service_cfg.json"), "."),
        (str(HUB / "service_cfg.schema.json"), "."),
        (str(REPO / "sandbox" / "agent_config" / "profiles"), "agent-config/profiles"),
    ]
)

# Starts empty and is populated with the OpenVINO runtime libs privacy_manager
# needs below.
binaries = []

# OpenVINO loads its device plugins and format frontends through LoadLibrary at
# runtime, so PyInstaller's static scan never sees them: `import openvino`
# succeeds in the bundle while `Core().available_devices` returns [] and the IR
# .xml cannot even be parsed. privacy_manager's NER/embedding models ship as
# OpenVINO IR, so without these the text pipeline is dead in the packaged build
# no matter what the Python side does (this is issue #1967).
#
# Selected rather than wholesale (`collect_dynamic_libs("openvino")` also misses
# them): `.lib` files are link-time only, the NPU trio is ~86 MB and its compiler
# cannot build these models (it rejects the IR's unbounded dynamic dimensions --
# "Missing upper bound for one or more node"), and the non-IR frontends are for
# reading ONNX/TF/PyTorch/Paddle graphs, which this service never does.
_OPENVINO_RUNTIME_LIBS = (
    "openvino.dll",
    "openvino_c.dll",
    "openvino_ir_frontend.dll",
    "openvino_intel_cpu_plugin.dll",
    "openvino_intel_gpu_plugin.dll",
    "openvino_auto_plugin.dll",
    "openvino_auto_batch_plugin.dll",
    "openvino_hetero_plugin.dll",
)
_openvino_libs_dir = Path(get_package_paths("openvino")[1]) / "libs"
_openvino_collected = []
for _name in _OPENVINO_RUNTIME_LIBS:
    _lib = _openvino_libs_dir / _name
    if not _lib.is_file():
        raise SystemExit(
            f"[superclaw-services] required OpenVINO runtime library missing: {_lib}. "
            "privacy_manager cannot load its OpenVINO IR models without it."
        )
    _openvino_collected.append(_name)
    binaries.append((str(_lib), "openvino/libs"))
# TBB is the threading runtime the plugins link against; ship every variant the
# wheel provides rather than guessing which the plugins resolve.
for _lib in sorted(_openvino_libs_dir.glob("tbb*.dll")):
    _openvino_collected.append(_lib.name)
    binaries.append((str(_lib), "openvino/libs"))
print(
    f"[superclaw-services] collected {len(_openvino_collected)} OpenVINO runtime "
    f"libraries from {_openvino_libs_dir}"
)
# One mark for every service's datas: measured at ~2.9 s total against ~19 s for the
# hiddenimports walks, so splitting it per service would restructure the expression
# (and reorder `datas`, invalidating the Analysis cache once) for no visible signal.
_phases.done("datas + binaries (all services)")

# transformers reaches every one of its ~400 model packages through `if TYPE_CHECKING:`
# imports, which modulegraph follows, and its hook ships each module twice (`pyz+py`).
# privacy_manager only calls AutoTokenizer on its two bundled models, which reaches
# exactly these:
#   * `auto` resolves the class named in tokenizer_config.json;
#   * `bert` defines finance_embedding's BertTokenizer;
#   * `align` is imported on the way to it, because tokenizer_class_from_name walks
#     TOKENIZER_MAPPING_NAMES in order and imports every package whose entry names the
#     class, and align's entry, which comes first, names BertTokenizer too;
#   * `encoder_decoder` is a module-scope import of tokenization_auto.
# pplx-pii-masking's PreTrainedTokenizerFast is the library's own TokenizersBackend, so
# its Qwen3 backbone config is never imported. Guarded by the privacy_manager frozen
# tokenizer smoke.
_TRANSFORMERS_MODELS_KEPT = ("align", "auto", "bert", "encoder_decoder")
_transformers_models_dir = Path(get_package_paths("transformers")[1]) / "models"
for _name in _TRANSFORMERS_MODELS_KEPT:
    if not (_transformers_models_dir / _name / "__init__.py").is_file():
        raise SystemExit(
            f"[superclaw_services.spec] transformers.models.{_name} missing from "
            f"{_transformers_models_dir}; re-trace what AutoTokenizer imports for the "
            "privacy models before changing _TRANSFORMERS_MODELS_KEPT."
        )
_transformers_models_excluded = [
    f"transformers.models.{_entry.name}"
    for _entry in sorted(_transformers_models_dir.iterdir())
    if (_entry / "__init__.py").is_file() and _entry.name not in _TRANSFORMERS_MODELS_KEPT
]
print(
    f"[superclaw_services.spec] excluding {len(_transformers_models_excluded)} "
    f"transformers.models packages, keeping {', '.join(_TRANSFORMERS_MODELS_KEPT)}"
)

a = Analysis(
    [str(Path(SPECPATH) / "_pyinstaller_entry.py")],
    pathex=[
        # privacy_manager's loose-datas packages resolve from the bundle root at
        # runtime; at analysis time its own directory is what makes them findable.
        str(SEC),
        str(LRM / "src"),
        str(TTS / "src"),
        # asr_manager ships no MODEL data: the ~630 MB Parakeet export is
        # downloaded on demand to %LOCALAPPDATA% (never bundled -- that is the whole
        # point of the consent flow), `tokens.txt` arrives with it, and the mel
        # filterbank is computed in numpy rather than loaded. Its only bundled data
        # is the dictation clean-up prompt and endpoint table, in `datas` above.
        str(ASR / "src"),
        str(MCPH / "src"),
        str(SBX / "src"),
        str(HUB / "src"),
        str(REPO / "shared" / "contracts" / "generated" / "python"),
    ],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    # Merging collapses `excludes` to the INTERSECTION of the four original
    # lists, which was empty: numpy is excluded by sandbox but required by the
    # other three, and so on.
    # Every module some spec used to drop was genuinely needed by another
    # service, so the merged bundle is the full union.
    #
    # torch is the exception, and it is excluded below rather than unioned in.
    #
    # What remains below is what NO service needs. Verified absent from
    # host/.venv entirely (so these are purely defensive, matching tts's original
    # intent), or present but with no import edge from any service:
    excludes=[
        # torch (~361 MB, torch_cpu.dll alone ~291 MB) used to be unionable
        # because privacy_manager reached it through optimum.intel, which
        # imports it at module scope. privacy_manager now loads its OpenVINO IR
        # models via openvino.Core directly and optimum is gone, so nothing in
        # any service executes a torch model.
        #
        # The exclude is REQUIRED, not merely tidy: dropping torch from
        # data_protection/pyproject.toml is not sufficient while torch remains
        # installed in host/.venv, because transformers guards its torch imports
        # with `if is_torch_available():` and PyInstaller's module graph follows
        # imports inside `if` blocks without evaluating the condition (see
        # transformers/pipelines/token_classification.py). Without this line the
        # bundle silently keeps all 361 MB.
        #
        # transformers itself still works: only AutoTokenizer is used, which is
        # backed by Rust tokenizers, and spacy's thinc probes torch inside a
        # try/except and degrades to has_torch=False. Both are asserted by the
        # frozen import smoke, which is the authoritative check.
        "torch",
        # optimum/optimum.intel: the only reason torch was ever pulled in.
        "optimum",
        # Absent from host/.venv. tts excluded them defensively; keep that.
        "tensorflow",
        "curated_transformers",
        # spacy-curated-transformers is overridden away at the workspace root
        # (host/pyproject.toml [tool.uv] override-dependencies) so the spacy
        # transformer extras do not drag torch back into the resolution.
        "spacy_curated_transformers",
        # hf_xet (~9 MB): huggingface_hub's optional Xet transfer backend. It is a
        # soft dependency by construction - `is_xet_available()` is a plain
        # `is_package_available("hf_xet")` probe and HF_HUB_DISABLE_XET turns it
        # off explicitly - so absence degrades to ordinary HTTP download, which is
        # what the GGUF downloader in llmrouter_manager/local/downloader.py uses.
        "hf_xet",
        # Test suites and build tooling. spaCy's own hook runs an unfiltered
        # collect_submodules("spacy"), so `spacy.tests` arrives despite `_without_tests`
        # above.
        "spacy.tests",
        "thinc.tests",
        "_pytest",
        "pytest",
        "setuptools",
        # NOTE: `torchgen` is deliberately NOT excluded. It looks unused -- it has
        # no directory under any shipped bundle's `_internal/` -- but that is
        # exactly the false signal the handoff doc warns about: torchgen is a pure
        # Python package, so PyInstaller compiles it into the PYZ inside the exe
        # instead of laying it out on disk. transformers imports it unguarded, and
        # excluding it fails that import with ModuleNotFoundError. It does not
        # import torch, so it survives the torch exclude. Authoritative check is
        # the frozen import smoke, not a directory listing.
        # Not a real exclusion. PyInstaller appends "__main__" to this very list
        # in place (`excludes += ("__main__",)` in depend/analysis.py mutates the
        # caller's list) and only afterwards writes the finished Analysis guts to
        # Analysis-00.toc. A spec that omits it therefore hands the un-mutated
        # list to the next build, `_check_guts_eq` reports "Building because
        # excludes changed", and the whole module-graph analysis re-runs even when
        # nothing changed. Naming it here makes the two lists identical so the
        # cached analysis is actually reusable.
        "__main__",
    ]
    + _transformers_models_excluded,
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)
_phases.done("Analysis (module graph)")

# -- datas post-processing ---------------------------------------------------
# torch is excluded from this bundle (see `excludes` above), so the
# torch-licence flattening that privacy_manager's original spec performed is
# gone with it: there is no `torch-*.dist-info/licenses/third_party` tree left
# to shorten. llmrouter's guardrail_benchmarks rule is orthogonal and survives.
#
# If torch is ever reintroduced, restore the flattening too -- the wheel's
# third-party licence tree is deep enough to blow the installer's legacy
# MAX_PATH budget, which is why it was hashed into `_licenses/torch/` rather
# than dropped.

# Build-time/dev-time-only package data: C/C++/Cython sources and headers, MSVC import
# libraries, .pyi stubs, pyarrow's C++ headers, and litellm's proxy admin UI + swagger.
# Compiled .pyd/.dll/.so never read these. Only `datas` is filtered, never `a.binaries`.
_NON_RUNTIME_SUFFIXES = (
    ".cpp", ".c", ".cc", ".pyx", ".pxd", ".pxi", ".h", ".hpp", ".lib", ".pyi",
)
_NON_RUNTIME_DIRS = (
    "/pyarrow/include/",
    "/litellm/proxy/_experimental/out/",
    "/litellm/proxy/swagger/",
)

_shortened_datas = []
_dropped_benchmarks = 0
_dropped_non_runtime = 0
_dropped_non_runtime_bytes = 0
for _destination, _source, _type_code in a.datas:
    _normalized = "/" + _destination.replace("\\", "/").strip("/") + "/"
    # LiteLLM ships offline guardrail evaluation inputs/results as package data.
    # They are not read at runtime and create unnecessarily deep installer paths.
    if "/guardrail_benchmarks/" in _normalized:
        _dropped_benchmarks += 1
        continue
    _lowered = _normalized.lower()
    if _lowered.rstrip("/").endswith(_NON_RUNTIME_SUFFIXES) or any(
        _dir in _lowered for _dir in _NON_RUNTIME_DIRS
    ):
        _dropped_non_runtime += 1
        if os.path.isfile(_source):
            _dropped_non_runtime_bytes += os.path.getsize(_source)
        continue
    _shortened_datas.append((_destination, _source, _type_code))

print(
    f"[superclaw_services.spec] datas: {len(a.datas)} -> {len(_shortened_datas)} "
    f"(dropped {_dropped_benchmarks} guardrail_benchmarks entries, "
    f"{_dropped_non_runtime} non-runtime source/header/stub/UI entries, "
    f"{_dropped_non_runtime_bytes} raw bytes = {_dropped_non_runtime_bytes / 1e6:.1f} MB)"
)
a.datas = _shortened_datas
_phases.done("datas rewrite (path shortening)")

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)
_phases.done("PYZ (compile pure modules)")

# -- Windows version resource ------------------------------------------------
# Task Manager names a process by its version resource's FileDescription and falls
# back to the image name when there is none -- which is why five identical
# `servicehub.exe` rows were all this bundle showed. FileDescription is what makes
# them read as "SuperClaw Services"; the image name below is the other half.
#
# build-servicehub.ps1 owns the version string and exports it, so the number here
# and the VERSION file it writes cannot drift. A hand-run PyInstaller stamps 0.0.0,
# which is the honest answer for a bundle the build script did not produce.
_version_text = os.environ.get("SUPERCLAW_SERVICES_VERSION", "").strip() or "0.0.0"
_version_parts = [int(part) if part.isdigit() else 0 for part in _version_text.split(".")]
_version_tuple = tuple((_version_parts + [0, 0, 0, 0])[:4])

_version_resource = VSVersionInfo(
    ffi=FixedFileInfo(filevers=_version_tuple, prodvers=_version_tuple),
    kids=[
        StringFileInfo(
            [
                StringTable(
                    # 040904B0 = US English, Unicode -- the codepage Windows reads for
                    # the Task Manager / Details-tab strings.
                    "040904B0",
                    [
                        StringStruct("CompanyName", "Intel"),
                        StringStruct("FileDescription", "SuperClaw Services"),
                        StringStruct("FileVersion", _version_text),
                        StringStruct("InternalName", "superclaw-services"),
                        StringStruct("OriginalFilename", "superclaw-services.exe"),
                        StringStruct("ProductName", "SuperClaw"),
                        StringStruct("ProductVersion", _version_text),
                    ],
                )
            ]
        ),
        VarFileInfo([VarStruct("Translation", [0x0409, 0x04B0])]),
    ],
)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    # Every role runs from THIS image, so the image name is what an operator sees
    # five copies of in Task Manager, in a WER crash report, and in
    # `Get-CimInstance Win32_Process`. `servicehub` named only the supervisor and
    # was actively misleading once the four children moved into the same exe; the
    # role each process is actually serving travels on the command line
    # (`--service <name>`, see _pyinstaller_entry.py).
    #
    # The COLLECT name below stays `servicehub`: it is the payload DIRECTORY, which
    # the Rust shell resolves, the installer synchronizes into APPDIR\servicehub,
    # and the uninstall cleanup removes. Renaming a directory is an installer-upgrade
    # concern, not a legibility one.
    name="superclaw-services",
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
    version=_version_resource,
)
_phases.done("EXE (bootloader + version resource)")

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="servicehub",
)
_phases.done("COLLECT (write bundle tree)")
