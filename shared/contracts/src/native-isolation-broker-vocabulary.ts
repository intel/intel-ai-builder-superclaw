/**
 * Vocabulary for the native isolation broker product wire.
 *
 * Browser-safe: no node imports. The broker resolves placeholders against a
 * validated native path set; nothing here touches Win32.
 */
import { z } from "zod";

import { ACL_OWNER_SID_PATTERN } from "./acl-policy-descriptor.js";
import { AgentRuntimeIsolationTierSchema } from "./agent-runtime-vocabulary.js";
import type { AgentRuntimeIsolationTier } from "./agent-runtime-vocabulary.js";

export const NativeIsolationBrokerContractVersionSchema = z.literal(1);
export const NATIVE_ISOLATION_BROKER_CONTRACT_VERSION = 1 as const;

/**
 * Launch roles the signed startup catalog may name.
 *
 * Executable member roles from the agent runtime descriptor, plus payload-hosted roles that name no
 * descriptor member: the broker-only test boundary role, `connector_service`, `egress_proxy`, and `hdr_sidecar`. A caller never supplies a
 * program path; it names a role.
 *
 * `connector_service` is the network Connector's own service process, which is payload-hosted rather
 * than a descriptor executable member, and is deliberately distinct from `connector_executable`
 * (`opencode-router.exe`). The service is the process that reads a bounded bootstrap on stdin, so it is
 * the one the broker has to be able to name.
 *
 * Two names here are historical and describe what their process was once expected to be rather than
 * what it is. `token_service_executable` is `openwork-server.exe`, which serves the whole product API
 * and not a token service; `connector_executable` is `opencode-router.exe`. They are kept because the
 * descriptor already binds each member to exactly one role, and inventing a second name for the same
 * binary would be the duplication this vocabulary exists to prevent. Renaming them is a wider change
 * than the one that gave them catalog entries, and it belongs on its own.
 */
export const BrokerLaunchRoleSchema = z.enum([
  "supervisor_executable",
  "token_service_executable",
  "runtime_executable",
  "connector_executable",
  "connector_service",
  "egress_proxy",
  "hdr_sidecar",
  "shell_executable",
  "test_fixed_sleep_child",
]);
export type BrokerLaunchRole = z.infer<typeof BrokerLaunchRoleSchema>;

// Mirrors `AGENT_RUNTIME_ROLE_TIER`, including its attributed-against-the-table entry and the router's
// move into the channel tier; see the rationale there.
export const BROKER_LAUNCH_ROLE_TIER: Record<BrokerLaunchRole, AgentRuntimeIsolationTier> = {
  supervisor_executable: "bootstrap",
  token_service_executable: "file_tool",
  runtime_executable: "file_tool",
  connector_executable: "channel",
  connector_service: "network_connector",
  egress_proxy: "network_connector",
  hdr_sidecar: "file_tool",
  shell_executable: "file_tool",
  test_fixed_sleep_child: "bootstrap",
};

/**
 * Path placeholders a start request may bind.
 *
 * Values must be canonical spellings from an already-validated native path set.
 */
export const BrokerPathPlaceholderSchema = z.enum([
  "payload_root",
  "workspace_root",
  "state_config_root",
  "state_data_root",
  "state_logs_root",
  "state_temp_root",
  "state_protected_root",
  "isolation_root",
]);
export type BrokerPathPlaceholder = z.infer<typeof BrokerPathPlaceholderSchema>;

/**
 * Scalar placeholders a start request may bind.
 *
 * Every name ending in `_port` is range-checked as a loopback port; `loopback_host` is bounded
 * non-empty text; `host_token` is an opaque secret checked for length alone, because a value only the
 * owner knows cannot be compared against anything else. There is no free-form scalar, so a role that
 * needs a new value needs a name here, and the classification of each name lives in
 * `BROKER_SCALAR_RULES` rather than being restated per validator.
 *
 * `payload_version` was removed when the supervisor entry stopped binding it: the version is already a
 * component of `payload_root`, so no entry will declare it again, and a name left in this enum is a name
 * a request can still bind. Keeping the vocabulary to what some entry consumes is what makes "every
 * declared scalar is consumed" a statement about the whole vocabulary rather than about three of its
 * five members.
 */
