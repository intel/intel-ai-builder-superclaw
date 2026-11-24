"""Ensure-ready orchestration for the local llama-server router.

Ported from ``backend_manager``'s ``api/v1/_inference_logic.py`` onto LRM's
async :class:`~llmrouter_manager.common.operations.OperationPool`.

Grain change
------------

The legacy version spawned a *parent* run with two weighted *child* runs
(``model_download`` 0.9 + ``server_start`` 0.1) via ``RunManager.spawn`` and a
``recompute_parent_pct`` roll-up. LRM's :class:`OperationPool` is deliberately
flat - no parent/child, no scheduler - so this port collapses the work into a
**single** operation whose progress bar is partitioned by hand:

* download phase  -> ``0 .. 90``  (both models share the sub-range)
* server-start    -> ``90 .. 100``

The worker coroutine is scheduled with :func:`asyncio.create_task` (the pool
does not own a scheduler); a reference is parked on ``app_state`` so it is not
garbage-collected mid-flight. Cancellation is cooperative: a caller flips the
operation to ``cancelled`` (``pool.cancel``) and the worker unwinds on its next
``await handle.raise_if_cancelled()``.

Model readiness is filesystem-derived (:meth:`HfDownloader.is_ready`); active
selections come from the ``Store`` config KV. No ``models`` / ``runs`` tables.
"""

from __future__ import annotations

import asyncio
import contextlib
from typing import Any, Literal

from loguru import logger
from pydantic import BaseModel, ConfigDict, Field

from .downloader import HfDownloader
from .hardware import HardwareInfo, launch_waits_for_reprobe
from .operations_bridge import OperationCancelled, OperationHandle
from .registry import ROLE_CHAT, ROLE_EMBEDDING, RegistryError
from .selections import set_model_selection
from .supervisor import LocalLlmRerouted

__all__ = [
    "EnsureReadyResponse",
    "KIND_ENSURE_READY",
    "ensure_model_servers_ready",
    "get_downloader",
    "get_ensure_ready_lock",
    "resume_local_if_ready",
]

# Operation ``kind`` for the single ensure-ready operation. Kept as a dotted
# namespace string to match the other LRM operation kinds (``model_download``,
# ``inference_server_provision`` ...).
KIND_ENSURE_READY = "model_server.ensure_ready"

# Progress partition boundary between the download phase and the server-start
# phase on the single operation's 0-100 bar.
_DOWNLOAD_CEILING = 90.0


class EnsureReadyResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    # "ready"   = nothing to do, router already up for both roles (operation_id null)
    # "running" = orchestration in progress (poll GET /v1/operations/{operation_id})
    # "skipped" = host is ineligible for local LLM (no llama-server will start)
    state: Literal["ready", "running", "skipped"]
    operation_id: str | None = Field(
        default=None, pattern=r"^lrm:[A-Za-z0-9][A-Za-z0-9._-]*$"
    )
    reason: str | None = None


def get_downloader(app_state: Any) -> HfDownloader:
    """Return the shared :class:`HfDownloader` from *app_state*.

    Expected to be initialised eagerly in ``build_app`` as
    ``app.state._downloader``. Falls back to lazy creation only as a safety net
    (e.g. tests that assemble ``app.state`` without going through ``build_app``).
    """
    dl = getattr(app_state, "_downloader", None)
    if dl is None:
        dl = HfDownloader(app_state.local_config, store=app_state.store)
        app_state._downloader = dl
    return dl


def get_ensure_ready_lock(app_state: Any) -> asyncio.Lock:
    """Return the ensure-ready mutex from *app_state*, creating it on demand."""
    lock = getattr(app_state, "_ensure_ready_lock", None)
    if lock is None:
        lock = asyncio.Lock()
        app_state._ensure_ready_lock = lock
    return lock


