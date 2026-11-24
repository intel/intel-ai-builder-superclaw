/**
 * Pure pieces of the two host placements an added local command can take: running on this computer
 * through the host MCP gateway, or staying in the sandbox and driving the host's SuperClaw Edge.
 */
import type {
  HostMcpApprovalMode,
  HostMcpErrorCode,
  HostMcpRuntimeEndpoint,
} from "@different-ai/openwork-contracts/host-mcp-api";
import type { McpServerConfig } from "~/shared/types/mcp";
import type { McpDirectoryInfo } from "~/shared/util/constants";
import { COLD_START_TIMEOUT_MS, isPackageLauncher } from "./mcp-config";

/**
 * `host`: the gateway runs the command as the user and the workspace stores a remote entry for it.
 * `host_browser`: the command stays a sandboxed local command, pointed at the host Edge's CDP relay.
 */
export type McpPlacement =
  | { kind: "host"; approvalMode: HostMcpApprovalMode }
  | { kind: "host_browser" };

/** `code` is the gateway's, when it refused for a reason the form words itself. */
export type McpConnectResult = { ok: true } | { ok: false; message: string; code?: HostMcpErrorCode };

/*
 * The rules below mirror openwork-server's `isHostBrowserRelayMcp`
 * (`sandbox/server/src/mcp/browser-sandbox-support.ts`), which refuses any other shape; the case
 * table in `mcp-host-placement.test.ts` holds the two alike.
 */
const PLAYWRIGHT_PACKAGE = "@playwright/mcp";
const PLAYWRIGHT_BINARY = "playwright-mcp";
const PLAYWRIGHT_NODE_SCRIPT = "/node_modules/@playwright/mcp/cli.js";

/** Every other browser-automation MCP the server knows, by package and published `bin`. */
const OTHER_BROWSER_PACKAGES = [
  "chrome-devtools-mcp",
  "@executeautomation/playwright-mcp-server",
  "@modelcontextprotocol/server-puppeteer",
  "puppeteer-mcp-server",
];
const OTHER_BROWSER_BINARIES = ["chrome-devtools", "chrome-devtools-mcp", "playwright-mcp-server", "mcp-server-puppeteer"];

/** Launchers whose next argument is the package, with the only options allowed before it. */
const PACKAGE_LAUNCHERS: Readonly<Record<string, ReadonlySet<string>>> = {
  npx: new Set(["-y", "--yes"]),
  bunx: new Set(["--bun"]),
};

/**
 * `@playwright/mcp` options that leave the browser source alone and work through the relay; the
 * server refuses any other (`--proxy-server`, `--grant-permissions`, `--storage-state`, `--device`
 * and `--mobile` among them: the relay refuses what they send, or Playwright exits).
 */
const RELAY_SAFE_OPTIONS: ReadonlySet<string> = new Set([
  "--cdp-endpoint",
  "--allowed-hosts", "--allowed-origins", "--allow-unrestricted-file-access", "--blocked-origins",
  "--block-service-workers", "--caps", "--cdp-header", "--cdp-timeout", "--codegen", "--console-level",
  "--file-paths", "--headless", "--host", "--idle-timeout",
  "--ignore-https-errors", "--ignore-roots", "--image-responses", "--init-page", "--init-script",
  "--isolated", "--no-webmcp", "--output-dir", "--output-max-size", "--port",
  "--proxy-bypass", "--redact-url-params", "--save-session", "--secrets",
  "--shared-browser-context", "--snapshot-boxes", "--snapshot-mode",
  "--test-id-attribute", "--timeout-action", "--timeout-navigation", "--timeout-settle",
  "--user-agent", "--viewport-size",
]);

/** Each option also reads `PLAYWRIGHT_MCP_<OPTION>`, so these names may not be in the environment. */
const RELAY_UNSAFE_ENVIRONMENT: ReadonlySet<string> = new Set([
  "CDP_ENDPOINT", "EXTENSION", "ENDPOINT", "CONFIG", "BROWSER", "EXECUTABLE_PATH", "USER_DATA_DIR",
  "PROFILE_DIR_NAME", "SANDBOX", "NO_SANDBOX", "ISOLATED", "PROXY_SERVER", "GRANT_PERMISSIONS",
  "STORAGE_STATE", "DEVICE", "MOBILE",
].map((name) => `PLAYWRIGHT_MCP_${name}`));

/**
 * Removed by the conversion: they would point Playwright at a browser other than the relay. Any
 * `--isolated` goes too, and the bare switch is appended with the endpoint: the relay serves only
 * the contexts Playwright creates in isolated mode.
 */
const STRIPPED_VALUE_FLAGS: ReadonlySet<string> = new Set(["--cdp-endpoint", "--browser"]);
const STRIPPED_SWITCHES: ReadonlySet<string> = new Set(["--headless", "--extension", "--isolated"]);

