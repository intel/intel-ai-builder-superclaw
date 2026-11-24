/**
 * Workspace-scoped MCP servers routes; the wire shapes are
 * `@different-ai/openwork-contracts/mcp`.
 *
 * The plumbing these need is private to server.ts, so it arrives as `deps`
 * (same reason as github-routes.ts: a runtime import back would be a cycle).
 */

import {
  McpServerAddRequestSchema,
  McpServerAuthCallbackRequestSchema,
  McpServerUpdateRequestSchema,
  McpToolPolicyUpdateRequestSchema,
  type McpServerListResponse,
  type McpServerMutationResponse,
  type McpToolListResponse,
  type McpToolPolicyResponse,
} from "@different-ai/openwork-contracts/mcp";
import { recordAudit } from "../audit.js";
import { ApiError } from "../errors.js";
import {
  assertBrowserMcpSupported, BROWSER_MCP_UNSUPPORTED_CODE, browserMcpUnsupportedReason,
} from "./browser-sandbox-support.js";
import {
  assertHostMcpAllowed,
  assertLocalMcpCommandAllowed,
  gateMcpAdd,
  mcpApprovalSummary,
} from "../mcp-local-command-gate.js";
import type { AuthMode, RequestContext, Route } from "../server.js";
import type { ApprovalRequest, ServerConfig, TokenScope, WorkspaceInfo } from "../types.js";
import { shortId } from "../utils.js";
import { validateMcpName } from "../validators.js";
import { opencodeConfigPath } from "../workspace-files.js";
import {
  applyServerUpdate,
  listContractServers,
  mcpAuthStorePath,
  readProjectServerConfig,
} from "./config-store.js";
import {
  connectServer,
  completeServerAuth,
  disconnectServer,
  hotAddServer,
  mcpAuthPath,
  mcpConnectPath,
  mcpDisconnectPath,
  readServerStatuses,
  removeServerAuth,
  startServerAuth,
  type EngineFetch,
} from "./engine-sync.js";
import { listServerTools } from "./engine-tools.js";
import { withLocalLiveness } from "./liveness.js";
import { addMcp, removeMcp, replaceProjectMcp, setConfiguredToolsPolicy } from "./mcp.js";
import { deniedTools, mcpPolicyPath, mcpToolKey, readPolicy } from "./mcp-policy-store.js";
import {
  captureMcpOperation,
  connectOutcomeFromStatus,
  describeConnectTarget,
  mcpOperationApiError,
  type McpOperationCapture,
  type McpOperationOutcome,
} from "./mcp-operation-outcomes.js";
import { assertNoRedactedValues } from "./write-gate.js";

export interface McpRouteDeps {
  addRoute: (
    routes: Route[],
    method: string,
    path: string,
    auth: AuthMode,
    handler: Route["handler"],
  ) => void;
  ensureWritable: (config: ServerConfig) => void;
  fetchOpencodeJson: EngineFetch;
  jsonResponse: (data: unknown, status?: number) => Response;
  readJsonBody: (request: Request) => Promise<Record<string, unknown>>;
  requireApproval: (
    ctx: RequestContext,
    input: Omit<ApprovalRequest, "id" | "createdAt" | "actor">,
  ) => Promise<void>;
  requireClientScope: (ctx: RequestContext, required: TokenScope) => void;
  resolveWorkspace: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
}

type ParseIssues = { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }> };

function invalidRequestError(error: ParseIssues, fallback: string): ApiError {
  const configIssue = error.issues.some((issue) => issue.path[0] === "config");
  return new ApiError(
    400,
    configIssue ? "invalid_mcp_config" : "invalid_payload",
    error.issues[0]?.message ?? fallback,
  );
}

