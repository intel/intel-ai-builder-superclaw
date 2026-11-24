"""Lazy model residency + model-dir resolution for the host TTS service.

Ported from ``sandbox/tts_service/server.py`` (the container-resident copy this
service replaces). Behavioural differences:

- **Host model dir.** The default download/load location is a Windows host dir
  (``%LOCALAPPDATA%\\SuperClaw\\kokoro``, falling back to ``~/.superclaw/kokoro``)
  instead of the container's ``/data`` / ``/opt`` volumes. All ``KOKORO_*`` env
  overrides still win.
- **Lazy residency.** The model is NOT loaded at startup — the port binds and
  ``/health`` responds before any weights exist or load. Loading happens on first
  use (``POST /prepare`` when narration turns on, or after a consented
  ``POST /download``). This keeps idle RAM cost at zero for users who never enable
  speech and makes ServiceHub readiness instant.

The onnxruntime session + KModel are not thread-safe, so inference is serialized
under ``INFERENCE_LOCK`` (held by the ``/tts`` route); model construction is
serialized under its own lock and is idempotent.
"""

from __future__ import annotations

import gc
import os
import sys
import threading
import time as _time
from pathlib import Path

# The two ONNX model files inside the model dir. Unlike the old PyTorch weights
# (one .pth + config.json + per-voice .pt packs), the ONNX export is exactly two
# self-contained files: the graph (~325 MB) and every voice pack bundled into one
# binary (~27 MB). No config.json / voices/*.pt are needed.
ONNX_MODEL_FILENAME = "kokoro-v1.0.onnx"
ONNX_VOICES_FILENAME = "voices-v1.0.bin"

# Pinned sha256 of each file (kokoro-onnx model-files-v1.0 GitHub release).
# Env-overridable so a model swap needs no code change here.
DEFAULT_MODEL_SHA256 = "7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5"
DEFAULT_VOICES_SHA256 = "bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d"

# Kokoro's native sample rate (kept here for callers that don't import the helper).
SAMPLE_RATE = 24000

# Inference lock — serializes KModel.generate() across concurrent requests. The
# `/tts` route acquires this; Starlette runs the sync route in a threadpool, so
# without the lock two requests could hit the single onnxruntime session at once.
INFERENCE_LOCK = threading.Lock()

# ── module state ──────────────────────────────────────────────────────────────
_MODEL = None
_MODEL_LOAD_LOCK = threading.Lock()   # serializes model construction (and teardown)
_THREADS = 6                          # set from env in __main__.py via set_threads()
_LOCAL_DIR_OVERRIDE: str | None = None
_WARMED = False                       # native-import warmup done once (see warm_native_imports)
_WARM_LOCK = threading.Lock()

# ── idle auto-unload ────────────────────────────────────────────────────────
# The resident Kokoro session costs ~500 MB of RSS on top of the ~200 MB the
# warmed native modules already hold (measured: ~200 MB idle → ~700 MB loaded).
# For a user who enables narration once and then stops using it, that half-gig
# sits pinned for the life of the process. The idle monitor (see
# start_idle_unload_monitor / __main__.run) drops the session back to disk-lazy
# after a configurable stretch with no TTS activity, reclaiming the ~500 MB; the
# very next 🔊 click re-triggers POST /prepare and reloads it (a few seconds).
#
# `_LAST_ACTIVITY` is a monotonic timestamp bumped by mark_activity() on every
# request that touches the model path (/tts, /prepare, /download) and on each
# successful load. The monitor unloads only when the model is actually resident,
# so if nobody ever loaded a model the feature is inert (no unload, no churn).
_ACTIVITY_LOCK = threading.Lock()
_LAST_ACTIVITY: float = _time.monotonic()

