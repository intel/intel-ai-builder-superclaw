"""Temporary upload file storage for multipart endpoint requests."""

from __future__ import annotations

import os
import shutil
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import HTTPException, UploadFile, status
from fastapi.concurrency import run_in_threadpool


# Whitelist of extensions accepted from multipart uploads. Anything outside
# this set falls back to ``.bin`` so a crafted filename (e.g. ``foo.exe``,
# path separators, control chars) cannot influence the on-disk suffix.
_ALLOWED_UPLOAD_SUFFIXES: frozenset[str] = frozenset(
    {".csv", ".xlsx", ".parquet", ".txt", ".md", ".html", ".htm", ".docx"}
)


def safe_upload_suffix(filename: str | None) -> str:
    """Return a whitelisted upload file extension.

    Args:
        filename: Client-provided upload filename.

    Returns:
        str: Whitelisted lowercase suffix, or ``.bin`` when unrecognized.
    """
    if not filename:
        return ".bin"
    suffix = Path(filename).suffix.lower()
    return suffix if suffix in _ALLOWED_UPLOAD_SUFFIXES else ".bin"


def _copy_stream_with_cap(src: object, dst: object, max_bytes: int, chunk: int = 1 << 20) -> None:
    """Copy a stream while enforcing a hard byte cap.

    Args:
        src: Readable binary stream.
        dst: Writable binary file.
        max_bytes: Hard cap on bytes written.
        chunk: Read chunk size in bytes (default 1 MiB).

    Raises:
        HTTPException: HTTP 413 if total bytes written exceeds ``max_bytes``.
    """
    written = 0
    while True:
        buf = src.read(chunk)
        if not buf:
            return
        written += len(buf)
        if written > max_bytes:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail={
                    "error": "source_too_large",
                    "message": f"Upload exceeds configured redact.max_source_bytes={max_bytes} bytes.",
                },
            )
        dst.write(buf)


def persist_upload_to_temp_file_sync(
    upload_stream: object,
    filename: str | None,
    redacts_dir: Path,
    max_bytes: int,
) -> tuple[Path, Path]:
    """Persist an upload stream to a private per-request temp directory.

    Args:
        upload_stream: Readable upload stream.
        filename: Client-provided filename used only for suffix selection.
        redacts_dir: Base redacts directory under which the upload root sits.
        max_bytes: Maximum upload size in bytes (0 = no limit).

    Returns:
        tuple[Path, Path]: Request directory and persisted upload file path.

    Raises:
        HTTPException: If the upload exceeds ``max_bytes``.
        OSError: If the upload cannot be written to disk.
    """
    parent = redacts_dir.parent
    parent.mkdir(parents=True, exist_ok=True)
    uploads_root = parent / "_uploads"
    uploads_root.mkdir(parents=True, exist_ok=True)

    suffix = safe_upload_suffix(filename)
    # mkdtemp returns a directory only this process can enter (0o700 on POSIX;
    # on Windows the unpredictable name still prevents symlink prediction).
    req_dir = Path(tempfile.mkdtemp(prefix="up_", dir=str(uploads_root)))
    tmp_path = req_dir / f"upload{suffix}"
    try:
        # O_EXCL ensures we never follow an existing path.
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        # O_NOFOLLOW is POSIX-only; a no-op where absent (Windows).
        nofollow = getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(str(tmp_path), flags | nofollow, 0o600)
        try:
            file_obj = os.fdopen(fd, "wb", closefd=True)
        except BaseException:
            try:
                os.close(fd)
            except OSError:
                pass
            raise
        with file_obj as tmp:
            if max_bytes > 0:
                _copy_stream_with_cap(upload_stream, tmp, max_bytes)
            else:
                shutil.copyfileobj(upload_stream, tmp)
    except BaseException:
        # Clean up on any failure (413, disk full, client disconnect).
        shutil.rmtree(req_dir, ignore_errors=True)
        raise
    finally:
        # Always close the upload stream to avoid leaking SpooledTemporaryFile handles.
        try:
            upload_stream.close()
        except Exception:
            pass
    return req_dir, tmp_path


@asynccontextmanager
async def temporary_uploaded_file(file: UploadFile, redacts_dir: Path, max_bytes: int = 0):
    """Persist an upload for the duration of an async context, then clean up.

    Args:
        file: Incoming multipart upload.
        redacts_dir: Base redacts directory.
        max_bytes: Maximum upload size in bytes (0 = no limit).

    Yields:
        Path: Temporary uploaded file path.
    """
    req_dir, tmp_path = await run_in_threadpool(
        persist_upload_to_temp_file_sync,
        file.file, file.filename, redacts_dir, max_bytes,
    )
    try:
        yield tmp_path
    finally:
        shutil.rmtree(req_dir, ignore_errors=True)
