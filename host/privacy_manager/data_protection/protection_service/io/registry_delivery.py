"""Registry file delivery, loading, and placeholder restore utilities."""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path

from fastapi import HTTPException, status

from file_protection.restore import PLACEHOLDER_PATTERN, TextRestoreResult, restore_text
from llm_pipeline.utils.registry_io import write_registry_json

from protection_service.config import AppConfig
from protection_service.redacts_store import RedactsStore
from protection_service.schemas import RedactRequest


def epoch_to_iso_utc(epoch: float) -> str:
    """Convert a POSIX timestamp to an ISO-8601 UTC string.

    Args:
        epoch: POSIX timestamp (seconds since the Unix epoch).

    Returns:
        str: UTC timestamp in ISO-8601 format, e.g. ``"2024-01-15T10:30:00Z"``.
    """
    return (
        datetime.fromtimestamp(epoch, tz=timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z")
    )


def _estimate_registry_bytes(registry: dict) -> int:
    """Estimate serialized registry JSON size without materializing it.

    Args:
        registry: Placeholder registry to estimate.

    Returns:
        int: Conservative byte-size estimate.
    """
    # Per-entry overhead in json.dumps(..., indent=2): 4-space indent + two
    # quote pairs (4) + ": " (2) + trailing ",\n" (2) ~= 12 bytes minimum;
    # leave extra headroom for wide unicode.
    _OVERHEAD_PER_ENTRY = 16
    total = 4  # opening/closing braces and newlines
    for k, v in registry.items():
        total += len(k) + len(str(v)) + _OVERHEAD_PER_ENTRY
    return total


def resolve_registry_ttl(req: RedactRequest, config: AppConfig) -> int:
    """Resolve and validate registry file TTL for a request.

    Args:
        req: Redaction request with optional TTL override.
        config: Service configuration containing TTL bounds.

    Returns:
        int: Valid TTL in seconds.

    Raises:
        HTTPException: If the TTL is outside configured bounds.
    """
    ttl = req.ttl_seconds if req.ttl_seconds is not None else config.redact.default_ttl_seconds
    if ttl < 1:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": "invalid_ttl", "message": "ttl_seconds must be >= 1"},
        )
    if ttl > config.redact.max_ttl_seconds:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "error": "ttl_too_large",
                "message": (
                    f"ttl_seconds={ttl} exceeds redact.max_ttl_seconds="
                    f"{config.redact.max_ttl_seconds}."
                ),
            },
        )
    return ttl


def validate_registry_placeholder_keys(registry: dict[str, str]) -> None:
    """Validate restore registry placeholder keys against the expected shape.

    Args:
        registry: Placeholder registry to validate.

    Raises:
        HTTPException: If any key does not match ``<CATEGORY_N>``.
    """
    for k in registry:
        if not isinstance(k, str) or not PLACEHOLDER_PATTERN.fullmatch(k):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={
                    "error": "invalid_registry_key",
                    "message": (
                        "Registry keys must match the placeholder shape "
                        "<CATEGORY_N> (e.g. <PERSON_1>, <EMAIL_2>)."
                    ),
                    "key": str(k)[:64],
                },
            )


def deliver_redaction_registry(
    registry: dict,
    req: RedactRequest,
    config: AppConfig,
    redacts_store: RedactsStore,
) -> tuple[dict | None, str | None, str | None]:
    """Return a registry inline or persist it to a TTL-managed file.

    Args:
        registry: Placeholder registry to deliver.
        req: Request containing registry delivery mode and optional TTL.
        config: Service configuration with inline size limits.
        redacts_store: Store used for file-backed registries.

    Returns:
        tuple[dict | None, str | None, str | None]: Inline registry dict,
            registry file path, and expiration timestamp. Each entry is ``None``
            when the corresponding delivery channel is not used.
    """
    mode = req.registry_return_mode
    inline_limit = config.redact.max_inline_registry_bytes

    if mode == "inline":
        offload = False
    elif mode == "path":
        offload = True
    else:  # "auto" — use estimator to avoid materializing a giant string
        offload = _estimate_registry_bytes(registry) > inline_limit

    if not offload:
        payload = json.dumps(registry, indent=2)
        # Re-check exact size in auto mode (estimator may under-count wide unicode).
        if mode == "auto" and len(payload.encode("utf-8")) > inline_limit:
            offload = True
        else:
            return registry, None, None

    ttl = resolve_registry_ttl(req, config)
    file_id, dest = redacts_store.allocate_path(suffix=".registry.json")
    # Write with owner-only perms upfront to close the brief window where the
    # payload is on disk with default permissions before register() chmods it.
    try:
        write_registry_json(registry, dest, indent=2)
    except BaseException:
        try:
            dest.unlink()
        except OSError:
            pass
        raise
    entry = redacts_store.register(file_id, dest, ttl)
    return None, str(dest), epoch_to_iso_utc(entry.expires_at)


