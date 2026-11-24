import { createEffect, createSignal, onCleanup, onMount, type Accessor } from "solid-js";
import type {
  McpOperationOutcome, McpServer, McpServerMutationResponse, McpServerUpdateRequest,
  McpToolListResponse, McpToolPolicyResponse, McpToolPolicyUpdateRequest,
} from "@different-ai/openwork-contracts/mcp";
import type { McpServerEntry, McpStatus, McpStatusMap } from "~/shared/types/mcp";
import { type McpDirectoryInfo, MCP_QUICK_CONNECT } from "~/shared/util/constants";
import { validateMcpServerName } from "~/shared/util/mcp-server-name";
import type {
  InstanceApiCapabilities, InstanceApiStatus,
} from "~/shared/platform/transport/instance-api.types";
import {
  HOST_MCP_PROXY_PREFIX, isHostMcpRuntimeUrl, type HostMcpRuntimeEndpoint, type HostMcpServer,
} from "@different-ai/openwork-contracts/host-mcp-api";
import { HostMcpApiError, type HostMcpApiClient } from "~/shared/platform/transport/host-mcp-api";
import { uiLogWarn } from "~/shared/platform/log/log";
import { t, type Language } from "../../i18n";
import { mcpServerKey } from "./mcp";
import { ownValue, type McpPendingAction, type McpPendingMap } from "./mcp-view-status";
import { createMcpServersClient, type McpServersClient } from "./mcp.client";
import { buildMcpServerConfig, mcpAuthRequiresRegistrationReload } from "./mcp-config";
import {
  hostRegisterRequest, hostRemoteConfig, withHostBrowserEndpoint,
  type McpConnectResult, type McpPlacement,
} from "./mcp-host-placement";
import {
  openworkMcpOperationOutcomesFromError, recordMcpDiagnostic, recordOpenworkMcpOperationOutcomes,
} from "./mcp-diagnostics";

export const MCP_STATUS_REFRESH_INTERVAL_MS = 5_000;
/**
 * How long a host-server reconnect that could not read a current status waits before it tries again:
 * short, so the reconnect lands soon after the runtime first answers.
 */
export const HOST_RECONNECT_RETRY_MS = 3_000;
const SERVER_UNAVAILABLE = "SuperClaw server unavailable. MCP config is read-only.";

export type UseMcpServersDeps = {
  instanceApiBaseUrl: Accessor<string>;
  instanceApiAuth: Accessor<{ token?: string; hostToken?: string }>;
  instanceWorkspaceId: Accessor<string | null>;
  instanceApiStatus: Accessor<InstanceApiStatus>;
  instanceCapabilities: Accessor<InstanceApiCapabilities | null>;
  currentLocale: Accessor<Language>;
  /** The host MCP gateway, or null when this build or Profile has none. */
  hostMcpClient?: Accessor<HostMcpApiClient | null>;
  /** True once the gateway has answered in this app start; failed host servers are then reconnected once. */
  hostMcpAwake?: Accessor<boolean>;
  createClient?: typeof createMcpServersClient;
  recordDiagnostic?: typeof recordMcpDiagnostic;
};

const toSlug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-");

// When the sandbox's process cap refuses a stdio launch, the engine reports only a fast
// "Connection closed", so the cause can be suggested but not confirmed.
const STDIO_EXIT_ON_START_MS = 5_000;
const isStdioExitOnStart = (outcome: McpOperationOutcome) =>
  outcome.step === "connect"
  && outcome.result === "failed"
  && outcome.transport === "local"
  && outcome.durationMs < STDIO_EXIT_ON_START_MS
  && /\bConnection closed\b/.test(outcome.errorMessage ?? "");

