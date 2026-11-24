"""``/health`` and ``/version`` (auth-free).

Health is a minimal liveness endpoint for monitoring/ops.  It intentionally
exposes **no** typed lifecycle state (server_state / sandbox_phase) — clients
building UI must use ``GET /sandbox-manager/v1/system/status`` instead.

api.md #1 response shape:
  { status, version,
    model_servers: [{ role, model_id, pid?, uptime_seconds?, restart_count }],
    sandbox: { port, pid? } }
"""

from __future__ import annotations

import math

from fastapi import APIRouter, Request

from ..version import get_app_version


router = APIRouter()


@router.get("/health")
async def health(request: Request) -> dict:
    app = request.app

    # cfg is always present after build_app() completes; raise loudly on
    # any programming error that leaves it unset rather than silently
    # returning an incomplete sandbox block.
    cfg = app.state.config
    supervisor = getattr(app.state, "supervisor", None)

    # --- model_servers ---------------------------------------------------
    model_servers = []
    if supervisor is not None:
        for role, sup in supervisor.items():
            snap = sup.snapshot()
            entry: dict = {
                "role": role,
                "model_id": snap.get("model_id"),
                "restart_count": snap.get("restart_attempts", 0),
            }
            pid = snap.get("pid")
            if pid is not None:
                entry["pid"] = pid
            uptime = snap.get("uptime")
            if uptime is not None:
                entry["uptime_seconds"] = math.floor(uptime)
            model_servers.append(entry)

    # --- sandbox (port always present; pid while the supervised tree runs)
    sandbox: dict = {"port": cfg.sandbox_port}
    lifecycle = getattr(app.state, "lifecycle", None)
    native_status = lifecycle.status() if lifecycle is not None else {}
    native_pid = native_status.get("pid")
    if native_pid is not None:
        sandbox["pid"] = native_pid

    return {
        "status": "ok",
        "version": get_app_version(),
        "model_servers": model_servers,
        "sandbox": sandbox,
    }


@router.get("/version")
async def version() -> dict:
    return {"version": get_app_version()}
