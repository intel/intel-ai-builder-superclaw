"""Liveness + ServiceHub contract endpoints, all under /speech-to-text/v1.

    GET  /speech-to-text/v1/health   -- {service, status, pid, instance_id, version,
                                         model_loaded, weights_present, model_status,
                                         model, language, sample_rate}
    GET  /speech-to-text/v1/status   -- {state, version, summary} per-service template
                                         (sub-service contract §6); a 404 here makes
                                         the Hub report status_supported: false
    GET  /speech-to-text/v1/version  -- {version}
    POST /speech-to-text/v1/shutdown -- flips app.state.server.should_exit (§7)

TOP-LEVEL ``status`` IS LIVENESS ONLY -- ALWAYS ``"ok"`` ONCE SERVING.
This is the single most expensive mistake available in this file, and it has
already been paid for once. ServiceHub's ``readiness.py`` gates a child on
top-level ``status == "ok"``; the old TTS container overloaded that field with
model state (``ok`` / ``loading`` / ``needs_download``), so a service that was
answering perfectly but had no weights yet reported ``needs_download``, the hub
concluded the child was never ready and -- being optional -- skipped it, and the
feature was invisible forever. For an ``on_demand`` service the trap is worse:
the FIRST request is what cold-starts the process, so a never-ready verdict is
also never self-correcting. Model state therefore lives in ``model_loaded`` /
``weights_present`` / ``model_status``.

NEITHER /health NOR /version COLD-STARTS THIS SERVICE. The hub whitelists both by
suffix and answers ``service_dormant`` 503 for a dormant ``on_demand`` child
rather than launching it (otherwise any health poller would keep a 1 GB model
process alive). A UI that polled ``/health`` for ``weights_present`` could not
distinguish "never downloaded" from "not running", which is why
``weights_present`` is also in ``GET /download/status`` -- the wake endpoint. See
``api/asr.py``.
"""

from __future__ import annotations

import os
import secrets

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from .. import __version__
from ..recognize import model_state as ms
from .errors import error_response

_PREFIX = "/speech-to-text/v1"

meta_router = APIRouter(prefix=_PREFIX, tags=["meta"])


def model_status() -> str:
    """Descriptive model state (NOT the liveness ``status``).

    EXACTLY THREE VALUES, because the frozen transcribe contract §3 pins the enum
    to ``"ok" | "loading" | "needs_download"``:

    ``ok``              the model is usable: either resident, or its weights are on
                        disk and the next /prepare or /transcribe loads them. This
                        covers the NORMAL resting state of a lazy service
                        (downloaded, not resident) -- reporting ``needs_download``
                        there is the tts_manager bug that would send a user who
                        already fetched 630 MB back through the consent dialog.
    ``loading``         a download, verify or model build is in flight.
    ``needs_download``  the UI must offer a download: no weights on disk, or the
                        last download/load FAILED (``model_present()`` is a pure
                        ``is_file()`` check, so a truncated file still reads as
                        present, and re-fetching is the fix either way).

    ``needs_download`` alongside ``weights_present: true`` therefore reads as a
    contradiction and is not one: it means "there are files on disk but they are not
    usable, so send the user back through the download". That is only honest because
    POST /download entered from the error state RE-VERIFIES each file's sha256 and
    re-fetches whichever one is bad (see ``recognize/download.py``). If that path
    were ever reverted to trusting ``model_present()``, this branch would be pointing
    the user at a button that cannot help them.

    A four- or five-value enum (adding ``idle`` / ``error``) would carry more
    information and an earlier revision of this file did emit those, but the
    contract is shared verbatim with the UI PR and the two agents do not talk:
    agent B writes a three-way switch, so a fourth value lands in whatever its
    default branch does -- constantly, since ``idle`` is the steady state. Widening
    §3 is a cross-PR change and belongs to the main agent, not to this service.

    Nothing is lost meanwhile. The finer state is already on the wire in the
    endpoint the UI actually polls: ``GET /download/status`` carries
    ``state`` (idle | downloading | verifying | loading | ready | error), ``error``
    and ``model_loaded`` (contract §4), and /transcribe still distinguishes
    ``model_not_downloaded`` / ``model_loading`` / ``model_load_failed`` (§8a).
    """
    if ms.is_loaded():
        return "ok"
    state = ms.dl_state_get("state")
    if state in ("downloading", "verifying", "loading"):
        return "loading"
    if state == "error" or not ms.model_present():
        return "needs_download"
    return "ok"


