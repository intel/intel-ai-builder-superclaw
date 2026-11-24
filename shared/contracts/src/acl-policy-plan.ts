/**
 * The ACL policy plan, the readback of what is actually there, and the drift
 * verdict that compares them.
 *
 * A plan is the descriptor resolved against one live workspace root set: one entry
 * per root, each carrying the security descriptor that root is required to have.
 * Adding a second workspace root adds an entry here. It does not change the
 * descriptor, which is why the descriptor is keyed by policy class.
 *
 * Nothing in this file applies anything. A plan says what should be true, an
 * observation says what a reader found, and a drift report says whether the two
 * agree. Turning a plan into a Win32 call is the applier's job, in a later slice.
 *
 * These shapes carry no cross-field refinement on purpose. A plan and a report are
 * produced by the L1 planner and checker and consumed across the language boundary,
 * so their invariants live with the producer, where they can be tested once, rather
 * than in a Zod refinement that the generated Pydantic model would not carry.
 */
import { z } from "zod";

import {
  AclIsolationTierSchema,
  AclManagedRootScopeSchema,
  AclPlaceholderKindSchema,
  AclPlaceholderRoleSchema,
  AclPolicyDriftReasonSchema,
  AclPolicyDriftVerdictSchema,
} from "./acl-policy-vocabulary.js";
import {
  AclAceSchema,
  AclOwnerSidSchema,
  AclPlaceholderPathSchema,
  AclPolicyContractVersionSchema,
  AclPolicyLocatorSchema,
  AclPolicyVersionSchema,
} from "./acl-policy-descriptor.js";
import { WORKSPACE_ROOT_SET_MAX_MEMBERS } from "./native-path-contract.js";
import { WorkspaceRootIdSchema, WorkspaceRootPolicyClassSchema } from "./workspace-root-vocabulary.js";

/**
 * One security descriptor a plan requires of one object.
 *
 * `policy_version` travels with it so an applier can stamp provenance and a checker
 * can tell a root secured by an older policy from a root nobody has touched.
 */
export const AclRequiredSecurityDescriptorSchema = z
  .object({
    owner_sid: AclOwnerSidSchema,
    policy_version: AclPolicyVersionSchema,
    dacl_protected: z.boolean(),
    aces: z.array(AclAceSchema).min(1),
  })
  .strict();
export type AclRequiredSecurityDescriptor = z.infer<
  typeof AclRequiredSecurityDescriptorSchema
>;

export const AclPlannedPlaceholderSchema = z
  .object({
    relative_path: AclPlaceholderPathSchema,
    placeholder_kind: AclPlaceholderKindSchema,
    placeholder_role: AclPlaceholderRoleSchema,
    required: AclRequiredSecurityDescriptorSchema,
  })
  .strict();
export type AclPlannedPlaceholder = z.infer<typeof AclPlannedPlaceholderSchema>;

/**
 * One workspace root's plan.
 *
 * `root_id` identifies the member; the literal path is deliberately absent. The
 * applier already holds the validated root set and opens the root by handle, so
 * repeating the path here would only create a second place for it to be wrong.
 */
export const AclWorkspaceRootPlanSchema = z
  .object({
    root_id: WorkspaceRootIdSchema,
    policy_class: WorkspaceRootPolicyClassSchema,
    required: AclRequiredSecurityDescriptorSchema,
    /** Empty for every class but `managed_default`. */
    placeholders: z.array(AclPlannedPlaceholderSchema),
  })
  .strict();
export type AclWorkspaceRootPlan = z.infer<typeof AclWorkspaceRootPlanSchema>;

export const AclPlannedTierSubtreeSchema = z
  .object({
    tier: AclIsolationTierSchema,
    required: AclRequiredSecurityDescriptorSchema,
  })
  .strict();
export type AclPlannedTierSubtree = z.infer<typeof AclPlannedTierSubtreeSchema>;

