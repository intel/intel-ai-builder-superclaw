/**
 * The ACL policy descriptor: what the file-system boundary is supposed to be.
 *
 * One versioned source for the DACL of every managed root and of every workspace
 * root policy class, plus the protected placeholder plan that replaces the
 * container's tmpfs masks. Read by the L1 planner and, later, by the broker that
 * applies it.
 *
 * Declares intent only, enforces nothing. Nothing here touches Win32, resolves a
 * SID, or reads a security descriptor. A descriptor is keyed by policy class and
 * managed root scope, never by a literal path, so a second workspace root is a new
 * member of a plan rather than a new descriptor to review.
 */
import { z } from "zod";

import {
  ACL_PLANNER_REFUSAL_REASONS,
  ACL_PRINCIPAL_TIER,
  ACL_RECOVERY_PRINCIPALS,
  ACL_WRITE_CONFERRING_RIGHTS,
  AclAceKindSchema,
  AclInheritanceSchema,
  AclIsolationTierSchema,
  AclManagedRootScopeSchema,
  AclPlaceholderKindSchema,
  AclPlaceholderRoleSchema,
  AclPolicyDriftReasonSchema,
  AclPolicyDriftVerdictSchema,
  AclPolicyRefusalReasonSchema,
  AclPrincipalSchema,
  AclRightSchema,
} from "./acl-policy-vocabulary.js";
import type {
  AclAceKind,
  AclInheritance,
  AclIsolationTier,
  AclManagedRootScope,
  AclPlaceholderKind,
  AclPlaceholderRole,
  AclPolicyDriftReason,
  AclPolicyDriftVerdict,
  AclPolicyRefusalReason,
  AclPrincipal,
  AclRight,
} from "./acl-policy-vocabulary.js";
import { WorkspaceRootIdSchema, WorkspaceRootPolicyClassSchema } from "./workspace-root-vocabulary.js";

/** Inferred here because the root set vocabulary exports the schema alone. */
type WorkspaceRootPolicyClass = z.infer<typeof WorkspaceRootPolicyClassSchema>;

export {
  ACL_PLANNER_REFUSAL_REASONS,
  ACL_PRINCIPAL_TIER,
  ACL_RECOVERY_PRINCIPALS,
  ACL_WRITE_CONFERRING_RIGHTS,
  AclAceKindSchema,
  AclInheritanceSchema,
  AclIsolationTierSchema,
  AclManagedRootScopeSchema,
  AclPlaceholderKindSchema,
  AclPlaceholderRoleSchema,
  AclPolicyDriftReasonSchema,
  AclPolicyDriftVerdictSchema,
  AclPolicyRefusalReasonSchema,
  AclPrincipalSchema,
  AclRightSchema,
};
export type {
  AclAceKind,
  AclInheritance,
  AclIsolationTier,
  AclManagedRootScope,
  AclPlaceholderKind,
  AclPlaceholderRole,
  AclPolicyDriftReason,
  AclPolicyDriftVerdict,
  AclPolicyRefusalReason,
  AclPrincipal,
  AclRight,
};

/** The descriptor shape. Bumped when a field is added, removed or retyped. */
export const AclPolicyContractVersionSchema = z.literal(1);
export const ACL_POLICY_CONTRACT_VERSION = 1 as const;

/**
 * The policy content. Bumped when any ACE, placeholder or DACL flag changes.
 *
 * This is the value reported as `isolation_policy_version`. It proves provenance
 * and nothing else: an applied version says where the policy came from, never that
 * it is still in force, which is what the drift checker is for.
 */
export const AclPolicyVersionSchema = z.number().int().min(1);
export const ACL_POLICY_VERSION = 9 as const;

/**
 * The grammar of a Windows SID in string form.
 *
 * Exported as the pattern, not only as a schema, because the Python planner checks
 * the same grammar on its own input and had no way to read it: a hand-copied regex on
 * that side is a second grammar that agrees with this one until someone edits one of
 * them. The generator publishes `.source` in the shared rule table.
 */
export const ACL_OWNER_SID_PATTERN = /^S-1-(?:\d+-)+\d+$/;

/** A Windows SID in string form. */
export const AclOwnerSidSchema = z.string().regex(ACL_OWNER_SID_PATTERN);

const RIGHT_ORDER: readonly AclRight[] = AclRightSchema.options;

/**
 * Rights in declaration order with duplicates dropped.
 *
 * Order carries no meaning to Windows, but a fixed order keeps the shipped
 * descriptor, its serialized form and its diff stable.
 */
function rights(...values: readonly AclRight[]): readonly AclRight[] {
  const held = new Set(values);
  return RIGHT_ORDER.filter((right) => held.has(right));
}

/** Every right this vocabulary can name. */
export const ACL_ALL_RIGHTS: readonly AclRight[] = rights(...RIGHT_ORDER);

/**
 * Full control.
 *
 * Used for the recovery principals on the managed roots.
 */
export const ACL_FULL_CONTROL_RIGHTS = ACL_ALL_RIGHTS;

/**
 * Full control minus `FILE_DELETE_CHILD`.
 *
 * No allow ACE on a workspace root may carry `FILE_DELETE_CHILD`, and that holds
 * for the recovery principals too. Dropping it costs them nothing they need: with
 * `WRITE_DAC` and `WRITE_OWNER` an administrator can rewrite the descriptor and
 * take the directory back. Keeping the rule absolute is what makes it checkable,
 * because a rule with an exception for "trusted" principals is a rule someone will
 * later read as permission to add one more exception.
 */
export const ACL_RECOVERY_RIGHTS_ON_WORKSPACE_ROOT: readonly AclRight[] = rights(
  ...ACL_ALL_RIGHTS.filter((right) => right !== "FILE_DELETE_CHILD")
);

/** The least a recovery principal must hold to get a root back. */
export const ACL_RECOVERY_MINIMUM_RIGHTS: readonly AclRight[] = rights(
  "FILE_READ_DATA",
  "FILE_READ_ATTRIBUTES",
  "FILE_EXECUTE",
  "DELETE",
  "READ_CONTROL",
  "WRITE_DAC",
  "WRITE_OWNER"
);

/** Read, enumerate and traverse. */
const READ_TRAVERSE_RIGHTS = rights(
  "FILE_READ_DATA",
  "FILE_READ_EA",
  "FILE_READ_ATTRIBUTES",
  "FILE_EXECUTE",
  "READ_CONTROL",
  "SYNCHRONIZE"
);

/**
 * Read-only content plus metadata compatibility for the isolated OpenCode Runtime.
 *
 * ProcMon measured OpenCode 1.18.25's embedded Bun loader opening every TypeScript tool/plugin with Generic Read plus
 * FILE_WRITE_ATTRIBUTES. This grants that one additional bit without allowing file content,
 * directory entries, names, ownership or the DACL to change.
 */
const RUNTIME_CONFIG_MODULE_RIGHTS = rights(...READ_TRAVERSE_RIGHTS, "FILE_WRITE_ATTRIBUTES");

/**
 * Read plus write, on the object itself.
 *
 * No `DELETE`, so the root or subtree root cannot be removed or renamed, and no
 * `FILE_DELETE_CHILD`, so a child cannot be replaced through the parent.
 */
