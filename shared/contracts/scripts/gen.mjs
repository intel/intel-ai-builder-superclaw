#!/usr/bin/env node
/**
 * Codegen for wire schemas.
 *
 * Zod -> JSON Schema -> Pydantic. All outputs are committed.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { RuntimeStatusSchema } from "../src/runtime-status.ts";
import {
  CONNECTOR_IPC_CONTRACT_VERSION,
  CONNECTOR_IPC_RULES,
  ConnectorMessageSchema,
} from "../src/connector-ipc.ts";
import { ModelRoutingTablesSchema, MODEL_ROUTING } from "../src/model-routing.ts";
import { PerfWeightSchema, PerfWeightUpdateSchema } from "../src/perf-weight.ts";
import { LocalCtxSizeSchema, LocalCtxSizeUpdateSchema } from "../src/local-ctx-size.ts";
import {
  NATIVE_PATH_CONTRACT_VERSION,
  NativePathSetSchema,
  WORKSPACE_ROOT_SET_MAX_MEMBERS,
  WorkspaceRootRefusalSchema,
} from "../src/native-path-contract.ts";
import {
  AGENT_RUNTIME_CONTRACT_VERSION,
  AGENT_RUNTIME_DESCRIPTORS,
  AGENT_RUNTIME_ENV_NAME_PATTERN,
  AGENT_RUNTIME_EXECUTABLE_ROLES,
  AGENT_RUNTIME_MEMBER_PATH_SEGMENT,
  AGENT_RUNTIME_ROLE_TIER,
  AGENT_RUNTIME_SHUTDOWN_GRACE_MAX_S,
  AGENT_RUNTIME_SHUTDOWN_GRACE_MIN_S,
  AGENT_RUNTIME_SINGLETON_ROLES,
  AGENT_RUNTIME_TEMPLATE_TOKEN_PATTERN,
  AgentRuntimeDescriptorSchema,
  AgentRuntimePathPlaceholderSchema,
  AgentRuntimeRefusalSchema,
  AgentRuntimeScalarPlaceholderSchema,
  SECRET_BEARING_ENV_NAMES,
} from "../src/agent-runtime-descriptor.ts";
import {
  ACL_PLANNER_REFUSAL_REASONS,
  ACL_POLICY_CONTRACT_VERSION,
  ACL_POLICY_DESCRIPTOR,
  ACL_POLICY_VERSION,
  ACL_RECOVERY_MINIMUM_RIGHTS,
  ACL_RECOVERY_PRINCIPALS,
  ACL_WRITE_CONFERRING_RIGHTS,
  ACL_PRINCIPAL_TIER,
  ACL_OWNER_SID_PATTERN,
  AclPolicyDescriptorSchema,
  AclPolicyRefusalSchema,
  canonicalAclPolicyJson,
} from "../src/acl-policy-descriptor.ts";
import {
  AclPolicyDriftReportSchema,
  AclPolicyObservationSchema,
  AclPolicyPlanSchema,
} from "../src/acl-policy-plan.ts";
import {
  EGRESS_BOUNDARY_CLOSED_STATE,
  EGRESS_LOOPBACK_DISPOSITION_ALLOWS_REACH,
  EGRESS_PLANNER_REFUSAL_REASONS,
  EGRESS_POLICY_CONTRACT_VERSION,
  EGRESS_POLICY_DESCRIPTOR,
  EGRESS_POLICY_ENFORCING_REFERENCE,
  EGRESS_POLICY_VERSION,
  EGRESS_POLICY_VERSION_LABEL,
  EGRESS_PORT_MAX,
  EGRESS_PORT_MIN,
  EGRESS_PRIMARY_RULE_CLASSES,
  EGRESS_REQUIRED_PRECONDITIONS,
  EGRESS_SUPPLEMENTARY_FILTER_CLASSES,
  EGRESS_TIER_DISPOSITION_FOR_TIER,
  EGRESS_TIER_DISPOSITION_RULE_CLASSES,
  EgressIsolationTierSchema,
  EgressPermitClassSchema,
  EgressPlanIntentSchema,
  EgressPolicyDescriptorSchema,
  EgressPolicyRefusalSchema,
  canonicalEgressPolicyJson,
} from "../src/egress-policy-descriptor.ts";
import {
  EGRESS_OBJECT_KEY_PATTERN,
  EGRESS_OBJECT_KEY_PREFIX,
  EGRESS_UPSTREAM_PROXY_MAX_ADDITIONAL_PORTS,
  EGRESS_UPSTREAM_PROXY_MAX_ADDRESSES,
  EGRESS_WFP_FILTERS_BY_CLASS,
  EGRESS_WFP_FILTER_KEY_DOMAIN,
  EGRESS_WFP_WEIGHTS,
  EGRESS_WFP_LAYERS_BY_CLASS,
  EGRESS_WFP_LAYER_KEYS,
  EGRESS_WFP_OTHER_PROTOCOL_RANGES,
  EGRESS_WFP_PROVIDER_DATA_PREFIX,
  EGRESS_WFP_SUBLAYER_KEY,
  EGRESS_WFP_SUBLAYER_WEIGHT,
  EgressHostPolicyStateSchema,
  EgressPolicyPlanSchema,
} from "../src/egress-policy-plan.ts";
import {
  EGRESS_FIXED_PORT_CANDIDATES,
  EGRESS_HOST_SERVICE_PORT_CANDIDATES,
  EGRESS_LOOPBACK_PORT_CONTRACT_VERSION,
  EgressPortAllocationRefusalSchema,
} from "../src/egress-loopback-ports.ts";
import {
  EGRESS_LOOPBACK_DYNAMIC_PORT_RANGE_BOUNDS,
  EGRESS_LOOPBACK_DYNAMIC_PORT_RANGE_DEFAULT,
  EGRESS_LOOPBACK_DYNAMIC_RANGE_REFUSALS,
  egressLoopbackBlockedPorts,
} from "../src/egress-loopback-dynamic-range.ts";
import {
  CONNECTOR_ADMIN_ERRORS,
  ConnectorAdminErrorSchema,
  ConnectorAdminPendingListSchema,
  ConnectorApprovalProviderConfigSchema,
  EGRESS_APPROVAL_GRANT_CHAT_VECTOR,
  EGRESS_APPROVAL_GRANT_CONTRACT_VERSION,
  EGRESS_APPROVAL_GRANT_RULES,
  EGRESS_APPROVAL_GRANT_VECTOR,
  EGRESS_APPROVAL_SESSION_REF,
  EgressApprovalGrantSchema,
} from "../src/egress-approval-grant.ts";
import {
  ChannelBindingRequestSchema,
  ChannelBindingResultSchema,
  ChannelSendRequestSchema,
  ChannelSendResultSchema,
  SlackSenderDecisionRequestSchema,
  SlackSendersResultSchema,
} from "../src/sandbox-manager-channel-messaging.ts";
import {
  ROUTER_APPROVAL_RULES,
  ROUTER_APPROVAL_VECTOR,
  ROUTER_SCOPED_ERRORS,
  RouterAdminPendingListSchema,
  RouterApprovalGrantSchema,
} from "../src/router-approval.ts";
import {
  EGRESS_PROXY_APPROVAL_RULES,
  EGRESS_PROXY_APPROVAL_VECTOR,
  EgressProxyAdminPendingListSchema,
  EgressProxyApprovalGrantSchema,
} from "../src/egress-proxy-approval.ts";
import {
  EGRESS_APPROVALS_MAX_WAIT_MS,
  EGRESS_APPROVAL_TEXT_MAX_UTF16_UNITS,
  EGRESS_PENDING_APPROVALS_MAX,
  EgressApprovalDecisionRequestSchema,
  EgressApprovalDecisionResultSchema,
  EgressChatGrantRequestSchema,
  EgressChatGrantStatusSchema,
  EgressPendingApprovalListSchema,
  SANDBOX_MANAGER_HOST_API_ERRORS,
  SandboxManagerHostApiErrorSchema,
  TavilyApiKeySaveRequestSchema,
  TavilyApiKeyStatusSchema,
  TavilyApiKeyEnabledRequestSchema,
  ChannelEnabledRequestSchema,
  ChannelIdentityEnabledRequestSchema,
  ChannelEnabledResultSchema,
  ChannelIdentityResultSchema,
  SlackIdentitySaveRequestSchema,
  SLACK_APP_BOT_EVENTS,
  SLACK_APP_BOT_SCOPES,
  SlackInstallCompleteRequestSchema,
  SlackInstallCompleteResultSchema,
  SlackInstallStartRequestSchema,
  SlackInstallStartResultSchema,
  SlackInstallStatusSchema,
  TelegramIdentitySaveRequestSchema,
} from "../src/sandbox-manager-host-api.ts";
import {
  HOST_MCP_APPROVAL_VECTORS,
  HOST_MCP_BROWSER_AUTOMATION_VECTORS,
  HOST_MCP_CALL_REFUSAL_TEXT,
  HOST_MCP_ERRORS,
  HOST_MCP_RULES,
  HostBrowserConfigRequestSchema,
  HostBrowserViewSchema,
  HostMcpApprovalDecisionRequestSchema,
  HostMcpApprovalDecisionResultSchema,
  HostMcpCallRefusalSchema,
  HostMcpErrorSchema,
  HostMcpOkSchema,
  HostMcpPendingApprovalListSchema,
  HostMcpServerListSchema,
  HostMcpServerRegisterRequestSchema,
  HostMcpServerRegistrationSchema,
  HostMcpServerSchema,
  HostMcpStatusSchema,
  HostMcpStopAllResultSchema,
  HostMcpSummarySchema,
  HostMcpToolAnnotationsSchema,
} from "../src/host-mcp-api.ts";
import {
  EGRESS_ALLOWLIST,
  EGRESS_ALLOWLIST_CONTRACT_VERSION,
  EgressAllowlistSchema,
} from "../src/egress-allowlist.ts";
import { EgressProxyConfigSchema } from "../src/egress-proxy-config.ts";
import {
  EGRESS_SURFACE_COMMENT_MARKER,
  EGRESS_SURFACE_INVENTORY,
  EGRESS_SURFACE_INVENTORY_CONTRACT_VERSION,
  EgressSurfaceInventorySchema,
  egressSurfaceTier,
} from "../src/egress-surface-inventory.ts";
import {
  BROKER_LAUNCH_ROLE_TIER,
  BROKER_ROLE_LOG_RULES,
  BROKER_SCALAR_RULES,
  BROKER_STARTUP_CATALOG,
  BROKER_STARTUP_CATALOG_DIGEST,
  BROKER_STARTUP_MANIFEST_VERSION,
  BrokerStartupCatalogSchema,
} from "../src/native-isolation-broker-manifest.ts";
import {
  BrokerAclApplyRefusalSchema,
  BrokerAclApplyWireRequestSchema,
  BrokerAclApplyWireResponseSchema,
  BrokerConnectorClientConfigSchema,
  BrokerProtocolRefusalSchema,
  BrokerProvisionRefusalSchema,
  BrokerStartRequestSchema,
  BrokerTierLaunchCompletedSchema,
  BrokerTierLaunchRefusalSchema,
  BrokerTierLaunchStartedSchema,
} from "../src/native-isolation-broker-wire.ts";
import {
  ISOLATION_CROSS_FIELD_RULES_CONTINUE_AFTER,
  ISOLATION_DISCRIMINATED_UNION_FIELDS,
  ISOLATION_FIELD_LOCAL_REFUSAL_REASONS,
  ISOLATION_EGRESS_BOUNDARY_POSTURE,
  ISOLATION_EGRESS_ENFORCED_TIER_COVERAGE,
  ISOLATION_EGRESS_READBACK_FACTS,
  ISOLATION_EGRESS_VERSION_LABEL_PATTERN,
  ISOLATION_FAIL_CLOSED_REPORTS,
  ISOLATION_INSTALLED_RELEASE_LEVELS,
  ISOLATION_INSTANT_PATTERN,
  ISOLATION_LEVEL_FACTS,
  ISOLATION_PROBE_SET_ID_PATTERN,
  ISOLATION_TIERS_REQUIRING_LAUNCH_EVIDENCE,
  ISOLATION_REPORT_CONTRACT_VERSION,
  ISOLATION_REPORT_REFUSAL_REASONS,
  ISOLATION_SHAPE_ISSUE_KINDS,
  ISOLATION_SHAPE_ISSUE_REASONS,
  ISOLATION_TOKEN_SHAPE_FACTS,
  IsolationReportRefusalSchema,
  IsolationReportSchema,
} from "../src/isolation-reporting.ts";
import {
  SERVICEHUB_FORWARDED_CREDENTIAL_HEADER,
  SERVICEHUB_FORWARDED_CREDENTIAL_LABEL,
  SERVICEHUB_FORWARDED_CREDENTIAL_VECTOR,
} from "../src/servicehub-forwarding.ts";
import {
  FileProtectionModeStateSchema,
  FileProtectionModeUpdateSchema,
  HybridThresholdStateSchema,
  HybridThresholdUpdateSchema,
} from "../src/security.ts";
import {
  McpRuntimeReachabilitySchema,
  McpErrorBodySchema,
  McpOperationOutcomeSchema,
  McpServerAddRequestSchema,
  McpServerAuthRemoveResponseSchema,
  McpServerAuthStartResponseSchema,
  McpServerAuthCallbackRequestSchema,
  McpServerAuthCallbackResponseSchema,
  McpServerConfigSchema,
  McpServerListResponseSchema,
  McpServerMutationResponseSchema,
  McpServerSchema,
  McpServerStatusSchema,
  McpServerUpdateRequestSchema,
  McpToolListResponseSchema,
  McpToolPolicyResponseSchema,
  McpToolPolicyUpdateRequestSchema,
  McpToolSchema,
} from "../src/mcp.ts";
import { ConfigPatchRequestSchema } from "../src/config-patch.ts";
import {
  ACTIVATION_FALLBACK_MESSAGE,
  ActivationFailureCauseSchema,
  MODEL_BINDING_ACTIVATION_ERROR_COPY,
  ModelBindingActivationCancellationSchema,
  ModelBindingActivationActiveResponseSchema,
  ModelBindingActivationOperationSchema,
  ModelBindingActivationRequestSchema,
  RUNTIME_PROVISION_FAILURE_COPY,
  activationFailureCauseMessage,
} from "../src/capability/model-binding-activation.ts";
import {
  ModelBundleSchema,
  PendingBundleStateSchema,
  PrimaryBundleStateSchema,
} from "../src/capability/model-bundle.ts";
import {
  ModelBindingSchema,
  ModelBindingStateSchema,
  PreparedModelBindingSchema,
} from "../src/capability/model-binding.ts";
import {
  PrimaryBundleAbortRequestSchema,
  PrimaryBundleAbortResponseSchema,
  PrimaryBundleCapabilitySchema,
  PrimaryBundleCommitRequestSchema,
  PrimaryBundleCommitResponseSchema,
  PrimaryBundleLifecycleReadbackSchema,
  PrimaryBundlePrepareRequestSchema,
  PrimaryBundlePrepareResponseSchema,
  PrimaryBundleReleaseRequestSchema,
  PrimaryBundleReleaseResponseSchema,
} from "../src/capability/primary-bundle.ts";
import { AppCapabilityProfileSchema, ProfileSnapshotSchema } from "../src/capability/app-capability-profile.ts";
import { ProductProfileRuntimeStatusSchema } from "../src/capability/runtime-profile-control.ts";
import { ProductProfileDescriptorSchema } from "../src/capability/product-profile.ts";
import {
  RuntimeDeploymentSpecSchema,
  RuntimeGenerationPublishedSchema,
  RuntimeSupervisorReadySchema,
  RuntimeInstanceEvidenceSchema,
} from "../src/capability/runtime-deployment.ts";
import { AppReadinessSchema } from "../src/capability/app-readiness.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, "..");
const GEN = join(PKG, "generated");
const JSON_SCHEMA_DIR = join(GEN, "json-schema");
const DATA_DIR = join(GEN, "data");
const TS_DIR = join(GEN, "ts");
const PY_DIR = join(GEN, "python", "contracts");

const DMCG_SPEC = "datamodel-code-generator==0.66.0";
const PY_TARGET = "3.10";

const HEADER_TS = "// @generated by shared/contracts/scripts/gen.mjs - DO NOT EDIT.\n// Run `pnpm contracts:gen` to regenerate. Source: shared/contracts/src/*.ts\n";
const HEADER_PY = '"""@generated by shared/contracts/scripts/gen.mjs - DO NOT EDIT.\n\nRun `pnpm contracts:gen` to regenerate. Source: shared/contracts/src/*.ts.\n"""\n';

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, sortKeysReplacer(), 2) + "\n");
}
function sortKeysReplacer() {
  return (_key, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => a.localeCompare(b)))
      : val;
}

const DESCRIPTORS = [
  { name: "runtime-status", title: "RuntimeStatus", schema: RuntimeStatusSchema, py: "runtime_status.py", module: "runtime-status" },
  { name: "connector-ipc", title: "ConnectorMessage", schema: ConnectorMessageSchema, py: "connector_ipc.py", module: "connector-ipc" },
  { name: "mcp-server-config", title: "McpServerConfig", schema: McpServerConfigSchema, py: "mcp_server_config.py", module: "mcp" },
  { name: "mcp-server-status", title: "McpServerStatus", schema: McpServerStatusSchema, py: "mcp_server_status.py", module: "mcp" },
  { name: "mcp-server", title: "McpServer", schema: McpServerSchema, py: "mcp_server.py", module: "mcp" },
  { name: "mcp-operation-outcome", title: "McpOperationOutcome", schema: McpOperationOutcomeSchema, py: "mcp_operation_outcome.py", module: "mcp" },
  { name: "mcp-runtime-reachability", title: "McpRuntimeReachability", schema: McpRuntimeReachabilitySchema, py: "mcp_runtime_reachability.py", module: "mcp" },
  { name: "mcp-server-list-response", title: "McpServerListResponse", schema: McpServerListResponseSchema, py: "mcp_server_list_response.py", module: "mcp" },
  { name: "mcp-server-mutation-response", title: "McpServerMutationResponse", schema: McpServerMutationResponseSchema, py: "mcp_server_mutation_response.py", module: "mcp" },
  { name: "mcp-server-add-request", title: "McpServerAddRequest", schema: McpServerAddRequestSchema, py: "mcp_server_add_request.py", module: "mcp" },
  { name: "mcp-server-update-request", title: "McpServerUpdateRequest", schema: McpServerUpdateRequestSchema, py: "mcp_server_update_request.py", module: "mcp" },
  { name: "mcp-server-auth-remove-response", title: "McpServerAuthRemoveResponse", schema: McpServerAuthRemoveResponseSchema, py: "mcp_server_auth_remove_response.py", module: "mcp" },
  { name: "mcp-server-auth-start-response", title: "McpServerAuthStartResponse", schema: McpServerAuthStartResponseSchema, py: "mcp_server_auth_start_response.py", module: "mcp" },
  { name: "mcp-server-auth-callback-request", title: "McpServerAuthCallbackRequest", schema: McpServerAuthCallbackRequestSchema, py: "mcp_server_auth_callback_request.py", module: "mcp" },
  { name: "mcp-server-auth-callback-response", title: "McpServerAuthCallbackResponse", schema: McpServerAuthCallbackResponseSchema, py: "mcp_server_auth_callback_response.py", module: "mcp" },
  { name: "mcp-tool", title: "McpTool", schema: McpToolSchema, py: "mcp_tool.py", module: "mcp" },
  { name: "mcp-tool-list-response", title: "McpToolListResponse", schema: McpToolListResponseSchema, py: "mcp_tool_list_response.py", module: "mcp" },
  { name: "mcp-tool-policy-update-request", title: "McpToolPolicyUpdateRequest", schema: McpToolPolicyUpdateRequestSchema, py: "mcp_tool_policy_update_request.py", module: "mcp" },
  { name: "mcp-tool-policy-response", title: "McpToolPolicyResponse", schema: McpToolPolicyResponseSchema, py: "mcp_tool_policy_response.py", module: "mcp" },
  { name: "mcp-error-body", title: "McpErrorBody", schema: McpErrorBodySchema, py: "mcp_error_body.py", module: "mcp" },
  { name: "config-patch-request", title: "ConfigPatchRequest", schema: ConfigPatchRequestSchema, py: "config_patch_request.py", module: "config-patch" },
  { name: "model-routing", title: "ModelRoutingTables", schema: ModelRoutingTablesSchema, py: "model_routing.py", module: "model-routing" },
  { name: "perf-weight", title: "PerfWeight", schema: PerfWeightSchema, py: "perf_weight.py", module: "perf-weight" },
  { name: "perf-weight-update", title: "PerfWeightUpdate", schema: PerfWeightUpdateSchema, py: "perf_weight_update.py", module: "perf-weight" },
  { name: "local-ctx-size", title: "LocalCtxSize", schema: LocalCtxSizeSchema, py: "local_ctx_size.py", module: "local-ctx-size" },
  { name: "local-ctx-size-update", title: "LocalCtxSizeUpdate", schema: LocalCtxSizeUpdateSchema, py: "local_ctx_size_update.py", module: "local-ctx-size" },
  { name: "native-path-set", title: "NativePathSetShape", schema: NativePathSetSchema, py: "native_path_set.py", module: "native-path-contract" },
  { name: "workspace-root-refusal", title: "WorkspaceRootRefusal", schema: WorkspaceRootRefusalSchema, py: "workspace_root_refusal.py", module: "native-path-contract" },
  { name: "agent-runtime-descriptor", title: "AgentRuntimeDescriptor", schema: AgentRuntimeDescriptorSchema, py: "agent_runtime_descriptor.py", module: "agent-runtime-descriptor" },
  { name: "agent-runtime-refusal", title: "AgentRuntimeRefusal", schema: AgentRuntimeRefusalSchema, py: "agent_runtime_refusal.py", module: "agent-runtime-descriptor" },
  { name: "acl-policy-descriptor", title: "AclPolicyDescriptor", schema: AclPolicyDescriptorSchema, py: "acl_policy_descriptor.py", module: "acl-policy-descriptor" },
  { name: "acl-policy-refusal", title: "AclPolicyRefusal", schema: AclPolicyRefusalSchema, py: "acl_policy_refusal.py", module: "acl-policy-descriptor" },
  { name: "acl-policy-plan", title: "AclPolicyPlan", schema: AclPolicyPlanSchema, py: "acl_policy_plan.py", module: "acl-policy-plan" },
  { name: "acl-policy-observation", title: "AclPolicyObservation", schema: AclPolicyObservationSchema, py: "acl_policy_observation.py", module: "acl-policy-plan" },
  { name: "acl-policy-drift-report", title: "AclPolicyDriftReport", schema: AclPolicyDriftReportSchema, py: "acl_policy_drift_report.py", module: "acl-policy-plan" },
  { name: "egress-policy-descriptor", title: "EgressPolicyDescriptor", schema: EgressPolicyDescriptorSchema, py: "egress_policy_descriptor.py", module: "egress-policy-descriptor" },
  { name: "egress-policy-refusal", title: "EgressPolicyRefusal", schema: EgressPolicyRefusalSchema, py: "egress_policy_refusal.py", module: "egress-policy-descriptor" },
  { name: "egress-host-policy-state", title: "EgressHostPolicyState", schema: EgressHostPolicyStateSchema, py: "egress_host_policy_state.py", module: "egress-policy-plan" },
  { name: "isolation-report", title: "IsolationReportShape", schema: IsolationReportSchema, py: "isolation_report.py", module: "isolation-reporting" },
  { name: "isolation-report-refusal", title: "IsolationReportRefusal", schema: IsolationReportRefusalSchema, py: "isolation_report_refusal.py", module: "isolation-reporting" },
  { name: "egress-policy-plan", title: "EgressPolicyPlan", schema: EgressPolicyPlanSchema, py: "egress_policy_plan.py", module: "egress-policy-plan" },
  { name: "egress-port-allocation-refusal", title: "EgressPortAllocationRefusal", schema: EgressPortAllocationRefusalSchema, py: "egress_port_allocation_refusal.py", module: "egress-loopback-ports" },
  { name: "egress-pending-approval-list", title: "EgressPendingApprovalList", schema: EgressPendingApprovalListSchema, py: "egress_pending_approval_list.py", module: "sandbox-manager-host-api" },
  { name: "egress-approval-decision-request", title: "EgressApprovalDecisionRequest", schema: EgressApprovalDecisionRequestSchema, py: "egress_approval_decision_request.py", module: "sandbox-manager-host-api" },
  { name: "egress-approval-decision-result", title: "EgressApprovalDecisionResult", schema: EgressApprovalDecisionResultSchema, py: "egress_approval_decision_result.py", module: "sandbox-manager-host-api" },
  { name: "egress-chat-grant-request", title: "EgressChatGrantRequest", schema: EgressChatGrantRequestSchema, py: "egress_chat_grant_request.py", module: "sandbox-manager-host-api" },
  { name: "egress-chat-grant-status", title: "EgressChatGrantStatus", schema: EgressChatGrantStatusSchema, py: "egress_chat_grant_status.py", module: "sandbox-manager-host-api" },
  { name: "tavily-api-key-status", title: "TavilyApiKeyStatus", schema: TavilyApiKeyStatusSchema, py: "tavily_api_key_status.py", module: "sandbox-manager-host-api" },
  { name: "tavily-api-key-save-request", title: "TavilyApiKeySaveRequest", schema: TavilyApiKeySaveRequestSchema, py: "tavily_api_key_save_request.py", module: "sandbox-manager-host-api" },
  { name: "tavily-api-key-enabled-request", title: "TavilyApiKeyEnabledRequest", schema: TavilyApiKeyEnabledRequestSchema, py: "tavily_api_key_enabled_request.py", module: "sandbox-manager-host-api" },
  { name: "slack-identity-save-request", title: "SlackIdentitySaveRequest", schema: SlackIdentitySaveRequestSchema, py: "slack_identity_save_request.py", module: "sandbox-manager-host-api" },
  { name: "slack-install-start-request", title: "SlackInstallStartRequest", schema: SlackInstallStartRequestSchema, py: "slack_install_start_request.py", module: "sandbox-manager-host-api" },
  { name: "slack-install-start-result", title: "SlackInstallStartResult", schema: SlackInstallStartResultSchema, py: "slack_install_start_result.py", module: "sandbox-manager-host-api" },
  { name: "slack-install-status", title: "SlackInstallStatus", schema: SlackInstallStatusSchema, py: "slack_install_status.py", module: "sandbox-manager-host-api" },
  { name: "slack-install-complete-request", title: "SlackInstallCompleteRequest", schema: SlackInstallCompleteRequestSchema, py: "slack_install_complete_request.py", module: "sandbox-manager-host-api" },
  { name: "slack-install-complete-result", title: "SlackInstallCompleteResult", schema: SlackInstallCompleteResultSchema, py: "slack_install_complete_result.py", module: "sandbox-manager-host-api" },
  { name: "telegram-identity-save-request", title: "TelegramIdentitySaveRequest", schema: TelegramIdentitySaveRequestSchema, py: "telegram_identity_save_request.py", module: "sandbox-manager-host-api" },
  { name: "channel-enabled-request", title: "ChannelEnabledRequest", schema: ChannelEnabledRequestSchema, py: "channel_enabled_request.py", module: "sandbox-manager-host-api" },
  { name: "channel-identity-enabled-request", title: "ChannelIdentityEnabledRequest", schema: ChannelIdentityEnabledRequestSchema, py: "channel_identity_enabled_request.py", module: "sandbox-manager-host-api" },
  { name: "channel-identity-result", title: "ChannelIdentityResult", schema: ChannelIdentityResultSchema, py: "channel_identity_result.py", module: "sandbox-manager-host-api" },
  { name: "channel-send-request", title: "ChannelSendRequest", schema: ChannelSendRequestSchema, py: "channel_send_request.py", module: "sandbox-manager-channel-messaging" },
  { name: "channel-send-result", title: "ChannelSendResult", schema: ChannelSendResultSchema, py: "channel_send_result.py", module: "sandbox-manager-channel-messaging" },
  { name: "channel-binding-request", title: "ChannelBindingRequest", schema: ChannelBindingRequestSchema, py: "channel_binding_request.py", module: "sandbox-manager-channel-messaging" },
  { name: "channel-binding-result", title: "ChannelBindingResult", schema: ChannelBindingResultSchema, py: "channel_binding_result.py", module: "sandbox-manager-channel-messaging" },
  { name: "slack-sender-decision-request", title: "SlackSenderDecisionRequest", schema: SlackSenderDecisionRequestSchema, py: "slack_sender_decision_request.py", module: "sandbox-manager-channel-messaging" },
  { name: "slack-senders-result", title: "SlackSendersResult", schema: SlackSendersResultSchema, py: "slack_senders_result.py", module: "sandbox-manager-channel-messaging" },
  { name: "channel-enabled-result", title: "ChannelEnabledResult", schema: ChannelEnabledResultSchema, py: "channel_enabled_result.py", module: "sandbox-manager-host-api" },
  { name: "sandbox-manager-host-api-error", title: "SandboxManagerHostApiError", schema: SandboxManagerHostApiErrorSchema, py: "sandbox_manager_host_api_error.py", module: "sandbox-manager-host-api" },
  { name: "host-mcp-tool-annotations", title: "HostMcpToolAnnotations", schema: HostMcpToolAnnotationsSchema, py: "host_mcp_tool_annotations.py", module: "host-mcp-api" },
  { name: "host-mcp-server", title: "HostMcpServer", schema: HostMcpServerSchema, py: "host_mcp_server.py", module: "host-mcp-api" },
  { name: "host-mcp-server-list", title: "HostMcpServerList", schema: HostMcpServerListSchema, py: "host_mcp_server_list.py", module: "host-mcp-api" },
  { name: "host-mcp-server-register-request", title: "HostMcpServerRegisterRequest", schema: HostMcpServerRegisterRequestSchema, py: "host_mcp_server_register_request.py", module: "host-mcp-api" },
  { name: "host-mcp-server-registration", title: "HostMcpServerRegistration", schema: HostMcpServerRegistrationSchema, py: "host_mcp_server_registration.py", module: "host-mcp-api" },
  { name: "host-mcp-ok", title: "HostMcpOk", schema: HostMcpOkSchema, py: "host_mcp_ok.py", module: "host-mcp-api" },
  { name: "host-mcp-pending-approval-list", title: "HostMcpPendingApprovalList", schema: HostMcpPendingApprovalListSchema, py: "host_mcp_pending_approval_list.py", module: "host-mcp-api" },
  { name: "host-mcp-approval-decision-request", title: "HostMcpApprovalDecisionRequest", schema: HostMcpApprovalDecisionRequestSchema, py: "host_mcp_approval_decision_request.py", module: "host-mcp-api" },
  { name: "host-mcp-approval-decision-result", title: "HostMcpApprovalDecisionResult", schema: HostMcpApprovalDecisionResultSchema, py: "host_mcp_approval_decision_result.py", module: "host-mcp-api" },
  { name: "host-mcp-status", title: "HostMcpStatus", schema: HostMcpStatusSchema, py: "host_mcp_status.py", module: "host-mcp-api" },
  { name: "host-mcp-summary", title: "HostMcpSummary", schema: HostMcpSummarySchema, py: "host_mcp_summary.py", module: "host-mcp-api" },
  { name: "host-mcp-stop-all-result", title: "HostMcpStopAllResult", schema: HostMcpStopAllResultSchema, py: "host_mcp_stop_all_result.py", module: "host-mcp-api" },
  { name: "host-browser-config-request", title: "HostBrowserConfigRequest", schema: HostBrowserConfigRequestSchema, py: "host_browser_config_request.py", module: "host-mcp-api" },
  { name: "host-browser-view", title: "HostBrowserView", schema: HostBrowserViewSchema, py: "host_browser_view.py", module: "host-mcp-api" },
  { name: "host-mcp-call-refusal", title: "HostMcpCallRefusal", schema: HostMcpCallRefusalSchema, py: "host_mcp_call_refusal.py", module: "host-mcp-api" },
  { name: "host-mcp-error", title: "HostMcpError", schema: HostMcpErrorSchema, py: "host_mcp_error.py", module: "host-mcp-api" },
  { name: "egress-allowlist", title: "EgressAllowlist", schema: EgressAllowlistSchema, py: "egress_allowlist.py", module: "egress-allowlist" },
  { name: "egress-proxy-config", title: "EgressProxyConfig", schema: EgressProxyConfigSchema, py: "egress_proxy_config.py", module: "egress-proxy-config" },
  { name: "egress-approval-grant", title: "EgressApprovalGrant", schema: EgressApprovalGrantSchema, py: "egress_approval_grant.py", module: "egress-approval-grant" },
  { name: "connector-approval-provider-config", title: "ConnectorApprovalProviderConfig", schema: ConnectorApprovalProviderConfigSchema, py: "connector_approval_provider_config.py", module: "egress-approval-grant" },
  { name: "connector-admin-pending-list", title: "ConnectorAdminPendingList", schema: ConnectorAdminPendingListSchema, py: "connector_admin_pending_list.py", module: "egress-approval-grant" },
  { name: "router-approval-grant", title: "RouterApprovalGrant", schema: RouterApprovalGrantSchema, py: "router_approval_grant.py", module: "router-approval" },
  { name: "router-admin-pending-list", title: "RouterAdminPendingList", schema: RouterAdminPendingListSchema, py: "router_admin_pending_list.py", module: "router-approval" },
  { name: "egress-proxy-approval-grant", title: "EgressProxyApprovalGrant", schema: EgressProxyApprovalGrantSchema, py: "egress_proxy_approval_grant.py", module: "egress-proxy-approval" },
  { name: "egress-proxy-admin-pending-list", title: "EgressProxyAdminPendingList", schema: EgressProxyAdminPendingListSchema, py: "egress_proxy_admin_pending_list.py", module: "egress-proxy-approval" },
  { name: "connector-admin-error", title: "ConnectorAdminError", schema: ConnectorAdminErrorSchema, py: "connector_admin_error.py", module: "egress-approval-grant" },
  { name: "file-protection-mode-state", title: "FileProtectionModeState", schema: FileProtectionModeStateSchema, py: "file_protection_mode_state.py", module: "security" },
  { name: "file-protection-mode-update", title: "FileProtectionModeUpdate", schema: FileProtectionModeUpdateSchema, py: "file_protection_mode_update.py", module: "security" },
  { name: "hybrid-threshold-state", title: "HybridThresholdState", schema: HybridThresholdStateSchema, py: "hybrid_threshold_state.py", module: "security" },
  { name: "hybrid-threshold-update", title: "HybridThresholdUpdate", schema: HybridThresholdUpdateSchema, py: "hybrid_threshold_update.py", module: "security" },
  // v1.2 capability gating
  { name: "model-binding-activation-operation", title: "ModelBindingActivationOperation", schema: ModelBindingActivationOperationSchema, py: "model_binding_activation_operation.py", module: "capability/model-binding-activation" },
  { name: "model-binding-activation-request", title: "ModelBindingActivationRequest", schema: ModelBindingActivationRequestSchema, py: "model_binding_activation_request.py", module: "capability/model-binding-activation" },
  { name: "model-binding-activation-cancellation", title: "ModelBindingActivationCancellation", schema: ModelBindingActivationCancellationSchema, py: "model_binding_activation_cancellation.py", module: "capability/model-binding-activation" },
  { name: "model-binding-activation-active-response", title: "ModelBindingActivationActiveResponse", schema: ModelBindingActivationActiveResponseSchema, py: "model_binding_activation_active_response.py", module: "capability/model-binding-activation" },
  { name: "model-bundle", title: "ModelBundle", schema: ModelBundleSchema, py: "model_bundle.py", module: "capability/model-bundle" },
  { name: "primary-bundle-state", title: "PrimaryBundleState", schema: PrimaryBundleStateSchema, py: "primary_bundle_state.py", module: "capability/model-bundle" },
  { name: "pending-bundle-state", title: "PendingBundleState", schema: PendingBundleStateSchema, py: "pending_bundle_state.py", module: "capability/model-bundle" },
  { name: "model-binding", title: "ModelBinding", schema: ModelBindingSchema, py: "model_binding.py", module: "capability/model-binding" },
  { name: "model-binding-state", title: "ModelBindingState", schema: ModelBindingStateSchema, py: "model_binding_state.py", module: "capability/model-binding" },
  { name: "prepared-model-binding", title: "PreparedModelBinding", schema: PreparedModelBindingSchema, py: "prepared_model_binding.py", module: "capability/model-binding" },
  { name: "primary-bundle", title: "PrimaryBundleCapability", schema: PrimaryBundleCapabilitySchema, py: "primary_bundle.py", module: "capability/primary-bundle" },
  { name: "primary-bundle-prepare-request", title: "PrimaryBundlePrepareRequest", schema: PrimaryBundlePrepareRequestSchema, py: "primary_bundle_prepare_request.py", module: "capability/primary-bundle" },
  { name: "primary-bundle-prepare-response", title: "PrimaryBundlePrepareResponse", schema: PrimaryBundlePrepareResponseSchema, py: "primary_bundle_prepare_response.py", module: "capability/primary-bundle" },
  { name: "primary-bundle-commit-request", title: "PrimaryBundleCommitRequest", schema: PrimaryBundleCommitRequestSchema, py: "primary_bundle_commit_request.py", module: "capability/primary-bundle" },
  { name: "primary-bundle-commit-response", title: "PrimaryBundleCommitResponse", schema: PrimaryBundleCommitResponseSchema, py: "primary_bundle_commit_response.py", module: "capability/primary-bundle" },
  { name: "primary-bundle-abort-request", title: "PrimaryBundleAbortRequest", schema: PrimaryBundleAbortRequestSchema, py: "primary_bundle_abort_request.py", module: "capability/primary-bundle" },
  { name: "primary-bundle-abort-response", title: "PrimaryBundleAbortResponse", schema: PrimaryBundleAbortResponseSchema, py: "primary_bundle_abort_response.py", module: "capability/primary-bundle" },
  { name: "primary-bundle-lifecycle-readback", title: "PrimaryBundleLifecycleReadback", schema: PrimaryBundleLifecycleReadbackSchema, py: "primary_bundle_lifecycle_readback.py", module: "capability/primary-bundle" },
  { name: "primary-bundle-release-request", title: "PrimaryBundleReleaseRequest", schema: PrimaryBundleReleaseRequestSchema, py: "primary_bundle_release_request.py", module: "capability/primary-bundle" },
  { name: "primary-bundle-release-response", title: "PrimaryBundleReleaseResponse", schema: PrimaryBundleReleaseResponseSchema, py: "primary_bundle_release_response.py", module: "capability/primary-bundle" },
  { name: "app-capability-profile", title: "AppCapabilityProfile", schema: AppCapabilityProfileSchema, py: "app_capability_profile.py", module: "capability/app-capability-profile" },
  { name: "profile-snapshot", title: "ProfileSnapshot", schema: ProfileSnapshotSchema, py: "profile_snapshot.py", module: "capability/app-capability-profile" },
  { name: "product-profile-runtime-status", title: "ProductProfileRuntimeStatus", schema: ProductProfileRuntimeStatusSchema, py: "product_profile_runtime_status.py", module: "capability/runtime-profile-control" },
  { name: "product-profile-descriptor", title: "ProductProfileDescriptor", schema: ProductProfileDescriptorSchema, py: "product_profile_descriptor.py", module: "capability/product-profile" },
  { name: "runtime-deployment-spec", title: "RuntimeDeploymentSpec", schema: RuntimeDeploymentSpecSchema, py: "runtime_deployment_spec.py", module: "capability/runtime-deployment" },
  { name: "runtime-instance-evidence", title: "RuntimeInstanceEvidence", schema: RuntimeInstanceEvidenceSchema, py: "runtime_instance_evidence.py", module: "capability/runtime-deployment" },
  { name: "runtime-generation-published", title: "RuntimeGenerationPublished", schema: RuntimeGenerationPublishedSchema, py: "runtime_generation_published.py", module: "capability/runtime-deployment" },
  { name: "runtime-supervisor-ready", title: "RuntimeSupervisorReady", schema: RuntimeSupervisorReadySchema, py: "runtime_supervisor_ready.py", module: "capability/runtime-deployment" },
  { name: "app-readiness", title: "AppReadiness", schema: AppReadinessSchema, py: "app_readiness.py", module: "capability/app-readiness" },
  {
    name: "broker-startup-catalog",
    title: "BrokerStartupCatalog",
    schema: BrokerStartupCatalogSchema,
    py: "broker_startup_catalog.py",
    module: "native-isolation-broker-manifest",
  },
  {
    name: "broker-start-request",
    title: "BrokerStartRequest",
    schema: BrokerStartRequestSchema,
    py: "broker_start_request.py",
    module: "native-isolation-broker-wire",
  },
  {
    name: "broker-protocol-refusal",
    title: "BrokerProtocolRefusal",
    schema: BrokerProtocolRefusalSchema,
    py: "broker_protocol_refusal.py",
    module: "native-isolation-broker-wire",
  },
  {
    name: "broker-acl-apply-wire-request",
    title: "BrokerAclApplyWireRequest",
    schema: BrokerAclApplyWireRequestSchema,
    py: "broker_acl_apply_wire_request.py",
    module: "native-isolation-broker-wire",
  },
  {
    name: "broker-acl-apply-wire-response",
    title: "BrokerAclApplyWireResponse",
    schema: BrokerAclApplyWireResponseSchema,
    py: "broker_acl_apply_wire_response.py",
    module: "native-isolation-broker-wire",
  },
  {
    name: "broker-acl-apply-refusal",
    title: "BrokerAclApplyRefusal",
    schema: BrokerAclApplyRefusalSchema,
    py: "broker_acl_apply_refusal.py",
    module: "native-isolation-broker-wire",
  },
  { name: "broker-provision-refusal", title: "BrokerProvisionRefusal", schema: BrokerProvisionRefusalSchema, py: "broker_provision_refusal.py", module: "native-isolation-broker-wire" },
  {
    name: "broker-tier-launch-refusal",
    title: "BrokerTierLaunchRefusal",
    schema: BrokerTierLaunchRefusalSchema,
    py: "broker_tier_launch_refusal.py",
    module: "native-isolation-broker-wire",
  },
  {
    name: "broker-tier-launch-started",
    title: "BrokerTierLaunchStarted",
    schema: BrokerTierLaunchStartedSchema,
    py: "broker_tier_launch_started.py",
    module: "native-isolation-broker-wire",
  },
  {
    name: "broker-tier-launch-completed",
    title: "BrokerTierLaunchCompleted",
    schema: BrokerTierLaunchCompletedSchema,
    py: "broker_tier_launch_completed.py",
    module: "native-isolation-broker-wire",
  },
  {
    name: "broker-connector-client-config",
    title: "BrokerConnectorClientConfig",
    schema: BrokerConnectorClientConfigSchema,
    py: "broker_connector_client_config.py",
    module: "native-isolation-broker-wire",
  },
];

// Exported from the package root with no generated schema of its own; tests import the inventory there.
const EXPORT_ONLY_MODULES = ["capability/common", "egress-surface-inventory", "egress-loopback-dynamic-range"];

function assertNoCollisions() {
  const names = new Set();
  const pys = new Set();
  for (const d of DESCRIPTORS) {
    if (names.has(d.name)) throw new Error(`duplicate descriptor name: ${d.name}`);
    if (pys.has(d.py)) throw new Error(`duplicate python module: ${d.py}`);
    names.add(d.name);
    pys.add(d.py);
  }
}

function freshDir(path) {
  rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });
}

const SRC_DIR = join(PKG, "src");
const HEADER_TS_BARREL =
  "// @generated by shared/contracts/scripts/gen.mjs — DO NOT EDIT.\n// Run `pnpm contracts:gen` to regenerate. Barrel driven by the DESCRIPTORS registry.\n\n";

function emitExports() {
  const allModules = [...DESCRIPTORS.map((d) => d.module), ...EXPORT_ONLY_MODULES];
  const uniq = (xs) => [...new Set(xs)];
  const capModules = uniq(allModules.filter((m) => m.startsWith("capability/")));
  const rootModules = uniq(allModules.filter((m) => !m.startsWith("capability/")));

  const capBarrel =
    HEADER_TS_BARREL +
    capModules.map((m) => `export * from "./${m.slice("capability/".length)}.js";`).join("\n") +
    "\n";
  writeTextIfChanged(join(SRC_DIR, "capability", "index.ts"), capBarrel);

  const rootBarrel =
    HEADER_TS_BARREL +
    [...rootModules.map((m) => `export * from "./${m}.js";`), `export * from "./capability/index.js";`].join("\n") +
    "\n";
  writeTextIfChanged(join(SRC_DIR, "index.ts"), rootBarrel);
  console.log(`✓ exports: ${rootModules.length} root modules + ${capModules.length} capability modules`);
}

function writeTextIfChanged(path, content) {
  if (existsSync(path) && readFileSync(path, "utf8") === content) return;
  writeFileSync(path, content);
}

function emitJsonSchemas() {
  freshDir(JSON_SCHEMA_DIR);
  for (const { name, title, schema } of DESCRIPTORS) {
    const json = z.toJSONSchema(schema, { target: "draft-2020-12" });
    json.title = title;
    json.$id = `https://different.ai/openwork-contracts/${name}.schema.json`;
    writeJson(join(JSON_SCHEMA_DIR, `${name}.json`), json);
  }
  console.log(`✓ JSON Schema: ${DESCRIPTORS.length} schemas`);
}

function emitModelRoutingData() {
  freshDir(DATA_DIR);
  freshDir(TS_DIR);
  ModelRoutingTablesSchema.parse(MODEL_ROUTING);
  writeJson(join(DATA_DIR, "model-routing.json"), MODEL_ROUTING);

  const ts =
    HEADER_TS +
    "\nimport type { ModelRoutingTables } from \"../../src/model-routing.js\";\n\n" +
    "export const MODEL_ROUTING: ModelRoutingTables = " +
    JSON.stringify(MODEL_ROUTING, null, 2) +
    " as const;\n";
  writeFileSync(join(TS_DIR, "model-routing.gen.ts"), ts);
  console.log("✓ model-routing data: JSON + generated TS");
}

/**
 * The rule tables the TypeScript, Python, and PowerShell consumers share.
 */
