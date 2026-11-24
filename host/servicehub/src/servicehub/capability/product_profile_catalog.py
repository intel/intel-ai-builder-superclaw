from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
from pathlib import Path
import stat
import sys
from typing import Literal, cast

from contracts.product_profile_descriptor import ProductProfileDescriptor
from pydantic import ValidationError

ProductProfileId = Literal["lite", "standard", "pro"]
_PRODUCT_PROFILE_IDS = frozenset({"lite", "standard", "pro"})
_IGNORED_DIRECTORY_NAMES = frozenset({".venv", "__pycache__"})
_IGNORED_FILE_SUFFIXES = (".pyc", ".pyo")


class ProductProfileLoadError(ValueError):
    pass


class ProductProfileTransientLoadError(ProductProfileLoadError):
    pass


def _profile_io_error(message: str, error: OSError) -> ProductProfileLoadError:
    if isinstance(error, (FileNotFoundError, NotADirectoryError)):
        return ProductProfileLoadError(message)
    return ProductProfileTransientLoadError(message)


@dataclass(frozen=True)
class ProductProfilesLocator:
    profiles_root: Path

    @classmethod
    def default(cls) -> ProductProfilesLocator:
        if getattr(sys, "frozen", False):
            root = Path(sys.executable).resolve().parent / "agent-config" / "profiles"
        else:
            root = Path(__file__).resolve().parents[5] / "sandbox" / "agent_config" / "profiles"
        return cls(root)


@dataclass(frozen=True)
class LoadedProductProfile:
    product_profile_id: ProductProfileId
    artifact_digest: str
    descriptor: ProductProfileDescriptor
    directory: Path


def compute_product_profile_digest(profile_root: Path) -> str:
    try:
        root_stat = profile_root.lstat()
    except OSError as exc:
        raise _profile_io_error(f"cannot read Product Profile root: {profile_root}", exc) from exc
    if profile_root.is_symlink() or not stat.S_ISDIR(root_stat.st_mode):
        raise ProductProfileLoadError(f"Product Profile root must be a regular directory: {profile_root}")

    digest = hashlib.sha256()

    def visit(directory: Path, prefix: str) -> None:
        try:
            entries = sorted(directory.iterdir(), key=lambda path: path.name.encode("utf-8"))
        except OSError as exc:
            raise _profile_io_error(f"cannot read Product Profile directory: {directory}", exc) from exc
        for entry in entries:
            relative_path = f"{prefix}/{entry.name}" if prefix else entry.name
            try:
                entry_stat = entry.lstat()
            except OSError as exc:
                raise _profile_io_error(f"cannot inspect Product Profile entry: {relative_path}", exc) from exc
            if entry.is_symlink():
                raise ProductProfileLoadError(f"Product Profile digest rejects symlink: {relative_path}")
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
                    raise _profile_io_error(f"cannot read Product Profile file: {relative_path}", exc) from exc
                digest.update(b"file\0")
                digest.update(relative_path.encode("utf-8"))
                digest.update(b"\0")
                digest.update(len(content).to_bytes(8, byteorder="big"))
                digest.update(content)
            else:
                raise ProductProfileLoadError(
                    f"Product Profile digest supports only directories and regular files: {relative_path}"
                )

    visit(profile_root, "")
    return digest.hexdigest()


class ProductProfileCatalog:
    def __init__(self, profiles_root: Path | None = None) -> None:
        self._profiles_root = (profiles_root or ProductProfilesLocator.default().profiles_root).resolve()

    def load(self, product_profile_id: str) -> LoadedProductProfile:
        if product_profile_id not in _PRODUCT_PROFILE_IDS:
            raise ProductProfileLoadError(f"unknown Product Profile: {product_profile_id}")
        profile_id = cast(ProductProfileId, product_profile_id)
        directory = self._profiles_root / profile_id
        artifact_digest = compute_product_profile_digest(directory)
        descriptor_path = directory / "profile.json"
        try:
            descriptor_json = descriptor_path.read_text(encoding="utf-8")
            descriptor_data = json.loads(descriptor_json)
        except OSError as exc:
            raise _profile_io_error(f"cannot read profile.json for {profile_id}: {exc}", exc) from exc
        except (UnicodeError, ValidationError, json.JSONDecodeError) as exc:
            raise ProductProfileLoadError(f"invalid profile.json for {profile_id}: {exc}") from exc
        if not isinstance(descriptor_data, dict) or type(descriptor_data.get("schema_version")) is not int:
            raise ProductProfileLoadError(f"invalid profile.json for {profile_id}: schema_version must be an integer")
        try:
            descriptor = ProductProfileDescriptor.model_validate_json(descriptor_json, strict=True)
        except ValidationError as exc:
            raise ProductProfileLoadError(f"invalid profile.json for {profile_id}: {exc}") from exc
        if descriptor.profile.value != profile_id:
            raise ProductProfileLoadError(
                f"Product Profile descriptor {descriptor.profile.value} does not match directory {profile_id}"
            )
        return LoadedProductProfile(
            product_profile_id=profile_id,
            artifact_digest=artifact_digest,
            descriptor=descriptor,
            directory=directory.resolve(),
        )
