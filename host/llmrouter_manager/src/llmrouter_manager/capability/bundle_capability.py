"""Pure compute and download evaluation for trusted Local Bundles."""

from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Mapping

from .bundle_registry import BundleEntry, BundleRegistry
from ..common.store import Store
from ..local import mock_bundle
from ..local.hardware import HardwareInfo
from ..local.models import sha256_file, stat_identity
from ..local.registry import ROLE_CHAT, ROLE_EMBEDDING, ModelEntry, Registry

GIB = 1024**3
# Hardware admission for the cloud-only Lite Profile, independent of any model.
_LITE_MIN_RAM_GB = 16
_LITE_MIN_MEM_SPEED_MTS = 5600
DownloadStatus = Literal["ready", "insufficient_disk", "probe_unknown"]


@dataclass(frozen=True)
class AssetCacheState:
    """Cache verdict for one asset, plus what is still missing from it.

    ``missing_bytes`` is per *file*, not per asset: an asset whose main GGUF is
    verified but whose speculative-decoding draft is not reports only the
    draft's bytes. Charging the whole asset would demand tens of GB of free
    space (and offer a full re-download) for a file that is already on disk.
    """

    cached_and_verified: bool
    missing_bytes: int = 0

    @classmethod
    def missing(cls, asset: "ModelEntry") -> "AssetCacheState":
        """State for an asset with nothing usable on disk."""
        return cls(cached_and_verified=False, missing_bytes=asset.total_size_bytes)


@dataclass(frozen=True)
class MissingAssetSpace:
    """Free space one not-yet-cached asset needs on the model-cache volume.

    ``download_bytes`` is what must come over the wire and ``installed_bytes``
    what the asset occupies once in place. They are *not* added together: a
    GGUF is streamed straight into its final location (``<file>.incomplete``
    beside the target, renamed within the same volume when complete), so the
    downloaded bytes and the installed bytes are the same bytes on the same
    volume, never two copies. Only a flow whose transient artifact coexists
    with the installed file - extracting from a retained archive, say - needs
    room for both, and that surplus belongs in ``temporary_expansion_bytes``.
    """

    download_bytes: int
    installed_bytes: int
    temporary_expansion_bytes: int = 0

    @property
    def peak_bytes(self) -> int:
        """Most this asset ever occupies, excluding transient expansion."""
        return max(self.download_bytes, self.installed_bytes)


@dataclass(frozen=True)
class DownloadEvaluation:
    status: DownloadStatus
    required_free_bytes: int
    reason_code: str | None = None
    reason_text: str | None = None


@dataclass(frozen=True)
class SupportedBundleEvaluation:
    bundle: BundleEntry
    chat: ModelEntry
    embedding: ModelEntry
    cache_states: tuple[AssetCacheState, AssetCacheState]
    download: DownloadEvaluation

    @property
    def total_download_bytes(self) -> int:
        return sum(state.missing_bytes for state in self.cache_states)


@dataclass(frozen=True)
class PrimaryBundleEvaluation:
    model_candidate_revision: int
    hardware_capability_ceiling: tuple[str, str] | None
    supported_bundle_ids: tuple[str, ...]
    recommended_bundle_id: str | None
    supported_bundles: tuple[SupportedBundleEvaluation, ...]
    reasons: tuple[str, ...]
    cloud_only_product_profile_id: Literal["lite"] | None = None