const AGENT_RUNTIME_RULES = {
  role_tier: AGENT_RUNTIME_ROLE_TIER,
  singleton_roles: [...AGENT_RUNTIME_SINGLETON_ROLES],
  executable_roles: [...AGENT_RUNTIME_EXECUTABLE_ROLES],
  secret_bearing_env_names: [...SECRET_BEARING_ENV_NAMES],
  path_placeholders: [...AgentRuntimePathPlaceholderSchema.options],
  scalar_placeholders: [...AgentRuntimeScalarPlaceholderSchema.options],
  member_path_segment_pattern: AGENT_RUNTIME_MEMBER_PATH_SEGMENT.source,
  env_name_pattern: AGENT_RUNTIME_ENV_NAME_PATTERN.source,
  template_token_pattern: AGENT_RUNTIME_TEMPLATE_TOKEN_PATTERN.source,
  shutdown_grace_min_s: AGENT_RUNTIME_SHUTDOWN_GRACE_MIN_S,
  shutdown_grace_max_s: AGENT_RUNTIME_SHUTDOWN_GRACE_MAX_S,
};

/** Runs after emitModelRoutingData, which freshens DATA_DIR and TS_DIR. */
function emitAgentRuntimeData() {
  for (const descriptor of Object.values(AGENT_RUNTIME_DESCRIPTORS)) {
    AgentRuntimeDescriptorSchema.parse(descriptor);
  }
  writeJson(join(DATA_DIR, "agent-runtime-descriptors.json"), {
    contract_version: AGENT_RUNTIME_CONTRACT_VERSION,
    descriptors: AGENT_RUNTIME_DESCRIPTORS,
    rules: AGENT_RUNTIME_RULES,
  });

  const ts =
    HEADER_TS +
    "\nimport type { AgentRuntimeDescriptor } from \"../../src/agent-runtime-descriptor.js\";\n\n" +
    "export const AGENT_RUNTIME_DESCRIPTORS: Readonly<Record<string, AgentRuntimeDescriptor>> = " +
    JSON.stringify(AGENT_RUNTIME_DESCRIPTORS, null, 2) +
    " as const;\n";
  writeFileSync(join(TS_DIR, "agent-runtime-descriptors.gen.ts"), ts);
  console.log(
    `✓ agent-runtime data: JSON + generated TS (${Object.keys(AGENT_RUNTIME_DESCRIPTORS).length} runtime)`
  );
}

