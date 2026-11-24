"""The egress policy planner.

Input: one owner SID, that owner's per-tier account SIDs, and what a caller read off the
host. Output: every WFP object that should exist for that owner and every object of ours
that should not, as an ``EgressPolicyPlan``.

The plan is the descriptor resolved against a tier account set, so a second tier produces
one more member here and changes nothing in the descriptor. That is not an incidental
property; it is the reason the descriptor is keyed by rule class and tier, and
``tests/test_egress_plan.py`` holds the line.

Nothing here applies anything. No WFP filter is added and nothing is shelled out to. A
plan is a statement of what should be true, and applying it is the broker's job.

One fail-closed requirement lives in this module rather than in the applier: a plan that
installs rules, whether they block or only log, is refused unless the caller's evidence
says the filtering engine is running, the host's dynamic port range was read and holds no
declared service port, and no other sublayer shares our weight. A BLOCK-only rule set that
another sublayer is evaluated ahead of, or that a tier can walk around through the
dynamic range, is a boundary that was never there, and it looks identical to one that was.
The applier re-checks the same preconditions; refusing here is what keeps a plan from
claiming a boundary the host was never going to give it.
"""

from __future__ import annotations

import ipaddress
from collections.abc import Mapping, Sequence
from typing import Any

from contracts.egress_policy_descriptor_data import EGRESS_POLICY_RULES
from contracts.egress_policy_plan import EgressPolicyPlan
from pydantic import ValidationError

from sandbox_policy.egress_descriptors import (
    ACCOUNT_SID_PATTERN,
    EGRESS_POLICY_CONTRACT_VERSION,
    PORT_MAX,
    PORT_MIN,
    EgressPolicyRefusalError,
    EgressRefusalItem,
    address_ranges,
    all_tiers,
    as_text,
    boundary_state,
    declared_preconditions,
    descriptor_data,
    enforcing_reference_data,
    expressed_tiers,
    is_build_validated_descriptor,
    is_shipped_descriptor,
    loopback_dynamic_gap,
    object_key,
    plan_intents,
    port_complement,
    primary_rule_classes,
    supplementary_filter_classes,
    tier_covered_by,
    tier_loopback_ports,
    tier_policy,
    tier_rule_classes,
    unmet_preconditions,
    validate_descriptor,
    validate_host_policy_state,
    version_label,
    wfp_filters,
)

__all__ = ["PLAN_INTENTS", "plan_egress_policy", "plan_enforcing_reference_policy"]

#: What a plan can be for, from the contract rather than restated here.
PLAN_INTENTS = plan_intents()

#: The one mechanism both layers are written with. The key grammar still carries it.
_MECHANISM = "wfp"

#: What the installed filters do, by the primary layer's presence. A presence with no entry
#: installs no rules.
_MODE_BY_PRESENCE = {"enforcing": "enforce", "log_only": "log_only"}

#: The one permit the contract has, and the one tier it can belong to (design D4).
_UPSTREAM_PERMIT_CLASS = "upstream_proxy_permit"
_CONNECTOR_TIER = "network_connector"

#: The two preconditions that are about the dynamic range; a typed gap refusal stands for them.
_DYNAMIC_RANGE_PRECONDITIONS = frozenset(
    {"dynamic_port_range_known", "declared_ports_outside_dynamic_port_range"}
)

#: Which address family each connect layer matches, for the permit's filters.
_LAYER_FAMILY = {"ale_auth_connect_v4": 4, "ale_auth_connect_v6": 6}


def _field(member: object, name: str) -> Any:
    """One field of a tier account, whether it arrived as a mapping or a model.

    Accepting both shapes is what keeps this package from importing the broker's own
    types, which would put a lower layer underneath this one.
    """
    if isinstance(member, Mapping):
        return member.get(name)
    return getattr(member, name, None)


