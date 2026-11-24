r"""Lazy model residency + model-dir resolution for the host ASR service.

Deliberately a near-mirror of ``tts_manager/synth/model_state.py``:
``ADDING_A_SERVICE.md`` names ``host/tts_manager/`` as the reference ``on_demand``
implementation, and ASR is TTS in the other direction (audio in, text out), so the
two lifecycles are the same shape. Divergences from that file are all listed here
so a reader can diff the two without guessing which differences are intentional:

- **Four weight files, not two.** Parakeet's sherpa-onnx int8 export is an
  encoder/decoder/joiner ONNX trio plus ``tokens.txt`` (~630 MB total, almost all
  of it the encoder). ``model_present()`` is True only when all four are on disk.
- **``weights_present`` is in the download snapshot**, not only in ``/health``.
  ``/health`` is the one endpoint ServiceHub does NOT cold-start (it answers
  ``service_dormant`` 503 instead), so a UI that had to read ``weights_present``
  from ``/health`` could not tell "never downloaded" from "not running". Putting it
  in ``dl_snapshot()`` gives the UI exactly one endpoint to poll. This is the
  frozen transcribe contract §4.
- **No espeak/G2P/spaCy chain**, so ``warm_native_imports()`` is numpy +
  onnxruntime + the ENC pipeline module only — a couple of seconds rather than
  tts_manager's ~5 s.
- **The runner is stateful across the whole decode.** A single ``OrtParakeet``
  holds three ONNX sessions, and the TDT greedy pass carries LSTM prediction state
  and a frame cursor. Two concurrent transcriptions on one runner would interleave
  joiner calls against the same prediction state, so inference is serialized under
  ``INFERENCE_LOCK`` exactly as TTS serializes KModel.

The onnxruntime sessions are not thread-safe, so inference is serialized under
``INFERENCE_LOCK`` (held by the ``/transcribe`` route); model construction is
serialized under its own lock and is idempotent.
"""

from __future__ import annotations

import gc
import os
import sys
import threading
import time as _time
from pathlib import Path

# The four files of the sherpa-onnx int8 export of nvidia/parakeet-tdt-0.6b-v2.
# These are the names used by the upstream HF repo
# (csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8) and the names
# OrtParakeet is constructed with, so downloader and loader cannot disagree.
ENCODER_FILENAME = "encoder.int8.onnx"
DECODER_FILENAME = "decoder.int8.onnx"
JOINER_FILENAME = "joiner.int8.onnx"
TOKENS_FILENAME = "tokens.txt"

# Order matters: OrtParakeet(model_dir, files) unpacks it as
# (encoder, decoder, joiner, tokens).
MODEL_FILENAMES = (
    ENCODER_FILENAME,
    DECODER_FILENAME,
    JOINER_FILENAME,
    TOKENS_FILENAME,
)

# HuggingFace repo the weights come from. Env-overridable so a mirror or a
# re-export needs no code change; the sha256 table below must be overridden with it.
DEFAULT_HF_REPO = "csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8"

# Pinned sha256 + exact byte size per file, read from the HF repo's own tree
# metadata (``GET /api/models/<repo>/tree/main``; for LFS files the API's
# ``lfs.oid`` IS the content sha256). Sizes are pinned too, not merely the hashes,
# because they are what makes the download progress bar exact instead of an
# estimate -- tts_manager has to guess a "rough total for the progress bar".
#
# Each is overridable via ASR_<FILE>_SHA256 (see download._expected_sha256) so a
# model swap is a config change. A blank override falls back to the pinned value
# rather than disabling verification -- see the fail-open note in download.py.
DEFAULT_FILE_SHA256: dict[str, str] = {
    ENCODER_FILENAME: "92a10bd9c23936ea0566c29f963bc57c2a5df4261b6a8921c39abea66557ca8b",
    DECODER_FILENAME: "4d097bae3bac5c96018d5293ba39f1b657296102b142affda40378f38b020f41",
    JOINER_FILENAME: "77a29f3e5ac7d37074e0af465391b80f314015d5b97f0f90c6c7767f1d56f428",
    TOKENS_FILENAME: "ec182b70dd42113aff6c5372c75cac58c952443eb22322f57bbd7f53977d497d",
}
DEFAULT_FILE_SIZES: dict[str, int] = {
    ENCODER_FILENAME: 652_282_309,
    DECODER_FILENAME: 7_257_753,
    JOINER_FILENAME: 1_739_080,
    TOKENS_FILENAME: 9_384,
}

