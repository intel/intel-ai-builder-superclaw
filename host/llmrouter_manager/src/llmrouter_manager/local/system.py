"""Pure helpers for the LRM system namespace endpoints.

Read-only, live. Hardware comes from LRM's own lazy WMI probe, cached on
``app.state`` on first access (see :mod:`llmrouter_manager.local.deps`).
These helpers return conservative, stable shapes covering only LRM-owned
resources: hardware capabilities, local-LLM eligibility, and the LLM slice
of preflight.

The preflight covers model selections, the model registry, on-disk model files
and configured inference ports. Sandbox readiness is owned by sandbox_manager.
"""

from __future__ import annotations

from typing import Any

from loguru import logger

from ..common.store import Store
from ..routing.policy.gates import available_memory_gb
from . import mock_bundle
from .deps import get_eligibility, get_hardware, get_selected_chat_model
from .hardware import HardwareInfo, probe_disk_free_bytes
from .models import model_dir
from .policy import available_chat_tiers, select_chat_model, targets_discrete_gpu
from .registry import ROLE_CHAT, Registry


# Free-RAM headroom over raw weight size to actually *load* a GGUF model: the
# declared ``size_bytes`` is only the quantized weights; the KV cache + llama
# runtime overhead need extra. On Intel AIPC (UMA — the iGPU has no dedicated
# VRAM and allocates from system RAM), this is the real "can it run" ceiling,
# so a model-scoped RAM requirement is the sole memory gate. 1.2 is the
# "close-fit" factor the product picked (2026-07-22); bump toward 1.5 if
# OOM/CPU-fallback is observed.
MODEL_MEMORY_MULTIPLIER = 1.2


def model_load_fits(
    available_gb: float,
    model_bytes: int,
    *,
    already_resident: bool,
    reclaimable_bytes: int = 0,
) -> tuple[bool, float]:
    """Pure model-load-headroom judgement, shared by the preflight endpoint
    (``_model_memory_check``) and the boot-resume gate (``resume_local_if_ready``).

    Returns ``(fits, required_gb)`` where ``required_gb = model_bytes ×
    MODEL_MEMORY_MULTIPLIER``. ``fits`` is whether enough RAM is available to
    *load* the model: ``available_gb + credit >= required_gb``. When
    ``already_resident`` the bundle's own footprint is credited back (the RAM it
    needs is already held by its running llama-server — issue #1528), so a
    resident model always fits; first launch (not resident) has no credit, so
    ``available_gb >= required_gb`` — unchanged behaviour. During a local model
    switch, ``reclaimable_bytes`` is the old worker's verified weight footprint;
    replacement terminates that worker before launching the target.

    This is the sole memory gate; it answers only the model-scoped load
    question.
    """
    required_gb = (model_bytes / (1024 ** 3)) * MODEL_MEMORY_MULTIPLIER
    credit_gb = (
        required_gb
        if already_resident
        else max(0, reclaimable_bytes) / (1024 ** 3)
    )
    return (available_gb + credit_gb >= required_gb, required_gb)


async def get_hardware_info(app_state: Any) -> dict[str, Any]:
    """Shape for GET /llm-router/v1/system/hardware.

    Reports the probed hardware plus the hardware-selected chat model id.
    ``select_chat_model`` always yields *some* model (falling back to the
    lowest tier), so ``selected_chat_model_id`` is populated even on a host
    the probe could not read. ``detected`` is ``False`` only when the probe
    itself failed (``detection_errors`` populated).
    """
    hw = await get_hardware(app_state)
    selected = await get_selected_chat_model(app_state)
    return {
        "detected": not hw.detection_errors,
        "hardware": hw.to_dict(),
        "selected_chat_model_id": selected.id,
    }


async def get_hardware_eligibility(app_state: Any) -> dict[str, Any]:
    """Shape for GET /llm-router/v1/system/hardware-eligibility.

    The strict local-LLM gate verdict
    (:func:`llmrouter_manager.local.eligibility.evaluate_local_llm_eligibility`)
    over the probed hardware. ``eligible=False`` on hosts that match no
    non-fallback chat model's ``requirements`` block.
    """
    result = await get_eligibility(app_state)
    return result.to_dict()


