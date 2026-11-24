import { ApiError } from "./errors.js";

const SKILL_NAME_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const COMMAND_NAME_REGEX = /^[A-Za-z0-9_-]+$/;
const MCP_NAME_REGEX = /^[A-Za-z0-9_-]+$/;

export function validateSkillName(name: string): void {
  if (!name || name.length < 1 || name.length > 64 || !SKILL_NAME_REGEX.test(name)) {
    throw new ApiError(400, "invalid_skill_name", "Skill name must be kebab-case (1-64 chars)");
  }
}

export function validateDescription(description: string | undefined): void {
  if (!description || description.length < 1 || description.length > 1024) {
    throw new ApiError(422, "invalid_description", "Description must be 1-1024 characters");
  }
}

export function validatePluginSpec(spec: string): void {
  if (!spec || spec.trim().length === 0) {
    throw new ApiError(400, "invalid_plugin_spec", "Plugin spec is required");
  }
}

export function sanitizeCommandName(name: string): string {
  const trimmed = name.trim().replace(/^\/+/, "");
  return trimmed;
}

export function validateCommandName(name: string): void {
  if (!name || !COMMAND_NAME_REGEX.test(name)) {
    throw new ApiError(400, "invalid_command_name", "Command name must be alphanumeric with _ or -");
  }
}

export function validateMcpName(name: string): void {
  if (!name || name.startsWith("-") || !MCP_NAME_REGEX.test(name)) {
    throw new ApiError(400, "invalid_mcp_name", "MCP name must be alphanumeric and not start with -");
  }
}

/**
 * MCP tools are namespaced `<server>_<tool>`, and a permission key is
 * `<server>_*`, so a server name that is another name plus `_` makes tool
 * attribution ambiguous — an agent granted only `foo` reaches every tool of
 * `foo_bar`. The per-message `tools` map outranks the agent permission ruleset,
 * so no later layer can undo it; the names have to be kept unambiguous instead.
 */
export function validateMcpNameCollision(name: string, existingNames: Iterable<string>): void {
  for (const existing of existingNames) {
    if (existing === name) continue;
    if (!name.startsWith(`${existing}_`) && !existing.startsWith(`${name}_`)) continue;
    throw new ApiError(
      409,
      "mcp_name_prefix_collision",
      `MCP name "${name}" collides with the already configured "${existing}": one is a prefix of another MCP server name followed by "_", which makes tool names like "${name}_search" ambiguous between the two servers. Rename one of them, for example with "-" instead of "_".`,
    );
  }
}

export function validateMcpConfig(config: Record<string, unknown>): void {
  const type = config.type;
  if (type !== "local" && type !== "remote") {
    throw new ApiError(400, "invalid_mcp_config", "MCP config type must be local or remote");
  }
  if (type === "local") {
    const command = config.command;
    if (!Array.isArray(command) || command.length === 0) {
      throw new ApiError(400, "invalid_mcp_config", "Local MCP requires command array");
    }
  }
  if (type === "remote") {
    const url = config.url;
    if (!url || typeof url !== "string") {
      throw new ApiError(400, "invalid_mcp_config", "Remote MCP requires url");
    }
  }
}