def plan_egress_policy(
    *,
    owner_sid: str,
    tier_accounts: Sequence[object],
    host_policy_state: Mapping[str, Any] | None = None,
    intent: str = "install",
    upstream_proxy: Mapping[str, Any] | None = None,
) -> EgressPolicyPlan:
    """Resolve the egress policy descriptor against one owner's tier accounts.

    ``tier_accounts`` is one entry per isolation tier this layer expresses, each with a
    ``tier`` and an ``account_sid``. ``host_policy_state`` is what a caller read off the
    host: the four facts of ``EgressHostPolicyState``. It may be omitted for a plan that
    installs no boundary rules, which is every plan at the version this release ships,
    because there is nothing for a precondition to be a precondition of.

    ``upstream_proxy`` is the host's upstream proxy as the caller resolved it (design D4):
    ``addresses``, the literals its name resolved to, and ``port``, plus optionally
    ``additional_ports`` (EG2-11: the PAC host's and each PAC-named proxy's ports; the permit
    is the union of those addresses with those ports). None is no upstream
    proxy. A plan opens it only through the connector tier's internal block, so a plan
    with no such block has no permit whatever is passed here, and an uninstall ignores it.

    Raises ``EgressPolicyRefusalError`` carrying every refusal. Raises ``ValueError`` for
    an intent that is not one of ``PLAN_INTENTS``, which is a caller bug rather than a
    host condition and so is not a policy refusal.

    There is deliberately no way to hand in a descriptor. The descriptor's policy rules
    are enforced at generation time on the TypeScript side and do not survive into the
    generated Pydantic model, so a descriptor argument would be a public door onto
    planning from a policy nobody checked.
    """
    return _plan_from_descriptor(
        owner_sid=owner_sid,
        tier_accounts=tier_accounts,
        host_policy_state=host_policy_state,
        intent=intent,
        descriptor=descriptor_data(),
        upstream_proxy=upstream_proxy,
    )


def plan_enforcing_reference_policy(
    *,
    owner_sid: str,
    tier_accounts: Sequence[object],
    host_policy_state: Mapping[str, Any],
    intent: str = "install",
    upstream_proxy: Mapping[str, Any] | None = None,
) -> EgressPolicyPlan:
    """Resolve the enforcing reference descriptor, which is not the shipped policy (EG2-11).

    The one door onto the reference, and it is not a descriptor argument: the artifact is fixed
    to the one this build validated, so this cannot plan a policy nobody checked. The only
    caller is the Sandbox Manager's WFP plan selection, which reaches it only when the
    internal ``SUPERCLAW_NATIVE_EGRESS_WFP_PLAN=enforcing`` setting is present; nothing ships
    that setting, and ``plan_egress_policy`` still refuses the reference. Host evidence is
    required, as for every plan that installs rules.
    """
    return _plan_from_descriptor(
        owner_sid=owner_sid,
        tier_accounts=tier_accounts,
        host_policy_state=host_policy_state,
        intent=intent,
        descriptor=enforcing_reference_data(),
        allow_unshipped_reference=True,
        upstream_proxy=upstream_proxy,
    )


