/**
 * mcp_status — authoritative MCP server status, read in-process from opencode.
 *
 * Fixes #1678: asked "which MCP servers are connected?", the model used to answer
 * from the cached MCP *resources* list. Most MCP servers implement tools only and
 * advertise no resources, so a healthy, connected server looked like nothing at
 * all and the answer came back "connected to none".
 *
 * This registers a `get_mcp_status` tool that reads opencode's own MCP status via
 * the injected plugin `client`. That is the same source the engine itself uses, so
 * it reports tools-only servers correctly.
 *
 * Why a plugin and not a `tools/*.ts` file: a directory tool only receives the
 * tool context (`sessionID`, `directory`, `abort`, ...) and has no way to reach the
 * engine, so it would have to make an HTTP round trip back out to OpenWork's
 * `/opencode/*` proxy and in again — which needs a port and a bearer token pushed
 * into the container env for a read-only status question. Plugins get `client`
 * injected (`PluginInput.client`), so `client.mcp.status()` costs no credentials,
 * no port, and no network hop out of the process.
 *
 * Tool naming: opencode registers plugin tools under the object key VERBATIM —
 * `fromPlugin(id, def)` over `Object.entries(p.tool ?? {})`, with no plugin-file
 * namespace (unlike directory tools, which are prefixed with their filename). So
 * this key must stay globally unique against builtins and other plugins, and the
 * `"get_mcp_status": "allow"` permission entries in opencode.jsonc /
 * opencode.minimal.jsonc match it as-is.
 */
import { tool, type Plugin } from "@opencode-ai/plugin";

