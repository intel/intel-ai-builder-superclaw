/**
 * Lexical contract for Windows-native managed roots.
 *
 * Uses node:crypto and must not be imported from browser code.
 * These rules compare path spellings only.
 * sandbox_manager/native_isolation/path_policy.py lists the ways two spellings can name one directory.
 */
import { createHash } from "node:crypto";
import { z } from "zod";

import {
  WORKSPACE_ROOT_ID_PATTERN,
  WORKSPACE_ROOT_SET_MAX_MEMBERS,
  WORKSPACE_ROOT_SET_MIN_MEMBERS,
  WorkspaceRootIdSchema,
  WorkspaceRootPolicyClassSchema,
  WorkspaceRootRefusalReasonSchema,
} from "./workspace-root-vocabulary.js";
import type { WorkspaceRootRefusalReason } from "./workspace-root-vocabulary.js";

export {
  WORKSPACE_ROOT_ID_PATTERN,
  WORKSPACE_ROOT_SET_MAX_MEMBERS,
  WORKSPACE_ROOT_SET_MIN_MEMBERS,
  WorkspaceRootIdSchema,
  WorkspaceRootPolicyClassSchema,
  WorkspaceRootRefusalReasonSchema,
};
export type { WorkspaceRootRefusalReason };

export const NativePathContractVersionSchema = z.literal(2);
export const NATIVE_PATH_CONTRACT_VERSION = 2 as const;

const OwnerSidSchema = z.string().regex(/^S-1-(?:\d+-)+\d+$/);
const SessionIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const PayloadVersionSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);

const LOCAL_PATH_PATTERN =
  /^(?:[A-Za-z]:\\|\\\\\?\\[A-Za-z]:\\)(?!(?:[Cc][Oo][Nn]|[Pp][Rr][Nn]|[Aa][Uu][Xx]|[Nn][Uu][Ll]|[Cc][Ll][Oo][Cc][Kk]\$|[Cc][Oo][Mm][1-9]|[Ll][Pp][Tt][1-9])(?:\.|\\|$))(?!\.{1,2}(?:\\|$))[^<>:"/\\|?*\u0000-\u001f]*[^<>:"/\\|?*\u0000-\u001f .](?:\\(?!(?:[Cc][Oo][Nn]|[Pp][Rr][Nn]|[Aa][Uu][Xx]|[Nn][Uu][Ll]|[Cc][Ll][Oo][Cc][Kk]\$|[Cc][Oo][Mm][1-9]|[Ll][Pp][Tt][1-9])(?:\.|\\|$))(?!\.{1,2}(?:\\|$))[^<>:"/\\|?*\u0000-\u001f]*[^<>:"/\\|?*\u0000-\u001f .])*$/;
const RESERVED_DOS_NAME = /^(?:con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\.|$)/i;
const VOLUME_ROOT_PATTERN = /^(?:\\\\\?\\)?[A-Za-z]:\\?$/;
const SHORT_NAME_ALIAS = /^[^.]{0,6}~[0-9]{1,6}(?:\.[^.]{1,3})?$/;

function canonicalComponents(value: string): readonly string[] {
  const withoutExtendedPrefix = value.startsWith("\\\\?\\") ? value.slice(4) : value;
  return withoutExtendedPrefix.split("\\");
}

interface LocalPathIssue {
  readonly reason: WorkspaceRootRefusalReason;
  readonly message: string;
}

function localPathIssue(value: string): LocalPathIssue | undefined {
  if (VOLUME_ROOT_PATTERN.test(value)) {
    return {
      reason: "path_is_volume_root",
      message: "a whole volume root is not a managed root",
    };
  }
  if (!LOCAL_PATH_PATTERN.test(value)) {
    return {
      reason: "path_not_canonical_local_windows",
      message:
        "must be an absolute local Windows drive path with canonical separators and components",
    };
  }
  for (const component of canonicalComponents(value).slice(1)) {
    if (component.endsWith(".") || component.endsWith(" ")) {
      return {
        reason: "path_not_canonical_local_windows",
        message: "components must not end in a dot or space",
      };
    }
    if (RESERVED_DOS_NAME.test(component)) {
      return {
        reason: "path_not_canonical_local_windows",
        message: "reserved DOS device names are not allowed",
      };
    }
    if (SHORT_NAME_ALIAS.test(component)) {
      return {
        reason: "path_uses_short_name_alias",
        message:
          "8.3 short-name components are not accepted; supply the long path spelling",
      };
    }
  }
  return undefined;
}

