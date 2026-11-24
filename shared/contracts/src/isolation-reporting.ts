/**
 * Isolation reporting: what the product is allowed to say about its own boundary.
 *
 * This module is the reporting *shape* and its cross-field rules. It applies nothing,
 * measures nothing, and establishes nothing. Every value here is an observation some
 * other component has to earn: the identity and Job work (T2), the applied ACL and
 * egress policy (C5), and the runtime attestation of the authority document's section
 * 6.5 (C4b). What this module owns is the promise that a report cannot be assembled
 * into a combination that reads safer than the evidence behind it.
 *
 * Three properties are load-bearing, and each is a rule below rather than a note:
 *
 * 1. **No path, in any field.** The authority document's section 6.3 forbids it, and
 *    section 1.2's "no UI depends on a payload path" rule depends on it holding here.
 *    Every string-typed field in this report carries a regex or is a closed enum, so a
 *    path is not a value this shape can hold. A test asserts that over the whole schema
 *    rather than field by field, because the next field added is the one that forgets.
 * 2. **A level is a claim, so it is gated by the evidence for it.** `user` and
 *    `user_open_egress` require a passing attestation whose covered policy categories
 *    include everything that level's definition covers, plus both policy versions. `user`
 *    additionally requires a closed egress boundary, which is what makes "no code path
 *    reports `user` while the egress version is the permissive one" a refusal rather
 *    than a review habit.
 * 3. **Neighbouring enums are not independently settable.** A level, a token shape and
 *    an attestation verdict sitting next to each other in one object is exactly the
 *    shape where one word edit makes an open boundary read as closed. So the level's
 *    requirements come from `ISOLATION_LEVEL_FACTS`, the token shapes that owe a warning
 *    come from `ISOLATION_TOKEN_SHAPE_FACTS`, a warning that pairs with a value carries
 *    that value and is checked against it, and each claimed attestation coverage
 *    category has to be backed by the evidence field that would establish it.
 *
 * ## Where the `isolation_level` members come from
 *
 * The authority document never lists the enum, so it is derived, and the derivation is
 * recorded here so it can be checked against the documents rather than against memory:
 *
 * - `user`, `restricted` and `minimal` are the three rows of the authority document's
 *   section 6.2 table, with the master plan's section 1.4 giving the same three.
 * - `user_open_egress` is section 1.4's fourth level, added 2026-08-26 and confirmed on
 *   2026-09-01 as the first release's gate (master plan section 4.3, section 2.1 item
 *   8). The 2026-10-01 release decision made network isolation mandatory for v2.0; the
 *   2026-10-20 release decision reversed that, so it is again a v2.0 release level and a
 *   member of `ISOLATION_INSTALLED_RELEASE_LEVELS`. It is not a degraded spelling of
 *   `user`: it has its own row in `ISOLATION_LEVEL_FACTS` and its own required coverage. Section
 *   1.4 removes exactly two things from `user` to get it - per-SID per-tier default-deny
 *   egress, and the egress half of the runtime attestation - and those two removals are
 *   the two facts that differ between the rows.
 * - `not_established` is the fifth member, and it exists because the four above are
 *   claims. Section 1.4 says a medium integrity level or a low integrity level build is
 *   none of the four; section 6.2 says installed builds fail closed and never silently
 *   start as `restricted` or `minimal`; master plan section 7 forbids describing MIC or
 *   Low-IL as installed isolation. A fail-closed report therefore needs a value that
 *   claims nothing, and an enum without one would force a producer with no evidence to
 *   pick the weakest *claim* instead. It is not launchable on an installed release: it
 *   is absent from `ISOLATION_INSTALLED_RELEASE_LEVELS`, and it owes a warning naming
 *   why no level was established.
 *
 * There is deliberately no `unknown` for the level and no `degraded`. "Which level" and
 * "why not" are two questions, and the second one is a warning with a typed reason.
 *
 * Generated from Zod to JSON Schema and Pydantic by scripts/gen.mjs.
 */

import { z } from "zod";
import { EgressLoopbackOpenTcpRangeSchema } from "./egress-loopback-dynamic-range.js";

import {
  EGRESS_BOUNDARY_CLOSED_STATE,
  EgressBoundaryStateSchema,
  EgressIsolationTierSchema,
  EgressPostureSchema,
} from "./egress-policy-vocabulary.js";
import type {
  EgressBoundaryState,
  EgressIsolationTier,
  EgressPosture,
} from "./egress-policy-vocabulary.js";
import {
  WORKSPACE_ROOT_SET_MAX_MEMBERS,
  WorkspaceRootIdSchema,
  WorkspaceRootPolicyClassSchema,
  WorkspaceRootRefusalReasonSchema,
} from "./workspace-root-vocabulary.js";

export const ISOLATION_REPORT_CONTRACT_VERSION = 3 as const;
export const IsolationReportContractVersionSchema = z.literal(
  ISOLATION_REPORT_CONTRACT_VERSION
);

/**
 * Which backend produced the report.
 *
 * The one value `sandbox_manager.native_backend.backend_mode` returns. The field stays in the
 * report as a fact a reader can check rather than an assumption, and a second backend would
 * be a new member here together with the rules that say what it may report.
 */
export const IsolationBackendModeSchema = z.enum(["native"]);
export type IsolationBackendMode = z.infer<typeof IsolationBackendModeSchema>;

/**
 * The policy categories a runtime attestation can cover.
 *
 * Not a free list. The authority document's section 6.5 probe set is identity (each
 * probe runs as its tier identity, against a control run from a trusted layer),
 * filesystem (a protected placeholder read that must fail, a write outside the declared
 * roots that must fail, a write inside them that must succeed) and egress (an external
 * connection that must fail, a declared loopback endpoint that must succeed). The master
 * plan's I7 row scopes a `user_open_egress` report to the first two and requires the
 * reported result to say which categories it covered, which is why coverage is a field
 * and not an assumption.
 */
export const IsolationPolicyCategorySchema = z.enum([
  "identity",
  "filesystem",
  "egress",
]);
export type IsolationPolicyCategory = z.infer<typeof IsolationPolicyCategorySchema>;

/** The isolation level reached, or the fail-closed value that claims nothing. */
export const IsolationLevelSchema = z.enum([
  "user",
  "user_open_egress",
  "restricted",
  "minimal",
  "not_established",
]);
export type IsolationLevel = z.infer<typeof IsolationLevelSchema>;

type LevelFacts = {
  /** Section 6.2's product policy column: source and development environments only. */
  readonly dev_environment_only: boolean;
  /** Whether reporting this level requires `isolation_attestation.verdict === "pass"`. */
  readonly requires_attestation_pass: boolean;
  /** What a passing attestation has to have covered for this level to be claimable. */
  readonly attested_policy_categories: readonly IsolationPolicyCategory[];
  /** Whether this level requires egress to be closed by policy. */
  readonly requires_closed_egress_boundary: boolean;
  /** Whether this level requires both applied policy versions to be reported. */
  readonly requires_policy_versions: boolean;
  /** Whether this level requires Job evidence for every tier `isolation_tier_evidence` names. */
  readonly requires_tier_job_evidence: boolean;
};

/**
 * What each level requires, as data rather than as branches.
 *
 * A mapped type over the union, so adding a level is a compile error until its facts are
 * written. The alternative - a chain of `if (level === ...)` in the refinement - is how
 * a new level ends up gated by nothing.
 *
 * `restricted` and `minimal` require no attestation and no versions because neither
 * claims applied policy: section 6.2 defines them as a restricted token derived from the
 * developer's own user plus a Job, and Job limits alone. They are development levels, so
 * the fields they leave empty are honestly empty rather than unproven.
 */
export const ISOLATION_LEVEL_FACTS: { readonly [L in IsolationLevel]: LevelFacts } = {
  user: {
    dev_environment_only: false,
    requires_attestation_pass: true,
    attested_policy_categories: ["identity", "filesystem", "egress"],
    requires_closed_egress_boundary: true,
    requires_policy_versions: true,
    requires_tier_job_evidence: true,
  },
  user_open_egress: {
    dev_environment_only: false,
    requires_attestation_pass: true,
    attested_policy_categories: ["identity", "filesystem"],
    requires_closed_egress_boundary: false,
    requires_policy_versions: true,
    requires_tier_job_evidence: true,
  },
  restricted: {
    dev_environment_only: true,
    requires_attestation_pass: false,
    attested_policy_categories: [],
    requires_closed_egress_boundary: false,
    requires_policy_versions: false,
    requires_tier_job_evidence: false,
  },
  minimal: {
    dev_environment_only: true,
    requires_attestation_pass: false,
    attested_policy_categories: [],
    requires_closed_egress_boundary: false,
    requires_policy_versions: false,
    requires_tier_job_evidence: false,
  },
  not_established: {
    dev_environment_only: false,
    requires_attestation_pass: false,
    attested_policy_categories: [],
    requires_closed_egress_boundary: false,
    requires_policy_versions: false,
    requires_tier_job_evidence: false,
  },
};