export function registerMcpRoutes(routes: Route[], config: ServerConfig, deps: McpRouteDeps): void {
  const {
    addRoute,
    ensureWritable,
    fetchOpencodeJson,
    jsonResponse,
    readJsonBody,
    requireApproval,
    requireClientScope,
    resolveWorkspace,
  } = deps;

  async function recordAuthAudit(
    ctx: RequestContext,
    workspace: WorkspaceInfo,
    action: string,
    summary: string,
  ): Promise<void> {
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action,
      target: mcpAuthStorePath(),
      summary,
      timestamp: Date.now(),
    });
  }

  async function mutationResponse(
    workspace: WorkspaceInfo,
    operations: McpOperationOutcome[],
  ): Promise<Response> {
    const body: McpServerMutationResponse = {
      items: await listContractServers(workspace.path),
      operations,
    };
    return jsonResponse(body);
  }

  /**
   * A connect call can succeed while the engine records the server as failed, so the outcome also
   * reads its status.
   */
  async function captureEngineConnect(
    workspace: WorkspaceInfo,
    name: string,
    serverConfig: Record<string, unknown> | undefined,
    path: string,
    run: () => Promise<void>,
  ): Promise<McpOperationCapture<void>> {
    const captured = await captureMcpOperation({
      operation: "connect",
      step: "connect",
      target: "instance-runtime",
      method: "POST",
      path,
      ...describeConnectTarget(serverConfig),
    }, run);
    if (!captured.ok) return captured;
    return {
      ...captured,
      outcome: connectOutcomeFromStatus(
        captured.outcome,
        (await readServerStatuses(fetchOpencodeJson, workspace)).statuses[name],
      ),
    };
  }

  async function requireConfiguredServer(workspace: WorkspaceInfo, rawName: string | undefined): Promise<string> {
    const name = String(rawName ?? "").trim();
    validateMcpName(name);
    const servers = await listContractServers(workspace.path);
    if (!servers.some((item) => item.name === name)) {
      throw new ApiError(404, "mcp_not_found", `MCP server "${name}" is not configured in this workspace`);
    }
    return name;
  }

  addRoute(routes, "GET", "/v1/workspaces/:id/mcp", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const { engine: runtime, statuses } = await readServerStatuses(fetchOpencodeJson, workspace);
    const listed = await listContractServers(workspace.path, (item) => {
      // Whatever the engine reports, a server that cannot run here is failed, with the reason.
      const reason = item.config.enabled === false ? null : browserMcpUnsupportedReason(item.config);
      if (reason) return { status: "failed", error: reason, code: BROWSER_MCP_UNSUPPORTED_CODE };
      return statuses[item.name] ?? (item.config.enabled === false ? { status: "disabled" } : undefined);
    });
    // A read-only server, or a global entry this workspace does not own, is only disconnected.
    const disableUnreachable = async (name: string): Promise<{ persisted: boolean } | null> => {
      try {
        await disconnectServer(fetchOpencodeJson, workspace, name);
      } catch (err) {
        console.error(`[mcp-liveness] could not disconnect unreachable MCP: ${name}`, err);
        return null;
      }
      let existing: Awaited<ReturnType<typeof readProjectServerConfig>> = null;
      try {
        existing = config.readOnly ? null : await readProjectServerConfig(workspace.path, name);
        if (existing) {
          await replaceProjectMcp(workspace.path, name, existing, applyServerUpdate(existing, { enabled: false }));
        }
        console.log(`[mcp-liveness] disabled unreachable MCP: ${name}`);
      } catch (err) {
        existing = null;
        console.error(`[mcp-liveness] disconnected unreachable MCP but could not turn it off: ${name}`, err);
      }
      await recordAudit(workspace.path, {
        id: shortId(),
        workspaceId: workspace.id,
        actor: ctx.actor ?? { type: "remote" },
        action: existing ? "mcp.update" : "mcp.disconnect",
        target: existing ? "opencode.json" : "opencode",
        summary: `Disabled unreachable MCP ${name}`,
        timestamp: Date.now(),
      });
      if (existing) ctx.reloadEvents.record(workspace.id, "mcp", { type: "mcp", name, action: "updated" });
      return { persisted: existing !== null };
    };
    const items = await Promise.all(listed.map((server) => withLocalLiveness(server, disableUnreachable)));
    const body: McpServerListResponse = { items, runtime };
    return jsonResponse(body);
  });

  addRoute(routes, "POST", "/v1/workspaces/:id/mcp", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    // `readJsonBody` only casts, so a JSON null or array arrives here unchecked.
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new ApiError(400, "invalid_payload", "Expected a JSON object");
    }
    const name = String(body.name ?? "");
    if (!body.config) {
      throw new ApiError(400, "invalid_payload", "MCP config is required");
    }
    validateMcpName(name);
    const parsed = McpServerAddRequestSchema.safeParse(body);
    if (!parsed.success) throw invalidRequestError(parsed.error, "Invalid MCP server");
    const { config: configPayload, summary } = await gateMcpAdd(name, parsed.data.config);
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "mcp.add",
      summary,
      paths: [opencodeConfigPath(workspace.path)],
    });
    const operations: McpOperationOutcome[] = [];
    const persist = await captureMcpOperation({
      operation: "connect",
      step: "persist",
      target: "workspace-config",
    }, () => addMcp(workspace.path, name, configPayload));
    operations.push(persist.outcome);
    if (!persist.ok) {
      throw mcpOperationApiError(persist.error, operations);
    }
    const result = persist.value;
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "mcp.add",
      target: "opencode.json",
      summary: `Added MCP ${name}`,
      timestamp: Date.now(),
    });
    ctx.reloadEvents.record(workspace.id, "mcp", { type: "mcp", name, action: result.action });
    // Hot-sync via the engine's native /mcp endpoint instead of a full instance
    // dispose, which would abort every in-flight session on this directory.
    const connect = await captureEngineConnect(
      workspace,
      name,
      configPayload,
      "/mcp",
      () => hotAddServer(fetchOpencodeJson, workspace, name, configPayload),
    );
    operations.push(connect.outcome);
    if (connect.ok) {
      console.log(`[mcp-add] engine hot-sync succeeded for MCP: ${name}`);
    } else {
      console.error(`[mcp-add] engine hot-sync failed for MCP: ${name}`, connect.error);
    }
    return mutationResponse(workspace, operations);
  });

  addRoute(routes, "PATCH", "/v1/workspaces/:id/mcp/:name", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const name = String(ctx.params.name ?? "").trim();
    validateMcpName(name);
    const parsed = McpServerUpdateRequestSchema.safeParse(await readJsonBody(ctx.request));
    if (!parsed.success) throw invalidRequestError(parsed.error, "Invalid MCP update");
    assertNoRedactedValues(parsed.data);
    const existing = await readProjectServerConfig(workspace.path, name);
    if (!existing) {
      const listed = (await listContractServers(workspace.path)).find((server) => server.name === name);
      const reconnectOnly = parsed.data.enabled === true && parsed.data.config === undefined;
      if (!listed || !reconnectOnly) {
        throw new ApiError(404, "mcp_not_found", `MCP server "${name}" is not configured in this workspace`);
      }
      await assertLocalMcpCommandAllowed(listed.config);
      await assertHostMcpAllowed(listed.config);
      assertBrowserMcpSupported(listed.config);
      // A global entry is not this workspace's to rewrite, so reconnect it in the engine only.
      await requireApproval(ctx, {
        workspaceId: workspace.id,
        action: "mcp.update",
        summary: mcpApprovalSummary(`Reconnect MCP ${name}`, listed.config),
        paths: [],
      });
      const connect = await captureEngineConnect(
        workspace,
        name,
        listed.config,
        mcpConnectPath(name),
        () => connectServer(fetchOpencodeJson, workspace, name),
      );
      if (!connect.ok) throw mcpOperationApiError(connect.error, [connect.outcome]);
      return mutationResponse(workspace, [connect.outcome]);
    }
    const next = applyServerUpdate(existing, parsed.data);
    if (parsed.data.enabled !== false || parsed.data.config !== undefined) {
      await assertLocalMcpCommandAllowed(next);
      await assertHostMcpAllowed(next);
      assertBrowserMcpSupported(next);
    }
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "mcp.update",
      summary: mcpApprovalSummary(`Update MCP ${name}`, next),
      paths: [opencodeConfigPath(workspace.path)],
    });
    const operations: McpOperationOutcome[] = [];
    const persist = await captureMcpOperation({
      operation: "connect",
      step: "persist",
      target: "workspace-config",
    }, () => replaceProjectMcp(workspace.path, name, existing, next));
    operations.push(persist.outcome);
    if (!persist.ok) {
      throw mcpOperationApiError(persist.error, operations);
    }
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "mcp.update",
      target: "opencode.json",
      summary: `Updated MCP ${name}`,
      timestamp: Date.now(),
    });
    ctx.reloadEvents.record(workspace.id, "mcp", { type: "mcp", name, action: "updated" });
    if (next.enabled === false) {
      const disconnect = await captureMcpOperation({
        operation: "connect",
        step: "disconnect",
        target: "instance-runtime",
        method: "POST",
        path: mcpDisconnectPath(name),
      }, () => disconnectServer(fetchOpencodeJson, workspace, name));
      operations.push(disconnect.outcome);
      if (!disconnect.ok) throw mcpOperationApiError(disconnect.error, operations);
    } else {
      const connect = await captureEngineConnect(
        workspace,
        name,
        next,
        "/mcp",
        () => hotAddServer(fetchOpencodeJson, workspace, name, next),
      );
      operations.push(connect.outcome);
      if (!connect.ok) {
        console.error(`[mcp-update] engine hot-sync failed for MCP: ${name}`, connect.error);
      }
    }
    return mutationResponse(workspace, operations);
  });

  addRoute(routes, "DELETE", "/v1/workspaces/:id/mcp/:name", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const name = String(ctx.params.name ?? "").trim();
    validateMcpName(name);
    if (!(await readProjectServerConfig(workspace.path, name))) {
      const global = (await listContractServers(workspace.path)).some((server) => server.name === name);
      throw new ApiError(404, "mcp_not_found", global
        ? `MCP server "${name}" is set in the global config; remove it there`
        : `MCP server "${name}" is not configured in this workspace`);
    }
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "mcp.remove",
      summary: `Remove MCP ${name}`,
      paths: [opencodeConfigPath(workspace.path)],
    });
    const operations: McpOperationOutcome[] = [];
    const disconnect = await captureMcpOperation({
      operation: "remove",
      step: "disconnect",
      target: "instance-runtime",
      method: "POST",
      path: mcpDisconnectPath(name),
    }, () => disconnectServer(fetchOpencodeJson, workspace, name));
    operations.push(disconnect.outcome);
    if (!disconnect.ok) {
      console.error(
        `[mcp-remove] OpenCode disconnect failed for MCP: ${name}`,
        disconnect.outcome.errorCode,
        disconnect.outcome.httpStatus,
      );
    }
    const persist = await captureMcpOperation({
      operation: "remove",
      step: "persist",
      target: "workspace-config",
    }, () => removeMcp(workspace.path, name));
    operations.push(persist.outcome);
    if (!persist.ok) {
      throw mcpOperationApiError(persist.error, operations);
    }
    const removed = persist.value;
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "mcp.remove",
      target: "opencode.json",
      summary: `Removed MCP ${name}`,
      timestamp: Date.now(),
    });
    if (removed) {
      ctx.reloadEvents.record(workspace.id, "mcp", { type: "mcp", name, action: "removed" });
      try {
        await disconnectServer(fetchOpencodeJson, workspace, name);
        console.log(`[mcp-remove] engine hot-sync succeeded for MCP: ${name}`);
      } catch (err) {
        console.error(`[mcp-remove] engine hot-sync failed for MCP: ${name}`, err);
      }
    }
    return mutationResponse(workspace, operations);
  });

  addRoute(routes, "DELETE", "/v1/workspaces/:id/mcp/:name/auth", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const name = String(ctx.params.name ?? "").trim();
    validateMcpName(name);

    const authStorePath = mcpAuthStorePath();
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "mcp.auth.remove",
      summary: `Logout MCP ${name}`,
      paths: [authStorePath],
    });

    const operations: McpOperationOutcome[] = [];
    const disconnect = await captureMcpOperation({
      operation: "logout",
      step: "disconnect",
      target: "instance-runtime",
      method: "POST",
      path: mcpDisconnectPath(name),
    }, () => disconnectServer(fetchOpencodeJson, workspace, name));
    operations.push(disconnect.outcome);
    if (!disconnect.ok) {
      console.error(
        `[mcp-auth-remove] OpenCode disconnect failed for MCP: ${name}`,
        disconnect.outcome.errorCode,
        disconnect.outcome.httpStatus,
      );
    }

    const authRemove = await captureMcpOperation({
      operation: "logout",
      step: "auth-remove",
      target: "instance-runtime",
      method: "DELETE",
      path: mcpAuthPath(name),
    }, () => removeServerAuth(fetchOpencodeJson, workspace, name));
    operations.push(authRemove.outcome);
    if (!authRemove.ok) {
      throw mcpOperationApiError(authRemove.error, operations);
    }

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "mcp.auth.remove",
      target: authStorePath,
      summary: `Logged out MCP ${name}`,
      timestamp: Date.now(),
    });

    return jsonResponse({ ok: true, operations });
  });

  addRoute(routes, "POST", "/v1/workspaces/:id/mcp/:name/auth/start", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const name = String(ctx.params.name ?? "").trim();
    validateMcpName(name);
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "mcp.auth.start",
      summary: `Start MCP sign-in ${name}`,
      paths: [mcpAuthStorePath()],
    });
    const started = await startServerAuth(fetchOpencodeJson, workspace, name);
    await recordAuthAudit(ctx, workspace, "mcp.auth.start", `Started MCP sign-in ${name}`);
    return jsonResponse(started);
  });

  addRoute(routes, "POST", "/v1/workspaces/:id/mcp/:name/auth/callback", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const name = String(ctx.params.name ?? "").trim();
    validateMcpName(name);
    const parsed = McpServerAuthCallbackRequestSchema.safeParse(await readJsonBody(ctx.request));
    if (!parsed.success) throw invalidRequestError(parsed.error, "Invalid MCP OAuth callback");
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "mcp.auth.add",
      summary: `Sign in MCP ${name}`,
      paths: [mcpAuthStorePath()],
    });
    await completeServerAuth(fetchOpencodeJson, workspace, name, parsed.data.code);
    await recordAuthAudit(ctx, workspace, "mcp.auth.add", `Signed in MCP ${name}`);
    return jsonResponse({ ok: true });
  });

  // Reaches the fork-only engine route; only the hidden Tools panel calls it.
  addRoute(routes, "GET", "/v1/workspaces/:id/mcp/:name/tools", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const name = await requireConfiguredServer(workspace, ctx.params.name);
    const listed = await listServerTools(fetchOpencodeJson, workspace, name);
    // The gate denies by engine key, and distinct raw names can share one, so a
    // tool is allowed only while no tool with its key is denied.
    const deniedKeys = new Set(deniedTools(await readPolicy(workspace.path), name).map((tool) => mcpToolKey(name, tool)));
    const body: McpToolListResponse = listed.state === "not_connected"
      ? { state: "not_connected", tools: [] }
      : {
        state: "ready",
        tools: listed.tools.map((tool) => {
          const key = mcpToolKey(name, tool.name);
          return { ...tool, key, allowed: !deniedKeys.has(key) };
        }),
      };
    return jsonResponse(body);
  });

  addRoute(routes, "PUT", "/v1/workspaces/:id/mcp/:name/policy", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const name = await requireConfiguredServer(workspace, ctx.params.name);
    const parsed = McpToolPolicyUpdateRequestSchema.safeParse(await readJsonBody(ctx.request));
    if (!parsed.success) {
      throw new ApiError(400, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid MCP tool policy");
    }
    const { action } = parsed.data;
    const requested = "tool" in parsed.data ? [parsed.data.tool] : parsed.data.tools;
    const policyPath = mcpPolicyPath(workspace.path);
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "mcp.policy.update",
      summary: `Set MCP ${name} tools ${requested.map((tool) => JSON.stringify(tool)).join(", ")} to ${action}, `
        + "with any stored tool names sharing their engine keys",
      paths: [policyPath],
    });
    const tools = await setConfiguredToolsPolicy(workspace.path, name, requested, action);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "mcp.policy.update",
      target: policyPath,
      summary: `Set ${tools.join(", ")} of MCP ${name} to ${action}`,
      timestamp: Date.now(),
    });
    const body: McpToolPolicyResponse = { policy: (await readPolicy(workspace.path))[name] ?? {} };
    return jsonResponse(body);
  });
}