/**
 * Canonical spelling: uppercase drive letter, no \\?\\ prefix.
 *
 * A stored path must be canonical, not merely legal.
 */
const CANONICAL_LOCAL_PATH_PATTERN = new RegExp(
  `^(?=[A-Z]:\\\\)${LOCAL_PATH_PATTERN.source.slice(1)}`,
);

export function canonicalizeLocalWindowsPath(value: string): string {
  const issue = localPathIssue(value);
  if (issue !== undefined) {
    throw new Error(issue.message);
  }
  const ordinary = value.startsWith("\\\\?\\") ? value.slice(4) : value;
  return ordinary[0].toUpperCase() + ordinary.slice(1);
}

export const LocalWindowsAbsolutePathSchema = z
  .string()
  .regex(LOCAL_PATH_PATTERN)
  .superRefine((value, context) => {
    const issue = localPathIssue(value);
    if (issue !== undefined) {
      context.addIssue({
        code: "custom",
        params: { reason: issue.reason },
        message: issue.message,
      });
    }
  });
export type LocalWindowsAbsolutePath = z.infer<typeof LocalWindowsAbsolutePathSchema>;

/**
 * A stored member path: canonical, not merely legal.
 */
export const CanonicalLocalWindowsAbsolutePathSchema = z
  .string()
  .regex(CANONICAL_LOCAL_PATH_PATTERN)
  .superRefine((value, context) => {
    // The grammar and volume-root checks first, so `\\?\D:\` is still reported as the
    // volume root it is rather than as a spelling problem.
    const issue = localPathIssue(value) ?? canonicalSpellingIssue(value);
    if (issue !== undefined) {
      context.addIssue({
        code: "custom",
        params: { reason: issue.reason },
        message: issue.message,
      });
    }
  });

function canonicalSpellingIssue(value: string): LocalPathIssue | undefined {
  if (CANONICAL_LOCAL_PATH_PATTERN.test(value)) {
    return undefined;
  }
  return {
    reason: "path_not_canonical_local_windows",
    message:
      "a stored path must be in canonical form: an uppercase drive letter and no \\\\?\\ prefix",
  };
}

function comparisonParts(value: unknown): readonly string[] | undefined {
  if (typeof value !== "string" || localPathIssue(value) !== undefined) {
    return undefined;
  }
  return canonicalizeLocalWindowsPath(value)
    .split("\\")
    .map((part) => part.toLocaleLowerCase("en-US"));
}

function partsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((part, i) => part === right[i]);
}

function isAtOrUnder(root: readonly string[], candidate: readonly string[]): boolean {
  return (
    candidate.length >= root.length && root.every((part, i) => part === candidate[i])
  );
}

function partsOverlap(left: readonly string[], right: readonly string[]): boolean {
  return isAtOrUnder(left, right) || isAtOrUnder(right, left);
}

/**
 * Stable id for a workspace root, from its canonical spelling.
 *
 * This id is a label, not a capability. It grants nothing and proves nothing.
 */
export function deriveWorkspaceRootId(canonicalPath: string): string {
  const folded = canonicalizeLocalWindowsPath(canonicalPath).toLocaleLowerCase("en-US");
  return `wsr_${createHash("sha256").update(folded, "utf8").digest("hex")}`;
}

function safeRootId(candidate: unknown): string | null {
  return typeof candidate === "string" && WORKSPACE_ROOT_ID_PATTERN.test(candidate)
    ? candidate
    : null;
}

export const WorkspaceRootAccessModeSchema = z.enum(["read_write", "read_only"]);

/**
 * Volume facts are caller-supplied inputs, never measured here.
 */
