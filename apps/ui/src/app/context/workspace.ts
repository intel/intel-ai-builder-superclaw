import { createEffect, createMemo, createSignal } from "solid-js";

import type {
  StartupPreference,
  WorkspaceDisplay,
  WorkspaceOpenworkConfig,
  WorkspacePreset,
  WorkspaceConnectionState,
} from "../types";
import {
  addOpencodeCacheHint,
  clearStartupPreference,
  isTauriRuntime,
  normalizeDirectoryPath,
  resolveWorkspaceDirectory,
  safeStringify,
  writeStartupPreference,
} from "../utils";
import { OpencodeReadinessError, OpencodeRequestError, unwrap } from "../lib/opencode";
import { uiLogError, uiLogInfo, uiLogWarn } from "../lib/log";
import {
  normalizeOpenworkServerUrl,
  type OpenworkWorkspaceInfo,
} from "../lib/openwork-server";
import {
  engineDoctor,
  pickDirectory,
  workspaceBootstrap,
  workspaceCreate,
  workspaceCreateRemote,
  workspaceOpenworkRead,
  workspaceOpenworkWrite,
  workspaceUpdateDisplayName,
  workspaceUpdateRemote,
  type EngineDoctorResult,
  type EngineInfo,
  type WorkspaceInfo,
} from "../lib/tauri";
import { completeStartupTiming } from "../lib/startup-timing";
import { waitForHealthy, createClient, type OpencodeAuth } from "../lib/opencode";
import type { OpencodeConnectStatus } from "../types";
import { t, currentLocale } from "../../i18n";
import { mapConfigProvidersToList } from "~/shared/util/providers";
import type {
  MigrationRepairResult,
  OwtTrace,
  WorkspaceDebugEvent,
  WorkspaceStoreOptions,
} from "./workspace-types";
import {
  canFallBackToSandboxHost,
  findOpenworkRemoteWorkspaceForTokenRefresh,
} from "./workspace-policy";
import {
  resolveOpenworkHost,
  resolveOpenworkHostWithRetry,
} from "./workspace-openwork-host";
import {
  createWorkspaceConnection,
  normalizeRemoteType,
} from "./workspace-connection";
import { createWorkspaceEngine } from "./workspace-engine";
import { createWorkspaceConfigIo } from "./workspace-config-io";
import { createWorkspaceActivate } from "./workspace-activate";
import {
  connectRequestKey,
  makeRunId,
  markOnboardingComplete,
  normalizeRoots,
  resolveConnectHealthTimeoutMs,
  resolveWorkspacePath,
} from "./workspace-store-helpers";

export type WorkspaceStore = ReturnType<typeof createWorkspaceStore>;

export type {
  MigrationRepairResult,
  WorkspaceDebugEvent,
} from "./workspace-types";
export {
  canFallBackToSandboxHost,
  classifyWorkspaceError,
  findOpenworkRemoteWorkspaceForTokenRefresh,
  nextOpenworkServerSettingsForWorkspace,
  OPENWORK_RESOLVE_RETRY_BUDGET_MS,
  openworkResolveRetryDecision,
  type OpenworkResolveOutcome,
} from "./workspace-policy";

// Upper bound on how long onBackendTokenRefresh waits for bootstrapOnboarding()
// to publish the persisted workspace list. Generous enough to cover a slow
// workspaceBootstrap() IPC round-trip, short enough that a wedged bootstrap
// still degrades to the previous behaviour instead of hanging the connect.
const WORKSPACE_BOOTSTRAP_GATE_TIMEOUT_MS = 10_000;

