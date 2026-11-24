"""Strict loader for the packaged atomic Chat+Embedding Bundle registry."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType
from typing import Literal, Mapping

from contracts.primary_bundle import ModelWarning

from ..local import mock_bundle
from ..local.registry import ROLE_CHAT, ROLE_EMBEDDING, Registry, load_builtin_registry

Backend = Literal["llama", "edge"]

SUPPORTED_CAPABILITY_CONTRACT_VERSIONS = frozenset({1})
_GRADE_RE = re.compile(r"^[a-z][a-z0-9-]*$")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_TOP_LEVEL_FIELDS = frozenset({"registry_version", "capability_contract_version", "bundles"})
_BUNDLE_FIELDS = frozenset(
    {
        "bundle_id",
        "backend",
        "chat_model_id",
        "embedding_model_id",
        "capability_grade",
        "compatible_product_profiles",
        "priority",
    }
)
_ASSET_FIELDS = frozenset(
    {
        "id",
        "name",
        "role",
        "source",
        "repo",
        "revision",
        "url",
        "filename",
        "size_bytes",
        "sha256",
        "default_port",
        "default_ctx",
        "default_ngl",
        "default_n_predict",
        "draft_filename",
        "draft_repo",
        "draft_revision",
        "draft_url",
        "draft_size_bytes",
        "draft_sha256",
        "extra_args",
        "requirements",
        "embedding_dimension",
        "warnings",
    }
)
_MODEL_WARNINGS = frozenset(warning.value for warning in ModelWarning)
_REQUIREMENT_FIELDS = frozenset({"min_ram_gb", "min_mem_speed_mts", "igpu_keywords"})
_TRUSTED_EDGE_PAIRS = frozenset({
    ("Qwen3-Coder-Next", "KaLM-embedding-v2.5"),
    ("Qwen3.8-Flash-Next", "KaLM-embedding-v2.5"),
})
_PRODUCT_PROFILES = frozenset({"lite", "standard", "pro"})


class BundleRegistryError(ValueError):
    """Raised when packaged Bundle facts are invalid or ambiguous."""


@dataclass(frozen=True)
class BundleEntry:
    bundle_id: str
    backend: Backend
    chat_model_id: str
    embedding_model_id: str
    capability_grade: str
    compatible_product_profiles: tuple[str, ...]
    capability_contract_version: int
    registry_version: int
    priority: int

    def as_model_bundle(self) -> dict[str, str | int]:
        """Return the frozen shared-contract wire identity; internal priority is omitted."""
        return {
            "backend": self.backend,
            "bundle_id": self.bundle_id,
            "chat_model_id": self.chat_model_id,
            "embedding_model_id": self.embedding_model_id,
            "capability_grade": self.capability_grade,
            "capability_contract_version": self.capability_contract_version,
            "registry_version": self.registry_version,
        }


@dataclass(frozen=True)
class BundleRegistry:
    registry_version: int
    capability_contract_version: int
    bundles: Mapping[str, BundleEntry]

    def require(self, bundle_id: str) -> BundleEntry:
        try:
            return self.bundles[bundle_id]
        except KeyError as exc:
            raise BundleRegistryError(f"unknown bundle id: {bundle_id!r}") from exc

    def by_backend(self, backend: Backend) -> tuple[BundleEntry, ...]:
        return tuple(bundle for bundle in self.bundles.values() if bundle.backend == backend)

    def local_bundles(self) -> tuple[BundleEntry, ...]:
        return self.by_backend("llama")

    def ranked_local_bundles(self) -> tuple[BundleEntry, ...]:
        """Rank local Bundles by the registry's explicit priority."""
        return tuple(
            sorted(
                self.local_bundles(),
                key=lambda bundle: bundle.priority,
                reverse=True,
            )
        )

    def match_edge_models(
        self,
        discovered_model_ids: set[str] | frozenset[str],
        *,
        bundle_id: str | None = None,
    ) -> BundleEntry | None:
        matches = [
            bundle
            for bundle in self.by_backend("edge")
            if (bundle_id is None or bundle.bundle_id == bundle_id)
            if bundle.chat_model_id in discovered_model_ids
            and bundle.embedding_model_id in discovered_model_ids
        ]
        if len(matches) > 1:
            raise BundleRegistryError("discovered Edge models match multiple trusted bundles")
        return matches[0] if matches else None