async def get_tier_selection(app_state: Any, store: Store) -> dict[str, Any]:
    """Shape for the ``available_tiers`` + ``selected_tier`` fields of /status.

    ``available_tiers`` is the hardware-gated chat-tier menu
    (:func:`llmrouter_manager.local.policy.available_chat_tiers`): the chat
    entries this box can actually run, most-demanding first, each reduced to
    ``{id, name}`` for the picker. It is **empty** on an ineligible host.

    ``selected_tier`` is the user's persisted chat choice
    (``active_chat_model_id``), defaulting to :func:`select_chat_model`'s
    verdict (the biggest eligible tier) when unset - matching the §3.5 default.
    On an ineligible host the default is still populated (``select_chat_model``
    falls back to the lowest tier) even though ``available_tiers`` is empty; the
    UI hides the picker there and offers edge only, so the two never disagree
    on an *eligible* host.
    """
    hw = await get_hardware(app_state)
    registry = app_state.registry
    tiers = available_chat_tiers(registry, hw)
    selected = store.get_config("active_chat_model_id") or select_chat_model(
        registry, hw
    ).id
    return {
        "available_tiers": [{"id": m.id, "name": m.name} for m in tiers],
        "selected_tier": selected,
    }


def _intended_local_bundle_id(app_state: Any) -> str | None:
    """Return the ``bundle_id`` of the committed **or** pending primary bundle
    whose backend is ``llama``, else ``None``.

    This is the intent signal the startup gate needs: "will this box load a
    model locally, and which bundle?" *before* the model is downloaded or the
    llama-server is up. Committed is preferred over pending (the committed one
    is what a boot resume brings up). It deliberately keys off intent
    (committed/pending), NOT readiness (``resolve_active_provider`` only reports
    ``llamacpp`` once the server is up — too late for a preflight gate), and NOT
    the ``local_provider`` user-selection KV (an auto-committed first-launch
    llama bundle never writes it).

    Edge bundles → ``None`` (model runs remotely, host RAM/disk never gate).
    No committed/pending bundle yet (earliest boot window) → ``None``.
    """
    store = getattr(app_state, "store", None)
    if store is None:
        return None
    try:
        lifecycle = store.get_bundle_lifecycle()
    except Exception:  # noqa: BLE001
        return None
    for key in ("primary_bundle", "pending_bundle"):
        bundle = lifecycle.get(key)
        if isinstance(bundle, dict) and bundle.get("backend") == "llama":
            bundle_id = bundle.get("bundle_id")
            if isinstance(bundle_id, str) and bundle_id:
                return bundle_id
    return None


def _local_bundle_intended(app_state: Any) -> bool:
    """True when a committed/pending local llama bundle exists — see
    :func:`_intended_local_bundle_id`."""
    return _intended_local_bundle_id(app_state) is not None


class UnknownBundleError(ValueError):
    """Raised when a preflight Bundle or one of its trusted assets is unknown."""


class _BundleSizing:
    """Resource sizing for a specific bundle, for the bundle-scoped preflight.

    ``ram_bytes`` = total declared weights (chat + embedding), sized regardless
    of cache state — the model must be loaded into system RAM every launch on
    UMA/shared-memory hardware. Dedicated-GPU bundles disable that generic
    system-RAM load gate because their primary allocation is in board VRAM.
    ``disk_required_bytes`` = the feasibility ``required_free_bytes`` over the
    **not-yet-cached** assets only (includes the download reserve), so a bundle
    already on disk needs 0 and its disk_free check skips.
    ``local`` is False for an edge bundle (model runs remotely — no local
    load/download).
    ``chat_model_id`` / ``embedding_model_id`` are the bundle's role model ids
    (empty for an edge bundle) — used by :func:`_bundle_already_resident` to
    decide whether the model_memory load-headroom check can be skipped because
    the very model being sized is already resident and ready.
    ``system_ram_gate`` is False for a dedicated-GPU bundle.
    """

    __slots__ = (
        "ram_bytes",
        "disk_required_bytes",
        "local",
        "chat_model_id",
        "embedding_model_id",
        "system_ram_gate",
    )

    def __init__(
        self,
        ram_bytes: int,
        disk_required_bytes: int,
        local: bool,
        chat_model_id: str = "",
        embedding_model_id: str = "",
        system_ram_gate: bool = True,
    ) -> None:
        self.ram_bytes = ram_bytes
        self.disk_required_bytes = disk_required_bytes
        self.local = local
        self.chat_model_id = chat_model_id
        self.embedding_model_id = embedding_model_id
        self.system_ram_gate = system_ram_gate