def inspect_asset_cache(
    models_dir: Path,
    asset: ModelEntry,
    store: Store | None = None,
    *,
    verify_hash: bool = True,
) -> AssetCacheState:
    """Verify the exact trusted asset without creating cache directories.

    ``verify_hash=False`` trusts the persisted verification record's *digest*
    and NEVER recomputes a fresh ``sha256``: a full-size file with no matching
    record reports ``cached_and_verified=False`` instead of hashing inline.
    Read-only callers with an external deadline (the B3
    ``GET /capability/primary-bundle`` projection, whose ServiceHub client
    aborts after 10 s) MUST pass this so a freshly-completed multi-GB download —
    whose ``set_model_verification`` record lands a beat after the file reaches
    full size — cannot wedge the endpoint on a minutes-long ``sha256_file``. The
    downloader is the authority that persists the record (see
    ``ModelDownloader._verify_existing`` / ``download``), so the transient "not
    verified" self-heals on the next poll.

    The record's digest is trusted, but its *existence claim* is not: a
    verification record can outlive the file it describes (a manually deleted
    asset, a disk-cleanup sweep, a wiped ``models_dir``). A stale "verified"
    record is worse than a missing one — the read projection would report the
    bundle cached while the hash-verifying commit path finds it gone, so their
    ``model_candidate_revision`` values never agree and no bundle switch can
    ever be committed (permanent limbo). The fast path therefore still confirms
    the file is present with the recorded size *and* ``mtime_ns`` via a single
    metadata ``stat``, which reads the directory entry without opening the file:
    it returns instantly for a present file, raises immediately for a missing
    one, and cannot block on a concurrent downloader's write handle or hash
    multi-GB contents. ``mtime_ns`` comes out of that same ``stat`` — no extra
    syscall — and catches the replacement that size alone cannot: a file
    swapped or rewritten to the same length would otherwise be reported cached
    off a digest that no longer describes it, inflating readiness and zeroing
    the asset out of ``missing_bytes``. Timestamps are not tamper-proof (a copy
    can preserve them), but this is the cheap direction of the trade: an mtime
    that drifted while the content is intact only under-reports, and the next
    hash-verifying caller (``verify_hash=True``,
    ``ModelDownloader._verify_existing``) rehashes and re-persists the record
    without re-downloading.

    An asset that ships a speculative-decoding draft is only cached when *both*
    its files are - the model is downloaded and launched as one unit.

    A mocked Bundle's chat asset (dev-only, ``local/mock_bundle.py``) reports
    cached-and-verified without touching the filesystem, exactly as the Edge
    Bundle's assets do: no file is ever fetched for it, so "is it on disk" is
    not a question that has a meaningful answer. Reporting it missing instead
    would send the prepare path off to download a stand-in asset whose repo and
    digest are placeholders.
    """
    if mock_bundle.mocks_chat_asset(asset.id):
        return AssetCacheState(cached_and_verified=True)

    model_dir = models_dir / asset.id
    missing_bytes = 0
    if not _inspect_asset_file(
        model_dir / asset.filename,
        verification_key=asset.id,
        expected_sha256=asset.sha256,
        expected_size=asset.size_bytes,
        store=store,
        verify_hash=verify_hash,
    ):
        missing_bytes += asset.size_bytes
    draft = asset.draft_asset()
    if draft is not None and not _inspect_asset_file(
        model_dir / draft.filename,
        verification_key=draft.id,
        expected_sha256=draft.sha256,
        expected_size=draft.size_bytes,
        store=store,
        verify_hash=verify_hash,
    ):
        missing_bytes += draft.size_bytes
    return AssetCacheState(
        cached_and_verified=missing_bytes == 0, missing_bytes=missing_bytes
    )


def _inspect_asset_file(
    path: Path,
    *,
    verification_key: str,
    expected_sha256: str | None,
    expected_size: int,
    store: Store | None,
    verify_hash: bool,
) -> bool:
    """Verify one downloaded file against its declared digest and size."""
    if expected_sha256 is None:
        return False
    expected_sha256 = expected_sha256.lower()
    if not verify_hash and store is not None:
        # Store-first fast path: trust the downloader-persisted digest instead
        # of recomputing it, but confirm the on-disk file still is the one the
        # record describes, so a stale record reports honestly. The record's
        # expected_sha256/filename/size_bytes are written by the downloader only
        # after a verified full-size file exists.
        record = store.get_model_verification(verification_key)
        if not (
            record is not None
            and record.get("expected_sha256") == expected_sha256
            and record.get("filename") == path.name
            and record.get("size_bytes") == expected_size
        ):
            return False
        try:
            stat = path.stat()
        except OSError:
            # The verification record outlived its file: treat it as stale
            # rather than blindly trusting it into a commit deadlock.
            return False
        # mtime_ns comes from the stat already taken above and rejects a
        # same-size replacement that the size check alone would wave through.
        # ctime_ns is deliberately NOT compared: on Windows it is the creation
        # timestamp and shifts after hf_hub_download's atomic temp→final rename
        # (see ModelDownloader._record_matches_file, which refreshes it).
        return stat.st_size == expected_size and stat.st_mtime_ns == record.get(
            "mtime_ns"
        )
    if not path.is_file():
        return False
    stat = path.stat()
    if stat.st_size != expected_size:
        return False
    record = store.get_model_verification(verification_key) if store else None
    if record == {
        "expected_sha256": expected_sha256,
        "filename": path.name,
        "size_bytes": stat.st_size,
        "mtime_ns": stat.st_mtime_ns,
        "ctime_ns": stat.st_ctime_ns,
    }:
        return True
    try:
        verified = sha256_file(path) == expected_sha256
        stable_stat = path.stat()
    except OSError:
        verified = False
        stable_stat = None
    # Compare content identity (size + mtime + ctime), not the whole stat_result:
    # os.stat_result.__eq__ also compares st_atime, which the sha256_file read
    # above can bump on Windows/NTFS (lastaccess-enabled volumes), spuriously
    # failing "file unchanged during hash" and reporting a freshly-verified asset
    # as unverified. These are the same fields persisted as the verification
    # record's fingerprint above.
    unchanged = stable_stat is not None and stat_identity(stable_stat) == stat_identity(
        stat
    )
    if verified and unchanged and store:
        store.set_model_verification(
            asset_id=verification_key,
            expected_sha256=expected_sha256,
            filename=path.name,
            size_bytes=stable_stat.st_size,
            mtime_ns=stable_stat.st_mtime_ns,
            ctime_ns=stable_stat.st_ctime_ns,
        )
    return verified and unchanged