/**
 * The levels an installed release may launch at.
 *
 * `user` is the master plan's section 4.3 target. `user_open_egress` is the v2.0 gate:
 * the 2026-10-20 release decision (Lin) accepts it, reversing the 2026-10-01 decision that
 * required network isolation, so file isolation still gates v2.0 and network
 * enforcement (N3) does not. `not_established` is
 * absent on purpose: an installed build that cannot establish a level fails closed and
 * refuses to launch, so it reports that value while refusing, and a gate that accepted
 * it would be the silent `restricted` start section 6.2 forbids. A test asserts this
 * set is exactly the levels that are not development-only and that require a passing
 * attestation, so a level cannot join it without also owing the evidence.
 */
export const ISOLATION_INSTALLED_RELEASE_LEVELS = ["user", "user_open_egress"] as const;

/**
 * The token hardening evidence of section 1.2, as the closed enum of section 6.3.
 *
 * Ordered strongest to weakest, one member per decided S1 outcome. No member of this
 * enum decides whether `user` is reached: identity, Job, ACL, egress policy, tier policy
 * and the section 6.5 attestation decide that. The two weakest members are reportable at
 * `user` and each owes an `isolation_warnings[]` entry naming the hardening that is
 * missing or unproven, which is corollary 1 of section 1.2 and is enforced below.
 */
export const IsolationTokenShapeSchema = z.enum([
  "restricted_all_access",
  "write_restricted_synthetic",
  "write_restricted_logon",
  "unrestricted_hardened",
  "unknown",
]);
export type IsolationTokenShape = z.infer<typeof IsolationTokenShapeSchema>;

type TokenShapeFacts = {
  /** Whether the token carries a restricting SID at all. Section 6.3's table. */
  readonly restricting_sid_present: boolean;
  /**
   * Whether reporting this shape owes a `token_hardening_unverified` warning.
   *
   * Not derived from the column above, though today it happens to be its negation. The
   * policy is one-directional: no restricting SID always owes a warning, and a test
   * asserts that direction. A shape that does carry one may still owe a warning later,
   * when there is something to verify about which SIDs it carries, so the obligation is
   * recorded per row instead of computed.
   */
  readonly requires_hardening_warning: boolean;
};

export const ISOLATION_TOKEN_SHAPE_FACTS: {
  readonly [S in IsolationTokenShape]: TokenShapeFacts;
} = {
  restricted_all_access: {
    restricting_sid_present: true,
    requires_hardening_warning: false,
  },
  write_restricted_synthetic: {
    restricting_sid_present: true,
    requires_hardening_warning: false,
  },
  write_restricted_logon: {
    restricting_sid_present: true,
    requires_hardening_warning: false,
  },
  unrestricted_hardened: {
    restricting_sid_present: false,
    requires_hardening_warning: true,
  },
  unknown: {
    restricting_sid_present: false,
    requires_hardening_warning: true,
  },
};

/**
 * The token shapes that owe a warning.
 *
 * Spelled as its own schema so the warning that discharges the obligation can only name
 * a shape that has one. A warning that could name `restricted_all_access` would be a
 * warning about nothing, and it would satisfy the pairing rule for a report whose actual
 * shape is `unknown`.
 *
 * Written out rather than filtered out of the facts table above: a `z.enum` over a
 * computed list needs a cast to keep its literal type, and a cast is the thing that would
 * stop failing when the two disagree. A test asserts these are exactly the shapes whose
 * facts say they owe a warning.
 */
export const IsolationTokenShapeRequiringWarningSchema = z.enum([
  "unrestricted_hardened",
  "unknown",
]);
export type IsolationTokenShapeRequiringWarning = z.infer<
  typeof IsolationTokenShapeRequiringWarningSchema
>;

/**
 * The section 6.5 attestation verdict. Exhaustive, and `stale` is not a weak `pass`.
 *
 * Section 6.3 defines the transitions, because a timestamp alone cannot tell a consumer
 * when a `pass` expired: `pass` holds only inside a declared validity window shorter
 * than the periodic run interval; it becomes `stale` the moment that window expires or
 * any invalidating event happens without a new result (resume from suspend, fast user
 * switching, session change, broker restart, an `isolation_policy_version` change, a
 * section 4.1.1 root set change, or a control run that cannot establish its
 * preconditions); it becomes `fail` when a probe ran and its result contradicts policy.
 * Before launch `stale` is treated exactly as `fail` and refuses launch, because the
 * product cannot tell an expired result from a broken boundary.
 */
export const IsolationAttestationVerdictSchema = z.enum(["pass", "fail", "stale"]);
export type IsolationAttestationVerdict = z.infer<
  typeof IsolationAttestationVerdictSchema
>;

/** The two verdicts that owe a warning and, before launch, refuse it. */
export const IsolationAttestationVerdictNotPassingSchema = z.enum(["fail", "stale"]);
export type IsolationAttestationVerdictNotPassing = z.infer<
  typeof IsolationAttestationVerdictNotPassingSchema
>;

/**
 * The probe set identifier: a digest, not a description.
 *
 * Section 6.5 derives the probe set from the currently effective root set rather than
 * from a fixed list, and a change to that set invalidates the last result. So this is an
 * identifier over a set, and the shape is fixed here for one blunt reason: it is the only
 * field on this surface that a producer might be tempted to fill with something readable,
 * and something readable about a root set is a path. Deriving it is section 6.5's job,
 * not this slice's. Like `root_id`, it is a label: it grants nothing and proves nothing.
 */
export const ISOLATION_PROBE_SET_ID_PATTERN = /^pst_[0-9a-f]{64}$/;
export const IsolationProbeSetIdSchema = z
  .string()
  .regex(ISOLATION_PROBE_SET_ID_PATTERN);

export const ISOLATION_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

/** RFC 3339 UTC instant, spelled as `granted_at` is in the native path contract. */
export const IsolationInstantSchema = z.string().regex(ISOLATION_INSTANT_PATTERN);

/**
 * The attestation, carrying the verdict, the probe set it came from, and its last pass.
 *
 * `covered_policy_categories` is what makes the verdict readable. A bare `pass` says
 * "something passed", and the master plan's I7 row requires the reported result to state
 * which policy categories it covered - which is the difference between an attestation
 * of identity and filesystem, and one that attested egress too.
 * Coverage is the input and the level is the consequence: the rules below check that the
 * level's required categories are covered and that each covered category is backed by
 * the evidence that would establish it, rather than deriving coverage from the level.
 */
export const IsolationAttestationSchema = z
  .object({
    verdict: IsolationAttestationVerdictSchema,
    probe_set_id: IsolationProbeSetIdSchema.nullable(),
    last_pass_at: IsolationInstantSchema.nullable(),
    covered_policy_categories: z.array(IsolationPolicyCategorySchema),
  })
  .strict();
export type IsolationAttestation = z.infer<typeof IsolationAttestationSchema>;

/**
 * How a tier's identity was established for this launch.
 *
 * `owner_kernel_verified`: the launcher read the runner's token SID through the process
 * handle it kept from the logon, and the Sandbox Manager found it to be the SID it resolved
 * for that tier's account, not the owner's, and no other tier's. Anything else is
 * `not_verified`, because a tier's own word about who it runs as is not identity evidence.
 */
export const IsolationTierIdentityEvidenceSchema = z.enum(["owner_kernel_verified", "not_verified"]);

/**
 * What the launcher's DACL readback found on the roots it bound, before it started a role.
 *
 * `matches_shipped_descriptor` also needs the Sandbox Manager to have found the descriptor
 * the launcher compared against to be the one its own ACL plan came from. This is
 * configuration evidence: it shows the roots carry the intended DACLs, not that a tier is
 * actually refused, which is what the section 6.5 filesystem probes show.
 */
export const IsolationTierAclReadbackSchema = z.enum([
  "matches_shipped_descriptor",
  "drifted",
  "not_read",
]);

/**
 * What the tier's runner reported about a role's Job before resuming it: membership
 * verified, and the limits read back equal to the tier's profile. Reported from inside the
 * tier, and named so, because nothing outside it checked.
 */
