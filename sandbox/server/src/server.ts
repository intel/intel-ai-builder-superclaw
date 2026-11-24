import { constants } from "node:fs";
import { open, readFile, writeFile, rm, readdir, rename, stat, mkdtemp } from "node:fs/promises";
import { createHash } from "node:crypto";
import { hostname, tmpdir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { ConfigPatchRequestSchema } from "@different-ai/openwork-contracts/config-patch";
import type { ApprovalRequest, Capabilities, ServerConfig, WorkspaceInfo, Actor, ReloadReason, ReloadTrigger, TokenScope } from "./types.js";
import { ApprovalService } from "./approvals.js";
import { addPlugin, listPlugins, normalizePluginSpec, removePlugin } from "./plugins.js";
import { migrateWorkspaceMcpPermissions } from "./mcp/mcp-permission-migration.js";
import { buildToolGate } from "./mcp/mcp-tool-gate.js";
import { registerMcpRoutes } from "./mcp/routes.js";
import { assertOpencodeProxyMcpReadOnly, gateOpencodeConfigMcp, normalizeOpencodeProxyPath } from "./mcp/write-gate.js";
import { deleteSkill, listSkills, upsertSkill } from "./skills.js";
import { listAgentToolSkillCatalog } from "./tool-skill-catalog.js";
import {
  type HybridDrProgressRegistry, hybridDrRegistryDisplay, hybridDrTitleForPhase, hybridDrToolIdCandidates,
  hybridDrToolOutputStatus, terminalHybridDrRegistry, validHybridDrRegistry,
} from "./hybrid-dr-progress.js";
import { installHubSkill, listHubSkills } from "./skill-hub.js";
import { deleteCommand, listCommands, upsertCommand } from "./commands.js";
import { deleteScheduledJob, isLegacySchedulerSupported, listScheduledJobs, resolveScheduledJob } from "./scheduler.js";
import { ApiError, formatError, throwIfRuntimeCredentialRejected } from "./errors.js";
import { stageOutboundFile } from "./outbound-attachment.js";
import {
  assertAutomationAgentRunnable,
  isAutomationDue,
  normalizeAutomationAgent,
  parseAgentLabSchedule,
  readAutomationAgentUpdate,
  validateAgentLabAutomationId,
  type AgentLabAutomation,
  type AgentLabSchedule,
  type AgentLabAutomationStore,
} from "./agentlab-automation.js";
import { applyRunResults, exclusiveAutomationDispatch, noteDispatchedAgent, parseModelString, recordRefusedRun, resolveAutomationRunTarget, skipWhileRunning } from "./agentlab-automation-dispatch.js";
import { requireClient, requireHost, requireTelemetry } from "./auth.js";
import { readJsoncFile, updateJsoncTopLevel, writeJsoncFile } from "./jsonc.js";
import { recordAudit, readAuditEntries, readLastAudit } from "./audit.js";
import { ReloadEventStore } from "./events.js";
import { parseFrontmatter } from "./frontmatter.js";
import { opencodeConfigPath, openworkConfigPath, projectAgentsDir, projectCommandsDir, projectSkillsDir } from "./workspace-files.js";
import { ensureDir, exists, hashToken, shortId } from "./utils.js";
import {
  createProtectedFileTextRestorer,
  isRestorableProtectedFile,
  ProtectedFileContentTooLargeError,
  type ProtectedPipelineOperationInfo,
} from "./protected-pipeline-file-restore.js";
import { workspaceIdForPath } from "./workspaces.js";
import { sanitizeCommandName, validateSkillName } from "./validators.js";
import { TokenService } from "./tokens.js";
import { TOY_UI_CSS, TOY_UI_FAVICON_SVG, TOY_UI_HTML, TOY_UI_JS, cssResponse, htmlResponse, jsResponse, svgResponse } from "./toy-ui.js";
import { FileSessionStore } from "./file-sessions.js";
import { reserveNextAvailableInboxPath, renameOverReservedPath } from "./inbox-upload-path.js";
import { resolveSafeChildPath } from "./safe-path.js";
import {
  SUPERCLAW_RUNTIME_SETTINGS_FILE,
  patchSuperclawRuntimeSettings,
  readSuperclawRuntimeSettings,
  serializeSuperclawRuntimeSettings,
  superclawRuntimeSettingsPath,
} from "./runtime-settings.js";
import { registerGithubRoutes } from "./github-routes.js";
import { registerMaskedReviewRoutes } from "./masked-review-routes.js";
import {
  isDebugObservabilityEnabled,
  fetchIntentTracesFromClassifier,
  probeOpencodeRouterSlice,
} from "./observability.js";
import {
  recordRuntimeMetricEvent,
  isMetricsExportEnabled,
  type RuntimeTelemetryEvent,
} from "./runtime-telemetry.js";
import { proxyIntentClassifierRequest } from "./intent-classifier-proxy.js";
import { isUiPollPath } from "./ui-poll-paths.js";
import { ensureLoggerProviderInitialized } from "./otel-logs.js";
import { ensureMeterProviderInitialized } from "./otel-metrics.js";
import { installServerCrashHandlers } from "./crash.js";
import { fetchRuntimeControl, fetchRuntimeControlResponse } from "./runtime-control.js";
import { isRewritableSpreadsheet, stripSpreadsheetViewState } from "./spreadsheet-view.js";
import { requireSoffice } from "./soffice-path.js";
import { SkillPackageImportStore } from "./skill-package-imports.js";
import { GMAIL_PAUSED_TOKEN_FILE, checkGmailApis, completeGmailOAuth, gmailDataDir, gmailPaused, gmailScriptCommand, gmailScriptDir, gmailUvEnv, migrateLegacyGmailData, removeGmailTokens } from "./gmail.js";
import { registerGmailEnabledRoute } from "./gmail-routes.js";
import { SKILL_PACKAGE_IMPORT_LIMITS } from "@different-ai/openwork-contracts/skill-package";
import { EGRESS_APPROVAL_GRANT_RULES } from "@different-ai/openwork-contracts/egress-approval-grant";
import pkg from "../package.json" with { type: "json" };

const SERVER_VERSION = pkg.version;

// Default deadline for the opencode proxy fetch when a caller does not declare
// its own. A caller that knows its turn budget can override this by sending the
// `x-openwork-timeout-ms` header (e.g. the batch-runner forwards each case's
// `timeout_s`); an explicit header wins even when larger than this default. The
// proxy also binds to `input.request.signal` so a client disconnect aborts the
// upstream immediately regardless of deadline.
const OPENCODE_PROXY_DEFAULT_TIMEOUT_MS = 30 * 60_000;
const OPENCODE_PROXY_TIMEOUT_HEADER = "x-openwork-timeout-ms";
// Enough for opencode's error envelope plus a stack-shaped detail, small enough
// that a pathological upstream body cannot flood the access log.
const OPENCODE_UPSTREAM_ERROR_LOG_LIMIT = 2_000;

const FILE_SESSION_DEFAULT_TTL_MS = 15 * 60 * 1000;
const FILE_SESSION_MIN_TTL_MS = 30 * 1000;
const FILE_SESSION_MAX_TTL_MS = 24 * 60 * 60 * 1000;
const FILE_SESSION_MAX_BATCH_ITEMS = 64;
const FILE_SESSION_MAX_FILE_BYTES = 5_000_000;
const PROJECT_CONTENT_MAX_BYTES = 25_000_000;
const FILE_SESSION_CATALOG_DEFAULT_LIMIT = 2000;
const FILE_SESSION_CATALOG_MAX_LIMIT = 10000;
const AGENTLAB_AUTOMATION_CONTEXT_RUNS = 5;
const HYBRID_DR_PROGRESS_CACHE_TTL_MS = 1500;

type LogLevel = "info" | "warn" | "error";

type LogAttributes = Record<string, unknown>;

type ServerLogger = {
  log: (level: LogLevel, message: string, attributes?: LogAttributes) => void;
};

type HybridDrProgressCacheEntry = {
  fetchedAt: number;
  title: string;
  terminal: boolean;
  display?: Record<string, unknown>;
};

const hybridDrProgressCache = new Map<string, HybridDrProgressCacheEntry>();

const LOG_LEVEL_NUMBERS: Record<LogLevel, number> = {
  info: 9,
  warn: 13,
  error: 17,
};

function toUnixNano(): string {
  return (BigInt(Date.now()) * 1_000_000n).toString();
}

export function createServerLogger(config: ServerConfig): ServerLogger {
  const runId = process.env.OPENWORK_RUN_ID ?? shortId();
  const host = hostname().trim();
  const resource: Record<string, string> = {
    "service.name": "openwork-server",
    "service.version": SERVER_VERSION,
    "service.instance.id": runId,
  };
  if (host) {
    resource["host.name"] = host;
  }
  const baseAttributes: LogAttributes = {
    "run.id": runId,
    "process.pid": process.pid,
  };

  const emit = (level: LogLevel, message: string, attributes?: LogAttributes) => {
    const merged = { ...baseAttributes, ...(attributes ?? {}) };
    if (config.logFormat === "json") {
      const record = {
        timeUnixNano: toUnixNano(),
        severityText: level.toUpperCase(),
        severityNumber: LOG_LEVEL_NUMBERS[level],
        body: message,
        attributes: merged,
        resource,
      };
      process.stdout.write(`${JSON.stringify(record)}\n`);
      return;
    }
    process.stdout.write(`${message}\n`);
  };

  return { log: emit };
}

const HEALTH_PROBE_PATHS = new Set<string>([
  "/health",
  "/capabilities",
  "/opencode/global/health",
  "/opencode-router/health",
]);

// Workspace-mounted equivalents under /w/<wsId>/...:
//   /health, /capabilities, /opencode/event (SSE), /opencode/global/health, /opencode-router/health
const MOUNTED_HEALTH_PROBE_RE =
  /^\/w\/[^/]+\/(health|capabilities|opencode\/(event|global\/health)|opencode-router\/health)$/;

export function isHealthProbePath(pathname: string): boolean {
  return HEALTH_PROBE_PATHS.has(pathname) || MOUNTED_HEALTH_PROBE_RE.test(pathname);
}

// Re-exported so callers (and the tests that cover it) keep importing it from
// here; the matcher itself moved to ui-poll-paths.ts, which runtime-telemetry.ts
// also needs and must not import from this module.
export { isUiPollPath };

// Suppress only successful (2xx/3xx) access logs on known low-signal paths:
// health probes, UI polling endpoints, and CORS preflight (OPTIONS).
// Every 4xx/5xx — including 401 — still logs so genuine auth/permission
// failures surface during boot and reconnect.
export function shouldSuppressAccessLog(pathname: string, status: number, method?: string): boolean {
  if (status >= 400) return false;
  if (isHealthProbePath(pathname)) return true;
  if (isUiPollPath(pathname)) return true;
  // CORS preflight for any path: 2xx/3xx OPTIONS is never interesting.
  if (method && method.toUpperCase() === "OPTIONS") return true;
  return false;
}

function logRequest(input: {
  logger: ServerLogger;
  request: Request;
  response: Response;
  durationMs: number;
  authMode: AuthMode;
  proxyService?: "opencode" | "opencode-router";
  proxyBaseUrl?: string;
  error?: string;
}) {
  const { logger, request, response, durationMs, authMode, proxyService, proxyBaseUrl, error } = input;
  const status = response.status;
  const url = new URL(request.url);
  if (shouldSuppressAccessLog(url.pathname, status, request.method)) {
    return;
  }
  const level: LogLevel = status >= 500 ? "error" : status >= 400 ? "warn" : "info";
  const method = request.method.toUpperCase();
  const proxyLabel = proxyBaseUrl ? ` (${proxyService ?? "proxy"})` : "";
  const message = `${method} ${url.pathname} ${status} ${durationMs}ms${proxyLabel}`;
  const attributes: LogAttributes = {
    method,
    path: url.pathname,
    status,
    durationMs,
    auth: authMode,
  };
  if (proxyBaseUrl) {
    attributes["proxy.base_url"] = proxyBaseUrl;
    if (proxyService) attributes["proxy.service"] = proxyService;
  }
  if (error) {
    attributes.error = error;
  }
  logger.log(level, message, attributes);
}

export type AuthMode = "none" | "client" | "host" | "telemetry";

function normalizeOpenCodeRouterProxyPath(pathname: string): string {
  const trimmed = pathname.trim();
  if (!trimmed) return "/opencode-router";
  if (trimmed === "/opencode-router/") return "/opencode-router";
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

function resolveOpenCodeRouterProxyPolicy(
  method: string,
  pathname: string,
): { auth: AuthMode; requiredScope?: TokenScope } {
  const normalized = normalizeOpenCodeRouterProxyPath(pathname);
  const upper = method.trim().toUpperCase();

  if (upper === "GET") {
    if (normalized === "/opencode-router" || normalized === "/opencode-router/health") {
      return { auth: "client" };
    }
    if (normalized === "/opencode-router/bindings") {
      return { auth: "client", requiredScope: "collaborator" };
    }
    if (normalized === "/opencode-router/identities/telegram" || normalized === "/opencode-router/identities/slack") {
      return { auth: "client", requiredScope: "collaborator" };
    }
  }

  return { auth: "host" };
}

// The router's identity routes take channel tokens, and the host saves those (`/sandbox-manager/v1/channels`),
// so a token never passes through this process. Reading identities through the proxy stays; writing them does not.
function assertOpenCodeRouterProxyAllowed(method: string, pathname: string): void {
  const normalized = normalizeOpenCodeRouterProxyPath(pathname);
  const isIdentityRoute = normalized === "/opencode-router/identities" || normalized.startsWith("/opencode-router/identities/");
  if (isIdentityRoute && method.trim().toUpperCase() !== "GET") {
    throw new ApiError(405, "channel_identities_are_host_owned", "Channel identities are saved by the host, not through this server");
  }
}
// Detects whether a URL uses the mounted workspace style (/w/<id>/...).
// Returns { workspaceId, restPath } if mounted, or null if it's a flat (non-mounted) path.
// e.g. "/w/ws1/opencode/session/abc" - { workspaceId: "ws1", restPath: "/opencode/session/abc" }; "/opencode/session/abc" - null
function parseWorkspaceMount(pathname: string): { workspaceId: string; restPath: string } | null {
  if (!pathname.startsWith("/w/")) return null;
  const remainder = pathname.slice(3);
  if (!remainder) return null;
  const slash = remainder.indexOf("/");
  if (slash === -1) {
    return { workspaceId: decodeURIComponent(remainder), restPath: "/" };
  }
  const workspaceId = remainder.slice(0, slash);
  const restPath = remainder.slice(slash) || "/";
  if (!workspaceId.trim()) return null;
  return { workspaceId: decodeURIComponent(workspaceId), restPath };
}

async function assertOpencodeProxyAllowed(actor: Actor, request: Request, proxyPath: string) {
  const m = request.method.toUpperCase();
  const scope = actor.scope ?? "viewer";

  if (scope === "viewer" && m !== "GET" && m !== "HEAD") {
    throw new ApiError(403, "forbidden", "Viewer tokens are read-only");
  }
  await assertOpencodeProxyMcpReadOnly(request, proxyPath);

  // Prevent collaborators/viewers from self-approving OpenCode permission requests via the proxy.
  // OpenCode uses /permission/:requestId/reply (and historically also a session-scoped variant).
  if (scope !== "owner" && m !== "GET" && m !== "HEAD") {
    const normalized = normalizeOpencodeProxyPath(proxyPath);
    if (/\/permission\/[^/]+\/reply$/.test(normalized)) {
      throw new ApiError(403, "forbidden", "Only owner tokens can reply to permission requests");
    }
  }
}

export interface Route {
  method: string;
  regex: RegExp;
  keys: string[];
  auth: AuthMode;
  handler: (ctx: RequestContext) => Promise<Response>;
}

export interface RequestContext {
  request: Request;
  url: URL;
  params: Record<string, string>;
  config: ServerConfig;
  approvals: ApprovalService;
  reloadEvents: ReloadEventStore;
  tokens: TokenService;
  actor?: Actor;
}

export function startServer(config: ServerConfig) {
  ensureMeterProviderInitialized();
  ensureLoggerProviderInitialized();
  installServerCrashHandlers();
  const approvals = new ApprovalService(config.approval);
  const reloadEvents = new ReloadEventStore();
  const tokens = new TokenService(config);
  // Created before the routes so route handlers can emit structured logs
  // (e.g. the office-preview stage timings).
  const logger = createServerLogger(config);
  const routes = createRoutes(config, approvals, tokens, logger);

  const serverOptions: {
    hostname: string;
    port: number;
    fetch: (request: Request) => Response | Promise<Response>;
  } = {
    hostname: config.host,
    port: config.port,
    fetch: async (request: Request) => {
      const url = new URL(request.url);
      const startedAt = Date.now();
      let authMode: AuthMode = "none";
      let proxyService: "opencode" | "opencode-router" | undefined;
      let proxyBaseUrl: string | undefined;
      let errorMessage: string | undefined;

      const finalize = (response: Response) => {
        const wrapped = withCors(response, request, config);
        if (config.logRequests) {
          logRequest({
            logger,
            request,
            response: wrapped,
            durationMs: Date.now() - startedAt,
            authMode,
            proxyService,
            proxyBaseUrl,
            error: errorMessage,
          });
        }
        return wrapped;
      };

      if (request.method === "OPTIONS") {
        return finalize(new Response(null, { status: 204 }));
      }

      // Routing/Dispatching - checks the URL path and decides which backend server to forward the request to
      // Clients can call the server in two ways:
      // 1. Non-mounted (flat paths): e.g. http://host:8787/opencode/session/abc, http://host:8787/workspace/ws1/config
      // 2. Mounted   (nested paths): e.g. http://host:8787/w/<workspace_id>/opencode/session/abc, http://host:8787/w/ws1/workspace/ws1/config -
      //                              -> mounted style was added later to enable multi-workspace support and remote 'connect' flows (Add worker -> connect remote)

      // Handle mounted proxies (e.g. /w/:id/opencode/*, /w/:id/opencode-router/*)
      // These proxy branches forward to external services (OpenCode, OpenCode Router).
      // restPath starts with /opencode        - branch 1a → proxy to OpenCode (AI engine)
      // restPath starts with /opencode-router - branch 1b → proxy to OpenCode Router (Telegram/Slack)

      // parseWorkspaceMount splits the URL:
      //   With /workspace/ : GET /w/ws1/workspace/ws1/config     → { workspaceId: "ws1", restPath: "/workspace/ws1/config" }
      //                      restPath starts with /workspace/    → rewrite url.pathname and fall through to matchRoute()
      //   Without /workspace/: GET /w/ws1/opencode/session/abc   → { workspaceId: "ws1", restPath: "/opencode/session/abc" }
      //                      restPath starts with /opencode      → proxy directly to OpenCode (external service), return immediately
      const mount = parseWorkspaceMount(url.pathname);

      // == Mounted Path ==
      // 1a. First branch: mounted opencode proxy (checks whether the mounted path is /opencode or starts with /opencode/)
      if (mount && (mount.restPath === "/opencode" || mount.restPath.startsWith("/opencode/"))) {
        authMode = "client";
        try {
          const actor = await requireClient(request, config, tokens);
          await assertOpencodeProxyAllowed(actor, request, mount.restPath);
          const workspace = await resolveWorkspace(config, mount.workspaceId);
          proxyService = "opencode";
          proxyBaseUrl = workspace.baseUrl?.trim() || undefined;
          const response = await proxyOpencodeRequest({
            request,
            url,
            workspace,
            proxyPath: mount.restPath,
            onUpstreamError: (body) => { errorMessage = body; },
            generationStartedAt: config.startedAt,
          });
          return finalize(response);
        } catch (error) {
          const apiError = error instanceof ApiError
            ? error
            : new ApiError(500, "internal_error", "Unexpected server error");
          errorMessage = apiError.message;
          return finalize(jsonResponse(formatError(apiError), apiError.status));
        }
      }

      // 1b. Second branch: mounted opencode-router proxy (checks whether the mounted path is /opencode-router or starts with /opencode-router/)
      if (mount && (mount.restPath === "/opencode-router" || mount.restPath.startsWith("/opencode-router/"))) {
        const policy = resolveOpenCodeRouterProxyPolicy(request.method, mount.restPath);
        authMode = policy.auth;
        try {
          assertOpenCodeRouterProxyAllowed(request.method, mount.restPath);
          if (authMode === "host") {
            await requireHost(request, config, tokens);
          } else {
            const actor = await requireClient(request, config, tokens);
            if (policy.requiredScope && scopeRank(actor.scope ?? "viewer") < scopeRank(policy.requiredScope)) {
              throw new ApiError(403, "forbidden", "Insufficient token scope", {
                required: policy.requiredScope,
                scope: actor.scope,
              });
            }
          }
          proxyService = "opencode-router";
          proxyBaseUrl = resolveOpenCodeRouterBaseUrl();
          const response = await proxyOpenCodeRouterRequest({ request, url, proxyPath: mount.restPath });
          return finalize(response);
        } catch (error) {
          const apiError = error instanceof ApiError
            ? error
            : new ApiError(500, "internal_error", "Unexpected server error");
          errorMessage = apiError.message;
          return finalize(jsonResponse(formatError(apiError), apiError.status));
        }
      }

      // Allow clients to use a mounted base URL (e.g. http://host:8787/w/<id>) while still calling the existing /workspace/:id/* API surface.
      // This allows mounted clients to use the same API routes.
      // Example: baseUrl + "/workspace/<id>/plugins" => "/w/<id>/workspace/<id>/plugins". We strip the mount prefix and route-match on the rest path.
      //
      // Important: when using a mounted base URL, enforce that the nested /workspace/:id matches the mount workspace id to preserve the "single-workspace" mental model.
      const nestedMatch = mount?.restPath.match(/^\/(?:workspace|v1\/workspaces)\/([^/]+)/);
      if (mount && nestedMatch) {
        const nestedId = nestedMatch[1] ? decodeURIComponent(nestedMatch[1]) : null;
        if (nestedId && nestedId !== mount.workspaceId) {
          errorMessage = "not_found";
          return finalize(jsonResponse({ code: "not_found", message: "Not found" }, 404));
        }
        url.pathname = mount.restPath;
      }

      // Handle non-mounted (flat) paths - check if the path starts with /opencode or /opencode-router and proxy accordingly
      if (url.pathname === "/opencode" || url.pathname.startsWith("/opencode/")) {
        authMode = "client";
        proxyBaseUrl = config.workspaces[0]?.baseUrl?.trim() || undefined;
        try {
          const actor = await requireClient(request, config, tokens);
          await assertOpencodeProxyAllowed(actor, request, url.pathname);
          proxyService = "opencode";
          const response = await proxyOpencodeRequest({
            request,
            url,
            workspace: config.workspaces[0],
            onUpstreamError: (body) => { errorMessage = body; },
            generationStartedAt: config.startedAt,
          });
          return finalize(response);
        } catch (error) {
          const apiError = error instanceof ApiError
            ? error
            : new ApiError(500, "internal_error", "Unexpected server error");
          errorMessage = apiError.message;
          return finalize(jsonResponse(formatError(apiError), apiError.status));
        }
      }

      if (url.pathname === "/opencode-router" || url.pathname.startsWith("/opencode-router/")) {
        const policy = resolveOpenCodeRouterProxyPolicy(request.method, url.pathname);
        authMode = policy.auth;
        try {
          assertOpenCodeRouterProxyAllowed(request.method, url.pathname);
          if (authMode === "host") {
            await requireHost(request, config, tokens);
          } else {
            const actor = await requireClient(request, config, tokens);
            if (policy.requiredScope && scopeRank(actor.scope ?? "viewer") < scopeRank(policy.requiredScope)) {
              throw new ApiError(403, "forbidden", "Insufficient token scope", {
                required: policy.requiredScope,
                scope: actor.scope,
              });
            }
          }
          proxyService = "opencode-router";
          proxyBaseUrl = resolveOpenCodeRouterBaseUrl();
          const response = await proxyOpenCodeRouterRequest({ request, url });
          return finalize(response);
        } catch (error) {
          const apiError = error instanceof ApiError
            ? error
            : new ApiError(500, "internal_error", "Unexpected server error");
          errorMessage = apiError.message;
          return finalize(jsonResponse(formatError(apiError), apiError.status));
        }
      }

      // Intent classifier proxy (non-mounted path). Allowlist the exact routes
      // the UI needs so the authenticated proxy cannot reach arbitrary sidecar
      // endpoints (e.g. /debug/intent).
      if (url.pathname.startsWith("/intent/")) {
        authMode = "client";
        try {
          await requireClient(request, config, tokens);
          const restPath =
            url.pathname === "/intent/classify"
              ? "/classify"
              : /^\/intent\/session\/[^/]+\/display$/.test(url.pathname)
                ? url.pathname.slice("/intent".length)
                : null;
          if (restPath === null) {
            errorMessage = "not_found";
            return finalize(jsonResponse({ code: "not_found", message: "Not found" }, 404));
          }
          const response = await proxyIntentClassifierRequest(request, restPath);
          return finalize(response);
        } catch (error) {
          const apiError = error instanceof ApiError
            ? error
            : new ApiError(500, "internal_error", "Unexpected server error");
          errorMessage = apiError.message;
          return finalize(jsonResponse(formatError(apiError), apiError.status));
        }
      }

      const route = matchRoute(routes, request.method, url.pathname);
      if (!route) {
        errorMessage = "not_found";
        return finalize(jsonResponse({ code: "not_found", message: "Not found" }, 404));
      }

      authMode = route.auth;
      try {
        const actor = route.auth === "host"
          ? await requireHost(request, config, tokens)
          : authMode === "telemetry"
            ? await requireTelemetry(request, tokens)
          : route.auth === "client"
            ? await requireClient(request, config, tokens)
            : undefined;
        const response = await route.handler({
          request,
          url,
          params: route.params,
          config,
          approvals,
          reloadEvents,
          tokens,
          actor,
        });
        return finalize(response);
      } catch (error) {
        if (!(error instanceof ApiError)) {
          console.error("[openwork-server] Unhandled error:", error);
        }
        const apiError = error instanceof ApiError
          ? error
          : new ApiError(500, "internal_error", "Unexpected server error");
        errorMessage = apiError.message;
        return finalize(jsonResponse(formatError(apiError), apiError.status));
      }
    },
  };

  (serverOptions as { idleTimeout?: number }).idleTimeout = 255;

  const server = Bun.serve(serverOptions);

  if (!config.readOnly) {
    void (async () => {
      for (const workspace of config.workspaces ?? []) {
        if (!workspace.path) continue;
        try {
          await migrateGmailDataLogged(workspace);
          const result = await migrateWorkspaceMcpPermissions(workspace.path);
          if (result.removedGrants.length > 0 || result.prunedAgents.length > 0) {
            logger.log("info", "Removed legacy workspace MCP grants", {
              workspaceId: workspace.id,
              removedGrants: result.removedGrants,
              prunedAgents: result.prunedAgents,
            });
          }
          if (result.preservedGrants.length > 0) {
            logger.log("info", "Kept authored workspace MCP grants", {
              workspaceId: workspace.id,
              preservedGrants: result.preservedGrants,
            });
          }
        } catch (error) {
          logger.log("error", "Failed to remove legacy workspace MCP grants", {
            workspaceId: workspace.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })();
  }

  // --- Automation scheduler loop ---
  // Checks all workspaces every 30 seconds for due AgentLab automations and
  // triggers their run via the same logic used by the manual /run endpoint.
  const SCHEDULER_INTERVAL_MS = 30_000;
  const schedulerTimer = setInterval(skipWhileRunning(async () => {
    if (config.readOnly) return;
    try {
      const workspaces = config.workspaces ?? [];
      for (const workspace of workspaces) {
        if (!workspace.path) continue;
        let store: AgentLabAutomationStore;
        try {
          store = await readAgentLabAutomations(workspace.path);
        } catch {
          continue;
        }
        const now = Date.now();
        const ran: AgentLabAutomation[] = [];
        for (const automation of store.items) {
          if (!automation.enabled) continue;
          if (!isAutomationDue(automation, now)) continue;
          try {
            const resolvedRootPeerId = automation.slackThreadPeerId
              ? null
              : await fetchSlackAutomationRootPeerId({ workspace, requestHost: null });
            const shouldNotifySlack = Boolean(automation.slackThreadPeerId) || Boolean(resolvedRootPeerId);
            let completionObserved = Promise.resolve(false);
            const { agent: runAgent, model: schedulerModel, sessionId } = await dispatchAgentLabAutomationRun(workspace, automation, automation.model || DEFAULT_AUTOMATION_MODEL, (id) => {
              if (shouldNotifySlack) completionObserved = waitForOpencodeSessionIdle(workspace, id, 30 * 60_000);
            });
            logger.log("info", `[AgentLab:scheduler] id=${automation.id} name=${automation.name} automation.model=${automation.model} schedulerModel=${schedulerModel} agent=${runAgent}`);
            automation.lastRunAt = now;
            automation.lastRunSessionId = sessionId;
            automation.lastRunError = undefined;
            automation.updatedAt = now;
            ran.push(automation);
            logger.log("info", `Scheduler: triggered automation "${automation.name}"`, {
              automationId: automation.id,
              sessionId,
            });
            if (shouldNotifySlack) {
              void notifySlackWhenAgentLabAutomationCompletes({
                workspace,
                automation,
                sessionId,
                logger,
                requestHost: null,
                completionObserved,
                resolvedRootPeerId,
              });
            }
          } catch (runErr) {
            logger.log("error", `Scheduler: failed to run automation "${automation.name}"`, {
              automationId: automation.id,
              error: runErr instanceof Error ? runErr.message : String(runErr),
            });
            if (recordRefusedRun(automation, runErr, now)) ran.push(automation);
          }
        }
        if (ran.length) {
          try {
            await writeAgentLabAutomations(workspace.path, applyRunResults(await readAgentLabAutomations(workspace.path), ran));
          } catch {
            // best-effort persist
          }
        }
      }
    } catch (outerErr) {
      logger.log("error", "Scheduler: unexpected error in scheduler loop", {
        error: outerErr instanceof Error ? outerErr.message : String(outerErr),
      });
    }
  }), SCHEDULER_INTERVAL_MS);

  // Attach cleanup so callers can stop the scheduler when the server shuts down
  (server as unknown as Record<string, unknown>).__schedulerTimer = schedulerTimer;

  return server;
}

function matchRoute(routes: Route[], method: string, path: string) {
  for (const route of routes) {
    if (route.method !== method) continue;
    const match = path.match(route.regex);
    if (!match) continue;
    const params: Record<string, string> = {};
    route.keys.forEach((key, index) => {
      params[key] = decodeURIComponent(match[index + 1]);
    });
    return { ...route, params };
  }
  return null;
}

function addRoute(routes: Route[], method: string, path: string, auth: AuthMode, handler: Route["handler"]) {
  const keys: string[] = [];
  const regex = pathToRegex(path, keys);
  routes.push({ method, regex, keys, auth, handler });
}

function pathToRegex(path: string, keys: string[]): RegExp {
  const pattern = path.replace(/:([A-Za-z0-9_]+)/g, (_, key) => {
    keys.push(key);
    return "([^/]+)";
  });
  return new RegExp(`^${pattern}$`);
}

function buildOpencodeProxyUrl(baseUrl: string, path: string, search: string) {
  const target = new URL(baseUrl);
  const trimmedPath = path.replace(/^\/opencode/, "");
  target.pathname = trimmedPath.startsWith("/") ? trimmedPath : `/${trimmedPath}`;
  target.search = search;
  return target.toString();
}

async function fetchOpencodeJson(workspace: WorkspaceInfo, path: string, init: { method: string; body?: unknown }) {
  const baseUrl = workspace.baseUrl?.trim() ?? "";
  if (!baseUrl) {
    throw new ApiError(400, "opencode_unconfigured", "OpenCode base URL is missing for this workspace");
  }

  const url = new URL(baseUrl);
  const [pathname, search = ""] = path.split("?", 2);
  url.pathname = pathname.startsWith("/") ? pathname : `/${pathname}`;
  url.search = search ? `?${search}` : "";

  const headers = new Headers();
  headers.set("Content-Type", "application/json");

  const directory = resolveOpencodeDirectory(workspace);
  if (directory) {
    headers.set("x-opencode-directory", directory);
  }

  const auth = buildOpencodeAuthHeader(workspace);
  if (auth) {
    headers.set("Authorization", auth);
  }

  // egress-surface: openwork_proxy_opencode
  const response = await fetch(url.toString(), {
    method: init.method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

  const text = await response.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!response.ok) {
    throw new ApiError(502, "opencode_request_failed", "OpenCode request failed", {
      status: response.status,
      body: json ?? text,
      path,
    });
  }
  return json;
}

function buildOpenCodeRouterProxyUrl(baseUrl: string, path: string, search: string) {
  const target = new URL(baseUrl);
  const trimmedPath = path.replace(/^\/opencode-router/, "");
  const normalized = trimmedPath.startsWith("/") ? trimmedPath : `/${trimmedPath}`;
  target.pathname = normalized === "/" ? "/" : normalized;
  target.search = search;
  return target.toString();
}

// By default, auto-routing overrides the model defined in the agent's .md file or in opencode.jsonc.
// Agent model pins allow us to explicitly assign a fixed model to specific agents, overriding both auto-routing and the UI model selection.
function parseAgentModelPins(): Map<string, { providerID: string; modelID: string }> {
  const pins = new Map<string, { providerID: string; modelID: string }>();
  const raw = process.env.AGENT_MODEL_PINS?.trim();
  if (!raw) return pins;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const [agent, model] of Object.entries(parsed)) {
      if (typeof model !== "string") continue;
      const idx = model.indexOf("/");
      if (idx > 0) pins.set(agent, { providerID: model.slice(0, idx), modelID: model.slice(idx + 1) });
    }
  } catch {
    // ignore parse errors
  }
  return pins;
}
const AGENT_MODEL_PINS = parseAgentModelPins();

/**
 * The two things the gate needs from the session, in one round trip.
 *
 * `agent` matters because "no agent in the body" must NOT be read as "the default
 * agent": a resumed or non-UI turn that omits it would otherwise be handed every
 * MCP server. The SDK's `Session` type declares neither field, yet `permission`
 * demonstrably works at runtime, so both are read defensively.
 */
async function fetchSessionGateInputs(
  workspace: WorkspaceInfo,
  sessionID: string,
): Promise<{ permission: unknown; agent?: string }> {
  const session = await fetchOpencodeJson(workspace, `/session/${encodeURIComponent(sessionID)}`, {
    method: "GET",
  });
  const record = session as { permission?: unknown; agent?: unknown } | null;
  return {
    permission: record?.permission,
    agent: typeof record?.agent === "string" && record.agent.trim() !== "" ? record.agent : undefined,
  };
}

/**
 * One agent's RESOLVED permission from the engine. Deliberately uncached: the gate
 * has to reflect an edit to an agent's MCP selection on the very next turn, and a
 * cache here would let the gate and the plugin's execution guard disagree.
 */
async function fetchAgentPermission(workspace: WorkspaceInfo, agent: string): Promise<unknown> {
  const agents = await fetchOpencodeJson(workspace, "/agent", { method: "GET" });
  if (!Array.isArray(agents)) return undefined;
  const match = agents.find(
    (candidate) =>
      !!candidate && typeof candidate === "object" && (candidate as { name?: unknown }).name === agent,
  );
  return match && typeof match === "object" ? (match as { permission?: unknown }).permission : undefined;
}

/**
 * Resolve this turn's `tools` map, or `undefined` when the request must carry no
 * `tools` key at all. A failure rejects the turn: forwarded without a map, the
 * session's persisted ruleset would govern, and it can still allow MCP the agent
 * or policy has since turned off.
 */
async function resolveToolGateForPrompt(input: {
  workspace: WorkspaceInfo;
  sessionID: string;
  agent?: string;
}): Promise<Record<string, boolean> | undefined> {
  try {
    const session = await fetchSessionGateInputs(input.workspace, input.sessionID);
    return await buildToolGate({
      workspaceRoot: input.workspace.path,
      agent: input.agent ?? session.agent,
      sessionPermission: session.permission,
      resolveAgentPermission: (agent) => fetchAgentPermission(input.workspace, agent),
    });
  } catch (error) {
    console.error(`[McpToolGate] session=${input.sessionID} failed; rejecting the turn:`, error);
    throw new ApiError(502, "mcp_tool_gate_failed", "MCP tool permissions could not be resolved for this turn");
  }
}

async function proxyOpencodeRequest(input: {
  request: Request;
  url: URL;
  workspace?: WorkspaceInfo;
  proxyPath?: string;
  onUpstreamError?: (body: string) => void;
  generationStartedAt: number;
}) {
  const workspace = input.workspace;
  const baseUrl = workspace?.baseUrl?.trim() ?? "";
  if (!baseUrl) {
    throw new ApiError(400, "opencode_unconfigured", "OpenCode base URL is missing for this workspace");
  }

  const proxyPath = input.proxyPath ?? input.url.pathname;
  const targetUrl = buildOpencodeProxyUrl(baseUrl, proxyPath, input.url.search);
  const headers = new Headers(input.request.headers);
  headers.delete("authorization");
  headers.delete("x-openwork-host-token");
  headers.delete("x-openwork-client-id");
  headers.delete("host");
  headers.delete("origin");

  const directory = workspace ? resolveOpencodeDirectory(workspace) : null;
  const incomingDir = headers.get("x-opencode-directory")?.trim() ?? "";
  if (incomingDir && workspace) {
    // Use the configured directory (from `workspace.directory` if set, else
    // `workspace.path`) as the rewrite fallback so that explicit per-workspace
    // overrides remain respected when a buggy client sends a Windows-shaped
    // header. `directory` here is the value `resolveOpencodeDirectory` already
    // computed; falling through to `workspace.path` matches its own internal
    // fallback for local workspaces.
    const fallback = directory ?? workspace.path;
    const cleaned =
      rewriteIfPosixLikeOnWindows(
        rewriteIfWindowsLike(incomingDir, fallback, "header"),
        fallback,
        "header",
      ) ?? fallback;
    if (cleaned !== incomingDir) {
      headers.set("x-opencode-directory", cleaned);
    }
  } else if (directory) {
    headers.set("x-opencode-directory", directory);
  } else if (incomingDir) {
    // No workspace to validate against, so this header is unverifiable. It used to be forwarded
    // untouched, which is how a container-shaped directory reached opencode on an unscoped request
    // and rooted an instance at the drive root. Dropping it leaves the role's declared
    // OPENCODE_DIRECTORY in charge, which already names the workspace root.
    if (rewriteIfPosixLikeOnWindows(incomingDir, null, "header") === null) {
      headers.delete("x-opencode-directory");
    }
  }

  const auth = workspace ? buildOpencodeAuthHeader(workspace) : null;
  if (auth) {
    headers.set("Authorization", auth);
  }

  const method = input.request.method.toUpperCase();

  // Detect prompt_async once so we can read the body a single time and reuse
  // it for agent-model pinning. Reading `input.request.text()` drains the
  // underlying stream, so any later use of `input.request.body` or
  // `input.request.clone()` would otherwise forward an empty body to upstream.
  const promptAsyncMatch =
    method === "POST" && proxyPath ? proxyPath.match(/\/session\/([^/]+)\/prompt_async$/) : null;
  const isPromptAsync = Boolean(promptAsyncMatch);

  let bufferedBody: string | undefined;
  if (isPromptAsync) {
    bufferedBody = await input.request.text();
  }

  // Agent model pinning and MCP tool gating both rewrite the prompt_async body.
  // They share one parse/serialize pass so neither clobbers the other. On JSON
  // parse failure the original body is forwarded verbatim.
  if (isPromptAsync && bufferedBody !== undefined && workspace) {
    try {
      const bodyJson = JSON.parse(bufferedBody) as Record<string, unknown>;
      const agentName = typeof bodyJson.agent === "string" ? bodyJson.agent : undefined;
      let rewritten = false;

      if (agentName && AGENT_MODEL_PINS.size > 0) {
        const pinnedModel = AGENT_MODEL_PINS.get(agentName);
        if (pinnedModel) {
          bodyJson.model = pinnedModel;
          rewritten = true;
          console.log(
            `[AgentModelPin] agent=${agentName} model overridden to ${pinnedModel.providerID}/${pinnedModel.modelID}`,
          );
        }
      }

      const sessionID = decodeURIComponent(promptAsyncMatch?.[1] ?? "");
      if (sessionID) {
        const tools = await resolveToolGateForPrompt({ workspace, sessionID, agent: agentName });
        // Delete rather than set `{}`: an empty map may still discard the
        // session ruleset, which was never measured.
        if (tools) {
          bodyJson.tools = tools;
          rewritten = true;
        } else if ("tools" in bodyJson) {
          delete bodyJson.tools;
          rewritten = true;
        }
      }

      if (rewritten) {
        bufferedBody = JSON.stringify(bodyJson);
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      console.error(`[PromptRewrite] prompt_async body left verbatim:`, error);
    }
  }

  let body: BodyInit | undefined;
  if (method === "GET" || method === "HEAD") {
    body = undefined;
  } else if (bufferedBody !== undefined) {
    body = bufferedBody;
    headers.set("content-type", "application/json");
    headers.delete("content-length");
  } else {
    body = input.request.body as BodyInit | undefined;
  }

  const abortMatch = method === "POST" ? proxyPath.match(/^\/opencode\/session\/([^/]+)\/abort$/) : null;
  if (abortMatch?.[1]) {
    await cancelHybridDrProgressForSession(decodeURIComponent(abortMatch[1])).catch(() => {});
  }

  // Per-request deadline: honor the caller-declared `x-openwork-timeout-ms`
  // header when present and valid, else fall back to the default.
  const headerTimeout = Number(input.request.headers.get(OPENCODE_PROXY_TIMEOUT_HEADER));
  const deadlineMs =
    Number.isFinite(headerTimeout) && headerTimeout > 0 ? headerTimeout : OPENCODE_PROXY_DEFAULT_TIMEOUT_MS;

  // Drive the deadline from an explicit timer so it is cleared the moment the
  // upstream responds, instead of leaving an up-to-30min `AbortSignal.timeout`
  // armed on every proxied request (this proxy also carries 2s UI polling).
  // `input.request.signal` stays composed in so a client disconnect still
  // aborts the upstream at once, for the whole response including SSE bodies.
  const deadlineController = new AbortController();
  let deadlineFired = false;
  const deadlineTimer = setTimeout(() => {
    deadlineFired = true;
    deadlineController.abort();
  }, deadlineMs);

  let response: Response;
  try {
    // egress-surface: openwork_proxy_opencode
    response = await fetch(targetUrl, {
      method,
      headers,
      body,
      // Bun's fetch imposes a hard ~300s default an AbortSignal cannot override;
      // disable it (`timeout: false`) so long local-model turns aren't silently
      // cut at 300s and surfaced as a 500 "Unexpected server error" (#1511).
      signal: AbortSignal.any([input.request.signal, deadlineController.signal]),
      timeout: false,
    } as RequestInit & { timeout: boolean });
  } catch (error) {
    // Translate our own deadline into a clear timeout rather than the generic
    // 500 the outer handler would otherwise emit (#1511 ask #2). A client
    // disconnect or any other fetch error propagates unchanged.
    if (deadlineFired) {
      throw new ApiError(504, "opencode_timeout", "OpenCode turn exceeded its time budget", {
        path: proxyPath,
        deadline_ms: deadlineMs,
      });
    }
    throw error;
  } finally {
    clearTimeout(deadlineTimer);
  }

  throwIfRuntimeCredentialRejected(response, proxyPath);

  // A 5xx here belongs to the upstream opencode, but the access log would record
  // only "GET /opencode/path 500", which reads identically to the proxy itself
  // failing. opencode answers with an opaque {name, data:{message, ref}} envelope
  // and keeps the detail in its own log, so carrying the envelope is what makes
  // the two correlatable by ref.
  if (response.status >= 500 && input.onUpstreamError) {
    try {
      const raw = await response.clone().text();
      input.onUpstreamError(raw.slice(0, OPENCODE_UPSTREAM_ERROR_LOG_LIMIT));
    } catch {
      // Unreadable body; status and duration still reach the access log.
    }
  }

  const messageMatch = method === "GET" ? proxyPath.match(/^\/opencode\/session\/([^/]+)\/message$/) : null;
  const responseContentType = response.headers.get("content-type") ?? "";
  if (messageMatch?.[1] && response.ok && responseContentType.includes("application/json")) {
    try {
      const messages = await response.json();
      const afterHybridDr = await overlayHybridDrProgressOnMessages(
        decodeURIComponent(messageMatch[1]), messages, input.generationStartedAt,
      );
      const afterRestore = await overlayProtectedPipelineRestoreOnMessages(afterHybridDr, workspace);
      const responseHeaders = new Headers(response.headers);
      responseHeaders.delete("content-encoding");
      responseHeaders.delete("transfer-encoding");
      responseHeaders.delete("content-length");
      responseHeaders.set("content-type", "application/json");
      return new Response(JSON.stringify(afterRestore), {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    } catch {
      // Fall through to the normal proxy response if overlay parsing fails.
    }
  }

  // Inject SSE keepalive pings to prevent desktop SSE readers from treating
  // slow local-model turns as a dead stream.
  // Local autoroute responses can leave the session event stream idle for tens
  // of seconds, so the interval needs to stay comfortably below the reader's
  // idle timeout.
  const contentType = response.headers.get("content-type") ?? "";

  if (contentType.includes("text/event-stream")) {
    const PING_INTERVAL_MS = 5_000;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const upstream = response.body;
    if (upstream) {
      const keepaliveStream = new ReadableStream({
        start(controller) {
          const reader = upstream.getReader();
          let pingTimer: ReturnType<typeof setTimeout> | undefined;

          const resetTimer = () => {
            if (pingTimer) clearTimeout(pingTimer);
            pingTimer = setTimeout(() => {
              try {
                controller.enqueue(encoder.encode(": ping\n\n"));
              } catch {
                // stream already closed
              }
              resetTimer();
            }, PING_INTERVAL_MS);
          };

          const pump = () => {
            reader.read().then(({ done, value }) => {
              if (done) {
                if (pingTimer) clearTimeout(pingTimer);
                try { controller.close(); } catch { /* already closed */ }
                return;
              }
              resetTimer();
              try {
                controller.enqueue(encoder.encode(decoder.decode(value, { stream: true })));
              } catch {
                if (pingTimer) clearTimeout(pingTimer);
                return;
              }
              pump();
            }).catch(() => {
              if (pingTimer) clearTimeout(pingTimer);
              try { controller.close(); } catch { /* already closed */ }
            });
          };

          resetTimer();
          pump();
        },
      });

      const responseHeaders = new Headers(response.headers);
      responseHeaders.delete("content-encoding");
      responseHeaders.delete("transfer-encoding");
      responseHeaders.delete("content-length");
      return new Response(keepaliveStream, {
        status: response.status,
        headers: responseHeaders,
      });
    }
  }

  return sanitizeProxyResponse(response);
}

function sanitizeProxyResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.delete("transfer-encoding");
  headers.delete("content-length");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function resolveOpenCodeRouterBaseUrl(): string {
  const port = parseInteger(process.env.OPENCODE_ROUTER_HEALTH_PORT);
  if (!port) {
    throw new ApiError(404, "opencodeRouter_unconfigured", "OpenCodeRouter is not configured on this host");
  }
  return `http://127.0.0.1:${port}`;
}

async function proxyOpenCodeRouterRequest(input: {
  request: Request;
  url: URL;
  proxyPath?: string;
}) {
  const baseUrl = resolveOpenCodeRouterBaseUrl();
  const proxyPath = input.proxyPath ?? input.url.pathname;
  const targetUrl = buildOpenCodeRouterProxyUrl(baseUrl, proxyPath, input.url.search);
  const headers = new Headers(input.request.headers);
  headers.delete("authorization");
  headers.delete("x-openwork-host-token");
  headers.delete("x-openwork-client-id");
  headers.delete("host");
  headers.delete("origin");
  const controlToken = routerBearerToken();
  if (controlToken) {
    headers.set("authorization", `Bearer ${controlToken}`);
  }

  const method = input.request.method.toUpperCase();
  const body = method === "GET" || method === "HEAD" ? undefined : input.request.body;
  try {
    // egress-surface: openwork_proxy_opencode_router
    const response = await fetch(targetUrl, {
      method,
      headers,
      body,
    });
    return response;
  } catch (error) {
    const port = parseInteger(process.env.OPENCODE_ROUTER_HEALTH_PORT);
    throw new ApiError(503, "opencodeRouter_unreachable", "OpenCodeRouter is not reachable on this host", {
      baseUrl,
      port,
      targetUrl,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function readRequestBytesWithLimit(request: Request, maxBytes: number, tooLargeMessage: string): Promise<Uint8Array> {
  const body = request.body;
  if (!body) return new Uint8Array();

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value ?? new Uint8Array();
      total += chunk.byteLength;
      if (total > maxBytes) {
        throw new ApiError(413, "skill_package_chunk_too_large", tooLargeMessage);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function opencodeRouterDebugEnabled(): boolean {
  return ["1", "true", "yes"].includes((process.env.OPENWORK_DEBUG_OPENCODE_ROUTER ?? "").toLowerCase());
}

function logOpenCodeRouterDebug(message: string, details?: Record<string, unknown>) {
  if (!opencodeRouterDebugEnabled()) return;
  const payload = details ? ` ${JSON.stringify(details)}` : "";
  console.log(`[opencodeRouter] ${message}${payload}`);
}

function withCors(response: Response, request: Request, config: ServerConfig) {
  const origin = request.headers.get("origin");
  const allowedOrigins = config.corsOrigins;
  let allowOrigin: string | null = null;
  if (allowedOrigins.includes("*")) {
    allowOrigin = "*";
  } else if (origin && allowedOrigins.includes(origin)) {
    allowOrigin = origin;
  }

  if (!allowOrigin) return response;
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", allowOrigin);
  headers.set(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, X-OpenWork-Host-Token, X-OpenWork-Client-Id, X-OpenCode-Directory, X-Opencode-Directory, x-opencode-directory",
  );
  headers.set("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  headers.set("Vary", "Origin");
  return new Response(response.body, { status: response.status, headers });
}

function buildCapabilities(config: ServerConfig): Capabilities {
  const writeEnabled = !config.readOnly;
  const schemaVersion = 1;
  const inboxEnabled = resolveInboxEnabled();
  const outboxEnabled = resolveOutboxEnabled();
  const maxBytes = resolveInboxMaxBytes();
  const toyUiEnabled = resolveToyUiEnabled();
  const browserProvider = resolveBrowserProvider();
  const opencodeRouterConfigured = Boolean(parseInteger(process.env.OPENCODE_ROUTER_HEALTH_PORT));
  const opencodeConfigured = config.workspaces.some((workspace) => Boolean(workspace.baseUrl?.trim()));
  return {
    schemaVersion,
    serverVersion: SERVER_VERSION,
    skills: {
      read: true,
      write: writeEnabled,
      source: "openwork",
      packageImport: writeEnabled ? { version: 1, ...SKILL_PACKAGE_IMPORT_LIMITS } : undefined,
    },
    hub: {
      skills: {
        read: true,
        install: writeEnabled,
        repo: { owner: "different-ai", name: "openwork-hub", ref: "main" },
      },
    },
    plugins: { read: true, write: writeEnabled },
    mcp: { read: true, write: writeEnabled },
    commands: { read: true, write: writeEnabled },
    config: { read: true, write: writeEnabled },

    approvals: { mode: config.approval.mode, timeoutMs: config.approval.timeoutMs },
    sandbox: { enabled: false, backend: "none" },
    ui: { toy: toyUiEnabled },
    tokens: { scoped: true, scopes: ["owner", "collaborator", "viewer"] },
    proxy: {
      opencode: opencodeConfigured,
      opencodeRouter: opencodeRouterConfigured,
    },
    toolProviders: {
      browser: browserProvider,
      files: {
        injection: writeEnabled && inboxEnabled,
        outbox: outboxEnabled,
        inboxPath: "",
        outboxPath: ".opencode/openwork/outbox/",
        maxBytes,
      },
    },
  };
}

function resolveInboxEnabled(): boolean {
  const raw = (process.env.OPENWORK_INBOX_ENABLED ?? "").trim().toLowerCase();
  if (!raw) return true;
  return ["1", "true", "yes", "on"].includes(raw);
}

function resolveOutboxEnabled(): boolean {
  const raw = (process.env.OPENWORK_OUTBOX_ENABLED ?? "").trim().toLowerCase();
  if (!raw) return true;
  return ["1", "true", "yes", "on"].includes(raw);
}

function resolveInboxMaxBytes(): number {
  const raw = (process.env.OPENWORK_INBOX_MAX_BYTES ?? "").trim();
  const parsed = raw ? Number(raw) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.min(Math.trunc(parsed), 250_000_000);
  }
  return 50_000_000;
}

function resolveToyUiEnabled(): boolean {
  const raw = (process.env.OPENWORK_TOY_UI ?? "").trim().toLowerCase();
  if (!raw) return true;
  return ["1", "true", "yes", "on"].includes(raw);
}

function resolveBrowserProvider(): Capabilities["toolProviders"]["browser"] {
  const raw = (process.env.OPENWORK_BROWSER_PROVIDER ?? "").trim().toLowerCase();
  if (raw === "sandbox-headless") {
    return { enabled: true, placement: "in-sandbox", mode: "headless" };
  }
  if (raw === "host-interactive") {
    return { enabled: true, placement: "host-machine", mode: "interactive" };
  }
  if (raw === "client-interactive") {
    return { enabled: true, placement: "client-machine", mode: "interactive" };
  }
  return { enabled: false, placement: "external", mode: "none" };
}

function resolveProjectsRoot(workspacePath: string): string {
  return (process.env.SUPERCLAW_PATH ?? "").trim() || workspacePath;
}

function resolveInboxDir(workspaceRoot: string): string {
  return workspaceRoot;
}

function resolveOutboxDir(workspaceRoot: string): string {
  return join(workspaceRoot, ".opencode", "openwork", "outbox");
}

function resolveAgentLabDir(workspaceRoot: string): string {
  return join(workspaceRoot, ".opencode", "openwork", "agentlab");
}

/** Fallback model used when an automation has no explicit model configured. */
const DEFAULT_AUTOMATION_MODEL = "opencode/big-pickle";

function resolveAgentLabAutomationsPath(workspaceRoot: string): string {
  return join(resolveAgentLabDir(workspaceRoot), "automations.json");
}

function resolveAgentLabLogsDir(workspaceRoot: string): string {
  return join(resolveAgentLabDir(workspaceRoot), "logs");
}

function hybridDrConnection(): { root: string; url: string; headers: Record<string, string> } | null {
  const mode = process.env.HYBRID_DR_NATIVE_MANAGED?.trim() || "";
  const token = process.env.HYBRID_DR_API_TOKEN?.trim() || "";
  const root = process.env.HYBRID_DR_PROGRESS_ROOT?.trim();
  const port = process.env.HYBRID_DR_PORT?.trim() || "18324";
  if (!/^[0-9]{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) return null;
  if (mode ? mode !== "1" || !/^[A-Za-z0-9_-]{32,256}$/.test(token) || !root : !!token) return null;
  // Legacy/container retains the tool's existing directory, without credentials. Registry URLs
  // are never authority, even in legacy mode. Native uses a per-boot token-derived subdirectory.
  return {
    root: mode ? join(root as string, createHash("sha256").update(token).digest("hex"))
      : root || join(process.env.SC_RUNTIME_CONFIG_DIR?.trim() || "/data/superclaw/runtime", "openwork", "hybrid-dr-progress"),
    url: `http://127.0.0.1:${port}/v1/hybrid-dr/sessions`,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  };
}

async function hybridDrState(connection: NonNullable<ReturnType<typeof hybridDrConnection>>, sid: string): Promise<string | null> {
  // egress-surface: openwork_hdr_control
  const response = await fetch(`${connection.url}/${sid}/state`, {
    headers: connection.headers, redirect: "error", signal: AbortSignal.timeout(1500),
  });
  if (!response.ok) return null;
  const body = await response.json() as { session_id?: unknown; state?: { current_phase?: unknown } };
  return body.session_id === sid && typeof body.state?.current_phase === "string" ? body.state.current_phase : null;
}

function safeHybridDrProgressSegment(value: string): string {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,159}$/.test(value)) throw new Error("Invalid HDR progress identity");
  return value;
}

async function readHybridDrProgressRegistry(sessionId: string, toolIds: string[]): Promise<HybridDrProgressRegistry | null> {
  const connection = hybridDrConnection();
  if (!connection || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,159}$/.test(sessionId)) return null;
  const sessionDir = join(connection.root, safeHybridDrProgressSegment(sessionId));
  for (const toolId of toolIds) {
    try {
      const raw = await readFile(join(sessionDir, `${safeHybridDrProgressSegment(toolId)}.json`), "utf8");
      const parsed = JSON.parse(raw) as HybridDrProgressRegistry;
      if (validHybridDrRegistry(parsed, sessionId, toolId)) return parsed;
    } catch {
      // Try the next candidate; registry writes are best-effort and may not exist yet.
    }
  }
  return null;
}

async function fetchHybridDrProgressTitle(sessionId: string, part: Record<string, unknown>): Promise<HybridDrProgressCacheEntry | null> {
  const connection = hybridDrConnection();
  if (!connection) return null;
  const toolIds = hybridDrToolIdCandidates(part);
  if (toolIds.length === 0) return null;
  const cacheKey = `${connection.root}:${sessionId}:${toolIds.join("|")}`;
  const cached = hybridDrProgressCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < HYBRID_DR_PROGRESS_CACHE_TTL_MS) return cached;

  const registry = await readHybridDrProgressRegistry(sessionId, toolIds);
  const sidecarSessionId = registry?.sidecarSessionId?.trim();
  if (!registry || !sidecarSessionId) return null;
  try {
    const phase = await hybridDrState(connection, sidecarSessionId);
    if (!phase) return null;
    const formatted = hybridDrTitleForPhase(phase);
    const entry: HybridDrProgressCacheEntry = { fetchedAt: Date.now(), ...formatted, display: hybridDrRegistryDisplay(registry) };
    hybridDrProgressCache.set(cacheKey, entry);
    return entry;
  } catch {
    return null;
  }
}

// ── Protected pipeline display-restore overlay ─────────────────────────────
// The protected-pipeline-terminal-guard plugin writes a JSON envelope into the
// task tool-result output instead of restoring PII in place.  This overlay
// intercepts that envelope during the /message display path, calls the restore
// backend, and replaces the envelope with the restored display text.  The
// OpenCode agent transcript is never written back — PII never enters agent context.

const PROTECTED_PIPELINE_RESULT_TYPE = "protected_pipeline_result";

type ProtectedPipelineEnvelope =
  | {
      type: typeof PROTECTED_PIPELINE_RESULT_TYPE;
      status: "needs_display_restore";
      operation_id: string;
      operation_session_id: string | null;
      // Full per-file operation list for a batch protect call (2+ files in
      // one run_protected_file_pipeline call). Absent or empty on envelopes
      // written by an older guard build, which only ever had one operation.
      operations?: ProtectedPipelineOperationInfo[];
      masked_text: string;
    }
  | {
      type: typeof PROTECTED_PIPELINE_RESULT_TYPE;
      status: "restore_unavailable";
      masked_text: string;
    };

// Matches the child sessionID embedded in OpenCode's own task-result wrapper:
// <task id="ses_..." state="completed"><task_result>...</task_result></task>.
// OpenCode wraps a subagent's final text in this form when it becomes the
// result of a parent's task() tool call — the wrapped text is plain prose,
// not our JSON envelope, even though it may still contain masked placeholders.
const NESTED_TASK_ID_RE = /<task\s+id="(ses_[A-Za-z0-9]+)"/;
// The response restore endpoint also accepts registry tokens whose brackets were dropped.
const PROTECTED_PIPELINE_PLACEHOLDER_RE = /\b[A-Za-z_]+_\d+\b/;

function hasProtectedPipelinePlaceholder(text: string): boolean {
  return PROTECTED_PIPELINE_PLACEHOLDER_RE.test(text);
}

export function resolveDataProtectionRestoreUrl(): string {
  const host = process.env.DATA_PROTECTION_HOST?.trim() || "127.0.0.1";
  const port = process.env.DATA_PROTECTION_PORT?.trim() || "18826";
  return `http://${host}:${port}/v1/session/response/restore`;
}

/** Call the restore backend against arbitrary text, using an already-known operation. */
async function restoreTextWithOperation(
  text: string,
  operationId: string,
  operationSessionId: string | null,
  logger?: Pick<ServerLogger, "log">,
  maxOutputBytes?: number,
): Promise<string> {
  const apiKey = process.env.PRIVACY_API_KEY?.trim();
  if (!apiKey) return text;
  try {
    // egress-surface: openwork_data_protection_restore
    const res = await fetch(resolveDataProtectionRestoreUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        session_id: operationSessionId,
        operation_id: operationId,
        text,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      (logger ?? console).log("warn", "protected-pipeline restore backend returned non-OK", {
        status: res.status,
        operation_id: operationId,
      });
      return text;
    }

    let result: { final_text?: string };
    if (maxOutputBytes === undefined) {
      result = (await res.json()) as { final_text?: string };
    } else {
      // JSON can expand each ASCII control byte to a six character escape; allow 1 KiB for the envelope.
      const maxResponseBytes = maxOutputBytes * 6 + 1024;
      const contentLength = Number(res.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > maxResponseBytes) {
        try {
          await res.body?.cancel();
        } catch {
          // Keep the size-limit error as the response when cancellation fails.
        }
        throw new ProtectedFileContentTooLargeError(maxOutputBytes, contentLength);
      }
      const reader = res.body?.getReader();
      if (!reader) {
        result = (await res.json()) as { final_text?: string };
      } else {
        const chunks: Uint8Array[] = [];
        let responseBytes = 0;
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            responseBytes += chunk.value.byteLength;
            if (responseBytes > maxResponseBytes) {
              await reader.cancel();
              throw new ProtectedFileContentTooLargeError(maxOutputBytes, responseBytes);
            }
            chunks.push(chunk.value);
          }
        } finally {
          reader.releaseLock();
        }
        result = JSON.parse(Buffer.concat(chunks, responseBytes).toString("utf8")) as { final_text?: string };
      }
    }
    const restored = typeof result.final_text === "string" ? result.final_text : text;
    if (maxOutputBytes !== undefined) {
      const restoredBytes = Buffer.byteLength(restored, "utf8");
      if (restoredBytes > maxOutputBytes) {
        throw new ProtectedFileContentTooLargeError(maxOutputBytes, restoredBytes);
      }
    }
    return restored;
  } catch (err) {
    if (err instanceof ProtectedFileContentTooLargeError) throw err;
    (logger ?? console).log("warn", "protected-pipeline restore backend request failed", {
      err: String(err),
      operation_id: operationId,
    });
    return text;
  }
}

/**
 * Chain restore calls across every operation in order, feeding each call's
 * output into the next. Needed when one response mixes placeholders from
 * several files' registries (a batch protect call covering multiple files).
 */
async function restoreTextWithOperations(
  text: string,
  operations: ProtectedPipelineOperationInfo[],
  logger?: Pick<ServerLogger, "log">,
  maxOutputBytes?: number,
): Promise<string> {
  if (!hasProtectedPipelinePlaceholder(text)) return text;
  let current = text;
  for (const op of operations) {
    current = await restoreTextWithOperation(
      current,
      op.operation_id,
      op.operation_session_id,
      logger,
      maxOutputBytes,
    );
  }
  return current;
}

/** Call the restore backend for one envelope.  Returns restored display text or a safe fallback. */
async function restoreProtectedPipelineEnvelope(
  envelope: ProtectedPipelineEnvelope,
  logger?: Pick<ServerLogger, "log">,
): Promise<string> {
  if (envelope.status !== "needs_display_restore") {
    // No operation info captured — return masked text as-is with a note.
    return (
      envelope.masked_text +
      "\n\n_(Note: placeholder values could not be restored because the restore session ID was unavailable.)_"
    );
  }
  const operations =
    envelope.operations && envelope.operations.length > 0
      ? envelope.operations
      : [{ operation_id: envelope.operation_id, operation_session_id: envelope.operation_session_id }];
  return restoreTextWithOperations(envelope.masked_text, operations, logger);
}

/** Extract a protected_pipeline_result envelope from a task tool-result string, if present. */
function parseProtectedPipelineEnvelope(output: unknown): ProtectedPipelineEnvelope | null {
  if (typeof output !== "string") return null;
  try {
    const parsed = JSON.parse(output);
    if (parsed && typeof parsed === "object" && parsed.type === PROTECTED_PIPELINE_RESULT_TYPE) {
      return parsed as ProtectedPipelineEnvelope;
    }
  } catch {
    // Not JSON — the caller falls back to nested task-result detection.
  }
  return null;
}

function parseCompletedProtectedPipelineOperations(
  state: Record<string, unknown>,
): ProtectedPipelineOperationInfo[] | null {
  if (state.status !== "completed") return null;
  let toolOutput: Record<string, unknown> | null = null;
  try {
    toolOutput = typeof state.output === "string"
      ? JSON.parse(state.output) as Record<string, unknown>
      : typeof state.output === "object" && state.output !== null
        ? state.output as Record<string, unknown>
        : null;
  } catch {
    return null;
  }
  if (!toolOutput) return null;

  // Batch shape from a source_file_paths call: { success, message, results: [...] }.
  if (Array.isArray(toolOutput.results)) {
    const operations = (toolOutput.results as unknown[])
      .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
      .filter((entry) => entry.success === true && typeof entry.operation_id === "string")
      .map((entry) => ({
        operation_id: entry.operation_id as string,
        operation_session_id:
          typeof entry.operation_session_id === "string" ? entry.operation_session_id : null,
      }));
    return operations.length > 0 ? operations : null;
  }

  // Single-file shape: { success, operation_id, operation_session_id, ... }.
  if (toolOutput.success !== true || typeof toolOutput.operation_id !== "string") return null;
  return [
    {
      operation_id: toolOutput.operation_id,
      operation_session_id:
        typeof toolOutput.operation_session_id === "string" ? toolOutput.operation_session_id : null,
    },
  ];
}

const restoreProtectedFileText = createProtectedFileTextRestorer({
  fetchOpencodeJson,
  parseOperations: parseCompletedProtectedPipelineOperations,
  restoreText: restoreTextWithOperations,
  shortId,
});

/**
 * A subagent's own final text becomes the result of its parent's task() call,
 * wrapped in OpenCode's <task id="..."><task_result>...</task_result></task>
 * form. Follow the sessionID embedded in that wrapper to the child session's
 * own messages and recover the envelope's operation info from there.
 */
async function findEnvelopeInChildSession(
  workspace: WorkspaceInfo,
  childSessionId: string,
): Promise<ProtectedPipelineOperationInfo[] | null> {
  try {
    const childMessages = await fetchOpencodeJson(
      workspace,
      `/session/${encodeURIComponent(childSessionId)}/message`,
      { method: "GET" },
    );
    if (!Array.isArray(childMessages)) return null;
    for (const message of childMessages) {
      if (!message || typeof message !== "object") continue;
      const parts = Array.isArray((message as Record<string, unknown>).parts)
        ? ((message as Record<string, unknown>).parts as unknown[])
        : [];
      for (const part of parts) {
        if (!part || typeof part !== "object") continue;
        const partRecord = part as Record<string, unknown>;
        if (partRecord.type !== "tool") continue;
        const state =
          partRecord.state && typeof partRecord.state === "object"
            ? (partRecord.state as Record<string, unknown>)
            : {};

        // Primary path: find the run_protected_file_pipeline tool call whose
        // output is persisted directly by the tool (not plugin-modified) and
        // always contains operation_id (or results[]) when masking succeeded.
        if (partRecord.tool === "run_protected_file_pipeline") {
          const operations = parseCompletedProtectedPipelineOperations(state);
          if (operations) return operations;
        }

        // Fallback path: if somehow the plugin's envelope was written and
        // persisted in a task tool part, use it.
        if (partRecord.tool === "task") {
          const envelope = parseProtectedPipelineEnvelope(state.output);
          if (envelope && envelope.status === "needs_display_restore") {
            return envelope.operations && envelope.operations.length > 0
              ? envelope.operations
              : [{ operation_id: envelope.operation_id, operation_session_id: envelope.operation_session_id }];
          }
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Walk the OpenCode message array and restore protected-pipeline placeholders
 * wherever they surface in the displayed session:
 *   A) a task tool result carrying our own JSON envelope directly;
 *   B) a task tool result wrapped by OpenCode's own <task_result> format,
 *      produced when a subagent (e.g. protected-file-agent) is itself tasked
 *      by a parent agent (e.g. build) — the child rephrases masked_text as
 *      its own final answer, so the wrapper carries placeholders but not JSON;
 *   C) the parent agent's own final text response, which repeats those same
 *      placeholders after relaying the subagent's answer.
 * Restoration only ever touches this display path; the OpenCode transcript
 * is never written back, so no PII enters agent context.
 */
async function overlayProtectedPipelineRestoreOnMessages(
  messages: unknown,
  workspace?: WorkspaceInfo,
  logger?: Pick<ServerLogger, "log">,
): Promise<unknown> {
  if (!Array.isArray(messages)) return messages;

  let changed = false;
  // Most recently discovered operation info while walking messages in order —
  // reused for later plain-text parts that carry the same placeholders but no
  // operation info of their own (e.g. the parent agent's final answer, which
  // is written in a later message than the task tool result it relays). An
  // array because one envelope can cover several files from a batch protect call.
  let lastOperationInfo: ProtectedPipelineOperationInfo[] | null = null;

  const nextMessages: unknown[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") {
      nextMessages.push(message);
      continue;
    }
    const record = message as Record<string, unknown>;
    const parts = Array.isArray(record.parts) ? record.parts : [];
    let partsChanged = false;
    const nextParts: unknown[] = [];

    for (const part of parts) {
      if (!part || typeof part !== "object") {
        nextParts.push(part);
        continue;
      }
      const partRecord = part as Record<string, unknown>;
      let handled = false;

      // A protected-file child session persists its operation metadata on the
      // durable pipeline tool result. Reuse it for later display-only text.
      if (partRecord.type === "tool" && partRecord.tool === "run_protected_file_pipeline") {
        const state =
          partRecord.state && typeof partRecord.state === "object"
            ? (partRecord.state as Record<string, unknown>)
            : {};
        const operations = parseCompletedProtectedPipelineOperations(state);
        if (operations) {
          lastOperationInfo = operations;
        }
      }

      if (partRecord.type === "tool" && partRecord.tool === "task") {
        const state =
          partRecord.state && typeof partRecord.state === "object"
            ? (partRecord.state as Record<string, unknown>)
            : {};

        // Case A: direct envelope.
        const envelope = parseProtectedPipelineEnvelope(state.output);
        if (envelope) {
          if (envelope.status === "needs_display_restore") {
            lastOperationInfo =
              envelope.operations && envelope.operations.length > 0
                ? envelope.operations
                : [{ operation_id: envelope.operation_id, operation_session_id: envelope.operation_session_id }];
          }
          const restoredOutput = await restoreProtectedPipelineEnvelope(envelope, logger);
          partsChanged = true;
          changed = true;
          nextParts.push({ ...partRecord, state: { ...state, output: restoredOutput } });
          handled = true;
        } else if (typeof state.output === "string") {
          // Case B: OpenCode's own <task_result> wrapper, still masked. The
          // wrapper is followed by session link rather than by placeholder
          // shape, because a subagent paraphrasing its answer may have dropped
          // the angle brackets; substitution stays registry-scoped server-side.
          const nestedMatch = state.output.match(NESTED_TASK_ID_RE);
          const metadata =
            state.metadata && typeof state.metadata === "object"
              ? (state.metadata as Record<string, unknown>)
              : {};
          const hasPlaceholder = hasProtectedPipelinePlaceholder(state.output);
          // Metadata IDs are common on ordinary task parts; only use that fallback for masked output.
          const childSessionId =
            nestedMatch?.[1] ??
            (hasPlaceholder && typeof metadata.sessionId === "string" ? metadata.sessionId : undefined);
          if (childSessionId && workspace) {
            // Keep wrapper lookups for later parent text; metadata-only lookups require masked output.
            const childInfo = await findEnvelopeInChildSession(workspace, childSessionId);
            if (childInfo) lastOperationInfo = childInfo;
          }
          if (lastOperationInfo && lastOperationInfo.length > 0) {
            const restoredOutput = await restoreTextWithOperations(state.output, lastOperationInfo, logger);
            if (restoredOutput !== state.output) {
              partsChanged = true;
              changed = true;
              nextParts.push({ ...partRecord, state: { ...state, output: restoredOutput } });
              handled = true;
            }
          }
        }
      }

      // Case C: parent agent's own final text, still masked.
      if (
        !handled &&
        (partRecord.type === "text" || partRecord.type === "reasoning") &&
        typeof partRecord.text === "string" &&
        lastOperationInfo &&
        lastOperationInfo.length > 0
      ) {
        const restoredText = await restoreTextWithOperations(partRecord.text, lastOperationInfo, logger);
        if (restoredText !== partRecord.text) {
          partsChanged = true;
          changed = true;
          nextParts.push({ ...partRecord, text: restoredText });
          handled = true;
        }
      }

      if (!handled) nextParts.push(part);
    }

    nextMessages.push(partsChanged ? { ...record, parts: nextParts } : message);
  }

  return changed ? nextMessages : messages;
}

// ── End protected pipeline display-restore overlay ─────────────────────────

const HYBRID_DR_GENERATION_RESTARTED =
  "Hybrid Deep Research was interrupted because the research service restarted. No report was produced; please retry.";

// Native managed HDR is restarted by Sandbox Manager together with its whole role set, OpenCode
// and this server included. A tool call that began before this server started therefore cannot
// still be executing, and OpenCode never marks it: its interrupted-tool cleanup runs in-process,
// which a Job kill skips.
function hybridDrPartStartedBefore(
  message: Record<string, unknown>,
  state: Record<string, unknown>,
  generationStartedAt: number,
): boolean {
  if (process.env.HYBRID_DR_NATIVE_MANAGED?.trim() !== "1") return false;
  const time = state.time && typeof state.time === "object" ? state.time as Record<string, unknown> : {};
  const info = message.info && typeof message.info === "object" ? message.info as Record<string, unknown> : {};
  const infoTime = info.time && typeof info.time === "object" ? info.time as Record<string, unknown> : {};
  const startedAt = typeof time.start === "number" ? time.start
    : typeof infoTime.created === "number" ? infoTime.created : null;
  return startedAt !== null && startedAt < generationStartedAt;
}

function hybridDrGenerationRestartedPart(
  part: Record<string, unknown>,
  state: Record<string, unknown>,
  generationStartedAt: number,
): Record<string, unknown> {
  const time = state.time && typeof state.time === "object" ? state.time as Record<string, unknown> : {};
  const metadata = state.metadata && typeof state.metadata === "object" ? state.metadata as Record<string, unknown> : {};
  return {
    ...part,
    state: {
      status: "error",
      input: state.input ?? {},
      error: HYBRID_DR_GENERATION_RESTARTED,
      time: { start: typeof time.start === "number" ? time.start : generationStartedAt, end: generationStartedAt },
      metadata: { ...metadata, hybridDrTerminal: true, hybridDrFailure: "runtime_generation_restarted" },
    },
  };
}

async function overlayHybridDrProgressOnMessages(
  sessionId: string,
  messages: unknown,
  generationStartedAt: number,
): Promise<unknown> {
  if (!Array.isArray(messages)) return messages;
  let changed = false;
  const nextMessages = await Promise.all(messages.map(async (message) => {
    if (!message || typeof message !== "object") return message;
    const record = message as Record<string, unknown>;
    const parts = Array.isArray(record.parts) ? record.parts : [];
    let partsChanged = false;
    const nextParts = await Promise.all(parts.map(async (part) => {
      if (!part || typeof part !== "object") return part;
      const partRecord = part as Record<string, unknown>;
      if (partRecord.type !== "tool" || partRecord.tool !== "hybrid_dr_post_polish_processor") return part;
      const state = partRecord.state && typeof partRecord.state === "object" ? partRecord.state as Record<string, unknown> : {};
      const status = typeof state.status === "string" ? state.status : "";
      if ((status === "running" || status === "pending")
        && hybridDrPartStartedBefore(record, state, generationStartedAt)) {
        partsChanged = true;
        changed = true;
        return hybridDrGenerationRestartedPart(partRecord, state, generationStartedAt);
      }
      const outputStatus = hybridDrToolOutputStatus(partRecord);
      if (status !== "running" && status !== "pending" && outputStatus !== "running") return part;
      const progress = await fetchHybridDrProgressTitle(sessionId, partRecord);
      if (!progress?.title) return part;
      partsChanged = true;
      changed = true;
      const metadata = state.metadata && typeof state.metadata === "object" ? state.metadata as Record<string, unknown> : {};
      const display = progress.display ?? {};
      return { ...partRecord, state: { ...state, title: progress.title, metadata: { ...metadata, ...display, hybridDrTerminal: progress.terminal } } };
    }));
    return partsChanged ? { ...record, parts: nextParts } : message;
  }));
  return changed ? nextMessages : messages;
}

async function cancelHybridDrProgressForSession(sessionId: string): Promise<void> {
  const connection = hybridDrConnection();
  if (!connection) return;
  const sessionDir = join(connection.root, safeHybridDrProgressSegment(sessionId));
  let files: string[];
  try {
    files = await readdir(sessionDir);
  } catch {
    return;
  }
  await Promise.all(files.filter((file) => file.endsWith(".json")).map(async (file) => {
    const path = join(sessionDir, file);
    let registry: HybridDrProgressRegistry;
    try {
      registry = JSON.parse(await readFile(path, "utf8")) as HybridDrProgressRegistry;
    } catch {
      return;
    }
    if (!validHybridDrRegistry(registry, sessionId, file.slice(0, -5)) || terminalHybridDrRegistry(registry)) return;
    const sidecarSessionId = registry.sidecarSessionId as string;
    try {
      // Existing cancel API acknowledges acceptance, not terminal completion. Do not cancel a
      // session already completed on the sidecar, nor claim success on 401/network/invalid replies.
      const before = await hybridDrState(connection, sidecarSessionId);
      if (!before || hybridDrTitleForPhase(before).terminal) return;
      // egress-surface: openwork_hdr_control
      const response = await fetch(`${connection.url}/${sidecarSessionId}/cancel`, {
        method: "POST",
        headers: connection.headers,
        redirect: "error",
        signal: AbortSignal.timeout(1500),
      });
      if (!response.ok) return;
      const body = await response.json() as { session_id?: unknown; cancelled?: unknown };
      if (body.session_id !== sidecarSessionId || body.cancelled !== true) return;
      if (await hybridDrState(connection, sidecarSessionId) !== "cancelled") return;
      // The tool may have finished or replaced this record while HTTP was in flight.
      const current = JSON.parse(await readFile(path, "utf8")) as HybridDrProgressRegistry;
      if (!validHybridDrRegistry(current, sessionId, file.slice(0, -5))
        || current.sidecarSessionId !== sidecarSessionId || terminalHybridDrRegistry(current)) return;
      await writeFile(
        path,
        JSON.stringify({ ...current, status: "cancelled", terminal: true, updatedAt: Date.now() }, null, 2) + "\n",
        "utf8",
      );
      hybridDrProgressCache.clear();
    } catch {
      // Preserve the public OpenCode abort response; never log registry, query, path or auth data.
    }
  }));
}

async function fetchOpencodeSessionTitle(workspace: WorkspaceInfo, sessionId: string, fallbackName?: string): Promise<string> {
  const session = await fetchOpencodeJson(workspace, `/session/${encodeURIComponent(sessionId)}`, { method: "GET" });
  return typeof session?.title === "string" ? session.title : `Automation: ${fallbackName ?? sessionId}`;
}

async function createAgentLabAutomationSession(workspace: WorkspaceInfo, automation: AgentLabAutomation): Promise<string> {
  const created = await fetchOpencodeJson(workspace, "/session", {
    method: "POST",
    body: { title: `Automation: ${automation.name}` },
  });
  return typeof created?.id === "string" ? created.id : String(created?.id ?? "");
}

async function resolveAgentLabAutomationSession(workspace: WorkspaceInfo, automation: AgentLabAutomation): Promise<string> {
  const existing = automation.lastRunSessionId?.trim();
  if (existing) {
    try {
      await fetchOpencodeJson(workspace, `/session/${encodeURIComponent(existing)}`, { method: "GET" });
      await pruneAgentLabAutomationSessionContext(workspace, existing, AGENTLAB_AUTOMATION_CONTEXT_RUNS - 1);
      return existing;
    } catch (err) {
      // Only fall back to a new session when the stored session is genuinely gone
      // (OpenCode returned 404). Network faults or non-404 server errors propagate
      // so the scheduler tick fails cleanly rather than silently creating a ghost session.
      const details = err instanceof ApiError ? (err.details as { status?: number } | undefined) : undefined;
      if (details?.status !== 404) throw err;
    }
  }
  return createAgentLabAutomationSession(workspace, automation);
}

/** `beforePrompt` gets the run's session before its prompt is posted. */
async function dispatchAgentLabAutomationRun(workspace: WorkspaceInfo, automation: AgentLabAutomation, model: string, beforePrompt?: (sessionId: string) => void) {
  return exclusiveAutomationDispatch(`${workspace.id}:${automation.id}`, async () => {
    // Before resolving the session: a refused run must not create or prune one.
    const target = await resolveAutomationRunTarget(automation, model, (path) => fetchOpencodeJson(workspace, path, { method: "GET" }));
    const sessionId = target.freshSession ? await createAgentLabAutomationSession(workspace, automation) : await resolveAgentLabAutomationSession(workspace, automation);
    if (!sessionId.trim()) throw new ApiError(502, "opencode_failed", "OpenCode session did not return an id");
    noteDispatchedAgent(sessionId, target.agent);
    beforePrompt?.(sessionId);
    const tools = await resolveToolGateForPrompt({ workspace, sessionID: sessionId, agent: target.agent });
    await fetchOpencodeJson(workspace, `/session/${encodeURIComponent(sessionId)}/prompt_async`, {
      method: "POST",
      body: { parts: [{ type: "text", text: automation.prompt }], agent: target.agent, ...parseModelString(target.model), ...(tools ? { tools } : {}) },
    });
    return { agent: target.agent, model: target.model, sessionId };
  });
}

async function fetchOpencodeSessionMessages(workspace: WorkspaceInfo, sessionId: string, limit?: number): Promise<Array<{ info?: unknown; parts?: unknown }>> {
  const query = typeof limit === "number" ? `?limit=${encodeURIComponent(String(limit))}` : "";
  const messages = await fetchOpencodeJson(workspace, `/session/${encodeURIComponent(sessionId)}/message${query}`, { method: "GET" });
  return Array.isArray(messages) ? messages as Array<{ info?: unknown; parts?: unknown }> : [];
}

function getMessageId(message: { info?: unknown }): string | null {
  const info = message.info;
  if (!info || typeof info !== "object") return null;
  const id = (info as { id?: unknown }).id;
  return typeof id === "string" && id.trim() ? id : null;
}

function getMessageRole(message: { info?: unknown }): string | null {
  const info = message.info;
  if (!info || typeof info !== "object") return null;
  const role = (info as { role?: unknown }).role;
  return typeof role === "string" ? role : null;
}

function textFromMessageParts(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  return parts
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const record = part as { type?: unknown; text?: unknown };
      return record.type === "text" && typeof record.text === "string" ? record.text.trim() : "";
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

async function fetchLatestAssistantResponseText(workspace: WorkspaceInfo, sessionId: string): Promise<string | null> {
  const messages = await fetchOpencodeSessionMessages(workspace, sessionId, 20);
  for (const message of [...messages].reverse()) {
    if (getMessageRole(message) !== "assistant") continue;
    const text = textFromMessageParts(message.parts);
    if (text) return text;
  }
  return null;
}

function findSlackThreadPeerId(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const targets = (result as { targets?: unknown }).targets;
  if (!Array.isArray(targets)) return null;
  for (const target of targets) {
    if (!target || typeof target !== "object") continue;
    const peerId = (target as { peerId?: unknown }).peerId;
    const partResults = (target as { partResults?: unknown }).partResults;
    if (typeof peerId !== "string" || !Array.isArray(partResults)) continue;
    const channelId = peerId.split("|")[0];
    for (const part of partResults) {
      if (!part || typeof part !== "object") continue;
      const record = part as { sent?: unknown; providerMessageId?: unknown };
      if (record.sent === true && typeof record.providerMessageId === "string" && record.providerMessageId.trim()) {
        return `${channelId}|${record.providerMessageId.trim()}`;
      }
    }
  }
  return null;
}

async function persistAgentLabAutomationSlackThread(workspace: WorkspaceInfo, automationId: string, peerId: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const store = await readAgentLabAutomations(workspace.path);
      const automation = store.items.find((item) => item.id === automationId);
      if (!automation || automation.slackThreadPeerId === peerId) return;
      automation.slackThreadPeerId = peerId;
      automation.updatedAt = Date.now();
      await writeAgentLabAutomations(workspace.path, store);
      return;
    } catch (error) {
      const isRetryable = error instanceof ApiError && error.code === "invalid_json" && attempt < 2;
      if (!isRetryable) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

async function pruneAgentLabAutomationSessionContext(workspace: WorkspaceInfo, sessionId: string, maxRuns: number): Promise<void> {
  const messages = await fetchOpencodeSessionMessages(workspace, sessionId);
  const userMessages = messages.filter((message) => getMessageRole(message) === "user");
  const excess = userMessages.length - maxRuns;
  if (excess <= 0) return;

  const messageIdsToDelete = new Set<string>();
  let remainingUserMessagesToDelete = excess;
  // After the Nth user message is marked for deletion, include its paired assistant
  // reply so the surviving context never starts with an orphaned assistant turn.
  let collectingTrailingAssistant = false;
  for (const message of messages) {
    const id = getMessageId(message);
    if (!id) continue;
    if (collectingTrailingAssistant) {
      if (getMessageRole(message) === "assistant") {
        messageIdsToDelete.add(id);
      }
      break;
    }
    messageIdsToDelete.add(id);
    if (getMessageRole(message) === "user") {
      remainingUserMessagesToDelete -= 1;
      if (remainingUserMessagesToDelete === 0) {
        collectingTrailingAssistant = true;
      }
    }
  }

  for (const messageId of messageIdsToDelete) {
    await fetchOpencodeJson(workspace, `/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(messageId)}`, {
      method: "DELETE",
    }).catch(() => undefined);
  }
}

function normalizeOpencodeEvent(raw: unknown): { type: string; properties?: Record<string, unknown> } | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.type === "string") {
    return {
      type: record.type,
      properties: record.properties && typeof record.properties === "object" ? record.properties as Record<string, unknown> : undefined,
    };
  }
  if (record.payload && typeof record.payload === "object") {
    const payload = record.payload as Record<string, unknown>;
    if (typeof payload.type === "string") {
      return {
        type: payload.type,
        properties: payload.properties && typeof payload.properties === "object" ? payload.properties as Record<string, unknown> : undefined,
      };
    }
  }
  return null;
}

async function waitForOpencodeSessionIdle(workspace: WorkspaceInfo, sessionId: string, timeoutMs: number): Promise<boolean> {
  const baseUrl = workspace.baseUrl?.trim() ?? "";
  if (!baseUrl) return false;

  const url = new URL(baseUrl);
  url.pathname = "/event";
  url.search = "";

  const headers = new Headers();
  const directory = resolveOpencodeDirectory(workspace);
  if (directory) {
    headers.set("x-opencode-directory", directory);
  }
  const auth = buildOpencodeAuthHeader(workspace);
  if (auth) {
    headers.set("Authorization", auth);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    // egress-surface: openwork_proxy_opencode
    const response = await fetch(url.toString(), { method: "GET", headers, signal: controller.signal });
    if (!response.ok || !response.body) return false;

    const decoder = new TextDecoder();
    reader = response.body.getReader();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) return false;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split(/\r?\n\r?\n/);
      buffer = chunks.pop() ?? "";
      for (const chunk of chunks) {
        const data = chunk
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n")
          .trim();
        if (!data || data === "[DONE]") continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }
        const event = normalizeOpencodeEvent(parsed);
        if (event?.type !== "session.idle") continue;
        if (event.properties?.sessionID === sessionId) return true;
      }
    }
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    reader?.cancel().catch(() => { });
  }
}

function normalizeAutomationDirectory(value: string): string {
  const unified = value.trim().replace(/\\/g, "/");
  const withoutTrailing = unified.replace(/\/+$/, "");
  const normalized = withoutTrailing || "/";
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function fetchSlackAutomationRootPeerId(input: {
  workspace: WorkspaceInfo;
  requestHost?: string | null;
}): Promise<string | null> {
  if (!parseInteger(process.env.OPENCODE_ROUTER_HEALTH_PORT)) return null;
  const port = resolveOpenCodeRouterHealthPort();
  const query = new URLSearchParams({ channel: "slack" });
  const result = await tryFetchOpenCodeRouterHealth(
    "GET",
    `/bindings?${query.toString()}`,
    { port, requestHost: input.requestHost ?? null, timeoutMs: 2_000 },
  );
  if (!result.applied || !result.body || typeof result.body !== "object") return null;
  const items = (result.body as { items?: unknown }).items;
  if (!Array.isArray(items)) return null;
  const workspacePath = normalizeAutomationDirectory(input.workspace.path);
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const directory = (item as { directory?: unknown }).directory;
    const peerId = (item as { peerId?: unknown }).peerId;
    if (typeof directory !== "string" || normalizeAutomationDirectory(directory) !== workspacePath) continue;
    if (typeof peerId === "string" && peerId.trim() && !peerId.includes("|")) return peerId.trim();
  }
  return null;
}

async function notifySlackWhenAgentLabAutomationCompletes(input: {
  workspace: WorkspaceInfo;
  automation: AgentLabAutomation;
  sessionId: string;
  logger: ServerLogger;
  requestHost?: string | null;
  completionObserved: Promise<boolean>;
  /** Root Slack channel peer ID already resolved by the scheduler; avoids a second
   *  HTTP round-trip to the router when the automation does not yet have a thread. */
  resolvedRootPeerId: string | null;
}) {
  try {
    const completed = await input.completionObserved;
    if (!completed) {
      input.logger.log("warn", "Scheduler: Slack notification skipped because automation completion was not observed", {
        automationId: input.automation.id,
        sessionId: input.sessionId,
      });
      return;
    }
    const port = resolveOpenCodeRouterHealthPort();
    // Use the root peer ID resolved at scheduling time; no second fetch needed.
    const rootPeerId = input.automation.slackThreadPeerId ? null : input.resolvedRootPeerId;
    if (!input.automation.slackThreadPeerId && !rootPeerId) {
      input.logger.log("warn", "Scheduler: Slack notification skipped because no root Slack channel binding was found", {
        automationId: input.automation.id,
        sessionId: input.sessionId,
      });
      return;
    }
    const title = await fetchOpencodeSessionTitle(input.workspace, input.sessionId, input.automation.name).catch(() => `Automation: ${input.automation.name}`);
    const responseText = await fetchLatestAssistantResponseText(input.workspace, input.sessionId).catch(() => null);
    const messageLines = [
      `✅ Scheduler completed: ${input.automation.name}`,
      `Session: ${title}`,
      `Session ID: ${input.sessionId}`,
    ];
    if (responseText) {
      messageLines.push("", "Agent response:", responseText);
    }
    const message = messageLines.join("\n");
    const apply = await tryPostOpenCodeRouterHealth(
      "/send",
      {
        channel: "slack",
        directory: input.workspace.path,
        peerId: input.automation.slackThreadPeerId ?? rootPeerId,
        text: message,
      },
      { port, requestHost: input.requestHost ?? null, timeoutMs: 5_000 },
    );

    if (!apply.applied) {
      input.logger.log("warn", "Scheduler: failed to send Slack notification", {
        automationId: input.automation.id,
        sessionId: input.sessionId,
        error: apply.error,
        status: apply.status,
      });
    } else if (!input.automation.slackThreadPeerId) {
      const threadPeerId = findSlackThreadPeerId(apply.body);
      if (threadPeerId) {
        input.automation.slackThreadPeerId = threadPeerId;
        await persistAgentLabAutomationSlackThread(input.workspace, input.automation.id, threadPeerId).catch((error) => {
          input.logger.log("warn", "Scheduler: failed to persist Slack thread", {
            automationId: input.automation.id,
            sessionId: input.sessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    }
  } catch (error) {
    input.logger.log("warn", "Scheduler: failed to send Slack notification", {
      automationId: input.automation.id,
      sessionId: input.sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Determine whether an automation is due for execution based on its schedule
 * type and the last time it ran. Returns true when enough time has elapsed
 * since the previous run (or the automation has never run before).
 */
async function readAgentLabAutomations(workspaceRoot: string): Promise<AgentLabAutomationStore> {
  const path = resolveAgentLabAutomationsPath(workspaceRoot);
  if (!(await exists(path))) {
    return { schemaVersion: 1, updatedAt: Date.now(), items: [] };
  }
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<AgentLabAutomationStore>;
    const items = Array.isArray(parsed.items) ? parsed.items : [];
    const normalized: AgentLabAutomation[] = [];
    for (const item of items) {
      const record = item as Partial<AgentLabAutomation>;
      const id = typeof record.id === "string" ? record.id.trim() : "";
      const name = typeof record.name === "string" ? record.name.trim() : "";
      const prompt = typeof record.prompt === "string" ? record.prompt : "";
      const enabled = typeof record.enabled === "boolean" ? record.enabled : true;
      if (!id || !name || !prompt) continue;
      let schedule: AgentLabSchedule;
      try {
        schedule = parseAgentLabSchedule(record.schedule);
      } catch {
        continue;
      }
      normalized.push({
        id,
        name,
        enabled,
        schedule,
        prompt,
        model: typeof record.model === "string" && record.model.trim() ? record.model.trim() : undefined,
        agent: normalizeAutomationAgent(record.agent),
        createdAt: typeof record.createdAt === "number" ? record.createdAt : Date.now(),
        updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : undefined,
        lastRunAt: typeof record.lastRunAt === "number" ? record.lastRunAt : undefined,
        lastRunSessionId: typeof record.lastRunSessionId === "string" ? record.lastRunSessionId : undefined,
        lastRunError: typeof record.lastRunError === "string" ? record.lastRunError : undefined,
        slackThreadPeerId: typeof record.slackThreadPeerId === "string" ? record.slackThreadPeerId : undefined,
      });
    }
    return {
      schemaVersion: typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : 1,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
      items: normalized,
    };
  } catch {
    throw new ApiError(422, "invalid_json", "Failed to parse Agent Lab automations");
  }
}

async function writeAgentLabAutomations(workspaceRoot: string, store: AgentLabAutomationStore): Promise<void> {
  const path = resolveAgentLabAutomationsPath(workspaceRoot);
  await ensureDir(dirname(path));
  await writeFile(path, JSON.stringify({ ...store, updatedAt: Date.now() }, null, 2) + "\n", "utf8");
}

export function normalizeWorkspaceRelativePath(input: string, options: { allowSubdirs: boolean }): string {
  const raw = String(input ?? "").trim();
  if (!raw) {
    throw new ApiError(400, "invalid_path", "Path is required");
  }
  if (raw.includes("\u0000")) {
    throw new ApiError(400, "invalid_path", "Path contains null byte");
  }

  // A lot of user-facing surfaces (artifacts, tool logs) reference files as
  // `workspace/<path>` or `/workspace/<path>`. The server API expects
  // workspace-relative paths, so normalize those common prefixes here.
  let normalized = raw.replace(/\\/g, "/");
  normalized = normalized.replace(/^\/+/, "");
  normalized = normalized.replace(/^\.\//, "");
  normalized = normalized.replace(/^workspace\//, "");
  normalized = normalized.replace(/^\/+/, "");

  const parts = normalized.split("/").filter(Boolean);
  if (!parts.length) {
    throw new ApiError(400, "invalid_path", "Path is required");
  }
  if (!options.allowSubdirs && parts.length > 1) {
    throw new ApiError(400, "invalid_path", "Subdirectories are not allowed");
  }
  for (const part of parts) {
    if (part === "." || part === "..") {
      throw new ApiError(400, "invalid_path", "Path traversal is not allowed");
    }
  }
  return parts.join("/");
}

function encodeArtifactId(path: string): string {
  return Buffer.from(path, "utf8").toString("base64url");
}

function decodeArtifactId(id: string): string {
  const raw = (id ?? "").trim();
  if (!raw) {
    throw new ApiError(400, "invalid_artifact", "Artifact id is required");
  }
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    return normalizeWorkspaceRelativePath(decoded, { allowSubdirs: true });
  } catch {
    throw new ApiError(400, "invalid_artifact", "Artifact id is invalid");
  }
}

function encodeInboxId(path: string): string {
  return encodeArtifactId(path);
}

function decodeInboxId(id: string): string {
  try {
    return decodeArtifactId(id);
  } catch {
    throw new ApiError(400, "invalid_inbox_item", "Inbox item id is invalid");
  }
}

type ArtifactDirectoryEntry = {
  name: string,
  isDirectory: () => boolean;
  isFile: () => boolean;
};

type ArtifactReaddir = (path: string) => Promise<ArtifactDirectoryEntry[]>;

const readArtifactDirectory: ArtifactReaddir = (path) => readdir(path, { withFileTypes: true });

export async function listArtifacts(outboxRoot: string, readDirectory: ArtifactReaddir = readArtifactDirectory): Promise<Array<{ id: string; path: string; size: number; updatedAt: number; kind?: "file" | "dir" }>> {
  const rootResolved = resolve(outboxRoot);
  if (!(await exists(rootResolved))) return [];

  const items: Array<{ id: string; path: string; size: number; updatedAt: number; kind?: "file" | "dir" }> = [];

  const addDirectory = async (dir: string) => {
    try {
      const rel = normalizeWorkspaceRelativePath(relative(rootResolved, dir), {
        allowSubdirs: true,
      });
      const info = await stat(dir);
      items.push({
        id: encodeArtifactId(rel),
        path: rel,
        size: 0,
        updatedAt: info.mtimeMs,
        kind: "dir",
      })
    } catch {
      // Directory disapeared or cannot be statted
    }
  };

  const walk = async (dir: string) => {
    let entries;
    try {
      entries = await readDirectory(dir);
    } catch {
      if (dir !== rootResolved) await addDirectory(dir);
      return;
    }

    const subDirs: string[] = [];
    const fileEntries: { abs: string; rel: string }[] = [];

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (entry.name === "opencode.jsonc") continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        subDirs.push(abs);
      } else if (entry.isFile()) {
        const rel = normalizeWorkspaceRelativePath(relative(rootResolved, abs), { allowSubdirs: true });
        fileEntries.push({ abs, rel });
      }
    }

    const hasChildren = subDirs.length > 0 || fileEntries.length > 0;

    // Stat files in batches to avoid EMFILE on large directories
    const STAT_BATCH = 64;
    for (let i = 0; i < fileEntries.length; i += STAT_BATCH) {
      const batch = fileEntries.slice(i, i + STAT_BATCH);
      const stats = await Promise.allSettled(batch.map((f) => stat(f.abs)));
      for (let j = 0; j < batch.length; j++) {
        const result = stats[j];
        if (!result || result.status === "rejected") continue;
        items.push({
          id: encodeArtifactId(batch[j]!.rel),
          path: batch[j]!.rel,
          size: result.value.size,
          updatedAt: result.value.mtimeMs,
          kind: "file",
        });
      }
    }

    // Recurse into subdirectories sequentially to limit total concurrency
    for (const d of subDirs) {
      await walk(d);
    }

    // Include empty directories so the frontend can display them
    if (!hasChildren && dir !== rootResolved) {
      await addDirectory(dir);
    }
  };

  await walk(rootResolved);

  items.sort((a, b) => b.updatedAt - a.updatedAt);
  return items;
}

async function listInbox(inboxRoot: string): Promise<Array<{ id: string; path: string; size: number; updatedAt: number; name: string }>> {
  const items = await listArtifacts(inboxRoot);
  return items.map((item) => ({
    ...item,
    id: encodeInboxId(item.path),
    name: basename(item.path),
  }));
}

type FileSessionCatalogEntry = {
  path: string;
  kind: "file" | "dir";
  size: number;
  mtimeMs: number;
  revision: string;
};

function fileRevision(info: { mtimeMs: number; size: number }): string {
  return `${Math.floor(info.mtimeMs)}:${info.size}`;
}

function parseFileSessionTtlMs(input: unknown): number {
  const raw = typeof input === "number" && Number.isFinite(input) ? input : Number.NaN;
  if (Number.isNaN(raw)) return FILE_SESSION_DEFAULT_TTL_MS;
  const ttlMs = Math.floor(raw * 1000);
  if (ttlMs < FILE_SESSION_MIN_TTL_MS) return FILE_SESSION_MIN_TTL_MS;
  if (ttlMs > FILE_SESSION_MAX_TTL_MS) return FILE_SESSION_MAX_TTL_MS;
  return ttlMs;
}

function parseCatalogLimit(input: string | null): number {
  if (!input) return FILE_SESSION_CATALOG_DEFAULT_LIMIT;
  const parsed = Number(input);
  if (!Number.isFinite(parsed) || parsed <= 0) return FILE_SESSION_CATALOG_DEFAULT_LIMIT;
  return Math.min(Math.floor(parsed), FILE_SESSION_CATALOG_MAX_LIMIT);
}

function parseSessionCursor(input: string | null): number {
  if (!input) return 0;
  const parsed = Number(input);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

function parseCatalogPathFilter(input: string | null): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  return normalizeWorkspaceRelativePath(trimmed, { allowSubdirs: true });
}

function matchesCatalogFilter(path: string, filter: string | null): boolean {
  if (!filter) return true;
  return path === filter || path.startsWith(`${filter}/`);
}

function normalizeResolvedRelativePath(input: string): string {
  const normalized = input.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  if (!parts.length) {
    throw new ApiError(400, "invalid_path", "Path is required");
  }
  for (const part of parts) {
    if (part === "." || part === "..") {
      throw new ApiError(400, "invalid_path", "Path traversal is not allowed");
    }
  }
  return parts.join("/");
}

async function listWorkspaceCatalogEntries(workspaceRoot: string): Promise<FileSessionCatalogEntry[]> {
  const rootResolved = resolve(workspaceRoot);
  const items: FileSessionCatalogEntry[] = [];

  const walk = async (dirPath: string) => {
    const entries = await readdir(dirPath, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const absPath = join(dirPath, entry.name);
      const relRaw = relative(rootResolved, absPath).replace(/\\/g, "/");
      const rel = normalizeResolvedRelativePath(relRaw);

      if (entry.isDirectory()) {
        const info = await stat(absPath);
        items.push({
          path: rel,
          kind: "dir",
          size: 0,
          mtimeMs: info.mtimeMs,
          revision: fileRevision({ mtimeMs: info.mtimeMs, size: 0 }),
        });
        await walk(absPath);
        continue;
      }

      if (!entry.isFile()) continue;
      const info = await stat(absPath);
      items.push({
        path: rel,
        kind: "file",
        size: info.size,
        mtimeMs: info.mtimeMs,
        revision: fileRevision(info),
      });
    }
  };

  if (await exists(rootResolved)) {
    await walk(rootResolved);
  }

  items.sort((a, b) => a.path.localeCompare(b.path));
  return items;
}

function parseBatchPathList(input: unknown): string[] {
  if (!Array.isArray(input)) {
    throw new ApiError(400, "invalid_payload", "paths must be an array");
  }
  if (!input.length) {
    throw new ApiError(400, "invalid_payload", "paths must not be empty");
  }
  if (input.length > FILE_SESSION_MAX_BATCH_ITEMS) {
    throw new ApiError(400, "invalid_payload", `paths must include <= ${FILE_SESSION_MAX_BATCH_ITEMS} items`);
  }
  return input.map((raw) => normalizeWorkspaceRelativePath(String(raw ?? ""), { allowSubdirs: true }));
}

function parseBatchWriteList(input: unknown): Array<{ path: string; contentBase64: string; ifMatchRevision?: string; force?: boolean }> {
  if (!Array.isArray(input)) {
    throw new ApiError(400, "invalid_payload", "writes must be an array");
  }
  if (!input.length) {
    throw new ApiError(400, "invalid_payload", "writes must not be empty");
  }
  if (input.length > FILE_SESSION_MAX_BATCH_ITEMS) {
    throw new ApiError(400, "invalid_payload", `writes must include <= ${FILE_SESSION_MAX_BATCH_ITEMS} items`);
  }

  return input.map((raw) => {
    if (!raw || typeof raw !== "object") {
      throw new ApiError(400, "invalid_payload", "write entries must be objects");
    }
    const record = raw as Record<string, unknown>;
    const contentBase64 = typeof record.contentBase64 === "string" ? record.contentBase64.trim() : "";
    if (!contentBase64) {
      throw new ApiError(400, "invalid_payload", "contentBase64 is required");
    }
    const ifMatchRevision =
      typeof record.ifMatchRevision === "string" && record.ifMatchRevision.trim().length
        ? record.ifMatchRevision.trim()
        : undefined;
    return {
      path: normalizeWorkspaceRelativePath(String(record.path ?? ""), { allowSubdirs: true }),
      contentBase64,
      ...(ifMatchRevision ? { ifMatchRevision } : {}),
      ...(record.force === true ? { force: true } : {}),
    };
  });
}

function emitReloadEvent(
  reloadEvents: ReloadEventStore,
  workspace: WorkspaceInfo,
  reason: ReloadReason,
  trigger?: ReloadTrigger,
) {
  // Record the reload event so SSE subscribers can be notified
  reloadEvents.record(workspace.id, reason, trigger);
}

function buildConfigTrigger(path: string): ReloadTrigger {
  const name = path.split(/[\\/]/).filter(Boolean).pop();
  return {
    type: "config",
    name: name || "opencode.json",
    action: "updated",
    path,
  };
}

function serializeWorkspace(workspace: ServerConfig["workspaces"][number]) {
  const { opencodeUsername, opencodePassword, ...rest } = workspace;
  const opencodeDirectory = resolveOpencodeDirectory(workspace);
  const opencode =
    workspace.baseUrl || opencodeDirectory || opencodeUsername || opencodePassword
      ? {
        baseUrl: workspace.baseUrl,
        directory: opencodeDirectory ?? undefined,
        username: opencodeUsername,
      }
      : undefined;
  return {
    ...rest,
    opencode,
  };
}

function createRoutes(
  config: ServerConfig,
  approvals: ApprovalService,
  tokens: TokenService,
  logger?: Pick<ServerLogger, "log">,
): Route[] {
  const routes: Route[] = [];
  const fileSessions = new FileSessionStore();
  const skillPackageImports = new SkillPackageImportStore();

  const serializeFileSession = (session: {
    id: string;
    workspaceId: string;
    createdAt: number;
    expiresAt: number;
    canWrite: boolean;
  }) => ({
    id: session.id,
    workspaceId: session.workspaceId,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    ttlMs: Math.max(0, session.expiresAt - Date.now()),
    canWrite: session.canWrite,
  });

  const resolveFileSession = (ctx: RequestContext, sessionId: string) => {
    const session = fileSessions.get(sessionId);
    if (!session) {
      throw new ApiError(404, "file_session_not_found", "File session not found");
    }

    if (!ctx.actor?.tokenHash || session.actorTokenHash !== ctx.actor.tokenHash) {
      throw new ApiError(403, "forbidden", "File session does not belong to this token");
    }

    const workspace = config.workspaces.find((item) => item.id === session.workspaceId);
    if (!workspace) {
      throw new ApiError(404, "workspace_not_found", "Workspace not found for this file session");
    }

    return { session, workspace };
  };

  const recordWorkspaceFileEvent = (workspaceId: string, input: { type: "write" | "delete" | "rename" | "mkdir"; path: string; toPath?: string; revision?: string }) => {
    return fileSessions.recordWorkspaceEvent({ workspaceId, ...input });
  };

  addRoute(routes, "GET", "/health", "none", async () => {
    return jsonResponse({ ok: true, version: SERVER_VERSION, uptimeMs: Date.now() - config.startedAt });
  });

  addRoute(routes, "GET", "/w/:id/health", "none", async () => {
    return jsonResponse({ ok: true, version: SERVER_VERSION, uptimeMs: Date.now() - config.startedAt });
  });

  addRoute(routes, "GET", "/ui", "none", async () => {
    if (!resolveToyUiEnabled()) {
      throw new ApiError(404, "ui_disabled", "Toy UI is disabled");
    }
    return htmlResponse(TOY_UI_HTML);
  });

  addRoute(routes, "GET", "/w/:id/ui", "none", async () => {
    if (!resolveToyUiEnabled()) {
      throw new ApiError(404, "ui_disabled", "Toy UI is disabled");
    }
    return htmlResponse(TOY_UI_HTML);
  });

  addRoute(routes, "GET", "/ui/assets/toy.css", "none", async () => {
    if (!resolveToyUiEnabled()) {
      throw new ApiError(404, "ui_disabled", "Toy UI is disabled");
    }
    return cssResponse(TOY_UI_CSS);
  });

  addRoute(routes, "GET", "/ui/assets/toy.js", "none", async () => {
    if (!resolveToyUiEnabled()) {
      throw new ApiError(404, "ui_disabled", "Toy UI is disabled");
    }
    return jsResponse(TOY_UI_JS);
  });

  addRoute(routes, "GET", "/ui/assets/icon.png", "none", async () => {
    if (!resolveToyUiEnabled()) {
      throw new ApiError(404, "ui_disabled", "Toy UI is disabled");
    }
    return svgResponse(TOY_UI_FAVICON_SVG);
  });

  addRoute(routes, "GET", "/w/:id/status", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    return jsonResponse({
      ok: true,
      version: SERVER_VERSION,
      uptimeMs: Date.now() - config.startedAt,
      readOnly: config.readOnly,
      approval: config.approval,
      corsOrigins: config.corsOrigins,
      workspaceCount: 1,
      activeWorkspaceId: workspace.id,
      workspace: serializeWorkspace(workspace),
      authorizedRoots: config.authorizedRoots,
      server: {
        host: config.host,
        port: config.port,
        configPath: config.configPath ?? null,
      },
      tokenSource: {
        client: config.tokenSource,
        host: config.hostTokenSource,
      },
    });
  });

  addRoute(routes, "GET", "/w/:id/capabilities", "client", async () => {
    return jsonResponse(buildCapabilities(config));
  });

  addRoute(routes, "GET", "/w/:id/workspaces", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    return jsonResponse({ items: [serializeWorkspace(workspace)], activeId: workspace.id });
  });

  addRoute(routes, "GET", "/status", "client", async () => {
    const active = config.workspaces[0];
    return jsonResponse({
      ok: true,
      version: SERVER_VERSION,
      uptimeMs: Date.now() - config.startedAt,
      readOnly: config.readOnly,
      approval: config.approval,
      corsOrigins: config.corsOrigins,
      workspaceCount: config.workspaces.length,
      activeWorkspaceId: active?.id ?? null,
      workspace: active ? serializeWorkspace(active) : null,
      authorizedRoots: config.authorizedRoots,
      server: {
        host: config.host,
        port: config.port,
        configPath: config.configPath ?? null,
      },
      tokenSource: {
        client: config.tokenSource,
        host: config.hostTokenSource,
      },
    });
  });

  // ── /v1/runtime/status ────────────────────────────────────────────────────
  // SuperClaw one-month visibility lane: aggregate sidecar health into a single
  // user-visible slice. Shape: ServerRuntimeSlices from
  // apps/ui/src/app/lib/runtime-view.ts. Each sidecar probe runs in
  // parallel with a short timeout; a failed probe yields {healthy:false,error}
  // and never fails the whole endpoint.
  addRoute(routes, "GET", "/v1/runtime/status", "client", async () => {
    // Neither LLMRouter nor the connected edge model is probed here — both are
    // Windows-host concerns owned by the ServiceHub-managed `llmrouter_manager`
    // (which holds the edge config + endpoint), and the app sources their health
    // from ServiceHub directly (see
    // apps/ui/src/app/lib/use-runtime-status.ts::fetchBackendManager). Probing
    // them from here would be redundant, and the host manager's health lives at
    // /llm-router/v1/health, not /health.
    const opencodeRouter = await probeOpencodeRouterSlice();
    const body: {
      server: { healthy: boolean; uptime_seconds?: number; version?: string; error?: string };
      opencode_router: typeof opencodeRouter;
    } = {
      server: {
        healthy: true,
        uptime_seconds: Math.max(0, Math.floor((Date.now() - config.startedAt) / 1000)),
        version: SERVER_VERSION,
      },
      opencode_router: opencodeRouter,
    };
    return jsonResponse(body);
  });

  // ── /v1/runtime/opencode-telemetry ───────────────────────────────────────
  // Telemetry ingest endpoint for OpenCode plugins.
  // Accepts either a single event or {events:[...]} batches, normalizes missing
  // source to local_ingest, and fans the sanitized payloads into the server's
  // local metrics pipeline without exposing this surface when all gates are off.
  // Admission is gated on the export pipeline (any gate); per-event tier gates
  // downstream decide what actually exports, so `accepted` counts admitted
  // events, not exported ones (e.g. a full-telemetry event under baseline-only
  // is admitted here but dropped by recordMetricEvent's full-telemetry gate).
  addRoute(routes, "POST", "/v1/runtime/opencode-telemetry", "telemetry", async (ctx) => {
    if (!isMetricsExportEnabled()) {
      throw new ApiError(404, "not_found", "metrics export disabled");
    }
    const body = await readJsonBody(ctx.request);
    const items = Array.isArray(body)
      ? body
      : Array.isArray((body as { events?: unknown })?.events)
        ? ((body as { events: unknown[] }).events)
        : [body];
    let accepted = 0;
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      if (typeof (item as RuntimeTelemetryEvent).event_name !== "string") continue;
      accepted += 1;
      recordRuntimeMetricEvent({
        ...(item as RuntimeTelemetryEvent),
        source:
          typeof (item as RuntimeTelemetryEvent).source === "string"
            ? (item as RuntimeTelemetryEvent).source
            : "local_ingest",
      });
    }
    return jsonResponse({ status: "ok", accepted });
  });

  // ── /v1/debug/intent ──────────────────────────────────────────────────────
  // The "intent" stage of the trajectory chain: a thin proxy to the intent
  // classifier's /debug/intent ring buffer, same flag gate and redaction
  // contract as /v1/debug/traces (length + sha join key only, no raw prompts).
  // The classifier receives the real opencode session_id, so its records
  // correlate to turns directly.
  addRoute(routes, "GET", "/v1/debug/intent", "client", async () => {
    if (!isDebugObservabilityEnabled()) {
      throw new ApiError(404, "not_found", "debug observability disabled");
    }
    const proxied = await fetchIntentTracesFromClassifier();
    return jsonResponse(proxied.body, proxied.status);
  });

  addRoute(routes, "GET", "/runtime/versions", "client", async () => {
    const snapshot = await fetchRuntimeControl("/runtime/versions");
    return jsonResponse(snapshot);
  });

  addRoute(routes, "POST", "/runtime/upgrade", "host", async (ctx) => {
    const body = await readJsonBody(ctx.request);
    const result = await fetchRuntimeControl("/runtime/upgrade", { method: "POST", body });
    return jsonResponse(result, 202);
  });

  for (const path of ["/runtime/profile", "/runtime/instance"] as const) {
    addRoute(routes, "GET", path, "host", async () => {
      const result = await fetchRuntimeControlResponse(path);
      return jsonResponse(result.body, result.status);
    });
  }

  addRoute(routes, "GET", "/w/:id/runtime/versions", "client", async () => {
    const snapshot = await fetchRuntimeControl("/runtime/versions");
    return jsonResponse(snapshot);
  });

  addRoute(routes, "POST", "/w/:id/runtime/upgrade", "host", async (ctx) => {
    const body = await readJsonBody(ctx.request);
    const result = await fetchRuntimeControl("/runtime/upgrade", { method: "POST", body });
    return jsonResponse(result, 202);
  });

  addRoute(routes, "GET", "/v1/edge-model", "client", async () => {
    const result = await fetchRuntimeControl("/v1/edge-model");
    return jsonResponse(result);
  });

  addRoute(routes, "POST", "/v1/edge-model", "client", async (ctx) => {
    const body = await readJsonBody(ctx.request);
    const result = await fetchRuntimeControl("/v1/edge-model", { method: "POST", body });
    return jsonResponse(result, 202);
  });

  addRoute(routes, "POST", "/v1/edge-model/validate", "client", async (ctx) => {
    const body = await readJsonBody(ctx.request);
    const result = await fetchRuntimeControl("/v1/edge-model/validate", { method: "POST", body });
    return jsonResponse(result);
  });

  addRoute(routes, "DELETE", "/v1/edge-model", "client", async () => {
    const result = await fetchRuntimeControl("/v1/edge-model", { method: "DELETE" });
    return jsonResponse(result, 202);
  });

  addRoute(routes, "GET", "/whoami", "client", async (ctx) => {
    return jsonResponse({ ok: true, actor: ctx.actor ?? null });
  });

  addRoute(routes, "GET", "/capabilities", "client", async () => {
    return jsonResponse(buildCapabilities(config));
  });

  addRoute(routes, "GET", "/workspaces", "client", async () => {
    const active = config.workspaces[0] ?? null;
    const items = config.workspaces.map(serializeWorkspace);
    return jsonResponse({ items, activeId: active?.id ?? null });
  });

  addRoute(routes, "GET", "/tokens", "host", async () => {
    const items = await tokens.list();
    return jsonResponse({ items });
  });

  addRoute(routes, "POST", "/tokens", "host", async (ctx) => {
    ensureWritable(config);
    const body = await readJsonBody(ctx.request);
    const scopeRaw = typeof body.scope === "string" ? body.scope.trim() : "";
    const scope = scopeRaw === "owner" || scopeRaw === "collaborator" || scopeRaw === "viewer" ? scopeRaw : null;
    if (!scope) {
      throw new ApiError(400, "invalid_scope", "Token scope must be owner, collaborator, or viewer");
    }
    const label = typeof body.label === "string" ? body.label.trim() : undefined;
    const issued = await tokens.create(scope, { label });
    return jsonResponse(issued, 201);
  });

  addRoute(routes, "DELETE", "/tokens/:id", "host", async (ctx) => {
    ensureWritable(config);
    const ok = await tokens.revoke(ctx.params.id);
    if (!ok) {
      throw new ApiError(404, "token_not_found", "Token not found");
    }
    return jsonResponse({ ok: true });
  });

  addRoute(routes, "POST", "/workspaces/:id/activate", "host", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    config.workspaces = [
      workspace,
      ...config.workspaces.filter((entry) => entry.id !== workspace.id),
    ];
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "host" },
      action: "workspace.activate",
      target: "workspace",
      summary: "Switched active workspace",
      timestamp: Date.now(),
    });
    return jsonResponse({ activeId: workspace.id, workspace: serializeWorkspace(workspace) });
  });

  addRoute(routes, "DELETE", "/workspaces/:id", "host", async (ctx) => {
    ensureWritable(config);

    const workspace = await resolveWorkspace(config, ctx.params.id);

    // Attempt to persist to server.json (when present) before mutating in-memory state.
    const configPath = config.configPath?.trim() ?? "";
    const persisted = configPath
      ? await persistWorkspaceDeletion(configPath, workspace.id, workspace.path)
      : false;

    const before = config.workspaces.length;
    config.workspaces = config.workspaces.filter((entry) => entry.id !== workspace.id);
    const deleted = before !== config.workspaces.length;

    if (deleted) {
      // Only remove exact matches; authorizedRoots can contain broader entries.
      config.authorizedRoots = config.authorizedRoots.filter((root) => resolve(root) !== resolve(workspace.path));
    }

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "host" },
      action: "workspace.delete",
      target: "workspace",
      summary: "Deleted workspace from OpenWork server",
      timestamp: Date.now(),
    });

    const active = config.workspaces[0] ?? null;
    return jsonResponse({
      ok: true,
      deleted,
      persisted,
      activeId: active?.id ?? null,
      items: config.workspaces.map(serializeWorkspace),
    });
  });

  addRoute(routes, "GET", "/workspace/:id/config", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const opencode = await readOpencodeConfig(workspace.path);
    const openwork = await readOpenworkConfig(workspace.path);
    const lastAudit = await readLastAudit(workspace.path, workspace.id);
    return jsonResponse({ opencode, openwork, updatedAt: lastAudit?.timestamp ?? null });
  });

  addRoute(routes, "GET", "/workspace/:id/runtime-settings", "client", async (ctx) => {
    await resolveWorkspace(config, ctx.params.id);
    const settings = await readSuperclawRuntimeSettings();
    return jsonResponse(serializeSuperclawRuntimeSettings(settings));
  });

  addRoute(routes, "GET", "/workspace/:id/audit", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const limitParam = ctx.url.searchParams.get("limit");
    const parsed = limitParam ? Number(limitParam) : NaN;
    const limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 200) : 50;
    const items = await readAuditEntries(workspace.path, workspace.id, limit);
    return jsonResponse({ items });
  });

  addRoute(routes, "DELETE", "/workspace/:id/sessions/:sessionId", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");

    const workspace = await resolveWorkspace(config, ctx.params.id);
    const sessionId = (ctx.params.sessionId ?? "").trim();
    if (!sessionId) {
      throw new ApiError(400, "invalid_payload", "sessionId is required");
    }

    // OpenCode session deletion via the upstream API.
    await fetchOpencodeJson(workspace, `/session/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
    });

    return jsonResponse({ ok: true });
  });

  addRoute(routes, "PATCH", "/workspace/:id/config", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = ConfigPatchRequestSchema.safeParse(await readJsonBody(ctx.request));
    if (!body.success) {
      const details: ConfigPatchIssueDetail[] = [];
      for (const issue of body.error.issues) collectConfigPatchIssueDetails(issue, [], details);
      throw new ApiError(400, "invalid_payload", "Invalid config patch request", details);
    }
    const { opencode, openwork } = body.data;
    await gateOpencodeConfigMcp(opencode);

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "config.patch",
      summary: "Patch workspace config",
      paths: [opencode ? opencodeConfigPath(workspace.path) : null, openwork ? openworkConfigPath(workspace.path) : null].filter(Boolean) as string[],
    });

    if (opencode) {
      await updateJsoncTopLevel(opencodeConfigPath(workspace.path), opencode);
    }
    if (openwork) {
      await writeOpenworkConfig(workspace.path, openwork, true);
    }

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "config.patch",
      target: "opencode.json",
      summary: "Patched workspace config",
      timestamp: Date.now(),
    });

    if (opencode) {
      emitReloadEvent(ctx.reloadEvents, workspace, "config", buildConfigTrigger(opencodeConfigPath(workspace.path)));
    }

    return jsonResponse({ updatedAt: Date.now() });
  });

  addRoute(routes, "PATCH", "/workspace/:id/runtime-settings", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const path = superclawRuntimeSettingsPath();

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "runtime-settings.patch",
      summary: "Patch SuperClaw runtime settings",
      paths: [path],
    });

    const settings = await patchSuperclawRuntimeSettings(
      body,
      (message) => new ApiError(400, "invalid_payload", message),
    );

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "runtime-settings.patch",
      target: SUPERCLAW_RUNTIME_SETTINGS_FILE,
      summary: "Patched SuperClaw runtime settings",
      timestamp: Date.now(),
    });

    return jsonResponse(serializeSuperclawRuntimeSettings(settings));
  });

  registerGithubRoutes(routes, config, {
    addRoute,
    ensureWritable,
    jsonResponse,
    readJsonBody,
    requireApproval,
    requireClientScope,
    resolveWorkspace,
  });

  registerMaskedReviewRoutes(routes, config, {
    addRoute,
    ensureWritable,
    jsonResponse,
    readJsonBody,
    requireClientScope,
    resolveWorkspace,
  });

  // Identities are listed from the running router and never from its configuration file: the file holds
  // the channel tokens, lives in the channel tier's data directory, and this process (the file_tool tier,
  // which runs the agent) cannot read it. Saving and deleting an identity are the host's routes now
  // (`/sandbox-manager/v1/channels`), reached by the app through ServiceHub.
  const listRouterIdentities = async (ctx: RequestContext, channel: "telegram" | "slack") => {
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const workspaceIdentityId = normalizeOpenCodeRouterIdentityId(workspace.id);
    const result = await tryFetchOpenCodeRouterHealth("GET", `/identities/${channel}`, {
      port: resolveOpenCodeRouterHealthPort(),
      requestHost: ctx.url.hostname,
      timeoutMs: 2_000,
    });
    const payload = result.applied ? ensurePlainObject(result.body) : null;
    const rawItems = payload ? payload.items : undefined;
    if (!payload || !Array.isArray(rawItems)) {
      throw new ApiError(503, "opencodeRouter_unreachable", "OpenCodeRouter is not reachable on this host", {
        port: result.port,
        status: result.status,
      });
    }
    const items = rawItems
      .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object" && !Array.isArray(entry)))
      .map((entry) => {
        const id = normalizeOpenCodeRouterIdentityId(entry.id);
        const enabled = entry.enabled === undefined ? true : entry.enabled === true || entry.enabled === "true";
        const running = entry.running === true || entry.running === "true";
        if (channel === "slack") return { id, enabled, running };
        const access = normalizeTelegramAccessMode(
          entry.access,
          entry.pairingRequired === true || entry.pairingRequired === "true" ? "private" : "public",
        );
        const bot = ensurePlainObject(entry.bot);
        return {
          id,
          enabled,
          running,
          access,
          pairingRequired: access === "private",
          ...(typeof bot.id === "number"
            ? {
                bot: {
                  id: bot.id,
                  ...(typeof bot.username === "string" ? { username: bot.username } : {}),
                  ...(typeof bot.name === "string" ? { name: bot.name } : {}),
                },
              }
            : {}),
        };
      })
      .filter((item) => item.id === workspaceIdentityId);
    return jsonResponse({ ok: true, items });
  };

  addRoute(routes, "GET", "/workspace/:id/opencode-router/identities/telegram", "client", async (ctx) => {
    return await listRouterIdentities(ctx, "telegram");
  });

  addRoute(routes, "GET", "/workspace/:id/opencode-router/identities/slack", "client", async (ctx) => {
    return await listRouterIdentities(ctx, "slack");
  });

  addRoute(routes, "GET", "/workspace/:id/opencode-router/bindings", "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const workspaceIdentityId = normalizeOpenCodeRouterIdentityId(workspace.id);
    const healthPortParam = parseInteger(ctx.url.searchParams.get("healthPort") ?? undefined);
    const port = healthPortParam ?? resolveOpenCodeRouterHealthPort();
    const requestHost = ctx.url.hostname;

    const search = new URLSearchParams();
    const channel = (ctx.url.searchParams.get("channel") ?? "").trim();
    const identityIdParam = (ctx.url.searchParams.get("identityId") ?? "").trim();
    const requestedId = identityIdParam ? normalizeOpenCodeRouterIdentityId(identityIdParam) : "";
    if (requestedId && requestedId !== workspaceIdentityId) {
      throw new ApiError(
        400,
        "identity_mismatch",
        `Identity id is scoped to this workspace (${workspace.id}).`,
        { expected: workspaceIdentityId, received: requestedId },
      );
    }
    if (channel) search.set("channel", channel);
    search.set("identityId", workspaceIdentityId);
    const suffix = search.toString();
    const pathname = suffix ? `/bindings?${suffix}` : "/bindings";

    const apply = await tryFetchOpenCodeRouterHealth("GET", pathname, { port, requestHost, timeoutMs: 2_000 });
    if (apply.applied && apply.body && typeof apply.body === "object") {
      return jsonResponse(apply.body);
    }
    throw new ApiError(503, "opencodeRouter_unreachable", "OpenCodeRouter is not reachable on this host", {
      port,
      error: apply.error,
      status: apply.status,
    });
  });

  addRoute(routes, "POST", "/workspace/:id/opencode-router/send", "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const workspaceIdentityId = normalizeOpenCodeRouterIdentityId(workspace.id);
    const body = await readJsonBody(ctx.request);
    const channel = typeof body.channel === "string" ? body.channel.trim().toLowerCase() : "";
    const text = typeof body.text === "string" ? body.text : "";
    const file = typeof body.file === "string" ? body.file.trim() : "";
    const peerId = typeof body.peerId === "string" ? body.peerId.trim() : "";
    const autoBind = body.autoBind === true || body.autoBind === "true";
    const directoryInput = typeof body.directory === "string" ? body.directory.trim() : "";
    const directory = directoryInput || workspace.path;
    const healthPort = normalizeHealthPort(body.healthPort);
    const requestHost = ctx.url.hostname;

    const identityIdParam = typeof body.identityId === "string" ? body.identityId.trim() : "";
    const requestedId = identityIdParam ? normalizeOpenCodeRouterIdentityId(identityIdParam) : "";
    if (requestedId && requestedId !== workspaceIdentityId) {
      throw new ApiError(
        400,
        "identity_mismatch",
        `Identity id is scoped to this workspace (${workspace.id}).`,
        { expected: workspaceIdentityId, received: requestedId },
      );
    }
    const identityId = requestedId || undefined;

    if (channel !== "telegram" && channel !== "slack") {
      throw new ApiError(400, "invalid_channel", "channel must be 'telegram' or 'slack'");
    }
    if (!directory.trim() && !peerId) {
      throw new ApiError(400, "directory_required", "directory is required when peerId is not provided");
    }
    if (!text.trim() && !file) {
      throw new ApiError(400, "text_required", "text is required");
    }
    // The router cannot see the workspace: a file goes to it as a copy in the outbox, named by a relative path.
    const stagedName = file
      ? await stageOutboundFile({ workspacePath: workspace.path, file, outboxDir: process.env.OPENCODE_ROUTER_OUTBOX_DIR?.trim() })
      : undefined;

    const port = healthPort ?? resolveOpenCodeRouterHealthPort();
    const apply = await tryPostOpenCodeRouterHealth(
      "/send",
      {
        channel,
        ...(identityId ? { identityId } : {}),
        ...(directory.trim() ? { directory } : {}),
        ...(peerId ? { peerId } : {}),
        ...(autoBind ? { autoBind: true } : {}),
        ...(stagedName
          ? { parts: [...(text.trim() ? [{ type: "text", text }] : []), { type: "file", filePath: stagedName }] }
          : { text }),
      },
      // With the scoped token, a send to an unbound conversation is held by the router until the operator decides
      // (at most the approval lifetime). Outwait it so the caller gets the router's decision, never a timeout
      // for a send that may still go out.
      { port, requestHost, timeoutMs: EGRESS_APPROVAL_GRANT_RULES.max_lifetime_ms + ROUTER_SEND_TIMEOUT_MARGIN_MS },
    );

    if (!apply.applied) {
      const refusal = routerRefusal(apply);
      if (refusal) throw new ApiError(refusal.status, refusal.code, refusal.message);
      throw new ApiError(503, "opencodeRouter_unreachable", "OpenCodeRouter did not send the message", {
        port,
        error: apply.error,
        status: apply.status,
      });
    }

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "opencodeRouter.send",
      target: `opencodeRouter.${channel}`,
      summary: `Sent outbound ${channel} message${identityId ? ` for ${identityId}` : ""}${peerId ? ` to ${peerId}` : ""}`,
      timestamp: Date.now(),
    });

    if (apply.body && typeof apply.body === "object") {
      return jsonResponse(apply.body);
    }
    return jsonResponse({
      ok: true,
      channel,
      identityId,
      directory,
      attempted: 0,
      sent: 0,
    });
  });

  addRoute(routes, "GET", "/workspace/:id/events", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    void ctx;
    return jsonResponse({ items: [], cursor: 0, workspaceId: workspace.id, disabled: true });
  });

  addRoute(routes, "POST", "/workspace/:id/engine/reload", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    requireClientScope(ctx, "collaborator");

    await reloadOpencodeEngine(workspace);

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "engine.reload",
      target: workspace.baseUrl ?? "opencode",
      summary: "Reloaded workspace engine",
      timestamp: Date.now(),
    });

    return jsonResponse({ ok: true, reloadedAt: Date.now() });
  });

  addRoute(routes, "GET", "/workspace/:id/inbox", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    if (!resolveInboxEnabled()) {
      return jsonResponse({ items: [] });
    }
    const inboxRoot = resolveInboxDir(workspace.path);
    const items = await listInbox(inboxRoot);
    return jsonResponse({ items });
  });

  addRoute(routes, "GET", "/workspace/:id/inbox/:inboxId", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    if (!resolveInboxEnabled()) {
      throw new ApiError(404, "inbox_disabled", "Workspace inbox is disabled");
    }
    const inboxRoot = resolveInboxDir(workspace.path);
    const relativePath = decodeInboxId(ctx.params.inboxId);
    const absPath = resolveSafeChildPath(inboxRoot, relativePath);
    if (!(await exists(absPath))) {
      throw new ApiError(404, "inbox_item_not_found", "Inbox item not found");
    }
    const info = await stat(absPath);
    if (!info.isFile()) {
      throw new ApiError(404, "inbox_item_not_found", "Inbox item not found");
    }

    const headers = new Headers();
    headers.set("Content-Type", "application/octet-stream");
    headers.set("Content-Length", String(info.size));
    headers.set("Content-Disposition", `attachment; filename=\"${basename(relativePath)}\"`);
    return new Response((Bun as any).file(absPath), { status: 200, headers });
  });

  addRoute(routes, "POST", "/workspace/:id/inbox", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    if (!resolveInboxEnabled()) {
      throw new ApiError(404, "inbox_disabled", "Workspace inbox is disabled");
    }
    const workspace = await resolveWorkspace(config, ctx.params.id);

    const contentType = ctx.request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("multipart/form-data")) {
      throw new ApiError(400, "invalid_payload", "Expected multipart/form-data");
    }
    const form = await ctx.request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      throw new ApiError(400, "file_required", "Form field 'file' is required");
    }

    const queryPath = (ctx.url.searchParams.get("path") ?? "").trim();
    const formPath = typeof form.get("path") === "string" ? String(form.get("path") || "").trim() : "";
    const requestedPath = queryPath || formPath || file.name;

    const requestedRelativePath = normalizeWorkspaceRelativePath(requestedPath, { allowSubdirs: true });
    const inboxRoot = resolveInboxDir(workspace.path);
    const maxBytes = resolveInboxMaxBytes();
    if (file.size > maxBytes) {
      throw new ApiError(413, "file_too_large", "File exceeds upload limit", { maxBytes, size: file.size });
    }
    await ensureDir(inboxRoot);
    await ensureDir(dirname(resolveSafeChildPath(inboxRoot, requestedRelativePath)));
    let reserved = false;
    const relativePath = await reserveNextAvailableInboxPath(
      requestedRelativePath,
      async (path) => {
        const handle = await open(resolveSafeChildPath(inboxRoot, path), "wx");
        await handle.close();
        reserved = true;
      },
    );
    const dest = resolveSafeChildPath(inboxRoot, relativePath);

    try {
      await requireApproval(ctx, {
        workspaceId: workspace.id,
        action: "workspace.inbox.upload",
        summary: `Upload ${relativePath} to inbox`,
        paths: [dest],
      });

      await ensureDir(dirname(dest));
      const bytes = Buffer.from(await file.arrayBuffer());
      const tmp = `${dest}.tmp-${shortId()}`;
      await writeFile(tmp, bytes);
      await renameOverReservedPath(tmp, dest, rename);
    } catch (error) {
      if (reserved) await rm(dest, { force: true });
      throw error;
    }

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "workspace.inbox.upload",
      target: dest,
      summary: `Uploaded ${relativePath} to inbox`,
      timestamp: Date.now(),
    });

    return jsonResponse({ ok: true, path: relativePath, bytes: file.size });
  });

  addRoute(routes, "DELETE", "/workspace/:id/inbox/:inboxId", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    if (!resolveInboxEnabled()) {
      throw new ApiError(404, "inbox_disabled", "Workspace inbox is disabled");
    }
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const inboxRoot = resolveInboxDir(workspace.path);
    const relativePath = decodeInboxId(ctx.params.inboxId);
    const absPath = resolveSafeChildPath(inboxRoot, relativePath);
    if (!(await exists(absPath))) {
      throw new ApiError(404, "inbox_item_not_found", "Inbox item not found");
    }
    const info = await stat(absPath);
    if (!info.isFile()) {
      throw new ApiError(404, "inbox_item_not_found", "Inbox item not found");
    }
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "workspace.inbox.delete",
      summary: `Delete ${relativePath} from inbox`,
      paths: [absPath],
    });
    await rm(absPath);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "workspace.inbox.delete",
      target: absPath,
      summary: `Deleted ${relativePath} from inbox`,
      timestamp: Date.now(),
    });
    return jsonResponse({ ok: true, path: relativePath });
  });

  // ── Read inbox file content (for preview) ──
  addRoute(routes, "GET", "/workspace/:id/inbox/:inboxId/content", "client", async (ctx) => {
    if (!resolveInboxEnabled()) {
      throw new ApiError(404, "inbox_disabled", "Workspace inbox is disabled");
    }
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const inboxRoot = resolveInboxDir(workspace.path);
    const relativePath = decodeInboxId(ctx.params.inboxId);
    const absPath = resolveSafeChildPath(inboxRoot, relativePath);
    if (!(await exists(absPath))) {
      throw new ApiError(404, "inbox_item_not_found", "Inbox item not found");
    }
    const maxBytes = resolveInboxMaxBytes();
    const handle = await open(absPath, "r").catch(() => null);
    if (!handle) {
      throw new ApiError(404, "inbox_item_not_found", "Inbox item not found");
    }
    let raw: Buffer;
    try {
      const info = await handle.stat();
      if (!info.isFile()) {
        throw new ApiError(404, "inbox_item_not_found", "Inbox item not found");
      }
      if (info.size > maxBytes) {
        throw new ApiError(413, "file_too_large", "File exceeds preview limit", { maxBytes, size: info.size });
      }
      const buffer = Buffer.alloc(maxBytes + 1);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
        if (result.bytesRead === 0) break;
        bytesRead += result.bytesRead;
      }
      if (bytesRead > maxBytes) {
        throw new ApiError(413, "file_too_large", "File exceeds preview limit", { maxBytes, size: bytesRead });
      }
      raw = buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
    const contentBase64 = raw.toString("base64");
    return jsonResponse({ ok: true, path: relativePath, contentBase64 });
  });

  // ── Office → PDF preview (inbox) ──
  addRoute(routes, "GET", "/workspace/:id/inbox/:inboxId/preview-pdf", "client", async (ctx) => {
    if (!resolveInboxEnabled()) {
      throw new ApiError(404, "inbox_disabled", "Workspace inbox is disabled");
    }
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const inboxRoot = resolveInboxDir(workspace.path);
    const relativePath = decodeInboxId(ctx.params.inboxId);
    const absPath = resolveSafeChildPath(inboxRoot, relativePath);
    if (!(await exists(absPath))) {
      throw new ApiError(404, "inbox_item_not_found", "Inbox item not found");
    }
    const info = await stat(absPath);
    if (!info.isFile()) {
      throw new ApiError(404, "inbox_item_not_found", "Inbox item not found");
    }
    if (!isOfficePreviewFile(relativePath)) {
      throw new ApiError(400, "unsupported_preview_type", "File type is not supported for PDF preview");
    }
    if (info.size > OFFICE_PREVIEW_MAX_BYTES) {
      throw new ApiError(413, "file_too_large", "File is too large to preview");
    }
    const contentBase64 = await convertOfficeToPdfBase64(absPath, logger);
    return jsonResponse({ ok: true, path: relativePath, contentBase64 });
  });

  // ── Projects listing (host-mounted SuperClawProjects) ──────────────────
  addRoute(routes, "GET", "/workspace/:id/projects", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const projectsRoot = resolveProjectsRoot(workspace.path);
    if (!projectsRoot) {
      return jsonResponse({ items: [] });
    }
    const items = await listArtifacts(projectsRoot);
    // Return items with kind information (files + dirs) for tree display
    const enriched = items.map((item) => ({
      ...item,
      name: basename(item.path),
    }));
    return jsonResponse({ items: enriched });
  });

  addRoute(routes, "DELETE", "/workspace/:id/workspace/:itemId", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const projectsRoot = resolveProjectsRoot(workspace.path);
    if (!projectsRoot) {
      throw new ApiError(404, "projects_disabled", "Projects directory is not configured");
    }
    const relativePath = decodeArtifactId(ctx.params.itemId);
    const absPath = resolveSafeChildPath(projectsRoot, relativePath);
    if (!(await exists(absPath))) {
      throw new ApiError(404, "project_item_not_found", "Project file not found");
    }
    const info = await stat(absPath);
    const isDir = info.isDirectory();
    await rm(absPath, { recursive: true });
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "workspace.projects.delete",
      target: absPath,
      summary: `Deleted ${isDir ? "directory" : "file"} ${relativePath} from projects`,
      timestamp: Date.now(),
    });
    return jsonResponse({ ok: true, path: relativePath });
  });

  // ── Read project file content (for preview) ──
  addRoute(routes, "GET", "/workspace/:id/workspace/:itemId/content", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const projectsRoot = resolveProjectsRoot(workspace.path);
    if (!projectsRoot) {
      throw new ApiError(404, "projects_disabled", "Projects directory is not configured");
    }
    const relativePath = decodeArtifactId(ctx.params.itemId);
    const openFlags = process.platform === "win32"
      ? "r"
      : constants.O_RDONLY | constants.O_NONBLOCK;
    let absPath: string;
    let handle;
    try {
      absPath = resolveSafeChildPath(projectsRoot, relativePath);
      handle = await open(absPath, openFlags);
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.code === "path_access_denied") {
          throw new ApiError(403, "project_item_access_denied", "Permission denied reading project file");
        }
        throw error;
      }
      const code = typeof error === "object" && error !== null && "code" in error
        ? error.code
        : undefined;
      if (code === "ENOENT" || code === "ENOTDIR") {
        throw new ApiError(404, "project_item_not_found", "Project file not found");
      }
      if (code === "EACCES" || code === "EPERM") {
        throw new ApiError(403, "project_item_access_denied", "Permission denied reading project file");
      }
      throw new ApiError(500, "project_item_read_failed", "Failed to open project file");
    }
    let raw: Buffer;
    try {
      const info = await handle.stat();
      if (!info.isFile()) {
        throw new ApiError(404, "project_item_not_found", "Project file not found");
      }
      if (info.size > PROJECT_CONTENT_MAX_BYTES) {
        throw new ApiError(413, "file_too_large", "File exceeds project content limit", {
          maxBytes: PROJECT_CONTENT_MAX_BYTES,
          size: info.size,
        });
      }
      let buffer = Buffer.alloc(info.size + 1);
      let bytesRead = 0;
      while (true) {
        if (bytesRead === buffer.length) {
          if (buffer.length === PROJECT_CONTENT_MAX_BYTES + 1) break;
          const nextLength = Math.min(
            Math.max(buffer.length * 2, bytesRead + 1),
            PROJECT_CONTENT_MAX_BYTES + 1,
          );
          const expanded = Buffer.alloc(nextLength);
          buffer.copy(expanded, 0, 0, bytesRead);
          buffer = expanded;
        }
        const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
        if (result.bytesRead === 0) break;
        bytesRead += result.bytesRead;
      }
      if (bytesRead > PROJECT_CONTENT_MAX_BYTES) {
        throw new ApiError(413, "file_too_large", "File exceeds project content limit", {
          maxBytes: PROJECT_CONTENT_MAX_BYTES,
          size: bytesRead,
        });
      }
      raw = buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
    let contentBase64: string;
    if (isRestorableProtectedFile(relativePath)) {
      let restored: string;
      try {
        restored = await restoreProtectedFileText(
          workspace,
          raw.toString("utf8"),
          absPath,
          undefined,
          PROJECT_CONTENT_MAX_BYTES,
        );
      } catch (error) {
        if (error instanceof ProtectedFileContentTooLargeError) {
          throw new ApiError(413, "file_too_large", "File exceeds project content limit", {
            maxBytes: error.maxBytes,
            size: error.size,
          });
        }
        throw error;
      }
      const restoredBytes = Buffer.byteLength(restored, "utf8");
      if (restoredBytes > PROJECT_CONTENT_MAX_BYTES) {
        throw new ApiError(413, "file_too_large", "File exceeds project content limit", {
          maxBytes: PROJECT_CONTENT_MAX_BYTES,
          size: restoredBytes,
        });
      }
      contentBase64 = Buffer.from(restored, "utf8").toString("base64");
    } else {
      contentBase64 = raw.toString("base64");
    }
    return jsonResponse({ ok: true, path: relativePath, contentBase64 });
  });

  // ── Office → PDF preview (project) ──
  addRoute(routes, "GET", "/workspace/:id/workspace/:itemId/preview-pdf", "client", async (ctx) => {
    // Validate the workspace exists (throws 404 otherwise); the value itself is
    // not needed since projects live under SUPERCLAW_PATH, not the workspace.
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const projectsRoot = resolveProjectsRoot(workspace.path);
    if (!projectsRoot) {
      throw new ApiError(404, "projects_disabled", "Projects directory is not configured");
    }
    const relativePath = decodeArtifactId(ctx.params.itemId);
    const absPath = resolveSafeChildPath(projectsRoot, relativePath);
    if (!(await exists(absPath))) {
      throw new ApiError(404, "project_item_not_found", "Project file not found");
    }
    const info = await stat(absPath);
    if (!info.isFile()) {
      throw new ApiError(404, "project_item_not_found", "Project file not found");
    }
    if (!isOfficePreviewFile(relativePath)) {
      throw new ApiError(400, "unsupported_preview_type", "File type is not supported for PDF preview");
    }
    if (info.size > OFFICE_PREVIEW_MAX_BYTES) {
      throw new ApiError(413, "file_too_large", "File is too large to preview");
    }
    const contentBase64 = await convertOfficeToPdfBase64(absPath, logger);
    return jsonResponse({ ok: true, path: relativePath, contentBase64 });
  });

  addRoute(routes, "GET", "/workspace/:id/artifacts", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    if (!resolveOutboxEnabled()) {
      return jsonResponse({ items: [] });
    }
    const outboxRoot = resolveOutboxDir(workspace.path);
    const items = await listArtifacts(outboxRoot);
    return jsonResponse({ items });
  });

  addRoute(routes, "GET", "/workspace/:id/artifacts/:artifactId", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    if (!resolveOutboxEnabled()) {
      throw new ApiError(404, "outbox_disabled", "Workspace outbox is disabled");
    }
    const outboxRoot = resolveOutboxDir(workspace.path);
    const relativePath = decodeArtifactId(ctx.params.artifactId);
    const absPath = resolveSafeChildPath(outboxRoot, relativePath, workspace.path);
    if (!(await exists(absPath))) {
      throw new ApiError(404, "artifact_not_found", "Artifact not found");
    }
    const info = await stat(absPath);
    if (!info.isFile()) {
      throw new ApiError(404, "artifact_not_found", "Artifact not found");
    }

    const headers = new Headers();
    headers.set("Content-Type", "application/octet-stream");
    headers.set("Content-Length", String(info.size));
    headers.set("Content-Disposition", `attachment; filename="${basename(relativePath)}"`);
    return new Response((Bun as any).file(absPath), { status: 200, headers });
  });

  addRoute(routes, "POST", "/workspace/:id/files/sessions", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const ttlMs = parseFileSessionTtlMs((body as Record<string, unknown>).ttlSeconds);
    const requestWrite = (body as Record<string, unknown>).write !== false;
    const canWrite =
      requestWrite &&
      !config.readOnly &&
      scopeRank(ctx.actor?.scope ?? "viewer") >= scopeRank("collaborator");

    const session = fileSessions.create({
      workspaceId: workspace.id,
      workspaceRoot: workspace.path,
      actorTokenHash: ctx.actor?.tokenHash ?? "",
      actorScope: ctx.actor?.scope ?? "viewer",
      canWrite,
      ttlMs,
    });

    return jsonResponse({ session: serializeFileSession(session) });
  });

  addRoute(routes, "POST", "/files/sessions/:sessionId/renew", "client", async (ctx) => {
    const body = await readJsonBody(ctx.request);
    const ttlMs = parseFileSessionTtlMs((body as Record<string, unknown>).ttlSeconds);
    const { session } = resolveFileSession(ctx, ctx.params.sessionId);
    const renewed = fileSessions.renew(session.id, ttlMs);
    if (!renewed) {
      throw new ApiError(404, "file_session_not_found", "File session not found");
    }
    return jsonResponse({ session: serializeFileSession(renewed) });
  });

  addRoute(routes, "DELETE", "/files/sessions/:sessionId", "client", async (ctx) => {
    const { session } = resolveFileSession(ctx, ctx.params.sessionId);
    fileSessions.close(session.id);
    return jsonResponse({ ok: true });
  });

  addRoute(routes, "GET", "/files/sessions/:sessionId/catalog/snapshot", "client", async (ctx) => {
    const { workspace } = resolveFileSession(ctx, ctx.params.sessionId);
    const prefix = parseCatalogPathFilter(ctx.url.searchParams.get("prefix"));
    const after = parseCatalogPathFilter(ctx.url.searchParams.get("after"));
    const includeDirs = ctx.url.searchParams.get("includeDirs") !== "false";
    const limit = parseCatalogLimit(ctx.url.searchParams.get("limit"));

    const entries = await listWorkspaceCatalogEntries(workspace.path);
    const filtered = entries.filter((entry) => {
      if (!includeDirs && entry.kind === "dir") return false;
      if (!matchesCatalogFilter(entry.path, prefix)) return false;
      if (after && entry.path <= after) return false;
      return true;
    });

    const items = filtered.slice(0, limit);
    const truncated = filtered.length > items.length;
    const nextAfter = truncated ? items[items.length - 1]?.path : undefined;
    const events = fileSessions.listWorkspaceEvents(workspace.id, Number.MAX_SAFE_INTEGER);

    return jsonResponse({
      sessionId: ctx.params.sessionId,
      workspaceId: workspace.id,
      generatedAt: Date.now(),
      cursor: events.cursor,
      total: filtered.length,
      truncated,
      nextAfter,
      items,
    });
  });

  addRoute(routes, "GET", "/files/sessions/:sessionId/catalog/events", "client", async (ctx) => {
    const { workspace } = resolveFileSession(ctx, ctx.params.sessionId);
    const since = parseSessionCursor(ctx.url.searchParams.get("since"));
    const events = fileSessions.listWorkspaceEvents(workspace.id, since);
    return jsonResponse(events);
  });

  addRoute(routes, "POST", "/files/sessions/:sessionId/read-batch", "client", async (ctx) => {
    const { workspace } = resolveFileSession(ctx, ctx.params.sessionId);
    const body = await readJsonBody(ctx.request);
    const paths = parseBatchPathList((body as Record<string, unknown>).paths);
    const items: Array<Record<string, unknown>> = [];

    for (const relativePath of paths) {
      try {
        const absPath = resolveSafeChildPath(workspace.path, relativePath);
        if (!(await exists(absPath))) {
          items.push({ ok: false, path: relativePath, code: "file_not_found", message: "File not found" });
          continue;
        }
        const info = await stat(absPath);
        if (!info.isFile()) {
          items.push({ ok: false, path: relativePath, code: "file_not_found", message: "File not found" });
          continue;
        }
        if (info.size > FILE_SESSION_MAX_FILE_BYTES) {
          items.push({
            ok: false,
            path: relativePath,
            code: "file_too_large",
            message: "File exceeds size limit",
            maxBytes: FILE_SESSION_MAX_FILE_BYTES,
            size: info.size,
          });
          continue;
        }

        const content = await readFile(absPath);
        items.push({
          ok: true,
          path: relativePath,
          kind: "file",
          bytes: info.size,
          updatedAt: info.mtimeMs,
          revision: fileRevision(info),
          contentBase64: content.toString("base64"),
        });
      } catch (error) {
        const message = error instanceof ApiError ? error.message : "Unable to read file";
        const code = error instanceof ApiError ? error.code : "read_failed";
        items.push({ ok: false, path: relativePath, code, message });
      }
    }

    return jsonResponse({ items });
  });

  addRoute(routes, "POST", "/files/sessions/:sessionId/write-batch", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const { session, workspace } = resolveFileSession(ctx, ctx.params.sessionId);
    if (!session.canWrite) {
      throw new ApiError(403, "forbidden", "File session is read-only");
    }

    const body = await readJsonBody(ctx.request);
    const writes = parseBatchWriteList((body as Record<string, unknown>).writes);
    const items: Array<Record<string, unknown>> = [];

    const plan: Array<{
      path: string;
      absPath: string;
      bytes: Buffer;
      ifMatchRevision?: string;
      force?: boolean;
      beforeRevision: string | null;
    }> = [];

    for (const write of writes) {
      try {
        const absPath = resolveSafeChildPath(workspace.path, write.path);
        const bytes = Buffer.from(write.contentBase64, "base64");
        if (bytes.byteLength > FILE_SESSION_MAX_FILE_BYTES) {
          items.push({
            ok: false,
            path: write.path,
            code: "file_too_large",
            message: "File exceeds size limit",
            maxBytes: FILE_SESSION_MAX_FILE_BYTES,
            size: bytes.byteLength,
          });
          continue;
        }

        const before = (await exists(absPath)) ? await stat(absPath) : null;
        if (before && !before.isFile()) {
          items.push({ ok: false, path: write.path, code: "invalid_path", message: "Path must point to a file" });
          continue;
        }
        const beforeRevision = before ? fileRevision(before) : null;
        if (!write.force && write.ifMatchRevision && write.ifMatchRevision !== beforeRevision) {
          items.push({
            ok: false,
            path: write.path,
            code: "conflict",
            message: "File changed since it was loaded",
            expectedRevision: write.ifMatchRevision,
            currentRevision: beforeRevision,
          });
          continue;
        }

        plan.push({
          path: write.path,
          absPath,
          bytes,
          beforeRevision,
          ...(write.ifMatchRevision ? { ifMatchRevision: write.ifMatchRevision } : {}),
          ...(write.force ? { force: true } : {}),
        });
      } catch (error) {
        const message = error instanceof ApiError ? error.message : "Invalid write request";
        const code = error instanceof ApiError ? error.code : "invalid_payload";
        items.push({ ok: false, path: write.path, code, message });
      }
    }

    if (plan.length) {
      await requireApproval(ctx, {
        workspaceId: workspace.id,
        action: "workspace.files.session.write",
        summary: `Write ${plan.length} file(s) via file session`,
        paths: plan.map((item) => item.absPath),
      });
    }

    for (const entry of plan) {
      try {
        const before = (await exists(entry.absPath)) ? await stat(entry.absPath) : null;
        const currentRevision = before ? fileRevision(before) : null;
        if (!entry.force && entry.ifMatchRevision && currentRevision !== entry.ifMatchRevision) {
          items.push({
            ok: false,
            path: entry.path,
            code: "conflict",
            message: "File changed before write could be applied",
            expectedRevision: entry.ifMatchRevision,
            currentRevision,
          });
          continue;
        }

        await ensureDir(dirname(entry.absPath));
        const tmp = `${entry.absPath}.tmp-${shortId()}`;
        await writeFile(tmp, entry.bytes);
        await rename(tmp, entry.absPath);
        const after = await stat(entry.absPath);
        const revision = fileRevision(after);

        recordWorkspaceFileEvent(workspace.id, { type: "write", path: entry.path, revision });

        await recordAudit(workspace.path, {
          id: shortId(),
          workspaceId: workspace.id,
          actor: ctx.actor ?? { type: "remote" },
          action: "workspace.files.session.write",
          target: entry.absPath,
          summary: `Wrote ${entry.path} via file session`,
          timestamp: Date.now(),
        });

        items.push({
          ok: true,
          path: entry.path,
          bytes: entry.bytes.byteLength,
          updatedAt: after.mtimeMs,
          revision,
          previousRevision: entry.beforeRevision,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to write file";
        items.push({ ok: false, path: entry.path, code: "write_failed", message });
      }
    }

    const events = fileSessions.listWorkspaceEvents(workspace.id, Number.MAX_SAFE_INTEGER);
    return jsonResponse({ items, cursor: events.cursor });
  });

  addRoute(routes, "POST", "/files/sessions/:sessionId/ops", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const { session, workspace } = resolveFileSession(ctx, ctx.params.sessionId);
    if (!session.canWrite) {
      throw new ApiError(403, "forbidden", "File session is read-only");
    }

    const body = await readJsonBody(ctx.request);
    const operations = Array.isArray((body as Record<string, unknown>).operations)
      ? ((body as Record<string, unknown>).operations as Array<Record<string, unknown>>)
      : null;
    if (!operations || !operations.length) {
      throw new ApiError(400, "invalid_payload", "operations must be a non-empty array");
    }
    if (operations.length > FILE_SESSION_MAX_BATCH_ITEMS) {
      throw new ApiError(400, "invalid_payload", `operations must include <= ${FILE_SESSION_MAX_BATCH_ITEMS} items`);
    }

    const items: Array<Record<string, unknown>> = [];
    const approvalPaths: string[] = [];
    for (const op of operations) {
      if (typeof op?.path === "string" && op.path.trim()) {
        approvalPaths.push(resolveSafeChildPath(workspace.path, normalizeWorkspaceRelativePath(op.path, { allowSubdirs: true })));
      }
      if (typeof op?.from === "string" && op.from.trim()) {
        approvalPaths.push(resolveSafeChildPath(workspace.path, normalizeWorkspaceRelativePath(op.from, { allowSubdirs: true })));
      }
      if (typeof op?.to === "string" && op.to.trim()) {
        approvalPaths.push(resolveSafeChildPath(workspace.path, normalizeWorkspaceRelativePath(op.to, { allowSubdirs: true })));
      }
    }

    if (approvalPaths.length) {
      await requireApproval(ctx, {
        workspaceId: workspace.id,
        action: "workspace.files.session.ops",
        summary: `Apply ${operations.length} file operation(s) via file session`,
        paths: approvalPaths,
      });
    }

    for (const op of operations) {
      const type = String(op.type ?? "").trim();
      try {
        if (type === "mkdir") {
          const path = normalizeWorkspaceRelativePath(String(op.path ?? ""), { allowSubdirs: true });
          const absPath = resolveSafeChildPath(workspace.path, path);
          await ensureDir(absPath);
          recordWorkspaceFileEvent(workspace.id, { type: "mkdir", path });
          items.push({ ok: true, type, path });
          continue;
        }

        if (type === "delete") {
          const path = normalizeWorkspaceRelativePath(String(op.path ?? ""), { allowSubdirs: true });
          const absPath = resolveSafeChildPath(workspace.path, path);
          if (!(await exists(absPath))) {
            items.push({ ok: false, type, path, code: "file_not_found", message: "Path not found" });
            continue;
          }
          await rm(absPath, { recursive: op.recursive === true, force: false });
          recordWorkspaceFileEvent(workspace.id, { type: "delete", path });
          items.push({ ok: true, type, path });
          continue;
        }

        if (type === "rename") {
          const from = normalizeWorkspaceRelativePath(String(op.from ?? ""), { allowSubdirs: true });
          const to = normalizeWorkspaceRelativePath(String(op.to ?? ""), { allowSubdirs: true });
          const fromAbs = resolveSafeChildPath(workspace.path, from);
          const toAbs = resolveSafeChildPath(workspace.path, to);
          if (!(await exists(fromAbs))) {
            items.push({ ok: false, type, from, to, code: "file_not_found", message: "Source path not found" });
            continue;
          }
          await ensureDir(dirname(toAbs));
          await rename(fromAbs, toAbs);
          recordWorkspaceFileEvent(workspace.id, { type: "rename", path: from, toPath: to });
          items.push({ ok: true, type, from, to });
          continue;
        }

        items.push({ ok: false, type, code: "invalid_operation", message: `Unsupported operation type: ${type}` });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Operation failed";
        items.push({ ok: false, type, code: "operation_failed", message });
      }
    }

    const events = fileSessions.listWorkspaceEvents(workspace.id, Number.MAX_SAFE_INTEGER);
    return jsonResponse({ items, cursor: events.cursor });
  });

  addRoute(routes, "GET", "/workspace/:id/files/content", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const requested = (ctx.url.searchParams.get("path") ?? "").trim();
    const relativePath = normalizeWorkspaceRelativePath(requested, { allowSubdirs: true });
    const lowered = relativePath.toLowerCase();
    const isMarkdown = lowered.endsWith(".md") || lowered.endsWith(".mdx") || lowered.endsWith(".markdown");
    if (!isMarkdown) {
      throw new ApiError(400, "invalid_path", "Only markdown files are supported");
    }

    const absPath = resolveSafeChildPath(workspace.path, relativePath);
    if (!(await exists(absPath))) {
      throw new ApiError(404, "file_not_found", "File not found");
    }
    const info = await stat(absPath);
    if (!info.isFile()) {
      throw new ApiError(404, "file_not_found", "File not found");
    }

    const maxBytes = FILE_SESSION_MAX_FILE_BYTES;
    if (info.size > maxBytes) {
      throw new ApiError(413, "file_too_large", "File exceeds size limit", { maxBytes, size: info.size });
    }

    const content = await restoreProtectedFileText(workspace, await readFile(absPath, "utf8"), absPath);
    return jsonResponse({ path: relativePath, content, bytes: info.size, updatedAt: info.mtimeMs });
  });

  addRoute(routes, "POST", "/workspace/:id/files/content", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);

    const requestedPath = String(body.path ?? "");
    const relativePath = normalizeWorkspaceRelativePath(requestedPath, { allowSubdirs: true });
    const lowered = relativePath.toLowerCase();
    const isSkillFolderWrite = lowered.startsWith(".opencode/skills/");
    // Allow markdown plus common text/source file types only for skill-folder
    // uploads under .opencode/skills/**. Keep markdown-only behavior elsewhere.
    const TEXT_FILE_EXTENSIONS = [
      ".md", ".mdx", ".markdown", ".txt", ".text",
      ".py", ".sh", ".bash", ".zsh", ".ps1",
      ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx",
      ".json", ".jsonc", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".env", ".properties",
      ".csv", ".tsv", ".xml", ".html", ".htm", ".css", ".scss",
      ".sql", ".rb", ".go", ".rs", ".java", ".kt", ".c", ".cc", ".cpp", ".h", ".hpp",
      ".r", ".lua", ".pl", ".php", ".swift", ".gitignore", ".example", ".lock", ".gradle", ".dockerfile",
    ];
    const isAllowedSkillTextFile =
      TEXT_FILE_EXTENSIONS.some((ext) => lowered.endsWith(ext)) || lowered.endsWith("/dockerfile");
    const isMarkdownOnlyFile = lowered.endsWith(".md") || lowered.endsWith(".mdx") || lowered.endsWith(".markdown");
    const isAllowedPath = isSkillFolderWrite ? isAllowedSkillTextFile : isMarkdownOnlyFile;
    if (!isAllowedPath) {
      throw new ApiError(
        400,
        "invalid_path",
        isSkillFolderWrite ? "Only text files are supported in .opencode/skills/**" : "Only markdown files are supported",
      );
    }

    if (typeof body.content !== "string") {
      throw new ApiError(400, "invalid_payload", "content must be a string");
    }
    const content = body.content;
    const bytes = Buffer.byteLength(content, "utf8");
    const maxBytes = FILE_SESSION_MAX_FILE_BYTES;
    if (bytes > maxBytes) {
      throw new ApiError(413, "file_too_large", "File exceeds size limit", { maxBytes, size: bytes });
    }

    const baseUpdatedAtRaw = body.baseUpdatedAt;
    const baseUpdatedAt =
      typeof baseUpdatedAtRaw === "number" && Number.isFinite(baseUpdatedAtRaw) ? baseUpdatedAtRaw : null;
    const force = body.force === true;

    const absPath = resolveSafeChildPath(workspace.path, relativePath);

    const before = (await exists(absPath)) ? await stat(absPath) : null;
    if (before && !before.isFile()) {
      throw new ApiError(400, "invalid_path", "Path must point to a file");
    }
    const beforeUpdatedAt = before ? before.mtimeMs : null;
    if (!force && beforeUpdatedAt !== null && baseUpdatedAt !== null && beforeUpdatedAt !== baseUpdatedAt) {
      throw new ApiError(409, "conflict", "File changed since it was loaded", {
        baseUpdatedAt,
        currentUpdatedAt: beforeUpdatedAt,
      });
    }

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "workspace.file.write",
      summary: `Write ${relativePath}`,
      paths: [absPath],
    });

    await ensureDir(dirname(absPath));
    const tmp = `${absPath}.tmp-${shortId()}`;
    await writeFile(tmp, content, "utf8");
    await rename(tmp, absPath);
    const after = await stat(absPath);
    const revision = fileRevision(after);

    recordWorkspaceFileEvent(workspace.id, {
      type: "write",
      path: relativePath,
      revision,
    });

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "workspace.file.write",
      target: absPath,
      summary: `Wrote ${relativePath}`,
      timestamp: Date.now(),
    });

    return jsonResponse({ ok: true, path: relativePath, bytes, updatedAt: after.mtimeMs, revision });
  });

  // ── Agent files listing (only .opencode/agents/*.md) ──

  addRoute(routes, "GET", "/workspace/:id/agents", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const agentsDir = projectAgentsDir(workspace.path);
    if (!(await exists(agentsDir))) {
      return jsonResponse({ items: [] });
    }
    const entries = await readdir(agentsDir, { withFileTypes: true });
    const items: Array<{ name: string; description?: string }> = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const lower = entry.name.toLowerCase();
      if (!lower.endsWith(".md")) continue;
      const name = entry.name.replace(/\.md$/i, "");
      let description: string | undefined;
      try {
        const raw = await readFile(join(agentsDir, entry.name), "utf-8");
        const fm = parseFrontmatter(raw);
        if (typeof fm.data.description === "string") {
          description = fm.data.description.trim();
        }
      } catch {
        // skip unreadable files
      }
      items.push({ name, description });
    }
    return jsonResponse({ items });
  });

  addRoute(routes, "DELETE", "/workspace/:id/files/content", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const agentsPathPrefix = ".opencode/agents/";

    const requestedPath = (ctx.url.searchParams.get("path") ?? "").trim();
    const relativePath = normalizeWorkspaceRelativePath(requestedPath, { allowSubdirs: true });
    const lowered = relativePath.toLowerCase();
    if (!lowered.startsWith(agentsPathPrefix)) {
      throw new ApiError(400, "invalid_path", "Only agent markdown files can be deleted via this endpoint");
    }
    const agentRelativePath = relativePath.slice(agentsPathPrefix.length);
    if (!agentRelativePath || agentRelativePath.includes("/")) {
      throw new ApiError(400, "invalid_path", "Path must point to a top-level agent file");
    }
    const isMarkdown = lowered.endsWith(".md") || lowered.endsWith(".mdx") || lowered.endsWith(".markdown");
    if (!isMarkdown) {
      throw new ApiError(400, "invalid_path", "Only agent markdown files can be deleted via this endpoint");
    }

    const absPath = resolveSafeChildPath(workspace.path, relativePath);
    if (!(await exists(absPath))) {
      throw new ApiError(404, "file_not_found", `File not found: ${relativePath}`);
    }
    const info = await stat(absPath);
    if (!info.isFile()) {
      throw new ApiError(400, "invalid_path", "Path must point to a file");
    }

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "workspace.file.delete",
      summary: `Delete ${relativePath}`,
      paths: [absPath],
    });

    await rm(absPath, { force: true });

    recordWorkspaceFileEvent(workspace.id, {
      type: "delete",
      path: relativePath,
    });

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "workspace.file.delete",
      target: absPath,
      summary: `Deleted ${relativePath}`,
      timestamp: Date.now(),
    });

    return jsonResponse({ ok: true, path: relativePath });
  });

  addRoute(routes, "GET", "/workspace/:id/plugins", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const includeGlobal = ctx.url.searchParams.get("includeGlobal") === "true";
    const result = await listPlugins(workspace.path, includeGlobal);
    return jsonResponse(result);
  });

  addRoute(routes, "POST", "/workspace/:id/plugins", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const spec = String(body.spec ?? "");
    const normalized = normalizePluginSpec(spec);
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "plugins.add",
      summary: `Add plugin ${spec}`,
      paths: [opencodeConfigPath(workspace.path)],
    });
    const changed = await addPlugin(workspace.path, spec);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "plugins.add",
      target: "opencode.json",
      summary: `Added ${spec}`,
      timestamp: Date.now(),
    });
    if (changed) {
      emitReloadEvent(ctx.reloadEvents, workspace, "plugins", {
        type: "plugin",
        name: normalized,
        action: "added",
      });
    }
    const result = await listPlugins(workspace.path, false);
    return jsonResponse(result);
  });

  addRoute(routes, "DELETE", "/workspace/:id/plugins/:name", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const name = ctx.params.name ?? "";
    const normalized = normalizePluginSpec(name);
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "plugins.remove",
      summary: `Remove plugin ${name}`,
      paths: [opencodeConfigPath(workspace.path)],
    });
    const removed = await removePlugin(workspace.path, name);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "plugins.remove",
      target: "opencode.json",
      summary: `Removed ${name}`,
      timestamp: Date.now(),
    });
    if (removed) {
      emitReloadEvent(ctx.reloadEvents, workspace, "plugins", {
        type: "plugin",
        name: normalized,
        action: "removed",
      });
    }
    const result = await listPlugins(workspace.path, false);
    return jsonResponse(result);
  });

  addRoute(routes, "GET", "/hub/skills", "client", async (ctx) => {
    const owner = ctx.url.searchParams.get("owner")?.trim();
    const repo = ctx.url.searchParams.get("repo")?.trim();
    const ref = ctx.url.searchParams.get("ref")?.trim();
    const freshRaw = ctx.url.searchParams.get("fresh")?.trim().toLowerCase();
    const forceRefresh = freshRaw === "1" || freshRaw === "true" || freshRaw === "yes";
    const items = await listHubSkills({
      owner: owner || "different-ai",
      repo: repo || "openwork-hub",
      ref: ref || "main",
    }, { forceRefresh });
    return jsonResponse({ items });
  });

  addRoute(routes, "GET", "/workspace/:id/skills", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const includeGlobal = ctx.url.searchParams.get("includeGlobal") === "true";
    const items = await listSkills(workspace.path, includeGlobal);
    return jsonResponse({ items });
  });

  addRoute(routes, "GET", "/workspace/:id/agent-tools-skills", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const catalog = await listAgentToolSkillCatalog(workspace.path);
    return jsonResponse(catalog);
  });

  addRoute(routes, "POST", "/workspace/:id/skills/hub/:name", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const name = String(ctx.params.name ?? "").trim();
    if (!name) {
      throw new ApiError(400, "invalid_skill_name", "Skill name is required");
    }
    const body = await readJsonBody(ctx.request);
    const overwrite = body?.overwrite === true;
    const repoPayload = body?.repo && typeof body.repo === "object" ? (body.repo as Record<string, unknown>) : undefined;
    const repo = repoPayload
      ? {
        owner: typeof repoPayload.owner === "string" ? repoPayload.owner : undefined,
        repo: typeof repoPayload.repo === "string" ? repoPayload.repo : undefined,
        ref: typeof repoPayload.ref === "string" ? repoPayload.ref : undefined,
      }
      : undefined;

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "skills.install_hub",
      summary: `Install hub skill ${name}`,
      paths: [join(workspace.path, ".opencode", "skills", name)],
    });

    const result = await installHubSkill(workspace.path, { name, overwrite, repo });
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "skills.install_hub",
      target: result.path,
      summary: `Installed hub skill ${name}`,
      timestamp: Date.now(),
    });
    emitReloadEvent(ctx.reloadEvents, workspace, "skills", {
      type: "skill",
      name,
      action: result.action,
      path: result.path,
    });
    // Trigger OpenCode engine hot reload so command.list returns the new skill
    try {
      await reloadOpencodeEngine(workspace);
      console.log(`[hub-skill-install] reloadOpencodeEngine succeeded for skill: ${name}`);
    } catch (err) {
      // Best-effort: don't fail the hub skill install if OpenCode reload fails
      console.error(`[hub-skill-install] reloadOpencodeEngine failed for skill: ${name}`, err);
    }

    return jsonResponse({ ok: true, ...result });
  });

  addRoute(routes, "GET", "/workspace/:id/skills/:name", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const includeGlobal = ctx.url.searchParams.get("includeGlobal") === "true";
    const name = String(ctx.params.name ?? "").trim();
    if (!name) {
      throw new ApiError(400, "invalid_skill_name", "Skill name is required");
    }
    const items = await listSkills(workspace.path, includeGlobal);
    const item = items.find((skill) => skill.name === name);
    if (!item) {
      throw new ApiError(404, "skill_not_found", `Skill not found: ${name}`);
    }
    const content = await readFile(item.path, "utf8");
    return jsonResponse({ item, content });
  });

  addRoute(routes, "POST", "/workspace/:id/skill-imports", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request) as Record<string, unknown>;
    const name = String(body.name ?? "").trim();
    const files = Array.isArray(body.files) ? body.files : [];
    const filtered = Array.isArray(body.filtered) ? body.filtered : [];
    const actorTokenHash = ctx.actor?.tokenHash;
    if (!actorTokenHash) throw new ApiError(401, "unauthorized", "Authenticated client token is required");

    validateSkillName(name);

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "skills.package.import",
      summary: `Import skill package ${name}`,
      paths: [join(projectSkillsDir(workspace.path), name)],
    });

    const created = await skillPackageImports.create({
      workspaceId: workspace.id,
      workspaceRoot: workspace.path,
      actorTokenHash,
      name,
      files: files.map((entry) => {
        const record = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
        return { id: String(record.id ?? ""), path: String(record.path ?? ""), size: Number(record.size) };
      }),
      filtered: filtered.map((entry) => {
        const record = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
        const reason = record.reason === "ignored_directory" ? "ignored_directory" : "unsupported_type";
        return { path: String(record.path ?? ""), reason };
      }),
    });
    return jsonResponse({ ok: true, ...created });
  });

  addRoute(routes, "PUT", "/workspace/:id/skill-imports/:importId/files/:fileId", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const actorTokenHash = ctx.actor?.tokenHash;
    if (!actorTokenHash) throw new ApiError(401, "unauthorized", "Authenticated client token is required");
    const offset = Number(ctx.request.headers.get("x-skill-file-offset") ?? "0");
    const contentLengthHeader = ctx.request.headers.get("content-length");
    const contentLength = contentLengthHeader === null ? null : Number(contentLengthHeader);
    const chunkTooLargeMessage = `Upload chunk exceeds ${SKILL_PACKAGE_IMPORT_LIMITS.chunkBytes} bytes`;
    if (contentLength !== null && (!Number.isFinite(contentLength) || contentLength < 0)) {
      throw new ApiError(400, "invalid_content_length", "Content-Length must be a non-negative number");
    }
    if (contentLength !== null && contentLength > SKILL_PACKAGE_IMPORT_LIMITS.chunkBytes) {
      throw new ApiError(413, "skill_package_chunk_too_large", chunkTooLargeMessage);
    }
    const bytes = await readRequestBytesWithLimit(ctx.request, SKILL_PACKAGE_IMPORT_LIMITS.chunkBytes, chunkTooLargeMessage);
    const result = await skillPackageImports.appendChunk(
      ctx.params.importId,
      workspace.id,
      ctx.params.fileId,
      offset,
      bytes,
      actorTokenHash,
    );
    return jsonResponse({ ok: true, ...result });
  });

  addRoute(routes, "POST", "/workspace/:id/skill-imports/:importId/commit", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const actorTokenHash = ctx.actor?.tokenHash;
    if (!actorTokenHash) throw new ApiError(401, "unauthorized", "Authenticated client token is required");
    const result = await skillPackageImports.commit(ctx.params.importId, workspace.id, actorTokenHash);

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "skills.package.import",
      target: result.targetPath,
      summary: `Imported ${result.name} with ${result.filesImported} file(s); ${result.filtered.length} filtered`,
      timestamp: Date.now(),
    });
    emitReloadEvent(ctx.reloadEvents, workspace, "skills", {
      type: "skill",
      name: result.name,
      action: result.action,
      path: join(result.targetPath, "SKILL.md"),
    });
    try {
      await reloadOpencodeEngine(workspace);
    } catch (error) {
      logger?.log("error", "Skill package committed but OpenCode reload failed", {
        workspaceId: workspace.id,
        skill: result.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return jsonResponse({
      ok: true,
      status: result.filtered.length ? "imported_with_filtered_files" : "imported",
      ...result,
    });
  });

  addRoute(routes, "DELETE", "/workspace/:id/skill-imports/:importId", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const actorTokenHash = ctx.actor?.tokenHash;
    if (!actorTokenHash) throw new ApiError(401, "unauthorized", "Authenticated client token is required");
    await skillPackageImports.abort(ctx.params.importId, workspace.id, actorTokenHash);
    return jsonResponse({ ok: true });
  });

  addRoute(routes, "POST", "/workspace/:id/skills", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const name = String(body.name ?? "");
    const content = String(body.content ?? "");
    const description = body.description ? String(body.description) : undefined;
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "skills.upsert",
      summary: `Upsert skill ${name}`,
      paths: [join(workspace.path, ".opencode", "skills", name, "SKILL.md")],
    });
    const result = await upsertSkill(workspace.path, { name, content, description });
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "skills.upsert",
      target: result.path,
      summary: `Upserted skill ${name}`,
      timestamp: Date.now(),
    });
    emitReloadEvent(ctx.reloadEvents, workspace, "skills", {
      type: "skill",
      name,
      action: result.action,
      path: result.path,
    });
    // Trigger OpenCode engine hot reload so command.list returns the new skill
    try {
      await reloadOpencodeEngine(workspace);
      console.log(`[skill-upsert] reloadOpencodeEngine succeeded for skill: ${name}`);
    } catch (err) {
      // Best-effort: don't fail the skill upsert if OpenCode reload fails
      console.error(`[skill-upsert] reloadOpencodeEngine failed for skill: ${name}`, err);
    }
    return jsonResponse({ name, path: result.path, description: description ?? "", scope: "project" });
  });

  addRoute(routes, "DELETE", "/workspace/:id/skills/:name", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const name = String(ctx.params.name ?? "").trim();
    if (!name) {
      throw new ApiError(400, "invalid_skill_name", "Skill name is required");
    }
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "skills.delete",
      summary: `Delete skill ${name}`,
      paths: [join(workspace.path, ".opencode", "skills", name)],
    });
    const result = await deleteSkill(workspace.path, name);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "skills.delete",
      target: result.path,
      summary: `Deleted skill ${name}`,
      timestamp: Date.now(),
    });
    emitReloadEvent(ctx.reloadEvents, workspace, "skills", {
      type: "skill",
      name,
      action: "removed",
      path: result.path,
    });
    // Trigger OpenCode engine hot reload so command.list reflects the deletion
    try {
      await reloadOpencodeEngine(workspace);
      console.log(`[skill-delete] reloadOpencodeEngine succeeded for skill: ${name}`);
    } catch (err) {
      // Best-effort: don't fail the skill delete if OpenCode reload fails
      console.error(`[skill-delete] reloadOpencodeEngine failed for skill: ${name}`, err);
    }
    return jsonResponse({ ok: true, name, path: result.path });
  });

  registerMcpRoutes(routes, config, {
    addRoute,
    ensureWritable,
    fetchOpencodeJson,
    jsonResponse,
    readJsonBody,
    requireApproval,
    requireClientScope,
    resolveWorkspace,
  });

  addRoute(routes, "GET", "/workspace/:id/commands", "client", async (ctx) => {
    const scope = ctx.url.searchParams.get("scope") === "global" ? "global" : "workspace";
    if (scope === "global") {
      await requireHost(ctx.request, config, tokens);
    }
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const items = await listCommands(workspace.path, scope);
    return jsonResponse({ items });
  });

  addRoute(routes, "POST", "/workspace/:id/commands", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const name = String(body.name ?? "");
    const template = String(body.template ?? "");
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "commands.upsert",
      summary: `Upsert command ${name}`,
      paths: [join(workspace.path, ".opencode", "commands", `${sanitizeCommandName(name)}.md`)],
    });
    const path = await upsertCommand(workspace.path, {
      name,
      description: body.description ? String(body.description) : undefined,
      template,
      agent: body.agent ? String(body.agent) : undefined,
      model: body.model ? String(body.model) : undefined,
      subtask: typeof body.subtask === "boolean" ? body.subtask : undefined,
    });
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "commands.upsert",
      target: path,
      summary: `Upserted command ${name}`,
      timestamp: Date.now(),
    });

    emitReloadEvent(ctx.reloadEvents, workspace, "commands", {
      type: "command",
      name: sanitizeCommandName(name),
      action: "updated",
      path,
    });
    const items = await listCommands(workspace.path, "workspace");
    return jsonResponse({ items });
  });

  addRoute(routes, "DELETE", "/workspace/:id/commands/:name", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const name = ctx.params.name ?? "";
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "commands.delete",
      summary: `Delete command ${name}`,
      paths: [join(workspace.path, ".opencode", "commands", `${sanitizeCommandName(name)}.md`)],
    });
    await deleteCommand(workspace.path, name);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "commands.delete",
      target: join(workspace.path, ".opencode", "commands"),
      summary: `Deleted command ${name}`,
      timestamp: Date.now(),
    });

    emitReloadEvent(ctx.reloadEvents, workspace, "commands", {
      type: "command",
      name: sanitizeCommandName(name),
      action: "removed",
      path: join(workspace.path, ".opencode", "commands", `${sanitizeCommandName(name)}.md`),
    });
    return jsonResponse({ ok: true });
  });

  addRoute(routes, "GET", "/workspace/:id/agentlab/automations", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const store = await readAgentLabAutomations(workspace.path);
    return jsonResponse({ items: store.items, updatedAt: store.updatedAt });
  });

  addRoute(routes, "POST", "/workspace/:id/agentlab/automations", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);

    const name = typeof body.name === "string" ? body.name.trim() : "";
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    const enabled = typeof body.enabled === "boolean" ? body.enabled : true;
    if (!name) {
      throw new ApiError(400, "invalid_payload", "name is required");
    }
    if (!prompt) {
      throw new ApiError(400, "invalid_payload", "prompt is required");
    }

    const schedule = parseAgentLabSchedule(body.schedule);
    const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : undefined;
    const { provided: agentProvided, agent } = readAutomationAgentUpdate(body);
    await assertAutomationAgentRunnable(agent, () => fetchOpencodeJson(workspace, "/agent", { method: "GET" }));
    const id = body.id ? validateAgentLabAutomationId(body.id) : `agentlab_${shortId().replace(/-/g, "")}`;
    console.log(`[AgentLab:create] id=${id} name=${name} body.model=${JSON.stringify(body.model)} parsed model=${model} agent=${agentProvided ? agent ?? "(default)" : "(unchanged)"}`);

    const path = resolveAgentLabAutomationsPath(workspace.path);
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "agentlab.automations.upsert",
      summary: `Upsert automation ${name}`,
      paths: [path],
    });

    const store = await readAgentLabAutomations(workspace.path);
    const now = Date.now();
    const existingIndex = store.items.findIndex((item) => item.id === id);
    if (existingIndex !== -1) {
      const prev = store.items[existingIndex];
      store.items[existingIndex] = {
        ...prev,
        id,
        name,
        enabled,
        schedule,
        prompt,
        model,
        agent: agentProvided ? agent : prev.agent,
        updatedAt: now,
      };
    } else {
      store.items.unshift({
        id,
        name,
        enabled,
        schedule,
        prompt,
        model,
        agent,
        createdAt: now,
        updatedAt: now,
      });
    }
    await writeAgentLabAutomations(workspace.path, store);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "agentlab.automations.upsert",
      target: path,
      summary: `Upserted automation ${name}`,
      timestamp: now,
    });

    const next = await readAgentLabAutomations(workspace.path);
    return jsonResponse({ items: next.items, updatedAt: next.updatedAt }, 201);
  });

  addRoute(routes, "DELETE", "/workspace/:id/agentlab/automations/:automationId", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const automationId = validateAgentLabAutomationId(ctx.params.automationId);

    const path = resolveAgentLabAutomationsPath(workspace.path);
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "agentlab.automations.delete",
      summary: `Delete automation ${automationId}`,
      paths: [path],
    });

    const store = await readAgentLabAutomations(workspace.path);
    const before = store.items.length;
    store.items = store.items.filter((item) => item.id !== automationId);
    if (store.items.length === before) {
      throw new ApiError(404, "automation_not_found", "Automation not found");
    }
    await writeAgentLabAutomations(workspace.path, store);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "agentlab.automations.delete",
      target: path,
      summary: `Deleted automation ${automationId}`,
      timestamp: Date.now(),
    });
    return jsonResponse({ ok: true });
  });

  addRoute(routes, "POST", "/workspace/:id/agentlab/automations/:automationId/run", "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const automationId = validateAgentLabAutomationId(ctx.params.automationId);

    const body = await readJsonBody(ctx.request).catch(() => ({}) as Record<string, unknown>);
    const requestModel = typeof body.model === "string" && body.model.trim() ? body.model.trim() : undefined;

    const store = await readAgentLabAutomations(workspace.path);
    const automation = store.items.find((item) => item.id === automationId);
    if (!automation) {
      throw new ApiError(404, "automation_not_found", "Automation not found");
    }

    // Use the model from the request (frontend's current selection), falling back
    // to the model stored on the automation record, then to the global default.
    const effectiveModel = requestModel ?? automation.model ?? DEFAULT_AUTOMATION_MODEL;
    console.log(`[AgentLab:run] id=${automationId} body.model=${JSON.stringify(body.model)} requestModel=${requestModel} automation.model=${automation.model} effectiveModel=${effectiveModel}`);
    // Persist the model onto the automation so the scheduler also uses it.
    if (requestModel && requestModel !== automation.model) {
      automation.model = requestModel;
    }

    const now = Date.now();
    const { sessionId } = await dispatchAgentLabAutomationRun(workspace, automation, effectiveModel);

    automation.lastRunAt = now;
    automation.lastRunSessionId = sessionId;
    automation.lastRunError = undefined;
    automation.updatedAt = now;
    if (!config.readOnly) {
      await writeAgentLabAutomations(workspace.path, store);
    }

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "agentlab.automations.run",
      target: resolveAgentLabAutomationsPath(workspace.path),
      summary: `Ran automation ${automation.name}`,
      timestamp: now,
    });

    return jsonResponse({ ok: true, automationId, sessionId, ranAt: now });
  });

  addRoute(routes, "GET", "/workspace/:id/agentlab/automations/logs", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const logsDir = resolveAgentLabLogsDir(workspace.path);
    if (!(await exists(logsDir))) {
      return jsonResponse({ items: [] });
    }
    const entries = await readdir(logsDir, { withFileTypes: true });
    const items: Array<{ id: string; path: string; size: number; updatedAt: number }> = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".log")) continue;
      const id = entry.name.slice(0, -4);
      const abs = join(logsDir, entry.name);
      try {
        const info = await stat(abs);
        items.push({ id, path: entry.name, size: info.size, updatedAt: info.mtimeMs });
      } catch {
        // ignore
      }
    }
    items.sort((a, b) => b.updatedAt - a.updatedAt);
    return jsonResponse({ items });
  });

  addRoute(routes, "GET", "/workspace/:id/agentlab/automations/logs/:automationId", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const automationId = validateAgentLabAutomationId(ctx.params.automationId);
    const logsDir = resolveAgentLabLogsDir(workspace.path);
    const abs = join(logsDir, `${automationId}.log`);
    if (!(await exists(abs))) {
      throw new ApiError(404, "log_not_found", "Log not found");
    }
    const content = await readFile(abs, "utf8");
    return jsonResponse({ id: automationId, content });
  });

  addRoute(routes, "GET", "/workspace/:id/scheduler/jobs", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const items = await listScheduledJobs(workspace.path);
    return jsonResponse({ items, supported: isLegacySchedulerSupported() });
  });

  addRoute(routes, "DELETE", "/workspace/:id/scheduler/jobs/:name", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const name = ctx.params.name ?? "";
    const { job, jobFile, systemPaths } = await resolveScheduledJob(name, workspace.path);
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "scheduler.delete",
      summary: `Delete scheduled job ${job.name}`,
      paths: [jobFile, ...systemPaths],
    });
    await deleteScheduledJob(job, jobFile);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "scheduler.delete",
      target: jobFile,
      summary: `Deleted scheduled job ${job.name}`,
      timestamp: Date.now(),
    });
    return jsonResponse({ job });
  });

  addRoute(routes, "GET", "/workspace/:id/export", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const exportPayload = await exportWorkspace(workspace);
    return jsonResponse(exportPayload);
  });

  addRoute(routes, "POST", "/workspace/:id/import", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    await gateOpencodeConfigMcp(body.opencode as Record<string, unknown> | undefined);
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "config.import",
      summary: "Import workspace config",
      paths: [opencodeConfigPath(workspace.path), openworkConfigPath(workspace.path)],
    });
    await importWorkspace(workspace, body);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "config.import",
      target: "workspace",
      summary: "Imported workspace config",
      timestamp: Date.now(),
    });
    emitReloadEvent(ctx.reloadEvents, workspace, "config", buildConfigTrigger(opencodeConfigPath(workspace.path)));
    return jsonResponse({ ok: true });
  });

  // ── Gmail credentials management ──

  addRoute(routes, "GET", "/workspace/:id/gmail/credentials/status", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    // Also here, not only at start-up: a workspace added later has had no start-up pass.
    if (!config.readOnly) await migrateGmailDataLogged(workspace);
    const gmailDir = gmailDataDir(workspace.path);
    const credPath = join(gmailDir, "credentials.json");
    const tokenPath = join(gmailDir, "token.json");
    const hasCredentials = await exists(credPath);
    const hasToken = await exists(tokenPath);
    let fileSize: number | null = null;
    let updatedAt: number | null = null;
    if (hasCredentials) {
      try {
        const info = await stat(credPath);
        fileSize = info.size;
        updatedAt = info.mtimeMs;
      } catch {
        // ignore stat errors
      }
    }
    return jsonResponse({ hasCredentials, hasToken, paused: gmailPaused(gmailDir), fileSize, updatedAt });
  });

  registerGmailEnabledRoute(routes, config, { addRoute, ensureWritable, jsonResponse, readJsonBody, requireClientScope, resolveWorkspace });

  addRoute(routes, "POST", "/workspace/:id/gmail/credentials", "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    ensureWritable(config);
    const workspace = await resolveWorkspace(config, ctx.params.id);

    const contentType = ctx.request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("multipart/form-data")) {
      throw new ApiError(400, "invalid_payload", "Expected multipart/form-data");
    }
    const form = await ctx.request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      throw new ApiError(400, "file_required", "Form field 'file' is required");
    }

    // Validate file size (max 100KB — credentials.json is typically < 1KB)
    const maxBytes = 100 * 1024;
    if (file.size > maxBytes) {
      throw new ApiError(413, "file_too_large", "File exceeds 100KB limit", { maxBytes, size: file.size });
    }

    // Validate JSON structure
    let parsed: unknown;
    try {
      const text = await file.text();
      parsed = JSON.parse(text);
    } catch {
      throw new ApiError(400, "invalid_json", "File is not valid JSON");
    }

    // Validate it looks like a Google OAuth credentials file
    const root = parsed as Record<string, unknown>;
    const inner = (root.installed ?? root.web) as Record<string, unknown> | undefined;
    if (!inner || typeof inner.client_id !== "string" || typeof inner.client_secret !== "string") {
      throw new ApiError(400, "invalid_credentials", "File does not look like a valid Google OAuth credentials.json. Expected 'installed' or 'web' key with client_id and client_secret.");
    }

    const gmailDir = gmailDataDir(workspace.path);
    await ensureDir(gmailDir);
    const dest = join(gmailDir, "credentials.json");

    // Write atomically via temp file
    const bytes = Buffer.from(await file.arrayBuffer());
    const tmp = `${dest}.tmp-${shortId()}`;
    await writeFile(tmp, bytes);
    await rename(tmp, dest);

    // Remove existing token.json so user re-authenticates with new credentials
    await removeGmailTokens(gmailDir);

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "gmail.credentials.upload",
      target: dest,
      summary: "Uploaded Gmail credentials.json",
      timestamp: Date.now(),
    });

    return jsonResponse({ ok: true, bytes: file.size });
  });

  addRoute(routes, "DELETE", "/workspace/:id/gmail/credentials", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const gmailDir = gmailDataDir(workspace.path);
    const credPath = join(gmailDir, "credentials.json");
    const tokenPath = join(gmailDir, "token.json");

    if (!(await exists(credPath))) {
      throw new ApiError(404, "not_found", "No credentials.json found");
    }

    await rm(credPath, { force: true });
    // Also remove token, email DB, and pending auth since they're tied to the credentials
    for (const file of [tokenPath, join(gmailDir, GMAIL_PAUSED_TOKEN_FILE), join(gmailDir, "gmail.db"), join(gmailDir, "pending_auth.json")]) {
      if (await exists(file)) {
        await rm(file, { force: true });
      }
    }

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "gmail.credentials.delete",
      target: credPath,
      summary: "Deleted Gmail credentials and all associated data (token, db, pending auth)",
      timestamp: Date.now(),
    });

    return jsonResponse({ ok: true });
  });

  addRoute(routes, "POST", "/workspace/:id/gmail/auth/start", "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    ensureWritable(config);
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const gmailDir = gmailScriptDir(workspace.path);
    const port = process.env.OPENWORK_HOST_PORT ?? "8787";
    const redirectURL = `http://localhost:${port}/w/${encodeURIComponent(workspace.id)}/api/gmail/oauth/callback`;

    // egress-surface: openwork_gmail_uv_install
    const proc = Bun.spawn(
      gmailScriptCommand("email_sync.py", ["--get-auth-url", redirectURL]),
      { cwd: gmailDir, env: gmailUvEnv(), stdout: "pipe", stderr: "pipe", windowsHide: true },
    )

    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      const message = stderr.trim() || "Failed to generate the auth URL";
      if (exitCode === 2) {
        throw new ApiError(409, "gmail_no_credentials", message);
      }
      throw new ApiError(500, "auth_url_failed", message);
    }

    const authURL = (await new Response(proc.stdout).text()).trim();

    if (!authURL.startsWith("https://")) {
      throw new ApiError(500, "auth_url_invalid", `Unexpected output: ${authURL}`);
    }

    return jsonResponse({ authURL });
  });

  addRoute(routes, "GET", "/workspace/:id/gmail/apis", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    return jsonResponse(await checkGmailApis(gmailScriptDir(workspace.path)));
  });

  addRoute(routes, "GET", "/api/gmail/oauth/callback", "none", async (ctx) => {
    return htmlResponse(await completeGmailOAuth(ctx.url, config.workspaces));
  });

  addRoute(routes, "GET", "/w/:id/api/gmail/oauth/callback", "none", async (ctx) => {
    return htmlResponse(await completeGmailOAuth(ctx.url, config.workspaces, ctx.params.id));
  });

  addRoute(routes, "GET", "/approvals", "host", async (ctx) => {
    return jsonResponse({ items: ctx.approvals.list() });
  });

  addRoute(routes, "POST", "/approvals/:id", "host", async (ctx) => {
    const body = await readJsonBody(ctx.request);
    const reply = body.reply === "allow" ? "allow" : "deny";
    const result = ctx.approvals.respond(ctx.params.id, reply);
    if (!result) {
      throw new ApiError(404, "approval_not_found", "Approval request not found");
    }
    return jsonResponse({ ok: true, allowed: result.allowed });
  });

  return routes;
}