def _builtin_path() -> Path:
    mocked = mock_bundle.registry_file(mock_bundle.BUNDLES_FILENAME)
    if mocked is not None:
        return mocked
    return Path(__file__).resolve().parents[1] / "data" / "bundles.builtin.json"


def _asset_builtin_path() -> Path:
    mocked = mock_bundle.registry_file(mock_bundle.MODELS_FILENAME)
    if mocked is not None:
        return mocked
    return Path(__file__).resolve().parents[1] / "data" / "models.builtin.json"


def _read_object(path: Path) -> dict[str, object]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise BundleRegistryError(f"bundle registry missing at {path}") from exc
    except json.JSONDecodeError as exc:
        raise BundleRegistryError(f"bundle registry {path} is not valid JSON: {exc}") from exc
    if not isinstance(value, dict):
        raise BundleRegistryError("bundle registry root must be an object")
    return value


def _require_int(value: object, field: str, *, minimum: int = 1) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < minimum:
        raise BundleRegistryError(f"{field} must be an integer >= {minimum}")
    return value


def _require_string(value: object, field: str) -> str:
    if not isinstance(value, str) or not value:
        raise BundleRegistryError(f"{field} must be a non-empty string")
    return value


def _strict_asset_registry(path: Path) -> Registry:
    raw = _read_object(path)
    if set(raw) != {"models"}:
        raise BundleRegistryError("trusted asset registry must contain only models")
    raw_models = raw.get("models")
    if not isinstance(raw_models, list) or not raw_models:
        raise BundleRegistryError("trusted asset models must be a non-empty array")
    seen: set[str] = set()
    for raw_asset in raw_models:
        if not isinstance(raw_asset, dict):
            raise BundleRegistryError("each trusted asset must be an object")
        unknown = set(raw_asset) - _ASSET_FIELDS
        if unknown:
            raise BundleRegistryError(f"unknown trusted asset field(s): {sorted(unknown)}")
        asset_id = _require_string(raw_asset.get("id"), "asset.id")
        if asset_id in seen:
            raise BundleRegistryError(f"duplicate trusted asset id: {asset_id!r}")
        seen.add(asset_id)
        role = _require_string(raw_asset.get("role"), f"asset {asset_id}.role")
        if role not in {ROLE_CHAT, ROLE_EMBEDDING}:
            raise BundleRegistryError(f"trusted asset {asset_id!r} has invalid role")
        source = _require_string(raw_asset.get("source"), f"asset {asset_id}.source")
        if source == "huggingface":
            _require_string(raw_asset.get("repo"), f"asset {asset_id}.repo")
            if "revision" in raw_asset:
                _require_string(raw_asset["revision"], f"asset {asset_id}.revision")
        elif source == "url":
            _require_string(raw_asset.get("url"), f"asset {asset_id}.url")
        else:
            raise BundleRegistryError(
                f"trusted asset {asset_id!r} has unsupported source {source!r}"
            )
        filename = _require_string(raw_asset.get("filename"), f"asset {asset_id}.filename")
        if not filename.lower().endswith(".gguf"):
            raise BundleRegistryError(f"trusted asset {asset_id!r} must be a GGUF file")
        _require_int(raw_asset.get("size_bytes"), f"asset {asset_id}.size_bytes")
        digest = raw_asset.get("sha256")
        if not isinstance(digest, str) or _SHA256_RE.fullmatch(digest) is None:
            raise BundleRegistryError(f"trusted asset {asset_id!r} must have a lowercase SHA-256")
        if any(field.startswith("draft_") for field in raw_asset):
            _validate_trusted_draft(asset_id, raw_asset)
        for numeric_field in ("default_port", "default_ctx", "default_ngl"):
            _require_int(raw_asset.get(numeric_field), f"asset {asset_id}.{numeric_field}", minimum=0)
        if "default_n_predict" in raw_asset:
            _require_int(
                raw_asset["default_n_predict"],
                f"asset {asset_id}.default_n_predict",
            )
        extra_args = raw_asset.get("extra_args")
        if not isinstance(extra_args, list) or not all(isinstance(arg, str) for arg in extra_args):
            raise BundleRegistryError(f"trusted asset {asset_id!r} extra_args must be strings")
        if "warnings" in raw_asset:
            warnings = raw_asset["warnings"]
            if (
                not isinstance(warnings, list)
                or not warnings
                or not all(isinstance(warning, str) and warning in _MODEL_WARNINGS for warning in warnings)
                or len(set(warnings)) != len(warnings)
            ):
                raise BundleRegistryError(
                    f"trusted asset {asset_id!r} warnings must be distinct known codes "
                    f"{sorted(_MODEL_WARNINGS)}"
                )
        requirements = raw_asset.get("requirements")
        if requirements is not None:
            if not isinstance(requirements, dict):
                raise BundleRegistryError(f"trusted asset {asset_id!r} requirements must be an object")
            unknown_requirements = set(requirements) - _REQUIREMENT_FIELDS
            if unknown_requirements:
                raise BundleRegistryError(
                    f"trusted asset {asset_id!r} has unknown requirement(s): {sorted(unknown_requirements)}"
                )
            for field in ("min_ram_gb", "min_mem_speed_mts"):
                if field in requirements:
                    _require_int(requirements[field], f"asset {asset_id}.requirements.{field}")
            keywords = requirements.get("igpu_keywords")
            if keywords is not None and (
                not isinstance(keywords, list)
                or not all(isinstance(keyword, str) and keyword for keyword in keywords)
            ):
                raise BundleRegistryError(
                    f"trusted asset {asset_id!r} igpu_keywords must be non-empty strings"
                )
        if role == ROLE_CHAT:
            if not isinstance(requirements, dict) or set(requirements) != _REQUIREMENT_FIELDS:
                raise BundleRegistryError(
                    f"trusted chat asset {asset_id!r} requires complete compute requirements"
                )
        if role == ROLE_EMBEDDING:
            _require_int(
                raw_asset.get("embedding_dimension"),
                f"asset {asset_id}.embedding_dimension",
            )
    return load_builtin_registry(builtin_path=path)


