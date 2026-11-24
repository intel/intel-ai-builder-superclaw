"""PyInstaller entry — kicks off the ``data_protection`` service.

Kept minimal for the same reason ``llm_pipeline/_pyinstaller_entry.py``
is: the frozen loader needs a plain module top-level that does the sys.path
dance so bundled sub-packages (common, file_protection, text_protection,
protection_service) resolve before we import the app.
"""
from __future__ import annotations

import importlib.util
import multiprocessing
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def _load_main():
    # privacy_manager.spec ships __main__.py as a loose data file (it's not
    # collected as an importable module by Analysis), and this script is
    # itself the process's ``__main__`` module -- so a plain
    # ``from __main__ import main`` always resolves to *this* file, never to
    # the bundled __main__.py, and fails with
    # "ImportError: cannot import name 'main' from '__main__'". Load it
    # explicitly by file path under a distinct module name instead.
    spec = importlib.util.spec_from_file_location("data_protection_main", ROOT / "__main__.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.main


# (import target, the privacy_manager.spec `excludes` entry it proves safe)
_SMOKE_TARGETS = (
    ("text_protection.sanitizer", "jieba"),
    ("spacy", "jieba"),
    ("protection_service.server", "babel"),
    ("onnxruntime", None),
    ("openvino", None),
    ("optimum.intel", None),
    ("transformers", None),
    ("pandas", None),
    ("pyarrow", None),
    ("docx", None),
    ("openpyxl", None),
    ("bs4", None),
)


def _openvino_diagnostic() -> None:
    # Report-only by design: absent devices must not fail a build on a host with
    # no Intel GPU. OpenVINO LoadLibrary's its plugins/IR frontend at runtime, so
    # PyInstaller's static scan misses them and `import openvino` still succeeds
    # with zero usable devices -- which _inference_backend.py then degrades to
    # ORT CPU silently. Printing the list is what makes that visible at all.
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


def _import_smoke() -> int:
    failures = []
    for target, guarded_exclude in _SMOKE_TARGETS:
        try:
            importlib.import_module(target)
        except Exception as exc:
            blame = (
                f"remove {guarded_exclude!r} from excludes in privacy_manager.spec"
                if guarded_exclude
                else "check hiddenimports in privacy_manager.spec"
            )
            failures.append(f"  {target}: {type(exc).__name__}: {exc}\n    -> {blame}")

    if failures:
        sys.stderr.write("SECURITY_IMPORT_FAILED\n" + "\n".join(failures) + "\n")
        return 1

    _openvino_diagnostic()
    sys.stdout.write("SECURITY_IMPORT_OK\n")
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    if getattr(sys, "frozen", False):
        multiprocessing.freeze_support()
    if "--import-smoke" in sys.argv:
        sys.exit(_import_smoke())
    main = _load_main()

    sys.exit(main())