export const WorkspaceVolumeVerdictSchema = z.enum([
  "fixed_ntfs",
  "non_ntfs",
  "removable",
  "redirected",
  "unknown",
]);

/**
 * Ancestry facts are caller-supplied inputs.
 *
 * no_reparse_point_observed is a point-in-time observation, not race-aware.
 */
export const WorkspaceAncestryVerdictSchema = z.enum([
  "no_reparse_point_observed",
  "reparse_point_observed",
  "unknown",
]);

export const WorkspaceRootAuthorizationSchema = z
  .object({
    kind: z.enum(["installer_provisioned", "user_grant"]),
    /** Null exactly when the root was installer-provisioned. */
    grant_id: z
      .string()
      .regex(/^wsg_[0-9a-f]{12}$/)
      .nullable(),
    /** RFC 3339 UTC instant; null exactly when the root was installer-provisioned. */
    granted_at: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/)
      .nullable(),
    revocable: z.boolean(),
  })
  .strict();

export const WorkspaceRootSchema = z
  .object({
    root_id: WorkspaceRootIdSchema,
    path: CanonicalLocalWindowsAbsolutePathSchema,
    policy_class: WorkspaceRootPolicyClassSchema,
    access_mode: WorkspaceRootAccessModeSchema,
    volume_verdict: WorkspaceVolumeVerdictSchema,
    ancestry_verdict: WorkspaceAncestryVerdictSchema,
    authorization: WorkspaceRootAuthorizationSchema,
  })
  .strict();
export type WorkspaceRoot = z.infer<typeof WorkspaceRootSchema>;

/**
 * Locations a workspace root may not occupy.
 */
export const DeniedWorkspaceAncestorsSchema = z
  .object({
    /** Every directory that contains user profiles. */
    users_container_roots: z.array(LocalWindowsAbsolutePathSchema).min(1),
    owner_profile_root: LocalWindowsAbsolutePathSchema,
    local_app_data_root: LocalWindowsAbsolutePathSchema,
    program_data_root: LocalWindowsAbsolutePathSchema,
    windows_root: LocalWindowsAbsolutePathSchema,
  })
  .strict();

/**
 * Machine-readable refusal. Codes and ids only, never a path.
 */
export const WorkspaceRootRefusalItemSchema = z
  .object({
    reason: WorkspaceRootRefusalReasonSchema,
    root_id: WorkspaceRootIdSchema.nullable(),
  })
  .strict();

export const WorkspaceRootRefusalSchema = z
  .object({
    contract_version: NativePathContractVersionSchema,
    refusals: z.array(WorkspaceRootRefusalItemSchema).min(1),
  })
  .strict();
export type WorkspaceRootRefusal = z.infer<typeof WorkspaceRootRefusalSchema>;
export type WorkspaceRootRefusalItem = z.infer<typeof WorkspaceRootRefusalItemSchema>;

const nativePathSetShape = {
  contract_version: NativePathContractVersionSchema,
  owner_sid: OwnerSidSchema,
  session_id: SessionIdSchema,
  payload_version: PayloadVersionSchema,
  workspace_roots: z
    .array(WorkspaceRootSchema)
    .meta({
      minItems: WORKSPACE_ROOT_SET_MIN_MEMBERS,
      maxItems: WORKSPACE_ROOT_SET_MAX_MEMBERS,
    }),
  config_root: LocalWindowsAbsolutePathSchema,
  data_root: LocalWindowsAbsolutePathSchema,
  logs_root: LocalWindowsAbsolutePathSchema,
  payload_root: LocalWindowsAbsolutePathSchema,
  temp_root: LocalWindowsAbsolutePathSchema,
  protected_root: LocalWindowsAbsolutePathSchema,
  isolation_root: LocalWindowsAbsolutePathSchema,
  denied_workspace_ancestors: DeniedWorkspaceAncestorsSchema,
} as const;

export const FIXED_MANAGED_ROOT_FIELDS = Object.keys(nativePathSetShape).filter(
  (field) => field.endsWith("_root")
) as readonly string[];

interface LabelledRoot {
  readonly kind: "fixed" | "member";
  readonly path: (string | number)[];
  readonly rootId: string | null;
  readonly parts: readonly string[];
}

