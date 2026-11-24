"""Shared utilities for the ``/sandbox-manager/v1`` router package."""

from __future__ import annotations

from pathlib import Path


# ------------------------------------------------------------------ operation ids

# Transport prefix for operation ids crossing the sandbox-manager API boundary.
#
# ServiceHub routes ``/app/operations/{operation_id}`` to the owning service by a
# short prefix (servicehub ``app_routes/operations.py`` →
# ``_OPERATION_PREFIX_TO_PROXY_PREFIX``); ``sm:`` maps to ``/sandbox-manager``.
# The Hub *also* validates ids against ``^[A-Za-z][A-Za-z0-9_-]*:[A-Za-z0-9_-]+$``,
# so a bare ``run_...`` id is both un-routable and rejected (400) by the Hub.
#
# sandbox-manager therefore presents every operation id at its API boundary WITH
# the ``sm:`` prefix and strips it back to the bare DB ``run_id`` on inbound
# operation lookups. Internally (store / RunManager) ids stay bare.
OPERATION_ID_PREFIX = "sm:"


def to_operation_id(run_id: str) -> str:
    """Bare DB ``run_id`` → wire ``operation_id`` (``sm:``-prefixed).

    Idempotent: an already-prefixed id is returned unchanged.
    """
    if run_id.startswith(OPERATION_ID_PREFIX):
        return run_id
    return f"{OPERATION_ID_PREFIX}{run_id}"


def to_run_id(operation_id: str) -> str:
    """Wire ``operation_id`` → bare DB ``run_id``.

    Strips a leading ``sm:`` when present; a bare id passes through unchanged so
    direct/legacy callers that still send the raw DB id keep working.
    """
    return operation_id.removeprefix(OPERATION_ID_PREFIX)


def server_state(snap_state: str) -> str:
    """Map supervisor internal state to api.md ``server_state`` enum.

    supervisor reports ``"ready"``; api.md enum is
    ``stopped | starting | running | error``.
    """
    return "running" if snap_state == "ready" else snap_state


def tail_lines(path: Path, n: int) -> list[str]:
    """Return the last *n* lines of *path* without loading the whole file.

    Reads backwards in 4 KB chunks until enough newlines are accumulated.
    Returns an empty list if the file does not exist or cannot be read.
    """
    try:
        with path.open("rb") as f:
            f.seek(0, 2)
            size = f.tell()
            block = 4096
            data = b""
            while size > 0 and data.count(b"\n") <= n:
                read = min(block, size)
                size -= read
                f.seek(size)
                data = f.read(read) + data
        text = data.decode("utf-8", errors="replace")
        return text.splitlines()[-n:]
    except OSError:
        return []
