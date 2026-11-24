"""Resolve payload-backed agent runtimes from shared contract data.

Descriptors are generated in ``superclaw-contracts`` (source:
``shared/contracts/src/agent-runtime-descriptor.ts``) and loaded from
:data:`contracts.agent_runtime_descriptor_data.AGENT_RUNTIME_DESCRIPTORS`.
:func:`descriptor_for` validates via :mod:`rules` before returning; callers such as
:mod:`native_backend` use the helpers here instead of hard-coding binary paths or
argv.

* :func:`descriptor_for` / :func:`payload_backed_runtime_ids` — lookup by runtime id
  (e.g. ``opencode``).
* Member helpers — which paths are required, executable, or role-singletons under a
  payload root (:func:`inspect_members`, :func:`required_executable_paths`, …).
* :func:`resolve_env_template` / :func:`resolve_launch` — expand descriptor launch
  templates against a :class:`LaunchContext` (dirs, ports, payload root) into a
  program path, argv, and env for ``subprocess`` / restricted spawn.

Launch resolution is pure: missing required members are reported in
:class:`MemberInspection`; the spawn layer decides whether to refuse. Unresolved argv
tokens raise :class:`AgentRuntimeLaunchError`; invalid ids raise
:class:`AgentRuntimeDescriptorRefusal`.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from functools import cache
from pathlib import Path

from contracts.agent_runtime_descriptor import AgentRuntimeDescriptor, Member
from contracts.agent_runtime_descriptor_data import AGENT_RUNTIME_DESCRIPTORS
from contracts.agent_runtime_refusal import Reason

from .rules import (
    SINGLETON_ROLES,
    AgentRuntimeDescriptorRefusal,
    RefusalItem,
    parse_template_token,
    validate_agent_runtime_descriptor,
)

_REQUIRED = "required"
_REQUIRED_WHEN_VERIFIED = "required_when_verified"


class AgentRuntimeLaunchError(ValueError):
    """The launch context does not supply something the descriptor's argv needs."""


@dataclass(frozen=True)
class LaunchContext:
    """The host facts a descriptor's templates are resolved against."""

    workspace_root: Path
    state_config_dir: Path
    state_data_dir: Path
    loopback_host: str
    supervisor_port: int
    runtime_port: int
    config_source_dir: Path | None = None
    payload_root: Path | None = None


@dataclass(frozen=True)
class MemberInspection:
    """Which declared members the payload at a given root actually has."""

    present: tuple[str, ...]
    missing_required: tuple[str, ...]
    missing_relaxable: tuple[str, ...]

    @property
    def missing(self) -> tuple[str, ...]:
        return self.missing_required + self.missing_relaxable


@dataclass(frozen=True)
class ResolvedEnv:
    """A resolved env template, plus the names dropped for an unsupplied fact."""

    values: Mapping[str, str]
    omitted: tuple[str, ...]


@dataclass(frozen=True)
class ResolvedLaunch:
    """A descriptor resolved against one host, ready to hand to a spawner."""

    program: Path
    argv: tuple[str, ...]
    env: Mapping[str, str]
    omitted_env: tuple[str, ...]
    skipped_guard_members: tuple[str, ...]


def payload_backed_runtime_ids() -> tuple[str, ...]:
    """Runtime ids that ship a descriptor, sorted."""
    return tuple(sorted(AGENT_RUNTIME_DESCRIPTORS))


def descriptor_for(runtime_id: str) -> AgentRuntimeDescriptor:
    """Return the validated descriptor for a runtime id, or refuse if it has none."""
    if runtime_id not in AGENT_RUNTIME_DESCRIPTORS:
        raise AgentRuntimeDescriptorRefusal(
            (RefusalItem(Reason.runtime_id_not_payload_backed, None),)
        )
    return _validated(runtime_id)


@cache
def _validated(runtime_id: str) -> AgentRuntimeDescriptor:
    return validate_agent_runtime_descriptor(AGENT_RUNTIME_DESCRIPTORS[runtime_id])


def required_member_paths(descriptor: AgentRuntimeDescriptor) -> tuple[str, ...]:
    """Members that must exist in every payload, verified or not."""
    return tuple(m.path for m in descriptor.members if m.requirement.value == _REQUIRED)


def relaxable_member_paths(descriptor: AgentRuntimeDescriptor) -> tuple[str, ...]:
    """Members a verified payload must have but an unverified source tree may lack."""
    return tuple(
        m.path
        for m in descriptor.members
        if m.requirement.value == _REQUIRED_WHEN_VERIFIED
    )


def verified_payload_member_paths(descriptor: AgentRuntimeDescriptor) -> tuple[str, ...]:
    """Every declared member, which is what a verified payload must carry."""
    return tuple(m.path for m in descriptor.members)


def singleton_member_path(descriptor: AgentRuntimeDescriptor, role: str) -> str | None:
    """The path of the member holding a singleton role, if the descriptor declares one."""
    if role not in SINGLETON_ROLES:
        raise ValueError(f"'{role}' is not a singleton role")
    return next((m.path for m in descriptor.members if m.role.value == role), None)


