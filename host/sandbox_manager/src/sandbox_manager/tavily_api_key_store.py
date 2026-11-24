"""The host's Tavily API key (EG1-3, #12): sealed for the owner, in the Sandbox Manager's own data directory.

No tier account is granted that directory, and the seal is the owner's DPAPI scope, so a copy of the file
is useless to any other account. The key never crosses a tier as a file: the Connector still gets it
through the sealed provider config the native backend writes, which this store tells the backend to
refresh whenever the key changes.

A key openwork-server saved in its runtime settings before the host held it moves here once, and leaves
that file. The key is never logged and never audited; the audit says only that a move happened.
"""

from __future__ import annotations

import json
import threading
from collections.abc import Callable
from pathlib import Path
from typing import Protocol

from loguru import logger

from .owner_dpapi import atomic_write, protect_for_owner, unprotect_for_owner

_SECRET = "tavily_api_key"


class _Audit(Protocol):
    def record(self, event: str, **fields: str) -> None: ...


class TavilyApiKeyUnreadable(Exception):
    """A key file exists and this account cannot open it: not the same as no key saved."""


class TavilyApiKeyFileStore:
    def __init__(
        self,
        path: Path,
        *,
        audit: _Audit,
        protect: Callable[[bytes], bytes] = protect_for_owner,
        unprotect: Callable[[bytes], bytes] = unprotect_for_owner,
    ) -> None:
        self.path = path
        self._audit = audit
        self._protect = protect
        self._unprotect = unprotect
        self._listeners: list[Callable[[], None]] = []
        self._lock = threading.Lock()

    def is_configured(self) -> bool:
        try:
            return bool(self.read())
        except TavilyApiKeyUnreadable:
            return False

    def read(self) -> str | None:
        """The saved key, None when none is saved; a file this account cannot open raises."""
        # Under the lock a save holds while it replaces the file: a reader must not see half a save, and on
        # Windows `os.replace` fails while a reader has the file open.
        with self._lock:
            try:
                sealed = self.path.read_bytes()
            except FileNotFoundError:
                return None
            except OSError as exc:
                raise TavilyApiKeyUnreadable(type(exc).__name__) from None
        try:
            return self._unprotect(sealed).decode("utf-8")
        except Exception as exc:  # noqa: BLE001 - DPAPI raises pywintypes.error, which is not an OSError
            # The type only: a decode error can quote the bytes it could not decode.
            raise TavilyApiKeyUnreadable(type(exc).__name__) from None

    def is_enabled(self) -> bool:
        """False while the user has paused the saved key; the key itself stays in its file."""
        return not self._paused.exists()

    def set_enabled(self, enabled: bool) -> None:
        with self._lock:
            if enabled:
                self._paused.unlink(missing_ok=True)
            else:
                atomic_write(self._paused, b"")
        self._notify()

    def save(self, api_key: str) -> None:
        """Store the key; a key the user has just entered is switched on."""
        self._write(api_key)
        with self._lock:
            self._paused.unlink(missing_ok=True)
        self._notify()

    def clear(self) -> None:
        with self._lock:
            self.path.unlink(missing_ok=True)
            self._paused.unlink(missing_ok=True)
        self._notify()

    def subscribe(self, listener: Callable[[], None]) -> None:
        """Call `listener` after every save or clear; whatever it raises is logged and not passed on."""
        self._listeners.append(listener)

    def adopt_runtime_settings_key(self, runtime_settings: Path) -> bool:
        """Move the key openwork-server saved in `runtime_settings` into this store; True when one moved.

        The move happens once. Until then only the old save path writes that file, so a key in it is the
        user's latest save and replaces the one held here. In this order: the key is stored; a marker beside
        the store records that the move happened; the audit says so; the key leaves the old file. The key
        leaves the old file last because openwork-server blanks that file on its next settings write, so a
        key that failed to store would otherwise be lost. The audit comes after the store, not before as in
        the routes: failing closed here does not lose the key, but it does abort the start, and the move is
        then never recorded (the next start only removes what is left in the old file).

        Once the marker exists a key still in the old file is a leftover from a scrub or an audit that
        failed, never a newer save, so it is removed and never adopted. Nothing is touched when there is no
        key, and listeners are not told: the caller seals the Connector's copy next.
        """
        try:
            parsed = json.loads(runtime_settings.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return False
        search = parsed.get("search") if isinstance(parsed, dict) else None
        saved = search.get("tavilyApiKey") if isinstance(search, dict) else None
        api_key = saved.strip() if isinstance(saved, str) else ""
        if not api_key:
            return False
        if self._migrated.exists():
            self._scrub(runtime_settings, parsed, search)
            return False
        try:
            self._write(api_key)
        except Exception as exc:  # noqa: BLE001 - DPAPI raises pywintypes.error, which is not an OSError
            logger.warning(
                "tavily key: the runtime settings key was not stored and stays in its file "
                "event=adopt outcome=store_failed exception_type={} path={}",
                type(exc).__name__,
                self.path,
            )
            return False
        atomic_write(self._migrated, b"")
        self._audit.record("secret.migrated", secret=_SECRET)
        self._scrub(runtime_settings, parsed, search)
        return True

    @property
    def _migrated(self) -> Path:
        return self.path.with_suffix(".migrated")

    @property
    def _paused(self) -> Path:
        return self.path.with_suffix(".paused")

    def _scrub(self, runtime_settings: Path, parsed: dict, search: dict) -> None:
        """Take the key out of the old settings file, keeping every other setting."""
        del search["tavilyApiKey"]
        try:
            atomic_write(
                runtime_settings, (json.dumps(parsed, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
            )
        except OSError as exc:
            logger.warning(
                "tavily key: the key could not be removed from its old file; it is tried again at the next "
                "start event=adopt outcome=old_file_kept exception_type={} path={}",
                type(exc).__name__,
                runtime_settings,
            )

    def _write(self, api_key: str) -> None:
        with self._lock:
            atomic_write(self.path, self._protect(api_key.encode("utf-8")))

    def _notify(self) -> None:
        for listener in list(self._listeners):
            try:
                listener()
            except Exception as exc:  # noqa: BLE001 - the key is stored; a listener must not undo that
                logger.warning(
                    "tavily key: a change listener failed event=notify exception_type={}",
                    type(exc).__name__,
                )

