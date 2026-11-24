r"""Single-exe role dispatch entry for ServiceHub and the services it supervises.

Why one exe
-----------
`host/.venv` is a single shared venv (`uv sync --all-packages`), so PyInstaller's
Analysis runs against every sibling service's dependency stack no matter which
spec is building. Separate onedir bundles therefore each carry their own copy of
the shared stack; folding the four children into one bundle measured 2302 MB ->
1450 MB (853 MB, 37%). Collecting the union once is what removes that.

Folding ServiceHub itself in buys something different and larger: parent and
children stop being independent PyInstaller applications. `ProcessManager` no
longer needs the PowerShell broker, the `_PYI_*` environment stripping, or the
process-wide DLL-directory reset that launching a foreign frozen app required.

The exe is named `superclaw-services.exe`
----------------------------------------
Every role runs from this one image, so the image name is what an operator sees several
copies of in Task Manager, in a WER crash report and in `Get-CimInstance
Win32_Process`. `servicehub.exe` named only the supervisor and became misleading once
the four children moved into the same exe. The exe also carries a version resource
whose FileDescription is "SuperClaw Services", which is the string Task Manager
prefers over the image name.

The payload DIRECTORY is still `servicehub\`: the Rust shell resolves the Hub inside
it (`apps/desktop/src-tauri/src/servicehub/mod.rs`), the installer synchronizes it
into `APPDIR\servicehub`, and the uninstall cleanup removes it. `service_cfg.json`'s
`launch.exe_name` must name the exe exactly -- `ProcessManager.child_argv` refuses to
re-exec an image whose name disagrees with it, so the two are changed together.

Role selection
--------------
1. `--service <name>` on the command line (what ServiceHub passes).
2. else the `SERVICEHUB_SERVICE_NAME` environment variable, which announces itself
   on stderr because reaching it means an inherited variable chose the role.
3. else `servicehub` -- the default, so a bare `superclaw-services.exe --port 0` from
   the Rust shell behaves exactly as it did before the children were folded in.

It is NEVER keyed on `argv[0]`, which is the same string for every role.

The command line is the identity signal of record because it is the only one the
operating system will show anyone. Every role shares one image path AND one image
name, so `superclaw-services.exe` in Task Manager, a WER crash report, or
`Get-CimInstance Win32_Process` is indistinguishable across roles unless the role
is IN the command line -- environment variables are not visible to any of those.
Putting it on argv is also what lets a developer or a support engineer start one
role by hand (`superclaw-services.exe --service sandbox_manager --port 18821`), which
an env-only contract makes impossible without first mutating the shell. This mirrors
`chrome.exe --type=renderer`.

`--service` is CONSUMED here and never forwarded: each service's own entrypoint
calls `argparse.parse_args()` with no argv, so a leftover `--service` would abort
it with "unrecognized arguments". Stripping it in the dispatcher is what keeps all
five entrypoints byte-for-byte unchanged -- including ServiceHub's own flags such
as `--contracts-import-smoke`, which still work on a bare invocation.
"""
from __future__ import annotations

import importlib
import multiprocessing
import os
import sys
from pathlib import Path

# privacy_manager's packages (common, file_protection, text_protection,
# protection_service, llm_pipeline) are collected as loose `datas` rather than
# analyzed modules, so they are only importable with the bundle root on sys.path.
# PyInstaller's bootstrap puts sys._MEIPASS there itself, but stating it keeps the
# source/dev invocation working too, and makes the dependency explicit rather than
# relying on bootstrap ordering.
ROOT = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


# service name -> (module, callable). The names are exactly `service_cfg.json`'s
# `name` field, which is what ServiceHub exports as SERVICEHUB_SERVICE_NAME.
_SERVICES: dict[str, tuple[str, str]] = {
    # ServiceHub is the DEFAULT role: the Rust shell still launches this exe with no
    # role flag, so a bare invocation must behave exactly as it did before the four
    # children were folded in.
    "servicehub": ("servicehub.__main__", "run"),
    "llmrouter_manager": ("llmrouter_manager.__main__", "run"),
    "sandbox_manager": ("sandbox_manager.main", "run"),
    "tts_manager": ("tts_manager.__main__", "run"),
    "asr_manager": ("asr_manager.__main__", "run"),
    "mcp_host_manager": ("mcp_host_manager.__main__", "run"),
    # privacy_manager's `__main__.py` is a one-line shim that re-exports exactly
    # this symbol. The old entry loaded that shim through
    # `spec_from_file_location` only because the entry script itself WAS the
    # process's `__main__` module, so `from __main__ import main` resolved back to
    # itself. A dispatcher has no such collision, so import the real module.
    "privacy_manager": ("protection_service.servicehub_entry", "main"),
}

