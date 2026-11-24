/**
 * Refuses browser-automation MCP servers where the Windows sandbox cannot run them (#3247).
 *
 * Chromium's own sandbox needs a nested Job, and Windows refuses to nest under a Job that has
 * `JobObjectBasicUIRestrictions` (CreateProcess fails with ERROR_NOT_SUPPORTED). The tier Job
 * carries those restrictions, so such a server connects, lists tools, then every call hangs.
 * The signal is measured from the process's own Job, not inferred from the platform.
 * There is deliberately no unsandboxed fallback (`--no-sandbox` and the like).
 */

import { dlopen, FFIType, ptr } from "bun:ffi";
import { isHostMcpCdpEndpoint } from "@different-ai/openwork-contracts/host-mcp-api";
import { ApiError } from "../errors.js";

/**
 * One entry per known browser-automation MCP server. `packages` is matched as an argv element or
 * `<package>@<version>`; `binaries` are the package's published npm `bin` names, matched by
 * basename without a `.exe`/`.cmd`/`.bat` extension (verified against each package's registry
 * metadata). Deliberately excludes `@browsermcp/mcp`: unlike every tool here, it never launches
 * its own Chromium at all — confirmed against its published source, it only attaches to the
 * user's already-running browser via a browser extension — so the Job-nesting conflict (#3247)
 * cannot occur for it in any configuration. Refusing it would be a pure false positive.
 *
 * NOT exempted: attach-only configs for the tools below (`@playwright/mcp --cdp-endpoint`/
 * `--extension`, `chrome-devtools-mcp --browserUrl`/`--autoConnect`), even though those also
 * connect to an already-running browser instead of spawning a sandboxed Chromium child and so
 * also cannot hit the Job-nesting conflict. Unlike `@browsermcp/mcp`, these tools default to a
 * disposable sandboxed browser profile; accepting the attach flags would be a live decision to
 * let the agent drive whatever browser session is on the other end instead — the user's real,
 * logged-in profile, if that is what they point it at. That tradeoff needs the security owner's
 * sign-off (tracked against #3247's option 3/4), not a detection-accuracy fix, so these configs
 * are refused for now like any other browser-automation command.
 *
 * The one exception is `@playwright/mcp`, launched directly or by `npx`/`pnpm dlx`/`bunx`/`node`,
 * whose every `--cdp-endpoint` is the host MCP gateway's CDP relay (`isHostMcpCdpEndpoint`), which
 * runs with `--isolated`, and whose other options, in argv and in `environment`, cannot pick
 * another browser source (`RELAY_SAFE_OPTIONS`). It launches no Chromium, and
 * the other end is not the user's browser: it is a dedicated Edge profile with no user data, behind
 * a relay that filters every CDP message and serves only the off-the-record contexts the client
 * creates (`host/mcp_host_manager/README.md`). `--isolated` is what makes Playwright create one
 * instead of using the browser's default context, which the relay refuses. It is gated on the
 * Profile's `host_browser` flag instead (`assertHostMcpAllowed`).
 */
type BrowserAutomationTool = {
  packages: readonly string[];
  binaries: readonly string[];
};

const PLAYWRIGHT_MCP: BrowserAutomationTool = {
  packages: ["@playwright/mcp"],
  binaries: ["playwright-mcp"],
};

const BROWSER_AUTOMATION_TOOLS: readonly BrowserAutomationTool[] = [
  PLAYWRIGHT_MCP,
  {
    packages: ["chrome-devtools-mcp"],
    binaries: ["chrome-devtools", "chrome-devtools-mcp"],
  },
  {
    packages: ["@executeautomation/playwright-mcp-server"],
    binaries: ["playwright-mcp-server"],
  },
  {
    packages: ["@modelcontextprotocol/server-puppeteer", "puppeteer-mcp-server"],
    binaries: ["mcp-server-puppeteer"],
  },
];

export const BROWSER_MCP_UNSUPPORTED_CODE = "mcp_browser_unsupported_in_sandbox";

