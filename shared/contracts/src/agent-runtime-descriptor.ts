/**
 * The agent runtime descriptor: runtime identity as versioned payload data.
 *
 * One source for the member roster, the launch argv and env templates, the
 * readiness probe, the shutdown protocol and the adapter selections, read by the
 * payload verifier, the packaging policy and the native launch path.
 * Declares expectations only, enforces nothing.
 */
import { z } from "zod";

import {
  AgentRuntimeGuardAdapterSchema,
  AgentRuntimeIdSchema,
  AgentRuntimeIsolationTierSchema,
  AgentRuntimeMemberRequirementSchema,
  AgentRuntimeMemberRoleSchema,
  AgentRuntimePathPlaceholderSchema,
  AgentRuntimeProjectionAdapterSchema,
  AgentRuntimeReadinessProbeKindSchema,
  AgentRuntimeRefusalReasonSchema,
  AgentRuntimeScalarPlaceholderSchema,
  AgentRuntimeShutdownKindSchema,
  SECRET_BEARING_ENV_NAMES,
} from "./agent-runtime-vocabulary.js";
import type {
  AgentRuntimeGuardAdapter,
  AgentRuntimeId,
  AgentRuntimeIsolationTier,
  AgentRuntimeMemberRequirement,
  AgentRuntimeMemberRole,
  AgentRuntimePathPlaceholder,
  AgentRuntimeProjectionAdapter,
  AgentRuntimeRefusalReason,
  AgentRuntimeScalarPlaceholder,
} from "./agent-runtime-vocabulary.js";

export {
  AgentRuntimeGuardAdapterSchema,
  AgentRuntimeIdSchema,
  AgentRuntimeIsolationTierSchema,
  AgentRuntimeMemberRequirementSchema,
  AgentRuntimeMemberRoleSchema,
  AgentRuntimePathPlaceholderSchema,
  AgentRuntimeProjectionAdapterSchema,
  AgentRuntimeRefusalReasonSchema,
  AgentRuntimeScalarPlaceholderSchema,
  SECRET_BEARING_ENV_NAMES,
};
export type {
  AgentRuntimeGuardAdapter,
  AgentRuntimeId,
  AgentRuntimeIsolationTier,
  AgentRuntimeMemberRequirement,
  AgentRuntimeMemberRole,
  AgentRuntimePathPlaceholder,
  AgentRuntimeProjectionAdapter,
  AgentRuntimeRefusalReason,
  AgentRuntimeScalarPlaceholder,
};

export const AgentRuntimeContractVersionSchema = z.literal(1);
export const AGENT_RUNTIME_CONTRACT_VERSION = 1 as const;

export const AGENT_RUNTIME_SHUTDOWN_GRACE_MIN_S = 1 as const;
export const AGENT_RUNTIME_SHUTDOWN_GRACE_MAX_S = 120 as const;

/** One portable path segment, as the payload manifest spells it. */
export const AGENT_RUNTIME_MEMBER_PATH_SEGMENT = /^[A-Za-z0-9@._+-]+$/;

/** Reject a spelling the payload manifest could not match byte-for-byte. */
function memberPathIssue(value: string): string | undefined {
  if (value.length === 0) return "must not be empty";
  if (value.includes("\\")) return "must use forward slashes";
  for (const segment of value.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      return "must have no empty or dot segments";
    }
    if (!AGENT_RUNTIME_MEMBER_PATH_SEGMENT.test(segment)) {
      return "segments must be portable file-name characters";
    }
  }
  return undefined;
}

/**
 * A payload-relative POSIX member path, as the payload manifest spells it.
 */
export const AgentRuntimeMemberPathSchema = z.string().superRefine((value, context) => {
  const issue = memberPathIssue(value);
  if (issue !== undefined) {
    context.addIssue({
      code: "custom",
      params: { reason: "member_path_not_posix_relative" },
      message: issue,
    });
  }
});

/**
 * Read and execute expectation for one member.
 */