def _plan_from_descriptor(
    *,
    owner_sid: str,
    tier_accounts: Sequence[object],
    host_policy_state: Mapping[str, Any] | None,
    intent: str,
    descriptor: Mapping[str, Any],
    allow_unshipped_reference: bool = False,
    upstream_proxy: Mapping[str, Any] | None = None,
) -> EgressPolicyPlan:
    """The planner body, over an explicit descriptor.

    Private, and the tests that pass something other than the shipped descriptor are the
    reason it exists: they have to be able to prove that a descriptor which is not the
    shipped one is refused, which means being able to offer one, and they have to be able
    to exercise the boundary path, which the shipped permissive descriptor has none of.

    ``allow_unshipped_reference`` is that second need, and it is off by default so the
    enforcing reference is not plannable by omission. Without it, the gate is the shipped
    digest and nothing else, which is what makes "the planner plans the shipped policy" a
    property of the code rather than of which call sites happen to exist today.
    """
    if intent not in PLAN_INTENTS:
        raise ValueError(f"intent is one of {PLAN_INTENTS}")

    source = dict(descriptor)
    refusals: list[EgressRefusalItem] = []

    try:
        validate_descriptor(source)
    except ValidationError:
        # A malformed descriptor is a build problem, not a host problem, and there is
        # nothing useful to plan from it, so this one refusal stands alone.
        raise EgressPolicyRefusalError(
            [EgressRefusalItem(reason="descriptor_shape_invalid")]
        ) from None

    accepted = (
        is_build_validated_descriptor(source)
        if allow_unshipped_reference
        else is_shipped_descriptor(source)
    )
    if not accepted:
        # Well-shaped and still not plannable. Every rule that makes the descriptor a
        # boundary rather than a list of firewall rules lives in a Zod refinement that
        # codegen does not carry, so shape is all the check above proved. The public
        # entry point above never reaches this: it plans from the shipped descriptor and
        # takes no other, so this refuses what comes through the private door.
        raise EgressPolicyRefusalError(
            [EgressRefusalItem(reason="descriptor_not_the_shipped_policy")]
        ) from None

    if not isinstance(owner_sid, str) or ACCOUNT_SID_PATTERN.fullmatch(owner_sid) is None:
        refusals.append(EgressRefusalItem(reason="owner_sid_shape_invalid"))

    account_by_tier = _tier_accounts(tier_accounts, source, refusals)
    # An uninstall removes every object and needs no proxy, so a malformed one must not
    # stop the cleanup being planned.
    upstream = None if intent == "uninstall" else _upstream_proxy(upstream_proxy, refusals)

    presence = as_text(source["primary_layer"].get("presence")) or ""
    installs_rules = intent != "uninstall" and presence in _MODE_BY_PRESENCE
    evidence: Mapping[str, Any] | None = None
    dynamic_gap: tuple[int, int] | None = None
    if installs_rules:
        evidence, precondition_refusals = _read_host_policy(host_policy_state, source)
        refusals.extend(precondition_refusals)
        if evidence is not None and _any_tier_allows_dynamic_range(source):
            dynamic_gap, gap_refusal = loopback_dynamic_gap(evidence)
            if gap_refusal is not None:
                # The typed reason stands for the two preconditions that are about this same range.
                refusals[:] = [
                    item
                    for item in refusals
                    if item.precondition not in _DYNAMIC_RANGE_PRECONDITIONS
                ]
                refusals.append(EgressRefusalItem(reason=gap_refusal))

    if refusals:
        raise EgressPolicyRefusalError(refusals)

    primary_rules: list[dict[str, Any]] = []
    supplementary_filters: list[dict[str, Any]] = []
    upstream_permits: list[dict[str, Any]] = []
    if intent != "uninstall":
        primary_rules = _primary_rules(source, owner_sid, account_by_tier, dynamic_gap)
        supplementary_filters = _supplementary_filters(source, owner_sid, account_by_tier)
        upstream_permits = _upstream_permits(primary_rules, owner_sid, account_by_tier, upstream)

    planned_keys = {rule["object_key"] for rule in primary_rules}
    planned_keys.update(item["object_key"] for item in supplementary_filters)
    planned_keys.update(item["object_key"] for item in upstream_permits)

    # A tier counts as covered when this plan gives it every boundary class its own
    # disposition asks for, the same measure ``boundary_state`` applies to the descriptor.
    # One class is not a boundary: a tier with half of its pair still reaches what the
    # other half was there to stop.
    classes_by_tier: dict[str, set[str]] = {}
    for rule in primary_rules:
        classes_by_tier.setdefault(rule["tier"], set()).add(rule["rule_class"])
    covered = [
        tier
        for tier in all_tiers(source)
        if tier_covered_by(tier, classes_by_tier.get(tier, set()))
    ]
    state = "removed_by_uninstall" if intent == "uninstall" else boundary_state(source)

    return EgressPolicyPlan.model_validate(
        {
            "contract_version": EGRESS_POLICY_CONTRACT_VERSION,
            "policy_version": int(source["policy_version"]),
            "policy_version_label": version_label(source),
            "intent": intent,
            "owner_sid": owner_sid,
            "boundary_state": state,
            "mode": _MODE_BY_PRESENCE[presence] if installs_rules else None,
            "covered_tiers": covered,
            "uncovered_tiers": [tier for tier in all_tiers(source) if tier not in covered],
            "preconditions": [
                {"action_kind": "verify_precondition", "precondition": precondition}
                for precondition in (declared_preconditions(source) if installs_rules else ())
            ],
            "primary_rules": primary_rules,
            "supplementary_filters": supplementary_filters,
            "upstream_permits": upstream_permits,
            "removals": _removals(source, owner_sid, account_by_tier, planned_keys),
            # The anchor: every install asks for our sublayer, even one with no filter in it.
            "install_sublayer": intent != "uninstall",
        }
    )