const BROWSER_MCP_UNSUPPORTED_REASON =
  "Browser automation MCP servers can't run in SuperClaw's Windows sandbox yet: "
  + "the browser's own sandbox cannot start inside it.";

const JOB_OBJECT_BASIC_UI_RESTRICTIONS = 4;

/** `UIRestrictionsClass` of the calling process's Job, or null when it has no Job or the query fails. */
type UiRestrictionsQuery = () => number | null;

export function jobUiRestrictionsPresent(query: UiRestrictionsQuery): boolean {
  try {
    const restrictions = query();
    return restrictions !== null && restrictions !== 0;
  } catch (error) {
    // The probe failing to answer is not evidence the Job has no UI restrictions: assume the
    // worse case (restricted, so browser automation is refused) rather than silently falling
    // back to the exact hang this module exists to prevent.
    console.warn(`[mcp/browser-sandbox-support] Job UI-restriction probe threw; assuming restricted: ${String(error)}`);
    return true;
  }
}

/**
 * `QueryInformationJobObject` reports a native failure by returning FALSE, not by throwing — and
 * that FALSE is indistinguishable from "not in a Job" unless checked separately. Confusing the two
 * would make an unexpected native failure look like a confirmed, safe "no Job" (null), silently
 * disarming the restricted-by-default fallback in `jobUiRestrictionsPresent`'s catch. So this is
 * split into two steps the caller must not blur: confirm "no Job" via `IsProcessInJob` (its own
 * failure is itself a native error, handled the same way), then only treat a later query failure as
 * an unexpected error (thrown, caught upstream, fail closed) once Job membership is confirmed.
 */
type Win32JobProbe = {
  /** True once confirmed the calling process is a member of some Job. Throws on a native failure. */
  isProcessInJob: () => boolean;
  /** The member Job's `UIRestrictionsClass`. Throws on a native failure; only called once a Job is confirmed. */
  queryUiRestrictions: () => number;
};

/** Exported for tests: the no-Job/native-failure split, without the real FFI calls. */
export function queryOwnJobUiRestrictionsWith(probe: Win32JobProbe): number | null {
  if (!probe.isProcessInJob()) return null;
  return probe.queryUiRestrictions();
}

function queryOwnJobUiRestrictions(): number | null {
  if (process.platform !== "win32") return null;
  const kernel32 = dlopen("kernel32.dll", {
    GetCurrentProcess: {
      args: [],
      returns: FFIType.ptr,
    },
    IsProcessInJob: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    },
    QueryInformationJobObject: {
      args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32, FFIType.ptr],
      returns: FFIType.i32,
    },
  });
  try {
    return queryOwnJobUiRestrictionsWith({
      isProcessInJob: () => {
        // IsProcessInJob's first parameter, unlike QueryInformationJobObject's job handle,
        // does NOT accept NULL for "the calling process" (confirmed empirically: it fails
        // natively rather than reporting current-process membership) — it needs the real
        // pseudo-handle from GetCurrentProcess(). NULL job handle still means "any Job".
        const self = kernel32.symbols.GetCurrentProcess();
        const result = new Int32Array(1);
        const ok = kernel32.symbols.IsProcessInJob(self, null, ptr(result));
        if (!ok) throw new Error("IsProcessInJob failed");
        return result[0] !== 0;
      },
      queryUiRestrictions: () => {
        // JOBOBJECT_BASIC_UI_RESTRICTIONS is a single DWORD; a NULL job handle means the caller's own Job.
        const info = new Uint32Array(1);
        const ok = kernel32.symbols.QueryInformationJobObject(
          null,
          JOB_OBJECT_BASIC_UI_RESTRICTIONS,
          ptr(info),
          info.byteLength,
          null,
        );
        if (!ok) throw new Error("QueryInformationJobObject failed despite a confirmed Job");
        return info[0] ?? 0;
      },
    });
  } finally {
    kernel32.close();
  }
}

let cached: boolean | undefined;
let override: (() => boolean) | null = null;

