"""Process entrypoint for asr_manager.

Boot sequence:

1. Parse argv (``--port`` required, ``--host`` default ``127.0.0.1`` -- loopback
   only; no sandbox role reaches this service, audio flows UI -> ServiceHub -> here).
2. Read ServiceHub-injected env (``SERVICEHUB_SERVICE_NAME`` /
   ``SERVICEHUB_INSTANCE_ID``, sub-service contract §4) with dev-friendly
   fallbacks, plus the onnxruntime thread cap ``PARAKEET_ASR_THREADS`` (default
   ``_default_threads()``: half the physical cores, clamped to [2, 6]) --
   ServiceHub passes only ``--host``/``--port`` on argv.
3. Warm the native C-extensions on the main thread, BEFORE the port binds.
4. Start the idle-unload monitor.
5. Build the app and store the ``uvicorn.Server`` on ``app.state.server`` so
   ``POST /speech-to-text/v1/shutdown`` can drain gracefully (§7).

LAZY RESIDENCY: the ~630 MB model is NOT loaded here. It loads on first use via
``POST .../prepare`` or after a consented ``POST .../download``, both of which
return 202 and load on a background thread. What IS paid at startup is the
C-extension import cost (numpy/onnxruntime), because ``ms.warm_native_imports()``
must run while this process is still single-threaded -- see the long comment in
``run()``. That keeps the ``on_demand`` cold-start bind fast enough for the hub's
readiness wait while idle RSS for a user who never dictates stays near zero.

Run standalone via::

    uv run python -u -m asr_manager --port 18829
"""

from __future__ import annotations

import argparse
import asyncio
import math
import multiprocessing
import os
import sys

import uvicorn
from loguru import logger
from superclaw_host_observability import install_crash_hooks, resolve_app_version

from . import __version__
from .app import build_app
from .config import RuntimeConfig
from .recognize import model_state as ms

_DEV_SERVICE_NAME = "asr_manager"
_DEV_INSTANCE_ID = "dev-instance"

# onnxruntime intra-op threads. A FRACTION OF THE MACHINE, not a constant.
#
# A fixed number cannot be right on both machines this ships to: 4 threads is 2.3%
# of a 172-logical-CPU workstation and 100% of a 4-core Lite box, where it is
# exactly the llama-server contention a fixed-low value was meant to avoid. So take
# half the (estimated) physical cores, clamped to [2, 6]:
#
#   4 logical /  2 physical -> 2      16 logical /  8 physical -> 4
#   8 logical /  4 physical -> 2      24 logical / 12 physical -> 6
#                                    172 logical / 86 physical -> 6 (cap)
#
# Both ends of the clamp are measured, on a 23.3 s clip with the shipped
# enc_w10_l0p64_r2p56_run preset (median of 3 after warmup, 86-physical-core Xeon,
# onnxruntime 1.30.0): 1 thread 3.255 s, 2 threads 1.971 s, 4 threads 1.313 s,
# 6 threads 1.128 s, 8 threads 1.089 s, 12 threads 1.015 s, 16 threads 0.953 s.
#   - floor 2: the 1->2 step is the single biggest win (1.65x) and one thread is
#     never the right answer even on the smallest box.
#   - cap 6: past 6 the curve is flat -- 16 threads costs 2.7x the cores for 1.18x
#     the speed -- and those cores are what the agent's llama-server is using while
#     the user dictates. 6 also matches tts_manager's KOKORO_TTS_THREADS.
#
# PARAKEET_ASR_THREADS overrides this (0 = let onnxruntime decide); service_cfg.json
# deliberately does NOT set it, so the policy is what runs in production.
_THREAD_CAP = 6
_THREAD_FLOOR = 2


