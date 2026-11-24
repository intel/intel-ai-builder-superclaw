"""The versioned egress policy descriptor, and the refusal type its consumers raise.

The descriptor is generated from ``shared/contracts/src/egress-policy-descriptor.ts``
and committed under ``shared/contracts/generated``. This module is the Python door onto
it: it validates it, hands out copies rather than the shared dict, and answers "what is
this tier's disposition", "which loopback endpoint owns this port" and "is this boundary
closed".

The descriptor is keyed by policy class, owner and tier. It names no account, no
address and no rule name, so adding a tier cannot change it.

Two things this module deliberately does not do. It does not apply anything: no WFP
filter is added here, and nothing shells out. And it does not re-derive the descriptor's
own policy rules, which are Zod refinements that codegen does not carry -
``is_shipped_descriptor`` is how this side insists on the artifact they were run over
instead.
"""

from __future__ import annotations

import hashlib
import json
import re
import uuid
from collections.abc import Iterable, Mapping
from copy import deepcopy
from dataclasses import dataclass
from typing import Any

from contracts.egress_host_policy_state import EgressHostPolicyState
from contracts.egress_policy_descriptor import EgressPolicyDescriptor
from contracts.egress_policy_descriptor_data import (
    EGRESS_POLICY_CONTRACT_VERSION,
    EGRESS_POLICY_DESCRIPTOR,
    EGRESS_POLICY_ENFORCING_REFERENCE_NOT_SHIPPED,
    EGRESS_POLICY_RULES,
    EGRESS_POLICY_VERSION,
    EGRESS_POLICY_VERSION_LABEL,
)
from contracts.egress_policy_refusal import EgressPolicyRefusal as EgressPolicyRefusalContract

__all__ = [
    "ACCOUNT_SID_PATTERN",
    "BOUNDARY_CLOSED_STATE",
    "EGRESS_POLICY_CONTRACT_VERSION",
    "EGRESS_POLICY_VERSION",
    "EGRESS_POLICY_VERSION_LABEL",
    "ISOLATION_TIERS",
    "OBJECT_KEY_PATTERN",
    "PORT_MAX",
    "PORT_MIN",
    "EgressPolicyRefusalError",
    "EgressRefusalItem",
    "address_ranges",
    "all_tiers",
    "as_text",
    "boundary_is_closed",
    "boundary_state",
    "covered_tiers",
    "declared_loopback_ports",
    "declared_preconditions",
    "descriptor_data",
    "descriptor_digest",
    "enforcing_reference_data",
    "expressed_tiers",
    "ipv4_dynamic_port_ranges",
    "loopback_dynamic_gap",
    "is_build_validated_descriptor",
    "is_shipped_descriptor",
    "loopback_endpoint_policy",
    "object_key",
    "plan_intents",
    "planner_refusal_reasons",
    "port_complement",
    "primary_rule_classes",
    "required_preconditions",
    "supplementary_filter_classes",
    "tier_boundary_is_closed",
    "tier_covered_by",
    "tier_loopback_ports",
    "tier_policy",
    "tier_rule_classes",
    "unmet_preconditions",
    "validate_descriptor",
    "validate_host_policy_state",
    "version_label",
    "wfp_filter_key",
    "wfp_filters",
    "wfp_provider_data",
]

#: A Windows account SID in string form.
#:
#: Compiled from the pattern the contract publishes rather than hand-copied, and the same
#: pattern the ACL policy contract publishes, because both name accounts the same broker
#: provisions. One grammar written out twice is two grammars that agree until one of them
#: is edited, and this one decides whether an account SID is refused.
ACCOUNT_SID_PATTERN = re.compile(EGRESS_POLICY_RULES["owner_sid_pattern"])

#: The grammar of a planned object's key, from the contract.
OBJECT_KEY_PATTERN = re.compile(EGRESS_POLICY_RULES["object_key_pattern"])

#: Port bounds, from the contract rather than restated as 1 and 65535.
PORT_MIN: int = int(EGRESS_POLICY_RULES["port_min"])
PORT_MAX: int = int(EGRESS_POLICY_RULES["port_max"])