/**
 * The rule tables the ACL policy planner and the drift checker share.
 *
 * These are the parts a JSON Schema cannot say: which principals must keep
 * recovery access, what each principal stands for, and which rights count as
 * write-conferring. The planner is Python and the applier will be Rust, so they
 * are emitted as data rather than restated in each language.
 *
 * `descriptor_digest` is the load-bearing one. The descriptor's ~30 cross-field
 * rules live in a Zod `superRefine`, which has no JSON Schema form, so the generated
 * Pydantic model checks field shapes and nothing else. Restating those rules in
 * Python would be two spellings of one policy, drifting apart on whichever side was
 * edited second. Instead the rules are checked here, at generation time, against the
 * one descriptor this build ships, and the digest of that artifact is published: a
 * runtime that is handed some other descriptor refuses it rather than planning from
 * a policy nobody ran the rules over.
 */
const ACL_POLICY_RULES = {
  recovery_principals: [...ACL_RECOVERY_PRINCIPALS],
  recovery_minimum_rights: [...ACL_RECOVERY_MINIMUM_RIGHTS],
  write_conferring_rights: [...ACL_WRITE_CONFERRING_RIGHTS],
  principal_tier: ACL_PRINCIPAL_TIER,
  planner_refusal_reasons: [...ACL_PLANNER_REFUSAL_REASONS],
  owner_sid_pattern: ACL_OWNER_SID_PATTERN.source,
  descriptor_digest: createHash("sha256")
    .update(canonicalAclPolicyJson(ACL_POLICY_DESCRIPTOR))
    .digest("hex"),
};

