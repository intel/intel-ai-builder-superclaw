"""Cross-field rules for the isolation report of authority section 6.3.

Production code calls ``validate_isolation_report``, never
``IsolationReportShape.model_validate``: the generated model checks field shapes and
nothing else, and every rule that keeps a report from reading safer than its evidence is
here.

Nothing in this module measures anything. It reads a report some other component
assembled and answers whether that report is allowed to say what it says. The rule tables
come from ``contracts.isolation_reporting_data``, generated from
``shared/contracts/src/isolation-reporting.ts``, so a level's requirements, the token
shapes that owe a warning and the one boundary state that counts as closed exist once. The
rules themselves necessarily exist twice, once as the Zod refinement and once here, and
the shared table ``shared/contracts/test-fixtures/isolation-report-cases.json`` is what
holds the two to one behaviour.

Absent evidence fails closed: a report that cannot show what a level requires does not get
that level, and ``fail_closed_isolation_report`` is the report to publish when there is no
evidence at all. No field here holds a path, and no rule here reads one.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Iterable, Mapping, Sequence
from copy import deepcopy
from dataclasses import dataclass
from enum import Enum
from typing import Any

from contracts.isolation_report import (
    BackendMode,
    EnforcedTier,
    IsolationLevel,
    IsolationReportShape,
    IsolationTokenShape,
    Verdict as AttestationVerdict,
)
from contracts.isolation_report_refusal import (
    IsolationReportRefusal as IsolationReportRefusalContract,
)
from contracts.isolation_report_refusal import PolicyCategory, Reason
from contracts.isolation_reporting_data import (
    ISOLATION_FAIL_CLOSED_REPORTS,
    ISOLATION_REPORT_CONTRACT_VERSION,
    ISOLATION_REPORTING_RULES,
)
from pydantic import TypeAdapter, ValidationError

_LEVEL_FACTS: Mapping[str, Mapping[str, Any]] = ISOLATION_REPORTING_RULES["level_facts"]
_TOKEN_SHAPE_FACTS: Mapping[str, Mapping[str, Any]] = ISOLATION_REPORTING_RULES[
    "token_shape_facts"
]
_EGRESS_BOUNDARY_CLOSED_STATE: str = ISOLATION_REPORTING_RULES[
    "egress_boundary_closed_state"
]
_EGRESS_BOUNDARY_POSTURE: Mapping[str, str] = ISOLATION_REPORTING_RULES[
    "egress_boundary_posture"
]
_EGRESS_ENFORCED_TIER_COVERAGE: Mapping[str, str] = ISOLATION_REPORTING_RULES[
    "egress_enforced_tier_coverage"
]
_EGRESS_READBACK_FACTS: Mapping[str, Mapping[str, bool]] = ISOLATION_REPORTING_RULES[
    "egress_readback_facts"
]
_EGRESS_VERSION_LABEL_PATTERN = re.compile(
    ISOLATION_REPORTING_RULES["egress_version_label_pattern"]
)
_INSTANT_PATTERN = re.compile(ISOLATION_REPORTING_RULES["instant_pattern"])
_PROBE_SET_ID_PATTERN = re.compile(ISOLATION_REPORTING_RULES["probe_set_id_pattern"])
_WORKSPACE_ROOT_COUNT_MAX: int = ISOLATION_REPORTING_RULES["workspace_root_count_max"]
_SHAPE_ISSUE_REASONS: Mapping[str, Mapping[str, Any]] = ISOLATION_REPORTING_RULES[
    "shape_issue_reasons"
]
_CROSS_FIELD_RULES_CONTINUE_AFTER = frozenset(
    ISOLATION_REPORTING_RULES["cross_field_rules_continue_after"]
)
_DISCRIMINATED_UNION_FIELDS: Mapping[str, str] = ISOLATION_REPORTING_RULES[
    "discriminated_union_fields"
]
_FIELD_LOCAL_REFUSAL_REASONS: Mapping[str, Sequence[str]] = ISOLATION_REPORTING_RULES[
    "field_local_refusal_reasons"
]
_TIERS_REQUIRING_LAUNCH_EVIDENCE: tuple[str, ...] = tuple(
    ISOLATION_REPORTING_RULES["tiers_requiring_launch_evidence"]
)
_LEVEL_NOT_ESTABLISHED = "not_established"
_ATTESTATION_PASS = AttestationVerdict.pass_.value

_WARNING_TOKEN_HARDENING = "token_hardening_unverified"
_WARNING_ATTESTATION_NOT_PASSING = "policy_attestation_not_passing"
_WARNING_LEVEL_NOT_ESTABLISHED = "isolation_level_not_established"
_WARNING_EGRESS_DRIFTED = "egress_policy_drifted"


@dataclass(frozen=True)
class IsolationRefusalItem:
    """One machine-readable refusal.

    Carries a reason and, when the reason is about one policy category, that category.
    Never a path, never an identifier a caller could act on.
    """

    reason: Reason
    policy_category: PolicyCategory | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.reason, Reason):
            raise TypeError(
                "a refusal reason must be a member of the generated vocabulary, not "
                + type(self.reason).__name__
            )
        if self.policy_category is not None and not isinstance(
            self.policy_category, PolicyCategory
        ):
            raise TypeError(
                "a refusal policy category must be a member of the generated "
                "vocabulary, not " + type(self.policy_category).__name__
            )


class IsolationReportRefusal(ValueError):
    """An isolation report was refused, with typed reasons."""

    def __init__(self, items: Sequence[IsolationRefusalItem]) -> None:
        self.items = tuple(items)
        self.reasons = tuple(item.reason for item in self.items)
        super().__init__(
            "isolation report refused: "
            + ", ".join(sorted({item.reason.value for item in self.items}))
        )

    def as_contract(self) -> IsolationReportRefusalContract:
        """Render the refusal as the wire shape."""
        return IsolationReportRefusalContract.model_validate(
            {
                "contract_version": ISOLATION_REPORT_CONTRACT_VERSION,
                "refusals": [
                    {
                        "reason": item.reason.value,
                        "policy_category": (
                            None
                            if item.policy_category is None
                            else item.policy_category.value
                        ),
                    }
                    for item in self.items
                ],
            }
        )


def validate_isolation_report(payload: Mapping[str, object]) -> IsolationReportShape:
    """Validate a report or raise IsolationReportRefusal.

    Shape first, then cross-field rules. Which reasons a shape failure produces, whether
    the cross-field rules run after one, and which reasons are raised by a field's own
    schema and so do not wait for them, are the published policy of
    ``shape_issue_reasons``, ``cross_field_rules_continue_after`` and
    ``field_local_refusal_reasons`` rather than this module's own reading, because the same
    report has to be refused for the same reasons on the TypeScript surface.

    Every field is read once on its own before the report is read as a whole, because the
    generated model's answer for one field depends on the others: a value it can only accept
    by changing it is invisible in a report that fails at some other field, and it is
    precisely the report that fails elsewhere where a coerced field would otherwise be
    handed to a rule.
    """
    fields = _field_readings(payload)
    try:
        model = IsolationReportShape.model_validate(payload)
    except ValidationError as exc:
        raise IsolationReportRefusal(
            _shape_failure_items(
                payload, _shape_issue_kinds(exc) + fields.kinds, fields
            )
        ) from exc
    if fields.kinds:
        raise IsolationReportRefusal(
            _shape_failure_items(payload, fields.kinds, fields)
        )
    items = collect_refusals(model.model_dump(mode="json"))
    if items:
        raise IsolationReportRefusal(items)
    return model


def fail_closed_isolation_report(backend_mode: str | BackendMode) -> dict[str, Any]:
    """Return the published fail-closed report for one backend mode.

    The report every surface publishes when nothing has applied the isolation policy: no
    level, no versions, no proven hardening, no passing attestation, an empty root set, and
    a warning for each of those. Read from the generated data rather than spelled by each
    caller, because a default each surface writes for itself is a default one surface gets
    wrong, and validated on the way out so a generated default that stopped satisfying the
    rules cannot ship quietly.
    """
    mode = backend_mode.value if isinstance(backend_mode, BackendMode) else backend_mode
    report = ISOLATION_FAIL_CLOSED_REPORTS.get(mode)
    if report is None:
        raise KeyError(f"no fail-closed isolation report for backend mode {mode!r}")
    payload = deepcopy(report)
    validate_isolation_report(payload)
    return payload


_PYDANTIC_ERROR_KINDS: Mapping[str, str] = {
    "string_pattern_mismatch": "malformed",
    "string_too_short": "below_bound",
    "string_too_long": "above_bound",
    "too_short": "below_bound",
    "too_long": "above_bound",
    "greater_than": "below_bound",
    "greater_than_equal": "below_bound",
    "less_than": "above_bound",
    "less_than_equal": "above_bound",
    "enum": "not_a_member",
    "literal_error": "not_a_member",
    "extra_forbidden": "unknown_field",
}


def _error_kind(error_type: str) -> str:
    """Translate one Pydantic error type into a published shape issue kind.

    Anything not listed is ``wrong_type``: every remaining Pydantic type - ``string_type``,
    ``int_type``, ``model_type``, ``missing`` and the rest - says the value is not of the
    field's type, which is the kind after which neither validator runs the cross-field
    rules. Defaulting this way means a Pydantic version that adds an error type fails
    closed, refusing more rather than reporting a rule that did not run.
    """
    return _PYDANTIC_ERROR_KINDS.get(error_type, "wrong_type")


def _shape_issue_reason(field: str, kind: str) -> Reason:
    """The named reason for one field's shape failure, or the generic one.

    Keyed on field and kind together, from the published table. The TypeScript twin
    ``shapeIssueReason`` reads the same table: an absent count and a count of nine are both
    refused, and only one of them is above the bound.
    """
    named = _SHAPE_ISSUE_REASONS.get(field)
    if named is not None and kind in named["kinds"]:
        return Reason(named["reason"])
    return Reason.report_shape_invalid


def _shape_failure_items(
    payload: Mapping[str, object],
    kinds: tuple[tuple[str, str], ...],
    fields: _FieldReadings,
) -> tuple[IsolationRefusalItem, ...]:
    """Reasons for a report that failed its field shapes.

    One reason per failing field, then the refusals a field's own schema raises for the
    fields that did parse, then the cross-field rules - but those last only when every
    failure is of a kind both validators continue after. Zod aborts a refinement after a
    wrong type, a value outside a closed vocabulary or an unknown key, so running the rules
    here in those cases would refuse the same report for more reasons on this side than on
    the other, and the reason set is what the contract publishes.
    """
    items = [
        IsolationRefusalItem(_shape_issue_reason(field, kind)) for field, kind in kinds
    ]
    items.extend(_field_local_refusals(payload, fields.readable))
    if all(kind in _CROSS_FIELD_RULES_CONTINUE_AFTER for _, kind in kinds):
        items.extend(collect_refusals(payload))
    return tuple(dict.fromkeys(items)) or (
        IsolationRefusalItem(Reason.report_shape_invalid),
    )


def _shape_issue_kinds(exc: ValidationError) -> tuple[tuple[str, str], ...]:
    """One (field, kind) pair per shape failure, with untagged-union noise dropped.

    The generated model spells the report's discriminated unions untagged, so Pydantic tries
    every member of one and reports a failure on the discriminator for each member that does
    not match, next to the real failure. Zod picks the one member the discriminator names and
    reports only its issues. Left alone the difference is not cosmetic: every failure inside
    such a field would carry a ``not_a_member``, so the gate above would never continue for
    that field whatever the real failure was, and ``cross_field_rules_continue_after`` would
    be published policy that does not hold where the report keeps its warnings.

    Which fields these are, and which property discriminates each, is read from
    ``discriminated_union_fields`` rather than known here. When no branch matched, the
    discriminator itself is what is wrong: everything is kept, and Zod reports that as one
    union issue which aborts the same way.
    """
    errors = list(exc.errors())
    dropped: set[int] = set()
    for prefix, branches in _union_branches(errors).items():
        discriminator = _DISCRIMINATED_UNION_FIELDS[str(prefix[0])]
        matched = {
            tag
            for tag, members in branches.items()
            if not any(
                len(errors[index]["loc"]) == len(prefix) + 2
                and str(errors[index]["loc"][-1]) == discriminator
                for index in members
            )
        }
        if not matched:
            continue
        for tag, members in branches.items():
            if tag not in matched:
                dropped.update(members)
    return tuple(
        (
            str(error["loc"][-1]) if error["loc"] else "",
            _error_kind(str(error["type"])),
        )
        for index, error in enumerate(errors)
        if index not in dropped
    )


def _union_branches(
    errors: Sequence[Mapping[str, Any]],
) -> dict[tuple[Any, ...], dict[Any, list[int]]]:
    """Group error indices by union occurrence, then by the member Pydantic was trying.

    A failure inside one of these fields is located as ``(field, member index, model name,
    ...)``, so the occurrence is the first two segments and the branch is the third. A failure
    of the field itself - not a list at all - is shorter than that and belongs to no branch.
    """
    groups: dict[tuple[Any, ...], dict[Any, list[int]]] = {}
    for index, error in enumerate(errors):
        loc = error["loc"]
        if len(loc) < 3 or str(loc[0]) not in _DISCRIMINATED_UNION_FIELDS:
            continue
        groups.setdefault(tuple(loc[:2]), {}).setdefault(loc[2], []).append(index)
    return groups


@dataclass(frozen=True)
class _FieldReadings:
    """What reading each field of the report on its own said about it.

    ``readable`` is the fields that are of this contract's type and were not changed to get
    there, which is the condition under which Zod runs a field's own checks and therefore the
    condition under which the refusals of ``field_local_refusal_reasons`` are reported.
    ``kinds`` is the ``wrong_type`` pairs for the rest, in the shape
    ``_shape_failure_items`` takes.
    """

    readable: frozenset[str]
    kinds: tuple[tuple[str, str], ...]


# One adapter per field of the report, rebuilt with the field's own constraints so that
# reading a field alone gives the same answer the whole model would. Built once: a
# TypeAdapter compiles its validator.
_FIELD_ADAPTERS: Mapping[str, TypeAdapter[Any]] = {
    name: TypeAdapter(info.rebuild_annotation())
    for name, info in IsolationReportShape.model_fields.items()
}


def _field_readings(payload: Mapping[str, object]) -> _FieldReadings:
    """Read every field of the report on its own, before reading the report.

    The generated models carry ``extra="forbid"`` but not ``strict=True``, so Pydantic's lax
    mode reads ``"1"`` and ``True`` as the integer 1 where Zod refuses both outright. Left
    alone, that is an acceptance divergence rather than a reason divergence: a report whose
    ``isolation_policy_version`` is a boolean would satisfy a level's
    ``requires_policy_versions`` gate here and be refused there, which is exactly the
    forgeable evidence this contract exists to prevent.

    A field the model can only read by changing it is therefore a field that was not of this
    contract's type, reported as ``wrong_type`` through the same table a Zod ``invalid_type``
    goes through, and - like a wrong type on either side - it stops the cross-field pass
    instead of letting a rule read a value the producer did not send.

    Per field rather than by comparing the validated report against the payload, because that
    comparison needs a report that validated: a ``False`` that Pydantic reads as 0 and then
    refuses for being below the bound, or a ``"2"`` in a report that fails at some other
    field, would both be invisible, and would leave this side running rules Zod aborted.
    """
    readable: set[str] = set()
    kinds: list[tuple[str, str]] = []
    for field, adapter in _FIELD_ADAPTERS.items():
        if field not in payload:
            continue
        value = payload[field]
        try:
            validated = adapter.validate_python(value)
        except ValidationError:
            # The field is refused either way, and its own error is already classified from
            # the whole-report pass. What is asked here is only whether the refusal came
            # after a coercion, because a bound failure lets the cross-field rules run and a
            # wrong type does not.
            if _not_of_declared_type(adapter, value):
                kinds.append((field, "wrong_type"))
            continue
        if _same_json_value(
            _json_value(value), adapter.dump_python(validated, mode="json", exclude_unset=True)
        ):
            readable.add(field)
        else:
            kinds.append((field, "wrong_type"))
    return _FieldReadings(frozenset(readable), tuple(kinds))


def _not_of_declared_type(adapter: TypeAdapter[Any], value: object) -> bool:
    """Whether a value the field refused was not of the field's type to begin with.

    Pydantic's strict mode is the only oracle for this that does not restate the field's type
    here, but it answers a stricter question than JSON has: a generated ``Enum`` member is not
    the string that names it and a model is not the mapping that spells it, both of which it
    reports as ``is_instance_of``. Only an error about the value's own type - Pydantic names
    every one of those ``<type>_type`` - and only one raised about the value itself rather
    than something inside it, is read as an answer. A number this contract declares as an
    integer is not asked about here at all: lax mode accepts ``1.0`` as the integer 1, which
    is what Zod does with the same JSON, so it never reaches this function.
    """
    try:
        adapter.validate_python(value, strict=True)
    except ValidationError as exc:
        return any(
            not error["loc"] and str(error["type"]).endswith("_type")
            for error in exc.errors()
        )
    return False


def _same_json_value(left: object, right: object) -> bool:
    """Equality that does not read a boolean as the integer it equals.

    ``True == 1`` in Python, so ``!=`` cannot see the coercion the caller above exists to
    catch: a ``True`` that Pydantic read as the integer 1 compares equal to it, and the field
    then satisfies a level's ``requires_policy_versions`` gate or a coverage rule's "the root
    count is not zero" here while Zod refuses the same payload. A float is deliberately not a
    coercion: JSON has one number type, so ``1.0`` is the integer 1 on the Zod side too.

    Applied to the whole value rather than to the top-level field, because a boolean inside the
    attestation or inside the egress version is the same forgery one level down.
    """
    if isinstance(left, bool) != isinstance(right, bool):
        return False
    if isinstance(left, Mapping) and isinstance(right, Mapping):
        return left.keys() == right.keys() and all(
            _same_json_value(left[key], right[key]) for key in left
        )
    if _is_list(left) and _is_list(right):
        return len(left) == len(right) and all(
            _same_json_value(item, other)
            for item, other in zip(left, right, strict=True)
        )
    return left == right


def _is_list(value: object) -> bool:
    return isinstance(value, Sequence) and not isinstance(value, str | bytes)


def collect_refusals(payload: Mapping[str, object]) -> tuple[IsolationRefusalItem, ...]:
    """Return every reason this report must be refused for.

    Not the validator, and deliberately not re-exported by the ``native_isolation``
    package: it answers "which of these rules does this payload break", so an empty
    mapping breaks none of them and comes back clean. Every rule reads the payload
    defensively for the same reason - this runs on reports that already failed their shape
    at one field, and a rule that cannot read what it needs yields nothing rather than
    guessing. ``validate_isolation_report`` is the entry point that turns a clean answer
    into an accepted report, and it checks the shape first.

    Deduplicated by reason and category, so one broken rule reads as one problem.
    """
    items: list[IsolationRefusalItem] = []
    items.extend(_field_shape_refusals(payload))
    items.extend(_egress_version_refusals(payload))
    items.extend(_warning_pairing_refusals(payload))
    items.extend(_tier_evidence_refusals(payload))
    items.extend(_attestation_refusals(payload))
    items.extend(_level_refusals(payload))
    items.extend(_workspace_root_refusals(payload))
    return tuple(dict.fromkeys(items))


def _field_shape_refusals(
    payload: Mapping[str, object],
) -> Iterable[IsolationRefusalItem]:
    """The three field shapes this contract names a reason for.

    Here as well as in the generated model because a value-level shape failure still gets
    the cross-field pass, and a reason the wire shape publishes has to be produced by the
    same function whichever way the report arrived.
    """
    probe_set_id = _attestation(payload).get("probe_set_id")
    if isinstance(probe_set_id, str) and not _PROBE_SET_ID_PATTERN.fullmatch(
        probe_set_id
    ):
        yield IsolationRefusalItem(Reason.probe_set_id_shape_invalid)
    if probe_set_id is not None and not isinstance(probe_set_id, str):
        yield IsolationRefusalItem(Reason.probe_set_id_shape_invalid)

    version = payload.get("isolation_egress_policy_version")
    if isinstance(version, Mapping):
        label = version.get("version_label")
        if not isinstance(label, str) or not _EGRESS_VERSION_LABEL_PATTERN.fullmatch(
            label
        ):
            yield IsolationRefusalItem(Reason.egress_version_label_shape_invalid)

    count = _root_count(payload)
    if count is not None and count > _WORKSPACE_ROOT_COUNT_MAX:
        # Above the bound only. A negative count is refused too, but by the field's type and
        # under the generic reason: "above bound" is a statement about the report, and a
        # count of -1 does not make it true. The published table keys this reason on the
        # `above_bound` kind for the same reason.
        yield IsolationRefusalItem(Reason.workspace_root_count_above_bound)


def _egress_version_refusals(
    payload: Mapping[str, object],
) -> Iterable[IsolationRefusalItem]:
    """The egress version's own invariants.

    The label and the boundary state have to have come from one descriptor:
    ``egress_descriptors.boundary_state`` only returns an enforcing state for a descriptor
    whose posture is enforcing, so a pair that disagrees is a pair assembled from two
    places. The enforced tiers have to be the ones the state closes, each once. The
    readback has an instant exactly when it ran.

    Skipped when the label or the instant is malformed. That field did not parse, and this
    also runs inside the cross-field pass, which continues after a pattern failure; the Zod
    refinement returns early on the same two patterns. Asking a malformed label which
    posture it names would add a reason that says nothing.
    """
    version = payload.get("isolation_egress_policy_version")
    if not isinstance(version, Mapping):
        return
    label = version.get("version_label")
    state = _scalar(version.get("boundary_state"))
    if not isinstance(label, str) or not _EGRESS_VERSION_LABEL_PATTERN.fullmatch(label):
        return
    readback = version.get("readback")
    read_at = readback.get("read_at") if isinstance(readback, Mapping) else None
    if read_at is not None and (
        not isinstance(read_at, str) or not _INSTANT_PATTERN.fullmatch(read_at)
    ):
        return
    posture = _EGRESS_BOUNDARY_POSTURE.get(str(state))
    if posture is None:
        return
    if not label.endswith(f"/{posture}"):
        yield IsolationRefusalItem(
            Reason.egress_version_label_disagrees_with_boundary_state,
            PolicyCategory.egress,
        )
    if not _enforced_tiers_agree_with_boundary_state(
        version.get("enforced_tiers"), str(state)
    ):
        yield IsolationRefusalItem(
            Reason.egress_enforced_tiers_disagree_with_boundary_state,
            PolicyCategory.egress,
        )
    verdict = _readback_verdict(payload)
    if verdict is not None and _EGRESS_READBACK_FACTS[verdict]["ran"] != (
        read_at is not None
    ):
        yield IsolationRefusalItem(
            Reason.egress_readback_instant_disagrees_with_verdict,
            PolicyCategory.egress,
        )


def _enforced_tiers_agree_with_boundary_state(tiers: object, state: str) -> bool:
    """Whether the enforced tiers are as many as the state closes, each named once."""
    if not isinstance(tiers, Sequence) or isinstance(tiers, str | bytes):
        return False
    named = [_closed_value(tier, EnforcedTier) for tier in tiers]
    distinct = set(named)
    if None in distinct or len(distinct) != len(named):
        return False
    coverage = _EGRESS_ENFORCED_TIER_COVERAGE.get(state)
    if coverage == "every_tier":
        return len(distinct) == len(EnforcedTier)
    if coverage == "some_tiers":
        return 0 < len(distinct) < len(EnforcedTier)
    if coverage == "no_tier":
        return not distinct
    return False


# The rules Zod keeps in a field's own type rather than in the report's refinement, one entry
# per field of `field_local_refusal_reasons`. They are reported whenever that field parsed,
# with no cross-field gate in front of them, because that is when Zod runs the field's checks:
# a disagreeing egress pair is refused by name even in a report that also failed somewhere
# else. A test holds the reasons these functions yield to the published table.
_FIELD_LOCAL_RULES: Mapping[
    str, Callable[[Mapping[str, object]], Iterable[IsolationRefusalItem]]
] = {
    "isolation_egress_policy_version": _egress_version_refusals,
}


def _field_local_refusals(
    payload: Mapping[str, object],
    readable: frozenset[str],
) -> Iterable[IsolationRefusalItem]:
    for field, rule in _FIELD_LOCAL_RULES.items():
        if field in readable:
            yield from rule(payload)


def _warning_pairing_refusals(
    payload: Mapping[str, object],
) -> Iterable[IsolationRefusalItem]:
    warnings = _warnings(payload)
    token_shape = _closed_value(
        payload.get("isolation_token_shape"), IsolationTokenShape
    )
    token_warnings = [
        warning
        for warning in warnings
        if warning.get("code") == _WARNING_TOKEN_HARDENING
    ]
    if token_shape is not None:
        if (
            _TOKEN_SHAPE_FACTS[token_shape]["requires_hardening_warning"]
            and not token_warnings
        ):
            yield IsolationRefusalItem(Reason.token_shape_requires_hardening_warning)
        for warning in token_warnings:
            if warning.get("token_shape") != token_shape:
                yield IsolationRefusalItem(
                    Reason.hardening_warning_disagrees_with_token_shape
                )

    verdict = _verdict(payload)
    attestation_warnings = [
        warning
        for warning in warnings
        if warning.get("code") == _WARNING_ATTESTATION_NOT_PASSING
    ]
    if verdict is not None:
        if verdict != _ATTESTATION_PASS and not attestation_warnings:
            yield IsolationRefusalItem(Reason.attestation_not_passing_requires_warning)
        for warning in attestation_warnings:
            if warning.get("verdict") != verdict:
                yield IsolationRefusalItem(
                    Reason.attestation_warning_disagrees_with_verdict
                )

    level = _closed_value(payload.get("isolation_level"), IsolationLevel)
    not_established = any(
        warning.get("code") == _WARNING_LEVEL_NOT_ESTABLISHED for warning in warnings
    )
    if level is not None:
        if level == _LEVEL_NOT_ESTABLISHED and not not_established:
            yield IsolationRefusalItem(Reason.level_not_established_requires_warning)
        if level != _LEVEL_NOT_ESTABLISHED and not_established:
            yield IsolationRefusalItem(
                Reason.not_established_warning_disagrees_with_level
            )

    yield from _not_established_reason_refusals(payload, warnings)

    verdict = _readback_verdict(payload)
    drift = (
        verdict is not None
        and _EGRESS_READBACK_FACTS[verdict]["requires_drift_warning"]
    )
    drift_warned = any(
        warning.get("code") == _WARNING_EGRESS_DRIFTED for warning in warnings
    )
    if drift and not drift_warned:
        yield IsolationRefusalItem(
            Reason.egress_drift_requires_warning, PolicyCategory.egress
        )
    if drift_warned and not drift:
        yield IsolationRefusalItem(
            Reason.egress_drift_warning_disagrees_with_readback, PolicyCategory.egress
        )


def _not_established_reason_refusals(
    payload: Mapping[str, object],
    warnings: Sequence[Mapping[str, object]],
) -> Iterable[IsolationRefusalItem]:
    """The reason a level was not established has to be one the report shows.

    The reason is the one part of the fail-closed path a producer picks by hand, so left
    unchecked a report that applied nothing could blame a failed attestation and every
    other rule here would still pass. These are necessary conditions rather than
    proofs: nothing in a shape-only report can show that policy was in fact applied.

    The table is keyed on the same closed vocabulary as the TypeScript
    ``ISOLATION_NOT_ESTABLISHED_REASON_FACTS``, and a test asserts it covers the generated
    enum, so a fifth reason cannot arrive with nothing behind it.
    """
    for warning in warnings:
        if warning.get("code") != _WARNING_LEVEL_NOT_ESTABLISHED:
            continue
        reason = warning.get("reason")
        check = _NOT_ESTABLISHED_REASON_CHECKS.get(str(reason))
        # A reason with no entry is a reason nothing backs. Reachable only if the generated
        # vocabulary gains a member and this table does not, which a test also fails on; the
        # refusal is here so that the runtime behaviour of that mistake is a refused report
        # rather than a report accepted by a rule that did not run. The TypeScript twin gets
        # this from its mapped type, where the same mistake is a compile error.
        if check is None or not check(payload):
            yield IsolationRefusalItem(
                Reason.not_established_reason_disagrees_with_report
            )


def _missing_a_policy_version(payload: Mapping[str, object]) -> bool:
    return (
        payload.get("isolation_policy_version") is None
        or payload.get("isolation_egress_policy_version") is None
    )


def _missing_both_policy_versions(payload: Mapping[str, object]) -> bool:
    return (
        payload.get("isolation_policy_version") is None
        and payload.get("isolation_egress_policy_version") is None
    )


# Each entry answers "does the rest of the report show this reason", and each one owes every
# part of the claim its own reason spells: the two that say policy was applied require the
# evidence that shows it, and the one that says nothing was applied requires the absence the
# other two report. The launch evidence reason requires that some tier's launch evidence is
# missing or incomplete.
_NOT_ESTABLISHED_REASON_CHECKS: Mapping[str, Callable[[Mapping[str, object]], bool]] = {
    "native_isolation_not_applied": _missing_both_policy_versions,
    "policy_version_unavailable": _missing_a_policy_version,
    "attestation_not_passing": lambda payload: _verdict(payload) != _ATTESTATION_PASS,
    "tier_launch_evidence_incomplete": lambda payload: not _tier_evidence_holds(
        payload, _launch_evidence_complete
    ),
}


def _attestation_refusals(
    payload: Mapping[str, object],
) -> Iterable[IsolationRefusalItem]:
    attestation = _attestation(payload)
    verdict = _verdict(payload)
    covered = _covered_categories(payload)
    if verdict == _ATTESTATION_PASS:
        if (
            attestation.get("probe_set_id") is None
            or attestation.get("last_pass_at") is None
            or not covered
        ):
            yield IsolationRefusalItem(Reason.attestation_pass_without_probe_evidence)
    elif verdict is not None and covered:
        yield IsolationRefusalItem(Reason.attestation_coverage_claimed_without_pass)

    if "egress" in covered and not _boundary_is_closed(payload):
        yield IsolationRefusalItem(
            Reason.egress_coverage_claimed_without_closed_boundary,
            PolicyCategory.egress,
        )
    if "filesystem" in covered and _root_count(payload) == 0:
        yield IsolationRefusalItem(
            Reason.filesystem_coverage_claimed_without_workspace_root_evidence,
            PolicyCategory.filesystem,
        )
    if "identity" in covered and not _tier_evidence_holds(payload, _identity_verified):
        yield IsolationRefusalItem(
            Reason.identity_coverage_claimed_without_tier_identity_evidence,
            PolicyCategory.identity,
        )
    if "filesystem" in covered and not _tier_evidence_holds(
        payload, _acl_readback_matches
    ):
        yield IsolationRefusalItem(
            Reason.filesystem_coverage_claimed_without_acl_readback,
            PolicyCategory.filesystem,
        )


def _level_refusals(payload: Mapping[str, object]) -> Iterable[IsolationRefusalItem]:
    level = _closed_value(payload.get("isolation_level"), IsolationLevel)
    if level is None:
        return
    facts = _LEVEL_FACTS[level]
    verdict = _verdict(payload)
    if facts["requires_attestation_pass"] and verdict != _ATTESTATION_PASS:
        yield IsolationRefusalItem(Reason.level_requires_attestation_pass)
    covered = _covered_categories(payload)
    for category in facts["attested_policy_categories"]:
        if category not in covered:
            yield IsolationRefusalItem(
                Reason.attestation_coverage_missing_policy_category,
                PolicyCategory(category),
            )
    if facts["requires_closed_egress_boundary"] and not _boundary_is_closed(payload):
        yield IsolationRefusalItem(
            Reason.level_requires_closed_egress_boundary, PolicyCategory.egress
        )
    if facts["requires_policy_versions"]:
        if payload.get("isolation_policy_version") is None:
            yield IsolationRefusalItem(
                Reason.level_requires_file_policy_version, PolicyCategory.filesystem
            )
        if payload.get("isolation_egress_policy_version") is None:
            yield IsolationRefusalItem(
                Reason.level_requires_egress_policy_version, PolicyCategory.egress
            )
    if facts["requires_tier_job_evidence"] and not _tier_evidence_holds(
        payload, _job_verified
    ):
        yield IsolationRefusalItem(Reason.level_requires_tier_job_evidence)


def _tier_evidence_refusals(
    payload: Mapping[str, object],
) -> Iterable[IsolationRefusalItem]:
    """One entry per tier, holding the worst of that tier's running roles."""
    tiers = [tier for tier in _evidence_tiers(payload) if isinstance(tier, str)]
    if len(set(tiers)) != len(tiers):
        yield IsolationRefusalItem(Reason.tier_evidence_tier_repeated)


