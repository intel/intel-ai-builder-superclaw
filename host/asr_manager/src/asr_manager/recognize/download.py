"""On-demand model downloader (urllib + sha256) for the Parakeet int8 export.

Streams the four files of ``csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8``
to the host model dir with real byte progress, verifies each sha256, then loads
the model. Consent-gated: nothing is fetched until the UI POSTs ``/download``
after the user confirms the ~630 MB.

Interrupted transfers RESUME rather than restart: a file already on disk with a
matching hash is skipped (``already_verified``), and a half-written part-file is
continued with an HTTP Range request (``_download_one``). On the slow connection
this feature is for, "stalled at 600 of 652 MB" must not mean "start over".

Shape is tts_manager's ``synth/download.py``; the SOURCE-SELECTION policy is
deliberately NOT tts_manager's, and that is the one difference that matters.

    tts_manager:  a single GitHub release URL, overridable only by hand through
                  KOKORO_WEIGHTS_URL / KOKORO_VOICES_URL. That is an env override,
                  not a fallback: on a network that cannot reach github.com the
                  download simply fails and the user has to discover an
                  undocumented variable and a working mirror URL themselves.

    asr_manager:  ``resolve_hf_endpoint()`` from
                  ``llmrouter_manager.local.hf_endpoint`` -- the resolver the GGUF
                  downloader already uses. It honours an operator-set HF_ENDPOINT
                  first, and otherwise probes huggingface.co and hf-mirror.com in
                  parallel and prefers the official site when reachable. So a host
                  behind the Great Firewall gets the mirror with no configuration,
                  which is exactly the failure mode the plan calls out.

Imported LAZILY (inside ``_resolve_endpoints``) rather than at module scope: it is
the only thing this service borrows from llmrouter_manager, it pulls httpx +
loguru, and keeping it out of the import graph of ``api/asr.py`` means a
transcribe-only process never touches it.
"""

from __future__ import annotations

import hashlib
import os
import ssl
import threading
import urllib.error
import urllib.request
from pathlib import Path

from . import model_state as ms

# Read timeout per chunk read, not per file. The encoder is 622 MB, so a
# whole-file timeout would have to be minutes and would then hide a genuinely
# dead connection for minutes.
_READ_TIMEOUT_S = 60
_CHUNK_BYTES = 262_144

# Attempts per file, spread round-robin over the available endpoints. A 622 MB
# transfer on a home connection is long enough that a single 60 s read stall is an
# ordinary event, not a verdict on the source -- and without a retry that stall
# costs the user the whole download. Each attempt RESUMES from the bytes already on
# disk (HTTP Range), so six attempts are six chances to finish one file, not six
# times 622 MB.
_MAX_ATTEMPTS = 6

_HF_OFFICIAL = "https://huggingface.co"
_HF_MIRROR = "https://hf-mirror.com"


def hf_repo() -> str:
    """The HF repo id to download from. ASR_HF_REPO overrides it; a swap must
    come with matching sha256 overrides (see ``_expected_sha256``) and matching
    sizes in ``ms.DEFAULT_FILE_SIZES``, which are now a download ceiling and not
    only progress arithmetic (see ``_expected_size``)."""
    return (os.environ.get("ASR_HF_REPO") or "").strip() or ms.DEFAULT_HF_REPO


def _expected_sha256(filename: str) -> str:
    """Pinned sha256 for one file, overridable per file.

    ``ASR_ENCODER_SHA256`` / ``ASR_DECODER_SHA256`` / ``ASR_JOINER_SHA256`` /
    ``ASR_TOKENS_SHA256``. An override that is set but blank/whitespace must NOT
    silently disable integrity verification (fail-open), so it falls back to the
    pinned default -- a blank value cannot be used to accept an unverified
    (MITM'd) file.
    """
    stem = filename.split(".")[0].upper()
    override = (os.environ.get(f"ASR_{stem}_SHA256") or "").strip()
    return override or ms.DEFAULT_FILE_SHA256.get(filename, "")