def executable_member_paths(descriptor: AgentRuntimeDescriptor) -> tuple[str, ...]:
    """Members declared executable, in declaration order."""
    return tuple(m.path for m in descriptor.members if m.access.execute)


def required_executable_paths(descriptor: AgentRuntimeDescriptor) -> tuple[str, ...]:
    """Members a launch layer must find under the payload root before spawning.

    Non-executable required members are mode-dependent config data, so the payload
    layer verifies them instead.
    """
    return tuple(
        m.path
        for m in descriptor.members
        if m.access.execute and m.requirement.value == _REQUIRED
    )


def member_at(descriptor: AgentRuntimeDescriptor, path: str) -> Member | None:
    return next((m for m in descriptor.members if m.path == path), None)


def member_host_path(payload_root: Path, member_path: str) -> Path:
    """Resolve a declared member path under a payload root."""
    return payload_root.joinpath(*member_path.split("/"))


def inspect_members(
    descriptor: AgentRuntimeDescriptor,
    payload_root: Path,
) -> MemberInspection:
    """Report which declared members exist under ``payload_root``."""
    present: list[str] = []
    missing_required: list[str] = []
    missing_relaxable: list[str] = []
    for member in descriptor.members:
        if member_host_path(payload_root, member.path).exists():
            present.append(member.path)
        elif member.requirement.value == _REQUIRED:
            missing_required.append(member.path)
        else:
            missing_relaxable.append(member.path)
    return MemberInspection(
        present=tuple(present),
        missing_required=tuple(missing_required),
        missing_relaxable=tuple(missing_relaxable),
    )


def resolve_env_template(
    descriptor: AgentRuntimeDescriptor,
    context: LaunchContext,
) -> ResolvedEnv:
    """Resolve the env template, naming rather than guessing what it cannot supply."""
    resolve = _Resolver(context)
    values: dict[str, str] = {}
    omitted: list[str] = []
    for name, template in descriptor.launch.env_template.items():
        value = resolve.token(template)
        if value is None:
            omitted.append(name)
        else:
            values[name] = value
    return ResolvedEnv(values=values, omitted=tuple(omitted))


def resolve_launch(
    descriptor: AgentRuntimeDescriptor,
    context: LaunchContext,
    inspection: MemberInspection | None = None,
) -> ResolvedLaunch:
    """Resolve the launch templates against one host, reporting every gap.

    Missing required members are the caller's to reject; resolution stays pure.
    """
    payload_root = context.payload_root
    if payload_root is None:
        raise AgentRuntimeLaunchError("launch resolution requires a payload root")
    facts = inspection or inspect_members(descriptor, payload_root)
    absent = frozenset(facts.missing)
    resolve = _Resolver(context)

    argv: list[str] = []
    skipped: list[str] = []
    for group in descriptor.launch.argv_groups:
        guard = group.present_member
        if guard is not None and guard in absent:
            skipped.append(guard)
            continue
        for token in group.tokens:
            value = resolve.token(token)
            if value is None:
                # An argv token cannot be dropped without changing the command
                # line, so an unsupplied placeholder is fatal rather than elided.
                raise AgentRuntimeLaunchError(
                    f"launch context supplies no value for argv token '{token}'"
                )
            argv.append(value)

    resolved_env = resolve_env_template(descriptor, context)
    return ResolvedLaunch(
        program=member_host_path(payload_root, descriptor.launch.program_member),
        argv=tuple(argv),
        env=resolved_env.values,
        omitted_env=resolved_env.omitted,
        skipped_guard_members=tuple(skipped),
    )


class _Resolver:
    """Turns one validated template token into a host string, or None if unsupplied."""

    def __init__(self, context: LaunchContext) -> None:
        self._paths: dict[str, Path | None] = {
            "payload_root": context.payload_root,
            "workspace_root": context.workspace_root,
            "state_config_dir": context.state_config_dir,
            "state_data_dir": context.state_data_dir,
            "config_source_dir": context.config_source_dir,
        }
        self._scalars: dict[str, str] = {
            "loopback_host": context.loopback_host,
            "supervisor_port": str(context.supervisor_port),
            "runtime_port": str(context.runtime_port),
        }
        self._payload_root = context.payload_root

    def token(self, token: str) -> str | None:
        parsed = parse_template_token(token)
        if parsed is None:
            # validate_agent_runtime_descriptor rejects an unparseable token, so
            # reaching here means the descriptor bypassed the rules.
            raise AgentRuntimeDescriptorRefusal(
                (RefusalItem(Reason.template_token_shape_invalid, None),)
            )
        if parsed.kind == "literal":
            return parsed.value
        if parsed.kind == "scalar":
            return self._scalars[parsed.value]
        if parsed.kind == "member":
            root = self._payload_root
            return None if root is None else str(member_host_path(root, parsed.value))
        base = self._paths[parsed.value]
        return None if base is None else str(base.joinpath(*parsed.segments))