export function toMcpServerEntry(server: McpServer): McpServerEntry {
  const { config } = server;
  const execution = server.execution ? { execution: server.execution } : {};
  if (config.type === "local") {
    return {
      name: server.name,
      config: { type: "local", command: config.command, environment: config.environment, enabled: server.enabled, timeout: config.timeout },
      source: server.source,
      ...execution,
    };
  }
  const oauth = config.oauth === false ? false : config.oauth ? {} : undefined;
  return {
    name: server.name,
    config: { type: "remote", url: config.url, headers: config.headers, oauth, enabled: server.enabled, timeout: config.timeout },
    source: server.source,
    ...execution,
  };
}

export function toMcpStatus(server: McpServer): McpStatus | undefined {
  const status = server.status;
  if (!status || status.status === "connecting") return undefined;
  if (status.status === "failed") {
    return { status: status.status, error: status.error ?? "", code: status.code };
  }
  if (status.status === "needs_client_registration") {
    return { status: status.status, error: status.error ?? "" };
  }
  return { status: status.status };
}

/**
 * The runtime sees a host server connected whenever the gateway answers from its cached tool list,
 * so only the gateway's own state says whether it runs, failed, or starts on its first call.
 * `gateway` is null while the gateway's list is unknown, and undefined when it has no such server.
 */
export function hostServerStatus(
  status: McpStatus | undefined,
  gateway: HostMcpServer | null | undefined,
  previous: McpStatus | undefined,
  text: { failed: string; missing: string },
): McpStatus | undefined {
  if (status?.status !== "connected" && status?.status !== "failed") return status;
  if (gateway === null) {
    if (status.status === "failed") return status;
    const carried = previous?.status === "connected" || previous?.status === "failed";
    return carried ? previous : { status: "connected", onDemand: true };
  }
  if (gateway === undefined) return { status: "failed", error: text.missing };
  if (gateway.state === "failed") return { status: "failed", error: text.failed, code: gateway.error_code };
  if (status.status === "failed" || gateway.state === "running") return status;
  // Starting: shown as connecting until its handshake completes.
  return gateway.state === "starting" ? undefined : { status: "connected", onDemand: true };
}

const GATEWAY_SERVER_PATH = `${HOST_MCP_PROXY_PREFIX}/mcp/`;

/** The gateway's name for a host server: the path segment after `/mcp-host/mcp/` in its URL. */
function gatewayName(server: McpServer): string {
  if (server.config.type !== "remote") return server.name;
  try {
    const path = decodeURIComponent(new URL(server.config.url).pathname).replace(/\/{2,}/g, "/");
    if (path.toLowerCase().startsWith(GATEWAY_SERVER_PATH)) {
      return path.slice(GATEWAY_SERVER_PATH.length).split("/")[0] || server.name;
    }
  } catch {
    // An unparsable URL has no gateway name; the workspace key is all there is.
  }
  return server.name;
}

