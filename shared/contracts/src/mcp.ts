/**
 * MCP resource family on the versioned instance API:
 *
 *   GET    /v1/workspaces/:id/mcp             -> McpServerListResponse
 *   POST   /v1/workspaces/:id/mcp             McpServerAddRequest -> McpServerMutationResponse
 *   PATCH  /v1/workspaces/:id/mcp/:name       McpServerUpdateRequest -> McpServerMutationResponse
 *   DELETE /v1/workspaces/:id/mcp/:name       -> McpServerMutationResponse
 *   DELETE /v1/workspaces/:id/mcp/:name/auth  -> McpServerAuthRemoveResponse
 *   GET    /v1/workspaces/:id/mcp/:name/tools -> McpToolListResponse
 *   PUT    /v1/workspaces/:id/mcp/:name/policy McpToolPolicyUpdateRequest -> McpToolPolicyResponse
 *
 * The tools route needs a runtime that serves `GET /mcp/:name/tools` (the
 * SuperClaw opencode fork, not upstream v1.18.25); without it the route answers
 * `engine_update_required`. Product Profile configuration decides whether the
 * UI offers this capability; the versioned instance API remains stable.
 *
 * Only the list asks the engine for status; a client refetches it after a
 * mutation. Every failure answers with McpErrorBody. Server configs are loose objects: the
 * engine owns the full config shape, and a key this contract does not name must
 * survive a round trip rather than be stripped.
 */

import { z } from "zod";

export const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;

export const McpServerNameSchema = z
  .string()
  .regex(MCP_SERVER_NAME_PATTERN, "MCP name must be alphanumeric, '-' or '_', and must not start with -");

const StringRecordSchema = z.record(z.string(), z.string());

export const McpLocalServerConfigSchema = z.looseObject({
  type: z.literal("local"),
  command: z.array(z.string()).min(1),
  environment: StringRecordSchema.optional(),
  enabled: z.boolean().optional(),
  timeout: z.number().int().positive().optional(),
});

export const McpRemoteServerConfigSchema = z.looseObject({
  type: z.literal("remote"),
  url: z.string().min(1),
  headers: StringRecordSchema.optional(),
  oauth: z.union([z.looseObject({}), z.literal(false)]).optional(),
  enabled: z.boolean().optional(),
  timeout: z.number().int().positive().optional(),
});

export const McpServerConfigSchema = z.discriminatedUnion("type", [
  McpLocalServerConfigSchema,
  McpRemoteServerConfigSchema,
]);

/** Every environment and header value in a response; the stored values never leave the server. */
export const MCP_REDACTED_VALUE = "[redacted]";

const RedactedRecordSchema = z.record(z.string(), z.literal(MCP_REDACTED_VALUE));

/**
 * The config a response carries: keys without their values, OAuth as on (`{}`) or off, and no
 * field this contract does not name. Only requests carry a full, loose config.
 */
export const McpServerConfigViewSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("local"),
    command: z.array(z.string()).min(1),
    environment: RedactedRecordSchema.optional(),
    enabled: z.boolean().optional(),
    timeout: z.number().int().positive().optional(),
  }),
  z.object({
    type: z.literal("remote"),
    url: z.string().min(1),
    headers: RedactedRecordSchema.optional(),
    oauth: z.union([z.object({}), z.literal(false)]).optional(),
    enabled: z.boolean().optional(),
    timeout: z.number().int().positive().optional(),
  }),
]);

export const MCP_SERVER_TRANSPORTS = ["local", "remote"] as const;
export const McpServerTransportSchema = z.enum(MCP_SERVER_TRANSPORTS);

export const MCP_SERVER_SOURCES = ["config.project", "config.global", "config.remote"] as const;
export const McpServerSourceSchema = z.enum(MCP_SERVER_SOURCES);

export const MCP_SERVER_EXECUTIONS = ["sandbox", "host"] as const;
export const McpServerExecutionSchema = z.enum(MCP_SERVER_EXECUTIONS);

