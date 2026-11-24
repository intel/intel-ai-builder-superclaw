"""HuggingFace GGUF downloader with operation-progress bridging.

Design notes
------------

* We use :func:`huggingface_hub.hf_hub_download` directly so we get
  resumable downloads and the HF mirror (``HF_ENDPOINT``) for free.
* Xet-accelerated downloads (``hf_xet``, auto-enabled whenever the package is
  installed) are explicitly disabled here in favor of the plain HTTP path.
  Xet streams through a Rust-native thread; a stalled Xet transfer blocks
  outside of any Python-level timeout or ``KeyboardInterrupt`` we could
  inject, so it cannot be unblocked or bounded from this module. The plain
  HTTP path (``huggingface_hub.file_download.http_get``) is fully Python/httpx
  and already passes an explicit per-request read timeout
  (``HF_HUB_DOWNLOAD_TIMEOUT``, 10s) to every call, with its own resume-on-
  timeout retry loop - so a silently-dead connection unwinds within seconds
  instead of blocking ``recv()`` forever.
* Progress is bridged into the operation pool through a *file-watching*
  background poller: ``hf_hub_download`` writes to ``<filename>.incomplete``
  while it streams; we sample its size on a 500ms tick and call
  :meth:`OperationHandle.progress`. This is more robust than swapping in a
  custom ``tqdm`` (the ``tqdm_class`` API is private and brittle).
* Concurrency is enforced by a process-wide :class:`asyncio.Semaphore`
  (capacity = ``concurrency``, defaults to 1).
* Cancellation is cooperative: when the operation is cancelled, we raise
  :class:`OperationCancelled` from the poller; the underlying HF download
  thread is allowed to finish naturally (writing to ``.incomplete``) so
  resume on the next attempt is intact.
* sha256 is accumulated while the partial file grows on platforms where an
  open reader does not block final rename. Windows hashes the final file after
  download because opening ``.incomplete`` races Hugging Face finalization.

Model presence is derived from the filesystem; successful integrity evidence
is persisted so unchanged files do not require another full hash. Progress
lives in the ephemeral :class:`OperationPool`, and the file layout is
``<models_dir>/<model_id>/<filename>``.

An asset that declares a speculative-decoding draft source (``draft_repo`` or
``draft_url``) installs a second file,
``<models_dir>/<model_id>/<draft_filename>``, fetched by the same ``download()``
call and verified with its own digest. The two files form one unit: readiness
requires both, and both report into a single progress row.
"""

from __future__ import annotations

import asyncio
import hashlib
import httpx
import os
import threading
import time
from pathlib import Path
from typing import Any
from urllib.parse import quote

from huggingface_hub import constants as hf_constants
from huggingface_hub import hf_hub_download
from huggingface_hub.errors import FileMetadataError, HfHubHTTPError, LocalEntryNotFoundError
from loguru import logger

from ..common.http_client import build_client_for_url, proxy_routes
from ..common.store import Store
from .config import LocalConfig
from .hf_endpoint import resolve_hf_endpoint
from .models import stat_identity
from .operations_bridge import OperationCancelled, OperationHandle
from .registry import ModelEntry

# Model state machine (filesystem-derived).
STATE_MISSING = "missing"
STATE_DOWNLOADING = "downloading"
STATE_READY = "ready"
STATE_ERROR = "error"

_STALL_TIMEOUT = 60.0  # seconds without any file-size growth before treating as a stall
# Read timeout for the mirror-fallback direct-stream path (_direct_stream_download).
# Unlike hf_hub_download's http_get, that path has no library-level retry/timeout
# of its own, so an unbounded read would let a dead connection block its worker
# thread forever - including the next retry's join() on it. Comfortably under
# _STALL_TIMEOUT so the file-poller's stall detection still fires first in the
# common case; this is the backstop for when it doesn't (e.g. poller delayed).
_DIRECT_STREAM_READ_TIMEOUT = 45.0
# Per-route connect timeout on that same path. An unusable route fails at connect,
# so this bounds the two-route failover (see proxy_routes) at 2x - short enough
# that the fallback route starts streaming before _STALL_TIMEOUT fires, since an
# unreachable route produces the zero bytes the poller reads as a stall.
_DIRECT_STREAM_CONNECT_TIMEOUT = 12.0


def _disable_xet() -> None:
    """Force ``hf_hub_download`` onto the plain-HTTP path (see module docstring).

    ``huggingface_hub.constants.HF_HUB_DISABLE_XET`` is read fresh on every
    download call (not cached at import time), so setting the module
    attribute directly - as opposed to ``os.environ`` before import - takes
    effect immediately. Idempotent; cheap enough to call before every attempt.
    """
    hf_constants.HF_HUB_DISABLE_XET = True


class DownloadError(RuntimeError):
    pass


