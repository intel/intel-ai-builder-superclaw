"""Automatic HuggingFace endpoint selection for GGUF downloads.

When the operator has NOT pinned ``HF_ENDPOINT``, probe the official endpoint
and the China mirror in parallel and pick the official one when it is
reachable, otherwise the mirror. This lets local model downloads succeed on
hosts where ``huggingface.co`` is blocked without any manual ``HF_ENDPOINT``
configuration.

Selection is priority-based, not race-based: the official endpoint always wins
when reachable (authoritative source), and the mirror is used only as a
fallback. If both probes fail we retry the parallel probe once, then default to
the official endpoint so downstream code always receives a usable URL (the same
behaviour as the pre-existing hard-coded default).
"""

from __future__ import annotations

import concurrent.futures
import time
from collections.abc import Callable

import httpx
from loguru import logger

HF_OFFICIAL_ENDPOINT = "https://huggingface.co"
HF_MIRROR_ENDPOINT = "https://hf-mirror.com"

# Per-probe timeout for each HF endpoint reachability check. Deliberately small:
# the goal is only to confirm the endpoint answers quickly enough to be useful,
# not to measure latency. Probes run concurrently, so worst-case auto-selection
# latency is ~1.5s x 2 attempts (initial parallel probe + 1 retry on total
# failure).
HF_ENDPOINT_PROBE_TIMEOUT_S = 1.5

# A probe takes an endpoint URL and returns it when reachable, else ``None``.
ProbeFn = Callable[[str], "str | None"]


def resolve_hf_endpoint(
    configured_endpoint: str, *, probe: ProbeFn | None = None
) -> str:
    """Resolve the effective HuggingFace endpoint for downloads.

    Priority:
      1. An explicitly configured endpoint — ``HF_ENDPOINT`` captured in
         :attr:`llmrouter_manager.local.config.LocalConfig.hf_endpoint` — that
         is NOT the built-in official default. Operator intent wins and no
         network probe is performed.
      2. Otherwise auto-select by probing the official endpoint and the mirror
         in parallel (see :func:`_select_hf_endpoint_by_probe`).

    ``configured_endpoint`` equal to the official default is treated as "unset"
    so a host can still auto-select the mirror without any manual env change.

    *probe* is injectable for tests; the default performs a real ``HEAD``.
    """
    normalized = (configured_endpoint or "").strip().rstrip("/")
    if normalized and normalized != HF_OFFICIAL_ENDPOINT:
        logger.info(
            "HF_ENDPOINT resolved: {} (source: configured)", configured_endpoint.strip()
        )
        return configured_endpoint.strip()
    return _select_hf_endpoint_by_probe(probe or _probe_hf_endpoint)


def _select_hf_endpoint_by_probe(probe: ProbeFn) -> str:
    """Pick the endpoint by probing the official endpoint and mirror in parallel.

    Both are probed concurrently to minimise latency, but selection is
    priority-based: the official endpoint wins when reachable; the mirror is
    used only when the official endpoint is not. If both probes fail, retry the
    whole parallel probe once; if both fail again, return the official endpoint
    as a last resort so downstream code still receives a usable URL.
    """
    max_attempts = 2  # 1 initial + 1 retry on total failure
    for attempt in range(1, max_attempts + 1):
        logger.info(
            "HF_ENDPOINT auto-selection attempt {}/{}: probing {} and {} in "
            "parallel (timeout={:.1f}s each)",
            attempt,
            max_attempts,
            HF_OFFICIAL_ENDPOINT,
            HF_MIRROR_ENDPOINT,
            HF_ENDPOINT_PROBE_TIMEOUT_S,
        )
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            official_future = executor.submit(probe, HF_OFFICIAL_ENDPOINT)
            mirror_future = executor.submit(probe, HF_MIRROR_ENDPOINT)
            official_result = official_future.result()
            mirror_result = mirror_future.result()
        if official_result is not None:
            logger.info(
                "HF_ENDPOINT auto-selection attempt {}: official reachable; using {}",
                attempt,
                HF_OFFICIAL_ENDPOINT,
            )
            return HF_OFFICIAL_ENDPOINT
        if mirror_result is not None:
            logger.info(
                "HF_ENDPOINT auto-selection attempt {}: official unreachable, "
                "mirror reachable; using {}",
                attempt,
                HF_MIRROR_ENDPOINT,
            )
            return HF_MIRROR_ENDPOINT
        logger.info(
            "HF_ENDPOINT auto-selection attempt {}: both endpoints unreachable",
            attempt,
        )
    logger.warning(
        "HF_ENDPOINT auto-selection: both endpoints unreachable after {} "
        "attempts; defaulting to {}",
        max_attempts,
        HF_OFFICIAL_ENDPOINT,
    )
    return HF_OFFICIAL_ENDPOINT


def _probe_hf_endpoint(url: str) -> str | None:
    """Send a ``HEAD`` request to *url*; return *url* on 2xx, else ``None``."""
    probe_start = time.monotonic()
    try:
        with httpx.Client(
            timeout=httpx.Timeout(
                connect=HF_ENDPOINT_PROBE_TIMEOUT_S,
                read=HF_ENDPOINT_PROBE_TIMEOUT_S,
                write=HF_ENDPOINT_PROBE_TIMEOUT_S,
                pool=HF_ENDPOINT_PROBE_TIMEOUT_S,
            ),
            follow_redirects=True,
        ) as client:
            response = client.head(url)
        response.raise_for_status()
        logger.info(
            "HF endpoint probe succeeded: url={} status={} elapsed={:.3f}s",
            url,
            response.status_code,
            time.monotonic() - probe_start,
        )
        return url
    except httpx.HTTPError as exc:
        logger.info(
            "HF endpoint probe failed: url={} elapsed={:.3f}s error={}",
            url,
            time.monotonic() - probe_start,
            exc,
        )
    return None