#: The one boundary state that means egress is closed by policy.
#:
#: Read from the contract rather than written out, so there is one spelling of the string
#: that decides whether egress is closed. Four of the five states mean the boundary is
#: absent, and a caller checking ``!= "removed_by_uninstall"`` would read three of them as
#: coverage, which is why ``boundary_is_closed`` exists and this constant is not compared
#: to by hand anywhere else.
BOUNDARY_CLOSED_STATE: str = EGRESS_POLICY_RULES["boundary_closed_state"]

#: Every isolation tier, from the contract's own vocabulary.
#:
#: The vocabulary, not the descriptor's ``tier_policies``. A tier missing from a
#: descriptor's list is still a tier whose traffic nothing blocks, so the question "is
#: every tier covered" has to be asked against the closed set.
ISOLATION_TIERS: tuple[str, ...] = tuple(EGRESS_POLICY_RULES["isolation_tiers"])


def as_text(value: Any) -> str | None:
    """A plain string, unwrapping the enum a generated model hands back.

    Every comparison against a descriptor's own vocabulary goes through this, because a
    descriptor reaches these functions two ways: as plain data read from the generated
    module, and as a ``model_dump()`` of the pydantic model, where an enum member is not
    equal to its own value. A comparison that skipped it would be right for one caller and
    quietly wrong for the other, and "quietly wrong about whether a boundary is there" is
    the failure this module exists to prevent.

    Public, and imported by ``egress_plan``, so there is one copy.
    """
    if isinstance(value, str):
        return value
    inner = getattr(value, "value", None)
    return inner if isinstance(inner, str) else None


@dataclass(frozen=True)
class EgressRefusalItem:
    """One refusal, with where it is.

    A locator holds codes, enum values and a port. It never holds an account SID, an
    address or a host name, because a refusal is a thing we log and hand around.
    """

    reason: str
    layer_authority: str | None = None
    rule_class: str | None = None
    tier: str | None = None
    endpoint: str | None = None
    precondition: str | None = None
    address_family: str | None = None
    port: int | None = None

    def as_contract(self) -> dict[str, Any]:
        return {
            "reason": self.reason,
            "locator": {
                "layer_authority": self.layer_authority,
                "rule_class": self.rule_class,
                "tier": self.tier,
                "endpoint": self.endpoint,
                "precondition": self.precondition,
                "address_family": self.address_family,
                "port": self.port,
            },
        }


class EgressPolicyRefusalError(ValueError):
    """Raised when an egress policy input is refused.

    Carries every refusal, not the first one. A caller fixing a tier account set wants
    the whole list, and a report that stops at the first problem invites the belief that
    fixing it was enough.
    """

    def __init__(self, items: Iterable[EgressRefusalItem]) -> None:
        self.items: tuple[EgressRefusalItem, ...] = tuple(items)
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
            "contract_version": EGRESS_POLICY_CONTRACT_VERSION,
            "refusals": [item.as_contract() for item in self.items],
        }
        return EgressPolicyRefusalContract.model_validate(payload).model_dump(mode="json")


def descriptor_data() -> dict[str, Any]:
    """A private copy of the shipped descriptor, as plain data."""
    return deepcopy(EGRESS_POLICY_DESCRIPTOR)


def enforcing_reference_data() -> dict[str, Any]:
    """A private copy of the enforcing reference descriptor, which is not shipped.

    It exists so the enforcing half of this planner can be tested at all: the descriptor
    this release ships is permissive and carries no rules, so a planner tested only
    against it would have its whole boundary path unexercised. ``is_shipped_descriptor``
    returns False for it and ``plan_egress_policy`` refuses it, which is what keeps it from
    becoming a second policy by accident.
    """
    return deepcopy(EGRESS_POLICY_ENFORCING_REFERENCE_NOT_SHIPPED)


