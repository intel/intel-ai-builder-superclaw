"""Regenerate ``protection_service/model_manifest.json`` from the model directories.

The privacy models are hosted as one zip per model (``<model>.zip``, files under
a top-level ``<model>/`` folder). The manifest pins each zip's byte size and
sha256, and every file inside: its path relative to the model directory, its
byte size and its sha256. The downloader enforces all of it, so the manifest
must describe exactly the bytes that are hosted. Run this after changing
anything under ``models/`` and commit the result together with the model files:

    uv run python scripts/gen_model_manifest.py --zip-dir OUT   # build OUT/<model>.zip, pin them
    uv run python scripts/gen_model_manifest.py                 # rewrite files, keep the zip pins
    uv run python scripts/gen_model_manifest.py --check         # exit 1 when it drifted

``--zip-dir`` keeps a ``<model>.zip`` already in OUT instead of rebuilding it,
so a zip that is already hosted can be pinned as it is. Upload the zips in OUT.

The model weights are git-LFS objects. Generating needs their real content
(``git lfs pull``); ``--check`` also works on a pointer-only checkout, because
an LFS pointer records the sha256 and size of the content it stands for.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
import zipfile
from pathlib import Path

DATA_PROTECTION_DIR = Path(__file__).resolve().parents[1]
DEFAULT_MODELS_DIR = DATA_PROTECTION_DIR / "models"
DEFAULT_MANIFEST = DATA_PROTECTION_DIR / "protection_service" / "model_manifest.json"
MODEL_NAMES = ("pplx-pii-masking-ov-int8",)

_LFS_POINTER_PREFIX = b"version https://git-lfs.github.com/spec/v1"
_LFS_POINTER_MAX_BYTES = 1024
_CHUNK_BYTES = 1 << 20


def read_lfs_pointer(path: Path) -> tuple[int, str] | None:
    """Return ``(size, sha256)`` recorded by an LFS pointer file, else ``None``."""
    if path.stat().st_size > _LFS_POINTER_MAX_BYTES:
        return None
    raw = path.read_bytes()
    if not raw.startswith(_LFS_POINTER_PREFIX):
        return None
    fields = dict(
        line.split(" ", 1) for line in raw.decode("ascii").splitlines() if " " in line
    )
    oid = fields.get("oid", "")
    if not oid.startswith("sha256:") or "size" not in fields:
        return None
    return int(fields["size"]), oid[len("sha256:"):]


def describe_file(path: Path) -> tuple[int, str, bool]:
    """Return ``(size, sha256, is_lfs_pointer)`` for one model file."""
    pointer = read_lfs_pointer(path)
    if pointer is not None:
        return pointer[0], pointer[1], True
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(_CHUNK_BYTES), b""):
            digest.update(chunk)
    return path.stat().st_size, digest.hexdigest(), False


def revision_of(files: list[dict]) -> str:
    """Content revision of one model: a digest over its pinned file list."""
    digest = hashlib.sha256()
    for entry in sorted(files, key=lambda e: e["path"]):
        digest.update(f"{entry['path']}\0{entry['size']}\0{entry['sha256']}\n".encode())
    return digest.hexdigest()[:16]


def build_archive(model_dir: Path, name: str, out: Path) -> None:
    """Zip ``model_dir`` to ``out`` with its files under ``<name>/``."""
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(p for p in model_dir.rglob("*") if p.is_file()):
            info = zipfile.ZipInfo(
                f"{name}/{path.relative_to(model_dir).as_posix()}", date_time=(1980, 1, 1, 0, 0, 0)
            )
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            with open(path, "rb") as src, zf.open(info, "w") as dst:
                shutil.copyfileobj(src, dst, _CHUNK_BYTES)


def archive_mismatch(zip_path: Path, name: str, files: list[dict]) -> str | None:
    """Why ``zip_path`` does not hold exactly ``files`` under ``<name>/``, else ``None``."""
    try:
        with zipfile.ZipFile(zip_path) as zf:
            for entry in files:
                member = f"{name}/{entry['path']}"
                try:
                    info = zf.getinfo(member)
                except KeyError:
                    return f"has no {member}"
                digest = hashlib.sha256()
                size = 0
                with zf.open(info) as src:
                    for chunk in iter(lambda: src.read(_CHUNK_BYTES), b""):
                        digest.update(chunk)
                        size += len(chunk)
                if size != entry["size"] or digest.hexdigest() != entry["sha256"]:
                    return f"{member} differs from the file under models/"
    except (zipfile.BadZipFile, OSError) as exc:
        return f"cannot be read: {exc}"
    return None


def build_manifest(
    models_dir: Path,
    names: tuple[str, ...] = MODEL_NAMES,
    *,
    archives: dict[str, dict],
    allow_pointers: bool = False,
) -> dict:
    """Describe ``models_dir/<name>/**`` for each model name.

    ``archives`` maps each name to the ``{"size", "sha256"}`` of its zip.
    """
    models: dict[str, dict] = {}
    for name in names:
        root = models_dir / name
        if not root.is_dir():
            raise FileNotFoundError(f"model directory {root} does not exist")
        files = []
        for path in sorted(p for p in root.rglob("*") if p.is_file()):
            size, sha256, is_pointer = describe_file(path)
            if is_pointer and not allow_pointers:
                raise RuntimeError(
                    f"{path} is a git-LFS pointer; run 'git lfs pull' before "
                    "regenerating the manifest"
                )
            files.append(
                {"path": path.relative_to(root).as_posix(), "size": size, "sha256": sha256}
            )
        models[name] = {"revision": revision_of(files), "archive": archives[name], "files": files}
    return {"schema": 2, "models": models}


def render(manifest: dict) -> str:
    return json.dumps(manifest, indent=2, sort_keys=True) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--models-dir", type=Path, default=DEFAULT_MODELS_DIR)
    parser.add_argument("--out", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument(
        "--zip-dir",
        type=Path,
        help="directory of <model>.zip: pin the zips in it, building any that is missing",
    )
    parser.add_argument(
        "--check", action="store_true", help="compare instead of writing; exit 1 on drift"
    )
    args = parser.parse_args(argv)

    current = json.loads(args.out.read_text(encoding="utf-8")) if args.out.is_file() else {}
    archives: dict[str, dict] = {}
    reused: list[str] = []
    for name in MODEL_NAMES:
        if args.zip_dir is not None:
            zip_path = args.zip_dir / f"{name}.zip"
            if not zip_path.is_file():
                if args.check:
                    print(f"{zip_path} does not exist", file=sys.stderr)
                    return 1
                args.zip_dir.mkdir(parents=True, exist_ok=True)
                build_archive(args.models_dir / name, name, zip_path)
            else:
                reused.append(name)
            size, sha256, _ = describe_file(zip_path)
            archives[name] = {"size": size, "sha256": sha256}
        elif (pinned := current.get("models", {}).get(name, {}).get("archive")) is not None:
            archives[name] = pinned
        else:
            print(f"no zip is pinned for {name}; pass --zip-dir", file=sys.stderr)
            return 2

    manifest = build_manifest(args.models_dir, archives=archives, allow_pointers=args.check)
    # A zip that already exists, or a pin kept from the committed manifest, describes older
    # bytes if the files changed since. Pinning it would make a manifest the downloader rejects
    # while unpacking, so refuse instead.
    for name in MODEL_NAMES:
        files = manifest["models"][name]["files"]
        if name in reused:
            problem = archive_mismatch(args.zip_dir / f"{name}.zip", name, files)
            if problem:
                print(f"{args.zip_dir / f'{name}.zip'} {problem}; delete it to rebuild", file=sys.stderr)
                return 2
        elif args.zip_dir is None and files != current.get("models", {}).get(name, {}).get("files"):
            print(
                f"the files of {name} changed, so its pinned zip is stale; pass --zip-dir",
                file=sys.stderr,
            )
            return 2
    text = render(manifest)
    if args.check:
        if args.out.read_text(encoding="utf-8") != text:
            print(f"{args.out} does not match {args.models_dir}; regenerate it", file=sys.stderr)
            return 1
        print(f"{args.out} matches {args.models_dir}")
        return 0
    args.out.write_text(text, encoding="utf-8", newline="\n")
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
