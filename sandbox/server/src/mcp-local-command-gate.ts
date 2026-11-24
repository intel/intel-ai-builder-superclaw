import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  ProductProfileDescriptorSchema,
  type ProductProfileFeatureFlags,
} from "@different-ai/openwork-contracts/capability";
import { ApiError } from "./errors.js";
import { assertBrowserMcpSupported, isHostBrowserRelayMcp } from "./mcp/browser-sandbox-support.js";
import { isHostGatewayUrl } from "./mcp/host-gateway-url.js";
// The config roots the runtime hands this process; the orchestrator publishes the selected
// Product Profile's `profile.json` into that root unchanged.
const PROFILE_ROOT_ENV = ["OPENWORK_OPENCODE_CONFIG_SOURCE_DIR", "OPENCODE_CONFIG_DIR"] as const;

type Env = Readonly<Record<string, string | undefined>>;

export function publishedProfilePath(env: Env): string | null {
  for (const name of PROFILE_ROOT_ENV) {
    const root = env[name]?.trim();
    if (root && existsSync(join(root, "profile.json"))) return join(root, "profile.json");
  }
  return null;
}

async function profileFlag(path: string, flag: keyof ProductProfileFeatureFlags): Promise<boolean> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code) return false;
    throw error;
  }
  const parsed = ProductProfileDescriptorSchema.safeParse(raw);
  return parsed.success && parsed.data.feature_flags[flag] === true;
}

/**
 * Whether the published Product Profile sets `flag`. An absent flag, or a `profile.json` that
 * cannot be read or validated, is false. With no published Profile at all (dev runs, runtimes
 * whose config root carries none) there is nothing to gate on, which is true.
 */
async function publishedProfileAllows(flag: keyof ProductProfileFeatureFlags, env: Env): Promise<boolean> {
  const path = publishedProfilePath(env);
  return !path || (await profileFlag(path, flag));
}

/**
 * Refuses a local-command MCP config unless the published Product Profile sets
 * `feature_flags.mcp_local_command`, with the semantics of `publishedProfileAllows`.
 */
export async function assertLocalMcpCommandAllowed(
  config: Record<string, unknown>,
  env: Env = process.env,
): Promise<void> {
  if (config.type !== "local") return;
  if (await publishedProfileAllows("mcp_local_command", env)) return;
  throw new ApiError(
    403,
    "mcp_local_command_disabled",
    "The active Product Profile does not allow MCP servers that run a local command. Add a server URL instead.",
  );
}

function isHostMcpServer(config: Record<string, unknown>): boolean {
  return config.type === "remote" && typeof config.url === "string" && isHostGatewayUrl(config.url);
}

/**
 * Refuses a server that reaches the host MCP gateway unless the published Product Profile allows
 * it: a host server (any URL that reaches the gateway, `isHostGatewayUrl`) needs `mcp_host_execution`, and a browser MCP
 * attached to the gateway's CDP relay needs `host_browser`. Same semantics as the local-command gate.
 */
export async function assertHostMcpAllowed(
  config: Record<string, unknown>,
  env: Env = process.env,
): Promise<void> {
  if (isHostMcpServer(config) && !(await publishedProfileAllows("mcp_host_execution", env))) {
    throw new ApiError(
      403,
      "mcp_host_execution_disabled",
      "The active Product Profile does not allow MCP servers that run on this computer outside the sandbox.",
    );
  }
  if (isHostBrowserRelayMcp(config) && !(await publishedProfileAllows("host_browser", env))) {
    throw new ApiError(
      403,
      "mcp_host_execution_disabled",
      "The active Product Profile does not allow browser automation in the SuperClaw browser on this computer.",
    );
  }
}

/**
 * Checks an `mcp.add` request's config before approval: it must be present, and a local command
 * or a server on the host must pass the Profile gates. Returns the config with the approval
 * prompt to show for it.
 */
export async function gateMcpAdd(
  name: string,
  config: Record<string, unknown> | undefined,
): Promise<{ config: Record<string, unknown>; summary: string }> {
  if (!config) throw new ApiError(400, "invalid_payload", "MCP config is required");
  await assertLocalMcpCommandAllowed(config);
  await assertHostMcpAllowed(config);
  assertBrowserMcpSupported(config);
  return { config, summary: mcpAddApprovalSummary(name, config) };
}

/**
 * An MCP approval prompt; a config that runs a local command shows its full argv, and a host
 * server says where it runs.
 */
export function mcpApprovalSummary(action: string, config: Record<string, unknown>): string {
  if (config.type === "local" && Array.isArray(config.command)) {
    return `${action} running local command ${JSON.stringify(config.command)}`;
  }
  if (isHostMcpServer(config)) return `${action} running on this computer outside the sandbox`;
  return action;
}

/** The approval prompt for adding an MCP server. */
export function mcpAddApprovalSummary(name: string, config: Record<string, unknown>): string {
  return mcpApprovalSummary(`Add MCP ${name}`, config);
}