/** Runs after emitModelRoutingData, which freshens DATA_DIR. */
function emitAclPolicyData() {
  AclPolicyDescriptorSchema.parse(ACL_POLICY_DESCRIPTOR);
  writeJson(join(DATA_DIR, "acl-policy-descriptor.json"), {
    contract_version: ACL_POLICY_CONTRACT_VERSION,
    descriptor: ACL_POLICY_DESCRIPTOR,
    rules: ACL_POLICY_RULES,
  });
  console.log(
    `✓ acl-policy data: JSON (${ACL_POLICY_DESCRIPTOR.workspace_root_policies.length} policy classes, ` +
      `${ACL_POLICY_DESCRIPTOR.managed_root_policies.length} managed roots, policy version ${ACL_POLICY_VERSION})`
  );
}

/**
 * The rule tables the egress policy planner shares with whatever applies a plan.
 *
 * Same shape and same reasoning as `ACL_POLICY_RULES`, including the load-bearing
 * `descriptor_digest`: this descriptor's cross-field rules are a Zod `superRefine` with
 * no JSON Schema form, they are checked here against the one descriptor this build
 * ships, and the digest is what lets the Python planner refuse anything else instead of
 * respelling thirty rules in a second language.
 *
 * `port_min` and `port_max` are here because the planner materializes the loopback
 * complement, and a bound it had to restate is a bound that could disagree.
 *
 * `enforcing_reference_digest` is the second artifact this build validated. It is not a
 * policy: `descriptor_digest` above is what the public planner checks, planning from the
 * reference takes an explicit opt-in no production call site passes, and it exists
 * because a planner whose whole boundary path went unexercised until the release that
 * turned enforcement on would be a planner nobody had run.
 *
 * `isolation_tiers`, `plan_intents` and `boundary_closed_state` are here so the Python
 * side reads them instead of restating them. The last one decides whether egress is
 * closed, which is not a string to have two copies of.
 *
 * The `wfp_*` entries are what turns a planned object into filters: the layer GUIDs, the
 * layers and matches each class is written with, the sublayer, and the two strings filter
 * keys and tags are derived under. The planner and the unelevated readback are Python and
 * the applier is Rust, and all three have to derive the same keys.
 */