def _size_bundle(
    app_state: Any,
    bundle_id: str,
    *,
    hardware: HardwareInfo | None = None,
) -> _BundleSizing:
    """Resolve ``bundle_id`` → RAM/disk sizing, reusing the capability layer's
    bundle registry + asset cache inspection so the disk figure matches the
    ``/capability/primary-bundle`` verdict (same reserve).

    Raises :class:`UnknownBundleError` for an unknown Bundle or trusted asset.
    An ``edge`` bundle returns ``local=False`` (skips model_memory/disk_free).
    """
    from ..capability.bundle_capability import (
        MissingAssetSpace,
        evaluate_download_feasibility,
        inspect_asset_cache,
    )
    from ..capability.bundle_registry import (
        BundleRegistryError,
        load_bundle_registry,
    )
    from .registry import RegistryError, load_builtin_registry

    bundles = load_bundle_registry()
    try:
        bundle = bundles.require(bundle_id)
    except BundleRegistryError as exc:
        raise UnknownBundleError(str(exc)) from exc

    if bundle.backend != "llama":
        # Edge bundle: model runs remotely, nothing loads/downloads locally.
        return _BundleSizing(ram_bytes=0, disk_required_bytes=0, local=False)

    assets = load_builtin_registry()
    try:
        chat = assets.require(bundle.chat_model_id)
        embedding = assets.require(bundle.embedding_model_id)
    except RegistryError as exc:
        raise UnknownBundleError(str(exc)) from exc

    models_dir = app_state.local_config.models_dir
    store = app_state.store
    # Speculative decoding loads the draft alongside its model, so an asset's
    # RAM footprint is every byte it installs, not just the main GGUF.
    # A mocked chat asset (dev-only) contributes ZERO: its weights live at a
    # remote endpoint and are never loaded into this host's RAM, so reserving
    # load headroom for them blocks the startup gate on memory that will never
    # be used. Observed live: the 27B stand-in's declared 16 GiB x the 1.2
    # multiplier demanded 19.8 GB against 19.5 GB free and refused to start.
    # Disk needs no equivalent guard -- inspect_asset_cache already reports the
    # mocked asset as cached, so it contributes 0 to the download reserve.
    ram_bytes = embedding.total_size_bytes
    if not mock_bundle.mocks_chat_asset(chat.id):
        ram_bytes += chat.total_size_bytes
    system_ram_gate = not targets_discrete_gpu(chat, hardware)

    # Disk: only assets not already cached-and-verified contribute; reuse the
    # capability feasibility evaluator so the reserve matches the download flow.
    missing: list[MissingAssetSpace] = []
    for asset in (chat, embedding):
        state = inspect_asset_cache(models_dir, asset, store, verify_hash=False)
        if state.missing_bytes:
            missing.append(
                MissingAssetSpace(
                    download_bytes=state.missing_bytes,
                    installed_bytes=state.missing_bytes,
                )
            )
    feasibility = evaluate_download_feasibility(tuple(missing), free_bytes=None)
    return _BundleSizing(
        ram_bytes=ram_bytes,
        disk_required_bytes=feasibility.required_free_bytes,
        local=True,
        chat_model_id=bundle.chat_model_id,
        embedding_model_id=bundle.embedding_model_id,
        system_ram_gate=system_ram_gate,
    )


# Supervisor role states that mean the bundle's llama-server is already holding
# (or actively taking) the model's RAM, so re-requiring full load headroom for
# the *same* bundle is a false block (issue #1528):
#   * "ready"    — weights fully loaded and serving.
#   * "starting" — process already spawned and mmap-ing/allocating the weights.
#                  On the boot-resume path LRM auto-starts the committed bundle,
#                  so the frontend's init-stage preflight routinely lands here a
#                  few seconds in, with free RAM already dropping as the load
#                  ramps. The model_id is assigned in _compute_launch_plan before
#                  the state flips to "starting", so it is trustworthy here.
_RESIDENT_ROLE_STATES = frozenset({"ready", "starting"})