// --------------------------------------------------------------------------- //
// Gmail data migration                                                        //
// --------------------------------------------------------------------------- //

/** Move an older build's Gmail data into GMAIL_DATA_DIR, and record it: a client secret
 * and token changing place is something the audit log has to show. */
async function migrateGmailDataLogged(workspace: WorkspaceInfo): Promise<void> {
  const migration = await migrateLegacyGmailData(workspace.path);
  if (!migration) return;
  await recordAudit(workspace.path, {
    id: shortId(),
    workspaceId: workspace.id,
    actor: { type: "host" },
    action: "gmail.credentials.migrate",
    target: migration.to,
    summary: `Moved Gmail data an older build kept in ${migration.from}: moved ${migration.moved.join(", ") || "none"}; removed superseded ${migration.removed.join(", ") || "none"}`,
    timestamp: Date.now(),
  });
}

// ── Office document preview (docx/xlsx/pptx → PDF via headless LibreOffice) ──
const OFFICE_PREVIEW_EXTENSIONS = new Set([
  ".doc", ".docx", ".odt",
  ".xls", ".xlsx", ".ods",
  ".ppt", ".pptx", ".odp",
]);
const OFFICE_PREVIEW_MAX_BYTES = 50 * 1024 * 1024; // 50 MB
const OFFICE_PREVIEW_TIMEOUT_MS = 30_000;