const EGRESS_POLICY_RULES = {
  isolation_tiers: [...EgressIsolationTierSchema.options],
  plan_intents: [...EgressPlanIntentSchema.options],
  boundary_closed_state: EGRESS_BOUNDARY_CLOSED_STATE,
  primary_rule_classes: [...EGRESS_PRIMARY_RULE_CLASSES],
  supplementary_filter_classes: [...EGRESS_SUPPLEMENTARY_FILTER_CLASSES],
  permit_classes: [...EgressPermitClassSchema.options],
  tier_disposition_for_tier: EGRESS_TIER_DISPOSITION_FOR_TIER,
  tier_disposition_rule_classes: EGRESS_TIER_DISPOSITION_RULE_CLASSES,
  upstream_proxy_max_addresses: EGRESS_UPSTREAM_PROXY_MAX_ADDRESSES,
  upstream_proxy_max_additional_ports: EGRESS_UPSTREAM_PROXY_MAX_ADDITIONAL_PORTS,
  required_preconditions: [...EGRESS_REQUIRED_PRECONDITIONS],
  loopback_disposition_allows_reach: EGRESS_LOOPBACK_DISPOSITION_ALLOWS_REACH,
  wfp_layer_keys: EGRESS_WFP_LAYER_KEYS,
  wfp_layers_by_class: EGRESS_WFP_LAYERS_BY_CLASS,
  wfp_filters_by_class: EGRESS_WFP_FILTERS_BY_CLASS,
  wfp_weights: EGRESS_WFP_WEIGHTS,
  wfp_other_protocol_ranges: EGRESS_WFP_OTHER_PROTOCOL_RANGES,
  wfp_sublayer_key: EGRESS_WFP_SUBLAYER_KEY,
  wfp_sublayer_weight: EGRESS_WFP_SUBLAYER_WEIGHT,
  wfp_filter_key_domain: EGRESS_WFP_FILTER_KEY_DOMAIN,
  wfp_provider_data_prefix: EGRESS_WFP_PROVIDER_DATA_PREFIX,
  planner_refusal_reasons: [...EGRESS_PLANNER_REFUSAL_REASONS],
  owner_sid_pattern: ACL_OWNER_SID_PATTERN.source,
  object_key_prefix: EGRESS_OBJECT_KEY_PREFIX,
  object_key_pattern: EGRESS_OBJECT_KEY_PATTERN.source,
  loopback_dynamic_port_range_default: EGRESS_LOOPBACK_DYNAMIC_PORT_RANGE_DEFAULT,
  loopback_dynamic_port_range_bounds: EGRESS_LOOPBACK_DYNAMIC_PORT_RANGE_BOUNDS,
  loopback_dynamic_range_refusals: [...EGRESS_LOOPBACK_DYNAMIC_RANGE_REFUSALS],
  loopback_dynamic_range_blocked_ports: [...new Set(egressLoopbackBlockedPorts())].sort((a, b) => a - b),
  port_min: EGRESS_PORT_MIN,
  port_max: EGRESS_PORT_MAX,
  descriptor_digest: createHash("sha256")
    .update(canonicalEgressPolicyJson(EGRESS_POLICY_DESCRIPTOR))
    .digest("hex"),
  enforcing_reference_digest: createHash("sha256")
    .update(canonicalEgressPolicyJson(EGRESS_POLICY_ENFORCING_REFERENCE))
    .digest("hex"),
};

