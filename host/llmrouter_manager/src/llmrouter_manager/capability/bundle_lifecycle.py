"""Durable staged lifecycle for atomic Chat+Embedding Bundles."""

from __future__ import annotations

import asyncio
import json
import sqlite3
from typing import Any, Mapping

from loguru import logger

from ..common.operations import OperationPool
from ..common.store import Store
from ..local import mock_bundle
from ..local.downloader import HfDownloader
from ..local.deps import get_hardware
from ..local.operations_bridge import OperationCancelled, OperationHandle
from ..local.registry import Registry, RegistryError, load_builtin_registry
from .bundle_capability import AssetCacheState, inspect_asset_cache
from .bundle_capability import compute_supported_bundles
from .bundle_registry import BundleEntry, BundleRegistryError, load_bundle_registry


def pending_state(bundle: BundleEntry, state: str, reason: str | None = None) -> dict[str, Any]:
    value: dict[str, Any] = {**bundle.as_model_bundle(), "state": state}
    if reason:
        value["reason"] = reason
    return value


async def prepare_local_bundle(
    *,
    bundle: BundleEntry,
    asset_registry: Registry,
    store: Store,
    downloader: HfDownloader,
    operation_pool: OperationPool,
    operation_id: str,
    prepare_token: str,
    cache_states: Mapping[str, AssetCacheState],
    allow_download: bool,
    initial_pct: float = 0,
) -> None:
    """Download/verify both Bundle assets without activating either selection."""
    logger.info(
        "bundle_prepare start operation_id={} bundle_id={} allow_download={}",
        operation_id,
        bundle.bundle_id,
        allow_download,
    )
    handle = OperationHandle(
        operation_pool,
        operation_id,
        lambda state, pct, message: store.update_preparation_progress(
            operation_id, state=state, pct=pct, message=message
        ),
        initial_pct=initial_pct,
    )
    assets = (
        asset_registry.require(bundle.chat_model_id),
        asset_registry.require(bundle.embedding_model_id),
    )
    # A partially cached asset (e.g. model present, draft missing) starts its
    # row at the bytes already verified so the bar reflects the real remainder.
    states = {
        asset.id: cache_states.get(asset.id, AssetCacheState.missing(asset))
        for asset in assets
    }
    await handle.set_files(
        [
            {
                "id": asset.id,
                "label": asset.name,
                "role": asset.role,
                "done": asset.total_size_bytes - states[asset.id].missing_bytes,
                "total": asset.total_size_bytes,
                "state": (
                    "complete" if states[asset.id].cached_and_verified else "pending"
                ),
            }
            for asset in assets
        ]
    )
    try:
        for index, asset in enumerate(assets):
            await handle.raise_if_cancelled()
            if mock_bundle.mocks_chat_asset(asset.id):
                # Dev-only: a remote endpoint stands in for these weights, so
                # there is nothing to fetch. The asset's repo and digest in the
                # mock overlay are placeholders -- attempting the download would
                # fail on a repo that does not exist, and succeeding would be
                # worse. Its progress row is already "complete" because
                # inspect_asset_cache reports it cached.
                logger.warning(
                    "bundle_prepare skipping mocked asset operation_id={} asset_id={}",
                    operation_id,
                    asset.id,
                )
                continue
            if not allow_download:
                verified = await asyncio.to_thread(
                    inspect_asset_cache, downloader.models_dir, asset, store
                )
                if not verified.cached_and_verified:
                    raise RuntimeError("download confirmation required after asset change")
            await handle.message(f"preparing {asset.role} asset")
            await downloader.download(
                asset,
                handle,
                mark_done=False,
                pct_range=(index * 50.0, (index + 1) * 50.0),
            )
        await handle.raise_if_cancelled()
        store.transition_pending_bundle(
            prepare_token=prepare_token,
            pending_bundle=pending_state(bundle, "prepared"),
        )
        await handle.done(message="bundle prepared")
    except OperationCancelled:
        logger.warning(
            "bundle_prepare cancelled operation_id={} bundle_id={} token={}",
            operation_id,
            bundle.bundle_id,
            prepare_token,
        )
        store.transition_pending_bundle(prepare_token=prepare_token, pending_bundle=None)
    except asyncio.CancelledError:
        logger.warning(
            "bundle_prepare shutdown_cancelled operation_id={} bundle_id={} token={}",
            operation_id,
            bundle.bundle_id,
            prepare_token,
        )
        # Preserve durable running evidence. The next LRM process resumes this
        # exact operation and the downloader reuses its partial file.
        raise
    except Exception as exc:
        logger.opt(exception=True).error(
            "bundle_prepare failed operation_id={} bundle_id={} exc_type={} exc={}",
            operation_id,
            bundle.bundle_id,
            type(exc).__name__,
            str(exc),
        )
        store.transition_pending_bundle(
            prepare_token=prepare_token,
            pending_bundle=pending_state(bundle, "error", str(exc)),
        )
        await handle.error(str(exc))


