"""Env-var helpers.

Numeric env reads with validation + clamping, plus the TLS-verify decision for
outbound httpx clients with one off-by-default escape hatch
(`SUPERCLAW_INSECURE_TLS`).
"""

import os

from loguru import logger


def _read_float_env(name: str, default: float, minimum: float) -> float:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = float(raw)
    except ValueError:
        logger.warning("[EnvResolve] {}={!r} is invalid, using default {:.1f}", name, raw, default)
        return default
    if value < minimum:
        logger.warning("[EnvResolve] {}={!r} is below {:.1f}, clamping", name, raw, minimum)
        return minimum
    return value


# Kept for an in-flight caller: #2813 adds `_read_bool_env` usage in
# `routing/vision_paths.py` without touching this file.
def _read_bool_env(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    value = raw.strip().lower()
    if value in ("1", "true", "yes", "on"):
        return True
    if value in ("0", "false", "no", "off"):
        return False
    logger.warning("[EnvResolve] {}={!r} is invalid, using default {}", name, raw, default)
    return default


_TLS_INSECURE_WARNED = False


def tls_verify() -> bool:
    """Return the ``verify`` value for outbound ``httpx`` clients.

    ``True`` (secure) by default. Returns ``False`` only when
    ``SUPERCLAW_INSECURE_TLS`` is explicitly truthy, logging one loud warning
    the first time. Disabling cert verification on cloud LLM calls leaks the
    Authorization bearer key and prompt/response content to any on-path attacker;
    the escape hatch is for trusted corporate-MITM proxies / debugging only.
    """
    global _TLS_INSECURE_WARNED
    insecure = os.environ.get("SUPERCLAW_INSECURE_TLS", "").strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    )
    if insecure and not _TLS_INSECURE_WARNED:
        _TLS_INSECURE_WARNED = True
        logger.warning(
            "SUPERCLAW_INSECURE_TLS is set: TLS certificate verification is DISABLED for outbound "
            "LLM/detector calls. This exposes the cloud API key and prompt/response content to "
            "man-in-the-middle attacks. Use ONLY behind a trusted corporate proxy or for debugging."
        )
    return not insecure