export const AgentRuntimeMemberAccessSchema = z
  .object({
    read: z.boolean(),
    execute: z.boolean(),
  })
  .strict();

export const AgentRuntimeMemberSchema = z
  .object({
    path: AgentRuntimeMemberPathSchema,
    role: AgentRuntimeMemberRoleSchema,
    requirement: AgentRuntimeMemberRequirementSchema,
    isolation_tier: AgentRuntimeIsolationTierSchema,
    access: AgentRuntimeMemberAccessSchema,
  })
  .strict();
export type AgentRuntimeMember = z.infer<typeof AgentRuntimeMemberSchema>;

/** Roles that name exactly one member per descriptor. */
export const AGENT_RUNTIME_SINGLETON_ROLES: readonly AgentRuntimeMemberRole[] = [
  "supervisor_executable",
  "token_service_executable",
  "runtime_executable",
  "connector_executable",
  "config_source",
  "agent_manifest",
];

/** Roles whose member is executed rather than only read. */
export const AGENT_RUNTIME_EXECUTABLE_ROLES: readonly AgentRuntimeMemberRole[] = [
  "supervisor_executable",
  "token_service_executable",
  "runtime_executable",
  "connector_executable",
  "shell_executable",
];

/**
 * Tier attribution per role, from the isolation baseline table.
 *
 * One role is attributed against that table rather than from it: `token_service_executable` is
 * `openwork-server.exe`, which reads and writes real project content - skills, MCP configuration,
 * inbox and outbox, AgentLab state. The baseline table lists OpenWork under bootstrap with "no
 * persistent project access", which was never true of this process, and file_tool is the only tier
 * the shipped ACL descriptor gives a workspace grant to.
 *
 * `connector_executable` is `opencode-router.exe`, the Slack and Telegram bridge, and it runs in the
 * `channel` tier. It holds the channel tokens, so no tier that runs the agent may read its data, and
 * it reaches the workspace only through three openings the ACL descriptor declares: an inbox it
 * writes, an agent definition it reads from its own config directory, and an outbox it reads.
 * Its egress is the proxy's channel port, per SaaS host.
 */
export const AGENT_RUNTIME_ROLE_TIER: Record<
  AgentRuntimeMemberRole,
  AgentRuntimeIsolationTier
> = {
  supervisor_executable: "bootstrap",
  token_service_executable: "file_tool",
  runtime_executable: "file_tool",
  connector_executable: "channel",
  shell_executable: "file_tool",
  sidecar_script: "bootstrap",
  config_source: "bootstrap",
  plugin_dependency_metadata: "bootstrap",
  agent_manifest: "bootstrap",
};

export const AGENT_RUNTIME_TEMPLATE_TOKEN_PATTERN =
  /^\{\{([a-z_]+|member:[^{}]*)\}\}((?:\/[^{}]*)*)$/;

/**
 * A resolved template token, or a shape rejection.
 */
export type ParsedTemplateToken =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "scalar"; readonly placeholder: AgentRuntimeScalarPlaceholder }
  | {
      readonly kind: "path";
      readonly placeholder: AgentRuntimePathPlaceholder;
      readonly segments: readonly string[];
    }
  | { readonly kind: "member"; readonly memberPath: string };

/**
 * Parse one argv or env template token against the grammar, or undefined if it is
 * not one.
 */
export function parseTemplateToken(token: string): ParsedTemplateToken | undefined {
  if (!token.includes("{{") && !token.includes("}}")) {
    return token.length === 0 ? undefined : { kind: "literal", value: token };
  }
  const match = AGENT_RUNTIME_TEMPLATE_TOKEN_PATTERN.exec(token);
  if (match === null) return undefined;
  const [, head, tail] = match;
  const segments = tail === "" ? [] : tail.slice(1).split("/");

  if (head.startsWith("member:")) {
    if (segments.length > 0) return undefined;
    const memberPath = head.slice("member:".length);
    if (memberPathIssue(memberPath) !== undefined) return undefined;
    return { kind: "member", memberPath };
  }

  const scalar = AgentRuntimeScalarPlaceholderSchema.safeParse(head);
  if (scalar.success) {
    return segments.length > 0 ? undefined : { kind: "scalar", placeholder: scalar.data };
  }

  const pathPlaceholder = AgentRuntimePathPlaceholderSchema.safeParse(head);
  if (!pathPlaceholder.success) return undefined;
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") return undefined;
    if (!AGENT_RUNTIME_MEMBER_PATH_SEGMENT.test(segment)) return undefined;
  }
  return { kind: "path", placeholder: pathPlaceholder.data, segments };
}

