"""The versioned ACL policy descriptor, and the refusal type its consumers raise.

The descriptor itself is generated from ``shared/contracts/src/acl-policy-descriptor.ts``
and committed under ``shared/contracts/generated``. This module is the Python door
onto it: it validates it, hands out copies rather than the shared dict, and answers
"what is the policy for this class" and "what is the policy for this managed root".

The descriptor is keyed by policy class and by managed root scope. It names no
path, so adding a workspace root cannot change it.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Iterable, Mapping
from copy import deepcopy
from dataclasses import dataclass
from typing import Any

from contracts.acl_policy_descriptor import AclPolicyDescriptor
from contracts.acl_policy_descriptor_data import (
    ACL_POLICY_CONTRACT_VERSION,
    ACL_POLICY_DESCRIPTOR,
    ACL_POLICY_RULES,
    ACL_POLICY_VERSION,
)
from contracts.acl_policy_refusal import AclPolicyRefusal as AclPolicyRefusalContract

__all__ = [
    "ACL_POLICY_CONTRACT_VERSION",
    "ACL_POLICY_VERSION",
    "OWNER_SID_PATTERN",
    "AclPolicyRefusalError",
    "RefusalItem",
    "descriptor_data",
    "descriptor_digest",
    "is_shipped_descriptor",
    "managed_root_policy",
    "planner_refusal_reasons",
    "principal_tier",
    "recovery_principals",
    "validate_descriptor",
    "workspace_root_policy",
]

#: A Windows SID in string form.
#:
#: Compiled from the pattern the contract publishes rather than hand-copied. The same
#: grammar written out twice is two grammars that agree until one of them is edited,
#: and this one decides whether an owner SID is refused.
OWNER_SID_PATTERN = re.compile(ACL_POLICY_RULES["owner_sid_pattern"])


@dataclass(frozen=True)
class RefusalItem:
    """One refusal, with where it is.

    A locator holds codes, ids and root-relative paths. It never holds an absolute
    path, because a refusal is a thing we log and hand around.
    """

    reason: str
    policy_class: str | None = None
    managed_root_scope: str | None = None
    tier: str | None = None
    root_id: str | None = None
    relative_path: str | None = None

    def as_contract(self) -> dict[str, Any]:
        return {
            "reason": self.reason,
            "locator": {
                "policy_class": self.policy_class,
                "managed_root_scope": self.managed_root_scope,
                "tier": self.tier,
                "root_id": self.root_id,
                "relative_path": self.relative_path,
            },
        }


class AclPolicyRefusalError(ValueError):
    """Raised when an ACL policy input is refused.

    Carries every refusal, not the first one. A caller fixing a root set wants the
    whole list, and a report that stops at the first problem invites the belief that
    fixing it was enough.
    """

    def __init__(self, items: Iterable[RefusalItem]) -> None:
        self.items: tuple[RefusalItem, ...] = tuple(items)
        if not self.items:
            raise ValueError("a refusal names at least one reason")
        super().__init__("; ".join(sorted({item.reason for item in self.items})))

    @property
    def reasons(self) -> tuple[str, ...]:
        """The distinct reasons, sorted, for a caller that only decides on codes."""
        return tuple(sorted({item.reason for item in self.items}))

    def as_contract(self) -> dict[str, Any]:
        """The refusal as the wire contract, validated through the generated model."""
        payload = {
            "contract_version": ACL_POLICY_CONTRACT_VERSION,
            "refusals": [item.as_contract() for item in self.items],
        }
        return AclPolicyRefusalContract.model_validate(payload).model_dump(mode="json")


def descriptor_data() -> dict[str, Any]:
    """A private copy of the shipped descriptor, as plain data."""
    return deepcopy(ACL_POLICY_DESCRIPTOR)


def validate_descriptor(payload: Mapping[str, Any]) -> AclPolicyDescriptor:
    """Field shapes for the descriptor, and nothing else.

    The cross-field rules (every class covered, placeholders only under
    ``managed_default``, no allow ACE granting ``FILE_DELETE_CHILD`` inside a
    workspace root, canonical deny-before-allow ordering) are refused in
    ``shared/contracts/src/acl-policy-descriptor.ts`` and tested there, because they
    guard a descriptor this repo ships rather than an input a host supplies. They do
    not survive codegen, which is what ``is_shipped_descriptor`` below exists for: a
    descriptor that passes this function has a valid shape and no checked policy.
    """
    return AclPolicyDescriptor.model_validate(payload)


def descriptor_digest(payload: Mapping[str, Any]) -> str:
    """The canonical digest of a descriptor.

    ``sort_keys`` with no separator padding, and non-ASCII text written as itself, is
    the same canonical form ``canonicalAclPolicyJson`` produces on the TypeScript side,
    so a digest computed here can be compared to the one the generator published. A
    test pins that agreement, because the two implementations are the only thing
    holding it up.
    """
    canonical = json.dumps(
        payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def is_shipped_descriptor(payload: Mapping[str, Any]) -> bool:
    """Whether this is the descriptor the contract's own rules were checked against.

    The policy rules that matter most - every class covered, no ``FILE_DELETE_CHILD``
    inside a workspace root, a mask that denies every tier everything - are Zod
    cross-field refinements with no JSON Schema form, so nothing on this side of the
    boundary re-derives them. Rather than restate them in a second language, the
    planner insists on the artifact they were run over.
    """
    return descriptor_digest(payload) == ACL_POLICY_RULES["descriptor_digest"]


def workspace_root_policy(
    policy_class: str, descriptor: Mapping[str, Any] | None = None
) -> Mapping[str, Any] | None:
    """A copy of the policy for one policy class, or None if it is not covered."""
    source = ACL_POLICY_DESCRIPTOR if descriptor is None else descriptor
    for policy in source.get("workspace_root_policies", ()):
        if policy.get("policy_class") == policy_class:
            return deepcopy(policy)
    return None


def managed_root_policy(
    managed_root_scope: str, descriptor: Mapping[str, Any] | None = None
) -> Mapping[str, Any] | None:
    """A copy of the policy for one managed root, or None if it is not covered."""
    source = ACL_POLICY_DESCRIPTOR if descriptor is None else descriptor
    for policy in source.get("managed_root_policies", ()):
        if policy.get("managed_root_scope") == managed_root_scope:
            return deepcopy(policy)
    return None


def recovery_principals() -> tuple[str, ...]:
    """The principals that must keep reaching every root."""
    return tuple(ACL_POLICY_RULES["recovery_principals"])


def planner_refusal_reasons() -> tuple[str, ...]:
    """The refusal reasons this planner owns, as opposed to the descriptor's own."""
    return tuple(ACL_POLICY_RULES["planner_refusal_reasons"])


def principal_tier() -> Mapping[str, str | None]:
    """Which isolation tier each principal stands for, None for a recovery one."""
    return dict(ACL_POLICY_RULES["principal_tier"])
