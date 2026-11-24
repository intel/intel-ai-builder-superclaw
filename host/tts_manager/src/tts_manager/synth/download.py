"""On-demand model downloader (urllib + sha256), ported verbatim from
``sandbox/tts_service/server.py``. Streams the two ONNX files to the host model
dir with real byte progress, verifies each sha256, then loads the model.

The download is consent-gated: nothing is fetched until the UI POSTs /download
after the user confirms the ~350 MB download. github.com release assets are the
first-time source; on an egress-allowlisted network that host must be permitted
(fully env-overridable via KOKORO_WEIGHTS_URL / KOKORO_VOICES_URL)."""

from __future__ import annotations

import hashlib
import os
import ssl
import threading
import urllib.request
from pathlib import Path

from . import model_state as ms

_ONNX_RELEASE_BASE = (
    "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
)


def _download_urls(env_var: str, filename: str) -> list[str]:
    """[primary] source for one ONNX file. Both files are pinned to the
    kokoro-onnx GitHub release (HuggingFace's onnx-community export is a different
    export whose bytes do not match the sha256 pins, so HF is NOT interchangeable). Fully
    env-overridable so an allowlisted mirror needs no code change."""
    primary = os.environ.get(env_var) or f"{_ONNX_RELEASE_BASE}/{filename}"
    return [primary]


def _download_one(target: Path, urls: list[str], sha_expected: str,
                  base_done: int, grand_total: int, ctx: ssl.SSLContext) -> int:
    """Stream one file to ``target``, verify sha256, atomically move into place.
    Byte progress is reported against the two-file total. Returns this file's size
    on success; raises on failure."""
    tmp = target.with_name(target.name + ".download")
    last_error = "no source reachable"
    for url in urls:
        try:
            ms.set_dl(state="downloading", source=url, error=None)
            print(f"[tts-manager] downloading {target.name} from {url} ...", flush=True)
            req = urllib.request.Request(url, headers={"User-Agent": "superclaw-tts/1.0"})
            hasher = hashlib.sha256()
            done = 0
            with urllib.request.urlopen(req, context=ctx, timeout=60) as resp:
                with open(tmp, "wb") as fh:
                    while True:
                        chunk = resp.read(262144)
                        if not chunk:
                            break
                        fh.write(chunk)
                        hasher.update(chunk)
                        done += len(chunk)
                        ms.set_dl(done_bytes=base_done + done, total_bytes=grand_total)
            if sha_expected and hasher.hexdigest() != sha_expected:
                last_error = f"checksum mismatch from {url}"
                print(f"[tts-manager] WARNING: {last_error}; trying next source.", flush=True)
                tmp.unlink(missing_ok=True)
                continue
            os.replace(tmp, target)
            print(f"[tts-manager] {target.name} ready at {target}.", flush=True)
            return done
        except Exception as exc:  # noqa: BLE001 — any source failure falls through
            last_error = f"{type(exc).__name__}: {exc}"
            print(f"[tts-manager] WARNING: download failed from {url}: {last_error}", flush=True)
            tmp.unlink(missing_ok=True)
            continue
    raise RuntimeError(last_error)