def _validate_trusted_draft(asset_id: str, raw_asset: dict[str, object]) -> None:
    """A trusted asset's draft must be as pinned as the asset itself.

    A packaged draft is downloaded and loaded into the model server exactly
    like the main GGUF, so it carries the same evidence: an explicit repo or
    URL, a GGUF filename, a declared size and a lowercase SHA-256.
    """
    filename = _require_string(raw_asset.get("draft_filename"), f"asset {asset_id}.draft_filename")
    if not filename.lower().endswith(".gguf"):
        raise BundleRegistryError(f"trusted asset {asset_id!r} draft must be a GGUF file")
    draft_repo = raw_asset.get("draft_repo")
    draft_url = raw_asset.get("draft_url")
    if bool(draft_repo) == bool(draft_url):
        raise BundleRegistryError(
            f"trusted asset {asset_id!r} draft must declare exactly one of "
            "draft_repo or draft_url"
        )
    if draft_repo:
        _require_string(draft_repo, f"asset {asset_id}.draft_repo")
        if "draft_revision" in raw_asset:
            _require_string(
                raw_asset["draft_revision"], f"asset {asset_id}.draft_revision"
            )
    else:
        _require_string(draft_url, f"asset {asset_id}.draft_url")
    _require_int(raw_asset.get("draft_size_bytes"), f"asset {asset_id}.draft_size_bytes")
    digest = raw_asset.get("draft_sha256")
    if not isinstance(digest, str) or _SHA256_RE.fullmatch(digest) is None:
        raise BundleRegistryError(
            f"trusted asset {asset_id!r} draft must have a lowercase SHA-256"
        )


def _validate_local_assets(bundle: BundleEntry, assets: Registry) -> None:
    chat = assets.get(bundle.chat_model_id)
    embedding = assets.get(bundle.embedding_model_id)
    if chat is None or chat.role != ROLE_CHAT:
        raise BundleRegistryError(
            f"bundle {bundle.bundle_id!r} chat_model_id must reference a trusted chat asset"
        )
    if embedding is None or embedding.role != ROLE_EMBEDDING:
        raise BundleRegistryError(
            f"bundle {bundle.bundle_id!r} embedding_model_id must reference a trusted embedding asset"
        )
    for asset in (chat, embedding):
        if asset.size_bytes <= 0:
            raise BundleRegistryError(f"trusted asset {asset.id!r} must have positive size_bytes")
        if asset.sha256 is None or _SHA256_RE.fullmatch(asset.sha256) is None:
            raise BundleRegistryError(f"trusted asset {asset.id!r} must have a lowercase SHA-256")


