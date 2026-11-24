"""Whether a host tool call needs the user, and which grant scopes the user may pick.

The rules are the contract's (``host-mcp-api.ts``) and are checked against its
``HOST_MCP_APPROVAL_VECTORS``. Annotations are the server's own claim from ``tools/list``; a hint the
server did not declare is ``None``, and only an explicit ``readOnlyHint: true`` without
``destructiveHint: true`` counts as read-only.
"""

from __future__ import annotations

from dataclasses import dataclass

WRITE_SCOPES: tuple[str, ...] = ("once", "until_restart")
READ_SCOPES: tuple[str, ...] = ("once", "until_restart", "always")


@dataclass(frozen=True)
class ToolAnnotations:
    read_only: bool | None = None
    destructive: bool | None = None
    open_world: bool | None = None

    def as_dict(self) -> dict[str, bool | None]:
        return {"read_only": self.read_only, "destructive": self.destructive, "open_world": self.open_world}


def _hint(value: object) -> bool | None:
    return value if isinstance(value, bool) else None


def annotations_from_tool(tool: dict[str, object]) -> ToolAnnotations:
    raw = tool.get("annotations")
    hints = raw if isinstance(raw, dict) else {}
    return ToolAnnotations(
        read_only=_hint(hints.get("readOnlyHint")),
        destructive=_hint(hints.get("destructiveHint")),
        open_world=_hint(hints.get("openWorldHint")),
    )


def is_read_only(annotations: ToolAnnotations) -> bool:
    return annotations.read_only is True and annotations.destructive is not True


def needs_approval(mode: str, annotations: ToolAnnotations) -> bool:
    return not (mode == "auto" and is_read_only(annotations))


def offered_scopes(annotations: ToolAnnotations) -> tuple[str, ...]:
    return READ_SCOPES if is_read_only(annotations) else WRITE_SCOPES