_DEFAULT_SERVICE = "servicehub"


# Per-service frozen-import smoke targets: (import target, the `excludes` entry it
# proves safe). Merging the four bundles means `excludes` collapses to the
# intersection of the four lists, so every module a single spec used to exclude is
# now present -- these assertions are what catch a merge that silently dropped
# something instead of surfacing it on a user's machine.
_SMOKE_TARGETS: dict[str, tuple[tuple[str, str | None], ...]] = {
    "servicehub": (
        ("servicehub.__main__", None),
        ("servicehub.app", None),
        ("servicehub.supervisor.process_manager", None),
        # The Hub pre-reads both providers' persisted keys through their owners'
        # readers; a bundle missing either only loses the early sandbox start.
        ("llmrouter_manager.common.inference_key", None),
        ("protection_service.data_plane_key", None),
        ("jsonschema", None),
    ),
    "privacy_manager": (
        ("protection_service.servicehub_entry", None),
        ("text_protection.sanitizer", None),
        ("spacy", None),
        ("protection_service.server", None),
        ("onnxruntime", None),
        ("openvino", None),
        ("transformers", None),
        ("pandas", None),
        ("pyarrow", None),
        ("docx", None),
        ("openpyxl", None),
        ("bs4", None),
    ),
    "llmrouter_manager": (
        ("llmrouter_manager.__main__", None),
        ("llmrouter_manager.routing.auto_router.adapter", None),
        ("litellm", None),
        ("huggingface_hub", None),
        ("tiktoken", None),
        ("numpy", None),
        ("scipy", None),
        ("sklearn", None),
        ("joblib", None),
        ("wmi", None),
    ),
    "tts_manager": (
        ("tts_manager.__main__", None),
        ("misaki.en", None),
        ("tts_manager.kokoro_helper", None),
        ("onnxruntime", None),
        ("scipy.io.wavfile", None),
    ),
    # asr_manager's stack is deliberately small: no sherpa-onnx (its offline API
    # cannot accept the encoder frames the ENC pipeline produces, so the three
    # ONNX sessions are driven through onnxruntime directly) and no torch. The
    # two pipeline modules are listed explicitly because they are the only
    # pure-Python modules in the bundle that PyInstaller reaches ONLY through
    # `model_state`'s deferred imports -- a missed hiddenimport would otherwise
    # surface as a failed model load on a user's machine rather than at build time.
    "asr_manager": (
        ("asr_manager.__main__", None),
        ("asr_manager.app", None),
        ("asr_manager.recognize.enc_pipeline", None),
        ("asr_manager.recognize.tdt_beam", None),
        ("onnxruntime", None),
        ("numpy", None),
    ),
    # uvicorn resolves its WebSocket protocol from a string at serve time, so without
    # these two the bundle would serve HTTP and refuse every CDP relay connection.
    "mcp_host_manager": (
        ("mcp_host_manager.__main__", None),
        ("mcp_host_manager.app", None),
        ("contracts.host_mcp_api_data", None),
        ("uvicorn.protocols.websockets.websockets_sansio_impl", None),
        ("websockets", None),
    ),
    "sandbox_manager": (
        ("sandbox_manager.main", None),
        ("sandbox_manager.api", None),
        ("fastapi", None),
        ("uvicorn", None),
        ("win32api", None),
        ("win32crypt", None),
    ),
}


# The spec keeps only the `transformers.models` packages AutoTokenizer reaches for these
# two models, so `import transformers` alone passes on a bundle that cannot tokenize.
# Each model is called the way its text_protection pipeline calls it
# (_pplx_pipeline.run, _embedding_pipeline._embed_run). The models are downloaded after
# install, not bundled, so the smoke reads their tokenizer files from the directory
# build-servicehub.ps1 names in SUPERCLAW_SMOKE_PRIVACY_MODELS_DIR (the repo's models
# dir; tokenizer files are plain git files, not LFS).
_PRIVACY_SMOKE_MODELS_DIR_ENV = "SUPERCLAW_SMOKE_PRIVACY_MODELS_DIR"
_PRIVACY_TOKENIZER_MODELS = (
    (
        "pplx-pii-masking-ov-int8",
        "Jane Doe, jane@example.com",
        {
            "return_tensors": "np",
            "return_offsets_mapping": True,
            "truncation": True,
            "max_length": 4096,
        },
    ),
)


