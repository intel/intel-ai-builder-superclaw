/**
 * Product wire between sandbox_manager and native_isolation_broker.
 *
 * Start requests carry catalog version and digest plus typed placeholder bindings
 * only. Apply requests carry an ACL plan; apply responses carry observations for
 * `check_acl_policy_drift`. A provision session is refused with one closed reason, and
 * the elevated command lines that open one are the closed shapes in
 * `BROKER_ELEVATED_OPERATIONS`.
 */
import { z } from "zod";

import {
  AclPolicyObservationSchema,
  AclPolicyPlanSchema,
} from "./acl-policy-plan.js";
import { AclOwnerSidSchema } from "./acl-policy-descriptor.js";
import { CONNECTOR_IPC_CONTRACT_VERSION } from "./connector-ipc.js";
import { Sha256Schema, SmOperationIdSchema } from "./capability/common.js";
import {
  canonicalizeLocalWindowsPath,
  LocalWindowsAbsolutePathSchema,
} from "./native-path-contract.js";
import {
  BROKER_SCALAR_RULES,
  BROKER_STARTUP_CATALOG,
  BROKER_STARTUP_CATALOG_DIGEST,
  BROKER_STARTUP_MANIFEST_VERSION,
  catalogEntryForRole,
} from "./native-isolation-broker-manifest.js";
import { AgentRuntimeIsolationTierSchema } from "./agent-runtime-vocabulary.js";
import {
  BROKER_ELEVATED_ARGUMENT_PATTERNS,
  BROKER_ELEVATED_OPERATIONS,
  BrokerAclApplyRefusalReasonSchema,
  BrokerElevatedArgumentSchema,
  BrokerElevatedOperationSchema,
  BrokerLaunchRoleSchema,
  BrokerPathPlaceholderSchema,
  BrokerProtocolRefusalReasonSchema,
  BrokerProvisionRefusalReasonSchema,
  BrokerScalarPlaceholderSchema,
  BrokerTierAccountNameSchema,
  BrokerTierLaunchRefusalReasonSchema,
  NativeIsolationBrokerContractVersionSchema,
  NATIVE_ISOLATION_BROKER_CONTRACT_VERSION,
} from "./native-isolation-broker-vocabulary.js";
import type {
  BrokerPathPlaceholder,
  BrokerProtocolRefusalReason,
  BrokerScalarPlaceholder,
} from "./native-isolation-broker-vocabulary.js";
import { IsolationInstantSchema } from "./isolation-reporting.js";
import {
  WORKSPACE_ROOT_SET_MAX_MEMBERS,
  WorkspaceRootIdSchema,
} from "./workspace-root-vocabulary.js";

export {
  BROKER_ELEVATED_ARGUMENT_PATTERNS,
  BROKER_ELEVATED_OPERATIONS,
  BrokerAclApplyRefusalReasonSchema,
  BrokerElevatedArgumentSchema,
  BrokerElevatedOperationSchema,
  BrokerLaunchRoleSchema,
  BrokerPathPlaceholderSchema,
  BrokerProtocolRefusalReasonSchema,
  BrokerProvisionRefusalReasonSchema,
  BrokerScalarPlaceholderSchema,
  BrokerTierAccountNameSchema,
  BrokerTierLaunchRefusalReasonSchema,
  NativeIsolationBrokerContractVersionSchema,
  NATIVE_ISOLATION_BROKER_CONTRACT_VERSION,
};

export const BrokerPathPlaceholderBindingSchema = z
  .object({
    placeholder: BrokerPathPlaceholderSchema,
    path: LocalWindowsAbsolutePathSchema,
  })
  .strict();
export type BrokerPathPlaceholderBinding = z.infer<typeof BrokerPathPlaceholderBindingSchema>;

export const BrokerScalarPlaceholderBindingSchema = z
  .object({
    placeholder: BrokerScalarPlaceholderSchema,
    value: z.union([z.string().min(1), z.number().int().nonnegative()]),
  })
  .strict();
