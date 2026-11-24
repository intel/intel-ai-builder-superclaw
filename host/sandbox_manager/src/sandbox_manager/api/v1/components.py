"""``/sandbox-manager/v1/components`` — backend component catalog (STUB).

Design ref: 06-30 backend API design §4.4 / fork plan §6. The native backend
runs several long-lived components — the run *orchestrator*, the
*deep-research* sidecar (``:18324``), *opencode*, and the *openwork-server*.
The eventual surface supervises them::

    GET  /components                    # list
    GET  /components/{name}             # one component's status
    POST /components/{name}/actions     # start / stop / restart
    GET  /components/{name}/logs        # tail logs

STUB STATUS (fork milestone): supervision is **not implemented**. The list
and per-component read endpoints return a *static* catalog (no live process
inspection), and the mutating / log endpoints return ``501``. Do not mistake
this module for a finished feature.
"""

from __future__ import annotations

from fastapi import APIRouter, Request

from ..errors import http_error


router = APIRouter()


# Static catalog of the components the sandbox backend runs.
# Ordering is display order. ``status`` is intentionally "unknown" until
# supervision is implemented.
_KNOWN_COMPONENTS: tuple[dict[str, str], ...] = (
    {"name": "orchestrator", "description": "run orchestrator"},
    {"name": "deep-research", "description": "deep-research sidecar (:18324)"},
    {"name": "opencode", "description": "opencode agent runtime"},
    {"name": "openwork-server", "description": "OpenWork server"},
)
_KNOWN_NAMES = frozenset(c["name"] for c in _KNOWN_COMPONENTS)


def _stub_entry(component: dict[str, str]) -> dict[str, object]:
    """Shape a catalog entry with stub markers."""
    return {
        **component,
        "status": "unknown",
        "supervision": "not_implemented",
    }


@router.get("/components")
async def list_components(request: Request) -> dict:
    """List the known backend components (static stub).

    Returns the catalog with ``stub: true`` so callers can detect that no
    live supervision is wired yet.
    """
    return {
        "components": [_stub_entry(c) for c in _KNOWN_COMPONENTS],
        "stub": True,
    }


@router.get("/components/{name}")
async def get_component(name: str, request: Request) -> dict:
    """Return a single component's static entry (stub).

    404 for an unknown name; known names return the static entry with
    ``status: "unknown"`` until supervision is implemented.
    """
    for component in _KNOWN_COMPONENTS:
        if component["name"] == name:
            return {**_stub_entry(component), "stub": True}
    raise http_error(404, "component_not_found", f"Component {name!r} is not known.")


@router.post("/components/{name}/actions")
async def component_action(name: str, request: Request) -> dict:
    """Perform a lifecycle action on a component (NOT IMPLEMENTED).

    404 for an unknown name; known names return 501 until supervision is
    wired.
    """
    if name not in _KNOWN_NAMES:
        raise http_error(404, "component_not_found", f"Component {name!r} is not known.")
    raise http_error(
        501,
        "not_implemented",
        f"Component supervision is not yet implemented; cannot act on {name!r}.",
    )


@router.get("/components/{name}/logs")
async def component_logs(name: str, request: Request) -> dict:
    """Tail a component's logs (NOT IMPLEMENTED).

    404 for an unknown name; known names return 501 until log streaming is
    wired.
    """
    if name not in _KNOWN_NAMES:
        raise http_error(404, "component_not_found", f"Component {name!r} is not known.")
    raise http_error(
        501,
        "not_implemented",
        f"Component log streaming is not yet implemented for {name!r}.",
    )
