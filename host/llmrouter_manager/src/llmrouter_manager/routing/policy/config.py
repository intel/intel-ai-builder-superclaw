"""Serving-policy configuration resolution (env-first, Tier-2 knobs).

Ported from ``D:/routing_service/sidecar.py`` config resolvers, adapted to
SuperClaw. The routing policy is ON by default and can be explicitly disabled
via ``LATENTFACTOR_ROUTING_POLICY`` set to a falsy value (0/false/no/off);
individual knobs follow the env>config>default precedence documented in plan
§13 (Tier-2 = internal experiment knobs, not GUI).

A ``routing:`` config dict may be threaded in later (plan §5e); for now the
knobs resolve from env with built-in defaults, so no config-schema change is
required to ship Phase 1.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Optional

from loguru import logger

from .compaction_tracker import (
    resolve_fresh_read_jump_tokens,
    resolve_max_local_compaction,
)
from .context_cap import _DEFAULT_OUTPUT_RESERVE


def policy_enabled() -> bool:
    """True when the serving-policy middleware is switched on. ON by default —
    set ``LATENTFACTOR_ROUTING_POLICY`` to a falsy value (0/false/no/off) to
    disable. Unset or any other value → enabled."""
    raw = os.environ.get("LATENTFACTOR_ROUTING_POLICY", "").strip().lower()
    return raw not in ("0", "false", "no", "off")


def _env_int(name: str, default: int, minimum: Optional[int] = None) -> int:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    try:
        v = int(raw)
    except ValueError:
        logger.warning("invalid {}={!r}; using default {}", name, raw, default)
        return default
    if minimum is not None and v < minimum:
        return minimum
    return v


@dataclass(frozen=True)
class RoutingPolicyConfig:
    """Resolved Tier-2 serving-policy knobs (env-first)."""

    enabled: bool
    max_local_compaction: int
    fresh_read_jump_tokens: int
    output_reserve: int
    max_context: Optional[str]  # raw env/config value, resolved against the probe
    max_input_tokens: Optional[int]  # explicit cap override; None = auto-derive

    @classmethod
    def resolve(cls, routing_cfg: Optional[dict] = None) -> "RoutingPolicyConfig":
        cfg = routing_cfg or {}
        max_input = cfg.get("max_input_tokens")
        try:
            max_input = int(max_input) if max_input is not None else None
        except (TypeError, ValueError):
            max_input = None
        return cls(
            enabled=policy_enabled(),
            max_local_compaction=resolve_max_local_compaction(
                arg_value=None,
                env_value=os.environ.get("LATENTFACTOR_MAX_LOCAL_COMPACTION"),
            ),
            fresh_read_jump_tokens=resolve_fresh_read_jump_tokens(
                arg_value=None,
                env_value=os.environ.get("LATENTFACTOR_FRESH_READ_JUMP_TOKENS"),
            ),
            output_reserve=_env_int(
                "LATENTFACTOR_OUTPUT_RESERVE",
                int(cfg.get("output_reserve", _DEFAULT_OUTPUT_RESERVE)),
                minimum=0,
            ),
            max_context=os.environ.get("LATENTFACTOR_MAX_CONTEXT")
            or (str(cfg["max_context"]) if cfg.get("max_context") is not None else None),
            max_input_tokens=max_input,
        )
