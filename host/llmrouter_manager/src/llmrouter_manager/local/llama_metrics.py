"""Helpers for scraping and normalizing llama-server Prometheus metrics."""

from __future__ import annotations

import re
from typing import Any, Mapping

from ..common.http_client import build_client_for_url
from .llama_auth import llama_auth_headers

_LLAMA_METRIC_MAP: dict[str, str] = {
    "prompt_tokens_total": "sc_llm_prompt_tokens_total",
    "tokens_predicted_total": "sc_llm_generation_tokens_total",
    "prompt_tokens_seconds": "sc_llm_prompt_tps",
    "predicted_tokens_seconds": "sc_llm_decode_tps",
    "requests_processing": "sc_llm_requests_running",
    "requests_deferred": "sc_llm_requests_waiting",
    "n_decode_total": "sc_llm_decode_total",
    "n_busy_slots_per_decode": "sc_llm_busy_slots_per_decode",
    "n_tokens_max": "sc_llm_max_tokens",
}

_SAMPLE_RE = re.compile(
    r"^(?P<name>[a-zA-Z_:][a-zA-Z0-9_:]*)"
    r"(?:\{(?P<labels>[^}]*)\})?"
    r"\s+(?P<value>[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)"
)


def _normalize_metric_name(name: str) -> str:
    if name.startswith("llamacpp:"):
        return name.removeprefix("llamacpp:")
    return name


def _coerce_number(raw: str) -> int | float:
    if not any(c in raw for c in (".", "e", "E")):
        try:
            return int(raw)
        except ValueError:
            pass
    value = float(raw)
    if value.is_integer():
        return int(value)
    return value


def parse_llama_metrics_text(text: str) -> dict[str, int | float]:
    """Parse the allowlisted llama-server samples from Prometheus text."""
    metrics: dict[str, int | float] = {}
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        match = _SAMPLE_RE.match(stripped)
        if match is None:
            continue
        name = _normalize_metric_name(match.group("name"))
        if name not in _LLAMA_METRIC_MAP:
            continue
        metrics[name] = _coerce_number(match.group("value"))
    return metrics


def canonicalize_llama_metrics(
    metrics: Mapping[str, int | float],
) -> dict[str, int | float]:
    """Map raw llama metric families to the canonical SuperClaw schema."""
    canonical: dict[str, int | float] = {}
    for raw_name, canonical_name in _LLAMA_METRIC_MAP.items():
        value = metrics.get(raw_name)
        if value is not None:
            canonical[canonical_name] = value
    return canonical


def scrape_llama_metrics(
    base_url: str,
    *,
    model_id: str,
    timeout: float = 5.0,
) -> dict[str, Any]:
    """Fetch /metrics from a live llama-server and return raw + canonical data."""
    if not model_id:
        raise ValueError("model_id is required to scrape llama-server /metrics")

    url = f"{base_url.rstrip('/')}/metrics"
    with build_client_for_url(url) as client:
        response = client.get(
            url,
            params={"model": model_id},
            headers=llama_auth_headers(),
            timeout=timeout,
        )
    response.raise_for_status()
    raw_metrics = parse_llama_metrics_text(response.text)
    return {
        "source": "llama-server",
        "base_url": base_url,
        "model_id": model_id,
        "raw": raw_metrics,
        "canonical": canonicalize_llama_metrics(raw_metrics),
    }