def _expected_size(filename: str) -> int:
    """Pinned byte size for one file, or 0 when unknown.

    This is a HARD CEILING on what one file may write, not just progress-bar
    arithmetic: the sha256 is only known after the last byte, so without a ceiling
    a faulty or hostile endpoint can stream past the pinned size and fill the
    user's disk (with the progress bar reporting >100% while it does). The size
    table is already treated as authoritative for a repo swap -- ``grand_total``
    comes from it whatever ``ASR_HF_REPO`` says -- so a swap to files of different
    sizes must update ``ms.DEFAULT_FILE_SIZES`` alongside the sha256 table, as
    ``hf_repo`` already warns.
    """
    return ms.DEFAULT_FILE_SIZES.get(filename, 0)


def _resolve_endpoints() -> list[str]:
    """Ordered HF endpoints to try, most-preferred first.

    ``resolve_hf_endpoint`` already probes and picks, so the FIRST entry is the
    answer in the normal case. The second entry exists for a different failure:
    the chosen endpoint answered a 1.5 s HEAD probe but then stalls or 5xx's
    partway through a 622 MB transfer. Adding the other public endpoint as a
    secondary source costs nothing when the first works.

    An explicitly configured HF_ENDPOINT is returned AS-IS and alone, without the
    resolver being consulted at all: the operator named one endpoint (often the
    only one their network permits, or an internal cache), and silently reaching
    past it would defeat the point of setting it. ANY non-empty value is
    exclusive, the official site included.

    The resolver cannot be asked about a pinned value, which is why the check is
    in front of it rather than after. ``resolve_hf_endpoint`` documents that a
    ``configured_endpoint`` equal to the official default is treated as "unset"
    so a blocked host can still auto-select the mirror -- sensible for its own
    callers, wrong here. Asking it about ``HF_ENDPOINT=https://huggingface.co``
    and returning its answer exclusively made the mirror the SOLE source
    whenever the official endpoint failed a 1.5 s probe: the operator pinned one
    host and got a 630 MB transfer from a third-party one they never named.
    Substituting the mirror is strictly worse than the appending bug this guard
    originally fixed, since there is no preferred entry in front of it.
    """
    configured = (os.environ.get("HF_ENDPOINT") or "").strip().rstrip("/")
    if configured:
        return [configured]

    try:
        from llmrouter_manager.local.hf_endpoint import resolve_hf_endpoint
    except Exception as exc:  # noqa: BLE001
        # Never fatal: a resolver import failure must degrade to "try both public
        # endpoints in the documented priority order", not to no download at all.
        print(
            f"[asr-manager] WARNING: HF endpoint resolver unavailable "
            f"({type(exc).__name__}: {exc}); falling back to the official "
            f"endpoint then the mirror",
            flush=True,
        )
        return [_HF_OFFICIAL, _HF_MIRROR]

    # "" rather than ``configured``, which is necessarily empty here: passing it
    # would read as though a pinned value could still reach the resolver.
    primary = resolve_hf_endpoint("").rstrip("/")
    alternate = _HF_MIRROR if primary == _HF_OFFICIAL else _HF_OFFICIAL
    return [primary, alternate]


def _tls_context() -> ssl.SSLContext:
    """Verifying context that trusts the Windows store PLUS certifi's Mozilla roots.

    The Windows store alone is not enough: Windows installs a missing root lazily,
    and only for its own TLS clients, so a home machine often lacks the Amazon root
    behind the HF CDN (``*.cdn.hf.co``) and every fetch fails with
    CERTIFICATE_VERIFY_FAILED. The store is still loaded so a corporate proxy CA
    (and SSL_CERT_FILE) keeps working; verification is never relaxed.
    """
    ctx = ssl.create_default_context()
    try:
        import certifi
    except ImportError:
        return ctx
    ctx.load_verify_locations(cafile=certifi.where())
    return ctx


def _file_urls(endpoints: list[str], filename: str) -> list[str]:
    repo = hf_repo()
    return [f"{endpoint}/{repo}/resolve/main/{filename}" for endpoint in endpoints]


def _sha256_of(path: Path, hasher: "hashlib._Hash | None" = None) -> "hashlib._Hash":
    """Feed ``path``'s bytes through ``hasher`` (a fresh sha256 by default) and
    return it. Streamed in chunks: these files are up to 622 MB."""
    hasher = hasher if hasher is not None else hashlib.sha256()
    with open(path, "rb") as fh:
        while True:
            chunk = fh.read(_CHUNK_BYTES)
            if not chunk:
                break
            hasher.update(chunk)
    return hasher


