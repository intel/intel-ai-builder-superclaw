"""Narrow installer API for allowlisted optional packages (the Office preview's LibreOffice).

The wire contract accepts only a package id. The winget package and every argument are fixed in
:mod:`sandbox_manager.libreoffice_install` and cannot be supplied by a caller.

    GET  /optional-packages/{id}          -> {package_id, installed, state, operation_id?, can_install?}
    POST /optional-packages/{id}/install  -> 202, same shape; poll /operations/{operation_id}

``state`` is ``ready``, ``installing`` or ``not_installed``. ``can_install`` is sent with
``not_installed`` and says whether winget is on this machine; without it the user installs the package
by hand. While an install runs, the operation's ``message`` is ``downloading`` or ``installing``. A failed
install ends the operation in ``error`` with the stable code in ``last_error_message``.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

from fastapi import APIRouter, Request
from loguru import logger

from ... import libreoffice_install as lo
from ...runs import KIND_OPTIONAL_PACKAGE_INSTALL, STATE_ERROR, RunHandle
from ..errors import http_error
from ._utils import to_operation_id

router = APIRouter()


def _require_package(package_id: str) -> None:
    if package_id != lo.PACKAGE_ID:
        raise http_error(
            404,
            "optional_package_not_found",
            f"Optional package {package_id!r} is not known.",
        )


def _active_install(request: Request) -> dict[str, Any] | None:
    active = request.app.state.store.find_active_run(kind=KIND_OPTIONAL_PACKAGE_INSTALL)
    if active and (active.get("metadata") or {}).get("package_id") == lo.PACKAGE_ID:
        return active
    return None


def _installing(active: dict[str, Any]) -> dict[str, Any]:
    return {
        "package_id": lo.PACKAGE_ID,
        "installed": False,
        "state": "installing",
        "operation_id": to_operation_id(active["run_id"]),
    }


@router.get("/optional-packages/{package_id}")
async def get_optional_package(package_id: str, request: Request) -> dict[str, Any]:
    _require_package(package_id)
    active = _active_install(request)
    if active:
        return _installing(active)
    if lo.find_soffice() is not None:
        return {"package_id": lo.PACKAGE_ID, "installed": True, "state": "ready"}
    return {
        "package_id": lo.PACKAGE_ID,
        "installed": False,
        "state": "not_installed",
        "can_install": lo.find_winget() is not None,
    }


@router.post("/optional-packages/{package_id}/install", status_code=202)
async def install_optional_package(package_id: str, request: Request) -> dict[str, Any]:
    _require_package(package_id)
    # A running install comes first: soffice.exe can appear on disk before the installer has finished.
    # No await between this check and the run row that spawn() inserts, so two POSTs cannot both pass it.
    active = _active_install(request)
    if active:
        return _installing(active)
    if lo.find_soffice() is not None:
        return {"package_id": lo.PACKAGE_ID, "installed": True, "state": "ready"}

    installer = request.app.state.optional_package_installer

    async def _install(handle: RunHandle) -> None:
        started = time.monotonic()
        logger.info("optional package install started package_id={}", lo.PACKAGE_ID)
        try:
            await asyncio.to_thread(installer, handle.message)
        except lo.InstallError as exc:
            logger.error(
                "optional package install failed package_id={} code={} detail={} elapsed_s={}",
                lo.PACKAGE_ID, exc.code, exc.detail, round(time.monotonic() - started),
            )
            handle.end(STATE_ERROR, error=exc.code, message=exc.detail or exc.code)
            return
        logger.info("optional package install completed package_id={}", lo.PACKAGE_ID)
        handle.done(message="done")

    run_id = await request.app.state.run_manager.spawn(
        kind=KIND_OPTIONAL_PACKAGE_INSTALL,
        worker=_install,
        metadata={"package_id": lo.PACKAGE_ID},
    )
    return {
        "package_id": lo.PACKAGE_ID,
        "installed": False,
        "state": "installing",
        "operation_id": to_operation_id(run_id),
    }