const ROOT_READ_WRITE_RIGHTS = rights(
  ...READ_TRAVERSE_RIGHTS,
  "FILE_WRITE_DATA",
  "FILE_APPEND_DATA",
  "FILE_WRITE_EA",
  "FILE_WRITE_ATTRIBUTES"
);

/** Read plus write plus `DELETE`, inherited by ordinary children. */
const CHILD_READ_WRITE_RIGHTS = rights(...ROOT_READ_WRITE_RIGHTS, "DELETE");

/**
 * Reach a subtree without being able to list what else is beside it.
 *
 * This is what keeps a per-tier config or data root from becoming one island-wide
 * allow ACE: a tier can traverse to its own subtree but cannot enumerate the root
 * to discover another tier's.
 */
const TRAVERSE_ONLY_RIGHTS = rights("FILE_EXECUTE", "FILE_READ_ATTRIBUTES");

/** Rights that let a directory be removed, renamed or re-secured. */
const RELOCATE_RIGHTS = rights("DELETE", "FILE_DELETE_CHILD", "WRITE_DAC", "WRITE_OWNER");

/**
 * Create and open one already-known log file inside a tier's own log directory.
 *
 * `FILE_WRITE_DATA` on a directory is add-file, which is the whole grant the tier runner needs to
 * open the log it derived; `FILE_EXECUTE` is traverse. `FILE_READ_DATA` is deliberately absent,
 * because on a directory it is list-directory: a tier that could enumerate its own log directory
 * could read back the launch identifiers of every other launch under the same owner, and it has no
 * use for a name it did not derive itself. `DELETE`, `FILE_DELETE_CHILD`, `WRITE_DAC` and
 * `WRITE_OWNER` are absent because retention and re-securing are the owner's work, not the tier's.
 */
const LOG_DIRECTORY_RIGHTS = rights(
  "FILE_WRITE_DATA",
  "FILE_EXECUTE",
  "FILE_READ_ATTRIBUTES",
  "SYNCHRONIZE"
);

/**
 * Append to a log file below a tier's log directory, and nothing more.
 *
 * Append rather than write, so a reopen cannot rewrite or truncate what was already reported. This
 * does not make a log tamper-evident and must not be described as if it did: the tier creates the
 * file, so the tier is its owner, and an object owner holds `WRITE_DAC` implicitly whatever this
 * descriptor says. That is exactly why a runner log is tier self-report rather than security
 * evidence. The mask is
 * here to keep the ordinary case narrow, not to defend the adversarial one.
 */
const LOG_FILE_RIGHTS = rights("FILE_APPEND_DATA", "FILE_READ_ATTRIBUTES", "SYNCHRONIZE");

export const AclAceSchema = z
  .object({
    ace_kind: AclAceKindSchema,
    principal: AclPrincipalSchema,
    rights: z.array(AclRightSchema).min(1),
    inheritance: AclInheritanceSchema,
  })
  .strict();
export type AclAce = z.infer<typeof AclAceSchema>;

/**
 * One discretionary ACL.
 *
 * `dacl_protected` is SE_DACL_PROTECTED: inherited entries are dropped so the
 * listed ACEs are the whole story. Every DACL this descriptor ships is protected,
 * because a canonical explicit DACL is the boundary and an inherited broad grant
 * from above would silently widen it.
 */
export const AclDaclSchema = z
  .object({
    dacl_protected: z.boolean(),
    aces: z.array(AclAceSchema).min(1),
  })
  .strict();
export type AclDacl = z.infer<typeof AclDaclSchema>;

const PLACEHOLDER_SEGMENT = "[A-Za-z0-9_+-]+(?:\\.[A-Za-z0-9_+-]+)*";

/**
 * The grammar of a placeholder path.
 *
 * A pattern rather than a refinement so that it survives into the JSON Schema and
 * so the generated Pydantic model refuses the same strings the Zod schema does.
 */
export const ACL_PLACEHOLDER_PATH_PATTERN = new RegExp(
  `^${PLACEHOLDER_SEGMENT}(?:/${PLACEHOLDER_SEGMENT})*$`
);

/**
 * A path relative to a workspace root, in the spelling the container masks use.
 *
 * Forward slashes, no drive letter, no leading or trailing separator and no dot
 * segments, so no placeholder can name a path that escapes its root. This is
 * deliberately its own grammar rather than the payload member path grammar: a
 * placeholder names a directory inside a user's project tree, not a member of a
 * payload we build.
 */
export const AclPlaceholderPathSchema = z.string().regex(ACL_PLACEHOLDER_PATH_PATTERN);

export const AclPlaceholderSchema = z
  .object({
    relative_path: AclPlaceholderPathSchema,
    placeholder_kind: AclPlaceholderKindSchema,
    placeholder_role: AclPlaceholderRoleSchema,
    dacl: AclDaclSchema,
  })
  .strict();
export type AclPlaceholder = z.infer<typeof AclPlaceholderSchema>;

export const WorkspaceRootAclPolicySchema = z
  .object({
    policy_class: WorkspaceRootPolicyClassSchema,
    /**
     * Whether granting this class writes a revocation record.
     *
     * True for exactly the two user-granted classes: an installer-provisioned root
     * is not revocable, so there is nothing to revoke it with.
     */
    revocation_record_required: z.boolean(),
    root_dacl: AclDaclSchema,
    /** Empty for every class but `managed_default`. */
    protected_placeholders: z.array(AclPlaceholderSchema),
  })
  .strict();
export type WorkspaceRootAclPolicy = z.infer<typeof WorkspaceRootAclPolicySchema>;

/**
 * The DACL for one tier's own subtree under a managed root.
 *
 * The subtree's path is not named here. It is the tier's own directory under the
 * root, and the applier gets it from the host path object, so this descriptor does
 * not invent a directory layout the path contract has not declared.
 */
export const AclTierSubtreeDaclSchema = z
  .object({
    tier: AclIsolationTierSchema,
    dacl: AclDaclSchema,
  })
  .strict();
export type AclTierSubtreeDacl = z.infer<typeof AclTierSubtreeDaclSchema>;

/**
 * The DACL for a directory below one tier's subtree that another tier is let into.
 *
 * A tier's subtree is closed to every other tier, which is what keeps a tier's secrets from the tiers
 * that run the agent. An opening is the declared exception: one named directory, with a DACL of its
 * own that names both sides, so what crosses is a path a reader can see in this descriptor rather
 * than an ACE inherited from a parent. `relative_path` is below the tier's own subtree, so the
 * descriptor still invents no directory layout the path contract has not declared.
 */
export const AclTierOpeningSchema = z
  .object({
    tier: AclIsolationTierSchema,
    relative_path: AclPlaceholderPathSchema,
    dacl: AclDaclSchema,
  })
  .strict();
export type AclTierOpening = z.infer<typeof AclTierOpeningSchema>;

export const ManagedRootAclPolicySchema = z
  .object({
    managed_root_scope: AclManagedRootScopeSchema,
    root_dacl: AclDaclSchema,
    /** Empty for a root that is not subdivided per tier. */
    tier_subtree_dacls: z.array(AclTierSubtreeDaclSchema),
    /** Empty for a root with no directory another tier is let into. */
    tier_openings: z.array(AclTierOpeningSchema),
  })
  .strict();
export type ManagedRootAclPolicy = z.infer<typeof ManagedRootAclPolicySchema>;