class HfDownloader:
    """Per-process serial-or-bounded downloader.

    Construct *once* and share across all download requests so the
    :class:`asyncio.Semaphore` actually serializes anything.
    """

    def __init__(
        self, cfg: LocalConfig, *, concurrency: int = 1, store: Store | None = None
    ) -> None:
        self._cfg = cfg
        self._store = store
        self._sem = asyncio.Semaphore(max(1, concurrency))
        # Effective HF endpoint, resolved lazily on first download and cached
        # for the process: auto-selection does network probes, and the reachable
        # endpoint does not change mid-run. See _effective_hf_endpoint.
        self._resolved_hf_endpoint: str | None = None
        # The most recently spawned hf-download-worker thread. Tracked so that
        # a retry can join() it before starting a new download — on Windows the
        # stalled thread holds an exclusive write-lock on the .incomplete file,
        # which would block the next hf_hub_download call from making progress.
        self._active_download_thread: threading.Thread | None = None

    # --------------------------------------------------------------- helpers

    def _effective_hf_endpoint(self) -> str:
        """Resolve (once) the HF endpoint to use, auto-detecting when unpinned.

        Honors an explicit ``HF_ENDPOINT`` (captured in ``cfg.hf_endpoint``);
        otherwise probes the official endpoint and the mirror and picks the
        reachable one (see :func:`.hf_endpoint.resolve_hf_endpoint`). Blocking
        (spawns probe threads), so call it via ``asyncio.to_thread``.
        """
        if self._resolved_hf_endpoint is None:
            self._resolved_hf_endpoint = resolve_hf_endpoint(self._cfg.hf_endpoint)
        return self._resolved_hf_endpoint

    def model_dir(self, model_id: str) -> Path:
        return self._cfg.models_dir / model_id

    def model_path(self, entry: ModelEntry) -> Path:
        return self.model_dir(entry.id) / entry.filename

    def draft_path(self, entry: ModelEntry) -> Path:
        """Path of *entry*'s speculative-decoding draft, beside its own GGUF.

        This is where the supervisor looks the draft up
        (``supervisor._apply_draft_model``), so the draft is stored under the
        *parent* model's id even though it carries its own asset identity.
        """
        return self.model_dir(entry.id) / entry.draft_filename

    @property
    def models_dir(self) -> Path:
        return self._cfg.models_dir

    def asset_files(self, entry: ModelEntry) -> list[tuple[ModelEntry, Path]]:
        """Every file this asset installs, as ``(asset, path)`` pairs.

        One pair for the model's own GGUF, plus one for its speculative-decoding
        draft when the registry declares a downloadable one. The draft's asset
        identity is its own (digest, size, verification key); its *path* is
        resolved beside the parent model.
        """
        files = [(entry, self.model_path(entry))]
        draft = entry.draft_asset()
        if draft is not None:
            files.append((draft, self.draft_path(entry)))
        return files

    def is_ready(self, entry: ModelEntry) -> bool:
        """Every file this asset installs exists at exactly its declared size.

        For an entry with a downloadable draft that means both the main GGUF
        and the draft: a model whose draft is missing would otherwise start
        with speculative decoding silently dropped, and no later ensure-ready
        would ever fetch the missing file.

        Intentionally does NOT compute sha256 - this method is called from
        async request handlers (ensure-ready fast path, status checks) and
        hashing a multi-GB GGUF file would block the event loop for 30+ s. Use
        :meth:`verify_installed` where the digest matters (the boot path and
        the download phase both do).
        """
        return all(
            _file_complete(path, asset.size_bytes)
            for asset, path in self.asset_files(entry)
        )

    async def verify_installed(self, entry: ModelEntry) -> bool:
        """Full integrity check of every file this asset installs.

        Existence, exact declared size, and sha256 - the digest coming from the
        persisted verification record when its stat still matches, so the
        expensive hash runs only for a file this install has never verified
        (e.g. one placed by hand). A file that fails its digest is deleted, so
        the caller's ``download`` re-fetches it rather than launching a model
        server on corrupt weights.

        Hashing runs off the event loop, but a multi-GB first check still takes
        tens of seconds - call it from a background task or an operation, never
        inline in a request handler.
        """
        for asset, path in self.asset_files(entry):
            if not _file_complete(path, asset.size_bytes):
                logger.info(
                    "asset verify incomplete id={} path={} size={} declared={}",
                    asset.id,
                    path,
                    _safe_size(path),
                    asset.size_bytes,
                )
                return False
            if not await self._verify_existing(asset, path):
                logger.warning(
                    "asset verify failed id={} path={} reason=digest_mismatch",
                    asset.id,
                    path,
                )
                return False
        return True

    def detect_state(self, entry: ModelEntry) -> str:
        if self.is_ready(entry):
            return STATE_READY
        return STATE_MISSING

    def _record_matches_file(self, entry: ModelEntry, target: Path) -> bool:
        if not self._store or not entry.sha256 or not target.is_file():
            return False
        stat = target.stat()
        record = self._store.get_model_verification(entry.id)
        if record is None:
            return False
        expected_sha256 = entry.sha256.lower()
        if not (
            record.get("expected_sha256") == expected_sha256
            and record.get("filename") == entry.filename
            and record.get("size_bytes") == stat.st_size
            and record.get("mtime_ns") == stat.st_mtime_ns
        ):
            return False
        if record.get("ctime_ns") != stat.st_ctime_ns:
            # On Windows, ctime is the file creation timestamp and can change
            # after an atomic rename (hf_hub_download temp→final) or a process
            # restart. sha256 + size + mtime already guarantee content identity;
            # refresh the stored ctime so future checks hit the fast path.
            self._store.set_model_verification(
                asset_id=entry.id,
                expected_sha256=expected_sha256,
                filename=entry.filename,
                size_bytes=stat.st_size,
                mtime_ns=stat.st_mtime_ns,
                ctime_ns=stat.st_ctime_ns,
            )
        return True

    async def _verify_existing(self, entry: ModelEntry, target: Path) -> bool:
        if not entry.sha256:
            return True
        if self._record_matches_file(entry, target):
            return True
        before = target.stat()
        actual = await asyncio.to_thread(_sha256_file, target)
        after = target.stat()
        # Identity, not the whole stat tuple: hashing the file just updated its
        # atime, and a "changed mid-verification" false negative here costs a
        # multi-GB re-download of a perfectly good asset.
        if stat_identity(before) != stat_identity(after):
            return False
        if actual != entry.sha256.lower():
            logger.warning(
                "model verify sha256_mismatch id={} expected={} actual={} action=delete_and_redownload",
                entry.id,
                entry.sha256.lower(),
                actual,
            )
            target.unlink(missing_ok=True)
            if self._store:
                self._store.delete_model_verification(entry.id)
            return False
        if self._store:
            stat = target.stat()
            self._store.set_model_verification(
                asset_id=entry.id,
                expected_sha256=entry.sha256.lower(),
                filename=entry.filename,
                size_bytes=stat.st_size,
                mtime_ns=stat.st_mtime_ns,
                ctime_ns=stat.st_ctime_ns,
            )
        return True

    # ----------------------------------------------------------- entry point

    async def download(
        self,
        entry: ModelEntry,
        handle: OperationHandle,
        *,
        mark_done: bool = True,
        pct_range: tuple[float, float] = (0.0, 100.0),
    ) -> Path:
        """Download ``entry`` into ``models/<id>/`` honoring concurrency + cancellation.

        An entry that declares a downloadable speculative-decoding draft source
        (``draft_repo`` or ``draft_url``) installs *two* files, and both are
        fetched here: the draft is useless without its model and the model is
        slow without its draft, so they are one unit of work. The draft lands
        beside the main GGUF, which is where the supervisor resolves it from.

        *pct_range* maps the raw 0-100 download progress onto a sub-range of
        the caller's progress scale. For example, ``pct_range=(0.0, 50.0)``
        means this download occupies the first half of the caller's progress
        bar. Defaults to the full 0-100 range so all existing callers are
        unaffected. When a draft is in play the sub-range is split between the
        two files in proportion to their declared sizes.

        Returns the path of the *main* GGUF.
        """
        target = self.model_path(entry)
        draft = entry.draft_asset()
        row_total = entry.total_size_bytes

        pct_lo, pct_hi = pct_range
        pct_split = pct_hi
        if draft is not None and row_total:
            pct_split = pct_lo + (pct_hi - pct_lo) * entry.size_bytes / row_total

        downloaded = await self._ensure_file(
            entry,
            target,
            handle,
            pct_range=(pct_lo, pct_split),
            announce=mark_done,
            file_id=entry.id,
            file_total=row_total,
        )
        if draft is not None:
            downloaded |= await self._ensure_file(
                draft,
                self.draft_path(entry),
                handle,
                pct_range=(pct_split, pct_hi),
                announce=mark_done,
                file_id=entry.id,
                file_done_base=entry.size_bytes,
                file_total=row_total,
            )

        # Close the manifest row for this asset. `file_progress` is otherwise only
        # emitted from `_do_download`, so an asset that verified without moving any
        # bytes would leave its row at whatever `set_files` seeded — `done=0 /
        # pending` once the prepare handler stops hashing inline (it hands over an
        # unverified `cache_states`). The UI closes its download dialog on
        # `assets.every(a => a.complete)`, so a row that never completes hangs the
        # dialog at 0.0 MB forever.
        #
        # Emitted here, after BOTH files are settled, rather than inside
        # `_ensure_file`: a model and its draft report against one shared row, so a
        # per-file emit would mark the row complete with only the model half done.
        # A draft that then failed verification would re-download with the dialog
        # already closed (closing is one-way — it also stops the progress poll).
        await handle.file_progress(
            entry.id, done=row_total, total=row_total, state="complete"
        )

        if mark_done:
            await handle.done(message="ready" if downloaded else "already present")
        return target

    async def _ensure_file(
        self,
        asset: ModelEntry,
        target: Path,
        handle: OperationHandle,
        *,
        pct_range: tuple[float, float],
        announce: bool,
        file_id: str,
        file_done_base: int = 0,
        file_total: int = 0,
    ) -> bool:
        """Download one asset file to *target*; return whether bytes moved.

        ``False`` means the file was already present and verified. *file_id*,
        *file_done_base* and *file_total* place this file inside the caller's
        per-file manifest row: an asset with a draft reports both files against
        one row, the draft's bytes continuing where the main GGUF's end.
        """
        target.parent.mkdir(parents=True, exist_ok=True)

        # Quick path: already ready
        if _file_complete(target, asset.size_bytes) and await self._verify_existing(
            asset, target
        ):
            return False

        async with self._sem:
            # Another request may have completed this asset while we waited.
            if _file_complete(
                target, asset.size_bytes
            ) and await self._verify_existing(asset, target):
                return False
            if announce:
                location = (
                    asset.url
                    if asset.source == "url"
                    else f"{asset.repo}/{asset.filename}"
                )
                await handle.message(f"downloading {location}")
            try:
                actual = await self._do_download(
                    asset,
                    handle,
                    target,
                    pct_lo=pct_range[0],
                    pct_hi=pct_range[1],
                    file_id=file_id,
                    file_done_base=file_done_base,
                    file_total=file_total,
                )
            except OperationCancelled:
                raise
            except Exception as exc:
                raise DownloadError(str(exc)) from exc
            if asset.sha256:
                expected = asset.sha256.lower()
                if actual != expected:
                    # Temp-file selection can change across an atomic rename.
                    # Confirm a streaming mismatch against the final file.
                    actual = await asyncio.to_thread(_sha256_file, target)
                    if actual != expected:
                        logger.error(
                            "model download sha256_mismatch id={} expected={} actual={} action=delete_and_retry",
                            asset.id,
                            expected,
                            actual,
                        )
                        target.unlink(missing_ok=True)
                        if self._store:
                            self._store.delete_model_verification(asset.id)
                        raise DownloadError(
                            f"sha256 mismatch: expected {asset.sha256}, got {actual}"
                        )
                before = target.stat()
                after = target.stat()
                if stat_identity(before) != stat_identity(after):
                    raise DownloadError("model file changed during final verification")
                if self._store:
                    self._store.set_model_verification(
                        asset_id=asset.id,
                        expected_sha256=expected,
                        filename=asset.filename,
                        size_bytes=after.st_size,
                        mtime_ns=after.st_mtime_ns,
                        ctime_ns=after.st_ctime_ns,
                    )
        return True

    # ---------------------------------------------------------- HF call wrap

    async def _do_download(
        self,
        entry: ModelEntry,
        handle: OperationHandle,
        target: Path,
        pct_lo: float = 0.0,
        pct_hi: float = 100.0,
        *,
        file_id: str | None = None,
        file_done_base: int = 0,
        file_total: int = 0,
    ) -> str:
        """Run the selected download path on a worker thread + poll progress.

        We deliberately don't pass ``cache_dir``: the file lands directly
        in ``target``'s directory thanks to ``local_dir``.

        Byte counters are reported against the manifest row *file_id* (default:
        this asset's own id), offset by *file_done_base* and denominated by
        *file_total* so several files can share one row.
        """
        row_id = file_id or entry.id
        is_url_source = entry.source == "url"
        if is_url_source:
            # Direct assets must not depend on HF connectivity or mutate the
            # process-wide HF endpoint used by repository-sourced downloads.
            endpoint = entry.url
        else:
            # Resolve the HF endpoint: honor an explicit operator setting
            # (``cfg.hf_endpoint``), else auto-detect the reachable endpoint
            # (official vs hf-mirror) so downloads work on hosts where
            # huggingface.co is blocked. Probing is off-loop and cached after
            # the first call.
            #
            # NOTE: huggingface_hub binds ``constants.ENDPOINT`` at *import*
            # time, so mutating ``HF_ENDPOINT`` in the environment here does
            # NOT change hf_hub_download's target - we must pass ``endpoint=``
            # explicitly (below). We still export it to the environment for
            # any child processes that resolve it themselves.
            endpoint = await asyncio.to_thread(self._effective_hf_endpoint)
            os.environ["HF_ENDPOINT"] = endpoint
            _disable_xet()

        # If a previous download thread is still alive (stalled and abandoned by
        # the poller), wait for it to exit before starting the new one. It's not
        # a hard correctness requirement - huggingface_hub already serializes
        # concurrent attempts on the same destination via its own advisory file
        # lock - but starting a second thread while the first is still retrying
        # would just queue behind that lock and confuse progress reporting.
        # ``http_get``'s explicit per-request read timeout (HF_HUB_DOWNLOAD_TIMEOUT,
        # 10s, see module docstring) bounds the wait: a permanently dead
        # connection now raises inside hf_hub_download's own retry loop instead
        # of blocking recv() forever, so this join is guaranteed to return.
        prev_thread = self._active_download_thread
        if prev_thread is not None and prev_thread.is_alive():
            logger.info(
                "model download waiting for previous thread to exit id={} thread={}",
                entry.id,
                prev_thread.name,
            )
            await asyncio.to_thread(prev_thread.join)

        if is_url_source:
            logger.info("model download start id={} url={}", entry.id, entry.url)
        else:
            logger.info(
                "model download start id={} repo={} revision={} filename={} endpoint={}",
                entry.id,
                entry.repo,
                entry.revision or "main",
                entry.filename,
                endpoint,
            )

        loop = asyncio.get_running_loop()
        download_done = asyncio.Event()
        download_err: list[BaseException] = []
        download_digest: list[str] = []
        legacy_partial = target.with_suffix(target.suffix + ".incomplete")
        modern_dir = target.parent / ".cache" / "huggingface" / "download"
        resume_partial = _adopt_largest_incomplete(
            legacy_partial, modern_dir, target.name, entry.sha256
        )
        if resume_partial:
            logger.info(
                "model download resuming from partial id={} bytes={} path={} route=direct_stream",
                entry.id,
                _safe_size(legacy_partial),
                legacy_partial,
            )
        else:
            logger.info(
                "model download no reusable partial id={} route={}",
                entry.id,
                "direct_url" if is_url_source else "hf_hub_download",
            )

        def _blocking() -> None:
            try:
                if resume_partial or is_url_source:
                    download_digest.append(
                        _direct_stream_download(entry, target, endpoint=endpoint)
                    )
                    return
                try:
                    download_kwargs = {
                        "repo_id": entry.repo,
                        "filename": entry.filename,
                        "local_dir": str(target.parent),
                        "endpoint": endpoint,
                        "resume_download": True,
                        "force_download": False,
                    }
                    if entry.revision is not None:
                        download_kwargs["revision"] = entry.revision
                    hf_hub_download(**download_kwargs)
                except Exception as e:
                    if _should_fallback_to_direct_download(e, endpoint=endpoint):
                        logger.warning(
                            "hf_hub_download metadata path rejected endpoint {}; falling back to direct stream for {}/{}",
                            endpoint,
                            entry.repo,
                            entry.filename,
                        )
                        download_digest.append(
                            _direct_stream_download(entry, target, endpoint=endpoint)
                        )
                    else:
                        raise
            except Exception as e:
                download_err.append(e)
            finally:
                loop.call_soon_threadsafe(download_done.set)

        self._active_download_thread = await asyncio.to_thread(_run_in_background, _blocking)

        # Progress polling.
        #
        # huggingface_hub writes the in-progress file in one of two places
        # depending on its version + whether ``local_dir`` is used:
        #   (a) Legacy: <target>.incomplete  (right next to the final file)
        #   (b) Modern (>=0.20 with local_dir): <local_dir>/.cache/huggingface/download/<filename>.<etag>.incomplete
        # These schemes are effectively mutually exclusive, so we take the max
        # across all candidate locations to move the bar regardless of which is
        # in play (each absent candidate contributes 0).
        hasher = hashlib.sha256()
        hashed_bytes = 0
        hashed_identity: tuple[int, int] | None = None
        hash_provenance_changed = False
        last_emit = 0.0
        cancelled = False
        last_progress_bytes = -1
        last_progress_time = time.monotonic()
        stall_error: Exception | None = None
        while not download_done.is_set():
            if not cancelled:
                try:
                    await handle.raise_if_cancelled()
                except OperationCancelled:
                    cancelled = True
            await asyncio.sleep(0.5)
            now = time.monotonic()
            if now - last_emit < 0.5:
                continue
            last_emit = now
            done = max(
                _safe_size(target),
                _safe_size(legacy_partial),
                _largest_incomplete(modern_dir, target.name, entry.sha256),
            )
            # Track stall: if downloaded bytes haven't grown for _STALL_TIMEOUT seconds,
            # abort — the underlying TCP connection is silently dead.
            if done != last_progress_bytes:
                last_progress_bytes = done
                last_progress_time = now
            elif now - last_progress_time >= _STALL_TIMEOUT and not cancelled:
                stall_error = DownloadError(
                    f"Network issue: download paused at "
                    f"{done / 1_000_000:.1f} MB of "
                    f"{(entry.size_bytes or 0) / 1_000_000:.1f} MB "
                    f"({int(now - last_progress_time)}s without progress). "
                    f"Your progress is saved — retry to continue."
                )
                logger.error(
                    "model download stall id={} bytes={} stall_seconds={}",
                    entry.id,
                    done,
                    int(now - last_progress_time),
                )
                # Don't try to kill the background thread here: it is left to
                # unwind on its own once http_get's per-request read timeout
                # (HF_HUB_DOWNLOAD_TIMEOUT, 10s) fires inside hf_hub_download's
                # retry loop. The next download attempt's thread-join (see
                # _do_download) waits for that to happen before starting a new
                # attempt.
                break
            # Windows denies Hugging Face's final rename while this process has
            # the .incomplete file open for incremental hashing. Progress only
            # needs stat sizes; hash the final file after the worker closes it.
            if os.name != "nt" and not download_digest:
                candidate = _active_download_path(
                    target, legacy_partial, modern_dir, entry.sha256
                )
                hashed_identity, hashed_bytes, changed = _hash_appended_bytes(
                    candidate, hasher, hashed_identity, hashed_bytes
                )
                hash_provenance_changed = hash_provenance_changed or changed
            total = entry.size_bytes or max(done, 1)
            raw_pct = min(99.0, 100.0 * done / total) if total else 0.0
            scaled_pct = pct_lo + (pct_hi - pct_lo) * raw_pct / 100.0
            if not cancelled:
                await handle.progress(scaled_pct)
                await handle.file_progress(
                    row_id,
                    done=file_done_base + done,
                    total=file_total or total,
                    state="downloading",
                )
        if stall_error is not None:
            raise stall_error

        if download_err:
            err = download_err[0]
            if isinstance(err, HfHubHTTPError):
                raise DownloadError(f"HF HTTP error: {err}") from err
            raise err if isinstance(err, Exception) else DownloadError(str(err))
        if cancelled:
            raise OperationCancelled

        # On Windows, hf_hub_download finalises the file via an atomic rename
        # from a temp/incomplete path. The rename is visible to the thread that
        # performed it immediately, but other threads / asyncio contexts can see
        # a brief window where Path.exists() returns False. Poll until the file
        # is present (any non-zero size - we trust hf_hub_download's success
        # signal for completeness; the registry's declared size_bytes can drift
        # from reality and must not be used as a completeness gate here).
        _deadline = time.monotonic() + 10.0
        while time.monotonic() < _deadline:
            if target.exists() and target.stat().st_size > 0:
                break
            await asyncio.sleep(0.1)
        else:
            logger.error(
                "model download file_not_visible id={} path={} reason=file_absent_after_10s",
                entry.id,
                target,
            )
            raise DownloadError(
                f"download completed but file not visible after 10 s: {target}"
            )

        if download_digest:
            actual_sha256 = download_digest[0]
        else:
            # On Windows the incremental hasher never runs during the polling
            # loop above (os.name != "nt" guard), so hashed_bytes is still 0
            # here and this "catch up" call ends up hashing the file's full
            # multi-GB size in one shot. Both calls do real disk I/O + CPU-bound
            # hashing; run them off the event loop so a large model's post-
            # download verification does not freeze request handling (health
            # checks, capability reads) for the entire hash duration.
            _, hashed_bytes, changed = await asyncio.to_thread(
                _hash_appended_bytes, target, hasher, hashed_identity, hashed_bytes
            )
            hash_provenance_changed = hash_provenance_changed or changed
            if hash_provenance_changed or hashed_bytes != target.stat().st_size:
                actual_sha256 = await asyncio.to_thread(_sha256_file, target)
            else:
                actual_sha256 = hasher.hexdigest()

        logger.info(
            "model download complete: id={} path={} size={}",
            entry.id,
            target,
            _safe_size(target),
        )

        # The row is only "complete" once every file sharing it has landed, so
        # a model whose draft is still downloading keeps its row in flight.
        final_size = _safe_size(target)
        row_done = file_done_base + (final_size or entry.size_bytes)
        row_total = file_total or row_done or 1
        await handle.progress(pct_hi)
        await handle.file_progress(
            row_id,
            done=min(row_done, row_total),
            total=row_total,
            state="complete" if row_done >= row_total else "downloading",
        )
        return actual_sha256