/**
 * Runs after emitModelRoutingData, which freshens DATA_DIR.
 *
 * `enforcing_reference_not_shipped` is published under that name on purpose. The
 * descriptor this release ships is permissive, so without an enforcing artifact the
 * planner's enforcing paths would have nothing to be tested against, and a hand-built
 * one in Python would be a second spelling of an enforcing policy. It is not the
 * shipped descriptor, its digest is not `descriptor_digest`, and tests on both sides
 * assert that handing it to the planner is refused.
 */
function emitBrokerStartupCatalogData() {
  BrokerStartupCatalogSchema.parse(BROKER_STARTUP_CATALOG);
  writeJson(join(DATA_DIR, "broker-startup-catalog.json"), {
    contract_version: BROKER_STARTUP_CATALOG.contract_version,
    catalog: BROKER_STARTUP_CATALOG,
    catalog_digest: BROKER_STARTUP_CATALOG_DIGEST,
    canonicalization: "sorted_object_keys_recursive",
    // Outside `catalog` on purpose: the digest a caller puts on the wire covers the role table, and
    // how a bound scalar is range-checked is not part of what the caller is pinning. The role log
    // grammar is outside it for the same reason - a caller never names a log file.
    scalar_rules: BROKER_SCALAR_RULES,
    role_log_rules: BROKER_ROLE_LOG_RULES,
  });
  console.log(
    `✓ broker-startup-catalog data: JSON (${BROKER_STARTUP_CATALOG.entries.length} entries, digest ${BROKER_STARTUP_CATALOG_DIGEST.slice(0, 8)}…)`,
  );
}

function emitEgressPolicyData() {
  EgressPolicyDescriptorSchema.parse(EGRESS_POLICY_DESCRIPTOR);
  EgressPolicyDescriptorSchema.parse(EGRESS_POLICY_ENFORCING_REFERENCE);
  writeJson(join(DATA_DIR, "egress-policy-descriptor.json"), {
    contract_version: EGRESS_POLICY_CONTRACT_VERSION,
    descriptor: EGRESS_POLICY_DESCRIPTOR,
    enforcing_reference_not_shipped: EGRESS_POLICY_ENFORCING_REFERENCE,
    rules: EGRESS_POLICY_RULES,
  });
  console.log(
    `✓ egress-policy data: JSON (${EGRESS_POLICY_DESCRIPTOR.loopback_endpoints.length} loopback endpoints, ` +
      `${EGRESS_POLICY_DESCRIPTOR.tier_policies.length} tiers, policy ${EGRESS_POLICY_VERSION_LABEL})`
  );
}

/**
 * The candidates the Sandbox Manager's port allocator reads, keyed by broker placeholder.
 *
 * Published as data because the allocator is Python and the candidates are not something a
 * JSON Schema can say. The refusal's vocabulary reaches Python through its generated model, so
 * it is not repeated here.
 */
const EGRESS_LOOPBACK_PORT_RULES = {
  fixed_port_candidates: EGRESS_FIXED_PORT_CANDIDATES,
  host_service_port_candidates: EGRESS_HOST_SERVICE_PORT_CANDIDATES,
};

/**
 * What the Sandbox Manager's host API routes read and a JSON Schema cannot carry: each error
 * code's status and fixed sentence, the bound a route applies to its `wait_ms` query, and the
 * forwarded credential's header, label and test vector, which ServiceHub reads as well.
 */
const SANDBOX_MANAGER_HOST_API_RULES = {
  errors: SANDBOX_MANAGER_HOST_API_ERRORS,
  egress_approvals_max_wait_ms: EGRESS_APPROVALS_MAX_WAIT_MS,
  egress_pending_approvals_max: EGRESS_PENDING_APPROVALS_MAX,
  egress_approval_text_max_utf16_units: EGRESS_APPROVAL_TEXT_MAX_UTF16_UNITS,
  slack_app_bot_scopes: SLACK_APP_BOT_SCOPES,
  slack_app_bot_events: SLACK_APP_BOT_EVENTS,
  forwarded_credential_header: SERVICEHUB_FORWARDED_CREDENTIAL_HEADER,
  forwarded_credential_label: SERVICEHUB_FORWARDED_CREDENTIAL_LABEL,
  forwarded_credential_vector: SERVICEHUB_FORWARDED_CREDENTIAL_VECTOR,
};

/**
 * What the approval grant's signer and verifier read and a JSON Schema cannot carry: the signing
 * label and limits, the Connector admin endpoint's error table, the golden vectors both
 * languages verify, and the chat key's label with its vector.
 */
const EGRESS_APPROVAL_GRANT_DATA = {
  contract_version: EGRESS_APPROVAL_GRANT_CONTRACT_VERSION,
  rules: EGRESS_APPROVAL_GRANT_RULES,
  admin_errors: CONNECTOR_ADMIN_ERRORS,
  vector: EGRESS_APPROVAL_GRANT_VECTOR,
  chat_vector: EGRESS_APPROVAL_GRANT_CHAT_VECTOR,
  session_ref: EGRESS_APPROVAL_SESSION_REF,
  router_rules: ROUTER_APPROVAL_RULES,
  router_errors: ROUTER_SCOPED_ERRORS,
  router_vector: ROUTER_APPROVAL_VECTOR,
  proxy_rules: EGRESS_PROXY_APPROVAL_RULES,
  proxy_vector: EGRESS_PROXY_APPROVAL_VECTOR,
};

/** Runs after emitModelRoutingData, which freshens DATA_DIR. */
function emitEgressApprovalGrantData() {
  writeJson(join(DATA_DIR, "egress-approval-grant.json"), EGRESS_APPROVAL_GRANT_DATA);
  console.log("✓ egress-approval-grant data: JSON (rules, admin errors, golden vectors, session ref)");
}

/** Runs after emitModelRoutingData, which freshens DATA_DIR. */
function emitSandboxManagerHostApiData() {
  writeJson(join(DATA_DIR, "sandbox-manager-host-api.json"), SANDBOX_MANAGER_HOST_API_RULES);
  console.log(
    `✓ sandbox-manager-host-api data: JSON (${Object.keys(SANDBOX_MANAGER_HOST_API_ERRORS).length} error codes)`
  );
}

/**
 * What the host MCP gateway reads and a JSON Schema cannot carry: its rules (port, prefixes, bounds,
 * forwarded credential, CDP filter), each error code's status and fixed sentence, the text of each
 * call refusal, and the approval vectors both languages decide alike.
 */
const HOST_MCP_API_DATA = {
  rules: HOST_MCP_RULES,
  errors: HOST_MCP_ERRORS,
  call_refusal_text: HOST_MCP_CALL_REFUSAL_TEXT,
  approval_vectors: HOST_MCP_APPROVAL_VECTORS,
  browser_automation_vectors: HOST_MCP_BROWSER_AUTOMATION_VECTORS,
};

/** Runs after emitModelRoutingData, which freshens DATA_DIR. */
function emitHostMcpApiData() {
  writeJson(join(DATA_DIR, "host-mcp-api.json"), HOST_MCP_API_DATA);
  console.log(
    `✓ host-mcp-api data: JSON (${Object.keys(HOST_MCP_ERRORS).length} error codes, ` +
      `${HOST_MCP_APPROVAL_VECTORS.length} approval vectors)`
  );
}

/** Runs after emitModelRoutingData, which freshens DATA_DIR. */
function emitEgressLoopbackPortData() {
  writeJson(join(DATA_DIR, "egress-loopback-ports.json"), {
    contract_version: EGRESS_LOOPBACK_PORT_CONTRACT_VERSION,
    ...EGRESS_LOOPBACK_PORT_RULES,
  });
  console.log(
    `✓ egress-loopback-ports data: JSON (${Object.keys(EGRESS_FIXED_PORT_CANDIDATES).length} allocated ports)`
  );
}

/**
 * The egress surface inventory, for `scripts/ci/check_egress_surfaces.mjs`.
 *
 * Each surface carries the tier its process runs under, read from the launch role table,
 * so the check and a reader see the tier without restating that table.
 */
/** The draft egress allowlist (EG2-3), validated before it is written. */
function emitEgressAllowlistData() {
  const allowlist = EgressAllowlistSchema.parse(EGRESS_ALLOWLIST);
  writeJson(join(DATA_DIR, "egress-allowlist.json"), allowlist);
  console.log(`✓ egress-allowlist data: JSON (${allowlist.entries.length} entries, ${allowlist.categories.length} categories)`);
}

function emitEgressSurfaceInventoryData() {
  const surfaces = EgressSurfaceInventorySchema.parse(EGRESS_SURFACE_INVENTORY);
  writeJson(join(DATA_DIR, "egress-surface-inventory.json"), {
    contract_version: EGRESS_SURFACE_INVENTORY_CONTRACT_VERSION,
    comment_marker: EGRESS_SURFACE_COMMENT_MARKER,
    surfaces: surfaces.map((surface) => ({ ...surface, tier: egressSurfaceTier(surface) })),
  });
  console.log(`✓ egress-surface-inventory data: JSON (${surfaces.length} surfaces)`);
}

