/**
 * The host MCP gateway's API: `mcp_host_manager`, a ServiceHub child on 127.0.0.1:18831 behind the
 * proxy prefix `/mcp-host`. It runs the MCP servers the user chose to run outside the sandbox, as the
 * signed-in user, and a visible, dedicated Edge. Design record: `host/mcp_host_manager/README.md`.
 *
 * Management plane, under `/mcp-host/v1`. Every route requires ServiceHub's forwarded credential
 * (`servicehub-forwarding.ts`) except `health`, `status` and `summary`, so no tier process can make the host
 * run a command or approve its own call:
 *
 *   GET    /mcp-host/v1/servers                     -> HostMcpServerList
 *   PUT    /mcp-host/v1/servers/{name}              HostMcpServerRegisterRequest -> HostMcpServerRegistration
 *   DELETE /mcp-host/v1/servers/{name}              -> HostMcpOk
 *   DELETE /mcp-host/v1/servers/{name}/grants       -> HostMcpOk (clears its `always` grants)
 *   GET    /mcp-host/v1/approvals?wait_ms=          -> HostMcpPendingApprovalList
 *   POST   /mcp-host/v1/approvals/{approval_id}/decision  HostMcpApprovalDecisionRequest -> HostMcpApprovalDecisionResult
 *   GET    /mcp-host/v1/status                      -> HostMcpStatus (unguarded)
 *   GET    /mcp-host/v1/summary                     -> HostMcpSummary (unguarded)
 *   POST   /mcp-host/v1/stop-all                    -> HostMcpStopAllResult (and pauses: see HostMcpStatus)
 *   POST   /mcp-host/v1/resume                      -> HostMcpOk (ends the pause stop-all began)
 *   POST   /mcp-host/v1/calls/{call_id}/cancel      -> HostMcpOk (one call in HostMcpStatus.active_calls)
 *   PUT    /mcp-host/v1/browser                     HostBrowserConfigRequest -> HostBrowserView
 *   GET    /mcp-host/v1/browser                     -> HostBrowserView
 *   DELETE /mcp-host/v1/browser                     -> HostBrowserView
 *   POST   /mcp-host/v1/browser/stop                -> HostBrowserView
 *
 * Data plane, reached directly on the port, not through ServiceHub:
 *
 *   POST /mcp-host/mcp/{name}   MCP Streamable HTTP, `Authorization: Bearer <runtime token>`. JSON
 *                               responses, except a `tools/call` with a progress token from a client
 *                               that accepts `text/event-stream`: that one is an SSE stream of
 *                               progress notifications ending in the response. A refused `tools/call`
 *                               is a tool result with `isError: true` and the refusal's fixed
 *                               sentence, never a hang or an HTTP error.
 *   WS   /mcp-host/cdp/{relay_token}                  the filtered CDP relay to the host Edge.
 *   GET  /mcp-host/cdp/{relay_token}/json/version     what `connectOverCDP` reads first.
 *
 * Every error is the one envelope below, because ServiceHub's `normalize_upstream_error` rewrites any
 * other error body to `upstream_error`. A malformed request is 400, never FastAPI's 422.
 *
 * Browser-safe: the frontend adapter parses with these schemas, so nothing here may import a node
 * builtin. That is why the two forwarded-credential strings are spelled again below rather than
 * imported from `servicehub-forwarding.ts`, which uses `node:crypto`; a test holds them equal.
 */
import { z } from "zod";

import { CorrelationIdSchema } from "./correlation-id.js";
import { IsolationInstantSchema } from "./isolation-reporting.js";
import { MCP_SERVER_NAME_PATTERN, McpServerNameSchema } from "./mcp.js";
import {
  EGRESS_APPROVAL_TEXT_MAX_UTF16_UNITS,
  EgressApprovalTextSchema,
} from "./sandbox-manager-host-api.js";

export const HOST_MCP_PORT = 18831;
export const HOST_MCP_PROXY_PREFIX = "/mcp-host";
export const HOST_MCP_RUNTIME_URL_PREFIX = `http://127.0.0.1:${HOST_MCP_PORT}${HOST_MCP_PROXY_PREFIX}/mcp/`;
export const HOST_MCP_CDP_URL_PREFIX = `ws://127.0.0.1:${HOST_MCP_PORT}${HOST_MCP_PROXY_PREFIX}/cdp/`;

/** A runtime bearer token or a CDP relay token: URL-safe base64 without padding. */
export const HOST_MCP_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

const TOKEN_BODY = HOST_MCP_TOKEN_PATTERN.source.slice(1, -1);
const NAME_BODY = MCP_SERVER_NAME_PATTERN.source.slice(1, -1);
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const HOST_MCP_RUNTIME_URL_PATTERN = new RegExp(
  `^${escapeRegExp(HOST_MCP_RUNTIME_URL_PREFIX)}${NAME_BODY}$`
);
export const HOST_MCP_CDP_ENDPOINT_PATTERN = new RegExp(
  `^${escapeRegExp(HOST_MCP_CDP_URL_PREFIX)}${TOKEN_BODY}$`
);
export const HOST_MCP_RUNTIME_AUTHORIZATION_PATTERN = new RegExp(`^Bearer ${TOKEN_BODY}$`);

/** The URL a workspace stores as the `remote` entry for a host server. Throws on an invalid name. */
export function hostMcpRuntimeUrl(name: string): string {
  return HOST_MCP_RUNTIME_URL_PREFIX + McpServerNameSchema.parse(name);
}

/** The exact prefix and one valid server name: no other host, port, scheme, query or trailing path. */
export function isHostMcpRuntimeUrl(url: string): boolean {
  return HOST_MCP_RUNTIME_URL_PATTERN.test(url);
}

/** The exact CDP relay prefix and one relay token. */
export function isHostMcpCdpEndpoint(url: string): boolean {
  return HOST_MCP_CDP_ENDPOINT_PATTERN.test(url);
}