/** A host gateway is this computer's, so it only describes a workspace served from this computer. */
const isLoopbackUrl = (url: string): boolean => {
  try {
    return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
};

/** How long a gateway list that failed is not asked for again: each ask may start the gateway. */
export const HOST_SERVERS_RETRY_MS = 60_000;

/** Thin state over the instance API MCP resource. Status comes only from the list; mutations refetch it. */
export function useMcpServers(deps: UseMcpServersDeps) {
  const [mcpServers, setMcpServers] = createSignal<McpServerEntry[]>([]);
  const [mcpStatuses, setMcpStatuses] = createSignal<McpStatusMap>({});
  const [mcpBrowserSandboxRefusal, setMcpBrowserSandboxRefusal] = createSignal(false);
  /** The last change was refused because this Profile does not run MCP servers on this computer. */
  const [mcpHostExecutionRefusal, setMcpHostExecutionRefusal] = createSignal(false);
  /** The server whose stdio launch closed right after starting, if the last change left one. */
  const [mcpStdioExitedOnStart, setMcpStdioExitedOnStart] = createSignal<string | null>(null);
  const [mcpLastUpdatedAt, setMcpLastUpdatedAt] = createSignal<number | null>(null);
  const [mcpConnectingName, setMcpConnectingName] = createSignal<McpPendingMap>({});
  const [mcpAuthModalOpen, setMcpAuthModalOpen] = createSignal(false);
  const [mcpAuthEntry, setMcpAuthEntry] = createSignal<McpDirectoryInfo | null>(null);
  const [mcpAuthNeedsReload, setMcpAuthNeedsReload] = createSignal(false);
  const loggedFailures = new Map<string, string>();

  const markPending = (slug: string, action: McpPendingAction) =>
    setMcpConnectingName((previous) => ({ ...previous, [slug]: action }));
  const clearPending = (slug: string) =>
    setMcpConnectingName((previous) => {
      const next = { ...previous };
      delete next[slug];
      return next;
    });

  function client(access: "read" | "write"): McpServersClient | null {
    const workspaceId = deps.instanceWorkspaceId();
    const baseUrl = deps.instanceApiBaseUrl().trim();
    const allowed = deps.instanceCapabilities()?.mcp?.[access];
    if (deps.instanceApiStatus() !== "connected" || !workspaceId || !baseUrl || !allowed) return null;
    const auth = deps.instanceApiAuth();
    return (deps.createClient ?? createMcpServersClient)({ baseUrl, workspaceId, ...auth });
  }

  let serversWorkspace: string | null = null;

  // Rows are keyed by entry identity, so an unchanged server keeps its entry across
  // polls: a fresh one would remount its open Tools panel and drop a pending save.
  function applyServers(items: McpServer[]) {
    const workspaceId = deps.instanceWorkspaceId();
    const previous = serversWorkspace === workspaceId ? mcpServers() : [];
    serversWorkspace = workspaceId;
    setMcpServers(items.map((item) => {
      const next = toMcpServerEntry(item);
      const kept = previous.find((entry) => entry.name === next.name);
      return kept && JSON.stringify(kept) === JSON.stringify(next) ? kept : next;
    }));
  }

  async function recordNewFailures(items: McpServer[]): Promise<void> {
    for (const item of items) {
      const error = item.status?.status === "failed" ? item.status.error ?? "" : undefined;
      if (error === undefined) {
        loggedFailures.delete(item.name);
        continue;
      }
      if (loggedFailures.get(item.name) === error) continue;
      loggedFailures.set(item.name, error);
      await (deps.recordDiagnostic ?? recordMcpDiagnostic)({
        operation: "health-check",
        step: "status",
        source: "openwork",
        target: "opencode",
        mcp: item.name,
        status: "failed",
        error: error || undefined,
      });
    }
  }

  let refreshSeq = 0;
  let statusWorkspace: string | null = null;

  let hostServersRetryAt = Number.NEGATIVE_INFINITY;
  // The runtime's own statuses, without the gateway's: automatic recovery acts only on these.
  let runtimeStatuses: McpStatusMap = Object.create(null);
  /** The gateway's host servers by name, or null while unknown. */
  async function readHostServers(skipWait: boolean): Promise<Map<string, HostMcpServer> | null> {
    const host = deps.hostMcpClient?.() ?? null;
    if (!host || !deps.hostMcpAwake?.()) return null;
    if (!skipWait && Date.now() < hostServersRetryAt) return null;
    try {
      const servers = new Map((await host.listServers()).map((server) => [server.name, server]));
      hostServersRetryAt = Number.NEGATIVE_INFINITY;
      return servers;
    } catch {
      hostServersRetryAt = Date.now() + HOST_SERVERS_RETRY_MS;
      return null;
    }
  }

  /** True only when this read was still current and the engine answered, so its statuses were applied. */
  /** `skipWait`: read the gateway even within the wait after a failed read (after a Reconnect). */
  async function refreshMcpServersApplied(skipWait = false): Promise<boolean> {
    const seq = ++refreshSeq;
    const api = client("read");
    if (!api) return false;
    const workspaceId = deps.instanceWorkspaceId();
    const isStale = () => seq !== refreshSeq || deps.instanceWorkspaceId() !== workspaceId;
    try {
      const { items, runtime } = await api.list();
      const overlay = runtime.reachable
        && isLoopbackUrl(deps.instanceApiBaseUrl())
        && items.some((item) => item.execution === "host");
      const hostServers = overlay ? await readHostServers(skipWait) : null;
      if (isStale()) return false;
      applyServers(items);
      const carryStatus = statusWorkspace === workspaceId;
      statusWorkspace = workspaceId;
      const hostText = {
        failed: t("mcp.host.server_failed", deps.currentLocale()),
        missing: t("mcp.host.server_missing", deps.currentLocale()),
      };
      if (runtime.reachable) {
        runtimeStatuses = Object.create(null);
        for (const item of items) {
          const raw = toMcpStatus(item);
          if (raw) runtimeStatuses[item.name] = raw;
        }
      }
      setMcpStatuses((previous) => {
        const next: McpStatusMap = Object.create(null);
        for (const item of items) {
          const fresh = overlay && item.execution === "host"
            ? hostServerStatus(
              toMcpStatus(item),
              hostServers ? hostServers.get(gatewayName(item)) : null,
              carryStatus ? ownValue(previous, item.name) : undefined,
              hostText,
            )
            : toMcpStatus(item);
          const status = runtime.reachable
            ? fresh
            : carryStatus ? ownValue(previous, item.name) : undefined;
          if (status) next[item.name] = status;
        }
        return next;
      });
      if (!runtime.reachable) return false;
      setMcpLastUpdatedAt(Date.now());
      await recordNewFailures(items);
      return true;
    } catch {
      // Poll failures are intentionally silent; per-server state remains unchanged.
      return false;
    }
  }

  async function refreshMcpServers(): Promise<void> {
    await refreshMcpServersApplied();
  }

  // Why the last mutation failed, for the host flow that has to say so.
  let lastMutationError: string | null = null;

  async function mutate(
    name: string,
    run: (api: McpServersClient) => Promise<McpServerMutationResponse>,
  ): Promise<boolean> {
    setMcpBrowserSandboxRefusal(false);
    setMcpHostExecutionRefusal(false);
    setMcpStdioExitedOnStart(null);
    lastMutationError = null;
    const api = client("write");
    if (!api) {
      lastMutationError = SERVER_UNAVAILABLE;
      return false;
    }
    const workspaceId = deps.instanceWorkspaceId();
    const switchedAway = () => deps.instanceWorkspaceId() !== workspaceId;
    try {
      const response = await run(api);
      await recordOpenworkMcpOperationOutcomes(name, response.operations);
      if (switchedAway()) return false;
      for (const outcome of response.operations) {
        if (outcome.step === "connect" && outcome.result === "failed" && outcome.errorMessage) {
          loggedFailures.set(name, outcome.errorMessage);
        }
      }
      applyServers(response.items);
      await refreshMcpServers();
      if (response.operations.some(isStdioExitOnStart)) setMcpStdioExitedOnStart(name);
      return true;
    } catch (error) {
      lastMutationError = error instanceof Error && error.message ? error.message : null;
      await recordOpenworkMcpOperationOutcomes(name, openworkMcpOperationOutcomesFromError(error));
      if (!switchedAway() && errorCode(error) === "mcp_browser_unsupported_in_sandbox") {
        setMcpBrowserSandboxRefusal(true);
      }
      if (!switchedAway() && errorCode(error) === "mcp_host_execution_disabled") {
        setMcpHostExecutionRefusal(true);
      }
      return false;
    }
  }

  function errorCode(error: unknown): unknown {
    return error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  }

  function serverNameOf(entry: McpDirectoryInfo): string | null {
    try {
      return mcpServerKey(entry);
    } catch {
      return null;
    }
  }

  const isHostEntry = (name: string) =>
    mcpServers().some((entry) => entry.name === name && entry.execution === "host");

  /** Best effort: the workspace no longer points at this host server, so the gateway should not run it. */
  async function unregisterHostServer(name: string, reason: string): Promise<void> {
    const host = deps.hostMcpClient?.() ?? null;
    if (!host) return;
    try {
      await host.removeServer(name);
    } catch {
      uiLogWarn("mcp.host", `Could not remove a host MCP registration ${reason}`, { server: name });
    }
  }

  /**
   * A name that was a host server and is saved as anything but the gateway's runtime URL loses its
   * gateway registration, so no Job is left running unseen.
   */
  async function addServer(
    entry: McpDirectoryInfo,
    slug: string,
    config: ReturnType<typeof buildMcpServerConfig>,
  ): Promise<boolean> {
    markPending(slug, "connect");
    const wasOnHost = isHostEntry(slug);
    const onHost = config.type === "remote" && isHostMcpRuntimeUrl(config.url);
    try {
      const ok = await mutate(slug, (api) => api.add({ name: slug, config }));
      if (!ok) return false;
      if (wasOnHost && !onHost) await unregisterHostServer(slug, "after it was replaced by a sandboxed server");
      // Once added, the row's own status (McpServersList, via mcpStatuses) already shows
      // connected/failed; no need to also say so in the banner.
      const status = mcpStatuses()[slug];
      if (entry.oauth && status?.status !== "connected") {
        setMcpAuthEntry(entry);
        setMcpAuthNeedsReload(mcpAuthRequiresRegistrationReload(status?.status));
        setMcpAuthModalOpen(true);
      }
      return true;
    } finally {
      clearPending(slug);
    }
  }

  async function connectMcp(entry: McpDirectoryInfo): Promise<boolean> {
    setMcpBrowserSandboxRefusal(false);
    const slug = serverNameOf(entry);
    if (!slug) return false;
    return addServer(entry, slug, buildMcpServerConfig(entry));
  }

  const hostFailure = (error: unknown): McpConnectResult => {
    // The form never offers this, so the gateway's refusal reads as the form's own sentence; the form
    // picks the variant that names the SuperClaw browser when its card is there.
    if (error instanceof HostMcpApiError && error.code === "host_mcp_browser_automation_refused") {
      return {
        ok: false,
        code: error.code,
        message: t("mcp.host.browser_automation_not_in_version", deps.currentLocale()),
      };
    }
    return {
      ok: false,
      message: error instanceof Error && error.message ? error.message : t("mcp.connect_failed", deps.currentLocale()),
    };
  };
  const addFailure = (): McpConnectResult => ({
    ok: false,
    message: lastMutationError ?? t("mcp.connect_failed", deps.currentLocale()),
  });

  /**
   * Adds a local command placed on the host. `host` registers the command with the gateway first and
   * stores only its runtime endpoint; when that add fails, a registration this call created is removed
   * again, and one that was already there (a re-PUT keeps its token) is left working.
   * `host_browser` keeps a sandboxed local command, attached to the host Edge's CDP relay.
   * Nothing on the gateway changes unless the workspace can be written.
   */
  async function connectMcpPlaced(entry: McpDirectoryInfo, placement: McpPlacement): Promise<McpConnectResult> {
    setMcpBrowserSandboxRefusal(false);
    const host = deps.hostMcpClient?.() ?? null;
    const slug = serverNameOf(entry);
    if (!host || !slug || !entry.command?.length) return hostFailure(null);
    if (!client("write")) return { ok: false, message: SERVER_UNAVAILABLE };

    if (placement.kind === "host_browser") {
      let cdpEndpoint: string | null;
      try {
        cdpEndpoint = (await host.configureBrowser()).cdp_endpoint;
      } catch (error) {
        return hostFailure(error);
      }
      if (!cdpEndpoint) return hostFailure(null);
      const attached = { ...entry, command: withHostBrowserEndpoint(entry.command, cdpEndpoint) };
      return (await addServer(attached, slug, buildMcpServerConfig(attached))) ? { ok: true } : addFailure();
    }

    let runtime: HostMcpRuntimeEndpoint;
    let registered: boolean;
    try {
      registered = isHostEntry(slug) || (await host.listServers()).some((server) => server.name === slug);
      runtime = (await host.registerServer(slug, hostRegisterRequest(entry, placement.approvalMode))).runtime;
    } catch (error) {
      return hostFailure(error);
    }
    const remote = { ...entry, type: "remote" as const, url: runtime.url, oauth: false, command: undefined };
    if (await addServer(remote, slug, hostRemoteConfig(entry.command, runtime))) return { ok: true };
    const failed = addFailure();
    if (!registered) await unregisterHostServer(slug, "after its workspace add failed");
    return failed;
  }

  async function updateMcp(name: string, update: McpServerUpdateRequest): Promise<boolean> {
    return mutate(name, (api) => api.update(name, update));
  }

  async function setMcpEnabled(entry: McpServerEntry, enabled: boolean): Promise<void> {
    const name = validateMcpServerName(entry.name);
    markPending(name, enabled ? "enable" : "disable");
    try {
      await updateMcp(name, { enabled });
    } finally {
      clearPending(name);
    }
  }

  async function reconnectMcp(entry: McpServerEntry): Promise<void> {
    await setMcpEnabled(entry, true);
    // Only this read skips the wait after a failed read; background polls stay backed off.
    if (entry.execution === "host") await refreshMcpServersApplied(true);
  }

  function authorizeMcp(entry: McpServerEntry) {
    if (entry.config.type !== "remote" || entry.config.oauth === false) return;
    const preset = MCP_QUICK_CONNECT.find((candidate) =>
      toSlug(candidate.name) === entry.name || candidate.name === entry.name);
    setMcpAuthEntry({
      ...(preset ?? { name: entry.name, description: "", type: "remote", url: entry.config.url, oauth: true }),
      id: entry.name,
    });
    setMcpAuthNeedsReload(false);
    setMcpAuthModalOpen(true);
  }

  async function logoutMcpAuth(name: string): Promise<void> {
    setMcpBrowserSandboxRefusal(false);
    const safeName = validateMcpServerName(name);
    const api = client("write");
    if (!api) return;
    try {
      const response = await api.removeAuth(safeName);
      await recordOpenworkMcpOperationOutcomes(safeName, response.operations);
      await refreshMcpServers();
    } catch (error) {
      await recordOpenworkMcpOperationOutcomes(safeName, openworkMcpOperationOutcomesFromError(error));
    }
  }

  async function removeMcp(name: string): Promise<void> {
    const onHost = isHostEntry(name);
    if (!(await mutate(name, (api) => api.remove(name))) || !onHost) return;
    await unregisterHostServer(name, "after its workspace entry was removed");
  }

  /**
   * Reconnects the host servers the engine reports failed, which it does when it started before the
   * on_demand gateway did. False unless the workspace can be written and a current, reachable status
   * read was applied, so the caller tries again later.
   */
  async function reconnectFailedHostServers(): Promise<boolean> {
    if (!client("write")) return false;
    if (!(await refreshMcpServersApplied())) return false;
    const failed = mcpServers().filter((entry) =>
      entry.execution === "host"
      && entry.config.enabled !== false
      && ownValue(runtimeStatuses, entry.name)?.status === "failed");
    // Not reconnectMcp: only a Reconnect the user asked for skips the wait after a failed read.
    for (const entry of failed) await setMcpEnabled(entry, true);
    return true;
  }

  // Once per workspace per app start, after the gateway first answered. An attempt that could not read
  // a current status is tried again on the next applied refresh, or after a pause.
  const [hostReconnectedIn, setHostReconnectedIn] = createSignal<string | null>(null);
  const [hostReconnectRetry, setHostReconnectRetry] = createSignal(0);
  let hostReconnectBusy = false;
  let hostReconnectTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(hostReconnectTimer));
  createEffect(() => {
    hostReconnectRetry();
    const appliedAt = mcpLastUpdatedAt();
    const workspaceId = deps.instanceWorkspaceId();
    if (!deps.hostMcpAwake?.() || !workspaceId || hostReconnectedIn() === workspaceId) return;
    if (hostReconnectBusy || !client("write")) return;
    hostReconnectBusy = true;
    clearTimeout(hostReconnectTimer);
    void reconnectFailedHostServers().then((done) => {
      hostReconnectBusy = false;
      if (done && deps.instanceWorkspaceId() === workspaceId) {
        setHostReconnectedIn(workspaceId);
        return;
      }
      const retry = () => setHostReconnectRetry((count) => count + 1);
      // A refresh applied while this attempt was busy was not acted on; it makes a retry worth it now.
      if (mcpLastUpdatedAt() !== appliedAt || deps.instanceWorkspaceId() !== workspaceId) retry();
      else hostReconnectTimer = setTimeout(retry, HOST_RECONNECT_RETRY_MS);
    });
  });

  async function getMcpAuthStatus(name: string): Promise<McpStatus | null> {
    const api = client("read");
    if (!api) return null;
    const response = await api.list();
    const server = response.items.find((item) => item.name === name);
    return server ? toMcpStatus(server) ?? null : null;
  }

  async function startMcpAuth(name: string): Promise<{ authorizationUrl?: string }> {
    const api = client("write");
    if (!api) throw new Error(SERVER_UNAVAILABLE);
    return api.startAuth(name);
  }

  async function completeMcpAuth(name: string, code: string): Promise<void> {
    const api = client("write");
    if (!api) throw new Error(SERVER_UNAVAILABLE);
    await api.completeAuth(name, code);
  }

  /** Only the Product Profile-gated Tools panel calls these methods. */
  async function listMcpTools(name: string): Promise<McpToolListResponse> {
    const api = client("read");
    if (!api) throw new Error(SERVER_UNAVAILABLE);
    return api.listTools(validateMcpServerName(name));
  }

  async function setMcpToolPolicy(name: string, request: McpToolPolicyUpdateRequest): Promise<McpToolPolicyResponse> {
    const api = client("write");
    if (!api) throw new Error(SERVER_UNAVAILABLE);
    return api.setToolPolicy(validateMcpServerName(name), request);
  }

  return {
    mcpServers, mcpBrowserSandboxRefusal,
    dismissMcpBrowserSandboxRefusal: () => setMcpBrowserSandboxRefusal(false),
    mcpHostExecutionRefusal,
    dismissMcpHostExecutionRefusal: () => setMcpHostExecutionRefusal(false),
    mcpStdioExitedOnStart,
    dismissMcpStdioExitedOnStart: () => setMcpStdioExitedOnStart(null),
    mcpLastUpdatedAt, mcpStatuses, mcpConnectingName,
    mcpAuthModalOpen, setMcpAuthModalOpen, mcpAuthEntry, setMcpAuthEntry, mcpAuthNeedsReload, setMcpAuthNeedsReload,
    quickConnect: MCP_QUICK_CONNECT,
    refreshMcpServers, connectMcp, updateMcp, reconnectMcp, setMcpEnabled, authorizeMcp, logoutMcpAuth, removeMcp,
    connectMcpPlaced, reconnectFailedHostServers,
    getMcpAuthStatus, startMcpAuth, completeMcpAuth,
    listMcpTools, setMcpToolPolicy,
  };
}

/** Refetch on mount and every 5 s while the calling view is mounted and the document is visible. */
export function useMcpStatusRefresh(refresh: () => Promise<void> | void, intervalMs = MCP_STATUS_REFRESH_INTERVAL_MS) {
  onMount(() => {
    let inFlight = false;
    const tick = async () => {
      if (inFlight || (typeof document !== "undefined" && document.visibilityState !== "visible")) return;
      inFlight = true;
      try {
        await refresh();
      } finally {
        inFlight = false;
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), intervalMs);
    onCleanup(() => clearInterval(timer));
  });
}
