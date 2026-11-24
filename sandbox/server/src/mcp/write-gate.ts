/**
 * MCP servers are written only through the instance API (`/v1/workspaces/:id/mcp`), where the
 * local-command gates and approval run. These checks keep the other write paths from bypassing it.
 */

import { MCP_REDACTED_VALUE, type McpServerUpdateRequest } from "@different-ai/openwork-contracts/mcp";
import { ApiError } from "../errors.js";
import { gateMcpAdd } from "../mcp-local-command-gate.js";

const INSTANCE_API_MCP_PATH = "/v1/workspaces/:id/mcp";

export function normalizeOpencodeProxyPath(proxyPath: string): string {
  const raw = (proxyPath ?? "").trim() || "/";
  const withoutPrefix = raw.startsWith("/opencode") ? raw.slice("/opencode".length) : raw;
  const normalized = (withoutPrefix || "/").replace(/\/+$/, "");
  return normalized || "/";
}

function decodedPath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch (error) {
    if (error instanceof URIError) return path;
    throw error;
  }
}

async function writesMcpConfig(request: Request, path: string): Promise<boolean> {
  if (!/^\/+(global\/+)?config(\/|$)/i.test(path)) return false;
  try {
    const body: unknown = JSON.parse(await request.clone().text());
    return Boolean(body) && typeof body === "object" && Object.prototype.hasOwnProperty.call(body, "mcp");
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
}

/** Refuses an MCP mutation through the opencode proxy, including a config write with an `mcp` section; reads pass through. */
export async function assertOpencodeProxyMcpReadOnly(request: Request, proxyPath: string): Promise<void> {
  const m = request.method.toUpperCase();
  if (m === "GET" || m === "HEAD") return;
  const path = decodedPath(normalizeOpencodeProxyPath(proxyPath));
  if (!/^\/+mcp(\/|$)/i.test(path) && !(await writesMcpConfig(request, path))) return;
  throw new ApiError(
    403,
    "forbidden",
    `MCP servers are managed through the instance API at ${INSTANCE_API_MCP_PATH}`,
    { instanceApi: INSTANCE_API_MCP_PATH },
  );
}

/** Puts every `mcp` entry of a raw opencode config write through the same gate as an MCP add. */
export async function gateOpencodeConfigMcp(
  opencode: Record<string, unknown> | undefined,
): Promise<void> {
  const mcp = opencode?.mcp;
  if (!mcp || typeof mcp !== "object" || Array.isArray(mcp)) return;
  for (const [name, entry] of Object.entries(mcp)) {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      await gateMcpAdd(name, entry as Record<string, unknown>);
    }
  }
}

/** A config read back from the list carries the placeholder for each value; writing it would overwrite the real secrets. */
export function assertNoRedactedValues(update: McpServerUpdateRequest): void {
  const config = update.config;
  if (!config) return;
  const values = config.type === "local" ? config.environment : config.headers;
  if (!values || !Object.values(values).includes(MCP_REDACTED_VALUE)) return;
  throw new ApiError(
    400,
    "invalid_mcp_config",
    `The config contains the redaction placeholder "${MCP_REDACTED_VALUE}"; send the real values to change them`,
  );
}