// Spreadsheets are the one office family whose on-screen layout has no page
// structure: a sheet is an unbounded grid, and unless the author configured a
// print area the default export slices it into A4 pages. Measured on the
// reported file (6001 rows x 10 cols, 380 KB) that produced a 236-page PDF, so
// the side-by-side column blocks the author had arranged were split across
// pages and the preview became unreadable.
//
// `SinglePageSheets` renders each sheet as one page sized to its content
// instead. Verified on LibreOffice 24.2.7.2: a fixture that
// exported to 8 A4 pages became 1 page of 519x265mm.
//
// This filter is Calc-specific: passing calc_pdf_Export to a Writer or Impress
// document fails, and neither needs it (documents and slides already carry
// their own page geometry), so only spreadsheets are routed through it.
const CALC_PREVIEW_EXTENSIONS = new Set([".xls", ".xlsx", ".ods"]);

/**
 * Single-page Calc export, anchored at A1.
 *
 * `SinglePageSheets` alone anchors the single page at each sheet's *stored view
 * origin* rather than at A1, so a workbook saved while scrolled exports only
 * the region from that origin onwards and silently drops everything above and
 * to the left of it. Excel persists the last scroll position on every save, so
 * this is common rather than exotic.
 *
 * Measured on a real report (content in B1:R44, saved with
 * `<sheetView topLeftCell="I25"/>`): the export kept a plausible 422x229mm page
 * but carried 25,609 bytes instead of 32,225 — missing the header band and the
 * whole left-hand column of content, while looking like a legitimate preview.
 *
 * Restricting the export range to the sheet's used area makes the output
 * independent of wherever the author happened to leave the cursor.
 */