/**
 * One argv fragment, kept or dropped as a whole depending on whether the member
 * named by `present_member` is there.
 */
export const AgentRuntimeArgvGroupSchema = z
  .object({
    tokens: z.array(z.string()),
    present_member: AgentRuntimeMemberPathSchema.nullable(),
  })
  .strict();
export type AgentRuntimeArgvGroup = z.infer<typeof AgentRuntimeArgvGroupSchema>;

/** One environment variable name an env template may declare. */
export const AGENT_RUNTIME_ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

export const AgentRuntimeLaunchSchema = z
  .object({
    /** The executable to run, named by its member path. */
    program_member: AgentRuntimeMemberPathSchema,
    argv_groups: z.array(AgentRuntimeArgvGroupSchema),
    /**
     * Runtime-identity environment. Host-capability probing stays with the
     * launcher; nothing here is discovered, everything is substituted.
     */
    env_template: z.record(z.string(), z.string()),
  })
  .strict();

export const AgentRuntimeReadinessProbeSchema = z
  .object({
    kind: AgentRuntimeReadinessProbeKindSchema,
    host_placeholder: AgentRuntimeScalarPlaceholderSchema,
    port_placeholder: AgentRuntimeScalarPlaceholderSchema,
    path: z.string().regex(/^\/[A-Za-z0-9/_-]*$/),
    timeout_seconds: z.number().positive(),
    poll_interval_seconds: z.number().positive(),
  })
  .strict();

export const AgentRuntimeShutdownSchema = z
  .object({
    kind: AgentRuntimeShutdownKindSchema,
    grace_seconds: z.number().positive(),
    /** Whether a kill-on-close job object backs the graceful path up. */
    job_object_backstop: z.boolean(),
  })
  .strict();

export const AgentRuntimeVersionPinSchema = z
  .object({
    /** The version is pinned by the payload build, not by this file. */
    source: z.enum(["payload_manifest"]),
    field: z.enum(["payload_version"]),
  })
  .strict();

export const AgentRuntimeAdaptersSchema = z
  .object({
    config_projection: AgentRuntimeProjectionAdapterSchema,
    guard: AgentRuntimeGuardAdapterSchema,
  })
  .strict();

/**
 * Machine-readable refusal. Reasons plus declared member paths, never a host path.
 */
export const AgentRuntimeRefusalItemSchema = z
  .object({
    reason: AgentRuntimeRefusalReasonSchema,
    member_path: z.string().nullable(),
  })
  .strict();

export const AgentRuntimeRefusalSchema = z
  .object({
    contract_version: AgentRuntimeContractVersionSchema,
    refusals: z.array(AgentRuntimeRefusalItemSchema).min(1),
  })
  .strict();
export type AgentRuntimeRefusal = z.infer<typeof AgentRuntimeRefusalSchema>;
export type AgentRuntimeRefusalItem = z.infer<typeof AgentRuntimeRefusalItemSchema>;

const agentRuntimeDescriptorShape = {
  contract_version: AgentRuntimeContractVersionSchema,
  runtime_id: AgentRuntimeIdSchema,
  runtime_version_pin: AgentRuntimeVersionPinSchema,
  members: z.array(AgentRuntimeMemberSchema),
  launch: AgentRuntimeLaunchSchema,
  readiness_probe: AgentRuntimeReadinessProbeSchema,
  shutdown: AgentRuntimeShutdownSchema,
  adapters: AgentRuntimeAdaptersSchema,
} as const;

