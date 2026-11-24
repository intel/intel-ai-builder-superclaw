"""Resolve the stored data-protection settings used by LLM Router Manager.

This module decides the active values for two security settings: file
protection mode and hybrid fallback threshold. Values come
from the Settings Store, which is persisted in ``llmrouter_manager.db``.

Precedence is Store > default. If an operator changes a value in the Security
tab, the stored value wins. If no valid value is stored, the built-in default is
used instead.
"""

from __future__ import annotations

from typing import Callable, Literal, Optional, TypeAlias

from loguru import logger


# ── Public enums / defaults ───────────────────────────────────────────────────
FileProtectionMode = Literal["none", "deterministic", "hybrid", "llm"]

FILE_PROTECTION_MODES: tuple[FileProtectionMode, ...] = (
    "none",
    "deterministic",
    "hybrid",
    "llm",
)
FILE_PROTECTION_MODE_DEFAULT: FileProtectionMode = "none"

HYBRID_THRESHOLD_DEFAULT: float = 0.75

STORE_KEY_FILE_PROTECTION_MODE = "security.file_protection_mode"
STORE_KEY_HYBRID_THRESHOLD = "security.file_protection_hybrid_threshold"


# StoreReader is injected so this module stays independent from the concrete
# Store implementation. Tests pass a no-op lambda; REST endpoints pass a
# Store-backed getter.
StoreReader: TypeAlias = Callable[[str], Optional[object]]


def _noop_store(_key: str) -> Optional[object]:
    return None


# File protection mode
def resolve_file_protection_mode(
    *,
    store_read: StoreReader = _noop_store,
    default: FileProtectionMode = FILE_PROTECTION_MODE_DEFAULT,
) -> FileProtectionMode:
    """Read the file protection mode from the Store, e.g. None, Deterministic, Hybrid, or LLM.

    Store values take precedence over the provided default. Invalid store
    values are logged and ignored; the function never raises.

    Args:
        store_read (StoreReader): Callable used to read persisted setting values.
        default (FileProtectionMode): Value returned when no valid store value
            exists.

    Returns:
        FileProtectionMode: The resolved file protection mode.
    """
    raw_store = store_read(STORE_KEY_FILE_PROTECTION_MODE)
    if raw_store is not None:
        parsed = _parse_mode(str(raw_store), source=f"Store[{STORE_KEY_FILE_PROTECTION_MODE}]")
        if parsed is not None:
            return parsed

    return default


def _parse_mode(raw: str, *, source: str) -> Optional[FileProtectionMode]:
    normalized = raw.strip().lower()
    if normalized in FILE_PROTECTION_MODES:
        return normalized  # type: ignore[return-value]
    logger.warning(
        "Invalid {}={!r}; expected one of {}; using default",
        source, raw, FILE_PROTECTION_MODES,
    )
    return None


# Hybrid fallback threshold
def resolve_hybrid_threshold(
    *,
    store_read: StoreReader = _noop_store,
    default: float = HYBRID_THRESHOLD_DEFAULT,
) -> float:
    """Resolve the hybrid file-protection fallback threshold.

    Store values take precedence over the provided default. Values below
    0.0 are clamped to 0.0 and values above 1.0 are clamped to 1.0, each
    with a warning.

    Args:
        store_read (StoreReader): Callable used to read persisted setting values.
        default (float): Value returned when no valid store value exists.

    Returns:
        float: The resolved threshold in the range 0.0 through 1.0.
    """
    raw_store = store_read(STORE_KEY_HYBRID_THRESHOLD)
    if raw_store is not None:
        parsed = _parse_threshold(str(raw_store), source=f"Store[{STORE_KEY_HYBRID_THRESHOLD}]")
        if parsed is not None:
            return parsed

    return default


def _parse_threshold(raw: str, *, source: str) -> Optional[float]:
    try:
        threshold = float(str(raw).strip())
    except (TypeError, ValueError):
        logger.warning(
            "Invalid {}={!r}; expected float in [0, 1]; using default", source, raw
        )
        return None
    if threshold < 0.0:
        logger.warning("{}={} is below 0.0; clamping to 0.0", source, threshold)
        return 0.0
    if threshold > 1.0:
        logger.warning("{}={} is above 1.0; clamping to 1.0", source, threshold)
        return 1.0
    return threshold