export const HOST_MCP_APPROVAL_MODES = ["prompt", "auto"] as const;
/**
 * `prompt` asks before every call. `auto` asks unless the tool is read-only by its own annotations.
 * A server registered without a mode is `prompt`.
 */
export const HostMcpApprovalModeSchema = z.enum(HOST_MCP_APPROVAL_MODES);
export type HostMcpApprovalMode = z.infer<typeof HostMcpApprovalModeSchema>;
export const HOST_MCP_DEFAULT_APPROVAL_MODE: HostMcpApprovalMode = "prompt";

/**
 * How long an approved call's grant lasts. `until_restart` lasts until the gateway restarts; there is
 * no chat scope because OpenCode's MCP client sends no session identity. `always` is offered only for
 * a read-only tool.
 */
export const HOST_MCP_GRANT_SCOPES = ["once", "until_restart", "always"] as const;
export const HostMcpGrantScopeSchema = z.enum(HOST_MCP_GRANT_SCOPES);
export type HostMcpGrantScope = z.infer<typeof HostMcpGrantScopeSchema>;

/**
 * A tool's MCP annotations as its server declared them in `tools/list`: `readOnlyHint`,
 * `destructiveHint`, `openWorldHint`. Null is a hint the server did not declare.
 */
export const HostMcpToolAnnotationsSchema = z
  .object({
    read_only: z.boolean().nullable(),
    destructive: z.boolean().nullable(),
    open_world: z.boolean().nullable(),
  })
  .strict();
export type HostMcpToolAnnotations = z.infer<typeof HostMcpToolAnnotationsSchema>;

/** Read-only only when the server says so and does not also call it destructive. */
export function hostMcpToolIsReadOnly(annotations: HostMcpToolAnnotations): boolean {
  return annotations.read_only === true && annotations.destructive !== true;
}

export function hostMcpCallNeedsApproval(
  mode: HostMcpApprovalMode,
  annotations: HostMcpToolAnnotations
): boolean {
  return mode === "prompt" ? true : !hostMcpToolIsReadOnly(annotations);
}

export function hostMcpOfferedScopes(annotations: HostMcpToolAnnotations): readonly HostMcpGrantScope[] {
  return hostMcpToolIsReadOnly(annotations) ? ["once", "until_restart", "always"] : ["once", "until_restart"];
}

export type HostMcpApprovalVector = {
  readonly mode: HostMcpApprovalMode;
  readonly annotations: HostMcpToolAnnotations;
  readonly needs_approval: boolean;
  readonly offered_scopes: readonly HostMcpGrantScope[];
};

const UNDECLARED: HostMcpToolAnnotations = { read_only: null, destructive: null, open_world: null };
const READ_ONLY: HostMcpToolAnnotations = { read_only: true, destructive: null, open_world: null };
const READ_ONLY_DESTRUCTIVE: HostMcpToolAnnotations = { read_only: true, destructive: true, open_world: null };
const NOT_READ_ONLY: HostMcpToolAnnotations = { read_only: false, destructive: null, open_world: null };
const DESTRUCTIVE: HostMcpToolAnnotations = { read_only: null, destructive: true, open_world: null };
const READ_ONLY_OPEN_WORLD: HostMcpToolAnnotations = { read_only: true, destructive: null, open_world: true };
const WRITE_SCOPES: readonly HostMcpGrantScope[] = ["once", "until_restart"];
const READ_SCOPES: readonly HostMcpGrantScope[] = ["once", "until_restart", "always"];

/** The decisions both implementations are checked against, written out rather than computed. */
export const HOST_MCP_APPROVAL_VECTORS: readonly HostMcpApprovalVector[] = [
  { mode: "prompt", annotations: UNDECLARED, needs_approval: true, offered_scopes: WRITE_SCOPES },
  { mode: "prompt", annotations: READ_ONLY, needs_approval: true, offered_scopes: READ_SCOPES },
  { mode: "prompt", annotations: READ_ONLY_DESTRUCTIVE, needs_approval: true, offered_scopes: WRITE_SCOPES },
  { mode: "prompt", annotations: NOT_READ_ONLY, needs_approval: true, offered_scopes: WRITE_SCOPES },
  { mode: "prompt", annotations: DESTRUCTIVE, needs_approval: true, offered_scopes: WRITE_SCOPES },
  { mode: "prompt", annotations: READ_ONLY_OPEN_WORLD, needs_approval: true, offered_scopes: READ_SCOPES },
  { mode: "auto", annotations: UNDECLARED, needs_approval: true, offered_scopes: WRITE_SCOPES },
  { mode: "auto", annotations: READ_ONLY, needs_approval: false, offered_scopes: READ_SCOPES },
  { mode: "auto", annotations: READ_ONLY_DESTRUCTIVE, needs_approval: true, offered_scopes: WRITE_SCOPES },
  { mode: "auto", annotations: NOT_READ_ONLY, needs_approval: true, offered_scopes: WRITE_SCOPES },
  { mode: "auto", annotations: DESTRUCTIVE, needs_approval: true, offered_scopes: WRITE_SCOPES },
  { mode: "auto", annotations: READ_ONLY_OPEN_WORLD, needs_approval: false, offered_scopes: READ_SCOPES },
];

/**
 * Text the user reads before deciding: the egress approval text rules, for the same reason. The
 * gateway builds it from what it saw, cleans and truncates it, and never passes runtime prose through.
 */
export const HostMcpTextSchema = EgressApprovalTextSchema;
export const HOST_MCP_TEXT_MAX_UTF16_UNITS = EGRESS_APPROVAL_TEXT_MAX_UTF16_UNITS;

