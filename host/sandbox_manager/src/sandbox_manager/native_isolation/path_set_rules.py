r"""Cross-field rules for the native path descriptor.

Production code calls ``validate_native_path_set``, never ``NativePathSetShape.model_validate``.
Volume and ancestry verdicts are caller-supplied inputs, not measurements taken here.
Anything not known-good is refused (absent evidence fails closed).
``denied_workspace_ancestors`` is also caller-supplied, and a wrong value here fails
open: with a bogus ``windows_root``, ``C:\Windows\System32`` is accepted and nothing
else notices.
The ancestry verdict is a point-in-time observation and not race-aware.
These rules compare path spellings only.
"""

from __future__ import annotations

import hashlib
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from enum import Enum

from contracts.native_path_set import (
    AccessMode,
    AncestryVerdict,
    Kind,
    NativePathSetShape,
    PolicyClass,
    VolumeVerdict,
)
from contracts.workspace_root_refusal import Reason, Refusal, WorkspaceRootRefusal
from pydantic import ValidationError

from .path_policy import (
    NativePathPolicyError,
    comparison_parts,
    normalize_local_windows_path,
)

# Bounds on how large one descriptor may get.
WORKSPACE_ROOT_SET_MIN_MEMBERS = 1
WORKSPACE_ROOT_SET_MAX_MEMBERS = 8

_ROOT_ID_PREFIX = "wsr_"
_ROOT_ID_DIGEST_LENGTH = hashlib.sha256().digest_size * 2


def _read_contract_version() -> int:
    annotation = NativePathSetShape.model_fields["contract_version"].annotation
    return int(annotation.__args__[0])


NATIVE_PATH_CONTRACT_VERSION = _read_contract_version()

FIXED_MANAGED_ROOT_FIELDS: tuple[str, ...] = tuple(
    field for field in NativePathSetShape.model_fields if field.endswith("_root")
)

_VOLUME_VERDICT_REASONS = {
    VolumeVerdict.non_ntfs.value: Reason.volume_verdict_non_ntfs,
    VolumeVerdict.removable.value: Reason.volume_verdict_removable,
    VolumeVerdict.redirected.value: Reason.volume_verdict_redirected,
    VolumeVerdict.unknown.value: Reason.volume_verdict_unknown,
}
_ANCESTRY_VERDICT_REASONS = {
    AncestryVerdict.reparse_point_observed.value: Reason.ancestor_reparse_point_observed,
    AncestryVerdict.unknown.value: Reason.ancestry_verdict_unknown,
}
_DENIED_SUBTREE_REASONS = (
    ("local_app_data_root", Reason.member_under_local_app_data_root),
    ("program_data_root", Reason.member_under_program_data_root),
    ("windows_root", Reason.member_under_windows_root),
)
_ACCESS_MODE_BY_POLICY_CLASS = {
    PolicyClass.managed_default.value: AccessMode.read_write.value,
    PolicyClass.user_granted_rw.value: AccessMode.read_write.value,
    PolicyClass.user_granted_ro.value: AccessMode.read_only.value,
}


@dataclass(frozen=True)
class RefusalItem:
    """One machine-readable refusal.

    Carries a code and an id, never a path.
    An id that is not the contract shape is dropped to None at construction.
    """

    reason: Reason
    root_id: str | None

    def __post_init__(self) -> None:
        if not isinstance(self.reason, Reason):
            raise TypeError(
                "a refusal reason must be a member of the generated vocabulary, not "
                + type(self.reason).__name__
            )
        object.__setattr__(self, "root_id", _safe_root_id(self.root_id))


class NativePathSetRefusal(ValueError):
    """A descriptor was refused, with typed reasons."""

    def __init__(self, items: Sequence[RefusalItem]) -> None:
        self.items = tuple(items)
        self.reasons = tuple(item.reason for item in self.items)
        super().__init__(
            "native path set refused: "
            + ", ".join(sorted({item.reason.value for item in self.items}))
        )

    def as_contract(self) -> WorkspaceRootRefusal:
        """Render the refusal as the wire shape."""
        return WorkspaceRootRefusal.model_validate(
            {
                "contract_version": NATIVE_PATH_CONTRACT_VERSION,
                "refusals": [
                    {"reason": item.reason.value, "root_id": item.root_id}
                    for item in self.items
                ],
            }
        )