export const IsolationTierJobEvidenceSchema = z.enum(["tier_reported_verified", "not_reported"]);

/**
 * One tier's launch evidence, as the worst of what that tier's running roles showed.
 *
 * One entry per tier rather than per role, so a tier is as good as its weakest role, and a
 * role that exited or restarted stops counting until its next launch reports again. No SID,
 * path or digest: those stay between the Sandbox Manager and the broker, because this
 * surface carries no host identifier.
 */
export const IsolationTierEvidenceSchema = z
  .object({
    tier: EgressIsolationTierSchema,
    identity: IsolationTierIdentityEvidenceSchema,
    acl_readback: IsolationTierAclReadbackSchema,
    job: IsolationTierJobEvidenceSchema,
    observed_at: IsolationInstantSchema,
  })
  .strict();
export type IsolationTierEvidence = z.infer<typeof IsolationTierEvidenceSchema>;

/**
 * The tiers whose launch evidence identity or filesystem coverage cannot do without.
 *
 * Every tier `isolation_tier_evidence` names has to pass as well; these two have to be
 * named, because they run in every Product Profile and hold the agent's files. A Profile
 * without the Connector launches no network connector role, so that tier is held to its
 * evidence only when it ran.
 */
export const ISOLATION_TIERS_REQUIRING_LAUNCH_EVIDENCE: readonly EgressIsolationTier[] = [
  "bootstrap",
  "file_tool",
];

/** The `v<n>/<posture>` grammar of `egress_descriptors.version_label()`. */
export const ISOLATION_EGRESS_VERSION_LABEL_PATTERN =
  /^v[1-9][0-9]*\/(?:permissive|enforcing)$/;

/**
 * Which posture a boundary state implies.
 *
 * A mapped type over C3's boundary state union, so a new boundary state is a compile
 * error here until someone says what posture it can be seen under. It exists because the
 * label and the state are two readings of one policy: `egress_descriptors.boundary_state`
 * only returns an enforcing state when the descriptor's posture is `enforcing`, so a
 * report pairing `v1/permissive` with `primary_enforcing` is a report whose two halves
 * came from different places. Nothing downstream would notice, and the wrong half is the
 * one that reads closed.
 */
export const ISOLATION_EGRESS_BOUNDARY_POSTURE: {
  readonly [S in EgressBoundaryState]: EgressPosture;
} = {
  primary_enforcing: "enforcing",
  primary_rules_do_not_cover_every_tier: "enforcing",
  declared_permissive_no_rules: "permissive",
  primary_logging_only: "permissive",
  supplementary_only_not_a_boundary: "permissive",
  removed_by_uninstall: "permissive",
};

/**
 * Which tiers `enforced_tiers` may name under each boundary state.
 *
 * A mapped type over C3's boundary state union, for the same reason as the posture map
 * above: a new state is a compile error here until someone says how much of the tier
 * vocabulary it can close. `some_tiers` is a non-empty proper subset, because a boundary
 * that covers nobody is not partial and one that covers everybody is not partial either.
 */
export const ISOLATION_EGRESS_ENFORCED_TIER_COVERAGE: {
  readonly [S in EgressBoundaryState]: "every_tier" | "some_tiers" | "no_tier";
} = {
  primary_enforcing: "every_tier",
  primary_rules_do_not_cover_every_tier: "some_tiers",
  declared_permissive_no_rules: "no_tier",
  primary_logging_only: "no_tier",
  supplementary_only_not_a_boundary: "no_tier",
  removed_by_uninstall: "no_tier",
};

/**
 * What the unelevated WFP readback found, compared with the plan that was applied.
 *
 * It reads by key, and its reach is the objects the contract can own: our sublayer when
 * the plan asks for it (`install_sublayer`), and every filter key the plan derives for
 * this owner, from the objects it plans and from its removals. It also enumerates our own
 * sublayer when the caller may (an unelevated one may not, and the readback says so), so a
 * filter in it that the plan does not name is drift too. A filter in some other sublayer is
 * outside what any verdict here speaks about.
 */
export const IsolationEgressReadbackVerdictSchema = z.enum([
  "matches_plan",
  "drifted",
  "not_read",
]);
export type IsolationEgressReadbackVerdict = z.infer<
  typeof IsolationEgressReadbackVerdictSchema
>;

/**
 * What each readback verdict says, as the rules below read it.
 *
 * - `ran`: the readback happened, so it has the instant it happened at.
 * - `confirms_plan`: every filter the contract can own for this owner was read by key and
 *   is as the plan says - each planned one present and identical, each other one absent.
 *   It says nothing about filters whose key the contract does not derive. Only then can
 *   the boundary read closed: a descriptor that says `primary_enforcing` is intent, and
 *   the readback is the evidence that the intent is installed.
 * - `requires_drift_warning`: the report owes an `egress_policy_drifted` warning.
 */
export const ISOLATION_EGRESS_READBACK_FACTS: {
  readonly [V in IsolationEgressReadbackVerdict]: {
    readonly ran: boolean;
    readonly confirms_plan: boolean;
    readonly requires_drift_warning: boolean;
  };
} = {
  matches_plan: { ran: true, confirms_plan: true, requires_drift_warning: false },
  drifted: { ran: true, confirms_plan: false, requires_drift_warning: true },
  not_read: { ran: false, confirms_plan: false, requires_drift_warning: false },
};

/** The last readback of the installed filters: its verdict and the instant it ran. */
export const IsolationEgressReadbackSchema = z
  .object({
    verdict: IsolationEgressReadbackVerdictSchema,
    read_at: IsolationInstantSchema.nullable(),
  })
  .strict();
export type IsolationEgressReadback = z.infer<typeof IsolationEgressReadbackSchema>;

function enforcedTiersAgreeWithBoundaryState(
  tiers: readonly EgressIsolationTier[],
  state: EgressBoundaryState
): boolean {
  const distinct = new Set(tiers);
  if (distinct.size !== tiers.length) {
    return false;
  }
  const everyTier = EgressIsolationTierSchema.options.length;
  switch (ISOLATION_EGRESS_ENFORCED_TIER_COVERAGE[state]) {
    case "every_tier":
      return distinct.size === everyTier;
    case "some_tiers":
      return distinct.size > 0 && distinct.size < everyTier;
    case "no_tier":
      return distinct.size === 0;
  }
}

/**
 * The applied egress policy version, as a label plus what the boundary actually is.
 *
 * One nullable object rather than separate nullable fields, because the values have to
 * agree and siblings can disagree about whether any of them is present at all.
 *
 * The label is `egress_descriptors.version_label()`, never the bare `policy_version`
 * integer: the shipped descriptor and the built-in enforcing reference are both
 * `policy_version=1` and differ only in posture, so a bare `1` cannot tell a permissive
 * release from an enforcing one. This is the whole reason an empty permissive rule set is
 * reported as a version rather than as a missing field.
 *
 * `boundary_state` is `egress_descriptors.boundary_state()`, which counts rules per tier
 * against the tier vocabulary rather than reading the posture word. It is the machine's
 * state, covering every tier, because `isolation_level` is a product-wide claim and
 * section 1.4's `user` requires per-SID per-tier default-deny egress. The level reads this
 * state and nothing narrower.
 *
 * `enforced_tiers` is the per-tier reading (C3's `egressTierBoundaryIsClosed`): the tiers
 * the applied policy closes. It is what lets a partly covering boundary - M1 closes
 * bootstrap and file_tool and not network_connector - say where it is closed, without the
 * level claiming anything per tier. It has to agree with the state.
 *
 * `readback` is the unelevated WFP readback (design 2026-10-01 section 6.8). The boundary
 * reads closed only when the readback confirms the plan, so a drifted or unread boundary
 * cannot hold `user`.
 */