function overlapReason(
  left: LabelledRoot,
  right: LabelledRoot
): WorkspaceRootRefusalReason {
  if (left.kind === "fixed" && right.kind === "fixed") return "managed_roots_overlap";
  if (left.kind === "member" && right.kind === "member") return "member_overlaps_member";
  return "member_overlaps_managed_root";
}

function expectedAccessMode(policyClass: unknown): string | undefined {
  if (policyClass === "user_granted_ro") return "read_only";
  if (policyClass === "managed_default" || policyClass === "user_granted_rw") {
    return "read_write";
  }
  return undefined;
}

function authorizationIsConsistent(
  policyClass: unknown,
  authorization: unknown
): boolean {
  if (typeof authorization !== "object" || authorization === null) return true;
  const record = authorization as Record<string, unknown>;
  if (policyClass === "managed_default") {
    return (
      record.kind === "installer_provisioned" &&
      record.grant_id === null &&
      record.granted_at === null &&
      record.revocable === false
    );
  }
  if (policyClass === "user_granted_rw" || policyClass === "user_granted_ro") {
    return (
      record.kind === "user_grant" &&
      typeof record.grant_id === "string" &&
      typeof record.granted_at === "string" &&
      record.revocable === true
    );
  }
  return true;
}

const VOLUME_VERDICT_REASONS: Record<string, WorkspaceRootRefusalReason> = {
  non_ntfs: "volume_verdict_non_ntfs",
  removable: "volume_verdict_removable",
  redirected: "volume_verdict_redirected",
  unknown: "volume_verdict_unknown",
};

const ANCESTRY_VERDICT_REASONS: Record<string, WorkspaceRootRefusalReason> = {
  reparse_point_observed: "ancestor_reparse_point_observed",
  unknown: "ancestry_verdict_unknown",
};

interface RefinementSink {
  addIssue(issue: {
    code: "custom";
    path: (string | number)[];
    params: { reason: WorkspaceRootRefusalReason; root_id: string | null };
    message: string;
  }): void;
}