def _tier_evidence(payload: Mapping[str, object]) -> tuple[Mapping[str, object], ...]:
    """The tier evidence entries, each value unwrapped, or none when unreadable."""
    entries = payload.get("isolation_tier_evidence")
    if not _is_list(entries):
        return ()
    return tuple(
        {key: _scalar(value) for key, value in entry.items()}
        for entry in entries
        if isinstance(entry, Mapping)
    )


def _tier_evidence_holds(
    payload: Mapping[str, object],
    passes: Callable[[Mapping[str, object]], bool],
) -> bool:
    """Whether every named tier passes and the tiers no claim can do without are named.

    The TypeScript twin is ``tierEvidenceHolds``. Empty evidence never holds, whatever the
    required tiers are: there is no launch it could be about.
    """
    entries = _tier_evidence(payload)
    named = {tier for tier in _evidence_tiers(payload) if isinstance(tier, str)}
    return (
        bool(entries)
        and all(tier in named for tier in _TIERS_REQUIRING_LAUNCH_EVIDENCE)
        and all(passes(entry) for entry in entries)
    )


def _evidence_tiers(payload: Mapping[str, object]) -> list[object]:
    return [entry.get("tier") for entry in _tier_evidence(payload)]


def _identity_verified(entry: Mapping[str, object]) -> bool:
    return entry.get("identity") == "owner_kernel_verified"


