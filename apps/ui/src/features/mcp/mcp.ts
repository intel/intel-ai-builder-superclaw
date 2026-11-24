import { validateMcpServerName } from "~/shared/util/mcp-server-name";

export function mcpServerSlug(name: string): string {
  return validateMcpServerName(
    name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""),
  );
}

/** The configured server key: `id` when the entry names an existing server, else the slug of its display name. */
export function mcpServerKey(entry: { id?: string; name: string }): string {
  return entry.id ?? mcpServerSlug(entry.name);
}