# Default idle-before-unload window: 1 hour. Overridable via the env var
# KOKORO_TTS_IDLE_UNLOAD_SECONDS (read in __main__.py) — set it to 60 for a
# quick "load ~700 MB → wait a minute → back to ~200 MB" memory check. A value
# <= 0 disables the monitor entirely (model stays resident until process exit).
DEFAULT_IDLE_UNLOAD_SECONDS = 3600

# Live download/load progress, read by GET /download/status. states:
# idle | downloading | verifying | loading | ready | error
_DL_LOCK = threading.Lock()
_DL_STATE: dict[str, object] = {
    "state": "idle",
    "done_bytes": 0,
    "total_bytes": 0,
    "source": None,
    "error": None,
}


def set_threads(threads: int) -> None:
    """Set the onnxruntime intra-op thread cap used when the model is built."""
    global _THREADS
    _THREADS = int(threads) if threads else 0


def threads() -> int:
    return _THREADS


def _host_model_dir_default() -> Path:
    """Default host model dir: ``%LOCALAPPDATA%\\SuperClaw\\kokoro`` on Windows,
    else ``~/.superclaw/kokoro``. The ~350 MB ONNX files are downloaded here on
    demand after the user consents (POST /download)."""
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(base) / "SuperClaw" / "kokoro"
    return Path.home() / ".superclaw" / "kokoro"


def model_dir() -> Path:
    """The directory the model files live in — KOKORO_MODEL_DIR or the host default."""
    env = os.environ.get("KOKORO_MODEL_DIR")
    if env:
        return Path(env)
    return _host_model_dir_default()


def weights_target() -> Path:
    """Absolute path of the ONNX graph file we download to / load from."""
    env = os.environ.get("KOKORO_WEIGHTS_PATH")
    if env:
        return Path(env)
    return model_dir() / ONNX_MODEL_FILENAME


def voices_target() -> Path:
    """Absolute path of the ONNX voices file we download to / load from."""
    env = os.environ.get("KOKORO_VOICES_PATH")
    if env:
        return Path(env)
    return model_dir() / ONNX_VOICES_FILENAME


def model_present() -> bool:
    """True only when BOTH ONNX files are on disk (the model can load offline)."""
    return weights_target().is_file() and voices_target().is_file()


def detect_local_dir(explicit: str | None = None) -> str | None:
    if explicit:
        return explicit
    # Resolve the loader's local_dir from the SAME two targets model_present()
    # checks — weights_target() and voices_target() — so the two can never
    # disagree. Both fold in every override uniformly (KOKORO_WEIGHTS_PATH /
    # KOKORO_VOICES_PATH first, else KOKORO_MODEL_DIR, else the host default), which
    # fixes an earlier asymmetry where only KOKORO_WEIGHTS_PATH was honoured and a
    # voices-side override (or a same-dir relocation reached via KOKORO_VOICES_PATH)
    # left local_dir=None while model_present() was True.
    #
    # The loader (KokoroTTS._local_files) needs BOTH files, by their FIXED names
    # (kokoro-v1.0.onnx + voices-v1.0.bin), in ONE directory — it appends those
    # names to local_dir. So a local_dir only exists when the resolved pair is
    # present, co-located, and named as expected: that honours a non-standard
    # DIRECTORY, not custom filenames or a split across two dirs (which the loader
    # cannot consume — we return None so the caller reports needs_download rather
    # than loading from a dir the session build would reject).
    weights = weights_target()
    voices = voices_target()
    if (
        weights.is_file()
        and voices.is_file()
        and weights.parent == voices.parent
        and weights.name == ONNX_MODEL_FILENAME
        and voices.name == ONNX_VOICES_FILENAME
    ):
        return str(weights.parent)
    return None


def is_loaded() -> bool:
    return _MODEL is not None


def get_model():
    return _MODEL


# ── download-state helpers ──────────────────────────────────────────────────
def set_dl(**kwargs: object) -> None:
    with _DL_LOCK:
        _DL_STATE.update(kwargs)


def dl_state_get(key: str) -> object:
    with _DL_LOCK:
        return _DL_STATE.get(key)


