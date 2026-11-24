"""Model registry - builtin + user override + env override merge.

Layer order (lowest to highest precedence):

1. ``<package>/data/models.builtin.json``          (shipped via PyInstaller ``datas``)
2. ``<registry_dir>/models.user.json``             (per-install)
3. ``$LRM_MODEL_REGISTRY_OVERRIDE``                (whole-file replacement)

Merge rules (layers 1 + 2 only):

* Models are keyed by ``id``.
* For matching ids, layer 2 fields override layer 1 fields shallowly.
* New ids in layer 2 are appended.
* ``active_chat_model_id`` / ``active_embedding_model_id`` from layer 2
  override layer 1 (if present).

Layer 3, when set, **replaces the entire merged result**.

Validation (raises :class:`RegistryError`):

* every model entry has ``role in {chat, embedding}``
* ``active_chat_model_id`` exists and points to a ``chat`` entry
* ``active_embedding_model_id`` exists and points to an ``embedding`` entry
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from .config import LocalConfig


ROLE_CHAT = "chat"
ROLE_EMBEDDING = "embedding"
VALID_ROLES = {ROLE_CHAT, ROLE_EMBEDDING}
_REGISTRY_TOP_LEVEL_FIELDS = frozenset(
    {"active_chat_model_id", "active_embedding_model_id", "models"}
)
_CAPABILITY_BEARING_MODEL_FIELDS = frozenset(
    {
        "backend",
        "bundle_id",
        "capability_contract_version",
        "capability_grade",
        "chat_model_id",
        "embedding_model_id",
        "priority",
        "registry_version",
    }
)
TRUSTED_LOCAL_ASSET_IDS = frozenset(
    {
        "qwen3.6-35b-a3b",
        "gemma-4-26b-a4b-it",
        "qwen3.8-27b",
        "qwen3.5-4b",
        "gemma4-e4b-it",
        "KaLM-embedding-v2.5",
    }
)

# The only requirement keys the hardware policy actually consumes
# (``policy.select_chat_model`` / ``eligibility``). An unrecognised key is
# almost always a typo (e.g. ``min_ram_gbs``) that would otherwise silently
# produce ``None``/``0`` and disable hardware gating for that model, so
# ``ModelEntry.from_dict`` rejects it at load time.
_RECOGNISED_REQUIREMENT_KEYS = frozenset(
    {"min_ram_gb", "min_mem_speed_mts", "igpu_keywords"}
)


# Appended to a model id to key its draft's verification record apart from the
# model's own. Never a directory name - the draft file lives beside the main
# GGUF under the *parent* id (see ``ModelEntry.draft_asset``).
DRAFT_ASSET_ID_SUFFIX = "#draft"


class RegistryError(ValueError):
    """Raised when the registry fails validation."""


def _hex_digest(value: Any, *, model_id: Any, field: str) -> str | None:
    """Normalise an optional sha256 field, rejecting a non-hex digest.

    A typo is caught at load time instead of silently never matching the
    downloaded file's real hash in ``verify_model``. Empty strings are treated
    as missing values, which matters for direct-URL assets that must verify on
    checksum instead of silently skipping integrity checks.
    """
    if value is None:
        return None
    digest = str(value).strip()
    if not digest:
        return None
    if not all(c in "0123456789abcdefABCDEF" for c in digest):
        raise RegistryError(
            f"model entry {model_id!r} has a non-hex {field}: {digest!r}"
        )
    return digest


def _validate_draft_fields(
    *,
    model_id: Any,
    draft_repo: str,
    draft_url: str,
    draft_filename: str,
    draft_size_bytes: int,
    draft_sha256: str | None,
) -> None:
    """Reject a half-declared draft, which would silently never download.

    A ``draft_filename`` on its own stays legal: that is the bring-your-own
    draft file case. Everything else must come as a complete downloadable set,
    because the downloader needs a source to fetch it, the size to report
    progress, and the digest to verify what it got.
    """
    if draft_repo and draft_url:
        raise RegistryError(
            f"model entry {model_id!r} sets both draft_repo and draft_url; "
            "they are mutually exclusive"
        )
    if not any((draft_repo, draft_url, draft_size_bytes > 0, draft_sha256)):
        return
    missing: list[str] = []
    if not (draft_repo or draft_url):
        missing.append("draft_repo or draft_url")
    if draft_size_bytes <= 0:
        missing.append("draft_size_bytes")
    if not draft_sha256:
        missing.append("draft_sha256")
    if not draft_filename:
        missing.append("draft_filename")
    if missing:
        raise RegistryError(
            f"model entry {model_id!r} declares a downloadable draft but is "
            f"missing {sorted(missing)}"
        )


@dataclass
class ModelEntry:
    id: str
    name: str
    role: str
    source: str
    repo: str
    filename: str
    size_bytes: int
    sha256: str | None
    default_port: int | None
    default_ctx: int
    default_ngl: int
    extra_args: list[str]
    # Optional Hugging Face revision (prefer an immutable commit SHA). When
    # absent, the downloader preserves the existing default-branch behaviour.
    revision: str | None = None
    # Optional hardware requirements consumed by ``policy.select_chat_model``.
    # Recognised keys: ``min_ram_gb``, ``min_mem_speed_mts``, ``igpu_keywords``.
    # ``None`` / empty dict means "runs anywhere" (universal baseline tier).
    requirements: dict[str, Any] | None = None
    # Output dimensionality for embedding models (0 = unknown).
    # Used to inject LRM_EMBEDDING_DIMENSION into the sandbox env.
    embedding_dimension: int = 0
    # Per-response output cap (llama-server --n-predict). 0 = use the
    # supervisor's built-in default (16384). Set per-model in the registry
    # JSON to give larger models more headroom for big tool-call payloads,
    # or to clamp tiny models below the global default.
    default_n_predict: int = 0
    # Speculative-decoding draft model, resolved next to this model's own GGUF
    # in ``models_dir/<id>/``. A filename rather than a path so it stays valid
    # on any install root; empty means the model runs without a draft.
    draft_filename: str = ""
    # Direct URL for a non-HuggingFace asset. Empty for repository-sourced
    # assets.
    url: str = ""
    # Download facts for that draft. When ``draft_repo`` or ``draft_url`` is set
    # the draft is a *downloadable* sidecar of this asset (see
    # :meth:`draft_asset`) and the downloader fetches it in the same operation
    # as the main GGUF. A ``draft_filename`` with no source keeps the older
    # bring-your-own-file behaviour: the supervisor uses the draft when it
    # happens to be on disk and drops the ``spec-*`` options when it is not.
    draft_repo: str = ""
    draft_url: str = ""
    draft_size_bytes: int = 0
    draft_sha256: str | None = None
    draft_revision: str | None = None
    # User-facing caveat codes (contracts ``ModelWarning``); validated by the
    # strict trusted-asset loader in ``capability.bundle_registry``.
    warnings: tuple[str, ...] = ()

    @property
    def total_size_bytes(self) -> int:
        """Every byte this asset installs: the main GGUF plus its draft.

        Use for space checks, download totals and progress denominators.
        ``size_bytes`` stays the size of the *main* file alone because it is
        compared against that one file's ``st_size`` for readiness.
        """
        return self.size_bytes + (
            self.draft_size_bytes if (self.draft_repo or self.draft_url) else 0
        )

    def draft_asset(self) -> "ModelEntry | None":
        """Return the draft GGUF as a standalone downloadable asset.

        ``None`` when this entry declares no downloadable draft. The draft is
        stored *beside* its parent (``models_dir/<parent id>/<draft filename>``),
        so callers must resolve its path from the parent id; the synthetic id
        here exists only to key the draft's own verification record apart from
        the parent's.

        The draft's source is decided by the draft itself, not by the parent
        model: a URL-sourced model may still use a Hugging Face repo draft, and
        the reverse is also valid. A synthetic URL draft with an empty URL would
        otherwise send the task into the direct-stream path even though the
        actual draft is repo-backed.
        """
        if not (self.draft_repo or self.draft_url):
            return None
        draft_source = "url" if self.draft_url else "huggingface"
        return ModelEntry(
            id=f"{self.id}{DRAFT_ASSET_ID_SUFFIX}",
            name=f"{self.name} draft",
            role=self.role,
            source=draft_source,
            repo=self.draft_repo,
            filename=self.draft_filename,
            size_bytes=self.draft_size_bytes,
            sha256=self.draft_sha256,
            default_port=None,
            default_ctx=0,
            default_ngl=0,
            extra_args=[],
            revision=self.draft_revision,
            url=self.draft_url,
        )

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "ModelEntry":
        try:
            req_raw = d.get("requirements")
            requirements = dict(req_raw) if isinstance(req_raw, dict) else None
            if requirements:
                unknown = set(requirements) - _RECOGNISED_REQUIREMENT_KEYS
                if unknown:
                    raise RegistryError(
                        f"model entry {d.get('id')!r} has unrecognised requirement "
                        f"key(s) {sorted(unknown)}; recognised keys: "
                        f"{sorted(_RECOGNISED_REQUIREMENT_KEYS)}"
                    )
            sha256 = _hex_digest(d.get("sha256"), model_id=d.get("id"), field="sha256")
            draft_sha256 = _hex_digest(
                d.get("draft_sha256"), model_id=d.get("id"), field="draft_sha256"
            )
            source = d.get("source", "huggingface")
            revision = str(d.get("revision") or "").strip() or None
            url = str(d.get("url") or "")
            size_bytes = int(d.get("size_bytes", 0))
            if source == "url":
                if not url:
                    raise RegistryError(
                        f"model entry {d.get('id')!r} with source='url' "
                        "requires a non-empty url"
                    )
                if size_bytes <= 0:
                    raise RegistryError(
                        f"model entry {d.get('id')!r} with source='url' "
                        "requires a positive size_bytes"
                    )
                if sha256 is None:
                    raise RegistryError(
                        f"model entry {d.get('id')!r} with source='url' "
                        "requires a sha256 digest"
                    )
            draft_filename = str(d.get("draft_filename") or "")
            draft_repo = str(d.get("draft_repo") or "")
            draft_url = str(d.get("draft_url") or "")
            draft_size_bytes = int(d.get("draft_size_bytes") or 0)
            draft_revision = str(d.get("draft_revision") or "").strip() or None
            _validate_draft_fields(
                model_id=d.get("id"),
                draft_repo=draft_repo,
                draft_url=draft_url,
                draft_filename=draft_filename,
                draft_size_bytes=draft_size_bytes,
                draft_sha256=draft_sha256,
            )
            return cls(
                id=d["id"],
                name=d.get("name", d["id"]),
                role=d["role"],
                source=source,
                repo=str(d.get("repo") or "") if source == "url" else d["repo"],
                filename=d["filename"],
                size_bytes=size_bytes,
                sha256=sha256,
                default_port=(
                    int(d["default_port"])
                    if d.get("default_port") not in (None, "")
                    else None
                ),
                default_ctx=int(d.get("default_ctx", 8192)),
                default_ngl=int(d.get("default_ngl", 99)),
                default_n_predict=int(d.get("default_n_predict") or 0),
                extra_args=list(d.get("extra_args") or []),
                revision=revision,
                requirements=requirements,
                embedding_dimension=int(d.get("embedding_dimension") or 0),
                draft_filename=draft_filename,
                draft_repo=draft_repo,
                draft_url=draft_url,
                draft_size_bytes=draft_size_bytes,
                draft_sha256=draft_sha256,
                draft_revision=draft_revision,
                url=url,
                warnings=tuple(d.get("warnings") or ()),
            )
        except KeyError as ke:
            raise RegistryError(
                f"model entry {d.get('id')!r} missing field {ke.args[0]!r}"
            ) from ke


@dataclass
class Registry:
    default_chat_id: str
    default_embedding_id: str
    models: dict[str, ModelEntry]  # keyed by id

    def get(self, model_id: str) -> ModelEntry | None:
        return self.models.get(model_id)

    def by_role(self, role: str) -> list[ModelEntry]:
        return [m for m in self.models.values() if m.role == role]

    def require(self, model_id: str) -> ModelEntry:
        m = self.models.get(model_id)
        if not m:
            raise RegistryError(f"unknown model id: {model_id!r}")
        return m


def _read_json(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise RegistryError(f"registry file {path} is not valid JSON: {e}") from e


def _merge(base: dict[str, Any], overlay: dict[str, Any]) -> dict[str, Any]:
    """Layer overlay onto base, by-id for ``models``; shallow for top-level keys."""
    _validate_registry_top_level(overlay, source="user registry")
    merged: dict[str, Any] = {
        "active_chat_model_id": overlay.get("active_chat_model_id")
        or base.get("active_chat_model_id"),
        "active_embedding_model_id": overlay.get("active_embedding_model_id")
        or base.get("active_embedding_model_id"),
    }
    by_id: dict[str, dict[str, Any]] = {
        m["id"]: dict(m) for m in base.get("models", []) if "id" in m
    }
    for m in overlay.get("models", []) or []:
        mid = m.get("id")
        if not mid:
            continue
        if mid in TRUSTED_LOCAL_ASSET_IDS:
            raise RegistryError(
                f"user registry may not override trusted bundle asset {mid!r}"
            )
        if mid in by_id:
            by_id[mid] = {**by_id[mid], **m}
        else:
            by_id[mid] = dict(m)
    merged["models"] = list(by_id.values())
    return merged


def _reject_trusted_asset_ids(registry: dict[str, Any], *, source: str) -> None:
    collisions = sorted(
        model.get("id")
        for model in registry.get("models", []) or []
        if isinstance(model, dict) and model.get("id") in TRUSTED_LOCAL_ASSET_IDS
    )
    if collisions:
        raise RegistryError(
            f"{source} may not replace trusted bundle asset id(s): {collisions}"
        )


def _validate_registry_top_level(registry: dict[str, Any], *, source: str) -> None:
    unknown = set(registry) - _REGISTRY_TOP_LEVEL_FIELDS
    if unknown:
        raise RegistryError(f"{source} has unsupported field(s): {sorted(unknown)}")
    for model in registry.get("models", []) or []:
        if not isinstance(model, dict):
            continue
        capability_fields = _find_capability_fields(model)
        if capability_fields:
            raise RegistryError(
                f"{source} model entry has capability-bearing field(s): "
                f"{sorted(capability_fields)}"
            )


def _find_capability_fields(value: object) -> set[str]:
    if isinstance(value, dict):
        found = set(value) & _CAPABILITY_BEARING_MODEL_FIELDS
        for nested in value.values():
            found.update(_find_capability_fields(nested))
        return found
    if isinstance(value, list):
        found: set[str] = set()
        for nested in value:
            found.update(_find_capability_fields(nested))
        return found
    return set()


# registry.py lives at ``src/llmrouter_manager/local/registry.py``.
# ``parents[1]`` == ``src/llmrouter_manager`` (the package root that carries
# ``data/``). This resolves correctly in a source checkout AND in the frozen
# onedir, where PyInstaller ``datas`` places ``llmrouter_manager/data/`` under
# ``_internal/`` alongside the package - so ``__file__`` navigation works in
# both modes (no ``sys.frozen`` / ``_MEIPASS`` special-casing needed).
_PACKAGE_ROOT = Path(__file__).resolve().parents[1]


def _builtin_path() -> Path:
    """Return the path to the builtin models registry JSON.

    The dev-only local-Bundle mock replaces this file wholesale (see
    ``local/mock_bundle.py``). It substitutes the *builtin* layer rather than
    the ``LRM_MODEL_REGISTRY_OVERRIDE`` layer on purpose: that override rejects
    every id in ``TRUSTED_LOCAL_ASSET_IDS`` and is a whole-file replacement, so
    it could not carry the trusted KaLM embedding entry the supervisor needs
    for the role the mock keeps running for real.
    """
    from .mock_bundle import MODELS_FILENAME, registry_file

    mocked = registry_file(MODELS_FILENAME)
    return mocked if mocked is not None else _PACKAGE_ROOT / "data" / "models.builtin.json"


def load_builtin_registry(*, builtin_path: Path | None = None) -> Registry:
    """Load packaged asset facts without user or environment override layers."""
    path = builtin_path or _builtin_path()
    builtin = _read_json(path)
    if builtin is None:
        raise RegistryError(f"builtin registry missing at {path}")
    return _build_registry(builtin)


def _build_registry(merged: dict[str, Any]) -> Registry:
    raw_models: Iterable[dict[str, Any]] = merged.get("models") or []
    models: dict[str, ModelEntry] = {}
    for m in raw_models:
        entry = ModelEntry.from_dict(m)
        if entry.role not in VALID_ROLES:
            raise RegistryError(
                f"model {entry.id!r} has invalid role {entry.role!r}; must be one of {sorted(VALID_ROLES)}"
            )
        if entry.id in models:
            raise RegistryError(f"duplicate model id after merge: {entry.id!r}")
        models[entry.id] = entry

    chat_id = merged.get("active_chat_model_id")
    emb_id = merged.get("active_embedding_model_id")

    # When not explicitly declared, auto-select the first model of each role.
    if not chat_id or chat_id not in models:
        chat_id = next((mid for mid, m in models.items() if m.role == ROLE_CHAT), None)
        if chat_id is None:
            raise RegistryError("no chat model in registry")
    elif models[chat_id].role != ROLE_CHAT:
        raise RegistryError(
            f"active_chat_model_id={chat_id!r} must reference a chat model (got role={models[chat_id].role!r})"
        )

    if not emb_id or emb_id not in models:
        emb_id = next((mid for mid, m in models.items() if m.role == ROLE_EMBEDDING), None)
        if emb_id is None:
            raise RegistryError("no embedding model in registry")
    elif models[emb_id].role != ROLE_EMBEDDING:
        raise RegistryError(
            f"active_embedding_model_id={emb_id!r} must reference an embedding model (got role={models[emb_id].role!r})"
        )

    return Registry(default_chat_id=chat_id, default_embedding_id=emb_id, models=models)


def load_registry(
    cfg: LocalConfig,
    *,
    builtin_path: Path | None = None,
    user_path: Path | None = None,
) -> Registry:
    """Load and validate the merged registry.

    ``builtin_path`` and ``user_path`` are exposed for unit tests; production
    paths are derived from the package layout / ``cfg``.
    """
    bp = builtin_path or _builtin_path()
    up = user_path or (cfg.registry_dir / "models.user.json")

    builtin = _read_json(bp)
    if builtin is None:
        raise RegistryError(f"builtin registry missing at {bp}")

    user = _read_json(up) or {}

    if cfg.model_registry_override is not None:
        override = _read_json(cfg.model_registry_override)
        if override is None:
            raise RegistryError(
                f"LRM_MODEL_REGISTRY_OVERRIDE points to missing file: {cfg.model_registry_override}"
            )
        _validate_registry_top_level(override, source="LRM_MODEL_REGISTRY_OVERRIDE")
        _reject_trusted_asset_ids(override, source="LRM_MODEL_REGISTRY_OVERRIDE")
        merged = override  # whole-file replacement for custom/untrusted assets
    else:
        merged = _merge(builtin, user)

    return _build_registry(merged)
