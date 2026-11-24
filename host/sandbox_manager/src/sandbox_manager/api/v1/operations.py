"""``/sandbox-manager/v1/operations/{operation_id}`` — async operation polling + cancellation.

Replaces the legacy ``/runs/{run_id}`` endpoint pair.

Serialization rules (api.md §3, §4):
- DB field ``run_id`` exposed as ``operation_id`` with the ``sm:`` transport
  prefix (see ``_utils.to_operation_id``); inbound ids are stripped back to the
  bare ``run_id`` before any store lookup (see ``_utils.to_run_id``)
- DB field ``error`` exposed as ``last_error_message`` (plain string)
- ``finished_at`` omitted when absent
- ``metadata`` omitted when empty
- ``children`` omitted on child rows (one level deep only)
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Request

from ...runs import TERMINAL_STATES, RunManager
from ..errors import http_error
from ..process_auth import reject_managed_public_mutation, require_process_credential
from ._utils import to_operation_id, to_run_id


router = APIRouter()
internal_router = APIRouter(
    prefix="/internal",
    dependencies=[Depends(require_process_credential)],
)


# ------------------------------------------------------------------ helpers


def _mgr(request: Request) -> RunManager:
    return request.app.state.run_manager


def _serialize_row(row: dict[str, Any], *, include_children: bool = True) -> dict[str, Any]:
    """Convert a DB run row to api.md operation row shape."""
    out: dict[str, Any] = {
        "operation_id": to_operation_id(row["run_id"]),
        "kind": row["kind"],
        "state": row["state"],
        "pct": row.get("pct", 0.0),
    }
    if row.get("message"):
        out["message"] = row["message"]
    if row.get("error"):
        out["last_error_message"] = row["error"]
    if row.get("started_at"):
        out["started_at"] = row["started_at"]
    if row.get("finished_at"):
        out["finished_at"] = row["finished_at"]
    meta = row.get("metadata") or {}
    if meta:
        out["metadata"] = meta
    if include_children:
        children = row.get("_children")
        if children is not None:
            out["children"] = [_serialize_row(c, include_children=False) for c in children]
    return out


def _load_with_children(run_id: str, request: Request) -> dict[str, Any] | None:
    mgr = _mgr(request)
    row = mgr.get(run_id)
    if not row:
        return None
    children = request.app.state.store.get_child_runs(run_id)
    row["_children"] = children
    return row


# ------------------------------------------------------------------ endpoints


@router.get("/operations/{operation_id}")
async def get_operation(operation_id: str, request: Request) -> dict:
    row = _load_with_children(to_run_id(operation_id), request)
    if not row:
        raise http_error(404, "operation_not_found", f"Operation {operation_id!r} not found.")
    return _serialize_row(row)


@router.post("/operations/{operation_id}/cancellations")
async def cancel_operation(operation_id: str, request: Request) -> dict:
    reject_managed_public_mutation(request)
    return _cancel_operation(operation_id, request)


@internal_router.post("/operations/{operation_id}/cancellations")
async def cancel_operation_internal(operation_id: str, request: Request) -> dict:
    return _cancel_operation(operation_id, request)


def _cancel_operation(operation_id: str, request: Request) -> dict:
    mgr = _mgr(request)
    run_id = to_run_id(operation_id)
    row = mgr.get(run_id)
    if not row:
        raise http_error(404, "operation_not_found", f"Operation {operation_id!r} not found.")
    if row["state"] in TERMINAL_STATES:
        raise http_error(
            409,
            "operation_not_cancellable",
            f"Operation {operation_id!r} is already in terminal state {row['state']!r}.",
        )
    ok = mgr.cancel(run_id)
    if not ok:
        raise http_error(
            409,
            "operation_not_cancellable",
            f"Operation {operation_id!r} could not be cancelled.",
        )
    return {"success": True, "operation_id": to_operation_id(run_id)}