def dl_snapshot() -> dict[str, object]:
    with _DL_LOCK:
        snap = dict(_DL_STATE)
    snap["model_loaded"] = _MODEL is not None
    return snap


def dl_begin_if_idle(state: str) -> bool:
    """Atomically flip the download state to ``state`` iff no download/load is in
    flight. Returns True if this caller should start the worker thread."""
    with _DL_LOCK:
        if _DL_STATE["state"] not in ("downloading", "verifying", "loading"):
            _DL_STATE.update(state=state, error=None)
            if state == "downloading":
                _DL_STATE.update(done_bytes=0, total_bytes=0, source=None)
            return True
    return False


def warm_native_imports() -> None:
    """Import the heavy native C-extensions ONCE, on the calling thread.

    WHERE THIS RUNS: at process startup, on the sole main thread, from
    ``__main__.run`` BEFORE the port binds and BEFORE uvicorn creates the event loop
    or any worker thread. That single-threaded moment is the ONLY safe place to warm.

    WHY (loader-lock deadlock — confirmed, not theoretical): the model load runs on
    a daemon background thread (``download_weights_and_load`` → ``load_model_locked``
    → ``import kokoro_helper`` → ``import numpy``). On this managed endpoint an
    endpoint-security DLL (``umppc*.dll``, observed loaded in the process) hooks
    ``LoadLibrary``. A first-time native import from a *secondary* thread, while the
    main thread sits in the asyncio event loop, blocks forever inside
    ``LoadLibraryExW`` — captured by py-spy as the background thread frozen in
    ``create_module`` at ``numpy/_core/multiarray.py`` with flat CPU, the download
    state stuck at "loading", and the 🔊 click hanging with no response.

    Warming while we are the only thread takes the loader lock where the hook is
    safe; every later import from the background load thread is then a cache hit (no
    ``LoadLibrary``), so the deadlock cannot occur. This warms MODULES only; the
    ~350 MB model session is still built lazily, so idle RAM stays near zero.

    COST: this delays the port bind (~5s warm; more on a cold, AV-scanned disk), so
    ServiceHub readiness waits that long — hence tts_manager's generous
    ``ready_timeout_s``. It is free because tts_manager is optional and starts LAST,
    after the other children are ready, so nothing waits on it.

    REJECTED (both regressed in production): warming in the /prepare or /download
    route handler runs on the event-loop thread and starves /health until the
    watchdog kills the child ("Host services degraded: tts manager"); warming on the
    background load thread hits the loader-lock deadlock above.

    Idempotent and cheap after the first call (import cache hits). Best-effort: a
    failure here must not break the caller. We log and continue; if a module is
    genuinely broken, the load path surfaces it.
    """
    global _WARMED
    with _WARM_LOCK:
        if _WARMED:
            return
        t0 = _time.monotonic()
        try:
            # ONNX synthesis chain.
            import numpy  # noqa: F401
            import onnxruntime  # noqa: F401
            import scipy.io.wavfile  # noqa: F401

            # misaki G2P chain. The English path (en.G2P) pulls spaCy, whose thinc
            # backend loads its OWN native C-extensions (blis, cymem, preshed,
            # murmurhash, thinc.backends.numpy_ops) — each a first-time LoadLibrary
            # that would deadlock on the background load thread just like numpy.
            import spacy  # noqa: F401
            import thinc.backends.numpy_ops  # noqa: F401
            from misaki import en  # noqa: F401

            # Pull in our helper too: the exact module the background thread imports,
            # so its native transitive imports are already resident (cache hits).
            from ..kokoro_helper import KokoroTTS  # noqa: F401
        except Exception as exc:  # noqa: BLE001 — never fatal
            print(
                f"[tts-manager] WARNING: native import warmup failed (non-fatal); "
                f"model load may be slower: {type(exc).__name__}: {exc}",
                flush=True,
            )
            _WARMED = True  # do not retry a broken warmup on every request
            return
        _WARMED = True
        print(
            f"[tts-manager] native import warmup complete in "
            f"{_time.monotonic() - t0:.2f}s "
            f"(numpy/scipy/onnxruntime/spacy/thinc/misaki)",
            flush=True,
        )