def derive_workspace_root_id(canonical_path: str) -> str:
    """Return the stable id for a workspace root, from its canonical spelling.

    This id is a label, not a capability. It grants nothing and proves nothing.
    """
    folded = str(normalize_local_windows_path(canonical_path)).lower()
    return _ROOT_ID_PREFIX + hashlib.sha256(folded.encode("utf-8")).hexdigest()


def validate_native_path_set(payload: Mapping[str, object]) -> NativePathSetShape:
    """Validate a descriptor or raise NativePathSetRefusal.

    Shape first, then cross-field rules.
    A shape-fatal failure reports only descriptor_shape_invalid with no cross-field reasons.
    """
    try:
        model = NativePathSetShape.model_validate(payload)
    except ValidationError as exc:
        raise NativePathSetRefusal(_shape_failure_items(payload, exc)) from exc
    items = collect_refusals(model.model_dump(mode="json"))
    if items:
        raise NativePathSetRefusal(items)
    return model


_VALUE_LEVEL_SHAPE_ERRORS = frozenset(
    {"string_pattern_mismatch", "too_short", "too_long"}
)


def _shape_failure_is_value_level(exc: ValidationError) -> bool:
    return all(error["type"] in _VALUE_LEVEL_SHAPE_ERRORS for error in exc.errors())


def _shape_failure_items(
    payload: Mapping[str, object],
    exc: ValidationError,
) -> tuple[RefusalItem, ...]:
    shape_invalid = (RefusalItem(Reason.descriptor_shape_invalid, None),)
    if not _shape_failure_is_value_level(exc):
        return shape_invalid
    return collect_refusals(payload) or shape_invalid


def collect_refusals(payload: Mapping[str, object]) -> tuple[RefusalItem, ...]:
    """Return every reason this descriptor must be refused for."""
    items: list[RefusalItem] = []
    members = payload.get("workspace_roots")
    records: list[Mapping[str, object]] = (
        [member for member in members if isinstance(member, Mapping)]
        if isinstance(members, Sequence) and not isinstance(members, str | bytes)
        else []
    )

    items.extend(_path_spelling_refusals(payload, records))
    items.extend(_cardinality_refusals(members, records))
    items.extend(_member_refusals(records))
    items.extend(_duplicate_refusals(records))
    items.extend(_denied_location_refusals(payload, records))
    items.extend(_disjointness_refusals(payload, records))
    return tuple(dict.fromkeys(items))


def _path_spelling_refusals(
    payload: Mapping[str, object],
    records: Sequence[Mapping[str, object]],
) -> Iterable[RefusalItem]:
    denied = payload.get("denied_workspace_ancestors")
    denied_values = denied.values() if isinstance(denied, Mapping) else ()
    for value in (*(payload.get(f) for f in FIXED_MANAGED_ROOT_FIELDS), *denied_values):
        candidates = (
            value
            if isinstance(value, Sequence) and not isinstance(value, str | bytes)
            else (value,)
        )
        for candidate in candidates:
            reason = _path_spelling_reason(candidate)
            if reason is not None:
                yield RefusalItem(reason, None)
    for record in records:
        reason = _member_path_spelling_reason(record.get("path"))
        if reason is not None:
            yield RefusalItem(reason, _member_root_id(record))


def _cardinality_refusals(
    members: object,
    records: Sequence[Mapping[str, object]],
) -> Iterable[RefusalItem]:
    if not isinstance(members, Sequence) or isinstance(members, str | bytes):
        return
    if len(members) < WORKSPACE_ROOT_SET_MIN_MEMBERS:
        yield RefusalItem(Reason.member_count_below_bound, None)
    if len(members) > WORKSPACE_ROOT_SET_MAX_MEMBERS:
        yield RefusalItem(Reason.member_count_above_bound, None)
    managed_defaults = sum(
        1
        for record in records
        if _closed_value(record.get("policy_class"), PolicyClass)
        == PolicyClass.managed_default.value
    )
    if managed_defaults == 0:
        yield RefusalItem(Reason.managed_default_missing, None)
    elif managed_defaults > 1:
        yield RefusalItem(Reason.managed_default_duplicated, None)


