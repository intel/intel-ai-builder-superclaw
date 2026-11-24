"""Read-only native projection onto existing readiness component names."""
from __future__ import annotations

import asyncio
from typing import Any

from .native_deployment import NativeEvidencePending
from .readiness import COMPONENT_NAMES, RuntimeComponent


# OpenWork + Connector each retain their 2s HTTP timeout, with 1s local
# allowance. HDR's 10s probe runs separately in the bounded status observation;
# it must not be nested inside this 5s read or ServiceHub's 8s refresh ceiling.
NATIVE_READINESS_TIMEOUT_S = 5.0


async def native_components(lifecycle: Any) -> list[RuntimeComponent]:
    try:
        evidence = (await asyncio.wait_for(
            lifecycle.runtime_readiness_evidence(), timeout=NATIVE_READINESS_TIMEOUT_S,
        )).root
    except NativeEvidencePending:
        # Nothing scheduled yet, or a superseded/torn observation: proof is still on its
        # way, which the readiness contract reports as a cold start, not as missing evidence.
        return [RuntimeComponent(name, "starting", "probe_pending") for name in COMPONENT_NAMES]
    except Exception:
        return [RuntimeComponent(name, "unknown", "evidence_unavailable") for name in COMPONENT_NAMES]
    state = {"ready": "ready", "applying": "starting", "failed": "failed"}[evidence.status]
    reason = {"ready": None, "applying": "probe_pending", "failed": "not_running"}[evidence.status]
    recovery_reason = lifecycle._supervision.recovery_reason() if state == "failed" else None
    # sandbox_container is the existing wire component name; no container ID is invented.
    return [RuntimeComponent(
        name=name,
        state=state,
        reason_code=recovery_reason if name == "sandbox_container" and recovery_reason else reason,
        instance_id=evidence.runtime_instance_id,
        active_revision=evidence.profile_revision,
        applied_revision=evidence.profile_revision if state == "ready" else None,
    ) for name in COMPONENT_NAMES]