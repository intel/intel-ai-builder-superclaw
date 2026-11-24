"""Build the governed P5 start policy and stage its verified payload."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

from contracts.native_path_set import NativePathSetShape
from sandbox_policy import plan_acl_policy

from ..native_isolation import (
    build_native_path_set,
    observe_workspace_root_facts,
    runtime_workspace_root,
)
from ..payload_integrity import VerifiedPayload
from ..payload_staging import stage_verified_payload
from .start import BrokerStartPolicy


@dataclass(frozen=True)
class PreparedBrokerPolicy:
    path_set: NativePathSetShape
    policy: BrokerStartPolicy
    payload: VerifiedPayload


def build_broker_start_policy(
    *,
    owner_sid: str,
    session_id: str,
    env: Mapping[str, str] | None = None,
) -> tuple[NativePathSetShape, BrokerStartPolicy]:
    workspace = runtime_workspace_root(env)
    workspace.mkdir(parents=True, exist_ok=True)
    facts = observe_workspace_root_facts(str(workspace))
    path_set = build_native_path_set(
        owner_sid=owner_sid,
        session_id=session_id,
        # No payload_version argument on purpose: the payload directory is the fixed
        # `payload/current`, so a payload content change leaves the path set - and the
        # provisioning evidence digested from it - untouched. What is in that directory is
        # `stage_verified_payload`'s business, decided by the content fingerprint.
        managed_default_facts=facts,
        env=env,
    )
    path_set_json = path_set.model_dump(mode="json")
    acl_plan = plan_acl_policy(
        workspace_roots=path_set.workspace_roots,
        owner_sid=owner_sid,
    ).model_dump(mode="json")
    return path_set, BrokerStartPolicy(path_set=path_set_json, acl_plan=acl_plan)


def prepare_broker_start_policy(
    *,
    owner_sid: str,
    session_id: str,
    source_payload: VerifiedPayload,
    env: Mapping[str, str] | None = None,
) -> PreparedBrokerPolicy:
    workspace = runtime_workspace_root(env)
    workspace.mkdir(parents=True, exist_ok=True)
    facts = observe_workspace_root_facts(str(workspace))
    path_set = build_native_path_set(
        owner_sid=owner_sid,
        session_id=session_id,
        # No payload_version argument on purpose: the payload directory is the fixed
        # `payload/current`, so a payload content change leaves the path set - and the
        # provisioning evidence digested from it - untouched. What is in that directory is
        # `stage_verified_payload`'s business, decided by the content fingerprint.
        managed_default_facts=facts,
        env=env,
    )
    staged = stage_verified_payload(source_payload, path_set)
    path_set_json = path_set.model_dump(mode="json")
    acl_plan = plan_acl_policy(
        workspace_roots=path_set.workspace_roots,
        owner_sid=owner_sid,
    ).model_dump(mode="json")
    return PreparedBrokerPolicy(
        path_set=path_set,
        policy=BrokerStartPolicy(path_set=path_set_json, acl_plan=acl_plan),
        payload=staged,
    )