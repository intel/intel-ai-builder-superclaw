"""One log line before and one after each UAC elevation the broker client asks for.

Both lines are flat ``key=value`` pairs, so a log can be read with a grep::

    elevation: op=<op> event=begin
    elevation: op=<op> event=end outcome=<outcome> started_at=<UTC ISO 8601> wall_ms=<n> [consent_ms=<n> work_ms=<n>]

``op`` is the closed broker operation. This module is where the line grammar is defined; the installer's
``packaging/installer/elevation-log.ps1`` and the desktop app's ``installer_update.rs`` write the same lines
for their own ``op`` values and follow it. ``outcome`` is one of:

* ``succeeded``
* ``cancelled_by_user``: the launch call reported ``ERROR_CANCELLED`` (1223), i.e. the prompt was dismissed.
  Where only ``Start-Process``'s message survives, the system's text for 1223 is what identifies it.
* ``failed:<code>``, where ``<code>`` is the first of these that applies:

  * the typed refusal reason the emitter raised (this module: a ``BrokerRefusalReason`` value);
  * ``exit_<n>``: the elevated process ran and exited with non-zero code ``<n>``;
  * ``win32_<n>``: the launch call failed with Win32 error ``<n>`` (never 1223);
  * the class name of the exception the emitter caught.

``<code>`` never contains whitespace or ``=``, so ``outcome=(\\S+)`` reads it whole.

``consent_ms`` and ``work_ms`` appear only where the elevation protocol separates the prompt from the work.
``ShellExecuteExW`` returns once the prompt is answered and the elevated process exists, so a
``provision-session`` and a ``provision-identities-and-session`` have them. ``Start-Process -Wait`` returns only after the elevated broker has exited, so
``provision`` reports wall time alone, and that wall time includes starting PowerShell.

Every ``begin`` is followed by exactly one ``end``, whatever is raised in between, so every prompt shown has
one ``outcome=`` line. The converse needs one caveat: an attempt that failed before Windows could show the
prompt still logs ``failed:<code>``. Neither line carries a SID, a pipe id, a key, a path or a refusal's
detail text.
"""

from __future__ import annotations

import time
from datetime import datetime, timezone
from types import TracebackType
from typing import Literal, Self

from loguru import logger

from .elevate import (
    PROVISION_IDENTITIES_AND_SESSION,
    PROVISION_SESSION,
    ElevationCancelled,
    SessionOperation,
)
from .errors import BrokerClientRefusal

ElevationOp = Literal["provision", "provision-session", "provision-identities-and-session"]

#: The ``op`` each provision-session flag logs under: the flag without its dashes.
SESSION_ELEVATION_OPS: dict[SessionOperation, ElevationOp] = {
    PROVISION_SESSION: "provision-session",
    PROVISION_IDENTITIES_AND_SESSION: "provision-identities-and-session",
}


class ElevationLog:
    """Logs one elevation attempt. Call :meth:`begin` immediately before the call that prompts.

    Leaving the ``with`` block writes the ``end`` line. It writes nothing if :meth:`begin` never ran: an
    attempt refused before it reached the prompt is not an elevation.
    """

    def __init__(self, op: ElevationOp) -> None:
        self._op = op
        self._begun: tuple[datetime, float] | None = None
        self._consented: float | None = None

    def __enter__(self) -> Self:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        if self._begun is None:
            return
        started_at, started = self._begun
        wall_ms = _milliseconds(time.perf_counter() - started)
        timing = f"wall_ms={wall_ms}"
        if self._consented is not None:
            consent_ms = _milliseconds(self._consented - started)
            timing += f" consent_ms={consent_ms} work_ms={wall_ms - consent_ms}"
        logger.info(
            "elevation: op={} event=end outcome={} started_at={} {}",
            self._op,
            _outcome(exc),
            started_at.isoformat(timespec="milliseconds"),
            timing,
        )

    def begin(self) -> None:
        self._begun = (datetime.now(timezone.utc), time.perf_counter())
        logger.info("elevation: op={} event=begin", self._op)

    def consented(self) -> None:
        """Marks the prompt answered: the elevated process exists, and what follows is its work."""
        self._consented = time.perf_counter()


def _outcome(exc: BaseException | None) -> str:
    if exc is None:
        return "succeeded"
    if _dismissed(exc):
        return "cancelled_by_user"
    if isinstance(exc, BrokerClientRefusal) and exc.items:
        return f"failed:{exc.items[0].reason.value}"
    return f"failed:{type(exc).__name__}"


def _dismissed(exc: BaseException) -> bool:
    """Whether the prompt itself was dismissed, however the refusal raised for it has been wrapped since."""
    cause: BaseException | None = exc
    while cause is not None:
        if isinstance(cause, ElevationCancelled):
            return True
        cause = cause.__cause__
    return False


def _milliseconds(seconds: float) -> int:
    return round(seconds * 1000)
