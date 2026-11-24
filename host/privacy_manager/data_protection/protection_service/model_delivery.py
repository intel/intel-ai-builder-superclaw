"""When the privacy models are downloaded, and what the service reports meanwhile.

``SanitizeManager`` starts delivery once, when the dormant sanitizer first wakes. Each model the sanitize
config refers to counts as present when its verified per-user copy exists, or
when a directory the service already resolves (the bundled copy of an older
install, the repo copy of a source run) holds every pinned file at its pinned
    size and sha256.
    Settings asks for consent before first enabling File Protection. Startup may verify
    and activate model files that are already present; missing models are downloaded
    only through the consented ``prepare_models`` path.
After each model lands the sanitizer is rebuilt in-process, so NER turns on
without a restart.

``models_state`` on ``/health``:

    ready        every model present and active
    downloading  bytes moving; ``done_bytes`` / ``total_bytes`` count progress
    verifying    hashing files a previous attempt left behind
    activating   files installed, sanitizer reloading
    failed       ``error`` says why; retried after ``RETRY_BACKOFF_S``, longer each time
    disabled     ``sanitize.enabled`` is false, so nothing is needed
    pending      delivery not started yet
    unsupported  a configured model path cannot be verified by the pinned manifest

Requests that need NER fail closed until the PII model is active (see
``model_activation.require_pii_model``).
"""

from __future__ import annotations

import logging
import ssl
import threading
import time
from collections.abc import Callable, Iterable, Mapping
from pathlib import Path

from common.model_names import ov_sibling_name

from protection_service.model_download import (
    DownloadError,
    ModelSpec,
    dir_hashes_match,
    dir_matches,
    download_model,
    is_installed,
    load_manifest,
    resolve_base_url,
    size_mismatches,
)
from protection_service.paths import default_models_dir
from protection_service.schemas import ModelsState

logger = logging.getLogger(__name__)

READY: ModelsState = "ready"
DOWNLOADING: ModelsState = "downloading"
VERIFYING: ModelsState = "verifying"
ACTIVATING: ModelsState = "activating"
FAILED: ModelsState = "failed"
DISABLED: ModelsState = "disabled"
PENDING: ModelsState = "pending"

# Wait before the next request-triggered attempt after the 1st, 2nd and later failed attempts
# in a row. Each attempt can transfer the whole PII archive again, so it must not repeat at
# the pace of the requests.
RETRY_BACKOFF_S = (300.0, 900.0, 3600.0)
RETRY_AFTER_FAILURE_S = RETRY_BACKOFF_S[0]

_LFS_POINTER_MAX_BYTES = 1024
_RECHECKOUT_HINT = (
    "delete the text files under host/privacy_manager/data_protection/models/* and run "
    "'git checkout -- host/privacy_manager/data_protection/models' (a checkout made "
    "with core.autocrlf=true converted them to CRLF)"
)