def load_bundle_registry(
    *,
    builtin_path: Path | None = None,
    asset_registry: Registry | None = None,
    asset_builtin_path: Path | None = None,
    supported_contract_versions: frozenset[int] = SUPPORTED_CAPABILITY_CONTRACT_VERSIONS,
) -> BundleRegistry:
    """Load immutable packaged Bundle facts; user/env model overrides never participate.

    ``LRM_MODEL_REGISTRY_OVERRIDE`` and ``models.user.json`` are still excluded
    here. The one exception is the dev-only local-Bundle mock, which replaces
    the packaged *builtin* files themselves via ``_builtin_path`` /
    ``_asset_builtin_path`` -- so the overlay is parsed by exactly these strict
    validators rather than bypassing them.
    """
    raw = _read_object(builtin_path or _builtin_path())
    unknown_top = set(raw) - _TOP_LEVEL_FIELDS
    if unknown_top:
        raise BundleRegistryError(f"unknown bundle registry field(s): {sorted(unknown_top)}")

    registry_version = _require_int(raw.get("registry_version"), "registry_version")
    contract_version = _require_int(
        raw.get("capability_contract_version"), "capability_contract_version"
    )
    if contract_version not in supported_contract_versions:
        raise BundleRegistryError(
            f"unsupported capability_contract_version: {contract_version}"
        )

    raw_bundles = raw.get("bundles")
    if not isinstance(raw_bundles, list) or not raw_bundles:
        raise BundleRegistryError("bundles must be a non-empty array")

    assets = asset_registry or _strict_asset_registry(asset_builtin_path or _asset_builtin_path())
    bundles: dict[str, BundleEntry] = {}
    priorities: set[tuple[str, int]] = set()
    for raw_bundle in raw_bundles:
        if not isinstance(raw_bundle, dict):
            raise BundleRegistryError("each bundle must be an object")
        unknown = set(raw_bundle) - _BUNDLE_FIELDS
        if unknown:
            raise BundleRegistryError(f"unknown bundle field(s): {sorted(unknown)}")
        missing = _BUNDLE_FIELDS - set(raw_bundle)
        if missing:
            raise BundleRegistryError(f"bundle missing field(s): {sorted(missing)}")

        bundle_id = _require_string(raw_bundle["bundle_id"], "bundle_id")
        backend = _require_string(raw_bundle["backend"], "backend")
        if backend not in {"llama", "edge"}:
            raise BundleRegistryError(f"bundle {bundle_id!r} has invalid backend {backend!r}")
        grade = _require_string(raw_bundle["capability_grade"], "capability_grade")
        if _GRADE_RE.fullmatch(grade) is None:
            raise BundleRegistryError(f"bundle {bundle_id!r} has invalid capability_grade")
        priority = _require_int(raw_bundle["priority"], "priority")
        raw_profiles = raw_bundle["compatible_product_profiles"]
        if (
            not isinstance(raw_profiles, list)
            or not raw_profiles
            or not all(isinstance(profile, str) and profile in _PRODUCT_PROFILES for profile in raw_profiles)
            or len(set(raw_profiles)) != len(raw_profiles)
        ):
            raise BundleRegistryError(
                f"bundle {bundle_id!r} compatible_product_profiles must be unique shipped Profile ids"
            )
        priority_key = (backend, priority)
        if priority_key in priorities:
            raise BundleRegistryError(
                f"duplicate priority {priority} for backend={backend!r}"
            )
        priorities.add(priority_key)

        bundle = BundleEntry(
            bundle_id=bundle_id,
            backend=backend,  # type: ignore[arg-type] -- validated above
            chat_model_id=_require_string(raw_bundle["chat_model_id"], "chat_model_id"),
            embedding_model_id=_require_string(
                raw_bundle["embedding_model_id"], "embedding_model_id"
            ),
            capability_grade=grade,
            compatible_product_profiles=tuple(raw_profiles),
            capability_contract_version=contract_version,
            registry_version=registry_version,
            priority=priority,
        )
        if bundle.chat_model_id == bundle.embedding_model_id:
            raise BundleRegistryError(f"bundle {bundle_id!r} must pair distinct model IDs")
        if bundle_id in bundles:
            raise BundleRegistryError(f"duplicate bundle id: {bundle_id!r}")
        if backend == "llama":
            _validate_local_assets(bundle, assets)
        else:
            if (bundle.chat_model_id, bundle.embedding_model_id) not in _TRUSTED_EDGE_PAIRS:
                raise BundleRegistryError(
                    f"Edge bundle {bundle_id!r} must use a reviewed trusted Chat+Embedding pair"
                )
        bundles[bundle_id] = bundle

    return BundleRegistry(
        registry_version=registry_version,
        capability_contract_version=contract_version,
        bundles=MappingProxyType(bundles),
    )