export const IsolationEgressPolicyVersionSchema = z
  .object({
    version_label: z.string().regex(ISOLATION_EGRESS_VERSION_LABEL_PATTERN),
    boundary_state: EgressBoundaryStateSchema,
    enforced_tiers: z.array(EgressIsolationTierSchema),
    readback: IsolationEgressReadbackSchema,
    /**
     * The loopback TCP range the installed plan leaves open to every tier (EG2-11), from the
     * plan that was installed. Absent when the plan has no such gap, as the shipped one.
     * An `enforced` boundary with this field is enforced minus these ports.
     */
    loopback_open_tcp_range: EgressLoopbackOpenTcpRangeSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const readAt = value.readback.read_at;
    if (
      !ISOLATION_EGRESS_VERSION_LABEL_PATTERN.test(value.version_label) ||
      (readAt !== null && !ISOLATION_INSTANT_PATTERN.test(readAt))
    ) {
      // The field's own shape is already refused, and a pattern failure is one of the
      // kinds Zod continues into a refinement after - see
      // `ISOLATION_CROSS_FIELD_RULES_CONTINUE_AFTER`. The Python side runs these rules only
      // over a field that parsed, so both skip them, and asking a malformed label which
      // posture it names would add a reason that says nothing.
      return;
    }
    const posture = ISOLATION_EGRESS_BOUNDARY_POSTURE[value.boundary_state];
    if (!value.version_label.endsWith(`/${posture}`)) {
      context.addIssue({
        code: "custom",
        path: ["version_label"],
        params: {
          reason: "egress_version_label_disagrees_with_boundary_state",
          policy_category: "egress",
        },
        message: `boundary state ${value.boundary_state} is only reachable under posture ${posture}`,
      });
    }
    if (!enforcedTiersAgreeWithBoundaryState(value.enforced_tiers, value.boundary_state)) {
      context.addIssue({
        code: "custom",
        path: ["enforced_tiers"],
        params: {
          reason: "egress_enforced_tiers_disagree_with_boundary_state",
          policy_category: "egress",
        },
        message: `under ${value.boundary_state} enforced_tiers names ${ISOLATION_EGRESS_ENFORCED_TIER_COVERAGE[value.boundary_state]}, each at most once`,
      });
    }
    if (ISOLATION_EGRESS_READBACK_FACTS[value.readback.verdict].ran !== (readAt !== null)) {
      context.addIssue({
        code: "custom",
        path: ["readback", "read_at"],
        params: {
          reason: "egress_readback_instant_disagrees_with_verdict",
          policy_category: "egress",
        },
        message: `a ${value.readback.verdict} readback has an instant exactly when it ran`,
      });
    }
  });
export type IsolationEgressPolicyVersion = z.infer<
  typeof IsolationEgressPolicyVersionSchema
>;

/** Why no isolation level was established. Every member is a fail-closed branch. */
export const IsolationLevelNotEstablishedReasonSchema = z.enum([
  /** The native backend is running and nothing has applied the isolation policy. */
  "native_isolation_not_applied",
  /** Policy was applied and its version could not be read back. */
  "policy_version_unavailable",
  /** Policy was applied and the section 6.5 attestation is not passing. */
  "attestation_not_passing",
  /** A tier's launch evidence is missing, or one of its three parts did not pass. */
  "tier_launch_evidence_incomplete",
]);
export type IsolationLevelNotEstablishedReason = z.infer<
  typeof IsolationLevelNotEstablishedReasonSchema
>;

/**
 * A workspace root that was refused, or applied in a form weaker than its class.
 *
 * Carries `root_id` and a typed reason, never a path. A refused root does not by itself
 * prevent `user`: the boundary over the remaining members is unaffected and refusing a
 * grant is the correct fail-closed outcome rather than a policy failure. A member whose
 * descriptor did not fully apply is a section 6.5 `fail`, and that is what blocks launch.
 */
export const WorkspaceRootDegradedWarningSchema = z
  .object({
    code: z.literal("workspace_root_degraded"),
    root_id: WorkspaceRootIdSchema.nullable(),
    reason: WorkspaceRootRefusalReasonSchema,
  })
  .strict();

/** The hardening that is missing or unproven, for the two shapes that owe one. */
export const TokenHardeningUnverifiedWarningSchema = z
  .object({
    code: z.literal("token_hardening_unverified"),
    token_shape: IsolationTokenShapeRequiringWarningSchema,
  })
  .strict();

/** A `fail` or `stale` attestation, which section 6.3 requires to be warned about. */
export const PolicyAttestationNotPassingWarningSchema = z
  .object({
    code: z.literal("policy_attestation_not_passing"),
    verdict: IsolationAttestationVerdictNotPassingSchema,
  })
  .strict();

/** Why the report claims no level. Required whenever it claims none. */
export const IsolationLevelNotEstablishedWarningSchema = z
  .object({
    code: z.literal("isolation_level_not_established"),
    reason: IsolationLevelNotEstablishedReasonSchema,
  })
  .strict();

/**
 * The installed egress filters no longer match the applied plan. Required whenever the
 * readback says so; the readback itself is the locator, so this entry carries none.
 */
export const EgressPolicyDriftedWarningSchema = z
  .object({
    code: z.literal("egress_policy_drifted"),
  })
  .strict();

/**
 * The installed plan leaves a loopback TCP range open to every tier, so `enforced` does not
 * mean those ports are unreachable. Carries the range the egress evidence carries.
 */
export const LoopbackDynamicRangeOpenWarningSchema = z
  .object({
    code: z.literal("loopback_dynamic_range_open"),
    first: EgressLoopbackOpenTcpRangeSchema.shape.first,
    last: EgressLoopbackOpenTcpRangeSchema.shape.last,
  })
  .strict();

/**
 * Why the host's proxy cannot be chained to.
 *
 * The first five classify a proxy value, in the order the classifier tests them: the first
 * that applies is the kind.
 *
 * - `unsupported_scheme`: a scheme other than http or https, such as socks.
 * - `tls_to_proxy`: an `https://` proxy.
 * - `credentials`: a user name or password in the URL.
 * - `missing_port`: no port.
 * - `malformed`: anything else, a value without a scheme included.
 *
 * The last comes from the Windows setting rather than a value:
 *
 * - `proxy_auto_config`: a PAC script and no manual proxy. Going direct there could bypass
 *   the proxy the script would have chosen.
 * - `loopback_upstream`: a proxy on the machine itself, such as a local authenticating
 *   proxy. The network connector tier's way to an upstream proxy is a permit through its
 *   internal block, and a permit on loopback would open a loopback port.
 */
export const EgressUpstreamUnsupportedKindSchema = z.enum([
  "unsupported_scheme",
  "tls_to_proxy",
  "credentials",
  "missing_port",
  "malformed",
  "proxy_auto_config",
  "loopback_upstream",
]);
export type EgressUpstreamUnsupportedKind = z.infer<typeof EgressUpstreamUnsupportedKindSchema>;

/**
 * The egress proxy cannot chain to the host's proxy, so it refuses every tunnel rather
 * than going direct. No reported field holds the upstream proxy, so nothing pairs with
 * this entry; the kind says what to fix.
 */
export const EgressUpstreamUnsupportedWarningSchema = z
  .object({
    code: z.literal("egress_upstream_unsupported"),
    kind: EgressUpstreamUnsupportedKindSchema,
  })
  .strict();

/**
 * The host MCP gateway is running MCP servers or its Edge for the user, as the signed-in user.
 *
 * The level is unchanged, because no tier's isolation changed. What the report must still say is
 * that these tools run outside every tier's boundary, and outside its egress rules, including WFP
 * enforcement when that lands. No reported field holds the gateway's state, so nothing pairs with
 * this entry; the counts say what is running. Sandbox Manager reads them from the gateway's summary.
 */
export const HostMcpExecutionEnabledWarningSchema = z
  .object({
    code: z.literal("host_mcp_execution_enabled"),
    host_server_count: z.number().int().min(0),
    host_browser_active: z.boolean(),
  })
  .strict();

/**
 * The warnings a report may carry, as a discriminated union on `code`.
 *
 * A union rather than one object with nullable neighbours. The alternative was already
 * here for `workspace_root_degraded`, and extending it would have meant a
 * `token_hardening_unverified` entry that carries a `root_id` and a workspace refusal
 * reason, both null, plus nothing that ties the entry to the value it warns about. Each
 * member carries exactly the locator its code needs, and the rules below check that
 * locator against the field it duplicates.
 */
export const IsolationWarningSchema = z.discriminatedUnion("code", [
  WorkspaceRootDegradedWarningSchema,
  TokenHardeningUnverifiedWarningSchema,
  PolicyAttestationNotPassingWarningSchema,
  IsolationLevelNotEstablishedWarningSchema,
  EgressPolicyDriftedWarningSchema,
  EgressUpstreamUnsupportedWarningSchema,
  HostMcpExecutionEnabledWarningSchema,
  LoopbackDynamicRangeOpenWarningSchema,
]);
export type IsolationWarning = z.infer<typeof IsolationWarningSchema>;