@meta_router.get("/health")
async def health(request: Request) -> dict[str, object]:
    """Health readiness per ServiceHub sub-service contract §5, plus the ASR model
    snapshot.

    Deliberately touches NO disk beyond the four ``is_file()`` probes in
    ``model_present()`` and never imports onnxruntime: the hub's watchdog polls
    this, and a health check that can block is a health check that gets the child
    killed.
    """
    return {
        "service": request.app.state.service_name,
        "status": "ok",
        "pid": os.getpid(),
        "instance_id": request.app.state.instance_id,
        "version": __version__,
        "model_loaded": ms.is_loaded(),
        "weights_present": ms.model_present(),
        "model_status": model_status(),
        # Static capability advertisement so the UI can render "English only" and
        # assert its capture rate without hard-coding either. English-only is a
        # property of Parakeet TDT 0.6B v2, not a configuration.
        "model": ms.MODEL_ID,
        "language": "en",
        "sample_rate": ms.SAMPLE_RATE,
    }


@meta_router.get("/status")
async def status() -> dict[str, object]:
    """ServiceHub per-service template status (sub-service contract §6).

    The hub's ``GET /app/services/status`` aggregate probes ``<prefix>/v1/status``
    on every child and echoes the body back; a 404 is exactly what makes a child
    show up as ``status_supported: false``. Same ``{state, version, summary}``
    shape as the sibling children so the aggregate stays uniform.

    ``summary.asr`` is a cheap in-memory projection -- no disk beyond
    ``model_present()``, no model import -- because a status probe must never be
    able to stall the aggregate for every other service.
    """
    return {
        "state": "running",
        "version": __version__,
        "summary": {
            "asr": {
                "model": ms.MODEL_ID,
                "model_loaded": ms.is_loaded(),
                "weights_present": ms.model_present(),
                "model_status": model_status(),
                "missing_files": list(ms.missing_files()),
                # The exact fetch size. NOT in the frozen contract's
                # /download/status snapshot, which reports ``total_bytes: 0`` until a
                # download is actually running (§4); this template endpoint is where
                # ops can read the figure at any time.
                "total_download_bytes": ms.TOTAL_DOWNLOAD_BYTES,
                "threads": ms.threads(),
                "idle_seconds": round(ms.seconds_since_activity(), 1),
                "download": ms.dl_snapshot(),
            }
        },
    }


@meta_router.get("/version")
async def version() -> dict[str, str]:
    return {"version": __version__}


@meta_router.post("/shutdown")
async def shutdown(request: Request) -> JSONResponse:
    """Graceful shutdown per sub-service contract §7 -- flips
    ``uvicorn.Server.should_exit`` so the server drains and exits.

    Credential-gated with ``secrets.compare_digest``: the hub injects
    ``SERVICEHUB_PROCESS_CREDENTIAL`` at spawn and sends it in
    ``X-SuperClaw-Process-Credential``. An empty expected value denies everything
    (a dev run without the env var cannot be shut down over HTTP -- Ctrl-C works),
    so a missing credential fails closed instead of making the endpoint public.

    A resident model is NOT unloaded first: the process is about to exit, so the
    OS reclaims the ~1 GB either way, and an unload would block the response
    behind ``INFERENCE_LOCK`` until an in-flight transcribe finished, pushing us
    past the 10 s ``shutdown_grace_s`` into a hard kill.
    """
    expected = getattr(request.app.state, "process_credential", "")
    supplied = request.headers.get("X-SuperClaw-Process-Credential", "")
    if not expected or not secrets.compare_digest(expected, supplied):
        return error_response(
            403, "shutdown_forbidden", "a valid process credential is required"
        )
    server = getattr(request.app.state, "server", None)
    if server is None:
        return JSONResponse({"state": "stopping", "detail": "no supervisor attached"})
    server.should_exit = True
    return JSONResponse({"state": "stopping"})
