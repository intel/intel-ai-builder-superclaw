"""Helpers for the LRM local model registry endpoints.

Discovers GGUF files on disk, cross-references the Store's active model
selections, and records successful trusted-model verification. No downloads or
absolute paths in responses.
"""

from __future__ import annotations

import hashlib
import os
import re
import shutil
import time
from pathlib import Path
from typing import Any, Iterable

from ..common.state import default_state_root
from ..common.store import Store
from .registry import DRAFT_ASSET_ID_SUFFIX, ModelEntry, Registry

# Only alphanumeric, dots, underscores, hyphens; must start with alphanumeric.
# Prevents backslash (Windows path traversal), slashes, and other special chars.
_MODEL_ID_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._-]*$")

_IS_WINDOWS = os.name == "nt"


def model_dir() -> Path:
    """Return the directory where GGUF model files are expected.

    Reads ``LRM_MODEL_DIR`` from the environment if set; otherwise falls back
    to ``<state-root-parent>/models`` (e.g. ``%LOCALAPPDATA%/SuperClaw/llmrouter_manager/models``).
    """
    env = os.environ.get("LRM_MODEL_DIR")
    if env:
        return Path(env)
    return default_state_root().parent / "models"


def list_models(store: Store) -> list[dict[str, Any]]:
    """Return sorted list of discovered GGUF models with active flag.

    Discovers the downloader's nested on-disk layout
    ``models/<id>/<filename>.gguf`` (the model id is the *directory* name, and
    the file name is the HuggingFace asset name, not ``<id>.gguf``). Each entry:
    ``{"id": str, "role": "chat", "downloaded": True, "active": bool}``.
    No absolute paths are included.

    One row per model *directory*, not per file: a model that ships a
    speculative-decoding draft keeps both GGUFs in its directory, and both
    describe the same model id.
    """
    mdir = model_dir()
    active_chat = store.get_config("active_chat_model_id")

    gguf_files: Iterable[Path] = mdir.glob("*/*.gguf") if mdir.is_dir() else ()
    model_ids = sorted({f.parent.name for f in gguf_files})

    return [
        {
            "id": model_id,
            "role": "chat",
            "downloaded": True,
            "active": model_id == active_chat,
        }
        for model_id in model_ids
    ]


def models_status(store: Store) -> dict[str, Any]:
    """Return aggregate status for GET /llm-router/v1/models/status.

    Shape: ``{"total": N, "downloaded": N, "active": {"chat": ..., "embedding": ...}}``.
    """
    models = list_models(store)
    downloaded = sum(1 for m in models if m["downloaded"])
    active_chat = store.get_config("active_chat_model_id")
    active_embedding = store.get_config("active_embedding_model_id")
    return {
        "total": len(models),
        "downloaded": downloaded,
        "active": {
            "chat": active_chat,
            "embedding": active_embedding,
        },
    }


def resolve_model_path(model_id: str) -> Path:
    """Resolve *model_id* to its ``.gguf`` file under the nested download layout.

    The downloader writes ``models/<id>/<filename>.gguf`` (the filename is the
    HuggingFace asset name, not ``<id>.gguf``), so we glob inside the per-model
    directory rather than assuming a flat ``models/<id>.gguf``. When the model
    is absent, a non-existent path inside the model dir is returned so callers
    surface a clean ``FileNotFoundError`` via ``is_file()``.

    The directory can hold a second GGUF - a speculative-decoding draft, always
    a fraction of the size of the model it drafts for - so the largest file
    wins rather than the first in name order.

    Raises ``ValueError`` if the ID fails the strict character allowlist or
    if the resolved path escapes the model directory (belt-and-suspenders).
    """
    if not _MODEL_ID_RE.match(model_id):
        raise ValueError(f"Invalid model id: {model_id!r}")
    mdir = model_dir()
    sub = mdir / model_id
    matches = sorted(sub.glob("*.gguf")) if sub.is_dir() else []
    path = max(matches, key=_file_size) if matches else sub / f"{model_id}.gguf"
    # Belt-and-suspenders: resolved path must stay inside the model dir.
    try:
        path.resolve().relative_to(mdir.resolve())
    except ValueError:
        raise ValueError(f"Invalid model id: {model_id!r}")
    return path


