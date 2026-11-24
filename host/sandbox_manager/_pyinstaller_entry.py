# PyInstaller entry point for sandbox-manager.
# This file lives OUTSIDE the sandbox_manager package so it is treated as a
# top-level script by PyInstaller (no relative imports).  It simply imports
# the package's run() function and delegates.
import importlib
import multiprocessing
import sys

from sandbox_manager.main import run

# (import target, the sandbox_manager.spec `excludes` entry it proves safe)
_SMOKE_TARGETS = (
    ("sandbox_manager.main", "numpy"),
    ("sandbox_manager.api", "numpy"),
    ("fastapi", None),
    ("uvicorn", None),
    ("wmi", None),
    ("win32api", None),
    ("win32crypt", None),
)


def _import_smoke() -> int:
    failures = []
    for target, guarded_exclude in _SMOKE_TARGETS:
        try:
            importlib.import_module(target)
        except Exception as exc:
            blame = (
                f"remove {guarded_exclude!r} from excludes in sandbox_manager.spec"
                if guarded_exclude
                else "check hiddenimports in sandbox_manager.spec"
            )
            failures.append(f"  {target}: {type(exc).__name__}: {exc}\n    -> {blame}")

    if failures:
        sys.stderr.write("SANDBOX_IMPORT_FAILED\n" + "\n".join(failures) + "\n")
        return 1

    sys.stdout.write("SANDBOX_IMPORT_OK\n")
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    if getattr(sys, "frozen", False):
        multiprocessing.freeze_support()
    if "--import-smoke" in sys.argv:
        sys.exit(_import_smoke())
    run()
