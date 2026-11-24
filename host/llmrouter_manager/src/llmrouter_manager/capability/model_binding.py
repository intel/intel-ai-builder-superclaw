"""Resolve the committed Bundle lifecycle into the Model Binding contract."""

from __future__ import annotations

import hashlib
import json
from typing import Any

from ..local.registry import ModelEntry, Registry, load_builtin_registry
from .bundle_registry import BundleEntry, BundleRegistry, load_bundle_registry


def _packaged_asset(asset_id: str, role: str, sha256: str | None) -> dict[str, str]:
    if not sha256:
        raise ValueError(f"trusted packaged asset {asset_id!r} has no SHA-256")
    return {
        "asset_id": asset_id,
        "role": role,
        "source": "packaged",
        "sha256": sha256,
    }


def _remote_asset(asset_id: str, role: str) -> dict[str, str]:
    return {"asset_id": asset_id, "role": role, "source": "remote"}


def _local_chat(entry: ModelEntry) -> dict[str, object]:
    chat: dict[str, object] = {
        "model_id": entry.id,
        "weights": _packaged_asset(entry.id, "chat_weights", entry.sha256),
    }
    draft = entry.draft_asset()
    if draft is not None:
        chat["draft"] = _packaged_asset(draft.id, "draft_weights", draft.sha256)
    # PR #1981 adds mmproj_asset(). Keep this resolver compatible before and
    # after that change lands without treating a missing optional method as a
    # text-only runtime decision.
    mmproj_factory = getattr(entry, "mmproj_asset", None)
    projector = mmproj_factory() if callable(mmproj_factory) else None
    if projector is not None:
        chat["projector"] = _packaged_asset(
            projector.id, "vision_projector", projector.sha256
        )
    return chat


def _local_launch_settings(entry: ModelEntry) -> dict[str, object]:
    return {
        "default_ctx": entry.default_ctx,
        "default_ngl": entry.default_ngl,
        "default_n_predict": entry.default_n_predict,
        "extra_args": list(entry.extra_args),
    }


def _launch_spec_sha256(value: dict[str, object]) -> str:
    canonical = json.dumps(value, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def resolve_model_binding(
    lifecycle: dict[str, Any],
    *,
    bundles: BundleRegistry | None = None,
    assets: Registry | None = None,
) -> dict[str, object] | None:
    """Return the active Binding while preserving the existing Bundle revision."""
    primary = lifecycle.get("primary_bundle")
    if not isinstance(primary, dict) or primary.get("state") != "ready":
        return None

    bundle_registry = bundles or load_bundle_registry()
    bundle: BundleEntry = bundle_registry.require(str(primary.get("bundle_id", "")))
    revision = int(lifecycle["bundle_revision"])

    if bundle.backend == "llama":
        asset_registry = assets or load_builtin_registry()
        chat = _local_chat(asset_registry.require(bundle.chat_model_id))
        chat_entry = asset_registry.require(bundle.chat_model_id)
        embedding_entry = asset_registry.require(bundle.embedding_model_id)
        embedding = {
            "model_id": embedding_entry.id,
            "weights": _packaged_asset(
                embedding_entry.id, "embedding_weights", embedding_entry.sha256
            ),
        }
        endpoint_ref = "local:llama-router"
        credential_ref = None
        launch_settings: dict[str, object] = {
            "chat": _local_launch_settings(chat_entry),
            "embedding": _local_launch_settings(embedding_entry),
        }
    else:
        chat = {
            "model_id": bundle.chat_model_id,
            "weights": _remote_asset(bundle.chat_model_id, "chat_weights"),
        }
        embedding = {
            "model_id": bundle.embedding_model_id,
            "weights": _remote_asset(bundle.embedding_model_id, "embedding_weights"),
        }
        fingerprint = lifecycle.get("primary_edge_config_fingerprint")
        if not isinstance(fingerprint, str) or not fingerprint:
            raise ValueError("committed Edge Binding has no configuration fingerprint")
        endpoint_ref = f"edge-config:{fingerprint}"
        credential_ref = endpoint_ref
        launch_settings = {}

    launch_identity: dict[str, object] = {
        "backend": bundle.backend,
        "bundle_id": bundle.bundle_id,
        "chat": chat,
        "embedding": embedding,
        "endpoint_ref": endpoint_ref,
        "credential_ref": credential_ref,
        "registry_version": bundle.registry_version,
        "launch_settings": launch_settings,
    }
    binding: dict[str, object] = {
        "contract_version": 1,
        "binding_revision": revision,
        "bundle_id": bundle.bundle_id,
        "backend": bundle.backend,
        "compatible_product_profiles": list(bundle.compatible_product_profiles),
        "chat": chat,
        "embedding": embedding,
        "endpoint_ref": endpoint_ref,
        "launch_spec_sha256": _launch_spec_sha256(launch_identity),
        "capabilities": {"text": True, "vision": "projector" in chat},
        "state": "ready",
    }
    if credential_ref is not None:
        binding["credential_ref"] = credential_ref
    return binding


def read_model_binding_state(store: Any) -> dict[str, object]:
    lifecycle = store.get_bundle_lifecycle()
    state: dict[str, object] = {
        "contract_version": 1,
        "binding_revision": int(lifecycle["bundle_revision"]),
    }
    active = resolve_model_binding(lifecycle)
    if active is not None:
        state["active"] = active
    return state