const CALC_SINGLE_PAGE_FILTER =
  'pdf:calc_pdf_Export:{"SinglePageSheets":{"type":"boolean","value":"true"}}';

function isOfficePreviewFile(path: string): boolean {
  return OFFICE_PREVIEW_EXTENSIONS.has(extname(path).toLowerCase());
}

function isCalcPreviewFile(path: string): boolean {
  return CALC_PREVIEW_EXTENSIONS.has(extname(path).toLowerCase());
}

/**
 * Convert an office document to PDF using headless LibreOffice and return the
 * PDF bytes as base64. Conversion runs in an isolated temp directory with a
 * per-call LibreOffice user profile (so concurrent conversions do not contend
 * on the single-instance lock). The temp directory — including the produced
 * PDF — is removed before returning, so nothing is ever written into the user
 * workspace.
 *
 * Emits a per-stage timing log (`office-preview.completed`) so a slow preview
 * can be attributed to conversion, disk read, or base64 encoding without
 * having to reproduce it under a profiler. Diagnosing the original report cost
 * several rounds of guesswork precisely because this breakdown did not exist.
 */
export async function convertOfficeToPdfBase64(
  absPath: string,
  logger?: Pick<ServerLogger, "log">,
): Promise<string> {
  const sofficePath = await requireSoffice();
  const startedAt = performance.now();
  const useCalcFilter = isCalcPreviewFile(absPath);
  const convertTo = useCalcFilter ? CALC_SINGLE_PAGE_FILTER : "pdf";
  let spawnMs = 0;
  let readMs = 0;
  let encodeMs = 0;
  let normalizedView = false;
  const tmpDir = await mkdtemp(join(tmpdir(), "office-preview-"));
  const profileDir = join(tmpDir, "profile");
  try {
    // A spreadsheet saved while scrolled would otherwise export only the region
    // from its stored view origin onwards (see stripSpreadsheetViewState).
    let sourcePath = absPath;
    if (useCalcFilter && isRewritableSpreadsheet(extname(absPath).toLowerCase())) {
      try {
        const rewritten = stripSpreadsheetViewState(await readFile(absPath));
        if (rewritten) {
          // Written into the conversion's own temp dir, never the workspace.
          sourcePath = join(tmpDir, basename(absPath));
          await writeFile(sourcePath, rewritten);
          normalizedView = true;
        }
      } catch (error) {
        // Preview must still work on packages this minimal zip reader cannot
        // handle; a stale scroll position is better than no preview at all.
        logger?.log("warn", "office-preview.view_reset_skipped", {
          "office.error": error instanceof Error ? error.message : String(error),
        });
      }
    }
    const spawnStartedAt = performance.now();
    const proc = Bun.spawn(
      [
        sofficePath,
        "--headless",
        "--nologo",
        "--nofirststartwizard",
        `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
        "--convert-to",
        convertTo,
        "--outdir",
        tmpDir,
        sourcePath,
      ],
      // stdout is intentionally ignored: only stderr is used for diagnostics,
      // and an unconsumed stdout pipe could fill and block the process.
      { stdout: "ignore", stderr: "pipe", windowsHide: true },
    ) as unknown as {
      exited: Promise<number>;
      stderr: ReadableStream<Uint8Array>;
      kill: (signal?: number) => void;
    };
    // Drain stderr concurrently (capped) so a full pipe buffer can never block
    // the process; the captured text is used only for server-side diagnostics.
    const STDERR_LOG_CAP = 16 * 1024;
    const stderrText = (async () => {
      try {
        const text = await new Response(proc.stderr).text();
        return text.length > STDERR_LOG_CAP ? `${text.slice(0, STDERR_LOG_CAP)}…` : text;
      } catch {
        return "";
      }
    })();
    // Race the process against a hard timeout so the request always completes
    // even if kill() fails or the process refuses to exit.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let exitCode: number;
    try {
      exitCode = await Promise.race([
        proc.exited,
        new Promise<number>((_, reject) => {
          timer = setTimeout(() => {
            try { proc.kill(); } catch { /* already exited */ }
            logger?.log("error", "office-preview.failed", {
              "office.stage": "timeout",
              "office.filter": convertTo,
              "office.timeout_ms": OFFICE_PREVIEW_TIMEOUT_MS,
            });
            reject(new ApiError(504, "office_conversion_timeout", "Document conversion timed out"));
          }, OFFICE_PREVIEW_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    spawnMs = performance.now() - spawnStartedAt;
    if (exitCode !== 0) {
      // Log the drained stderr server-side but never return it to the client —
      // it can contain host paths and other environment details.
      logger?.log("error", "office-preview.failed", {
        "office.stage": "convert",
        "office.exit_code": exitCode,
        "office.filter": convertTo,
        "office.spawn_ms": Math.round(spawnMs),
      });
      console.error(`[office-preview] LibreOffice conversion failed (exit ${exitCode}): ${(await stderrText).trim()}`);
      throw new ApiError(500, "office_conversion_failed", "Failed to convert document for preview");
    }
    const pdfPath = join(tmpDir, `${basename(absPath, extname(absPath))}.pdf`);
    if (!(await exists(pdfPath))) {
      logger?.log("error", "office-preview.failed", {
        "office.stage": "missing_output",
        "office.filter": convertTo,
        "office.spawn_ms": Math.round(spawnMs),
      });
      console.error("[office-preview] LibreOffice exited 0 but produced no PDF");
      throw new ApiError(500, "office_conversion_failed", "Failed to convert document for preview");
    }
    const readStartedAt = performance.now();
    const pdfBytes = await readFile(pdfPath);
    readMs = performance.now() - readStartedAt;
    const encodeStartedAt = performance.now();
    const base64 = pdfBytes.toString("base64");
    encodeMs = performance.now() - encodeStartedAt;
    logger?.log("info", "office-preview.completed", {
      "office.filter": convertTo,
      "office.single_page_sheets": useCalcFilter,
      "office.view_state_reset": normalizedView,
      "office.source_bytes": (await stat(absPath)).size,
      "office.pdf_bytes": pdfBytes.byteLength,
      "office.base64_bytes": base64.length,
      "office.spawn_ms": Math.round(spawnMs),
      "office.read_ms": Math.round(readMs),
      "office.encode_ms": Math.round(encodeMs),
      "office.total_ms": Math.round(performance.now() - startedAt),
    });
    return base64;
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => { });
  }
}

async function resolveWorkspace(config: ServerConfig, id: string): Promise<WorkspaceInfo> {
  const workspace = config.workspaces.find((entry) => entry.id === id);
  if (!workspace) {
    throw new ApiError(404, "workspace_not_found", "Workspace not found");
  }
  const resolvedWorkspace = resolve(workspace.path);
  const authorized = await isAuthorizedRoot(resolvedWorkspace, config.authorizedRoots);
  if (!authorized) {
    throw new ApiError(403, "workspace_unauthorized", "Workspace is not authorized");
  }
  return { ...workspace, path: resolvedWorkspace };
}

async function isAuthorizedRoot(workspacePath: string, roots: string[]): Promise<boolean> {
  const resolvedWorkspace = resolve(workspacePath);
  for (const root of roots) {
    const resolvedRoot = resolve(root);
    if (resolvedWorkspace === resolvedRoot) return true;
    if (resolvedWorkspace.startsWith(resolvedRoot + sep)) return true;
  }
  return false;
}

function ensureWritable(config: ServerConfig): void {
  if (config.readOnly) {
    throw new ApiError(403, "read_only", "Server is read-only");
  }
}

function scopeRank(scope: TokenScope): number {
  if (scope === "telemetry") return 0;
  if (scope === "viewer") return 1;
  if (scope === "collaborator") return 2;
  return 3;
}

function requireClientScope(ctx: RequestContext, required: TokenScope): void {
  const scope = ctx.actor?.scope;
  if (!scope) {
    throw new ApiError(401, "unauthorized", "Missing token scope");
  }
  if (scopeRank(scope) < scopeRank(required)) {
    throw new ApiError(403, "forbidden", "Insufficient token scope", { required, scope });
  }
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const json = await request.json();
    return json as Record<string, unknown>;
  } catch {
    throw new ApiError(400, "invalid_json", "Invalid JSON body");
  }
}

function parseInteger(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}


/**
 * The bearer this process presents to the router. In the native layout it is the SCOPED token: status reads and
 * `POST /send`, where a send to a new conversation waits for an approval, and nothing that writes a binding or
 * an identity (EG2-7). Other layouts, where the orchestrator starts both processes, still share one token.
 */
function routerBearerToken(): string {
  return (process.env.OPENCODE_ROUTER_SCOPED_TOKEN ?? process.env.OPENCODE_ROUTER_CONTROL_TOKEN ?? "").trim();
}

const ROUTER_SEND_TIMEOUT_MARGIN_MS = 10_000;

/** The router's own coded 4xx refusal of a send (approval denied/expired, queue full, forbidden field). */
function routerRefusal(apply: OpenCodeRouterApplyAttempt): { status: number; code: string; message: string } | null {
  const status = apply.status;
  const body = apply.body;
  if (typeof status !== "number" || status < 400 || status >= 500) return null;
  if (!body || typeof body !== "object") return null;
  const { code, error } = body as Record<string, unknown>;
  if (typeof code !== "string" || typeof error !== "string") return null;
  return { status, code, message: error };
}

function resolveOpenCodeRouterHealthPort(): number {
  return parseInteger(process.env.OPENCODE_ROUTER_HEALTH_PORT) ?? 3005;
}

// Observability helpers (probes + /v1/debug/* gate) moved to
// `./observability.ts` as the first surgical carve-out from this god file.
// `isDebugObservabilityEnabled` is re-exported so existing test imports stay green.
export { isDebugObservabilityEnabled } from "./observability.js";
function parseJsonResponse(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return trimmed;
  }
}

function normalizeHealthPort(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const port = Math.trunc(value);
  if (port <= 0 || port > 65535) return null;
  return port;
}

function ensurePlainObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

type OpenworkServerConfigFile = Record<string, unknown> & {
  workspaces?: Array<Record<string, unknown>>;
  authorizedRoots?: string[];
};

async function persistWorkspaceDeletion(configPath: string, workspaceId: string, workspacePath: string): Promise<boolean> {
  if (!configPath.trim()) return false;
  if (!(await exists(configPath))) {
    // If the server was started from CLI args/env, avoid implicitly creating server.json
    // because it can change token behavior on restart.
    return false;
  }

  let raw = "";
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    throw new ApiError(500, "server_config_read_failed", "Failed to read server config", {
      path: configPath,
      error: String(error),
    });
  }

  let parsed: OpenworkServerConfigFile;
  try {
    parsed = ensurePlainObject(JSON.parse(raw)) as OpenworkServerConfigFile;
  } catch (error) {
    throw new ApiError(422, "invalid_json", "Failed to parse server config", {
      path: configPath,
      error: String(error),
    });
  }

  const configDir = dirname(configPath);
  const workspacesRaw = parsed.workspaces;
  const workspaces = Array.isArray(workspacesRaw) ? workspacesRaw : [];

  const nextWorkspaces = workspaces.filter((entry) => {
    const obj = ensurePlainObject(entry);
    const path = typeof obj.path === "string" ? obj.path.trim() : "";
    if (!path) return true;
    const id = workspaceIdForPath(resolve(configDir, path));
    return id !== workspaceId;
  });

  const rootsRaw = parsed.authorizedRoots;
  const roots = Array.isArray(rootsRaw) ? rootsRaw : [];
  const nextRoots = roots.filter((root) => {
    const value = typeof root === "string" ? root.trim() : "";
    if (!value) return false;
    return resolve(configDir, value) !== resolve(workspacePath);
  });

  const workspacesChanged = nextWorkspaces.length !== workspaces.length;
  const rootsChanged = nextRoots.length !== roots.length;
  if (!workspacesChanged && !rootsChanged) return false;

  const next: OpenworkServerConfigFile = {
    ...parsed,
    ...(workspacesChanged ? { workspaces: nextWorkspaces } : {}),
    ...(rootsChanged ? { authorizedRoots: nextRoots } : {}),
  };

  await ensureDir(dirname(configPath));
  const tmpPath = `${configPath}.tmp.${shortId()}`;
  try {
    await writeFile(tmpPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await rename(tmpPath, configPath);
    return true;
  } finally {
    try {
      await rm(tmpPath);
    } catch {
      // ignore
    }
  }
}

function normalizeOpenCodeRouterIdentityId(value: unknown): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return "default";
  const safe = trimmed.replace(/[^a-zA-Z0-9_.-]+/g, "-");
  const cleaned = safe.replace(/^-+|-+$/g, "").slice(0, 48);
  return cleaned || "default";
}

type TelegramAccessMode = "public" | "private";

function normalizeTelegramAccessMode(value: unknown, fallback: TelegramAccessMode = "public"): TelegramAccessMode {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (raw === "private") return "private";
  if (raw === "public") return "public";
  return fallback;
}

type OpenCodeRouterApplyAttempt = {
  applied: boolean;
  port: number;
  hosts: string[];
  host?: string;
  status?: number;
  error?: string;
  body?: unknown;
};

function buildOpenCodeRouterHealthUrl(host: string, port: number, pathname: string): string {
  return `http://${host}:${port}${pathname}`;
}

async function tryPostOpenCodeRouterHealth(
  pathname: string,
  payload: unknown,
  options: { port: number; requestHost?: string | null; timeoutMs: number },
): Promise<OpenCodeRouterApplyAttempt> {
  const controlToken = routerBearerToken();
  const candidates = ["127.0.0.1"];
  const port = resolveOpenCodeRouterHealthPort();

  let lastError: OpenCodeRouterApplyAttempt | null = null;
  for (const host of candidates) {
    const url = buildOpenCodeRouterHealthUrl(host, port, pathname);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      // egress-surface: openwork_proxy_opencode_router
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(controlToken ? { Authorization: `Bearer ${controlToken}` } : {}),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timer);

      const text = await response.text();
      const parsed = parseJsonResponse(text);

      if (response.ok) {
        return {
          applied: true,
          port,
          hosts: candidates,
          host,
          status: response.status,
          body: parsed,
        };
      }

      const detail =
        typeof parsed === "object" && parsed && "error" in parsed
          ? String((parsed as Record<string, unknown>).error)
          : response.statusText || "OpenCodeRouter request failed";
      lastError = {
        applied: false,
        port,
        hosts: candidates,
        host,
        status: response.status,
        error: detail,
        body: parsed,
      };
    } catch (error) {
      clearTimeout(timer);
      const message =
        error instanceof Error && error.name === "AbortError"
          ? `Timeout after ${options.timeoutMs}ms`
          : String(error);
      lastError = {
        applied: false,
        port,
        hosts: candidates,
        host,
        error: message,
      };
    }
  }

  return (
    lastError ?? {
      applied: false,
      port,
      hosts: candidates,
      error: "OpenCodeRouter health server is unavailable",
    }
  );
}

async function tryFetchOpenCodeRouterHealth(
  method: "GET" | "DELETE",
  pathname: string,
  options: { port: number; requestHost?: string | null; timeoutMs: number },
): Promise<OpenCodeRouterApplyAttempt> {
  const controlToken = routerBearerToken();
  const candidates = ["127.0.0.1"];
  const port = resolveOpenCodeRouterHealthPort();

  let lastError: OpenCodeRouterApplyAttempt | null = null;
  for (const host of candidates) {
    const url = buildOpenCodeRouterHealthUrl(host, port, pathname);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      // egress-surface: openwork_proxy_opencode_router
      const response = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(controlToken ? { Authorization: `Bearer ${controlToken}` } : {}),
        },
        signal: controller.signal,
      });
      clearTimeout(timer);

      const text = await response.text();
      const parsed = parseJsonResponse(text);

      if (response.ok) {
        return {
          applied: true,
          port,
          hosts: candidates,
          host,
          status: response.status,
          body: parsed,
        };
      }

      const detail =
        typeof parsed === "object" && parsed && "error" in parsed
          ? String((parsed as Record<string, unknown>).error)
          : response.statusText || "OpenCodeRouter request failed";
      lastError = {
        applied: false,
        port,
        hosts: candidates,
        host,
        status: response.status,
        error: detail,
        body: parsed,
      };
    } catch (error) {
      clearTimeout(timer);
      const message =
        error instanceof Error && error.name === "AbortError"
          ? `Timeout after ${options.timeoutMs}ms`
          : String(error);
      lastError = {
        applied: false,
        port,
        hosts: candidates,
        host,
        error: message,
      };
    }
  }

  return (
    lastError ?? {
      applied: false,
      port,
      hosts: candidates,
      error: "OpenCodeRouter health server is unavailable",
    }
  );
}