def _default_threads() -> int:
    """Half the physical cores, clamped to ``[_THREAD_FLOOR, _THREAD_CAP]``.

    ``os.cpu_count()`` reports LOGICAL processors and the stdlib has no physical
    count, so physical is estimated as ``logical // 2`` -- SMT/hyper-threading is on
    for every Intel client and Xeon part this ships to, and the clamp absorbs the
    error on the one platform where it is not (an estimate that is 2x too small still
    lands on the floor for a small box and on the cap for a large one). No psutil /
    wmi probe: this runs on the cold-start path, ahead of the port bind the hub is
    timing, and it must not be able to block.
    """
    logical = os.cpu_count() or _THREAD_FLOOR * 2
    physical = max(1, logical // 2)
    return min(_THREAD_CAP, max(_THREAD_FLOOR, physical // 2))


def _parse_args(argv: list[str] | None = None) -> RuntimeConfig:
    parser = argparse.ArgumentParser(
        prog="asr_manager",
        description=(
            "SuperClaw ASR Manager (native-host Parakeet TDT 0.6B v2 int8 "
            "speech-to-text)."
        ),
    )
    parser.add_argument(
        "--port",
        type=int,
        required=True,
        help="TCP port to listen on. Fixed by ServiceHub's service_cfg.json.",
    )
    parser.add_argument(
        "--host",
        type=str,
        default="127.0.0.1",
        help=(
            "Bind host (default 127.0.0.1 -- loopback only). No sandbox role reaches "
            "this service; audio flows UI -> ServiceHub -> asr_manager."
        ),
    )
    ns = parser.parse_args(argv)

    service_name = os.environ.get("SERVICEHUB_SERVICE_NAME") or _DEV_SERVICE_NAME
    instance_id = os.environ.get("SERVICEHUB_INSTANCE_ID") or _DEV_INSTANCE_ID
    process_credential = os.environ.get("SERVICEHUB_PROCESS_CREDENTIAL", "")
    # In managed mode a missing credential would leave /shutdown permanently
    # deniable, so the hub could never stop this child except by killing it. Fail
    # at startup instead of discovering it at shutdown time.
    if os.environ.get("SERVICEHUB_MANAGED") == "1" and not process_credential:
        parser.error("SERVICEHUB_PROCESS_CREDENTIAL is required in managed mode")

    default_threads = _default_threads()
    try:
        threads = int(os.environ.get("PARAKEET_ASR_THREADS", str(default_threads)))
    except ValueError:
        threads = default_threads
    if threads < 0:
        threads = default_threads

    return RuntimeConfig(
        host=ns.host,
        port=ns.port,
        service_name=service_name,
        instance_id=instance_id,
        threads=threads,
        process_credential=process_credential,
    )


def _idle_unload_seconds() -> float:
    """Read PARAKEET_ASR_IDLE_UNLOAD_SECONDS, failing SAFE to the default."""
    raw = os.environ.get("PARAKEET_ASR_IDLE_UNLOAD_SECONDS")
    try:
        value = float(raw if raw is not None else str(ms.DEFAULT_IDLE_UNLOAD_SECONDS))
    except ValueError:
        # Log the substitution: an operator who fat-fingered the value should learn
        # from the child log why their window had no effect.
        print(
            f"[asr-manager] WARNING: PARAKEET_ASR_IDLE_UNLOAD_SECONDS={raw!r} is not a "
            f"number; using default {ms.DEFAULT_IDLE_UNLOAD_SECONDS}s.",
            flush=True,
        )
        return float(ms.DEFAULT_IDLE_UNLOAD_SECONDS)
    # float() accepts "nan"/"inf". A NaN window would ENABLE the monitor (nan <= 0
    # is False) yet never fire (seconds_since_activity() < nan is always False), so
    # ~1 GB would stay pinned forever -- the opposite of what someone setting this
    # variable wants. Fall back to the documented default. inf is left alone: it
    # coherently means "never unload", and <= 0 still disables explicitly.
    if math.isnan(value):
        print(
            f"[asr-manager] WARNING: PARAKEET_ASR_IDLE_UNLOAD_SECONDS={raw!r} is NaN; "
            f"using default {ms.DEFAULT_IDLE_UNLOAD_SECONDS}s.",
            flush=True,
        )
        return float(ms.DEFAULT_IDLE_UNLOAD_SECONDS)
    return value


def run() -> None:
    """Entry-point for ``python -m asr_manager`` and for the frozen role dispatch."""
    if getattr(sys, "frozen", False):
        multiprocessing.freeze_support()
    install_crash_hooks(
        service="asr_manager", release=resolve_app_version(package_version=__version__)
    )
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except (AttributeError, ValueError):
        pass

    cfg = _parse_args()
    # Drop the credential and the managed flag from the environment now that they
    # are captured: this process spawns no children, but a crash dump or a later
    # `os.environ` dump should not carry the hub's shutdown credential.
    os.environ.pop("SERVICEHUB_PROCESS_CREDENTIAL", None)
    os.environ.pop("SERVICEHUB_MANAGED", None)
    ms.set_threads(cfg.threads)

    # Warm the heavy native C-extensions HERE -- synchronously, before the port
    # binds and before uvicorn creates the event loop or any worker thread. This is
    # the ONLY point at which the process is single-threaded, and single-threaded is
    # the one warmup location that cannot deadlock: on this managed endpoint an
    # endpoint-security DLL (umppc*.dll) hooks LoadLibrary, and a first-time native
    # import from a *secondary* thread while the main thread sits in the event loop
    # blocks forever inside LoadLibraryExW (captured by py-spy on tts_manager as a
    # background thread frozen in `create_module` at numpy/_core/multiarray.py, flat
    # CPU, download state stuck at "loading", UI hanging). Warming while we are the
    # only thread takes the loader lock where the hook is safe, so every later
    # import from the background load thread is a cache hit.
    #
    # Both alternatives regressed in production for tts_manager and would regress
    # identically here: warming inside /prepare or /download runs on the event-loop
    # thread and starves /health until the watchdog kills the child; warming on the
    # background load thread hits the deadlock above.
    #
    # This delays the port bind by the warmup time, which is why the service_cfg
    # entry carries a generous ready_timeout_s. It is much cheaper than
    # tts_manager's (~5 s) -- no spaCy/thinc/misaki chain, just numpy +
    # onnxruntime + the pure-Python ENC pipeline.
    ms.warm_native_imports()

    # Idle auto-unload: reclaim the resident model's ~0.8-1.0 GB after a stretch
    # with no /transcribe, /prepare or /download. Default 900 s; set
    # PARAKEET_ASR_IDLE_UNLOAD_SECONDS=60 for a quick load->idle->unload memory
    # check, or <= 0 to disable. Inert until a model is actually loaded, so a user
    # who never dictates pays nothing. Started AFTER warmup so the activity stamp
    # is fresh and the warmup delay is not counted as idle time.
    ms.mark_activity()
    ms.start_idle_unload_monitor(_idle_unload_seconds())

    app = build_app(cfg)

    logger.info(
        "service.startup pid={} version={} host={} port={} service={} instance_id={} "
        "threads={} model_dir={} weights_present={}",
        os.getpid(),
        __version__,
        cfg.host,
        cfg.port,
        cfg.service_name,
        cfg.instance_id,
        cfg.threads,
        ms.model_dir(),
        ms.model_present(),
    )

    uv_config = uvicorn.Config(
        app,
        host=cfg.host,
        port=cfg.port,
        log_config=None,
        access_log=False,
    )
    server = uvicorn.Server(uv_config)
    # On app.state so POST /speech-to-text/v1/shutdown (§7) can flip should_exit
    # for a graceful drain + exit.
    app.state.server = server

    try:
        asyncio.run(server.serve())
    except KeyboardInterrupt:
        pass
    finally:
        logger.info("service.shutdown pid={} version={}", os.getpid(), __version__)


if __name__ == "__main__":  # pragma: no cover
    run()