export const BrokerScalarPlaceholderSchema = z.enum([
  "loopback_host",
  // The port openwork-server listens on. The name predates openwork-server having a catalog entry of
  // its own, when the only process that bound this value was the supervisor passing it to a child it
  // spawned; it is now bound by both roles, which have to agree on it. Kept for the same reason the
  // role names above are kept, and equally worth renaming on its own.
  "supervisor_port",
  "runtime_port",
  "router_health_port",
  "connector_port",
  // The egress proxy's two listeners. The caller class is the port a connection arrived on, so the
  // shell's and the router's traffic are told apart by the operating system rather than by a credential.
  "egress_proxy_shell_port",
  "egress_proxy_channel_port",
  "hdr_port",
  // The loopback port LLMRouter Manager listens on. Bound rather than assumed because the runtime
  // role's configuration names the router as a URL, and a role that had to guess the port would be a
  // second place for it to be wrong - the Manager already knows which port it opened.
  // `egress-policy-vocabulary.ts` states the boundary side of the same fact: this endpoint is
  // `allowlistable` on the `host_data` plane, unlike the control-plane ports a tier may never reach.
  "llmrouter_port",
  "hdr_api_token",
  "hdr_ready_token",
  "hdr_enabled",
  "host_token",
  // Lowercase hex SHA-256 of `host_token`, for openwork-server, which only checks it. A file_tool start
  // request reaches that tier's runner whole, so the plaintext must never be bound there (#3498).
  "host_token_sha256",
  "openwork_token",
  // The bearer opencode-router requires on its control routes. Minted by the owner and bound to the
  // router only: it can write bindings and identities, so no tier that runs the agent holds it (EG2-7).
  "router_control_token",
  // The router's second bearer, for the file_tool tier: status reads and `POST /send`, where a send to
  // a conversation other than the current or a bound one waits for an approval (`router-approval.ts`).
  // Bound to the router, openwork-server and Runtime, so the agent's own send tool works.
  "router_scoped_token",
  // The LLMRouter Manager inference credential. ServiceHub owns it and hands it to the Sandbox
  // Manager; the runtime presents it on every `/v1/*` call, which the Manager refuses without it.
  "lrm_api_key",
  // Privacy Manager data-plane credential. ServiceHub owns it and the file-tool runtime presents
  // it only to the protected-file pipeline's authenticated host data plane.
  "privacy_api_key",
  // HTTP Basic password of the native OpenCode runtime. Sandbox Manager mints it per role-set start;
  // the runtime requires it, and the router, supervisor and openwork-server present it.
  "runtime_password",
  // Sandbox Manager mints it per role-set start; the classifier requires it, and the supervisor,
  // openwork-server and router present it.
  "intent_classifier_token",
  "runtime_deployment_b64",
  "runtime_desired_fingerprint",
  "runtime_instance_id",
  "runtime_launch_attempt_id",
  // Where a file_tool process sends its general egress: the egress proxy's loopback listener, as
  // `http://127.0.0.1:<port>`, and the bypass list that stays off it. Named for what they are to the
  // process that reads them. The corporate upstream proxy is not here: it never reaches a file_tool
  // process, only the egress proxy and the Connector, through their sealed configuration files.
  "local_proxy_url",
  "local_proxy_bypass",
]);
export type BrokerScalarPlaceholder = z.infer<typeof BrokerScalarPlaceholderSchema>;

/** Stable identity slot the broker provisions per owner and tier. */
export const BrokerIdentityIdSchema = z.string().regex(/^ibid:[a-z_]+$/);
export type BrokerIdentityId = z.infer<typeof BrokerIdentityIdSchema>;

/** Policy bundle the launch role must have converged before start. */
export const BrokerPolicyIdSchema = z.string().regex(/^acl:v[0-9]+$/);
export type BrokerPolicyId = z.infer<typeof BrokerPolicyIdSchema>;

/**
 * Reasons a start or catalog request is refused before any privileged work.
 *
 * Distinct from Win32 permission failures and from ACL apply coverage refusals.
 */
