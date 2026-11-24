"""Prepare the file_tool tier's writable Python without changing the payload."""

from __future__ import annotations

import json
import os
import stat
import subprocess
import uuid
from pathlib import Path

from loguru import logger

from .runtime_global_config import _require_plain_destination

#: Same convention as ``broker_client.cache_quarantine``: a sibling of the tree it
#: replaces, outside the subtree startup otherwise walks.
_QUARANTINE_DIRECTORY = ".cache-quarantine"


_CREATE_ENVIRONMENT = """
import pathlib
import shutil
import sys
import venv

target = pathlib.Path(sys.argv[1])
packages = pathlib.Path(sys.argv[2])
pth_content = sys.argv[3]
venv.EnvBuilder(with_pip=False).create(target)
scripts = target / 'Scripts'
shutil.copyfile(scripts / 'python.exe', scripts / 'python3.exe')
site_packages = target / 'Lib' / 'site-packages'
site_packages.mkdir(parents=True, exist_ok=True)
(site_packages / 'superclaw-packages.pth').write_text(pth_content, encoding='ascii')
sys.path.insert(0, str(packages))
from pip._vendor.distlib.scripts import ScriptMaker
maker = ScriptMaker(None, str(scripts))
maker.executable = str(scripts / 'python.exe')
maker.variants = {''}
maker.make('pip = pip._internal.cli.main:main')
"""


def _pth_content(site_packages: Path, packages: Path) -> str:
    """The venv's own site-packages is where task `pip install`s land, and it is
    already in `sys.path` by the time a `.pth` import line runs. Appending the
    preinstalled `packages` dir after it would let a task-installed package shadow a
    same-named preinstalled one for every later import in the tier. Inserting it just
    before the venv's site-packages instead gives the trusted preinstalled packages
    priority, so only a genuinely new package name is added, never a replacement.
    """
    return (
        "import sys; _p = " + ascii(str(site_packages)) + "; "
        "sys.path.insert(sys.path.index(_p) if _p in sys.path else len(sys.path), "
        + ascii(str(packages)) + ")\n"
    )


def _redirected_ancestor(root: Path, path: Path) -> Path | None:
    """The first reparse point among ``path``'s ancestors (``root`` up to but excluding
    ``path`` itself), or ``None``.

    Deliberately excludes ``path``'s own final component: a plain rename of ``path`` never
    follows a reparse point *at* ``path`` (that is the redirected-environment case this
    module already handles by quarantining the link entry itself). An ancestor is different -
    Windows transparently follows an intermediate reparse point while resolving the rest of
    the path, so ``os.rename(path, ...)`` with a redirected ancestor would silently operate on
    whatever is on the other side of that link, not on anything under ``root``.
    """
    current = root
    for component in ("", *path.relative_to(root).parts[:-1]):
        if component:
            current = current / component
        try:
            metadata = current.lstat()
        except FileNotFoundError:
            return None
        if stat.S_ISLNK(metadata.st_mode) or (
            getattr(metadata, "st_file_attributes", 0)
            & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
        ):
            return current
    return None


def _quarantine(data_dir: Path, target: Path) -> bool:
    """Renames ``target`` out of the way so a fresh venv can be created in its place.

    ``target`` lives in the file_tool tier's own writable home, so the tier itself can
    turn it into a reparse point or a hard-linked launcher without any privilege (that is
    exactly what ``_require_plain_destination`` and the hard-link check below refuse to
    write through). Refusing the write is right, but the tier controls this state, so
    one such command must not be allowed to fail every later start the same way: move
    the bad tree aside - a plain rename, never following a link - and let the caller
    retry a clean creation. Best effort: a tree that cannot be renamed (e.g. a sharing
    violation), or whose path crosses a redirected ancestor rather than being the link
    itself, is left in place and reported, not renamed through.
    """
    try:
        if _redirected_ancestor(data_dir, target) is not None:
            logger.warning(
                "native-backend: task Python phase=prepare event=quarantine_skipped "
                "reason=redirected_ancestor"
            )
            return False
        quarantine_root = data_dir / _QUARANTINE_DIRECTORY
        if _redirected_ancestor(data_dir, quarantine_root) is not None:
            logger.warning(
                "native-backend: task Python phase=prepare event=quarantine_skipped "
                "reason=redirected_quarantine_root"
            )
            return False
        quarantine_root.mkdir(parents=True, exist_ok=True)
        destination = quarantine_root / f"python-{uuid.uuid4().hex}"
        os.rename(target, destination)
    except OSError as exc:
        # Covers both the rename itself and the ancestor lookups above: a `PermissionError`
        # while inspecting a tier-owned ancestor is the same class of failure as a failed
        # rename, and must not escape to abort Runtime start either.
        logger.warning(
            "native-backend: task Python phase=prepare event=quarantine_failed reason={}",
            type(exc).__name__,
        )
        return False
    logger.warning("native-backend: task Python phase=prepare event=quarantined path={}", target)
    return True