def validate_descriptor(payload: Mapping[str, Any]) -> EgressPolicyDescriptor:
    """Field shapes for the descriptor, and nothing else.

    The cross-field rules - both boundary classes covered for every tier that is denied,
    loopback expressible only as the complement of the declared services a tier may reach, the two
    address sets partitioning the address space, a posture that agrees with the primary
    layer - are refused in ``shared/contracts/src/egress-policy-descriptor.ts`` and tested
    there, because they guard a descriptor this repo ships rather than an input a host
    supplies. They do not survive codegen. A descriptor that passes this function has a
    valid shape and no checked policy.
    """
    return EgressPolicyDescriptor.model_validate(payload)


def validate_host_policy_state(payload: Mapping[str, Any]) -> EgressHostPolicyState:
    """Field shapes for the host policy evidence a caller read off the machine."""
    return EgressHostPolicyState.model_validate(payload)


def descriptor_digest(payload: Mapping[str, Any]) -> str:
    """The canonical digest of a descriptor.

    ``sort_keys`` with no separator padding, and non-ASCII text written as itself, is
    the same canonical form ``canonicalEgressPolicyJson`` produces on the TypeScript side,
    so a digest computed here can be compared to the one the generator published. A test
    pins that agreement, because the two implementations are the only thing holding it up.
    """
    canonical = json.dumps(
        payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def is_shipped_descriptor(payload: Mapping[str, Any]) -> bool:
    """Whether this is the descriptor the contract's own rules were checked against.

    The rules that make this artifact a boundary rather than a list of filters -
    that loopback has no expressible "off", that the two address sets cover the machine,
    that an absent layer says why - are Zod cross-field refinements with no JSON Schema
    form, so nothing on this side of the boundary re-derives them. Rather than restate
    them in a second language, the planner insists on the artifact they were run over.
    """
    return descriptor_digest(payload) == EGRESS_POLICY_RULES["descriptor_digest"]


def is_build_validated_descriptor(payload: Mapping[str, Any]) -> bool:
    """Whether this build ran the descriptor's own rules over this exact artifact.

    Two artifacts qualify: the descriptor this release ships, and the enforcing reference,
    which is validated by the generator and shipped as nothing but a fixture. Only the
    first is a policy. ``plan_egress_policy`` gates on ``is_shipped_descriptor`` and there
    is no argument that changes that; the reference is reachable only by passing
    ``allow_unshipped_reference=True`` to the private ``_plan_from_descriptor``, which no
    production call site does.

    The distinction exists so the planner's boundary path can be exercised before the
    release that turns enforcement on. A permissive descriptor has no rules, so a planner
    tested only against it would have every rule-building line unrun.
    """
    return descriptor_digest(payload) in (
        EGRESS_POLICY_RULES["descriptor_digest"],
        EGRESS_POLICY_RULES["enforcing_reference_digest"],
    )


def tier_policy(
    tier: str, descriptor: Mapping[str, Any] | None = None
) -> Mapping[str, Any] | None:
    """A copy of the policy for one isolation tier, or None if it is not covered."""
    source = EGRESS_POLICY_DESCRIPTOR if descriptor is None else descriptor
    for policy in source.get("tier_policies", ()):
        if policy.get("tier") == tier:
            return deepcopy(policy)
    return None


def loopback_endpoint_policy(
    endpoint: str, descriptor: Mapping[str, Any] | None = None
) -> Mapping[str, Any] | None:
    """A copy of the policy for one loopback endpoint, or None if it is not covered."""
    source = EGRESS_POLICY_DESCRIPTOR if descriptor is None else descriptor
    for policy in source.get("loopback_endpoints", ()):
        if policy.get("endpoint") == endpoint:
            return deepcopy(policy)
    return None


def tier_rule_classes(tier: str) -> frozenset[str]:
    """The boundary classes a tier has to carry to count as covered.

    Read from the contract's table of each tier's disposition, not from the descriptor's
    own disposition field: a descriptor that gave the file and tool tier the connector's
    disposition would trade its external block for an internal one, and the internet would
    stay open to a tier this function called covered.
    """
    disposition = EGRESS_POLICY_RULES["tier_disposition_for_tier"][tier]
    return frozenset(EGRESS_POLICY_RULES["tier_disposition_rule_classes"][disposition])


def covered_tiers(descriptor: Mapping[str, Any]) -> frozenset[str]:
    """The tiers the primary layer carries every boundary class their disposition asks for.

    A rule of one class is not a boundary. The file and tool tiers need the external block
    and the loopback block, the connector tier the internal block and the loopback block,
    and with either half missing something stays reachable that should not. This is the
    set ``boundary_state`` measures against the tier vocabulary.
    """
    by_tier: dict[str, set[str]] = {}
    for rule in descriptor.get("primary_layer", {}).get("rules", ()):
        rule_class = as_text(rule.get("rule_class"))
        if rule_class is None:
            continue
        for tier in rule.get("tiers", ()):
            named = as_text(tier)
            if named is not None:
                by_tier.setdefault(named, set()).add(rule_class)
    return frozenset(
        tier for tier in ISOLATION_TIERS if tier_covered_by(tier, by_tier.get(tier, set()))
    )


def tier_covered_by(tier: str, classes: Iterable[str]) -> bool:
    """Whether these boundary classes cover a tier: every class its disposition asks for.

    A tier whose disposition asks for none, the channel tier today, is never covered: no
    rule could show that it was, and counting it would close the machine over a tier
    nothing blocks.
    """
    required = tier_rule_classes(tier)
    return bool(required) and required.issubset(classes)


def boundary_state(descriptor: Mapping[str, Any]) -> str:
    """What the boundary is, for a descriptor, before an intent is applied to it.

    Counts rules against the tier vocabulary rather than reading the primary layer's
    presence, because presence is a word and coverage is the boundary. An enforcing layer
    that carries rules for two of the three tiers leaves the third tier's traffic
    unblocked, and a state that called that closed would be the wrong answer to the only
    question a gate asks.

    Takes the posture too, so a descriptor that disagrees with itself reads open. A valid
    descriptor cannot disagree - a refinement refuses it - and this is the direction that
    has to hold for one that never went through the refinement.
    """
    primary = descriptor.get("primary_layer", {})
    supplementary = descriptor.get("supplementary_layer", {})
    if (
        as_text(descriptor.get("posture")) == "enforcing"
        and as_text(primary.get("presence")) == "enforcing"
    ):
        if covered_tiers(descriptor) >= frozenset(ISOLATION_TIERS):
            return BOUNDARY_CLOSED_STATE
        return "primary_rules_do_not_cover_every_tier"
    if as_text(primary.get("presence")) == "log_only":
        # The boundary as it will be, installed and observed, blocking nothing.
        return "primary_logging_only"
    if as_text(supplementary.get("presence")) == "filters_installed":
        # A live supplementary layer and no boundary rules. The BLOCK-only filter set narrows what
        # a process can reach; it does not close egress, and calling this state anything
        # that contained the word "enforcing" would invite a gate to accept it.
        return "supplementary_only_not_a_boundary"
    return "declared_permissive_no_rules"


def boundary_is_closed(state: str) -> bool:
    """Whether a boundary state means egress is closed by policy. One state does."""
    return state == BOUNDARY_CLOSED_STATE


def tier_boundary_is_closed(descriptor: Mapping[str, Any], tier: str) -> bool:
    """Whether one tier's egress is closed by policy.

    The per-tier question, which is the one an isolation report asks. ``boundary_state``
    answers for the machine, and a report that read the machine's answer for a tier would
    call every tier open until the last one is covered.
    """
    return (
        as_text(descriptor.get("posture")) == "enforcing"
        and as_text(descriptor.get("primary_layer", {}).get("presence")) == "enforcing"
        and tier in covered_tiers(descriptor)
    )


def version_label(descriptor: Mapping[str, Any]) -> str:
    """The descriptor's own version label, as ``v<version>/<posture>``.

    Derived from the descriptor in hand rather than read from the module constant, because
    the constant describes the shipped descriptor and a plan built from any other one would
    be labelled with a posture it does not have. A label reading ``permissive`` on an
    enforcing plan is the kind of thing an operator believes.
    """
    version = descriptor.get("policy_version")
    posture = as_text(descriptor.get("posture")) or "unknown"
    return f"v{int(version) if version is not None else 0}/{posture}"


def port_complement(allowed: Iterable[int]) -> list[dict[str, int]]:
    """The ports a loopback rule blocks, as ranges, given the ports it allows.

    The whole loopback boundary is this function's output. The descriptor has no field
    that lists blocked loopback ports and none that removes the rule, so an allowlist is
    the only thing anybody edits, and the block set follows from it. The result is empty
    only for an allowlist of every port, which the descriptor refuses.

    ``shared/contracts/src/egress-policy-descriptor.ts`` has the same function, because
    the descriptor's own tests need it and the plan is produced here. Both sides pin the
    same table, which is what holds them together.
    """
    blocked: list[dict[str, int]] = []
    cursor = PORT_MIN
    for port in sorted(set(allowed)):
        if port > cursor:
            blocked.append({"first": cursor, "last": port - 1})
        cursor = max(cursor, port + 1)
    if cursor <= PORT_MAX:
        blocked.append({"first": cursor, "last": PORT_MAX})
    return blocked


def ipv4_dynamic_port_ranges(evidence: Mapping[str, Any]) -> list[tuple[int, int]]:
    """The host's IPv4 TCP dynamic port ranges as read, or none if nobody read one.

    IPv4, because that is the family a Windows socketpair connects over, and so the range
    D2 is about. A range in any other shape is not a range that was read.
    """
    ranges: list[tuple[int, int]] = []
    reported = evidence.get("tcp_dynamic_port_ranges")
    if not isinstance(reported, list):
        return ranges
    for entry in reported:
        if (
            not isinstance(entry, Mapping)
            or as_text(entry.get("address_family")) != "ipv4"
        ):
            continue
        first, last = entry.get("first"), entry.get("last")
        if (
            type(first) is int
            and type(last) is int
            and PORT_MIN <= first <= last <= PORT_MAX
        ):
            ranges.append((first, last))
    return ranges


def loopback_dynamic_gap(
    evidence: Mapping[str, Any],
) -> tuple[tuple[int, int] | None, str | None]:
    """The loopback gap an enforcing plan leaves open, or the typed reason the host cannot have one.

    The gap is the host's IPv4 TCP dynamic range, because that is where ``socketpair`` binds. The rules
    (sane bounds, the ports that must stay blocked, the reasons) are the contract's
    ``loopback_dynamic_*`` rule data, defined once in ``egress-loopback-dynamic-range.ts``. IPv6 is not
    read: ``socketpair`` is AF_INET and nothing SuperClaw needs is a ``::1`` ephemeral listener.
    """
    ranges = ipv4_dynamic_port_ranges(evidence)
    if not ranges:
        return None, "loopback_dynamic_range_unavailable"
    if len(ranges) != 1:
        return None, "loopback_dynamic_range_invalid"
    first, last = ranges[0]
    bounds = EGRESS_POLICY_RULES["loopback_dynamic_port_range_bounds"]
    if (
        first < bounds["min_first"]
        or last > bounds["max_last"]
        or last - first + 1 < bounds["min_count"]
    ):
        return None, "loopback_dynamic_range_invalid"
    if any(first <= port <= last for port in EGRESS_POLICY_RULES["loopback_dynamic_range_blocked_ports"]):
        return None, "loopback_dynamic_range_covers_control_port"
    return (first, last), None


def _precondition_met(
    precondition: str, evidence: Mapping[str, Any], descriptor: Mapping[str, Any] | None
) -> bool:
    """Whether one precondition holds on this evidence. Unknown ones never do."""
    if precondition == "base_filtering_engine_running":
        return evidence.get("base_filtering_engine_running") is True
    if precondition == "dynamic_port_range_known":
        return bool(ipv4_dynamic_port_ranges(evidence))
    if precondition == "declared_ports_outside_dynamic_port_range":
        ranges = ipv4_dynamic_port_ranges(evidence)
        return bool(ranges) and not any(
            first <= port <= last
            for port in declared_loopback_ports(descriptor)
            for first, last in ranges
        )
    if precondition == "sublayer_weight_uncontested":
        others = evidence.get("other_sublayers_at_our_weight")
        return isinstance(others, list) and not others
    return False


def unmet_preconditions(
    evidence: Mapping[str, Any], descriptor: Mapping[str, Any] | None = None
) -> tuple[str, ...]:
    """Which of the descriptor's required preconditions this evidence contradicts.

    In the descriptor's declared order, so a report reads in the order the applier will
    verify them. The evidence is facts, and this is where facts become verdicts: a range
    nobody read decides nothing in its favour, and a precondition this module does not
    know is returned as unmet, because an unrecognised requirement is not a satisfied one.
    """
    return tuple(
        precondition
        for precondition in declared_preconditions(descriptor)
        if not _precondition_met(precondition, evidence, descriptor)
    )


def object_key(mechanism: str, rule_class: str, tier: str, owner_sid: str) -> str:
    """The key for one planned object, built the one way the contract builds it.

    Five dot-separated segments, of which only the owner's SID carries digits, so a port
    number or an address cannot end up in a key. An applier matches on the whole string
    and never parses it.
    """
    return ".".join(
        (EGRESS_POLICY_RULES["object_key_prefix"], mechanism, rule_class, tier, owner_sid)
    )


def primary_rule_classes() -> tuple[str, ...]:
    """The boundary rule classes. The primary layer covers all of them or none."""
    return tuple(EGRESS_POLICY_RULES["primary_rule_classes"])


def supplementary_filter_classes() -> tuple[str, ...]:
    """The supplementary filter classes. Installed whole or not at all."""
    return tuple(EGRESS_POLICY_RULES["supplementary_filter_classes"])


def required_preconditions() -> tuple[str, ...]:
    """Every precondition the contract knows about, in declared order.

    The vocabulary's whole set. A descriptor declares which of them it requires, and a
    refinement on the TypeScript side refuses a descriptor that leaves one out, so the two
    lists agree for any descriptor this repo ships. Callers that need what a particular
    descriptor requires ask ``declared_preconditions`` instead, so a plan and its own
    unmet-precondition report cannot be reading two different lists.
    """
    return tuple(EGRESS_POLICY_RULES["required_preconditions"])


def declared_preconditions(descriptor: Mapping[str, Any] | None = None) -> tuple[str, ...]:
    """What one descriptor requires of the host, in its declared order."""
    source = EGRESS_POLICY_DESCRIPTOR if descriptor is None else descriptor
    return tuple(
        as_text(precondition) or ""
        for precondition in source.get("required_host_preconditions", ())
    )


def plan_intents() -> tuple[str, ...]:
    """What a plan can be for.

    ``repair`` is the idempotent re-run: the same objects, the same whole desired state.
    It is its own intent so that "make it right again" cannot be spelled as an uninstall
    followed by an install, which would take the boundary down in between.
    """
    return tuple(EGRESS_POLICY_RULES["plan_intents"])


def planner_refusal_reasons() -> tuple[str, ...]:
    """The refusal reasons this planner owns, as opposed to the descriptor's own."""
    return tuple(EGRESS_POLICY_RULES["planner_refusal_reasons"])


def address_ranges(
    address_set: str, descriptor: Mapping[str, Any] | None = None
) -> list[dict[str, Any]]:
    """Copies of the ranges in one of the address sets.

    ``loopback`` and ``non_loopback`` partition the address space, and ``internal`` lies
    inside ``non_loopback``. All three are derived on the TypeScript side. Nothing here
    recomputes any of them: a planner that derived its own idea of which addresses are
    loopback or internal would be a second answer to the question the descriptor exists
    to answer once.
    """
    source = EGRESS_POLICY_DESCRIPTOR if descriptor is None else descriptor
    return [deepcopy(dict(entry)) for entry in source["address_sets"][address_set]]


def expressed_tiers(descriptor: Mapping[str, Any] | None = None) -> tuple[str, ...]:
    """The tiers this layer expresses a policy for, in declared order.

    A tier the layer declares it does not express owns no objects: no rule is planned for
    it, and no removal either. Claiming its objects would be claiming a boundary this
    layer does not have.
    """
    source = EGRESS_POLICY_DESCRIPTOR if descriptor is None else descriptor
    return tuple(
        as_text(policy["tier"]) or ""
        for policy in source.get("tier_policies", ())
        if as_text(policy.get("disposition")) != "not_expressed_by_this_layer"
    )


def all_tiers(descriptor: Mapping[str, Any] | None = None) -> tuple[str, ...]:
    """Every tier the descriptor covers, in declared order."""
    source = EGRESS_POLICY_DESCRIPTOR if descriptor is None else descriptor
    return tuple(as_text(policy["tier"]) or "" for policy in source.get("tier_policies", ()))


def declared_loopback_ports(
    descriptor: Mapping[str, Any] | None = None,
) -> Mapping[int, Mapping[str, Any]]:
    """Every port a declared loopback service may listen on, keyed by port.

    All of a service's candidates, because the allocator may bind any of them. A port with
    no entry here is a port no tier is allowed, which is the rule that keeps the loopback
    allowlist a list of services rather than a list of numbers.
    """
    source = EGRESS_POLICY_DESCRIPTOR if descriptor is None else descriptor
    by_port: dict[int, Mapping[str, Any]] = {}
    for policy in source.get("loopback_endpoints", ()):
        for port in policy.get("ports", ()):
            by_port[int(port)] = deepcopy(dict(policy))
    return by_port


def tier_loopback_ports(
    tier: str, descriptor: Mapping[str, Any] | None = None
) -> list[int]:
    """The loopback ports one tier may reach under a descriptor, sorted and once each.

    Every port of every reachable service whose ``reachable_from`` names the tier, one that
    requires a credential included: the allowlist the loopback rule blocks the complement
    of. The same function as ``egressTierLoopbackPorts`` on the TypeScript side, reading
    the same table of which dispositions allow reach, and the planner adds the host's
    dynamic port range to it for a tier that allows that range.
    """
    source = EGRESS_POLICY_DESCRIPTOR if descriptor is None else descriptor
    allows_reach = EGRESS_POLICY_RULES["loopback_disposition_allows_reach"]
    ports: set[int] = set()
    for policy in source.get("loopback_endpoints", ()):
        disposition = as_text(policy.get("loopback_disposition")) or ""
        if not allows_reach.get(disposition, False):
            continue
        if tier not in {as_text(member) for member in policy.get("reachable_from", ())}:
            continue
        ports.update(int(port) for port in policy.get("ports", ()))
    return sorted(ports)


def wfp_filters(rule_class: str) -> list[dict[str, str]]:
    """The filters one object of a rule class becomes, at each of its layers."""
    layers = EGRESS_POLICY_RULES["wfp_layers_by_class"][rule_class]
    shapes = EGRESS_POLICY_RULES["wfp_filters_by_class"][rule_class]
    return [
        {"layer": layer, "match": shape["match"], "transport": shape["transport"]}
        for layer in layers
        for shape in shapes
    ]


def wfp_filter_key(object_key: str, layer: str, match: str, transport: str) -> str:
    """One WFP filter's key, derived the way ``egressWfpFilterKey`` derives it.

    SHA-256 over the domain, the object key, the layer, the match and the transport, one per
    line; the first sixteen bytes with the version nibble set to 8 and the RFC 4122 variant.
    ``uuid.UUID(bytes=...)`` reads those bytes as big-endian fields, which is the spelling
    the shared golden vectors pin.
    """
    domain = EGRESS_POLICY_RULES["wfp_filter_key_domain"]
    source = f"{domain}\n{object_key}\n{layer}\n{match}\n{transport}"
    digest = bytearray(hashlib.sha256(source.encode()).digest()[:16])
    digest[6] = (digest[6] & 0x0F) | 0x80
    digest[8] = (digest[8] & 0x3F) | 0x80
    return str(uuid.UUID(bytes=bytes(digest)))


def wfp_provider_data(plan: Mapping[str, Any]) -> str:
    """The ``providerData`` tag every object a plan installs carries.

    The same canonical digest the descriptor gate uses, over the plan as JSON data, after
    the contract's fixed prefix. A readback that finds a different tag found an object an
    older plan, or a re-provisioned account, left behind.
    """
    return EGRESS_POLICY_RULES["wfp_provider_data_prefix"] + descriptor_digest(plan)