def already_verified(target: Path, sha_expected: str) -> bool:
    """True when ``target`` is on disk AND its sha256 matches the pinned value.

    This is what makes a retry cheap, and it is the ONLY check that can tell a good
    file from a bad one. ``download_weights_and_load``'s fast path is gated on
    ``model_present()`` -- ALL FOUR files, ``is_file()`` only -- so after a failure
    partway through, the files that did land are re-requested; without this check the
    user pays for them again. It is also what makes a corrupt file the only one
    re-fetched, which is both the behaviour the size-ascending order below assumes
    and the whole recovery path for ``model_load_failed``.

    Hashing 622 MB from a warm page cache costs ~1-2 s against a ~630 MB download, so
    it is only ever consulted on a retry or re-verify path (a first download has
    nothing on disk, and a healthy complete model short-circuits earlier on
    ``model_present()``).
    """
    if not target.is_file():
        return False
    if not sha_expected:
        return False
    try:
        return _sha256_of(target).hexdigest() == sha_expected
    except OSError:
        return False


def _download_one(
    target: Path,
    urls: list[str],
    sha_expected: str,
    size_expected: int,
    base_done: int,
    grand_total: int,
    ctx: ssl.SSLContext,
) -> int:
    """Stream one file to ``target``, verify sha256, atomically move into place.

    RESUMABLE. Each attempt keeps the ``.download`` part-file and asks for
    ``Range: bytes=<have>-``, because the failure this has to survive is a stall at
    600 of 652 MB: deleting the part-file there means the user presses Download again
    and re-streams everything, and on a slow connection that can fail indefinitely.
    Attempts are spread round-robin over ``urls`` (``_MAX_ATTEMPTS`` total) so a
    genuinely broken endpoint still falls through to the other one.

    Integrity is unchanged by resuming: the sha256 is computed over the WHOLE file
    (the part-file's existing bytes are re-hashed from disk at the start of an
    attempt), so a mismatched or tampered fragment still fails the pinned hash. A
    hash mismatch is the one failure that does NOT resume -- it means the bytes on
    disk are wrong, so the part-file is discarded and the next attempt starts clean.

    ``size_expected`` is enforced WHILE streaming, not after: the hash cannot be
    checked until the last byte, so a source that never stops sending would
    otherwise be free to fill the disk first and fail verification afterwards. An
    overrun is treated exactly like a hash mismatch -- the bytes are known wrong,
    so the part-file is discarded and the next attempt starts clean.

    Byte progress is reported against the four-file total. Returns this file's size
    on success; raises RuntimeError when every attempt failed.
    """
    tmp = target.with_name(target.name + ".download")
    last_error = "no source reachable"
    for attempt in range(_MAX_ATTEMPTS):
        url = urls[attempt % len(urls)]
        try:
            ms.set_dl(state="downloading", source=url, error=None)
            # Resume point: whatever a previous attempt managed to write. Re-hash it
            # so the running digest covers the bytes on disk as well as the new ones.
            have = tmp.stat().st_size if tmp.is_file() else 0
            if size_expected and have > size_expected:
                # A part-file already longer than the pinned size cannot become the
                # right file by resuming, and asking for a Range past the end of the
                # object only earns a 416. Start clean.
                print(
                    f"[asr-manager] WARNING: {target.name}.download is "
                    f"{have} bytes, past the pinned {size_expected}; discarding it.",
                    flush=True,
                )
                tmp.unlink(missing_ok=True)
                have = 0
            hasher = hashlib.sha256()
            if have:
                hasher = _sha256_of(tmp, hasher)
                print(
                    f"[asr-manager] resuming {target.name} at "
                    f"{have / 1_048_576:.1f} MiB from {url} ...",
                    flush=True,
                )
            else:
                print(
                    f"[asr-manager] downloading {target.name} from {url} ...",
                    flush=True,
                )
            headers = {"User-Agent": "superclaw-asr/1.0"}
            if have:
                headers["Range"] = f"bytes={have}-"
            req = urllib.request.Request(url, headers=headers)
            ms.set_dl(done_bytes=base_done + have, total_bytes=grand_total)
            done = have
            with urllib.request.urlopen(req, context=ctx, timeout=_READ_TIMEOUT_S) as resp:
                # A server may ignore Range and answer 200 with the whole file. Then
                # the part-file must be thrown away, or the two byte ranges would be
                # concatenated into a file that is the right length and the wrong
                # content (the hash would catch it, but only after a full download).
                resuming = have > 0 and resp.status == 206
                if have and not resuming:
                    print(
                        f"[asr-manager] {url} ignored the Range request "
                        f"(HTTP {resp.status}); restarting {target.name} from 0.",
                        flush=True,
                    )
                    hasher = hashlib.sha256()
                    done = 0
                    ms.set_dl(done_bytes=base_done, total_bytes=grand_total)
                oversize = False
                with open(tmp, "ab" if resuming else "wb") as fh:
                    while True:
                        chunk = resp.read(_CHUNK_BYTES)
                        if not chunk:
                            break
                        if size_expected and done + len(chunk) > size_expected:
                            # Refused BEFORE the write, so the ceiling is a real cap
                            # on bytes on disk and not merely a post-hoc check.
                            oversize = True
                            break
                        fh.write(chunk)
                        hasher.update(chunk)
                        done += len(chunk)
                        ms.set_dl(done_bytes=base_done + done, total_bytes=grand_total)
            if oversize:
                last_error = (
                    f"{url} sent more than the pinned {size_expected} bytes for "
                    f"{target.name}"
                )
                print(
                    f"[asr-manager] WARNING: {last_error}; discarding the partial "
                    f"file and retrying from the start.",
                    flush=True,
                )
                tmp.unlink(missing_ok=True)
                ms.set_dl(done_bytes=base_done, total_bytes=grand_total)
                continue
            if sha_expected and hasher.hexdigest() != sha_expected:
                last_error = f"checksum mismatch from {url}"
                print(
                    f"[asr-manager] WARNING: {last_error}; discarding the partial "
                    f"file and retrying from the start.",
                    flush=True,
                )
                tmp.unlink(missing_ok=True)
                # Progress must not keep the bytes of a rejected file, or the retry
                # would show >100%.
                ms.set_dl(done_bytes=base_done, total_bytes=grand_total)
                continue
            os.replace(tmp, target)
            print(f"[asr-manager] {target.name} ready at {target}.", flush=True)
            return done
        except urllib.error.HTTPError as exc:
            last_error = f"HTTPError: {exc}"
            print(
                f"[asr-manager] WARNING: download failed from {url}: {last_error}",
                flush=True,
            )
            # 416 means the part-file is at least as long as the remote object, so
            # the resume offset itself is the problem and no retry can fix it while
            # the file stays. Every other HTTP status leaves the part-file alone so
            # the next attempt resumes.
            if exc.code == 416:
                tmp.unlink(missing_ok=True)
                ms.set_dl(done_bytes=base_done, total_bytes=grand_total)
            continue
        except Exception as exc:  # noqa: BLE001 -- any source failure falls through
            last_error = f"{type(exc).__name__}: {exc}"
            print(
                f"[asr-manager] WARNING: download failed from {url}: {last_error}",
                flush=True,
            )
            # The part-file SURVIVES a network failure on purpose -- that is the
            # whole resume mechanism. Only the two failures that prove the bytes on
            # disk are WRONG discard it: a hash mismatch and a size overrun (above).
            continue
    raise RuntimeError(last_error)