def stat_identity(stat: os.stat_result) -> tuple[int, int, int]:
    """Content identity of a file: size + mtime + ctime.

    Used to confirm a file did not change under a long read (hashing a
    multi-GB GGUF). Deliberately excludes ``st_atime``: reading the file to
    hash it is itself an access, so comparing whole ``os.stat_result`` tuples
    could report a perfectly intact asset as "changed mid-verification" - and
    a spurious unverified asset means a spurious multi-GB re-download.
    """
    return (stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)


def _file_size(path: Path) -> int:
    """Size in bytes, or 0 for a file that vanished mid-scan."""
    try:
        return path.stat().st_size
    except OSError:
        return 0


def sha256_file(path: Path, *, chunk: int = 1 << 20) -> str:
    """Streamed sha256 so verifying a multi-GB GGUF never loads it into RAM."""
    h = hashlib.sha256()
    with path.open("rb") as f:
        while True:
            buf = f.read(chunk)
            if not buf:
                break
            h.update(buf)
    return h.hexdigest()


def verify_model(
    model_id: str, registry: Registry, store: Store | None = None
) -> dict[str, Any]:
    """Return size + sha256 of the model file, compared against the registry.

    Shape::

        {
          "ok": bool,                    # EVERY file of the asset verified
          "sha256": str,                 # actual, streamed (no whole-file read)
          "sha256_match": bool | None,   # None when the registry has no sha256
          "size_bytes": int,             # actual on-disk size
          "size_match": bool | None,     # None when the registry has no size
          "expected_sha256": str | None,
          "expected_size_bytes": int | None,
          "draft": {... same keys, plus "present": bool},  # only when declared
        }

    A ``*_match`` field is ``None`` (never ``False``) when the registry carries
    no expected value for it, so "unknown" is never conflated with "mismatch".

    The top-level fields describe the main GGUF. An entry declaring a
    speculative-decoding draft also carries a ``"draft"`` block, and ``"ok"``
    folds both files together because ``inspect_asset_cache`` only counts such
    an asset cached when BOTH files verify - model and draft launch as one unit.

    Covering the draft is not cosmetic. This is the pre-download helper the UI
    calls per *asset* (there is no per-draft endpoint - a draft is not a row in
    ``bundle.assets``), and it is all that stands between a ``-KeepModels``
    rebuild and a consent prompt for files already on disk. Hashing only the
    main GGUF left the draft's record - keyed separately as
    ``<id>#draft`` - permanently unwritable by this helper, so a 35B box asked
    the user to approve the draft's 421.1 MB on every rebuild and then moved
    zero bytes. The downloader persists both records (``_ensure_file``) and
    ``delete_model`` removes both; this path must cover both or the hash-free
    projection in ``inspect_asset_cache`` can never agree with it.

    Raises ``ValueError`` for an invalid *model_id*.
    Raises ``FileNotFoundError`` when the main file does not exist. A declared
    but absent draft reports ``present: False`` instead of raising: that is a
    genuine partial cache the caller should go on to download, not a lookup
    failure.
    """
    entry = registry.get(model_id)

    # Prefer the registry's declared filename so we verify the exact asset the
    # downloader wrote, not whatever *.gguf happens to sort first when several
    # coexist under models/<id>/ (e.g. a leftover partial or a different quant).
    if entry and entry.filename:
        candidate = model_dir() / model_id / entry.filename
        path = candidate if candidate.is_file() else resolve_model_path(model_id)
    else:
        path = resolve_model_path(model_id)
    if not path.is_file():
        raise FileNotFoundError(model_id)

    result = _verify_asset_file(entry, path, store)

    draft = entry.draft_asset() if entry else None
    if draft is not None:
        # The draft sits beside its parent, so its path resolves from the parent
        # id even though its record is keyed by the synthetic `<id>#draft` (see
        # ModelEntry.draft_asset).
        draft_path = model_dir() / model_id / draft.filename
        if draft_path.is_file():
            draft_result: dict[str, Any] = {
                "present": True,
                **_verify_asset_file(draft, draft_path, store),
            }
        else:
            draft_result = {
                "present": False,
                "ok": False,
                "sha256": None,
                "sha256_match": None,
                "size_bytes": None,
                "size_match": None,
                "expected_sha256": draft.sha256,
                "expected_size_bytes": draft.size_bytes,
            }
        result["draft"] = draft_result
        result["ok"] = bool(result["ok"] and draft_result["ok"])

    return result