export const HOST_MCP_SERVER_MAX = 64;
export const HOST_MCP_COMMAND_ARG_MAX_CHARS = 4096;
export const HOST_MCP_ENVIRONMENT_MAX_KEYS = 64;
export const HOST_MCP_PENDING_APPROVALS_MAX = 64;
/** The longest `GET .../approvals?wait_ms=` holds open, inside ServiceHub's 30 s read timeout. */
export const HOST_MCP_APPROVALS_MAX_WAIT_MS = 20_000;
/**
 * How long a held call waits for the user before it is refused as `approval_timeout`, and how long an
 * approved call may then run. The MCP SDK gives up on a request after 60 s unless a progress
 * notification resets its timer, and the runtime's client asks for that reset
 * (`resetTimeoutOnProgress`) and sends a progress token. So a `tools/call` that carries one, from a
 * client that accepts `text/event-stream`, is answered as an SSE stream with a progress notification
 * every `HOST_MCP_PROGRESS_KEEPALIVE_MS` while it waits and runs.
 */
export const HOST_MCP_APPROVAL_TIMEOUT_MS = 600_000;
/** The interval between progress notifications on a streamed call, well inside the SDK's 60 s. */
export const HOST_MCP_PROGRESS_KEEPALIVE_MS = 15_000;
/**
 * The approval wait for a call that cannot be kept alive (no progress token, or a JSON-only client):
 * it is refused before the SDK's 60 s default request timeout ends it.
 */
export const HOST_MCP_NO_PROGRESS_APPROVAL_TIMEOUT_MS = 50_000;
/**
 * A host server with no `tools/call` in flight for this long is stopped (its Job closed). It starts
 * again on its next call; `initialize` and `tools/list` are answered from its last good tool list,
 * which the gateway keeps, so the runtime connecting does not start it. Only a server with no such
 * list yet (just registered, or its command changed) is started to learn its tools, and the same
 * idle stop then ends it.
 */
export const HOST_MCP_IDLE_STOP_MS = 180_000;
export const HOST_BROWSER_UPLOAD_ROOTS_MAX = 8;

/**
 * Every error the gateway answers with. `servicehub_forwarding_required` is the management plane's
 * answer to a request that did not come through ServiceHub; `runtime_token_invalid` is the data
 * plane's answer to a missing or wrong bearer token.
 */
export const HostMcpErrorCodeSchema = z.enum([
  "invalid_request",
  "servicehub_forwarding_required",
  "runtime_token_invalid",
  "host_mcp_server_not_found",
  "approval_not_found",
  "approval_not_pending",
  "approval_scope_not_offered",
  "host_mcp_server_limit",
  "host_mcp_server_start_failed",
  "host_browser_not_configured",
  "host_browser_unavailable",
  "host_mcp_browser_automation_refused",
  "host_mcp_call_not_found",
]);
export type HostMcpErrorCode = z.infer<typeof HostMcpErrorCodeSchema>;

/** The status and the one fixed sentence each code goes out with; no message is built from a request. */
export const HOST_MCP_ERRORS: {
  readonly [C in HostMcpErrorCode]: { readonly status: number; readonly message: string };
} = {
  invalid_request: { status: 400, message: "The request is not one this endpoint accepts." },
  servicehub_forwarding_required: {
    status: 401,
    message: "This endpoint is reached only through ServiceHub.",
  },
  runtime_token_invalid: {
    status: 401,
    message: "The runtime token is missing or is not this server's.",
  },
  host_mcp_server_not_found: { status: 404, message: "No host MCP server has that name." },
  approval_not_found: { status: 404, message: "No approval has that id." },
  approval_not_pending: {
    status: 409,
    message: "That approval has already been decided or has expired.",
  },
  approval_scope_not_offered: {
    status: 409,
    message: "That approval does not offer the chosen scope.",
  },
  host_mcp_server_limit: {
    status: 409,
    message: "No more host MCP servers can be registered. Remove one first.",
  },
  host_mcp_server_start_failed: {
    status: 502,
    message: "The host MCP server could not be started.",
  },
  host_browser_not_configured: { status: 409, message: "The host browser is not set up." },
  host_browser_unavailable: {
    status: 501,
    message: "Microsoft Edge was not found on this computer.",
  },
  host_mcp_browser_automation_refused: {
    status: 400,
    message:
      "Browser automation servers can't run on this computer outside the sandbox. Add it without that option and use the SuperClaw browser instead.",
  },
  host_mcp_call_not_found: { status: 404, message: "That action has already finished or does not exist." },
};

/**
 * MCP servers that drive a browser of their own. None may be registered to run on the host: there
 * it would bypass the CDP relay's filter entirely (file access, private network, uploads,
 * downloads) and launch the system Chrome or Edge, which on a managed machine silently signs into
 * the user's work account (Edge implicit sign-in, Chrome `CloudAPAuthEnabled`). The supported path
 * is the sandboxed server attached to the SuperClaw browser relay. Includes every tool
 * `sandbox/server/src/mcp/browser-sandbox-support.ts` refuses in the sandbox.
 */
export const HOST_MCP_BROWSER_AUTOMATION_COMMANDS = {
  packages: [
    "@playwright/mcp",
    "chrome-devtools-mcp",
    "@executeautomation/playwright-mcp-server",
    "@modelcontextprotocol/server-puppeteer",
    "puppeteer-mcp-server",
    "@browsermcp/mcp",
    "@agent-infra/mcp-server-browser",
  ],
  binaries: ["playwright-mcp", "chrome-devtools", "chrome-devtools-mcp", "playwright-mcp-server", "mcp-server-puppeteer"],
} as const;

/** Launcher option prefixes whose value names the package to run (`npx --package=`, `uvx --from=`). */
const BROWSER_AUTOMATION_ARG_PREFIXES = ["--package=", "-p=", "--from=", "npm:"] as const;
const BROWSER_AUTOMATION_LAUNCH_SUFFIX = /\.(exe|cmd|bat|com|ps1|js|cjs|mjs)$/;

/**
 * One argv element as the matcher reads it: lowercase, `\` as `/`, trailing dots and spaces
 * stripped (Windows ignores them), and any launcher prefix that carries a package taken off.
 */