def _tier_accounts(
    tier_accounts: Sequence[object],
    descriptor: Mapping[str, Any],
    refusals: list[EgressRefusalItem],
) -> dict[str, str]:
    """The account SID per tier, refusing anything that would leave a tier unaccounted for.

    An account is required for every tier this layer expresses, whatever the posture. The
    removals a plan carries are keyed by tier, so a missing account is not a smaller plan;
    it is a tier whose objects this plan cannot speak about, including ones an earlier
    enforcing version installed.
    """
    known = set(all_tiers(descriptor))
    account_by_tier: dict[str, str] = {}
    sid_owner: dict[str, str] = {}

    members = tier_accounts
    if isinstance(members, (str, bytes)) or not isinstance(members, Sequence):
        refusals.append(EgressRefusalItem(reason="tier_account_sid_shape_invalid"))
        members = ()

    for member in members:
        tier = as_text(_field(member, "tier"))
        account_sid = as_text(_field(member, "account_sid"))
        if tier is None or tier not in known:
            # No locator. The tier is the caller's own string and it is not a tier, so
            # putting it in the refusal would put arbitrary caller text into something we
            # log and hand around - and the contract's locator types this field as the
            # tier enum, so a wrong value would fail validation instead of reporting.
            refusals.append(EgressRefusalItem(reason="tier_account_tier_unknown"))
            continue
        if account_sid is None or ACCOUNT_SID_PATTERN.fullmatch(account_sid) is None:
            refusals.append(
                EgressRefusalItem(reason="tier_account_sid_shape_invalid", tier=tier)
            )
            continue
        if account_sid in sid_owner:
            # One account per tier. Two tiers behind one SID is one blast radius wearing
            # two names: every rule scoped to that account applies to both.
            refusals.append(
                EgressRefusalItem(reason="tier_account_sid_duplicated", tier=tier)
            )
            continue
        sid_owner[account_sid] = tier
        account_by_tier[tier] = account_sid

    for tier in expressed_tiers(descriptor):
        if tier not in account_by_tier:
            refusals.append(EgressRefusalItem(reason="tier_account_absent_for_tier", tier=tier))

    return account_by_tier


def _read_host_policy(
    host_policy_state: Mapping[str, Any] | None, descriptor: Mapping[str, Any]
) -> tuple[Mapping[str, Any] | None, list[EgressRefusalItem]]:
    """The host evidence as parsed, and a refusal for each precondition it contradicts."""
    if host_policy_state is None:
        return None, [EgressRefusalItem(reason="host_policy_evidence_absent")]
    try:
        evidence = validate_host_policy_state(host_policy_state).model_dump(mode="json")
    except ValidationError:
        # Evidence that does not parse is not evidence. Reading it as "nothing was
        # claimed" is the right reading, and it is the same refusal as claiming nothing.
        return None, [EgressRefusalItem(reason="host_policy_evidence_absent")]
    return evidence, [
        EgressRefusalItem(
            reason="host_policy_precondition_unsatisfied", precondition=precondition
        )
        for precondition in unmet_preconditions(evidence, descriptor)
    ]


