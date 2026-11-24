"""Expiry sweep of the persistent inference cache while the sanitizer is dormant."""

from __future__ import annotations

import logging
import sqlite3
import time
from pathlib import Path

from protection_service.config import SanitizeConfig
from protection_service.model_activation import exe_dir

logger = logging.getLogger(__name__)


def sweep_expired(cfg: SanitizeConfig) -> int:
    """Reap expired persistent rows without starting the sanitizer.

    Returns the number of rows removed. Best-effort: persistence must never block
    service startup or turn a dormant sanitizer into a degraded one.
    """
    if not cfg.persistent_cache:
        return 0

    cache_dir = Path(cfg.cache_dir)
    if not cache_dir.is_absolute():
        cache_dir = Path(exe_dir()) / cache_dir
    db_path = cache_dir / "inference_cache.sqlite"
    if not db_path.is_file():
        return 0

    try:
        conn = sqlite3.connect(str(db_path), timeout=5.0, isolation_level=None)
        try:
            conn.execute("PRAGMA busy_timeout=5000")
            columns = {
                str(row[1])
                for row in conn.execute("PRAGMA table_info(cache)").fetchall()
            }
            if "expires_at" not in columns:
                return 0
            cursor = conn.execute(
                "DELETE FROM cache WHERE expires_at != 0 AND expires_at <= ?",
                (int(time.time()),),
            )
            return (
                cursor.rowcount
                if cursor.rowcount is not None and cursor.rowcount > 0
                else 0
            )
        finally:
            conn.close()
    except Exception:
        logger.debug("Error sweeping dormant persistent cache", exc_info=True)
        return 0