def _acl_readback_matches(entry: Mapping[str, object]) -> bool:
    return entry.get("acl_readback") == "matches_shipped_descriptor"


def _job_verified(entry: Mapping[str, object]) -> bool:
    return entry.get("job") == "tier_reported_verified"


def _launch_evidence_complete(entry: Mapping[str, object]) -> bool:
    return (
        _identity_verified(entry)
        and _acl_readback_matches(entry)
        and _job_verified(entry)
    )


def _workspace_root_refusals(
    payload: Mapping[str, object],
) -> Iterable[IsolationRefusalItem]:
    count = _root_count(payload)
    classes = payload.get("isolation_workspace_root_classes")
    if count is None or not isinstance(classes, Sequence) or isinstance(classes, str):
        return
    if not 0 <= count <= _WORKSPACE_ROOT_COUNT_MAX:
        # The count's own shape is already refused, so comparing the class list against it
        # would add a second reason about a number nobody should read. The Zod refinement
        # skips the same rule for the same input.
        return
    if len(classes) != count:
        yield IsolationRefusalItem(Reason.workspace_root_classes_disagree_with_count)


def _boundary_is_closed(payload: Mapping[str, object]) -> bool:
    """Whether the report says egress is closed by policy, for every tier.

    Both halves of the field have to agree. ``boundary_state`` is the answer, because it
    is what C3 derives by counting rules per tier rather than by reading the posture word,
    but the closed state is only believed when the label's posture backs it. Writing the
    state word without the posture behind it is the one-word edit this slice exists to
    refuse, and it is refused twice over: as a disagreement of its own, and by not being
    read as closed here. The TypeScript twin ``reportedBoundaryIsClosed`` does the same,
    and the shared fixture holds them to it.

    And the readback has to confirm the plan. The state is what the policy says; the
    readback is the evidence that the filters saying it are installed.
    """
    version = payload.get("isolation_egress_policy_version")
    if not isinstance(version, Mapping):
        return False
    state = _scalar(version.get("boundary_state"))
    label = version.get("version_label")
    if state != _EGRESS_BOUNDARY_CLOSED_STATE:
        return False
    verdict = _readback_verdict(payload)
    if verdict is None or not _EGRESS_READBACK_FACTS[verdict]["confirms_plan"]:
        return False
    posture = _EGRESS_BOUNDARY_POSTURE.get(str(state))
    return isinstance(label, str) and label.endswith(f"/{posture}")