async function readOpencodeConfig(workspaceRoot: string): Promise<Record<string, unknown>> {
  const { data } = await readJsoncFile(opencodeConfigPath(workspaceRoot), {} as Record<string, unknown>);
  return data;
}

async function readOpenworkConfig(workspaceRoot: string): Promise<Record<string, unknown>> {
  const path = openworkConfigPath(workspaceRoot);
  if (!(await exists(path))) return {};
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new ApiError(422, "invalid_json", "Failed to parse openwork.json");
  }
}

/**
 * Heuristic: detects strings that look like Windows host paths
 * (drive letter or backslashes). If we see one, the upstream client is buggy —
 * rewrite to the server's own workspace arg and warn.
 *
 * This is purely a runtime backstop. The fix for the buggy client lives in
 * the Tauri desktop shell (see docs/fixes/2026-04-30-windows-path-leak/).
 */
export function isWindowsLikePath(value: string): boolean {
  if (!value) return false;
  if (/^[A-Za-z]:[\\/]/.test(value)) return true;   // C:\... or D:/...
  if (value.includes("\\")) return true;             // backslashes anywhere
  return false;
}

export function rewriteIfWindowsLike(input: string, fallback: string, source: "header" | "config"): string {
  if (!isWindowsLikePath(input)) return input;
  // No-op rewrite: server is itself running on Windows, so the fallback is
  // also a Windows path. Skip the warning to avoid noise on host-Windows runs.
  if (input === fallback) return input;
  console.warn(
    `[openwork-server] ${source} contained a Windows-shaped path; rewriting to fallback. ` +
    `original=${JSON.stringify(input)} fallback=${JSON.stringify(fallback)}. ` +
    `This indicates a buggy client — see docs/fixes/2026-04-30-windows-path-leak/.`
  );
  return fallback;
}