export const BrokerProtocolRefusalReasonSchema = z.enum([
  "forbidden_executable_path",
  "forbidden_command_line",
  "forbidden_shell",
  "forbidden_free_env",
  "unknown_field",
  "unsupported_contract_version",
  "manifest_version_unknown",
  "manifest_digest_mismatch",
  "launch_role_unknown",
  "placeholder_not_declared",
  "placeholder_missing",
  "placeholder_duplicate",
  "path_not_canonical",
  "path_placeholder_escape",
  "workspace_root_id_required",
  "workspace_root_id_forbidden",
  "scalar_out_of_range",
  "request_shape_invalid",
]);
export type BrokerProtocolRefusalReason = z.infer<typeof BrokerProtocolRefusalReasonSchema>;

/**
 * Reasons an ACL apply wire call is refused before drift comparison.
 *
 * `coverage_bound_exceeded` must stay distinct from `win32_permission_denied`.
 */
export const BrokerAclApplyRefusalReasonSchema = z.enum([
  "unsupported_contract_version",
  "operation_id_invalid",
  "plan_shape_invalid",
  "coverage_bound_exceeded",
  "win32_permission_denied",
  "apply_shape_invalid",
]);
export type BrokerAclApplyRefusalReason = z.infer<typeof BrokerAclApplyRefusalReasonSchema>;

/**
 * Reasons the unelevated launcher refuses to start a tier runner in a tier account.
 *
 * These are the failures of the first hop, which logs the tier account on with
 * `CreateProcessWithLogonW` rather than assigning a token. Each names an operator action, which is
 * why the set is this small: `provision_required` covers every way the account, the credential or
 * the credential's protection is not what elevated provisioning leaves behind, because
 * re-provisioning is the answer to all of them. The other three are the two environment
 * dependencies the two-hop design takes on - a running Secondary Logon service, and the tier
 * account's right to log on locally - plus `windows_api_failure`: a Win32 code with no established
 * meaning, or an unsupported host prerequisite its detail names, such as a launcher started outside
 * the interactive window station `WinSta0`.
 *
 * Deliberately disjoint from `BrokerProtocolRefusalReasonSchema`: a malformed start request is
 * refused before the launcher looks at an account at all, so a caller must never see a provisioning
 * remedy for a payload problem.
 */
export const BrokerTierLaunchRefusalReasonSchema = z.enum([
  "provision_required",
  "seclogon_unavailable",
  "local_logon_denied",
  "windows_api_failure",
]);
export type BrokerTierLaunchRefusalReason = z.infer<typeof BrokerTierLaunchRefusalReasonSchema>;

/**
 * Reasons the elevated broker declines a provision session, answered on the owner's pipe.
 *
 * `ProvisionRefusal` in `host/native_isolation_broker/src/provision_session/wire.rs` and
 * `REFUSAL_REASONS` in `host/sandbox_manager/src/sandbox_manager/broker_client/provision_wire.py`
 * must both mirror this list. A refusal is one word and no detail, because a privileged boundary has
 * no business handing free text to an unprivileged caller.
 *
 * `tier_identity_provision_failed` is answered only by `provision_identities_and_session`, when the
 * identity step failed and nothing was recorded or applied. It cannot reuse
 * `provision_precondition_missing`, which already says the state directory, the store or the tier
 * identities are absent, for two reasons. A client answers that word by forcing `provision` and
 * another session, which would be two more UAC prompts for the step that has just failed. And the
 * apply step raises that word itself, so reusing it would leave a receipt unable to say whether the
 * identity step or an apply precondition refused.
 */
export const BrokerProvisionRefusalReasonSchema = z.enum([
  "owner_binding_invalid",
  "path_set_shape_invalid",
  "plan_shape_invalid",
  "coverage_bound_exceeded",
  "reparse_point_in_path",
  "managed_path_refused",
  "descriptor_not_the_shipped_policy",
  "managed_root_not_authorized",
  "provision_precondition_missing",
  "win32_permission_denied",
  "tier_identity_provision_failed",
]);
export type BrokerProvisionRefusalReason = z.infer<typeof BrokerProvisionRefusalReasonSchema>;