/** A directory below one tier's subtree that another tier is let into, and what it is required to carry. */
export const AclPlannedTierOpeningSchema = z
  .object({
    tier: AclIsolationTierSchema,
    relative_path: AclPlaceholderPathSchema,
    required: AclRequiredSecurityDescriptorSchema,
  })
  .strict();
export type AclPlannedTierOpening = z.infer<typeof AclPlannedTierOpeningSchema>;

export const AclManagedRootPlanSchema = z
  .object({
    managed_root_scope: AclManagedRootScopeSchema,
    required: AclRequiredSecurityDescriptorSchema,
    tier_subtrees: z.array(AclPlannedTierSubtreeSchema),
    tier_openings: z.array(AclPlannedTierOpeningSchema),
  })
  .strict();
export type AclManagedRootPlan = z.infer<typeof AclManagedRootPlanSchema>;

/**
 * The whole required-state plan for one host.
 *
 * Bounded by the workspace root set's own member limits, read from the path contract
 * rather than restated: at least one root, at most
 * `WORKSPACE_ROOT_SET_MAX_MEMBERS`, exactly one of them `managed_default`. A second
 * spelling of the bound would let a root set the path contract accepts produce a plan
 * this schema rejects.
 */
export const AclPolicyPlanSchema = z
  .object({
    contract_version: AclPolicyContractVersionSchema,
    policy_version: AclPolicyVersionSchema,
    workspace_root_plans: z
      .array(AclWorkspaceRootPlanSchema)
      .min(1)
      .max(WORKSPACE_ROOT_SET_MAX_MEMBERS),
    managed_root_plans: z.array(AclManagedRootPlanSchema),
  })
  .strict();
export type AclPolicyPlan = z.infer<typeof AclPolicyPlanSchema>;

/**
 * What a reader found on one object.
 *
 * `policy_version` is nullable because an object nobody has applied a policy to
 * carries no stamp, and that is a normal thing to observe, not a malformed one.
 */
export const AclObservedSecurityDescriptorSchema = z
  .object({
    owner_sid: AclOwnerSidSchema.nullable(),
    policy_version: AclPolicyVersionSchema.nullable(),
    dacl_protected: z.boolean(),
    aces: z.array(AclAceSchema),
  })
  .strict();
export type AclObservedSecurityDescriptor = z.infer<
  typeof AclObservedSecurityDescriptorSchema
>;

/**
 * What a reader found where a placeholder was planned.
 *
 * `is_reparse_point` is recorded rather than inferred: a placeholder that became a
 * junction or a symlink is the way a mask gets turned back into a window onto the
 * real content, and it is the reason a placeholder is required to be a plain empty
 * directory. `is_empty` is false for a `guard_ancestor`, which holds a mask below
 * it, so emptiness is judged against the placeholder's role by the checker.
 */
export const AclPlaceholderObservationSchema = z
  .object({
    relative_path: AclPlaceholderPathSchema,
    present: z.boolean(),
    is_reparse_point: z.boolean(),
    is_empty: z.boolean(),
    security: AclObservedSecurityDescriptorSchema.nullable(),
  })
  .strict();
export type AclPlaceholderObservation = z.infer<
  typeof AclPlaceholderObservationSchema
>;

/**
 * What a reader found where a root was planned.
 *
 * `is_reparse_point` is required on a root for the same reason it is required on a
 * placeholder, and it is the more serious of the two: a root that became a junction
 * points the whole plan at a directory nobody validated, and every ACE below it would
 * then be applied there.
 */
export const AclWorkspaceRootObservationSchema = z
  .object({
    root_id: WorkspaceRootIdSchema,
    present: z.boolean(),
    is_reparse_point: z.boolean(),
    security: AclObservedSecurityDescriptorSchema.nullable(),
    placeholders: z.array(AclPlaceholderObservationSchema),
  })
  .strict();
export type AclWorkspaceRootObservation = z.infer<
  typeof AclWorkspaceRootObservationSchema
>;

export const AclDescendantConvergenceSkipSchema = z
  .object({
    path: z.string().min(1),
    reason: z.string().min(1),
  })
  .strict();

