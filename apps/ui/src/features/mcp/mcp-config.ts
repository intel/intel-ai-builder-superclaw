import type { McpDirectoryInfo } from "~/shared/util/constants";
import type { McpServerConfig, McpStatusMap } from "~/shared/types/mcp";

type BuiltMcpServerConfig =
  | (McpServerConfig & { type: "remote"; url: string })
  | (McpServerConfig & { type: "local"; command: string[] });

/** Connect timeout for an npx/uvx launch, whose first run downloads its package; the engine default is 30 s. */
export const COLD_START_TIMEOUT_MS = 120_000;

/** The executable's base name, lowercased, without a Windows `.exe` / `.cmd` suffix. */
export const launcherName = (command: readonly string[] | undefined) =>
  command?.[0]?.split(/[\\/]/).pop()?.toLowerCase().replace(/\.(cmd|exe)$/, "");

export const isPackageLauncher = (command: readonly string[] | undefined) => {
  const launcher = launcherName(command);
  return launcher === "npx" || launcher === "uvx";
};

const isUvOffline = (key: string) => key.toUpperCase() === "UV_OFFLINE";

/** Environment variable names to show for a server, without the UV_OFFLINE that `buildMcpServerConfig` adds to a uvx launch. */
export const userEnvironmentNames = (
  command: readonly string[] | undefined,
  environment: Record<string, string> | undefined,
) => Object.keys(environment ?? {}).filter((key) => !(launcherName(command) === "uvx" && isUvOffline(key)));

export function mcpAuthRequiresRegistrationReload(
  status: McpStatusMap[string]["status"] | undefined,
): boolean {
  return status === undefined;
}

export function resolveWorkspaceFolderArgument(value: string): string {
  const folderName = value.trim();
  if (!folderName) {
    throw new Error("Enter an Obsidian vault folder name.");
  }
  if (
    folderName === "." ||
    folderName === ".." ||
    folderName.includes("/") ||
    folderName.includes("\\")
  ) {
    throw new Error("Enter only the Obsidian vault folder name, without /workspace.");
  }
  return `/workspace/${folderName}`;
}

export function resolveMcpSetup(
  entry: McpDirectoryInfo,
  values: Record<string, string>,
): McpDirectoryInfo {
  const resolved: McpDirectoryInfo = {
    ...entry,
    command: entry.command ? [...entry.command] : undefined,
    environment: entry.environment ? { ...entry.environment } : undefined,
  };

  for (const input of entry.setup?.inputs ?? []) {
    const value = values[input.key]?.trim() ?? "";
    if (!value) continue;

    if (input.target.kind === "oauth") {
      resolved[input.target.property] = value;
    } else if (input.target.kind === "environment") {
      resolved.environment = {
        ...resolved.environment,
        [input.target.name]: value,
      };
    } else if (input.target.kind === "workspaceFolderArgument") {
      resolved.command = [
        ...(resolved.command ?? []),
        resolveWorkspaceFolderArgument(value),
      ];
    } else {
      resolved.command = [...(resolved.command ?? []), value];
    }
  }

  return resolved;
}

export function buildMcpServerConfig(entry: McpDirectoryInfo): BuiltMcpServerConfig {
  const type = entry.type ?? "remote";

  if (type === "remote") {
    if (!entry.url) throw new Error("Missing MCP URL.");
    return {
      type,
      enabled: true,
      url: entry.url,
      ...(entry.headers && Object.keys(entry.headers).length > 0
        ? { headers: { ...entry.headers } }
        : {}),
      ...(entry.oauth ? { oauth: {
        ...(entry.clientId ? { clientId: entry.clientId } : {}),
        ...(entry.clientSecret ? { clientSecret: entry.clientSecret } : {}),
      } } : {}),
      ...(entry.environment && Object.keys(entry.environment).length > 0
        ? { environment: { ...entry.environment } }
        : {}),
      ...(entry.timeout ? { timeout: entry.timeout } : {}),
    };
  }

  if (!entry.command?.length) throw new Error("Missing MCP command.");
  // The native runtime sets UV_OFFLINE=1 for its agent shell, so agent tool installs stay offline.
  // A uvx launch has to fetch its package, so it overrides that for its own process only.
  const isUvx = launcherName(entry.command) === "uvx";
  const timeout = entry.timeout ?? (isPackageLauncher(entry.command) ? COLD_START_TIMEOUT_MS : undefined);
  const environment = {
    ...(isUvx && !Object.keys(entry.environment ?? {}).some(isUvOffline)
      ? { UV_OFFLINE: "0" }
      : {}),
    ...entry.environment,
  };
  return {
    type,
    enabled: true,
    command: [...entry.command],
    ...(Object.keys(environment).length > 0
      ? { environment }
      : {}),
    ...(timeout ? { timeout } : {}),
  };
}
