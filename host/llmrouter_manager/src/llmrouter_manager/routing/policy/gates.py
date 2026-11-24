"""Pre-router serving gates: free-memory floor + max-turns cap.

These short-circuit an AUTO request to cloud before the router runs:
  * low free RAM   → the local model can't load / would thrash → cloud;
  * too many turns → a long local loop that isn't converging → cloud.
Defaults: `resolve_min_memory_gb()` defaults to 4.0 GB (always on unless the operator sets `LATENTFACTOR_MIN_MEMORY_GB=0`). `resolve_max_turns()` defaults to 0 (off unless the operator sets `LATENTFACTOR_MAX_TURNS>0`).
"""
from __future__ import annotations

import os
import sys
from typing import Any, Optional

from loguru import logger


# ── Windows free-RAM probe (ctypes GlobalMemoryStatusEx) ─────────────────────
# psutil is NOT a declared runtime dependency of llmrouter_manager and is not
# installed on the frozen exe. On Windows there is no /proc/meminfo either, so
# without this path `available_memory_gb()` always returned None and the
# LATENTFACTOR_MIN_MEMORY_GB=4.0 baseline never actually gated anything.
#
# We probe kernel32.GlobalMemoryStatusEx via ctypes — pure stdlib, works in the
# PyInstaller onedir bundle, no extra deps. Function pointer + struct signature
# are set up once at import time (mirrors the Job Object setup in
# local/supervisor.py) so the hot path is a single Win32 call.

_WIN_GLOBAL_MEMORY_STATUS_EX: Any = None


if sys.platform == "win32":
    import ctypes
    from ctypes import wintypes


    class _MemoryStatusEx(ctypes.Structure):
        _fields_ = [
            ("dwLength", wintypes.DWORD),
            ("dwMemoryLoad", wintypes.DWORD),
            ("ullTotalPhys", ctypes.c_ulonglong),
            ("ullAvailPhys", ctypes.c_ulonglong),
            ("ullTotalPageFile", ctypes.c_ulonglong),
            ("ullAvailPageFile", ctypes.c_ulonglong),
            ("ullTotalVirtual", ctypes.c_ulonglong),
            ("ullAvailVirtual", ctypes.c_ulonglong),
            ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
        ]


    try:
        _k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        _k32.GlobalMemoryStatusEx.argtypes = [ctypes.POINTER(_MemoryStatusEx)]
        _k32.GlobalMemoryStatusEx.restype = wintypes.BOOL
        _WIN_GLOBAL_MEMORY_STATUS_EX = _k32.GlobalMemoryStatusEx
    except Exception:  # noqa: BLE001
        # If kernel32 isn't reachable (extremely unusual) we fall through to
        # the psutil / /proc/meminfo path below.
        _WIN_GLOBAL_MEMORY_STATUS_EX = None


def resolve_min_memory_gb(
    routing_cfg: dict[str, Any],
    env_value: Optional[str] = None,
    default: float = 4.0,
) -> float:
    """Free-RAM floor (GB). Precedence: env ``LATENTFACTOR_MIN_MEMORY_GB`` >
    ``routing.min_available_memory_gb`` > default. 0/negative disables."""
    if env_value:
        try:
            return float(env_value)
        except ValueError:
            logger.warning("bad LATENTFACTOR_MIN_MEMORY_GB={!r}; using config/default",
                           env_value)
    v = routing_cfg.get("min_available_memory_gb")
    if v is not None:
        try:
            return float(v)
        except (TypeError, ValueError):
            logger.warning("bad routing.min_available_memory_gb={!r}; using default {}", v, default)
    return float(default)