/**
 * A folder between the user profile root and `backend_root`, relative to the profile.
 *
 * The placeholder grammar, so it cannot be empty (the profile root), climb out (the
 * folder holding every profile) or carry a drive or leading separator (a volume root).
 */
export const AclProfileRelativePathSchema = z.string().regex(ACL_PLACEHOLDER_PATH_PATTERN);

/**
 * One ACE added to one profile ancestor, beside whatever that folder already carries.
 *
 * Not a DACL, unlike every other entry here: the folder belongs to the user profile,
 * so the applier never replaces or protects its DACL. It adds `added_ace` if missing,
 * leaves every other ACE and the inheritance state as found, and removal takes away
 * exactly that ACE. It exists because Node's realpath lstat()s every path component
 * from the drive root, and above `backend_root` nothing else grants a tier anything.
 */
export const AclProfileAncestorGrantSchema = z
  .object({
    profile_relative_path: AclProfileRelativePathSchema,
    added_ace: AclAceSchema,
  })
  .strict();
export type AclProfileAncestorGrant = z.infer<typeof AclProfileAncestorGrantSchema>;

/**
 * Where a refusal or a drift finding is. Codes, ids and root-relative paths only.
 *
 * `tier` is here because a managed root's per-tier subtrees are separate objects with
 * separate DACLs, and a finding that could only say which root it was in would report
 * "one of the three subtrees under data_root" as its location.
 */
export const AclPolicyLocatorSchema = z
  .object({
    policy_class: WorkspaceRootPolicyClassSchema.nullable(),
    managed_root_scope: AclManagedRootScopeSchema.nullable(),
    tier: AclIsolationTierSchema.nullable(),
    root_id: WorkspaceRootIdSchema.nullable(),
    relative_path: z.string().nullable(),
  })
  .strict();
export type AclPolicyLocator = z.infer<typeof AclPolicyLocatorSchema>;

const EMPTY_LOCATOR: AclPolicyLocator = {
  policy_class: null,
  managed_root_scope: null,
  tier: null,
  root_id: null,
  relative_path: null,
};

export const AclPolicyRefusalItemSchema = z
  .object({
    reason: AclPolicyRefusalReasonSchema,
    locator: AclPolicyLocatorSchema,
  })
  .strict();
export type AclPolicyRefusalItem = z.infer<typeof AclPolicyRefusalItemSchema>;

export const AclPolicyRefusalSchema = z
  .object({
    contract_version: AclPolicyContractVersionSchema,
    refusals: z.array(AclPolicyRefusalItemSchema).min(1),
  })
  .strict();
export type AclPolicyRefusal = z.infer<typeof AclPolicyRefusalSchema>;

const aclPolicyDescriptorShape = {
  contract_version: AclPolicyContractVersionSchema,
  policy_version: AclPolicyVersionSchema,
  /** Exactly one policy per policy class. */
  workspace_root_policies: z.array(WorkspaceRootAclPolicySchema),
  /** Exactly one policy per managed root scope. */
  managed_root_policies: z.array(ManagedRootAclPolicySchema),
  /** Parents first, one per folder strictly between the profile root and `backend_root`. */
  profile_ancestor_grants: z.array(AclProfileAncestorGrantSchema),
} as const;

/**
 * The descriptor's shape, before the cross-field rules.
 *
 * Named separately so the rules below can be written against the parsed descriptor
 * rather than against `unknown`. `superRefine` runs only for a value that already
 * satisfies this, so the two are the same value seen twice.
 */
const aclPolicyDescriptorBaseSchema = z.object(aclPolicyDescriptorShape).strict();
export type AclPolicyDescriptor = z.infer<typeof aclPolicyDescriptorBaseSchema>;

/**
 * The sandbox principals, derived rather than listed.
 *
 * A fourth tier added to the vocabulary appears here, and therefore in the shipped
 * masks, without anyone remembering to extend a literal list. A tier that is missing
 * from a mask is a tier the mask does not deny, and the rules below check the mask
 * against the tier enum, so a literal list here would turn a new tier into a
 * refusal at generation time rather than a mask that covers it.
 */
const SANDBOX_PRINCIPALS: readonly AclPrincipal[] = AclPrincipalSchema.options.filter(
  (principal) => ACL_PRINCIPAL_TIER[principal] !== null
);

/**
 * Rights that let a principal rewrite a security descriptor or take an object.
 *
 * Held by no sandbox principal anywhere. `WRITE_DAC` is a strictly stronger
 * parent-replacement vector than the `FILE_DELETE_CHILD` this descriptor forbids
 * absolutely: a principal that can rewrite a DACL can grant itself the rest.
 */
const DACL_CONTROL_RIGHTS: readonly AclRight[] = rights("WRITE_DAC", "WRITE_OWNER");

/**
 * The DOS device names, which are reserved at every directory level on Windows.
 *
 * Reserved with or without an extension, so `NUL.txt` is the device too. Checked
 * here rather than in `ACL_PLACEHOLDER_PATH_PATTERN` because the pattern has to
 * survive into the JSON Schema, and a regex that enumerated these would be
 * unreadable there.
 */
const RESERVED_DEVICE_NAMES: ReadonlySet<string> = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  ...Array.from({ length: 9 }, (_unused, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_unused, index) => `lpt${index + 1}`),
]);

/** The string an issue path points at, or null if it is not a string. */
function valueAt(root: unknown, path: readonly PropertyKey[]): string | null {
  let cursor: unknown = root;
  for (const step of path) {
    if (cursor === null || typeof cursor !== "object") return null;
    cursor = (cursor as Record<PropertyKey, unknown>)[step];
  }
  return typeof cursor === "string" ? cursor : null;
}

function isSandboxPrincipal(principal: AclPrincipal): boolean {
  return ACL_PRINCIPAL_TIER[principal] !== null;
}

function grantsAny(ace: AclAce, candidates: readonly AclRight[]): readonly AclRight[] {
  return candidates.filter((right) => ace.rights.includes(right));
}

/**
 * Whether an ACE is evaluated against the object it is attached to.
 *
 * `children_only` is INHERIT_ONLY, which Windows does not evaluate on the object
 * itself. Every rule about what an object grants or denies has to filter on this, or
 * an ACE that applies to nothing on this object satisfies it.
 */
function appliesToObject(ace: AclAce): boolean {
  return ace.inheritance !== "children_only";
}

type Refuse = (
  reason: AclPolicyRefusalReason,
  path: (string | number)[],
  locator: AclPolicyLocator,
  message: string
) => void;

/**
 * The rules every DACL obeys wherever it appears.
 */