function normalizeBrowserAutomationArg(element: string): string {
  let value = element.trim().toLowerCase().replace(/\\/g, "/").replace(/[. ]+$/, "");
  for (let changed = true; changed; ) {
    changed = false;
    for (const prefix of BROWSER_AUTOMATION_ARG_PREFIXES) {
      if (value.startsWith(prefix)) {
        value = value.slice(prefix.length);
        changed = true;
      }
    }
  }
  return value;
}

/**
 * Whether a command runs a browser-automation server. An argv element, normalized as above, names
 * a package (equal to it, `<package>@<version>`, `<package>/<subpath>`, or a path through
 * `node_modules/<package>`), or its basename without a launcher extension (`.exe`, `.cmd`, `.bat`,
 * `.com`, `.ps1`, `.js`, `.cjs`, `.mjs`) is one of the binaries.
 */
export function isBrowserAutomationCommand(command: readonly string[]): boolean {
  const packages: readonly string[] = HOST_MCP_BROWSER_AUTOMATION_COMMANDS.packages;
  const binaries: readonly string[] = HOST_MCP_BROWSER_AUTOMATION_COMMANDS.binaries;
  return command.some((element) => {
    const value = normalizeBrowserAutomationArg(element);
    const namesPackage = (pkg: string) =>
      value === pkg ||
      value.startsWith(`${pkg}@`) ||
      value.startsWith(`${pkg}/`) ||
      value.includes(`/node_modules/${pkg}/`) ||
      value.endsWith(`/node_modules/${pkg}`);
    if (packages.some(namesPackage)) return true;
    const basename = value.slice(value.lastIndexOf("/") + 1);
    return binaries.includes(basename.replace(BROWSER_AUTOMATION_LAUNCH_SUFFIX, ""));
  });
}

/** Commands both implementations of `isBrowserAutomationCommand` are checked against. */
export const HOST_MCP_BROWSER_AUTOMATION_VECTORS: readonly { readonly command: readonly string[]; readonly refused: boolean }[] = [
  { command: ["npx", "-y", "@playwright/mcp@latest"], refused: true },
  { command: ["npx", "@playwright/mcp"], refused: true },
  { command: ["npx.cmd", "-y", "@Playwright/MCP@0.0.41", "--headless"], refused: true },
  { command: ["pnpm", "dlx", "chrome-devtools-mcp@latest"], refused: true },
  { command: ["bunx", "@executeautomation/playwright-mcp-server"], refused: true },
  { command: ["npx", "-y", "@modelcontextprotocol/server-puppeteer"], refused: true },
  { command: ["npx", "puppeteer-mcp-server@1.2.3"], refused: true },
  { command: ["npx", "@browsermcp/mcp@latest"], refused: true },
  { command: ["npx", "-y", "@agent-infra/mcp-server-browser"], refused: true },
  { command: ["uvx", "playwright-mcp"], refused: true },
  { command: ["playwright-mcp"], refused: true },
  { command: ["C:\\Users\\me\\AppData\\Roaming\\npm\\playwright-mcp.cmd", "--port", "8931"], refused: true },
  { command: ["C:\\tools\\Chrome-DevTools-MCP.EXE"], refused: true },
  { command: ["/usr/local/bin/mcp-server-puppeteer"], refused: true },
  { command: ["node", "C:\\mcp\\bin\\chrome-devtools.bat"], refused: true },
  { command: [" @playwright/mcp "], refused: true },
  { command: ["node", "C:\\p\\node_modules\\@playwright\\mcp\\cli.js"], refused: true },
  { command: ["node", "C:\\p\\node_modules\\@playwright\\mcp"], refused: true },
  { command: ["npx", "--package=@playwright/mcp@latest", "cli"], refused: true },
  { command: ["npx", "-p=@playwright/mcp", "x"], refused: true },
  { command: ["npx", "-p", "@playwright/mcp", "x"], refused: true },
  { command: ["uvx", "--from=chrome-devtools-mcp@1.0", "x"], refused: true },
  { command: ["uvx", "--from=playwright-mcp", "x"], refused: true },
  { command: ["npx", "npm:@playwright/mcp@latest"], refused: true },
  { command: ["npx", "--package=npm:@playwright/mcp", "x"], refused: true },
  { command: ["npx", "@playwright/mcp/cli"], refused: true },
  { command: ["C:\\tools\\playwright-mcp.cmd."], refused: true },
  { command: ["C:\\tools\\playwright-mcp.exe . "], refused: true },
  { command: ["playwright-mcp.com"], refused: true },
  { command: ["playwright-mcp.ps1"], refused: true },
  { command: ["C:\\x\\playwright-mcp.js"], refused: true },
  { command: ["node", "/opt/mcp/mcp-server-puppeteer.mjs"], refused: true },
  { command: ["node", "chrome-devtools-mcp.cjs"], refused: true },
  { command: ["npx", "-y", "@playwright/test"], refused: false },
  { command: ["npx", "-y", "@playwright/mcp-extension"], refused: false },
  { command: ["playwright-mcp-helper"], refused: false },
  { command: ["npx", "my-playwright-mcp"], refused: false },
  { command: ["npx", "-y", "@modelcontextprotocol/server-filesystem", "C:\\work"], refused: false },
  { command: ["uvx", "windows-mcp"], refused: false },
  { command: ["python", "-m", "playwright_mcp"], refused: false },
  { command: ["node", "C:\\mcp\\chrome-devtools-mcp-wrapper.js"], refused: false },
  { command: ["npx", "puppeteer-mcp-server-fork"], refused: false },
  { command: ["npx", "--package=@playwright/test", "playwright"], refused: false },
  { command: ["node", "C:\\p\\node_modules\\@playwright\\mcp-extension\\cli.js"], refused: false },
  { command: ["node", "C:\\p\\node_modules\\@playwright\\test\\cli.js"], refused: false },
  { command: ["npx", "npm:@playwright/test"], refused: false },
  { command: ["C:\\tools\\playwright-mcp-helper.ps1"], refused: false },
  { command: ["uvx", "--from=puppeteer-mcp-server-fork", "x"], refused: false },
];