async def ensure_model_servers_ready(
    app_state: Any,
    *,
    chat_model_id: str | None = None,
    embedding_model_id: str | None = None,
) -> EnsureReadyResponse:
    """Ensure the local router is serving both roles; return an operation handle.

    *app_state* is ``request.app.state`` (or any object exposing ``store``,
    ``registry``, ``supervisor``, ``eligibility``, ``operation_pool``,
    ``local_config``).

    *chat_model_id* / *embedding_model_id* are optional per-request overrides
    (useful at first boot before a selection is persisted); when omitted the
    active selection from the config store is used, falling back to the
    registry defaults.
    """
    store = app_state.store
    registry = app_state.registry
    supervisor = app_state.supervisor
    pool = app_state.operation_pool
    dl = get_downloader(app_state)

    # Strict eligibility gate: on an ineligible host no local llama-server is
    # provisioned. The Tauri shell normally skips this call entirely, but any
    # caller (manual curl, future UI button) hits the same gate here.
    eligibility = getattr(app_state, "eligibility", None)
    if eligibility is not None and not eligibility.eligible:
        return EnsureReadyResponse(
            state="skipped", operation_id=None, reason=eligibility.reason
        )

    chat_id = (
        chat_model_id
        or store.get_config("active_chat_model_id")
        or registry.default_chat_id
    )
    emb_id = (
        embedding_model_id
        or store.get_config("active_embedding_model_id")
        or registry.default_embedding_id
    )
    chat_entry = registry.require(chat_id)
    emb_entry = registry.require(emb_id)

    chat_sup = supervisor[ROLE_CHAT]
    emb_sup = supervisor[ROLE_EMBEDDING]

    async with get_ensure_ready_lock(app_state):
        # Fast path: models on disk and router already serving both roles.
        if (
            dl.is_ready(chat_entry)
            and dl.is_ready(emb_entry)
            and chat_sup.state == "ready"
            and emb_sup.state == "ready"
        ):
            return EnsureReadyResponse(state="ready", operation_id=None)

        # Persist the resolved selection for BOTH roles before any launch path
        # runs. The shared RouterSupervisor resolves its launch plan from the
        # store's active_*_model_id keys (supervisor._resolve_active_model_id),
        # NOT from the registry defaults that this function falls back to above.
        # Provisioning historically pinned only chat (PUT /model-selections/chat),
        # so active_embedding_model_id stayed unset and the chat facade - which
        # wins the asyncio.gather race in _start_phase and computes the launch
        # plan before embedding's id is applied to the shared router - raised
        # "no active model configured for role=embedding". Writing both here
        # restores the store<->registry invariant so the supervisor always
        # resolves both roles regardless of launch ordering.
        set_model_selection(store, ROLE_CHAT, chat_entry.id)
        set_model_selection(store, ROLE_EMBEDDING, emb_entry.id)

        # In-flight dedup: reuse the active operation if it is still running.
        active_id: str | None = getattr(
            app_state, "_ensure_ready_active_operation_id", None
        )
        if active_id:
            snap = await pool.get(active_id)
            if snap is not None and snap["state"] not in ("done", "error", "cancelled"):
                return EnsureReadyResponse(state="running", operation_id=active_id)
            app_state._ensure_ready_active_operation_id = None

        operation = await pool.create(
            KIND_ENSURE_READY,
            metadata={
                "chat_model_id": chat_entry.id,
                "embedding_model_id": emb_entry.id,
            },
        )
        operation_id = str(operation["operation_id"])
        handle = OperationHandle(pool, operation_id)

        task = asyncio.create_task(
            _run_ensure_ready(
                app_state,
                handle,
                dl=dl,
                chat_entry=chat_entry,
                emb_entry=emb_entry,
                chat_sup=chat_sup,
                emb_sup=emb_sup,
            ),
            name=f"lrm-ensure-ready-{operation_id}",
        )
        # Park a reference so the fire-and-forget task is not GC'd mid-flight.
        app_state._ensure_ready_task = task
        app_state._ensure_ready_active_operation_id = operation_id
        task.add_done_callback(_log_task_result)

        return EnsureReadyResponse(state="running", operation_id=operation_id)