export type BrokerScalarPlaceholderBinding = z.infer<typeof BrokerScalarPlaceholderBindingSchema>;

export const BrokerStartRequestSchema = z
  .object({
    contract_version: NativeIsolationBrokerContractVersionSchema,
    manifest_version: z.number().int().min(1),
    manifest_digest: Sha256Schema,
    launch_role: BrokerLaunchRoleSchema,
    workspace_root_id: WorkspaceRootIdSchema.nullable(),
    path_bindings: z.array(BrokerPathPlaceholderBindingSchema),
    scalar_bindings: z.array(BrokerScalarPlaceholderBindingSchema),
  })
  .strict();
export type BrokerStartRequest = z.infer<typeof BrokerStartRequestSchema>;

export const BrokerProtocolRefusalItemSchema = z
  .object({
    reason: BrokerProtocolRefusalReasonSchema,
    detail: z.string(),
  })
  .strict();

export const BrokerProtocolRefusalSchema = z
  .object({
    contract_version: NativeIsolationBrokerContractVersionSchema,
    refusals: z.array(BrokerProtocolRefusalItemSchema).min(1),
  })
  .strict();
export type BrokerProtocolRefusal = z.infer<typeof BrokerProtocolRefusalSchema>;

/**
 * One reason the unelevated launcher refused a tier launch, with what it observed and what to do.
 *
 * `remedy` is on the wire rather than only in the launcher's console text because the process that
 * receives this envelope is not always the one with a console: the Sandbox Manager reads the refusal
 * off a pipe and has to be able to show an operator the action without keeping its own table of
 * reasons, which would be a second place for the two to drift apart.
 */
export const BrokerTierLaunchRefusalItemSchema = z
  .object({
    reason: BrokerTierLaunchRefusalReasonSchema,
    detail: z.string(),
    remedy: z.string(),
  })
  .strict();
export type BrokerTierLaunchRefusalItem = z.infer<typeof BrokerTierLaunchRefusalItemSchema>;

/**
 * The single JSON line the owner-side launcher prints when it will not start a tier runner.
 *
 * Mirrors `TierLaunchRefusalReport` in `host/native_isolation_broker/src/launcher/refusal.rs`, which
 * is `deny_unknown_fields` on the Rust side and `.strict()` here, so neither end can add a field the
 * other silently drops. `event` is the discriminator that separates this line from the completion
 * report on the same stream, so it is pinned to one literal rather than left as a free string.
 *
 * Nothing in the envelope is derived from the credential. Tier, owner SID and account name are all
 * public naming inputs, and `detail` is built from a reason and an observation rather than from the
 * failing call's arguments; the launcher's password only ever exists inside a zeroizing container
 * that no formatter can reach.
 */
export const BrokerTierLaunchRefusalSchema = z
  .object({
    contract_version: NativeIsolationBrokerContractVersionSchema,
    event: z.literal("tier_launch_refused"),
    tier: AgentRuntimeIsolationTierSchema,
    owner_sid: AclOwnerSidSchema,
    account_name: BrokerTierAccountNameSchema,
    refusals: z.array(BrokerTierLaunchRefusalItemSchema).min(1),
  })
  .strict();
export type BrokerTierLaunchRefusal = z.infer<typeof BrokerTierLaunchRefusalSchema>;

/**
 * How the launcher established the runner's identity.
 *
 * The token SID it read through the process handle `CreateProcessWithLogonW` returned, never by
 * reopening the process id, checked against the tier SID it resolved from the derived account name.
 * The SID itself is `runner_sid` on the line; this part says how it was obtained.
 */
export const BrokerLaunchIdentityEvidenceSchema = z
  .object({
    source: z.literal("owner_kernel"),
    runner_token_read_through: z.literal("retained_process_handle"),
    tier_sid_resolved_by: z.literal("lookup_account_name_local_sam_user"),
  })
  .strict();