# ~630 MB. Derived, not typed: it is the exact ``total_bytes`` a download in flight
# reports (contract §4) and the figure ``GET /v1/status`` advertises as
# ``summary.asr.total_download_bytes``.
TOTAL_DOWNLOAD_BYTES = sum(DEFAULT_FILE_SIZES.values())

# Opaque model identifier echoed in the /transcribe response and in logs.
MODEL_ID = "parakeet-tdt-0.6b-v2-int8"

# Parakeet's native sample rate. The wire contract requires exactly this
# (see api/asr.py for why we reject instead of resampling).
SAMPLE_RATE = 16000

# Inference lock -- serializes transcription across concurrent requests. The
# `/transcribe` route acquires this; Starlette runs the sync work in a threadpool,
# so without the lock two requests could drive one OrtParakeet's three ONNX
# sessions (and, in the pipelined decoder, one LSTM prediction state) at once.
INFERENCE_LOCK = threading.Lock()

# -- module state ------------------------------------------------------------
_RUNNER = None
_MODEL_LOAD_LOCK = threading.Lock()   # serializes model construction (and teardown)
_THREADS = 4                          # set from env in __main__.py via set_threads()
_WARMED = False                       # native-import warmup done once
_WARM_LOCK = threading.Lock()

# -- idle auto-unload --------------------------------------------------------
# The three resident ONNX sessions cost roughly 0.8-1.0 GB of RSS (the int8
# encoder graph alone is 622 MB on disk). For a user who dictates once and then
# types for the rest of the day that sits pinned for the life of the process, so
# the same idle monitor tts_manager uses drops it back to disk-lazy; the next
# /prepare or /transcribe reloads it.
_ACTIVITY_LOCK = threading.Lock()
_LAST_ACTIVITY: float = _time.monotonic()

# Default idle-before-unload window: 15 minutes. SHORTER than tts_manager's 1 hour
# on purpose -- this model is ~2x the RAM, and dictation is bursty (a user dictates
# a prompt, then reads a long agent reply), so the window that matters is "between
# messages", not "between sessions". Overridable via
# PARAKEET_ASR_IDLE_UNLOAD_SECONDS; <= 0 disables the monitor entirely.
DEFAULT_IDLE_UNLOAD_SECONDS = 900

# Live download/load progress, read by GET /download/status. states:
# idle | downloading | verifying | loading | ready | error
#
# ``total_bytes`` IS 0 UNTIL A DOWNLOAD IS ACTUALLY IN FLIGHT, per the frozen
# transcribe contract §4, whose idle example is ``total_bytes: 0``. Seeding it with
# TOTAL_DOWNLOAD_BYTES would be strictly more useful -- the consent dialog wants a
# size, and /download/status is the only endpoint that wakes an on_demand child --
# but the contract is shared verbatim with the UI PR and the two agents do not talk:
# agent B may read ``total_bytes == 0`` as "no download started", in which case a
# fresh install would render as 0% of a download in flight instead of idle. The
# dialog quotes the plan's "~630 MB" from the UI side; ops can still read the exact
# figure from ``GET /v1/status``'s ``summary.asr.total_download_bytes``, which is a
# per-service template endpoint and not part of the frozen contract. Amending §4 to
# carry the size is a cross-PR change and belongs to the main agent.
_DL_LOCK = threading.Lock()
_DL_STATE: dict[str, object] = {
    "state": "idle",
    "done_bytes": 0,
    "total_bytes": 0,
    "source": None,
    "error": None,
}


def set_threads(threads: int) -> None:
    """Set the onnxruntime intra-op thread cap used when the sessions are built."""
    global _THREADS
    _THREADS = int(threads) if threads else 0


def threads() -> int:
    return _THREADS


def _host_model_dir_default() -> Path:
    r"""Default host model dir: ``%LOCALAPPDATA%\SuperClaw\parakeet`` on Windows,
    else ``~/.superclaw/parakeet``. The ~630 MB export is downloaded here on demand
    after the user consents (POST /download)."""
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(base) / "SuperClaw" / "parakeet"
    return Path.home() / ".superclaw" / "parakeet"


