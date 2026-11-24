/**
 * Deletes the `agent.<name>.permission["<mcp>_*"]` grants the retired config
 * injector wrote into the workspace config, so that MCP authorization is decided
 * only by the tool gate.
 *
 * Deletion-only, hence idempotent, hence no completion marker to keep correct.
 *
 * Scope is deliberately the injector's EXACT output shape: it created the whole
 * `agent.<name>` entry, so a matching entry has `permission` as its only key and
 * nothing in that permission map except `<mcp>_*: "allow"`. Anything else is
 * treated as authored by someone and preserved, then reported.
 *
 * Preserving is safe, and deleting is not. A surviving grant is resolved by the
 * engine and therefore reaches the gate through `GET /agent`, which is exactly the
 * gate's input — so a leftover injector grant on `superclaw-default` re-states what
 * the gate already decides. A user-authored grant, on the other hand, is how a
 * customized agent expresses which MCP it may use, so deleting it would silently
 * revoke a feature the user configured.
 *
 * Grants whose MCP server is no longer configured are also left alone: their tools
 * do not exist so the key is inert, and matching every `<x>_*` key instead would
 * risk deleting an unrelated permission of the same shape.
 */
import { readJsoncFile, updateJsoncTopLevel } from "../jsonc.js";
import { listMcp } from "./mcp.js";
import { opencodeConfigPath } from "../workspace-files.js";

export type McpPermissionMigrationResult = {
  removedGrants: string[];
  prunedAgents: string[];
  /** Grants left in place because their agent entry carries authored content. */
  preservedGrants: string[];
};

function mcpGrantKeys(permission: Record<string, unknown>, mcpNames: string[]): string[] {
  return mcpNames.map((name) => `${name}_*`).filter((key) => key in permission);
}

// opencode reads any `agent.<name>` key in the workspace config as an agent
// DEFINITION, so a stub left behind after removing its only permission would
// register an agent absent from the active Product Profile. Matching the
// injector's whole entry and
// deleting it outright avoids ever creating such a stub.
function isInjectorAuthoredEntry(
  agentDef: unknown,
  mcpNames: string[],
): agentDef is { permission: Record<string, unknown> } {
  if (!agentDef || typeof agentDef !== "object") return false;
  const keys = Object.keys(agentDef);
  if (keys.length !== 1 || keys[0] !== "permission") return false;
  const permission = (agentDef as { permission?: unknown }).permission;
  if (!permission || typeof permission !== "object") return false;
  const permissionMap = permission as Record<string, unknown>;
  const grants = mcpGrantKeys(permissionMap, mcpNames);
  if (grants.length === 0) return false;
  return Object.entries(permissionMap).every(
    ([key, value]) => grants.includes(key) && value === "allow",
  );
}

export function stripMcpGrantsFromAgentMap(
  agentMap: Record<string, unknown>,
  mcpNames: string[],
): McpPermissionMigrationResult {
  const removedGrants: string[] = [];
  const prunedAgents: string[] = [];
  const preservedGrants: string[] = [];

  for (const [agentName, agentDef] of Object.entries(agentMap)) {
    if (!agentDef || typeof agentDef !== "object") continue;
    const permission = (agentDef as { permission?: unknown }).permission;
    if (!permission || typeof permission !== "object") continue;
    const grants = mcpGrantKeys(permission as Record<string, unknown>, mcpNames);
    if (grants.length === 0) continue;

    if (!isInjectorAuthoredEntry(agentDef, mcpNames)) {
      for (const key of grants) preservedGrants.push(`${agentName}.${key}`);
      continue;
    }

    for (const key of grants) removedGrants.push(`${agentName}.${key}`);
    delete agentMap[agentName];
    prunedAgents.push(agentName);
  }

  return { removedGrants, prunedAgents, preservedGrants };
}

export async function migrateWorkspaceMcpPermissions(
  workspaceRoot: string,
): Promise<McpPermissionMigrationResult> {
  const empty: McpPermissionMigrationResult = {
    removedGrants: [],
    prunedAgents: [],
    preservedGrants: [],
  };

  const mcpNames = (await listMcp(workspaceRoot)).map((item) => item.name);
  if (mcpNames.length === 0) return empty;

  const configPath = opencodeConfigPath(workspaceRoot);
  const { data: config } = await readJsoncFile(configPath, {} as Record<string, unknown>);
  const agent = config.agent;
  if (!agent || typeof agent !== "object") return empty;

  const agentMap = agent as Record<string, unknown>;
  const result = stripMcpGrantsFromAgentMap(agentMap, mcpNames);
  if (result.removedGrants.length === 0 && result.prunedAgents.length === 0) return result;

  await updateJsoncTopLevel(configPath, { agent: agentMap });
  return result;
}
