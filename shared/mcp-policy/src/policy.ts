/**
 * Per-workspace MCP tool policy: which individual tools of a configured MCP
 * server the user has switched off. Shared between the sandbox server (which
 * owns writes) and the channel router (which only ever reads it).
 *
 * Location: `<workspaceRoot>/.opencode/superclaw-mcp-policy.json`, beside the
 * other SuperClaw-owned workspace state (`openwork.json`) and next to the
 * workspace `opencode.jsonc` the MCP config resolver reads the servers from.
 *
 * Shape: `{ "schemaVersion": 1, "servers": { "<server>": { "<raw tool>": "allow" | "deny" } } }`.
 * Tool names are stored raw (as the MCP server reports them); the engine-side
 * key is derived with `mcpToolKey`. Allow is the default, but a tool that was
 * denied and then re-allowed keeps an explicit `allow` entry: the engine has
 * already persisted the earlier deny onto live sessions, and a gate reading
 * this file can only recognise that echo as its own if the tool is still named
 * here. That echo is indistinguishable from a foreign deny of the same key, so
 * it stays in the policy: a re-allow reaches new sessions, not ones that
 * already carry the deny.
 *
 * A missing file is an empty policy. A malformed, partially invalid or
 * other-`schemaVersion` file throws `McpPolicyError`: reading it as empty
 * would silently re-allow every denied tool, so callers must fail closed
 * instead.
 *
 * Writes are server-owned (see `sandbox/server/src/mcp/mcp-policy-store.ts`)
 * and are intentionally NOT part of this package: this module only reads.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type McpToolAction = "allow" | "deny";

/** server -> raw tool name -> action. */
export type McpToolPolicy = Record<string, Record<string, McpToolAction>>;

export const MCP_POLICY_FILE = "superclaw-mcp-policy.json";

export function mcpPolicyPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".opencode", MCP_POLICY_FILE);
}

/**
 * The engine's tool name for an MCP tool: opencode (mcp/catalog.ts) replaces every
 * character outside `[a-zA-Z0-9_-]` with `_` in both halves, per UTF-16 code unit.
 */
export function sanitizeMcpName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function mcpToolKey(server: string, tool: string): string {
  return `${sanitizeMcpName(server)}_${sanitizeMcpName(tool)}`;
}

function isAction(value: unknown): value is McpToolAction {
  return value === "allow" || value === "deny";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export class McpPolicyError extends Error {
  constructor(
    readonly path: string,
    reason: string,
  ) {
    super(`invalid MCP tool policy ${path}: ${reason}`);
    this.name = "McpPolicyError";
  }
}

/** The reason `input` is not a valid policy file, or the policy it holds. */
function parsePolicy(input: unknown): McpToolPolicy | string {
  if (!isRecord(input) || !isRecord(input.servers)) return "expected { servers: { ... } }";
  if (input.schemaVersion !== 1) return `unsupported schemaVersion ${JSON.stringify(input.schemaVersion)}`;
  // Null-prototype maps: `__proto__` is a valid server or tool name.
  const policy: McpToolPolicy = Object.create(null);
  for (const [server, tools] of Object.entries(input.servers)) {
    if (!isRecord(tools)) return `servers.${server} is not an object`;
    const actions: Record<string, McpToolAction> = Object.create(null);
    for (const [tool, action] of Object.entries(tools)) {
      if (!isAction(action)) return `servers.${server}.${tool} is neither "allow" nor "deny"`;
      actions[tool] = action;
    }
    policy[server] = actions;
  }
  return policy;
}

export async function readPolicy(workspaceRoot: string): Promise<McpToolPolicy> {
  const path = mcpPolicyPath(workspaceRoot);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return Object.create(null);
    console.warn(`[mcp-policy] ${path} is unreadable (${code ?? "unknown"}); MCP is withheld until it is fixed`);
    throw new McpPolicyError(path, `unreadable: ${String(error)}`);
  }
  return parsePolicyText(path, raw);
}

/**
 * Parse the text of a policy file that exists. `path` only labels errors. A
 * malformed, partially invalid or other-`schemaVersion` text warns and throws
 * `McpPolicyError` (callers fail closed).
 */
export function parsePolicyText(path: string, raw: string): McpToolPolicy {
  let result: McpToolPolicy | string;
  try {
    result = parsePolicy(JSON.parse(raw));
  } catch (error) {
    result = `unparseable: ${String(error)}`;
  }
  if (typeof result === "string") {
    console.warn(`[mcp-policy] ${path} is invalid (${result}); MCP is withheld until it is fixed`);
    throw new McpPolicyError(path, result);
  }
  return result;
}

/** Raw names of the tools denied for one server. */
export function deniedTools(policy: McpToolPolicy, server: string): string[] {
  const tools = Object.prototype.hasOwnProperty.call(policy, server) ? policy[server] : {};
  return Object.entries(tools)
    .filter(([, action]) => action === "deny")
    .map(([tool]) => tool);
}

/**
 * Ordered engine-side deny keys for every denied tool of `server`, in the raw
 * policy's own insertion order. A thin convenience over `deniedTools` +
 * `mcpToolKey`, kept here so both consumers derive deny keys identically.
 */
export function deniedToolKeys(policy: McpToolPolicy, server: string): string[] {
  return deniedTools(policy, server).map((tool) => mcpToolKey(server, tool));
}
