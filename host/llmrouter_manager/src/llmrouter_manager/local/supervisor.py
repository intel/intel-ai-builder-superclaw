"""llama-server router supervisor with per-role compatibility facades.

Hard-cut single-port topology:

* one ``RouterSupervisor`` owns the single ``llama-server.exe`` router process
* one shared port serves both chat + embedding models via ``--models-preset``
* ``_RoleSupervisorFacade`` preserves the old per-role supervisor API surface

Ported from ``backend_manager`` onto LRM conventions: :class:`LocalConfig`
instead of ``Config``, loguru instead of stdlib logging, and the bundled
``llama-server.exe`` resolved fail-fast at spawn via
:func:`llmrouter_manager.local.paths.llama_server_exe` (the binary is no longer
a config field). Model state is filesystem-derived; the only Store dependency
is the active-selection config KV (``get_config``).
"""

from __future__ import annotations

import asyncio
import contextlib
import ctypes
import ctypes.wintypes
import hashlib
import json
import os
import re
import shlex
import socket
import subprocess
import time
import traceback
from collections import OrderedDict
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

import httpx
from loguru import logger

from . import gpu_devices, mock_bundle, paths
from .booster import (
    LocalLLMBooster,
    LocalUnsupported,
    TunedLaunchArgs,
    channel_allows_substitution,
)
from .build_channel import Channel, detect_channel
from .config import LocalConfig
from .hardware import HardwareInfo, launch_waits_for_reprobe
from .llama_auth import KeyNotEnforcedError, llama_api_key, llama_auth_headers, verify_key_enforced
from .policy import present_discrete_gpu_keywords, targets_discrete_gpu
from .registry import (
    ModelEntry,
    Registry,
    ROLE_CHAT,
    ROLE_EMBEDDING,
    VALID_ROLES,
)
from ..common.http_client import build_async_client_for_url
from ..common.store import Store


class LocalUnsupportedError(Exception):
    """Raised on ``release-candidate`` / ``main`` when local chat is unsupported."""