/** The runner token's mandatory label, by its RID. A RID not listed here is `other`. */
export const BrokerTokenIntegrityLevelSchema = z.enum([
  "untrusted",
  "low",
  "medium",
  "medium_plus",
  "high",
  "system",
  "protected_process",
  "other",
]);

/** Administrators (`S-1-5-32-544`) in the runner token's groups, by that group's attributes. */
export const BrokerTokenAdministratorsSchema = z.enum([
  "absent",
  "deny_only",
  "present_disabled",
  "present_enabled",
]);

/** `TokenElevationType` 1, 2 and 3. */
export const BrokerTokenElevationTypeSchema = z.enum(["default", "full", "limited"]);

export const BROKER_TOKEN_PRIVILEGE_PATTERN = /^Se[A-Za-z]+Privilege$/;
export const BROKER_TOKEN_FACT_LIMITS = { restricted_sids: 64, privileges: 64 } as const;

/**
 * What the runner's token holds, read by the launcher through the retained handle.
 *
 * Facts rather than a verdict: whether they make a hardened token is a rule the contract does not
 * publish yet, and until it does the report says `unknown`. Privileges are the ones present, enabled
 * or not, because the holder can enable a disabled one. The role's own token cannot be opened from
 * the owner's side; it is the runner's, because the runner starts the role with a same-account
 * `CreateProcessW` that takes no token.
 */
export const BrokerLaunchTokenFactsSchema = z
  .object({
    source: z.literal("owner_kernel"),
    integrity_level: BrokerTokenIntegrityLevelSchema,
    restricted_sid_count: z.number().int().min(0).max(BROKER_TOKEN_FACT_LIMITS.restricted_sids),
    administrators: BrokerTokenAdministratorsSchema,
    privileges: z
      .array(z.string().regex(BROKER_TOKEN_PRIVILEGE_PATTERN))
      .max(BROKER_TOKEN_FACT_LIMITS.privileges),
    elevation_type: BrokerTokenElevationTypeSchema,
    role_token: z.literal("same_as_runner_by_construction"),
  })
  .strict();

/** A managed root the readback checked, by its placeholder. A workspace root goes by `root_id`. */
export const BrokerReadbackManagedRootSchema = BrokerPathPlaceholderSchema.exclude(["workspace_root"]);

/**
 * The launcher's DACL readback before it started the role.
 *
 * Only a match is ever reported: a mismatch refuses the launch with `provision_required`, so there is
 * no started line to carry it. `descriptor_digest` is the shipped ACL descriptor's, the one the
 * launcher compared against, and the Sandbox Manager checks it is the one its ACL plan came from.
 * Roots are named by placeholder or `root_id`, never by path.
 */
export const BrokerLaunchAclReadbackEvidenceSchema = z
  .object({
    source: z.literal("owner_kernel"),
    verdict: z.literal("matches_descriptor"),
    descriptor_digest: Sha256Schema,
    roots_checked: z
      .array(z.union([BrokerReadbackManagedRootSchema, WorkspaceRootIdSchema]))
      .min(1)
      .max(BrokerReadbackManagedRootSchema.options.length + WORKSPACE_ROOT_SET_MAX_MEMBERS),
    checked_at: IsolationInstantSchema,
  })
  .strict();

/** The Job profile a tier's roles run under. The test-only sleep profile is not one of them. */
export const BrokerJobProfileSchema = z.enum([
  "bootstrap_tier",
  "file_tool_tier",
  "connector_tier",
  "channel_tier",
]);

/** The range a read-back Job limit has to fall in. */
export const BROKER_JOB_LIMIT_BOUNDS = {
  active_processes: { min: 1, max: 64 },
  process_memory_bytes: { min: 1, max: 8 * 1024 ** 3 },
  job_memory_bytes: { min: 1, max: 8 * 1024 ** 3 },
  cpu_rate: { min: 1, max: 10_000 },
  ui_restrictions: { min: 0, max: 255 },
} as const;

function jobLimitSchema(bounds: { readonly min: number; readonly max: number }) {
  return z.number().int().min(bounds.min).max(bounds.max);
}

