"""Local subsystem dependency wiring for llmrouter_manager.

``build_default_local_deps()`` constructs the production local subsystem
(registry + shared :class:`Store` + role-facade supervisor + downloader).
``attach_local_deps`` unpacks a :class:`LocalDeps` onto the flat ``app.state``
attributes that the local endpoints and
:func:`llmrouter_manager.local.inference_logic.ensure_model_servers_ready`
already read (``store`` / ``registry`` / ``supervisor`` / ``local_config`` /
``_downloader`` / ``eligibility``).

Hardware-probe timing
---------------------

The WMI hardware probe is **not** run at construction time: it is expensive
and would otherwise fire on every ``TestClient(build_app(cfg))``. It is probed
lazily on first access via :func:`get_hardware` (off the event loop through
``asyncio.to_thread``) and cached on ``app.state``; an incomplete
(``retryable``) reading is re-probed in the background with backoff until a
complete one replaces it. Tests inject a
``LocalDeps(hardware=<canned HardwareInfo>)`` to skip the probe entirely and
keep assertions deterministic.

The supervisor needs the same reading (the booster tunes per hardware) but from
a *sync* code path, so it is handed the shared once-only probe built by
:func:`_shared_hardware_probe` rather than a value. The HTTP layer and the
supervisor then resolve the same ``HardwareInfo`` from a single WMI call,
whichever of them asks first.
"""

from __future__ import annotations

import asyncio
import threading
from dataclasses import dataclass
from time import monotonic
from typing import Any, Callable, Mapping

from loguru import logger

from ..common.store import Store, default_db_path
from .booster import LocalLLMBooster
from .config import LocalConfig, load_local_config
from .downloader import HfDownloader
from .eligibility import EligibilityResult, evaluate_local_llm_eligibility
from .hardware import HardwareInfo, probe_hardware
from .policy import select_chat_model
from .registry import ModelEntry, Registry, load_registry
from .supervisor import RouterSupervisor, make_role_facades


@dataclass
class LocalDeps:
    """Construction-time bundle unpacked onto ``app.state`` by ``build_app``.

    ``supervisor`` is the role-facade mapping from :func:`make_role_facades`
    (keyed by ``chat`` / ``embedding``), not the raw :class:`RouterSupervisor`
    - ``ensure_model_servers_ready`` subscripts it by role.

    ``hardware`` is pre-set only by tests; ``None`` in production selects the
    lazy probe path in :func:`get_hardware`.
    """

    local_config: LocalConfig
    registry: Registry
    store: Store
    supervisor: Mapping[str, Any]
    downloader: HfDownloader
    hardware: HardwareInfo | None = None
    hardware_provider: Callable[[], HardwareInfo] | None = None


class _SharedHardwareProbe:
    """A blocking hardware probe that runs at most once per process on its own.

    Handed to both :class:`RouterSupervisor` (sync caller, off-loaded to a
    thread by ``resolve_launch_context``) and :func:`get_hardware` (async
    caller), so the two never probe WMI twice. :func:`get_hardware`'s background
    re-probe publishes each later reading here, so a supervisor that first
    resolves its launch context after a boot-time timeout launches on the
    recovered reading. ``threading.Lock`` rather than ``asyncio.Lock``: the
    supervisor's call arrives on a worker thread.
    """

    def __init__(self) -> None:
        self._reading: HardwareInfo | None = None
        self._lock = threading.Lock()

    def __call__(self) -> HardwareInfo:
        with self._lock:
            if self._reading is None:
                self._reading = probe_hardware()
            return self._reading

    def publish(self, reading: HardwareInfo) -> None:
        with self._lock:
            self._reading = reading


def _shared_hardware_probe() -> _SharedHardwareProbe:
    return _SharedHardwareProbe()


def build_default_local_deps() -> LocalDeps:
    """Construct the real local subsystem. Cheap: no WMI probe, no network.

    Reads ``LRM_*`` env + the per-user state root (via ``load_local_config``),
    loads the merged model registry, opens the shared config :class:`Store`,
    and wires a single :class:`RouterSupervisor` - with the booster and the
    lazy hardware probe it tunes from - behind its two role facades.
    """
    local_config = load_local_config()
    registry = load_registry(local_config)
    store = Store(default_db_path())
    hardware_provider = _shared_hardware_probe()
    router = RouterSupervisor(
        config=local_config,
        store=store,
        registry=registry,
        booster=LocalLLMBooster(),
        hardware_provider=hardware_provider,
    )
    return LocalDeps(
        local_config=local_config,
        registry=registry,
        store=store,
        supervisor=make_role_facades(router),
        downloader=HfDownloader(local_config, store=store),
        hardware=None,
        hardware_provider=hardware_provider,
    )