export const HostMcpErrorSchema = z
  .object({
    error: z
      .object({ code: HostMcpErrorCodeSchema, message: z.string() })
      .strict()
      .refine(
        (error) => error.message === HOST_MCP_ERRORS[error.code].message,
        "the message is the code's fixed sentence"
      ),
  })
  .strict();
export type HostMcpError = z.infer<typeof HostMcpErrorSchema>;

/** Why the gateway refused a `tools/call`, returned to the runtime as a tool result with `isError: true`. */
export const HostMcpCallRefusalSchema = z.enum([
  "denied",
  "approval_timeout",
  "session_locked",
  "server_unavailable",
  "cancelled",
  "stopped_by_user",
  "cancelled_by_user",
]);
export type HostMcpCallRefusal = z.infer<typeof HostMcpCallRefusalSchema>;

/**
 * The tool result's text for each refusal. The agent reads it, so it says what happened and what to
 * do next: tell the user rather than retry on its own. `cancelled` is answered to a request the
 * client cancelled (or dropped) while it waited, so the client is normally no longer listening.
 */
export const HOST_MCP_CALL_REFUSAL_TEXT: { readonly [R in HostMcpCallRefusal]: string } = {
  denied: "The user denied this action on their computer, so it was not run. Do not retry it unless the user asks you to.",
  approval_timeout:
    "The approval request on the user's computer expired before they answered, so the action was not run. Tell the user it expired and ask whether to try again; do not retry it on your own.",
  session_locked:
    "The user's computer is locked, so the action was not run. Tell the user and wait for them to unlock it before trying again.",
  server_unavailable:
    "The MCP server on the user's computer is not running, so the action was not run. Tell the user.",
  cancelled: "The request was cancelled before the user answered, so the action was not run.",
  stopped_by_user:
    "The user stopped the tools on their computer, so the action was not run. Do not retry it; tell the user they can resume the tools in SuperClaw.",
  cancelled_by_user:
    "The user cancelled this action on their computer, so it did not finish. Do not retry it unless the user asks you to.",
};

export const HOST_MCP_SERVER_STATES = ["stopped", "starting", "running", "failed"] as const;
export const HostMcpServerStateSchema = z.enum(HOST_MCP_SERVER_STATES);
export type HostMcpServerState = z.infer<typeof HostMcpServerStateSchema>;

const HostMcpEnvironmentNameSchema = z.string().regex(/^[^=]+$/);

/**
 * A registered host server. Environment values never leave the gateway; only their names do.
 * `always_grants` are the tools granted `always`, by raw tool name.
 */
export const HostMcpServerSchema = z
  .object({
    name: McpServerNameSchema,
    command: z.array(z.string().min(1).max(HOST_MCP_COMMAND_ARG_MAX_CHARS)).min(1),
    environment_keys: z.array(HostMcpEnvironmentNameSchema).max(HOST_MCP_ENVIRONMENT_MAX_KEYS),
    approval_mode: HostMcpApprovalModeSchema,
    allow_when_locked: z.boolean(),
    state: HostMcpServerStateSchema,
    /** Why the server is `failed`, when the gateway knows. */
    error_code: HostMcpErrorCodeSchema.optional(),
    always_grants: z.array(HostMcpTextSchema),
  })
  .strict();
export type HostMcpServer = z.infer<typeof HostMcpServerSchema>;

export const HostMcpServerListSchema = z
  .object({ servers: z.array(HostMcpServerSchema).max(HOST_MCP_SERVER_MAX) })
  .strict();
export type HostMcpServerList = z.infer<typeof HostMcpServerListSchema>;

/**
 * `PUT /mcp-host/v1/servers/{name}`. A second PUT replaces the config whole and keeps the runtime
 * token. `allow_when_locked` absent is false: a call while the session is locked is refused.
 *
 * The generated Pydantic model does not bound `environment`'s key count; the gateway applies
 * `environment_max_keys` from the published rules.
 */
export const HostMcpServerRegisterRequestSchema = z
  .object({
    command: z.array(z.string().min(1).max(HOST_MCP_COMMAND_ARG_MAX_CHARS)).min(1),
    environment: z
      .record(HostMcpEnvironmentNameSchema, z.string())
      .refine((environment) => Object.keys(environment).length <= HOST_MCP_ENVIRONMENT_MAX_KEYS, {
        message: `at most ${HOST_MCP_ENVIRONMENT_MAX_KEYS} environment variables`,
      })
      .optional(),
    approval_mode: HostMcpApprovalModeSchema.optional(),
    allow_when_locked: z.boolean().optional(),
  })
  .strict();
export type HostMcpServerRegisterRequest = z.infer<typeof HostMcpServerRegisterRequestSchema>;

/** What the workspace stores as the server's `remote` entry, with `oauth: false`. */
export const HostMcpRuntimeEndpointSchema = z
  .object({
    url: z.string().regex(HOST_MCP_RUNTIME_URL_PATTERN),
    headers: z.object({ Authorization: z.string().regex(HOST_MCP_RUNTIME_AUTHORIZATION_PATTERN) }).strict(),
  })
  .strict();
export type HostMcpRuntimeEndpoint = z.infer<typeof HostMcpRuntimeEndpointSchema>;

export const HostMcpServerRegistrationSchema = z
  .object({ server: HostMcpServerSchema, runtime: HostMcpRuntimeEndpointSchema })
  .strict()
  .refine((registration) => registration.runtime.url === HOST_MCP_RUNTIME_URL_PREFIX + registration.server.name, {
    message: "the runtime URL names the registered server",
  });
export type HostMcpServerRegistration = z.infer<typeof HostMcpServerRegistrationSchema>;

export const HostMcpOkSchema = z.object({ ok: z.literal(true) }).strict();
export type HostMcpOk = z.infer<typeof HostMcpOkSchema>;