/**
 * The rule tables the isolation report's two validators share.
 *
 * Same reasoning as the two policy rule tables above, with one difference worth stating:
 * there is no `descriptor_digest` here and there is nothing to take one of. A policy
 * descriptor is a build artifact, so the digest is what lets a runtime refuse a
 * descriptor nobody ran the rules over. A report is per-run observation, produced fresh
 * on every call, so the only defence available is the rules themselves - which is why
 * they are published as data and read by the Python validator rather than restated
 * there.
 *
 * `level_facts`, `token_shape_facts`, `egress_boundary_posture`,
 * `egress_enforced_tier_coverage` and `egress_readback_facts` are the five tables that make
 * neighbouring enums non-independent. `installed_release_levels` is section 4.3's gate set,
 * published so a release check reads it instead of hard-coding two strings.
 *
 * Every closed vocabulary of the contract reaches Python as a generated Pydantic enum, so
 * this table publishes only what the Python validator reads and cannot derive: rules, not
 * option lists. A vocabulary published here as well would be a second spelling of what
 * codegen already emits, and a test comparing the two would compare one Zod enum with
 * itself.
 */
const ISOLATION_REPORTING_RULES = {
  level_facts: ISOLATION_LEVEL_FACTS,
  installed_release_levels: [...ISOLATION_INSTALLED_RELEASE_LEVELS],
  token_shape_facts: ISOLATION_TOKEN_SHAPE_FACTS,
  shape_issue_kinds: [...ISOLATION_SHAPE_ISSUE_KINDS],
  shape_issue_reasons: ISOLATION_SHAPE_ISSUE_REASONS,
  cross_field_rules_continue_after: [...ISOLATION_CROSS_FIELD_RULES_CONTINUE_AFTER],
  discriminated_union_fields: ISOLATION_DISCRIMINATED_UNION_FIELDS,
  field_local_refusal_reasons: ISOLATION_FIELD_LOCAL_REFUSAL_REASONS,
  egress_boundary_posture: ISOLATION_EGRESS_BOUNDARY_POSTURE,
  egress_enforced_tier_coverage: ISOLATION_EGRESS_ENFORCED_TIER_COVERAGE,
  egress_readback_facts: ISOLATION_EGRESS_READBACK_FACTS,
  egress_boundary_closed_state: EGRESS_BOUNDARY_CLOSED_STATE,
  egress_version_label_pattern: ISOLATION_EGRESS_VERSION_LABEL_PATTERN.source,
  instant_pattern: ISOLATION_INSTANT_PATTERN.source,
  probe_set_id_pattern: ISOLATION_PROBE_SET_ID_PATTERN.source,
  workspace_root_count_max: WORKSPACE_ROOT_SET_MAX_MEMBERS,
  tiers_requiring_launch_evidence: [...ISOLATION_TIERS_REQUIRING_LAUNCH_EVIDENCE],
};

/**
 * Runs after emitModelRoutingData, which freshens DATA_DIR.
 *
 * The two fail-closed reports are parsed here, through the refinement, so a default that
 * its own rules refuse fails this build instead of becoming the value every surface
 * publishes when it has nothing to report.
 */
function emitIsolationReportingData() {
  for (const report of Object.values(ISOLATION_FAIL_CLOSED_REPORTS)) {
    IsolationReportSchema.parse(report);
  }
  writeJson(join(DATA_DIR, "isolation-reporting.json"), {
    contract_version: ISOLATION_REPORT_CONTRACT_VERSION,
    fail_closed_reports: ISOLATION_FAIL_CLOSED_REPORTS,
    rules: ISOLATION_REPORTING_RULES,
  });
  console.log(
    `✓ isolation-reporting data: JSON (${Object.keys(ISOLATION_LEVEL_FACTS).length} levels, ` +
      `${ISOLATION_REPORT_REFUSAL_REASONS.length} refusal reasons, ` +
      `${ISOLATION_REPORTING_RULES.installed_release_levels.join(" and ")} gate-authoritative)`
  );
}