/**
 * The first five are the engine's own `GET /mcp` states. `connecting` is the
 * client-side state of a mutation still in flight; the server never reports it.
 */
export const MCP_SERVER_STATUSES = [
  "connected",
  "disabled",
  "failed",
  "needs_auth",
  "needs_client_registration",
  "connecting",
] as const;

export const McpServerStatusSchema = z.object({
  status: z.enum(MCP_SERVER_STATUSES),
  error: z.string().optional(),
  /** Set when `error` comes from a known typed refusal (e.g. `mcp_browser_unsupported_in_sandbox`), so clients can localize instead of showing the raw server string. */
  code: z.string().optional(),
});

export const McpServerSchema = z.object({
  name: z.string().min(1),
  transport: McpServerTransportSchema,
  config: McpServerConfigViewSchema,
  enabled: z.boolean(),
  source: McpServerSourceSchema,
  disabledByTools: z.boolean().optional(),
  /**
   * Where the server's tools run. openwork-server sets `host` when a remote server's URL is the host
   * MCP gateway's runtime URL (`host-mcp-api.ts`); the command then runs outside the sandbox.
   */
  execution: McpServerExecutionSchema.optional(),
  /** Absent when the engine is unreachable or has not registered this server. */
  status: McpServerStatusSchema.optional(),
});

export const McpOperationOutcomeSchema = z.object({
  operation: z.enum(["connect", "remove", "logout"]),
  step: z.enum(["persist", "reload", "connect", "disconnect", "auth-remove"]),
  target: z.enum(["instance-runtime", "workspace-config"]),
  method: z.enum(["GET", "POST", "DELETE"]).optional(),
  path: z.string().optional(),
  /** Connect steps only. `command` is the local command line without environment; `host` is the remote URL host. */
  transport: McpServerTransportSchema.optional(),
  command: z.string().optional(),
  host: z.string().optional(),
  result: z.enum(["success", "failed"]),
  durationMs: z.number().nonnegative(),
  errorCode: z.string().optional(),
  errorMessage: z.string().optional(),
  httpStatus: z.number().int().optional(),
});

export const McpRuntimeReachabilitySchema = z.object({
  reachable: z.boolean(),
  errorCode: z.string().optional(),
});

export const McpServerListResponseSchema = z.object({
  items: z.array(McpServerSchema),
  runtime: McpRuntimeReachabilitySchema,
});

/** `items` is the configured set after the mutation, without engine status. */
export const McpServerMutationResponseSchema = z.object({
  items: z.array(McpServerSchema),
  operations: z.array(McpOperationOutcomeSchema),
});

export const McpServerAddRequestSchema = z.object({
  name: McpServerNameSchema,
  config: McpServerConfigSchema,
});

/** `config` replaces the stored config whole; `enabled` toggles it in place. At least one is required. */
export const McpServerUpdateRequestSchema = z.union([
  z.object({ enabled: z.boolean(), config: McpServerConfigSchema.optional() }),
  z.object({ enabled: z.boolean().optional(), config: McpServerConfigSchema }),
], { error: "Provide enabled, config, or both" });

export const McpServerAuthRemoveResponseSchema = z.object({
  ok: z.literal(true),
  operations: z.array(McpOperationOutcomeSchema),
});

export const McpServerAuthStartResponseSchema = z.object({
  authorizationUrl: z.string().url().optional(),
});

export const McpServerAuthCallbackRequestSchema = z.object({
  code: z.string().min(1),
});

export const McpServerAuthCallbackResponseSchema = z.object({
  ok: z.literal(true),
});

export const MCP_TOOL_ACTIONS = ["allow", "deny"] as const;
export const McpToolActionSchema = z.enum(MCP_TOOL_ACTIONS);

