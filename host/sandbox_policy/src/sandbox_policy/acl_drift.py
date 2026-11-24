"""The drift checker: does what a reader found still match the plan?

Fail closed. A planned object with no readback is drift, not an unknown, because
"we did not look" and "it is correct" must not report the same way. So is a root
that is there but whose DACL grew an ACE nobody planned.

A clean report says the readback matched the plan. It does not say the boundary
held, and it says nothing about containment or egress. Those are other evidence,
from other slices.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from contracts.acl_policy_drift_report import AclPolicyDriftReport
from contracts.acl_policy_observation import AclPolicyObservation
from contracts.acl_policy_plan import AclPolicyPlan

from sandbox_policy.acl_descriptors import (
    ACL_POLICY_CONTRACT_VERSION,
    recovery_principals,
)

__all__ = ["check_acl_policy_drift"]

#: The right that lets a child be replaced through its parent. No allow ACE inside
#: a workspace root may carry it, whoever it names.
DELETE_CHILD = "FILE_DELETE_CHILD"

# Objects the elevated broker derives or creates are owned by Administrators. Caller-named roots keep
# the requesting owner; see native_isolation_broker's ObjectOwnership rules.
ADMINISTRATORS_SID = "S-1-5-32-544"
ADMINISTRATORS_OWNED_MANAGED_ROOTS = frozenset({"protected_root", "isolation_root"})


def _plain(model_type: Any, value: Any) -> dict[str, Any]:
    """One input as plain JSON-shaped data, through its generated model.

    Validated rather than trusted, and this is not ceremony. An unvalidated mapping
    that is missing ``workspace_root_plans`` reads as a plan for no roots, and a plan
    for no roots has nothing to disagree with, so the checker would report
    ``no_drift_observed`` for a host it never looked at. The same argument covers
    ``contract_version``: a readback written by a reader that speaks a different
    version of this contract must not be silently compared field by field.

    Raises ``pydantic.ValidationError``, which is the right shape of failure. A
    malformed plan is a caller bug, not drift, and returning a verdict for it would
    make the two indistinguishable.
    """
    if isinstance(value, model_type):
        return value.model_dump(mode="json")
    return model_type.model_validate(value).model_dump(mode="json")


def _finding(
    reason: str,
    detail: str,
    *,
    policy_class: str | None = None,
    managed_root_scope: str | None = None,
    tier: str | None = None,
    root_id: str | None = None,
    relative_path: str | None = None,
) -> dict[str, Any]:
    return {
        "reason": reason,
        "locator": {
            "policy_class": policy_class,
            "managed_root_scope": managed_root_scope,
            "tier": tier,
            "root_id": root_id,
            "relative_path": relative_path,
        },
        "detail": detail,
    }


def _ace_key(ace: Mapping[str, Any]) -> tuple[str, str, tuple[str, ...], str]:
    """An ACE reduced to what Windows acts on.

    Rights are compared as a set: their order in a descriptor is ours, for readable
    diffs, and means nothing to an access check.
    """
    return (
        str(ace.get("ace_kind")),
        str(ace.get("principal")),
        tuple(sorted(str(right) for right in ace.get("rights", ()))),
        str(ace.get("inheritance")),
    )


def _describe(ace: Mapping[str, Any]) -> str:
    key = _ace_key(ace)
    return f"{key[0]} {key[1]} {'|'.join(key[2])} ({key[3]})"


def _index_by(
    items: Sequence[Mapping[str, Any]],
    field: str,
    duplicate_locator: Any,
) -> tuple[dict[str, Mapping[str, Any]], list[dict[str, Any]]]:
    """A readback indexed by one field, plus a finding for anything named twice.

    A dict comprehension would keep the last entry, which means choosing which half of
    the evidence to discard. Two readbacks of one object are two claims about it, and
    if they disagree, the one that happened to be second is not the truth.
    """
    indexed: dict[str, Mapping[str, Any]] = {}
    findings: list[dict[str, Any]] = []
    for item in items:
        key = str(item.get(field))
        if key in indexed:
            findings.append(
                _finding(
                    "observation_duplicated",
                    f"the readback names {field} {key} more than once",
                    **duplicate_locator(key),
                )
            )
            continue
        indexed[key] = item
    return indexed, findings


def _compare_security(
    required: Mapping[str, Any],
    observed: Mapping[str, Any],
    locator: Mapping[str, Any],
    *,
    deny_absent_reason: str,
    refuse_delete_child: bool = False,
    expected_owner_sid: str | None = None,
) -> list[dict[str, Any]]:
    """One required security descriptor against one readback.

    ``deny_absent_reason`` has no default. A missing deny ACE on a mask and a missing
    allow ACE on a root are both "the plan is not what is there", but only the first
    one means protected content is now reachable, and a default would quietly file it
    under the milder reason at whichever call site forgot to pass it.
    """
    findings: list[dict[str, Any]] = []

    if observed.get("policy_version") != required.get("policy_version"):
        findings.append(
            _finding(
                "policy_version_mismatch",
                f"planned policy version {required.get('policy_version')}, "
                f"observed {observed.get('policy_version')}",
                **locator,
            )
        )
    planned_owner = expected_owner_sid or required.get("owner_sid")
    if observed.get("owner_sid") != planned_owner:
        findings.append(
            _finding(
                "owner_sid_mismatch",
                f"planned owner {planned_owner}, observed {observed.get('owner_sid')}",
                **locator,
            )
        )
    if observed.get("dacl_protected") is not True:
        findings.append(
            _finding(
                "dacl_not_protected",
                "the DACL inherits from above, so the planned ACEs are not the whole story",
                **locator,
            )
        )

    required_aces = list(required.get("aces", ()))
    observed_aces = list(observed.get("aces", ()))
    observed_keys = {_ace_key(ace) for ace in observed_aces}
    required_keys = {_ace_key(ace) for ace in required_aces}

    for ace in required_aces:
        if _ace_key(ace) in observed_keys:
            continue
        reason = (
            deny_absent_reason if str(ace.get("ace_kind")) == "deny" else "required_ace_absent"
        )
        findings.append(_finding(reason, f"planned ACE absent: {_describe(ace)}", **locator))

    for ace in observed_aces:
        if _ace_key(ace) not in required_keys:
            findings.append(
                _finding(
                    "unexpected_ace_present",
                    f"ACE nobody planned: {_describe(ace)}",
                    **locator,
                )
            )

    # Order is compared even though the ACEs themselves are compared as sets, because
    # order is the one property of a DACL that Windows acts on and a set cannot hold:
    # an access check stops at the first ACE that matches, so a deny ACE moved below
    # the allow ACE it was meant to override stops overriding anything while the DACL
    # still lists every ACE the plan named.
    kinds = [str(ace.get("ace_kind")) for ace in observed_aces]
    if "allow" in kinds and "deny" in kinds[kinds.index("allow") :]:
        findings.append(
            _finding(
                "dacl_not_canonically_ordered",
                "a deny ACE is listed after an allow ACE, so it is evaluated too late",
                **locator,
            )
        )

    allowed_principals = {
        str(ace.get("principal")) for ace in observed_aces if str(ace.get("ace_kind")) == "allow"
    }
    for principal in recovery_principals():
        if principal not in allowed_principals:
            findings.append(
                _finding(
                    "recovery_principal_absent",
                    f"{principal} can no longer reach this object",
                    **locator,
                )
            )

    if refuse_delete_child:
        for ace in observed_aces:
            if str(ace.get("ace_kind")) != "allow":
                continue
            if DELETE_CHILD in {str(right) for right in ace.get("rights", ())}:
                findings.append(
                    _finding(
                        "delete_child_granted_on_workspace_root",
                        f"{ace.get('principal')} can replace children through the parent",
                        **locator,
                    )
                )

    return findings


def _check_placeholders(
    planned: Sequence[Mapping[str, Any]],
    observed: Sequence[Mapping[str, Any]],
    *,
    policy_class: str,
    root_id: str,
) -> list[dict[str, Any]]:
    observed_by_path, findings = _index_by(
        observed,
        "relative_path",
        lambda path: {
            "policy_class": policy_class,
            "root_id": root_id,
            "relative_path": path,
        },
    )

    for placeholder in planned:
        relative_path = str(placeholder.get("relative_path"))
        locator = {
            "policy_class": policy_class,
            "root_id": root_id,
            "relative_path": relative_path,
        }
        observation = observed_by_path.pop(relative_path, None)
        if observation is None:
            findings.append(
                _finding("observation_absent", "no readback for a planned placeholder", **locator)
            )
            continue
        if observation.get("present") is not True:
            findings.append(
                _finding(
                    "placeholder_absent",
                    "the mask is gone, so the path it stood in for is whatever is there now",
                    **locator,
                )
            )
            continue
        if observation.get("is_reparse_point") is True:
            findings.append(
                _finding(
                    "placeholder_is_reparse_point",
                    "a placeholder became a link, which is a window onto the content it masked",
                    **locator,
                )
            )
        if (
            str(placeholder.get("placeholder_role")) == "protected_mask"
            and observation.get("is_empty") is not True
        ):
            # Only a mask must be empty. A guard ancestor holds the mask below it.
            findings.append(
                _finding(
                    "placeholder_not_empty",
                    "a mask holds content, so it is no longer standing in for anything",
                    **locator,
                )
            )
        security = observation.get("security")
        if not isinstance(security, Mapping):
            findings.append(
                _finding(
                    "observation_absent",
                    "the placeholder was found but its security descriptor was not read",
                    **locator,
                )
            )
            continue
        findings.extend(
            _compare_security(
                placeholder["required"],
                security,
                locator,
                deny_absent_reason="placeholder_deny_ace_absent",
                refuse_delete_child=True,
                expected_owner_sid=ADMINISTRATORS_SID,
            )
        )

    for relative_path in observed_by_path:
        findings.append(
            _finding(
                "placeholder_not_in_plan",
                "a placeholder nobody planned",
                policy_class=policy_class,
                root_id=root_id,
                relative_path=relative_path,
            )
        )

    return findings


def _check_tier_subtrees(
    planned: Sequence[Mapping[str, Any]],
    observed: Sequence[Mapping[str, Any]],
    *,
    managed_root_scope: str,
) -> list[dict[str, Any]]:
    """The per-tier subtrees of one managed root against their readback.

    Checked separately from the managed root above them because they are where the
    tiers are actually told apart. A managed root whose own DACL matches the plan
    while the subtree inside it grants a tier more than its own says nothing useful
    was verified, and before this loop existed that was reported as no drift.
    """
    observed_by_tier, findings = _index_by(
        observed,
        "tier",
        lambda tier: {"managed_root_scope": managed_root_scope, "tier": tier},
    )

    for subtree in planned:
        tier = str(subtree.get("tier"))
        locator = {"managed_root_scope": managed_root_scope, "tier": tier}
        observation = observed_by_tier.pop(tier, None)
        if observation is None:
            findings.append(
                _finding("observation_absent", "no readback for a planned subtree", **locator)
            )
            continue
        if observation.get("present") is not True:
            findings.append(
                _finding(
                    "root_absent",
                    "the tier's own subtree is not there, so its files have no separate policy",
                    **locator,
                )
            )
            continue
        security = observation.get("security")
        if not isinstance(security, Mapping):
            findings.append(
                _finding(
                    "observation_absent",
                    "the subtree was found but its security descriptor was not read",
                    **locator,
                )
            )
            continue
        findings.extend(
            _compare_security(
                subtree["required"],
                security,
                locator,
                deny_absent_reason="required_ace_absent",
                expected_owner_sid=ADMINISTRATORS_SID,
            )
        )

    for tier in observed_by_tier:
        findings.append(
            _finding(
                "tier_subtree_not_in_plan",
                "a tier subtree the plan does not cover",
                managed_root_scope=managed_root_scope,
                tier=tier,
            )
        )

    return findings


def _check_tier_openings(
    planned: Sequence[Mapping[str, Any]],
    observed: Sequence[Mapping[str, Any]],
    *,
    managed_root_scope: str,
) -> list[dict[str, Any]]:
    """The directories a tier lets another tier into, against their readback.

    Checked on their own because an opening is the one place a tier's subtree is deliberately
    reachable from outside, so a subtree that matches its plan while its opening grants the
    other side more than the plan says is a leak this loop alone can see.
    """

    def keyed(items: Sequence[Mapping[str, Any]]) -> list[Mapping[str, Any]]:
        return [{**item, "key": f"{item.get('tier')}/{item.get('relative_path')}"} for item in items]

    def locator_for(key: str) -> dict[str, Any]:
        tier, _, relative_path = key.partition("/")
        return {"managed_root_scope": managed_root_scope, "tier": tier, "relative_path": relative_path}

    observed_by_key, findings = _index_by(keyed(observed), "key", locator_for)

    for opening in keyed(planned):
        key = str(opening["key"])
        locator = locator_for(key)
        observation = observed_by_key.pop(key, None)
        if observation is None:
            findings.append(
                _finding("observation_absent", "no readback for a planned opening", **locator)
            )
            continue
        if observation.get("present") is not True:
            findings.append(
                _finding("root_absent", "the opening is not there, so its two sides have no path", **locator)
            )
            continue
        security = observation.get("security")
        if not isinstance(security, Mapping):
            findings.append(
                _finding(
                    "observation_absent",
                    "the opening was found but its security descriptor was not read",
                    **locator,
                )
            )
            continue
        findings.extend(
            _compare_security(
                opening["required"],
                security,
                locator,
                deny_absent_reason="required_ace_absent",
                expected_owner_sid=ADMINISTRATORS_SID,
            )
        )

    for key in observed_by_key:
        findings.append(
            _finding(
                "tier_opening_not_in_plan",
                "a tier opening the plan does not cover",
                **locator_for(key),
            )
        )

    return findings


def check_acl_policy_drift(plan: Any, observation: Any) -> AclPolicyDriftReport:
    """Compare a plan against a readback and return the verdict with its findings.

    Takes either the validated models or their plain-data equivalents. The verdict is
    ``no_drift_observed`` exactly when there are no findings.
    """
    plan_data = _plain(AclPolicyPlan, plan)
    observed_data = _plain(AclPolicyObservation, observation)

    observed_roots, findings = _index_by(
        observed_data["workspace_root_observations"],
        "root_id",
        lambda root_id: {"root_id": root_id},
    )
    for root_plan in plan_data["workspace_root_plans"]:
        root_id = str(root_plan.get("root_id"))
        policy_class = str(root_plan.get("policy_class"))
        locator = {"policy_class": policy_class, "root_id": root_id}
        observation_item = observed_roots.pop(root_id, None)
        if observation_item is None:
            findings.append(
                _finding("observation_absent", "no readback for a planned root", **locator)
            )
            continue
        if observation_item.get("present") is not True:
            findings.append(
                _finding("root_absent", "the planned root is not there", **locator)
            )
            continue
        if observation_item.get("is_reparse_point") is not False:
            # Reported and then still compared: the ACEs below are being applied to
            # whatever the link points at, and both halves of that are worth saying.
            findings.append(
                _finding(
                    "root_is_reparse_point",
                    "the root is a link, so this plan is describing a directory nobody validated",
                    **locator,
                )
            )
        security = observation_item.get("security")
        if not isinstance(security, Mapping):
            findings.append(
                _finding(
                    "observation_absent",
                    "the root was found but its security descriptor was not read",
                    **locator,
                )
            )
        else:
            findings.extend(
                _compare_security(
                    root_plan["required"],
                    security,
                    locator,
                    deny_absent_reason="required_ace_absent",
                    refuse_delete_child=True,
                )
            )
        findings.extend(
            _check_placeholders(
                root_plan.get("placeholders", ()),
                observation_item.get("placeholders", ()),
                policy_class=policy_class,
                root_id=root_id,
            )
        )

    for root_id in observed_roots:
        findings.append(
            _finding(
                "root_not_in_plan",
                "a root carrying our policy that the plan does not cover",
                root_id=root_id,
            )
        )

    observed_managed, managed_duplicates = _index_by(
        observed_data["managed_root_observations"],
        "managed_root_scope",
        lambda scope: {"managed_root_scope": scope},
    )
    findings.extend(managed_duplicates)
    for managed_plan in plan_data["managed_root_plans"]:
        scope = str(managed_plan.get("managed_root_scope"))
        locator = {"managed_root_scope": scope}
        observation_item = observed_managed.pop(scope, None)
        if observation_item is None:
            findings.append(
                _finding("observation_absent", "no readback for a planned managed root", **locator)
            )
            continue
        if observation_item.get("present") is not True:
            findings.append(
                _finding("root_absent", "the planned managed root is not there", **locator)
            )
            continue
        if observation_item.get("is_reparse_point") is not False:
            findings.append(
                _finding(
                    "root_is_reparse_point",
                    "the managed root is a link, so its policy is being applied elsewhere",
                    **locator,
                )
            )
        security = observation_item.get("security")
        if not isinstance(security, Mapping):
            findings.append(
                _finding(
                    "observation_absent",
                    "the managed root was found but its security descriptor was not read",
                    **locator,
                )
            )
        else:
            findings.extend(
                _compare_security(
                    managed_plan["required"],
                    security,
                    locator,
                    deny_absent_reason="required_ace_absent",
                    expected_owner_sid=(
                        ADMINISTRATORS_SID
                        if scope in ADMINISTRATORS_OWNED_MANAGED_ROOTS
                        else None
                    ),
                )
            )
        findings.extend(
            _check_tier_subtrees(
                managed_plan.get("tier_subtrees", ()),
                observation_item.get("tier_subtree_observations", ()),
                managed_root_scope=scope,
            )
        )
        findings.extend(
            _check_tier_openings(
                managed_plan.get("tier_openings", ()),
                observation_item.get("tier_opening_observations", ()),
                managed_root_scope=scope,
            )
        )

    for scope in observed_managed:
        findings.append(
            _finding(
                "root_not_in_plan",
                "a managed root the plan does not cover",
                managed_root_scope=scope,
            )
        )

    return AclPolicyDriftReport.model_validate(
        {
            "contract_version": ACL_POLICY_CONTRACT_VERSION,
            "policy_version": plan_data.get("policy_version"),
            "verdict": "drift_detected" if findings else "no_drift_observed",
            "findings": findings,
        }
    )