class ModelDelivery:
    """Download state for the manifest's models, shared by health and the gate."""

    def __init__(
        self,
        manifest: Mapping[str, ModelSpec] | None = None,
        models_dir: Path | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._manifest = dict(manifest) if manifest is not None else load_manifest()
        self._models_dir = models_dir
        self._clock = clock
        self._lock = threading.Lock()
        self._state: ModelsState = PENDING
        self._done_bytes = 0
        self._total_bytes = 0
        self._error: str | None = None
        self._restart_reason: str | None = None
        self._gate_model: str | None = None
        self._active: set[str] = set()
        self._last_attempt: float | None = None
        self._failed_attempts = 0
        self._hashes_checked: dict[str, bool] = {}
        self._dirs_hashed: dict[str, bool] = {}
        self._hash_lock = threading.Lock()

    # ------------------------------------------------------------------
    # Where models live
    # ------------------------------------------------------------------

    @property
    def models_dir(self) -> Path:
        return self._models_dir if self._models_dir is not None else default_models_dir()

    def spec(self, name: str) -> ModelSpec | None:
        return self._manifest.get(name)

    def manifest_name_for(self, dir_name: str) -> str | None:
        """Manifest model a configured directory name refers to, if any."""
        if dir_name in self._manifest:
            return dir_name
        sibling = ov_sibling_name(dir_name)
        return sibling if sibling in self._manifest else None

    def is_installed(self, name: str) -> bool:
        spec = self._manifest.get(name)
        directory = self.models_dir / name
        if spec is None or not is_installed(spec, directory):
            return False
        # Sizes are checked on every call. The sha256 of every file is checked once per process,
        # when the model is first used, so an edit that keeps a file's size does not load. A
        # model that fails it counts as missing and is downloaded again.
        with self._hash_lock:
            if name in self._hashes_checked:
                return self._hashes_checked[name]
            verified = dir_hashes_match(spec, directory)
            self._hashes_checked[name] = verified
        if verified:
            return True
        logger.warning(
            "Privacy model %s in %s does not match its pinned sha256; downloading it again",
            name, directory,
        )
        return False

    def directory_verified(self, name: str, directory: Path) -> bool:
        """A directory outside the per-user download holds the pinned files: their sizes on
        every call, their sha256 once per process. The loader takes such a directory only
        when this is true, so a same-size edit in the working directory does not load."""
        spec = self._manifest.get(name)
        if spec is None or not dir_matches(spec, directory):
            return False
        key = str(directory)
        with self._hash_lock:
            if key in self._dirs_hashed:
                return self._dirs_hashed[key]
            verified = dir_hashes_match(spec, directory)
            self._dirs_hashed[key] = verified
        if verified:
            return True
        logger.warning(
            "Privacy model %s in %s has the pinned sizes but not the pinned sha256; not used",
            name, directory,
        )
        return False

    def _satisfied(self, name: str, other_dirs: Iterable[Path]) -> bool:
        """Present per-user, or verified in one of ``other_dirs``."""
        if self.is_installed(name):
            return True
        spec = self._manifest[name]
        for directory in other_dirs:
            mismatches = size_mismatches(spec, Path(directory))
            if mismatches == []:
                if self.directory_verified(name, Path(directory)):
                    return True
                continue
            if mismatches:
                _warn_size_mismatch(name, Path(directory), mismatches)
        return False

    def all_present(self, needed: Mapping[str, Iterable[Path]]) -> bool:
        """Whether every configured model is present and verified, without starting delivery."""
        return bool(needed) and all(
            self._satisfied(name, other_dirs) for name, other_dirs in needed.items()
        )

    # ------------------------------------------------------------------
    # Status
    # ------------------------------------------------------------------

    def snapshot(self) -> dict[str, object]:
        with self._lock:
            return {
                "state": self._state,
                "done_bytes": self._done_bytes,
                "total_bytes": self._total_bytes,
                "error": self._error,
            }

    @property
    def state(self) -> ModelsState:
        with self._lock:
            return self._state

    def gate_open(self) -> bool:
        """Whether requests that need the PII model may run."""
        with self._lock:
            if self._state == DISABLED:
                return True
            if self._state == PENDING and self._last_attempt is None:
                return False
            # A retry passes through PENDING too; an active PII model stays usable.
            return self._gate_model is None or self._gate_model in self._active

    def pii_model_present(self) -> bool:
        """The PII model is active, or its files are installed and activating."""
        with self._lock:
            gate = self._gate_model
            if gate is None or gate in self._active:
                return True
        return self.is_installed(gate)

    @property
    def restart_reason(self) -> str | None:
        """Set when an in-process activation failed; a fresh process loads the
        installed files at start-up instead."""
        with self._lock:
            return self._restart_reason

    def _set_state(self, state: ModelsState, *, error: str | None = None) -> None:
        with self._lock:
            self._state = state
            self._error = error

    def _set_done(self, done_bytes: int) -> None:
        with self._lock:
            self._done_bytes = done_bytes

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def disable(self) -> None:
        with self._lock:
            if self._state == PENDING:
                self._state = DISABLED

    def start(
        self,
        needed: Mapping[str, Iterable[Path]],
        on_installed: Callable[[], None],
        *,
        gate_model: str | None = None,
    ) -> None:
        """Decide once whether anything must be downloaded, and start it.

        ``needed`` maps each manifest model the config uses, in download
        order, to the other directories that may already hold it.
        ``gate_model`` is the PII model requests wait for. ``on_installed``
        runs on the download thread after each model lands. Idempotent.
        """
        with self._lock:
            if self._state != PENDING:
                return
        self._begin(needed, on_installed, gate_model)

    def start_if_missing(
        self,
        needed: Mapping[str, Iterable[Path]],
        on_installed: Callable[[], None],
        *,
        gate_model: str | None = None,
    ) -> None:
        """Start delivery when files are absent, including a stale ready state."""
        with self._lock:
            state = self._state
        if state == READY:
            if self.all_present(needed):
                return
            with self._lock:
                if self._state != READY:
                    return
                self._state = PENDING
                self._active.clear()
        self.start(needed, on_installed, gate_model=gate_model)

    def retry_if_due(
        self,
        needed: Mapping[str, Iterable[Path]],
        on_installed: Callable[[], None],
        *,
        gate_model: str | None = None,
        force: bool = False,
    ) -> bool:
        """Retry a failed download, respecting automatic backoff unless explicitly requested.

        A failed activation is not retried: its files are installed and a restart loads them.
        Non-blocking.
        """
        with self._lock:
            due = (
                self._state == FAILED
                and self._restart_reason is None
                and self._last_attempt is not None
                and (
                    force
                    or self._clock() - self._last_attempt
                    >= RETRY_BACKOFF_S[
                        min(max(self._failed_attempts, 1), len(RETRY_BACKOFF_S)) - 1
                    ]
                )
            )
            if not due:
                return False
            self._state = PENDING
        logger.info("Retrying the privacy model download")
        self._begin(needed, on_installed, gate_model)
        return True

    def _begin(
        self,
        needed: Mapping[str, Iterable[Path]],
        on_installed: Callable[[], None],
        gate_model: str | None,
    ) -> None:
        if self._unhashed(needed):
            # Hashing ~600 MiB takes seconds. The callers are request handlers and the protection
            # mode watcher, so it runs on a worker; requests answer 503 "verifying" meanwhile.
            with self._lock:
                if self._state != PENDING:
                    return
                self._state = VERIFYING
                self._gate_model = gate_model
                self._last_attempt = self._clock()
            threading.Thread(
                target=self._verify_then_begin,
                args=(needed, on_installed, gate_model),
                name="privacy-model-verify",
                daemon=True,
            ).start()
            return
        self._settle(needed, on_installed, gate_model)

    def _unhashed(self, needed: Mapping[str, Iterable[Path]]) -> bool:
        """Whether a model is on disk at its pinned sizes, per-user or elsewhere, but not yet
        hash-checked."""
        for name, others in needed.items():
            spec = self._manifest.get(name)
            if spec is None:
                continue
            with self._hash_lock:
                checked = name in self._hashes_checked
                dirs_hashed = set(self._dirs_hashed)
            if not checked and is_installed(spec, self.models_dir / name):
                return True
            if any(str(d) not in dirs_hashed and dir_matches(spec, Path(d)) for d in others):
                return True
        return False

    def _verify_then_begin(
        self,
        needed: Mapping[str, Iterable[Path]],
        on_installed: Callable[[], None],
        gate_model: str | None,
    ) -> None:
        try:
            for name, others in needed.items():
                self.is_installed(name)  # hashes it once; a mismatch makes _settle download it
                for directory in others:
                    self.directory_verified(name, Path(directory))
            self._settle(needed, on_installed, gate_model)
        except Exception as exc:  # noqa: BLE001 - a dead worker must not leave the state VERIFYING
            with self._lock:
                self._state = FAILED
                self._error = f"model verification failed: {type(exc).__name__}: {exc}"
                self._failed_attempts += 1
            logger.exception("Privacy model verification failed")

    def _settle(
        self,
        needed: Mapping[str, Iterable[Path]],
        on_installed: Callable[[], None],
        gate_model: str | None,
    ) -> None:
        present = {name for name, others in needed.items() if self._satisfied(name, others)}
        missing = [name for name in needed if name not in present]
        base_url: str | None = None
        error: str | None = None
        if missing:
            try:
                base_url = resolve_base_url()
            except DownloadError as exc:
                error = str(exc)
        total = sum(self._manifest[name].total_bytes for name in missing)
        with self._lock:
            if self._state not in (PENDING, VERIFYING):
                return
            self._gate_model = gate_model
            self._active |= present
            self._last_attempt = self._clock()
            if not missing:
                self._state = READY
                return
            if error is not None:
                self._state = FAILED
                self._error = error
                self._failed_attempts += 1
                logger.error("Privacy models not downloaded: %s", error)
                return
            self._state = DOWNLOADING
            self._done_bytes = 0
            self._total_bytes = total
            self._error = None
        logger.info(
            "Privacy models missing (%s); downloading %.1f MiB from %s into %s",
            ", ".join(missing), total / 1_048_576, base_url, self.models_dir,
        )
        threading.Thread(
            target=self._run,
            args=(missing, base_url, on_installed),
            name="privacy-model-download",
            daemon=True,
        ).start()

    def _run(self, missing: list[str], base_url: str, on_installed: Callable[[], None]) -> None:
        ctx = ssl.create_default_context()
        failures: list[str] = []
        base = 0
        for name in missing:
            spec = self._manifest[name]
            try:
                self.models_dir.mkdir(parents=True, exist_ok=True)
                download_model(
                    spec,
                    base_url,
                    self.models_dir,
                    on_progress=lambda n, base=base: self._set_done(base + n),
                    on_phase=lambda phase: self._set_state(phase),
                    ctx=ctx,
                )
            except Exception as exc:  # noqa: BLE001 - reported; the next model still downloads
                reason = str(exc) if isinstance(exc, DownloadError) else f"{type(exc).__name__}: {exc}"
                failures.append(f"{name}: {reason}")
                logger.error("Privacy model %s download failed: %s", name, reason)
                _log_tls_hint(reason)
                continue
            base += spec.total_bytes
            self._set_done(base)
            with self._hash_lock:
                self._hashes_checked[name] = True  # extraction just checked every file's sha256
            self._set_state(ACTIVATING)
            try:
                on_installed()
            except Exception as exc:  # noqa: BLE001
                reason = f"model activation failed: {type(exc).__name__}: {exc}"
                with self._lock:
                    self._state = FAILED
                    self._error = reason
                    self._restart_reason = reason
                logger.error("%s; asking ServiceHub for a restart", reason)
                return
            with self._lock:
                self._active.add(name)
        with self._lock:
            self._last_attempt = self._clock()
            if failures:
                self._state = FAILED
                self._error = "; ".join(failures)
                self._failed_attempts += 1
            else:
                self._state = READY
                self._error = None
                self._failed_attempts = 0
        if not failures:
            logger.info("Privacy models ready")


def _warn_size_mismatch(name: str, directory: Path, mismatches: list[tuple[str, int, int]]) -> None:
    for rel, pinned, actual in mismatches:
        if actual <= _LFS_POINTER_MAX_BYTES < pinned:
            hint = "it is a git-LFS pointer; run 'git lfs pull'"
        else:
            hint = _RECHECKOUT_HINT
        logger.warning(
            "Privacy model %s at %s not used: %s is %d bytes, pinned %d; %s",
            name, directory, rel, actual, pinned, hint,
        )


def _log_tls_hint(reason: str) -> None:
    lowered = reason.lower()
    if "certificate_verify_failed" in lowered or "sslcertverificationerror" in lowered:
        logger.error(
            "TLS certificate verification failed. Behind a corporate proxy, add "
            "its root CA to the system trust store or set SSL_CERT_FILE; do not "
            "disable verification."
        )
