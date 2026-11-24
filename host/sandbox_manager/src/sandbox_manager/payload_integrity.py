"""Fail-closed verification for a versioned Windows-native backend payload."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import time
from typing import Any, Literal

from .startup_diagnostics import startup_diagnostic


PAYLOAD_MANIFEST_NAME = "manifest.json"
# v2 dropped the `agent_manifest` binding. The Product Profile cutover deleted
# `superclaw-agent-manifest.json` and moved the OpenCode configuration tree out
# of the payload, leaving `config-source` as the offline dependency tree.
PAYLOAD_MANIFEST_SCHEMA_VERSION = 2
# Not the broker: an installed one is elevated, so it ships beside the archive in the install
# directory and is never staged into the user-writable managed root. The tier bootstrap is the
# launcher's first-hop image and must sit beside it: the launcher starts it from its own directory.
REQUIRED_PAYLOAD_PATHS = frozenset(
    {
        "openwork.exe",
        "openwork-server.exe",
        "opencode-router.exe",
        "opencode.exe",
        "native-isolation/native_isolation_launcher.exe",
        "native-isolation/native_isolation_tier_bootstrap.exe",
        "shell/sh.exe",
        "shell/bash.exe",
        "shell/rg.exe",
        "shell/licenses/ripgrep.LICENSE",
        "intent-classifier/intent_classifier_server.py",
        "config-source/package.json",
        "config-source/node_modules/@opencode-ai/plugin/package.json",
    }
)

# Absent on POSIX, where `st_file_attributes` is absent too and `is_symlink` is the whole test.
_REPARSE_ATTRIBUTE = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)

_SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
_PAYLOAD_VERSION_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_TOP_LEVEL_KEYS = frozenset(
    {"schema_version", "payload_version", "hash_algorithm", "files"}
)
_FILE_ENTRY_KEYS = frozenset({"path", "bytes", "sha256"})
# Names Windows resolves to a device rather than a file, with or without an extension.
_WINDOWS_DEVICE_NAMES = frozenset(
    {"CON", "PRN", "AUX", "NUL"}
    | {f"COM{n}" for n in range(1, 10)}
    | {f"LPT{n}" for n in range(1, 10)}
)


# Bounded codes a payload failure carries to the status and the API, in place of its text.
PayloadFailureReason = Literal[
    "payload_reparse_point",
    "manifest_missing_or_unsafe",
    "manifest_unreadable",
    "manifest_schema_unsupported",
    "manifest_schema_invalid",
    "payload_version_invalid",
    "hash_algorithm_invalid",
    "required_member_omitted",
    "payload_member_missing",
    "unexpected_payload_member",
    "payload_size_mismatch",
    "payload_case_collision",
    "unsafe_payload_path",
    "payload_root_invalid",
    "payload_disk_full",
    "payload_io_error",
    "payload_in_use",
    "installed_payload_missing",
    "installed_payload_archive_invalid",
    "verified_payload_changed",
    "config_source_unavailable",
    "payload_verification_failed",
]


class PayloadIntegrityError(ValueError):
    """The native backend payload cannot be trusted."""

    def __init__(
        self, message: str, *, reason: PayloadFailureReason = "payload_verification_failed"
    ) -> None:
        super().__init__(message)
        self.reason: PayloadFailureReason = reason


@dataclass(frozen=True)
class VerifiedPayload:
    payload_root: Path
    payload_version: str
    file_count: int
    # Digest of the manifest roster. Two builds of one commit can differ byte-for-byte, so
    # this rather than `payload_version` is what decides whether two roots hold the same
    # payload. Since verification stopped reading file bytes, it is also the whole of this
    # payload's content identity. It is not part of any path: the managed payload directory
    # is one stable path, and this is what says whether its content is the wanted one.
    content_fingerprint: str


@dataclass(frozen=True)
class _FileEntry:
    path: str
    size: int
    sha256: str


def verify_payload(payload_root: Path) -> VerifiedPayload:
    """Check the manifest, the on-disk inventory and every member's size.

    What this does *not* do is read the payload's bytes. Per-file SHA-256 over ~30,000
    files cost 11-28 s per pass and a boot makes several of them, and #2638 accepted the
    residual risk of dropping it: the attacker it defended against is a process already
    running as the logged-in user, who owns the managed payload root regardless. The
    broker and launcher used to get a second digest plus Authenticode check in
    `broker_client.trust`; that was deleted for the same reason, so nothing here or
    downstream reads payload bytes back to check them.

    So a member replaced by same-length content passes here. A missing, extra, truncated,
    grown, non-regular or reparse-point member does not, which is what covers the failure
    this is actually on the critical path for: an incomplete or interrupted copy.
    """
    if _is_reparse_point(payload_root):
        raise PayloadIntegrityError(
            f"payload root may not be a symlink or reparse point: {payload_root}",
            reason="payload_reparse_point",
        )
    root = payload_root.resolve()
    if not root.is_dir():
        raise PayloadIntegrityError(
            f"payload root is not a directory: {payload_root}", reason="payload_root_invalid"
        )

    manifest_path = root / PAYLOAD_MANIFEST_NAME
    if _is_reparse_point(manifest_path) or not manifest_path.is_file():
        raise PayloadIntegrityError(
            f"payload manifest is missing or unsafe: {manifest_path}",
            reason="manifest_missing_or_unsafe",
        )
    manifest_started = time.perf_counter()
    payload_version, entries = _validated_manifest(_read_manifest(manifest_path))
    entries_by_key = {entry.path.casefold(): entry for entry in entries}

    manifest_ms = round((time.perf_counter() - manifest_started) * 1000)
    inventory_started = time.perf_counter()
    inventory = _inventory_payload(root)
    inventory_ms = round((time.perf_counter() - inventory_started) * 1000)
    manifest_keys = set(entries_by_key)
    inventory_keys = set(inventory)
    missing = sorted(entries_by_key[key].path for key in manifest_keys - inventory_keys)
    extra = sorted(inventory[key][0] for key in inventory_keys - manifest_keys)
    if missing:
        raise PayloadIntegrityError(
            f"payload files are missing: {', '.join(missing)}", reason="payload_member_missing"
        )
    if extra:
        raise PayloadIntegrityError(
            f"payload contains unexpected files: {', '.join(extra)}",
            reason="unexpected_payload_member",
        )

    # Free: `_inventory_payload` already stat'd every entry to classify it, so the size
    # comparison costs nothing beyond this loop and is the one content-shaped check left.
    for key, entry in entries_by_key.items():
        actual_size = inventory[key][2]
        if actual_size != entry.size:
            raise PayloadIntegrityError(
                f"payload file size mismatch for {entry.path}: "
                f"expected {entry.size}, got {actual_size}",
                reason="payload_size_mismatch",
            )

    startup_diagnostic(
        "verify_payload",
        "observed",
        elapsed_ms=manifest_ms + inventory_ms,
        manifest_ms=manifest_ms,
        inventory_ms=inventory_ms,
        files=len(entries),
        bytes=sum(entry.size for entry in entries),
    )

    return VerifiedPayload(
        payload_root=root,
        payload_version=payload_version,
        file_count=len(entries),
        content_fingerprint=_entries_fingerprint(entries),
    )


@dataclass(frozen=True)
class ManifestIdentity:
    """What a manifest says about its payload, before any tree exists to check it against."""

    payload_version: str
    file_count: int
    content_fingerprint: str
    roster: dict[str, tuple[str, int, str]]


def parse_payload_manifest(data: bytes) -> ManifestIdentity:
    """Every check `verify_payload` makes on the manifest itself, but not the inventory."""
    payload_version, entries = _validated_manifest(_load_manifest(data))
    return ManifestIdentity(
        payload_version=payload_version,
        file_count=len(entries),
        content_fingerprint=_entries_fingerprint(entries),
        roster={
            entry.path.casefold(): (entry.path, entry.size, entry.sha256)
            for entry in entries
        },
    )


def _validated_manifest(manifest: dict[str, Any]) -> tuple[str, list[_FileEntry]]:
    _require_exact_keys(manifest, _TOP_LEVEL_KEYS, "payload manifest")

    schema_version = manifest["schema_version"]
    if (
        isinstance(schema_version, bool)
        or not isinstance(schema_version, int)
        or schema_version != PAYLOAD_MANIFEST_SCHEMA_VERSION
    ):
        raise PayloadIntegrityError(
            f"unsupported payload manifest schema_version: {schema_version!r}",
            reason="manifest_schema_unsupported",
        )

    payload_version = manifest["payload_version"]
    if not isinstance(payload_version, str) or not _PAYLOAD_VERSION_PATTERN.fullmatch(
        payload_version
    ):
        raise PayloadIntegrityError(
            "payload_version is missing or invalid", reason="payload_version_invalid"
        )
    if manifest["hash_algorithm"] != "sha256":
        raise PayloadIntegrityError(
            "payload hash_algorithm must be sha256", reason="hash_algorithm_invalid"
        )

    entries = _parse_file_entries(manifest["files"])
    keys = {entry.path.casefold() for entry in entries}
    missing_required = sorted(
        path for path in REQUIRED_PAYLOAD_PATHS if path.casefold() not in keys
    )
    if missing_required:
        raise PayloadIntegrityError(
            f"payload manifest omits required paths: {', '.join(missing_required)}",
            reason="required_member_omitted",
        )
    return payload_version, entries


def payload_content_fingerprint(payload_root: Path) -> str:
    """Digest a verified payload's manifest inventory, independent of manifest layout.

    `payload_version` is typically a commit SHA, and two builds of the same
    commit can differ byte-for-byte (for example one that signed the native
    isolation executables and one that did not). Callers that must decide
    whether an already-published payload still matches its source compare this
    fingerprint instead of trusting the version string. It only covers the
    manifest's per-file (path, size, sha256) set, so it is cheap; it is only
    meaningful for a root that `verify_payload` has already accepted, which is
    what proves the manifest describes the files on disk.
    """
    manifest = _read_manifest(payload_root / PAYLOAD_MANIFEST_NAME)
    entries = _parse_file_entries(manifest.get("files"))
    return _entries_fingerprint(entries)


def payload_roster(payload_root: Path) -> dict[str, tuple[str, int, str]]:
    """The manifest's members as `{casefolded path: (path, size, sha256)}`.

    What an in-place update diffs against: a member whose entry is unchanged between the
    published manifest and the wanted one is not written again. Like
    `payload_content_fingerprint`, it reads the manifest only and is meaningful for a root
    that `verify_payload` has accepted.
    """
    manifest = _read_manifest(payload_root / PAYLOAD_MANIFEST_NAME)
    return {
        entry.path.casefold(): (entry.path, entry.size, entry.sha256)
        for entry in _parse_file_entries(manifest.get("files"))
    }


def _entries_fingerprint(entries: Sequence[_FileEntry]) -> str:
    digest = hashlib.sha256()
    for entry in sorted(entries, key=lambda item: item.path.casefold()):
        digest.update(f"{entry.path}\n{entry.size}\n{entry.sha256}\n".encode())
    return digest.hexdigest()


def _read_manifest(path: Path) -> dict[str, Any]:
    try:
        data = path.read_bytes()
    except OSError as exc:
        raise PayloadIntegrityError(
            f"cannot read payload manifest: {exc}", reason="manifest_unreadable"
        ) from exc
    return _load_manifest(data)


def _load_manifest(data: bytes) -> dict[str, Any]:
    try:
        value = json.loads(data, object_pairs_hook=_unique_object)
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise PayloadIntegrityError(
            f"cannot read payload manifest: {exc}", reason="manifest_unreadable"
        ) from exc
    if not isinstance(value, dict):
        raise PayloadIntegrityError("payload manifest must be a JSON object")
    return value


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise PayloadIntegrityError(f"payload manifest contains duplicate key: {key}")
        value[key] = item
    return value


def _require_exact_keys(
    value: dict[str, Any], expected: frozenset[str], description: str
) -> None:
    actual = set(value)
    if actual != expected:
        missing = sorted(expected - actual)
        extra = sorted(actual - expected)
        details = []
        if missing:
            details.append(f"missing {', '.join(missing)}")
        if extra:
            details.append(f"unexpected {', '.join(extra)}")
        raise PayloadIntegrityError(
            f"invalid {description}: {'; '.join(details)}", reason="manifest_schema_invalid"
        )


def _parse_file_entries(value: Any) -> list[_FileEntry]:
    if not isinstance(value, list) or not value:
        raise PayloadIntegrityError("payload manifest files must be a non-empty array")

    entries: list[_FileEntry] = []
    seen: set[str] = set()
    for index, raw_entry in enumerate(value):
        if not isinstance(raw_entry, dict):
            raise PayloadIntegrityError(f"payload file entry {index} must be an object")
        _require_exact_keys(raw_entry, _FILE_ENTRY_KEYS, f"payload file entry {index}")
        path = raw_entry["path"]
        _validate_relative_path(path)
        if path == PAYLOAD_MANIFEST_NAME:
            raise PayloadIntegrityError("payload manifest may not include itself")
        key = path.casefold()
        if key in seen:
            raise PayloadIntegrityError(f"payload manifest contains duplicate path: {path}")
        seen.add(key)

        size = raw_entry["bytes"]
        if isinstance(size, bool) or not isinstance(size, int) or size < 0:
            raise PayloadIntegrityError(f"payload file bytes is invalid for {path}")
        sha256 = raw_entry["sha256"]
        if not isinstance(sha256, str) or not _SHA256_PATTERN.fullmatch(sha256):
            raise PayloadIntegrityError(f"payload file sha256 is invalid for {path}")
        entries.append(_FileEntry(path=path, size=size, sha256=sha256))
    return entries


def _validate_relative_path(value: Any) -> None:
    if not isinstance(value, str):
        raise PayloadIntegrityError("payload file path must be a string")
    parts = value.split("/")
    if (
        "\\" in value
        or "\0" in value
        or ":" in value
        or any(
            part in {"", ".", ".."}
            or part.endswith((".", " "))
            or part.split(".", 1)[0].upper() in _WINDOWS_DEVICE_NAMES
            for part in parts
        )
        or value != "/".join(parts)
    ):
        raise PayloadIntegrityError(
            f"unsafe payload file path: {value!r}", reason="unsafe_payload_path"
        )


def _inventory_payload(root: Path) -> dict[str, tuple[str, Path, int]]:
    """Walk the payload once, taking each entry's metadata from the directory read.

    `Path.rglob` plus a reparse check plus `is_dir` plus `is_file` asked the filesystem for
    the same metadata four times per entry, which over 30,282 files was measured at 2.7-8.0 s
    per verification pass depending on contention. `os.scandir` carries the type and
    attributes from the enumeration, so one `stat` per entry answers all of it - including
    the size the caller compares against the roster, which is why that comparison is free.
    The rules enforced are unchanged: no reparse point anywhere, regular files only, and no
    case-colliding pair.
    """
    inventory: dict[str, tuple[str, Path, int]] = {}

    def visit(directory: str, prefix: str) -> None:
        with os.scandir(directory) as entries:
            for entry in entries:
                relative = f"{prefix}{entry.name}"
                if relative == PAYLOAD_MANIFEST_NAME:
                    continue
                metadata = entry.stat(follow_symlinks=False)
                attributes = getattr(metadata, "st_file_attributes", 0)
                if entry.is_symlink() or attributes & _REPARSE_ATTRIBUTE:
                    raise PayloadIntegrityError(
                        f"payload may not contain reparse points: {relative}",
                        reason="payload_reparse_point",
                    )
                if stat.S_ISDIR(metadata.st_mode):
                    visit(entry.path, f"{relative}/")
                    continue
                if not stat.S_ISREG(metadata.st_mode):
                    raise PayloadIntegrityError(
                        f"payload contains a non-file path: {relative}"
                    )
                _validate_relative_path(relative)
                key = relative.casefold()
                if key in inventory:
                    raise PayloadIntegrityError(
                        f"payload contains case-colliding paths: "
                        f"{inventory[key][0]}, {relative}",
                        reason="payload_case_collision",
                    )
                inventory[key] = (relative, Path(entry.path), metadata.st_size)

    visit(str(root), "")
    return inventory


def _is_reparse_point(path: Path) -> bool:
    try:
        metadata = path.lstat()
    except OSError:
        return False
    file_attributes = getattr(metadata, "st_file_attributes", 0)
    return path.is_symlink() or bool(file_attributes & _REPARSE_ATTRIBUTE)
