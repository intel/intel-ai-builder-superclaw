/**
 * The workspace opencode config's `mcp` section, as the routes see it. Reads and
 * writes go through `mcp.ts` (listMcp / addMcp / removeMcp), which keeps the
 * validation, the global-name collision check and the JSONC-preserving write.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import {
  MCP_REDACTED_VALUE,
  McpServerConfigSchema,
  type McpServer,
  type McpServerConfig,
  type McpServerConfigView,
  type McpServerStatus,
  type McpServerUpdateRequest,
} from "@different-ai/openwork-contracts/mcp";
import type { McpItem } from "../types.js";
import { isHostGatewayUrl } from "./host-gateway-url.js";
import { listMcp } from "./mcp.js";

export function mcpAuthStorePath(): string {
  return join(homedir(), ".config", "opencode", "mcp-auth.json");
}

export { readProjectMcp as readProjectServerConfig } from "./mcp.js";

/** Enabling drops the flag rather than writing the engine default back. */
export function applyServerUpdate(
  existing: Record<string, unknown>,
  update: McpServerUpdateRequest,
): Record<string, unknown> {
  const { enabled: _enabled, ...base } = update.config ?? existing;
  const enabled = update.enabled ?? (update.config ? update.config.enabled : existing.enabled);
  return enabled === false ? { ...base, enabled: false } : base;
}

function redactValues(values: Record<string, string> | undefined): Record<string, typeof MCP_REDACTED_VALUE> | undefined {
  return values && Object.fromEntries(Object.keys(values).map((key) => [key, MCP_REDACTED_VALUE]));
}

/** Picks the named fields only: environment, header and OAuth values are secrets. */
function toConfigView(config: McpServerConfig): McpServerConfigView {
  const shared = {
    ...(config.enabled !== undefined ? { enabled: config.enabled } : {}),
    ...(config.timeout !== undefined ? { timeout: config.timeout } : {}),
  };
  if (config.type === "local") {
    const environment = redactValues(config.environment);
    return { type: "local", command: config.command, ...(environment ? { environment } : {}), ...shared };
  }
  const headers = redactValues(config.headers);
  return {
    type: "remote",
    url: config.url,
    ...(headers ? { headers } : {}),
    ...(config.oauth !== undefined ? { oauth: config.oauth === false ? false : {} } : {}),
    ...shared,
  };
}

export function toContractServer(item: McpItem, status?: McpServerStatus): McpServer | null {
  const parsed = McpServerConfigSchema.safeParse(item.config);
  if (!parsed.success) {
    console.warn(`[mcp] skipping server "${item.name}": config does not match the MCP contract`);
    return null;
  }
  const config = parsed.data;
  return {
    name: item.name,
    transport: config.type,
    config: toConfigView(config),
    enabled: config.enabled !== false,
    source: item.source,
    ...(config.type === "remote" && isHostGatewayUrl(config.url) ? { execution: "host" as const } : {}),
    ...(item.disabledByTools ? { disabledByTools: true } : {}),
    ...(status ? { status } : {}),
  };
}

export async function listContractServers(
  workspaceRoot: string,
  statusOf: (item: McpItem) => McpServerStatus | undefined = () => undefined,
): Promise<McpServer[]> {
  const items = await listMcp(workspaceRoot);
  return items.flatMap((item) => {
    const server = toContractServer(item, statusOf(item));
    return server ? [server] : [];
  });
}
