"""Resolve ``sanitize.device`` to runtime provider routing.

The config layer validates the device token. This module turns it into a
``ResolvedProviders`` value used by the PPLX, embedding, and ONNX Runtime
loaders.

Rules:
* ``AUTO`` prefers accelerators and falls back to CPU with a diagnostic log.
* Explicit devices are strict. If the requested device is unavailable, raise
    ``DeviceUnavailableError`` instead of silently using CPU.
* Intel GPU/NPU detection comes from ``openvino.Core().available_devices``.
"""

from __future__ import annotations

import logging
import platform
from dataclasses import dataclass
from typing import Sequence


logger = logging.getLogger(__name__)


class DeviceUnavailableError(RuntimeError):
    """Raised when a strict device request cannot be satisfied."""


@dataclass(frozen=True)
class ResolvedProviders:
    """Resolved provider routing plus a human-readable description.

    For ORT paths, ``providers`` and ``provider_options`` are passed to
    ``onnxruntime.InferenceSession``. For OpenVINO direct paths,
    ``OpenVINOExecutionProvider`` is only a routing token consumed by the
    pipeline before ORT session creation.
    """

    providers: list[str]
    provider_options: list[dict]
    description: str


def resolve_providers(device: str, *, ov_cache_dir: str | None = None) -> ResolvedProviders:
    """Resolve a validated ``sanitize.device`` token.

    ``ov_cache_dir`` is forwarded to OpenVINO so compiled GPU/NPU kernels can
    be reused across restarts.
    """
    _preload_openvino_dll_path()
    available_ep = _available_ort_providers()

    if device == "AUTO":
        return _resolve_auto(available_ep, ov_cache_dir=ov_cache_dir)

    if device == "INTEL_GPU":
        return _require_openvino(
            target="GPU", available_ep=available_ep, ov_cache_dir=ov_cache_dir
        )

    if device == "INTEL_NPU":
        return _require_openvino(
            target="NPU", available_ep=available_ep, ov_cache_dir=ov_cache_dir
        )

    if device == "CPU":
        return ResolvedProviders(
            providers=["CPUExecutionProvider"],
            provider_options=[{}],
            description="CPU (CPUExecutionProvider)",
        )

    if device == "DIRECTML":
        if "DmlExecutionProvider" not in available_ep:
            raise DeviceUnavailableError(
                "device=DIRECTML requested but onnxruntime-directml is not "
                "installed (or the host is not Windows). Install the "
                "onnxruntime-directml wheel or change sanitize.device."
            )
        return ResolvedProviders(
            providers=["DmlExecutionProvider", "CPUExecutionProvider"],
            provider_options=[{}, {}],
            description="DirectML GPU -> CPU fallback",
        )

    if device == "COREML":
        if "CoreMLExecutionProvider" not in available_ep:
            raise DeviceUnavailableError(
                "device=COREML requested but CoreMLExecutionProvider is not "
                "available. Build/install onnxruntime with CoreML support, or "
                "change sanitize.device. (CoreML EP is macOS-only.)"
            )
        # MLProgram gives CoreML broad op coverage; ALL lets it choose NPU/GPU/CPU.
        return ResolvedProviders(
            providers=["CoreMLExecutionProvider", "CPUExecutionProvider"],
            provider_options=[
                {"ModelFormat": "MLProgram", "MLComputeUnits": "ALL"},
                {},
            ],
            description="CoreML (NPU/GPU/CPU) -> CPU fallback",
        )

    if device == "CUDA":
        if "CUDAExecutionProvider" not in available_ep:
            raise DeviceUnavailableError(
                "device=CUDA requested but CUDAExecutionProvider is not "
                "available. Install the onnxruntime-gpu wheel and ensure "
                "CUDA + cuDNN runtimes are present, or change sanitize.device."
            )
        return ResolvedProviders(
            providers=["CUDAExecutionProvider", "CPUExecutionProvider"],
            provider_options=[{}, {}],
            description="CUDA GPU -> CPU fallback",
        )

    # Config validation should make this unreachable.
    raise AssertionError(f"unhandled device token: {device!r}")