def _any_tier_allows_dynamic_range(descriptor: Mapping[str, Any]) -> bool:
    return any(
        (tier_policy(tier, descriptor) or {}).get("allows_host_dynamic_port_range") is True
        for tier in all_tiers(descriptor)
    )


def _tier_allowed_ports(
    tier: str, descriptor: Mapping[str, Any], dynamic_gap: tuple[int, int] | None
) -> list[int]:
    """The loopback ports one tier may reach: its services, and the host's dynamic range if D2.

    The dynamic range is the host's own IPv4 TCP range, as read and checked by ``loopback_dynamic_gap``
    (CPython's socketpair binds an ephemeral port inside it), so it is part of the plan and a host whose
    range changes gets another digest. Leaving it out of the blocked set is how it is open: the loopback
    block has a gap, and the filter count does not change.
    """
    allowed = set(tier_loopback_ports(tier, descriptor))
    policy = tier_policy(tier, descriptor) or {}
    if policy.get("allows_host_dynamic_port_range") is True and dynamic_gap is not None:
        allowed.update(range(dynamic_gap[0], dynamic_gap[1] + 1))
    return sorted(allowed)


def _primary_rules(
    descriptor: Mapping[str, Any],
    owner_sid: str,
    account_by_tier: Mapping[str, str],
    dynamic_gap: tuple[int, int] | None,
) -> list[dict[str, Any]]:
    """One planned boundary rule per rule class and tier.

    The blocked port ranges are materialized here, once, from the services each tier may
    reach. An applier writes what it is given: it has no allowlist to consult and no
    complement to work out, so there is no second implementation of the loopback boundary
    to get wrong. They are empty exactly when the match mode is ``every_port``, where a rule
    with no port scope already blocks every port. Every rule also lists the filters it
    becomes, from the contract's class tables.
    """
    planned: list[dict[str, Any]] = []
    for rule in descriptor["primary_layer"]["rules"]:
        rule_class = as_text(rule["rule_class"]) or ""
        address_set = as_text(rule["address_set"]) or ""
        match_mode = as_text(rule["port_match"]["match_mode"]) or ""
        complement = match_mode == "block_complement_of_allowed_ports"
        for tier in _tiers_of(rule, descriptor):
            allowed = (
                _tier_allowed_ports(tier, descriptor, dynamic_gap) if complement else []
            )
            planned.append(
                {
                    "action_kind": "create_or_replace",
                    "object_key": object_key(_MECHANISM, rule_class, tier, owner_sid),
                    "authority": "primary",
                    "mechanism": _MECHANISM,
                    "rule_class": rule_class,
                    "tier": tier,
                    "account_sid": account_by_tier[tier],
                    "action": "block",
                    "protocol": "any",
                    "address_ranges": address_ranges(address_set, descriptor),
                    "match_mode": match_mode,
                    "blocked_tcp_port_ranges": (
                        port_complement(allowed) if complement else []
                    ),
                    "blocked_udp_port_ranges": (
                        port_complement([]) if complement else []
                    ),
                    "filters": wfp_filters(rule_class),
                }
            )
    return planned