def _bundle_already_resident(app_state: Any, sizing: "_BundleSizing") -> bool:
    """True when the sized bundle's model is *already loaded or loading* right now.

    Reads the two role-facade supervisors on ``app_state.supervisor`` (keyed
    ``chat`` / ``embedding`` — see :mod:`llmrouter_manager.local.deps`). Each
    facade's ``snapshot()`` returns ``{state, model_id, ...}``
    (:meth:`RouterSupervisor.role_snapshot`). Returns ``True`` only when *both*
    roles report a state in :data:`_RESIDENT_ROLE_STATES` (``ready`` or
    ``starting``) **and** their ``model_id`` matches the bundle's
    ``chat_model_id`` / ``embedding_model_id``.

    This is the signal the bundle-scoped preflight uses to skip the
    ``model_memory`` load-headroom check on a reinstall/reopen: the previously
    loaded llama-server is still resident and is itself holding the RAM, so
    requiring another full bundle-sized amount of free RAM to load a model that
    is *already loaded* — or whose process is *already loading it right now* —
    is a false block (issue #1528). ``starting`` matters because the boot-resume
    path auto-starts the committed bundle, so the frontend startup gate fires
    mid-load, while the in-flight load has already begun consuming the RAM the
    check would demand be free.

    Fail-safe: any missing supervisor / attribute / unexpected shape → ``False``
    so we keep the full check. We never *skip* the check unless residency is
    provably true — a bad probe can only make the gate stricter, never wrongly
    pass a real shortfall.
    """
    if not sizing.local or not sizing.chat_model_id or not sizing.embedding_model_id:
        return False
    try:
        supervisors = app_state.supervisor
        wanted = {
            "chat": sizing.chat_model_id,
            "embedding": sizing.embedding_model_id,
        }
        for role, model_id in wanted.items():
            facade = supervisors[role]
            snap = facade.snapshot()
            if (
                snap.get("state") not in _RESIDENT_ROLE_STATES
                or snap.get("model_id") != model_id
            ):
                return False
        return True
    except Exception:  # noqa: BLE001
        return False


def _reclaimable_resident_bytes(app_state: Any, sizing: "_BundleSizing") -> int:
    """Return the verified weight footprint released by a local model switch.

    The shared worker replacement path terminates the old process before
    launching the target. Credit only a fully ready, different two-role plan
    whose model IDs resolve in the loaded registry. A starting or partial plan
    is too uncertain to credit.
    """
    if not sizing.local:
        return 0
    try:
        snapshots = {
            role: app_state.supervisor[role].snapshot()
            for role in ("chat", "embedding")
        }
        if any(snap.get("state") != "ready" for snap in snapshots.values()):
            return 0
        chat_model_id = snapshots["chat"].get("model_id")
        embedding_model_id = snapshots["embedding"].get("model_id")
        if not isinstance(chat_model_id, str) or not chat_model_id:
            return 0
        if not isinstance(embedding_model_id, str) or not embedding_model_id:
            return 0
        resident_ids = (chat_model_id, embedding_model_id)
        if resident_ids == (sizing.chat_model_id, sizing.embedding_model_id):
            return 0
        registry: Registry = app_state.registry
        entries = [registry.models[model_id] for model_id in resident_ids]
        if entries[0].role != "chat" or entries[1].role != "embedding":
            return 0
        return sum(entry.total_size_bytes for entry in entries)
    except Exception:  # noqa: BLE001
        return 0


def _selected_model_ids(store: Store, registry: Registry) -> list[str]:
    """Active chat + embedding selections that exist in the registry, or the
    full registry when nothing is selected (fresh install, pre-provision).

    Mirrors the scoping the model_files check uses so the resource checks
    (memory / disk) size themselves against the models this host will actually
    run, not against tiers it is not eligible for and will never download.
    """
    active_chat = store.get_config("active_chat_model_id")
    active_embedding = store.get_config("active_embedding_model_id")
    selected = [mid for mid in (active_chat, active_embedding) if mid]
    scoped = [mid for mid in selected if mid in registry.models]
    if scoped:
        return scoped
    return list(registry.models.keys())


def _disk_check(
    free_bytes: int | None, required_bytes: int, local_server_active: bool
) -> dict[str, Any]:
    """The disk_free preflight check.

    ``local_server_active`` is False (edge / local not configured) => the host
    downloads no GGUF => skipped/info. ``free_bytes is None`` =>
    ``shutil.disk_usage`` could not read the cache volume => skipped/info.
    ``required_bytes <= 0`` => nothing to size against (empty registry /
    unknown model sizes) => skipped/info. Below the requirement => fail/error,
    which blocks ``ready``.
    """
    if not local_server_active:
        return {
            "name": "disk_free",
            "state": "skipped",
            "severity": "info",
            "message": "local llama-server not selected; no model download needed",
        }
    if required_bytes <= 0:
        return {
            "name": "disk_free",
            "state": "skipped",
            "severity": "info",
            "message": "no model size to size against",
        }
    if free_bytes is None:
        return {
            "name": "disk_free",
            "state": "skipped",
            "severity": "info",
            "message": "free disk unmeasurable on this host",
        }
    if free_bytes < required_bytes:
        return {
            "name": "disk_free",
            "state": "fail",
            "severity": "error",
            "free_gb": round(free_bytes / (1024 ** 3), 1),
            "required_gb": round(required_bytes / (1024 ** 3), 1),
            "message": (
                f"insufficient free disk: {free_bytes / (1024 ** 3):.1f} GB free, "
                f"{required_bytes / (1024 ** 3):.1f} GB required for model download"
            ),
        }
    return {
        "name": "disk_free",
        "state": "pass",
        "severity": "info",
        "message": (
            f"{free_bytes / (1024 ** 3):.1f} GB free "
            f"(need {required_bytes / (1024 ** 3):.1f} GB)"
        ),
    }