# --------------------------------------------------------------------------
# AUTO: pick the best available provider without failing startup.
# --------------------------------------------------------------------------


def _resolve_auto(
    available_ep: set[str], *, ov_cache_dir: str | None
) -> ResolvedProviders:
    """Resolve the default AUTO device policy.

    On Windows/Linux, prefer Intel OpenVINO GPU, then Intel NPU, then
    DirectML on Windows, then CUDA, then CPU. On macOS, prefer CoreML, then
    CPU. AUTO never raises for a missing accelerator; it logs why and returns
    CPU when no accelerator is usable.
    """
    system = platform.system()  # 'Linux', 'Darwin', 'Windows'

    # Log what AUTO saw so CPU fallback has an actionable reason.
    ov_devices: set[str] = set()
    if system in ("Linux", "Windows"):
        ov_devices = _openvino_devices()
    logger.info(
        "Device AUTO: system=%s, ORT providers=%s, OpenVINO devices=%s",
        system,
        sorted(available_ep) or "<none>",
        sorted(ov_devices) or "<none>",
    )

    if system in ("Linux", "Windows"):
        # Intel paths use OpenVINO Core directly; ORT's OpenVINO EP is not required.
        if "GPU" in ov_devices:
            return _ov_provider(target="GPU", ov_cache_dir=ov_cache_dir)

        if "NPU" in ov_devices:
            return _ov_provider(target="NPU", ov_cache_dir=ov_cache_dir)

        if system == "Windows" and "DmlExecutionProvider" in available_ep:
            return ResolvedProviders(
                providers=["DmlExecutionProvider", "CPUExecutionProvider"],
                provider_options=[{}, {}],
                description="AUTO -> DirectML GPU -> CPU",
            )

        if "CUDAExecutionProvider" in available_ep:
            return ResolvedProviders(
                providers=["CUDAExecutionProvider", "CPUExecutionProvider"],
                provider_options=[{}, {}],
                description="AUTO -> CUDA GPU -> CPU",
            )

    if system == "Darwin":
        if "CoreMLExecutionProvider" in available_ep:
            return ResolvedProviders(
                providers=["CoreMLExecutionProvider", "CPUExecutionProvider"],
                provider_options=[
                    {"ModelFormat": "MLProgram", "MLComputeUnits": "ALL"},
                    {},
                ],
                description="AUTO -> CoreML (NPU/GPU/CPU) -> CPU",
            )

    # Explain why AUTO ended on CPU instead of leaving operators to infer it.
    reasons: list[str] = []
    if system in ("Linux", "Windows"):
        if "OpenVINOExecutionProvider" not in available_ep:
            reasons.append(
                "OpenVINOExecutionProvider not registered with onnxruntime "
                "(install the 'onnxruntime-openvino' wheel for Intel iGPU/NPU)"
            )
        elif "GPU" not in ov_devices and "NPU" not in ov_devices:
            reasons.append(
                "OpenVINO sees no GPU/NPU on this host (only "
                f"{sorted(ov_devices) or ['CPU']}); install/update Intel "
                "graphics + NPU drivers"
            )
        if system == "Windows" and "DmlExecutionProvider" not in available_ep:
            reasons.append(
                "DmlExecutionProvider not registered (install the "
                "'onnxruntime-directml' wheel for AMD/NVIDIA/Intel GPUs via DirectML)"
            )
        if "CUDAExecutionProvider" not in available_ep:
            reasons.append(
                "CUDAExecutionProvider not registered (install 'onnxruntime-gpu' "
                "+ matching CUDA/cuDNN runtimes for NVIDIA GPUs)"
            )
    elif system == "Darwin" and "CoreMLExecutionProvider" not in available_ep:
        reasons.append(
            "CoreMLExecutionProvider not registered (rebuild onnxruntime "
            "with --use_coreml or install a wheel that includes it)"
        )

    if reasons:
        logger.warning(
            "Device AUTO falling back to CPU. Accelerator unavailable because: %s. "
            "If you expected a GPU/NPU run, install the matching wheel and "
            "restart. Pin sanitize.device to a strict token (INTEL_GPU/CUDA/"
            "DIRECTML/...) to fail loudly instead of silently falling back.",
            "; ".join(reasons),
        )

    return ResolvedProviders(
        providers=["CPUExecutionProvider"],
        provider_options=[{}],
        description="AUTO -> CPU (no accelerator detected)",
    )