export const BrokerJobLimitsSchema = z
  .object({
    active_processes: jobLimitSchema(BROKER_JOB_LIMIT_BOUNDS.active_processes),
    process_memory_bytes: jobLimitSchema(BROKER_JOB_LIMIT_BOUNDS.process_memory_bytes),
    job_memory_bytes: jobLimitSchema(BROKER_JOB_LIMIT_BOUNDS.job_memory_bytes),
    cpu_rate: jobLimitSchema(BROKER_JOB_LIMIT_BOUNDS.cpu_rate),
    ui_restrictions: jobLimitSchema(BROKER_JOB_LIMIT_BOUNDS.ui_restrictions),
  })
  .strict();

/**
 * The role's Job, as the tier's runner checked it before resuming the role.
 *
 * Membership by `IsProcessInJob`, and the limits read back with `QueryInformationJobObject` equal
 * to the profile's; a mismatch keeps the role suspended, so neither flag is ever false on a started
 * line. Reported from inside the tier, which is what `source` says.
 */
export const BrokerLaunchJobEvidenceSchema = z
  .object({
    source: z.literal("tier_reported"),
    profile: BrokerJobProfileSchema,
    membership_verified_before_resume: z.literal(true),
    limits_read_back_match: z.literal(true),
    active_processes_at_ready: z
      .number()
      .int()
      .min(0)
      .max(BROKER_JOB_LIMIT_BOUNDS.active_processes.max),
    limits: BrokerJobLimitsSchema,
  })
  .strict();

/** What a started line shows about its launch: all four parts, each saying where it came from. */
export const BrokerTierLaunchEvidenceSchema = z
  .object({
    identity: BrokerLaunchIdentityEvidenceSchema,
    token_facts: BrokerLaunchTokenFactsSchema,
    acl_readback: BrokerLaunchAclReadbackEvidenceSchema,
    job: BrokerLaunchJobEvidenceSchema,
  })
  .strict();
export type BrokerTierLaunchEvidence = z.infer<typeof BrokerTierLaunchEvidenceSchema>;

/**
 * The owner-side launcher has started one catalog role and now owns its lifecycle.
 *
 * `evidence` is optional until every launcher reports it. A line without it gives the Sandbox
 * Manager no launch evidence for that role, and its isolation report then establishes no level.
 */
export const BrokerTierLaunchStartedSchema = z
  .object({
    contract_version: NativeIsolationBrokerContractVersionSchema,
    event: z.literal("tier_launch_started"),
    launch_path: z.literal("tier_logon"),
    tier: AgentRuntimeIsolationTierSchema,
    owner_sid: AclOwnerSidSchema,
    runner_sid: AclOwnerSidSchema,
    launch_role: BrokerLaunchRoleSchema,
    runner_pid: z.number().int().positive(),
    role_pid: z.number().int().positive(),
    evidence: BrokerTierLaunchEvidenceSchema.optional(),
  })
  .strict();
export type BrokerTierLaunchStarted = z.infer<typeof BrokerTierLaunchStartedSchema>;

/** The tier runner's one report: the role it started. It holds no Job, so it says nothing about one. */
const BrokerTierRunnerStartedFrameSchema = z
  .object({
    op: z.literal("started"),
    tier: AgentRuntimeIsolationTierSchema,
    launch_role: BrokerLaunchRoleSchema,
    role_pid: z.number().int().positive(),
    role_environment_names: z.array(z.string()),
  })
  .strict();

/** The exit code the owner's `TerminateJobObject` stamps on every process in the role's Job. */
export const BROKER_JOB_EXIT_CODE = 0x5343_4a42;

/**
 * The role's Job as the owner-side launcher held it (#3010).
 *
 * The owner created the Job, assigned the suspended runner and verified membership before resuming
 * it, found the runner's reported role in the Job's own process list, and terminated the Job itself.
 * The tier never held a handle to it. Every count is the Job's own accounting, read by the owner.
 */