def load_present_weights() -> None:
    """Load the on-disk weights into RAM. NEVER fetches anything.

    This is the whole body of ``/prepare`` (contract §5: "loads already-present
    weights into RAM") and the short-circuit of ``/download`` when the four files
    are on disk and nothing has failed -- with lazy residency the normal state is
    "model present, not loaded", so a download trigger must NOT re-stream ~630 MB it
    already has.

    The byte counters are zeroed, not left at whatever a caller published:
    ``dl_begin_if_idle("downloading")`` sets ``total_bytes`` to the full ~630 MB
    before it is known whether any byte will be fetched, and leaving that behind
    while the state is ``loading``/``error`` renders in the UI as a download stuck at
    0% (contract §4 computes the percentage from these two fields).

    Runs on a daemon background thread (never the event-loop thread). The native
    C-extensions the load imports (numpy/onnxruntime) were already warmed at
    process startup on the sole main thread (see __main__.run ->
    warm_native_imports), so every import here is a cache hit -- this thread must
    NOT be the first to LoadLibrary them or it deadlocks on the endpoint loader
    hook.
    """
    ms.set_dl(state="loading", error=None, done_bytes=0, total_bytes=0, source=None)
    try:
        ms.load_model_locked()
        ms.set_dl(state="ready", error=None)
    except Exception as exc:  # noqa: BLE001
        ms.set_dl(state="error", error=f"{type(exc).__name__}: {exc}")
        print(
            f"[asr-manager] WARNING: load of existing model failed: {exc}; "
            f"POST /speech-to-text/v1/download re-verifies the files on disk and "
            f"re-fetches whichever one is bad",
            flush=True,
        )