# --------------------------------------------------------------------- utils


def _file_complete(p: Path, size_bytes: int) -> bool:
    """File exists at exactly *size_bytes* (0 = size undeclared, existence only).

    Exact, not "at least": a short file is a truncated download and a long one
    is not the asset the registry pinned. Both must re-download, and a ``>=``
    test would silently accept the second and start a model server on it.
    """
    try:
        if not p.is_file():
            return False
        return not size_bytes or p.stat().st_size == size_bytes
    except OSError:
        return False


def _safe_size(p: Path) -> int:
    try:
        return p.stat().st_size if p.exists() else 0
    except OSError:
        return 0


def _partials_for(
    d: Path, filename: str | None = None, sha256: str | None = None
) -> list[Path]:
    """In-progress huggingface_hub blobs under *d* belonging to one file.

    Scoping matters because a model and its speculative-decoding draft share a
    directory: an unrelated multi-GB leftover must never be mistaken for the
    draft's own partial - it would be resumed from (a range request far past
    the end of a 400 MB file) and counted as its progress.

    Two naming schemes are matched, because huggingface_hub has used both:

    * ``<filename>.<etag>.incomplete``  - legacy, keyed on the target name
    * ``<opaque>.<sha256>.<etag>.incomplete`` - current, where the middle
      component is the file's expected digest (an LFS object's etag *is* its
      sha256), and the leading component is derived, not the filename

    A blob matching neither is left alone: no resume and no progress readout
    for it, which costs bandwidth in the worst case but can never attribute
    one asset's bytes to another. Passing neither token matches everything
    (used only where the directory holds a single asset).
    """
    tokens = [t.lower() for t in (filename, sha256) if t]
    try:
        partials = [p for p in d.rglob("*.incomplete") if p.is_file()]
    except OSError:
        return []
    if not tokens:
        return partials
    return [
        p
        for p in partials
        if any(
            p.name.lower().startswith(f"{token}.") or f".{token}." in p.name.lower()
            for token in tokens
        )
    ]