def model_dir() -> Path:
    """The directory the four model files live in -- PARAKEET_MODEL_DIR or the
    host default.

    Unlike tts_manager there is no per-file path override. The loader
    (``OrtParakeet``) appends the four FIXED filenames to one directory, so a
    per-file override could only ever express "same dir, other name", which the
    loader cannot consume -- tts_manager's KOKORO_WEIGHTS_PATH /
    KOKORO_VOICES_PATH pair needed a dedicated co-location check in
    ``detect_local_dir`` for exactly that reason. One directory knob has no such
    failure mode.
    """
    env = (os.environ.get("PARAKEET_MODEL_DIR") or "").strip()
    if env:
        return Path(env)
    return _host_model_dir_default()


def model_file(filename: str) -> Path:
    """Absolute path of one model file inside the model dir."""
    return model_dir() / filename


def model_present() -> bool:
    """True only when ALL FOUR files are on disk (the model can load offline).

    A pure ``is_file()`` check, so it stays True for a truncated or corrupt
    download -- which is why the load path reports ``error`` separately and
    ``/transcribe`` maps that to ``model_load_failed`` rather than retrying.
    """
    directory = model_dir()
    return all((directory / name).is_file() for name in MODEL_FILENAMES)


def missing_files() -> tuple[str, ...]:
    """Which of the four files are absent. For log lines and /status only."""
    directory = model_dir()
    return tuple(name for name in MODEL_FILENAMES if not (directory / name).is_file())


def is_loaded() -> bool:
    return _RUNNER is not None


def get_runner():
    return _RUNNER


# -- download-state helpers --------------------------------------------------
def set_dl(**kwargs: object) -> None:
    with _DL_LOCK:
        _DL_STATE.update(kwargs)


def dl_state_get(key: str) -> object:
    with _DL_LOCK:
        return _DL_STATE.get(key)


def dl_snapshot() -> dict[str, object]:
    """The frozen contract §4 payload: tts_manager's snapshot plus
    ``weights_present``, so the UI needs exactly one polling endpoint."""
    with _DL_LOCK:
        snap = dict(_DL_STATE)
    snap["model_loaded"] = _RUNNER is not None
    snap["weights_present"] = model_present()
    return snap


def dl_begin_if_idle(state: str) -> bool:
    """Atomically flip the download state to ``state`` iff no download/load is in
    flight. Returns True if this caller should start the worker thread."""
    with _DL_LOCK:
        if _DL_STATE["state"] not in ("downloading", "verifying", "loading"):
            _DL_STATE.update(state=state, error=None)
            if state == "downloading":
                # A download IS now in flight, so publish the exact total here
                # rather than leaving a transient 0 for the first poll after the
                # user clicked "download" (the download path sets the same
                # constant a moment later). ``done_bytes`` restarts at 0.
                _DL_STATE.update(
                    done_bytes=0, total_bytes=TOTAL_DOWNLOAD_BYTES, source=None
                )
            return True
    return False


def warm_native_imports() -> None:
    """Import the heavy native C-extensions ONCE, on the calling thread.

    WHERE THIS RUNS: at process startup, on the sole main thread, from
    ``__main__.run`` BEFORE the port binds and BEFORE uvicorn creates the event
    loop or any worker thread.

    WHY: this is not a speculative optimisation, it is a fix carried over from
    tts_manager for a confirmed deadlock on this managed endpoint. The model load
    runs on a daemon background thread, and an endpoint-security DLL (``umppc*.dll``)
    hooks ``LoadLibrary``; a first-time native import from a *secondary* thread
    while the main thread sits in the asyncio event loop blocks forever inside
    ``LoadLibraryExW`` (captured by py-spy as a background thread frozen in
    ``create_module`` at ``numpy/_core/multiarray.py`` with flat CPU, download state
    stuck at "loading", and the UI hanging with no response). Warming while we are
    the only thread takes the loader lock where the hook is safe, so every later
    import from the load thread is a cache hit.

    Both alternative placements regressed in production for tts_manager and would
    regress identically here: warming inside the /prepare or /download handler runs
    on the event-loop thread and starves /health until the watchdog kills the child;
    warming on the background load thread hits the deadlock above.

    This warms MODULES only -- the ~630 MB of ONNX sessions is still built lazily,
    so idle RAM stays near zero for a user who never dictates. Much cheaper than
    tts_manager's warmup (no spaCy/thinc/misaki chain): numpy + onnxruntime + the
    pure-Python ENC pipeline.

    Idempotent and best-effort: a failure here must not break the caller.
    """
    global _WARMED
    with _WARM_LOCK:
        if _WARMED:
            return
        t0 = _time.monotonic()
        try:
            import numpy  # noqa: F401
            import onnxruntime  # noqa: F401

            # The exact module the background load thread imports, so its
            # transitive natives are already resident (cache hits).
            from .enc_pipeline import OrtParakeet  # noqa: F401
        except Exception as exc:  # noqa: BLE001 -- never fatal
            print(
                f"[asr-manager] WARNING: native import warmup failed (non-fatal); "
                f"model load may be slower: {type(exc).__name__}: {exc}",
                flush=True,
            )
            _WARMED = True  # do not retry a broken warmup on every request
            return
        _WARMED = True
        print(
            f"[asr-manager] native import warmup complete in "
            f"{_time.monotonic() - t0:.2f}s (numpy/onnxruntime/enc_pipeline)",
            flush=True,
        )


