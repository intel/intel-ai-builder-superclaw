"""`GET /app/readiness` — the authoritative App readiness projection (SVC-04).

Two properties of this handler are contract, not implementation detail:

HTTP 200 for every document this can produce, including `starting`, `failed`, and
`unknown`; 5xx means only that ServiceHub could not serve the contract. Returning
503 with the document in the body is the natural Kubernetes-probe reflex and wrong
here: `test_servicehub_backend_readiness.ps1` uses `Invoke-RestMethod` with
`ErrorAction = "Stop"`, and on Windows PowerShell 5.1 a 5xx raises with the body
unreachable -- discarding the diagnostics exactly when an install has failed.

No I/O. The handler serves a snapshot maintained by the watchdog and the runtime
refresher, so a readiness read cannot probe, provision, or activate a dormant
service, and a slow component is reported as `unknown` rather than hanging the
endpoint.

Bearer-protected by the app-level dependency and deliberately not whitelisted
alongside `/health`: it reports component names, instance identities, and Profile
revision mismatches.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, status

from contracts.app_readiness import AppReadiness


router = APIRouter()


@router.get("/app/readiness")
async def app_readiness(request: Request) -> dict[str, object]:
    store = getattr(request.app.state, "readiness_store", None)
    if store is None:
        # Not "the product is unhealthy" but "this Hub cannot answer the question",
        # which is the one case the contract reserves 5xx for.
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "error": {
                    "code": "readiness_unavailable",
                    "message": "ServiceHub cannot serve the readiness contract",
                }
            },
        )

    document = store.app_projection()
    # Validate outbound: a drifted projection must fail here, in our own tests,
    # rather than reaching an installer that would misparse it.
    return AppReadiness.model_validate(document).model_dump(mode="json")
