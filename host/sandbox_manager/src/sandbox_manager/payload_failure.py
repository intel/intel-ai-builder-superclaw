"""Bounded reason codes and user remedies for native payload failures.

A status message reaches the desktop UI, so it carries a code and a fixed remedy, never the
verifier's own text: that names paths and bytes under Program Files and %LOCALAPPDATA%.
"""

from __future__ import annotations

from dataclasses import dataclass
import errno
from typing import Any

from .payload_integrity import PayloadFailureReason, PayloadIntegrityError

REINSTALL = "Repair or reinstall SuperClaw."

# The remedy a user can act on, appended to the status message for these reasons.
PAYLOAD_FAILURE_DETAIL: dict[PayloadFailureReason, str] = {
    "payload_disk_full": (
        "Free some disk space on the drive that holds %LOCALAPPDATA%, then restart SuperClaw."
    ),
    "payload_io_error": "Restart SuperClaw; if this keeps happening, repair or reinstall it.",
    "payload_in_use": (
        "The previous SuperClaw backend is still running. Quit SuperClaw, wait a few seconds, "
        "then start it again."
    ),
    "installed_payload_missing": REINSTALL,
    "installed_payload_archive_invalid": REINSTALL,
}

_FAILURE_PREFIX = "native backend payload integrity failure"
_RECOVERY = "rebuild_or_reinstall_native_payload"
# Setup reads the installed payload and staging writes it; a failure in either repeats on retry.
_REPEATING_PHASES = frozenset({"setup", "staging"})


@dataclass(frozen=True)
class PayloadFailure:
    """A payload failure the API reports by its fields rather than by parsing `message`."""

    message: str
    reason: PayloadFailureReason
    remedy: str
    # Only an in-use payload: it clears once the previous backend exits.
    retryable: bool
    # False for a phase whose failure a retry may clear; the API reports that as not ready.
    reported: bool


PAYLOAD_IN_USE = PayloadFailure(
    message=(
        "native backend payload update refused reason=payload_in_use "
        "recovery=stop_backend_and_retry"
    ),
    reason="payload_in_use",
    remedy=PAYLOAD_FAILURE_DETAIL["payload_in_use"],
    retryable=True,
    reported=True,
)


def safe_payload_reason(error: Exception) -> PayloadFailureReason:
    """The bounded code for a payload failure, never derived from its text."""
    if isinstance(error, PayloadIntegrityError):
        return error.reason
    if isinstance(error, OSError):
        return "payload_disk_full" if error.errno == errno.ENOSPC else "payload_io_error"
    return "payload_verification_failed"


def payload_failure_message(
    phase: str, reason: PayloadFailureReason, detail: str | None = None
) -> str:
    """The status message for a payload failure."""
    message = f"{_FAILURE_PREFIX} phase={phase} reason={reason} recovery={_RECOVERY}"
    detail = detail or PAYLOAD_FAILURE_DETAIL.get(reason)
    return message if detail is None else f"{message}; {detail}"


def payload_failure(
    phase: str, reason: PayloadFailureReason, detail: str | None = None
) -> PayloadFailure:
    return PayloadFailure(
        message=payload_failure_message(phase, reason, detail),
        reason=reason,
        remedy=detail or PAYLOAD_FAILURE_DETAIL.get(reason, REINSTALL),
        retryable=False,
        reported=phase in _REPEATING_PHASES,
    )


def error_status(
    message: str,
    failure: PayloadFailure | None,
    provision_failure: tuple[str, str] | None = None,
) -> dict[str, Any]:
    """The lifecycle's error status; `failure` describes it only if `message` is still its own.

    `provision_failure` is `(refusal word, the message it came with)`: the closed
    `BrokerRefusalReason` word is reported as a field, so a reader never parses `message`,
    which also carries the refusal's detail text.
    """
    status: dict[str, Any] = {"phase": "error", "mode": "native", "message": message}
    if failure is not None and failure.reported and failure.message == message:
        status["payload_failure"] = {
            "reason": failure.reason,
            "remedy": failure.remedy,
            "retryable": failure.retryable,
        }
    if provision_failure is not None and provision_failure[1] == message:
        status["provision_failure"] = {"reason": provision_failure[0]}
    return status