const PENDING_APPROVAL_COMMON = {
  approval_id: CorrelationIdSchema,
  requested_at: IsolationInstantSchema,
  expires_at: IsolationInstantSchema,
};

const hasNoDuplicates = (scopes: readonly string[]): boolean => new Set(scopes).size === scopes.length;

/**
 * A held `tools/call`. Every field is what the gateway saw, never what the runtime said about it.
 * `grant_scopes` is exactly `hostMcpOfferedScopes(annotations)`, so `always` is never offered for a
 * tool that is not read-only. The generated Pydantic model cannot say that; the gateway builds the
 * list with its own `hostMcpOfferedScopes` and the vectors hold the two alike.
 */
export const HostMcpToolCallApprovalSchema = z
  .object({
    kind: z.literal("tool_call"),
    ...PENDING_APPROVAL_COMMON,
    grant_scopes: z.array(HostMcpGrantScopeSchema).min(1).max(3),
    server: McpServerNameSchema,
    tool: HostMcpTextSchema,
    title: HostMcpTextSchema.optional(),
    annotations: HostMcpToolAnnotationsSchema,
    /** Absent when the call has no arguments. */
    arguments_preview: HostMcpTextSchema.optional(),
  })
  .strict()
  .refine(
    (approval) => {
      const offered = hostMcpOfferedScopes(approval.annotations);
      return (
        hasNoDuplicates(approval.grant_scopes) &&
        approval.grant_scopes.length === offered.length &&
        approval.grant_scopes.every((scope) => offered.includes(scope))
      );
    },
    { message: "the grant scopes are the ones the tool's annotations offer, each once" }
  );
export type HostMcpToolCallApproval = z.infer<typeof HostMcpToolCallApprovalSchema>;

/** A host browser navigation to an origin the policy says to ask about. Never offered `always`. */
export const HostMcpBrowserOriginApprovalSchema = z
  .object({
    kind: z.literal("browser_origin"),
    ...PENDING_APPROVAL_COMMON,
    grant_scopes: z.array(HostMcpGrantScopeSchema.exclude(["always"])).min(1).max(2),
    origin: HostMcpTextSchema,
  })
  .strict()
  .refine((approval) => hasNoDuplicates(approval.grant_scopes), {
    message: "each grant scope is offered once",
  });
export type HostMcpBrowserOriginApproval = z.infer<typeof HostMcpBrowserOriginApprovalSchema>;

export const HostMcpPendingApprovalSchema = z.discriminatedUnion("kind", [
  HostMcpToolCallApprovalSchema,
  HostMcpBrowserOriginApprovalSchema,
]);
export type HostMcpPendingApproval = z.infer<typeof HostMcpPendingApprovalSchema>;

/** `GET /mcp-host/v1/approvals`: the requests waiting, oldest first. */
export const HostMcpPendingApprovalListSchema = z
  .object({ approvals: z.array(HostMcpPendingApprovalSchema).max(HOST_MCP_PENDING_APPROVALS_MAX) })
  .strict();
export type HostMcpPendingApprovalList = z.infer<typeof HostMcpPendingApprovalListSchema>;

export const HostMcpApprovalDecisionSchema = z.enum(["approve", "deny"]);
export type HostMcpApprovalDecision = z.infer<typeof HostMcpApprovalDecisionSchema>;

/** An approval without a scope is `once`. A scope the approval did not offer is a 409. */
export const HostMcpApprovalDecisionRequestSchema = z
  .object({ decision: HostMcpApprovalDecisionSchema, grant_scope: HostMcpGrantScopeSchema.optional() })
  .strict()
  .refine((request) => request.grant_scope === undefined || request.decision === "approve", {
    message: "a denial has no grant scope",
  });
export type HostMcpApprovalDecisionRequest = z.infer<typeof HostMcpApprovalDecisionRequestSchema>;

export const HostMcpApprovalDecisionResultSchema = z.union([
  z
    .object({
      approval_id: CorrelationIdSchema,
      decision: z.literal("approve"),
      outcome: z.literal("granted"),
      grant_scope: HostMcpGrantScopeSchema.optional(),
    })
    .strict(),
  z
    .object({
      approval_id: CorrelationIdSchema,
      decision: z.literal("deny"),
      outcome: z.literal("denied"),
    })
    .strict(),
]);
export type HostMcpApprovalDecisionResult = z.infer<typeof HostMcpApprovalDecisionResultSchema>;

const CountSchema = z.number().int().min(0);

export const HOST_MCP_ACTIVE_CALLS_MAX = 16;
export const HOST_MCP_ACTIVE_CALL_STATES = ["awaiting_approval", "running", "waiting_for_user"] as const;

/**
 * One `tools/call` the gateway is handling, so the UI can say that SuperClaw is operating the
 * computer and let the user cancel just that action (`POST /v1/calls/{call_id}/cancel`).
 * `awaiting_approval` while it is held for the user, `running` while the server runs it, and
 * `waiting_for_user` while the server has yielded the desktop to the user (USER_CONTROL) and the
 * gateway waits to send it again: `resume_in_ms` is how long until then, and is null in the other
 * states. `computer_use` is true once this server has ever yielded the desktop, which marks it as a
 * server that operates the user's input; the gateway keeps that per server in its registry.
 */
export const HostMcpActiveCallSchema = z
  .object({
    call_id: CorrelationIdSchema,
    server: McpServerNameSchema,
    tool: HostMcpTextSchema,
    state: z.enum(HOST_MCP_ACTIVE_CALL_STATES),
    resume_in_ms: z.number().int().min(0).nullable(),
    computer_use: z.boolean(),
  })
  .strict()
  .refine((call) => (call.resume_in_ms !== null) === (call.state === "waiting_for_user"), {
    message: "resume_in_ms is set exactly while the call waits for the user",
  });
export type HostMcpActiveCall = z.infer<typeof HostMcpActiveCallSchema>;

