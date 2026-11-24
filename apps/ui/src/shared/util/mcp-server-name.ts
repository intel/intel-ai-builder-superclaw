/**
 * MCP server-name validation.
 *
 * Lives in `shared/` rather than with the `mcp` slice because it is a plain
 * string validator with no MCP domain knowledge, and `shared/platform/tauri`
 * needs it — a slice-owned copy would be a forbidden `shared/ -> features/` edge.
 */

export function validateMcpServerName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("server_name is required");
  }
  if (trimmed.startsWith("-")) {
    throw new Error("server_name must not start with '-'");
  }
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) {
    throw new Error("server_name must be alphanumeric with '-' or '_'");
  }
  return trimmed;
}
