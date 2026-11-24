"""Write native-backend.zip from an ordered entry list, one zstd frame per member.

New-NativeBackendArchive.ps1 walks the payload, orders the entries, leaves the broker out and
rewrites the manifest; this only compresses and writes. Every member, the manifest included, is a
STORED zip entry whose bytes are exactly one zstd frame with the content size in its header, which
is the layout Sandbox Manager's payload_archive.py reads for `"codec": "zstd"`. A member zstd
cannot shrink is still written as a frame.

Members are compressed on a process pool, largest first, and written in the given order with one
fixed timestamp, so the same tree packed with the same zstandard gives the same bytes.

    python pack_native_backend_archive.py --root <payload> --entries <names.txt>
        --manifest <manifest.json> --output <native-backend.zip>
"""

from __future__ import annotations

import argparse
from concurrent.futures import ProcessPoolExecutor
import os
from pathlib import Path
import sys
import zipfile

import zstandard

_LEVEL = 19
_MANIFEST_NAME = "manifest.json"
# payload_archive._MAX_WINDOW_BYTES: the reader refuses any frame that needs more.
_MAX_WINDOW_BYTES = 8 << 20
_FRAME_HEADER_BYTES = 18
_TIMESTAMP = (2000, 1, 1, 0, 0, 0)
_WORKERS = 8


class _PackError(Exception):
    pass


def _compress(data: bytes) -> bytes:
    return zstandard.ZstdCompressor(
        level=_LEVEL, write_content_size=True, write_checksum=False, write_dict_id=False
    ).compress(data)


def _compress_file(path: str) -> bytes:
    return _compress(Path(path).read_bytes())


def _readable_frame(name: str, frame: bytes) -> bytes:
    window = zstandard.get_frame_parameters(frame[:_FRAME_HEADER_BYTES]).window_size
    if window > _MAX_WINDOW_BYTES:
        raise _PackError(f"{name}: frame window {window} exceeds the reader's {_MAX_WINDOW_BYTES}")
    return frame


def _pack(root: Path, names: list[str], manifest: bytes, output: Path, workers: int) -> None:
    """Write `names` (archive paths under `root`) to `output`; `manifest` replaces the tree's own.

    Members are compressed largest first but written in `names` order, so a finished member
    waits in `pending` until its turn: peak memory is about the whole compressed archive
    (~440 MiB for the full payload) plus the files in flight. Fine on the build runner.
    """
    if len(set(names)) != len(names):
        raise _PackError("duplicate entry names")
    if _MANIFEST_NAME not in names:
        raise _PackError(f"the entry list does not name {_MANIFEST_NAME}")
    sources = {name: root / name for name in names if name != _MANIFEST_NAME}
    by_size = sorted(sources, key=lambda name: sources[name].stat().st_size, reverse=True)
    with ProcessPoolExecutor(max_workers=workers) as pool:
        pending = {name: pool.submit(_compress_file, str(sources[name])) for name in by_size}
        with zipfile.ZipFile(output, "x", zipfile.ZIP_STORED) as archive:
            for name in names:
                frame = _compress(manifest) if name == _MANIFEST_NAME else pending.pop(name).result()
                info = zipfile.ZipInfo(name, _TIMESTAMP)
                # Otherwise zipfile records the packing host's OS and file mode, and the bytes
                # differ per machine.
                info.create_system = 0
                info.external_attr = 0
                archive.writestr(info, _readable_frame(name, frame), zipfile.ZIP_STORED)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--entries", type=Path, required=True, help="UTF-8, one archive path per line")
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--workers", type=int, default=min(_WORKERS, os.cpu_count() or 1))
    args = parser.parse_args(argv)
    lines = args.entries.read_text(encoding="utf-8").split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    names = [line.rstrip("\r") for line in lines]
    try:
        _pack(args.root, names, args.manifest.read_bytes(), args.output, args.workers)
    except (_PackError, OSError) as exc:
        print(f"native backend archive pack failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