export const BrokerOwnerJobEvidenceSchema = z
  .object({
    source: z.literal("owner_kernel"),
    runner_membership_verified_before_resume: z.literal(true),
    role_membership_verified: z.literal(true),
    active_processes_at_ready: z
      .number()
      .int()
      .min(2)
      .max(BROKER_JOB_LIMIT_BOUNDS.active_processes.max),
    active_processes_before_cleanup: z
      .number()
      .int()
      .min(1)
      .max(BROKER_JOB_LIMIT_BOUNDS.active_processes.max),
    active_processes_after_cleanup: z.literal(0),
    cleanup_confirmed: z.literal(true),
    cleanup_elapsed_ms: z.number().int().nonnegative(),
  })
  .strict();
export type BrokerOwnerJobEvidence = z.infer<typeof BrokerOwnerJobEvidenceSchema>;

/**
 * The launcher has terminated the role's Job itself and confirmed it drained, after Stop or owner EOF.
 *
 * The runner is a Job member, so the owner's termination is what ends it: its exit code is the Job's.
 */
export const BrokerTierLaunchCompletedSchema = z
  .object({
    contract_version: NativeIsolationBrokerContractVersionSchema,
    event: z.literal("tier_launch_completed"),
    launch_path: z.literal("tier_logon"),
    tier: AgentRuntimeIsolationTierSchema,
    owner_sid: AclOwnerSidSchema,
    runner_sid: AclOwnerSidSchema,
    launch_role: BrokerLaunchRoleSchema,
    runner_pid: z.number().int().positive(),
    runner_exit_code: z.literal(BROKER_JOB_EXIT_CODE),
    evidence_source: z.literal("tier_runner_self_report"),
    runner_frames: z.array(BrokerTierRunnerStartedFrameSchema).length(1),
    owner_job: BrokerOwnerJobEvidenceSchema,
  })
  .strict();
export type BrokerTierLaunchCompleted = z.infer<typeof BrokerTierLaunchCompletedSchema>;

export const BrokerConnectorClientConfigSchema = z
  .object({
    // The Connector IPC version the endpoint speaks, which each client checks against its own.
    contract_version: z.literal(CONNECTOR_IPC_CONTRACT_VERSION),
    endpoint: z.string().regex(/^http:\/\/127\.0\.0\.1:\d{4,5}\/v1\/connector$/),
    boot_id: z.string().regex(/^boot-[0-9a-f]{32}$/),
    caller_key_id: z.string().regex(/^caller_[0-9a-f]{16}$/),
    caller_key_b64: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
    response_key_id: z.string().regex(/^response_[0-9a-f]{16}$/),
    response_key_b64: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
  })
  .strict();
export type BrokerConnectorClientConfig = z.infer<typeof BrokerConnectorClientConfigSchema>;

export const BrokerAclApplyWireRequestSchema = z
  .object({
    contract_version: NativeIsolationBrokerContractVersionSchema,
    operation_id: SmOperationIdSchema,
    owner_sid: AclOwnerSidSchema,
    plan: AclPolicyPlanSchema,
  })
  .strict();
export type BrokerAclApplyWireRequest = z.infer<typeof BrokerAclApplyWireRequestSchema>;

export const BrokerAclApplyWireResponseSchema = z
  .object({
    contract_version: NativeIsolationBrokerContractVersionSchema,
    operation_id: SmOperationIdSchema,
    observation: AclPolicyObservationSchema,
  })
  .strict();
export type BrokerAclApplyWireResponse = z.infer<typeof BrokerAclApplyWireResponseSchema>;

export const BrokerAclApplyRefusalItemSchema = z
  .object({
    reason: BrokerAclApplyRefusalReasonSchema,
    detail: z.string(),
  })
  .strict();

export const BrokerAclApplyRefusalSchema = z
  .object({
    contract_version: NativeIsolationBrokerContractVersionSchema,
    operation_id: SmOperationIdSchema,
    refusals: z.array(BrokerAclApplyRefusalItemSchema).min(1),
  })
  .strict();
