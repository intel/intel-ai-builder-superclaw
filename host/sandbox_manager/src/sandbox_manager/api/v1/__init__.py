"""``/sandbox-manager/v1`` versioned API — aggregate router.

This aggregate router owns the ``/sandbox-manager/v1`` prefix (set below via
``APIRouter(prefix=...)``).  Each sub-router declares paths *relative* to that
prefix (e.g. ``/system/provisions``) and is mounted here with no additional
prefix.  :func:`sandbox_manager.main.build_app` then includes this aggregate
router as-is, without adding any further prefix.
"""

from __future__ import annotations

from fastapi import APIRouter

from . import (
    capability,
    channel_secrets,
    components,
    egress_approvals,
    egress_chat_grants,
    operations,
    optional_packages,
    runtime_secrets,
    sandbox,
    servicehub,
    system,
    workspace_cleanup,
)

router = APIRouter(prefix="/sandbox-manager/v1")

router.include_router(capability.router)
router.include_router(capability.internal_router)
router.include_router(egress_approvals.router)
router.include_router(egress_chat_grants.router)
router.include_router(operations.router)
router.include_router(operations.internal_router)
router.include_router(optional_packages.router)
router.include_router(runtime_secrets.router)
router.include_router(channel_secrets.router)
router.include_router(sandbox.router)
router.include_router(sandbox.internal_router)
router.include_router(system.router)
router.include_router(workspace_cleanup.router)
router.include_router(workspace_cleanup.internal_router)
router.include_router(components.router)
router.include_router(servicehub.router)