def load_model_locked() -> None:
    """Build the resident runner from the (now-present) local weights. Idempotent."""
    global _RUNNER
    with _MODEL_LOAD_LOCK:
        if _RUNNER is not None:
            mark_activity()
            return
        from .enc_pipeline import OrtParakeet

        directory = model_dir()
        print(
            f"[asr-manager] loading model (dir={directory}, threads={_THREADS})...",
            flush=True,
        )
        _RUNNER = OrtParakeet(directory, MODEL_FILENAMES, num_threads=_THREADS)
        print("[asr-manager] model loaded", flush=True)
        # A fresh load counts as activity so the just-loaded model isn't unloaded by
        # a monitor tick that fires immediately after. Bumped INSIDE the load lock:
        # bumping after releasing it leaves a window where _idle_unload_tick can take
        # the lock, see the PRE-load timestamp (a ~630 MB download easily outlasts the
        # 15-minute idle window) and drop the runner that was just built. Safe to hold
        # both -- mark_activity only takes _ACTIVITY_LOCK, and _MODEL_LOAD_LOCK ->
        # _ACTIVITY_LOCK is the order unload_model_locked's re-check already uses, so
        # there is no inversion.
        mark_activity()


# -- idle auto-unload --------------------------------------------------------
def mark_activity() -> None:
    """Record that the ASR model was just used. Called by the /transcribe,
    /prepare and /download handlers and on each successful load. The idle monitor
    measures wall time since this stamp to decide when to unload.

    ``/prepare`` is the activity ping the UI sends when the user opens the
    composer / arms the mic (frozen contract §5), which is what keeps "no
    dictation" the thing that starts the countdown rather than "no page open".
    """
    global _LAST_ACTIVITY
    with _ACTIVITY_LOCK:
        _LAST_ACTIVITY = _time.monotonic()


def seconds_since_activity() -> float:
    with _ACTIVITY_LOCK:
        last = _LAST_ACTIVITY
    return _time.monotonic() - last