/** A POSIX absolute path: leading slash, no drive letter and no backslashes. */
export function isPosixLikeAbsolutePath(value: string): boolean {
  if (!value) return false;
  if (isWindowsLikePath(value)) return false;
  return value.startsWith("/");
}

/**
 * The mirror of `rewriteIfWindowsLike`, for a server that is itself running native on Windows.
 *
 * A container-shaped directory (`/workspace`) cannot name a directory here, and opencode does not
 * reject it: it resolves the POSIX root against the current drive, finds nothing, walks up looking
 * for a project root and settles on `C:\`. It then indexes the whole drive until JavaScriptCore
 * aborts on memory exhaustion, which takes the runtime role down with it. Measured on this branch as
 * `creating instance directory="C:\"` immediately before
 * `MemoryExhaustion: Crash intentionally because memory is exhausted`.
 *
 * Returning `null` rather than a guess is deliberate for the caller that has no workspace to fall
 * back to: the runtime role is launched with `OPENCODE_DIRECTORY` already naming the workspace root,
 * so dropping an unusable header leaves opencode with the right default, while inventing a directory
 * here would be this layer choosing a project tree on the client's behalf.
 */
export function rewriteIfPosixLikeOnWindows(
  input: string,
  fallback: string | null,
  source: "header" | "config",
): string | null {
  if (process.platform !== "win32") return input;
  if (!isPosixLikeAbsolutePath(input)) return input;
  console.warn(
    `[openwork-server] ${source} contained a container-shaped path on a Windows-native runtime; ` +
    `${fallback ? "rewriting to fallback" : "dropping it"}. ` +
    `original=${JSON.stringify(input)} fallback=${JSON.stringify(fallback)}. ` +
    `Forwarding it would resolve to a drive root and index the whole volume.`
  );
  return fallback;
}