function programName(part: string): string {
  const value = part.trim().toLowerCase();
  return value.slice(Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\")) + 1).replace(/\.(exe|cmd|bat)$/, "");
}

function isPlaywrightPackage(part: string): boolean {
  const value = part.trim().toLowerCase();
  return value === PLAYWRIGHT_PACKAGE || value.startsWith(`${PLAYWRIGHT_PACKAGE}@`);
}

function isOtherBrowserTool(part: string): boolean {
  const value = part.trim().toLowerCase();
  return OTHER_BROWSER_PACKAGES.some((pkg) => value === pkg || value.startsWith(`${pkg}@`))
    || OTHER_BROWSER_BINARIES.includes(programName(part));
}

/** Where `@playwright/mcp`'s own arguments start, or -1 when it is not the program being launched. */
function playwrightArgsStart(command: readonly string[]): number {
  const program = programName(command[0] ?? "");
  if (program === PLAYWRIGHT_BINARY) return 1;
  if (program === "node") {
    return (command[1] ?? "").replace(/\\/g, "/").toLowerCase().endsWith(PLAYWRIGHT_NODE_SCRIPT) ? 2 : -1;
  }
  let index = 1;
  let allowed = PACKAGE_LAUNCHERS[program];
  if (program === "pnpm" && command[1] === "dlx") {
    index = 2;
    allowed = new Set();
  }
  if (!allowed) return -1;
  while (index < command.length && allowed.has(command[index] ?? "")) index += 1;
  return isPlaywrightPackage(command[index] ?? "") ? index + 1 : -1;
}

const optionName = (arg: string) => arg.split("=", 1)[0] ?? arg;

/**
 * Whether "Use SuperClaw browser" may be offered: `@playwright/mcp` is the program launched, no other
 * browser-automation tool and no `--config` appear, and once converted every option is one the
 * server lets through, with no `PLAYWRIGHT_MCP_*` variable that picks another browser.
 */
export function isPlaywrightMcpCommand(
  command: readonly string[],
  environment: Readonly<Record<string, string>> = {},
): boolean {
  const start = playwrightArgsStart(command);
  if (start < 0 || command.some(isOtherBrowserTool)) return false;
  if (command.slice(start).some((arg) => optionName(arg) === "--config")) return false;
  if (Object.keys(environment).some((name) => RELAY_UNSAFE_ENVIRONMENT.has(name.toUpperCase()))) return false;
  return withHostBrowserEndpoint(command, "")
    .slice(start)
    .every((arg) => !arg.startsWith("-") || RELAY_SAFE_OPTIONS.has(optionName(arg)));
}

/**
 * The command with `--cdp-endpoint <endpoint> --isolated` appended and any `--cdp-endpoint`,
 * `--browser`, `--headless`, `--extension` or `--isolated` among Playwright's own arguments removed.
 * A value flag written without a value does not take the next option with it. Arguments before the
 * package are the launcher's (`npx -y`) and are kept as written.
 */
export function withHostBrowserEndpoint(command: readonly string[], cdpEndpoint: string): string[] {
  const start = playwrightArgsStart(command);
  if (start < 0) return [...command];
  const kept = command.slice(0, start);
  for (let index = start; index < command.length; index += 1) {
    const arg = command[index] ?? "";
    const option = optionName(arg);
    if (STRIPPED_SWITCHES.has(option)) continue;
    if (STRIPPED_VALUE_FLAGS.has(option)) {
      const next = command[index + 1];
      if (!arg.includes("=") && next !== undefined && !next.startsWith("-")) index += 1;
      continue;
    }
    kept.push(arg);
  }
  return [...kept, "--cdp-endpoint", cdpEndpoint, "--isolated"];
}

/** The workspace entry for a host server: the gateway's runtime endpoint, never the command. */
export function hostRemoteConfig(
  command: readonly string[],
  runtime: HostMcpRuntimeEndpoint,
): McpServerConfig & { type: "remote"; url: string } {
  return {
    type: "remote",
    enabled: true,
    url: runtime.url,
    headers: { ...runtime.headers },
    oauth: false,
    ...(isPackageLauncher(command) ? { timeout: COLD_START_TIMEOUT_MS } : {}),
  };
}

/** The register request for a local entry: its command, environment and the chosen approval mode. */
export function hostRegisterRequest(entry: McpDirectoryInfo, approvalMode: HostMcpApprovalMode) {
  return {
    command: [...(entry.command ?? [])],
    ...(entry.environment && Object.keys(entry.environment).length > 0
      ? { environment: { ...entry.environment } }
      : {}),
    approval_mode: approvalMode,
  };
}
