"""Fail-closed validation for agent runtime descriptors (beyond Pydantic shape).

Generated Pydantic models in ``superclaw-contracts`` enforce field types and
single-value constraints. This module applies **cross-field rules** that must
stay aligned with TypeScript: shared limits and regexes come from
``AGENT_RUNTIME_RULES`` in ``contracts.agent_runtime_descriptor_data``, and
refusal reasons from ``contracts.agent_runtime_refusal.Reason``.

**Entry points**

* :func:`validate_agent_runtime_descriptor` — parse with
  ``AgentRuntimeDescriptor.model_validate``, then run :func:`collect_refusals`; on
  any issue raise :class:`AgentRuntimeDescriptorRefusal` (prefer this over calling
  ``model_validate`` alone so callers get typed reasons).
* :func:`collect_refusals` — inspect a JSON-shaped descriptor dict and return every
  :class:`RefusalItem` (members, launch argv/env templates, shutdown grace, adapters, …).
* :func:`parse_template_token` / :func:`member_path_issue` — shared template grammar
  used by validation and by :mod:`catalog` at launch time.

Module-level constants (``SINGLETON_ROLES``, ``PATH_PLACEHOLDERS``, …) are re-exported
views of the generated rules blob so Python and TS cannot drift on vocabulary.

:class:`AgentRuntimeDescriptorRefusal` can be rendered for APIs via
:meth:`AgentRuntimeDescriptorRefusal.as_contract`.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass

from contracts.agent_runtime_descriptor import AgentRuntimeDescriptor
from contracts.agent_runtime_descriptor_data import (
    AGENT_RUNTIME_CONTRACT_VERSION,
    AGENT_RUNTIME_RULES,
)
from contracts.agent_runtime_refusal import AgentRuntimeRefusal, Reason
from pydantic import ValidationError

ROLE_TIER: Mapping[str, str] = AGENT_RUNTIME_RULES["role_tier"]
SINGLETON_ROLES: tuple[str, ...] = tuple(AGENT_RUNTIME_RULES["singleton_roles"])
EXECUTABLE_ROLES: tuple[str, ...] = tuple(AGENT_RUNTIME_RULES["executable_roles"])
SECRET_BEARING_ENV_NAMES: tuple[str, ...] = tuple(
    AGENT_RUNTIME_RULES["secret_bearing_env_names"]
)
PATH_PLACEHOLDERS: tuple[str, ...] = tuple(AGENT_RUNTIME_RULES["path_placeholders"])
SCALAR_PLACEHOLDERS: tuple[str, ...] = tuple(AGENT_RUNTIME_RULES["scalar_placeholders"])
SHUTDOWN_GRACE_MIN_S: float = AGENT_RUNTIME_RULES["shutdown_grace_min_s"]
SHUTDOWN_GRACE_MAX_S: float = AGENT_RUNTIME_RULES["shutdown_grace_max_s"]


def _shared_pattern(name: str) -> re.Pattern[str]:
    """Compile a shared pattern so its end anchor means what it means in JavaScript.

    Python's ``$`` also matches before one trailing newline; ``\\Z`` does not.
    """
    source = AGENT_RUNTIME_RULES[name]
    if not source.endswith("$"):
        raise ValueError(f"shared pattern '{name}' must be end-anchored: {source}")
    return re.compile(source[:-1] + r"\Z")


_MEMBER_PATH_SEGMENT = _shared_pattern("member_path_segment_pattern")
_ENV_NAME = _shared_pattern("env_name_pattern")
_TEMPLATE_TOKEN = _shared_pattern("template_token_pattern")
_MEMBER_PREFIX = "member:"


@dataclass(frozen=True)
class RefusalItem:
    """One machine-readable refusal: a reason plus a declared member path."""

    reason: Reason
    member_path: str | None

    def __post_init__(self) -> None:
        if not isinstance(self.reason, Reason):
            raise TypeError(
                "a refusal reason must be a member of the generated vocabulary, not "
                + type(self.reason).__name__
            )
        object.__setattr__(self, "member_path", _safe_member_path(self.member_path))


class AgentRuntimeDescriptorRefusal(ValueError):
    """A descriptor was refused, with typed reasons."""

    def __init__(self, items: Sequence[RefusalItem]) -> None:
        self.items = tuple(items)
        self.reasons = tuple(item.reason for item in self.items)
        super().__init__(
            "agent runtime descriptor refused: "
            + ", ".join(sorted({item.reason.value for item in self.items}))
        )

    def as_contract(self) -> AgentRuntimeRefusal:
        """Render the refusal as the wire shape."""
        return AgentRuntimeRefusal.model_validate(
            {
                "contract_version": AGENT_RUNTIME_CONTRACT_VERSION,
                "refusals": [
                    {"reason": item.reason.value, "member_path": item.member_path}
                    for item in self.items
                ],
            }
        )


@dataclass(frozen=True)
class ParsedToken:
    """One parsed argv or env template token."""

    kind: str
    value: str
    segments: tuple[str, ...] = ()


def member_path_issue(value: object) -> str | None:
    """Return why a member path is not a payload-relative POSIX path, or None."""
    if not isinstance(value, str) or not value:
        return "must be a non-empty string"
    if "\\" in value:
        return "must use forward slashes"
    for segment in value.split("/"):
        if segment in ("", ".", ".."):
            return "must have no empty or dot segments"
        if not _MEMBER_PATH_SEGMENT.match(segment):
            return "segments must be portable file-name characters"
    return None


def parse_template_token(token: object) -> ParsedToken | None:
    """Parse one template token against the shared grammar, or None if it is not one."""
    if not isinstance(token, str):
        return None
    if "{{" not in token and "}}" not in token:
        return None if not token else ParsedToken("literal", token)
    match = _TEMPLATE_TOKEN.match(token)
    if match is None:
        return None
    head, tail = match.group(1), match.group(2)
    segments = tuple(tail[1:].split("/")) if tail else ()

    if head.startswith(_MEMBER_PREFIX):
        member_path = head[len(_MEMBER_PREFIX) :]
        if segments or member_path_issue(member_path) is not None:
            return None
        return ParsedToken("member", member_path)

    if head in SCALAR_PLACEHOLDERS:
        return None if segments else ParsedToken("scalar", head)

    if head not in PATH_PLACEHOLDERS:
        return None
    for segment in segments:
        if segment in ("", ".", "..") or not _MEMBER_PATH_SEGMENT.match(segment):
            return None
    return ParsedToken("path", head, segments)


def validate_agent_runtime_descriptor(
    payload: Mapping[str, object],
) -> AgentRuntimeDescriptor:
    """Validate a descriptor or raise AgentRuntimeDescriptorRefusal, shape rules first."""
    try:
        model = AgentRuntimeDescriptor.model_validate(payload)
    except ValidationError as exc:
        raise AgentRuntimeDescriptorRefusal(_shape_failure_items(payload, exc)) from exc
    items = collect_refusals(model.model_dump(mode="json"))
    if items:
        raise AgentRuntimeDescriptorRefusal(items)
    return model


_VALUE_LEVEL_SHAPE_ERRORS = frozenset(
    {"string_pattern_mismatch", "too_short", "too_long"}
)


def _shape_failure_items(
    payload: Mapping[str, object],
    exc: ValidationError,
) -> tuple[RefusalItem, ...]:
    shape_invalid = (RefusalItem(Reason.descriptor_shape_invalid, None),)
    if not all(error["type"] in _VALUE_LEVEL_SHAPE_ERRORS for error in exc.errors()):
        return shape_invalid
    return collect_refusals(payload) or shape_invalid


def collect_refusals(payload: Mapping[str, object]) -> tuple[RefusalItem, ...]:
    """Return every reason this descriptor must be refused for."""
    records = _records(payload.get("members"))
    if not records:
        return (RefusalItem(Reason.member_list_empty, None),)

    items: list[RefusalItem] = []
    items.extend(_member_refusals(records))
    items.extend(_role_cardinality_refusals(records))
    items.extend(_launch_refusals(payload, records))
    items.extend(_bound_refusals(payload))
    items.extend(_adapter_refusals(payload, records))
    return tuple(dict.fromkeys(items))


def _member_refusals(
    records: Sequence[Mapping[str, object]],
) -> Iterable[RefusalItem]:
    seen: set[str] = set()
    for record in records:
        path = record.get("path")
        member_path = path if isinstance(path, str) else None
        if member_path_issue(path) is not None:
            yield RefusalItem(Reason.member_path_not_posix_relative, member_path)
        elif member_path in seen:
            yield RefusalItem(Reason.duplicate_member_path, member_path)
        else:
            seen.add(str(member_path))

        role = record.get("role")
        access = record.get("access")
        access_map = access if isinstance(access, Mapping) else {}
        if access_map.get("read") is not True:
            yield RefusalItem(Reason.member_not_readable, member_path)
        should_execute = role in EXECUTABLE_ROLES
        if should_execute and access_map.get("execute") is not True:
            yield RefusalItem(
                Reason.executable_role_not_marked_executable, member_path
            )
        if not should_execute and access_map.get("execute") is True:
            yield RefusalItem(
                Reason.non_executable_role_marked_executable, member_path
            )
        expected_tier = ROLE_TIER.get(role) if isinstance(role, str) else None
        if expected_tier is not None and record.get("isolation_tier") != expected_tier:
            yield RefusalItem(Reason.member_tier_inconsistent_with_role, member_path)


def _role_cardinality_refusals(
    records: Sequence[Mapping[str, object]],
) -> Iterable[RefusalItem]:
    for role in SINGLETON_ROLES:
        if sum(1 for record in records if record.get("role") == role) > 1:
            yield RefusalItem(Reason.member_role_must_be_unique, None)


def _launch_refusals(
    payload: Mapping[str, object],
    records: Sequence[Mapping[str, object]],
) -> Iterable[RefusalItem]:
    launch = payload.get("launch")
    if not isinstance(launch, Mapping):
        return
    by_path = {
        record["path"]: record for record in records if isinstance(record.get("path"), str)
    }

    def relaxable(path: object) -> bool:
        record = by_path.get(path)
        return bool(record) and record.get("requirement") == "required_when_verified"

    program = launch.get("program_member")
    program_record = by_path.get(program)
    program_path = program if isinstance(program, str) else None
    if program_record is None:
        yield RefusalItem(Reason.program_member_not_declared, program_path)
    else:
        access = program_record.get("access")
        access_map = access if isinstance(access, Mapping) else {}
        if access_map.get("execute") is not True:
            yield RefusalItem(Reason.program_member_not_executable, program_path)
        if program_record.get("requirement") != "required":
            yield RefusalItem(Reason.program_member_relaxable, program_path)

    used_scalars: set[str] = set()
    for group in _records(launch.get("argv_groups")):
        tokens = group.get("tokens")
        token_list = list(tokens) if isinstance(tokens, Sequence) and not isinstance(tokens, str) else []
        if not token_list:
            yield RefusalItem(Reason.launch_group_empty, None)
        guard = group.get("present_member")
        if guard is not None:
            guard_path = guard if isinstance(guard, str) else None
            if guard not in by_path:
                yield RefusalItem(Reason.launch_group_guard_member_undeclared, guard_path)
            elif not relaxable(guard):
                yield RefusalItem(
                    Reason.launch_group_guard_member_unconditional, guard_path
                )
        for token in token_list:
            parsed = parse_template_token(token)
            if parsed is None:
                yield RefusalItem(Reason.template_token_shape_invalid, None)
                continue
            if parsed.kind == "scalar":
                used_scalars.add(parsed.value)
                continue
            if parsed.kind != "member":
                continue
            if parsed.value not in by_path:
                yield RefusalItem(
                    Reason.template_references_undeclared_member, parsed.value
                )
            elif relaxable(parsed.value) and guard != parsed.value:
                yield RefusalItem(
                    Reason.launch_group_relaxable_member_unguarded, parsed.value
                )

    env_template = launch.get("env_template")
    for name, template in (env_template or {}).items() if isinstance(env_template, Mapping) else ():
        if not _ENV_NAME.match(str(name)):
            yield RefusalItem(Reason.env_name_shape_invalid, None)
        if name in SECRET_BEARING_ENV_NAMES:
            yield RefusalItem(Reason.env_name_secret_bearing, None)
        parsed = parse_template_token(template)
        if parsed is None:
            yield RefusalItem(Reason.template_token_shape_invalid, None)
            continue
        if parsed.kind == "scalar":
            used_scalars.add(parsed.value)
        if parsed.kind == "member" and parsed.value not in by_path:
            yield RefusalItem(
                Reason.template_references_undeclared_member, parsed.value
            )

    # The port we probe must be a port we passed, else readiness watches a
    # listener the launch never asked for.
    probe = payload.get("readiness_probe")
    if isinstance(probe, Mapping):
        probe_port = probe.get("port_placeholder")
        if isinstance(probe_port, str) and probe_port not in used_scalars:
            yield RefusalItem(Reason.readiness_probe_port_not_passed_to_launch, None)


def _bound_refusals(payload: Mapping[str, object]) -> Iterable[RefusalItem]:
    shutdown = payload.get("shutdown")
    if isinstance(shutdown, Mapping):
        grace = shutdown.get("grace_seconds")
        if isinstance(grace, int | float) and not (
            SHUTDOWN_GRACE_MIN_S <= grace <= SHUTDOWN_GRACE_MAX_S
        ):
            yield RefusalItem(Reason.shutdown_grace_out_of_bounds, None)


def _adapter_refusals(
    payload: Mapping[str, object],
    records: Sequence[Mapping[str, object]],
) -> Iterable[RefusalItem]:
    adapters = payload.get("adapters")
    if not isinstance(adapters, Mapping):
        return
    expected = (
        "opencode_jsonc_extract" if payload.get("runtime_id") == "opencode" else "none"
    )
    projection = adapters.get("config_projection")
    if projection != expected:
        yield RefusalItem(
            Reason.config_projection_adapter_inconsistent_with_runtime_id, None
        )
    roles = [record.get("role") for record in records]
    if projection == "opencode_jsonc_extract" and "config_source" not in roles:
        yield RefusalItem(Reason.config_projection_requires_config_source_member, None)
    if adapters.get("guard") == "native_pinned_shell" and "shell_executable" not in roles:
        yield RefusalItem(Reason.guard_adapter_requires_shell_member, None)


def _records(value: object) -> tuple[Mapping[str, object], ...]:
    if not isinstance(value, Sequence) or isinstance(value, str | bytes):
        return ()
    return tuple(item for item in value if isinstance(item, Mapping))


def _safe_member_path(value: object) -> str | None:
    return value if isinstance(value, str) and member_path_issue(value) is None else None
