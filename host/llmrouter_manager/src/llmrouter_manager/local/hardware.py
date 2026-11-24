"""Hardware capability probe (Windows / Intel PTL platform).

Detects:

* CPU brand string            - via ``Win32_Processor.Name`` (first socket)
* iGPU adapter name(s)        - via ``Win32_VideoController``
* Total physical RAM (GB)     - sum of ``Win32_PhysicalMemory.Capacity``
* Maximum DIMM speed (MT/s)   - max of ``ConfiguredClockSpeed`` (falls back to ``Speed``)

The probe is *fail-soft*: any WMI / import error degrades to a populated
``HardwareInfo.detection_errors`` field rather than raising. It is also
*time-bounded*: if WMI is in a degraded state (the Windows ``Winmgmt``
service occasionally hangs for minutes after a flurry of process kills,
elevation prompts, or driver installs), the probe returns fallback values
instead of blocking LRM startup forever. See the ``LRM_HW_PROBE_TIMEOUT_S``
env-var override below.

Callers (``local.policy.select_chat_model``) treat unknown hardware as the
lowest tier and pick the most permissive model, so a degraded probe
gracefully selects a conservative model rather than crashing.

The result surfaces via ``GET /llm-router/v1/system/hardware``.
"""

from __future__ import annotations

import os
import shutil
import threading
import time
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

from loguru import logger

# Wall-clock budget for the entire WMI probe. WMI on a healthy host returns
# in <500 ms; the 15 s default is conservative. If exceeded, we return
# fallback HardwareInfo with a `wmi probe timed out` note so the caller
# (policy) picks the most permissive model and boot proceeds.
#
# Override via the ``LRM_HW_PROBE_TIMEOUT_S`` env var (any positive number;
# values <=0 disable the timeout, restoring the legacy behavior where the
# probe could block forever - kept for debug only).
DEFAULT_PROBE_TIMEOUT_S = 15.0

_TIMEOUT_ENV_VAR = "LRM_HW_PROBE_TIMEOUT_S"

# The one probe failure that can leave a partial GPU list. Every other failure that
# touches the GPUs (WMI import, connect, timeout, crashed worker) leaves none.
VIDEO_CONTROLLER_PROBE_FAILED = "video controller probe failed"


@dataclass(frozen=True)
class HardwareInfo:
    igpu_names: tuple[str, ...]
    total_ram_gb: float
    mem_speed_mts: int  # 0 = unknown
    # Keep ``detection_errors`` as the 4th positional field for backward
    # compatibility with existing test fixtures that construct
    # ``HardwareInfo((), 0.0, 0, ("probe failed",))`` positionally. New
    # ``cpu_brand`` is appended after with a default so older positional
    # constructors keep assigning the error tuple to the right field.
    detection_errors: tuple[str, ...] = ()
    cpu_brand: str = ""  # Win32_Processor.Name (first socket); "" = unknown
    cpu_manufacturer: str = ""
    gpu_pnp_device_ids: tuple[str, ...] = ()
    # Set by probe_hardware when the reading has any detection error, including
    # missing evidence (see _with_missing_evidence), so a later probe may change
    # the capability verdict.
    # Not serialized: callers see the same `detection_errors` they always did.
    retryable: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "cpu_brand": self.cpu_brand,
            "igpu_names": list(self.igpu_names),
            "total_ram_gb": round(self.total_ram_gb, 2),
            "mem_speed_mts": self.mem_speed_mts,
            "detection_errors": list(self.detection_errors),
            "cpu_manufacturer": self.cpu_manufacturer,
            "gpu_pnp_device_ids": list(self.gpu_pnp_device_ids),
        }


def _with_missing_evidence(info: HardwareInfo) -> HardwareInfo:
    """Name evidence the capability verdict needs but WMI did not return.

    WMI can answer with no rows or zeroed values without raising. ServiceHub and
    the UI recognise a recoverable reading by its ``detection_errors``, so the gap
    is recorded there too when no error already explains it.
    """
    if info.detection_errors:
        return info
    missing: list[str] = []
    # any(): a video controller row without a PNPDeviceID is recorded as "".
    if not info.cpu_manufacturer and not any(info.gpu_pnp_device_ids):
        missing.append("no cpu_manufacturer or gpu_pnp_device_ids")
    if info.total_ram_gb <= 0:
        missing.append("total_ram_gb=0")
    if info.mem_speed_mts <= 0:
        missing.append("mem_speed_mts=0")
    if not missing:
        return info
    return replace(info, detection_errors=(f"incomplete evidence: {', '.join(missing)}",))


