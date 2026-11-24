import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { McpItem } from "../types.js";
import { ApiError } from "../errors.js";
import { readJsoncFile, updateJsoncTopLevel } from "../jsonc.js";
import { removeServerPolicy, setToolsPolicy, type McpToolAction } from "./mcp-policy-store.js";
import { opencodeConfigPath } from "../workspace-files.js";
import { validateMcpConfig, validateMcpName, validateMcpNameCollision } from "../validators.js";
import {
  globalOpencodeConfigPath as globalOpenCodeConfigPath,
  resolveMcpServers,
} from "@different-ai/openwork-mcp-policy";

function getMcpConfig(config: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const mcp = config.mcp;
  if (!mcp || typeof mcp !== "object") return {};
  return mcp as Record<string, Record<string, unknown>>;
}

export function validateObsidianVaultConfig(
  workspaceRoot: string,
  config: Record<string, unknown>,
): void {
  const command = config.command;
  if (
    !Array.isArray(command) ||
    !command.some(
      (argument) =>
        typeof argument === "string" && argument.startsWith("@bitbonsai/mcpvault@"),
    )
  ) {
    return;
  }

  const vaultPath = command.at(-1);
  if (typeof vaultPath !== "string" || !vaultPath.startsWith("/workspace/")) {
    throw new ApiError(
      400,
      "invalid_obsidian_vault",
      "Enter an Obsidian vault folder name from %USERPROFILE%\\SuperClawProjects.",
    );
  }

  const vaultName = vaultPath.slice("/workspace/".length);
  if (
    !vaultName ||
    vaultName === "." ||
    vaultName === ".." ||
    vaultName.includes("/") ||
    vaultName.includes("\\")
  ) {
    throw new ApiError(
      400,
      "invalid_obsidian_vault",
      "Enter only the Obsidian vault folder name, without /workspace.",
    );
  }

  const vaultDirectory = join(workspaceRoot, vaultName);
  let isDirectory = false;
  try {
    isDirectory = statSync(vaultDirectory).isDirectory();
  } catch {
    // A missing, inaccessible, or concurrently removed vault is invalid.
  }
  if (!isDirectory) {
    throw new ApiError(
      400,
      "obsidian_vault_not_found",
      `Obsidian vault "${vaultName}" was not found in %USERPROFILE%\\SuperClawProjects.`,
    );
  }
}

type ListMcpOptions = {
  includeGlobal?: boolean;
};

/**
 * Reads through the serialized config-access queue so a concurrent write
 * cannot race a read into a partial file; the merge itself is the shared
 * `resolveMcpServers`.
 */
export async function listMcp(workspaceRoot: string, options: ListMcpOptions = {}): Promise<McpItem[]> {
  const includeGlobal = options.includeGlobal ?? true;
  const { data: config } = await serializeConfigAccess(workspaceRoot, () =>
    readJsoncFile(opencodeConfigPath(workspaceRoot), {} as Record<string, unknown>));
  const { data: globalConfig } = includeGlobal
    ? await readJsoncFile(globalOpenCodeConfigPath(), {} as Record<string, unknown>)
    : { data: {} as Record<string, unknown> };

  return resolveMcpServers({ projectConfig: config, globalConfig });
}

const configWrites = new Map<string, Promise<unknown>>();

/**
 * Each write reads and rewrites the whole `mcp` map, so two concurrent writes to one
 * workspace would drop one change. They run one at a time per workspace instead.
 * Reads queue too: a write rewrites the file in place, so a read beside it can see
 * a partial file and fail to parse.
 */
function serializeConfigAccess<T>(workspaceRoot: string, task: () => Promise<T>): Promise<T> {
  const key = opencodeConfigPath(workspaceRoot);
  const run = (configWrites.get(key) ?? Promise.resolve()).then(task);
  const settled = run.catch(() => undefined);
  configWrites.set(key, settled);
  void settled.then(() => {
    if (configWrites.get(key) === settled) configWrites.delete(key);
  });
  return run;
}

export function addMcp(
  workspaceRoot: string,
  name: string,
  config: Record<string, unknown>,
): Promise<{ action: "added" | "updated" }> {
  return serializeConfigAccess(workspaceRoot, () => writeProjectMcp(workspaceRoot, name, config));
}

export function removeMcp(workspaceRoot: string, name: string): Promise<boolean> {
  return serializeConfigAccess(workspaceRoot, () => removeProjectMcp(workspaceRoot, name));
}

/** The project-level entry only: a global entry is not this workspace's to edit. */
export function readProjectMcp(workspaceRoot: string, name: string): Promise<Record<string, unknown> | null> {
  return serializeConfigAccess(workspaceRoot, () => readProjectEntry(workspaceRoot, name));
}

