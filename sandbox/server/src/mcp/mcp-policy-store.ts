/**
 * Per-workspace MCP tool policy: which individual tools of a configured MCP
 * server the user has switched off. SuperClaw owns this file; the engine never
 * reads it. `buildToolGate` projects it into the per-message `tools` map.
 *
 * Reading, validation, types and the key helpers live in the shared
 * `@different-ai/openwork-mcp-policy` package (also used read-only by the
 * channel router, which enforces the same policy over its own HTTP transport)
 * and are re-exported here unchanged. This module adds the one thing that
 * stays server-owned: WRITES, and the serialization that keeps two concurrent
 * writes from losing one.
 *
 * Writes are atomic (temp file + rename) and serialized within this process.
 */
import { rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ensureDir } from "../utils.js";

export {
  MCP_POLICY_FILE,
  McpPolicyError,
  deniedTools,
  deniedToolKeys,
  mcpPolicyPath,
  mcpToolKey,
  readPolicy,
  sanitizeMcpName,
  type McpToolAction,
  type McpToolPolicy,
} from "@different-ai/openwork-mcp-policy";

import { mcpPolicyPath, mcpToolKey, readPolicy, type McpToolAction, type McpToolPolicy } from "@different-ai/openwork-mcp-policy";

type PolicyFile = { schemaVersion: 1; servers: McpToolPolicy };

async function writePolicy(workspaceRoot: string, policy: McpToolPolicy): Promise<void> {
  const path = mcpPolicyPath(workspaceRoot);
  await ensureDir(dirname(path));
  const payload: PolicyFile = { schemaVersion: 1, servers: policy };
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(payload, null, 2) + "\n", "utf8");
    await rename(temporary, path);
  } catch (error) {
    try {
      await rm(temporary, { force: true });
    } catch {
      // The write error is the one worth surfacing.
    }
    throw error;
  }
}

let writeQueue: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(task);
  writeQueue = run.catch(() => undefined);
  return run;
}

export async function setToolPolicy(
  workspaceRoot: string,
  server: string,
  tool: string,
  action: McpToolAction,
): Promise<void> {
  await setToolsPolicy(workspaceRoot, server, [tool], action);
}

/**
 * Sets `tools` and every stored name sharing one of their engine keys, and
 * answers the raw names written. The aliases are found inside the queued write:
 * found outside it, concurrent writes to two names of one key could leave one
 * deny and one allow, and the deny still disables both.
 */
export function setToolsPolicy(
  workspaceRoot: string,
  server: string,
  tools: readonly string[],
  action: McpToolAction,
): Promise<string[]> {
  return enqueue(async () => {
    const policy = await readPolicy(workspaceRoot);
    const keys = new Set(tools.map((tool) => mcpToolKey(server, tool)));
    const aliases = Object.keys(policy[server] ?? {}).filter((tool) => keys.has(mcpToolKey(server, tool)));
    const written = [...new Set([...tools, ...aliases])];
    policy[server] = {
      ...policy[server],
      ...Object.fromEntries(written.map((tool) => [tool, action])),
    };
    await writePolicy(workspaceRoot, policy);
    return written;
  });
}

export function removeServerPolicy(workspaceRoot: string, server: string): Promise<void> {
  return enqueue(async () => {
    const policy = await readPolicy(workspaceRoot);
    if (!Object.prototype.hasOwnProperty.call(policy, server)) return;
    delete policy[server];
    await writePolicy(workspaceRoot, policy);
  });
}