export type BrokerAclApplyRefusal = z.infer<typeof BrokerAclApplyRefusalSchema>;

/**
 * The `refused` frame the elevated broker answers a provision session with.
 *
 * It travels inside the session's authenticated envelope, which this shape does not restate, and it
 * is the whole answer: a refused request is not a provisioned one, and the client records no marker
 * for it. Mirrors `ProvisionFrame::Refused` in
 * `host/native_isolation_broker/src/provision_session/wire.rs`, which is `deny_unknown_fields` there
 * and `.strict()` here, so no detail string can ride along.
 */
export const BrokerProvisionRefusalSchema = z
  .object({
    op: z.literal("refused"),
    reason: BrokerProvisionRefusalReasonSchema,
  })
  .strict();
export type BrokerProvisionRefusal = z.infer<typeof BrokerProvisionRefusalSchema>;

const FORBIDDEN_START_FIELD_REASON: Record<string, BrokerProtocolRefusalReason> = {
  executable: "forbidden_executable_path",
  executable_path: "forbidden_executable_path",
  program: "forbidden_executable_path",
  program_path: "forbidden_executable_path",
  command_line: "forbidden_command_line",
  commandline: "forbidden_command_line",
  argv: "forbidden_command_line",
  shell: "forbidden_shell",
  env: "forbidden_free_env",
  environment: "forbidden_free_env",
};

function refuseProtocol(
  reason: BrokerProtocolRefusalReason,
  detail: string
): BrokerProtocolRefusal {
  return BrokerProtocolRefusalSchema.parse({
    contract_version: NATIVE_ISOLATION_BROKER_CONTRACT_VERSION,
    refusals: [{ reason, detail }],
  });
}