async def _restore_interrupted_local_bundle(app_state: Any, *, start_download: bool) -> None:
    lock = getattr(app_state, "bundle_prepare_recovery_lock", None)
    if lock is None:
        lock = asyncio.Lock()
        app_state.bundle_prepare_recovery_lock = lock
    async with lock:
        recovery = app_state.store.get_resumable_preparation()
        if recovery is None:
            return
        operation_id = str(recovery["prepare_operation_id"])
        target = recovery["target_bundle"]
        if any(
            task.get_name() == operation_id and not task.done()
            for task in app_state.bundle_prepare_tasks
        ):
            return
        if target.get("backend") != "llama":
            raise ValueError("only local Bundle preparations can resume after restart")
        assets = load_builtin_registry()
        bundles = load_bundle_registry(asset_registry=assets)
        bundle = bundles.require(str(target["bundle_id"]))
        if bundle.backend != "llama" or bundle.as_model_bundle() != target:
            raise ValueError("persisted Bundle no longer matches the trusted registry")
        lifecycle = app_state.store.get_bundle_lifecycle()
        if lifecycle["bundle_revision"] != recovery["expected_bundle_revision"]:
            raise ValueError("Bundle revision changed while preparation was interrupted")
        hardware = await get_hardware(app_state)
        if bundle not in compute_supported_bundles(hardware, bundles, assets):
            raise ValueError("Bundle is no longer compute-supported")
        cache_states = await asyncio.to_thread(
            lambda: {
                asset_id: inspect_asset_cache(
                    app_state.local_config.models_dir,
                    assets.require(asset_id),
                    app_state.store,
                )
                for asset_id in (bundle.chat_model_id, bundle.embedding_model_id)
            }
        )
        verified_assets = sum(
            1 for state in cache_states.values() if state.cached_and_verified
        )
        await app_state.operation_pool.restore(
            operation_id,
            "primary_bundle.prepare",
            pct=int(float(recovery["pct"])),
            message="resuming bundle preparation",
            metadata={"bundle_id": bundle.bundle_id},
        )
        if not start_download:
            logger.info(
                "restored interrupted Bundle preparation operation_id={} bundle_id={} pct={} "
                "verified_assets={}/2 awaiting confirmation",
                operation_id,
                bundle.bundle_id,
                recovery["pct"],
                verified_assets,
            )
            return
        current = app_state.store.get_resumable_preparation()
        if current is None or current["prepare_token"] != recovery["prepare_token"]:
            logger.warning(
                "resume aborted: prepare_token changed operation_id={} bundle_id={}",
                operation_id,
                bundle.bundle_id,
            )
            await app_state.operation_pool.cancel(operation_id)
            return
        task = asyncio.create_task(
            prepare_local_bundle(
                bundle=bundle,
                asset_registry=assets,
                store=app_state.store,
                downloader=app_state._downloader,
                operation_pool=app_state.operation_pool,
                operation_id=operation_id,
                prepare_token=str(recovery["prepare_token"]),
                cache_states=cache_states,
                allow_download=bool(recovery["allow_download"]),
                initial_pct=float(recovery["pct"]),
            ),
            name=operation_id,
        )
        app_state.bundle_prepare_tasks.add(task)
        task.add_done_callback(app_state.bundle_prepare_tasks.discard)
        logger.info(
            "resumed interrupted Bundle preparation operation_id={} bundle_id={} pct={} "
            "verified_assets={}/2 (download task started)",
            operation_id,
            bundle.bundle_id,
            recovery["pct"],
            verified_assets,
        )