def _privacy_tokenizer_smoke() -> list[str]:
    configured = os.environ.get(_PRIVACY_SMOKE_MODELS_DIR_ENV, "").strip()
    if not configured:
        return [
            f"  [privacy_manager] {_PRIVACY_SMOKE_MODELS_DIR_ENV} is not set\n"
            "    -> set it to host/privacy_manager/data_protection/models (build-servicehub.ps1 does)"
        ]
    models_dir = Path(configured)
    failures: list[str] = []
    for name, text, call_kwargs in _PRIVACY_TOKENIZER_MODELS:
        model_dir = models_dir / name
        if not (model_dir / "tokenizer_config.json").is_file():
            failures.append(
                f"  [privacy_manager] tokenizer {name}: no tokenizer_config.json in {model_dir}\n"
                f"    -> point {_PRIVACY_SMOKE_MODELS_DIR_ENV} at the repo's models dir"
            )
            continue
        try:
            from transformers import AutoTokenizer

            tokenizer = AutoTokenizer.from_pretrained(str(model_dir), local_files_only=True)
            tokenizer(text, **call_kwargs)
        except Exception as exc:
            failures.append(
                f"  [privacy_manager] tokenizer {name}: {type(exc).__name__}: {exc}\n"
                "    -> check _TRANSFORMERS_MODELS_KEPT in superclaw_services.spec"
            )
    return failures


def _openvino_diagnostic() -> None:
    # Report-only by design: absent devices must not fail a build on a host with
    # no Intel GPU. OpenVINO LoadLibrary's its plugins/IR frontend at runtime, so
    # PyInstaller's static scan misses them and `import openvino` still succeeds
    # with zero usable devices -- which _inference_backend.py then degrades to
    # ORT CPU silently. Printing the list is what makes that visible at all
    # (see issue #1967).
    try:
        from openvino import Core

        devices = Core().available_devices
    except Exception as exc:
        sys.stdout.write(f"OPENVINO_DEVICES=<error: {type(exc).__name__}: {exc}>\n")
        return
    sys.stdout.write(f"OPENVINO_DEVICES={devices}\n")
    if not devices:
        sys.stdout.write(
            "OPENVINO_WARNING=no devices; bundle is missing openvino device "
            "plugins / IR frontend, so PII NER will fall back to ORT CPU\n"
        )


def _import_smoke(only: str | None = None) -> int:
    """Import one service's critical modules out of the merged bundle.

    A service MUST be named. Importing every service into one process is not a valid
    smoke: at runtime each service is its own process importing only its own
    stack, and doing all four together produced failures that cannot happen in
    production -- llmrouter_manager's `_runtime_stubs` found the real torch that
    privacy_manager needs and skipped its stub install, after which the combined
    onnxruntime + openvino + torch import crashed the process with an access
    violation. The build script therefore invokes this once per service, which
    also mirrors how ServiceHub actually runs them.
    """
    if only is None:
        sys.stderr.write(
            "SERVICES_IMPORT_FAILED\n"
            "  --import-smoke requires a service name.\n"
            "  Importing every service into one process is not a valid check: each\n"
            "  service runs as its own process, and the combined import triggers\n"
            "  cross-service conflicts that cannot occur in production.\n"
            "  Available: " + ", ".join(sorted(_SMOKE_TARGETS)) + "\n"
        )
        return 2

    targets = _SMOKE_TARGETS.get(only)
    if targets is None:
        if only in _SERVICES:
            sys.stderr.write(
                f"SERVICES_IMPORT_FAILED\n  {only!r} is a hosted role but has no entry in\n"
                "  _SMOKE_TARGETS, so its frozen imports are unverified. Add one.\n"
            )
        else:
            sys.stderr.write(f"SERVICES_IMPORT_FAILED\n  unknown service: {only}\n")
        return 2

    failures: list[str] = []
    for target, guarded_exclude in targets:
        try:
            importlib.import_module(target)
        except Exception as exc:
            blame = (
                f"remove {guarded_exclude!r} from excludes in superclaw_services.spec"
                if guarded_exclude
                else "check hiddenimports / datas in superclaw_services.spec"
            )
            failures.append(f"  [{only}] {target}: {type(exc).__name__}: {exc}\n    -> {blame}")
    if only == "privacy_manager":
        failures.extend(_privacy_tokenizer_smoke())

    if failures:
        sys.stderr.write("SERVICES_IMPORT_FAILED\n" + "\n".join(failures) + "\n")
        return 1

    if only == "privacy_manager":
        _openvino_diagnostic()

    sys.stdout.write(f"SERVICES_IMPORT_OK {only}\n")
    sys.stdout.flush()
    return 0