function emitPython() {
  try {
    execFileSync("uvx", ["--version"], { stdio: "ignore" });
  } catch {
    console.warn(
      "! uvx not found — preserving committed Pydantic bindings. JSON/TS outputs still regenerated.\n" +
        "  Install uv (https://docs.astral.sh/uv/) to generate Python models locally; CI runs this step."
    );
    return;
  }

  const pySpecs = DESCRIPTORS.map((d) => [d.name, d.py]);
  freshDir(PY_DIR);
  const pythonModules = [
    ...pySpecs.map(([, out]) => out.replace(/\.py$/, "")),
    "model_routing_data",
    "agent_runtime_descriptor_data",
    "acl_policy_descriptor_data",
    "broker_startup_catalog_data",
    "egress_policy_descriptor_data",
    "egress_loopback_ports_data",
    "isolation_reporting_data",
    "sandbox_manager_host_api_data",
    "host_mcp_api_data",
    "egress_approval_grant_data",
    "runtime_provision_failure_data",
    "activation_error_copy_data",
    "egress_allowlist_data",
  ];
  const pyInit =
    HEADER_PY +
    "\n__all__ = [\n" +
    pythonModules.map((module) => `    ${JSON.stringify(module)},`).join("\n") +
    "\n]\n";
  writeFileSync(join(PY_DIR, "__init__.py"), pyInit);

  // model-routing data as a Python module (lists, deterministic).
  const pyData =
    HEADER_PY +
    "\nfrom __future__ import annotations\n\nMODEL_ROUTING: dict[str, list[str]] = " +
    pyRepr(MODEL_ROUTING) +
    "\n";
  writeFileSync(join(PY_DIR, "model_routing_data.py"), pyData);

  // The agent runtime descriptors and their rule tables as plain Python data,
  // one source for the payload verifier, the packaging policy, and the native
  // launch path.
  const pyRuntimeData =
    HEADER_PY +
    "\nfrom __future__ import annotations\n\nfrom typing import Any\n\n" +
    `AGENT_RUNTIME_CONTRACT_VERSION = ${AGENT_RUNTIME_CONTRACT_VERSION}\n\n` +
    "AGENT_RUNTIME_DESCRIPTORS: dict[str, Any] = " +
    pyRepr(AGENT_RUNTIME_DESCRIPTORS) +
    "\n\nAGENT_RUNTIME_RULES: dict[str, Any] = " +
    pyRepr(AGENT_RUNTIME_RULES) +
    "\n";
  writeFileSync(join(PY_DIR, "agent_runtime_descriptor_data.py"), pyRuntimeData);

  // The ACL policy descriptor and its rule tables as plain Python data, read by
  // the L1 planner and drift checker. Plain data, not a Pydantic instance: the
  // planner validates it through the generated model, so a broken descriptor
  // fails a test here rather than becoming an unvalidated import.
  const pyAclData =
    HEADER_PY +
    "\nfrom __future__ import annotations\n\nfrom typing import Any\n\n" +
    `ACL_POLICY_CONTRACT_VERSION = ${ACL_POLICY_CONTRACT_VERSION}\n\n` +
    `ACL_POLICY_VERSION = ${ACL_POLICY_VERSION}\n\n` +
    "ACL_POLICY_DESCRIPTOR: dict[str, Any] = " +
    pyRepr(ACL_POLICY_DESCRIPTOR) +
    "\n\nACL_POLICY_RULES: dict[str, Any] = " +
    pyRepr(ACL_POLICY_RULES) +
    "\n";
  writeFileSync(join(PY_DIR, "acl_policy_descriptor_data.py"), pyAclData);

  // The shipped startup catalog as plain Python data, so the Sandbox Manager side reads the
  // same closed role table the broker embeds instead of restating which roles exist. The
  // digest travels with it because a caller has to put it on the wire, and a caller that
  // recomputed it from its own copy of the catalog would be checking itself.
  const pyCatalogData =
    HEADER_PY +
    "\nfrom __future__ import annotations\n\nfrom typing import Any\n\n" +
    `BROKER_STARTUP_CONTRACT_VERSION = ${BROKER_STARTUP_CATALOG.contract_version}\n\n` +
    `BROKER_STARTUP_MANIFEST_VERSION = ${BROKER_STARTUP_MANIFEST_VERSION}\n\n` +
    `BROKER_STARTUP_CATALOG_DIGEST = ${JSON.stringify(BROKER_STARTUP_CATALOG_DIGEST)}\n\n` +
    "BROKER_STARTUP_CATALOG: dict[str, Any] = " +
    pyRepr(BROKER_STARTUP_CATALOG) +
    "\n\nBROKER_LAUNCH_ROLE_TIER: dict[str, str] = " +
    pyRepr(BROKER_LAUNCH_ROLE_TIER) +
    "\n\nBROKER_SCALAR_RULES: dict[str, Any] = " +
    pyRepr(BROKER_SCALAR_RULES) +
    "\n\nBROKER_ROLE_LOG_RULES: dict[str, Any] = " +
    pyRepr(BROKER_ROLE_LOG_RULES) +
    "\n";
  writeFileSync(join(PY_DIR, "broker_startup_catalog_data.py"), pyCatalogData);

  // The egress policy descriptor and its rule tables, read by the L1 planner. Same
  // plain-data treatment as the ACL descriptor above, and for the same reason: the
  // planner validates it through the generated model and against the digest, so a
  // broken descriptor fails a test rather than becoming an unvalidated import.
  const pyEgressData =
    HEADER_PY +
    "\nfrom __future__ import annotations\n\nfrom typing import Any\n\n" +
    `EGRESS_POLICY_CONTRACT_VERSION = ${EGRESS_POLICY_CONTRACT_VERSION}\n\n` +
    `EGRESS_POLICY_VERSION = ${EGRESS_POLICY_VERSION}\n\n` +
    `EGRESS_POLICY_VERSION_LABEL = ${JSON.stringify(EGRESS_POLICY_VERSION_LABEL)}\n\n` +
    "EGRESS_POLICY_DESCRIPTOR: dict[str, Any] = " +
    pyRepr(EGRESS_POLICY_DESCRIPTOR) +
    "\n\nEGRESS_POLICY_ENFORCING_REFERENCE_NOT_SHIPPED: dict[str, Any] = " +
    pyRepr(EGRESS_POLICY_ENFORCING_REFERENCE) +
    "\n\nEGRESS_POLICY_RULES: dict[str, Any] = " +
    pyRepr(EGRESS_POLICY_RULES) +
    "\n";
  writeFileSync(join(PY_DIR, "egress_policy_descriptor_data.py"), pyEgressData);

  // The fixed loopback port candidates, read by the Sandbox Manager's allocator instead of a
  // port literal of its own.
  const pyLoopbackPortData =
    HEADER_PY +
    "\nfrom __future__ import annotations\n\nfrom typing import Any\n\n" +
    `EGRESS_LOOPBACK_PORT_CONTRACT_VERSION = ${EGRESS_LOOPBACK_PORT_CONTRACT_VERSION}\n\n` +
    "EGRESS_LOOPBACK_PORT_RULES: dict[str, Any] = " +
    pyRepr(EGRESS_LOOPBACK_PORT_RULES) +
    "\n";
  writeFileSync(join(PY_DIR, "egress_loopback_ports_data.py"), pyLoopbackPortData);

  // The host API's error table and wait bound, read by the Sandbox Manager's approval and secret
  // routes so that a status or a fixed sentence has one spelling.
  const pyHostApiData =
    HEADER_PY +
    "\nfrom __future__ import annotations\n\nfrom typing import Any\n\n" +
    "SANDBOX_MANAGER_HOST_API_RULES: dict[str, Any] = " +
    pyRepr(SANDBOX_MANAGER_HOST_API_RULES) +
    "\n";
  writeFileSync(join(PY_DIR, "sandbox_manager_host_api_data.py"), pyHostApiData);

  // The host MCP gateway's rules, error table, refusal text and approval vectors, read by
  // mcp_host_manager so that a bound, a status, a sentence or a policy decision has one spelling.
  const pyHostMcpData =
    HEADER_PY +
    "\nfrom __future__ import annotations\n\nfrom typing import Any\n\n" +
    "HOST_MCP_RULES: dict[str, Any] = " +
    pyRepr(HOST_MCP_RULES) +
    "\n\nHOST_MCP_ERRORS: dict[str, Any] = " +
    pyRepr(HOST_MCP_ERRORS) +
    "\n\nHOST_MCP_CALL_REFUSAL_TEXT: dict[str, str] = " +
    pyRepr(HOST_MCP_CALL_REFUSAL_TEXT) +
    "\n\nHOST_MCP_APPROVAL_VECTORS: list[dict[str, Any]] = " +
    pyRepr(HOST_MCP_APPROVAL_VECTORS) +
    "\n\nHOST_MCP_BROWSER_AUTOMATION_VECTORS: list[dict[str, Any]] = " +
    pyRepr(HOST_MCP_BROWSER_AUTOMATION_VECTORS) +
    "\n";
  writeFileSync(join(PY_DIR, "host_mcp_api_data.py"), pyHostMcpData);

  // The approval grant's rules, the Connector admin errors and the golden vector, read by the
  // Sandbox Manager's signer and the Connector's verifier so that the label and the vector have
  // one spelling.
  const pyGrantData =
    HEADER_PY +
    "\nfrom __future__ import annotations\n\nfrom typing import Any\n\n" +
    `EGRESS_APPROVAL_GRANT_CONTRACT_VERSION = ${EGRESS_APPROVAL_GRANT_CONTRACT_VERSION}\n\n` +
    "EGRESS_APPROVAL_GRANT_DATA: dict[str, Any] = " +
    pyRepr(EGRESS_APPROVAL_GRANT_DATA) +
    "\n";
  writeFileSync(join(PY_DIR, "egress_approval_grant_data.py"), pyGrantData);

  // The draft egress allowlist as plain Python data, for the Sandbox Manager to resolve into the
  // proxy's sealed configuration; the proxy itself never imports it.
  const pyAllowlistData =
    HEADER_PY +
    "\nfrom __future__ import annotations\n\nfrom typing import Any\n\n" +
    `EGRESS_ALLOWLIST_CONTRACT_VERSION = ${EGRESS_ALLOWLIST_CONTRACT_VERSION}\n\n` +
    "EGRESS_ALLOWLIST: dict[str, Any] = " +
    pyRepr(EgressAllowlistSchema.parse(EGRESS_ALLOWLIST)) +
    "\n";
  writeFileSync(join(PY_DIR, "egress_allowlist_data.py"), pyAllowlistData);

  // The isolation reporting rule tables and the fail-closed reports, read by
  // sandbox_manager.native_isolation.isolation_report_rules. Plain data for the same
  // reason as the two above, and the fail-closed reports are here rather than built in
  // Python so the report a surface publishes when it has nothing to report has one
  // spelling that the generator has already validated.
  const pyIsolationData =
    HEADER_PY +
    "\nfrom __future__ import annotations\n\nfrom typing import Any\n\n" +
    `ISOLATION_REPORT_CONTRACT_VERSION = ${ISOLATION_REPORT_CONTRACT_VERSION}\n\n` +
    "ISOLATION_FAIL_CLOSED_REPORTS: dict[str, Any] = " +
    pyRepr(ISOLATION_FAIL_CLOSED_REPORTS) +
    "\n\nISOLATION_REPORTING_RULES: dict[str, Any] = " +
    pyRepr(ISOLATION_REPORTING_RULES) +
    "\n";
  writeFileSync(join(PY_DIR, "isolation_reporting_data.py"), pyIsolationData);

  // The user-facing sentence for each runtime provision failure reason, read by ServiceHub when it
  // writes an activation failure, so the console and ServiceHub share one spelling of every sentence.
  const pyProvisionFailureData =
    HEADER_PY +
    "\nfrom __future__ import annotations\n\n" +
    "RUNTIME_PROVISION_FAILURE_COPY: dict[str, str] = " +
    pyRepr(RUNTIME_PROVISION_FAILURE_COPY) +
    "\n";
  writeFileSync(join(PY_DIR, "runtime_provision_failure_data.py"), pyProvisionFailureData);

  // The sentence for every other activation error code, and for each internal failure cause that the
  // public error folds into `safe_error` (already ending in its cause word, which is not on the wire).
  // ServiceHub writes these into the receipt and the HTTP error body, so it never spells a sentence itself.
  const pyActivationErrorCopyData =
    HEADER_PY +
    "\nfrom __future__ import annotations\n\n" +
    "ACTIVATION_FALLBACK_MESSAGE: str = " +
    pyRepr(ACTIVATION_FALLBACK_MESSAGE) +
    "\n\nMODEL_BINDING_ACTIVATION_ERROR_COPY: dict[str, str] = " +
    pyRepr(MODEL_BINDING_ACTIVATION_ERROR_COPY) +
    "\n\nACTIVATION_FAILURE_CAUSE_MESSAGE: dict[str, str] = " +
    pyRepr(Object.fromEntries(ActivationFailureCauseSchema.options.map((cause) => [cause, activationFailureCauseMessage(cause)]))) +
    "\n";
  writeFileSync(join(PY_DIR, "activation_error_copy_data.py"), pyActivationErrorCopyData);

  // The Connector's limits and the search-query URL grammar, read by the Connector instead
  // of literals of its own. The message shapes reach it through the generated model.
  const pyConnectorData =
    HEADER_PY +
    "\nfrom __future__ import annotations\n\nfrom typing import Any\n\n" +
    `CONNECTOR_IPC_CONTRACT_VERSION = ${CONNECTOR_IPC_CONTRACT_VERSION}\n\n` +
    "CONNECTOR_IPC_RULES: dict[str, Any] = " +
    pyRepr(CONNECTOR_IPC_RULES) +
    "\n";
  writeFileSync(join(PY_DIR, "connector_ipc_data.py"), pyConnectorData);

  for (const [name, out] of pySpecs) {
    execFileSync(
      "uvx",
      [
        "--from",
        DMCG_SPEC,
        "datamodel-codegen",
        "--input",
        join(JSON_SCHEMA_DIR, `${name}.json`),
        "--input-file-type",
        "jsonschema",
        "--output",
        join(PY_DIR, out),
        "--output-model-type",
        "pydantic_v2.BaseModel",
        "--target-python-version",
        PY_TARGET,
        "--use-double-quotes",
        "--disable-timestamp",
        "--formatters",
        "builtin",
      ],
      { stdio: "inherit" }
    );
  }
  for (const [, out] of pySpecs) normalizeLf(join(PY_DIR, out));
  addNativePathSetVersionGuard(join(PY_DIR, "native_path_set.py"));
  console.log(`✓ Pydantic: ${pySpecs.length} modules`);
}

function normalizeLf(path) {
  const text = readFileSync(path, "utf8");
  const lf = text.replace(/\r\n/g, "\n");
  if (lf !== text) writeFileSync(path, lf);
}

function addNativePathSetVersionGuard(path) {
  let text = readFileSync(path, "utf8");
  const typingImport = /^from typing import /m;
  if (!typingImport.test(text)) {
    throw new Error("native-path-set codegen no longer exposes its typing import");
  }
  text = text.replace(typingImport, "from collections.abc import Mapping\nfrom typing import ");

  const pydanticImport = /^from pydantic import (.+)$/m;
  const pydanticMatch = pydanticImport.exec(text);
  if (!pydanticMatch) {
    throw new Error("native-path-set codegen no longer exposes its Pydantic import");
  }
  const imported = [...new Set([...pydanticMatch[1].split(",").map((n) => n.trim()), "model_validator"])].sort();
  text = text.replace(pydanticImport, `from pydantic import ${imported.join(", ")}`);

  const classMarker = "class NativePathSetShape(BaseModel):\n";
  if (!text.includes(classMarker)) {
    throw new Error("native-path-set codegen no longer exposes the model class to extend");
  }
  const version = NATIVE_PATH_CONTRACT_VERSION;
  const guard = `class NativePathSetShape(BaseModel):
    """Field shapes for the host-owned native path descriptor, and nothing else.

    This model refuses no cross-field rule. It does not check that the workspace root
    set holds exactly one managed_default member, that no root overlaps another root or
    a fixed managed root, that a member sits outside every denied location, that an
    access mode matches its policy class, or that the caller-supplied volume and
    ancestry verdicts are acceptable. Every one of those refusals lives in
    \`\`sandbox_manager.native_isolation.path_set_rules\`\`, because JSON Schema cannot
    express them.

    Validate through \`\`path_set_rules.validate_native_path_set\`\`, which returns the
    validated \`\`NativePathSet\`\`. Calling \`\`NativePathSetShape.model_validate\`\`
    directly accepts descriptors that the contract refuses.
    """

    @model_validator(mode="before")
    @classmethod
    def validate_contract_version(cls, value: object) -> object:
        if isinstance(value, Mapping):
            contract_version = value.get("contract_version")
            if type(contract_version) is not int or contract_version != ${version}:
                raise ValueError("contract_version must be the integer ${version}")
        return value

`;
  writeFileSync(path, text.replace(classMarker, guard));
}

function pyRepr(value, indent = 0) {
  const pad = "    ".repeat(indent);
  const padInner = "    ".repeat(indent + 1);
  if (value === null) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value.map((v) => padInner + pyRepr(v, indent + 1)).join(",\n");
    return `[\n${items},\n${pad}]`;
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    if (keys.length === 0) return "{}";
    const items = keys
      .map((k) => `${padInner}${JSON.stringify(k)}: ${pyRepr(value[k], indent + 1)}`)
      .join(",\n");
    return `{\n${items},\n${pad}}`;
  }
  return JSON.stringify(value);
}

assertNoCollisions();
emitJsonSchemas();
emitExports();
emitModelRoutingData();
emitAgentRuntimeData();
emitAclPolicyData();
emitBrokerStartupCatalogData();
emitEgressPolicyData();
emitEgressLoopbackPortData();
emitSandboxManagerHostApiData();
emitHostMcpApiData();
emitEgressApprovalGrantData();
emitEgressSurfaceInventoryData();
emitEgressAllowlistData();
emitIsolationReportingData();
emitPython();
console.log("contracts:gen complete.");