def _largest_incomplete(
    d: Path, filename: str | None = None, sha256: str | None = None
) -> int:
    """Size of the largest matching ``*.incomplete`` file under ``d``.

    A single-file GGUF download has exactly one live partial blob, so we take
    the largest match rather than summing: an orphaned ``*.incomplete`` from a
    prior interrupted attempt (huggingface_hub keys the temp name on the file's
    etag, so a re-download can create a second blob) must not be *added* to the
    live one — that double-counting pushed reported progress past the real size.

    Returns 0 if the directory does not exist or contains no in-progress files.
    """
    return max((_safe_size(p) for p in _partials_for(d, filename, sha256)), default=0)


def _adopt_largest_incomplete(
    legacy_partial: Path,
    modern_dir: Path,
    filename: str | None = None,
    sha256: str | None = None,
) -> bool:
    """Move a reusable interrupted HF temp file to the stable resume path."""
    candidates = [legacy_partial, *_partials_for(modern_dir, filename, sha256)]
    source = max(candidates, key=_safe_size)
    if _safe_size(source) <= 0:
        return False
    if source != legacy_partial:
        logger.info(
            "adopting modern HF partial as resume source size={} from={} to={}",
            _safe_size(source),
            source,
            legacy_partial,
        )
        legacy_partial.unlink(missing_ok=True)
        source.replace(legacy_partial)
    return True


