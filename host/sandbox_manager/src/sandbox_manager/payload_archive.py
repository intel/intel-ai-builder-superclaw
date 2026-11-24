"""The native payload as the installer ships it: one archive and its sidecar.

The installer ships `native-backend.zip` plus `native-backend.json` (`{"version", "sha256", "size",
"codec"}`) rather than ~20,000 loose files, because the Setup UI updates taskbar progress once per
installed file and that freezes the taskbar. This module is the only reader of either.

With `"codec": "zstd"` every member, the manifest included, is a STORED zip entry whose bytes are
one zstd frame with the content size in its header. A sidecar without `codec` is the layout before
that, plain Deflate or stored members, and is still read so an installer built either way works.
Any other codec is refused.

Every start opens the archive just far enough to read its manifest; that is enough to tell whether
`payload/current` already holds this payload, which is the usual case and costs no extraction. Only
when it does not - the first start after an install or upgrade, or a damaged root - is the whole
archive hashed against the sidecar and its members written into the root in place, through the
same updater a source tree uses, manifest last.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
import errno
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import threading
from typing import Any, BinaryIO
import zipfile
import zlib

from loguru import logger
import zstandard

from .payload_failure import REINSTALL
from .payload_integrity import (
    PAYLOAD_MANIFEST_NAME,
    PayloadIntegrityError,
    VerifiedPayload,
    parse_payload_manifest,
)
from .payload_staging import (
    NativePayloadDestination,
    PayloadMembers,
    _extended_length,
    stage_payload_members,
)
from .startup_diagnostics import startup_stage

ARCHIVE_NAME = "native-backend.zip"
SIDECAR_NAME = "native-backend.json"
_MAX_MEMBERS = 200_000
_MAX_UNCOMPRESSED_BYTES = 8 << 30
# The manifest takes ~150 bytes per member, so a real one is a few MB.
_MAX_MANIFEST_BYTES = 64 << 20
_VERSION = re.compile(r"\d+(\.\d+)*")
_ZSTD_CODEC = "zstd"
# Level 19, the packer's, never uses a window above 8 MiB; this bounds each decoder's memory.
_MAX_WINDOW_BYTES = 8 << 20
# The longest zstd frame header: magic, descriptor, window, dictionary id and content size.
_FRAME_HEADER_BYTES = 18
_COPY_CHUNK = 1 << 20
# Every way a damaged or hostile archive has of failing inside zipfile/zlib/zstd.
_EXTRACTION_ERRORS = (
    RuntimeError,
    NotImplementedError,
    zlib.error,
    zstandard.ZstdError,
    EOFError,
    OSError,
    zipfile.BadZipFile,
)
# What a hash-verified archive can still raise while a member is read: bytes that changed on disk
# after hashing. OSError is left to the updater, which tells in-use and access-denied apart, and to
# the disk-full mapping below.
_ARCHIVE_DATA_ERRORS = (zipfile.BadZipFile, zlib.error, zstandard.ZstdError, EOFError)
# Members written at once. Creating, writing and closing ~20,000 mostly small files costs more
# than inflating them, and that cost overlaps across writers.
_EXTRACT_WORKERS = 8
_extracting = threading.Event()


@dataclass(frozen=True)
class InstalledPayloadArchive:
    """An installed archive whose sidecar parsed and whose in-archive manifest validated.

    Its bytes are not yet checked against `sha256`: that happens only if staging must extract.
    """

    archive: Path
    version: str
    sha256: str
    size: int
    # None when the sidecar has no `codec`: plain zip members, Deflate or stored.
    codec: str | None
    payload_version: str
    file_count: int
    content_fingerprint: str


InstalledSource = VerifiedPayload | InstalledPayloadArchive


def is_installed_archive(path: Path) -> bool:
    return path.name.casefold() == ARCHIVE_NAME and path.is_file()


def extracting() -> bool:
    """Whether this process is writing the installed archive into `payload/current` right now."""
    return _extracting.is_set()


def open_installed_archive(archive: Path) -> InstalledPayloadArchive:
    """Read the sidecar and the archive's manifest; refuse legibly on anything wrong."""
    sidecar = archive.with_name(SIDECAR_NAME)
    try:
        raw: Any = json.loads(sidecar.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise PayloadIntegrityError(
            f"installed payload sidecar is missing: {sidecar}. {REINSTALL}",
            reason="installed_payload_archive_invalid",
        ) from exc
    except (OSError, ValueError) as exc:
        raise PayloadIntegrityError(
            f"installed payload sidecar is unreadable: {sidecar}. {REINSTALL}",
            reason="installed_payload_archive_invalid",
        ) from exc
    if (
        not isinstance(raw, dict)
        or not isinstance(raw.get("version"), str)
        or not _VERSION.fullmatch(raw["version"])
        or not isinstance(raw.get("sha256"), str)
        or not re.fullmatch(r"[0-9a-f]{64}", raw["sha256"])
        or not isinstance(raw.get("size"), int)
        or isinstance(raw.get("size"), bool)
    ):
        raise PayloadIntegrityError(
            f"installed payload sidecar is malformed: {sidecar}. {REINSTALL}",
            reason="installed_payload_archive_invalid",
        )
    codec = raw.get("codec")
    if "codec" in raw and codec != _ZSTD_CODEC:
        raise PayloadIntegrityError(
            f"installed payload sidecar names a codec this build cannot read "
            f"({str(codec)[:32]!r}): {sidecar}. {REINSTALL}",
            reason="installed_payload_archive_invalid",
        )
    try:
        size = archive.stat().st_size
        if size != raw["size"]:
            raise PayloadIntegrityError(
                f"installed payload archive is {size} bytes, its sidecar says {raw['size']}: "
                f"{archive}. {REINSTALL}",
                reason="installed_payload_archive_invalid",
            )
        with zipfile.ZipFile(archive) as zf:
            manifest = parse_payload_manifest(_manifest_bytes(zf, codec))
    except _EXTRACTION_ERRORS as exc:
        raise _unreadable(archive, exc) from exc
    return InstalledPayloadArchive(
        archive=archive,
        version=raw["version"],
        sha256=raw["sha256"],
        size=size,
        codec=codec,
        payload_version=manifest.payload_version,
        file_count=manifest.file_count,
        content_fingerprint=manifest.content_fingerprint,
    )


def stage_installed_archive(
    source: InstalledPayloadArchive, path_set: NativePayloadDestination
) -> VerifiedPayload:
    """Bring `payload/current` up to the installed archive, extracting only if it differs.

    The archive is opened once. Its central directory and manifest are read to plan the update,
    and the whole file is hashed against the sidecar only after the in-use probe, so a refusal
    for a running backend costs no hash; no member is written before the hash matched.
    """

    @contextmanager
    def open_members() -> Iterator[PayloadMembers]:
        logger.info(
            "native-backend: extracting installed payload version={} files={}",
            source.version,
            source.file_count,
        )
        _extracting.set()
        try:
            try:
                stream = source.archive.open("rb")
            except OSError as exc:
                raise _unreadable(source.archive, exc) from exc
            with stream:
                try:
                    zf = zipfile.ZipFile(stream)
                    members = _archive_members(zf, source, lambda: _require_digest(stream, source))
                except _EXTRACTION_ERRORS as exc:
                    raise _unreadable(source.archive, exc) from exc
                with zf:
                    yield members
        except _ARCHIVE_DATA_ERRORS as exc:
            raise PayloadIntegrityError(
                f"installed payload archive could not be extracted: {exc}. The next start "
                "retries; if it keeps failing, repair or reinstall SuperClaw.",
                reason="installed_payload_archive_invalid",
            ) from exc
        except OSError as exc:
            if exc.errno != errno.ENOSPC:
                raise
            raise PayloadIntegrityError(
                "installed payload extraction stopped: not enough disk space under "
                "%LOCALAPPDATA%. Free some space; the next start retries.",
                reason="payload_disk_full",
            ) from exc
        finally:
            _extracting.clear()

    with startup_stage("stage_payload", source="installed_archive") as counts:
        return stage_payload_members(source, path_set, open_members, counts)


def _require_digest(stream: BinaryIO, source: InstalledPayloadArchive) -> None:
    stream.seek(0)
    try:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    except OSError as exc:
        raise _unreadable(source.archive, exc) from exc
    if digest != source.sha256:
        raise PayloadIntegrityError(
            f"installed payload archive does not match its sidecar sha256: "
            f"{source.archive}. {REINSTALL}",
            reason="installed_payload_archive_invalid",
        )


def _manifest_bytes(
    zf: zipfile.ZipFile, codec: str | None, frame_sizes: dict[zipfile.ZipInfo, int] | None = None
) -> bytes:
    """The manifest member's content; `frame_sizes` are zstd frame sizes already read."""
    try:
        info = zf.getinfo(PAYLOAD_MANIFEST_NAME)
    except KeyError as exc:
        raise _refused("manifest_missing") from exc
    if info.file_size > _MAX_MANIFEST_BYTES:
        raise _refused("manifest_too_large")
    if codec != _ZSTD_CODEC:
        return zf.read(info)
    size = frame_sizes[info] if frame_sizes is not None else _frame_size(zf, info)
    if size > _MAX_MANIFEST_BYTES:
        raise _refused("manifest_too_large")
    # allow_extra_data=False: junk or a second frame after the first is an error, not ignored.
    return _decompressor().decompress(zf.read(info), allow_extra_data=False)


def _decompressor() -> zstandard.ZstdDecompressor:
    # One per use: a decompressor may not run two operations at once.
    return zstandard.ZstdDecompressor(max_window_size=_MAX_WINDOW_BYTES)


def _write_frame(reader: zipfile.ZipExtFile, writer: BinaryIO, size: int, name: str) -> None:
    """Decode the one frame `reader` holds into `writer`, never writing more than `size` bytes.

    The member must be exactly one complete frame: input after its end (junk, or a second frame,
    even an empty one) and a frame cut short both fail.
    """
    frame = _decompressor().decompressobj()
    written = 0
    # A chunk of input after the frame's end makes the decoder raise ZstdError.
    while chunk := reader.read(_COPY_CHUNK):
        decoded = frame.decompress(chunk)
        writer.write(decoded[: size - written])
        written += len(decoded)
        if written > size:
            break
    if written != size or not frame.eof or frame.unused_data:
        raise zipfile.BadZipFile(
            f"{name} is not exactly one complete frame that decodes to the {size} bytes "
            "its header says"
        )


def _frame_size(zf: zipfile.ZipFile, info: zipfile.ZipInfo) -> int:
    """The content size in the header of the zstd frame a member holds; refused unless usable."""
    if info.compress_type != zipfile.ZIP_STORED:
        raise _refused("member_not_stored")
    with zf.open(info) as reader:
        header = reader.read(_FRAME_HEADER_BYTES)
    try:
        size = zstandard.frame_content_size(header)
        window = zstandard.get_frame_parameters(header).window_size
    except zstandard.ZstdError as exc:
        raise _refused("member_not_a_zstd_frame") from exc
    if size < 0:
        raise _refused("member_size_not_in_frame")
    if window > _MAX_WINDOW_BYTES:
        raise _refused("member_window_too_large")
    return size


def _refused(reason: str) -> PayloadIntegrityError:
    return PayloadIntegrityError(
        f"installed payload archive refused ({reason}). {REINSTALL}",
        reason="installed_payload_archive_invalid",
    )


def _unreadable(archive: Path, error: BaseException) -> PayloadIntegrityError:
    return PayloadIntegrityError(
        f"installed payload archive is unreadable: {archive} ({error}). {REINSTALL}",
        reason="installed_payload_archive_invalid",
    )


def _archive_members(
    zf: zipfile.ZipFile, source: InstalledPayloadArchive, before_writing: Callable[[], None]
) -> PayloadMembers:
    """The archive's members, refused unless they are exactly the manifest's roster.

    Member names are never used as paths: only members that match the manifest's roster are
    written, under the manifest's own spelling, which `payload_integrity` validates. A zstd
    member's size is the one its frame header states, and writing it fails unless it decodes to
    exactly that.
    """
    infos = zf.infolist()
    if len(infos) > _MAX_MEMBERS:
        raise _refused("too_many_members")
    decode = source.codec == _ZSTD_CODEC
    sizes = {
        info: _frame_size(zf, info) if decode else info.file_size
        for info in infos
        if not info.is_dir()
    }
    if sum(sizes.values()) > _MAX_UNCOMPRESSED_BYTES:
        raise _refused("too_large")
    manifest_bytes = _manifest_bytes(zf, source.codec, sizes if decode else None)
    manifest = parse_payload_manifest(manifest_bytes)
    if manifest.content_fingerprint != source.content_fingerprint:
        raise PayloadIntegrityError(
            "installed payload archive changed since it was opened",
            reason="installed_payload_archive_invalid",
        )
    by_key: dict[str, zipfile.ZipInfo] = {}
    for info in infos:
        if info.is_dir() or info.filename == PAYLOAD_MANIFEST_NAME:
            continue
        key = info.filename.casefold()
        if key in by_key:
            raise PayloadIntegrityError(
                f"installed payload archive has case-colliding members: {info.filename}. "
                f"{REINSTALL}",
                reason="payload_case_collision",
            )
        by_key[key] = info
    roster = manifest.roster
    if by_key.keys() != roster.keys() or any(
        sizes[by_key[key]] != size for key, (_, size, _) in roster.items()
    ):
        raise PayloadIntegrityError(
            f"installed payload archive members do not match its manifest: {source.archive}. "
            f"{REINSTALL}",
            reason="installed_payload_archive_invalid",
        )
    # Written under the manifest's spelling, which is what `verify_payload` checks afterwards.
    files = sorted(path for path, _, _ in roster.values())
    directories = sorted(
        {
            str(parent)
            for path in files
            for parent in PurePosixPath(path).parents
            if str(parent) != "."
        },
        key=lambda path: (path.count("/"), path),
    )

    # Every read of a member seeks and reads the shared archive handle under ZipFile's own lock,
    # but opening and closing a member update its reader count without one.
    opening = threading.Lock()

    def copy(relative: str, target: Path) -> None:
        member = by_key[relative.casefold()]
        with opening:
            reader = zf.open(member)
        try:
            with open(_extended_length(target), "xb") as writer:
                if decode:
                    _write_frame(reader, writer, sizes[member], member.filename)
                else:
                    shutil.copyfileobj(reader, writer, _COPY_CHUNK)
        finally:
            with opening:
                reader.close()

    return PayloadMembers(
        roster=roster,
        directories=directories,
        files=files,
        copy=copy,
        manifest=manifest_bytes,
        workers=_EXTRACT_WORKERS,
        before_writing=before_writing,
    )
