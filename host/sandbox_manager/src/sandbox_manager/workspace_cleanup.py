r"""Workspace cleanup policy
Defines which paths inside ``%USERPROFILE%\SuperClawProjects`` are safe to delete automatically.  User created files are shouldnt be in the  list

The allowlist and thresholds are hardcoded in :data:`BUILTIN_POLICY` /
:data:`BUILTIN_CLEANUP_PATTERNS`. There is no JSON override surface — a
user-configurable policy is deferred to a future version.
Contract touched: ``Sandbox`` (workspace filesystem boundary)
"""

from __future__ import annotations
import re
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Literal

PatternTypes = Literal["dir_glob"]
WORKSPACE_CLEANUP_CONFIG_KEY = "workspace_cleanup_settings"

if TYPE_CHECKING:
    from .store import Store

# safetey validation, forbid segments that could escape out our Workspace directory or target root level user files directly
_UNSAFE_SEGEMENT = re.compile(
    r"(^|[/\\])" r"(\.\.|~)" r"([/\\]|$)",
)
# pattern must not begin with an absolute indicator
_ABSOLUTE_PREFIX = re.compile(r"^([A-Za-z]:[/\\]|[/\\])")
# Pattern must contain at least one literal (non-wildcard, non-separator) segment.
# Catch *, **, */, **/, */* etc. or any pattern with only wildcards and separators
_ROOT_ONLY = re.compile(r"^[\*/\\]+$")


def _validate_pattern_safety(pattern: str) -> None:
    """Raise ValueError if pattern looks unsafe

    This is a defense in depth check, the primary safety guarantee is the allowlist itself
    """

    if _ABSOLUTE_PREFIX.match(pattern):
        raise ValueError(
            f"Cleanup pattern {pattern!r} is absolute. Patterns must be relative to workspace root"
        )
    if _UNSAFE_SEGEMENT.search(pattern):
        raise ValueError(
            f"Cleanup pattern {pattern!r} contains a path traversal segment. Patterns may not escape workspace"
        )
    if _ROOT_ONLY.match(pattern):
        raise ValueError(
            f"Cleanup pattenr {pattern!r} would match workspace root itself. Patterns must target a named sub path"
        )


@dataclass(
    frozen=True
)  # creates __init__ class automatically, no need manual declaring
class CleanupPattern:
    """One entry in the cleanup allow list

    Attributes:
        pattern: relative path pattern (forward / , no leading /) Glob wildcards (*, **) are supported.
        pattern_type: ``dir_glob`` – glob-match a directory path (``*``/``**`` supported)
        description: explanation of why the target is safe
        safe:        Must be True, acts as an explicit sign off that the pattern was reviewed and cannot match user files
    """

    pattern: str
    pattern_type: PatternTypes
    description: str
    safe: bool

    def __post_init__(self) -> None:
        if not self.safe:
            raise ValueError(
                f"Cleanup pattenr {self.pattern!r} has set as safe=False. Only patterns explicitly set as safe=True are allowed in the policy"
            )
        _validate_pattern_safety(self.pattern)


@dataclass(frozen=True)
class CleanupPolicy:
    """Full workspace cleanup policy

    Attributes:
        eligible_patterns: allowed listed cleanup targets
        max_session_age_days: Chat sessions older than this are eligible for intermediate file cleanup
        warn_bytes: disk usage at which a warning to be displayed
        critical_bytes: disk usage at which automatics cleanup will be triggered
    """

    eligible_patterns: tuple[CleanupPattern, ...]
    max_session_age_days: int = 7
    warn_bytes: int = 2 * 1024**3
    critical_bytes: int = 5 * 1024**3


# builtin allow list — the sole source of truth for cleanup targets
BUILTIN_CLEANUP_PATTERNS: tuple[CleanupPattern, ...] = (
    CleanupPattern(
        pattern="deep-research-workspaces/sessions/*/local_intermediate/",
        pattern_type="dir_glob",
        description=( 
            "Local intermediate deep research artifacts in a sessions/ "
            "session directory."),
        safe=True,
    ),
    CleanupPattern(
        pattern="deep-research-workspaces/sessions/*/cloud_intermediate/",
        pattern_type="dir_glob",
        description=(
            "Cloud intermediate deep research artifacts in a sessions/ "
            "session directory."),
        safe=True,
    ),
)

BUILTIN_POLICY = CleanupPolicy(
    eligible_patterns=BUILTIN_CLEANUP_PATTERNS,
    max_session_age_days=7,
)


def _coerce_enabled(value: object, default: bool = True) -> bool:
    """Coerce a runtime-config ``enabled`` value to a real bool.

    JSON booleans pass through; strings are matched case-insensitively so a
    stringified ``"false"`` is not treated as truthy (plain ``bool("false")``
    is ``True``, which would wrongly enable cleanup). Numbers use their
    truthiness. Anything unrecognized falls back to ``default``.
    """
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        v = value.strip().lower()
        if v in ("true", "1", "yes", "on"):
            return True
        if v in ("false", "0", "no", "off"):
            return False
        return default
    if isinstance(value, (int, float)):
        return bool(value)
    return default


def normalize_cleanup_settings(value: object) -> dict[str, object]:
    defaults: dict[str, object] = {"enabled": True, "retentionDays": 7}
    if not isinstance(value, dict):
        return defaults
    enabled = _coerce_enabled(value.get("enabled", True))
    raw_retention = value.get("retentionDays")
    try:
        retention = int(raw_retention) if raw_retention is not None else 7
    except (TypeError, ValueError):
        retention = 7
    if retention < 1 or retention > 30:
        retention = 7
    return {"enabled": enabled, "retentionDays": retention}


def load_cleanup_settings(store: "Store | None") -> dict[str, object]:
    """Read host-owned cleanup settings from the SandboxManager store.

    The store is the only source of truth. When no value has been written yet
    (fresh install, or store unavailable) the built-in defaults apply.
    """
    stored = store.get_config(WORKSPACE_CLEANUP_CONFIG_KEY) if store is not None else None
    return normalize_cleanup_settings(stored)


def load_cleanup_policy() -> CleanupPolicy:
    """Return the workspace cleanup policy.

    The allowlist and thresholds are hardcoded in :data:`BUILTIN_POLICY`;
    there is no file or env override surface.

    Returns:
        A validated :class:`CleanupPolicy`
    """
    return BUILTIN_POLICY