function refineDacl(
  dacl: AclDacl,
  at: (string | number)[],
  locator: AclPolicyLocator,
  refuse: Refuse
): void {
  if (!dacl.dacl_protected) {
    refuse(
      "dacl_not_protected",
      [...at, "dacl_protected"],
      locator,
      "an explicit DACL is the boundary, so inherited entries are dropped"
    );
  }

  const seen = new Set<string>();
  let sawAllow = false;
  dacl.aces.forEach((ace, index) => {
    if (new Set(ace.rights).size !== ace.rights.length) {
      refuse(
        "ace_rights_not_unique",
        [...at, "aces", index, "rights"],
        locator,
        "a right is named once per ACE"
      );
    }
    const key = JSON.stringify([ace.ace_kind, ace.principal, [...ace.rights].sort(), ace.inheritance]);
    if (seen.has(key)) {
      refuse("duplicate_ace", [...at, "aces", index], locator, "the same ACE is listed twice");
    }
    seen.add(key);

    if (ace.ace_kind === "allow") {
      sawAllow = true;
    } else if (sawAllow) {
      refuse(
        "deny_ace_not_ordered_before_allow",
        [...at, "aces", index],
        locator,
        "a canonical DACL lists every deny ACE before any allow ACE"
      );
    }

    if (ace.ace_kind === "allow" && isSandboxPrincipal(ace.principal)) {
      if (ace.rights.includes("FILE_DELETE_CHILD")) {
        refuse(
          "sandbox_principal_granted_delete_child",
          [...at, "aces", index, "rights"],
          locator,
          "FILE_DELETE_CHILD lets a child be replaced through its parent"
        );
      }
      const control = grantsAny(ace, DACL_CONTROL_RIGHTS);
      if (control.length > 0) {
        refuse(
          "sandbox_principal_granted_dacl_control",
          [...at, "aces", index, "rights"],
          locator,
          `${control.join(", ")} lets the sandbox rewrite this boundary into any other one`
        );
      }
    }

    if (ace.ace_kind === "deny" && ACL_RECOVERY_PRINCIPALS.includes(ace.principal)) {
      // A deny ACE naming a recovery principal is not the mirror image of a missing
      // allow: canonical ordering puts it first, so Windows evaluates it first and
      // the allow below it never runs. Recovery would then need
      // SeTakeOwnershipPrivilege, which is not a recovery path we can claim.
      refuse(
        "recovery_principal_denied",
        [...at, "aces", index],
        locator,
        `a deny ACE for ${ace.principal} overrides the allow that keeps this object reachable`
      );
    }
  });

  for (const principal of ACL_RECOVERY_PRINCIPALS) {
    const allowed = dacl.aces.filter(
      (ace) => ace.ace_kind === "allow" && ace.principal === principal && appliesToObject(ace)
    );
    if (allowed.length === 0) {
      refuse(
        "recovery_principal_absent",
        [...at, "aces"],
        locator,
        `${principal} keeps recovery access to every root`
      );
      continue;
    }
    // The one exemption, and it is scoped to the one root that earns it: the
    // isolation record store deliberately gives the interactive user read access
    // only, because a user who can rewrite those records can forge a revocation.
    // Anywhere else, host_user holding less than the minimum would ship a directory
    // its own owner cannot repair.
    if (principal === "host_user" && locator.managed_root_scope === "isolation_root") continue;
    const held = new Set(allowed.flatMap((ace) => ace.rights));
    const missing = ACL_RECOVERY_MINIMUM_RIGHTS.filter((right) => !held.has(right));
    if (missing.length > 0) {
      refuse(
        "recovery_principal_absent",
        [...at, "aces"],
        locator,
        `${principal} is missing ${missing.join(", ")}`
      );
    }
  }
}

/**
 * The cross-field rules, over an already-parsed descriptor.
 *
 * `superRefine` runs only when the object parse did not abort, so every field here
 * is present and of its declared type. Rules that belong to a field's own shape live
 * in the schema instead, where the generated Pydantic model carries them too.
 */