/**
 * The closed operations the elevated broker executable accepts, one per elevated invocation.
 *
 * Each invocation performs exactly one of these and exits. `provision_identities_and_session` exists
 * so that a first start asks for one UAC prompt rather than two: it ensures the owner's tier
 * identities exactly as `provision` does and then serves one provision session exactly as
 * `provision_session` does, refusing before anything is recorded or applied if the identity step
 * fails. `--self-test` is not listed: it is a developer check, and no product caller reaches it.
 */
export const BrokerElevatedOperationSchema = z.enum([
  "provision",
  "provision_session",
  "provision_identities_and_session",
  "revoke",
  "revoke_workspace_authorization",
]);
export type BrokerElevatedOperation = z.infer<typeof BrokerElevatedOperationSchema>;

/** The value grammars an elevated command line may carry. None is a path, a plan, or free text. */
export const BrokerElevatedArgumentSchema = z.enum(["owner_sid", "pipe_id", "auth_key"]);
export type BrokerElevatedArgument = z.infer<typeof BrokerElevatedArgumentSchema>;

/**
 * The grammar the client emits for each argument. The owner SID is the spine's one SID grammar. The
 * auth key is the session's 32 random bytes in lowercase hex, and the pipe id names an object in the
 * pipe namespace, which is why neither admits a separator.
 *
 * The broker does not parse against these patterns. Its command-line parser is pinned to the
 * operations' flags and arity, and it re-validates each value itself: the owner SID by
 * canonicalization and the pipe server's token user, the pipe id by its pipe-name rule, and the
 * auth key by hex decoding. It accepts some spellings these patterns do not emit (uppercase hex, an
 * SDDL alias); an owner SID spelled that way is refused by the owner-bound pipe instead.
 */
export const BROKER_ELEVATED_ARGUMENT_PATTERNS: Record<BrokerElevatedArgument, string> = {
  owner_sid: ACL_OWNER_SID_PATTERN.source,
  pipe_id: "^[A-Za-z0-9_-]{1,64}$",
  auth_key: "^[0-9a-f]{64}$",
};

export interface BrokerElevatedOperationShape {
  readonly flag: string;
  readonly arguments: ReadonlyArray<{ readonly flag: string; readonly value: BrokerElevatedArgument }>;
}

/**
 * The exact command line of each operation: its flag, then every argument flag in this order, each
 * followed by one value. Fixed arity and fixed order, so a command line cannot be steered by adding
 * to it, only replaced, which is a different UAC prompt.
 */
export const BROKER_ELEVATED_OPERATIONS: Record<BrokerElevatedOperation, BrokerElevatedOperationShape> =
  {
    provision: {
      flag: "--provision",
      arguments: [{ flag: "--owner-sid", value: "owner_sid" }],
    },
    provision_session: {
      flag: "--provision-session",
      arguments: [
        { flag: "--owner-sid", value: "owner_sid" },
        { flag: "--pipe-id", value: "pipe_id" },
        { flag: "--auth-key", value: "auth_key" },
      ],
    },
    provision_identities_and_session: {
      flag: "--provision-identities-and-session",
      arguments: [
        { flag: "--owner-sid", value: "owner_sid" },
        { flag: "--pipe-id", value: "pipe_id" },
        { flag: "--auth-key", value: "auth_key" },
      ],
    },
    revoke: {
      flag: "--revoke",
      arguments: [{ flag: "--owner-sid", value: "owner_sid" }],
    },
    revoke_workspace_authorization: {
      flag: "--revoke-workspace-authorization",
      arguments: [{ flag: "--owner-sid", value: "owner_sid" }],
    },
  };

/**
 * Shape of the local account name the broker derives for one owner and tier.
 *
 * The name is `SCB`, a one-character tier code, and sixteen base32 characters of a digest over the
 * owner SID and the tier: twenty characters, which is the SAM limit. This is the shape only, not the
 * derivation - `host/native_isolation_broker/src/identity_name.rs` owns that, and a consumer that
 * needs the name reads it out of a broker report rather than computing it. Validating the shape is
 * still worth doing here, because it is what distinguishes a derived tier account from an operator
 * typing a name of their own into a field that must never accept one.
 */
export const BrokerTierAccountNameSchema = z.string().regex(/^SCB[BFCH][A-Z2-7]{16}$/);
export type BrokerTierAccountName = z.infer<typeof BrokerTierAccountNameSchema>;