def _active_download_path(
    target: Path, legacy_partial: Path, modern_dir: Path, sha256: str | None = None
) -> Path:
    candidates = [
        target,
        legacy_partial,
        *_partials_for(modern_dir, target.name, sha256),
    ]
    return max(candidates, key=_safe_size)


def _hash_appended_bytes(
    path: Path,
    hasher: Any,
    previous_identity: tuple[int, int] | None,
    offset: int,
    *,
    chunk: int = 1 << 20,
) -> tuple[tuple[int, int] | None, int, bool]:
    if not path.is_file():
        return previous_identity, offset, False
    stat = path.stat()
    identity = (stat.st_dev, stat.st_ino)
    identity_changed = previous_identity is not None and identity != previous_identity
    if identity_changed or stat.st_size < offset:
        return identity, offset, True
    with path.open("rb") as fh:
        fh.seek(offset)
        while True:
            data = fh.read(chunk)
            if not data:
                break
            hasher.update(data)
            offset += len(data)
    return identity, offset, False


def _sha256_file(p: Path, *, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        while True:
            buf = f.read(chunk)
            if not buf:
                break
            h.update(buf)
    return h.hexdigest()


def _run_in_background(fn) -> threading.Thread:
    """Helper so we can ``await asyncio.to_thread(_run_in_background, fn)``
    without the executor blocking on the entire HF download.

    We immediately spawn a daemon thread for the actual blocking call and
    return it so the caller can join() it on the next retry attempt.
    """
    t = threading.Thread(target=fn, daemon=True, name="hf-download-worker")
    t.start()
    return t


def _should_fallback_to_direct_download(exc: Exception, *, endpoint: str) -> bool:
    """Use a direct GET fallback when huggingface_hub rejects a mirror HEAD path.

    huggingface_hub's local-dir download path expects Hugging Face-specific
    metadata headers (commit hash / etag) on the initial HEAD/metadata call.
    Some mirrors can still serve the file bytes, but the library rejects that
    metadata response before any download starts. Limit the fallback to mirror
    endpoints so official huggingface.co failures keep their normal semantics.
    """
    normalized = endpoint.strip().rstrip("/").lower()
    if normalized == "https://huggingface.co":
        return False
    if isinstance(exc, FileMetadataError):
        return True
    if isinstance(exc, LocalEntryNotFoundError):
        return any(isinstance(cause, FileMetadataError) for cause in _iter_exception_chain(exc))
    return False


def _iter_exception_chain(exc: BaseException) -> list[BaseException]:
    chain: list[BaseException] = []
    current: BaseException | None = exc
    while current is not None:
        chain.append(current)
        current = current.__cause__ or current.__context__
    return chain


def _direct_stream_download(entry: ModelEntry, target: Path, *, endpoint: str) -> str:
    """Download the file bytes directly from the resolved endpoint.

    This is a compatibility path for mirrors whose metadata responses are not
    accepted by huggingface_hub. Integrity is still protected by the registry's
    declared size + the streaming sha256 verification in ``download()``.
    """
    partial = target.with_suffix(target.suffix + ".incomplete")
    partial.parent.mkdir(parents=True, exist_ok=True)

    resume_from = partial.stat().st_size if partial.exists() else 0
    hasher = hashlib.sha256()
    if resume_from:
        with partial.open("rb") as existing:
            for chunk in iter(lambda: existing.read(1 << 20), b""):
                hasher.update(chunk)
    method_headers: dict[str, str] = {}
    if resume_from > 0:
        method_headers["Range"] = f"bytes={resume_from}-"

    url = _resolve_file_url(endpoint, entry)
    routes = proxy_routes(url)
    logger.info(
        "[direct-stream-debug] START url={} resume_from={} routes={}",
        url,
        resume_from,
        [_route_label(r) for r in routes],
    )
    for attempt, force_bypass in enumerate(routes, start=1):
        try:
            hasher = _stream_to_partial(
                url,
                partial,
                headers=method_headers,
                force_bypass=force_bypass,
                resume_from=resume_from,
                hasher=hasher,
            )
            break
        except (httpx.ConnectError, httpx.ConnectTimeout, httpx.ProxyError) as exc:
            # The route is unusable (no TCP/TLS/CONNECT), so nothing was read and
            # the partial is untouched — safe to re-try the same byte range over
            # the other route. Only connection errors qualify: an HTTP status or a
            # mid-stream failure means the route works and must surface.
            if attempt >= len(routes):
                raise DownloadError(
                    f"cannot reach {url} over any route "
                    f"({', '.join(_route_label(r) for r in routes)}): {exc}"
                ) from exc
            logger.warning(
                "[direct-stream-debug] route unusable, failing over from {}: {}",
                _route_label(force_bypass),
                exc,
            )
    logger.info("[direct-stream-debug] DONE written={} bytes", partial.stat().st_size if partial.exists() else 0)

    actual_size = partial.stat().st_size if partial.exists() else 0
    if entry.size_bytes and actual_size < entry.size_bytes:
        raise DownloadError(
            f"download incomplete: expected at least {entry.size_bytes} bytes, got {actual_size}"
        )
    partial.replace(target)
    return hasher.hexdigest()


def _route_label(force_bypass: bool) -> str:
    return "direct" if force_bypass else "proxy"


def _stream_to_partial(
    url: str,
    partial: Path,
    *,
    headers: dict[str, str],
    force_bypass: bool,
    resume_from: int,
    hasher: hashlib._Hash,
) -> hashlib._Hash:
    """Stream *url* into *partial* over one route; return the hasher to keep.

    Usually that is the *hasher* passed in, but a server answering a ``Range``
    request with ``200`` resends from byte 0, rewriting the partial — so the
    caller must adopt the fresh hasher returned here instead of its own.
    """
    with build_client_for_url(
        url,
        force_bypass=force_bypass,
        follow_redirects=True,
        timeout=httpx.Timeout(
            connect=_DIRECT_STREAM_CONNECT_TIMEOUT,
            read=_DIRECT_STREAM_READ_TIMEOUT,
            write=30.0,
            pool=20.0,
        ),
    ) as client:
        with client.stream("GET", url, headers=headers) as response:
            logger.info(
                "[direct-stream-debug] response route={} status={} content_length={} content_type={}",
                _route_label(force_bypass),
                response.status_code,
                response.headers.get("content-length"),
                response.headers.get("content-type"),
            )
            if resume_from > 0 and response.status_code == 200:
                resume_from = 0
                hasher = hashlib.sha256()
            elif resume_from > 0 and response.status_code != 206:
                response.raise_for_status()

            response.raise_for_status()
            mode = "ab" if resume_from > 0 and response.status_code == 206 else "wb"
            _last_log = time.monotonic()
            _written = resume_from
            with partial.open(mode) as fh:
                for chunk in response.iter_bytes(chunk_size=1 << 20):
                    if chunk:
                        fh.write(chunk)
                        hasher.update(chunk)
                        _written += len(chunk)
                        _now = time.monotonic()
                        if _now - _last_log >= 5.0:
                            logger.info(
                                "[direct-stream-debug] progress written={} bytes", _written
                            )
                            _last_log = _now
    return hasher


def _resolve_file_url(endpoint: str, entry: ModelEntry) -> str:
    if entry.source == "url":
        return entry.url
    repo = quote(entry.repo, safe="/")
    revision = quote(entry.revision or "main", safe="")
    filename = "/".join(quote(part, safe="") for part in entry.filename.split("/"))
    return f"{endpoint.rstrip('/')}/{repo}/resolve/{revision}/{filename}?download=true"