def _member_refusals(
    records: Sequence[Mapping[str, object]],
) -> Iterable[RefusalItem]:
    for record in records:
        root_id = _member_root_id(record)
        policy_class = _closed_value(record.get("policy_class"), PolicyClass)
        access_mode = _closed_value(record.get("access_mode"), AccessMode)
        volume_verdict = _closed_value(record.get("volume_verdict"), VolumeVerdict)
        ancestry_verdict = _closed_value(
            record.get("ancestry_verdict"), AncestryVerdict
        )
        if None in (policy_class, access_mode, volume_verdict, ancestry_verdict):
            yield RefusalItem(Reason.descriptor_shape_invalid, root_id)
        if policy_class is not None:
            if access_mode != _ACCESS_MODE_BY_POLICY_CLASS[policy_class]:
                yield RefusalItem(
                    Reason.access_mode_inconsistent_with_policy_class, root_id
                )
            if not _authorization_is_consistent(
                policy_class, record.get("authorization")
            ):
                yield RefusalItem(
                    Reason.authorization_inconsistent_with_policy_class, root_id
                )
        if volume_verdict is not None:
            volume = _VOLUME_VERDICT_REASONS.get(volume_verdict)
            if volume is not None:
                yield RefusalItem(volume, root_id)
        if ancestry_verdict is not None:
            ancestry = _ANCESTRY_VERDICT_REASONS.get(ancestry_verdict)
            if ancestry is not None:
                yield RefusalItem(ancestry, root_id)
        path = record.get("path")
        if root_id is not None and isinstance(path, str):
            try:
                derived = derive_workspace_root_id(path)
            except NativePathPolicyError:
                derived = None
            if derived is not None and derived != root_id:
                yield RefusalItem(Reason.root_id_not_derived_from_path, root_id)


def _duplicate_refusals(
    records: Sequence[Mapping[str, object]],
) -> Iterable[RefusalItem]:
    seen_root_ids: set[str] = set()
    seen_paths: set[tuple[str, ...]] = set()
    for record in records:
        root_id = _member_root_id(record)
        if root_id is not None:
            if root_id in seen_root_ids:
                yield RefusalItem(Reason.duplicate_root_id, root_id)
            seen_root_ids.add(root_id)
        parts = _parts(record.get("path"))
        if parts is not None:
            if parts in seen_paths:
                yield RefusalItem(Reason.duplicate_canonical_path, root_id)
            seen_paths.add(parts)


def _denied_location_refusals(
    payload: Mapping[str, object],
    records: Sequence[Mapping[str, object]],
) -> Iterable[RefusalItem]:
    """Refuse a member that meets a denied location from either direction."""
    denied = payload.get("denied_workspace_ancestors")
    if not isinstance(denied, Mapping):
        return
    users_containers = _parts_list(denied.get("users_container_roots"))
    owner_profile = _parts(denied.get("owner_profile_root"))
    for record in records:
        parts = _parts(record.get("path"))
        if parts is None:
            continue
        root_id = _member_root_id(record)
        if owner_profile is not None and parts == owner_profile:
            yield RefusalItem(Reason.member_is_owner_profile_root, root_id)
        if any(
            _parts_overlap(container, parts) for container in users_containers
        ) and not (owner_profile is not None and _is_at_or_under(owner_profile, parts)):
            yield RefusalItem(Reason.member_under_other_user_profile, root_id)
        for field, reason in _DENIED_SUBTREE_REASONS:
            denied_parts = _parts(denied.get(field))
            if denied_parts is not None and _parts_overlap(denied_parts, parts):
                yield RefusalItem(reason, root_id)