_SERVICE_FLAG = "--service"


def _extract_service_flag(argv: list[str]) -> tuple[str | None, list[str]]:
    remaining: list[str] = []
    service: str | None = None
    index = 0
    while index < len(argv):
        token = argv[index]
        if token == _SERVICE_FLAG:
            if index + 1 >= len(argv):
                sys.stderr.write(
                    f"SUPERCLAW_SERVICES_BAD_FLAG: {_SERVICE_FLAG} requires a value.\n"
                    "Available services: " + ", ".join(sorted(_SERVICES)) + "\n"
                )
                raise SystemExit(2)
            service = argv[index + 1]
            index += 2
            continue
        if token.startswith(f"{_SERVICE_FLAG}="):
            service = token[len(_SERVICE_FLAG) + 1 :]
            index += 1
            continue
        remaining.append(token)
        index += 1
    return service, remaining


def _resolve_service(flag_value: str | None) -> str:
    if flag_value is not None:
        name = flag_value.strip()
        if not name:
            sys.stderr.write(
                f"SUPERCLAW_SERVICES_BAD_FLAG: {_SERVICE_FLAG} was given an empty value.\n"
                "Available services: " + ", ".join(sorted(_SERVICES)) + "\n"
            )
            raise SystemExit(2)
    else:
        name = os.environ.get("SERVICEHUB_SERVICE_NAME", "").strip()
        if name:
            # ServiceHub always passes --service, so reaching this branch means an
            # inherited variable is choosing the role. Say so: a Hub started from a
            # shell that still exports SERVICEHUB_SERVICE_NAME would otherwise
            # silently come up as a child service instead of the supervisor.
            sys.stderr.write(
                f"SUPERCLAW_SERVICES_ROLE_FROM_ENV: {name!r} selected by "
                f"SERVICEHUB_SERVICE_NAME because no {_SERVICE_FLAG} was passed.\n"
            )
        else:
            name = _DEFAULT_SERVICE
    if name not in _SERVICES:
        sys.stderr.write(
            f"SUPERCLAW_SERVICES_UNKNOWN_IDENTITY: {name!r}.\n"
            "Available services: " + ", ".join(sorted(_SERVICES)) + "\n"
            f"Example: {Path(sys.executable).name} {_SERVICE_FLAG} sandbox_manager "
            "--host 127.0.0.1 --port 18821\n"
        )
        raise SystemExit(2)
    return name


def _set_console_title(service: str) -> None:
    """Label this process's console window with its role.

    Every role shares one image name, so Task Manager otherwise lists N identical
    `SuperClaw Services` rows; where a console exists, its title is the only
    per-role label the Processes tab will show. Best-effort by design: a role
    running with no console (or on a non-Windows dev box) must not fail to start
    over a cosmetic label.
    """
    if sys.platform != "win32":
        return
    try:
        import ctypes

        ctypes.windll.kernel32.SetConsoleTitleW(f"SuperClaw {service}")
    except (OSError, AttributeError):
        pass


def main() -> int:
    service_flag, argv = _extract_service_flag(sys.argv[1:])

    if "--list-services" in argv:
        for name, (module, func) in sorted(_SERVICES.items()):
            sys.stdout.write(f"{name}\t{module}:{func}\n")
        return 0

    if "--import-smoke" in argv:
        index = argv.index("--import-smoke")
        only = argv[index + 1] if len(argv) > index + 1 and not argv[index + 1].startswith("-") else None
        return _import_smoke(only or service_flag)

    service = _resolve_service(service_flag)
    # SERVICEHUB_SERVICE_NAME identifies a MANAGED CHILD - every child service
    # reads it for its own health response, and ServiceHub injects it per spawn.
    # Exporting it here makes a hand-started child report the same identity as a
    # Hub-started one. The Hub itself is deliberately excluded: it is the
    # supervisor, not one of its own children, and stamping the variable on the
    # Hub process would leak into anything it spawns without an explicit override.
    if service != _DEFAULT_SERVICE:
        os.environ.setdefault("SERVICEHUB_SERVICE_NAME", service)
    _set_console_title(service)
    # Hand the target the argv it would have received before this dispatcher
    # existed: `--service` is stripped, everything else is untouched.
    sys.argv = [sys.argv[0], *argv]
    module_name, func_name = _SERVICES[service]
    target = getattr(importlib.import_module(module_name), func_name)
    result = target()
    return result if isinstance(result, int) else 0


if __name__ == "__main__":
    if getattr(sys, "frozen", False):
        multiprocessing.freeze_support()
    sys.exit(main())