def launch_evidence_missing(info: HardwareInfo) -> bool:
    """The reading lacks what a local launch plan reads: memory size or a usable GPU list.

    Narrower than ``retryable``: a box where one WMI class keeps failing while the
    GPU and memory read fine can still be launched. Memory speed is not required;
    the booster skips its speed check when the speed is unknown. A GPU list from a
    failed video-controller query may be partial, and policy.present_discrete_gpu_keywords
    rejects it the same way.
    """
    has_gpu = any(name.strip() for name in info.igpu_names) or any(
        device_id.strip() for device_id in info.gpu_pnp_device_ids
    )
    gpu_list_partial = any(
        error.startswith(VIDEO_CONTROLLER_PROBE_FAILED) for error in info.detection_errors
    )
    return info.total_ram_gb <= 0 or not has_gpu or gpu_list_partial


def launch_waits_for_reprobe(info: HardwareInfo) -> bool:
    """A local launch waits only when the probe failed AND left the plan without evidence.

    A complete reading with no GPU (a failed display driver leaves only the filtered
    "Microsoft Basic Display Adapter") is the machine's real answer and launches, as
    it always has.
    """
    return info.retryable and launch_evidence_missing(info)


def _probe_hardware_inner() -> HardwareInfo:
    """The actual WMI probe, run inside a worker thread by ``probe_hardware``.

    Always returns a ``HardwareInfo`` (never raises). Any WMI/COM failure
    degrades to populating ``detection_errors``.
    """
    errors: list[str] = []

    # COM must be initialised on this thread BEFORE `import wmi`: the module binds
    # to Winmgmt at import (`GetObject("winmgmts:")`), and pywin32 initialises COM
    # only on the thread that first imports it. Every probe runs on a new worker
    # thread, so importing first would fail every re-probe after a failed first
    # import. A failed import is not cached in sys.modules, so it re-runs here.
    pythoncom = None
    com_initialized = False
    try:
        try:
            import pythoncom  # type: ignore[import-not-found]

            pythoncom.CoInitialize()
            com_initialized = True
        except Exception as e:
            errors.append(f"CoInitialize failed: {e!r}")

        try:
            import wmi  # type: ignore[import-not-found]
        except Exception as e:  # ImportError, or Winmgmt stopped/disabled (com_error at import)
            return HardwareInfo(
                igpu_names=(),
                total_ram_gb=0.0,
                mem_speed_mts=0,
                detection_errors=(*errors, f"wmi import failed: {e!r}"),
            )

        try:
            c = wmi.WMI()
        except Exception as e:
            return HardwareInfo(
                igpu_names=(),
                total_ram_gb=0.0,
                mem_speed_mts=0,
                detection_errors=(*errors, f"wmi connect failed: {e!r}"),
            )

        cpu_brand = ""
        cpu_manufacturer = ""
        try:
            for cpu in c.Win32_Processor():
                name = (getattr(cpu, "Name", "") or "").strip()
                if name:
                    cpu_brand = name
                    cpu_manufacturer = (getattr(cpu, "Manufacturer", "") or "").strip()
                    break
        except Exception as e:
            errors.append(f"cpu probe failed: {e!r}")

        igpus: list[str] = []
        gpu_pnp_device_ids: list[str] = []
        try:
            for gpu in c.Win32_VideoController():
                name = (getattr(gpu, "Name", "") or "").strip()
                if not name:
                    continue
                # Drop synthetic/virtual adapters that Windows surfaces alongside
                # the real GPU (e.g. "Microsoft Remote Display Adapter" appears
                # under RDP sessions, "Microsoft Basic Display Adapter" appears
                # when the GPU driver fails to load). They never satisfy the
                # 35B model's iGPU keyword check and only add noise to the
                # /v1/system/hardware-eligibility response.
                if name.startswith("Microsoft "):
                    continue
                igpus.append(name)
                gpu_pnp_device_ids.append(
                    (getattr(gpu, "PNPDeviceID", "") or "").strip()
                )
        except Exception as e:
            errors.append(f"{VIDEO_CONTROLLER_PROBE_FAILED}: {e!r}")

        total_bytes = 0
        speed = 0
        try:
            for dimm in c.Win32_PhysicalMemory():
                try:
                    total_bytes += int(getattr(dimm, "Capacity", 0) or 0)
                except Exception:
                    pass
                # ConfiguredClockSpeed = actual MT/s the DIMM is running at.
                # Speed = max-supported.  Prefer configured, fall back to nominal.
                try:
                    cs = int(getattr(dimm, "ConfiguredClockSpeed", 0) or 0)
                except Exception:
                    cs = 0
                try:
                    ms = int(getattr(dimm, "Speed", 0) or 0)
                except Exception:
                    ms = 0
                best = max(cs, ms)
                if best > speed:
                    speed = best
        except Exception as e:
            errors.append(f"physical memory probe failed: {e!r}")

        return HardwareInfo(
            igpu_names=tuple(igpus),
            total_ram_gb=total_bytes / (1024**3),
            mem_speed_mts=speed,
            cpu_brand=cpu_brand,
            cpu_manufacturer=cpu_manufacturer,
            gpu_pnp_device_ids=tuple(gpu_pnp_device_ids),
            detection_errors=tuple(errors),
        )
    finally:
        if com_initialized and pythoncom is not None:
            try:
                pythoncom.CoUninitialize()
            except Exception:
                pass