/**
 * Why a report is refused.
 *
 * Every member is produced by a case in the shared fixture table, on both sides, and a
 * test asserts that: a reason no test can produce is a reason that looks like it works.
 */
export const IsolationReportRefusalReasonSchema = z.enum([
  /** The report does not have the field shapes of this contract. */
  "report_shape_invalid",
  /** The level requires a passing attestation and the verdict is not `pass`. */
  "level_requires_attestation_pass",
  /** The attestation did not cover a policy category this level is defined over. */
  "attestation_coverage_missing_policy_category",
  /** The level requires egress closed by policy and the boundary state is not closed. */
  "level_requires_closed_egress_boundary",
  /** The level requires the applied file policy version and it is absent. */
  "level_requires_file_policy_version",
  /** The level requires the applied egress policy version and it is absent. */
  "level_requires_egress_policy_version",
  /** The label's posture and the boundary state came from different descriptors. */
  "egress_version_label_disagrees_with_boundary_state",
  /** The version label is not the `v<n>/<posture>` grammar. */
  "egress_version_label_shape_invalid",
  /** The enforced tiers are not the ones the boundary state closes, or repeat one. */
  "egress_enforced_tiers_disagree_with_boundary_state",
  /** A readback that ran without its instant, or an instant for one that did not run. */
  "egress_readback_instant_disagrees_with_verdict",
  /** The readback found drift and no warning carries it. */
  "egress_drift_requires_warning",
  /** A drift warning next to a readback that found none. */
  "egress_drift_warning_disagrees_with_readback",
  /** The token shape owes a hardening warning and no entry carries it. */
  "token_shape_requires_hardening_warning",
  /** A hardening warning names a token shape the report does not report. */
  "hardening_warning_disagrees_with_token_shape",
  /** A `pass` without a probe set, a last pass instant, or any covered category. */
  "attestation_pass_without_probe_evidence",
  /** Coverage claimed under a verdict that is not `pass`. */
  "attestation_coverage_claimed_without_pass",
  /** The probe set identifier is not the digest shape. */
  "probe_set_id_shape_invalid",
  /** A `fail` or `stale` verdict with no warning entry carrying it. */
  "attestation_not_passing_requires_warning",
  /** An attestation warning names a verdict the report does not report. */
  "attestation_warning_disagrees_with_verdict",
  /** No level was established and no warning says why. */
  "level_not_established_requires_warning",
  /** A warning says no level was established and the report claims one. */
  "not_established_warning_disagrees_with_level",
  /** A warning blames a reason the rest of the report does not show. */
  "not_established_reason_disagrees_with_report",
  /** The class list and the count describe root sets of different sizes. */
  "workspace_root_classes_disagree_with_count",
  /** The count is above the section 4.1.1 bound on the root set. */
  "workspace_root_count_above_bound",
  /** Egress coverage claimed while the boundary is not closed by policy. */
  "egress_coverage_claimed_without_closed_boundary",
  /** Filesystem coverage claimed over a root set the report says is empty. */
  "filesystem_coverage_claimed_without_workspace_root_evidence",
  /** The tier evidence names one tier more than once. */
  "tier_evidence_tier_repeated",
  /** Identity coverage claimed without launcher-verified identity for the tiers it needs. */
  "identity_coverage_claimed_without_tier_identity_evidence",
  /** Filesystem coverage claimed without a matching ACL readback for the tiers it needs. */
  "filesystem_coverage_claimed_without_acl_readback",
  /** The level requires Job evidence and a tier it needs has none. */
  "level_requires_tier_job_evidence",
]);
export type IsolationReportRefusalReason = z.infer<
  typeof IsolationReportRefusalReasonSchema
>;

export const ISOLATION_REPORT_REFUSAL_REASONS =
  IsolationReportRefusalReasonSchema.options;

export const IsolationReportRefusalItemSchema = z
  .object({
    reason: IsolationReportRefusalReasonSchema,
    /** The category a coverage refusal is about. Null when the reason is not about one. */
    policy_category: IsolationPolicyCategorySchema.nullable(),
  })
  .strict();
export type IsolationReportRefusalItem = z.infer<typeof IsolationReportRefusalItemSchema>;

export const IsolationReportRefusalSchema = z
  .object({
    contract_version: IsolationReportContractVersionSchema,
    refusals: z.array(IsolationReportRefusalItemSchema).min(1),
  })
  .strict();
export type IsolationReportRefusal = z.infer<typeof IsolationReportRefusalSchema>;

/**
 * The reported fields, in the order the authority document's section 6.3 lists them.
 *
 * One object, spread into both the standalone `IsolationReportSchema` and
 * `SandboxStatusSchema`, so the detailed sandbox surface and the report a producer
 * validates cannot drift into two shapes. A test asserts the two key sets match.
 */
export const ISOLATION_REPORT_SHAPE = {
  backend_mode: IsolationBackendModeSchema,
  isolation_level: IsolationLevelSchema,
  /**
   * The applied file policy version, from `acl_descriptors`, or null when none is
   * applied. Separate from the egress version on purpose: one number covering both
   * would make a permissive egress rule set invisible behind an applied file policy.
   */
  isolation_policy_version: z.number().int().min(1).nullable(),
  isolation_egress_policy_version: IsolationEgressPolicyVersionSchema.nullable(),
  isolation_warnings: z.array(IsolationWarningSchema),
  isolation_token_shape: IsolationTokenShapeSchema,
  isolation_attestation: IsolationAttestationSchema,
  /** How many section 4.1.1 members the policy applied to. Never their paths. */
  isolation_workspace_root_count: z
    .number()
    .int()
    .min(0)
    .max(WORKSPACE_ROOT_SET_MAX_MEMBERS),
  /** Each applied member's section 4.2 policy class, in the same cardinality. */
  isolation_workspace_root_classes: z
    .array(WorkspaceRootPolicyClassSchema)
    .max(WORKSPACE_ROOT_SET_MAX_MEMBERS),
  /** This launch's evidence for each tier that ran a role. Never an account or a path. */
  isolation_tier_evidence: z
    .array(IsolationTierEvidenceSchema)
    .max(EgressIsolationTierSchema.options.length),
} as const;

/**
 * What the rules below read: the shape above, inferred rather than restated.
 *
 * Deliberately not a hand-written mirror of `ISOLATION_REPORT_SHAPE`. A `superRefine`
 * callback is contravariant in its argument, so a callback typed on nine fields is a
 * legal refinement of an object with ten: a field added to the shape and forgotten in a
 * hand-written mirror would compile, and every rule would simply stop being able to see
 * it. Inferring the type means the field either appears in the rules or is visibly
 * unread, which is the whole reason `ISOLATION_REPORT_SHAPE` is one object.
 */
const IsolationReportFieldsSchema = z.object(ISOLATION_REPORT_SHAPE);
type IsolationReportFields = z.infer<typeof IsolationReportFieldsSchema>;

type Refuse = (
  reason: IsolationReportRefusalReason,
  path: (string | number)[],
  policyCategory: IsolationPolicyCategory | null,
  message: string
) => void;

/**
 * The cross-field rules. JSON Schema cannot express any of them.
 *
 * They are collected here rather than restated in Python: the generated Pydantic model
 * checks field shapes and nothing else, and
 * `sandbox_manager.native_isolation.isolation_report_rules` reads the rule tables this
 * module publishes instead of keeping a second spelling of the policy, and both sides are
 * held to one behaviour by the shared fixture table
 * `shared/contracts/test-fixtures/isolation-report-cases.json`.
 */
export function refineIsolationReport(
  report: IsolationReportFields,
  context: z.RefinementCtx
): void {
  const refuse: Refuse = (reason, path, policyCategory, message) => {
    context.addIssue({
      code: "custom",
      path,
      params: { reason, policy_category: policyCategory },
      message,
    });
  };

  refineWarningPairing(report, refuse);
  refineTierEvidence(report, refuse);
  refineAttestation(report, refuse);
  refineLevel(report, refuse);
  refineWorkspaceRootEvidence(report, refuse);
}