interface RefinementSink {
  addIssue(issue: {
    code: "custom";
    path: (string | number)[];
    params: { reason: AgentRuntimeRefusalReason; member_path: string | null };
    message: string;
  }): void;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function safeMemberPath(value: unknown): string | null {
  return typeof value === "string" && memberPathIssue(value) === undefined ? value : null;
}

function refineAgentRuntimeDescriptor(value: unknown, context: RefinementSink): void {
  const raw = asRecord(value);
  const refuse = (
    reason: AgentRuntimeRefusalReason,
    path: (string | number)[],
    memberPath: string | null,
    message: string
  ): void => {
    context.addIssue({
      code: "custom",
      path,
      params: { reason, member_path: safeMemberPath(memberPath) },
      message,
    });
  };

  const members = (Array.isArray(raw.members) ? raw.members : []).map(asRecord);
  if (members.length === 0) {
    refuse("member_list_empty", ["members"], null, "a payload-backed runtime has members");
    return;
  }

  const byPath = new Map<string, Record<string, unknown>>();
  const roleCounts = new Map<string, number>();
  members.forEach((member, index) => {
    const path = typeof member.path === "string" ? member.path : "";
    const role = typeof member.role === "string" ? member.role : "";
    if (path !== "") {
      if (byPath.has(path)) {
        refuse("duplicate_member_path", ["members", index, "path"], path, "declared twice");
      }
      byPath.set(path, member);
    }
    roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1);

    const access = asRecord(member.access);
    if (access.read !== true) {
      refuse("member_not_readable", ["members", index, "access", "read"], path, "a member is read");
    }
    const shouldExecute = (AGENT_RUNTIME_EXECUTABLE_ROLES as readonly string[]).includes(role);
    if (shouldExecute && access.execute !== true) {
      refuse(
        "executable_role_not_marked_executable",
        ["members", index, "access", "execute"],
        path,
        `role ${role} is executed`
      );
    }
    if (!shouldExecute && access.execute === true) {
      refuse(
        "non_executable_role_marked_executable",
        ["members", index, "access", "execute"],
        path,
        `role ${role} is only read`
      );
    }
    const expectedTier = AGENT_RUNTIME_ROLE_TIER[role as AgentRuntimeMemberRole];
    if (expectedTier !== undefined && member.isolation_tier !== expectedTier) {
      refuse(
        "member_tier_inconsistent_with_role",
        ["members", index, "isolation_tier"],
        path,
        `role ${role} is attributed to ${expectedTier}`
      );
    }
  });

  for (const role of AGENT_RUNTIME_SINGLETON_ROLES) {
    if ((roleCounts.get(role) ?? 0) > 1) {
      refuse("member_role_must_be_unique", ["members"], null, `role ${role} names one member`);
    }
  }

  const isRelaxable = (path: string): boolean =>
    byPath.get(path)?.requirement === "required_when_verified";

  const launch = asRecord(raw.launch);
  const programMember = typeof launch.program_member === "string" ? launch.program_member : "";
  const program = byPath.get(programMember);
  if (program === undefined) {
    refuse(
      "program_member_not_declared",
      ["launch", "program_member"],
      programMember,
      "the program is a declared member"
    );
  } else {
    if (asRecord(program.access).execute !== true) {
      refuse(
        "program_member_not_executable",
        ["launch", "program_member"],
        programMember,
        "the program is executed"
      );
    }
    if (program.requirement !== "required") {
      refuse(
        "program_member_relaxable",
        ["launch", "program_member"],
        programMember,
        "the program can never be absent"
      );
    }
  }