async def resume_local_if_ready(app_state: Any) -> EnsureReadyResponse:
    """Boot-time local resume: verify the active Local Bundle, then bring it up.

    Called from the app lifespan beside the latency-router prewarm (as a
    background task, so the checks below never delay ``lifespan ready``). Acts
    only when a committed Primary Bundle exists with ``backend == "llama"``; an
    Edge Bundle or no active Bundle stays inert.

    Every file of that Bundle is verified — existence, exact declared size and
    sha256 (:meth:`HfDownloader.verify_installed`) — and anything that fails leaves
    boot **inert**, with the failing asset ids in ``reason``. Boot must not block on
    a download: a repair here would start multi-GB transfers before the consent
    prompt that authorises them, under an operation no dialog is polling. The
    startup switch owns that repair instead — it is offered on every launch, because
    an asset that is not cached-and-verified is exactly what makes the resolver ask
    for ``download_and_connect`` — and the commit hook starts the servers afterwards.

    Verification is still what decides, not presence: a download interrupted
    mid-file leaves a short GGUF on disk, and the older "exists and is at least
    declared size" test accepted corrupt files. Verification is cheap in the steady
    state (a stat plus a persisted-digest lookup per file); it hashes only files this
    install has never verified.

    Idempotent against a concurrent manual provision: the actual launch is
    serialized by the same ``get_ensure_ready_lock`` mutex that
    :func:`ensure_model_servers_ready` takes (which also dedups an in-flight
    operation), so a boot resume racing a manual provision folds onto one run.
    """
    store = app_state.store
    registry = app_state.registry

    primary = store.get_bundle_lifecycle()["primary_bundle"]
    if primary is None:
        return EnsureReadyResponse(
            state="skipped", operation_id=None, reason="no active Primary Bundle"
        )
    if primary.get("backend") != "llama":
        return EnsureReadyResponse(
            state="skipped", operation_id=None, reason="active Primary Bundle is Edge"
        )

    try:
        chat_id = str(primary["chat_model_id"])
        emb_id = str(primary["embedding_model_id"])
        chat_entry = registry.require(chat_id)
        emb_entry = registry.require(emb_id)
    except (KeyError, RegistryError) as exc:
        # A stale selection pointing at a model id that no longer exists in the
        # registry (e.g. after a registry change). Stay inert rather than crash
        # boot; the user re-picks a tier in-app.
        return EnsureReadyResponse(state="skipped", operation_id=None, reason=str(exc))

    dl = get_downloader(app_state)
    incomplete = [
        entry.id
        for entry in (chat_entry, emb_entry)
        if not await dl.verify_installed(entry)
    ]
    if incomplete:
        # Boot does not repair. Downloading here put multi-GB transfers ahead of the
        # consent prompt that exists to authorise them — measured on a real launch as
        # bytes moving 7.4 s before the dialog appeared and 12.4 s before Confirm was
        # clicked, so Cancel (which by design exits the app) could not stop what was
        # already on disk. It also wrote those bytes under this task's own operation
        # while the dialog polled the switch's, leaving the dialog's per-asset progress
        # pinned at 0 for the whole transfer.
        #
        # Nothing is left for the user to stumble upon: the startup resolver asks for
        # an intent on every launch and gets `download_and_connect` exactly when an
        # asset is not cached-and-verified (a truncated GGUF has no matching
        # verification record, so it lands there too). That switch downloads under the
        # operation the dialog is already polling, and the commit hook in
        # `capability/api.py` starts the servers after a non-replayed llama commit.
        #
        # Verification above is unchanged, so the gain #1650 was after — a corrupt or
        # truncated file is refused rather than launched — is kept. Only the action on
        # failure moves: decline here instead of downloading here.
        #
        # Returned rather than logged-and-continued: an inert boot with no stated
        # reason is indistinguishable from a crash.
        names = ", ".join(incomplete)
        logger.info(
            "[BootResume] not resumed: assets do not verify ({}); leaving the repair "
            "to the consented startup switch",
            names,
        )
        return EnsureReadyResponse(
            state="skipped",
            operation_id=None,
            reason=f"assets do not verify: {names}",
        )

    # Boot-resume memory gate (先检查再拉起). Reaching here means every asset
    # verified, so this is always the pure-spawn path — an unverified Bundle has
    # already returned inert above, and the gate no longer has to be skipped for a
    # "the download will take tens of minutes anyway" case.
    #
    # For UMA/shared-memory models, check there is enough free RAM to LOAD this
    # bundle. At boot the server is not up yet, so nothing is resident
    # (already_resident=False) — the check uses raw free RAM, and the model's
    # footprint has not yet been taken, so the reading is honest. Dedicated-GPU
    # bundles use board VRAM for the primary allocation, so the generic
    # system-RAM load estimate does not apply to them.
    #
    # This gate ONLY checks the model-load headroom (model_load_fits). The
    # separate 4 GB anti-thrash floor is the /system/preflight `available_memory`
    # check's job (a generic host-health floor), NOT a reason to refuse resuming
    # an already-configured tiny model — so it is deliberately not applied here.
    # Local imports avoid coupling this boot path to the routing/system layers at
    # module load.
    from ..routing.policy.gates import available_memory_gb
    from .deps import get_hardware
    from .policy import targets_discrete_gpu
    from .system import model_load_fits

    hardware = await get_hardware(app_state)
    if await _resume_waits_for_hardware(app_state, hardware):
        # A failed probe left no memory or GPU evidence, so a plan built on it has
        # no dedicated-GPU evidence: no tuning, no --main-gpu pin, and a board's
        # model loads on device 0. Or it left the Bundle ineligible (a zero memory
        # speed fails every model's requirement). Nothing else starts a committed
        # local model after boot, so the resume comes back by itself once
        # LLMRouter's background re-probe completes the reading.
        logger.warning(
            "[BootResume] hardware reading incomplete ({}); local resume deferred",
            "; ".join(hardware.detection_errors),
        )
        _defer_resume_until_hardware_complete(app_state)
        return EnsureReadyResponse(
            state="skipped",
            operation_id=None,
            reason="hardware reading incomplete; local resume deferred",
        )
    if not targets_discrete_gpu(chat_entry, hardware):
        available_gb = available_memory_gb()
        if available_gb is not None:
            # Speculative decoding loads the draft next to its model, so the
            # footprint is every byte the bundle installs.
            model_bytes = int(chat_entry.total_size_bytes) + int(emb_entry.total_size_bytes)
            fits, required_gb = model_load_fits(
                available_gb, model_bytes, already_resident=False
            )
            if not fits:
                logger.warning(
                    "boot-resume memory gate: not spawning llama-server — "
                    "free={:.1f}GB, model_need={:.1f}GB (bundle={})",
                    available_gb,
                    required_gb,
                    primary.get("bundle_id"),
                )
                return EnsureReadyResponse(
                    state="skipped",
                    operation_id=None,
                    reason=(
                        f"insufficient free RAM to load model: {available_gb:.1f} GB free, "
                        f"{required_gb:.1f} GB needed"
                    ),
                )

    return await ensure_model_servers_ready(
        app_state,
        chat_model_id=chat_id,
        embedding_model_id=emb_id,
    )


