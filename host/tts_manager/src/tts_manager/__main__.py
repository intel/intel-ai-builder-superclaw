"""Process entrypoint for tts_manager.

Boot sequence:

1. Parse argv (``--port`` required, ``--host`` default ``127.0.0.1`` — loopback
   only; no sandbox role reaches this service, audio flows UI → ServiceHub → here).
2. Read ServiceHub-injected env (``SERVICEHUB_SERVICE_NAME`` /
   ``SERVICEHUB_INSTANCE_ID``, contract §4) with dev-friendly fallbacks, and the
   onnxruntime thread cap ``KOKORO_TTS_THREADS`` (default 6) — ServiceHub passes
   only ``--host``/``--port`` on argv, so the cap comes from env.
3. Build FastAPI app; store the ``uvicorn.Server`` on ``app.state.server`` so
   ``POST /tts-narration/v1/shutdown`` can trigger a graceful exit (contract §7).

LAZY RESIDENCY: the ~350 MB model is NOT loaded here — it loads on first use via
``POST …/prepare`` or after a consented ``POST …/download`` (those routes start a
background load thread and return 202). The heavy native C-extensions
(onnxruntime/spacy/thinc/misaki) ARE imported here, though: ``run()`` calls
``ms.warm_native_imports()`` synchronously on the main thread *before* the port
binds (see the comment there for why the main-thread, pre-bind placement is
mandatory — an EDR loader-lock deadlock on background-thread first-import). Only
the C-extension import cost is paid at startup; the model session stays lazy.
Two placements were rejected in production: warming inside the /prepare or
/download handler runs on the event loop and starves ``/health`` until the
watchdog kills the child; warming on the background load thread hits the
loader-lock deadlock. The pre-bind warmup delays the port bind (~5s warm; longer
on a cold, AV-scanned disk), which is why tts_manager carries a generous
``ready_timeout_s`` and, being optional, starts last so nothing waits on it.

Run standalone via::

    uv run python -u -m tts_manager --port 18827
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
from .synth import model_state as ms

_DEV_SERVICE_NAME = "tts_manager"
_DEV_INSTANCE_ID = "dev-instance"


def _parse_args(argv: list[str] | None = None) -> RuntimeConfig:
    parser = argparse.ArgumentParser(
        prog="tts_manager",
        description="SuperClaw TTS Manager (native-host Kokoro-82M narration).",
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
            "Bind host (default 127.0.0.1 — loopback only). No sandbox role reaches "
            "this service; audio flows UI → ServiceHub → tts_manager."
        ),
    )
    ns = parser.parse_args(argv)

    service_name = os.environ.get("SERVICEHUB_SERVICE_NAME") or _DEV_SERVICE_NAME
    instance_id = os.environ.get("SERVICEHUB_INSTANCE_ID") or _DEV_INSTANCE_ID
    process_credential = os.environ.get("SERVICEHUB_PROCESS_CREDENTIAL", "")
    if os.environ.get("SERVICEHUB_MANAGED") == "1" and not process_credential:
        parser.error("SERVICEHUB_PROCESS_CREDENTIAL is required in managed mode")

    try:
        threads = int(os.environ.get("KOKORO_TTS_THREADS", "6"))
    except ValueError:
        threads = 6
    if threads < 0:
        threads = 6

    return RuntimeConfig(
        host=ns.host,
        port=ns.port,
        service_name=service_name,
        instance_id=instance_id,
        threads=threads,
        process_credential=process_credential,
    )


def run() -> None:
    """Entry-point for `python -m tts_manager`."""
    if getattr(sys, "frozen", False):
        multiprocessing.freeze_support()
    install_crash_hooks(
        service="tts_manager", release=resolve_app_version(package_version=__version__)
    )
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except (AttributeError, ValueError):
        pass

    cfg = _parse_args()
    os.environ.pop("SERVICEHUB_PROCESS_CREDENTIAL", None)
    os.environ.pop("SERVICEHUB_MANAGED", None)
    ms.set_threads(cfg.threads)

    # Warm the heavy native C-extensions HERE — synchronously, before the port
    # binds and before uvicorn creates the event loop or any worker thread. This
    # is the ONLY place the process is single-threaded, and single-threaded is the
    # one warmup location that cannot deadlock: on this managed endpoint an
    # endpoint-security DLL (umppc*.dll) hooks LoadLibrary, and a first-time native
    # import from a *secondary* thread while the main thread is elsewhere blocks
    # forever on that hook (confirmed by py-spy: a background-thread `import numpy`
    # hung in LoadLibraryExW with flat CPU). Warming at startup takes the loader
    # lock while we are the only thread, so every later import (from the background
    # model-load thread) is a cache hit and the hook is never re-armed.
    #
    # This does delay the port bind by the warmup time (~5s warm; longer on a cold,
    # AV-scanned disk), so ServiceHub readiness waits that long — which is why
    # tts_manager carries a generous ready_timeout_s. That cost is free: tts_manager
    # is optional and starts LAST, after the other children are already ready, so
    # nothing waits on it and a slow warmup blocks no other service.
    #
    # Rejected alternatives (both regressed in production): warming inside the
    # /prepare or /download route handler runs on the event-loop thread and starves
    # /health long enough for the watchdog to kill the child; warming on the
    # background load thread hits the loader-lock deadlock above.
    ms.warm_native_imports()

    # Idle auto-unload: reclaim the resident model's ~500 MB after a stretch with
    # no TTS activity (no /tts, /prepare or /download). Default 1 hour; set
    # KOKORO_TTS_IDLE_UNLOAD_SECONDS=60 for a quick load→idle→unload memory check,
    # or <= 0 to disable. The monitor is a no-op until a model is actually loaded
    # (a user who never enables narration pays nothing), and the next 🔊 click
    # re-triggers /prepare to reload it. Start it AFTER warmup so the stamp the
    # monitor measures from is fresh and the warmup delay isn't counted as idle.
    _raw_idle = os.environ.get("KOKORO_TTS_IDLE_UNLOAD_SECONDS")
    try:
        idle_unload_seconds = float(
            _raw_idle if _raw_idle is not None else str(ms.DEFAULT_IDLE_UNLOAD_SECONDS)
        )
    except ValueError:
        # Log the substitution so an operator who fat-fingered the value can learn
        # from the child log why their configured window had no effect, instead of
        # silently getting the default.
        print(
            f"[tts-manager] WARNING: KOKORO_TTS_IDLE_UNLOAD_SECONDS={_raw_idle!r} is not "
            f"a number; using default {ms.DEFAULT_IDLE_UNLOAD_SECONDS}s.",
            flush=True,
        )
        idle_unload_seconds = float(ms.DEFAULT_IDLE_UNLOAD_SECONDS)
    # float() accepts "nan"/"inf": a NaN window would enable the monitor (nan <= 0
    # is False) yet never fire (seconds_since_activity() < nan is always False), so
    # the model would silently stay resident forever — the opposite of a fat-finger
    # user's intent. Fall back to the default so a malformed value fails safe to the
    # documented 1-hour behavior rather than quietly disabling the feature. (inf is
    # left as-is: it means "effectively never unload", a coherent choice, and <= 0
    # still disables explicitly.)
    if math.isnan(idle_unload_seconds):
        print(
            f"[tts-manager] WARNING: KOKORO_TTS_IDLE_UNLOAD_SECONDS={_raw_idle!r} is NaN; "
            f"using default {ms.DEFAULT_IDLE_UNLOAD_SECONDS}s.",
            flush=True,
        )
        idle_unload_seconds = float(ms.DEFAULT_IDLE_UNLOAD_SECONDS)
    ms.mark_activity()
    ms.start_idle_unload_monitor(idle_unload_seconds)

    app = build_app(cfg)

    logger.info(
        "service.startup pid={} version={} host={} port={} service={} instance_id={} threads={}",
        os.getpid(),
        __version__,
        cfg.host,
        cfg.port,
        cfg.service_name,
        cfg.instance_id,
        cfg.threads,
    )

    uv_config = uvicorn.Config(
        app,
        host=cfg.host,
        port=cfg.port,
        log_config=None,
        access_log=False,
    )
    server = uvicorn.Server(uv_config)
    # Store the server on app.state so `POST /tts-narration/v1/shutdown`
    # (contract §7) can flip `should_exit` for a graceful drain + exit.
    app.state.server = server

    try:
        asyncio.run(server.serve())
    except KeyboardInterrupt:
        pass
    finally:
        logger.info("service.shutdown pid={} version={}", os.getpid(), __version__)


if __name__ == "__main__":  # pragma: no cover
    run()