function refineWarningPairing(report: IsolationReportFields, refuse: Refuse): void {
  const tokenWarnings = report.isolation_warnings.filter(
    (warning) => warning.code === "token_hardening_unverified"
  );
  if (ISOLATION_TOKEN_SHAPE_FACTS[report.isolation_token_shape].requires_hardening_warning) {
    if (tokenWarnings.length === 0) {
      refuse(
        "token_shape_requires_hardening_warning",
        ["isolation_warnings"],
        null,
        `token shape ${report.isolation_token_shape} is reportable only with a token_hardening_unverified warning`
      );
    }
  }
  for (const warning of tokenWarnings) {
    if (warning.token_shape !== report.isolation_token_shape) {
      refuse(
        "hardening_warning_disagrees_with_token_shape",
        ["isolation_warnings"],
        null,
        `a hardening warning names ${warning.token_shape} and the report reports ${report.isolation_token_shape}`
      );
    }
  }

  const verdict = report.isolation_attestation.verdict;
  const attestationWarnings = report.isolation_warnings.filter(
    (warning) => warning.code === "policy_attestation_not_passing"
  );
  if (verdict !== "pass" && attestationWarnings.length === 0) {
    refuse(
      "attestation_not_passing_requires_warning",
      ["isolation_warnings"],
      null,
      `attestation ${verdict} requires a policy_attestation_not_passing warning`
    );
  }
  for (const warning of attestationWarnings) {
    if (warning.verdict !== verdict) {
      refuse(
        "attestation_warning_disagrees_with_verdict",
        ["isolation_warnings"],
        null,
        `an attestation warning names ${warning.verdict} and the report reports ${verdict}`
      );
    }
  }

  const notEstablished = report.isolation_warnings.some(
    (warning) => warning.code === "isolation_level_not_established"
  );
  if (report.isolation_level === "not_established" && !notEstablished) {
    refuse(
      "level_not_established_requires_warning",
      ["isolation_warnings"],
      null,
      "a report that establishes no level has to say why"
    );
  }
  if (report.isolation_level !== "not_established" && notEstablished) {
    refuse(
      "not_established_warning_disagrees_with_level",
      ["isolation_warnings"],
      null,
      `a warning says no level was established and the report reports ${report.isolation_level}`
    );
  }
  for (const warning of report.isolation_warnings) {
    if (warning.code !== "isolation_level_not_established") {
      continue;
    }
    if (!ISOLATION_NOT_ESTABLISHED_REASON_FACTS[warning.reason].backed_by(report)) {
      refuse(
        "not_established_reason_disagrees_with_report",
        ["isolation_warnings"],
        null,
        `a warning blames ${warning.reason} and the rest of the report does not show it`
      );
    }
  }

  const readback = report.isolation_egress_policy_version?.readback ?? null;
  const drift =
    readback !== null && ISOLATION_EGRESS_READBACK_FACTS[readback.verdict].requires_drift_warning;
  const driftWarned = report.isolation_warnings.some(
    (warning) => warning.code === "egress_policy_drifted"
  );
  if (drift && !driftWarned) {
    refuse(
      "egress_drift_requires_warning",
      ["isolation_warnings"],
      "egress",
      "a readback that found drift requires an egress_policy_drifted warning"
    );
  }
  if (driftWarned && !drift) {
    refuse(
      "egress_drift_warning_disagrees_with_readback",
      ["isolation_warnings"],
      "egress",
      "a drift warning needs a readback that found drift"
    );
  }
}

/**
 * What the rest of the report has to show for each reason a level was not established.
 *
 * The reason is the operator-facing half of the fail-closed path, and it is the one field of
 * it a producer picks by hand. Left unchecked, a report that applied nothing could blame a
 * failed attestation, and every other rule here would still pass. A mapped type over the
 * closed reason enum, so a new reason is a compile error until somebody says what backs it.
 *
 * These are necessary conditions and not proofs: nothing in a shape-only report can show
 * that policy was in fact applied, which is exactly the limit section 2.1 item 8 puts on
 * this slice. What each entry does owe is every part of the claim its own reason spells.
 * Two of the four say policy was applied, so they require the versions that show it; the
 * first says nothing was applied, so it requires the absence the other two report. A reason
 * whose condition is weaker than its wording is a reason an operator reads as more than the
 * report shows.
 */
export const ISOLATION_NOT_ESTABLISHED_REASON_FACTS: {
  readonly [R in IsolationLevelNotEstablishedReason]: {
    readonly backed_by: (report: IsolationReportFields) => boolean;
  };
} = {
  native_isolation_not_applied: {
    // The strongest of the three reasons and therefore the narrowest condition: a report
    // that carries a policy version contradicts "nothing has applied the isolation policy"
    // within one document, which is a disagreement a shape-only report can see. It is the
    // bottom of a ladder whose next rung, `policy_version_unavailable`, needs only one of
    // the two versions missing.
    backed_by: (report) =>
      report.isolation_policy_version === null &&
      report.isolation_egress_policy_version === null,
  },
  policy_version_unavailable: {
    backed_by: (report) =>
      report.isolation_policy_version === null ||
      report.isolation_egress_policy_version === null,
  },
  attestation_not_passing: {
    backed_by: (report) => report.isolation_attestation.verdict !== "pass",
  },
  tier_launch_evidence_incomplete: {
    // A tier whose launch evidence is missing or short of one of its three parts.
    backed_by: (report) =>
      !tierEvidenceHolds(
        report,
        (entry) => identityVerified(entry) && aclReadbackMatches(entry) && jobVerified(entry)
      ),
  },
};

/**
 * Whether the report says egress is closed by policy, for every tier.
 *
 * Both halves of the field have to say so. `boundary_state` is the one that counts, since
 * it comes from counting rules per tier rather than from reading a posture word, but a
 * closed state next to a permissive label is a pair whose two halves came from different
 * descriptors, and the reading that would be safe is exactly the one being asserted. So
 * the pair is refused *and* it does not read as closed, which means no rule downstream can
 * be satisfied by editing one of the two words.
 *
 * And the readback has to confirm the plan. The state is what the policy says; the
 * readback is the evidence that the filters saying it are installed.
 */
function reportedBoundaryIsClosed(report: IsolationReportFields): boolean {
  const version = report.isolation_egress_policy_version;
  if (version === null || version.boundary_state !== EGRESS_BOUNDARY_CLOSED_STATE) {
    return false;
  }
  if (!ISOLATION_EGRESS_READBACK_FACTS[version.readback.verdict].confirms_plan) {
    return false;
  }
  const posture = ISOLATION_EGRESS_BOUNDARY_POSTURE[version.boundary_state];
  return version.version_label.endsWith(`/${posture}`);
}

/**
 * Whether the tier evidence holds `passes` for every tier it names, and names every tier in
 * `ISOLATION_TIERS_REQUIRING_LAUNCH_EVIDENCE`. Empty evidence never holds, whatever that list
 * says: there is no launch it could be about.
 */
function tierEvidenceHolds(
  report: IsolationReportFields,
  passes: (entry: IsolationTierEvidence) => boolean
): boolean {
  const entries = report.isolation_tier_evidence;
  return (
    entries.length > 0 &&
    ISOLATION_TIERS_REQUIRING_LAUNCH_EVIDENCE.every((tier) =>
      entries.some((entry) => entry.tier === tier)
    ) &&
    entries.every(passes)
  );
}

const identityVerified = (entry: IsolationTierEvidence): boolean =>
  entry.identity === "owner_kernel_verified";
const aclReadbackMatches = (entry: IsolationTierEvidence): boolean =>
  entry.acl_readback === "matches_shipped_descriptor";
const jobVerified = (entry: IsolationTierEvidence): boolean =>
  entry.job === "tier_reported_verified";

function refineTierEvidence(report: IsolationReportFields, refuse: Refuse): void {
  const tiers = report.isolation_tier_evidence.map((entry) => entry.tier);
  if (new Set(tiers).size !== tiers.length) {
    refuse(
      "tier_evidence_tier_repeated",
      ["isolation_tier_evidence"],
      null,
      "one entry per tier, holding the worst of that tier's running roles"
    );
  }
}

