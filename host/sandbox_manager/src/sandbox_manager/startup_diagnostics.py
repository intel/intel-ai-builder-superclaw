"""Greppable per-stage startup measurements for the Windows-native backend.

The orchestrator already emits `PUBLICATION_DIAG=` lines for the stages that publish a
Runtime generation. This is the same idea for the stages that run in the manager, so one
boot can be read end to end instead of only its publication tail: every line is
`STARTUP_DIAG=` followed by one JSON object carrying a stage, an event and counts.

A duration on its own cannot separate "many files" from "slow per file", so stages report
file and byte counts next to `elapsed_ms`. That is the distinction a startup optimization
decision turns on, and guessing it is what the performance plan forbids.

Like its TypeScript counterpart this records measurements only. Values are filtered rather
than trusted: counts must be non-negative integers and labels must be short lowercase
tokens, so an absolute path, environment value, manifest excerpt or credential cannot
reach a log line through this module even by mistake. Diagnostics never decide whether a
startup step succeeded, so emission failures are swallowed.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
import json
import re
import time
from typing import Any

from loguru import logger

_LABEL_PATTERN = re.compile(r"^[a-z][a-z0-9_]{0,47}$")


def _clean(fields: dict[str, Any]) -> dict[str, Any]:
    cleaned: dict[str, Any] = {}
    for key, value in fields.items():
        # `stage` and `event` identify the line itself and may not be shadowed by a field.
        if key in {"stage", "event"} or not _LABEL_PATTERN.fullmatch(key):
            continue
        # bool is an int subclass, and a stray flag logged as a count would be misread.
        if isinstance(value, bool):
            cleaned[key] = value
        elif isinstance(value, int) and value >= 0:
            cleaned[key] = value
        elif isinstance(value, str) and _LABEL_PATTERN.fullmatch(value):
            cleaned[key] = value
    return cleaned


def startup_diagnostic(stage: str, event: str, /, **fields: Any) -> None:
    """Emit one measurement line, dropping anything that is not a count or a short label.

    `stage` and `event` are positional-only so that a caller splatting a measured dict
    cannot collide with them: a `stage` key in that dict is a field to be filtered, not a
    duplicate argument that raises.
    """
    if not _LABEL_PATTERN.fullmatch(stage) or not _LABEL_PATTERN.fullmatch(event):
        return
    try:
        payload = json.dumps({"stage": stage, "event": event, **_clean(fields)})
        logger.info("STARTUP_DIAG={}", payload)
    except Exception:  # noqa: BLE001 - a diagnostic must never fail its caller.
        pass


@contextmanager
def startup_stage(stage: str, /, **fields: Any) -> Iterator[dict[str, Any]]:
    """Time one stage, reporting counts the body records into the yielded dict.

    The body mutates the dict, so a stage that discovers its own file count partway
    through still reports it, and a stage that fails reports what it had measured.
    """
    counts: dict[str, Any] = {}
    started = time.perf_counter()
    startup_diagnostic(stage, "begin", **fields)

    def report(event: str) -> None:
        # Merged rather than double-splatted: a stage recording a key it was also opened
        # with should report its measured value, not raise for a duplicate argument.
        measured = {**fields, **counts}
        measured["elapsed_ms"] = round((time.perf_counter() - started) * 1000)
        startup_diagnostic(stage, event, **measured)

    try:
        yield counts
    except BaseException:
        report("failed")
        raise
    report("end")