function resolveOpencodeDirectory(workspace: WorkspaceInfo): string | null {
  const explicit = workspace.directory?.trim() ?? "";
  if (explicit) {
    return rewriteIfPosixLikeOnWindows(
      rewriteIfWindowsLike(explicit, workspace.path, "config"),
      workspace.path,
      "config",
    );
  }
  if (workspace.workspaceType === "local") return workspace.path;
  return null;
}

function buildOpencodeReloadUrl(baseUrl: string, directory?: string | null): string {
  try {
    const url = new URL(baseUrl);
    url.pathname = "/instance/dispose";
    url.search = "";
    if (directory) {
      url.searchParams.set("directory", directory);
    }
    return url.toString();
  } catch {
    throw new ApiError(400, "opencode_url_invalid", "OpenCode base URL is invalid");
  }
}

function buildOpencodeAuthHeader(workspace: WorkspaceInfo): string | null {
  const username = workspace.opencodeUsername?.trim() ?? "";
  const password = workspace.opencodePassword?.trim() ?? "";
  if (!username || !password) return null;
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function parseOpencodeErrorBody(input: string): unknown {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return trimmed;
  }
}

async function reloadOpencodeEngine(workspace: WorkspaceInfo): Promise<void> {
  const baseUrl = workspace.baseUrl?.trim() ?? "";
  if (!baseUrl) {
    throw new ApiError(400, "opencode_unconfigured", "OpenCode base URL is missing for this workspace");
  }

  const directory = resolveOpencodeDirectory(workspace);
  const targetUrl = buildOpencodeReloadUrl(baseUrl, directory);
  const headers: Record<string, string> = {};
  const auth = buildOpencodeAuthHeader(workspace);
  if (auth) headers.Authorization = auth;

  // egress-surface: openwork_proxy_opencode
  const response = await fetch(targetUrl, { method: "POST", headers });
  if (response.ok) return;
  const body = parseOpencodeErrorBody(await response.text());
  throw new ApiError(502, "opencode_workspace_instance_refresh_failed", "OpenCode workspace instance refresh failed", {
    status: response.status,
    body,
  });
}