/** Whether this process's Job has UI restrictions; measured once per process. */
export function jobHasUiRestrictions(): boolean {
  if (override) return override();
  cached ??= jobUiRestrictionsPresent(queryOwnJobUiRestrictions);
  return cached;
}

/** Test seam for route and gate tests; pass null to restore the real probe. */
export function setJobUiRestrictionsProbeForTests(probe: (() => boolean) | null): void {
  override = probe;
  // Clear any memoized real-probe result so "restore the real probe" re-probes on next use
  // instead of replaying whatever a prior, override-less call happened to cache.
  cached = undefined;
}

function matchesTool(element: string, tool: BrowserAutomationTool): boolean {
  const value = element.trim().toLowerCase();
  if (tool.packages.some((pkg) => value === pkg || value.startsWith(`${pkg}@`))) return true;
  const basename = value.slice(Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\")) + 1);
  return tool.binaries.includes(basename.replace(/\.(exe|cmd|bat)$/, ""));
}

function localCommand(config: Record<string, unknown>): string[] | null {
  if (config.type !== "local" || !Array.isArray(config.command)) return null;
  return config.command.filter((part): part is string => typeof part === "string");
}

export function isBrowserAutomationMcp(config: Record<string, unknown>): boolean {
  const command = localCommand(config);
  if (!command) return false;
  return BROWSER_AUTOMATION_TOOLS.some((tool) => command.some((part) => matchesTool(part, tool)));
}

const CDP_ENDPOINT_FLAG = "--cdp-endpoint";
const ISOLATED_FLAG = "--isolated";

/**
 * The `@playwright/mcp` options (its `--help`, 0.0.x) that leave the browser source alone and work
 * through the relay. Anything else is refused, including the options that pick another source or
 * launch (`--extension`, `--endpoint`, `--config`, `--browser`, `--executable-path`,
 * `--user-data-dir`, `--profile-dir-name`, `--sandbox`, `--no-sandbox`), those whose effect the
 * relay refuses so every call would fail (`--proxy-server`: a proxied context; `--grant-permissions`:
 * `Browser.grantPermissions`; `--storage-state`: `Storage.setCookies`), those 0.0.84 rejects with a
 * CDP endpoint (`--device`, `--mobile`), and any option a later release adds.
 */
const RELAY_SAFE_OPTIONS = new Set([
  CDP_ENDPOINT_FLAG,
  "--allowed-hosts", "--allowed-origins", "--allow-unrestricted-file-access", "--blocked-origins",
  "--block-service-workers", "--caps", "--cdp-header", "--cdp-timeout", "--codegen", "--console-level",
  "--file-paths", "--headless", "--host", "--idle-timeout",
  "--ignore-https-errors", "--ignore-roots", "--image-responses", "--init-page", "--init-script",
  ISOLATED_FLAG, "--no-webmcp", "--output-dir", "--output-max-size", "--port",
  "--proxy-bypass", "--redact-url-params", "--save-session", "--secrets",
  "--shared-browser-context", "--snapshot-boxes", "--snapshot-mode",
  "--test-id-attribute", "--timeout-action", "--timeout-navigation", "--timeout-settle",
  "--user-agent", "--viewport-size",
]);

/**
 * Every option also reads a `PLAYWRIGHT_MCP_<OPTION>` variable, so these are refused in `environment`
 * too; `ISOLATED` because a value there could turn isolated mode off.
 */
const RELAY_UNSAFE_ENVIRONMENT = new Set([
  "CDP_ENDPOINT", "EXTENSION", "ENDPOINT", "CONFIG", "BROWSER", "EXECUTABLE_PATH", "USER_DATA_DIR",
  "PROFILE_DIR_NAME", "SANDBOX", "NO_SANDBOX", "ISOLATED", "PROXY_SERVER", "GRANT_PERMISSIONS",
  "STORAGE_STATE", "DEVICE", "MOBILE",
].map((name) => `PLAYWRIGHT_MCP_${name}`));

/** Launchers whose next argument is the package, with the only options allowed before it. */
const PACKAGE_LAUNCHERS: Readonly<Record<string, ReadonlySet<string>>> = {
  npx: new Set(["-y", "--yes"]),
  bunx: new Set(["--bun"]),
};

function programName(part: string): string {
  const value = part.trim().toLowerCase();
  return value.slice(Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\")) + 1).replace(/\.(exe|cmd|bat)$/, "");
}

function isPlaywrightMcpPackage(part: string): boolean {
  const value = part.trim().toLowerCase();
  return PLAYWRIGHT_MCP.packages.some((pkg) => value === pkg || value.startsWith(`${pkg}@`));
}

/** Where `@playwright/mcp`'s own arguments start, or -1 when it is not the program being launched. */
function playwrightMcpArgsStart(command: readonly string[]): number {
  const program = programName(command[0] ?? "");
  if (PLAYWRIGHT_MCP.binaries.includes(program)) return 1;
  if (program === "node") {
    const script = (command[1] ?? "").replace(/\\/g, "/").toLowerCase();
    return script.endsWith("/node_modules/@playwright/mcp/cli.js") ? 2 : -1;
  }
  let index = 1;
  let allowed = PACKAGE_LAUNCHERS[program];
  if (program === "pnpm" && command[1] === "dlx") {
    index = 2;
    allowed = new Set();
  }
  if (!allowed) return -1;
  while (index < command.length && allowed.has(command[index] ?? "")) index += 1;
  return isPlaywrightMcpPackage(command[index] ?? "") ? index + 1 : -1;
}

/** `@playwright/mcp` attached only to the host MCP gateway's CDP relay; see the header comment. */
export function isHostBrowserRelayMcp(config: Record<string, unknown>): boolean {
  const command = localCommand(config);
  if (!command || (Array.isArray(config.command) && command.length !== config.command.length)) return false;
  const start = playwrightMcpArgsStart(command);
  if (start < 0) return false;
  const others = BROWSER_AUTOMATION_TOOLS.filter((tool) => tool !== PLAYWRIGHT_MCP);
  if (command.some((part) => others.some((tool) => matchesTool(part, tool)))) return false;
  const environment = config.environment;
  if (environment !== undefined && (typeof environment !== "object" || environment === null)) return false;
  if (Object.keys(environment ?? {}).some((name) => RELAY_UNSAFE_ENVIRONMENT.has(name.toUpperCase()))) return false;
  const endpoints: Array<string | undefined> = [];
  let isolated = false;
  for (let index = start; index < command.length; index += 1) {
    const part = command[index] ?? "";
    if (!part.startsWith("-")) continue;
    const option = part.split("=", 1)[0] ?? part;
    if (!RELAY_SAFE_OPTIONS.has(option)) return false;
    if (option === ISOLATED_FLAG) {
      // Only the bare switch: `--isolated=false` could turn it off.
      if (part !== ISOLATED_FLAG) return false;
      isolated = true;
      continue;
    }
    if (option !== CDP_ENDPOINT_FLAG) continue;
    if (part.includes("=")) {
      endpoints.push(part.slice(CDP_ENDPOINT_FLAG.length + 1));
    } else {
      endpoints.push(command[index + 1]);
      index += 1;
    }
  }
  return isolated && endpoints.length > 0 && endpoints.every((url) => url !== undefined && isHostMcpCdpEndpoint(url));
}

/** Why this server cannot run here, or null when it can. */
export function browserMcpUnsupportedReason(
  config: Record<string, unknown>,
  probe: () => boolean = jobHasUiRestrictions,
): string | null {
  return isBrowserAutomationMcp(config) && !isHostBrowserRelayMcp(config) && probe()
    ? BROWSER_MCP_UNSUPPORTED_REASON
    : null;
}

export function assertBrowserMcpSupported(
  config: Record<string, unknown>,
  probe: () => boolean = jobHasUiRestrictions,
): void {
  const reason = browserMcpUnsupportedReason(config, probe);
  if (reason) throw new ApiError(403, BROWSER_MCP_UNSUPPORTED_CODE, reason);
}