def _verify_asset_file(
    entry: ModelEntry | None, path: Path, store: Store | None
) -> dict[str, Any]:
    """Hash one asset file, compare it to *entry*, and persist its record.

    *entry* is ``None`` for a GGUF with no registry entry: nothing to compare
    against, so both ``*_match`` fields stay ``None`` and no record is written.

    The record is persisted only when the comparison passed AND the file's stat
    identity held across the hash, so a record never describes content that
    changed mid-read.
    """
    before = path.stat()
    actual_sha = sha256_file(path)
    after = path.stat()
    actual_size = after.st_size

    expected_sha = entry.sha256 if entry else None
    expected_size = entry.size_bytes if entry and entry.size_bytes else None

    # Compare sha256 hex case-insensitively - a user-supplied registry entry
    # may carry an uppercase digest while sha256_file always yields lowercase.
    sha256_match = (
        actual_sha.lower() == expected_sha.lower() if expected_sha else None
    )
    size_match = (actual_size == expected_size) if expected_size else None
    ok = sha256_match is not False and size_match is not False

    if (
        ok
        and before.st_size == after.st_size
        and before.st_mtime_ns == after.st_mtime_ns
        and before.st_ctime_ns == after.st_ctime_ns
        and store is not None
        and entry is not None
        and entry.sha256 is not None
        and entry.filename
        and entry.size_bytes is not None
    ):
        store.set_model_verification(
            asset_id=entry.id,
            expected_sha256=entry.sha256.lower(),
            filename=entry.filename,
            size_bytes=after.st_size,
            mtime_ns=after.st_mtime_ns,
            ctime_ns=after.st_ctime_ns,
        )

    return {
        "ok": ok,
        "sha256": actual_sha,
        "sha256_match": sha256_match,
        "size_bytes": actual_size,
        "size_match": size_match,
        "expected_sha256": expected_sha,
        "expected_size_bytes": expected_size,
    }


def delete_model(model_id: str, store: Store) -> dict[str, Any]:
    """Delete *model_id*'s ``.gguf`` file if it is not currently active.

    Shape: ``{"success": True, "id": model_id}``.

    Raises ``ValueError`` for invalid *model_id*.
    Raises ``FileNotFoundError`` when the file does not exist.
    Raises ``RuntimeError`` when the model is set as the active chat or embedding
    model, or when the GGUF is still locked by a running server.
    Raises ``OSError`` when the GGUF was removed but its per-model cache
    directory could not be fully cleaned up.
    """
    path = resolve_model_path(model_id)
    if not path.is_file():
        raise FileNotFoundError(model_id)
    active_chat = store.get_config("active_chat_model_id")
    active_embedding = store.get_config("active_embedding_model_id")
    if model_id in (active_chat, active_embedding):
        raise RuntimeError(f"Model {model_id!r} is currently in use")
    try:
        path.unlink()
    except FileNotFoundError:
        pass
    except PermissionError as exc:
        if not _IS_WINDOWS:
            raise
        for _ in range(5):
            time.sleep(0.2)
            try:
                path.unlink()
                break
            except FileNotFoundError:
                break
            except PermissionError:
                continue
        else:
            raise RuntimeError(f"Model {model_id!r} is currently in use") from exc
    # Remove the *entire* per-model directory, not just the GGUF. huggingface_hub
    # keeps resume state under ``<id>/.cache/huggingface/download/`` including
    # ``*.incomplete`` partial blobs. Leaving those behind (the old code only
    # rmdir'd the dir when empty) made a later re-download resume from — and the
    # progress poller double-count — stale bytes, so progress started mid-file
    # and could exceed the declared size. The nested layout is one directory per
    # model id, so removing it wholesale only affects this model.
    try:
        shutil.rmtree(path.parent)
    except FileNotFoundError:
        pass
    except OSError as exc:
        raise OSError(
            f"Model {model_id!r} was removed but its cache directory could not be "
            f"fully cleaned up ({exc}); leftover partial blobs may corrupt a later "
            f"re-download"
        ) from exc
    store.delete_model_verification(model_id)
    # The per-model directory removal above also took any speculative-decoding
    # draft with it, so its verification record must go too - a record that
    # outlives its file makes the capability projection report a cached asset
    # that is not there (see ``inspect_asset_cache``).
    store.delete_model_verification(f"{model_id}{DRAFT_ASSET_ID_SUFFIX}")
    return {"success": True, "id": model_id}
