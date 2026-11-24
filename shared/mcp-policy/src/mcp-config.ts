/**
 * Read-only MCP server discovery: which servers a workspace's `opencode.jsonc`
 * (plus the global config it falls back to) configures, and whether any of
 * them is switched off at the config layer (`tools.deny` pattern or
 * `enabled: false`).
 *
 * This is the read/merge/pattern-matching half of what the sandbox server's
 * `listMcp` does, shared so the channel router — which has no config WRITE
 * path and no serialized config-access queue to join — can resolve the exact
 * same server list and off-switches the server would. A caller that also
 * writes config (the sandbox server) must keep reading through its own
 * serialized queue and its own JSONC error shape, then feed the parsed
 * objects into `resolveMcpServers` — see `sandbox/server/src/mcp/mcp.ts`.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseJsonc, printParseErrorCode } from "jsonc-parser";
import { minimatch } from "minimatch";

export type McpConfigServer = {
  name: string;
  config: Record<string, unknown>;
  source: "config.project" | "config.global";
  disabledByTools?: boolean;
};

export type McpConfigParseErrorDetail = { code: string; offset: number; length: number };

/**
 * A config file exists but could not be read as JSON(C). Unlike a missing
 * file (normal — no MCP configured), this must surface as an explicit
 * failure: reading it as empty would silently permit every server, and on
 * the router's cross-process path a file the sandbox server is mid-rewrite of
 * (`updateJsoncTopLevel` edits in place, not atomically) can legitimately be
 * caught here as transiently unparseable.
 */
export class McpConfigError extends Error {
  constructor(
    readonly path: string,
    readonly reason: string,
    readonly details?: McpConfigParseErrorDetail[],
  ) {
    super(`invalid opencode config ${path}: ${reason}`);
    this.name = "McpConfigError";
  }
}

export function opencodeConfigPath(workspaceRoot: string): string {
  const jsoncPath = join(workspaceRoot, "opencode.jsonc");
  const jsonPath = join(workspaceRoot, "opencode.json");
  if (existsSync(jsoncPath)) return jsoncPath;
  if (existsSync(jsonPath)) return jsonPath;
  return jsoncPath;
}

/**
 * Resolve the global config from the same locations opencode itself reads, in
 * priority order:
 *   1. OPENCODE_CONFIG_DIR      — the live config dir opencode is launched
 *                                 with (the sandbox orchestrator sets this to
 *                                 /opencode-config and copies the mounted host
 *                                 config into it).
 *   2. /persist/.config/opencode — the read-only host config mount.
 *   3. ~/.config/opencode        — legacy fallback for non-sandbox runs.
 */
export function globalOpencodeConfigPath(): string {
  const bases: string[] = [];
  const envConfigDir = process.env.OPENCODE_CONFIG_DIR?.trim();
  if (envConfigDir) bases.push(envConfigDir);
  bases.push("/persist/.config/opencode");
  bases.push(join(homedir(), ".config", "opencode"));

  for (const base of bases) {
    const jsonc = join(base, "opencode.jsonc");
    const json = join(base, "opencode.json");
    if (existsSync(jsonc)) return jsonc;
    if (existsSync(json)) return json;
  }
  return join(bases[0], "opencode.jsonc");
}

/**
 * Read-only JSONC read. A missing file is an empty config object. A present
 * file that fails to parse throws `McpConfigError` rather than falling back
 * to empty.
 */
export async function readOpencodeConfigFile(path: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return {};
    throw new McpConfigError(path, `unreadable: ${String(error)}`);
  }
  return parseOpencodeConfigText(path, raw);
}

/**
 * Parse the text of a config file that exists. `path` only labels errors. An
 * unparseable text throws `McpConfigError`; a non-object document is `{}`.
 */
export function parseOpencodeConfigText(path: string, raw: string): Record<string, unknown> {
  const errors: { error: number; offset: number; length: number }[] = [];
  const data = parseJsonc(raw, errors, { allowTrailingComma: true }) as unknown;
  if (errors.length > 0) {
    const details = errors.map((error) => ({
      code: printParseErrorCode(error.error),
      offset: error.offset,
      length: error.length,
    }));
    throw new McpConfigError(path, "unparseable", details);
  }
  return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
}

function getMcpConfigSection(config: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const mcp = config.mcp;
  if (!mcp || typeof mcp !== "object") return {};
  return mcp as Record<string, Record<string, unknown>>;
}

function getDeniedToolPatterns(config: Record<string, unknown>): string[] {
  const tools = config.tools;
  if (!tools || typeof tools !== "object") return [];
  const deny = (tools as { deny?: unknown }).deny;
  if (!Array.isArray(deny)) return [];
  return deny.filter((item): item is string => typeof item === "string");
}

export function isMcpDisabledByTools(config: Record<string, unknown>, name: string): boolean {
  const patterns = getDeniedToolPatterns(config);
  if (patterns.length === 0) return false;
  const candidates = [`mcp.${name}`, `mcp.${name}.*`, `mcp:${name}`, `mcp:${name}:*`, "mcp.*", "mcp:*"];
  return patterns.some((pattern) => candidates.some((candidate) => minimatch(candidate, pattern)));
}

/**
 * Pure merge of already-parsed project + global config objects into the
 * precedence-ordered server list: global MCPs first, then project MCPs
 * (which override a global entry of the same name). A global entry's
 * disabled-by-tools check also honours a PROJECT `tools.deny` pattern (a
 * project can reach into a global server), but a project entry's check only
 * honours its own config.
 */
export function resolveMcpServers(params: {
  projectConfig: Record<string, unknown>;
  globalConfig?: Record<string, unknown>;
}): McpConfigServer[] {
  const { projectConfig, globalConfig = {} } = params;
  const projectMcpMap = getMcpConfigSection(projectConfig);
  const globalMcpMap = getMcpConfigSection(globalConfig);

  const items: McpConfigServer[] = [];

  for (const [name, entry] of Object.entries(globalMcpMap)) {
    if (Object.prototype.hasOwnProperty.call(projectMcpMap, name)) continue;
    items.push({
      name,
      config: entry,
      source: "config.global",
      disabledByTools: isMcpDisabledByTools(globalConfig, name) || isMcpDisabledByTools(projectConfig, name) || undefined,
    });
  }

  for (const [name, entry] of Object.entries(projectMcpMap)) {
    items.push({
      name,
      config: entry,
      source: "config.project",
      disabledByTools: isMcpDisabledByTools(projectConfig, name) || undefined,
    });
  }

  return items;
}

/**
 * Full read-only discovery for a caller with no competing config writes (the
 * channel router): reads project + optional global config straight from disk
 * and merges them. Explicitly NOT used by the sandbox server, which must read
 * through its own serialized config-access queue — see
 * `sandbox/server/src/mcp/mcp.ts`.
 */
export async function listMcpServers(
  workspaceRoot: string,
  options: { includeGlobal?: boolean } = {},
): Promise<McpConfigServer[]> {
  const includeGlobal = options.includeGlobal ?? true;
  const projectConfig = await readOpencodeConfigFile(opencodeConfigPath(workspaceRoot));
  const globalConfig = includeGlobal ? await readOpencodeConfigFile(globalOpencodeConfigPath()) : {};
  return resolveMcpServers({ projectConfig, globalConfig });
}