def download_weights_and_load(reverify: bool = False) -> None:
    """Download all four files with real byte progress, verify each sha256, then
    load the model. Updates the download state throughout.

    ``reverify=False`` (the normal /download): short-circuits to
    ``load_present_weights()`` when ``model_present()`` says all four files exist.

    ``reverify=True`` (/download entered from ``state == "error"``, i.e. the UI's
    [重新下載] after ``model_load_failed``): SKIPS that short-circuit and walks the
    per-file ``already_verified()`` path below, so each file's sha256 is re-checked
    and only the ones that fail are re-fetched.

    That distinction is the difference between a recoverable and an unrecoverable
    install. ``model_present()`` is a pure ``is_file()`` check, so a truncated or
    corrupt encoder still reads as present; short-circuiting on it unconditionally
    meant the documented recovery for ``model_load_failed`` (contract §8a: "Show
    failure + [重新下載]") rebuilt and re-failed the same ONNX session forever
    without re-fetching a single byte, and the only way out was for the user to
    delete ``%LOCALAPPDATA%\\SuperClaw\\parakeet`` by hand.

    Re-verifying costs a sha256 sweep of ~630 MB (a few seconds from disk) and is
    only ever paid on this failure path -- a healthy /download still short-circuits.

    Runs on a daemon background thread; see ``load_present_weights`` for the
    native-import warmup constraint.
    """
    if not reverify and ms.model_present():
        load_present_weights()
        return

    directory = ms.model_dir()
    directory.mkdir(parents=True, exist_ok=True)

    # TLS cert validation is always enforced (CERT_REQUIRED + hostname check via
    # the default context). Corporate-MITM proxies must add their root CA to the
    # system trust store or SSL_CERT_FILE/SSL_CERT_DIR rather than disabling verify.
    ctx = _tls_context()

    # Exact, not estimated: the per-file sizes are pinned alongside the hashes.
    grand_total = ms.TOTAL_DOWNLOAD_BYTES
    try:
        ms.set_dl(
            state="downloading", done_bytes=0, total_bytes=grand_total, error=None
        )
        endpoints = _resolve_endpoints()
        print(
            f"[asr-manager] model source: repo={hf_repo()} endpoints={endpoints} "
            f"(reverify={reverify})",
            flush=True,
        )
        done = 0
        # Smallest file first: tokens.txt is 9 KB of the 630 MB, and the encoder is
        # 622 MB of it. Combined with the already_verified() skip below, a failure
        # part-way through really does leave the encoder as the single thing to
        # re-fetch -- the cheap files are on disk with a matching hash and are
        # skipped. (The order alone would NOT achieve that: this whole function is
        # entered whenever any of the four files is missing, so without the skip a
        # retry re-streams the three small ones as well.)
        order = sorted(
            ms.MODEL_FILENAMES, key=lambda name: ms.DEFAULT_FILE_SIZES.get(name, 0)
        )
        for filename in order:
            target = directory / filename
            if target.is_file():
                # Hashing the 622 MB encoder takes a few seconds; say "verifying"
                # rather than leaving the UI on "downloading 0%" while nothing moves.
                # (Contract §4 lists verifying as a legal state and renders it with
                # the same percentage as downloading.)
                ms.set_dl(state="verifying", source=None)
            if already_verified(target, _expected_sha256(filename)):
                print(
                    f"[asr-manager] {filename} already present and verified; skipping.",
                    flush=True,
                )
                done += target.stat().st_size
                ms.set_dl(done_bytes=done, total_bytes=grand_total)
                continue
            if target.is_file():
                print(
                    f"[asr-manager] {filename} is present but does NOT match its "
                    f"pinned sha256 (truncated or corrupt); re-fetching it.",
                    flush=True,
                )
            done += _download_one(
                target,
                _file_urls(endpoints, filename),
                _expected_sha256(filename),
                _expected_size(filename),
                done,
                grand_total,
                ctx,
            )
        # Every file's sha256 was verified inside _download_one as it streamed, so
        # "verifying" is a transient state the UI may or may not observe; it is set
        # for parity with tts_manager's snapshot vocabulary (frozen contract §4
        # lists it as a legal `state`).
        ms.set_dl(state="verifying")
        ms.set_dl(state="loading")
        ms.load_model_locked()
        ms.set_dl(state="ready", error=None)
    except Exception as exc:  # noqa: BLE001
        last_error = f"{type(exc).__name__}: {exc}"
        ms.set_dl(state="error", error=last_error)
        print(
            f"[asr-manager] ERROR: model could not be fetched: {last_error}", flush=True
        )
        lowered = last_error.lower()
        if "certificate_verify_failed" in lowered or "sslcertverificationerror" in lowered:
            print(
                "[asr-manager] HINT: TLS certificate verification failed. Behind a "
                "corporate proxy, add its root CA to the system trust store, or set "
                "SSL_CERT_FILE to the proxy CA bundle (.pem) -- do NOT disable "
                "certificate verification.",
                flush=True,
            )