# --------------------------------------------------------------------------
# OpenVINO direct-path helpers.
# --------------------------------------------------------------------------


def _require_openvino(
    *, target: str, available_ep: set[str], ov_cache_dir: str | None
) -> ResolvedProviders:
    """Require an OpenVINO-visible GPU or NPU for a strict Intel request."""
    ov_devices = _openvino_devices()
    if not ov_devices:
        raise DeviceUnavailableError(
            f"device=INTEL_{target} requested but the 'openvino' runtime "
            "package is not installed (or failed to import). Install "
            "with `pip install openvino`, or change sanitize.device to "
            "AUTO/CPU."
        )
    if target not in ov_devices:
        raise DeviceUnavailableError(
            f"device=INTEL_{target} requested but OpenVINO does not see a "
            f"{target} on this host. Detected devices: {sorted(ov_devices)}. "
            "Update Intel graphics / NPU drivers, or change sanitize.device."
        )
    return _ov_provider(target=target, ov_cache_dir=ov_cache_dir)


def _ov_provider(*, target: str, ov_cache_dir: str | None) -> ResolvedProviders:
    """Return routing data for the pipeline-level OpenVINO direct path.

    ``OpenVINOExecutionProvider`` is a routing token here. Pipelines must
    consume it before calling the ONNX Runtime factory.

    GPU/NPU use FP16 because the Intel plugin's FP32 path can produce NaNs for
    this int8 model chain. CPU keeps FP32.
    """
    options: dict[str, str] = {"device_type": target}
    if target in ("GPU", "NPU"):
        options["precision"] = "FP16"
    if ov_cache_dir:
        # Reuse compiled GPU/NPU kernels across restarts.
        options["cache_dir"] = ov_cache_dir
    return ResolvedProviders(
        providers=["OpenVINOExecutionProvider", "CPUExecutionProvider"],
        provider_options=[options, {}],
        description=f"OpenVINO {target} direct FP16 (no ORT EP) -> CPU fallback"
                    if target in ("GPU", "NPU") else
                    f"OpenVINO {target} direct (no ORT EP) -> CPU fallback",
    )


def _preload_openvino_dll_path() -> None:
    """Import OpenVINO on Windows so its DLL directory is registered.

    This is harmless when OpenVINO is absent and avoids Windows DLL lookup
    failures when OpenVINO is present.
    """
    if platform.system() != "Windows":
        return
    try:
        import openvino  # noqa: F401  (side-effect import: registers DLL dir)
    except ImportError:
        # CPU/DirectML/CUDA builds may not ship OpenVINO.
        return


def _openvino_devices() -> set[str]:
    """Return OpenVINO-visible devices, e.g. ``CPU``, ``GPU``, or ``NPU``."""
    try:
        from openvino import Core  # type: ignore[import-not-found]
    except ImportError:
        return set()
    try:
        return set(Core().available_devices)
    except Exception as exc:
        # Driver issues should make AUTO fall through, not crash startup.
        logger.warning("openvino.Core().available_devices failed: %s", exc)
        return set()


def _available_ort_providers() -> set[str]:
    """Return available ONNX Runtime providers, importing ORT lazily."""
    try:
        import onnxruntime as ort  # type: ignore[import-not-found]
    except ImportError:
        return set()
    try:
        return set(ort.get_available_providers())
    except Exception as exc:
        logger.warning("onnxruntime.get_available_providers failed: %s", exc)
        return set()