function refineAclPolicyDescriptor(
  descriptor: AclPolicyDescriptor,
  context: z.RefinementCtx
): void {
  const refuse: Refuse = (reason, path, locator, message) => {
    context.addIssue({ code: "custom", path, params: { reason, locator }, message });
  };

  const seenClasses = new Set<WorkspaceRootPolicyClass>();
  descriptor.workspace_root_policies.forEach((policy, index) => {
    const policyClass = policy.policy_class;
    const locator: AclPolicyLocator = { ...EMPTY_LOCATOR, policy_class: policyClass };
    const at: (string | number)[] = ["workspace_root_policies", index];
    if (seenClasses.has(policyClass)) {
      refuse("policy_class_duplicated", [...at, "policy_class"], locator, "one policy per class");
    }
    seenClasses.add(policyClass);

    refineDacl(policy.root_dacl, [...at, "root_dacl"], locator, refuse);

    const expectRevocation = policyClass !== "managed_default";
    if (policy.revocation_record_required !== expectRevocation) {
      refuse(
        "revocation_record_inconsistent_with_policy_class",
        [...at, "revocation_record_required"],
        locator,
        `${policyClass} is ${expectRevocation ? "" : "not "}revocable`
      );
    }

    const rootAces = policy.root_dacl.aces;
    const placeholders = policy.protected_placeholders;
    const placeholderAces = placeholders.flatMap((placeholder) => placeholder.dacl.aces);
    for (const ace of [...rootAces, ...placeholderAces]) {
      if (ace.ace_kind === "allow" && ace.rights.includes("FILE_DELETE_CHILD")) {
        refuse(
          "workspace_root_allow_ace_grants_delete_child",
          [...at, "root_dacl"],
          locator,
          "no allow ACE inside a workspace root may carry FILE_DELETE_CHILD"
        );
      }
    }

    if (policyClass === "user_granted_ro") {
      rootAces.forEach((ace, aceIndex) => {
        if (
          ace.ace_kind === "allow" &&
          isSandboxPrincipal(ace.principal) &&
          grantsAny(ace, ACL_WRITE_CONFERRING_RIGHTS).length > 0
        ) {
          refuse(
            "read_only_class_grants_sandbox_write",
            [...at, "root_dacl", "aces", aceIndex, "rights"],
            locator,
            "a read-only root grants the sandbox no write-conferring right"
          );
        }
      });
    }

    if (policyClass !== "managed_default" && placeholders.length > 0) {
      refuse(
        "placeholder_declared_outside_managed_default",
        [...at, "protected_placeholders"],
        locator,
        "granting a root carries no protected-content claim, so it carries no placeholder"
      );
    }
    if (policyClass === "managed_default" && placeholders.length === 0) {
      refuse(
        "placeholder_absent_for_managed_default",
        [...at, "protected_placeholders"],
        locator,
        "the default managed root is the class that carries the masks"
      );
    }

    // Keyed case-folded throughout: NTFS is case-insensitive by default, so two
    // spellings of one path are two declarations for one directory, and the second
    // DACL applied would replace the first wholesale.
    const declaredPaths = new Set<string>();
    const ancestorRoles = new Map<string, AclPlaceholderRole>();
    for (const placeholder of placeholders) {
      ancestorRoles.set(placeholder.relative_path.toLowerCase(), placeholder.placeholder_role);
    }
    placeholders.forEach((placeholder, placeholderIndex) => {
      const relativePath = placeholder.relative_path;
      const placeholderLocator: AclPolicyLocator = { ...locator, relative_path: relativePath };
      const placeholderAt: (string | number)[] = [
        ...at,
        "protected_placeholders",
        placeholderIndex,
      ];
      const key = relativePath.toLowerCase();
      if (declaredPaths.has(key)) {
        refuse(
          "duplicate_placeholder_path",
          [...placeholderAt, "relative_path"],
          placeholderLocator,
          "one placeholder per path, whatever case it is spelled in"
        );
      }
      declaredPaths.add(key);

      const segments = relativePath.split("/");
      for (const segment of segments) {
        if (RESERVED_DEVICE_NAMES.has(segment.toLowerCase().split(".")[0])) {
          refuse(
            "placeholder_path_reserved_device_name",
            [...placeholderAt, "relative_path"],
            placeholderLocator,
            `${segment} names a DOS device, so creating it would not create a directory`
          );
        }
      }
      for (let depth = 1; depth < segments.length; depth += 1) {
        const ancestor = segments.slice(0, depth).join("/");
        if (ancestorRoles.get(ancestor.toLowerCase()) !== "guard_ancestor") {
          refuse(
            "placeholder_ancestor_not_declared",
            [...placeholderAt, "relative_path"],
            placeholderLocator,
            `${ancestor} carries a placeholder below it, so it is declared as a guard_ancestor`
          );
        }
      }

      if (placeholder.placeholder_kind !== "empty_directory") {
        // A mask stands in for a directory the container mounted a tmpfs over, and a
        // guard ancestor holds a mask below it. Neither is a thing a file can be.
        refuse(
          "placeholder_kind_not_directory",
          [...placeholderAt, "placeholder_kind"],
          placeholderLocator,
          "a placeholder replaces a directory, so it is a directory"
        );
      }

      refineDacl(placeholder.dacl, [...placeholderAt, "dacl"], placeholderLocator, refuse);

      const aces = placeholder.dacl.aces;
      const isMask = placeholder.placeholder_role === "protected_mask";
      if (isMask) {
        aces.forEach((ace, aceIndex) => {
          if (ace.ace_kind === "allow" && isSandboxPrincipal(ace.principal)) {
            // A mask denying everything and allowing something is not a mask. The
            // deny wins on the rights it names, so what an allow ACE here really
            // does is widen the mask by exactly the rights nobody remembered to
            // deny.
            refuse(
              "protected_mask_grants_sandbox_access",
              [...placeholderAt, "dacl", "aces", aceIndex],
              placeholderLocator,
              `a mask grants ${ace.principal} nothing, and this ACE grants it something`
            );
          }
        });
      }

      // Required in full, not as a subset that is "enough". The shipped masks deny
      // every right in the vocabulary and the guards deny every relocation right, so
      // a subset rule would only ever accept a descriptor weaker than the one we
      // ship, and a reader could not tell which of the two lines was the rule.
      const requiredDenials = isMask ? ACL_ALL_RIGHTS : RELOCATE_RIGHTS;
      const denied = aces.filter(
        (ace) =>
          ace.ace_kind === "deny" && isSandboxPrincipal(ace.principal) && appliesToObject(ace)
      );
      for (const tier of AclIsolationTierSchema.options) {
        const forTier = denied.filter((ace) => ACL_PRINCIPAL_TIER[ace.principal] === tier);
        const held = new Set(forTier.flatMap((ace) => ace.rights));
        const missing = requiredDenials.filter((right) => !held.has(right));
        if (missing.length > 0) {
          refuse(
            "placeholder_dacl_missing_deny_ace",
            [...placeholderAt, "dacl", "aces"],
            placeholderLocator,
            `tier ${tier} is not denied ${missing.join(", ")} on this object`
          );
        }
      }
    });
  });

  for (const policyClass of WorkspaceRootPolicyClassSchema.options) {
    if (!seenClasses.has(policyClass)) {
      refuse(
        "policy_class_not_covered",
        ["workspace_root_policies"],
        { ...EMPTY_LOCATOR, policy_class: policyClass },
        "every policy class has a policy, else a root set member has no descriptor"
      );
    }
  }

  const seenScopes = new Set<AclManagedRootScope>();
  descriptor.managed_root_policies.forEach((policy, index) => {
    const scope = policy.managed_root_scope;
    const locator: AclPolicyLocator = { ...EMPTY_LOCATOR, managed_root_scope: scope };
    const at: (string | number)[] = ["managed_root_policies", index];
    if (seenScopes.has(scope)) {
      refuse(
        "managed_root_scope_duplicated",
        [...at, "managed_root_scope"],
        locator,
        "one policy per managed root"
      );
    }
    seenScopes.add(scope);

    refineDacl(policy.root_dacl, [...at, "root_dacl"], locator, refuse);

    const subtrees = policy.tier_subtree_dacls;
    const openings = policy.tier_openings;
    const everyAce = [
      ...policy.root_dacl.aces,
      ...subtrees.flatMap((subtree) => subtree.dacl.aces),
      ...openings.flatMap((opening) => opening.dacl.aces),
    ];

    if (scope === "payload_root") {
      for (const ace of everyAce) {
        if (
          ace.ace_kind === "allow" &&
          isSandboxPrincipal(ace.principal) &&
          grantsAny(ace, ACL_WRITE_CONFERRING_RIGHTS).length > 0
        ) {
          refuse(
            "payload_root_grants_sandbox_write",
            [...at, "root_dacl"],
            locator,
            "the payload is read and executed, never written"
          );
        }
      }
    }

    if (scope === "protected_root") {
      for (const ace of everyAce) {
        if (ace.ace_kind === "allow" && isSandboxPrincipal(ace.principal)) {
          refuse(
            "protected_root_grants_sandbox_access",
            [...at, "root_dacl"],
            locator,
            "real protected content sits outside every sandbox-reachable layer"
          );
        }
      }
    }

    const seenTiers = new Set<AclIsolationTier>();
    subtrees.forEach((subtree, subtreeIndex) => {
      if (seenTiers.has(subtree.tier)) {
        refuse(
          "duplicate_tier_subtree_dacl",
          [...at, "tier_subtree_dacls", subtreeIndex, "tier"],
          locator,
          "one subtree policy per tier"
        );
      }
      seenTiers.add(subtree.tier);
      refineDacl(
        subtree.dacl,
        [...at, "tier_subtree_dacls", subtreeIndex, "dacl"],
        locator,
        refuse
      );
    });

    const seenOpenings = new Set<string>();
    openings.forEach((opening, openingIndex) => {
      const key = `${opening.tier}/${opening.relative_path}`;
      if (seenOpenings.has(key)) {
        refuse(
          "duplicate_tier_opening",
          [...at, "tier_openings", openingIndex, "relative_path"],
          locator,
          "one DACL per opening"
        );
      }
      seenOpenings.add(key);
      if (!seenTiers.has(opening.tier)) {
        refuse(
          "tier_opening_without_subtree",
          [...at, "tier_openings", openingIndex, "tier"],
          locator,
          "an opening is a directory below a tier subtree the policy declares"
        );
      }
      refineDacl(
        opening.dacl,
        [...at, "tier_openings", openingIndex, "dacl"],
        locator,
        refuse
      );
    });
  });

  for (const scope of AclManagedRootScopeSchema.options) {
    if (!seenScopes.has(scope)) {
      refuse(
        "managed_root_scope_not_covered",
        ["managed_root_policies"],
        { ...EMPTY_LOCATOR, managed_root_scope: scope },
        "every managed root the path contract names has a policy"
      );
    }
  }

  refineProfileAncestorGrants(descriptor.profile_ancestor_grants, refuse);
}

/**
 * The profile ancestor rules.
 *
 * The chain is checked as a chain, parents first and with no gap, because the applier
 * derives the folders from it: a gap is a folder Node still cannot lstat, and a
 * duplicate in another spelling is one NTFS folder declared twice.
 */