def start_download_if_idle() -> dict[str, object]:
    """Kick off the background download unless the model is already loaded or a
    download is in flight. Returns the current status snapshot.

    Entering from ``state == "error"`` means this POST is the UI's [重新下載] after a
    ``model_load_failed`` (contract §8a), so the bytes on disk are known-suspect and
    must be re-verified file by file instead of being trusted because they exist.
    The state is read BEFORE ``dl_begin_if_idle`` because that call clears ``error``
    and overwrites ``state``.

    The read is not inside the same critical section as the begin, and does not need
    to be: two racing POSTs are already serialized by ``dl_begin_if_idle`` (exactly
    one starts a thread), and the only cost of the loser's stale read is one
    unnecessary -- or one deferred -- sha256 sweep, never a wrong download.
    """
    if ms.is_loaded():
        return ms.dl_snapshot()
    reverify = ms.dl_state_get("state") == "error"
    if ms.dl_begin_if_idle("downloading"):
        threading.Thread(
            target=download_weights_and_load,
            kwargs={"reverify": reverify},
            name="asr-download",
            daemon=True,
        ).start()
    return ms.dl_snapshot()


def start_prepare_if_idle() -> dict[str, object]:
    """Lazily load the resident model IFF the weights are already on disk, without
    triggering any download. This is what the UI calls when the voice-input page
    opens or the mic is armed: residency is deferred until first use, so the load
    happens here rather than inside the first /transcribe. When weights are absent
    this is a no-op reporting the current (needs-download) state -- the UI's
    consent flow (POST /download) owns fetching them."""
    if ms.is_loaded():
        return ms.dl_snapshot()
    if not ms.model_present():
        return ms.dl_snapshot()
    if ms.dl_begin_if_idle("loading"):
        # ``load_present_weights`` and NOT ``download_weights_and_load``: /prepare
        # must be incapable of fetching anything, whatever the state of the files on
        # disk. Routing it through the downloader (which now re-fetches a file whose
        # sha256 is wrong) would let an un-consented ~630 MB transfer start from a
        # route the user never agreed to.
        threading.Thread(
            target=load_present_weights, name="asr-prepare", daemon=True
        ).start()
    return ms.dl_snapshot()