def _disjointness_refusals(
    payload: Mapping[str, object],
    records: Sequence[Mapping[str, object]],
) -> Iterable[RefusalItem]:
    labelled: list[tuple[bool, str | None, tuple[str, ...]]] = []
    for field in FIXED_MANAGED_ROOT_FIELDS:
        parts = _parts(payload.get(field))
        if parts is not None:
            labelled.append((False, None, parts))
    for record in records:
        parts = _parts(record.get("path"))
        if parts is not None:
            labelled.append((True, _member_root_id(record), parts))

    for index, (left_is_member, left_root_id, left_parts) in enumerate(labelled):
        for right_is_member, right_root_id, right_parts in labelled[index + 1 :]:
            if not _parts_overlap(left_parts, right_parts):
                continue
            if left_is_member and right_is_member:
                reason = Reason.member_overlaps_member
            elif left_is_member or right_is_member:
                reason = Reason.member_overlaps_managed_root
            else:
                reason = Reason.managed_roots_overlap
            yield RefusalItem(reason, right_root_id or left_root_id)


def _authorization_is_consistent(policy_class: str, authorization: object) -> bool:
    if not isinstance(authorization, Mapping):
        return True
    kind = _closed_value(authorization.get("kind"), Kind)
    if policy_class == PolicyClass.managed_default.value:
        return (
            kind == Kind.installer_provisioned.value
            and authorization.get("grant_id") is None
            and authorization.get("granted_at") is None
            and authorization.get("revocable") is False
        )
    return (
        kind == Kind.user_grant.value
        and isinstance(authorization.get("grant_id"), str)
        and isinstance(authorization.get("granted_at"), str)
        and authorization.get("revocable") is True
    )


def _path_spelling_reason(value: object) -> Reason | None:
    if not isinstance(value, str):
        return None
    try:
        normalize_local_windows_path(value)
    except NativePathPolicyError as exc:
        return Reason(exc.reason)
    return None


def _member_path_spelling_reason(value: object) -> Reason | None:
    """Return the spelling refusal for a stored member path.

    A member path must be canonical, not merely legal.
    """
    reason = _path_spelling_reason(value)
    if reason is not None or not isinstance(value, str):
        return reason
    if str(normalize_local_windows_path(value)) != value:
        return Reason.path_not_canonical_local_windows
    return None


def _closed_value(value: object, vocabulary: type[Enum]) -> str | None:
    """Return a closed-vocabulary field as its string value, or None when unreadable."""
    if isinstance(value, vocabulary):
        return str(value.value)
    if isinstance(value, str) and value in {member.value for member in vocabulary}:
        return value
    return None


def _parts(value: object) -> tuple[str, ...] | None:
    if not isinstance(value, str):
        return None
    try:
        return comparison_parts(value)
    except NativePathPolicyError:
        return None


def _parts_list(value: object) -> tuple[tuple[str, ...], ...]:
    if not isinstance(value, Sequence) or isinstance(value, str | bytes):
        return ()
    folded = (_parts(entry) for entry in value)
    return tuple(parts for parts in folded if parts is not None)


def _is_at_or_under(root: tuple[str, ...], candidate: tuple[str, ...]) -> bool:
    return len(candidate) >= len(root) and candidate[: len(root)] == root


def _parts_overlap(left: tuple[str, ...], right: tuple[str, ...]) -> bool:
    return _is_at_or_under(left, right) or _is_at_or_under(right, left)


def _member_root_id(record: Mapping[str, object]) -> str | None:
    root_id = record.get("root_id")
    return root_id if isinstance(root_id, str) else None


def _safe_root_id(root_id: str | None) -> str | None:
    if root_id is None:
        return None
    expected_length = len(_ROOT_ID_PREFIX) + _ROOT_ID_DIGEST_LENGTH
    body = root_id[len(_ROOT_ID_PREFIX) :]
    if (
        len(root_id) == expected_length
        and root_id.startswith(_ROOT_ID_PREFIX)
        and all(character in "0123456789abcdef" for character in body)
    ):
        return root_id
    return None