class LocalLlmRerouted(Exception):
    """Raised on ``dev`` when chat is rerouted away from local llama-server."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


_SENSITIVE_ARG_NAMES = (
    "key",
    "token",
    "secret",
    "password",
    "passwd",
    "credential",
)


def _mask_path_for_log(arg: str) -> str:
    """If arg looks like an absolute path, keep only its basename plus a masked-parent marker."""
    if len(arg) >= 3 and arg[1:3] == ":\\" and arg[0].isalpha():
        return f"<path>\\{Path(arg).name}"
    if arg.startswith("/") and len(arg) > 1 and "/" in arg[1:]:
        return f"<path>/{Path(arg).name}"
    if arg.startswith("\\\\"):
        return f"<unc>\\{Path(arg).name}"
    return arg


def _format_cmd_for_log(cmd: list[str]) -> str:
    """Return a shell-escaped command line with sensitive argument values and paths masked."""
    masked: list[str] = []
    mask_next = False
    for arg in cmd:
        if mask_next:
            masked.append("****")
            mask_next = False
            continue

        key, sep, _value = arg.partition("=")
        if sep and _is_sensitive_arg_name(key):
            masked.append(f"{key}=****")
            continue

        masked.append(_mask_path_for_log(arg))
        if arg.startswith("-") and _is_sensitive_arg_name(arg):
            mask_next = True

    return shlex.join(masked)


def _is_sensitive_arg_name(arg: str) -> bool:
    normalized = arg.lstrip("-").replace("_", "-").lower()
    return any(marker in normalized for marker in _SENSITIVE_ARG_NAMES)


_JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
_JobObjectExtendedLimitInformation = 9


class _IoCounters(ctypes.Structure):
    _fields_ = [
        ("ReadOperationCount", ctypes.c_uint64),
        ("WriteOperationCount", ctypes.c_uint64),
        ("OtherOperationCount", ctypes.c_uint64),
        ("ReadTransferCount", ctypes.c_uint64),
        ("WriteTransferCount", ctypes.c_uint64),
        ("OtherTransferCount", ctypes.c_uint64),
    ]


class _BasicLimitInfo(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_int64),
        ("PerJobUserTimeLimit", ctypes.c_int64),
        ("LimitFlags", ctypes.wintypes.DWORD),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", ctypes.wintypes.DWORD),
        ("Affinity", ctypes.c_size_t),
        ("PriorityClass", ctypes.wintypes.DWORD),
        ("SchedulingClass", ctypes.wintypes.DWORD),
    ]


class _ExtendedLimitInfo(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", _BasicLimitInfo),
        ("IoInfo", _IoCounters),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


def _configure_kernel32_job_api(k32: Any) -> None:
    """Declare Win32 Job Object ctypes signatures."""
    k32.CreateJobObjectW.argtypes = [ctypes.wintypes.LPVOID, ctypes.wintypes.LPCWSTR]
    k32.CreateJobObjectW.restype = ctypes.wintypes.HANDLE
    k32.SetInformationJobObject.argtypes = [
        ctypes.wintypes.HANDLE,
        ctypes.c_int,
        ctypes.wintypes.LPVOID,
        ctypes.wintypes.DWORD,
    ]
    k32.SetInformationJobObject.restype = ctypes.wintypes.BOOL
    k32.AssignProcessToJobObject.argtypes = [
        ctypes.wintypes.HANDLE,
        ctypes.wintypes.HANDLE,
    ]
    k32.AssignProcessToJobObject.restype = ctypes.wintypes.BOOL
    k32.CloseHandle.argtypes = [ctypes.wintypes.HANDLE]
    k32.CloseHandle.restype = ctypes.wintypes.BOOL


def _create_kill_on_close_job() -> int | None:
    """Create a Windows Job Object that kills all members on handle close."""
    try:
        windll = getattr(ctypes, "WinDLL", None)
        get_last_error = getattr(ctypes, "get_last_error", lambda: 0)
        if windll is None:
            return None
        k32 = windll("kernel32", use_last_error=True)
        _configure_kernel32_job_api(k32)
        job = k32.CreateJobObjectW(None, None)
        if not job:
            logger.warning("supervisor: CreateJobObjectW failed (err={})", get_last_error())
            return None

        info = _ExtendedLimitInfo()
        info.BasicLimitInformation.LimitFlags = _JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        ok = k32.SetInformationJobObject(
            job,
            _JobObjectExtendedLimitInformation,
            ctypes.byref(info),
            ctypes.sizeof(info),
        )
        if not ok:
            logger.warning(
                "supervisor: SetInformationJobObject failed (err={})",
                get_last_error(),
            )
            k32.CloseHandle(job)
            return None

        logger.debug("supervisor: kill-on-close Job Object created (handle={})", job)
        return job
    except Exception as exc:  # noqa: BLE001
        logger.warning("supervisor: could not create Job Object: {}", exc)
        return None


_LLAMA_JOB: int | None = _create_kill_on_close_job()


def _assign_to_job(proc: subprocess.Popen) -> None:
    """Assign *proc* to the module-level kill-on-close Job Object."""
    if _LLAMA_JOB is None:
        return
    try:
        windll = getattr(ctypes, "WinDLL", None)
        get_last_error = getattr(ctypes, "get_last_error", lambda: 0)
        if windll is None:
            return
        k32 = windll("kernel32", use_last_error=True)
        _configure_kernel32_job_api(k32)
        ok = k32.AssignProcessToJobObject(_LLAMA_JOB, int(proc._handle))  # type: ignore[attr-defined]
        if not ok:
            logger.warning(
                "supervisor: AssignProcessToJobObject failed for pid={} (err={})",
                proc.pid,
                get_last_error(),
            )
        else:
            logger.debug("supervisor: pid={} assigned to kill-on-close job", proc.pid)
    except Exception as exc:  # noqa: BLE001
        logger.warning("supervisor: could not assign pid={} to job: {}", proc.pid, exc)


STATE_STOPPED = "stopped"
STATE_STARTING = "starting"
STATE_READY = "ready"
STATE_ERROR = "error"
STATE_REROUTED = "rerouted"

DEFAULT_ROUTER_PORT = 8080
DEFAULT_PORTS = {ROLE_CHAT: DEFAULT_ROUTER_PORT, ROLE_EMBEDDING: DEFAULT_ROUTER_PORT}
# Two distinct readiness budgets (see _probe_ready). HEALTH_TIMEOUT_S bounds only
# how long we wait for llama-server to *start answering* /health — a process that
# is up but never listens within this window is wedged, so we fail fast. Once the
# router is reachable, model weights may take minutes to finish loading (a 35B
# chat model on an iGPU is the motivating case), so model readiness gets the
# separate, generous MODEL_LOAD_TIMEOUT_S budget. Collapsing these into one short
# timeout is what killed a healthy, still-loading router (issue #1616). Both are
# env-overridable for slow boxes / tests via LRM_HEALTH_TIMEOUT_S and
# LRM_MODEL_LOAD_TIMEOUT_S.
HEALTH_TIMEOUT_S = 60.0
MODEL_LOAD_TIMEOUT_S = 300.0
GRACEFUL_STOP_S = 5.0
MAX_RESTART_ATTEMPTS = 5
RESTART_BACKOFFS = (2.0, 4.0, 8.0, 16.0, 32.0)
RESTART_STABILITY_S = 30.0  # dwell in STATE_READY before the restart budget resets


def _env_float(name: str, default: float) -> float:
    """Positive float from env ``name`` or ``default`` (bad/≤0 values ignored)."""
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        value = float(raw)
    except ValueError:
        return default
    return value if value > 0 else default


def _resolve_probe_timeouts() -> tuple[float, float]:
    """``(reachability, model-load)`` probe budgets in seconds."""
    return (
        _env_float("LRM_HEALTH_TIMEOUT_S", HEALTH_TIMEOUT_S),
        _env_float("LRM_MODEL_LOAD_TIMEOUT_S", MODEL_LOAD_TIMEOUT_S),
    )

_MODEL_STATUS_LOADED = "loaded"
_MODEL_STATUS_LOADING = "loading"
_MODEL_STATUS_UNLOADED = "unloaded"

# Fallback output cap when a chat model's registry entry leaves
# ``default_n_predict`` at 0 (unset). Matches the ModelEntry docstring.
_DEFAULT_N_PREDICT = 16384


def _llama_metrics_enabled() -> bool:
    raw = os.environ.get("LRM_LLAMA_METRICS", "1").strip().lower()
    return raw not in {"0", "false", "no", "off"}


def _resolve_n_predict(entry: ModelEntry, ctx_size: int) -> int:
    """Per-model output cap (llama-server ``--n-predict``).

    Precedence: the model's registry ``default_n_predict`` (set per model to
    give big models more headroom or clamp small ones) → ``_DEFAULT_N_PREDICT``
    when unset (0). The result is CLAMPED to the effective context window
    ``ctx_size`` so a per-model n-predict can never exceed ``-c`` (which would
    leave no room for the prompt).
    """
    n = int(entry.default_n_predict) or _DEFAULT_N_PREDICT
    # Never let the output cap exceed the context window itself.
    if ctx_size > 0:
        n = min(n, ctx_size)
    return max(1, n)


class SupervisorError(RuntimeError):
    pass


class PortConflictError(SupervisorError):
    pass


class RouterProbeError(SupervisorError):
    """Router process spawned but failed readiness (crashed during load, or the
    /health + /v1/models probe timed out). Distinct from config / pre-spawn
    SupervisorError so self-heal treats it as a CONSUMABLE retry attempt."""


def _port_in_use(port: int, host: str = "127.0.0.1") -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.2)
        try:
            s.bind((host, port))
            return False
        except OSError:
            return True


@dataclass(frozen=True)
class _LaunchPlan:
    chat_entry: ModelEntry | None
    embedding_entry: ModelEntry
    chat_tuned_args: TunedLaunchArgs | None
    chat_rerouted: bool
    reroute_reason: str | None
    fingerprint: str = ""
    ini_contents: str = ""
    expected_model_ids: tuple[str, ...] = ()
    model_paths: tuple[Path, ...] = ()
    chat_ctx_size: int | None = None
    chat_n_predict: int | None = None


@dataclass(frozen=True)
class ReadinessEvidence:
    plan_fingerprint: str
    worker_generation: int
    pid: int
    model_statuses: tuple[tuple[str, str], ...]


class RouterSupervisor:
    """Single owner of the router-mode llama-server process."""

    _ACTIVE_TUNING_FILENAME = "active-llm-tuning.json"

    def __init__(
        self,
        *,
        config: LocalConfig,
        store: Store,
        registry: Registry,
        booster: LocalLLMBooster | None = None,
        hardware: HardwareInfo | None = None,
        hardware_provider: Callable[[], HardwareInfo] | None = None,
        channel: Channel | None = None,
    ) -> None:
        self._cfg = config
        self._store = store
        self._registry = registry
        self._booster = booster
        # ``hardware`` pre-set = tests (and any caller that already probed);
        # production passes a *provider* instead, resolved off the loop on the
        # first launch so construction stays cheap. See resolve_launch_context.
        self._hardware = hardware
        self._hardware_provider = hardware_provider
        self._channel: Channel = channel or detect_channel()
        # llama.cpp's own device listing, and the --main-gpu index the dedicated
        # board sits at within it. None listing = never obtained (keep whatever
        # pin the registry carries); None index with a listing = the board is
        # missing from llama.cpp's view, which must not silently fall back to 0.
        self._device_listing: list[tuple[str, str]] | None = None
        self._main_gpu_index: int | None = None
        # Both role facades are started concurrently (inference_logic._start_phase
        # gathers them), so the one-time resolution below needs its own lock or it
        # runs the device-listing subprocess twice. Separate from self._lock: the
        # resolution happens BEFORE the launch lock is taken.
        self._context_lock = asyncio.Lock()

        self._state = STATE_STOPPED
        self._proc: subprocess.Popen | None = None
        self._port: int | None = None
        self._started_at: float | None = None
        self._last_error: str | None = None
        self._restart_attempts = 0
        self._ready_since: float | None = None
        self._manual_stop = False
        self._log_fp = None
        self._log_path: Path | None = None
        self._watcher_task: asyncio.Task | None = None
        self._lock = asyncio.Lock()
        self._worker_generation = 0

        self._chat_model_id: str | None = None
        self._embedding_model_id: str | None = None
        self._chat_rerouted = False
        self._reroute_reason: str | None = None
        self._model_statuses: dict[str, str] = {}
        self._last_models_status: int | None = None
        self._desired_plan: _LaunchPlan | None = None
        self._active_plan: _LaunchPlan | None = None
        self._previous_known_good_plan: _LaunchPlan | None = None
        # Kept as an alias for focused legacy self-heal tests.
        self._last_plan: _LaunchPlan | None = None

    @property
    def state(self) -> str:
        return self._state

    @property
    def port(self) -> int | None:
        return self._port

    @property
    def pid(self) -> int | None:
        return self._proc.pid if self._proc and self._proc.poll() is None else None

    @property
    def is_chat_rerouted(self) -> bool:
        return self._chat_rerouted

    async def ensure_running(self, plan: _LaunchPlan | None = None) -> ReadinessEvidence:
        await self.resolve_launch_context()
        async with self._lock:
            desired = plan or self._compute_launch_plan()
            self._desired_plan = desired
            if (
                self._state == STATE_READY
                and self._active_plan is not None
                and self._active_plan.fingerprint == desired.fingerprint
            ):
                return self._readiness_evidence()
            if self._state == STATE_STARTING:
                raise SupervisorError("router is starting a different desired launch plan")
            if self._proc is not None or self._active_plan is not None:
                return await self._replace_plan_locked(desired)
            await self._launch(desired, attempt=0)
            return self._readiness_evidence()

    async def replace_plan(self, plan: _LaunchPlan) -> ReadinessEvidence:
        """Replace the worker, restoring the active known-good plan on failure."""
        async with self._lock:
            return await self._replace_plan_locked(plan)

    async def _replace_plan_locked(self, plan: _LaunchPlan) -> ReadinessEvidence:
        previous = self._active_plan
        self._desired_plan = plan
        await self._cancel_watcher()
        await self._terminate_process()
        self._clear_active_identity()
        try:
            await self._launch(plan, attempt=0)
        except Exception:
            if previous is not None:
                self._previous_known_good_plan = previous
                self._desired_plan = previous
                try:
                    await self._launch(previous, attempt=0)
                except Exception as restore_exc:
                    self._last_error = (
                        "candidate failed and previous plan restore failed: "
                        f"{restore_exc}"
                    )
                    raise SupervisorError(self._last_error) from restore_exc
            raise
        self._previous_known_good_plan = previous
        return self._readiness_evidence()

    def _readiness_evidence(self) -> ReadinessEvidence:
        if (
            self._state != STATE_READY
            or self._active_plan is None
            or self.pid is None
        ):
            raise SupervisorError("router has no ready active launch plan")
        return ReadinessEvidence(
            plan_fingerprint=self._active_plan.fingerprint,
            worker_generation=self._worker_generation,
            pid=self.pid,
            model_statuses=tuple(sorted(self._model_statuses.items())),
        )

    async def _cancel_watcher(self) -> None:
        task = self._watcher_task
        self._watcher_task = None
        if task is None or task.done() or task is asyncio.current_task():
            return
        task.cancel()
        with contextlib.suppress(BaseException):
            await task

    def _clear_active_identity(self) -> None:
        self._active_plan = None
        self._last_plan = None
        self._chat_model_id = None
        self._embedding_model_id = None
        self._chat_rerouted = False
        self._reroute_reason = None
        self._model_statuses = {}

    async def stop(self, *, abort_if: Callable[[], bool] | None = None) -> None:
        """Stop the router. ``abort_if`` is re-checked INSIDE the critical section.

        A detached caller can wait on ``self._lock`` for the whole of a
        ``_probe_ready`` model load (``MODEL_LOAD_TIMEOUT_S``, 300 s), so by the
        time it gets in, the reason it wanted the stop may no longer hold. The
        predicate therefore has to run here, after the lock is taken -- evaluating
        it before ``stop()`` is called, or inside the caller's own coroutine before
        it blocks, both read state that is minutes stale by the time it matters.

        Left deliberately domain-agnostic: the caller supplies the intent test (for
        the edge-commit teardown it is "is Edge still the committed primary?"), so
        the supervisor does not need to know about Bundles.

        `_state` is not a usable substitute. A later local switch calls
        ``ensure_running()``, which returns immediately when the server is already
        ``STATE_READY`` -- so it neither relaunches nor changes any counter here.
        A stale stop would then find exactly the state it expected and tear down a
        server the user now wants, and nothing brings it back: this method sets
        ``_manual_stop`` and cancels the watcher, which makes the watchdog return
        early instead of self-healing.
        """
        async with self._lock:
            if abort_if is not None and abort_if():
                logger.info(
                    "RouterSupervisor.stop() aborted: intent no longer holds state={}",
                    self._state,
                )
                return
            self._manual_stop = True
            await self._cancel_watcher()
            await self._terminate_process()
            self._state = STATE_STOPPED
            self._port = None
            self._started_at = None
            self._ready_since = None
            self._clear_active_identity()
            self._desired_plan = None
            self._previous_known_good_plan = None
            self._clear_active_tuning()

    async def restart(self, plan: _LaunchPlan | None = None) -> None:
        await self.resolve_launch_context()
        await self.replace_plan(plan or self._compute_launch_plan())
        self._restart_attempts = 0

    def _active_tuning_path(self) -> Path:
        return self._cfg.data_dir / self._ACTIVE_TUNING_FILENAME

    def _publish_active_tuning(
        self,
        entry: ModelEntry,
        *,
        port: int,
        ctx_size: int,
        n_predict: int,
    ) -> None:
        payload = {
            "model_id": entry.id,
            "role": ROLE_CHAT,
            "port": port,
            "n_predict": n_predict,
            "ctx_size": ctx_size,
            "updated_at": datetime.now().isoformat(timespec="seconds"),
        }
        path = self._active_tuning_path()
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
            tmp.replace(path)
            logger.info(
                "supervisor: published active tuning model={} n_predict={} ctx={} -> {}",
                entry.id,
                n_predict,
                ctx_size,
                path,
            )
        except OSError as exc:
            logger.warning(
                "supervisor: could not publish active tuning to {}: {}", path, exc
            )

    def _clear_active_tuning(self) -> None:
        path = self._active_tuning_path()
        try:
            path.unlink(missing_ok=True)
        except OSError as exc:
            logger.warning(
                "supervisor: could not clear active tuning file {}: {}", path, exc
            )

    def _resolve_active_model_id(self, role: str) -> str:
        key = "active_chat_model_id" if role == ROLE_CHAT else "active_embedding_model_id"
        mid = self._store.get_config(key)
        if not mid:
            raise SupervisorError(f"no active model configured for role={role}")
        return str(mid)

    def _validate_model_for_role(self, role: str, model_id: str | None) -> ModelEntry | None:
        if model_id is None:
            return None
        entry = self._registry.require(model_id)
        if entry.role != role:
            raise SupervisorError(
                f"model {model_id!r} role={entry.role} does not match supervisor role={role}"
            )
        projector_factory = getattr(entry, "mmproj_asset", None)
        projector = projector_factory() if callable(projector_factory) else None
        if projector is not None or getattr(entry, "mmproj_filename", ""):
            raise SupervisorError(
                f"model {model_id!r} declares a projector, but projector launch is unsupported"
            )
        return entry

    async def resolve_launch_context(self) -> None:
        """Resolve the slow, process-lifetime facts the sync plan builders need.

        Both the WMI hardware probe and llama.cpp's device listing block for
        seconds, so neither runs at construction time (``build_app`` must stay
        cheap - see ``deps.build_default_local_deps``) nor inside
        :meth:`_compute_launch_plan`, which is sync and runs on the event loop.
        Every async launch entry point calls this first; results are cached for
        the process, and self-heal relaunches reuse the frozen plan.

        An incomplete (``retryable``) reading is re-read from the provider on every
        call: LLMRouter's background re-probe publishes the recovered reading there,
        and re-reading it costs no probe. While a failed probe has left the reading
        without memory or GPU evidence (``launch_waits_for_reprobe``) no launch
        proceeds: a plan built on it
        has no dedicated-GPU evidence, so a board's model would skip its tuning and
        its ``--main-gpu`` pin and load on device 0.
        """
        async with self._context_lock:
            stale = self._hardware is None or self._hardware.retryable
            if stale and self._hardware_provider is not None:
                provider = self._hardware_provider
                self._hardware = await asyncio.to_thread(provider)
            if self._hardware is not None and launch_waits_for_reprobe(self._hardware):
                raise SupervisorError(
                    "hardware reading incomplete; local launch deferred until LLMRouter "
                    f"reads the hardware ({'; '.join(self._hardware.detection_errors)})"
                )
            await self._resolve_main_gpu_index()

    async def _resolve_main_gpu_index(self) -> None:
        """Find which llama.cpp device index the host's dedicated board is at.

        Only runs on a host that actually has one; UMA boxes keep the registry's
        pin untouched. Fail-soft: when the listing cannot be obtained the pin is
        also left alone, and the mismatch case (listing obtained, board absent
        from it) is refused later in :meth:`_apply_discrete_gpu_pin` where the
        model being launched is known.
        """
        if self._device_listing is not None:
            return
        wanted = present_discrete_gpu_keywords(self._hardware)
        if not wanted:
            return
        try:
            exe = paths.llama_server_exe()
        except FileNotFoundError as exc:
            logger.warning("cannot enumerate llama.cpp devices: {}", exc)
            return
        listing = await asyncio.to_thread(gpu_devices.list_llama_devices, exe)
        if not listing:
            return
        self._device_listing = listing
        self._main_gpu_index = gpu_devices.resolve_device_index(listing, wanted)
        logger.info(
            "llama.cpp devices={} dedicated_board={} resolved main-gpu={}",
            [f"{device_id}:{desc}" for device_id, desc in listing],
            sorted(wanted),
            self._main_gpu_index,
        )

    def _booster_verdict(self, entry: ModelEntry) -> TunedLaunchArgs | LocalUnsupported:
        if self._booster is None or self._hardware is None:
            return TunedLaunchArgs()
        # The dedicated-GPU profile ships enabled: its launch args (kv-unified +
        # one slot per agent leg) are the only way a discrete board is served
        # correctly, so gating them behind an env var left them dead in every
        # real install. The RAM-tier table stays opt-in until it is validated
        # across the UMA fleet - flipping it is a separate rollout decision.
        if (
            not targets_discrete_gpu(entry, self._hardware)
            and (os.environ.get("LRM_BOOSTER") or "").strip() != "1"
        ):
            return TunedLaunchArgs()
        return self._booster.tune(self._hardware, entry)

    def _compute_launch_plan(
        self,
        *,
        chat_model_id: str | None = None,
        embedding_model_id: str | None = None,
    ) -> _LaunchPlan:
        chat_id = chat_model_id or self._resolve_active_model_id(ROLE_CHAT)
        emb_id = embedding_model_id or self._resolve_active_model_id(ROLE_EMBEDDING)

        chat_entry = self._validate_model_for_role(ROLE_CHAT, chat_id)
        emb_entry = self._validate_model_for_role(ROLE_EMBEDDING, emb_id)
        if emb_entry is None:
            raise SupervisorError("no active embedding model configured")

        # Dev-only: a mocked chat model has no weights on this box, so launch
        # embedding-only via the same rerouted plan the booster uses when it
        # declines a chat launch. The embedding role is deliberately still real
        # -- KaLM runs anywhere, and AutoRoute needs genuine 896-dim vectors.
        # Unlike the booster's reroute (which hands chat to the cloud slot),
        # here the data plane keeps serving `local-model`: resolve_primary
        # redirects only the upstream address. Deliberately placed after the
        # role validation above so a typo'd overlay still fails loudly.
        if mock_bundle.mocks_chat_asset(chat_id):
            return self._freeze_plan(_LaunchPlan(
                chat_entry=None,
                embedding_entry=emb_entry,
                chat_tuned_args=None,
                chat_rerouted=True,
                reroute_reason=f"chat model {chat_id!r} is mocked by a remote endpoint",
            ))

        verdict = self._booster_verdict(chat_entry) if chat_entry is not None else TunedLaunchArgs()
        if isinstance(verdict, LocalUnsupported):
            if channel_allows_substitution(self._channel):
                return self._freeze_plan(_LaunchPlan(
                    chat_entry=None,
                    embedding_entry=emb_entry,
                    chat_tuned_args=None,
                    chat_rerouted=True,
                    reroute_reason=verdict.reason,
                ))
            self._state = STATE_ERROR
            self._last_error = verdict.reason
            raise LocalUnsupportedError(verdict.reason)

        return self._freeze_plan(_LaunchPlan(
            chat_entry=chat_entry,
            embedding_entry=emb_entry,
            chat_tuned_args=verdict,
            chat_rerouted=False,
            reroute_reason=None,
        ))

    def _freeze_plan(self, plan: _LaunchPlan) -> _LaunchPlan:
        ini_contents = self._build_ini_contents(plan)
        chat_opts = (
            self._chat_section_options(plan.chat_entry, plan.chat_tuned_args)
            if plan.chat_entry is not None
            else None
        )
        identity = json.dumps(
            {
                "ini": ini_contents,
                "models": [
                    plan.chat_entry.id if plan.chat_entry is not None else None,
                    plan.embedding_entry.id,
                ],
                "assets": [
                    {
                        "id": entry.id,
                        "sha256": entry.sha256,
                        "draft_sha256": entry.draft_sha256,
                    }
                    for entry in (
                        ([plan.chat_entry] if plan.chat_entry is not None else [])
                        + [plan.embedding_entry]
                    )
                ],
                "rerouted": plan.chat_rerouted,
            },
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        return _LaunchPlan(
            chat_entry=plan.chat_entry,
            embedding_entry=plan.embedding_entry,
            chat_tuned_args=plan.chat_tuned_args,
            chat_rerouted=plan.chat_rerouted,
            reroute_reason=plan.reroute_reason,
            fingerprint=hashlib.sha256(identity).hexdigest(),
            ini_contents=ini_contents,
            expected_model_ids=tuple(
                model_id
                for model_id in (
                    plan.chat_entry.id if plan.chat_entry is not None else None,
                    plan.embedding_entry.id,
                )
                if model_id is not None
            ),
            model_paths=tuple(
                self._cfg.models_dir / entry.id / entry.filename
                for entry in (
                    ([plan.chat_entry] if plan.chat_entry is not None else [])
                    + [plan.embedding_entry]
                )
            ),
            chat_ctx_size=int(chat_opts["c"]) if chat_opts is not None else None,
            chat_n_predict=(
                int(chat_opts["n-predict"]) if chat_opts is not None else None
            ),
        )

    def _ini_path(self) -> Path:
        return self._cfg.data_dir / "llama-router.ini"

    @staticmethod
    def _set_opt(opts: OrderedDict[str, str], key: str, value: str | bool | int | float) -> None:
        if isinstance(value, bool):
            opts[key] = "true" if value else "false"
        else:
            opts[key] = str(value)

    def _apply_cli_args_to_opts(self, opts: OrderedDict[str, str], args: list[str]) -> None:
        i = 0
        while i < len(args):
            token = args[i]
            if not token.startswith("-"):
                i += 1
                continue
            key = token.lstrip("-")
            if i + 1 < len(args) and not args[i + 1].startswith("-"):
                self._set_opt(opts, key, args[i + 1])
                i += 2
                continue
            self._set_opt(opts, key, True)
            i += 1

    def _apply_draft_model(self, opts: OrderedDict[str, str], entry: ModelEntry) -> None:
        """Point ``--spec-draft-model`` at the draft GGUF beside the model's own.

        The registry names the draft by FILENAME so the entry stays valid on any
        install root; the path is resolved here against the same per-model
        directory the main GGUF lives in.

        The downloader fetches the draft together with the model whenever the
        registry declares a downloadable draft source. A missing declared draft changes the
        serving variant, so activation fails instead of silently launching a
        different text-only plan.
        """
        if not entry.draft_filename:
            return
        draft_path = self._cfg.models_dir / entry.id / entry.draft_filename
        if draft_path.is_file():
            self._set_opt(opts, "spec-draft-model", str(draft_path))
            return
        raise SupervisorError(
            f"model {entry.id!r} declares speculative draft but file is missing: {draft_path}"
        )

    def _chat_section_options(
        self, entry: ModelEntry, tuned_args: TunedLaunchArgs | None
    ) -> OrderedDict[str, str]:
        opts: OrderedDict[str, str] = OrderedDict()
        self._set_opt(opts, "model", str(self._cfg.models_dir / entry.id / entry.filename))
        # Per-model context window comes from the registry (default_ctx); the
        # booster may shrink it below on constrained hardware (see tuned_args).
        self._set_opt(opts, "c", entry.default_ctx)
        self._set_opt(opts, "n-gpu-layers", entry.default_ngl)
        self._set_opt(opts, "flash-attn", True)
        # n-predict is set LAST (after tuned_args may shrink -c) so the per-model
        # output cap is clamped to the EFFECTIVE context window. See below.
        # Sampling — Qwen's published instruct recipe except for temp, which is 0.
        # A tools request installs a GBNF grammar, and llama.cpp samples first and
        # only then checks the token against it (common/sampling.cpp): while the
        # output is inside a tool call the grammar admits very few tokens, so a
        # temp>0 pick off the top-k is usually illegal and falls into the expensive
        # resample - a full 151k-candidate grammar filter plus the whole sampler
        # chain again - for every DRAFTED token. Replaying one recorded agent
        # request: temp 0.7 -> 25.7 t/s, temp 0 -> 103.4 t/s (4.0x). Neither tools
        # alone nor temp>0 alone costs anything; it is the interaction with
        # speculative decoding, whose greedy fast path a grammar disables.
        # presence-penalty stays on to guard the repetition greedy decoding invites.
        self._set_opt(opts, "temp", "0")
        self._set_opt(opts, "top-p", "0.80")
        self._set_opt(opts, "top-k", "20")
        self._set_opt(opts, "min-p", "0.00")
        self._set_opt(opts, "presence-penalty", "1.5")
        self._set_opt(opts, "repeat-penalty", "1.0")
        # Reproducibility + reasoning off (matches E:/models/start_llama_gemma.sh).
        self._set_opt(opts, "seed", 3407)
        self._set_opt(opts, "reasoning", "off")
        self._set_opt(opts, "reasoning-budget", 0)
        self._set_opt(opts, "jinja", True)
        self._set_opt(opts, "chat-template-kwargs", '{"enable_thinking":false}')
        # Slot count, kv-unified and the slot-similarity threshold are memory-topology
        # decisions, so they come from the booster (see tuned_args below) rather than
        # from this baseline: a shared-memory iGPU cannot afford what a discrete board
        # can. Putting them here would have applied a 3.4 GiB recurrent-state buffer
        # to every tier.
        self._set_opt(opts, "parallel", 1)
        self._set_opt(opts, "cache-reuse", 256)
        # Batch + KV-cache tuning: larger (u)batch and no-mmap for the SYCL build.
        # KV cache is f16 (NOT quantized). Benchmarking on the Arc B390 SYCL
        # backend showed q8_0 KV is ~4-5x SLOWER than f16 at depth: quantized KV
        # must be de-quantized every attention step, and that dequant path on this
        # backend costs more than the bandwidth saved. With q8_0, decode at ~80k
        # ctx was ~5.5 tok/s (7.5x decay across 1k->100k); with f16 it is ~25 tok/s
        # (only 1.8x decay). f16 uses ~2x the KV VRAM but fits comfortably (loaded
        # at 100k ctx with headroom). See decodeTPS analysis. extra_args below can
        # still override per-model.
        self._set_opt(opts, "b", 2048)
        self._set_opt(opts, "ub", 2048)
        self._set_opt(opts, "cache-type-k", "f16")
        self._set_opt(opts, "cache-type-v", "f16")
        # cache-ram=0 disables the CPU KV-cache RAM pool. With the KV cache
        # already living on the accelerator, the RAM pool ends up double-
        # buffering hot state and hurts throughput on `--parallel 1` sessions.
        # Tuner-supplied cache_ram_mib below still overrides when set.
        self._set_opt(opts, "cache-ram", 0)
        self._set_opt(opts, "cms", 512)
        self._set_opt(opts, "no-mmap", True)
        # With ngl 99 the CPU threads have almost nothing to do, but Intel OpenMP
        # still spins them: a VTune capture of llama-server during an agent task
        # showed libiomp5md at 89% of process CPU with ZERO effective time
        # (646 s spin + 181 s thread creation in a 240 s window, ~3.4 cores).
        # Decode is identical from t=1 to t=16 (31.0 t/s at d8192 either way), so
        # the wide pool only steals cores from the agent. No booster
        # tier lowers n-gpu-layers, so this holds for every tier.
        self._set_opt(opts, "t", 4)
        self._set_opt(opts, "load-on-startup", True)
        self._apply_cli_args_to_opts(opts, list(entry.extra_args))
        if "load-mode" in opts:
            # Newer CUDA runtimes replaced --no-mmap with --load-mode.
            opts.pop("no-mmap", None)
        self._apply_discrete_gpu_pin(opts, entry)
        self._apply_draft_model(opts, entry)
        if tuned_args is not None:
            if tuned_args.ctx_size is not None:
                self._set_opt(opts, "c", tuned_args.ctx_size)
            if tuned_args.n_gpu_layers is not None:
                self._set_opt(opts, "n-gpu-layers", tuned_args.n_gpu_layers)
            if tuned_args.parallel is not None:
                self._set_opt(opts, "parallel", tuned_args.parallel)
            if tuned_args.cache_ram_mib is not None:
                self._set_opt(opts, "cache-ram", tuned_args.cache_ram_mib)
            if tuned_args.slot_prompt_similarity is not None:
                self._set_opt(
                    opts,
                    "slot-prompt-similarity",
                    f"{tuned_args.slot_prompt_similarity:.2f}",
                )
            if tuned_args.kv_unified:
                self._set_opt(opts, "kv-unified", True)
            if tuned_args.batch is not None:
                self._set_opt(opts, "b", tuned_args.batch)
            if tuned_args.ubatch is not None:
                self._set_opt(opts, "ub", tuned_args.ubatch)
        # Local context-size override layer (experiment knob). Applied AFTER
        # the booster so an operator can explicitly override the hardware
        # safety net during experiments. Two precedence steps:
        #   1. Store key ``local_ctx_size_override`` — set via
        #      ``PUT /llm-router/v1/local/ctx-size``, persists across restarts.
        #   2. env ``LATENTFACTOR_LOCAL_CTX`` — trumps the Store (pinchbench
        #      sweep sets it in the shell without touching persisted state).
        # See routing/policy/gates.py::resolve_ctx_size for the env parser.
        store_override = self._read_store_ctx_override()
        if store_override is not None:
            self._set_opt(opts, "c", store_override)
        from ..routing.policy.gates import resolve_ctx_size_env
        final_ctx = resolve_ctx_size_env(default=int(opts["c"]))
        self._set_opt(opts, "c", final_ctx)
        # Per-model output cap, resolved against the FINAL context window (after
        # any booster shrink of -c above) so a large n-predict can never exceed
        # the served context.
        self._set_opt(opts, "n-predict", _resolve_n_predict(entry, int(opts["c"])))
        return opts

    def _apply_discrete_gpu_pin(self, opts: OrderedDict[str, str], entry: ModelEntry) -> None:
        """Repoint ``--main-gpu`` at the board *entry* targets, resolved by name.

        The registry can only carry a fixed index, and index 0 is not
        necessarily the dedicated board: WMI and the SYCL backend enumerate
        adapters independently, so on a host with both an iGPU and a discrete
        board the registry's ``0`` can be the iGPU - which would put a 19 GB
        model on shared memory. When llama.cpp does report a listing but the
        targeted board is not in it, refuse the launch rather than run on
        whatever device 0 happens to be.
        """
        if not targets_discrete_gpu(entry, self._hardware):
            return
        if not self._device_listing:
            logger.warning(
                "model {} targets a dedicated GPU but llama.cpp devices could not "
                "be enumerated; keeping the registry --main-gpu={} pin",
                entry.id,
                opts.get("main-gpu", "<unset>"),
            )
            return
        if self._main_gpu_index is None:
            raise SupervisorError(
                f"model {entry.id!r} targets a dedicated GPU "
                f"({', '.join(sorted(present_discrete_gpu_keywords(self._hardware)))}) "
                f"but llama.cpp enumerated only "
                f"[{', '.join(desc for _, desc in self._device_listing)}]; "
                "refusing to launch on the wrong device"
            )
        self._set_opt(opts, "main-gpu", self._main_gpu_index)

    def _discrete_gpu_pin(self, chat_entry: ModelEntry | None) -> int | None:
        """The ``--main-gpu`` index the embedding model must follow, if any.

        Both models live in one llama-server process but are pinned per-INI
        section, so the embedding model has to land on the same board the chat
        model was pinned to. ``None`` = leave the registry's pin alone.
        """
        if chat_entry is None or not targets_discrete_gpu(chat_entry, self._hardware):
            return None
        return self._main_gpu_index if self._device_listing else None

    def _read_store_ctx_override(self) -> int | None:
        """Read ``local_ctx_size_override`` from the Store. Returns None when
        unset, unreachable, or out of range — the caller falls through to
        registry ``default_ctx`` + booster. Out-of-range values (from an
        older build without bounds, or from a direct-API caller pre-fix) are
        ignored here so a poisoned Store cannot wedge the boot cycle. Never
        raises."""
        from ..routing.local_ctx_api import (
            MAX_CTX_SIZE,
            MIN_CTX_SIZE,
            is_valid_persisted_ctx_size,
        )
        try:
            v = self._store.get_config("local_ctx_size_override")
        except Exception:  # noqa: BLE001
            return None
        if v is None:
            return None
        try:
            n = int(v)
        except (TypeError, ValueError):
            logger.warning(
                "supervisor: bad Store[local_ctx_size_override]={!r}; ignoring", v,
            )
            return None
        if not is_valid_persisted_ctx_size(n):
            logger.warning(
                "supervisor: out-of-range Store[local_ctx_size_override]={} "
                "(allowed {}-{}); ignoring",
                n, MIN_CTX_SIZE, MAX_CTX_SIZE,
            )
            return None
        return n

    def _embedding_section_options(
        self, entry: ModelEntry, *, main_gpu_index: int | None = None
    ) -> OrderedDict[str, str]:
        opts: OrderedDict[str, str] = OrderedDict()
        self._set_opt(opts, "model", str(self._cfg.models_dir / entry.id / entry.filename))
        self._set_opt(opts, "c", entry.default_ctx)
        self._set_opt(opts, "n-gpu-layers", entry.default_ngl)
        self._set_opt(opts, "embeddings", True)
        self._set_opt(opts, "ub", 8192)
        self._set_opt(opts, "b", 8192)
        self._set_opt(opts, "t", 2)
        self._set_opt(opts, "load-on-startup", True)
        self._apply_cli_args_to_opts(opts, list(entry.extra_args))
        if main_gpu_index is not None:
            self._set_opt(opts, "main-gpu", main_gpu_index)
        return opts

    def _build_ini_contents(self, plan: _LaunchPlan) -> str:
        if plan.ini_contents:
            return plan.ini_contents
        lines = ["version = 1", ""]
        sections: list[tuple[str, OrderedDict[str, str]]] = []
        if plan.chat_entry is not None:
            sections.append(
                (
                    plan.chat_entry.id,
                    self._chat_section_options(plan.chat_entry, plan.chat_tuned_args),
                )
            )
        sections.append(
            (
                plan.embedding_entry.id,
                self._embedding_section_options(
                    plan.embedding_entry,
                    main_gpu_index=self._discrete_gpu_pin(plan.chat_entry),
                ),
            )
        )
        for index, (section_name, opts) in enumerate(sections):
            lines.append(f"[{section_name}]")
            for key, value in opts.items():
                lines.append(f"{key} = {value}")
            if index != len(sections) - 1:
                lines.append("")
        return "\n".join(lines) + "\n"

    def _write_ini(self, contents: str) -> Path:
        path = self._ini_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(contents, encoding="utf-8")
        section_names = re.findall(r"^\[([^\]]+)\]", contents, flags=re.MULTILINE)
        logger.info(
            "llama-router INI written path={} sections={} lines={}",
            path,
            section_names,
            contents.count("\n"),
        )
        return path

    def _child_port(self) -> int:
        """Port the child llama-server binds.

        Normally the same port LRM proxies to. The ``LRM_LLAMA_SPAWN_PORT``
        diagnostic hook moves ONLY the child, leaving ``llama_router_port`` free
        for a recording proxy to sit between LRM and llama-server. Everything
        that talks to the child directly - the pre-flight port-conflict check
        and the readiness probe - must therefore follow the child here, while
        the client-facing ``self._port`` stays on ``llama_router_port``.
        """
        spawn_port = os.environ.get("LRM_LLAMA_SPAWN_PORT", "").strip()
        if spawn_port.isdigit():
            return int(spawn_port)
        return self._cfg.llama_router_port

    def _build_cmd(self, ini_path: Path, exe: Path) -> list[str]:
        cmd = [
            str(exe),
            "--no-webui",
            "--host",
            self._cfg.llama_bind_host,
            "--port",
            str(self._child_port()),
            "--models-preset",
            str(ini_path),
            "--models-max",
            "2",
        ]
        if _llama_metrics_enabled():
            cmd.append("--metrics")
        # Diagnostic escape hatch: llama-server's speculative per-phase timings
        # (common_speculative_print_stats -> "dur(b,g,a)") are emitted at trace
        # level only, so they need -lv 4. Off unless explicitly asked for, since
        # trace logging is heavy.
        verbosity = os.environ.get("LRM_LLAMA_LOG_VERBOSITY", "").strip()
        if verbosity.isdigit():
            cmd += ["-lv", verbosity]
        return cmd

    def _open_log(self) -> Path:
        self._cfg.llama_log_dir.mkdir(parents=True, exist_ok=True)
        # Close any prior handle before opening a new one. The _watch self-heal
        # path relaunches via _launch -> _open_log WITHOUT going through
        # _terminate_process (which is what closes + nulls self._log_fp), so
        # without this a crash-and-restart cycle would overwrite the attribute
        # and leak the previous file descriptor on every restart.
        if self._log_fp is not None:
            with contextlib.suppress(Exception):
                self._log_fp.close()
            self._log_fp = None
        ts = datetime.now().strftime("%Y%m%dT%H%M%S")
        log_path = self._cfg.llama_log_dir / f"llama-router-{ts}.log"
        self._log_fp = open(log_path, "ab", buffering=0)
        self._log_path = log_path
        return log_path

    async def _launch(self, plan: _LaunchPlan, *, attempt: int) -> None:
        port = self._cfg.llama_router_port
        child_port = self._child_port()
        if _port_in_use(child_port, self._cfg.llama_bind_host):
            self._state = STATE_ERROR
            self._last_error = f"port {child_port} already in use"
            raise PortConflictError(self._last_error)

        try:
            exe = paths.llama_server_exe()
        except FileNotFoundError as exc:
            self._state = STATE_ERROR
            self._last_error = str(exc)
            raise SupervisorError(self._last_error) from exc

        for model_path in plan.model_paths:
            if not model_path.exists():
                self._state = STATE_ERROR
                self._last_error = f"model file missing: {model_path}"
                raise SupervisorError(self._last_error)

        ini_contents = self._build_ini_contents(plan)
        ini_path = self._write_ini(ini_contents)
        cmd = self._build_cmd(ini_path, exe)
        log_path = self._open_log()
        logger.info(
            "launching llama-router port={} models={} log={} rerouted_chat={} attempt={}",
            port,
            list(plan.expected_model_ids),
            log_path,
            plan.chat_rerouted,
            attempt,
        )
        logger.info("llamacpp router command: {}", _format_cmd_for_log(cmd))

        self._state = STATE_STARTING
        self._port = port
        self._started_at = time.monotonic()
        self._last_error = None
        self._manual_stop = False
        self._model_statuses = {}

        creation = int(getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0) | getattr(subprocess, "CREATE_NO_WINDOW", 0))
        child_env = dict(os.environ)
        child_env.pop("SERVICEHUB_MANAGED", None)
        child_env.pop("SERVICEHUB_PROCESS_CREDENTIAL", None)
        child_env["LLAMA_API_KEY"] = llama_api_key()

        spawn_t0 = time.monotonic()
        self._proc = await asyncio.to_thread(
            subprocess.Popen,
            cmd,
            stdout=self._log_fp,
            stderr=subprocess.STDOUT,
            env=child_env,
            creationflags=creation,
            close_fds=True,
        )
        self._worker_generation += 1
        generation = self._worker_generation
        proc = self._proc
        _assign_to_job(self._proc)
        logger.info(
            "startup step complete step=llama_spawn pid={} port={} attempt={} duration_ms={}",
            self._proc.pid,
            child_port,
            attempt,
            round((time.monotonic() - spawn_t0) * 1000),
        )

        expected_ids = list(plan.expected_model_ids)
        statuses = await self._probe_ready(child_port, expected_ids)
        if statuses is None:
            await self._terminate_process()
            self._state = STATE_ERROR
            self._last_error = self._last_error or "router health probe timed out"
            raise RouterProbeError(self._last_error)

        try:
            await verify_key_enforced(self._probe_host(), child_port)
        except KeyNotEnforcedError as exc:
            await self._terminate_process()
            self._state = STATE_ERROR
            self._last_error = str(exc)
            logger.error("{}", self._last_error)
            # A status other than 401 is permanent: relaunching the same binary cannot help.
            raise (RouterProbeError if exc.retryable else SupervisorError)(self._last_error) from exc

        self._model_statuses = statuses
        self._active_plan = plan
        self._last_plan = plan
        self._chat_model_id = plan.chat_entry.id if plan.chat_entry is not None else None
        self._embedding_model_id = plan.embedding_entry.id
        self._chat_rerouted = plan.chat_rerouted
        self._reroute_reason = plan.reroute_reason
        self._state = STATE_READY
        self._ready_since = time.monotonic()

        if plan.chat_entry is not None:
            self._publish_active_tuning(
                plan.chat_entry,
                port=port,
                ctx_size=plan.chat_ctx_size or 0,
                n_predict=plan.chat_n_predict or 0,
            )
        else:
            self._clear_active_tuning()

        await self._cancel_watcher()
        self._watcher_task = asyncio.create_task(
            self._watch(generation, proc.pid, plan.fingerprint),
            name="llama-router-watch",
        )

    def _probe_host(self) -> str:
        """Client-reachable host for the local health / model-status probes.

        ``llama-server`` binds ``llama_bind_host`` (default ``127.0.0.1``). A
        wildcard bind (``0.0.0.0`` / ``::``) is reached over loopback, so map it
        to ``127.0.0.1``; any explicit interface is probed as-is, consistent with
        ``_port_in_use(..., self._cfg.llama_bind_host)`` at launch.
        """
        host = self._cfg.llama_bind_host
        return "127.0.0.1" if host in ("", "0.0.0.0", "::") else host

    async def _fetch_model_statuses(
        self, client: httpx.AsyncClient, port: int
    ) -> dict[str, str]:
        response = await client.get(f"http://{self._probe_host()}:{port}/v1/models")
        if response.status_code != 200:
            if response.status_code != self._last_models_status:
                logger.warning(
                    "router /v1/models probe returned HTTP {} (expected 200)",
                    response.status_code,
                )
            self._last_models_status = response.status_code
            return {}
        self._last_models_status = None
        try:
            payload = response.json()
        except ValueError:
            return {}
        statuses: dict[str, str] = {}
        for row in payload.get("data", []) or []:
            model_id = row.get("id")
            if not isinstance(model_id, str):
                continue
            status_obj = row.get("status") or {}
            status_value = status_obj.get("value")
            if isinstance(status_value, str):
                statuses[model_id] = status_value.lower()
        return statuses

    async def _probe_ready(
        self, port: int, expected_ids: list[str]
    ) -> dict[str, str] | None:
        # Two-tier readiness (issue #1616): the router must become *reachable*
        # (health 200 seen at least once) within the short reachability budget,
        # but once reachable, its models get the far longer model-load budget to
        # finish loading. A slow 35B load must NOT be killed for exceeding the
        # reachability budget while it is still actively loading.
        health_timeout, load_timeout = _resolve_probe_timeouts()
        start = time.monotonic()
        reachable_deadline = start + health_timeout
        load_deadline = start + load_timeout
        health_url = f"http://{self._probe_host()}:{port}/health"
        # Use the CIDR-aware proxy-bypass client: a bare httpx client inherits
        # HTTP_PROXY from the env and routes this loopback probe through the
        # corporate proxy (httpx does not honor a 127.0.0.0/8 NO_PROXY CIDR),
        # which 403s the probe forever and gets a healthy router killed.
        last_bad_status: int | None = None
        reachable = False
        # Per-role load time. llama-server answers /health before the weights
        # finish loading, so the roles go LOADED at different instants and each
        # one's cost has to be captured as it happens rather than at the end.
        timed_roles: set[str] = set()
        role_by_model = {self._role_model_id(role): role for role in (ROLE_CHAT, ROLE_EMBEDDING)}
        async with build_async_client_for_url(
            health_url, timeout=2.0, headers=llama_auth_headers()
        ) as client:
            while time.monotonic() < load_deadline:
                if self._proc and self._proc.poll() is not None:
                    self._last_error = f"process exited early with code {self._proc.returncode}"
                    return None
                try:
                    health = await client.get(health_url)
                    if health.status_code == 200:
                        reachable = True
                        last_bad_status = None
                        statuses = await self._fetch_model_statuses(client, port)
                        for model_id in expected_ids:
                            if statuses.get(model_id) != _MODEL_STATUS_LOADED:
                                continue
                            role = role_by_model.get(model_id)
                            if role is None or role in timed_roles:
                                continue
                            timed_roles.add(role)
                            logger.info(
                                "startup step complete step=llama_role_healthy role={} model_id={} port={} duration_ms={}",
                                role,
                                model_id,
                                port,
                                round((time.monotonic() - start) * 1000),
                            )
                        if all(
                            statuses.get(model_id) == _MODEL_STATUS_LOADED
                            for model_id in expected_ids
                        ):
                            return statuses
                        self._model_statuses = statuses
                    elif health.status_code != last_bad_status:
                        # Throttle: log once per distinct status. A persistent
                        # non-200 (e.g. 403) on a loopback health probe almost
                        # always means the request is being intercepted by a
                        # proxy rather than reaching llama-server.
                        last_bad_status = health.status_code
                        logger.warning(
                            "router health probe returned HTTP {} for {} "
                            "(expected 200; a non-200 on loopback usually means "
                            "proxy interception)",
                            health.status_code,
                            health_url,
                        )
                        self._last_error = f"router health probe HTTP {health.status_code}"
                except (httpx.ConnectError, httpx.ReadError, httpx.RemoteProtocolError):
                    pass
                except httpx.HTTPError as exc:
                    self._last_error = f"router probe error: {exc}"
                # Fail fast only when the router never became reachable: a process
                # that is up but not serving /health within the reachability
                # budget is wedged, not slow-loading. Once reachable, keep waiting
                # for the models up to the (much longer) load budget.
                if not reachable and time.monotonic() >= reachable_deadline:
                    self._last_error = (
                        self._last_error
                        or f"router did not become reachable within {health_timeout:.0f}s"
                    )
                    return None
                await asyncio.sleep(0.5)
        missing = [
            model_id
            for model_id in expected_ids
            if self._model_statuses.get(model_id) != _MODEL_STATUS_LOADED
        ]
        if missing:
            self._last_error = (
                f"router ready but models not loaded within {load_timeout:.0f}s: "
                f"{missing}"
            )
        return None

    async def _refresh_model_statuses(self) -> None:
        if self._port is None:
            return
        # Child-state poll, so it follows the child port (see _child_port), not
        # the client-facing self._port.
        # Proxy-bypass client for the loopback /v1/models poll; see _probe_ready.
        child_port = self._child_port()
        models_url = f"http://{self._probe_host()}:{child_port}/v1/models"
        try:
            async with build_async_client_for_url(
                models_url, timeout=2.0, headers=llama_auth_headers()
            ) as client:
                self._model_statuses = await self._fetch_model_statuses(client, child_port)
        except httpx.HTTPError:
            pass

    def _maybe_reset_restart_budget(self) -> None:
        """Reset the self-heal budget only after the process has stayed READY for
        RESTART_STABILITY_S, so the N-in-a-row limit engages for crash-after-ready loops."""
        if (
            self._state == STATE_READY
            and self._restart_attempts > 0
            and self._ready_since is not None
            and (time.monotonic() - self._ready_since) >= RESTART_STABILITY_S
        ):
            logger.info(
                "llama-router stable for >= {:.0f}s; resetting restart budget",
                RESTART_STABILITY_S,
            )
            self._restart_attempts = 0

    async def _run_self_heal(
        self,
        rc: int | None,
        *,
        generation: int | None = None,
        pid: int | None = None,
        fingerprint: str | None = None,
    ) -> None:
        """Relaunch with backoff until the process comes up or the budget is
        exhausted. A relaunch that spawns but fails readiness (RouterProbeError,
        the start->load->crash shape) CONSUMES an attempt and we keep retrying.
        A permanent pre-spawn failure (port conflict, missing exe/model)
        short-circuits to STATE_ERROR - retrying cannot help."""
        plan = self._active_plan or self._last_plan
        if plan is None:
            self._state = STATE_ERROR
            self._last_error = "no active launch plan available for self-heal"
            return
        expected_generation = generation
        while True:
            if generation is not None:
                if expected_generation == generation:
                    if not self._watcher_matches(generation, pid, fingerprint):
                        return
                elif (
                    self._worker_generation != expected_generation
                    or self._active_plan is not plan
                    or self._desired_plan is not plan
                ):
                    return
            if self._restart_attempts >= MAX_RESTART_ATTEMPTS:
                self._state = STATE_ERROR
                self._last_error = f"crashed (exit={rc}); exhausted restart attempts"
                return
            backoff = RESTART_BACKOFFS[
                min(self._restart_attempts, len(RESTART_BACKOFFS) - 1)
            ]
            self._restart_attempts += 1
            await asyncio.sleep(backoff)
            if generation is not None and self._desired_plan is not plan:
                return
            try:
                await self._launch(plan, attempt=self._restart_attempts)
            except RouterProbeError as exc:
                expected_generation = self._worker_generation
                logger.warning(
                    "router self-heal relaunch failed readiness (attempt={}): {}",
                    self._restart_attempts,
                    exc,
                )
                continue
            except Exception as exc:  # noqa: BLE001  -- permanent / non-retryable
                logger.exception("router self-heal launch failed permanently: {}", exc)
                self._state = STATE_ERROR
                self._last_error = str(exc)
                return
            else:
                # Relaunch succeeded: _launch spawned a fresh process and started a
                # new watcher task (cancelling this one). Hand off.
                return

    def _watcher_matches(
        self, generation: int, pid: int | None, fingerprint: str | None
    ) -> bool:
        return (
            self._worker_generation == generation
            and self._proc is not None
            and self._proc.pid == pid
            and self._active_plan is not None
            and self._active_plan.fingerprint == fingerprint
            and self._desired_plan is not None
            and self._desired_plan.fingerprint == fingerprint
        )

    async def _watch(
        self,
        generation: int | None = None,
        pid: int | None = None,
        fingerprint: str | None = None,
    ) -> None:
        try:
            legacy_unfenced = generation is None and pid is None and fingerprint is None
            generation = self._worker_generation if generation is None else generation
            pid = self._proc.pid if pid is None and self._proc is not None else pid
            fingerprint = (
                self._active_plan.fingerprint
                if fingerprint is None and self._active_plan is not None
                else fingerprint
            )
            refresh_every = 5
            ticks = 0
            while True:
                await asyncio.sleep(1.0)
                if legacy_unfenced:
                    if self._proc is None:
                        return
                elif not self._watcher_matches(generation, pid, fingerprint):
                    return
                rc = self._proc.poll()
                if rc is None:
                    ticks += 1
                    self._maybe_reset_restart_budget()
                    if self._state == STATE_READY and ticks % refresh_every == 0:
                        await self._refresh_model_statuses()
                    continue
                if self._manual_stop:
                    return
                self._ready_since = None
                logger.warning(
                    "llama-router exited unexpectedly code={}; attempt={}",
                    rc,
                    self._restart_attempts + 1,
                )
                if legacy_unfenced:
                    await self._run_self_heal(rc)
                else:
                    await self._run_self_heal(
                        rc, generation=generation, pid=pid, fingerprint=fingerprint
                    )
                return
        except asyncio.CancelledError:
            return

    async def _terminate_process(self) -> None:
        if self._proc is None:
            return
        try:
            if self._proc.poll() is None:
                self._proc.terminate()
                try:
                    await asyncio.wait_for(
                        asyncio.to_thread(self._proc.wait), timeout=GRACEFUL_STOP_S
                    )
                except asyncio.TimeoutError:
                    self._proc.kill()
                    await asyncio.to_thread(self._proc.wait)
        finally:
            self._proc = None
            if self._log_fp is not None:
                with contextlib.suppress(Exception):
                    self._log_fp.close()
                self._log_fp = None
                self._log_path = None

    def _role_model_id(self, role: str) -> str | None:
        return self._chat_model_id if role == ROLE_CHAT else self._embedding_model_id

    def _role_state(self, role: str) -> str:
        if self._state == STATE_STOPPED:
            return STATE_STOPPED
        if self._state == STATE_ERROR:
            return STATE_ERROR
        if role == ROLE_CHAT and self._chat_rerouted:
            return STATE_REROUTED if self._state == STATE_READY else self._state
        if self._state == STATE_STARTING:
            return STATE_STARTING

        model_id = self._role_model_id(role)
        if not model_id:
            return STATE_ERROR
        model_status = self._model_statuses.get(model_id)
        if model_status == _MODEL_STATUS_LOADED:
            return STATE_READY
        if model_status == _MODEL_STATUS_LOADING:
            return STATE_STARTING
        if model_status == _MODEL_STATUS_UNLOADED:
            return STATE_ERROR
        return STATE_ERROR if self._state == STATE_READY else self._state

    def role_snapshot(self, role: str) -> dict[str, Any]:
        if role not in VALID_ROLES:
            raise ValueError(f"invalid role: {role!r}")
        return {
            "role": role,
            "state": self._role_state(role),
            "model_id": self._role_model_id(role),
            "port": self._port,
            "pid": self.pid,
            "uptime": (time.monotonic() - self._started_at) if self._started_at else None,
            "restart_attempts": self._restart_attempts,
            "last_error": self._last_error,
            "log_path": self._log_path,
        }


class _RoleSupervisorFacade:
    """Per-role compatibility shim over the shared RouterSupervisor."""

    def __init__(self, *, role: str, router: RouterSupervisor) -> None:
        if role not in VALID_ROLES:
            raise ValueError(f"invalid role: {role!r}")
        self._role = role
        self._router = router

    @property
    def role(self) -> str:
        return self._role

    @property
    def state(self) -> str:
        return self._router._role_state(self._role)

    @property
    def port(self) -> int | None:
        return self._router.port

    @property
    def is_rerouted(self) -> bool:
        return self._role == ROLE_CHAT and self._router.is_chat_rerouted

    async def start(self, *, model_id: str | None = None) -> None:
        # Hardware + device-index resolution must precede any plan computation:
        # _compute_launch_plan is sync and reads both (see resolve_launch_context).
        await self._router.resolve_launch_context()
        entry = self._router._validate_model_for_role(self._role, model_id)
        plan = None
        if entry is not None:
            plan = self._router._compute_launch_plan(
                chat_model_id=entry.id if self._role == ROLE_CHAT else None,
                embedding_model_id=entry.id if self._role == ROLE_EMBEDDING else None,
            )
        await self._router.ensure_running(plan)
        if self._role == ROLE_CHAT and self._router.is_chat_rerouted:
            raise LocalLlmRerouted(self._router._reroute_reason or "local chat rerouted")

    async def stop(self, *, abort_if: Callable[[], bool] | None = None) -> None:
        # Every `chat_sup.stop()` / `embedding_sup.stop()` call from any
        # endpoint funnels through here — log the immediate caller so a
        # "why did llama-server just stop" report can be traced to the exact
        # endpoint/line without needing per-call-site instrumentation.
        caller = traceback.extract_stack()[-2]
        logger.info(
            "RouterSupervisor.stop() requested role={} caller={}:{} in {}()",
            self._role,
            caller.filename,
            caller.lineno,
            caller.name,
        )
        await self._router.stop(abort_if=abort_if)

    async def restart(self, *, model_id: str | None = None) -> None:
        await self._router.resolve_launch_context()
        entry = self._router._validate_model_for_role(self._role, model_id)
        plan = None
        if entry is not None:
            plan = self._router._compute_launch_plan(
                chat_model_id=entry.id if self._role == ROLE_CHAT else None,
                embedding_model_id=entry.id if self._role == ROLE_EMBEDDING else None,
            )
        await self._router.restart(plan)
        if self._role == ROLE_CHAT and self._router.is_chat_rerouted:
            raise LocalLlmRerouted(self._router._reroute_reason or "local chat rerouted")

    async def replace_models(
        self, *, chat_model_id: str, embedding_model_id: str
    ) -> ReadinessEvidence:
        """Replace the shared worker with one immutable two-role launch plan."""
        await self._router.resolve_launch_context()
        plan = self._router._compute_launch_plan(
            chat_model_id=chat_model_id,
            embedding_model_id=embedding_model_id,
        )
        return await self._router.replace_plan(plan)

    async def restore_previous_plan(self) -> ReadinessEvidence | None:
        """Restore the plan active immediately before the latest replacement."""
        previous = self._router._previous_known_good_plan
        if previous is None:
            await self._router.stop()
            return None
        evidence = await self._router.replace_plan(previous)
        self._router._previous_known_good_plan = None
        return evidence

    def snapshot(self) -> dict[str, Any]:
        return self._router.role_snapshot(self._role)


def make_role_facades(router: RouterSupervisor) -> dict[str, _RoleSupervisorFacade]:
    return {
        ROLE_CHAT: _RoleSupervisorFacade(role=ROLE_CHAT, router=router),
        ROLE_EMBEDDING: _RoleSupervisorFacade(role=ROLE_EMBEDDING, router=router),
    }
