/**
 * EngineTools: the one MCP server's tool list, read from the engine's
 * `GET /mcp/:name/tools`. That route exists only in the SuperClaw opencode fork,
 * not in upstream v1.18.25, so only the hidden Tools panel path may reach this.
 *
 * The fork answers a server it has not connected with 404 and an
 * `McpServerNotFoundError` body; that is `not_connected`. Any other 404, or a
 * success that is not the fork's `{ tools: [...] }` (an upstream engine falls
 * through to its web proxy), means the engine predates the route.
 */

import { ApiError } from "../errors.js";
import type { WorkspaceInfo } from "../types.js";
import type { EngineFetch } from "./engine-sync.js";

export type EngineTool = { name: string; description?: string };

export type EngineToolList =
  | { state: "ready"; tools: EngineTool[] }
  | { state: "not_connected"; tools: [] };

const NOT_CONNECTED_TAG = "McpServerNotFoundError";

export function mcpToolsPath(name: string): string {
  return `/mcp/${encodeURIComponent(name)}/tools`;
}

export function engineUpdateRequired(): ApiError {
  return new ApiError(
    501,
    "engine_update_required",
    "The agent engine does not list MCP tools; update it to manage tools per server",
  );
}

function engineFailure(error: unknown): { status?: unknown; body?: unknown } | null {
  if (!(error instanceof ApiError) || error.code !== "opencode_request_failed") return null;
  return error.details && typeof error.details === "object"
    ? (error.details as { status?: unknown; body?: unknown })
    : {};
}

function parseEngineTools(raw: unknown): EngineTool[] | null {
  const tools = raw && typeof raw === "object" ? (raw as { tools?: unknown }).tools : undefined;
  if (!Array.isArray(tools)) return null;
  const parsed: EngineTool[] = [];
  for (const item of tools) {
    const { name, description } = (item ?? {}) as { name?: unknown; description?: unknown };
    if (typeof name !== "string" || !name) return null;
    parsed.push(typeof description === "string" ? { name, description } : { name });
  }
  return parsed;
}

export async function listServerTools(
  fetchEngine: EngineFetch,
  workspace: WorkspaceInfo,
  server: string,
): Promise<EngineToolList> {
  let raw: unknown;
  try {
    raw = await fetchEngine(workspace, mcpToolsPath(server), { method: "GET" });
  } catch (error) {
    const failure = engineFailure(error);
    if (failure?.status !== 404) throw error;
    const tag = failure.body && typeof failure.body === "object"
      ? (failure.body as { _tag?: unknown })._tag
      : undefined;
    if (tag === NOT_CONNECTED_TAG) return { state: "not_connected", tools: [] };
    throw engineUpdateRequired();
  }
  const tools = parseEngineTools(raw);
  if (!tools) throw engineUpdateRequired();
  return { state: "ready", tools };
}