export const AclDescendantConvergenceObservationSchema = z
  .object({
    visited: z.number().int().nonnegative(),
    repaired: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    duration_ms: z.number().int().nonnegative(),
    skipped_entries: z.array(AclDescendantConvergenceSkipSchema),
    skipped_entries_truncated: z.boolean(),
    retryable_skips: z.number().int().nonnegative().optional(),
    coverage_bound_exceeded: z.boolean().optional(),
  })
  .strict();

/** What a reader found on one tier's own subtree under a managed root. */
export const AclTierSubtreeObservationSchema = z
  .object({
    tier: AclIsolationTierSchema,
    present: z.boolean(),
    security: AclObservedSecurityDescriptorSchema.nullable(),
    convergence: AclDescendantConvergenceObservationSchema.optional(),
  })
  .strict();
export type AclTierSubtreeObservation = z.infer<
  typeof AclTierSubtreeObservationSchema
>;

/** What a reader found on one opening below a tier's subtree. */
export const AclTierOpeningObservationSchema = z
  .object({
    tier: AclIsolationTierSchema,
    relative_path: AclPlaceholderPathSchema,
    present: z.boolean(),
    security: AclObservedSecurityDescriptorSchema.nullable(),
  })
  .strict();
export type AclTierOpeningObservation = z.infer<typeof AclTierOpeningObservationSchema>;

/**
 * What a reader found where a managed root was planned.
 *
 * `tier_subtree_observations` is not optional. A managed root's per-tier subtrees are
 * where the per-tier separation actually lives: the root above them only grants
 * traverse. An observation shape with no room for them would let a checker report
 * `no_drift_observed` for a host where every tier subtree had been opened up, having
 * compared the one DACL that carries the least.
 */
export const AclManagedRootObservationSchema = z
  .object({
    managed_root_scope: AclManagedRootScopeSchema,
    present: z.boolean(),
    is_reparse_point: z.boolean(),
    security: AclObservedSecurityDescriptorSchema.nullable(),
    tier_subtree_observations: z.array(AclTierSubtreeObservationSchema),
    tier_opening_observations: z.array(AclTierOpeningObservationSchema),
  })
  .strict();
export type AclManagedRootObservation = z.infer<
  typeof AclManagedRootObservationSchema
>;

/**
 * A readback of the host, as complete as the reader managed to be.
 *
 * A missing entry is not an omission the checker forgives. Anything the plan names
 * and this does not cover is reported as `observation_absent`.
 */
export const AclPolicyObservationSchema = z
  .object({
    contract_version: AclPolicyContractVersionSchema,
    descendant_convergence_required: z.boolean().optional(),
    workspace_root_observations: z.array(AclWorkspaceRootObservationSchema),
    managed_root_observations: z.array(AclManagedRootObservationSchema),
  })
  .strict();
export type AclPolicyObservation = z.infer<typeof AclPolicyObservationSchema>;

/**
 * One way the observed state differs from the plan.
 *
 * `detail` is for a human reading a report. The pair of `reason` and `locator` is
 * what a gate decides on, so nothing is expressed in `detail` alone.
 */
export const AclPolicyDriftFindingSchema = z
  .object({
    reason: AclPolicyDriftReasonSchema,
    locator: AclPolicyLocatorSchema,
    detail: z.string(),
  })
  .strict();
export type AclPolicyDriftFinding = z.infer<typeof AclPolicyDriftFindingSchema>;

/**
 * The verdict, with everything it rests on.
 *
 * `verdict` is `no_drift_observed` exactly when `findings` is empty. The name says
 * "observed" because a clean report means the plan matched what was read, never
 * that the boundary held.
 */
export const AclPolicyDriftReportSchema = z
  .object({
    contract_version: AclPolicyContractVersionSchema,
    policy_version: AclPolicyVersionSchema,
    verdict: AclPolicyDriftVerdictSchema,
    findings: z.array(AclPolicyDriftFindingSchema),
  })
  .strict();
export type AclPolicyDriftReport = z.infer<typeof AclPolicyDriftReportSchema>;
