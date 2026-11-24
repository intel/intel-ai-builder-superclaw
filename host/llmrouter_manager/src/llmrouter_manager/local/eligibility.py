"""Strict hardware eligibility gate for local LLM provisioning.

Distinct from ``policy.select_chat_model``:

* ``select_chat_model`` always returns *some* chat model (falls back to the
  lowest tier if nothing matches) so pre-existing builds keep booting on dev
  machines with a small fallback model.
* ``evaluate_local_llm_eligibility`` is a strict gate: the host must match the
  ``requirements`` block of a non-fallback chat model (i.e. the 35B tier).
  Otherwise **no** local model is provisioned (neither chat nor embedding
  llama-server is started) and the user is expected to configure an edge
  model in the UI.

Decision contract (locked with the user 2026-06-03):

* CPU brand string is probed and reported for diagnostics but does **not**
  participate in the verdict.
* A chat model qualifies as "non-fallback" when its registry entry declares a
  non-empty ``requirements`` block. A fallback entry using ``requirements:
  null`` is never sufficient to flip the gate.
* The host is eligible iff at least one non-fallback chat model's
  ``requirements`` are satisfied by the probed hardware (iGPU keywords,
  ``min_ram_gb``, ``min_mem_speed_mts``). The highest-tier matching entry is
  exposed as ``local_chat_model``.
* When eligible, the first embedding model in the registry is paired with the
  chat model and exposed as ``local_embedding_model`` (today: KaLM v2.5).
* Otherwise -> ineligible: LRM skips download + llama-server launch entirely.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .hardware import HardwareInfo
from .policy import _meets, _tier_score
from .registry import ROLE_CHAT, ROLE_EMBEDDING, ModelEntry, Registry


@dataclass(frozen=True)
class EligibilityResult:
    eligible: bool
    reason: str
    hardware: HardwareInfo
    local_chat_model: ModelEntry | None
    local_embedding_model: ModelEntry | None

    def to_dict(self) -> dict[str, Any]:
        hw = self.hardware
        return {
            "eligible": self.eligible,
            "reason": self.reason,
            "hardware": {
                "cpu_brand": hw.cpu_brand or "",
                "igpu_names": list(hw.igpu_names),
                "total_ram_gb": round(hw.total_ram_gb, 2),
                "mem_speed_mts": hw.mem_speed_mts,
            },
            "local_chat_model": _model_summary(self.local_chat_model),
            "local_embedding_model": _model_summary(self.local_embedding_model),
        }


def _model_summary(m: ModelEntry | None) -> dict[str, Any] | None:
    if m is None:
        return None
    return {"id": m.id, "name": m.name}


def evaluate_local_llm_eligibility(
    hw: HardwareInfo, registry: Registry
) -> EligibilityResult:
    chats = registry.by_role(ROLE_CHAT)
    qualifying = [m for m in chats if m.requirements]
    matching = [m for m in qualifying if _meets(m.requirements, hw)]

    if not matching:
        igpu_repr = list(hw.igpu_names) or ["<none>"]
        return EligibilityResult(
            eligible=False,
            reason=(
                f"no qualifying chat model matches host "
                f"(ram={hw.total_ram_gb:.1f}GB, mem_speed={hw.mem_speed_mts}MT/s, "
                f"igpu={igpu_repr})"
            ),
            hardware=hw,
            local_chat_model=None,
            local_embedding_model=None,
        )

    matching.sort(key=lambda m: _tier_score(m.requirements), reverse=True)
    chosen_chat = matching[0]
    embeddings = registry.by_role(ROLE_EMBEDDING)
    chosen_embedding = embeddings[0] if embeddings else None
    return EligibilityResult(
        eligible=True,
        reason=f"matched {chosen_chat.id}",
        hardware=hw,
        local_chat_model=chosen_chat,
        local_embedding_model=chosen_embedding,
    )