function refineAttestation(report: IsolationReportFields, refuse: Refuse): void {
  const attestation = report.isolation_attestation;
  const covered = new Set(attestation.covered_policy_categories);
  if (attestation.verdict === "pass") {
    if (
      attestation.probe_set_id === null ||
      attestation.last_pass_at === null ||
      covered.size === 0
    ) {
      refuse(
        "attestation_pass_without_probe_evidence",
        ["isolation_attestation"],
        null,
        "a pass needs the probe set it came from, the instant it passed, and what it covered"
      );
    }
  } else if (covered.size > 0) {
    refuse(
      "attestation_coverage_claimed_without_pass",
      ["isolation_attestation", "covered_policy_categories"],
      null,
      `a ${attestation.verdict} attestation covers nothing, and stale is treated as fail`
    );
  }

  if (covered.has("egress") && !reportedBoundaryIsClosed(report)) {
    refuse(
      "egress_coverage_claimed_without_closed_boundary",
      ["isolation_attestation", "covered_policy_categories"],
      "egress",
      "egress coverage over a boundary that is not closed by policy attests nothing"
    );
  }
  if (covered.has("filesystem") && report.isolation_workspace_root_count === 0) {
    refuse(
      "filesystem_coverage_claimed_without_workspace_root_evidence",
      ["isolation_attestation", "covered_policy_categories"],
      "filesystem",
      "filesystem coverage over an empty root set attests nothing"
    );
  }
  if (covered.has("identity") && !tierEvidenceHolds(report, identityVerified)) {
    refuse(
      "identity_coverage_claimed_without_tier_identity_evidence",
      ["isolation_attestation", "covered_policy_categories"],
      "identity",
      "identity coverage needs the launcher's own reading of each tier's identity"
    );
  }
  if (covered.has("filesystem") && !tierEvidenceHolds(report, aclReadbackMatches)) {
    refuse(
      "filesystem_coverage_claimed_without_acl_readback",
      ["isolation_attestation", "covered_policy_categories"],
      "filesystem",
      "filesystem coverage needs each tier's roots read back as the shipped descriptor"
    );
  }
}

function refineLevel(report: IsolationReportFields, refuse: Refuse): void {
  const facts = ISOLATION_LEVEL_FACTS[report.isolation_level];
  const attestation = report.isolation_attestation;
  if (facts.requires_attestation_pass && attestation.verdict !== "pass") {
    refuse(
      "level_requires_attestation_pass",
      ["isolation_level"],
      null,
      `level ${report.isolation_level} requires a passing attestation and the verdict is ${attestation.verdict}`
    );
  }
  const covered = new Set(attestation.covered_policy_categories);
  for (const category of facts.attested_policy_categories) {
    if (!covered.has(category)) {
      refuse(
        "attestation_coverage_missing_policy_category",
        ["isolation_attestation", "covered_policy_categories"],
        category,
        `level ${report.isolation_level} is defined over ${category} policy and the attestation did not cover it`
      );
    }
  }
  if (facts.requires_closed_egress_boundary && !reportedBoundaryIsClosed(report)) {
    refuse(
      "level_requires_closed_egress_boundary",
      ["isolation_egress_policy_version"],
      "egress",
      `level ${report.isolation_level} requires egress closed by policy`
    );
  }
  if (facts.requires_policy_versions) {
    if (report.isolation_policy_version === null) {
      refuse(
        "level_requires_file_policy_version",
        ["isolation_policy_version"],
        "filesystem",
        `level ${report.isolation_level} requires the applied file policy version`
      );
    }
    if (report.isolation_egress_policy_version === null) {
      refuse(
        "level_requires_egress_policy_version",
        ["isolation_egress_policy_version"],
        "egress",
        `level ${report.isolation_level} requires the applied egress policy version, permissive included`
      );
    }
  }
  if (facts.requires_tier_job_evidence && !tierEvidenceHolds(report, jobVerified)) {
    refuse(
      "level_requires_tier_job_evidence",
      ["isolation_tier_evidence"],
      null,
      `level ${report.isolation_level} requires Job evidence for every tier it runs`
    );
  }
}

function refineWorkspaceRootEvidence(
  report: IsolationReportFields,
  refuse: Refuse
): void {
  if (
    report.isolation_workspace_root_count < 0 ||
    report.isolation_workspace_root_count > WORKSPACE_ROOT_SET_MAX_MEMBERS
  ) {
    // The count's own bound is already refused, and a bound failure is one of the kinds
    // Zod continues into this refinement after - see
    // `ISOLATION_CROSS_FIELD_RULES_CONTINUE_AFTER`. Comparing the class list against a
    // number nobody should read would add a second reason about it. The Python side skips
    // the same rule for the same input.
    return;
  }
  if (
    report.isolation_workspace_root_classes.length !==
    report.isolation_workspace_root_count
  ) {
    refuse(
      "workspace_root_classes_disagree_with_count",
      ["isolation_workspace_root_classes"],
      null,
      `${report.isolation_workspace_root_classes.length} classes for ${report.isolation_workspace_root_count} members`
    );
  }
}

/**
 * The report as its own object, for producers and for the Python side.
 *
 * `SandboxStatusSchema` carries the same fields inline, without `contract_version`,
 * because it is one component's slice of `RuntimeStatus` rather than a versioned
 * document of its own.
 */
export const IsolationReportSchema = z
  .object({
    contract_version: IsolationReportContractVersionSchema,
    ...ISOLATION_REPORT_SHAPE,
  })
  .strict()
  .superRefine(refineIsolationReport);
export type IsolationReport = z.infer<typeof IsolationReportSchema>;

/**
 * What went wrong with one field, in terms neither validator's error vocabulary owns.
 *
 * Zod issue codes and Pydantic error types are two vocabularies for one set of facts, so
 * the policy below - which failures get a named reason, and which failures the cross-field
 * rules still run after - is expressed over these kinds and published as data. Each side
 * translates its own codes into them, and only that translation is per-language.
 */
export const ISOLATION_SHAPE_ISSUE_KINDS = [
  /**
   * The value is not of the field's type at all. An absent field is this kind, with one
   * spelling the two validators do not share: Pydantic reports every absent field as
   * `missing`, while Zod reports an absent closed-vocabulary field as `invalid_value` and so
   * as `not_a_member`. Both kinds abort the cross-field pass and neither carries a named
   * reason, so nothing observable diverges - but a named reason keyed on `wrong_type` for a
   * closed-vocabulary field would be reported on one surface and not the other, which is why
   * `ISOLATION_SHAPE_ISSUE_REASONS` names no such field and a test holds it to that.
   */
  "wrong_type",
  /** The right type, above the field's bound. */
  "above_bound",
  /** The right type, below the field's bound. */
  "below_bound",
  /** The right type, failing a check on its value: a pattern, or another field-level check. */
  "malformed",
  /** Not a member of a closed vocabulary. */
  "not_a_member",
  /** A field the shape does not have. */
  "unknown_field",
] as const;
export type IsolationShapeIssueKind = (typeof ISOLATION_SHAPE_ISSUE_KINDS)[number];

/**
 * After which shape failures the cross-field rules still run.
 *
 * Measured, not assumed. Zod 4's rule is that an issue raised by a *check* on a value of the
 * right type continues into `superRefine`, and an issue raised while parsing the value's type
 * aborts. Over this schema that means it continues after a bound or a pattern failure and
 * aborts after a wrong type, a value outside a closed vocabulary or an unknown key, which is
 * the distinction a rule-author cares about: a rule that reads a field of the wrong type has
 * nothing to compare, and one that reads a malformed string of the right type does.
 *
 * Stated as Zod's rule rather than as the list of codes this schema happens to raise, because
 * the codes are not the rule. `not_multiple_of` and a field-level `refine` were measured to
 * continue as well, so both translations below name them even though no field of this
 * contract uses either yet: the next field that does must not silently land on the wrong side.
 *
 * Published because the Python side has to match it. Running the cross-field rules where
 * Zod aborts would make the same report refuse for different reasons on the two surfaces,
 * and the reason set is the published contract. It is also the rule the next rule-author
 * needs: a rule that reads a field whose bound or pattern can fail needs an early return,
 * and a rule that reads a closed vocabulary does not.
 */
export const ISOLATION_CROSS_FIELD_RULES_CONTINUE_AFTER: readonly IsolationShapeIssueKind[] =
  ["above_bound", "below_bound", "malformed"];

/**
 * Which fields of the report are arrays of a discriminated union, and on which property.
 *
 * Published because the rule above is otherwise inoperative for such a field on the Python
 * side. Zod picks one member by the discriminator and reports only that member's issues.
 * `datamodel-code-generator` emits the same union untagged, so Pydantic tries every member
 * and reports a `literal_error` on the discriminator of each one that does not match,
 * alongside the real failure. Every failure inside the field therefore always includes a
 * `not_a_member`, the kind that aborts, whatever the real failure was - so a malformed
 * `root_id` would abort the cross-field pass here and continue it there. The Python validator
 * uses this table to drop the branches whose discriminator did not match before classifying
 * what is left, which is how it compares like with like.
 */
export const ISOLATION_DISCRIMINATED_UNION_FIELDS: Readonly<Record<string, string>> = {
  isolation_warnings: IsolationWarningSchema.def.discriminator,
};

