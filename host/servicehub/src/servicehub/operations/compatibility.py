"""Operation compatibility at the ServiceHub child-service boundary."""

from __future__ import annotations

import re
from typing import Literal


OperationOwner = Literal["lrm", "sm"]

_CANONICAL_OPERATION_ID = re.compile(r"^(hub|lrm|sm):[A-Za-z0-9][A-Za-z0-9._-]*$")


def child_operation_id(operation_id: str, *, owner: OperationOwner) -> str:
    """Translate a ServiceHub-routable id to the child service's accepted id."""
    if _CANONICAL_OPERATION_ID.fullmatch(operation_id) is None:
        raise ValueError("operation_id is not canonical")
    prefix, _child_id = operation_id.split(":", 1)
    if prefix != owner:
        raise ValueError(f"operation_id does not belong to {owner}")
    return operation_id


def adapt_operation_payload(
    payload: dict[str, object],
    *,
    owner: OperationOwner,
) -> dict[str, object]:
    """Validate a child operation payload without mutating it."""
    operation_id = payload.get("operation_id")
    if operation_id is not None:
        if not isinstance(operation_id, str):
            raise ValueError("operation_id must be a string")
        child_operation_id(operation_id, owner=owner)
        return dict(payload)
    raise ValueError("operation payload is missing operation_id")