# How often the deferred boot resume re-reads the hardware. Each read is a cache
# hit; it also lets get_hardware start the next background re-probe on its backoff.
_DEFERRED_RESUME_POLL_S = 5.0


async def _resume_waits_for_hardware(app_state: Any, hardware: HardwareInfo) -> bool:
    """Boot resume waits while a failed probe can still change the outcome.

    Only a retryable reading waits: a clean ineligible one is the machine's answer
    and skips. A retryable reading waits when it lacks launch evidence, or when the
    eligibility verdict ensure-ready gates on (refreshed from this reading) rejects
    the Bundle. A harmless probe error with an eligible Bundle launches.
    """
    if not hardware.retryable:
        return False
    if launch_waits_for_reprobe(hardware):
        return True
    from .deps import get_eligibility

    return not (await get_eligibility(app_state)).eligible


def _defer_resume_until_hardware_complete(app_state: Any) -> None:
    task: asyncio.Task[None] | None = getattr(app_state, "_deferred_resume_task", None)
    if task is not None and not task.done():
        return

    async def resume_when_complete() -> None:
        from .deps import get_hardware

        while await _resume_waits_for_hardware(app_state, await get_hardware(app_state)):
            await asyncio.sleep(_DEFERRED_RESUME_POLL_S)
        result = await resume_local_if_ready(app_state)
        logger.info(
            "[BootResume] deferred local resume after a complete hardware reading: "
            "state={} operation_id={} reason={}",
            result.state,
            result.operation_id,
            result.reason,
        )

    task = asyncio.get_running_loop().create_task(
        resume_when_complete(), name="lrm-deferred-boot-resume"
    )
    task.add_done_callback(_log_task_result)
    app_state._deferred_resume_task = task


def _log_task_result(task: asyncio.Task) -> None:
    """Surface an unexpected worker crash (the worker itself swallows failures
    into ``handle.error``; this only catches truly unhandled exceptions)."""
    if task.cancelled():
        return
    exc = task.exception()
    if exc is not None:
        logger.opt(exception=exc).error("ensure-ready task crashed unhandled")


async def _run_ensure_ready(
    app_state: Any,
    handle: OperationHandle,
    *,
    dl: HfDownloader,
    chat_entry: Any,
    emb_entry: Any,
    chat_sup: Any,
    emb_sup: Any,
) -> None:
    """Single flat worker: download both models (0-90) then start the router (90-100)."""
    try:
        await _download_phase(handle, dl=dl, chat_entry=chat_entry, emb_entry=emb_entry)
        outcomes = await _start_phase(
            handle,
            chat_sup=chat_sup,
            emb_sup=emb_sup,
            chat_entry=chat_entry,
            emb_entry=emb_entry,
        )
        if "rerouted" in outcomes:
            await handle.done(message="model servers ready (some rerouted to cloud)")
        else:
            await handle.done(message="model servers ready")
    except OperationCancelled:
        logger.info("ensure-ready operation {} cancelled", handle.operation_id)
    except Exception as exc:  # noqa: BLE001 - surface every failure onto the operation
        logger.opt(exception=exc).warning(
            "ensure-ready operation {} failed", handle.operation_id
        )
        await handle.error(str(exc))
        # Best-effort teardown so a half-started router does not linger.
        with contextlib.suppress(Exception):
            await chat_sup.stop()
    finally:
        if (
            getattr(app_state, "_ensure_ready_active_operation_id", None)
            == handle.operation_id
        ):
            app_state._ensure_ready_active_operation_id = None


