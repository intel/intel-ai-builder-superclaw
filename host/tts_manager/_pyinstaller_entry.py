import importlib
import multiprocessing
import sys

from tts_manager.__main__ import run


# (import target, the tts_manager.spec `excludes` entry it proves safe)
_SMOKE_TARGETS = (
    ("misaki.en", "lxml"),
    ("spacy", "spacy_curated_transformers"),
    ("tts_manager.kokoro_helper", None),
    ("onnxruntime", "torch"),
    ("scipy", "pandas"),
    ("numpy", None),
)


def _import_smoke() -> int:
    failures = []
    for target, guarded_exclude in _SMOKE_TARGETS:
        try:
            importlib.import_module(target)
        except Exception as exc:
            blame = (
                f"remove {guarded_exclude!r} from excludes in tts_manager.spec"
                if guarded_exclude
                else "check hiddenimports in tts_manager.spec"
            )
            failures.append(f"  {target}: {type(exc).__name__}: {exc}\n    -> {blame}")

    if failures:
        sys.stderr.write("TTS_IMPORT_FAILED\n" + "\n".join(failures) + "\n")
        return 1

    sys.stdout.write("TTS_IMPORT_OK\n")
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    if getattr(sys, "frozen", False):
        multiprocessing.freeze_support()
    if "--import-smoke" in sys.argv:
        sys.exit(_import_smoke())
    run()