def load_placeholder_registry(path: str) -> dict[str, str]:
    """Load a DPS or LLM/FileGuard registry JSON file.

    Args:
        path: Registry JSON file path.

    Returns:
        dict[str, str]: Placeholder-to-original-value mapping. An empty dict is
        a valid result: a file with no detected PII produces an empty registry
        (``{}``), which means "nothing to rewrite or restore", not an error.

    Raises:
        FileNotFoundError: If the registry file does not exist.
        ValueError: If the file is not a JSON object.
    """
    p = Path(path).expanduser().resolve()
    if not p.exists():
        raise FileNotFoundError(f"Registry file not found: {p}")
    with p.open(encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict):
        raise ValueError(f"Registry file is not a JSON object: {p}")
    return {str(k): str(v) for k, v in data.items()}


def _restore_bare_registry_keys(
    result: TextRestoreResult,
    registry: dict[str, str],
) -> tuple[str, int, list[str]]:
    """Restore de-bracketed occurrences of known registry keys.

    Agents paraphrasing a masked answer routinely drop the angle brackets
    (``<ORGANIZATION_2>`` -> ``ORGANIZATION_2``), which leaves the placeholder
    unrestored. Matching is scoped to keys actually present in this
    operation's registry, so unrelated tokens such as ``Q1_2024`` are never
    rewritten.

    Args:
        result: Outcome of the bracketed restore pass.
        registry: Placeholder-to-original-value mapping with bracketed keys.

    Returns:
        tuple[str, int, list[str]]: Restored text, cumulative substitution
            count, and the unmatched keys carried over from ``result``.
    """
    text = result.text
    unmatched = list(result.unmatched)
    bare_keys = [k[1:-1] for k in registry if k.startswith("<") and k.endswith(">")]
    present = [k for k in bare_keys if re.search(rf"\b{re.escape(k)}\b", text)]
    if not present:
        return text, result.replacements, unmatched

    # Longest-first so a key is never shadowed by a shorter prefix key.
    present.sort(key=len, reverse=True)
    pattern = re.compile("|".join(rf"\b{re.escape(k)}\b" for k in present))
    replacements = result.replacements

    def _sub(m: re.Match[str]) -> str:
        nonlocal replacements
        replacements += 1
        return str(registry[f"<{m.group(0)}>"])

    return pattern.sub(_sub, text), replacements, unmatched


def restore_text_from_registry(
    text: str,
    registry: dict[str, str],
) -> tuple[str, int, list[str]]:
    """Restore placeholders in text back to their original values.

    Registries normally use bracketed keys like ``<CATEGORY_N>`` — that's
    what every masker in this repo (DPS and the LLM pipeline) actually
    writes, and it's restored via the standard `restore_text` path below,
    followed by a registry-scoped pass that also catches keys an agent
    de-bracketed while paraphrasing.
    Bare keys without brackets (e.g. ``CUSTOMER_NAME_4``) are also
    supported in case a registry ever stores them that way, even though
    nothing in this repo currently produces them.

    Args:
        text: Text containing bracketed or bare placeholders.
        registry: Placeholder-to-original-value mapping.

    Returns:
        tuple[str, int, list[str]]: Restored text, substitution count, and
            list of registry keys that did not appear in the text.
    """
    if not registry:
        return text, 0, []

    sample_key = next(iter(registry))
    if sample_key.startswith("<"):
        # Bracketed keys — delegate to the standard restore implementation.
        result = restore_text(text, registry)
        return _restore_bare_registry_keys(result, registry)

    # Bare-key registry (no angle brackets on disk): sort longest-first so
    # "CUSTOMER_NAME_4" is tried before any shorter prefix that might match.
    # Each key produces two alternatives (<KEY> then KEY) so a bracketed form
    # in the text is consumed as a whole token rather than leaving dangling
    # angle brackets around the substituted value.
    keys_sorted = sorted(registry.keys(), key=len, reverse=True)
    pattern = re.compile(
        "|".join(f"<{re.escape(k)}>|{re.escape(k)}" for k in keys_sorted)
    )
    replacements = 0

    def _sub(m: re.Match[str]) -> str:
        nonlocal replacements
        replacements += 1
        matched = m.group(0)
        key = matched[1:-1] if matched.startswith("<") and matched.endswith(">") else matched
        return registry[key]

    restored = pattern.sub(_sub, text)
    unmatched = [k for k in registry if k not in text and f"<{k}>" not in text]
    return restored, replacements, unmatched