def _readback_verdict(payload: Mapping[str, object]) -> str | None:
    """The egress readback's verdict, or None when the report carries no readable one."""
    version = payload.get("isolation_egress_policy_version")
    if not isinstance(version, Mapping):
        return None
    readback = version.get("readback")
    if not isinstance(readback, Mapping):
        return None
    verdict = _scalar(readback.get("verdict"))
    if isinstance(verdict, str) and verdict in _EGRESS_READBACK_FACTS:
        return verdict
    return None


def _attestation(payload: Mapping[str, object]) -> Mapping[str, object]:
    attestation = payload.get("isolation_attestation")
    return attestation if isinstance(attestation, Mapping) else {}


def _verdict(payload: Mapping[str, object]) -> str | None:
    verdict = _scalar(_attestation(payload).get("verdict"))
    return verdict if isinstance(verdict, str) else None


def _covered_categories(payload: Mapping[str, object]) -> frozenset[str]:
    covered = _attestation(payload).get("covered_policy_categories")
    if not isinstance(covered, Sequence) or isinstance(covered, str | bytes):
        return frozenset()
    values = {_scalar(category) for category in covered}
    return frozenset(value for value in values if isinstance(value, str))


def _warnings(payload: Mapping[str, object]) -> tuple[Mapping[str, object], ...]:
    warnings = payload.get("isolation_warnings")
    if not isinstance(warnings, Sequence) or isinstance(warnings, str | bytes):
        return ()
    return tuple(
        {key: _scalar(value) for key, value in warning.items()}
        for warning in warnings
        if isinstance(warning, Mapping)
    )


