"""The receipt error for a Runtime start that failed because the sandbox could not be provisioned.

SandboxManager puts the closed ``BrokerRefusalReason`` word in failed Runtime evidence's ``error.code``.
This turns a known word into the public ``runtime_provision_failed`` error: the word as ``reason`` and the
curated sentence for it from the activation contract. The sentence is looked up by word and never built
from evidence free text, paths, SIDs or exception messages, and a word the contract does not list keeps
the generic failure.
"""

from __future__ import annotations

from contracts.runtime_provision_failure_data import RUNTIME_PROVISION_FAILURE_COPY


def provision_failure_code(evidence: object) -> str | None:
    """The contract's refusal word on failed Runtime evidence, else ``None``."""
    code = getattr(getattr(evidence, "error", None), "code", None)
    return code if isinstance(code, str) and code in RUNTIME_PROVISION_FAILURE_COPY else None


def provision_failure_error(reason: str | None) -> dict[str, object] | None:
    """The public receipt error for ``reason``; ``None`` for an unlisted reason."""
    if reason is None or reason not in RUNTIME_PROVISION_FAILURE_COPY:
        return None
    return {
        "code": "runtime_provision_failed",
        "reason": reason,
        "message": RUNTIME_PROVISION_FAILURE_COPY[reason],
    }