def resolve_max_turns(
    routing_cfg: dict[str, Any],
    env_value: Optional[str] = None,
    default: int = 0,
) -> int:
    """Max assistant turns before an AUTO session hands off to cloud.
    Precedence: env ``LATENTFACTOR_MAX_TURNS`` > ``routing.max_turns`` >
    default (0 = disabled)."""
    if env_value:
        try:
            return int(env_value)
        except ValueError:
            logger.warning("bad LATENTFACTOR_MAX_TURNS={!r}; using config/default",
                           env_value)
    v = routing_cfg.get("max_turns")
    if v is not None:
        try:
            return int(v)
        except (TypeError, ValueError):
            logger.warning("bad routing.max_turns={!r}; using default {}", v, default)
    return int(default)


def count_assistant_turns(messages: Any) -> int:
    """Count ``role="assistant"`` messages in an OpenAI chat array. Robust to
    non-list input and malformed entries (returns 0)."""
    if not isinstance(messages, list):
        return 0
    return sum(
        1 for m in messages
        if isinstance(m, dict) and m.get("role") == "assistant"
    )


def available_memory_gb() -> Optional[float]:
    """Best-effort free RAM in GB, or None if unmeasurable. Never raises.

    Probe order:
      1. Windows: ``kernel32.GlobalMemoryStatusEx`` via ctypes (stdlib only,
         works in the frozen exe with no extra deps).
      2. psutil, when installed (Linux/macOS dev environments where psutil
         happens to be present; NOT a declared runtime dep here).
      3. Linux fallback: ``/proc/meminfo`` MemAvailable.
      4. None (caller treats as "unmeasurable" and skips the gate).
    """
    # 1. Windows via ctypes (avoids the psutil dependency on Windows builds).
    if _WIN_GLOBAL_MEMORY_STATUS_EX is not None:
        try:
            st = _MemoryStatusEx()
            st.dwLength = ctypes.sizeof(_MemoryStatusEx)
            if _WIN_GLOBAL_MEMORY_STATUS_EX(ctypes.byref(st)):
                return st.ullAvailPhys / (1024 ** 3)
        except Exception:  # noqa: BLE001
            pass
    # 2. psutil if available (cross-platform; not a declared dep, so guarded).
    try:
        import psutil  # type: ignore

        return psutil.virtual_memory().available / (1024 ** 3)
    except Exception:  # noqa: BLE001
        pass
    # 3. Linux fallback: /proc/meminfo MemAvailable.
    try:
        with open("/proc/meminfo", encoding="utf-8") as f:
            for line in f:
                if line.startswith("MemAvailable:"):
                    kb = float(line.split()[1])
                    return kb / (1024 ** 2)
    except Exception:  # noqa: BLE001
        pass
    return None


def resolve_max_turns_env() -> int:
    """Convenience: resolve max_turns from env only (no config dict)."""
    return resolve_max_turns({}, env_value=os.environ.get("LATENTFACTOR_MAX_TURNS"))


def resolve_ctx_size(default: int, env_value: Optional[str] = None) -> int:
    """Local llama-server ``-c`` override (positive int). Precedence:

        env ``LATENTFACTOR_LOCAL_CTX``  >  ``default``

    ``default`` is the caller's already-resolved fallback (usually
    ``Store["local_ctx_size_override"]`` if present, else
    ``entry.default_ctx`` or the booster's ``tuned_args.ctx_size``). This
    function ONLY layers the env override on top; the Store lookup + booster
    interaction stay in the caller (supervisor) where they have context.

    Bad env values (non-int, ``<=0``) log a warning and fall through to
    ``default`` — an operator experiment shouldn't crash llama-server boot
    over a typo in the env var. Values > default are accepted silently
    (experiments intentionally probe upward)."""
    if env_value:
        try:
            v = int(env_value)
            if v <= 0:
                raise ValueError(f"ctx must be positive, got {v!r}")
            return v
        except (TypeError, ValueError) as exc:
            logger.warning(
                "bad LATENTFACTOR_LOCAL_CTX={!r} ({}); using default {}",
                env_value, exc, default,
            )
    return int(default)


def resolve_ctx_size_env(default: int) -> int:
    """Convenience: resolve ctx_size from env only (no config dict)."""
    return resolve_ctx_size(default, env_value=os.environ.get("LATENTFACTOR_LOCAL_CTX"))
