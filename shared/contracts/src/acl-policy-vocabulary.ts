/**
 * ACL policy vocabulary: principals, rights, inheritance shapes, refusal and
 * drift reasons.
 *
 * Importable from browser code. Holds no node: import.
 * Every value here is symbolic. A principal is a role, never a literal SID, and a
 * right is a name, never a bit mask, because this layer plans policy and the
 * broker is the only thing that resolves either against Windows.
 */
import { z } from "zod";

import { AgentRuntimeIsolationTierSchema } from "./agent-runtime-vocabulary.js";
import type { AgentRuntimeIsolationTier } from "./agent-runtime-vocabulary.js";

/**
 * Isolation tiers, from the isolation baseline table.
 *
 * The agent runtime descriptor already spells this enum and it is the same tiers, so it
 * is re-exported rather than restated.
 */
export const AclIsolationTierSchema = AgentRuntimeIsolationTierSchema;
export type AclIsolationTier = AgentRuntimeIsolationTier;

/**
 * Who an ACE names.
 *
 * `host_user`, `local_system` and `administrators` are the recovery principals
 * that keep a root reachable after any sandbox change. The `sandbox_tier_*`
 * principals are the per-owner, per-tier accounts the broker provisions; one
 * principal per tier is what keeps config and data ACLs per-tier instead of one
 * island-wide allow ACE.
 */
export const AclPrincipalSchema = z.enum([
  "host_user",
  "local_system",
  "administrators",
  "sandbox_tier_bootstrap",
  "sandbox_tier_file_tool",
  "sandbox_tier_network_connector",
  "sandbox_tier_channel",
]);
export type AclPrincipal = z.infer<typeof AclPrincipalSchema>;

/**
 * The principals that must keep reaching a root whatever the sandbox policy says.
 */
export const ACL_RECOVERY_PRINCIPALS: readonly AclPrincipal[] = [
  "host_user",
  "local_system",
  "administrators",
];

/**
 * Which tier a sandbox principal stands for, or null for a recovery principal.
 */
export const ACL_PRINCIPAL_TIER: Record<AclPrincipal, AclIsolationTier | null> = {
  host_user: null,
  local_system: null,
  administrators: null,
  sandbox_tier_bootstrap: "bootstrap",
  sandbox_tier_file_tool: "file_tool",
  sandbox_tier_network_connector: "network_connector",
  sandbox_tier_channel: "channel",
};

/**
 * The NTFS rights a descriptor may name.
 *
 * On a directory `FILE_READ_DATA` is list-directory, `FILE_WRITE_DATA` is
 * add-file, `FILE_APPEND_DATA` is add-subdirectory and `FILE_EXECUTE` is
 * traverse. Each bit has exactly one spelling here so a descriptor cannot name
 * the same bit twice under two names and look like it granted more than it did.
 */
export const AclRightSchema = z.enum([
  "FILE_READ_DATA",
  "FILE_WRITE_DATA",
  "FILE_APPEND_DATA",
  "FILE_READ_EA",
  "FILE_WRITE_EA",
  "FILE_EXECUTE",
  "FILE_DELETE_CHILD",
  "FILE_READ_ATTRIBUTES",
  "FILE_WRITE_ATTRIBUTES",
  "DELETE",
  "READ_CONTROL",
  "WRITE_DAC",
  "WRITE_OWNER",
  "SYNCHRONIZE",
]);
export type AclRight = z.infer<typeof AclRightSchema>;

/**
 * The rights that confer a change to content, name, or the security descriptor.
 *
 * A read-only policy class may grant none of these to a sandbox principal.
 */
export const ACL_WRITE_CONFERRING_RIGHTS: readonly AclRight[] = [
  "FILE_WRITE_DATA",
  "FILE_APPEND_DATA",
  "FILE_WRITE_EA",
  "FILE_WRITE_ATTRIBUTES",
  "FILE_DELETE_CHILD",
  "DELETE",
  "WRITE_DAC",
  "WRITE_OWNER",
];

/**
 * How far an ACE propagates.
 *
 * `children_only` is CONTAINER_INHERIT | OBJECT_INHERIT | INHERIT_ONLY, and it is
 * how a root grants a right to everything below it while withholding that right
 * on the root object itself.
 */
export const AclInheritanceSchema = z.enum([
  "this_object_only",
  "this_object_and_children",
  "children_only",
]);
export type AclInheritance = z.infer<typeof AclInheritanceSchema>;

export const AclAceKindSchema = z.enum(["allow", "deny"]);
export type AclAceKind = z.infer<typeof AclAceKindSchema>;

/**
 * The host-owned roots and the three fixed backend layout ancestors.
 *
 * A test pins this list against the path contract's own fixed-root fields, so a
 * new managed root cannot appear there without an ACL policy for it here.
 */
export const AclManagedRootScopeSchema = z.enum([
  "backend_root",
  "payload_container_root",
  "temp_container_root",
  "config_root",
  "data_root",
  "logs_root",
  "payload_root",
  "temp_root",
  "protected_root",
  "isolation_root",
]);
export type AclManagedRootScope = z.infer<typeof AclManagedRootScopeSchema>;

/**
 * What a protected placeholder is.
 *
 * Both of today's placeholders are directories, because the container masks they
 * replace are tmpfs mounts over directories.
 */
export const AclPlaceholderKindSchema = z.enum(["empty_file", "empty_directory"]);
export type AclPlaceholderKind = z.infer<typeof AclPlaceholderKindSchema>;