def load_model_locked() -> None:
    """Build the resident model from the (now-present) local weights. Idempotent."""
    global _MODEL
    with _MODEL_LOAD_LOCK:
        if _MODEL is not None:
            return
        from ..kokoro_helper import KokoroTTS

        local_dir = detect_local_dir(_LOCAL_DIR_OVERRIDE)
        print(
            f"[tts-manager] loading model (local_dir={local_dir}, threads={_THREADS})...",
            flush=True,
        )
        _MODEL = KokoroTTS.from_pretrained(threads=_THREADS, local_dir=local_dir)
        print("[tts-manager] model loaded", flush=True)
    # A fresh load counts as activity so the just-loaded model isn't unloaded by
    # a monitor tick that fires immediately after (e.g. a 60s window and a load
    # that landed 59s into the current interval). Bump OUTSIDE the load lock — the
    # monitor takes the same lock to unload, so bumping under it is unnecessary and
    # keeps the critical section to model construction only.
    mark_activity()


# ── idle auto-unload ────────────────────────────────────────────────────────
def mark_activity() -> None:
    """Record that the TTS model was just used. Called by the /tts, /prepare and
    /download handlers and on each successful load. The idle monitor measures
    wall time since this stamp to decide when to unload."""
    global _LAST_ACTIVITY
    with _ACTIVITY_LOCK:
        _LAST_ACTIVITY = _time.monotonic()


def seconds_since_activity() -> float:
    with _ACTIVITY_LOCK:
        last = _LAST_ACTIVITY
    return _time.monotonic() - last


def unload_model_locked(min_idle_seconds: float | None = None) -> bool:
    """Drop the resident model so its ~500 MB is reclaimed; the next /prepare
    reloads it from the on-disk weights. Idempotent and safe to call when nothing
    is loaded — returns False in that case (this is the guard that keeps the idle
    feature inert until a model has actually been loaded). Returns True when a
    resident model was released.

    ``min_idle_seconds`` closes a TOCTOU with the idle monitor. The monitor decides
    to unload OUTSIDE this lock (see _idle_unload_tick), so a /tts or /prepare can
    land in the gap between that decision and this critical section. When a value is
    passed, we RE-CHECK ``seconds_since_activity() >= min_idle_seconds`` under
    ``_MODEL_LOAD_LOCK`` and bail (return False) if activity is fresh — otherwise a
    🔊 re-activation exactly at the boundary could mark_activity(), have
    start_prepare_if_idle() see is_loaded() still True (so it starts NO load), and
    then get the model dropped here, leaving narration ON with no model and nothing
    reloading it. Callers doing an explicit unload (tests, teardown) pass None to
    skip the re-check.

    Serialized under the SAME lock as construction (``_MODEL_LOAD_LOCK``) so it
    can never race a concurrent load_model_locked() (the two can't half-overlap:
    one finishes before the other's critical section starts). It ALSO briefly
    takes ``INFERENCE_LOCK`` while nulling ``_MODEL`` so it can't tear the session
    out from under an in-flight /tts:
      - a synthesis already inside INFERENCE_LOCK (mid generate()) holds the lock,
        so this unload blocks until it finishes; and
      - a synthesis still WAITING on INFERENCE_LOCK re-reads get_model() once it
        acquires the lock (see api/tts._synthesize) and observes ``_MODEL is None``,
        so it 503s cleanly instead of running generate() on a retired session.
    That re-read inside the lock — NOT the pre-lock capture — is what makes this
    safe if unload is ever extended to real teardown (e.g. explicitly releasing the
    onnxruntime session). The lock order here (``_MODEL_LOAD_LOCK`` →
    ``INFERENCE_LOCK``) is the only order any code path takes, so there is no ABBA
    deadlock."""
    global _MODEL
    with _MODEL_LOAD_LOCK:
        if _MODEL is None:
            return False
        # Re-check activity UNDER the lock: the monitor's idle decision was made
        # outside this lock, so an activity bump (a /tts or /prepare 🔊 click) may
        # have landed since. Bailing on fresh activity means every ordering either
        # keeps the model (activity seen here) or reloads it (start_prepare_if_idle
        # saw is_loaded() False and started a load) — never "unloaded with no
        # reload while narration is on".
        if min_idle_seconds is not None and seconds_since_activity() < min_idle_seconds:
            return False
        # Also serialize against an in-flight /tts: hold the inference lock while
        # we drop the reference so a request that already passed the is_loaded()
        # gate can finish, and a request that is waiting on INFERENCE_LOCK re-reads
        # get_model()==None after we release and 503s cleanly rather than touching
        # a torn-down session.
        with INFERENCE_LOCK:
            _MODEL = None
        # Reset the download/status projection to a clean pre-load state so
        # /health and /status report "needs_download"/model_loaded=False again,
        # matching the true residency. Only downgrade a terminal "ready" state —
        # never stomp an in-flight download/verify/load that a racing /prepare or
        # /download may have just started (dl_begin_if_idle guards those).
        if dl_state_get("state") == "ready":
            set_dl(state="idle", error=None, done_bytes=0, total_bytes=0)
    # Return the freed native buffers to the allocator promptly rather than
    # waiting for the next incidental collection.
    gc.collect()
    print("[tts-manager] model unloaded (idle); RAM reclaimed", flush=True)
    return True


