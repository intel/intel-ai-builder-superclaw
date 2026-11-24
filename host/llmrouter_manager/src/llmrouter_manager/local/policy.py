"""Hardware-aware chat-model selection policy.

The registry's chat-role entries each carry an optional ``requirements``
block describing the minimum hardware needed to run that model::

    "requirements": {
        "min_ram_gb":         64,
        "min_mem_speed_mts":  8000,
        "igpu_keywords":      ["B370", "B390"]    // any-of substring match
    }

``select_chat_model`` returns the **most demanding** chat entry whose
requirements the detected hardware satisfies. This lets the registry list
multiple tiers (e.g. Qwen3.6-35B for high-end PTL boxes, Qwen3.5-4B for
everything else) and have the right one auto-picked at boot.

Fallback rules:

* If no chat entry's requirements are met (e.g. probe failed, unusual
  hardware), the entry with the *lowest* tier score is returned - i.e. the
  most permissive option, which should run anywhere.
* An entry with ``requirements == None`` (or empty dict) is treated as the
  universal baseline (tier score 0) and is always eligible.
"""

from __future__ import annotations

from typing import Any, Final

from loguru import logger

from .hardware import VIDEO_CONTROLLER_PROBE_FAILED, HardwareInfo
from .registry import ROLE_CHAT, ModelEntry, Registry


_DISCRETE_GPU_KEYWORDS: Final[frozenset[str]] = frozenset({"b70"})


def discrete_gpu_keywords(entry: ModelEntry) -> frozenset[str]:
    """The subset of *entry*'s ``igpu_keywords`` that name a discrete board.

    Single source of truth for "which keyword means dedicated GPU", so the
    eligibility predicate below and the launch-time device pin
    (``gpu_devices.resolve_device_index``) cannot drift apart.
    """
    return frozenset(
        keyword
        for keyword in (
            str(raw).strip().lower()
            for raw in ((entry.requirements or {}).get("igpu_keywords") or [])
        )
        if keyword in _DISCRETE_GPU_KEYWORDS
    )


def present_discrete_gpu_keywords(hardware: HardwareInfo | None) -> frozenset[str]:
    """Discrete-board keywords matching an adapter actually present on the host.

    Used both to decide the dedicated-GPU launch profile and to name the board
    that ``--main-gpu`` must resolve to at launch.

    Judged on the GPU evidence itself: errors from other WMI classes (CPU, memory,
    a zero memory speed) do not make the adapter list wrong. A failed WMI import,
    connect, timeout or crashed worker leaves no GPU names; only a failed
    video-controller query can leave a partial list.
    """
    if hardware is None or not any(name.strip() for name in hardware.igpu_names):
        return frozenset()
    if any(error.startswith(VIDEO_CONTROLLER_PROBE_FAILED) for error in hardware.detection_errors):
        return frozenset()
    return frozenset(
        keyword
        for keyword in _DISCRETE_GPU_KEYWORDS
        if any(keyword in adapter.lower() for adapter in hardware.igpu_names)
    )


def targets_discrete_gpu(
    entry: ModelEntry, hardware: HardwareInfo | None
) -> bool:
    """Return whether *entry* targets a discrete GPU present in *hardware*.

    Model ``igpu_keywords`` are alternatives for eligibility, so the presence
    of ``B70`` in the entry alone is not enough to select the dedicated-GPU
    path when the host matched another keyword such as ``B390``.
    """
    return bool(discrete_gpu_keywords(entry) & present_discrete_gpu_keywords(hardware))


def _meets(req: dict[str, Any] | None, hw: HardwareInfo) -> bool:
    if not req:
        return True

    min_ram = req.get("min_ram_gb")
    if min_ram is not None and hw.total_ram_gb < float(min_ram):
        return False

    min_mts = req.get("min_mem_speed_mts")
    if min_mts is not None:
        # mem_speed_mts == 0 means probe didn't report a value;
        # treat as failing any positive threshold (safer to downgrade).
        if hw.mem_speed_mts <= 0 or hw.mem_speed_mts < int(min_mts):
            return False

    keywords = req.get("igpu_keywords") or []
    if keywords:
        if not hw.igpu_names:
            return False
        joined = " | ".join(hw.igpu_names).lower()
        if not any(str(kw).lower() in joined for kw in keywords):
            return False

    return True


def _tier_score(req: dict[str, Any] | None) -> tuple[int, int, int]:
    """Higher tuple = more demanding hardware. Used to rank eligible models."""
    if not req:
        return (0, 0, 0)
    return (
        int(req.get("min_ram_gb") or 0),
        int(req.get("min_mem_speed_mts") or 0),
        len(req.get("igpu_keywords") or []),
    )


_last_policy_log: tuple | None = None


def select_chat_model(registry: Registry, hw: HardwareInfo) -> ModelEntry:
    """Return the best-fit chat ``ModelEntry`` for the detected hardware."""
    global _last_policy_log
    chats = registry.by_role(ROLE_CHAT)
    if not chats:
        raise RuntimeError("registry has no chat models")

    eligible = [m for m in chats if _meets(m.requirements, hw)]
    if eligible:
        eligible.sort(key=lambda m: _tier_score(m.requirements), reverse=True)
        chosen = eligible[0]
        key = ("ok", len(eligible), chosen.id, _tier_score(chosen.requirements))
        if key != _last_policy_log:
            _last_policy_log = key
            logger.info(
                "model_policy: {} eligible chat model(s); chose {!r} (tier={})",
                len(eligible),
                chosen.id,
                _tier_score(chosen.requirements),
            )
        return chosen

    # Nothing matched - pick the most permissive (lowest tier) entry.
    chats_sorted = sorted(chats, key=lambda m: _tier_score(m.requirements))
    chosen = chats_sorted[0]
    key = ("fallback", chosen.id, tuple(sorted(hw.igpu_names)), hw.total_ram_gb, hw.mem_speed_mts)
    if key != _last_policy_log:
        _last_policy_log = key
        logger.warning(
            "model_policy: no chat model matches hardware (igpu={} ram={:.1f}GB "
            "mem_speed={}); falling back to lowest-tier {!r}",
            list(hw.igpu_names),
            hw.total_ram_gb,
            hw.mem_speed_mts,
            chosen.id,
        )
    return chosen


def available_chat_tiers(registry: Registry, hw: HardwareInfo) -> list[ModelEntry]:
    """Return every chat tier this hardware can run, most-demanding first.

    This is the user-facing tier *menu* backing ``PUT /model-selections/tier``
    and the ``available_tiers`` field of ``/status``. Unlike
    :func:`select_chat_model` - which always yields *some* entry (a lowest-tier
    fallback so the supervisor has a default even on an unreadable box) - this
    returns the exact set of eligible tiers: an ineligible host gets an **empty
    list** and the UI offers edge only (no local chat tier).

    Ordering matches :func:`select_chat_model`'s pick: sorted by ``_tier_score``
    descending, so index 0 is the biggest tier the box qualifies for (the
    default) and later entries are downgrades.
    """
    eligible = [m for m in registry.by_role(ROLE_CHAT) if _meets(m.requirements, hw)]
    eligible.sort(key=lambda m: _tier_score(m.requirements), reverse=True)
    return eligible