/**
 * `server_count` is every registered server; `running_count` the ones in `running`. Unguarded, like
 * `summary`: ServiceHub's aggregate status calls `/v1/status` without a forwarded credential. The
 * body is counts and booleans, and in `active_calls` the server and tool names of the calls in
 * flight, newest first (no arguments).
 *
 * `paused` is true from a `stop-all` until `resume` (or until the gateway restarts: the pause is held
 * in memory). While paused no host server starts, every `tools/call` is refused as `stopped_by_user`,
 * and the browser relay takes no new connection.
 */
export const HostMcpStatusSchema = z
  .object({
    server_count: CountSchema,
    running_count: CountSchema,
    browser_configured: z.boolean(),
    browser_active: z.boolean(),
    session_locked: z.boolean(),
    paused: z.boolean(),
    active_calls: z.array(HostMcpActiveCallSchema).max(HOST_MCP_ACTIVE_CALLS_MAX),
  })
  .strict();
export type HostMcpStatus = z.infer<typeof HostMcpStatusSchema>;

/**
 * `GET /mcp-host/v1/summary`, unguarded: the Sandbox Manager reads it to build the isolation report's
 * `host_mcp_execution_enabled` warning. Counts and booleans only. `host_server_count` is the running
 * host servers.
 */
export const HostMcpSummarySchema = z
  .object({ host_server_count: CountSchema, host_browser_active: z.boolean() })
  .strict();
export type HostMcpSummary = z.infer<typeof HostMcpSummarySchema>;

export const HostMcpStopAllResultSchema = z
  .object({ stopped_servers: CountSchema, browser_stopped: z.boolean() })
  .strict();
export type HostMcpStopAllResult = z.infer<typeof HostMcpStopAllResultSchema>;

/** `scheme://host[:port]`, lowercase, http or https, no path, no userinfo, no trailing slash. */
export const HOST_BROWSER_ORIGIN_PATTERN =
  /^https?:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::[1-9][0-9]{0,4})?$/;

/**
 * An origin in its one spelling: the URL parser's own serialization of it. That refuses a port over
 * 65535, a scheme's default port written out (`http://a.com:80`, `https://a.com:443`) and a host the
 * parser rewrites, such as `http://127.1`. The generated Pydantic model checks the pattern only; the
 * gateway compares with its own parser's serialization too.
 */
export const HostBrowserOriginSchema = z
  .string()
  .regex(HOST_BROWSER_ORIGIN_PATTERN)
  .refine(
    (origin) => {
      try {
        return new URL(origin).origin === origin;
      } catch {
        return false;
      }
    },
    { message: "the origin is written the one way a URL parser writes it" }
  );