def _resolve_timeout_s(override_s: float | None) -> float | None:
    """Resolve the wall-clock timeout. ``None`` from caller -> env var or default;
    ``<=0`` -> disable timeout (legacy behavior, debug-only)."""
    if override_s is not None:
        return override_s if override_s > 0 else None
    raw = os.environ.get(_TIMEOUT_ENV_VAR, "").strip()
    if raw:
        try:
            v = float(raw)
            return v if v > 0 else None
        except ValueError:
            # An operator who set the env var but mistyped the number would
            # otherwise see "default applied" with no explanation. Surface it
            # so "why didn't my timeout change?" is debuggable from the logs.
            logger.warning(
                "hardware probe: {}={!r} is not a valid float; ignoring and "
                "using the default of {:.1f}s.",
                _TIMEOUT_ENV_VAR,
                raw,
                DEFAULT_PROBE_TIMEOUT_S,
            )
    return DEFAULT_PROBE_TIMEOUT_S


# The probe worker that has not produced a reading yet. One that outlives its
# caller's budget stays here and the next probe joins it instead of starting
# another, so a hung Winmgmt holds at most one stuck COM thread and a reading
# that lands late is still used.
_probe_worker: tuple[threading.Thread, list[HardwareInfo]] | None = None
_probe_worker_lock = threading.Lock()


def _join_probe_worker(timeout_s: float) -> HardwareInfo | None:
    """Wait up to ``timeout_s`` for the probe worker; ``None`` when it is still running."""
    global _probe_worker
    with _probe_worker_lock:
        if _probe_worker is None:
            result_box: list[HardwareInfo] = []

            def _worker() -> None:
                try:
                    result_box.append(_probe_hardware_inner())
                except Exception as exc:  # noqa: BLE001
                    # _probe_hardware_inner is itself fail-soft, but be defensive.
                    result_box.append(
                        HardwareInfo(
                            igpu_names=(),
                            total_ram_gb=0.0,
                            mem_speed_mts=0,
                            detection_errors=(f"probe worker raised: {exc!r}",),
                        )
                    )

            worker = threading.Thread(target=_worker, name="hw-probe", daemon=True)
            worker.start()
            _probe_worker = (worker, result_box)
        worker, box = _probe_worker
    worker.join(timeout=timeout_s)
    if not box:
        return None
    with _probe_worker_lock:
        if _probe_worker is not None and _probe_worker[0] is worker:
            _probe_worker = None
    return box[0]