def download_weights_and_load() -> None:
    """Download BOTH ONNX files (graph + voices) with real byte progress, verify
    each sha256, then load the model. Updates the download state throughout.

    Short-circuits to a load-only path when both files are already on disk — with
    lazy residency the normal state is "model present, not loaded", so a download
    trigger must NOT re-stream ~350 MB it already has.

    Runs on a daemon background thread (never the event-loop thread). The heavy
    native C-extensions this thread imports (numpy/onnxruntime/spacy/…) were
    already warmed at process startup on the sole main thread (see
    __main__.run → warm_native_imports), so every import here is a cache hit — this
    thread must NOT be the first to LoadLibrary them or it deadlocks on the endpoint
    loader hook."""
    model_target = ms.weights_target()
    voices_target = ms.voices_target()
    if ms.model_present():
        ms.set_dl(state="loading", error=None)
        try:
            ms.load_model_locked()
            ms.set_dl(state="ready", error=None)
        except Exception as exc:  # noqa: BLE001
            ms.set_dl(state="error", error=f"{type(exc).__name__}: {exc}")
            print(f"[tts-manager] WARNING: load of existing model failed: {exc}", flush=True)
        return
    model_target.parent.mkdir(parents=True, exist_ok=True)
    # An env override that's set but empty/whitespace must NOT silently disable
    # integrity verification (fail-open) — fall back to the pinned default so a
    # blank value can't be used to accept an unverified (MITM'd) file.
    model_sha = (os.environ.get("KOKORO_WEIGHTS_SHA256") or "").strip() or ms.DEFAULT_MODEL_SHA256
    voices_sha = (os.environ.get("KOKORO_VOICES_SHA256") or "").strip() or ms.DEFAULT_VOICES_SHA256

    # TLS cert validation is always enforced (CERT_REQUIRED + hostname check via
    # the default context). Corporate-MITM proxies must add their root CA to the
    # system trust store or SSL_CERT_FILE/SSL_CERT_DIR rather than disabling verify.
    ctx = ssl.create_default_context()

    # Rough total for the progress bar (~325 MB graph + ~27 MB voices).
    grand_total = 353_000_000
    try:
        ms.set_dl(state="downloading", done_bytes=0, total_bytes=grand_total, error=None)
        n = _download_one(model_target, _download_urls("KOKORO_WEIGHTS_URL", ms.ONNX_MODEL_FILENAME),
                          model_sha, 0, grand_total, ctx)
        _download_one(voices_target, _download_urls("KOKORO_VOICES_URL", ms.ONNX_VOICES_FILENAME),
                      voices_sha, n, grand_total, ctx)
        ms.set_dl(state="verifying")
        ms.set_dl(state="loading")
        ms.load_model_locked()
        ms.set_dl(state="ready", error=None)
    except Exception as exc:  # noqa: BLE001
        last_error = f"{type(exc).__name__}: {exc}"
        ms.set_dl(state="error", error=last_error)
        print(f"[tts-manager] ERROR: model could not be fetched: {last_error}", flush=True)
        lowered = last_error.lower()
        if "certificate_verify_failed" in lowered or "sslcertverificationerror" in lowered:
            print("[tts-manager] HINT: TLS certificate verification failed. Behind a corporate "
                  "proxy, add its root CA to the system trust store, or set SSL_CERT_FILE to the "
                  "proxy CA bundle (.pem) — do NOT disable certificate verification.", flush=True)


def start_download_if_idle() -> dict[str, object]:
    """Kick off the background download unless the model is already loaded or a
    download is in flight. Returns the current status snapshot."""
    if ms.is_loaded():
        return ms.dl_snapshot()
    if ms.dl_begin_if_idle("downloading"):
        threading.Thread(target=download_weights_and_load, daemon=True).start()
    return ms.dl_snapshot()


def start_prepare_if_idle() -> dict[str, object]:
    """Lazily load the resident model IFF the weights are already on disk, without
    triggering any download. This is what the UI calls when the user turns
    narration on: residency is deferred until first use, so the model load happens
    here rather than blocking the first sentence's synthesis. When weights are
    absent this is a no-op reporting needs_download (the UI then falls back to the
    /download consent flow)."""
    if ms.is_loaded():
        return ms.dl_snapshot()
    if not ms.model_present():
        # No model files yet — do NOT download here; the UI's consent flow
        # (POST /download) owns that. Just report the current (needs_download) state.
        return ms.dl_snapshot()
    if ms.dl_begin_if_idle("loading"):
        # download_weights_and_load short-circuits to a load-only path when the
        # weights are already present, so it is safe (and reused) here.
        threading.Thread(target=download_weights_and_load, daemon=True).start()
    return ms.dl_snapshot()