  const usedScalars = new Set<string>();
  const argvGroups = (Array.isArray(launch.argv_groups) ? launch.argv_groups : []).map(asRecord);
  argvGroups.forEach((group, index) => {
    const tokens = Array.isArray(group.tokens) ? group.tokens : [];
    if (tokens.length === 0) {
      refuse("launch_group_empty", ["launch", "argv_groups", index, "tokens"], null, "no tokens");
    }
    const guard = typeof group.present_member === "string" ? group.present_member : null;
    if (guard !== null) {
      if (!byPath.has(guard)) {
        refuse(
          "launch_group_guard_member_undeclared",
          ["launch", "argv_groups", index, "present_member"],
          guard,
          "the guard names a declared member"
        );
      } else if (!isRelaxable(guard)) {
        refuse(
          "launch_group_guard_member_unconditional",
          ["launch", "argv_groups", index, "present_member"],
          guard,
          "a required member is always present, so the guard is dead"
        );
      }
    }
    tokens.forEach((token, tokenIndex) => {
      const tokenPath = ["launch", "argv_groups", index, "tokens", tokenIndex];
      const parsed = typeof token === "string" ? parseTemplateToken(token) : undefined;
      if (parsed === undefined) {
        refuse("template_token_shape_invalid", tokenPath, null, "not a template token");
        return;
      }
      if (parsed.kind === "scalar") {
        usedScalars.add(parsed.placeholder);
        return;
      }
      if (parsed.kind !== "member") return;
      if (!byPath.has(parsed.memberPath)) {
        refuse(
          "template_references_undeclared_member",
          tokenPath,
          parsed.memberPath,
          "the token names a declared member"
        );
        return;
      }
      if (isRelaxable(parsed.memberPath) && guard !== parsed.memberPath) {
        refuse(
          "launch_group_relaxable_member_unguarded",
          tokenPath,
          parsed.memberPath,
          "a member that may be absent needs the fragment guarded on it"
        );
      }
    });
  });

  const envTemplate = asRecord(launch.env_template);
  for (const [name, template] of Object.entries(envTemplate)) {
    if (!AGENT_RUNTIME_ENV_NAME_PATTERN.test(name)) {
      refuse(
        "env_name_shape_invalid",
        ["launch", "env_template", name],
        null,
        "must be an upper-snake environment variable name"
      );
    }
    if (SECRET_BEARING_ENV_NAMES.includes(name)) {
      refuse(
        "env_name_secret_bearing",
        ["launch", "env_template", name],
        null,
        `${name} carries a secret and is supplied at launch, not declared`
      );
    }
    const parsed = typeof template === "string" ? parseTemplateToken(template) : undefined;
    if (parsed === undefined) {
      refuse(
        "template_token_shape_invalid",
        ["launch", "env_template", name],
        null,
        "not a template token"
      );
      continue;
    }
    if (parsed.kind === "scalar") usedScalars.add(parsed.placeholder);
    if (parsed.kind === "member" && !byPath.has(parsed.memberPath)) {
      refuse(
        "template_references_undeclared_member",
        ["launch", "env_template", name],
        parsed.memberPath,
        "the token names a declared member"
      );
    }
  }

  // The port we probe must be a port we passed, else readiness watches a
  // listener the launch never asked for.
  const probe = asRecord(raw.readiness_probe);
  const probePort = probe.port_placeholder;
  if (typeof probePort === "string" && !usedScalars.has(probePort)) {
    refuse(
      "readiness_probe_port_not_passed_to_launch",
      ["readiness_probe", "port_placeholder"],
      null,
      `${probePort} appears in no argv or env token`
    );
  }

  const shutdown = asRecord(raw.shutdown);
  const grace = shutdown.grace_seconds;
  if (
    typeof grace === "number" &&
    (grace < AGENT_RUNTIME_SHUTDOWN_GRACE_MIN_S || grace > AGENT_RUNTIME_SHUTDOWN_GRACE_MAX_S)
  ) {
    refuse(
      "shutdown_grace_out_of_bounds",
      ["shutdown", "grace_seconds"],
      null,
      `grace_seconds is in [${AGENT_RUNTIME_SHUTDOWN_GRACE_MIN_S}, ${AGENT_RUNTIME_SHUTDOWN_GRACE_MAX_S}]`
    );
  }