def evaluate_download_feasibility(
    missing_assets: tuple[MissingAssetSpace, ...], *, free_bytes: int | None
) -> DownloadEvaluation:
    """Evaluate cache-volume space; verified assets contribute no bytes."""
    if not missing_assets:
        return DownloadEvaluation(status="ready", required_free_bytes=0)
    subtotal = sum(asset.peak_bytes for asset in missing_assets)
    # Assets download one after another, so at most one transient expansion is
    # ever live; take the largest rather than summing them.
    temporary_expansion = max(
        asset.temporary_expansion_bytes for asset in missing_assets
    )
    reserve = max(2 * GIB, math.ceil(subtotal * 0.10))
    required = subtotal + temporary_expansion + reserve
    if free_bytes is None:
        return DownloadEvaluation(
            status="probe_unknown",
            required_free_bytes=required,
            reason_code="model_cache_space_probe_unknown",
            reason_text="Free space on the model-cache volume could not be determined.",
        )
    if free_bytes < required:
        return DownloadEvaluation(
            status="insufficient_disk",
            required_free_bytes=required,
            reason_code="insufficient_model_cache_space",
            reason_text=f"Model-cache volume requires {required} free bytes; {free_bytes} available.",
        )
    return DownloadEvaluation(status="ready", required_free_bytes=required)


def _has_trusted_intel_evidence(hardware: HardwareInfo) -> bool:
    return hardware.cpu_manufacturer.lower() in {"genuineintel", "intel"} or any(
        "VEN_8086" in device_id.upper() for device_id in hardware.gpu_pnp_device_ids
    )


def _supports_cloud_only_lite(hardware: HardwareInfo) -> bool:
    return (
        _has_trusted_intel_evidence(hardware)
        and hardware.total_ram_gb >= _LITE_MIN_RAM_GB
        and hardware.mem_speed_mts >= _LITE_MIN_MEM_SPEED_MTS
    )


def is_cloud_only_lite_hardware(
    hardware: HardwareInfo, bundle_registry: BundleRegistry, asset_registry: Registry
) -> bool:
    """The verdict `evaluate_primary_bundle_capability` reports as `cloud_only_product_profile_id="lite"`."""
    return not compute_supported_bundles(hardware, bundle_registry, asset_registry) and _supports_cloud_only_lite(
        hardware
    )


def compute_supported_bundles(
    hardware: HardwareInfo,
    bundle_registry: BundleRegistry,
    asset_registry: Registry,
) -> tuple[BundleEntry, ...]:
    """Return ranked Local Bundles only when all required evidence is known.

    A mocked Bundle (dev-only, ``local/mock_bundle.py``) is supported
    unconditionally: its chat weights never touch this box, so neither the
    Intel-evidence check nor the compute requirements describe anything that
    has to be true for it to serve. Every other Bundle is still judged on the
    real hardware, including in the same process.
    """
    trusted_hardware = _has_trusted_intel_evidence(hardware)
    if not trusted_hardware and not mock_bundle.is_armed():
        return ()
    return tuple(
        bundle
        for bundle in bundle_registry.ranked_local_bundles()
        if mock_bundle.mocks_bundle(bundle.bundle_id)
        or (
            trusted_hardware
            and _meets_compute_requirements(
                asset_registry.require(bundle.chat_model_id), hardware
            )
        )
    )


def _meets_compute_requirements(asset: ModelEntry, hardware: HardwareInfo) -> bool:
    requirements = asset.requirements or {}
    if hardware.total_ram_gb < int(requirements.get("min_ram_gb", 0)):
        return False
    if hardware.mem_speed_mts < int(requirements.get("min_mem_speed_mts", 0)):
        return False
    keywords = tuple(str(value).lower() for value in requirements.get("igpu_keywords", []))
    return not keywords or any(
        keyword in gpu.lower() for keyword in keywords for gpu in hardware.igpu_names
    )