/** Drive-absolute, such as `C:\Users\me\Downloads`. No UNC or device path, no stream name. */
export const HOST_WINDOWS_ABSOLUTE_PATH_PATTERN = /^[A-Za-z]:\\[^\p{Cc}<>:"|?*]*$/u;

/** A segment with one of these names, with or without an extension, in any case, opens a device. */
export const HOST_WINDOWS_RESERVED_DEVICE_NAMES = [
  "CON",
  "PRN",
  "AUX",
  "NUL",
  ...["1", "2", "3", "4", "5", "6", "7", "8", "9"].flatMap((digit) => [`COM${digit}`, `LPT${digit}`]),
] as const;

/** Windows strips a trailing dot or space, so such a segment names a different file than it reads. */
function isPlainWindowsSegment(segment: string): boolean {
  if (segment === "." || segment === ".." || segment.endsWith(".") || segment.endsWith(" ")) return false;
  const base = segment.split(".")[0].trimEnd().toUpperCase();
  return !(HOST_WINDOWS_RESERVED_DEVICE_NAMES as readonly string[]).includes(base);
}

/**
 * The generated Pydantic model checks the pattern only; the gateway applies the segment rules with
 * `windows_reserved_device_names` from the published rules.
 */
export const HostWindowsAbsolutePathSchema = z
  .string()
  .regex(HOST_WINDOWS_ABSOLUTE_PATH_PATTERN)
  .refine((path) => path.slice(3).split("\\").filter((segment) => segment !== "").every(isPlainWindowsSegment), {
    message: "no dot segment, no segment ending in a dot or space, and no device name",
  });

export const HostBrowserOriginDefaultSchema = z.enum(["allow", "ask", "deny"]);
export type HostBrowserOriginDefault = z.infer<typeof HostBrowserOriginDefaultSchema>;

/** An origin in both `allow` and `deny` is denied: the relay applies `deny` first. */
export const HostBrowserOriginPolicySchema = z
  .object({
    default: HostBrowserOriginDefaultSchema,
    allow: z.array(HostBrowserOriginSchema),
    deny: z.array(HostBrowserOriginSchema),
  })
  .strict();
export type HostBrowserOriginPolicy = z.infer<typeof HostBrowserOriginPolicySchema>;

/**
 * `PUT /mcp-host/v1/browser`. An absent field keeps the gateway's default: `downloads` under
 * `%USERPROFILE%\SuperClawProjects`, that root as the one upload root, and every origin allowed.
 */
export const HostBrowserConfigRequestSchema = z
  .object({
    downloads_dir: HostWindowsAbsolutePathSchema.optional(),
    upload_roots: z.array(HostWindowsAbsolutePathSchema).max(HOST_BROWSER_UPLOAD_ROOTS_MAX).optional(),
    origin_policy: HostBrowserOriginPolicySchema.optional(),
  })
  .strict();
export type HostBrowserConfigRequest = z.infer<typeof HostBrowserConfigRequestSchema>;

/**
 * The browser's state. `cdp_endpoint` is set exactly when the browser is configured, and keeps its
 * relay token until `DELETE`. `active` is an Edge running, which only a configured browser can be:
 * it starts on the first CDP connection and ends on `stop`, `stop-all` or `DELETE`.
 */
export const HostBrowserViewSchema = z
  .object({
    configured: z.boolean(),
    active: z.boolean(),
    cdp_endpoint: z.string().regex(HOST_MCP_CDP_ENDPOINT_PATTERN).nullable(),
  })
  .strict()
  .refine((view) => (view.cdp_endpoint !== null) === view.configured, {
    message: "a CDP endpoint is listed exactly when the browser is configured",
  })
  .refine((view) => view.configured || !view.active, {
    message: "only a configured browser can be active",
  });
export type HostBrowserView = z.infer<typeof HostBrowserViewSchema>;

/**
 * What the gateway reads and a JSON Schema cannot carry, published so Python spells none of it.
 *
 * `cdp` is the relay filter. A CDP method outside `allowed_cdp_domains`, or in `blocked_cdp_methods`,
 * is never forwarded as sent. Playwright sends `Browser.setDownloadBehavior` when it sets a context
 * up, so the relay answers that one with its own downloads directory applied rather than an error.
 * A navigation, a new target or an intercepted request whose URL has a scheme in
 * `blocked_url_schemes` is refused; for `data`, that is a browser-initiated top-level navigation
 * (`Page.navigate`, `Target.createTarget`), and `about:blank` stays allowed. `Tracing` is not
 * allowed because `IO` is not, so a trace stream could not be read. `Network.clearBrowserCache` is
 * blocked because which context's cache it clears is not measured; the cookie methods on a page
 * session stay in that page's own context (measured, Edge 156).
 *
 * With `block_private_network_destinations`, the relay refuses a browser-initiated navigation whose
 * host is, or resolves to, a loopback, private, link-local, CGNAT, multicast, unspecified or
 * otherwise reserved address, IPv4 or IPv6 (IPv4-mapped included), unless that exact origin is in
 * `origin_policy.allow`. This is checked before the configurable origin policy.
 *
 * `edge_required_args` go on every Edge launch: they turn ambient Windows authentication off, so an
 * intranet site does not get the user's identity automatically, and turn Edge's implicit sign-in
 * (`msImplicitSignin`, an Edge-internal feature name) off, so the profile never takes the Windows
 * work account. With it on, Edge 156 also crashes in an off-the-record context after leaving a
 * Microsoft login page. Chromium reads only the last `--disable-features`, so this is the launch's
 * only one and carries every feature Edge turns off, the sidebar included.
 */
export const HOST_MCP_RULES = {
  port: HOST_MCP_PORT,
  proxy_prefix: HOST_MCP_PROXY_PREFIX,
  runtime_url_prefix: HOST_MCP_RUNTIME_URL_PREFIX,
  cdp_url_prefix: HOST_MCP_CDP_URL_PREFIX,
  server_name_pattern: MCP_SERVER_NAME_PATTERN.source,
  token_pattern: HOST_MCP_TOKEN_PATTERN.source,
  forwarded_credential_header: "X-SuperClaw-Forwarded-Credential",
  forwarded_credential_label: "superclaw/servicehub-forwarded-request/v1",
  unguarded_paths: ["/mcp-host/v1/health", "/mcp-host/v1/status", "/mcp-host/v1/summary"],
  default_approval_mode: HOST_MCP_DEFAULT_APPROVAL_MODE,
  approval_timeout_ms: HOST_MCP_APPROVAL_TIMEOUT_MS,
  progress_keepalive_ms: HOST_MCP_PROGRESS_KEEPALIVE_MS,
  no_progress_approval_timeout_ms: HOST_MCP_NO_PROGRESS_APPROVAL_TIMEOUT_MS,
  idle_stop_ms: HOST_MCP_IDLE_STOP_MS,
  approvals_max_wait_ms: HOST_MCP_APPROVALS_MAX_WAIT_MS,
  pending_max: HOST_MCP_PENDING_APPROVALS_MAX,
  server_max: HOST_MCP_SERVER_MAX,
  active_calls_max: HOST_MCP_ACTIVE_CALLS_MAX,
  /** How often one call is sent again after the server yielded the desktop to the user. */
  user_control_retries_max: 3,
  text_max_utf16_units: HOST_MCP_TEXT_MAX_UTF16_UNITS,
  command_arg_max_chars: HOST_MCP_COMMAND_ARG_MAX_CHARS,
  environment_max_keys: HOST_MCP_ENVIRONMENT_MAX_KEYS,
  upload_roots_max: HOST_BROWSER_UPLOAD_ROOTS_MAX,
  browser_automation_commands: HOST_MCP_BROWSER_AUTOMATION_COMMANDS,
  windows_reserved_device_names: HOST_WINDOWS_RESERVED_DEVICE_NAMES,
  edge_required_args: [
    "--auth-server-allowlist=none.invalid",
    "--auth-negotiate-delegate-allowlist=none.invalid",
    "--disable-features=msEdgeSidebarV2,msImplicitSignin",
  ],
  cdp: {
    blocked_url_schemes: [
      "file",
      "chrome",
      "edge",
      "devtools",
      "view-source",
      "chrome-extension",
      "javascript",
      "data",
    ],
    block_private_network_destinations: true,
    allowed_cdp_domains: [
      "Accessibility",
      "Browser",
      "CSS",
      "Console",
      "DOM",
      "Debugger",
      "Emulation",
      "Fetch",
      "Input",
      "Inspector",
      "Log",
      "Network",
      "Overlay",
      "Page",
      "Performance",
      "Runtime",
      "Security",
      "Target",
    ],
    blocked_cdp_methods: [
      "Browser.close",
      "Browser.crash",
      "Browser.crashGpuProcess",
      "Browser.executeBrowserCommand",
      "Browser.grantPermissions",
      "Browser.setDownloadBehavior",
      "Browser.setPermission",
      "Network.clearBrowserCache",
      "Network.continueInterceptedRequest",
      "Network.loadNetworkResource",
      "Page.setDownloadBehavior",
      "Target.attachToBrowserTarget",
      "Target.exposeDevToolsProtocol",
      "Target.setRemoteLocations",
    ],
  },
} as const;
