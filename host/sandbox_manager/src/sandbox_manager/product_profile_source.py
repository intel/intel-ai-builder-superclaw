"""Product Profile directory digest for the native backend's config source.

The native backend seeds its OpenCode config tree from the Product Profile the
committed ``RuntimeDeploymentSpec`` selected, and must prove the packaged tree is
the one the deployment was computed from. The orchestrator does the same thing
in ``sandbox/orchestrator/src/runtime-deployment.ts``.

``compute_product_profile_digest`` is one cross-language contract with three
implementations: this one, ServiceHub's
``servicehub.capability.product_profile_catalog.compute_product_profile_digest``,
and the TypeScript ``computeProductProfileDigest`` in
``shared/contracts/scripts/product-profile-digest.mjs`` (mirrored in the
orchestrator). SandboxManager and ServiceHub are separately packaged services, so
this is a byte-for-byte copy rather than an import; the golden vector in
``tests/unit/test_product_profile_source.py`` is the same constant the TypeScript
and ServiceHub suites assert, and is what keeps the three from drifting. Any
change here is a contract change in all three.
"""

from __future__ import annotations

import hashlib
from pathlib import Path
import stat

PRODUCT_PROFILE_IDS = frozenset({"lite", "standard", "pro"})

_IGNORED_DIRECTORY_NAMES = frozenset({".venv", "__pycache__"})
_IGNORED_FILE_SUFFIXES = (".pyc", ".pyo")


class ProductProfileDigestError(ValueError):
    """The Product Profile tree cannot be digested (unreadable or not a plain tree)."""


def compute_product_profile_digest(profile_root: Path) -> str:
    try:
        root_stat = profile_root.lstat()
    except OSError as exc:
        raise ProductProfileDigestError(
            f"cannot read Product Profile root: {profile_root}"
        ) from exc
    if profile_root.is_symlink() or not stat.S_ISDIR(root_stat.st_mode):
        raise ProductProfileDigestError(
            f"Product Profile root must be a regular directory: {profile_root}"
        )

    digest = hashlib.sha256()

    def visit(directory: Path, prefix: str) -> None:
        try:
            entries = sorted(directory.iterdir(), key=lambda path: path.name.encode("utf-8"))
        except OSError as exc:
            raise ProductProfileDigestError(
                f"cannot read Product Profile directory: {directory}"
            ) from exc
        for entry in entries:
            relative_path = f"{prefix}/{entry.name}" if prefix else entry.name
            try:
                entry_stat = entry.lstat()
            except OSError as exc:
                raise ProductProfileDigestError(
                    f"cannot inspect Product Profile entry: {relative_path}"
                ) from exc
            if entry.is_symlink():
                raise ProductProfileDigestError(
                    f"Product Profile digest rejects symlink: {relative_path}"
                )
            if (stat.S_ISDIR(entry_stat.st_mode) and entry.name in _IGNORED_DIRECTORY_NAMES) or (
                stat.S_ISREG(entry_stat.st_mode) and entry.name.endswith(_IGNORED_FILE_SUFFIXES)
            ):
                continue
            if stat.S_ISDIR(entry_stat.st_mode):
                digest.update(b"directory\0")
                digest.update(relative_path.encode("utf-8"))
                digest.update(b"\0")
                visit(entry, relative_path)
            elif stat.S_ISREG(entry_stat.st_mode):
                try:
                    content = entry.read_bytes()
                except OSError as exc:
                    raise ProductProfileDigestError(
                        f"cannot read Product Profile file: {relative_path}"
                    ) from exc
                digest.update(b"file\0")
                digest.update(relative_path.encode("utf-8"))
                digest.update(b"\0")
                digest.update(len(content).to_bytes(8, byteorder="big"))
                digest.update(content)
            else:
                raise ProductProfileDigestError(
                    "Product Profile digest supports only directories and regular files: "
                    f"{relative_path}"
                )

    visit(profile_root, "")
    return digest.hexdigest()
