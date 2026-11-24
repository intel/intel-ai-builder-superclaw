import importlib
import multiprocessing
import sys

from llmrouter_manager.__main__ import run


# (import target, the llmrouter_manager.spec `excludes` entry it proves safe)
_SMOKE_TARGETS = (
    ("pandas", "pyarrow"),
    ("llmrouter_manager.routing.auto_router.adapter", "torch"),
    ("litellm", "transformers"),
    ("huggingface_hub", "safetensors"),
    ("tiktoken", "babel"),
    ("bs4", "lxml"),
    ("numpy", None),
    ("scipy", None),
    ("sklearn", None),
    ("joblib", None),
)


def _import_smoke() -> int:
    failures = []
    for target, guarded_exclude in _SMOKE_TARGETS:
        try:
            importlib.import_module(target)
        except Exception as exc:
            blame = (
                f"remove {guarded_exclude!r} from excludes in llmrouter_manager.spec"
                if guarded_exclude
                else "check hiddenimports in llmrouter_manager.spec"
            )
            failures.append(f"  {target}: {type(exc).__name__}: {exc}\n    -> {blame}")

    if failures:
        sys.stderr.write("LLMROUTER_IMPORT_FAILED\n" + "\n".join(failures) + "\n")
        return 1

    sys.stdout.write("LLMROUTER_IMPORT_OK\n")
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    if getattr(sys, "frozen", False):
        multiprocessing.freeze_support()
    if "--import-smoke" in sys.argv:
        sys.exit(_import_smoke())
    run()
