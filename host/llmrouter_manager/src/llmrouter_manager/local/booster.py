"""Smart Local LLM Booster - hardware-aware tuning + dev/RC/main contract.

Given a ``HardwareInfo`` from ``hardware.py`` and a chosen ``ModelEntry``
from the registry, this module returns either:

* ``TunedLaunchArgs`` - concrete overrides for the llama-server CLI
  (``--ctx-size``, ``--n-gpu-layers``, ``--parallel``, ``--cache-ram``,
  ``--slot-prompt-similarity``) that fit the actual box, OR
* ``LocalUnsupported`` - a verdict that this box cannot run the chosen
  model under realistic agent workload. The supervisor then either:
    - on ``dev``: skips starting a local llama-server and reports the
      rerouted state; LRM serves the traffic from its configured cloud
      upstream, so the user-facing surface keeps reading "local",
    - on ``release-candidate`` / ``main``: surfaces the verdict as a
      preflight failure.

The booster is a **pure function** - no I/O, no mutation. ``supervisor.py``
calls ``LocalLLMBooster.tune(hw, entry)`` once per llama-server start and
applies the result to the launch command.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Final

from .build_channel import Channel
from .hardware import HardwareInfo
from .policy import targets_discrete_gpu

# The window a discrete board actually launches with, overriding the
# registry's `default_ctx`. Named so the dev Bundle mock can declare the
# same number instead of the registry's, and cannot drift from it.
DISCRETE_GPU_CTX_SIZE: int = 262144
from .registry import ModelEntry

# ---------------------------------------------------------------------------
# Verdict types
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class TunedLaunchArgs:
    """Concrete overrides for the llama-server CLI tailored to this box.

    Each field is optional. ``None`` means "leave the registry default
    alone" - the supervisor only emits flags for fields that are set.
    """

    ctx_size: int | None = None
    n_gpu_layers: int | None = None
    parallel: int | None = None
    # Cap for llama-server's internal prompt cache (MiB). 0 disables caching
    # entirely; ``None`` means leave the default in place.
    cache_ram_mib: int | None = None
    # ``--slot-prompt-similarity`` threshold. Lower values spread requests
    # across slots more aggressively (mitigates the LCP routing pattern that
    # serializes parallel sub-agent fan-out).
    slot_prompt_similarity: float | None = None
    # ``--kv-unified``: share one KV pool across slots so n_ctx_seq stays at the
    # full n_ctx instead of n_ctx/parallel. Only affordable where the recurrent
    # state buffer, which it sizes for LLAMA_MAX_SEQ rather than n_seq_max, fits
    # in dedicated VRAM.
    kv_unified: bool | None = None
    # ``-b`` / ``-ub``. These size the compute buffers, and they are the only dial
    # that shrinks the speculative draft's scratch space too: the draft has no batch
    # flags of its own and shares the target's memory, so they are what makes a very
    # large context fit.
    batch: int | None = None
    ubatch: int | None = None

    def to_cli_args(self) -> list[str]:
        """Render set fields as a flat list of ``llama-server`` CLI tokens.

        Used by ``supervisor.py`` to merge into the launch command. Order
        doesn't matter for llama-server, but we keep insertion order stable
        for log readability.
        """
        out: list[str] = []
        if self.ctx_size is not None:
            out += ["--ctx-size", str(self.ctx_size)]
        if self.n_gpu_layers is not None:
            out += ["--n-gpu-layers", str(self.n_gpu_layers)]
        if self.parallel is not None:
            out += ["--parallel", str(self.parallel)]
        if self.cache_ram_mib is not None:
            out += ["--cache-ram", str(self.cache_ram_mib)]
        if self.slot_prompt_similarity is not None:
            out += [
                "--slot-prompt-similarity",
                f"{self.slot_prompt_similarity:.2f}",
            ]
        if self.kv_unified:
            out += ["--kv-unified"]
        if self.batch is not None:
            out += ["--batch-size", str(self.batch)]
        if self.ubatch is not None:
            out += ["--ubatch-size", str(self.ubatch)]
        return out


@dataclass(frozen=True)
class LocalUnsupported:
    """The box cannot run the chosen model under realistic agent workload.

    Caller decides what to do based on the build channel:
      * ``dev``: substitute cloud upstream for ``local-model`` requests.
      * ``release-candidate`` / ``main``: fail preflight with ``reason``
        surfaced to the user.
    """

    reason: str


Verdict = TunedLaunchArgs | LocalUnsupported


# ---------------------------------------------------------------------------
# Decision matrix (v1 - calibrate before relying on this in production)
# ---------------------------------------------------------------------------

# A "tier" is a coarse description of how much GPU memory + RAM headroom
# the box has. Each tier maps to a TunedLaunchArgs preset.
#
# These presets directly address the symptoms we hit on the Lunar Lake /
# Arc 140V / 32 GB / 8533 MT/s box: --ctx-size 64000 + 4 parallel slots +
# 8 GB prompt cache exhausted the 16 GB iGPU pool, which crashed
# llama-server with STATUS_STACK_BUFFER_OVERRUN under sustained agent load.

# Hard floor: any chat model needs at least this much GPU memory free
# (weights + minimal KV cache + compute buffers). Below this we declare
# LocalUnsupported.
#
# The floor is a no-op today because no caller actually supplies
# ``free_gpu_mib`` - the only way to *see* the value is to wire up a DXGI /
# WMI probe (a pending follow-up). To force LocalUnsupported on this box
# without a probe, set the ``LRM_FORCE_LOCAL_UNSUPPORTED`` env var (see
# ``tune`` below). That's the load-bearing test hook today.
MIN_FREE_GPU_MIB_FOR_LOCAL_CHAT: Final[int] = 2048


# Env-var override for testing the dev-mode reroute path on hardware that
# would otherwise pick a tier and run local. Set to "1" to make ``tune``
# return ``LocalUnsupported`` regardless of probe / hardware tier. Useful
# for verifying the reroute verdict (no local llama-server is started; the
# supervisor reports the rerouted state and LLM traffic is served by LRM's
# cloud upstream) before we have a real free-GPU probe to drive the
# decision automatically.
ENV_FORCE_UNSUPPORTED: Final[str] = "LRM_FORCE_LOCAL_UNSUPPORTED"


@dataclass(frozen=True)
class _Tier:
    name: str
    ctx_size: int
    parallel: int
    cache_ram_mib: int
    slot_prompt_similarity: float

    # Lower bounds for this tier (any-must-match).
    min_total_ram_gb: float
    min_mem_speed_mts: int
    # GPU-memory bound is informational here; the booster checks
    # ``MIN_FREE_GPU_MIB_FOR_LOCAL_CHAT`` separately for the
    # LocalUnsupported gate.


# Ordered most-demanding to least-demanding so the picker can scan top-
# down and stop at the first tier that fits. Do not move t1-tight first:
# its 0/0 lower bounds match every machine and would silently downgrade
# all hardware to the tightest profile.
_TIERS: Final[tuple[_Tier, ...]] = (
    _Tier(
        # Calibration history:
        #   v1: ctx 32768, cache 2048 -> still crashed ~15 min into sustained
        #     agent load on a 16 GB shared-memory iGPU (Arc 140V / 32 GB /
        #     8533 MT/s) with STATUS_STACK_BUFFER_OVERRUN.
        #   v2: ctx 16384, cache 2048 -> too tight: --parallel 2 -> 8192
        #     tokens per slot. Large opencode prompts exceed the per-slot
        #     context and trigger exceed_context_size_error on subagent calls.
        #   v3: ctx 24576, cache 2048 -> middle-ground. With --parallel 2 each
        #     slot gets 12288 tokens, just above the typical opencode prompt
        #     size. KV cache lands at ~768 MiB - well below v1's pressure.
        name="t3-roomy",
        ctx_size=24576,
        parallel=2,
        cache_ram_mib=2048,
        slot_prompt_similarity=0.30,
        min_total_ram_gb=32.0,
        min_mem_speed_mts=8000,
    ),
    _Tier(
        name="t2-mid",
        ctx_size=16384,
        parallel=2,
        cache_ram_mib=1024,
        slot_prompt_similarity=0.30,
        min_total_ram_gb=16.0,
        min_mem_speed_mts=6400,
    ),
    _Tier(
        name="t1-tight",
        ctx_size=8192,
        parallel=1,
        cache_ram_mib=0,
        slot_prompt_similarity=0.30,
        min_total_ram_gb=0.0,
        min_mem_speed_mts=0,
    ),
)


def _meets(tier: _Tier, hw: HardwareInfo) -> bool:
    if hw.total_ram_gb < tier.min_total_ram_gb:
        return False
    if tier.min_mem_speed_mts > 0 and hw.mem_speed_mts > 0:
        if hw.mem_speed_mts < tier.min_mem_speed_mts:
            return False
    return True


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


class LocalLLMBooster:
    """Stateless booster. Construct once at app startup; call ``tune`` per
    llama-server launch.

    Future evolution (out of scope for v1):
      * Per-workload-profile tuning (chat vs. agent vs. code).
      * Free-GPU-memory snapshot via ``llama_params_fit`` or DXGI.
      * User overrides from ``settings.json`` (``local_llm_overrides``).
    """

    def tune(
        self,
        hw: HardwareInfo,
        entry: ModelEntry,
        *,
        free_gpu_mib: int | None = None,
    ) -> Verdict:
        """Return tuned launch args, or LocalUnsupported.

        ``free_gpu_mib`` is optional today - when supplied, it gates the
        LocalUnsupported decision against actual free GPU memory rather
        than the hardware tier alone. ``None`` = trust the tier check.
        """
        # Embedding role doesn't trigger the same KV-cache pressure the
        # chat role does - leave it on the registry default for v1.
        if entry.role != "chat":
            return TunedLaunchArgs()

        # Test override: ``LRM_FORCE_LOCAL_UNSUPPORTED=1``. Lets an operator
        # drive the dev-mode reroute verdict on hardware that would otherwise
        # pick a tier: no local llama-server is started and the supervisor
        # reports the rerouted state. LLM traffic is served by LRM's cloud
        # upstream. Removed once a real ``free_gpu_mib`` probe is wired up.
        if (os.environ.get(ENV_FORCE_UNSUPPORTED) or "").strip() == "1":
            return LocalUnsupported(
                reason=(
                    f"forced via {ENV_FORCE_UNSUPPORTED}=1 (test hook for "
                    "the dev-mode local->cloud reroute path)"
                )
            )

        if free_gpu_mib is not None and free_gpu_mib < MIN_FREE_GPU_MIB_FOR_LOCAL_CHAT:
            return LocalUnsupported(
                reason=(
                    f"only {free_gpu_mib} MiB GPU free; need at least "
                    f"{MIN_FREE_GPU_MIB_FOR_LOCAL_CHAT} MiB for a 4B chat model"
                )
            )

        if entry.id == "bonsai-2.5-27b" and targets_discrete_gpu(entry, hw):
            # Keep room for KaLM and the desktop on the validated 12 GiB card.
            return TunedLaunchArgs(
                ctx_size=entry.default_ctx,
                parallel=1,
                kv_unified=False,
                batch=512,
                ubatch=256,
                cache_ram_mib=0,
            )

        if targets_discrete_gpu(entry, hw):
            # A 256K window, which is the point of putting this tier on a discrete
            # board: at the registry's 100000 window, 8 of 116 agent tasks failed on
            # ContextOverflowError with inputs of 91k-103k tokens, and the effective
            # input ceiling is c - n_predict - 1024, so 100096 only admits 90880.
            # A 116-task run at 256K produced zero ContextOverflowError and lifted
            # L2 from 0.766 to 0.894; cache_ram_mib stays None as before.
            #
            # This REPLACES the parallel 3 + kv-unified arrangement that preceded it,
            # and that is a real trade, not an upgrade. Those values were measured at
            # the 100k window and are not affordable at 256K: kv-unified sizes the
            # recurrent state buffer for LLAMA_MAX_SEQ rather than n_seq_max
            # (150 -> 3591 MiB), and that 3441 MiB is the difference between fitting
            # and paging. With one slot n_ctx_seq is already the full n_ctx, so it also
            # buys nothing here. What is given up is measured: the 3-slot arrangement
            # cut an 8-task subset's prefill from 156 s to 71 s and raised cache reuse
            # from 77% to 94%, so a parent session and its sub-agents will evict each
            # other again. The window was worth more than the slots.
            #
            # b/ub 512 rather than the 2048 baseline: the draft shares the target's
            # memory and has no batch flags of its own, so this is the only dial that
            # shrinks both compute buffers. Measured on a 33456 MiB B70 with the draft
            # and the KaLM embedding model co-resident, 199699-token prefill: ub 512
            # peaks at 31824 MiB with shared memory flat (no spill), ub 1024 still put
            # 401 MiB into shared under load, and ub 2048 put 972 MiB there and never
            # finished the prefill.
            #
            # Costs at this window, both measured, worth knowing before raising it:
            # prefill 888 t/s and decode 7.26 t/s at 200k depth, against 63 t/s decode
            # at agent-typical depths.
            return TunedLaunchArgs(
                ctx_size=DISCRETE_GPU_CTX_SIZE,
                parallel=1,
                kv_unified=False,
                batch=512,
                ubatch=512,
                slot_prompt_similarity=0.50,
            )

        # Pick the most-demanding tier this box satisfies.
        for tier in _TIERS:
            if _meets(tier, hw):
                return TunedLaunchArgs(
                    ctx_size=tier.ctx_size,
                    parallel=tier.parallel,
                    cache_ram_mib=tier.cache_ram_mib,
                    slot_prompt_similarity=tier.slot_prompt_similarity,
                )

        # _TIERS ends with t1-tight which has 0/0 minimums, so we should
        # never reach here. Guard defensively in case the table is edited.
        return LocalUnsupported(
            reason=(
                f"no booster tier matched hardware "
                f"(ram={hw.total_ram_gb:.1f}GB mem_speed={hw.mem_speed_mts}MT/s)"
            )
        )


def channel_allows_substitution(channel: Channel) -> bool:
    """Re-export from ``build_channel`` for caller convenience.

    Imported here so the supervisor doesn't have to depend on two modules
    just to make the dev/RC decision after a ``LocalUnsupported`` verdict.
    """
    from .build_channel import allows_silent_local_to_cloud_substitution

    return allows_silent_local_to_cloud_substitution(channel)
