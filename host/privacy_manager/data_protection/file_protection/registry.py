"""Registry helpers — load, save, and invert the placeholder registry.

The forward registry is the canonical format produced by the masking pipeline:
    {"<CATEGORY_N>": "original_value", ...}

The inverted form is used by the query rewriter:
    {"original_value": "<CATEGORY_N>", ...}
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Mapping


class RegistryError(ValueError):
    """Raised when a registry file is missing, malformed, or inverted."""


def load_registry(path: str | Path) -> dict[str, str]:
    """Load and validate a forward registry JSON file.

    Args:
        path: Path to a JSON file containing ``{placeholder: original}``.

    Returns:
        A new dict copy of the registry.

    Raises:
        RegistryError: If the file is missing, empty, or appears inverted.
    """
    p = Path(path).expanduser().resolve()
    if not p.exists():
        raise RegistryError(f"Registry file not found: {p}")

    try:
        with open(p, encoding="utf-8") as f:
            registry = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        raise RegistryError(f"Could not read registry file {p}: {exc}") from exc

    if not isinstance(registry, dict) or not registry:
        raise RegistryError("Registry is empty or not a valid JSON object")

    sample = list(registry.keys())[:5]
    if not any(k.startswith("<") and k.endswith(">") for k in sample):
        raise RegistryError(
            "Registry appears inverted. Expected forward keys like <ORG_1>; "
            f"got sample keys {sample}"
        )

    return dict(registry)


def save_registry(registry: Mapping[str, str], path: str | Path) -> Path:
    """Write a forward registry to JSON.

    Args:
        registry: Mapping of placeholder -> original.
        path: Destination JSON path.

    Returns:
        Resolved destination path.
    """
    p = Path(path).expanduser().resolve()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(dict(registry), indent=2), encoding="utf-8")
    return p


def invert_registry(registry: Mapping[str, str]) -> dict[str, str]:
    """Return ``{original: placeholder}`` from a forward registry.

    If two placeholders map to the same original value, the longer placeholder
    wins (this is rare and only happens when the masker assigns the same value
    to multiple categories).
    """
    inverted: dict[str, str] = {}
    for ph, original in registry.items():
        existing = inverted.get(original)
        if existing is None or len(ph) > len(existing):
            inverted[original] = ph
    return inverted