def _transition_recovery_to_error(app_state: Any, recovery: dict[str, Any], exc: Exception) -> None:
    """Move the one durable pending slot to a terminal ``error`` state.

    Shared by both restart-recovery callers so their error-terminal handling
    cannot drift apart again: a ``prepare_token`` guard ensures this only
    touches the slot if it still belongs to the same preparation attempt.
    """
    binding = app_state.store.get_preparation_binding()
    if binding is not None and binding["prepare_token"] == recovery["prepare_token"]:
        app_state.store.transition_pending_bundle(
            prepare_token=binding["prepare_token"],
            pending_bundle={
                **recovery["target_bundle"],
                "state": "error",
                "reason": str(exc),
            },
        )


async def resume_interrupted_local_bundle(app_state: Any) -> None:
    """Resume the one durable local Bundle preparation after explicit confirmation."""
    recovery = app_state.store.get_resumable_preparation()
    if recovery is None:
        return
    try:
        await _restore_interrupted_local_bundle(app_state, start_download=True)
    except Exception as exc:
        operation_id = str(recovery["prepare_operation_id"])
        logger.opt(exception=True).error(
            "could not resume interrupted Bundle preparation operation_id={}", operation_id
        )
        _transition_recovery_to_error(app_state, recovery, exc)


def reset_uncatalogued_bindings(app_state: Any) -> None:
    """Forget saved Bundles and model selections the current catalogue no longer has.

    Runs synchronously at the top of the ``app.py`` lifespan, before any capability
    read is served. A catalogue that cannot be loaded resets nothing.
    """
    try:
        bundles = load_bundle_registry()
    # The loader converts only a missing file and invalid JSON; a denied read or
    # invalid UTF-8 escapes it as OSError / UnicodeDecodeError.
    except (BundleRegistryError, RegistryError, OSError, UnicodeDecodeError) as exc:
        logger.warning("uncatalogued binding cleanup skipped: catalogue unreadable ({})", exc)
        return
    model_ids = set(app_state.registry.models)
    for bundle in bundles.bundles.values():
        model_ids.update((bundle.chat_model_id, bundle.embedding_model_id))
    try:
        app_state.store.reset_uncatalogued_bindings(
            bundle_ids=frozenset(bundles.bundles), model_ids=frozenset(model_ids)
        )
    # A locked or failing DB, or a corrupt saved row, must never stop start-up;
    # the transaction has already rolled back, so the row is left as it was.
    except (sqlite3.Error, json.JSONDecodeError, AttributeError, TypeError):
        logger.opt(exception=True).warning(
            "uncatalogued binding cleanup failed; continuing start-up with saved state unchanged"
        )


async def restore_interrupted_local_bundle(app_state: Any) -> None:
    """Restore durable operation readback without restarting network activity.

    Runs unattended on every process boot (``app.py`` lifespan), so it must
    not treat every failure as permanent: ``_restore_interrupted_local_bundle``
    raises ``ValueError`` for the closed set of structural drift checks
    (persisted target no longer matches the trusted registry, the bundle
    revision changed, or the bundle is no longer compute-supported --
    registry/asset lookups reuse the same ``ValueError``-derived error types).
    That drift is permanent: retrying on the next boot would just repeat the
    same failure forever while leaving the durable pending slot stuck in
    "preparing" and locking out ``claim_pending_bundle`` for every future
    switch. Any other exception (hardware probe hiccup, disk I/O not yet
    ready, event-loop wiring) is transient, so it is logged only and the
    durable state is left untouched -- the next boot's restore attempt gets
    to retry it (fail-open).
    """
    recovery = app_state.store.get_resumable_preparation()
    if recovery is None:
        return
    try:
        await _restore_interrupted_local_bundle(app_state, start_download=False)
    except ValueError as exc:
        operation_id = str(recovery["prepare_operation_id"])
        logger.opt(exception=True).error(
            "bundle drift while restoring interrupted Bundle preparation "
            "operation_id={}: {}",
            operation_id,
            exc,
        )
        _transition_recovery_to_error(app_state, recovery, exc)
    except Exception:
        logger.opt(exception=True).error(
            "could not restore interrupted Bundle preparation operation_id={}",
            recovery["prepare_operation_id"],
        )