def _scalar(value: object) -> object:
    """Unwrap a generated enum member to its string value, leaving anything else alone.

    ``datamodel-code-generator`` emits plain ``Enum`` classes, so a member is not equal to
    its value. Every field read here therefore goes through this, because a producer that
    imports the generated enums is the natural next caller and a comparison that silently
    misses would read as an absent value.
    """
    return value.value if isinstance(value, Enum) else value


def _json_value(value: object) -> object:
    """Normalize a field for comparison against generated data.

    ``_scalar`` for every leaf, recursively, so a producer that holds the generated enums
    compares equal to the JSON the data module publishes. Sequences become lists so a tuple
    and a list of the same members are one value; mappings keep their keys, which makes the
    comparison order-independent.
    """
    value = _scalar(value)
    if isinstance(value, Mapping):
        return {str(key): _json_value(item) for key, item in value.items()}
    if isinstance(value, Sequence) and not isinstance(value, str | bytes):
        return [_json_value(item) for item in value]
    return value


def _root_count(payload: Mapping[str, object]) -> int | None:
    count = payload.get("isolation_workspace_root_count")
    return count if isinstance(count, int) and not isinstance(count, bool) else None


def _closed_value(value: object, vocabulary: type[Enum]) -> str | None:
    """Return a closed-vocabulary field as its string value, or None when unreadable."""
    if isinstance(value, vocabulary):
        return str(value.value)
    if isinstance(value, str) and value in {member.value for member in vocabulary}:
        return value
    return None