def attach_local_deps(app_state: Any, deps: LocalDeps) -> None:
    """Unpack ``deps`` onto the flat ``app.state`` attributes endpoints read.

    ``eligibility`` is intentionally left unset here (computed lazily by
    :func:`get_eligibility`); ``ensure_model_servers_ready`` reads it via
    ``getattr(..., None)`` and treats ``None`` as "no gate yet".
    """
    app_state.local_config = deps.local_config
    app_state.registry = deps.registry
    app_state.store = deps.store
    app_state.supervisor = deps.supervisor
    app_state._downloader = deps.downloader
    app_state._hardware = deps.hardware  # None => probe lazily on first access
    app_state._hardware_provider = deps.hardware_provider
    app_state._hardware_lock = asyncio.Lock()


async def get_hardware(app_state: Any) -> HardwareInfo:
    """Return the cached :class:`HardwareInfo`, probing once on first access.

    The blocking, self-timeboxed :func:`probe_hardware` is off-loaded to a
    worker thread so the event loop stays free. Double-checked under a lock so
    concurrent first requests share a single probe.

    A ``retryable`` reading (WMI timed out or failed) is still served at once,
    but also starts one background re-probe that replaces it when it lands.
    Callers never wait on that re-probe: it can take the full probe budget,
    longer than ServiceHub's deadline on a capability read.
    """
    hw = getattr(app_state, "_hardware", None)
    if hw is None:
        lock = getattr(app_state, "_hardware_lock", None)
        if lock is None:
            lock = asyncio.Lock()
            app_state._hardware_lock = lock
        async with lock:
            hw = getattr(app_state, "_hardware", None)
            if hw is None:
                # Shared with the supervisor when wired (see _shared_hardware_probe);
                # a bare probe for app states assembled without one.
                probe = getattr(app_state, "_hardware_provider", None) or probe_hardware
                hw = await asyncio.to_thread(probe)
                app_state._hardware = hw
    if hw.retryable:
        _schedule_hardware_reprobe(app_state)
    return hw


# Wait before the next re-probe after the Nth consecutive failed one (the last
# entry repeats). The first re-probe is immediate: a boot-time WMI timeout is
# usually a busy Winmgmt that answers seconds later. The startup UI's Retry keeps
# reading for 35 s, longer than this cap plus one probe budget, so it always
# starts a new probe; raising the cap means raising that window.
_HARDWARE_REPROBE_BACKOFF_S = (5.0, 15.0)


def _schedule_hardware_reprobe(app_state: Any) -> None:
    task: asyncio.Task[None] | None = getattr(app_state, "_hardware_reprobe_task", None)
    if task is not None and not task.done():
        return
    if monotonic() < getattr(app_state, "_hardware_reprobe_not_before", 0.0):
        return

    publish = getattr(getattr(app_state, "_hardware_provider", None), "publish", None)

    def probe_and_publish() -> HardwareInfo:
        # Not the shared provider's call: it would hand back the same cached
        # fallback. probe_hardware rejoins a still-hung WMI worker. Published on
        # this worker thread so the event loop never waits on the provider lock.
        hw = probe_hardware()
        if publish is not None:
            publish(hw)
        return hw

    async def reprobe() -> None:
        hw = await asyncio.to_thread(probe_and_publish)
        app_state._hardware = hw
        # ensure_model_servers_ready gates on the flat cached verdict, which the
        # boot resume computed from the reading this one replaces.
        if getattr(app_state, "eligibility", None) is not None:
            app_state.eligibility = evaluate_local_llm_eligibility(hw, app_state.registry)
        if not hw.retryable:
            app_state._hardware_reprobe_failures = 0
            logger.info("hardware re-probe recovered a complete reading")
            return
        failures = getattr(app_state, "_hardware_reprobe_failures", 0) + 1
        app_state._hardware_reprobe_failures = failures
        delay = _HARDWARE_REPROBE_BACKOFF_S[min(failures, len(_HARDWARE_REPROBE_BACKOFF_S)) - 1]
        app_state._hardware_reprobe_not_before = monotonic() + delay
        logger.warning(
            "hardware re-probe still incomplete failures={} next_in_s={} errors={}",
            failures,
            delay,
            list(hw.detection_errors),
        )

    app_state._hardware_reprobe_task = asyncio.get_running_loop().create_task(
        reprobe(), name="llmrouter.hardware-reprobe"
    )


async def get_eligibility(app_state: Any) -> EligibilityResult:
    """Compute + cache the strict local-LLM eligibility verdict.

    Caches onto ``app_state.eligibility`` so the flat read in
    ``ensure_model_servers_ready`` sees the same verdict.
    """
    hw = await get_hardware(app_state)
    result = evaluate_local_llm_eligibility(hw, app_state.registry)
    app_state.eligibility = result
    return result


async def get_selected_chat_model(app_state: Any) -> ModelEntry:
    """Return the hardware-selected chat model (most-demanding eligible tier)."""
    hw = await get_hardware(app_state)
    return select_chat_model(app_state.registry, hw)
