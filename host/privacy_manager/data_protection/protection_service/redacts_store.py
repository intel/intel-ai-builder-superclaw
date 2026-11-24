"""TTL-managed store for path-mode masked CSVs.

Each entry is `{file_id: (path, expires_at)}`. A background sweeper task
unlinks expired files. There are no IDs in the public API -- the client
gets a path back and the server reaps it on schedule. The store is
in-memory; on restart, expired files left behind are cleaned by a one-shot
startup sweep that removes anything older than `max_ttl_seconds`.
"""

from __future__ import annotations

import asyncio
import logging
import os
import secrets
import threading
import time
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger(__name__)


def _restrict_permissions(path: Path) -> None:
    """Best-effort tighten a redact file to owner-only (0600) on POSIX.

    A PII registry or masked output sitting under ``redacts_dir`` should
    not be readable by other local users on a shared host. On POSIX we
    chmod to 0600; on Windows we rely on the parent directory's ACL and
    log at DEBUG only.
    """
    if os.name != "posix":
        return
    try:
        os.chmod(path, 0o600)
    except OSError as exc:  # pragma: no cover -- best effort
        logger.debug(
            "Could not chmod %s to 0600: %s", path, exc,
        )


@dataclass(frozen=True)
class RedactEntry:
    file_id: str
    path: Path
    expires_at: float          # epoch seconds


class RedactsStore:
    def __init__(self, redacts_dir: Path, max_ttl_seconds: int) -> None:
        self.redacts_dir = redacts_dir
        self.max_ttl_seconds = max_ttl_seconds
        self._entries: dict[str, RedactEntry] = {}
        self._lock = threading.Lock()
        # Extra reapers run on each sweep tick so all on-disk PII hygiene
        # (redact files + the persistent-cache L2) shares one cadence and one
        # background task. Each returns the number of items it removed.
        self._sweep_hooks: list = []
        self.redacts_dir.mkdir(parents=True, exist_ok=True)

    def add_sweep_hook(self, hook) -> None:
        """Register a ``() -> int`` reaper invoked on every ``sweep_once``.

        Used to fold other TTL cleanups (e.g. the persistent inference cache)
        into the existing sweeper loop. Hook errors are swallowed so one
        misbehaving reaper never stalls the sweep.
        """
        self._sweep_hooks.append(hook)

    # ------------------------------------------------------------------
    # Allocate / record
    # ------------------------------------------------------------------

    def allocate_path(self, suffix: str = ".csv") -> tuple[str, Path]:
        """Reserve a unique file path for a new redact. Caller writes to it.

        ``suffix`` sets the output extension (default ``.csv``) so path-mode
        can preserve a columnar source format, e.g. ``.parquet``. The orphan
        sweep in :meth:`sweep_once` reaps any leftover file regardless of
        extension, so a non-CSV suffix is still cleaned on TTL.
        """
        if not suffix.startswith("."):
            suffix = "." + suffix
        file_id = "r_" + secrets.token_hex(8)
        path = self.redacts_dir / f"{file_id}{suffix}"
        return file_id, path

    def register(self, file_id: str, path: Path, ttl_seconds: int) -> RedactEntry:
        """Record a written file with its deletion deadline.

        Also tightens the file to 0600 on POSIX so co-tenants on the host
        cannot read the masked output or the placeholder registry (both
        of which contain PII — the registry maps placeholders back to
        real values).
        """
        ttl = max(1, min(ttl_seconds, self.max_ttl_seconds))
        entry = RedactEntry(
            file_id=file_id,
            path=path,
            expires_at=time.time() + ttl,
        )
        _restrict_permissions(path)
        with self._lock:
            self._entries[file_id] = entry
        return entry

    # ------------------------------------------------------------------
    # Sweep
    # ------------------------------------------------------------------

    def sweep_once(self, *, now: float | None = None) -> int:
        """Delete every entry whose deadline has passed. Returns count.

        Also unlinks any *.csv in `redacts_dir` whose mtime is older than
        max_ttl_seconds even if it's not in `_entries`. That covers files
        left behind by a previous server process that exited uncleanly.
        """
        now = now if now is not None else time.time()
        evicted = 0

        with self._lock:
            to_remove = [
                fid for fid, e in self._entries.items() if e.expires_at <= now
            ]
            for fid in to_remove:
                entry = self._entries.pop(fid)
                _unlink_quiet(entry.path)
                evicted += 1

        # Disaster recovery: orphan files older than max_ttl_seconds.
        # Cheap because most directories will be empty in steady state.
        cutoff = now - self.max_ttl_seconds
        try:
            for child in self.redacts_dir.iterdir():
                if not child.is_file():
                    continue
                try:
                    mtime = child.stat().st_mtime
                except OSError:
                    continue
                if mtime < cutoff:
                    _unlink_quiet(child)
                    evicted += 1
        except OSError:
            pass

        # Fold in registered reapers (e.g. the persistent-cache L2 sweep) so
        # every on-disk TTL cleanup runs on this one cadence.
        for hook in self._sweep_hooks:
            try:
                evicted += hook() or 0
            except Exception:
                logger.exception("[sweeper] sweep hook failed")

        return evicted

    async def sweeper_loop(self, interval_seconds: int = 60) -> None:
        """Background task -- run from FastAPI lifespan."""
        while True:
            try:
                await asyncio.sleep(interval_seconds)
                count = self.sweep_once()
                if count:
                    logger.info("[sweeper] evicted %d expired redact(s)", count)
            except asyncio.CancelledError:
                raise
            except Exception:  # pragma: no cover -- defensive
                logger.exception("[sweeper] error during sweep")


def _unlink_quiet(path: Path) -> None:
    try:
        path.unlink()
    except FileNotFoundError:
        pass
    except OSError as exc:  # pragma: no cover
        logger.warning("[sweeper] could not delete %s: %s", path, exc)