/** `name` is the raw name the MCP server reports; `key` is the engine's tool key for it. */
export const McpToolSchema = z.object({
  name: z.string().min(1),
  key: z.string().min(1),
  description: z.string().optional(),
  allowed: z.boolean(),
});

/** A server the engine has not connected lists no tools; that is a state, not an error. */
export const McpToolListResponseSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("ready"), tools: z.array(McpToolSchema) }),
  z.object({ state: z.literal("not_connected"), tools: z.array(McpToolSchema).max(0) }),
]);

/** One tool, or every listed tool (allow all / deny all), by raw name. */
export const McpToolPolicyUpdateRequestSchema = z.union([
  z.object({ tool: z.string().min(1), action: McpToolActionSchema }).strict(),
  z.object({ tools: z.array(z.string().min(1)).min(1), action: McpToolActionSchema }).strict(),
]);

/** The server's stored policy after the write: raw tool name -> action. */
export const McpToolPolicyResponseSchema = z.object({
  policy: z.record(z.string(), McpToolActionSchema),
});

/** Codes the MCP routes raise themselves; auth, scope and workspace codes are shared server-wide. */
export const MCP_ERROR_CODES = [
  "invalid_json",
  "invalid_payload",
  "invalid_mcp_name",
  "invalid_mcp_config",
  "mcp_name_prefix_collision",
  "invalid_obsidian_vault",
  "obsidian_vault_not_found",
  "mcp_not_found",
  "mcp_update_conflict",
  "mcp_local_command_disabled",
  "mcp_host_execution_disabled",
  "mcp_browser_unsupported_in_sandbox",
  "opencode_unconfigured",
  "opencode_request_failed",
  "engine_update_required",
  "internal_error",
] as const;

export const McpErrorCodeSchema = z.enum(MCP_ERROR_CODES);

export const McpErrorBodySchema = z.object({
  code: z.string().min(1),
  message: z.string(),
  details: z.unknown().optional(),
});

export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;
export type McpServerConfigView = z.infer<typeof McpServerConfigViewSchema>;
export type McpServerTransport = z.infer<typeof McpServerTransportSchema>;
export type McpServerSource = z.infer<typeof McpServerSourceSchema>;
export type McpServerExecution = z.infer<typeof McpServerExecutionSchema>;
export type McpServerStatus = z.infer<typeof McpServerStatusSchema>;
export type McpServer = z.infer<typeof McpServerSchema>;
export type McpOperationOutcome = z.infer<typeof McpOperationOutcomeSchema>;
export type McpRuntimeReachability = z.infer<typeof McpRuntimeReachabilitySchema>;
export type McpServerListResponse = z.infer<typeof McpServerListResponseSchema>;
export type McpServerMutationResponse = z.infer<typeof McpServerMutationResponseSchema>;
export type McpServerAddRequest = z.infer<typeof McpServerAddRequestSchema>;
export type McpServerUpdateRequest = z.infer<typeof McpServerUpdateRequestSchema>;
export type McpServerAuthRemoveResponse = z.infer<typeof McpServerAuthRemoveResponseSchema>;
export type McpServerAuthStartResponse = z.infer<typeof McpServerAuthStartResponseSchema>;
export type McpServerAuthCallbackRequest = z.infer<typeof McpServerAuthCallbackRequestSchema>;
export type McpServerAuthCallbackResponse = z.infer<typeof McpServerAuthCallbackResponseSchema>;
export type McpToolAction = z.infer<typeof McpToolActionSchema>;
export type McpTool = z.infer<typeof McpToolSchema>;
export type McpToolListResponse = z.infer<typeof McpToolListResponseSchema>;
export type McpToolPolicyUpdateRequest = z.infer<typeof McpToolPolicyUpdateRequestSchema>;
export type McpToolPolicyResponse = z.infer<typeof McpToolPolicyResponseSchema>;
export type McpErrorCode = z.infer<typeof McpErrorCodeSchema>;
export type McpErrorBody = z.infer<typeof McpErrorBodySchema>;