/**
 * Writes tool policy only while `name` is still configured, checked and written in the
 * queued step a removal runs in: a write approved after the removal would otherwise put
 * the policy back, and a same-named server added later would inherit its denies.
 */
export function setConfiguredToolsPolicy(
  workspaceRoot: string,
  name: string,
  tools: readonly string[],
  action: McpToolAction,
): Promise<string[]> {
  return serializeConfigAccess(workspaceRoot, async () => {
    const { data: globalData } = await readJsoncFile(globalOpenCodeConfigPath(), {} as Record<string, unknown>);
    const configured = (await readProjectEntry(workspaceRoot, name))
      || Object.prototype.hasOwnProperty.call(getMcpConfig(globalData), name);
    if (!configured) {
      throw new ApiError(404, "mcp_not_found", `MCP server "${name}" is not configured in this workspace`);
    }
    return setToolsPolicy(workspaceRoot, name, tools, action);
  });
}

/**
 * Writes `config` only if the project entry still equals `expected`, checked and written
 * in one queued step. A caller that read, then waited on approval, must not overwrite a
 * change that landed meanwhile, and the value written must be the one it gated.
 */
export function replaceProjectMcp(
  workspaceRoot: string,
  name: string,
  expected: Record<string, unknown>,
  config: Record<string, unknown>,
): Promise<{ action: "added" | "updated" }> {
  return serializeConfigAccess(workspaceRoot, async () => {
    const current = await readProjectEntry(workspaceRoot, name);
    if (!current) {
      throw new ApiError(404, "mcp_not_found", `MCP server "${name}" is not configured in this workspace`);
    }
    if (!isDeepStrictEqual(current, expected)) {
      throw new ApiError(409, "mcp_update_conflict", `MCP server "${name}" changed while this update waited; retry it`);
    }
    return writeProjectMcp(workspaceRoot, name, config);
  });
}

async function readProjectEntry(workspaceRoot: string, name: string): Promise<Record<string, unknown> | null> {
  const { data } = await readJsoncFile(opencodeConfigPath(workspaceRoot), {} as Record<string, unknown>);
  const mcpMap = getMcpConfig(data);
  const entry = Object.prototype.hasOwnProperty.call(mcpMap, name) ? mcpMap[name] : undefined;
  return entry && typeof entry === "object" ? entry : null;
}

async function writeProjectMcp(
  workspaceRoot: string,
  name: string,
  config: Record<string, unknown>,
): Promise<{ action: "added" | "updated" }> {
  validateMcpName(name);
  validateMcpConfig(config);
  validateObsidianVaultConfig(workspaceRoot, config);
  const { data } = await readJsoncFile(opencodeConfigPath(workspaceRoot), {} as Record<string, unknown>);
  const mcpMap = getMcpConfig(data);
  // Global names count too: the engine registers the merged set, so that is the
  // set a tool name has to stay unambiguous within.
  const { data: globalData } = await readJsoncFile(
    globalOpenCodeConfigPath(),
    {} as Record<string, unknown>,
  );
  validateMcpNameCollision(name, [
    ...Object.keys(mcpMap),
    ...Object.keys(getMcpConfig(globalData)),
  ]);
  const existed = Object.prototype.hasOwnProperty.call(mcpMap, name);
  mcpMap[name] = config;
  await updateJsoncTopLevel(opencodeConfigPath(workspaceRoot), { mcp: mcpMap });

  return { action: existed ? "updated" : "added" };
}

async function removeProjectMcp(workspaceRoot: string, name: string): Promise<boolean> {
  const { data } = await readJsoncFile(opencodeConfigPath(workspaceRoot), {} as Record<string, unknown>);
  const mcpMap = getMcpConfig(data);
  if (!Object.prototype.hasOwnProperty.call(mcpMap, name)) return false;
  delete mcpMap[name];
  await updateJsoncTopLevel(opencodeConfigPath(workspaceRoot), { mcp: mcpMap });
  // Best-effort: the server is already gone, so a retry could not reach this
  // again. A leftover entry can only deny tools of a same-named server re-added later.
  try {
    // The policy is keyed by name, so a global server this entry shadowed is now
    // governed by it; dropping it would open that server's denied tools.
    const { data: globalData } = await readJsoncFile(globalOpenCodeConfigPath(), {} as Record<string, unknown>);
    if (Object.prototype.hasOwnProperty.call(getMcpConfig(globalData), name)) {
      console.log(`[mcp] removed project ${name}; kept its tool policy for the global ${name}`);
      return true;
    }
    await removeServerPolicy(workspaceRoot, name);
  } catch (error) {
    console.warn(`[mcp] removed ${name} but kept its tool policy: ${String(error)}`);
  }

  return true;
}
