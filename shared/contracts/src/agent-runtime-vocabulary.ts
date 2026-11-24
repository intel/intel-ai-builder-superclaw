/**
 * Agent runtime vocabulary: refusal reasons, runtime ids and the closed enums a
 * runtime descriptor is built from. Importable from browser code, no node: import.
 */
import { z } from "zod";

/**
 * Refusal reasons.
 */
export const AgentRuntimeRefusalReasonSchema = z.enum([
  "runtime_id_not_payload_backed",
  "member_list_empty",
  "duplicate_member_path",
  "member_path_not_posix_relative",
  "member_role_must_be_unique",
  "member_not_readable",
  "executable_role_not_marked_executable",
  "non_executable_role_marked_executable",
  "member_tier_inconsistent_with_role",
  "program_member_not_declared",
  "program_member_not_executable",
  "program_member_relaxable",
  "template_token_shape_invalid",
  "template_references_undeclared_member",
  "launch_group_empty",
  "launch_group_guard_member_undeclared",
  "launch_group_guard_member_unconditional",
  "launch_group_relaxable_member_unguarded",
  "env_name_shape_invalid",
  "env_name_secret_bearing",
  "readiness_probe_port_not_passed_to_launch",
  "config_projection_adapter_inconsistent_with_runtime_id",
  "config_projection_requires_config_source_member",
  "guard_adapter_requires_shell_member",
  "shutdown_grace_out_of_bounds",
  "descriptor_shape_invalid",
]);
export type AgentRuntimeRefusalReason = z.infer<
  typeof AgentRuntimeRefusalReasonSchema
>;

/**
 * The closed set of agent runtimes. Same values as the runtime-status wire enum.
 */
export const AgentRuntimeIdSchema = z.enum(["opencode", "mock"]);
export type AgentRuntimeId = z.infer<typeof AgentRuntimeIdSchema>;

/**
 * What a payload member is for. Roles drive the tier and executability rules.
 */
export const AgentRuntimeMemberRoleSchema = z.enum([
  "supervisor_executable",
  "token_service_executable",
  "runtime_executable",
  "connector_executable",
  "shell_executable",
  "sidecar_script",
  "config_source",
  "plugin_dependency_metadata",
  "agent_manifest",
]);
export type AgentRuntimeMemberRole = z.infer<
  typeof AgentRuntimeMemberRoleSchema
>;

/**
 * How strictly a member's presence is demanded. A required_when_verified member
 * may be absent only while the payload is unverified, and that is reported.
 */
export const AgentRuntimeMemberRequirementSchema = z.enum([
  "required",
  "required_when_verified",
]);
export type AgentRuntimeMemberRequirement = z.infer<
  typeof AgentRuntimeMemberRequirementSchema
>;

/**
 * Which isolation tier a member is expected to run in. Cross-checked against the
 * member role; this states an attribution and asserts nothing about enforcement.
 */
export const AgentRuntimeIsolationTierSchema = z.enum([
  "bootstrap",
  "file_tool",
  "network_connector",
  "channel",
]);
export type AgentRuntimeIsolationTier = z.infer<
  typeof AgentRuntimeIsolationTierSchema
>;

/**
 * Which capability-projection adapter the runtime's config is produced by.
 */
export const AgentRuntimeProjectionAdapterSchema = z.enum([
  "opencode_jsonc_extract",
  "none",
]);
export type AgentRuntimeProjectionAdapter = z.infer<
  typeof AgentRuntimeProjectionAdapterSchema
>;

/**
 * Which guard the runtime's file and shell tools are expected to run behind.
 */
export const AgentRuntimeGuardAdapterSchema = z.enum([
  "native_pinned_shell",
  "none",
]);
export type AgentRuntimeGuardAdapter = z.infer<
  typeof AgentRuntimeGuardAdapterSchema
>;

/**
 * Path-valued template placeholders. A token may append `/segment` parts.
 */
export const AgentRuntimePathPlaceholderSchema = z.enum([
  "payload_root",
  "workspace_root",
  "state_config_dir",
  "state_data_dir",
  "config_source_dir",
]);
export type AgentRuntimePathPlaceholder = z.infer<
  typeof AgentRuntimePathPlaceholderSchema
>;

/**
 * Scalar template placeholders. A token is the placeholder alone.
 */
export const AgentRuntimeScalarPlaceholderSchema = z.enum([
  "loopback_host",
  "supervisor_port",
  "runtime_port",
]);
export type AgentRuntimeScalarPlaceholder = z.infer<
  typeof AgentRuntimeScalarPlaceholderSchema
>;

export const AgentRuntimeReadinessProbeKindSchema = z.enum(["http_get"]);

export const AgentRuntimeShutdownKindSchema = z.enum(["process_tree_kill"]);

/**
 * Environment variables whose value is a secret. A descriptor ships in the repo,
 * so it may name none of these.
 */
export const SECRET_BEARING_ENV_NAMES: readonly string[] = [
  "OPENWORK_HOST_TOKEN",
  "LRM_API_KEY",
  "PRIVACY_API_KEY",
  "SUPERCLAW_HOST_TOKEN",
  "OPENCODE_SERVER_PASSWORD",
  "OPENWORK_OPENCODE_PASSWORD",
  "INTENT_CLASSIFIER_TOKEN",
];
