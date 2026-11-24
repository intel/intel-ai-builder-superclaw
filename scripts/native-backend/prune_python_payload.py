#!/usr/bin/env python3
"""Remove what the payload's Python environments never load at runtime.

Runs against a freshly staged ``py`` tree, before signing and before the payload
manifest is written, so the manifest rosters exactly the pruned bytes.
"""

from __future__ import annotations

import argparse
import os
import re
import shutil
import stat
import sys
from collections.abc import Iterator
from pathlib import Path

ENVIRONMENTS = (
    "agent-python-venv",
    "readers-venv",
    "hybrid-dr-venv",
    "classifier-venv",
    "runtime",
)
# Library self-tests. `testing` / `_testing` are deliberately absent: numpy, pandas
# and scikit-learn import those modules from non-test code.
TEST_DIR_NAMES = frozenset({"tests", "test"})
PACKAGING_TOOLS = re.compile(
    r"(pip|setuptools|wheel|pkg_resources|_distutils_hack)(-[^-]+\.dist-info)?"
    r"|distutils-precedence\.pth",
    re.IGNORECASE,
)
# Agents are told to run `python3 -m pip install`, which resolves to this environment.
KEEPS_PACKAGING_TOOLS = frozenset({"agent-python-venv"})
# Type stubs, C/C++/Cython sources and headers, and import libraries: only a type
# checker or a compiler reads them, and nothing can compile against an environment's
# interpreter, whose sysconfig include directory (`Scripts\Include`) does not exist.
BUILD_ONLY_SUFFIXES = frozenset(
    {".pyi", ".c", ".cc", ".cpp", ".h", ".hpp", ".pyx", ".pxd", ".pxi", ".lib", ".a"}
)
# The runtime's headers, import libraries and Tcl/Tk script library. Tcl looks for its
# library beside the running interpreter's prefix, which for every environment is its
# Scripts directory, so only the bare runtime interpreter, which no role runs, finds it.
RUNTIME_BUILD_DIRS = ("include", "libs", "tcl")
# Installer bookkeeping inside a distribution's dist-info. importlib.metadata reads
# METADATA and entry_points.txt, never these; RECORD still lists them, and pip
# tolerates a missing RECORD entry on uninstall.
INERT_DIST_INFO = frozenset({"INSTALLER", "REQUESTED", "WHEEL"})
# OpenCV's FFmpeg plugin, which cv2 loads only to open a video. The readers' OCR decodes
# still images and rendered PDF pages, and no other role-run environment ships cv2.
VIDEO_IO_PLUGIN = "opencv_videoio_ffmpeg*.dll"
DROPS_VIDEO_IO = frozenset({"readers-venv"})


def _is_link(path: Path) -> bool:
    # is_symlink() is False for an NTFS junction, which is still a reparse point.
    attributes = getattr(path.lstat(), "st_file_attributes", 0)
    return path.is_symlink() or bool(attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT)


def _walk(root: Path) -> Iterator[tuple[Path, list[str], list[str]]]:
    """Top-down walk that never enters a symlink or junction."""
    for directory, subdirs, names in os.walk(root):
        here = Path(directory)
        subdirs[:] = [name for name in subdirs if not _is_link(here / name)]
        yield here, subdirs, names


def _is_timestamp_pyc(path: Path) -> bool:
    # A timestamp-checked pyc records its source's mtime, and the payload archive gives
    # every entry one fixed timestamp (New-NativeBackendArchive.ps1), so once
    # extracted it never validates again; the hash-checked kinds (flags 1 and 3) do.
    if path.suffix != ".pyc" or path.parent.name != "__pycache__":
        return False
    with path.open("rb") as handle:
        header = handle.read(8)
    return len(header) == 8 and int.from_bytes(header[4:8], "little") == 0