async def _download_phase(
    handle: OperationHandle,
    *,
    dl: HfDownloader,
    chat_entry: Any,
    emb_entry: Any,
) -> None:
    """Download whichever models are missing, mapped onto the 0-90 sub-range.

    "Missing" is decided by full verification - existence, exact declared size
    and sha256 for every file of every asset (model GGUF, its speculative
    decoding draft, embedding). A truncated or corrupt file is deleted by the
    verifier and re-downloaded here, instead of being loaded as-is.
    """
    await handle.message("verifying model files")
    chat_needed = not await dl.verify_installed(chat_entry)
    emb_needed = not await dl.verify_installed(emb_entry)

    await handle.set_files(
        [
            _file_descriptor(chat_entry, needed=chat_needed),
            _file_descriptor(emb_entry, needed=emb_needed),
        ]
    )

    if not chat_needed and not emb_needed:
        return

    both = chat_needed and emb_needed
    if chat_needed:
        await handle.progress(0.0, message="downloading chat model")
        await handle.file_progress(
            chat_entry.id, done=0, total=chat_entry.total_size_bytes, state="downloading"
        )
        await dl.download(
            chat_entry,
            handle,
            mark_done=False,
            pct_range=(0.0, 45.0) if both else (0.0, _DOWNLOAD_CEILING),
        )
        await handle.file_progress(
            chat_entry.id,
            done=chat_entry.total_size_bytes,
            total=chat_entry.total_size_bytes,
            state="complete",
        )
    if emb_needed:
        # No explicit progress() here - dl.download emits its range start
        # immediately so the bar advances smoothly without going backward.
        await handle.message("downloading embedding model")
        await handle.file_progress(
            emb_entry.id, done=0, total=emb_entry.total_size_bytes, state="downloading"
        )
        await dl.download(
            emb_entry,
            handle,
            mark_done=False,
            pct_range=(45.0, _DOWNLOAD_CEILING) if both else (0.0, _DOWNLOAD_CEILING),
        )
        await handle.file_progress(
            emb_entry.id,
            done=emb_entry.total_size_bytes,
            total=emb_entry.total_size_bytes,
            state="complete",
        )


def _file_descriptor(entry: Any, *, needed: bool) -> dict[str, object]:
    """One entry of the per-file download manifest exposed via op metadata."""
    return {
        "id": entry.id,
        "label": entry.name,
        "role": entry.role,
        "done": 0 if needed else entry.total_size_bytes,
        "total": entry.total_size_bytes,
        "state": "pending" if needed else "complete",
    }


async def _start_phase(
    handle: OperationHandle,
    *,
    chat_sup: Any,
    emb_sup: Any,
    chat_entry: Any,
    emb_entry: Any,
) -> list[str]:
    """Start the router for both roles (90-100). Returns per-role outcome labels."""
    chat_start_needed = chat_sup.state != "ready"
    emb_start_needed = emb_sup.state != "ready"
    if not chat_start_needed and not emb_start_needed:
        return []

    await handle.progress(
        _DOWNLOAD_CEILING,
        message=f"launching {ROLE_CHAT} + {ROLE_EMBEDDING}",
    )
    coros = []
    if chat_start_needed:
        coros.append(_start_one(chat_sup, chat_entry.id))
    if emb_start_needed:
        coros.append(_start_one(emb_sup, emb_entry.id))
    try:
        return await asyncio.gather(*coros)
    except BaseException:
        # Any launch failure tears down the shared router process so a retry
        # starts from a clean slate (the two facades share one llama-server).
        with contextlib.suppress(Exception):
            await chat_sup.stop()
        raise


async def _start_one(sup: Any, model_id: str) -> str:
    """Start one role; treat :class:`LocalLlmRerouted` as a soft success.

    On the ``dev`` channel the booster may decline launching a local
    llama-server for this box - that is graceful degradation, not a failure:
    the host LRM serves the traffic (cloud-routed), so we report ``rerouted``
    rather than propagating an error.
    """
    try:
        await sup.start(model_id=model_id)
        return "ready"
    except LocalLlmRerouted as exc:
        logger.warning(
            "supervisor[{}] declined local launch (booster): {}; served by host LRM.",
            sup.role,
            exc.reason,
        )
        return "rerouted"
