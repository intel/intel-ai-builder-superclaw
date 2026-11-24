"""Liveness + ServiceHub contract endpoints, all under /tts-narration/v1.

    GET  /tts-narration/v1/health   — {service, status, pid, instance_id, version,
                                       model_loaded, weights_present, model_status, voices}
    GET  /tts-narration/v1/status   — {state, version, summary} per-service template
                                       (contract §6); a 404 here makes the Hub report
                                       status_supported: false
    GET  /tts-narration/v1/version  — {version}
    POST /tts-narration/v1/shutdown — flips app.state.server.should_exit (contract §7)

HEALTH PAYLOAD RECONCILIATION (the one real semantic collision with the old
container service). ServiceHub readiness (readiness.py) requires top-level
``status == "ok"``. The old container ``/health`` overloaded ``status`` with model
state (ok / loading / needs_download), so a cold service would report
``needs_download`` and ServiceHub would deem the child never-ready and (being
optional) skip it — hiding 🔊 forever.

Fix: top-level ``status`` is now the LIVENESS field (always ``"ok"`` once serving),
and model state moves to distinct fields the UI already reads
(``model_loaded`` / ``weights_present``) plus a descriptive ``model_status``
(ok / loading / needs_download) for diagnostics. No UI code reads top-level
``.status`` from health; the download poll reads ``.state`` from /download/status,
which is unchanged.
"""

from __future__ import annotations

import os
import secrets

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

from .. import __version__
from ..synth import model_state as ms

_PREFIX = "/tts-narration/v1"

meta_router = APIRouter(prefix=_PREFIX, tags=["meta"])


def _model_status() -> str:
    """Descriptive model state (NOT the liveness ``status``): ok once resident;
    loading while a download or model build is in flight; needs_download when no
    weights are on disk yet (the UI shows the consent dialog in that case)."""
    if ms.is_loaded():
        return "ok"
    if ms.dl_state_get("state") in ("downloading", "verifying", "loading"):
        return "loading"
    return "needs_download"


@meta_router.get("/health")
async def health(request: Request) -> dict[str, object]:
    """Health readiness per ServiceHub sub-service contract §5, extended with the
    TTS model snapshot the UI reads.

    Top-level ``status`` is ALWAYS ``"ok"`` once the server is answering — it is
    the liveness signal ServiceHub gates on, not model state. Model state lives in
    ``model_loaded`` / ``weights_present`` / ``model_status``."""
    from ..voices import load_voices

    ref_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    try:
        voices = sorted(load_voices(ref_dir).keys())
    except Exception:  # noqa: BLE001 — voices.json missing/corrupt must not fail liveness
        voices = []
    return {
        "service": request.app.state.service_name,
        "status": "ok",
        "pid": os.getpid(),
        "instance_id": request.app.state.instance_id,
        "version": __version__,
        "model_loaded": ms.is_loaded(),
        "weights_present": ms.model_present(),
        "model_status": _model_status(),
        "voices": voices,
    }


@meta_router.get("/status")
async def status(request: Request) -> dict[str, object]:
    """ServiceHub per-service template status (contract §6).

    The Hub's ``GET /app/services/status`` aggregate probes ``<prefix>/v1/status``
    on every child and echoes the JSON body back under ``status``; a 404 here is
    exactly what makes the Hub mark a child ``status_supported: false``. Without
    this route tts_manager is observable only as process liveness — the Hub sees
    ``state: running`` with ``status: null`` and cannot tell whether the voice
    model is resident, downloading, or absent.

    Returns the same ``{state, version, summary}`` shape as the sibling
    sub-services (llmrouter_manager, sandbox_manager) so the aggregate stays
    uniform across children. ``summary.tts`` is a cheap, in-memory projection: it
    mirrors the model fields ``/health`` reports plus the live ``/download/status``
    snapshot, all read from ``model_state`` without touching disk.

    Deliberately no ``load_voices()`` call here — that is file IO that can raise on
    a missing/corrupt ``voices.json``, and a Hub status probe must never be able to
    fail or stall the aggregate. Voice ids stay on ``/health``.
    """
    return {
        "state": "running",
        "version": __version__,
        "summary": {
            "tts": {
                "model_loaded": ms.is_loaded(),
                "weights_present": ms.model_present(),
                "model_status": _model_status(),
                "threads": ms.threads(),
                "download": ms.dl_snapshot(),
            }
        },
    }


@meta_router.get("/version")
async def version() -> dict[str, str]:
    return {"version": __version__}


@meta_router.post("/shutdown")
async def shutdown(request: Request) -> JSONResponse:
    """Graceful shutdown per ServiceHub sub-service contract §7 — flips
    ``uvicorn.Server.should_exit`` so the server drains and exits."""
    expected = getattr(request.app.state, "process_credential", "")
    supplied = request.headers.get("X-SuperClaw-Process-Credential", "")
    if not expected or not secrets.compare_digest(expected, supplied):
        raise HTTPException(status_code=403, detail="shutdown_forbidden")
    server = getattr(request.app.state, "server", None)
    if server is None:
        return JSONResponse({"state": "stopping", "detail": "no supervisor attached"})
    server.should_exit = True
    return JSONResponse({"state": "stopping"})
