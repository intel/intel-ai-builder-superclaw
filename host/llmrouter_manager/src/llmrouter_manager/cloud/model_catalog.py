from __future__ import annotations

import asyncio
import time
from pathlib import Path
from typing import Any

import httpx

from ..common.state import default_state_root, read_json, write_json_atomic


CATALOG_URL = "https://models.dev/api.json"
CATALOG_TTL_SECONDS = 3600.0
CATALOG_TIMEOUT_SECONDS = 10.0


def _cache_path() -> Path:
    return default_state_root() / "models-dev.json"


def _cached_catalog() -> dict[str, Any] | None:
    cached = read_json(_cache_path())
    if not isinstance(cached, dict) or not isinstance(cached.get("catalog"), dict):
        return None
    return cached


async def _fetch_catalog() -> dict[str, Any]:
    response = await asyncio.to_thread(httpx.get, CATALOG_URL, timeout=CATALOG_TIMEOUT_SECONDS)
    response.raise_for_status()
    catalog = response.json()
    if not isinstance(catalog, dict):
        raise ValueError("models.dev returned a non-object catalog")
    return catalog


async def get_catalog() -> dict[str, Any]:
    cached = _cached_catalog()
    fetched_at = cached["fetched_at"] if cached is not None else None
    if cached is not None and isinstance(fetched_at, (int, float)) and time.time() - fetched_at < CATALOG_TTL_SECONDS:
        return cached["catalog"]
    try:
        catalog = await _fetch_catalog()
    except (httpx.HTTPError, ValueError):
        if cached is not None:
            return cached["catalog"]
        raise
    write_json_atomic(_cache_path(), {"fetched_at": time.time(), "catalog": catalog})
    return catalog


def picker_models(
    *,
    catalog: dict[str, Any],
    catalog_provider: str,
    live_model_ids: set[str],
) -> list[dict[str, Any]]:
    provider = catalog.get(catalog_provider)
    records = provider.get("models") if isinstance(provider, dict) else None
    if not isinstance(records, dict):
        return []

    models: list[dict[str, Any]] = []
    for model_id, model in records.items():
        if not isinstance(model_id, str) or model_id not in live_model_ids or not isinstance(model, dict):
            continue
        modalities = model.get("modalities")
        if not isinstance(modalities, dict):
            continue
        inputs = modalities.get("input")
        outputs = modalities.get("output")
        if not isinstance(inputs, list) or not isinstance(outputs, list):
            continue
        if "text" not in inputs or "text" not in outputs:
            continue
        if model.get("status") in {"alpha", "deprecated"}:
            continue
        release_date = model.get("release_date")
        models.append(
            {
                "id": model_id,
                "name": model.get("name") if isinstance(model.get("name"), str) else model_id,
                "release_date": release_date if isinstance(release_date, str) else "",
            }
        )
    models.sort(key=lambda model: (model["name"], model["id"]))
    models.sort(key=lambda model: model["release_date"], reverse=True)
    return models