def _supplementary_filters(
    descriptor: Mapping[str, Any], owner_sid: str, account_by_tier: Mapping[str, str]
) -> list[dict[str, Any]]:
    """One planned supplementary filter per filter class and tier.

    Shaped unlike a boundary rule on purpose: no address ranges, and the ports it blocks
    listed rather than complemented. That is what these filters express, and a shape that
    pretended otherwise would make the two layers look like alternatives.
    """
    planned: list[dict[str, Any]] = []
    for item in descriptor["supplementary_layer"]["filters"]:
        filter_class = as_text(item["filter_class"]) or ""
        for tier in _tiers_of(item, descriptor):
            planned.append(
                {
                    "action_kind": "create_or_replace",
                    "object_key": object_key(_MECHANISM, filter_class, tier, owner_sid),
                    "authority": "supplementary",
                    "mechanism": _MECHANISM,
                    "filter_class": filter_class,
                    "tier": tier,
                    "account_sid": account_by_tier[tier],
                    "action": "block",
                    "protocols": [as_text(protocol) for protocol in item["protocols"]],
                    "blocked_ports": [int(port) for port in item["blocked_ports"]],
                    "filters": wfp_filters(filter_class),
                }
            )
    return planned


def _upstream_proxy(
    value: object, refusals: list[EgressRefusalItem]
) -> dict[str, Any] | None:
    """The upstream proxy a caller resolved, checked as ``EgressUpstreamProxySchema`` is.

    One to the contract's limit of distinct address literals, none of them loopback or
    v4-mapped, and a port. None is no upstream proxy. The addresses come back as
    ``egressUpstreamPermitAddresses`` gives them: IPv4 before IPv6 and each family by
    value, fully expanded. So one set of addresses plans to the same bytes whatever order
    or spelling a caller gave it.
    """
    if value is None:
        return None
    refusal = EgressRefusalItem(reason="upstream_proxy_shape_invalid")
    if (
        not isinstance(value, Mapping)
        or not {"addresses", "port"} <= set(value) <= {"addresses", "port", "additional_ports"}
    ):
        refusals.append(refusal)
        return None
    addresses = value["addresses"]
    ports = _upstream_ports(value)
    limit = int(EGRESS_POLICY_RULES["upstream_proxy_max_addresses"])
    if not isinstance(addresses, list) or not 1 <= len(addresses) <= limit or ports is None:
        refusals.append(refusal)
        return None
    parsed: set[ipaddress.IPv4Address | ipaddress.IPv6Address] = set()
    for text in addresses:
        try:
            address = ipaddress.ip_address(text) if isinstance(text, str) else None
        except ValueError:
            address = None
        if (
            address is None
            or getattr(address, "scope_id", None) is not None
            or getattr(address, "ipv4_mapped", None) is not None
            or address.is_loopback
            or address in parsed
        ):
            refusals.append(refusal)
            return None
        parsed.add(address)
    ordered = sorted(parsed, key=lambda address: (address.version, int(address)))
    planned: dict[str, Any] = {
        "addresses": [_expanded(address) for address in ordered],
        "port": ports[0],
        "additional_ports": ports[1:],
    }
    return planned


def _upstream_ports(value: Mapping[str, Any]) -> list[int] | None:
    """The proxy's ports, ascending, or None when one is not a port or one is given twice.

    ``port`` and the optional ``additional_ports`` are one set to the planner: the lowest is
    the permit's ``port`` and the rest follow, so the same ports in any order are one plan.
    """
    extra = value.get("additional_ports", [])
    limit = int(EGRESS_POLICY_RULES["upstream_proxy_max_additional_ports"])
    if not isinstance(extra, list) or len(extra) > limit:
        return None
    ports = [value["port"], *extra]
    if any(
        isinstance(port, bool) or not isinstance(port, int) or not PORT_MIN <= port <= PORT_MAX
        for port in ports
    ) or len(set(ports)) != len(ports):
        return None
    return sorted(ports)


def _expanded(address: ipaddress.IPv4Address | ipaddress.IPv6Address) -> str:
    """A dotted quad, or eight groups of four hex digits: the descriptor ranges' spelling.

    Formatted from the number rather than taken from ``exploded``, whose spelling of an
    address with an IPv4 tail is ``ipaddress``'s choice: a v4-mapped one keeps the tail.
    """
    if address.version == 4:
        return str(address)
    value = int(address)
    return ":".join(f"{(value >> shift) & 0xFFFF:04x}" for shift in range(112, -1, -16))