def _model_memory_check(
    available_gb: float | None,
    model_bytes: int,
    local_server_active: bool,
    *,
    already_resident: bool = False,
    reclaimable_bytes: int = 0,
    system_ram_gate: bool = True,
) -> dict[str, Any]:
    """The model_memory preflight check: is free RAM enough to *load* the
    selected model(s)?

    The sole memory gate. The requirement scales with the scoped models'
    declared ``size_bytes`` ×
    :data:`MODEL_MEMORY_MULTIPLIER` (weights + KV cache + runtime overhead). On
    Intel AIPC / UMA the model loads into system RAM, so this is the real
    "can it run locally" gate. Dedicated-GPU bundles leave this generic gate
    disabled because the primary allocation is in board VRAM; their hardware
    eligibility and launch profile still apply.

    ``local_server_active`` is False (edge / local not configured) => nothing
    loads locally => skipped/info. ``model_bytes <= 0`` (no selection / unknown
    sizes) => skipped/info. ``available_gb is None`` (unmeasurable) =>
    skipped/info, never a false block. ``system_ram_gate`` False =>
    skipped/info because this model is sized for dedicated GPU execution.

    ``already_resident`` (the very bundle being sized is already loaded or
    loading — see :func:`_bundle_already_resident`) credits the bundle's own
    requirement back into the budget: the RAM this model needs is already held
    by its running llama-server, so ``effective_available = available_gb +
    required_gb``. This makes the check **pass** (not skip) on a
    reinstall/reopen, fixing the #1528 self-block where preflight demanded
    another full bundle-sized amount of free RAM to load a model that is already
    loaded. During a local model switch, ``reclaimable_bytes`` credits the
    verified weight footprint of the ready worker that replacement terminates
    before launching the target. First launch (not resident) => no credit =>
    the check is unchanged.

    Below the (credited) requirement => fail/error, which flips ``ready``.
    """
    if not local_server_active:
        return {
            "name": "model_memory",
            "state": "skipped",
            "severity": "info",
            "message": "local llama-server not selected; model runs remotely",
        }
    if not system_ram_gate:
        return {
            "name": "model_memory",
            "state": "skipped",
            "severity": "info",
            "message": (
                "dedicated-GPU model selected; generic system-RAM load gate "
                "does not apply"
            ),
        }
    if model_bytes <= 0:
        return {
            "name": "model_memory",
            "state": "skipped",
            "severity": "info",
            "message": "no selected model size to size against",
        }
    if available_gb is None:
        return {
            "name": "model_memory",
            "state": "skipped",
            "severity": "info",
            "message": "free RAM unmeasurable on this host",
        }
    # Shared judgement: credits the bundle's own footprint back when resident
    # (issue #1528), no credit on first launch. Same function the boot-resume
    # gate uses, so both agree.
    fits, required_gb = model_load_fits(
        available_gb,
        model_bytes,
        already_resident=already_resident,
        reclaimable_bytes=reclaimable_bytes,
    )
    reclaimable_gb = max(0, reclaimable_bytes) / (1024 ** 3)
    if not fits:
        return {
            "name": "model_memory",
            "state": "fail",
            "severity": "error",
            "free_gb": round(available_gb, 1),
            "required_gb": round(required_gb, 1),
            "message": (
                f"insufficient free RAM to load selected model(s): "
                f"{available_gb:.1f} GB available"
                + (
                    f" + {reclaimable_gb:.1f} GB reclaimable from resident model"
                    if reclaimable_gb > 0
                    else ""
                )
                + f", {required_gb:.1f} GB required"
            ),
        }
    if already_resident:
        return {
            "name": "model_memory",
            "state": "pass",
            "severity": "info",
            "message": (
                f"{available_gb:.1f} GB free + {required_gb:.1f} GB already held "
                f"by the resident model >= {required_gb:.1f} GB needed"
            ),
        }
    if reclaimable_gb > 0:
        return {
            "name": "model_memory",
            "state": "pass",
            "severity": "info",
            "message": (
                f"{available_gb:.1f} GB free + {reclaimable_gb:.1f} GB reclaimable "
                f"from resident model >= {required_gb:.1f} GB needed"
            ),
        }
    return {
        "name": "model_memory",
        "state": "pass",
        "severity": "info",
        "message": (
            f"{available_gb:.1f} GB free "
            f"(need {required_gb:.1f} GB to load selected model(s))"
        ),
    }