function refineProfileAncestorGrants(grants: readonly AclProfileAncestorGrant[], refuse: Refuse): void {
  if (grants.length === 0) {
    refuse(
      "profile_ancestor_chain_invalid",
      ["profile_ancestor_grants"],
      EMPTY_LOCATOR,
      "the folders between the profile root and backend_root are declared"
    );
  }
  grants.forEach((grant, index) => {
    const path = grant.profile_relative_path;
    const locator: AclPolicyLocator = { ...EMPTY_LOCATOR, relative_path: path };
    const at: (string | number)[] = ["profile_ancestor_grants", index];
    const segments = path.split("/");
    const parent = segments.slice(0, -1).join("/").toLowerCase();
    if (
      segments.length !== index + 1 ||
      (index > 0 && parent !== grants[index - 1].profile_relative_path.toLowerCase())
    ) {
      refuse(
        "profile_ancestor_chain_invalid",
        [...at, "profile_relative_path"],
        locator,
        "each grant names the child of the one before it, starting one level below the profile"
      );
    }

    const ace = grant.added_ace;
    if (
      ace.ace_kind !== "allow" ||
      !isSandboxPrincipal(ace.principal) ||
      ace.rights.length !== 1 ||
      ace.rights[0] !== "FILE_READ_ATTRIBUTES" ||
      ace.inheritance !== "this_object_only"
    ) {
      refuse(
        "profile_ancestor_grant_widened",
        [...at, "added_ace"],
        locator,
        "a profile folder gives a sandbox tier FILE_READ_ATTRIBUTES on itself and nothing more"
      );
    }
  });
}

export const AclPolicyDescriptorSchema =
  aclPolicyDescriptorBaseSchema.superRefine(refineAclPolicyDescriptor);

/**
 * The descriptor as one canonical string.
 *
 * Object keys sorted at every depth and no insignificant whitespace, so the string
 * depends on the content and not on the order a serializer happened to walk it. This
 * is the JS half of a two-language agreement: the Python half is
 * `json.dumps(payload, sort_keys=True, separators=(",", ":"))`, which produces the
 * same bytes for the JSON types a descriptor is made of.
 *
 * It exists because the cross-field rules above do not survive codegen. Zod
 * `superRefine` has no JSON Schema representation, so the generated Pydantic model
 * enforces field shapes and nothing else. Rather than restate ~30 rules in a second
 * language and let the two spellings drift, the planner pins the digest of this
 * string: the rules are checked once, here, at build time, and the runtime refuses
 * any descriptor that is not the artifact those rules were checked against.
 */