export function createWorkspaceStore(options: WorkspaceStoreOptions) {

  const wsDebugEnabled = () => options.developerMode();

  const WORKSPACE_DEBUG_EVENT_LIMIT = 200;
  const [workspaceDebugEvents, setWorkspaceDebugEvents] = createSignal<WorkspaceDebugEvent[]>([]);
  const clearWorkspaceDebugEvents = () => setWorkspaceDebugEvents([]);
  const pushWorkspaceDebugEvent = (label: string, payload?: unknown) => {
    if (!wsDebugEnabled()) return;
    const entry: WorkspaceDebugEvent = { at: Date.now(), label, payload };
    setWorkspaceDebugEvents((prev) => {
      if (!prev.length) return [entry];
      const sliceStart = Math.max(0, prev.length - WORKSPACE_DEBUG_EVENT_LIMIT + 1);
      const next = prev.slice(sliceStart);
      next.push(entry);
      return next;
    });
  };

  const wsDebug = (label: string, payload?: unknown) => {
    if (!wsDebugEnabled()) return;
    try {
      if (payload === undefined) {
        console.log(`[WSDBG] ${label}`);
      } else {
        console.log(`[WSDBG] ${label}`, payload);
      }
      pushWorkspaceDebugEvent(label, payload);
    } catch {
      // ignore
    }
  };

  const connectInFlightByKey = new Map<string, Promise<boolean>>();
  let createRemoteInFlight: Promise<boolean> | null = null;
  // [Startup race fix] `bootstrapOnboarding()` (which loads persisted workspaces
  // via workspaceBootstrap()) and the owtToken poller in app.tsx run in two
  // independent effects. When the token lands first, `onBackendTokenRefresh`
  // inspects an empty `workspaces()` list, fails to find the openwork-remote
  // entry, and falls through to the create-new path — which then fails outright
  // because the sandbox's listWorkspaces isn't serving yet. Gate the token
  // handler on this promise so it always observes the bootstrapped list.
  let workspaceBootstrapGate: Promise<void> | null = null;
  let resolveWorkspaceBootstrapGate: (() => void) | null = null;
  const ensureWorkspaceBootstrapGate = () => {
    if (!workspaceBootstrapGate) {
      workspaceBootstrapGate = new Promise<void>((resolve) => {
        resolveWorkspaceBootstrapGate = resolve;
      });
    }
    return workspaceBootstrapGate;
  };
  const markWorkspaceBootstrapSettled = () => {
    ensureWorkspaceBootstrapGate();
    resolveWorkspaceBootstrapGate?.();
    resolveWorkspaceBootstrapGate = null;
  };

  const [engine, setEngine] = createSignal<EngineInfo | null>(null);
  const [engineAuth, setEngineAuth] = createSignal<OpencodeAuth | null>(null);
  const [engineDoctorResult, setEngineDoctorResult] = createSignal<EngineDoctorResult | null>(null);
  const [engineDoctorCheckedAt, setEngineDoctorCheckedAt] = createSignal<number | null>(null);
  const [engineInstallLogs, setEngineInstallLogs] = createSignal<string | null>(null);
  const [projectDir, setProjectDir] = createSignal("");
  const [workspaces, setWorkspaces] = createSignal<WorkspaceInfo[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = createSignal<string>("starter");

  const syncActiveWorkspaceId = (id: string) => {
    setActiveWorkspaceId(id);
  };

  const [authorizedDirs, setAuthorizedDirs] = createSignal<string[]>([]);
  const [newAuthorizedDir, setNewAuthorizedDir] = createSignal("");

  const [workspaceConfig, setWorkspaceConfig] = createSignal<WorkspaceOpenworkConfig | null>(null);
  const [workspaceConfigLoaded, setWorkspaceConfigLoaded] = createSignal(false);
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = createSignal(false);
  const [createRemoteWorkspaceOpen, setCreateRemoteWorkspaceOpen] = createSignal(false);
  const [connectingWorkspaceId, setConnectingWorkspaceId] = createSignal<string | null>(null);
  const [workspaceConnectionStateById, setWorkspaceConnectionStateById] = createSignal<
    Record<string, WorkspaceConnectionState>
  >({});
  const [exportingWorkspaceConfig, setExportingWorkspaceConfig] = createSignal(false);
  const [importingWorkspaceConfig, setImportingWorkspaceConfig] = createSignal(false);
  const [migrationRepairBusy, setMigrationRepairBusy] = createSignal(false);
  const [migrationRepairResult, setMigrationRepairResult] = createSignal<MigrationRepairResult | null>(null);

  const activeWorkspaceInfo = createMemo(() => workspaces().find((w) => w.id === activeWorkspaceId()) ?? null);
  const activeWorkspaceDisplay = createMemo<WorkspaceDisplay>(() => {
    const ws = activeWorkspaceInfo();
    if (!ws) {
      return {
        id: "",
        name: "Worker",
        path: "",
        preset: "starter",
        workspaceType: "local",
        remoteType: "opencode",
        baseUrl: null,
        directory: null,
        displayName: null,
        openworkHostUrl: null,
        openworkWorkspaceId: null,
        openworkWorkspaceName: null,
      };
    }
    const displayName =
      ws.displayName?.trim() ||
      ws.openworkWorkspaceName?.trim() ||
      ws.name ||
      ws.openworkHostUrl ||
      ws.baseUrl ||
      ws.path ||
      "Worker";
    return { ...ws, name: displayName };
  });
  const {
    updateWorkspaceConnectionState,
    testWorkspaceConnection,
    syncOpenworkTokens,
  } = createWorkspaceConnection({
    workspaces,
    setWorkspaces,
    setWorkspaceConnectionStateById,
    openworkServerSettings: options.openworkServerSettings,
  });

  const isOpenworkRemote = (workspace: WorkspaceInfo | null) =>
    Boolean(workspace && workspace.workspaceType === "remote" && normalizeRemoteType(workspace.remoteType) === "openwork");
  const activeWorkspacePath = createMemo(() => {
    const ws = activeWorkspaceInfo();
    if (!ws) return "";
    if (ws.workspaceType === "remote") return ws.directory?.trim() ?? "";
    return ws.path ?? "";
  });
  const activeWorkspaceRoot = createMemo(() => activeWorkspacePath().trim());

  /**
   * The directory string that should be sent to opencode/openwork-server SDK
   * calls (`directory:` field, `x-opencode-directory` header, file:// URLs in
   * attachments) for the active workspace.
   *
   * This is NOT the host-side filesystem path — see `activeWorkspacePath` /
   * `activeWorkspaceRoot` for that. On Windows + sandbox runtime they differ:
   * `activeWorkspacePath` is `C:\Users\...`, this is `/workspace`.
   *
   * Backed by `resolveWorkspaceDirectory()` which switches on the active
   * engine runtime. Introduced 2026-04-30 as part of the windows-path-leak
   * fix; see `docs/fixes/2026-04-30-windows-path-leak/`.
   */
  const activeWorkspaceSdkDirectory = createMemo(() =>
    resolveWorkspaceDirectory(activeWorkspaceInfo(), engine()?.runtime ?? null),
  );

  const clearWorkspaceConnectionState = (workspaceId: string) => {
    const id = workspaceId.trim();
    if (!id) return;
    setWorkspaceConnectionStateById((prev) => {
      if (!prev[id]) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  createEffect(() => {
    const ids = new Set(workspaces().map((workspace) => workspace.id));
    setWorkspaceConnectionStateById((prev) => {
      let changed = false;
      const next: Record<string, WorkspaceConnectionState> = {};
      for (const [id, state] of Object.entries(prev)) {
        if (!ids.has(id)) {
          changed = true;
          continue;
        }
        next[id] = state;
      }
      return changed ? next : prev;
    });
  });

  const resolveEngineRuntime = () => options.engineRuntime?.() ?? "openwork-orchestrator";

  const resolveWorkspacePaths = () => {
    const active = activeWorkspacePath().trim();
    const locals = workspaces()
      .filter((ws) => ws.workspaceType === "local")
      .map((ws) => ws.path)
      .filter((path): path is string => Boolean(path && path.trim()))
      .map((path) => path.trim());
    const resolved: string[] = [];
    if (active) resolved.push(active);
    for (const path of locals) {
      if (!resolved.includes(path)) resolved.push(path);
    }
    return resolved;
  };

  const activateOpenworkHostWorkspace = async (workspacePath: string) => {
    const client = options.openworkServerClient?.();
    if (!client) return;
    const targetPath = normalizeDirectoryPath(workspacePath);
    if (!targetPath) return;
    try {
      const response = await client.listWorkspaces();
      const items = Array.isArray(response.items) ? response.items : [];
      const match = items.find((entry) => normalizeDirectoryPath(entry.path) === targetPath);
      if (!match?.id) return;
      if (response.activeId === match.id) return;
      await client.activateWorkspace(match.id);
    } catch {
      // ignore
    }
  };

  const {
    refreshEngine,
    stopHost,
    reloadWorkspaceEngine,
    onInstallEngine,
  } = createWorkspaceEngine({
    options,
    engine,
    setEngine,
    setEngineAuth,
    setEngineInstallLogs,
    setProjectDir,
    activeWorkspaceInfo,
    activeWorkspaceDisplay,
    activeWorkspacePath,
    resolveEngineRuntime,
    resolveWorkspacePaths,
    refreshEngineDoctor,
    connectToServer,
  });

  async function refreshEngineDoctor() {
    if (!isTauriRuntime()) return;

    try {
      const source = options.engineSource();
      const result = await engineDoctor({
        preferSidecar: source === "sidecar",
        opencodeBinPath: source === "custom" ? options.engineCustomBinPath?.().trim() || null : null,
      });
      setEngineDoctorResult(result);
      setEngineDoctorCheckedAt(Date.now());
    } catch (e) {
      setEngineDoctorResult(null);
      setEngineDoctorCheckedAt(Date.now());
      setEngineInstallLogs(e instanceof Error ? e.message : safeStringify(e));
    }
  }

  const { activateWorkspace } = createWorkspaceActivate({
    options,
    wsDebug,
    workspaces,
    setWorkspaces,
    activeWorkspaceId,
    syncActiveWorkspaceId,
    projectDir,
    setProjectDir,
    authorizedDirs,
    setAuthorizedDirs,
    setWorkspaceConfig,
    setWorkspaceConfigLoaded,
    engine,
    setEngine,
    setEngineAuth,
    setConnectingWorkspaceId,
    resolveEngineRuntime,
    resolveWorkspacePaths,
    activateOpenworkHostWorkspace,
    startHost,
    connectToServer,
    updateWorkspaceConnectionState,
  });

  async function connectToServer(
    nextBaseUrl: string,
    directory?: string,
    context?: {
      workspaceId?: string;
      workspaceType?: WorkspaceInfo["workspaceType"];
      targetRoot?: string;
      reason?: string;
    },
    auth?: OpencodeAuth,
    connectOptions?: { quiet?: boolean; navigate?: boolean },
  ) {
    const requestKey = connectRequestKey(nextBaseUrl, directory, context, auth, connectOptions);
    const existing = connectInFlightByKey.get(requestKey);
    if (existing) {
      wsDebug("connect:dedupe", {
        baseUrl: nextBaseUrl,
        directory: directory ?? null,
        reason: context?.reason ?? null,
        workspaceType: context?.workspaceType ?? null,
      });
      return existing;
    }

    const run = (async () => {
      const connectStart = Date.now();
      let failureStage = "opencode.health";
      wsDebug("connect:start", {
        baseUrl: nextBaseUrl,
        directory: directory ?? null,
        reason: context?.reason ?? null,
        workspaceType: context?.workspaceType ?? null,
        targetRoot: context?.targetRoot ?? null,
        healthTimeoutMs: resolveConnectHealthTimeoutMs(context?.reason),
        quiet: connectOptions?.quiet ?? false,
        navigate: connectOptions?.navigate ?? true,
        authMode: auth && "mode" in auth ? (auth as any).mode : auth ? "basic" : "none",
      });
      const quiet = connectOptions?.quiet ?? false;
      const navigate = connectOptions?.navigate ?? true;
      options.setError(null);
      if (!quiet) {
        options.setBusy(true);
        options.setBusyLabel("status.connecting");
        options.setBusyStartedAt(Date.now());
      }
      options.setSseConnected(false);

      const connectMeta: OpencodeConnectStatus = {
        at: Date.now(),
        baseUrl: nextBaseUrl,
        directory: directory ?? null,
        reason: context?.reason ?? null,
        status: "connecting",
        error: null,
      };
      options.setOpencodeConnectStatus?.(connectMeta);

      const connectMetrics: NonNullable<OpencodeConnectStatus["metrics"]> = {};

      try {
        let resolvedDirectory = directory?.trim() ?? "";
        let nextClient = createClient(nextBaseUrl, resolvedDirectory || undefined, auth);
        const healthTimeoutMs = resolveConnectHealthTimeoutMs(context?.reason);
        const health = await waitForHealthy(nextClient, { timeoutMs: healthTimeoutMs });
        connectMetrics.healthyMs = Date.now() - connectStart;
        wsDebug("connect:healthy", {
          ms: Date.now() - connectStart,
          version: health.version,
          timeoutMs: healthTimeoutMs,
        });

        if (context?.workspaceType === "remote" && !resolvedDirectory) {
          try {
            const pathInfo = unwrap(await nextClient.path.get());
            const discovered = pathInfo.directory?.trim() ?? "";
            if (discovered) {
              resolvedDirectory = discovered;
              console.log("[workspace] remote directory resolved", resolvedDirectory);
              if (isTauriRuntime() && context.workspaceId) {
                const updated = await workspaceUpdateRemote({
                  workspaceId: context.workspaceId,
                  directory: resolvedDirectory,
                });
                setWorkspaces(updated.workspaces);
                syncActiveWorkspaceId(updated.activeId);
              }
              setProjectDir(resolvedDirectory);
              nextClient = createClient(nextBaseUrl, resolvedDirectory, auth);
            }
          } catch (error) {
            console.log("[workspace] remote directory lookup failed", error);
          }
        }

        options.setClient(nextClient);
        options.setConnectedVersion(health.version);
        options.setBaseUrl(nextBaseUrl);
        options.setClientDirectory(resolvedDirectory);

        // NOTE: provider.list returns ~3MB on remote OpenWork workspaces.
        // Running it concurrently with session.list / pending permissions caused
        // session.list to time out under Tauri plugin-http (request serialization
        // / connection contention against the same origin). To keep startup
        // robust, we serialize: fetch sessions + permissions FIRST (small, fast),
        // then kick off providers in the background.
        const buildProviders = async () => {
          const providersAt = Date.now();
          wsDebug("connect:providers:start", { baseUrl: nextBaseUrl });
          try {
            const providerList = unwrap(await nextClient.provider.list());
            wsDebug("connect:providers:done", {
              ms: Date.now() - providersAt,
              source: "provider.list",
              available: providerList.all?.length ?? 0,
              connected: providerList.connected?.length ?? 0,
            });
            return {
              providers: providerList.all,
              defaults: providerList.default,
              connectedIds: providerList.connected,
            };
          } catch (error) {
            const message = error instanceof Error ? error.message : safeStringify(error);
            uiLogWarn("runtime.connect", "OpenCode provider listing failed; trying fallback", {
              failureStage: "provider.list",
              status: error instanceof OpencodeRequestError ? error.status : null,
              code: error instanceof OpencodeRequestError ? error.code : null,
              message,
            });
            wsDebug("connect:providers:fallback", { ms: Date.now() - providersAt, message });
            try {
              const cfg = unwrap(await nextClient.config.providers());
              const mapped = mapConfigProvidersToList(cfg.providers);
              wsDebug("connect:providers:done", {
                ms: Date.now() - providersAt,
                source: "config.providers",
                available: mapped.length,
                connected: 0,
              });
              return {
                providers: mapped,
                defaults: cfg.default,
                connectedIds: [],
              };
            } catch (fallbackError) {
              const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : safeStringify(fallbackError);
              uiLogWarn("runtime.connect", "OpenCode provider fallback also failed", {
                failureStage: "provider.config",
                status: fallbackError instanceof OpencodeRequestError ? fallbackError.status : null,
                code: fallbackError instanceof OpencodeRequestError ? fallbackError.code : null,
                message: fallbackMessage,
              });
              wsDebug("connect:providers:error", { ms: Date.now() - providersAt, message: fallbackMessage });
              return {
                providers: [],
                defaults: {},
                connectedIds: [],
              };
            }
          } finally {
            connectMetrics.providersMs = Date.now() - providersAt;
          }
        };

        const targetRoot = context?.targetRoot ?? (resolvedDirectory || activeWorkspaceRoot().trim());
        failureStage = "session.list";
        wsDebug("connect:loadSessions", { targetRoot, resolvedDirectory });
        const sessionsAt = Date.now();
        await options.loadSessions(targetRoot);
        connectMetrics.loadSessionsMs = Date.now() - sessionsAt;
        wsDebug("connect:loadSessions:done", { ms: Date.now() - sessionsAt });
        failureStage = "permission.list";
        const pendingPermissionsAt = Date.now();
        await options.refreshPendingPermissions();
        connectMetrics.pendingPermissionsMs = Date.now() - pendingPermissionsAt;
        // Kick off providers AFTER fast endpoints completed. We still await it
        // here because the Settings UI relies on populated providers state.
        const providerState = await buildProviders();
        options.setProviders(providerState.providers);
        options.setProviderDefaults(providerState.defaults);
        options.setProviderConnectedIds(providerState.connectedIds);

        options.setSelectedSessionId(null);
        options.setMessages([]);
        options.setTodos([]);
        options.setPendingPermissions([]);
        options.setSessionStatusById({});

        options.refreshSkills({ force: true }).catch(() => undefined);
        options.refreshPlugins().catch(() => undefined);
        if (navigate && !options.selectedSessionId()) {
          options.setView("session");
        }

        // If the user successfully connected, treat onboarding as complete so we
        // don't force the onboarding flow on subsequent launches.
        markOnboardingComplete();
        options.onEngineStable?.();
        connectMetrics.totalMs = Date.now() - connectStart;
        options.setOpencodeConnectStatus?.({ ...connectMeta, status: "connected", metrics: connectMetrics });
        wsDebug("connect:done", { ok: true, ms: Date.now() - connectStart });
        uiLogInfo("runtime.connect", "Connected to server", {
          baseUrl: nextBaseUrl,
          reason: context?.reason ?? null,
          workspaceType: context?.workspaceType ?? null,
          elapsedMs: connectMetrics.totalMs,
        });
        completeStartupTiming({
          outcome: "runtime_connected",
          connectReason: context?.reason ?? null,
        });
        return true;
      } catch (e) {
        options.setClient(null);
        options.setConnectedVersion(null);
        const message = e instanceof Error ? e.message : safeStringify(e);
        console.error("[workspace] connect:error", { baseUrl: nextBaseUrl, ms: Date.now() - connectStart, message, error: e });
        wsDebug("connect:error", { ms: Date.now() - connectStart, message });
        // Persisted (unlike wsDebug/console.error above) so this shows up in
        // tauri_*.log even without devtools open. Without this, a health-check
        // failure here silently sets client=null and the SSE effect in
        // session.ts never fires again — the UI just shows "disconnected"
        // with no trace in the log file.
        uiLogError("runtime.connect", "Connect to server failed", {
          baseUrl: nextBaseUrl,
          failureStage: e instanceof OpencodeReadinessError ? e.phase : failureStage,
          reason: context?.reason ?? null,
          workspaceType: context?.workspaceType ?? null,
          message,
          elapsedMs: Date.now() - connectStart,
          attempts: e instanceof OpencodeReadinessError ? e.attempts : null,
          status:
            e instanceof OpencodeReadinessError || e instanceof OpencodeRequestError
              ? e.status ?? null
              : null,
          code:
            e instanceof OpencodeReadinessError || e instanceof OpencodeRequestError
              ? e.code ?? null
              : null,
        });
        connectMetrics.totalMs = Date.now() - connectStart;
        options.setOpencodeConnectStatus?.({
          ...connectMeta,
          status: "error",
          error: addOpencodeCacheHint(message),
          metrics: connectMetrics,
        });
        if (!quiet) {
          options.setError(addOpencodeCacheHint(message));
        }
        return false;
      } finally {
        if (!quiet) {
          options.setBusy(false);
          options.setBusyLabel(null);
          options.setBusyStartedAt(null);
        }
        // --- end of original startHost logic --- */
      }
    })();

    connectInFlightByKey.set(requestKey, run);
    try {
      return await run;
    } finally {
      if (connectInFlightByKey.get(requestKey) === run) {
        connectInFlightByKey.delete(requestKey);
      }
    }
  }

  const openEmptySession = async (scopeRoot?: string) => {
    const root = (scopeRoot ?? activeWorkspaceRoot().trim()).trim();

    if (options.client()) {
      try {
        await options.loadSessions(root || undefined);
      } catch {
        // If session loading fails, still fall back to the draft-ready session view.
      }
    }

    options.setSelectedSessionId(null);
    options.setMessages([]);
    options.setTodos([]);
    options.setPendingPermissions([]);
    options.setSessionStatusById({});
    options.setView("session");
  };

  const activateFreshLocalWorkspace = async (workspaceId: string | null, workspacePath: string) => {
    if (!workspaceId) {
      await openEmptySession(workspacePath);
      return true;
    }

    const hasClient = Boolean(options.client());
    const ok = hasClient
      ? await activateWorkspace(workspaceId)
      : await startHost({ workspacePath, navigate: false });

    if (!ok) {
      return false;
    }

    await openEmptySession(activeWorkspaceRoot().trim() || workspacePath);
    return true;
  };

  async function createWorkspaceFlow(preset: WorkspacePreset, folder: string | null): Promise<boolean> {
    if (!isTauriRuntime()) {
      options.setError(t("app.error.tauri_required", currentLocale()));
      return false;
    }

    if (!folder) {
      options.setError(t("app.error.choose_folder", currentLocale()));
      return false;
    }

    options.setBusy(true);
    options.setBusyLabel("status.creating_workspace");
    options.setBusyStartedAt(Date.now());
    options.setError(null);

    try {
      const resolvedFolder = await resolveWorkspacePath(folder);
      if (!resolvedFolder) {
        options.setError(t("app.error.choose_folder", currentLocale()));
        return false;
      }

      const name = resolvedFolder.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "Worker";
      const ws = await workspaceCreate({ folderPath: resolvedFolder, name, preset });
      setWorkspaces(ws.workspaces);
      syncActiveWorkspaceId(ws.activeId);
      if (ws.activeId) {
        updateWorkspaceConnectionState(ws.activeId, { status: "connected", message: null });
      }

      setCreateWorkspaceOpen(false);
      markOnboardingComplete();

      const opened = await activateFreshLocalWorkspace(ws.activeId ?? null, resolvedFolder);
      if (!opened) {
        return false;
      }

      return true;
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      options.setError(addOpencodeCacheHint(message));
      return false;
    } finally {
      options.setBusy(false);
      options.setBusyLabel(null);
      options.setBusyStartedAt(null);
    }
  }

  async function createRemoteWorkspaceFlow(input: {
    openworkHostUrl?: string | null;
    openworkToken?: string | null;
    directory?: string | null;
    displayName?: string | null;
    manageBusy?: boolean;
    closeModal?: boolean;

    // Sandbox lifecycle metadata (desktop-managed)
    sandboxBackend?: "servicehub" | null;
  }) {
    if (createRemoteInFlight) {
      wsDebug("create-remote:dedupe", {
        hostUrl: input.openworkHostUrl ?? null,
        directory: input.directory ?? null,
      });
      return createRemoteInFlight;
    }

    const run = (async () => {
    const hostUrl = normalizeOpenworkServerUrl(input.openworkHostUrl ?? "") ?? "";
    const token = input.openworkToken?.trim() ?? "";
    const directory = input.directory?.trim() ?? "";
    const displayName = input.displayName?.trim() || null;

    if (!hostUrl) {
      options.setError(t("app.error.remote_base_url_required", currentLocale()));
      return false;
    }

    options.setError(null);

    options.setStartupPreference("server");

    let remoteType: "openwork" = "openwork";
    let resolvedBaseUrl = "";
    let resolvedDirectory = directory;
    let openworkWorkspace: OpenworkWorkspaceInfo | null = null;
    let resolvedAuth: OpencodeAuth | undefined = undefined;
    let resolvedHostUrl = hostUrl;

    options.updateOpenworkServerSettings({
      ...options.openworkServerSettings(),
      urlOverride: hostUrl,
      token: token || undefined,
    });

    try {
      const resolved = await resolveOpenworkHostWithRetry(
        {
          hostUrl,
          token,
          directoryHint: directory || null,
        },
        {
          // A managed sandbox has its own host-URL fallback below, so it does
          // not need the boot-race retry; only the plain remote-connect path
          // (which otherwise hard-disconnects) does.
          //
          // This opt-out only behaves as written now that the create-new
          // caller actually tags the flow (see onBackendTokenRefresh): before
          // that, a managed sandbox arrived here as `null`, skipped the
          // fallback below, and depended entirely on this retry. The two
          // mechanisms are complementary - retry covers an untagged/user
          // remote host, the fallback covers the tagged managed sandbox.
          budgetMs: canFallBackToSandboxHost(input.sandboxBackend) ? 0 : undefined,
          onRetry: ({ attempt, delayMs, reason }) => {
            uiLogWarn("runtime.connect", "Retrying openwork host resolution", {
              hostUrl,
              sandboxBackend: input.sandboxBackend ?? null,
              attempt,
              delayMs,
              reason,
            });
          },
        },
      );

      if (resolved.kind === "openwork") {
        resolvedBaseUrl = resolved.opencodeBaseUrl;
        resolvedDirectory = resolved.directory || directory;
        openworkWorkspace = resolved.workspace;
        resolvedHostUrl = resolved.hostUrl;
        resolvedAuth = resolved.auth;
      } else if (canFallBackToSandboxHost(input.sandboxBackend)) {
        resolvedHostUrl = hostUrl;
        resolvedBaseUrl = `${hostUrl.replace(/\/+$/, "")}/opencode`;
        resolvedDirectory = directory || resolvedDirectory;
        resolvedAuth = token ? { token, mode: "openwork" } : undefined;
        // Persisted (not just wsDebug/console) because this is the branch that
        // rescues a managed sandbox whose listWorkspaces isn't serving yet. When
        // it is missing from the logs but the "did not return a usable
        // workspace" warning is present, the caller forgot to tag the flow with
        // sandboxBackend:"servicehub" - exactly the startup-disconnect regression.
        uiLogInfo("runtime.connect", "Sandbox host fallback engaged for workspace resolution", {
          hostUrl,
          sandboxBackend: input.sandboxBackend ?? null,
          baseUrl: resolvedBaseUrl,
          resolvedKind: resolved.kind,
        });
        wsDebug("sandbox:openwork-resolve-fallback:host", {
          hostUrl: resolvedHostUrl,
          baseUrl: resolvedBaseUrl,
          directory: resolvedDirectory,
        });
      } else {
        uiLogWarn("runtime.connect", "Openwork host resolution did not return a usable workspace", {
          hostUrl,
          sandboxBackend: input.sandboxBackend ?? null,
          resolvedKind: resolved.kind,
        });
        options.setError("SuperClaw server unavailable. Check the URL and token.");
        return false;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : safeStringify(error);
      uiLogError("runtime.connect", "Openwork host resolution failed", {
        hostUrl,
        sandboxBackend: input.sandboxBackend ?? null,
        message,
      });
      options.setError(addOpencodeCacheHint(message));
      return false;
    }

    if (!resolvedBaseUrl) {
      options.setError(t("app.error.remote_base_url_required", currentLocale()));
      return false;
    }

    const ok = await connectToServer(
      resolvedBaseUrl,
      resolvedDirectory || undefined,
      {
        workspaceType: "remote",
        targetRoot: resolvedDirectory ?? "",
        reason: "workspace-create-remote",
      },
      resolvedAuth,
    );

    if (!ok) {
      return false;
    }

    const finalDirectory = options.clientDirectory().trim() || resolvedDirectory || "";

    const manageBusy = input.manageBusy ?? true;
    if (manageBusy) {
      options.setBusy(true);
      options.setBusyLabel("status.creating_workspace");
      options.setBusyStartedAt(Date.now());
    }

    try {
      if (isTauriRuntime()) {
        const ws = await workspaceCreateRemote({
          baseUrl: resolvedBaseUrl.replace(/\/+$/, ""),
          directory: finalDirectory ? finalDirectory : null,
          displayName,
          remoteType,
          openworkHostUrl: resolvedHostUrl,
          openworkToken: token || null,
          openworkWorkspaceId: openworkWorkspace?.id ?? null,
          openworkWorkspaceName: openworkWorkspace?.name ?? null,
          sandboxBackend: input.sandboxBackend ?? null,
        });
        setWorkspaces(ws.workspaces);
        syncActiveWorkspaceId(ws.activeId);
      } else {
        const workspaceId = `remote:${resolvedBaseUrl}:${finalDirectory}`;
        const nextWorkspace: WorkspaceInfo = {
          id: workspaceId,
          name: displayName ?? openworkWorkspace?.name ?? resolvedHostUrl ?? resolvedBaseUrl,
          path: "",
          preset: "remote",
          workspaceType: "remote",
          remoteType,
          baseUrl: resolvedBaseUrl,
          directory: finalDirectory || null,
          displayName,
          openworkHostUrl: resolvedHostUrl,
          openworkToken: token || null,
          openworkWorkspaceId: openworkWorkspace?.id ?? null,
          openworkWorkspaceName: openworkWorkspace?.name ?? null,
          sandboxBackend: input.sandboxBackend ?? null,
        };

        setWorkspaces((prev) => {
          const withoutMatch = prev.filter((workspace) => workspace.id !== workspaceId);
          return [...withoutMatch, nextWorkspace];
        });
        syncActiveWorkspaceId(workspaceId);
      }

      setProjectDir(finalDirectory);
      setWorkspaceConfig(null);
      setWorkspaceConfigLoaded(true);
      setAuthorizedDirs([]);

      const closeModal = input.closeModal ?? true;
      if (closeModal) {
        setCreateWorkspaceOpen(false);
        setCreateRemoteWorkspaceOpen(false);
      }
      const activeId = activeWorkspaceId();
      if (activeId) {
        updateWorkspaceConnectionState(activeId, { status: "connected", message: null });
      }

      await openEmptySession(activeWorkspaceRoot().trim() || finalDirectory);
      return true;
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      options.setError(addOpencodeCacheHint(message));
      return false;
    } finally {
      if (manageBusy) {
        options.setBusy(false);
        options.setBusyLabel(null);
        options.setBusyStartedAt(null);
      }
    }
    })();

    createRemoteInFlight = run;
    try {
      return await run;
    } finally {
      if (createRemoteInFlight === run) {
        createRemoteInFlight = null;
      }
    }
  }

  async function updateRemoteWorkspaceFlow(
    workspaceId: string,
    input: {
      openworkHostUrl?: string | null;
      openworkToken?: string | null;
      directory?: string | null;
      displayName?: string | null;
    },
  ) {
    const id = workspaceId.trim();
    if (!id) return false;
    const workspace = workspaces().find((item) => item.id === id) ?? null;
    if (!workspace || workspace.workspaceType !== "remote") return false;

    const remoteType = normalizeRemoteType(workspace.remoteType);
    if (remoteType !== "openwork") {
      options.setError("Only OpenWork remote workers can be edited.");
      return false;
    }

    const hostUrl =
      normalizeOpenworkServerUrl(
        input.openworkHostUrl ?? workspace.openworkHostUrl ?? workspace.baseUrl ?? "",
      ) ?? "";
    const token =
      input.openworkToken?.trim() ??
      workspace.openworkToken?.trim() ??
      options.openworkServerSettings().token ??
      "";
    const directory = input.directory?.trim() ?? "";
    const displayName = input.displayName?.trim() || null;

    if (!hostUrl) {
      options.setError(t("app.error.remote_base_url_required", currentLocale()));
      return false;
    }

    options.setError(null);
    options.setStartupPreference("server");

    let resolvedBaseUrl = "";
    let resolvedDirectory = directory;
    let openworkWorkspace: OpenworkWorkspaceInfo | null = null;
    let resolvedAuth: OpencodeAuth | undefined = undefined;
    let resolvedHostUrl = hostUrl;

    options.updateOpenworkServerSettings({
      ...options.openworkServerSettings(),
      urlOverride: hostUrl,
      token: token || undefined,
    });

    try {
      const resolved = await resolveOpenworkHost({
        hostUrl,
        token,
        workspaceId: workspace.openworkWorkspaceId ?? null,
        directoryHint: directory || null,
      });
      if (resolved.kind !== "openwork") {
        options.setError("SuperClaw server unavailable. Check the URL and token.");
        return false;
      }
      resolvedBaseUrl = resolved.opencodeBaseUrl;
      resolvedDirectory = resolved.directory || directory;
      openworkWorkspace = resolved.workspace;
      resolvedHostUrl = resolved.hostUrl;
      resolvedAuth = resolved.auth;
    } catch (error) {
      const message = error instanceof Error ? error.message : safeStringify(error);
      options.setError(addOpencodeCacheHint(message));
      return false;
    }

    if (!resolvedBaseUrl) {
      options.setError(t("app.error.remote_base_url_required", currentLocale()));
      return false;
    }

    const isActive = activeWorkspaceId() === id;
    const finalDirectory = resolvedDirectory || "";

    if (isActive) {
      updateWorkspaceConnectionState(id, { status: "connecting", message: null });
      const ok = await connectToServer(
        resolvedBaseUrl,
        finalDirectory || undefined,
        {
          workspaceId: id,
          workspaceType: "remote",
          targetRoot: finalDirectory ?? "",
          reason: "workspace-edit-remote",
        },
        resolvedAuth,
      );
      if (!ok) {
        updateWorkspaceConnectionState(id, {
          status: "error",
          message: "Failed to connect to worker.",
        });
        return false;
      }
    }

    if (isTauriRuntime()) {
      try {
        const ws = await workspaceUpdateRemote({
          workspaceId: id,
          remoteType: "openwork",
          baseUrl: resolvedBaseUrl,
          directory: finalDirectory ? finalDirectory : null,
          displayName,
          openworkHostUrl: resolvedHostUrl,
          openworkToken: token ? token : null,
          openworkWorkspaceId: openworkWorkspace?.id ?? workspace.openworkWorkspaceId ?? null,
          openworkWorkspaceName: openworkWorkspace?.name ?? workspace.openworkWorkspaceName ?? null,
        });
        setWorkspaces(ws.workspaces);
        syncActiveWorkspaceId(ws.activeId);
      } catch {
        // ignore
      }
    } else {
      setWorkspaces((prev) =>
        prev.map((item) =>
          item.id === id
            ? {
                ...item,
                remoteType: "openwork",
                baseUrl: resolvedBaseUrl,
                directory: finalDirectory ? finalDirectory : null,
                displayName,
                openworkHostUrl: resolvedHostUrl,
                openworkToken: token ? token : null,
                openworkWorkspaceId: openworkWorkspace?.id ?? item.openworkWorkspaceId ?? null,
                openworkWorkspaceName: openworkWorkspace?.name ?? item.openworkWorkspaceName ?? null,
              }
            : item,
        ),
      );
    }

    if (isActive) {
      setProjectDir(finalDirectory);
      setWorkspaceConfig(null);
      setWorkspaceConfigLoaded(true);
      setAuthorizedDirs([]);
      updateWorkspaceConnectionState(id, { status: "connected", message: null });
    }

    return true;
  }

  const {
    recoverWorkspace,
    exportWorkspaceConfig,
    importWorkspaceConfig,
    repairOpencodeMigration,
  } = createWorkspaceConfigIo({
    options,
    workspaces,
    setWorkspaces,
    activeWorkspaceId,
    activeWorkspaceInfo,
    activeWorkspacePath,
    syncActiveWorkspaceId,
    engine,
    setEngine,
    exportingWorkspaceConfig,
    setExportingWorkspaceConfig,
    importingWorkspaceConfig,
    setImportingWorkspaceConfig,
    migrationRepairBusy,
    setMigrationRepairBusy,
    setMigrationRepairResult,
    connectingWorkspaceId,
    setConnectingWorkspaceId,
    setCreateWorkspaceOpen,
    setCreateRemoteWorkspaceOpen,
    activateFreshLocalWorkspace,
    activateWorkspace,
    startHost,
    testWorkspaceConnection,
    updateWorkspaceConnectionState,
  });

  async function pickWorkspaceFolder() {
    if (!isTauriRuntime()) {
      options.setError(t("app.error.tauri_required", currentLocale()));
      return null;
    }

    try {
      const selection = await pickDirectory({ title: t("onboarding.choose_workspace_folder", currentLocale()) });
      const folder =
        typeof selection === "string" ? selection : Array.isArray(selection) ? selection[0] : null;

      return folder ?? null;
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      options.setError(addOpencodeCacheHint(message));
      return null;
    }
  }

  function canRepairOpencodeMigration() {
    if (!isTauriRuntime()) return false;
    const workspace = activeWorkspaceInfo();
    if (!workspace || workspace.workspaceType !== "local") return false;
    return Boolean(activeWorkspacePath().trim());
  }

  async function onRepairOpencodeMigration() {
    options.setStartupPreference("local");
    options.setOnboardingStep("connecting");
    const ok = await repairOpencodeMigration({ navigate: true });
    if (!ok) {
      options.setOnboardingStep("local");
    }
  }

  async function startHost(optionsOverride?: { workspacePath?: string; navigate?: boolean }) {
    // [Remote-first] Local engine start is disabled — always connect to remote worker.
    options.setError("Local engine is disabled. Connect to a remote worker instead.");
    return false;
    // [Remote-first] Original startHost logic removed — was spawning local engine via Tauri IPC.
    // To restore: revert this function from git history.
  }

  async function updateWorkspaceDisplayName(workspaceId: string, displayName: string | null) {
    const id = workspaceId.trim();
    if (!id) return false;
    const workspace = workspaces().find((item) => item.id === id) ?? null;
    if (!workspace) return false;

    const nextDisplayName = displayName?.trim() || null;
    options.setError(null);

    if (isTauriRuntime()) {
      try {
        const ws = await workspaceUpdateDisplayName({ workspaceId: id, displayName: nextDisplayName });
        setWorkspaces(ws.workspaces);
        if (ws.activeId) {
          updateWorkspaceConnectionState(ws.activeId, { status: "connected", message: null });
        }
        return true;
      } catch (e) {
        const message = e instanceof Error ? e.message : safeStringify(e);
        options.setError(addOpencodeCacheHint(message));
        return false;
      }
    }

    setWorkspaces((prev) =>
      prev.map((entry) =>
        entry.id === id
          ? {
              ...entry,
              displayName: nextDisplayName,
              name: nextDisplayName ?? entry.name,
            }
          : entry
      )
    );
    return true;
  }

  async function persistAuthorizedRoots(nextRoots: string[]) {
    if (!isTauriRuntime()) return;
    if (activeWorkspaceInfo()?.workspaceType === "remote") return;
    const root = activeWorkspacePath().trim();
    if (!root) return;

    const existing = workspaceConfig();
    const cfg: WorkspaceOpenworkConfig = {
      version: existing?.version ?? 1,
      workspace: existing?.workspace ?? null,
      authorizedRoots: nextRoots,
      reload: existing?.reload ?? null,
    };

    await workspaceOpenworkWrite({ workspacePath: root, config: cfg });
    setWorkspaceConfig(cfg);
  }

  async function persistReloadSettings(next: { auto?: boolean; resume?: boolean }) {
    if (!isTauriRuntime()) return;
    if (activeWorkspaceInfo()?.workspaceType === "remote") return;
    const root = activeWorkspacePath().trim();
    if (!root) return;

    const existing = workspaceConfig();
    const cfg: WorkspaceOpenworkConfig = {
      version: existing?.version ?? 1,
      workspace: existing?.workspace ?? null,
      authorizedRoots: Array.isArray(existing?.authorizedRoots) ? existing!.authorizedRoots : authorizedDirs(),
      reload: {
        auto: Boolean(next.auto),
        resume: Boolean(next.resume),
      },
    };

    await workspaceOpenworkWrite({ workspacePath: root, config: cfg });
    setWorkspaceConfig(cfg);
  }

  async function addAuthorizedDir() {
    if (activeWorkspaceInfo()?.workspaceType === "remote") return;
    const next = newAuthorizedDir().trim();
    if (!next) return;

    const roots = normalizeRoots([...authorizedDirs(), next]);
    setAuthorizedDirs(roots);
    setNewAuthorizedDir("");

    try {
      await persistAuthorizedRoots(roots);
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      options.setError(addOpencodeCacheHint(message));
    }
  }

  async function addAuthorizedDirFromPicker(optionsOverride?: { persistToWorkspace?: boolean }) {
    if (!isTauriRuntime()) return;
    if (activeWorkspaceInfo()?.workspaceType === "remote") return;

    try {
      const selection = await pickDirectory({ title: t("onboarding.authorize_folder", currentLocale()) });
      const folder =
        typeof selection === "string" ? selection : Array.isArray(selection) ? selection[0] : null;
      if (!folder) return;

      const roots = normalizeRoots([...authorizedDirs(), folder]);
      setAuthorizedDirs(roots);

      if (optionsOverride?.persistToWorkspace) {
        await persistAuthorizedRoots(roots);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      options.setError(addOpencodeCacheHint(message));
    }
  }

  async function removeAuthorizedDir(dir: string) {
    if (activeWorkspaceInfo()?.workspaceType === "remote") return;
    const roots = normalizeRoots(authorizedDirs().filter((root) => root !== dir));
    setAuthorizedDirs(roots);

    try {
      await persistAuthorizedRoots(roots);
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      options.setError(addOpencodeCacheHint(message));
    }
  }

  function removeAuthorizedDirAtIndex(index: number) {
    const roots = authorizedDirs();
    const target = roots[index];
    if (target) {
      void removeAuthorizedDir(target);
    }
  }

  /**
   * Called when the backend-manager emits a new token (e.g. backend restart).
   * Syncs the token onto existing workspaces and reconnects the active one
   * instead of creating a duplicate workspace.
   */
  async function onBackendTokenRefresh(newToken: string, newUrl: string, trace?: OwtTrace) {
    const operation = trace ?? {
      requestId: makeRunId(),
      attempt: 1,
      tokenCreatedAt: "",
      tokenScope: "",
      tokenRevision: null,
    };
    const startedAt = Date.now();
    uiLogInfo("runtime.owt.sync", "Syncing refreshed workspace token", {
      requestId: operation.requestId,
      attempt: operation.attempt,
      status: "started",
      elapsedMs: 0,
      tokenCreatedAt: operation.tokenCreatedAt,
      tokenScope: operation.tokenScope,
      tokenRevision: operation.tokenRevision,
    });

    // [Startup race fix] Wait for bootstrapOnboarding() to publish the persisted
    // workspace list before deciding between "reactivate existing" and
    // "create new". Without this, a fast owtToken (e.g. reused from the
    // CapabilityStartupResolver Phase C stash) can arrive while workspaces() is
    // still empty, sending a perfectly healthy managed sandbox down the
    // create-new path. Bounded so a stalled bootstrap can't hang the handler.
    if (isTauriRuntime()) {
      const gate = ensureWorkspaceBootstrapGate();
      let timerId: ReturnType<typeof setTimeout> | null = null;
      const settledInTime = await Promise.race([
        gate.then(() => true as const),
        new Promise<false>((resolve) => {
          timerId = setTimeout(() => resolve(false), WORKSPACE_BOOTSTRAP_GATE_TIMEOUT_MS);
        }),
      ]);
      if (timerId) clearTimeout(timerId);
      if (!settledInTime) {
        uiLogWarn("runtime.owt.sync", "Proceeded before workspace bootstrap settled", {
          requestId: operation.requestId,
          attempt: operation.attempt,
          errorCode: "workspace_bootstrap_gate_timeout",
          elapsedMs: Date.now() - startedAt,
          tokenCreatedAt: operation.tokenCreatedAt,
          tokenScope: operation.tokenScope,
          tokenRevision: operation.tokenRevision,
        });
      } else {
        // Proof that the race fix did its job: `waitedMs` > 0 means the token
        // genuinely arrived before bootstrapOnboarding() had published the
        // workspace list, and we blocked instead of misrouting to create-new.
        uiLogInfo("runtime.owt.sync", "Workspace bootstrap settled before token routing", {
          requestId: operation.requestId,
          attempt: operation.attempt,
          status: "succeeded",
          waitedMs: Date.now() - startedAt,
          workspaceCount: workspaces().length,
        });
      }
    }

    // Sync all existing openwork workspaces to the new token. We pass the
    // token explicitly because a reactive effect in app.tsx may revert the
    // global settings signal back to the previous (stale) workspace token
    // before this runs, causing the comparison to skip the patch.
    await syncOpenworkTokens(newToken, operation);

    // After patching workspaces, ensure the global settings signal also
    // reflects the new token. The reactive sync effect in app.tsx will now
    // see the patched workspace token and stop fighting us.
    if (newToken?.trim()) {
      const current = options.openworkServerSettings();
      if (current.token?.trim() !== newToken.trim()) {
        options.updateOpenworkServerSettings({
          ...current,
          urlOverride: newUrl || current.urlOverride,
          token: newToken,
        });
      }
    }

    // If there's an active openwork workspace, reactivate it so it
    // reconnects with the (possibly refreshed) token.  We do this
    // regardless of whether tokens were patched — the workspace may
    // already have the correct token but need reconnection anyway.
    // Prefer the active workspace, but fall back to any existing openwork-remote
    // workspace matching the refreshed URL (see
    // findOpenworkRemoteWorkspaceForTokenRefresh doc comment for why).
    const active = findOpenworkRemoteWorkspaceForTokenRefresh(workspaces(), activeWorkspaceId(), newUrl);
    // Make the routing decision explicit in the persisted log. Previously the
    // create-new branch could only be inferred from the *absence* of a
    // "runtime.owt.activate" line, which made the startup-disconnect triage
    // guesswork.
    uiLogInfo("runtime.owt.route", "Token refresh routing decided", {
      requestId: operation.requestId,
      attempt: operation.attempt,
      route: active ? "activate-existing" : "create-new",
      workspaceId: active?.id ?? null,
      workspaceCount: workspaces().length,
      activeWorkspaceId: activeWorkspaceId() || null,
      hostUrl: newUrl,
    });
    if (active) {
      options.setStartupPreference("server");
      options.setOnboardingStep("connecting");
      uiLogInfo("runtime.owt.activate", "Activating workspace with refreshed token", {
        requestId: operation.requestId,
        workspaceId: active.id,
        attempt: operation.attempt,
        status: "started",
        elapsedMs: Date.now() - startedAt,
        tokenCreatedAt: operation.tokenCreatedAt,
        tokenScope: operation.tokenScope,
        tokenRevision: operation.tokenRevision,
      });
      const ok = await activateWorkspace(active.id, operation);
      uiLogInfo("runtime.owt.activate", "Workspace activation completed", {
        requestId: operation.requestId,
        workspaceId: active.id,
        attempt: operation.attempt,
        status: ok ? "succeeded" : "failed",
        errorCode: ok ? undefined : "workspace_activation_failed",
        elapsedMs: Date.now() - startedAt,
        tokenCreatedAt: operation.tokenCreatedAt,
        tokenScope: operation.tokenScope,
        tokenRevision: operation.tokenRevision,
      });
      if (!ok) {
        options.setOnboardingStep("server");
      }
      return;
    }

    // No existing openwork workspace → create-new flow.
    //
    // ServiceHub-managed desktop runtime (native sandbox_manager).
    // Tag as "servicehub" so resolveOpenworkHost can use the host-level fallback.
    const createNewSandboxBackend: "servicehub" | null = isTauriRuntime()
      ? "servicehub"
      : null;
    uiLogInfo("runtime.owt.route", "Creating workspace for refreshed token", {
      requestId: operation.requestId,
      attempt: operation.attempt,
      sandboxBackend: createNewSandboxBackend,
      hostUrl: newUrl,
    });
    await onConnectClient({ sandboxBackend: createNewSandboxBackend });
  }

  async function bootstrapOnboarding() {
    ensureWorkspaceBootstrapGate();
    try {
      await bootstrapOnboardingBody();
    } finally {
      // Always release the gate, even on early return / throw, so a failed
      // bootstrap can never deadlock onBackendTokenRefresh.
      markWorkspaceBootstrapSettled();
    }
  }

  async function bootstrapOnboardingBody() {
    if (isTauriRuntime()) {
      try {
        const ws = await workspaceBootstrap();
        setWorkspaces(ws.workspaces);
        syncActiveWorkspaceId(ws.activeId);
      } catch {
        // ignore
      }

      // Sync the global settings token onto existing openwork workspaces.
      // When the backend restarts it generates new tokens, but workspace objects
      // loaded from storage still carry the old token.  Updating them here
      // (before any connection attempt) prevents stale-token failures.
      const patched = await syncOpenworkTokens();
    }

    // [Remote-first] Skip local engine refresh — we always connect to a remote worker.
    // await refreshEngine();
    // await refreshEngineDoctor();

    if (isTauriRuntime()) {
      const active = workspaces().find((w) => w.id === activeWorkspaceId()) ?? null;
      if (active) {
        if (active.workspaceType === "remote") {
          setProjectDir(active.directory?.trim() ?? "");
          setWorkspaceConfig(null);
          setWorkspaceConfigLoaded(true);
          setAuthorizedDirs([]);
          if (active.baseUrl) {
            options.setBaseUrl(active.baseUrl);
          }
        }
        // [Remote-first] Skip local workspace config loading — local worker not used.
        // else {
        //   setProjectDir(active.path);
        //   try {
        //     const cfg = await workspaceOpenworkRead({ workspacePath: active.path });
        //     setWorkspaceConfig(cfg);
        //     setWorkspaceConfigLoaded(true);
        //     const roots = Array.isArray(cfg.authorizedRoots) ? cfg.authorizedRoots : [];
        //     setAuthorizedDirs(roots.length ? roots : [active.path]);
        //   } catch {
        //     setWorkspaceConfig(null);
        //     setWorkspaceConfigLoaded(true);
        //     setAuthorizedDirs([active.path]);
        //   }
        // }
      }
    }

    // [Remote-first] Skip local engine baseUrl — not starting a local engine.
    // const info = engine();
    // if (info?.baseUrl) {
    //   options.setBaseUrl(info.baseUrl);
    // }

    const activeWorkspace = activeWorkspaceInfo();
    if (activeWorkspace?.workspaceType === "remote") {
      options.setStartupPreference("server");
      options.setOnboardingStep("connecting");

      // [Backend-ready race fix] In Tauri runtime, an openwork remote workspace
      // is served by the local backend-manager (native sandbox). The backend
      // may not be ready yet on cold start, and the persisted OWT token is
      // typically stale (rotated by every backend restart). Connecting now
      // would either time out or 401, leaving the UI in a "Connection failed"
      // state until the user retries.
      //
      // Defer the connection to the `superclaw://backend-ready` listener in
      // app.tsx, which calls `onBackendTokenRefresh` with the fresh URL/token
      // and reactivates the workspace. The `BackendBootOverlay` keeps the UI
      // in a "starting backend" state during this wait, and surfaces any
      // backend-manager errors via `superclaw://backend-error`.
      const isOpenworkRemote =
        isTauriRuntime() && normalizeRemoteType(activeWorkspace.remoteType) === "openwork";
      if (isOpenworkRemote) {
        return;
      }

      const ok = await activateWorkspace(activeWorkspace.id);
      if (!ok) {
        options.setOnboardingStep("server");
      }
      return;
    }

    // [Remote-first] Always default to "server" mode — skip local engine auto-start.
    options.setStartupPreference("server");
    options.setOnboardingStep("server");

    // --- Original local engine auto-start logic (disabled for remote-first mode) ---
    // if (startupPref) {
    //   options.setStartupPreference(startupPref);
    // }
    //
    // if (startupPref === "server") {
    //   options.setOnboardingStep("server");
    //   return;
    // }
    //
    // if (activeWorkspacePath().trim()) {
    //   options.setStartupPreference("local");
    //
    //   if (info?.running && info.baseUrl) {
    //     options.setOnboardingStep("connecting");
    //     const ok = await connectToServer(
    //       info.baseUrl,
    //       info.projectDir ?? undefined,
    //       { reason: "bootstrap-local" },
    //       engineAuth() ?? undefined,
    //     );
    //     if (!ok) {
    //       options.setStartupPreference(null);
    //       options.setOnboardingStep("welcome");
    //       return;
    //     }
    //     markOnboardingComplete();
    //     return;
    //   }
    //
    //   options.setOnboardingStep("connecting");
    //   const ok = await startHost({ workspacePath: activeWorkspacePath().trim() });
    //   if (!ok) {
    //     options.setOnboardingStep("local");
    //     return;
    //   }
    //   markOnboardingComplete();
    //   return;
    // }
    //
    // if (startupPref === "local") {
    //   options.setOnboardingStep("local");
    //   return;
    // }
    //
    // options.setOnboardingStep("welcome");
  }

  function onSelectStartup(nextPref: StartupPreference) {
    if (options.rememberStartupChoice()) {
      writeStartupPreference(nextPref);
    }
    options.setStartupPreference(nextPref);
    options.setOnboardingStep(nextPref === "local" ? "local" : "server");
  }

  function onBackToWelcome() {
    options.setStartupPreference(null);
    options.setOnboardingStep("welcome");
  }

  async function onStartHost() {
    options.setStartupPreference("local");
    options.setOnboardingStep("connecting");
    const ok = await startHost({ workspacePath: activeWorkspacePath().trim() });
    if (!ok) {
      options.setOnboardingStep("local");
    }
  }

  async function onAttachHost() {
    options.setStartupPreference("local");
    options.setOnboardingStep("connecting");
    const ok = await connectToServer(
      engine()?.baseUrl ?? "",
      engine()?.projectDir ?? undefined,
      { reason: "attach-local" },
      engineAuth() ?? undefined,
    );
    if (!ok) {
      options.setStartupPreference(null);
      options.setOnboardingStep("welcome");
    }
  }

  async function onConnectClient(overrides?: { sandboxBackend?: "servicehub" | null }) {
    options.setStartupPreference("server");
    options.setOnboardingStep("connecting");
    const settings = options.openworkServerSettings();
    const ok = await createRemoteWorkspaceFlow({
      openworkHostUrl: settings.urlOverride ?? null,
      openworkToken: settings.token ?? null,
      directory: options.clientDirectory().trim() ? options.clientDirectory().trim() : null,
      displayName: null,
      sandboxBackend: overrides?.sandboxBackend ?? null,
    });
    if (!ok) {
      options.setOnboardingStep("server");
    }
  }

  function onRememberStartupToggle() {
    if (typeof window === "undefined") return;
    const next = !options.rememberStartupChoice();
    options.setRememberStartupChoice(next);
    try {
      if (next) {
        const current = options.startupPreference();
        if (current === "local" || current === "server") {
          writeStartupPreference(current);
        }
      } else {
        clearStartupPreference();
      }
    } catch {
      // ignore
    }
  }

  return {
    engine,
    engineDoctorResult,
    engineDoctorCheckedAt,
    engineInstallLogs,
    projectDir,
    workspaces,
    activeWorkspaceId,
    authorizedDirs,
    newAuthorizedDir,
    workspaceConfig,
    workspaceConfigLoaded,
    createWorkspaceOpen,
    createRemoteWorkspaceOpen,
    connectingWorkspaceId,
    workspaceConnectionStateById,
    exportingWorkspaceConfig,
    importingWorkspaceConfig,
    migrationRepairBusy,
    migrationRepairResult,
    activeWorkspaceDisplay,
    activeWorkspacePath,
    activeWorkspaceRoot,
    activeWorkspaceSdkDirectory,
    setCreateWorkspaceOpen,
    setCreateRemoteWorkspaceOpen,
    setProjectDir,
    setAuthorizedDirs,
    setNewAuthorizedDir,
    setWorkspaceConfig,
    setWorkspaceConfigLoaded,
    setWorkspaces,
    syncActiveWorkspaceId: syncActiveWorkspaceId,
    refreshEngine,
    refreshEngineDoctor,
    activateWorkspace,
    testWorkspaceConnection,
    connectToServer,
    createWorkspaceFlow,
    createRemoteWorkspaceFlow,
    updateRemoteWorkspaceFlow,
    updateWorkspaceDisplayName,
    recoverWorkspace,
    pickWorkspaceFolder,
    exportWorkspaceConfig,
    importWorkspaceConfig,
    canRepairOpencodeMigration,
    repairOpencodeMigration,
    startHost,
    stopHost,
    reloadWorkspaceEngine,
    bootstrapOnboarding,
    onSelectStartup,
    onBackToWelcome,
    onStartHost,
    onRepairOpencodeMigration,
    onAttachHost,
    onConnectClient,
    onBackendTokenRefresh,
    onRememberStartupToggle,
    onInstallEngine,
    addAuthorizedDir,
    addAuthorizedDirFromPicker,
    removeAuthorizedDir,
    removeAuthorizedDirAtIndex,
    persistReloadSettings,
    setEngineInstallLogs,
    workspaceDebugEvents,
    clearWorkspaceDebugEvents,
  };
}