def probe_hardware(timeout_s: float | None = None) -> HardwareInfo:
    """Probe the host via WMI, time-bounded by ``timeout_s`` (default 15s).

    Always returns a ``HardwareInfo`` and never raises - on a hung WMI
    service (the Windows ``Winmgmt`` service can stall for minutes after
    rapid process churn) the call returns fallback values with a
    ``wmi probe timed out`` note so LRM boot doesn't block on a system-level
    service issue.

    The worker thread is *not* cancelled on timeout - Windows COM calls
    aren't interruptible from Python. The thread is left as a daemon and
    will exit with the process, and the next call joins that same worker
    rather than starting another, so repeated probes against a hung WMI
    hold one COM handle, not one per attempt. An incomplete result is
    ``retryable`` (see :func:`_with_missing_evidence`).
    """
    effective = _resolve_timeout_s(timeout_s)
    wmi_started_at = time.monotonic()
    wmi_timed_out = False
    if effective is None:
        # Legacy: no timeout. Used by tests + the rare case where an
        # operator wants to wait out a slow but ultimately-healthy WMI.
        info = _probe_hardware_inner()
    else:
        # We deliberately use a daemon `threading.Thread` rather than
        # `concurrent.futures.ThreadPoolExecutor` because the latter's
        # context manager forces `shutdown(wait=True)` on exit, which would
        # block on the very thread we're trying to abandon. With a daemon
        # thread, the worker is left running but exits with the process.
        # Windows COM calls aren't interruptible from Python, so leaking the
        # thread is the only way to honor the wall-clock budget.
        result = _join_probe_worker(effective)

        if result is not None:
            info = result
        else:
            wmi_timed_out = True
            logger.warning(
                "hardware probe: WMI did not return within {:.1f}s; using "
                "fallback HardwareInfo. The Winmgmt service may be degraded - "
                "try `Restart-Service Winmgmt -Force` from an admin shell.",
                effective,
            )
            info = HardwareInfo(
                igpu_names=(),
                total_ram_gb=0.0,
                mem_speed_mts=0,
                cpu_brand="",
                detection_errors=(
                    f"wmi probe timed out after {effective:.1f}s; using fallback",
                ),
            )

    wmi_elapsed_ms = round((time.monotonic() - wmi_started_at) * 1000)
    info = _with_missing_evidence(info)
    # Judged on the evidence rather than on which step failed: a stopped Winmgmt,
    # for one, surfaces as an import failure, not as a timeout or a failed query.
    info = replace(info, retryable=bool(info.detection_errors))

    # Enrich the boot log with *current remaining* mem/disk (best-effort, never
    # raises). These are the runtime figures the frontend startup gate
    # (/system/preflight) also reads; logging them here makes "why did the gate
    # block?" answerable straight from the LRM boot log. Imports are local to
    # avoid coupling this low-level WMI probe to the routing/model layers.
    free_mem_repr = "unknown"
    disk_repr = "unknown"
    try:
        from ..routing.policy.gates import available_memory_gb

        free_gb = available_memory_gb()
        if free_gb is not None:
            free_mem_repr = f"{free_gb:.1f}GB"
    except Exception:  # noqa: BLE001
        pass
    try:
        from .models import model_dir

        # Report total(free) on the cache volume to mirror the ram=X(free Y)
        # shape. Walk up to the first existing parent (model_dir may not exist
        # yet on a fresh install) so disk_usage has a real path to stat.
        probe_path = model_dir()
        while not probe_path.exists() and probe_path != probe_path.parent:
            probe_path = probe_path.parent
        usage = shutil.disk_usage(probe_path)
        disk_repr = (
            f"{usage.total / (1024 ** 3):.1f}GB(free {usage.free / (1024 ** 3):.1f}GB)"
        )
    except Exception:  # noqa: BLE001
        pass

    logger.info(
        "hardware probe: cpu={!r} igpu={} ram={:.1f}GB(free {}) "
        "mem_speed={}MT/s disk={} wmi_elapsed_ms={} wmi_timed_out={} errors={}",
        info.cpu_brand,
        list(info.igpu_names),
        info.total_ram_gb,
        free_mem_repr,
        info.mem_speed_mts,
        disk_repr,
        wmi_elapsed_ms,
        wmi_timed_out,
        len(info.detection_errors),
    )
    return info


def probe_disk_free_bytes(cache_dir: Path) -> int | None:
    """Return free bytes on the cache volume without creating the directory."""
    probe_path = cache_dir
    while not probe_path.exists() and probe_path != probe_path.parent:
        probe_path = probe_path.parent
    try:
        return shutil.disk_usage(probe_path).free
    except OSError:
        return None