  const adapters = asRecord(raw.adapters);
  const expectedProjection = raw.runtime_id === "opencode" ? "opencode_jsonc_extract" : "none";
  if (adapters.config_projection !== expectedProjection) {
    refuse(
      "config_projection_adapter_inconsistent_with_runtime_id",
      ["adapters", "config_projection"],
      null,
      `runtime ${String(raw.runtime_id)} projects through ${expectedProjection}`
    );
  }
  if (adapters.config_projection === "opencode_jsonc_extract" && (roleCounts.get("config_source") ?? 0) === 0) {
    refuse(
      "config_projection_requires_config_source_member",
      ["adapters", "config_projection"],
      null,
      "the extract adapter reads a config_source member"
    );
  }
  if (adapters.guard === "native_pinned_shell" && (roleCounts.get("shell_executable") ?? 0) === 0) {
    refuse(
      "guard_adapter_requires_shell_member",
      ["adapters", "guard"],
      null,
      "the pinned-shell guard needs a shell_executable member"
    );
  }
}

export const AgentRuntimeDescriptorSchema = z
  .object(agentRuntimeDescriptorShape)
  .strict()
  .superRefine(refineAgentRuntimeDescriptor);
export type AgentRuntimeDescriptor = z.infer<typeof AgentRuntimeDescriptorSchema>;

/**
 * Validate a descriptor and return the refusal, or undefined. A shape-fatal
 * failure reports only descriptor_shape_invalid.
 */
export function refuseAgentRuntimeDescriptor(value: unknown): AgentRuntimeRefusal | undefined {
  const result = AgentRuntimeDescriptorSchema.safeParse(value);
  if (result.success) {
    return undefined;
  }

  const rawMembers = asRecord(value).members;
  const declaredPathAt = (index: number): string | null =>
    Array.isArray(rawMembers) ? safeMemberPath(asRecord(rawMembers[index]).path) : null;

  const items = new Map<string, AgentRuntimeRefusalItem>();
  for (const issue of result.error.issues) {
    const params = (issue as { params?: { reason?: unknown; member_path?: unknown } }).params;
    if (typeof params?.reason !== "string") {
      continue;
    }
    const reason = params.reason as AgentRuntimeRefusalReason;
    const carried = safeMemberPath(params.member_path);
    const [head, index] = issue.path;
    const memberPath =
      carried ??
      (head === "members" && typeof index === "number" ? declaredPathAt(index) : null);
    items.set(JSON.stringify([reason, memberPath]), { reason, member_path: memberPath });
  }
  if (items.size === 0) {
    items.set(JSON.stringify(["descriptor_shape_invalid", null]), {
      reason: "descriptor_shape_invalid",
      member_path: null,
    });
  }

  return AgentRuntimeRefusalSchema.parse({
    contract_version: AGENT_RUNTIME_CONTRACT_VERSION,
    refusals: [...items.values()],
  });
}