def _plan_tree(
    root: Path, *, keep_packaging_tools: bool, site_packages: bool
) -> list[Path]:
    """The outermost paths to remove under ``root``, package rules included if asked."""
    doomed = [
        entry
        for entry in sorted(root.iterdir())
        if site_packages
        and not keep_packaging_tools
        and PACKAGING_TOOLS.fullmatch(entry.name)
    ]
    skipped = set(doomed)
    for directory, subdirs, names in _walk(root):
        if directory == root:
            subdirs[:] = [name for name in subdirs if directory / name not in skipped]
        elif site_packages:
            for name in [n for n in subdirs if n in TEST_DIR_NAMES]:
                subdirs.remove(name)
                doomed.append(directory / name)
        dist_info = (
            site_packages
            and directory.parent == root
            and directory.name.endswith(".dist-info")
        )
        for name in names:
            path = directory / name
            if path in skipped:
                continue
            build_only = site_packages and path.suffix.lower() in BUILD_ONLY_SUFFIXES
            inert = dist_info and name in INERT_DIST_INFO
            if build_only or inert or _is_timestamp_pyc(path):
                doomed.append(path)
    return doomed


def plan_python_payload(py_root: Path) -> dict[str, list[Path]]:
    """What pruning would remove from every known environment; removes nothing."""
    plan: dict[str, list[Path]] = {}
    for name in ENVIRONMENTS:
        environment = py_root / name
        site_packages = environment / "Lib" / "site-packages"
        if not site_packages.is_dir():
            raise FileNotFoundError(
                f"site-packages missing for {name}: {site_packages}"
            )
        # The walks below only refuse links beneath their roots, so the roots and the
        # directories above them are checked here.
        for level in (py_root, environment, environment / "Lib", site_packages):
            if _is_link(level):
                raise OSError(f"refusing to prune through a link: {level}")
        keep_tools = name in KEEPS_PACKAGING_TOOLS
        doomed = _plan_tree(
            site_packages, keep_packaging_tools=keep_tools, site_packages=True
        )
        cv2 = site_packages / "cv2"
        if name in DROPS_VIDEO_IO and cv2.is_dir() and not _is_link(cv2):
            doomed += sorted(cv2.glob(VIDEO_IO_PLUGIN))
        if name == "runtime":
            doomed += [
                environment / directory
                for directory in RUNTIME_BUILD_DIRS
                if (environment / directory).exists()
            ]
            for entry in sorted((environment / "Lib").iterdir()):
                if entry == site_packages:
                    continue
                if entry.is_dir() and not _is_link(entry):
                    doomed += _plan_tree(
                        entry, keep_packaging_tools=True, site_packages=False
                    )
        plan[name] = doomed
    return plan


def _measure(path: Path) -> tuple[int, int]:
    if path.is_file():
        files = [path]
    else:
        files = [here / name for here, _, names in _walk(path) for name in names]
    return len(files), sum(p.lstat().st_size for p in files)


def _remove(path: Path) -> tuple[int, int]:
    if _is_link(path):
        raise OSError(f"refusing to remove a link: {path}")
    removed = _measure(path)
    if path.is_dir():
        shutil.rmtree(path)
    else:
        path.unlink()
    return removed


def _remove_all(paths: list[Path]) -> tuple[int, int]:
    files = size = 0
    for path in paths:
        removed = _remove(path)
        files, size = files + removed[0], size + removed[1]
    return files, size


def prune_python_payload(py_root: Path) -> dict[str, tuple[int, int]]:
    """Prune every known environment under ``py_root``; return removals by name."""
    return {
        name: _remove_all(doomed)
        for name, doomed in plan_python_payload(py_root).items()
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("py_root", type=Path)
    args = parser.parse_args(argv)
    try:
        report = prune_python_payload(args.py_root)
    except OSError as exc:
        print(f"python payload prune failed: {exc}", file=sys.stderr)
        return 1
    for name, (files, size) in report.items():
        print(f"pruned {name}: {files} files, {size / (1024 * 1024):.1f} MiB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
