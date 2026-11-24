/**
 * Hot add / disconnect / auth removal against the engine's own MCP routes, and
 * the status read the list route merges in. Only routes upstream opencode
 * v1.18.25 serves: GET|POST /mcp, POST /mcp/:name/connect|disconnect, DELETE /mcp/:name/auth.
 *
 * The engine has no MCP status event on its event stream, so status is a read.
 */

import {
  McpServerStatusSchema,
  McpServerAuthStartResponseSchema,
  type McpRuntimeReachability,
  type McpServerAuthStartResponse,
  type McpServerStatus,
} from "@different-ai/openwork-contracts/mcp";
import { ApiError } from "../errors.js";
import type { WorkspaceInfo } from "../types.js";

export type EngineFetch = (
  workspace: WorkspaceInfo,
  path: string,
  init: { method: string; body?: unknown },
) => Promise<unknown>;

export type EngineStatusRead = {
  engine: McpRuntimeReachability;
  statuses: Record<string, McpServerStatus>;
};

export function mcpConnectPath(name: string): string {
  return `/mcp/${encodeURIComponent(name)}/connect`;
}

export function mcpDisconnectPath(name: string): string {
  return `/mcp/${encodeURIComponent(name)}/disconnect`;
}

export function mcpAuthPath(name: string): string {
  return `/mcp/${encodeURIComponent(name)}/auth`;
}

function engineMessage(body: unknown): string | undefined {
  if (typeof body === "string") return body.trim() || undefined;
  if (!body || typeof body !== "object") return undefined;
  const { data, message, error } = body as { data?: { message?: unknown }; message?: unknown; error?: unknown };
  const found = [data?.message, message, error].find((value) => typeof value === "string" && value.trim());
  return found as string | undefined;
}

/**
 * The auth modal's recovery branches (OAuth unsupported, invalid refresh token) match on the
 * engine's wording, so an engine refusal keeps its code but carries the engine's message.
 */
async function withEngineReason<T>(request: () => Promise<T>): Promise<T> {
  try {
    return await request();
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== "opencode_request_failed") throw error;
    const details = error.details as { body?: unknown } | undefined;
    const reason = engineMessage(details?.body);
    if (!reason) throw error;
    throw new ApiError(error.status, error.code, reason, error.details);
  }
}

export async function startServerAuth(
  fetchEngine: EngineFetch,
  workspace: WorkspaceInfo,
  name: string,
): Promise<McpServerAuthStartResponse> {
  return McpServerAuthStartResponseSchema.parse(
    await withEngineReason(() => fetchEngine(workspace, mcpAuthPath(name), { method: "POST" })),
  );
}

export async function completeServerAuth(
  fetchEngine: EngineFetch,
  workspace: WorkspaceInfo,
  name: string,
  code: string,
): Promise<void> {
  await withEngineReason(() => fetchEngine(workspace, `${mcpAuthPath(name)}/callback`, {
    method: "POST",
    body: { code },
  }));
}

export async function hotAddServer(
  fetchEngine: EngineFetch,
  workspace: WorkspaceInfo,
  name: string,
  config: Record<string, unknown>,
): Promise<void> {
  await fetchEngine(workspace, "/mcp", { method: "POST", body: { name, config } });
}

/** Reconnects a server the engine already has from its own config, whatever the source. */
export async function connectServer(
  fetchEngine: EngineFetch,
  workspace: WorkspaceInfo,
  name: string,
): Promise<void> {
  await fetchEngine(workspace, mcpConnectPath(name), { method: "POST" });
}

export async function disconnectServer(
  fetchEngine: EngineFetch,
  workspace: WorkspaceInfo,
  name: string,
): Promise<void> {
  await fetchEngine(workspace, mcpDisconnectPath(name), { method: "POST" });
}

/** A 404 means the engine holds no credential for this server, which is the goal. */
export async function removeServerAuth(
  fetchEngine: EngineFetch,
  workspace: WorkspaceInfo,
  name: string,
): Promise<void> {
  try {
    await fetchEngine(workspace, mcpAuthPath(name), { method: "DELETE" });
  } catch (error) {
    const status = error instanceof ApiError && error.details && typeof error.details === "object"
      ? (error.details as { status?: unknown }).status
      : undefined;
    if (error instanceof ApiError && error.code === "opencode_request_failed" && status === 404) {
      return;
    }
    throw error;
  }
}

export async function readServerStatuses(
  fetchEngine: EngineFetch,
  workspace: WorkspaceInfo,
): Promise<EngineStatusRead> {
  let raw: unknown;
  try {
    raw = await fetchEngine(workspace, "/mcp", { method: "GET" });
  } catch (error) {
    const errorCode = error instanceof ApiError ? error.code : "internal_error";
    return { engine: { reachable: false, errorCode }, statuses: Object.create(null) };
  }
  // Null-prototype: `__proto__` and `constructor` are valid server names.
  const statuses: Record<string, McpServerStatus> = Object.create(null);
  if (raw && typeof raw === "object") {
    for (const [name, value] of Object.entries(raw)) {
      const parsed = McpServerStatusSchema.safeParse(value);
      if (parsed.success) statuses[name] = parsed.data;
    }
  }
  return { engine: { reachable: true }, statuses };
}