def build_resource_checks(
    store: Store,
    registry: Registry,
    *,
    available_gb: float | None,
    disk_free_bytes: int | None,
    local_server_active: bool,
    hardware: HardwareInfo | None = None,
) -> list[dict[str, Any]]:
    """Pure builder for the current-remaining-resource preflight checks.

    Separated from the probes so tests can drive every branch deterministically
    without ctypes / WMI / a real filesystem. ``required_bytes`` is the sum of
    the scoped models' declared ``size_bytes`` — the disk needed to download
    the models this host will actually run, and (× ``MODEL_MEMORY_MULTIPLIER``)
    the RAM needed to load them.

    ``model_memory`` and ``disk_free`` gate a *local* llama-server, so they only
    apply when ``local_server_active`` is True. Callers derive that from
    :func:`_local_bundle_intended` — the *intent* to run local (a committed OR
    pending llama bundle), so the gate fires before the model is downloaded or
    the server is up. NOT the ready-only ``active_provider``, and NOT the raw
    ``local_provider`` user-selection KV (an auto-committed first-launch llama
    bundle never writes it). On edge (model runs remotely) or when no local
    bundle is committed/pending, both are ``skipped/info`` so an edge user is
    never blocked by host resource limits. For a selected chat model that
    targets a detected dedicated GPU, ``model_memory`` is skipped because the
    generic system-RAM load estimate does not describe that launch path. If
    hardware is unavailable or has detection errors, the system-RAM gate stays
    enabled. Memory is otherwise governed solely by ``model_memory`` (weights
    x1.2, resident-credited) — there is no separate fixed anti-thrash floor
    check.
    """
    # A mocked chat asset is excluded for the same reason as in _size_bundle:
    # nothing is downloaded or loaded locally for it.
    selected_ids = _selected_model_ids(store, registry)
    required_bytes = sum(
        registry.models[mid].size_bytes
        for mid in selected_ids
        if mid in registry.models and not mock_bundle.mocks_chat_asset(mid)
    )
    active_chat_id = store.get_config("active_chat_model_id")
    active_chat = registry.models.get(active_chat_id) if active_chat_id else None
    system_ram_gate = not (
        active_chat is not None
        and active_chat.role == ROLE_CHAT
        and targets_discrete_gpu(active_chat, hardware)
    )
    return [
        _model_memory_check(
            available_gb,
            required_bytes,
            local_server_active,
            system_ram_gate=system_ram_gate,
        ),
        _disk_check(disk_free_bytes, required_bytes, local_server_active),
    ]


def _log_bundle_preflight(
    bundle_id: str,
    sizing: "_BundleSizing",
    available_gb: float | None,
    disk_free_bytes: int | None,
    checks: list[dict[str, Any]],
    resident: bool = False,
    reclaimable_bytes: int = 0,
) -> None:
    """Emit one log line for a bundle-scoped ``/system/preflight`` request.

    Called from :func:`get_preflight_info` only when a ``bundle_id`` is given
    (i.e. the frontend startup gate between ``/capability/primary-bundle`` and
    the switch). This is the single authoritative resource line in the LRM log:
    it reflects the exact bundle the frontend is about to switch to, and its
    numbers are the same the endpoint returns. WARNING when a check is a
    blocking ``error`` (resource short), else INFO. Best-effort — a logging
    failure never affects the endpoint response.

    An ``edge`` bundle (``sizing.local`` False) → ``edge[<base_url>]`` with
    ``n/a`` model figures (model runs remotely).
    """
    try:
        if sizing.local:
            provider = f"llamacpp[{bundle_id}]"
            if not sizing.system_ram_gate:
                mem_need_repr = "n/a (dedicated GPU)"
            elif resident:
                # Model already loaded/loading — model_memory credits the
                # bundle's own footprint back into the budget and passes, so the
                # need is met by the resident model rather than freshly free RAM.
                mem_need_repr = "n/a (loaded)"
            else:
                weights_gb = sizing.ram_bytes / (1024 ** 3)
                mem_need_repr = f"{weights_gb * MODEL_MEMORY_MULTIPLIER:.1f}GB"
            disk_need_repr = (
                f"{sizing.disk_required_bytes / (1024 ** 3):.1f}GB"
                if sizing.disk_required_bytes > 0
                else "n/a (cached)"
            )
        else:
            provider = f"edge[{bundle_id}]"
            mem_need_repr = "n/a"
            disk_need_repr = "n/a"

        free_mem_repr = f"{available_gb:.1f}GB" if available_gb is not None else "unknown"
        reclaimable_repr = f"{reclaimable_bytes / (1024 ** 3):.1f}GB"
        free_disk_repr = (
            f"{disk_free_bytes / (1024 ** 3):.1f}GB"
            if disk_free_bytes is not None
            else "unknown"
        )
        blocking = any(
            c["state"] == "fail" and c["severity"] == "error" for c in checks
        )
        log = logger.warning if blocking else logger.info
        log(
            "resource preflight: provider={} mem free={} reclaimable={} "
            "model_need={} disk free={} need={} -> {}",
            provider,
            free_mem_repr,
            reclaimable_repr,
            mem_need_repr,
            free_disk_repr,
            disk_need_repr,
            "SHORT" if blocking else "ok",
        )
    except Exception:  # noqa: BLE001
        logger.opt(exception=True).warning(
            "resource preflight log failed — endpoint response unaffected"
        )