type ConfigPatchIssue = NonNullable<ReturnType<typeof ConfigPatchRequestSchema.safeParse>["error"]>["issues"][number];
type ConfigPatchIssueDetail = { path: string[]; code: string; message: string };

// A union issue wraps the real field errors in its branches; surface those so callers see the offending field.
function collectConfigPatchIssueDetails(issue: ConfigPatchIssue, prefix: string[], out: ConfigPatchIssueDetail[]): void {
  const path = [...prefix, ...issue.path.map(String)];
  if (issue.code === "invalid_union") {
    const nested = issue.errors.flat().filter((entry) => entry.path.length > 0 || entry.code === "unrecognized_keys");
    if (nested.length > 0) {
      for (const entry of nested) collectConfigPatchIssueDetails(entry, path, out);
      return;
    }
  }
  if (issue.code === "unrecognized_keys") {
    for (const key of issue.keys) {
      out.push({ path: [...path, key], code: issue.code, message: `Unrecognized key: ${key}` });
    }
    return;
  }
  out.push({ path, code: issue.code, message: issue.message });
}

async function writeOpenworkConfig(workspaceRoot: string, payload: Record<string, unknown>, merge: boolean): Promise<void> {
  const path = openworkConfigPath(workspaceRoot);
  const existing = merge ? await readOpenworkConfig(workspaceRoot) : {};
  const next: Record<string, unknown> = merge ? { version: 1, ...existing, ...payload } : payload;
  for (const key of ["workspace", "reload"] as const) {
    const currentSection = existing[key];
    const patchSection = payload[key];
    if (
      currentSection && typeof currentSection === "object" && !Array.isArray(currentSection) &&
      patchSection && typeof patchSection === "object" && !Array.isArray(patchSection)
    ) {
      next[key] = {
        ...(currentSection as Record<string, unknown>),
        ...(patchSection as Record<string, unknown>),
      };
    }
  }
  await ensureDir(join(workspaceRoot, ".opencode"));
  await writeFile(path, JSON.stringify(next, null, 2) + "\n", "utf8");
}

async function requireApproval(
  ctx: RequestContext,
  input: Omit<ApprovalRequest, "id" | "createdAt" | "actor">,
): Promise<void> {
  const actor = ctx.actor ?? { type: "remote" };
  const result = await ctx.approvals.requestApproval({ ...input, actor });
  if (!result.allowed) {
    throw new ApiError(403, "write_denied", "Write request denied", {
      requestId: result.id,
      reason: result.reason,
    });
  }
}

async function exportWorkspace(workspace: WorkspaceInfo) {
  const opencode = await readOpencodeConfig(workspace.path);
  const openwork = await readOpenworkConfig(workspace.path);
  const skills = await listSkills(workspace.path, false);
  const commands = await listCommands(workspace.path, "workspace");
  const skillContents = await Promise.all(
    skills.map(async (skill) => ({
      name: skill.name,
      description: skill.description,
      content: await readFile(skill.path, "utf8"),
    })),
  );
  const commandContents = await Promise.all(
    commands.map(async (command) => ({
      name: command.name,
      description: command.description,
      template: command.template,
    })),
  );

  return {
    workspaceId: workspace.id,
    exportedAt: Date.now(),
    opencode,
    openwork,
    skills: skillContents,
    commands: commandContents,
  };
}

async function importWorkspace(workspace: WorkspaceInfo, payload: Record<string, unknown>): Promise<void> {
  const modes = (payload.mode as Record<string, string> | undefined) ?? {};
  const opencode = payload.opencode as Record<string, unknown> | undefined;
  const openwork = payload.openwork as Record<string, unknown> | undefined;
  const skills = (payload.skills as { name: string; content: string; description?: string }[] | undefined) ?? [];
  const commands = (payload.commands as { name: string; content?: string; description?: string; template?: string; agent?: string; model?: string | null; subtask?: boolean }[] | undefined) ?? [];

  if (opencode) {
    if (modes.opencode === "replace") {
      await writeJsoncFile(opencodeConfigPath(workspace.path), opencode);
    } else {
      await updateJsoncTopLevel(opencodeConfigPath(workspace.path), opencode);
    }
  }

  if (openwork) {
    if (modes.openwork === "replace") {
      await writeOpenworkConfig(workspace.path, openwork, false);
    } else {
      await writeOpenworkConfig(workspace.path, openwork, true);
    }
  }

  if (skills.length > 0) {
    if (modes.skills === "replace") {
      await rm(projectSkillsDir(workspace.path), { recursive: true, force: true });
    }
    for (const skill of skills) {
      await upsertSkill(workspace.path, skill);
    }
  }

  if (commands.length > 0) {
    if (modes.commands === "replace") {
      await rm(projectCommandsDir(workspace.path), { recursive: true, force: true });
    }
    for (const command of commands) {
      if (command.content) {
        const parsed = parseFrontmatter(command.content);
        const name = command.name || (typeof parsed.data.name === "string" ? parsed.data.name : "");
        const description = command.description || (typeof parsed.data.description === "string" ? parsed.data.description : undefined);
        if (!name) {
          throw new ApiError(400, "invalid_command", "Command name is required");
        }
        const template = parsed.body.trim();
        await upsertCommand(workspace.path, {
          name,
          description,
          template,
          agent: typeof parsed.data.agent === "string" ? parsed.data.agent : undefined,
          model: typeof parsed.data.model === "string" ? parsed.data.model : undefined,
          subtask: typeof parsed.data.subtask === "boolean" ? parsed.data.subtask : undefined,
        });
      } else {
        const name = command.name ?? "";
        const template = command.template ?? "";
        await upsertCommand(workspace.path, {
          name,
          description: command.description,
          template,
          agent: command.agent,
          model: command.model,
          subtask: command.subtask,
        });
      }
    }
  }
}