const OPENCODE_DESCRIPTOR: AgentRuntimeDescriptor = {
  contract_version: AGENT_RUNTIME_CONTRACT_VERSION,
  runtime_id: "opencode",
  runtime_version_pin: { source: "payload_manifest", field: "payload_version" },
  members: [
    {
      path: "openwork.exe",
      role: "supervisor_executable",
      requirement: "required",
      isolation_tier: "bootstrap",
      access: { read: true, execute: true },
    },
    {
      path: "openwork-server.exe",
      role: "token_service_executable",
      requirement: "required",
      isolation_tier: "file_tool",
      access: { read: true, execute: true },
    },
    {
      path: "opencode.exe",
      role: "runtime_executable",
      requirement: "required",
      isolation_tier: "file_tool",
      access: { read: true, execute: true },
    },
    // The verified payload demands the router; only the unverified
    // source-development payload may lack it, and it says so when it does.
    {
      path: "opencode-router.exe",
      role: "connector_executable",
      requirement: "required_when_verified",
      isolation_tier: "channel",
      access: { read: true, execute: true },
    },
    {
      path: "shell/sh.exe",
      role: "shell_executable",
      requirement: "required_when_verified",
      isolation_tier: "file_tool",
      access: { read: true, execute: true },
    },
    {
      path: "shell/bash.exe",
      role: "shell_executable",
      requirement: "required_when_verified",
      isolation_tier: "file_tool",
      access: { read: true, execute: true },
    },
    {
      path: "intent-classifier/intent_classifier_server.py",
      role: "sidecar_script",
      requirement: "required_when_verified",
      isolation_tier: "bootstrap",
      access: { read: true, execute: false },
    },
    {
      path: "config-source/package.json",
      role: "config_source",
      requirement: "required",
      isolation_tier: "bootstrap",
      access: { read: true, execute: false },
    },
    {
      path: "config-source/node_modules/@opencode-ai/plugin/package.json",
      role: "plugin_dependency_metadata",
      requirement: "required",
      isolation_tier: "bootstrap",
      access: { read: true, execute: false },
    },
  ],
  launch: {
    program_member: "openwork.exe",
    argv_groups: [
      { tokens: ["serve"], present_member: null },
      { tokens: ["--workspace", "{{workspace_root}}"], present_member: null },
      { tokens: ["--opencode-directory", "{{workspace_root}}"], present_member: null },
      // Loopback by design (master plan §6.5).
      { tokens: ["--openwork-host", "{{loopback_host}}"], present_member: null },
      { tokens: ["--openwork-port", "{{supervisor_port}}"], present_member: null },
      { tokens: ["--opencode-host", "{{loopback_host}}"], present_member: null },
      { tokens: ["--opencode-port", "{{runtime_port}}"], present_member: null },
      { tokens: ["--connect-host", "{{loopback_host}}"], present_member: null },
      { tokens: ["--approval", "auto"], present_member: null },
      // Egress is open today. Declaring the flag as data does not change that.
      { tokens: ["--allow-external"], present_member: null },
      { tokens: ["--opencode-bin", "{{member:opencode.exe}}"], present_member: null },
      {
        tokens: ["--openwork-server-bin", "{{member:openwork-server.exe}}"],
        present_member: null,
      },
      {
        tokens: ["--opencode-router-bin", "{{member:opencode-router.exe}}"],
        present_member: "opencode-router.exe",
      },
    ],
    env_template: {
      OPENWORK_DEV_MODE: "0",
      OPENWORK_ALLOW_EXTERNAL: "1",
      OPENWORK_PORT: "{{supervisor_port}}",
      OPENCODE_CONFIG_DIR: "{{state_config_dir}}/opencode",
      SC_RUNTIME_CONFIG_DIR: "{{state_config_dir}}/opencode",
      OPENWORK_OPENCODE_CONFIG_SOURCE_DIR: "{{state_config_dir}}/opencode",
      OPENWORK_DATA_DIR: "{{state_data_dir}}/openwork-orchestrator",
      OPENWORK_TOKEN_STORE: "{{state_config_dir}}/openwork/tokens.json",
      LOGDIR: "{{state_data_dir}}/opencode/logs",
      OPENCODE_DIRECTORY: "{{workspace_root}}",
    },
  },
  readiness_probe: {
    kind: "http_get",
    host_placeholder: "loopback_host",
    port_placeholder: "supervisor_port",
    path: "/health",
    timeout_seconds: 60,
    poll_interval_seconds: 0.5,
  },
  shutdown: { kind: "process_tree_kill", grace_seconds: 5, job_object_backstop: true },
  adapters: { config_projection: "opencode_jsonc_extract", guard: "native_pinned_shell" },
};

/**
 * Descriptors for the payload-backed runtimes. `mock` launches nothing of its own,
 * so it has none, and a lookup for it is refused.
 */
export const AGENT_RUNTIME_DESCRIPTORS: Readonly<
  Partial<Record<AgentRuntimeId, AgentRuntimeDescriptor>>
> = {
  opencode: OPENCODE_DESCRIPTOR,
};