async def get_preflight_info(
    store: Store, app_state: Any, *, bundle_id: str | None = None
) -> dict[str, Any]:
    """Shape for GET /llm-router/v1/system/preflight.

    Checks only LRM-owned resources: model selections, the model registry,
    on-disk model files, configured inference ports, and — added for the
    frontend startup gate — the host's *current remaining* free RAM and free
    disk. Sandbox readiness belongs to sandbox_manager.

    Resource-shortfall checks (``model_memory`` / ``disk_free``) are
    ``severity=error`` when they fail, so a host that cannot load the model or
    download it flips ``ready`` to ``False`` and the frontend blocks startup.

    ``model_memory`` + ``disk_free`` are sized two ways:

    * **``bundle_id`` given** (the frontend startup gate, called between
      ``/capability/primary-bundle`` and the switch): size against that specific
      bundle. ``model_memory`` uses the bundle's total chat+embedding weights ×
      1.2 for UMA/shared-memory models; dedicated-GPU bundles skip that generic
      system-RAM gate. ``disk_free`` uses the download feasibility over the
      bundle's **not-yet-cached** assets only (reserve included), so a bundle
      already on disk needs 0 and its disk check skips — matching "no
      re-download on later launches". An ``edge`` bundle skips both (remote
      model). An unknown Bundle or trusted asset raises
      :class:`UnknownBundleError` (the route maps it to ``404 unknown_bundle``).
    * **no ``bundle_id``** (legacy / ``/status``): size against the active
      chat+embedding selection, gated by :func:`_local_bundle_intended`.

    The response also carries a static ``hardware`` summary (total RAM, GPU,
    CPU) from the cached WMI probe so a single call answers both "what is this
    box" and "can it run right now".

    ``registry`` is the already-loaded, already-validated registry from
    ``app.state`` (built once at startup by ``build_default_local_deps``), so
    this helper never re-reads or re-validates it off disk.

    Missing model files are reported as an informational ``warn`` (and listed
    in ``missing_resources``) rather than a blocking ``error``: a fresh install
    has no GGUF on disk yet, and the download/provision flow is what fetches
    them, so a not-yet-downloaded model must not flip ``ready`` to ``False``.

    The model-files check is scoped to the active chat + embedding selections
    (seeded from eligibility by the provision flow) so a model the host is not
    eligible for — and will never download — does not surface as a missing
    resource. Before any selection exists it falls back to the full registry.
    """
    registry: Registry = app_state.registry
    checks: list[dict[str, Any]] = []
    missing_resources: list[dict[str, Any]] = []

    def _check(
        name: str, state: str, severity: str, message: str | None = None
    ) -> None:
        entry: dict[str, Any] = {"name": name, "state": state, "severity": severity}
        if message:
            entry["message"] = message
        checks.append(entry)

    # 1. Model selections — informational; missing is not a blocking error yet.
    active_chat = store.get_config("active_chat_model_id")
    active_embedding = store.get_config("active_embedding_model_id")
    if active_chat is None and active_embedding is None:
        _check(
            "model_selections",
            "skipped",
            "info",
            "no active model selections configured",
        )
    else:
        _check("model_selections", "pass", "info")

    # 2. Registry — built + validated at startup; report the model count.
    _check(
        "registry",
        "pass",
        "info",
        f"{len(registry.models)} model(s) in registry",
    )

    # 3. Model files — the GGUF for each host-relevant model under the nested
    #    download layout models/<id>/<filename>. "Host-relevant" is the active
    #    chat + embedding selection (seeded from eligibility by the provision
    #    flow): a model the host is not eligible for is never downloaded, so it
    #    must not surface as a missing resource. Before any selection exists
    #    (fresh install, pre-provision) fall back to the whole registry so the
    #    check does not falsely report "all present" with nothing on disk.
    #    Missing => informational (will download), never a hard error, so
    #    ``ready`` survives a fresh install.
    mdir = model_dir()
    selected_ids = [mid for mid in (active_chat, active_embedding) if mid]
    if selected_ids:
        scoped = [registry.models[mid] for mid in selected_ids if mid in registry.models]
    else:
        scoped = list(registry.models.values())
    missing: list[str] = []
    for entry in scoped:
        # A mocked chat asset has no file on disk by design — a remote endpoint
        # stands in for it. Reporting it "not downloaded" is a warning nobody
        # can act on, and it points at a repo/digest that are placeholders.
        if mock_bundle.mocks_chat_asset(entry.id):
            continue
        if not (mdir / entry.id / entry.filename).is_file():
            missing.append(entry.id)
            missing_resources.append(
                {"type": "model_file", "id": entry.id, "name": entry.filename}
            )
    if missing:
        _check("model_files", "fail", "warn", f"not downloaded: {', '.join(missing)}")
    else:
        _check("model_files", "pass", "info")

    # 4. Ports — inference ports declared in the registry (no live probing).
    ports = sorted(
        {e.default_port for e in registry.models.values() if e.default_port is not None}
    )
    if ports:
        _check(
            "ports",
            "pass",
            "info",
            f"configured inference ports: {', '.join(str(p) for p in ports)}",
        )
    else:
        _check("ports", "skipped", "info", "no port configuration in registry")

    # 5. Current remaining resources — the frontend startup gate. Probe hardware,
    #    free RAM (ctypes on Windows, fail-soft) and free disk on the cache
    #    volume, then
    #    size them against the model requirements.
    #    - bundle_id given: size against that specific bundle (RAM = total
    #      weights x1.2; disk = feasibility over not-yet-cached assets). Unknown
    #      bundle raises UnknownBundleError (route → 404). edge bundle → skip.
    #    - no bundle_id: legacy scoping against the active selection, gated by
    #      _local_bundle_intended (committed OR pending llama bundle).
    #    Memory is governed solely by model_memory (weights x1.2, resident-
    #    credited); there is no separate fixed anti-thrash floor check.
    hw: HardwareInfo = await get_hardware(app_state)
    available_gb = available_memory_gb()
    disk_free_bytes = probe_disk_free_bytes(model_dir())
    if bundle_id is not None:
        sizing = _size_bundle(
            app_state, bundle_id, hardware=hw
        )  # raises UnknownBundleError
        # If the bundle's model is already loaded/loading, model_memory credits
        # its own footprint back (issue #1528): the RAM it needs is already held
        # by its running llama-server, so it passes rather than demanding another
        # full bundle-sized amount of free RAM.
        resident = _bundle_already_resident(app_state, sizing)
        reclaimable_bytes = (
            0
            if resident or not sizing.system_ram_gate
            else _reclaimable_resident_bytes(app_state, sizing)
        )
        checks.append(
            _model_memory_check(
                available_gb,
                sizing.ram_bytes,
                sizing.local,
                already_resident=resident,
                reclaimable_bytes=reclaimable_bytes,
                system_ram_gate=sizing.system_ram_gate,
            )
        )
        checks.append(
            _disk_check(disk_free_bytes, sizing.disk_required_bytes, sizing.local)
        )
        _log_bundle_preflight(
            bundle_id,
            sizing,
            available_gb,
            disk_free_bytes,
            checks,
            resident,
            reclaimable_bytes,
        )
    else:
        local_server_active = _local_bundle_intended(app_state)
        checks.extend(
            build_resource_checks(
                store,
                registry,
                available_gb=available_gb,
                disk_free_bytes=disk_free_bytes,
                local_server_active=local_server_active,
                hardware=hw,
            )
        )

    ready = all(
        not (c["state"] == "fail" and c["severity"] == "error") for c in checks
    )
    return {
        "ready": ready,
        "missing_resources": missing_resources,
        "checks": checks,
        "hardware": hw.to_dict(),
    }
