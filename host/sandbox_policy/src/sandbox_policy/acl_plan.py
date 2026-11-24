"""The required-descriptor planner.

Input: one live workspace root set, plus the SID that is to own the managed roots.
Output: the security descriptor every root and every placeholder is required to
have, as an ``AclPolicyPlan``.

The plan is the descriptor resolved against the root set, so a second workspace
root produces one more member here and changes nothing in the descriptor. That is
not an incidental property; it is the reason the descriptor is keyed by policy
class, and ``tests/test_acl_plan.py`` holds the line.

Nothing here applies anything. A plan is a statement of what should be true.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from contracts.acl_policy_plan import AclPolicyPlan
from pydantic import ValidationError

from sandbox_policy.acl_descriptors import (
    ACL_POLICY_CONTRACT_VERSION,
    OWNER_SID_PATTERN,
    AclPolicyRefusalError,
    RefusalItem,
    descriptor_data,
    is_shipped_descriptor,
    validate_descriptor,
)

__all__ = ["WORKSPACE_ROOT_SET_MAX_MEMBERS", "plan_acl_policy"]

#: Mirrors the workspace root set contract. Restated because the planner refuses on
#: it, and a limit a caller cannot see the planner enforce is a limit that surprises.
WORKSPACE_ROOT_SET_MAX_MEMBERS = 8


def _member_field(member: object, field: str) -> Any:
    """One field of a root set member, whether it arrived as a mapping or a model.

    The root set is validated before it gets here, by
    ``sandbox_manager.native_isolation.path_set_rules``. Accepting both shapes is
    what keeps this package from importing that one, which would put L2 underneath
    L1.
    """
    if isinstance(member, Mapping):
        return member.get(field)
    return getattr(member, field, None)


def _as_text(value: Any) -> str | None:
    """A plain string, unwrapping the enum a generated model hands back."""
    if isinstance(value, str):
        return value
    inner = getattr(value, "value", None)
    return inner if isinstance(inner, str) else None


def _required(dacl: Mapping[str, Any], owner_sid: str, policy_version: int) -> dict[str, Any]:
    """One DACL from the descriptor, stamped with its owner and policy version."""
    return {
        "owner_sid": owner_sid,
        "policy_version": policy_version,
        "dacl_protected": dacl["dacl_protected"],
        "aces": [dict(ace) for ace in dacl["aces"]],
    }


def plan_acl_policy(
    *,
    workspace_roots: Sequence[object],
    owner_sid: str,
) -> AclPolicyPlan:
    """Resolve the ACL policy descriptor against one workspace root set.

    ``workspace_roots`` is the ``workspace_roots`` member list of a validated native
    path set: each entry needs a ``root_id`` and a ``policy_class`` and may carry
    anything else. Members keep their input order, so a plan reads in the same order
    as the root set it came from.

    Raises ``AclPolicyRefusalError`` carrying every refusal. The planner re-checks
    only the invariants it depends on itself: it does not restate the workspace root
    set contract, which the caller validates first.

    There is deliberately no way to hand in a descriptor. The descriptor's policy
    rules are enforced at generation time on the TypeScript side and do not survive
    into the generated Pydantic model, so a descriptor argument would be a public door
    onto planning from a policy nobody checked.
    """
    return _plan_from_descriptor(
        workspace_roots=workspace_roots, owner_sid=owner_sid, descriptor=descriptor_data()
    )


def _plan_from_descriptor(
    *,
    workspace_roots: Sequence[object],
    owner_sid: str,
    descriptor: Mapping[str, Any],
) -> AclPolicyPlan:
    """The planner body, over an explicit descriptor.

    Private, and the tests that pass something other than the shipped descriptor are
    the reason it exists: they have to be able to prove that a descriptor which is not
    the shipped one is refused, which means being able to offer one.
    """
    source = dict(descriptor)
    refusals: list[RefusalItem] = []

    try:
        validate_descriptor(source)
    except ValidationError:
        # A malformed descriptor is a build problem, not a host problem, and there is
        # nothing useful to plan from it, so this one refusal stands alone.
        raise AclPolicyRefusalError([RefusalItem(reason="descriptor_shape_invalid")]) from None

    if not is_shipped_descriptor(source):
        # Well-shaped and still not plannable. Every rule that makes the descriptor a
        # boundary rather than a list of ACEs lives in a Zod refinement that codegen
        # does not carry, so shape is all the check above proved.
        raise AclPolicyRefusalError(
            [RefusalItem(reason="descriptor_not_the_shipped_policy")]
        ) from None

    if not isinstance(owner_sid, str) or OWNER_SID_PATTERN.match(owner_sid) is None:
        refusals.append(RefusalItem(reason="owner_sid_shape_invalid"))

    # One policy per class, without checking for a duplicate: the digest gate above
    # already established that this is the descriptor whose own rules refuse a
    # duplicated class, so a check here would be that rule's second spelling.
    policy_by_class = {
        policy["policy_class"]: policy for policy in source["workspace_root_policies"]
    }

    members: list[tuple[str, str]] = []
    if not isinstance(workspace_roots, Sequence) or isinstance(workspace_roots, (str, bytes)):
        refusals.append(RefusalItem(reason="root_set_shape_invalid"))
        workspace_roots = ()

    for member in workspace_roots:
        root_id = _as_text(_member_field(member, "root_id"))
        policy_class = _as_text(_member_field(member, "policy_class"))
        if root_id is None or policy_class is None:
            refusals.append(RefusalItem(reason="root_set_shape_invalid", root_id=root_id))
            continue
        if policy_class not in policy_by_class:
            refusals.append(
                RefusalItem(reason="root_set_policy_class_unknown", root_id=root_id)
            )
            continue
        members.append((root_id, policy_class))

    if not members and not refusals:
        # An empty root set is not a plan for nothing; it is a caller that lost its
        # root set on the way here.
        refusals.append(RefusalItem(reason="root_set_shape_invalid"))
    if len(members) > WORKSPACE_ROOT_SET_MAX_MEMBERS:
        # Its own reason, not the catch-all: too many roots is the one refusal here a
        # user can act on, and "the shape is wrong" does not tell them to remove one.
        refusals.append(RefusalItem(reason="root_set_member_count_above_bound"))

    seen: set[str] = set()
    for root_id, _policy_class in members:
        if root_id in seen:
            refusals.append(RefusalItem(reason="root_set_root_id_duplicated", root_id=root_id))
        seen.add(root_id)

    managed_defaults = [
        root_id for root_id, policy_class in members if policy_class == "managed_default"
    ]
    if members and len(managed_defaults) != 1:
        refusals.append(
            RefusalItem(
                reason="root_set_managed_default_not_unique",
                policy_class="managed_default",
                root_id=managed_defaults[0] if managed_defaults else None,
            )
        )

    if refusals:
        raise AclPolicyRefusalError(refusals)

    policy_version = int(source["policy_version"])
    workspace_root_plans: list[dict[str, Any]] = []
    for root_id, policy_class in members:
        policy = policy_by_class[policy_class]
        workspace_root_plans.append(
            {
                "root_id": root_id,
                "policy_class": policy_class,
                "required": _required(policy["root_dacl"], owner_sid, policy_version),
                "placeholders": [
                    {
                        "relative_path": placeholder["relative_path"],
                        "placeholder_kind": placeholder["placeholder_kind"],
                        "placeholder_role": placeholder["placeholder_role"],
                        "required": _required(placeholder["dacl"], owner_sid, policy_version),
                    }
                    for placeholder in policy["protected_placeholders"]
                ],
            }
        )

    managed_root_plans = [
        {
            "managed_root_scope": policy["managed_root_scope"],
            "required": _required(policy["root_dacl"], owner_sid, policy_version),
            "tier_subtrees": [
                {
                    "tier": subtree["tier"],
                    "required": _required(subtree["dacl"], owner_sid, policy_version),
                }
                for subtree in policy["tier_subtree_dacls"]
            ],
            "tier_openings": [
                {
                    "tier": opening["tier"],
                    "relative_path": opening["relative_path"],
                    "required": _required(opening["dacl"], owner_sid, policy_version),
                }
                for opening in policy["tier_openings"]
            ],
        }
        for policy in source["managed_root_policies"]
    ]

    return AclPolicyPlan.model_validate(
        {
            "contract_version": ACL_POLICY_CONTRACT_VERSION,
            "policy_version": policy_version,
            "workspace_root_plans": workspace_root_plans,
            "managed_root_plans": managed_root_plans,
        }
    )