function refineNativePathSet(value: unknown, context: RefinementSink): void {
  const raw = value as unknown as Record<string, unknown>;
  const refuse = (
    reason: WorkspaceRootRefusalReason,
    path: (string | number)[],
    rootId: string | null,
    message: string
  ): void => {
    context.addIssue({
      code: "custom",
      path,
      params: { reason, root_id: safeRootId(rootId) },
      message,
    });
  };

  const members = Array.isArray(raw.workspace_roots) ? raw.workspace_roots : [];
  const memberRecords = members.map((member) =>
    typeof member === "object" && member !== null
      ? (member as Record<string, unknown>)
      : {}
  );
  const memberRootId = (index: number): string | null => {
    const candidate = memberRecords[index].root_id;
    return typeof candidate === "string" ? candidate : null;
  };

  if (Array.isArray(raw.workspace_roots)) {
    if (members.length < WORKSPACE_ROOT_SET_MIN_MEMBERS) {
      refuse(
        "member_count_below_bound",
        ["workspace_roots"],
        null,
        `the workspace root set must hold at least ${WORKSPACE_ROOT_SET_MIN_MEMBERS} member(s)`
      );
    }
    if (members.length > WORKSPACE_ROOT_SET_MAX_MEMBERS) {
      refuse(
        "member_count_above_bound",
        ["workspace_roots"],
        null,
        `the workspace root set must hold at most ${WORKSPACE_ROOT_SET_MAX_MEMBERS} member(s)`
      );
    }
  }

  const managedDefaults = memberRecords.filter(
    (member) => member.policy_class === "managed_default"
  );
  if (Array.isArray(raw.workspace_roots)) {
    if (managedDefaults.length === 0) {
      refuse(
        "managed_default_missing",
        ["workspace_roots"],
        null,
        "the workspace root set must hold exactly one managed_default member"
      );
    } else if (managedDefaults.length > 1) {
      refuse(
        "managed_default_duplicated",
        ["workspace_roots"],
        null,
        "the workspace root set must hold exactly one managed_default member"
      );
    }
  }

  memberRecords.forEach((member, index) => {
    const rootId = memberRootId(index);
    const expected = expectedAccessMode(member.policy_class);
    if (expected !== undefined && member.access_mode !== expected) {
      refuse(
        "access_mode_inconsistent_with_policy_class",
        ["workspace_roots", index, "access_mode"],
        rootId,
        `policy class ${String(member.policy_class)} requires access mode ${expected}`
      );
    }
    if (!authorizationIsConsistent(member.policy_class, member.authorization)) {
      refuse(
        "authorization_inconsistent_with_policy_class",
        ["workspace_roots", index, "authorization"],
        rootId,
        `the authorization record does not match policy class ${String(member.policy_class)}`
      );
    }
    const volumeReason =
      typeof member.volume_verdict === "string"
        ? VOLUME_VERDICT_REASONS[member.volume_verdict]
        : undefined;
    if (volumeReason !== undefined) {
      refuse(
        volumeReason,
        ["workspace_roots", index, "volume_verdict"],
        rootId,
        `volume verdict ${String(member.volume_verdict)} is not an acceptable workspace volume`
      );
    }
    const ancestryReason =
      typeof member.ancestry_verdict === "string"
        ? ANCESTRY_VERDICT_REASONS[member.ancestry_verdict]
        : undefined;
    if (ancestryReason !== undefined) {
      refuse(
        ancestryReason,
        ["workspace_roots", index, "ancestry_verdict"],
        rootId,
        `ancestry verdict ${String(member.ancestry_verdict)} is not an acceptable workspace ancestry`
      );
    }
    const memberParts = comparisonParts(member.path);
    if (memberParts !== undefined && rootId !== null) {
      let derived: string | undefined;
      try {
        derived = deriveWorkspaceRootId(member.path as string);
      } catch {
        derived = undefined;
      }
      if (derived !== undefined && derived !== rootId) {
        refuse(
          "root_id_not_derived_from_path",
          ["workspace_roots", index, "root_id"],
          rootId,
          "root_id must be derived from the canonical path"
        );
      }
    }
  });

  // Duplicate identity and duplicate path, reported once per repeat.
  const seenRootIds = new Set<string>();
  const seenPaths = new Set<string>();
  memberRecords.forEach((member, index) => {
    const rootId = memberRootId(index);
    if (rootId !== null) {
      if (seenRootIds.has(rootId)) {
        refuse(
          "duplicate_root_id",
          ["workspace_roots", index, "root_id"],
          rootId,
          "root_id must be unique within the workspace root set"
        );
      }
      seenRootIds.add(rootId);
    }
    const parts = comparisonParts(member.path);
    if (parts !== undefined) {
      const key = parts.join("\\");
      if (seenPaths.has(key)) {
        refuse(
          "duplicate_canonical_path",
          ["workspace_roots", index, "path"],
          rootId,
          "canonical path must be unique within the workspace root set"
        );
      }
      seenPaths.add(key);
    }
  });

  const denied =
    typeof raw.denied_workspace_ancestors === "object" &&
    raw.denied_workspace_ancestors !== null
      ? (raw.denied_workspace_ancestors as Record<string, unknown>)
      : {};
  const usersContainers = (
    Array.isArray(denied.users_container_roots) ? denied.users_container_roots : []
  )
    .map((value) => comparisonParts(value))
    .filter((parts): parts is readonly string[] => parts !== undefined);
  const ownerProfile = comparisonParts(denied.owner_profile_root);
  const deniedSubtrees: readonly [string, WorkspaceRootRefusalReason][] = [
    ["local_app_data_root", "member_under_local_app_data_root"],
    ["program_data_root", "member_under_program_data_root"],
    ["windows_root", "member_under_windows_root"],
  ];
  memberRecords.forEach((member, index) => {
    const parts = comparisonParts(member.path);
    if (parts === undefined) return;
    const rootId = memberRootId(index);
    const at = ["workspace_roots", index, "path"];
    if (ownerProfile !== undefined && partsEqual(ownerProfile, parts)) {
      refuse(
        "member_is_owner_profile_root",
        at,
        rootId,
        "the owning user's profile directory is not a valid workspace root"
      );
    }
    if (
      usersContainers.some((container) => partsOverlap(container, parts)) &&
      (ownerProfile === undefined || !isAtOrUnder(ownerProfile, parts))
    ) {
      refuse(
        "member_under_other_user_profile",
        at,
        rootId,
        "a workspace root must not contain or live in another user's profile"
      );
    }
    for (const [field, reason] of deniedSubtrees) {
      const deniedParts = comparisonParts(denied[field]);
      if (deniedParts !== undefined && partsOverlap(deniedParts, parts)) {
        refuse(
          reason,
          at,
          rootId,
          `a workspace root must not contain or live under ${field}`
        );
      }
    }
  });

  const labelled: LabelledRoot[] = [];
  for (const field of FIXED_MANAGED_ROOT_FIELDS) {
    const parts = comparisonParts(raw[field]);
    if (parts !== undefined) {
      labelled.push({ kind: "fixed", path: [field], rootId: null, parts });
    }
  }
  memberRecords.forEach((member, index) => {
    const parts = comparisonParts(member.path);
    if (parts !== undefined) {
      labelled.push({
        kind: "member",
        path: ["workspace_roots", index, "path"],
        rootId: memberRootId(index),
        parts,
      });
    }
  });
  for (let left = 0; left < labelled.length; left += 1) {
    for (let right = left + 1; right < labelled.length; right += 1) {
      if (!partsOverlap(labelled[left].parts, labelled[right].parts)) continue;
      const reason = overlapReason(labelled[left], labelled[right]);
      refuse(
        reason,
        labelled[right].path,
        labelled[right].rootId ?? labelled[left].rootId,
        `${labelled[right].path.join(".")} must not overlap ${labelled[left].path.join(".")}`
      );
    }
  }
}