/** Scan a parsed JSON value for caller-forbidden launch fields at any depth. */
export function forbiddenStartFieldRefusal(value: unknown): BrokerProtocolRefusal | undefined {
  if (Array.isArray(value)) {
    for (const member of value) {
      const nested = forbiddenStartFieldRefusal(member);
      if (nested !== undefined) return nested;
    }
    return undefined;
  }
  if (value === null || typeof value !== "object") return undefined;
  for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
    const reason = FORBIDDEN_START_FIELD_REASON[key];
    if (reason !== undefined) {
      return refuseProtocol(reason, `field ${JSON.stringify(key)} is not allowed on the broker wire`);
    }
    const nested = forbiddenStartFieldRefusal(member);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function scalarRangeIssue(
  placeholder: BrokerScalarPlaceholder,
  value: string | number
): string | undefined {
  if (BROKER_SCALAR_RULES.text_placeholders.includes(placeholder)) {
    if (typeof value !== "string" || value.length === 0) {
      return "must be a non-empty string";
    }
    if (BROKER_SCALAR_RULES.opaque_placeholders.includes(placeholder)) {
      if (
        value.length < BROKER_SCALAR_RULES.opaque_min_chars ||
        value.length > BROKER_SCALAR_RULES.opaque_max_chars ||
        !/^[A-Za-z0-9_-]+$/.test(value)
      ) {
        return "must be a bounded URL-safe opaque value";
      }
    }
    return undefined;
  }
  // Fail closed rather than fall through to the port check: a scalar in neither list is one the
  // rules have nothing to say about, and guessing which check it wanted is how an unchecked value
  // reaches a command line.
  if (!BROKER_SCALAR_RULES.port_placeholders.includes(placeholder)) {
    return "has no scalar rule in the shipped catalog";
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return "must be a non-negative integer port";
  }
  if (value < BROKER_SCALAR_RULES.port_min || value > BROKER_SCALAR_RULES.port_max) {
    return `port must be between ${BROKER_SCALAR_RULES.port_min} and ${BROKER_SCALAR_RULES.port_max}`;
  }
  return undefined;
}

/**
 * Validate a start request against the shipped catalog and path normalization rules.
 *
 * Returns a refusal when invalid; undefined when the request is accepted at the contract layer.
 */
export function refuseBrokerStartRequest(value: unknown): BrokerProtocolRefusal | undefined {
  const forbidden = forbiddenStartFieldRefusal(value);
  if (forbidden !== undefined) return forbidden;

  const parsed = BrokerStartRequestSchema.safeParse(value);
  if (!parsed.success) {
    return refuseProtocol("request_shape_invalid", "start request does not match the wire schema");
  }
  const request = parsed.data;
  if (request.contract_version !== NATIVE_ISOLATION_BROKER_CONTRACT_VERSION) {
    return refuseProtocol("unsupported_contract_version", "contract version is not supported");
  }
  if (request.manifest_version !== BROKER_STARTUP_MANIFEST_VERSION) {
    return refuseProtocol("manifest_version_unknown", "manifest version is not in the shipped catalog");
  }
  if (request.manifest_digest !== BROKER_STARTUP_CATALOG_DIGEST) {
    return refuseProtocol("manifest_digest_mismatch", "manifest digest does not match the catalog bytes");
  }

  const entry = catalogEntryForRole(request.launch_role);
  if (entry === undefined) {
    return refuseProtocol("launch_role_unknown", "launch role is not in the startup catalog");
  }

  const needsWorkspaceRoot = entry.path_placeholders.includes("workspace_root");
  if (needsWorkspaceRoot && request.workspace_root_id === null) {
    return refuseProtocol("workspace_root_id_required", "workspace_root placeholder requires workspace_root_id");
  }
  if (!needsWorkspaceRoot && request.workspace_root_id !== null) {
    return refuseProtocol("workspace_root_id_forbidden", "workspace_root_id is not used for this launch role");
  }

  const allowedPath = new Set(entry.path_placeholders);
  const allowedScalar = new Set(entry.scalar_placeholders);
  const seenPath = new Set<BrokerPathPlaceholder>();
  const seenScalar = new Set<BrokerScalarPlaceholder>();

  for (const binding of request.path_bindings) {
    if (!allowedPath.has(binding.placeholder)) {
      return refuseProtocol(
        "placeholder_not_declared",
        `path placeholder ${binding.placeholder} is not declared for ${request.launch_role}`
      );
    }
    if (seenPath.has(binding.placeholder)) {
      return refuseProtocol("placeholder_duplicate", `duplicate path placeholder ${binding.placeholder}`);
    }
    seenPath.add(binding.placeholder);
    try {
      canonicalizeLocalWindowsPath(binding.path);
    } catch {
      return refuseProtocol("path_not_canonical", `path for ${binding.placeholder} is not canonical`);
    }
  }

  for (const binding of request.scalar_bindings) {
    if (!allowedScalar.has(binding.placeholder)) {
      return refuseProtocol(
        "placeholder_not_declared",
        `scalar placeholder ${binding.placeholder} is not declared for ${request.launch_role}`
      );
    }
    if (seenScalar.has(binding.placeholder)) {
      return refuseProtocol("placeholder_duplicate", `duplicate scalar placeholder ${binding.placeholder}`);
    }
    seenScalar.add(binding.placeholder);
    const rangeIssue = scalarRangeIssue(binding.placeholder, binding.value);
    if (rangeIssue !== undefined) {
      return refuseProtocol("scalar_out_of_range", `${binding.placeholder}: ${rangeIssue}`);
    }
  }

  for (const placeholder of entry.path_placeholders) {
    if (!seenPath.has(placeholder)) {
      return refuseProtocol("placeholder_missing", `missing required path placeholder ${placeholder}`);
    }
  }
  for (const placeholder of entry.scalar_placeholders) {
    if (!seenScalar.has(placeholder)) {
      return refuseProtocol("placeholder_missing", `missing required scalar placeholder ${placeholder}`);
    }
  }

  return undefined;
}

/** Canonical JSON for golden fixture stability across languages. */
export function canonicalBrokerWireJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalBrokerWireJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalBrokerWireJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