export function canonicalAclPolicyJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalAclPolicyJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, member]) => member !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, member]) => `${JSON.stringify(key)}:${canonicalAclPolicyJson(member)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * The reason a schema-level failure reports, by the field it landed on.
 *
 * The refinement never runs when the base parse fails, so without this a rule
 * moved into the schema would silently lose its reason.
 */
const SHAPE_ISSUE_REASONS: Readonly<Record<string, AclPolicyRefusalReason>> = {
  relative_path: "placeholder_path_not_root_relative",
  profile_relative_path: "profile_ancestor_path_not_profile_relative",
  rights: "ace_rights_empty",
};

/**
 * Validate a descriptor and return the refusal, or undefined.
 *
 * A failure that lands nowhere more specific reports `descriptor_shape_invalid`.
 */
export function refuseAclPolicyDescriptor(value: unknown): AclPolicyRefusal | undefined {
  const result = AclPolicyDescriptorSchema.safeParse(value);
  if (result.success) {
    return undefined;
  }

  const items = new Map<string, AclPolicyRefusalItem>();
  for (const issue of result.error.issues) {
    const params = (issue as { params?: { reason?: unknown; locator?: unknown } }).params;
    if (typeof params?.reason !== "string") {
      // Some rules are expressed in the schema rather than in the refinement, so
      // that the generated Pydantic model refuses the same values. Name their
      // reason anyway: "malformed somewhere" is not a usable verdict.
      const shapeReason = SHAPE_ISSUE_REASONS[String(issue.path.at(-1))];
      const item: AclPolicyRefusalItem = {
        reason: shapeReason ?? "descriptor_shape_invalid",
        locator:
          shapeReason === "placeholder_path_not_root_relative" ||
          shapeReason === "profile_ancestor_path_not_profile_relative"
            ? { ...EMPTY_LOCATOR, relative_path: valueAt(value, issue.path) }
            : EMPTY_LOCATOR,
      };
      items.set(JSON.stringify(item), item);
      continue;
    }
    const parsedLocator = AclPolicyLocatorSchema.safeParse(params.locator);
    const item: AclPolicyRefusalItem = {
      reason: params.reason as AclPolicyRefusalReason,
      locator: parsedLocator.success ? parsedLocator.data : EMPTY_LOCATOR,
    };
    items.set(JSON.stringify(item), item);
  }
  if (items.size === 0) {
    const item: AclPolicyRefusalItem = {
      reason: "descriptor_shape_invalid",
      locator: EMPTY_LOCATOR,
    };
    items.set(JSON.stringify(item), item);
  }

  return AclPolicyRefusalSchema.parse({
    contract_version: ACL_POLICY_CONTRACT_VERSION,
    refusals: [...items.values()],
  });
}

function allow(
  principal: AclPrincipal,
  granted: readonly AclRight[],
  inheritance: AclInheritance
): AclAce {
  return { ace_kind: "allow", principal, rights: [...granted], inheritance };
}

function deny(
  principal: AclPrincipal,
  denied: readonly AclRight[],
  inheritance: AclInheritance
): AclAce {
  return { ace_kind: "deny", principal, rights: [...denied], inheritance };
}

function recoveryAces(granted: readonly AclRight[]): readonly AclAce[] {
  return ACL_RECOVERY_PRINCIPALS.map((principal) =>
    allow(principal, granted, "this_object_and_children")
  );
}

/**
 * The file/tool tier's grant on a read-write workspace root.
 *
 * Two ACEs, not one: the root itself withholds `DELETE` so it cannot be renamed
 * out from under the policy, while ordinary children inherit it so the agent can
 * still delete and rename the files it made.
 */
const WORKSPACE_READ_WRITE_ACES: readonly AclAce[] = [
  allow("sandbox_tier_file_tool", ROOT_READ_WRITE_RIGHTS, "this_object_only"),
  allow("sandbox_tier_file_tool", CHILD_READ_WRITE_RIGHTS, "children_only"),
];

function protectedMask(relativePath: string): AclPlaceholder {
  return {
    relative_path: relativePath,
    placeholder_kind: "empty_directory",
    placeholder_role: "protected_mask",
    dacl: {
      dacl_protected: true,
      aces: [
        ...SANDBOX_PRINCIPALS.map((principal) =>
          deny(principal, ACL_ALL_RIGHTS, "this_object_and_children")
        ),
        ...recoveryAces(ACL_RECOVERY_RIGHTS_ON_WORKSPACE_ROOT),
      ],
    },
  };
}

function guardAncestor(relativePath: string): AclPlaceholder {
  return {
    relative_path: relativePath,
    placeholder_kind: "empty_directory",
    placeholder_role: "guard_ancestor",
    dacl: {
      dacl_protected: true,
      aces: [
        ...SANDBOX_PRINCIPALS.map((principal) =>
          deny(principal, RELOCATE_RIGHTS, "this_object_only")
        ),
        ...recoveryAces(ACL_RECOVERY_RIGHTS_ON_WORKSPACE_ROOT),
        ...WORKSPACE_READ_WRITE_ACES,
      ],
    },
  };
}

/**
 * The masks the container provides with tmpfs mounts.
 *
 * `data_protection_workspace` is listed because `mask_registries` sits below it:
 * the mask itself cannot be deleted, but without a guard on its parent the parent
 * could be renamed and the compatibility path would point at nothing.
 */
const MANAGED_DEFAULT_PLACEHOLDERS: readonly AclPlaceholder[] = [
  protectedMask("sensitive"),
  guardAncestor("data_protection_workspace"),
  protectedMask("data_protection_workspace/mask_registries"),
];

function workspaceReadWritePolicy(
  policyClass: WorkspaceRootPolicyClass,
  placeholders: readonly AclPlaceholder[]
): WorkspaceRootAclPolicy {
  return {
    policy_class: policyClass,
    revocation_record_required: policyClass !== "managed_default",
    root_dacl: {
      dacl_protected: true,
      aces: [
        ...recoveryAces(ACL_RECOVERY_RIGHTS_ON_WORKSPACE_ROOT),
        ...WORKSPACE_READ_WRITE_ACES,
      ],
    },
    protected_placeholders: [...placeholders],
  };
}

// The channel tier has no ACE on any workspace root in this policy version. Its three openings
// (inbox directory, copied agent definition, outbox directory) arrive with EG2-6.
const WORKSPACE_ROOT_POLICIES: readonly WorkspaceRootAclPolicy[] = [
  workspaceReadWritePolicy("managed_default", MANAGED_DEFAULT_PLACEHOLDERS),
  workspaceReadWritePolicy("user_granted_rw", []),
  {
    policy_class: "user_granted_ro",
    revocation_record_required: true,
    root_dacl: {
      dacl_protected: true,
      aces: [
        ...recoveryAces(ACL_RECOVERY_RIGHTS_ON_WORKSPACE_ROOT),
        // Traverse is FILE_EXECUTE on a directory. Denying FILE_EXECUTE would not
        // be a noexec equivalent anyway: an interpreter the agent can read a
        // script with is still an interpreter.
        allow("sandbox_tier_file_tool", READ_TRAVERSE_RIGHTS, "this_object_and_children"),
      ],
    },
    protected_placeholders: [],
  },
];

/**
 * A per-tier subtree under a managed root, reachable but not enumerable from the
 * root above it.
 */
function tierSubtree(
  tier: AclIsolationTier,
  principal: AclPrincipal,
  writable: boolean
): AclTierSubtreeDacl {
  return {
    tier,
    dacl: {
      dacl_protected: true,
      aces: writable
        ? [
            ...recoveryAces(ACL_FULL_CONTROL_RIGHTS),
            allow(principal, ROOT_READ_WRITE_RIGHTS, "this_object_only"),
            allow(principal, CHILD_READ_WRITE_RIGHTS, "children_only"),
          ]
        : [
            ...recoveryAces(ACL_FULL_CONTROL_RIGHTS),
            allow(principal, READ_TRAVERSE_RIGHTS, "this_object_and_children"),
          ],
    },
  };
}

/** A managed root whose contents are divided per tier. */
function subdividedRoot(
  scope: AclManagedRootScope,
  subtrees: readonly AclTierSubtreeDacl[],
  openings: readonly AclTierOpening[] = []
): ManagedRootAclPolicy {
  const reachers = subtrees.map((subtree) => {
    const principal = SANDBOX_PRINCIPALS.find(
      (candidate) => ACL_PRINCIPAL_TIER[candidate] === subtree.tier
    );
    return allow(principal as AclPrincipal, TRAVERSE_ONLY_RIGHTS, "this_object_only");
  });
  return {
    managed_root_scope: scope,
    root_dacl: {
      dacl_protected: true,
      aces: [...recoveryAces(ACL_FULL_CONTROL_RIGHTS), ...reachers],
    },
    tier_subtree_dacls: [...subtrees],
    tier_openings: [...openings],
  };
}

/**
 * The channel tier's directory in the data root, which holds its tokens.
 *
 * The same read-write subtree every tier gets, plus one ACE for file_tool: traverse on this directory
 * and nothing else, so that file_tool can reach the two openings below it. Traverse is not
 * enumeration and does not inherit, so file_tool can neither list the directory nor open anything in
 * it that is not an opening with a DACL of its own.
 */
function channelDataSubtree(): AclTierSubtreeDacl {
  const base = tierSubtree("channel", "sandbox_tier_channel", true);
  return {
    ...base,
    dacl: {
      ...base.dacl,
      aces: [...base.dacl.aces, allow("sandbox_tier_file_tool", TRAVERSE_ONLY_RIGHTS, "this_object_only")],
    },
  };
}

/**
 * The channel tier's three openings onto the rest of the product.
 *
 * The router holds the Slack and Telegram tokens, so it sees the workspace through exactly these:
 * an inbox it writes and file_tool reads, an outbox file_tool writes and it reads, and an agent
 * definition directory the host writes and it reads. Each DACL names both sides. The router's own
 * data directory, where the tokens are, is the channel subtree above and is in none of them.
 */
const CHANNEL_INBOX: AclTierOpening = {
  tier: "channel",
  relative_path: "inbox",
  dacl: {
    dacl_protected: true,
    aces: [
      ...recoveryAces(ACL_FULL_CONTROL_RIGHTS),
      allow("sandbox_tier_channel", ROOT_READ_WRITE_RIGHTS, "this_object_only"),
      allow("sandbox_tier_channel", CHILD_READ_WRITE_RIGHTS, "children_only"),
      allow("sandbox_tier_file_tool", READ_TRAVERSE_RIGHTS, "this_object_and_children"),
    ],
  },
};

const CHANNEL_OUTBOX: AclTierOpening = {
  tier: "channel",
  relative_path: "outbox",
  dacl: {
    dacl_protected: true,
    aces: [
      ...recoveryAces(ACL_FULL_CONTROL_RIGHTS),
      allow("sandbox_tier_file_tool", ROOT_READ_WRITE_RIGHTS, "this_object_only"),
      allow("sandbox_tier_file_tool", CHILD_READ_WRITE_RIGHTS, "children_only"),
      allow("sandbox_tier_channel", READ_TRAVERSE_RIGHTS, "this_object_and_children"),
    ],
  },
};

const CHANNEL_AGENT_DEFINITIONS: AclTierOpening = {
  tier: "channel",
  relative_path: "agents",
  dacl: {
    dacl_protected: true,
    aces: [
      ...recoveryAces(ACL_FULL_CONTROL_RIGHTS),
      allow("sandbox_tier_channel", READ_TRAVERSE_RIGHTS, "this_object_and_children"),
    ],
  },
};

/**
 * A per-tier log directory: write-only from inside the tier, readable by the owner.
 *
 * A tier's log directory is not a scratch tree, so it does not get the read-write subtree above.
 * The tier runner opens exactly one file whose name it derived itself, appends to it, and never
 * reads, lists, deletes or re-secures anything here; those are the only rights granted. The owner
 * still reads and prunes the tree through the recovery ACEs, which inherit onto every file a tier
 * creates - that inheritance is what lets an unelevated owner delete a tier-created log, and it is
 * why there is no separate owner ACE on the created file.
 */
function tierLogSubtree(tier: AclIsolationTier, principal: AclPrincipal): AclTierSubtreeDacl {
  return {
    tier,
    dacl: {
      dacl_protected: true,
      aces: [
        ...recoveryAces(ACL_FULL_CONTROL_RIGHTS),
        allow(principal, LOG_DIRECTORY_RIGHTS, "this_object_only"),
        allow(principal, LOG_FILE_RIGHTS, "children_only"),
      ],
    },
  };
}

const EVERY_TIER_WRITES: readonly AclTierSubtreeDacl[] = [
  tierSubtree("bootstrap", "sandbox_tier_bootstrap", true),
  tierSubtree("file_tool", "sandbox_tier_file_tool", true),
  tierSubtree("network_connector", "sandbox_tier_network_connector", true),
  tierSubtree("channel", "sandbox_tier_channel", true),
];

const EVERY_TIER_APPENDS_LOGS: readonly AclTierSubtreeDacl[] = [
  tierLogSubtree("bootstrap", "sandbox_tier_bootstrap"),
  tierLogSubtree("file_tool", "sandbox_tier_file_tool"),
  tierLogSubtree("network_connector", "sandbox_tier_network_connector"),
  tierLogSubtree("channel", "sandbox_tier_channel"),
];

const MANAGED_ROOT_POLICIES: readonly ManagedRootAclPolicy[] = [
  // Config content is written by the orchestrator/config materializer. The Runtime reads content
  // and may update file attributes only, because Bun's measured TypeScript loader requires that
  // metadata right. It still cannot add, overwrite, append, delete, rename or re-secure anything.
  subdividedRoot("config_root", [
    {
      tier: "bootstrap",
      dacl: {
        dacl_protected: true,
        aces: [
          ...recoveryAces(ACL_FULL_CONTROL_RIGHTS),
          allow("sandbox_tier_bootstrap", ROOT_READ_WRITE_RIGHTS, "this_object_only"),
          allow("sandbox_tier_bootstrap", CHILD_READ_WRITE_RIGHTS, "children_only"),
          allow(
            "sandbox_tier_file_tool",
            RUNTIME_CONFIG_MODULE_RIGHTS,
            "this_object_and_children"
          ),
        ],
      },
    },
    tierSubtree("file_tool", "sandbox_tier_file_tool", false),
    tierSubtree("network_connector", "sandbox_tier_network_connector", false),
    tierSubtree("channel", "sandbox_tier_channel", false),
  ], [CHANNEL_AGENT_DEFINITIONS]),
  subdividedRoot(
    "data_root",
    EVERY_TIER_WRITES.map((subtree) => (subtree.tier === "channel" ? channelDataSubtree() : subtree)),
    [CHANNEL_INBOX, CHANNEL_OUTBOX]
  ),
  // Logs are the one subdivided root a tier writes without reading. The tier runner opens a single
  // derived file name per launch and appends to it, so this root does not reuse the read-write
  // subtree the data and temp roots get.
  subdividedRoot("logs_root", EVERY_TIER_APPENDS_LOGS),
  subdividedRoot("temp_root", EVERY_TIER_WRITES),
  // Fixed layout ancestors: read grants apply only to these directory objects.
  ...(["backend_root", "payload_container_root", "temp_container_root"] as const).map(
    (scope): ManagedRootAclPolicy => ({
      managed_root_scope: scope,
      root_dacl: {
        dacl_protected: true,
        aces: [
          ...recoveryAces(ACL_FULL_CONTROL_RIGHTS),
          ...SANDBOX_PRINCIPALS.map((principal) =>
            allow(principal, READ_TRAVERSE_RIGHTS, "this_object_only")
          ),
        ],
      },
      tier_subtree_dacls: [],
      tier_openings: [],
    })
  ),
  {
    managed_root_scope: "payload_root",
    root_dacl: {
      dacl_protected: true,
      aces: [
        ...recoveryAces(ACL_FULL_CONTROL_RIGHTS),
        ...SANDBOX_PRINCIPALS.map((principal) =>
          allow(principal, READ_TRAVERSE_RIGHTS, "this_object_and_children")
        ),
      ],
    },
    tier_subtree_dacls: [],
    tier_openings: [],
  },
  {
    // No sandbox ACE at all. The real protected content is owned by the Security
    // Manager in the trusted layer, which the host-user and SYSTEM grants cover.
    managed_root_scope: "protected_root",
    root_dacl: {
      dacl_protected: true,
      aces: [...recoveryAces(ACL_FULL_CONTROL_RIGHTS)],
    },
    tier_subtree_dacls: [],
    tier_openings: [],
  },
  {
    // The broker's authorization and revocation records. The interactive user gets
    // read access only: these records are the evidence of what was granted, and a
    // user who can rewrite them can forge a revocation that never happened.
    managed_root_scope: "isolation_root",
    root_dacl: {
      dacl_protected: true,
      aces: [
        allow("host_user", READ_TRAVERSE_RIGHTS, "this_object_and_children"),
        allow("local_system", ACL_FULL_CONTROL_RIGHTS, "this_object_and_children"),
        allow("administrators", ACL_FULL_CONTROL_RIGHTS, "this_object_and_children"),
      ],
    },
    tier_subtree_dacls: [],
    tier_openings: [],
  },
];

/**
 * `%LOCALAPPDATA%\SuperClaw\backend` is `<profile>\AppData\Local\SuperClaw\backend`, so
 * these are the three folders Node lstat()s between the profile and the backend.
 */
const PROFILE_ANCESTOR_GRANTS: readonly AclProfileAncestorGrant[] = [
  "AppData",
  "AppData/Local",
  "AppData/Local/SuperClaw",
].map((path) => ({
  profile_relative_path: path,
  added_ace: allow("sandbox_tier_file_tool", rights("FILE_READ_ATTRIBUTES"), "this_object_only"),
}));

/**
 * The ACL policy this build intends to apply.
 *
 * Keyed by policy class and managed root scope. Adding a workspace root adds a
 * member to a plan; it does not add anything here.
 */
export const ACL_POLICY_DESCRIPTOR: AclPolicyDescriptor = {
  contract_version: ACL_POLICY_CONTRACT_VERSION,
  policy_version: ACL_POLICY_VERSION,
  workspace_root_policies: [...WORKSPACE_ROOT_POLICIES],
  managed_root_policies: [...MANAGED_ROOT_POLICIES],
  profile_ancestor_grants: [...PROFILE_ANCESTOR_GRANTS],
};

/** The policy for one class, or undefined if the class is not covered. */
export function workspaceRootAclPolicy(
  policyClass: WorkspaceRootPolicyClass,
  descriptor: AclPolicyDescriptor = ACL_POLICY_DESCRIPTOR
): WorkspaceRootAclPolicy | undefined {
  return descriptor.workspace_root_policies.find(
    (policy) => policy.policy_class === policyClass
  );
}

/** The policy for one managed root, or undefined if the scope is not covered. */
export function managedRootAclPolicy(
  scope: AclManagedRootScope,
  descriptor: AclPolicyDescriptor = ACL_POLICY_DESCRIPTOR
): ManagedRootAclPolicy | undefined {
  return descriptor.managed_root_policies.find(
    (policy) => policy.managed_root_scope === scope
  );
}
