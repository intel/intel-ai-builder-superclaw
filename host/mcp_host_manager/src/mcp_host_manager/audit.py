"""The gateway's audit trail: one JSON line per event in ``audit.jsonl`` in the state directory, and
the same event in the service log.

Callers pass names, ids, counts and decisions only. Argument values, environment values and tokens
are never handed to ``record``. The file rotates at 5 MB and keeps one previous file.
"""

from __future__ import annotations

import json
import os
import threading
from datetime import UTC, datetime
from pathlib import Path

from loguru import logger

AUDIT_FILE = "audit.jsonl"
_ROTATE_BYTES = 5 * 1024 * 1024

AuditValue = str | int | bool | None


def utc_instant(moment: datetime) -> str:
    """RFC 3339 UTC instant with millisecond precision, e.g. ``2026-10-06T18:40:00.000Z``."""
    moment = moment.astimezone(UTC)
    return f"{moment:%Y-%m-%dT%H:%M:%S}.{moment.microsecond // 1000:03d}Z"


class AuditLog:
    def __init__(self, state_dir: Path) -> None:
        self._path = state_dir / AUDIT_FILE
        self._lock = threading.Lock()

    @property
    def path(self) -> Path:
        return self._path

    def record(self, event: str, **fields: AuditValue) -> None:
        entry = {"at": utc_instant(datetime.now(UTC)), "event": event, **fields}
        logger.info("audit {}", json.dumps(entry, ensure_ascii=False, sort_keys=True))
        line = json.dumps(entry, ensure_ascii=False, separators=(",", ":")) + "\n"
        with self._lock:
            try:
                self._path.parent.mkdir(parents=True, exist_ok=True)
                if self._path.exists() and self._path.stat().st_size >= _ROTATE_BYTES:
                    os.replace(self._path, self._path.with_name(AUDIT_FILE + ".1"))
                with self._path.open("a", encoding="utf-8") as handle:
                    handle.write(line)
            except OSError as exc:
                logger.error("audit line not written event={} error={}", event, type(exc).__name__)