#: Caught around ``_prepare_or_reuse``: a reparse point / hard link refusal (``RuntimeError``),
#: a creation that failed or timed out, or any other filesystem error on the *destination*
#: side (``target`` is tier-writable, so a directory where a file is expected, a permission
#: error, and the like are all tier-controlled state, not payload integrity problems).
_RECOVERABLE_PREPARE_ERRORS = (RuntimeError, subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError)


def prepare_runtime_python(*, payload_root: Path, data_dir: Path) -> Path | None:
    """Prepares (or reuses) the task venv; never raises for tier-controlled failures.

    A missing or broken *payload* (the trusted, read-only side) is a real integrity
    problem and still raises - that check happens above, before anything in
    ``_RECOVERABLE_PREPARE_ERRORS`` can fire. Anything on the *destination* side - a reparse
    point or hard-linked launcher where the venv should go, a creation that fails or times
    out, or any other filesystem error reading or writing under ``target`` - is quarantined
    and retried once; if that still does not produce a clean venv, this logs the reason
    (including any captured stderr) and returns ``None`` so Runtime start continues without a
    task venv rather than failing closed.
    """
    runtime = payload_root / "py" / "runtime"
    interpreter = runtime / "python.exe"
    packages = payload_root / "py" / "agent-python-venv" / "Lib" / "site-packages"
    if not (interpreter.is_file() and (runtime / "BUILD").is_file() and (packages / "pip").is_dir()):
        raise RuntimeError("The payload is missing the task Python runtime or pip")

    target = data_dir / "file_tool" / "home" / ".local" / "python"
    try:
        return _prepare_or_reuse(
            target=target, runtime=runtime, interpreter=interpreter, packages=packages, data_dir=data_dir
        )
    except _RECOVERABLE_PREPARE_ERRORS as exc:
        stderr = getattr(exc, "stderr", None) or ""
        logger.warning(
            "native-backend: task Python phase=prepare event=creation_failed reason={} stderr={}",
            type(exc).__name__,
            stderr[-4000:],
        )
        if not _quarantine(data_dir, target):
            return None

    try:
        return _prepare_or_reuse(
            target=target, runtime=runtime, interpreter=interpreter, packages=packages, data_dir=data_dir
        )
    except _RECOVERABLE_PREPARE_ERRORS as exc:
        stderr = getattr(exc, "stderr", None) or ""
        logger.warning(
            "native-backend: task Python phase=prepare event=skipped reason={} stderr={}",
            type(exc).__name__,
            stderr[-4000:],
        )
        return None


def _prepare_or_reuse(*, target: Path, runtime: Path, interpreter: Path, packages: Path, data_dir: Path) -> Path:
    marker = target / ".superclaw-python.json"
    package_path = target / "Lib" / "site-packages" / "superclaw-packages.pth"
    expected = {
        "schema_version": 3,
        "runtime": str(runtime),
        "build": (runtime / "BUILD").read_text(encoding="ascii").strip(),
    }
    destinations = (
        marker,
        target / "pyvenv.cfg",
        package_path,
        *(target / "Scripts" / name for name in (
            "python.exe", "python3.exe", "pythonw.exe", "pip.exe",
            "activate", "activate.bat", "Activate.ps1", "deactivate.bat",
        )),
    )
    for destination in destinations:
        _require_plain_destination(data_dir, destination)
        if destination.is_file() and destination.stat().st_nlink > 1:
            raise RuntimeError(f"Task Python destination is a hard link: {destination}")
    if marker.is_file():
        try:
            installed = json.loads(marker.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            installed = None
        if installed == expected and all(
            path.is_file()
            for path in (
                target / "Scripts" / "python.exe",
                target / "Scripts" / "python3.exe",
                target / "Scripts" / "pip.exe",
                target / "pyvenv.cfg",
                package_path,
            )
        ):
            logger.info("native-backend: task Python phase=prepare event=reused")
            return target

    target.mkdir(parents=True, exist_ok=True)
    marker.unlink(missing_ok=True)
    subprocess.run(
        [
            str(interpreter), "-I", "-B", "-c", _CREATE_ENVIRONMENT, str(target), str(packages),
            _pth_content(target / "Lib" / "site-packages", packages),
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=60,
        cwd=runtime,
    )
    marker.write_text(json.dumps(expected, sort_keys=True), encoding="utf-8")
    logger.info("native-backend: task Python phase=prepare event=created")
    return target