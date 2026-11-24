"""Build-channel detection for graceful local-LLM degradation.

Three build channels gate whether the booster may silently reroute
``local-model`` calls to the configured cloud upstream when the hardware
probe says the box can't realistically run the local model:

* ``dev``               - engineers iterating locally. Silent reroute is
                          **permitted** so an under-spec dev box keeps moving.
* ``release-candidate`` - RC validates user-fidelity behavior; silent
                          substitution is **disabled** so an under-spec box
                          fails preflight and the merge gate reflects reality.
* ``main``              - production. Same fidelity rule as RC.

The channel is read from the ``SUPERCLAW_BUILD_CHANNEL`` env var. When unset,
empty, or invalid we default to ``dev`` (the most-permissive channel) because
an unbundled ``uv run`` invocation is the only context where the var is
expected to be absent.
"""

from __future__ import annotations

import os
from typing import Final, Literal

Channel = Literal["dev", "release-candidate", "main"]

DEFAULT_CHANNEL: Final[Channel] = "dev"
ENV_VAR: Final[str] = "SUPERCLAW_BUILD_CHANNEL"

_VALID: Final[frozenset[str]] = frozenset({"dev", "release-candidate", "main"})


def detect_channel() -> Channel:
    """Return the build channel for this binary.

    Reads ``$SUPERCLAW_BUILD_CHANNEL`` and validates it against the known set;
    falls back to ``dev`` when the env var is unset, empty, or invalid. An
    invalid value is **not** an error - treating it as ``dev`` keeps engineers
    unblocked, and the booster's hard-fail behavior is reserved for the
    explicit ``release-candidate`` / ``main`` channels.
    """
    raw = (os.environ.get(ENV_VAR) or "").strip().lower()
    if raw in _VALID:
        return raw  # type: ignore[return-value]
    return DEFAULT_CHANNEL


def allows_silent_local_to_cloud_substitution(channel: Channel) -> bool:
    """Whether this channel may transparently reroute local->cloud when the
    hardware probe says local can't run.

    Only ``dev`` permits the silent substitution. ``release-candidate`` and
    ``main`` must surface under-spec hardware as an explicit failure.
    """
    return channel == "dev"