def _candidate_revision(evaluations: tuple[SupportedBundleEvaluation, ...]) -> int:
    """Fingerprint the *capability facts* a client's switch request was built on.

    This is optimistic-concurrency control: a client reads the projection, then
    submits a switch carrying the revision it saw, and ``prepare`` rejects the
    request if the facts moved underneath it.

    Deliberately EXCLUDES ``cached_and_verified``. Whether an asset has been
    hashed yet is local cache *progress*, not a capability fact -- and including
    it made ``prepare`` self-defeating: the prepare handler re-inspects the
    assets, that inspection persists a verification record (unverified ->
    verified), the revision is recomputed, and the very request that triggered
    the hashing is then rejected with ``bundle_candidate_changed``. When model files
    outlive ``model_verifications``, hashing a 20 GB chat model takes ~15 s, so the
    FIRST launch failed deterministically while the second -- records now present --
    succeeded.

    Excluding it does not weaken integrity: the full sha256 still runs, and
    ``cached_and_verified`` is still what drives the connect-vs-download decision
    (``has_missing_assets`` in ``capability/api.py``, ``fully_cached_and_verified``
    in the UI). Only the concurrency token stops moving for it.
    """
    facts = [
        {
            "bundle": item.bundle.as_model_bundle(),
            "assets": [
                {
                    "id": asset.id,
                    "role": asset.role,
                    "source": asset.source,
                    "repo": asset.repo,
                    "revision": asset.revision,
                    "filename": asset.filename,
                    "sha256": asset.sha256,
                    "size_bytes": asset.size_bytes,
                }
                for asset in (item.chat, item.embedding)
            ],
        }
        for item in evaluations
    ]
    digest = hashlib.sha256(
        json.dumps(facts, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).digest()
    return int.from_bytes(digest[:6], "big")


def _display_asset(asset_registry: Registry, model_id: str, role: str) -> ModelEntry:
    """Return the trusted local asset if known, else a display-only stand-in.

    The trusted Edge Bundle's chat model (e.g. ``Qwen3-Coder-Next``) has no
    local asset entry because it is never downloaded; its embedding model
    happens to alias a real local asset (``KaLM-embedding-v2.5``), so this
    prefers the real entry when present for a more accurate display label.
    """
    known = asset_registry.get(model_id)
    if known is not None:
        return known
    return ModelEntry(
        id=model_id,
        name=model_id,
        role=role,
        source="edge",
        repo="",
        filename="",
        size_bytes=0,
        sha256=None,
        default_port=None,
        default_ctx=0,
        default_ngl=0,
        extra_args=[],
    )


def evaluate_edge_bundle(
    bundle_registry: BundleRegistry,
    asset_registry: Registry,
    edge_config_record: Mapping[str, object] | None,
    committed_edge_bundle_id: str | None = None,
) -> tuple[SupportedBundleEvaluation, ...]:
    """Return selected and still-committed trusted Edge Bundle evaluations.

    This is a local snapshot only — it never performs network I/O. Edge has
    no download semantics, so configured trusted assets are treated as cached;
    live model discovery and chat/embedding compatibility are validated later
    inside the async ``prepare_edge_bundle`` operation. A committed Edge Bundle
    remains eligible during a model-only switch so failed switches can recover.
    """
    if edge_config_record is None:
        return ()
    edge_bundles = bundle_registry.by_backend("edge")
    if not edge_bundles:
        return ()
    model_name = edge_config_record.get("model_name")
    selected_model = model_name if isinstance(model_name, str) and model_name else None
    edge_bundles = tuple(
        bundle
        for bundle in edge_bundles
        if bundle.chat_model_id == selected_model
        or bundle.bundle_id == committed_edge_bundle_id
    )
    if not edge_bundles:
        return ()
    cache_states = (
        AssetCacheState(cached_and_verified=True),
        AssetCacheState(cached_and_verified=True),
    )
    return tuple(
        SupportedBundleEvaluation(
            bundle=bundle,
            chat=_display_asset(asset_registry, bundle.chat_model_id, ROLE_CHAT),
            embedding=_display_asset(asset_registry, bundle.embedding_model_id, ROLE_EMBEDDING),
            cache_states=cache_states,
            download=DownloadEvaluation(status="ready", required_free_bytes=0),
        )
        for bundle in edge_bundles
    )


def evaluate_primary_bundle_capability(
    *,
    hardware: HardwareInfo,
    bundle_registry: BundleRegistry,
    asset_registry: Registry,
    cache_states: Mapping[str, AssetCacheState],
    free_bytes: int | None,
    edge_config_record: Mapping[str, object] | None = None,
    committed_edge_bundle_id: str | None = None,
) -> PrimaryBundleEvaluation:
    """Return compute-supported Bundles independently from disk feasibility.

    Edge participation (``edge_config_record``) is strictly additive: it is
    appended to ``supported_bundles``/``supported_bundle_ids`` but never
    contributes to ``hardware_capability_ceiling``/``recommended_bundle_id``,
    which are derived only from the local (``backend == "llama"``) evidence.
    """
    reasons: list[str] = []
    edge_evaluations = evaluate_edge_bundle(
        bundle_registry,
        asset_registry,
        edge_config_record,
        committed_edge_bundle_id,
    )

    # NOTE: do NOT add a "the Bundle is mocked" marker to ``reasons``.
    # ServiceHub's LRM adapter validates this field against a closed allow-list
    # (``adapters/lrm_bundle_client._ALLOWED_REASON_CODES``) and rejects the
    # WHOLE capability read as ``semantic_invalid`` on an unknown code — which
    # silently disables Primary Bundle switching. The mock announces itself with
    # a WARNING at startup instead; that costs nothing and breaks nothing.
    if not _has_trusted_intel_evidence(hardware) and not mock_bundle.is_armed():
        reasons.append(
            "hardware_evidence_unknown"
            if not hardware.cpu_manufacturer and not hardware.gpu_pnp_device_ids
            else "unsupported_local_hardware"
        )
        if not edge_evaluations:
            return PrimaryBundleEvaluation(0, None, (), None, (), tuple(reasons))
        return PrimaryBundleEvaluation(
            model_candidate_revision=0,
            hardware_capability_ceiling=None,
            supported_bundle_ids=tuple(item.bundle.bundle_id for item in edge_evaluations),
            recommended_bundle_id=None,
            supported_bundles=edge_evaluations,
            reasons=tuple(reasons),
        )

    supported: list[SupportedBundleEvaluation] = []
    local_bundles = compute_supported_bundles(hardware, bundle_registry, asset_registry)
    for bundle in local_bundles:
        chat = asset_registry.require(bundle.chat_model_id)
        embedding = asset_registry.require(bundle.embedding_model_id)
        states = (
            cache_states.get(chat.id, AssetCacheState.missing(chat)),
            cache_states.get(embedding.id, AssetCacheState.missing(embedding)),
        )
        missing_assets = tuple(
            MissingAssetSpace(
                download_bytes=state.missing_bytes,
                installed_bytes=state.missing_bytes,
                # GGUF downloads are final files; no archive expansion occurs.
                temporary_expansion_bytes=0,
            )
            for state in states
            if state.missing_bytes
        )
        supported.append(
            SupportedBundleEvaluation(
                bundle=bundle,
                chat=chat,
                embedding=embedding,
                cache_states=states,
                download=evaluate_download_feasibility(
                    missing_assets, free_bytes=free_bytes
                ),
            )
        )

    evaluations = tuple(supported)
    if not evaluations:
        if _supports_cloud_only_lite(hardware):
            return PrimaryBundleEvaluation(
                model_candidate_revision=0,
                hardware_capability_ceiling=None,
                supported_bundle_ids=tuple(
                    item.bundle.bundle_id for item in edge_evaluations
                ),
                recommended_bundle_id=None,
                supported_bundles=edge_evaluations,
                reasons=(),
                cloud_only_product_profile_id="lite",
            )
        reasons.append("no_compute_compatible_local_bundle")
        if not edge_evaluations:
            return PrimaryBundleEvaluation(0, None, (), None, (), tuple(reasons))
        return PrimaryBundleEvaluation(
            model_candidate_revision=0,
            hardware_capability_ceiling=None,
            supported_bundle_ids=tuple(item.bundle.bundle_id for item in edge_evaluations),
            recommended_bundle_id=None,
            supported_bundles=edge_evaluations,
            reasons=tuple(reasons),
        )
    recommended = evaluations[0].bundle
    all_supported = evaluations + edge_evaluations
    return PrimaryBundleEvaluation(
        model_candidate_revision=_candidate_revision(evaluations),
        hardware_capability_ceiling=(
            recommended.bundle_id,
            recommended.capability_grade,
        ),
        supported_bundle_ids=tuple(item.bundle.bundle_id for item in all_supported),
        recommended_bundle_id=recommended.bundle_id,
        supported_bundles=all_supported,
        reasons=(),
    )