/** One server as reported to the model. */
type McpServerStatus = {
  name: string;
  status: string;
  error?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Browser-automation MCP packages that cannot actually run in SuperClaw's Windows
 * sandbox (#3247): their own MCP handshake succeeds, so the engine genuinely
 * reports `status: "connected"`, but every one of their tools is forced off for
 * every agent by `buildToolGate` (sandbox/server/src/mcp/mcp-tool-gate.ts) because
 * the tier Job's UI restrictions collide with Chromium's own sandbox. Reporting
 * these as "connected" here would be truthful about the handshake but misleading
 * about usability — the model would confidently offer a tool it cannot actually
 * call. This list is kept in sync by hand with `BROWSER_AUTOMATION_TOOLS` in
 * sandbox/server/src/mcp/browser-sandbox-support.ts: that gate's own process and
 * this plugin's host process run in different languages with no shared module to
 * import from.
 */
// Deliberately excludes @browsermcp/mcp: it never launches its own Chromium in any
// configuration (it attaches to the user's existing browser via an extension), so the
// Job-nesting conflict this list exists to catch cannot occur for it.
//
// NOT exempted: attach-only configs for the tools below (`@playwright/mcp --cdp-endpoint`/
// `--extension`, `chrome-devtools-mcp --browserUrl`/`--autoConnect`) — accepting those is a live
// decision to let the agent drive whatever browser is on the other end, which needs the security
// owner's sign-off (tracked against #3247's option 3/4), not a detection-accuracy fix. See the
// matching comment in browser-sandbox-support.ts. The one exception, as there, is `@playwright/mcp`
// attached only to the host gateway's CDP relay with `--isolated` (`isHostBrowserRelayMcp`).
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

function matchesTool(element: string, tool: BrowserAutomationTool): boolean {
  const value = element.trim().toLowerCase();
  if (tool.packages.some((pkg) => value === pkg || value.startsWith(`${pkg}@`))) return true;
  const basename = value.slice(Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\")) + 1);
  return tool.binaries.includes(basename.replace(/\.(exe|cmd|bat)$/, ""));
}

function isBrowserAutomationMcp(config: unknown): boolean {
  if (!isRecord(config) || config.type !== "local" || !Array.isArray(config.command)) return false;
  const command = config.command.filter((part): part is string => typeof part === "string");
  return BROWSER_AUTOMATION_TOOLS.some((tool) => command.some((part) => matchesTool(part, tool)));
}

/*
 * Kept in sync by hand with `isHostBrowserRelayMcp` and its option lists in
 * sandbox/server/src/mcp/browser-sandbox-support.ts. The endpoint is `HOST_MCP_CDP_ENDPOINT_PATTERN`
 * in shared/contracts/src/host-mcp-api.ts, which this plugin's process cannot import.
 */
const CDP_ENDPOINT_FLAG = "--cdp-endpoint";
const ISOLATED_FLAG = "--isolated";
const HOST_MCP_CDP_ENDPOINT = /^ws:\/\/127\.0\.0\.1:18831\/mcp-host\/cdp\/[A-Za-z0-9_-]{32,128}$/;
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
const RELAY_UNSAFE_ENVIRONMENT = new Set([
  "CDP_ENDPOINT", "EXTENSION", "ENDPOINT", "CONFIG", "BROWSER", "EXECUTABLE_PATH", "USER_DATA_DIR",
  "PROFILE_DIR_NAME", "SANDBOX", "NO_SANDBOX", "ISOLATED", "PROXY_SERVER", "GRANT_PERMISSIONS",
  "STORAGE_STATE", "DEVICE", "MOBILE",
].map((name) => `PLAYWRIGHT_MCP_${name}`));
const PACKAGE_LAUNCHERS: Readonly<Record<string, ReadonlySet<string>>> = {
  npx: new Set(["-y", "--yes"]),
  bunx: new Set(["--bun"]),
};

function programName(part: string): string {
  const value = part.trim().toLowerCase();
  return value.slice(Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\")) + 1).replace(/\.(exe|cmd|bat)$/, "");
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
  const value = (command[index] ?? "").trim().toLowerCase();
  return PLAYWRIGHT_MCP.packages.some((pkg) => value === pkg || value.startsWith(`${pkg}@`)) ? index + 1 : -1;
}

/** `@playwright/mcp --isolated` attached only to the host gateway's CDP relay: openwork-server leaves its tools on. */
function isHostBrowserRelayMcp(config: unknown): boolean {
  if (!isRecord(config) || config.type !== "local" || !Array.isArray(config.command)) return false;
  const command = config.command.filter((part): part is string => typeof part === "string");
  if (command.length !== config.command.length) return false;
  const start = playwrightMcpArgsStart(command);
  if (start < 0) return false;
  const others = BROWSER_AUTOMATION_TOOLS.filter((tool) => tool !== PLAYWRIGHT_MCP);
  if (command.some((part) => others.some((tool) => matchesTool(part, tool)))) return false;
  const environment = config.environment;
  if (environment !== undefined && !isRecord(environment)) return false;
  if (Object.keys(environment ?? {}).some((name) => RELAY_UNSAFE_ENVIRONMENT.has(name.toUpperCase()))) return false;
  const endpoints: Array<string | undefined> = [];
  let isolated = false;
  for (let index = start; index < command.length; index += 1) {
    const part = command[index] ?? "";
    if (!part.startsWith("-")) continue;
    const option = part.split("=", 1)[0] ?? part;
    if (!RELAY_SAFE_OPTIONS.has(option)) return false;
    if (option === ISOLATED_FLAG) {
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
  return isolated && endpoints.length > 0 && endpoints.every((url) => url !== undefined && HOST_MCP_CDP_ENDPOINT.test(url));
}

const JOB_OBJECT_BASIC_UI_RESTRICTIONS = 4;

/**
 * Measures whether THIS process's own Job carries UI restrictions — the same signal
 * sandbox/server/src/mcp/browser-sandbox-support.ts's `jobHasUiRestrictions()` uses to
 * decide whether Chromium's sandbox can run here. Duplicated (not imported) because this
 * plugin runs inside the opencode engine's own process, a different process/language from
 * openwork-server; per the native isolation broker's startup catalog each role (including this
 * engine) gets its own Job rather than sharing openwork-server's, so this probes the engine's
 * OWN Job membership directly rather than assuming it inherited one.
 *
 * Fails closed: `IsProcessInJob`/`QueryInformationJobObject` failing natively, or `bun:ffi`
 * itself being unavailable in this host runtime (unverified — this plugin's process is not
 * guaranteed to be the same Bun build sandbox/server runs on), is reported as restricted rather
 * than silently clearing the way for a server that cannot actually run. `bun:ffi` is imported
 * dynamically, inside this try, rather than at module scope: a static top-level import that
 * fails would fail the whole module — taking `get_mcp_status` down entirely instead of just this
 * probe degrading to "restricted". A probe that always answers "restricted" degrades to exactly
 * today's platform-only behavior, never worse.
 */
async function jobIsUiRestricted(): Promise<boolean> {
  try {
    const { dlopen, FFIType, ptr } = await import("bun:ffi");
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
      // IsProcessInJob's first parameter does NOT accept NULL for "the calling process"
      // (confirmed empirically: it fails natively instead) — it needs the real pseudo-handle
      // from GetCurrentProcess(). NULL job handle still means "any Job".
      const self = kernel32.symbols.GetCurrentProcess();
      const inJob = new Int32Array(1);
      const checked = kernel32.symbols.IsProcessInJob(self, null, ptr(inJob));
      if (!checked) throw new Error("IsProcessInJob failed");
      if (!inJob[0]) return false; // confirmed: no Job at all, genuinely unrestricted

      // JOBOBJECT_BASIC_UI_RESTRICTIONS is a single DWORD; a NULL job handle means the
      // caller's own Job.
      const info = new Uint32Array(1);
      const ok = kernel32.symbols.QueryInformationJobObject(
        null,
        JOB_OBJECT_BASIC_UI_RESTRICTIONS,
        ptr(info),
        info.byteLength,
        null,
      );
      if (!ok) throw new Error("QueryInformationJobObject failed despite a confirmed Job");
      return (info[0] ?? 0) !== 0;
    } finally {
      kernel32.close();
    }
  } catch {
    return true;
  }
}

/**
 * Server names this host's sandbox will never let run, regardless of what the engine's
 * handshake-level status says. Windows-only at the outer check (no Job/Chromium
 * conflict exists off Windows at all); on Windows, `isRestricted` is the actual
 * measured signal, not an assumption — an unrestricted Windows host (e.g. the engine
 * run directly outside the native isolation broker) reports nothing unsupported here,
 * matching what `buildToolGate` would actually allow. A failed config read degrades to
 * "nothing is unsupported" rather than hiding every server, matching this tool's
 * existing per-server tolerance (see toServerList). `platform`/`isRestricted` are
 * parameters only so tests can drive both branches without touching the real host.
 *
 * Not exported directly: opencode loads every export of a plugin module as a plugin and would
 * invoke this bare helper as a factory. It rides on the default export's `Object.assign` below
 * instead, like every other plugin's helpers.
 */
async function browserAutomationServerNames(
  client: { config: { get: () => Promise<{ data?: unknown; error?: unknown }> } },
  platform: string = process.platform,
  isRestricted: () => boolean | Promise<boolean> = jobIsUiRestricted,
): Promise<Set<string>> {
  const unsupported = new Set<string>();
  if (platform !== "win32") return unsupported;
  if (!(await isRestricted())) return unsupported;
  try {
    const result = await client.config.get();
    const mcp = !result.error && isRecord(result.data) ? result.data.mcp : undefined;
    if (!isRecord(mcp)) return unsupported;
    for (const [name, config] of Object.entries(mcp)) {
      if (isBrowserAutomationMcp(config) && !isHostBrowserRelayMcp(config)) unsupported.add(name);
    }
  } catch {
    // Best-effort: fall through with nothing excluded.
  }
  return unsupported;
}

/**
 * Shape the engine's status record for the model.
 *
 * Deliberately tolerant PER SERVER: an entry we cannot read becomes
 * `status: "unknown"` instead of failing the whole call. Throwing on the batch
 * would leave the model with nothing and send it straight back to guessing from
 * resources — the exact bug this tool exists to fix.
 *
 * opencode's status union is `connected | disabled | failed | needs_auth |
 * needs_client_registration`; the value is passed through as a string rather than
 * matched against that list, so a new engine status shows up verbatim instead of
 * being reported as "unknown".
 */
function toServerList(raw: unknown): McpServerStatus[] {
  if (!isRecord(raw)) return [];

  return Object.entries(raw).map(([name, value]) => {
    if (!isRecord(value) || typeof value.status !== "string") {
      return { name, status: "unknown" };
    }
    return {
      name,
      status: value.status,
      ...(typeof value.error === "string" ? { error: value.error } : {}),
    };
  });
}

function agentName(agent: unknown): string {
  if (typeof agent === "string") return agent;
  if (!isRecord(agent)) return "";
  for (const key of ["name", "id", "type", "agent"]) {
    const value = agent[key];
    if (typeof value === "string") return value;
  }
  return "";
}

/**
 * LONGEST match, not the first: `MCP_NAME_REGEX` (sandbox/server/src/validators.ts)
 * allows underscores, so `foo` and `foo_bar` can both be configured and
 * `foo_bar_search` carries both prefixes. Returning `foo` there would let an
 * agent granted only `foo` reach every tool of `foo_bar`, and the per-message
 * `tools` map outranks the agent ruleset, so nothing downstream catches it.
 */
function matchingMcpServer(toolName: string, serverNames: Iterable<string>): string | undefined {
  let match: string | undefined;
  for (const serverName of serverNames) {
    if (!toolName.startsWith(`${serverName}_`)) continue;
    if (match === undefined || serverName.length > match.length) match = serverName;
  }
  return match;
}

/**
 * Which of `serverNames` a non-default agent's OWN resolved permission
 * already allows. A customized agent's grant is authored once, at creation
 * time, as a literal `"<mcp>_*": allow` entry in its agent-file frontmatter
 * (see generateAgentMarkdown in apps/ui). Confirmed against a live engine
 * (2026-08-14 debug dump): client.app.agents() — the v1 (non-v2) SDK surface
 * injected into plugins — reports that back as a flat PermissionRuleset on
 * `Agent.permission`, e.g. `{permission: "markitdown_*", pattern: "*", action:
 * "allow"}`; there is no `Agent.tools` map (the v1 .d.ts's narrower fixed-shape
 * `permission` type is stale relative to the actual response). Same shape and
 * same wildcard key the openwork-server tool gate reads, so this guard and the
 * gate resolve a grant identically — see sandbox/server/src/mcp-tool-gate.ts.
 * Best-effort: an unreadable/missing agent roster allows nothing, matching
 * the existing fail-closed default for any non-"superclaw-default" agent.
 */
async function allowedMcpServersForAgent(
  client: { app: { agents: () => Promise<{ data?: unknown; error?: unknown }> } },
  agentName: string,
  serverNames: Iterable<string>,
): Promise<Set<string>> {
  const allowed = new Set<string>();
  try {
    const result = await client.app.agents();
    if (result.error || !Array.isArray(result.data)) return allowed;
    const match = result.data.find(
      (candidate) => isRecord(candidate) && candidate.name === agentName,
    );
    const permission = isRecord(match) && Array.isArray(match.permission) ? match.permission : undefined;
    if (!permission) return allowed;
    const allowedKeys = new Set(
      permission
        .filter(
          (rule): rule is Record<string, unknown> & { action: "allow"; permission: string } =>
            isRecord(rule) && rule.action === "allow" && typeof rule.permission === "string",
        )
        .map((rule) => rule.permission),
    );
    for (const serverName of serverNames) {
      if (allowedKeys.has(`${serverName}_*`)) allowed.add(serverName);
    }
  } catch {
    // Best-effort: fall through with nothing allowed.
  }
  return allowed;
}

export const SuperclawMcpStatus: Plugin = async ({ client }) => {
  await client.app.log({
    body: {
      service: "mcp-status",
      level: "info",
      message: "Plugin initialised — registers the get_mcp_status tool",
    },
  });

  const sessionAgents = new Map<string, string>();
  // Only populated for non-"superclaw-default" agents — see allowedMcpServersForAgent.
  const sessionAllowedMcp = new Map<string, Set<string>>();

  // matchingMcpServer recognises an MCP tool ONLY by a known server-name prefix,
  // so an empty set silently disarms this guard. Hence: per session, because one
  // process serves directories with different MCP configs and a shared set let the
  // newest chat.params overwrite an earlier session's names; loaded on demand, for
  // a session resumed after a restart; and a last-known-good union so a TRANSIENT
  // failure does not regress identification to "recognise nothing".
  //
  // NEVER await a load from the plugin factory: plugins load while opencode builds
  // the instance that owns the MCP registry, so client.mcp.status() cannot resolve
  // until construction finishes — awaiting there deadlocks every request carrying a
  // directory while /global/health keeps answering 200.
  //
  // Declared residual: if status never once loads, nothing can be identified as MCP
  // and this layer cannot enforce. A blanket deny would also block legitimate
  // underscore-named builtins, so it is logged loudly instead; upstream covers it,
  // since with no `tools` map the engine omits MCP tools from the request entirely.
  const sessionServerNames = new Map<string, Set<string>>();
  const knownServerNames = new Set<string>();

  const loadServerNames = async (): Promise<Set<string> | undefined> => {
    let failure: unknown;
    try {
      const result = await client.mcp.status();
      if (!result.error && isRecord(result.data)) {
        const names = new Set(Object.keys(result.data));
        for (const name of names) knownServerNames.add(name);
        return names;
      }
      failure = result.error ?? result.data;
    } catch (error) {
      failure = error;
    }
    await client.app.log({
      body: {
        service: "mcp-status",
        level: "error",
        message:
          `Could not load MCP server names, so MCP tools cannot be identified for ` +
          `per-agent enforcement: ${JSON.stringify(failure)}`,
      },
    });
    return undefined;
  };

  const serverNamesFor = async (sessionID: string): Promise<Set<string>> => {
    const cached = sessionServerNames.get(sessionID);
    if (cached) return cached;
    const loaded = await loadServerNames();
    if (!loaded) return knownServerNames;
    sessionServerNames.set(sessionID, loaded);
    return loaded;
  };

  return {
    "chat.params": async (input) => {
      const names = await loadServerNames();
      if (!input.sessionID) return;
      if (names) sessionServerNames.set(input.sessionID, names);
      const name = input.agent == null ? "superclaw-default" : agentName(input.agent);
      sessionAgents.set(input.sessionID, name || "unknown");
      if (name && name !== "superclaw-default") {
        sessionAllowedMcp.set(
          input.sessionID,
          await allowedMcpServersForAgent(client, name, names ?? knownServerNames),
        );
      } else {
        sessionAllowedMcp.delete(input.sessionID);
      }
    },
    "tool.execute.before": async (input) => {
      const agent = sessionAgents.get(input.sessionID);
      // Before the name lookup: keeps the default-agent path free of a round trip.
      if (agent === "superclaw-default") return;
      const server = matchingMcpServer(input.tool, await serverNamesFor(input.sessionID));
      if (!server) return;
      if (sessionAllowedMcp.get(input.sessionID)?.has(server)) return;
      throw new Error(
        `MCP tool '${input.tool}' is only callable from superclaw-default or an agent that explicitly allows it; current agent is '${agent || "unknown"}'.`,
      );
    },
    tool: {
      get_mcp_status: tool({
        description:
          "Get the MCP servers currently CONNECTED and available to YOU (the current agent) from OpenCode. Use this for questions about which MCP servers are connected. Do not use MCP resources, resource templates, or available tools to infer connection status.",
        args: {},
        async execute(_args, context) {
          const result = await client.mcp.status();
          if (result.error) {
            throw new Error(
              `Unable to retrieve MCP server status: ${JSON.stringify(result.error)}`,
            );
          }
          // Filter and only return mcp with status:connected, disabled | failed | needs_auth | needs_client_registration is stripped away.
          const connected = toServerList(result.data).filter((server) => server.status === "connected");
          // A server whose own handshake succeeded but whose tools this sandbox forces off for
          // every agent (#3247) must not be reported as connected: the model would offer a tool
          // it can never actually call. See browserAutomationServerNames above.
          const sandboxUnsupported = connected.length === 0
            ? new Set<string>()
            : await browserAutomationServerNames(client);
          const servers = connected.filter((server) => !sandboxUnsupported.has(server.name));
          // Same scoping as tool.execute.before: superclaw-default sees every
          // configured server; any other agent — including a customized agent
          // that only checked one MCP — only sees the ones it can actually
          // call. Without this, the model could truthfully report tool-call
          // failures away but still claim access to servers it can't use,
          // since get_mcp_status predates per-agent MCP scoping (#1678) and
          // was never itself agent-aware.
          //
          // Reads sessionAgents (populated via agentName() in chat.params)
          // instead of context.agent directly: ToolContext.agent is typed as a
          // plain string, but so is chat.params's input.agent, and that one
          // needs agentName()'s defensive object-handling in practice — the
          // .d.ts here isn't trustworthy enough to skip going through the same
          // normalized, already-verified path tool.execute.before relies on.
          const agent = sessionAgents.get(context.sessionID);
          if (!agent || agent === "superclaw-default") {
            return JSON.stringify({ servers }, null, 2);
          }
          const allowed = sessionAllowedMcp.get(context.sessionID);
          const scoped = servers.filter((server) => allowed?.has(server.name));
          return JSON.stringify({ servers: scoped }, null, 2);
        },
      }),
    },
  };
};

// The helper rides on the plugin function rather than being an export of its own: opencode loads
// every export of a plugin module as a plugin and invokes a bare helper export as a factory.
export default Object.assign(SuperclawMcpStatus, { browserAutomationServerNames });
