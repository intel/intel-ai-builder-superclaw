/**
 * Workspace root vocabulary: refusal codes, id shape, and policy classes.
 *
 * Importable from browser code. Holds no node: import.
 */
import { z } from "zod";

/**
 * Refusal reasons.
 */
export const WorkspaceRootRefusalReasonSchema = z.enum([
  "path_not_canonical_local_windows",
  "path_is_volume_root",
  "path_uses_short_name_alias",
  "root_id_not_derived_from_path",
  "duplicate_root_id",
  "duplicate_canonical_path",
  "member_count_below_bound",
  "member_count_above_bound",
  "managed_default_missing",
  "managed_default_duplicated",
  "access_mode_inconsistent_with_policy_class",
  "authorization_inconsistent_with_policy_class",
  "managed_roots_overlap",
  "member_overlaps_managed_root",
  "member_overlaps_member",
  "member_is_owner_profile_root",
  "member_under_other_user_profile",
  "member_under_local_app_data_root",
  "member_under_program_data_root",
  "member_under_windows_root",
  "volume_verdict_non_ntfs",
  "volume_verdict_removable",
  "volume_verdict_redirected",
  "volume_verdict_unknown",
  "ancestor_reparse_point_observed",
  "ancestry_verdict_unknown",
  "descriptor_shape_invalid",
]);
export type WorkspaceRootRefusalReason = z.infer<
  typeof WorkspaceRootRefusalReasonSchema
>;

export const WORKSPACE_ROOT_ID_PATTERN = /^wsr_[0-9a-f]{64}$/;
export const WorkspaceRootIdSchema = z.string().regex(WORKSPACE_ROOT_ID_PATTERN);

export const WorkspaceRootPolicyClassSchema = z.enum([
  "managed_default",
  "user_granted_rw",
  "user_granted_ro",
]);

/**
 * How many members a workspace root set may hold.
 *
 * Here rather than in `native-path-contract.ts` because the bound is vocabulary: the
 * isolation report bounds its root set evidence by the same number, and taking it from the
 * path contract would drag `node:crypto` into a browser bundle for the sake of an integer.
 * `native-path-contract.ts` re-exports both, so every existing importer is unaffected.
 */
export const WORKSPACE_ROOT_SET_MIN_MEMBERS = 1 as const;
export const WORKSPACE_ROOT_SET_MAX_MEMBERS = 8 as const;