def _upstream_permits(
    primary_rules: Sequence[Mapping[str, Any]],
    owner_sid: str,
    account_by_tier: Mapping[str, str],
    upstream: Mapping[str, Any] | None,
) -> list[dict[str, Any]]:
    """The upstream proxy's permit, when there is a block for it to open.

    Only the connector tier's internal block has one: with no upstream proxy, or no
    internal block planned for that tier, there is nothing to open and no permit. One
    filter per address family the proxy resolved to, at that family's connect layer, so a
    filter never has no address to match.
    """
    opens_a_block = any(
        rule["rule_class"] == "internal_outbound_block" and rule["tier"] == _CONNECTOR_TIER
        for rule in primary_rules
    )
    if upstream is None or not opens_a_block:
        return []
    families = {ipaddress.ip_address(text).version for text in upstream["addresses"]}
    permit: dict[str, Any] = {
        "action_kind": "create_or_replace",
        "object_key": object_key(_MECHANISM, _UPSTREAM_PERMIT_CLASS, _CONNECTOR_TIER, owner_sid),
        "tier": _CONNECTOR_TIER,
        "account_sid": account_by_tier[_CONNECTOR_TIER],
        "action": "permit",
        "protocol": "tcp",
        "addresses": list(upstream["addresses"]),
        "port": upstream["port"],
        "additional_ports": list(upstream["additional_ports"]),
    }
    permit["filters"] = [
        item
        for item in wfp_filters(_UPSTREAM_PERMIT_CLASS)
        if _LAYER_FAMILY.get(item["layer"]) in families
    ]
    return [permit]


def _plannable(rule_class: str, tier: str) -> bool:
    """Whether a plan could ever hold an object of this class for this tier."""
    if rule_class == _UPSTREAM_PERMIT_CLASS:
        return tier == _CONNECTOR_TIER
    if rule_class in primary_rule_classes():
        return rule_class in tier_rule_classes(tier)
    return True


def _removals(
    descriptor: Mapping[str, Any],
    owner_sid: str,
    account_by_tier: Mapping[str, str],
    planned_keys: set[str],
) -> list[dict[str, Any]]:
    """Every object the key grammar admits for this owner that this plan does not want.

    Enumerated from the rule classes and the tier accounts, not read off the host, so a
    plan can say "and nothing else of ours is here". Downgrading to a permissive version
    is the case that needs it: without removals, the plan for the version this release
    ships would be a plan for nothing, and a machine that had run an enforcing version
    would keep rules no descriptor still describes.
    """
    removals: list[dict[str, Any]] = []
    classes = (*primary_rule_classes(), *supplementary_filter_classes(), _UPSTREAM_PERMIT_CLASS)
    for rule_class in classes:
        for tier in expressed_tiers(descriptor):
            key = object_key(_MECHANISM, rule_class, tier, owner_sid)
            if key in planned_keys or not _plannable(rule_class, tier):
                continue
            removals.append(
                {
                    "action_kind": "remove_owned_object",
                    "object_key": key,
                    "mechanism": _MECHANISM,
                    "rule_class": rule_class,
                    "tier": tier,
                    "account_sid": account_by_tier[tier],
                }
            )
    return removals


def _tiers_of(rule: Mapping[str, Any], descriptor: Mapping[str, Any]) -> list[str]:
    """A rule's tiers, in the descriptor's declared tier order.

    Declared order rather than the rule's own, so two rules that name the same tiers plan
    them in the same sequence and a plan diff stays readable.
    """
    named = {as_text(tier) for tier in rule["tiers"]}
    return [tier for tier in all_tiers(descriptor) if tier in named]