/**
 * Which refusals a field's own schema raises, rather than the report's refinement.
 *
 * `IsolationEgressPolicyVersionSchema` refuses a label and a boundary state that came from
 * two different descriptors inside the field's own type, because that pair is the field's
 * invariant and not a relationship between fields: the schema is exported, a producer can
 * hold one against it, and a state that reads closed next to a permissive label is the
 * one-word edit this slice exists to catch. The enforced tiers against the state, and the
 * readback's instant against its verdict, are the same kind of invariant and live in the
 * same place. Keeping the rules there costs one asymmetry,
 * which is what this table publishes. Zod runs a field's checks while parsing the field, so
 * the refusal is raised whether or not some other field's failure aborted the report-level
 * refinement, and `ISOLATION_CROSS_FIELD_RULES_CONTINUE_AFTER` does not apply to it.
 *
 * Keyed on the field whose readability is the real gate: the refusal is reported exactly
 * when that field parsed, and skipped when it did not, on both surfaces. The Python
 * validator has one function per entry and runs it outside its cross-field pass; without
 * this table it would report these reasons only when nothing else was wrong, which is the
 * one place a report refused on both surfaces was refused for different reasons.
 */
export const ISOLATION_FIELD_LOCAL_REFUSAL_REASONS: Readonly<
  Record<string, readonly IsolationReportRefusalReason[]>
> = {
  isolation_egress_policy_version: [
    "egress_version_label_disagrees_with_boundary_state",
    "egress_enforced_tiers_disagree_with_boundary_state",
    "egress_readback_instant_disagrees_with_verdict",
  ],
};

/**
 * Reasons for the rules that live in a field's type rather than in the refinement.
 *
 * A bound or a pattern is refused by the field's own type, which reports its validator's
 * error code and not one of this contract's reasons. Without this map, a rule that is
 * expressed as a field type - and that the generated Pydantic model therefore also
 * enforces - would lose its name on the refusal surface.
 *
 * Keyed on the field *and* the kind, because a reason is a statement about the report. An
 * absent count and a count of nine are both refused, but only one of them is above the
 * bound, and a map keyed on the field name alone reports the first as the second. Anything
 * this map does not name is `report_shape_invalid`, which claims nothing beyond the refusal
 * itself.
 */
export const ISOLATION_SHAPE_ISSUE_REASONS: Readonly<
  Record<
    string,
    {
      readonly reason: IsolationReportRefusalReason;
      readonly kinds: readonly IsolationShapeIssueKind[];
    }
  >
> = {
  probe_set_id: {
    reason: "probe_set_id_shape_invalid",
    kinds: ["wrong_type", "malformed"],
  },
  version_label: {
    reason: "egress_version_label_shape_invalid",
    kinds: ["wrong_type", "malformed"],
  },
  isolation_workspace_root_count: {
    reason: "workspace_root_count_above_bound",
    kinds: ["above_bound"],
  },
};

/**
 * The Zod half of the translation. Every other code is a `wrong_type`.
 *
 * `not_multiple_of` and `custom` are the two continuing codes no field of this contract
 * raises today; they are here so that the field which first raises one is classified by the
 * measured rule rather than by this table's silence. A `custom` issue that carries a reason in
 * `params` is one of this contract's own refusals and never reaches this table.
 */
const ZOD_ISSUE_KINDS: Readonly<Record<string, IsolationShapeIssueKind>> = {
  invalid_type: "wrong_type",
  too_big: "above_bound",
  too_small: "below_bound",
  invalid_format: "malformed",
  not_multiple_of: "malformed",
  custom: "malformed",
  invalid_value: "not_a_member",
  unrecognized_keys: "unknown_field",
};

function shapeIssueReason(
  field: string,
  kind: IsolationShapeIssueKind
): IsolationReportRefusalReason {
  const named = ISOLATION_SHAPE_ISSUE_REASONS[field];
  if (named !== undefined && named.kinds.includes(kind)) {
    return named.reason;
  }
  return "report_shape_invalid";
}

/** Validate a report and return the refusal, or undefined. */
export function refuseIsolationReport(value: unknown): IsolationReportRefusal | undefined {
  const result = IsolationReportSchema.safeParse(value);
  if (result.success) {
    return undefined;
  }
  const items = new Map<string, IsolationReportRefusalItem>();
  const fatalIssues = result.error.issues.filter((issue) =>
    issue.code !== "custom" && !ISOLATION_CROSS_FIELD_RULES_CONTINUE_AFTER.includes(
      ZOD_ISSUE_KINDS[issue.code] ?? "wrong_type",
    ),
  );
  const shapeFatal = fatalIssues.length > 0;
  // Zod rejects oversized arrays before refinements. Preserve the duplicate-tier diagnostic
  // using only a bounded prefix; never resume validation of an unbounded attacker array.
  const tierLimit = EgressIsolationTierSchema.options.length;
  if (!shapeFatal && result.error.issues.some((issue) => issue.code === "too_big" && issue.path[0] === "isolation_tier_evidence") &&
      typeof value === "object" && value !== null && "isolation_tier_evidence" in value &&
      Array.isArray(value.isolation_tier_evidence)) {
    const prefix = z.array(IsolationTierEvidenceSchema).max(tierLimit + 1)
      .safeParse(value.isolation_tier_evidence.slice(0, tierLimit + 1));
    if (prefix.success && new Set(prefix.data.map((entry) => entry.tier)).size < prefix.data.length) {
      const item: IsolationReportRefusalItem = { reason: "tier_evidence_tier_repeated", policy_category: null };
      items.set(JSON.stringify(item), item);
    }
  }
  for (const issue of result.error.issues) {
    const params = (issue as { params?: { reason?: unknown; policy_category?: unknown } })
      .params;
    if (typeof params?.reason === "string") {
      const localReasons = ISOLATION_FIELD_LOCAL_REFUSAL_REASONS[String(issue.path[0])] ?? [];
      if (shapeFatal && (!localReasons.includes(params.reason as IsolationReportRefusalReason) ||
          fatalIssues.some((fatal) => fatal.path[0] === issue.path[0]))) continue;
      const category = IsolationPolicyCategorySchema.safeParse(params.policy_category);
      const item: IsolationReportRefusalItem = {
        reason: params.reason as IsolationReportRefusalReason,
        policy_category: category.success ? category.data : null,
      };
      items.set(JSON.stringify(item), item);
      continue;
    }
    const item: IsolationReportRefusalItem = {
      reason: shapeIssueReason(
        String(issue.path.at(-1)),
        ZOD_ISSUE_KINDS[issue.code] ?? "wrong_type"
      ),
      policy_category: null,
    };
    items.set(JSON.stringify(item), item);
  }
  if (items.size === 0) {
    const item: IsolationReportRefusalItem = {
      reason: "report_shape_invalid",
      policy_category: null,
    };
    items.set(JSON.stringify(item), item);
  }
  return IsolationReportRefusalSchema.parse({
    contract_version: ISOLATION_REPORT_CONTRACT_VERSION,
    refusals: [...items.values()],
  });
}

/**
 * The fail-closed report for each backend mode.
 *
 * Published as data, and read by the producer rather than restated by it, because a
 * default that each surface spells for itself is a default that one surface spells
 * wrong. It establishes no level, proves no hardening, holds no passing attestation and
 * describes an empty root set, which is the only honest report this repository can
 * currently produce: nothing applies the isolation policy yet, and apply is C5.
 *
 * `stale` rather than `fail` for a never-run attestation, because `fail` means a probe
 * ran and contradicted policy. Before launch the two are treated identically, so nothing
 * is weakened by the distinction, and section 6.3 defines `stale` as the value for a
 * result that is absent rather than contradicted.
 */
export const ISOLATION_FAIL_CLOSED_REPORTS: {
  readonly [M in IsolationBackendMode]: IsolationReport;
} = {
  native: {
    contract_version: ISOLATION_REPORT_CONTRACT_VERSION,
    backend_mode: "native",
    isolation_level: "not_established",
    isolation_policy_version: null,
    isolation_egress_policy_version: null,
    isolation_warnings: [
      { code: "isolation_level_not_established", reason: "native_isolation_not_applied" },
      { code: "token_hardening_unverified", token_shape: "unknown" },
      { code: "policy_attestation_not_passing", verdict: "stale" },
    ],
    isolation_token_shape: "unknown",
    isolation_attestation: {
      verdict: "stale",
      probe_set_id: null,
      last_pass_at: null,
      covered_policy_categories: [],
    },
    isolation_workspace_root_count: 0,
    isolation_workspace_root_classes: [],
    isolation_tier_evidence: [],
  },
};