def unload_model_locked(min_idle_seconds: float | None = None) -> bool:
    """Drop the resident runner so its ~0.8-1.0 GB is reclaimed; the next
    /prepare (or /transcribe's self-heal) reloads it from the on-disk weights.
    Idempotent and safe to call when nothing is loaded -- returns False in that
    case, which is the guard that keeps the idle feature inert until a model has
    actually been loaded. Returns True when a resident runner was released.

    ``min_idle_seconds`` closes a TOCTOU with the idle monitor. The monitor decides
    to unload OUTSIDE this lock (see _idle_unload_tick), so a /transcribe or
    /prepare can land in the gap between that decision and this critical section.
    When a value is passed we RE-CHECK ``seconds_since_activity() >=
    min_idle_seconds`` under ``_MODEL_LOAD_LOCK`` and bail if activity is fresh --
    otherwise a mic click exactly at the boundary could mark_activity(), have
    start_prepare_if_idle() see is_loaded() still True (so it starts NO load), and
    then get the model dropped here, leaving the mic armed with no model and
    nothing reloading it. Callers doing an explicit unload (tests, teardown) pass
    None to skip the re-check.

    Serialized under the SAME lock as construction (``_MODEL_LOAD_LOCK``) so it
    can never race a concurrent load_model_locked(). It ALSO briefly takes
    ``INFERENCE_LOCK`` while nulling ``_RUNNER`` so it cannot tear the sessions out
    from under an in-flight /transcribe:
      - a transcription already inside INFERENCE_LOCK holds the lock, so this
        unload blocks until it finishes; and
      - a transcription still WAITING on INFERENCE_LOCK re-reads get_runner() once
        it acquires the lock (see api/asr._transcribe_locked) and observes
        ``_RUNNER is None``, so it 503s ``model_unloaded`` cleanly instead of
        running against retired ONNX sessions.
    That re-read inside the lock -- NOT the pre-lock capture -- is what makes this
    safe if unload is ever extended to explicit session teardown. The lock order
    (``_MODEL_LOAD_LOCK`` -> ``INFERENCE_LOCK``) is the only order any code path
    takes, so there is no ABBA deadlock.
    """
    global _RUNNER
    with _MODEL_LOAD_LOCK:
        if _RUNNER is None:
            return False
        if min_idle_seconds is not None and seconds_since_activity() < min_idle_seconds:
            return False
        with INFERENCE_LOCK:
            _RUNNER = None
        # Reset the download/status projection to a clean pre-load state so
        # /health and /download/status report model_loaded=False again, matching
        # true residency. Only downgrade a terminal "ready" state -- never stomp an
        # in-flight download/verify/load that a racing /prepare or /download may
        # have just started (dl_begin_if_idle guards those).
        if dl_state_get("state") == "ready":
            # Back to the contract §4 idle snapshot exactly: no download is in
            # flight, so both byte counters read 0 and ``weights_present: true`` is
            # what tells the UI the 630 MB is still on disk (which is why that field
            # was added to this endpoint in the first place).
            set_dl(state="idle", error=None, done_bytes=0, total_bytes=0)
    gc.collect()
    print("[asr-manager] model unloaded (idle); RAM reclaimed", flush=True)
    return True


def _idle_unload_tick(idle_seconds: float) -> bool:
    """One monitor evaluation: unload iff a model is resident AND it has been idle
    for at least ``idle_seconds``. Split out from the loop so tests can drive a
    single deterministic tick without sleeping. Returns True if it unloaded."""
    if not is_loaded():
        return False
    if seconds_since_activity() < idle_seconds:
        return False
    # Pass the window so unload re-checks activity UNDER _MODEL_LOAD_LOCK: the
    # is-idle test just above ran outside the lock, so a request may land in the
    # gap. The in-lock re-check is authoritative and closes that TOCTOU.
    return unload_model_locked(min_idle_seconds=idle_seconds)


def start_idle_unload_monitor(
    idle_seconds: float, poll_seconds: float | None = None
) -> threading.Thread | None:
    """Start the daemon thread that unloads the model after ``idle_seconds`` with
    no activity. A non-positive ``idle_seconds`` disables the feature (returns
    None -- the model then stays resident until the process exits).

    The poll cadence defaults to a fraction of the window (so a 60 s test window
    checks every ~5 s and the 15 min default checks every ~60 s), clamped to
    [1 s, 60 s]."""
    if idle_seconds <= 0:
        print(
            "[asr-manager] idle auto-unload disabled "
            "(PARAKEET_ASR_IDLE_UNLOAD_SECONDS <= 0)",
            flush=True,
        )
        return None
    if poll_seconds is None:
        poll_seconds = min(60.0, max(1.0, idle_seconds / 12.0))

    def _loop() -> None:
        while True:
            _time.sleep(poll_seconds)
            try:
                _idle_unload_tick(idle_seconds)
            except Exception as exc:  # noqa: BLE001 -- a hiccup must not kill the thread
                print(
                    f"[asr-manager] WARNING: idle-unload tick failed: "
                    f"{type(exc).__name__}: {exc}",
                    flush=True,
                )

    print(
        f"[asr-manager] idle auto-unload monitor started "
        f"(unload after {idle_seconds:.0f}s idle, poll every {poll_seconds:.0f}s)",
        flush=True,
    )
    t = threading.Thread(target=_loop, name="asr-idle-unload", daemon=True)
    t.start()
    return t