/**
 * Why a placeholder exists.
 *
 * A `protected_mask` is the compatibility stand-in for real protected content: it
 * stays empty, and the sandbox is denied everything on it. A `guard_ancestor` is a
 * directory that exists only to carry a mask below it; it holds the mask, so it is
 * not empty, and the sandbox may work inside it but may not delete, rename or
 * re-secure it. Without that second role a mask nested one level down could be
 * defeated by renaming its parent, which the sandbox can otherwise do because
 * children inherit `DELETE`.
 */
export const AclPlaceholderRoleSchema = z.enum(["protected_mask", "guard_ancestor"]);
export type AclPlaceholderRole = z.infer<typeof AclPlaceholderRoleSchema>;

/**
 * Refusal reasons for an ACL policy descriptor and for a planner input.
 *
 * Two halves, split by `ACL_PLANNER_REFUSAL_REASONS` below: the descriptor half is
 * checked against the descriptor this repo ships, so it fires at generation time
 * rather than on a customer machine, and the planner half is the invariants the
 * runtime planner itself depends on.
 */
export const AclPolicyRefusalReasonSchema = z.enum([
  "descriptor_shape_invalid",
  "policy_class_not_covered",
  "policy_class_duplicated",
  "managed_root_scope_not_covered",
  "managed_root_scope_duplicated",
  "ace_rights_empty",
  "ace_rights_not_unique",
  "duplicate_ace",
  "deny_ace_not_ordered_before_allow",
  "dacl_not_protected",
  "recovery_principal_absent",
  "recovery_principal_denied",
  "workspace_root_allow_ace_grants_delete_child",
  "sandbox_principal_granted_delete_child",
  "sandbox_principal_granted_dacl_control",
  "read_only_class_grants_sandbox_write",
  "payload_root_grants_sandbox_write",
  "protected_root_grants_sandbox_access",
  "revocation_record_inconsistent_with_policy_class",
  "placeholder_declared_outside_managed_default",
  "placeholder_absent_for_managed_default",
  "placeholder_path_not_root_relative",
  "placeholder_path_reserved_device_name",
  "placeholder_kind_not_directory",
  "duplicate_placeholder_path",
  "placeholder_ancestor_not_declared",
  "placeholder_dacl_missing_deny_ace",
  "protected_mask_grants_sandbox_access",
  "duplicate_tier_subtree_dacl",
  "duplicate_tier_opening",
  "tier_opening_without_subtree",
  "profile_ancestor_path_not_profile_relative",
  "profile_ancestor_chain_invalid",
  "profile_ancestor_grant_widened",
  "descriptor_not_the_shipped_policy",
  "root_set_shape_invalid",
  "root_set_member_count_above_bound",
  "root_set_managed_default_not_unique",
  "root_set_root_id_duplicated",
  "root_set_policy_class_unknown",
  "owner_sid_shape_invalid",
]);
export type AclPolicyRefusalReason = z.infer<typeof AclPolicyRefusalReasonSchema>;

/**
 * The reasons the runtime planner raises, as opposed to the ones the shipped
 * descriptor is checked against when this package is built.
 *
 * Named rather than left to a `root_set_` prefix convention, because the two halves
 * are proved by two different suites and a reader has to be able to tell which
 * suite owes a reason its coverage. This package's golden table proves the
 * descriptor half; the Python planner's table proves this half, and reads this list
 * through `ACL_POLICY_RULES` so neither side restates it.
 */
export const ACL_PLANNER_REFUSAL_REASONS: readonly AclPolicyRefusalReason[] = [
  "descriptor_shape_invalid",
  "descriptor_not_the_shipped_policy",
  "root_set_shape_invalid",
  "root_set_member_count_above_bound",
  "root_set_managed_default_not_unique",
  "root_set_root_id_duplicated",
  "root_set_policy_class_unknown",
  "owner_sid_shape_invalid",
];

/**
 * Why an observed state does not match the plan.
 *
 * `observation_absent` is the fail-closed reason: a planned root or placeholder
 * with no readback is drift, never an unknown, because "we did not look" and "it
 * is correct" must not report the same way. `root_absent` is the different thing
 * of having looked and found nothing there. `observation_duplicated` is the third
 * shape of the same failure: a readback that names one object twice, where taking
 * either entry would mean deciding which half of the evidence to throw away.
 */
export const AclPolicyDriftReasonSchema = z.enum([
  "policy_version_mismatch",
  "owner_sid_mismatch",
  "observation_absent",
  "observation_duplicated",
  "dacl_not_protected",
  "dacl_not_canonically_ordered",
  "required_ace_absent",
  "unexpected_ace_present",
  "delete_child_granted_on_workspace_root",
  "recovery_principal_absent",
  "root_not_in_plan",
  "root_absent",
  "root_is_reparse_point",
  "tier_subtree_not_in_plan",
  "tier_opening_not_in_plan",
  "placeholder_absent",
  "placeholder_is_reparse_point",
  "placeholder_not_empty",
  "placeholder_deny_ace_absent",
  "placeholder_not_in_plan",
]);
export type AclPolicyDriftReason = z.infer<typeof AclPolicyDriftReasonSchema>;

/**
 * Whether a drift check found anything.
 *
 * There is no third value. An incomplete observation is `drift_detected` with an
 * `observation_absent` finding.
 */
export const AclPolicyDriftVerdictSchema = z.enum([
  "no_drift_observed",
  "drift_detected",
]);
export type AclPolicyDriftVerdict = z.infer<typeof AclPolicyDriftVerdictSchema>;
