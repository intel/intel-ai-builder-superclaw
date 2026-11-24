"""ServiceHub readiness + lifecycle endpoints under ``/sandbox-manager/v1``.

Implements the ServiceHub sub-service contract
(``2026-07-01_servicehub_subservice_development_contract``):

* ``GET /sandbox-manager/v1/health`` — readiness probe polled by ServiceHub
  after it spawns ``python -m sandbox_manager --port <port>``.  The body echoes
  the injected ``SERVICEHUB_SERVICE_NAME`` / ``SERVICEHUB_INSTANCE_ID`` so the
  Hub can reject a stale fixed-port process squatting on the port.
* ``GET /sandbox-manager/v1/version`` — reports the running sub-service build
  (``{service, version, instance_id}``).  Whitelisted alongside ``/health`` on
  the Hub's auth edge (``*/v1/version``), so it is reachable without a token.
* ``GET /sandbox-manager/v1/status`` — ServiceHub per-service *template* status
  (``{state, version, summary}``).  This is the path the Hub's ``/app/services``
  status aggregate probes for every child; a 404 here is what makes the Hub
  report ``status_supported: false``.  ``summary.sandbox`` carries a cheap,
  store-only projection of the sandbox flow (shared with ``/system/status``);
  the richer sandbox/host domain snapshot still lives at
  ``GET /sandbox-manager/v1/system/status``.
* ``POST /sandbox-manager/v1/shutdown`` — graceful drain + exit.  Signals the
  uvicorn server to stop accepting connections, finish in-flight requests, and
  run lifespan shutdown (native backend teardown + store close).

Health, version, and status are unauthenticated. Shutdown requires the
ServiceHub-injected process credential before it changes server state.

``SERVICEHUB_*`` env vars are read with tolerant defaults (decision O1) so the
endpoints also work under unit tests and standalone dev where the Hub — and
therefore its injected env — is absent.
"""

from __future__ import annotations

import os

from fastapi import APIRouter, Depends, Request
from loguru import logger

from ..process_auth import require_process_credential

from ...native_readiness import native_components
from ...version import get_app_version
from .system import compute_sandbox_flow


router = APIRouter()

#: Fallbacks used when ServiceHub has not injected its env (unit tests / dev).
_DEFAULT_SERVICE_NAME = "sandbox_manager"
_DEFAULT_INSTANCE_ID = "dev-instance"


@router.get("/health")
async def health() -> dict[str, object]:
    """ServiceHub readiness probe.

    Returns the contract-required ``{service, status, pid, instance_id}``.
    ``service`` and ``instance_id`` are echoed from the ServiceHub-injected
    environment (falling back to dev defaults) so the Hub can detect a stale
    process still holding the fixed port after a restart.
    """
    return {
        "service": os.environ.get("SERVICEHUB_SERVICE_NAME", _DEFAULT_SERVICE_NAME),
        "status": "ok",
        "pid": os.getpid(),
        "instance_id": os.environ.get("SERVICEHUB_INSTANCE_ID", _DEFAULT_INSTANCE_ID),
    }


@router.get("/version")
async def version() -> dict[str, str]:
    """Report the running sub-service build.

    The version comes from :func:`sandbox_manager.version.get_app_version` —
    the same resolver used by the root ``/version`` and ``/system/status`` — so
    a frozen installer build reports the full product version
    (``x.y.z.<Mdd>``, e.g. ``1.0.0.701``) from the ``VERSION`` file rather than
    the static ``__version__`` base.

    This is the Hub-proxied counterpart to the root ``/version``: ServiceHub
    only forwards ``/sandbox-manager/*`` and whitelists ``*/v1/version`` on its
    auth edge, so operators can query it without a bearer token.  Echoes the
    injected identity for the same stale-process disambiguation as
    :func:`health`.
    """
    return {
        "service": os.environ.get("SERVICEHUB_SERVICE_NAME", _DEFAULT_SERVICE_NAME),
        "version": get_app_version(),
        "instance_id": os.environ.get("SERVICEHUB_INSTANCE_ID", _DEFAULT_INSTANCE_ID),
    }


@router.get("/status")
async def status(request: Request) -> dict[str, object]:
    """ServiceHub per-service template status.

    The Hub's ``GET /app/services/status`` aggregate probes ``<prefix>/v1/status``
    on every child and echoes the JSON body back under ``status``; a 404 is what
    makes the Hub mark a service ``status_supported: false``.  We return the same
    ``{state, version, summary}`` template shape as the other sub-services
    (llmrouter_manager).

    ``summary.sandbox`` is a cheap, store-only projection of the sandbox flow
    (:func:`sandbox_manager.api.v1.system.compute_sandbox_flow`) — the same
    ``{state, pct, active_operation_id?}`` the Hub would otherwise have to fetch
    from the heavier ``GET /sandbox-manager/v1/system/status``.  It is computed
    from a single shared helper so the two surfaces cannot drift.  When no store
    is attached (unit tests, or ASGI hosts that build the app without ``run()``),
    ``summary`` stays empty (decision O1) rather than raising.
    """
    summary: dict[str, object] = {}
    store = getattr(request.app.state, "store", None)
    if store is not None:
        summary["sandbox"] = compute_sandbox_flow(store)
    return {
        "state": "running",
        "version": get_app_version(),
        "summary": summary,
    }


@router.get("/readiness")
async def readiness(request: Request) -> dict[str, object]:
    """Runtime readiness evidence for ServiceHub's `/app/readiness` projection.

    Reports the four execution-plane facts SandboxManager owns as independent
    evidence nodes; ServiceHub aggregates them with its own host-service evidence.
    Bounded and side-effect free: nothing here starts the backend, issues a token,
    or triggers provisioning.

    No timestamp is returned on purpose. Freshness is stamped by ServiceHub when it
    receives this payload, on ServiceHub's own clock — these are separate processes,
    and trusting a child's wall clock to decide whether evidence is stale would make
    staleness depend on clock skew between them.

    Tolerant when the lifecycle is absent (unit tests, or ASGI hosts that build the
    app without `run()`), following the same decision-O1 pattern as `/status`:
    reports `evidence_unavailable` rather than raising, so an incomplete read can
    never be mistaken for a healthy runtime.
    """
    components = await native_components(getattr(request.app.state, "lifecycle", None))
    return {"contract_version": 1, "components": [item.as_dict() for item in components]}


@router.post("/shutdown", dependencies=[Depends(require_process_credential)])
async def shutdown(request: Request) -> dict[str, str]:
    """Signal a graceful shutdown, then return immediately.

    ServiceHub calls this to drain the sub-service before exit.  We flip
    ``uvicorn.Server.should_exit`` (stashed on ``app.state.server`` by
    :func:`sandbox_manager.main.run`) so uvicorn stops accepting new
    connections, lets in-flight requests — including this one — finish, then
    runs the lifespan shutdown that tears down the native backend and closes
    the store.

    Tolerant when no server is attached (unit tests, or ASGI hosts that build
    the app without ``run()``): still returns 200 so callers get a consistent
    contract response.
    """
    logger.info("shutdown requested by ServiceHub")
    lifecycle = getattr(request.app.state, "lifecycle", None)
    prepare_shutdown = getattr(lifecycle, "prepare_shutdown", None)
    if callable(prepare_shutdown):
        prepare_shutdown()
    server = getattr(request.app.state, "server", None)
    if server is not None:
        server.should_exit = True
    return {"state": "stopping"}
