"""Hub-owned access to restricted SandboxManager product operations."""

from __future__ import annotations

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from servicehub.adapters.restricted_sandbox_lifecycle_client import (
    RestrictedSandboxLifecycleClient,
    RestrictedSandboxResponse,
    RestrictedSandboxRuntimeUnavailable,
)


router = APIRouter(prefix="/app")


def _sandbox(request: Request) -> RestrictedSandboxLifecycleClient:
    return request.app.state.restricted_sandbox_lifecycle_client


def _upstream_error(exc: httpx.HTTPStatusError) -> JSONResponse:
    try:
        payload = exc.response.json()
    except ValueError:
        payload = {
            "error": {
                "code": "sandbox_request_failed",
                "message": "Sandbox request failed.",
            }
        }
    return JSONResponse(status_code=exc.response.status_code, content=payload)


def _unavailable_error() -> JSONResponse:
    return JSONResponse(
        status_code=503,
        content={
            "error": {
                "code": "sandbox_manager_unavailable",
                "message": "Sandbox Manager is unavailable.",
            }
        },
    )


async def _object_body(request: Request) -> dict[str, object] | JSONResponse:
    body = await request.body()
    if not body:
        return {}
    try:
        payload = await request.json()
    except ValueError:
        return JSONResponse(status_code=400, content={"error": "invalid_payload"})
    if not isinstance(payload, dict):
        return JSONResponse(status_code=400, content={"error": "invalid_payload"})
    return payload


@router.get("/runtime/sandbox-token", response_model=None)
async def get_sandbox_token(request: Request) -> JSONResponse:
    try:
        return JSONResponse(content=await _sandbox(request).get_owt_token())
    except RestrictedSandboxRuntimeUnavailable:
        return _unavailable_error()
    except httpx.RequestError:
        return _unavailable_error()
    except httpx.HTTPStatusError as exc:
        return _upstream_error(exc)


@router.post("/runtime/converge", response_model=None)
async def converge_runtime(request: Request, rearm: bool = False) -> JSONResponse:
    """Converge the Runtime; `?rearm=true` is the console's Retry after a refused provision."""
    capability = getattr(request.app.state, "capability", None)
    if capability is not None:
        await capability.retry_cloud_only_lite()
    try:
        sandbox = _sandbox(request)
        result: RestrictedSandboxResponse = await (
            sandbox.converge_runtime(rearm=True) if rearm else sandbox.converge_runtime()
        )
        return JSONResponse(status_code=result.status_code, content=result.payload)
    except RestrictedSandboxRuntimeUnavailable:
        return _unavailable_error()
    except httpx.RequestError:
        return _unavailable_error()
    except httpx.HTTPStatusError as exc:
        return _upstream_error(exc)


@router.post("/workspace/cleanup/run-now", response_model=None)
async def run_workspace_cleanup(request: Request) -> JSONResponse:
    payload = await _object_body(request)
    if isinstance(payload, JSONResponse):
        return payload
    try:
        return JSONResponse(content=await _sandbox(request).run_workspace_cleanup(payload))
    except RestrictedSandboxRuntimeUnavailable:
        return _unavailable_error()
    except httpx.RequestError:
        return _unavailable_error()
    except httpx.HTTPStatusError as exc:
        return _upstream_error(exc)


@router.post("/workspace/cleanup/settings", response_model=None)
async def set_workspace_cleanup_settings(request: Request) -> JSONResponse:
    payload = await _object_body(request)
    if isinstance(payload, JSONResponse):
        return payload
    try:
        return JSONResponse(
            content=await _sandbox(request).set_workspace_cleanup_settings(payload)
        )
    except RestrictedSandboxRuntimeUnavailable:
        return _unavailable_error()
    except httpx.RequestError:
        return _unavailable_error()
    except httpx.HTTPStatusError as exc:
        return _upstream_error(exc)