def _idle_unload_tick(idle_seconds: float) -> bool:
    """One monitor evaluation: unload iff a model is resident AND it has been idle
    for at least ``idle_seconds``. Split out from the loop so tests can drive a
    single deterministic tick without sleeping. Returns True if it unloaded."""
    if not is_loaded():
        # Feature is inert when nothing is loaded — no model weight, no unload.
        return False
    if seconds_since_activity() < idle_seconds:
        return False
    # Pass the window so unload re-checks activity UNDER _MODEL_LOAD_LOCK: the
    # is-idle test just above ran outside the lock, so a /tts or /prepare may land
    # in the gap. The in-lock re-check is authoritative and closes that TOCTOU.
    return unload_model_locked(min_idle_seconds=idle_seconds)


def start_idle_unload_monitor(idle_seconds: float, poll_seconds: float | None = None) -> threading.Thread | None:
    """Start the daemon thread that unloads the model after ``idle_seconds`` with
    no activity. A non-positive ``idle_seconds`` disables the feature (returns
    None — the model then stays resident until the process exits).

    The poll cadence defaults to a fraction of the window (so a 60s test window
    checks every ~5s and a 1h default checks every ~60s), clamped to [1s, 60s]."""
    if idle_seconds <= 0:
        print("[tts-manager] idle auto-unload disabled (KOKORO_TTS_IDLE_UNLOAD_SECONDS <= 0)", flush=True)
        return None
    if poll_seconds is None:
        poll_seconds = min(60.0, max(1.0, idle_seconds / 12.0))

    def _loop() -> None:
        while True:
            _time.sleep(poll_seconds)
            try:
                _idle_unload_tick(idle_seconds)
            except Exception as exc:  # noqa: BLE001 — a monitor hiccup must never kill the thread
                print(f"[tts-manager] WARNING: idle-unload tick failed: {type(exc).__name__}: {exc}", flush=True)

    print(
        f"[tts-manager] idle auto-unload monitor started "
        f"(unload after {idle_seconds:.0f}s idle, poll every {poll_seconds:.0f}s)",
        flush=True,
    )
    t = threading.Thread(target=_loop, name="tts-idle-unload", daemon=True)
    t.start()
    return t