export const NativePathSetSchema = z
  .object(nativePathSetShape)
  .strict()
  .superRefine(refineNativePathSet);
export type NativePathSet = z.infer<typeof NativePathSetSchema>;

/**
 * Validate a descriptor and return the refusal, or undefined.
 *
 * A shape-fatal failure reports only descriptor_shape_invalid with no cross-field reasons.
 */
export function refuseNativePathSet(value: unknown): WorkspaceRootRefusal | undefined {
  const result = NativePathSetSchema.safeParse(value);
  if (result.success) {
    return undefined;
  }

  const members =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>).workspace_roots
      : undefined;
  const memberRootId = (index: number): string | null => {
    if (!Array.isArray(members)) return null;
    const member = members[index];
    return typeof member === "object" && member !== null
      ? safeRootId((member as Record<string, unknown>).root_id)
      : null;
  };

  const items = new Map<string, WorkspaceRootRefusalItem>();
  // Zod 4.6 continues refinements after unknown keys; the wire contract treats them as shape-fatal.
  if (result.error.issues.some((issue) => issue.code === "unrecognized_keys")) {
    return WorkspaceRootRefusalSchema.parse({
      contract_version: NATIVE_PATH_CONTRACT_VERSION,
      refusals: [{ reason: "descriptor_shape_invalid", root_id: null }],
    });
  }
  for (const issue of result.error.issues) {
    const params = (issue as { params?: { reason?: unknown; root_id?: unknown } }).params;
    if (typeof params?.reason !== "string") {
      continue;
    }
    const reason = params.reason as WorkspaceRootRefusalReason;
    const carried = safeRootId(params.root_id);
    const [head, index] = issue.path;
    const rootId =
      carried ?? (head === "workspace_roots" && typeof index === "number"
        ? memberRootId(index)
        : null);
    items.set(`${reason}\u0000${rootId ?? ""}`, { reason, root_id: rootId });
  }
  if (items.size === 0) {
    items.set("descriptor_shape_invalid\u0000", {
      reason: "descriptor_shape_invalid",
      root_id: null,
    });
  }

  return WorkspaceRootRefusalSchema.parse({
    contract_version: NATIVE_PATH_CONTRACT_VERSION,
    refusals: [...items.values()],
  });
}
