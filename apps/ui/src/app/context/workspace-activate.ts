/**
 * `activateWorkspace`, lifted out of `createWorkspaceStore`.
 *
 * This is the store's largest single member: it resolves a workspace's
 * runtime (openwork host, sandbox or local engine), connects to it and
 * publishes the resulting project/session state.
 */
import type { Accessor, Setter } from "solid-js";

import { currentLocale, t } from "../../i18n";
import type {
  EngineRuntime,
  WorkspaceOpenworkConfig,
} from "../types";
import { addOpencodeCacheHint, isTauriRuntime, safeStringify } from "../utils";
import { uiLogInfo, uiLogWarn } from "../lib/log";
import type { OpencodeAuth } from "../lib/opencode";
import type { OpenworkWorkspaceInfo } from "../lib/openwork-server";
import { trackProjectOpened } from "../lib/telemetry";
import {
  engineInfo,
  engineStart,
  engineStop,
  orchestratorWorkspaceActivate,
  workspaceOpenworkRead,
  workspaceSetActive,
  workspaceUpdateRemote,
  type EngineInfo,
  type WorkspaceInfo,
} from "../lib/tauri";
import { normalizeRemoteType } from "./workspace-connection";
import {
  resolveOpenworkHost,
  resolveOpenworkHostWithRetry,
} from "./workspace-openwork-host";
import { classifyWorkspaceError } from "./workspace-policy";
import { makeRunId } from "./workspace-store-helpers";
import type {
  ConnectToServer,
  OwtTrace,
  StartHost,
  UpdateWorkspaceConnectionState,
  WorkspaceStoreOptions,
} from "./workspace-types";

export type WorkspaceActivateDeps = {
  options: WorkspaceStoreOptions;
  wsDebug: (label: string, payload?: unknown) => void;
  workspaces: Accessor<WorkspaceInfo[]>;
  setWorkspaces: Setter<WorkspaceInfo[]>;
  activeWorkspaceId: Accessor<string>;
  syncActiveWorkspaceId: (id: string) => void;
  projectDir: Accessor<string>;
  setProjectDir: Setter<string>;
  authorizedDirs: Accessor<string[]>;
  setAuthorizedDirs: Setter<string[]>;
  setWorkspaceConfig: Setter<WorkspaceOpenworkConfig | null>;
  setWorkspaceConfigLoaded: Setter<boolean>;
  engine: Accessor<EngineInfo | null>;
  setEngine: Setter<EngineInfo | null>;
  setEngineAuth: Setter<OpencodeAuth | null>;
  setConnectingWorkspaceId: Setter<string | null>;
  resolveEngineRuntime: () => EngineRuntime;
  resolveWorkspacePaths: () => string[];
  activateOpenworkHostWorkspace: (workspacePath: string) => Promise<void>;
  startHost: StartHost;
  connectToServer: ConnectToServer;
  updateWorkspaceConnectionState: UpdateWorkspaceConnectionState;
};

export function createWorkspaceActivate(deps: WorkspaceActivateDeps) {
  const {
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
  } = deps;

  async function activateWorkspace(workspaceId: string, trace?: OwtTrace) {
    const id = workspaceId.trim();
    if (!id) return false;

    const next = workspaces().find((w) => w.id === id) ?? null;
    if (!next) return false;
    const isRemote = next.workspaceType === "remote";
    const activateStart = Date.now();
    wsDebug("activate:start", {
      id: next.id,
      type: next.workspaceType,
      remoteType: next.remoteType ?? null,
      prevActiveId: activeWorkspaceId(),
      prevProjectDir: projectDir(),
      startupPref: options.startupPreference(),
      hasClient: Boolean(options.client()),
    });

    const remoteType = isRemote ? normalizeRemoteType(next.remoteType) : "opencode";
    const baseUrl = isRemote ? next.baseUrl?.trim() ?? "" : "";
    const emitProjectOpened = () => {
      void trackProjectOpened(isRemote ? "remote" : "local");
    };

    setConnectingWorkspaceId(id);
    updateWorkspaceConnectionState(id, { status: "connecting", message: null });

    // Allow the UI to paint the "switching" state before we kick off work that can
    // trigger expensive reactive updates (e.g. sidebar session refreshes).
    if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    }

    try {
      if (isRemote) {
        options.setStartupPreference("server");

        if (remoteType === "openwork") {
          const hostUrl = next.openworkHostUrl?.trim() ?? "";
          if (!hostUrl) {
            options.setError("SuperClaw server URL is required.");
            updateWorkspaceConnectionState(id, {
              status: "error",
              message: "SuperClaw server URL is required.",
            });
            return false;
          }

          const workspaceToken = next.openworkToken?.trim() ?? "";
          const fallbackToken = options.openworkServerSettings().token ?? "";
          const token = workspaceToken || fallbackToken;
          const canRetryWithGlobal = fallbackToken && workspaceToken && fallbackToken !== workspaceToken;

          // Observability for the reload-disconnect investigation: which token
          // does activate use? After a webview reload the in-memory global
          // token is empty, so a "workspace" source means we're about to try a
          // possibly-stale persisted token (the 401/403 fatal-path hazard).
          uiLogInfo("runtime.owt.health", "activate token source", {
            workspaceId: id,
            source: workspaceToken ? "workspace" : fallbackToken ? "global" : "none",
            hasWorkspaceToken: Boolean(workspaceToken),
            hasGlobalToken: Boolean(fallbackToken),
            canRetryWithGlobal: Boolean(canRetryWithGlobal),
            requestId: trace?.requestId ?? null,
          });

          const currentSettings = options.openworkServerSettings();
          if (
            currentSettings.urlOverride?.trim() !== hostUrl ||
            (token && currentSettings.token?.trim() !== token)
          ) {
            options.updateOpenworkServerSettings({
              ...currentSettings,
              urlOverride: hostUrl,
              token: token || currentSettings.token,
            });
          }

          let resolvedBaseUrl = baseUrl;
          let resolvedDirectory = next.directory?.trim() ?? "";
          let workspaceInfo: OpenworkWorkspaceInfo | null = null;
          let resolvedAuth: OpencodeAuth | undefined = undefined;

          try {
            if (trace) {
              uiLogInfo("runtime.owt.health", "Checking workspace health", {
                requestId: trace.requestId,
                workspaceId: id,
                attempt: trace.attempt,
                status: "started",
                elapsedMs: Date.now() - activateStart,
                tokenCreatedAt: trace.tokenCreatedAt,
                tokenScope: trace.tokenScope,
                tokenRevision: trace.tokenRevision,
              });
            }
            let resolved = await resolveOpenworkHostWithRetry(
              {
                hostUrl,
                token,
                workspaceId: next.openworkWorkspaceId ?? null,
                directoryHint: next.directory ?? null,
              },
              {
                onRetry: ({ attempt, delayMs, reason }) => {
                  if (!trace) return;
                  uiLogWarn("runtime.owt.health", "Retrying workspace health check", {
                    requestId: trace.requestId,
                    workspaceId: id,
                    attempt,
                    delayMs,
                    reason,
                    elapsedMs: Date.now() - activateStart,
                  });
                },
              },
            );
            // If the workspace-level token is stale, retry with the global settings token.
            if (resolved.kind !== "openwork" && canRetryWithGlobal) {
              resolved = await resolveOpenworkHost({
                hostUrl,
                token: fallbackToken,
                workspaceId: next.openworkWorkspaceId ?? null,
                directoryHint: next.directory ?? null,
              });
            }
            if (resolved.kind !== "openwork") {
              if (trace) {
                uiLogWarn("runtime.owt.health", "Workspace health check failed", {
                  requestId: trace.requestId,
                  workspaceId: id,
                  attempt: trace.attempt,
                  status: "failed",
                  errorCode: "network_unreachable",
                  elapsedMs: Date.now() - activateStart,
                  tokenCreatedAt: trace.tokenCreatedAt,
                  tokenScope: trace.tokenScope,
                  tokenRevision: trace.tokenRevision,
                });
              }
              options.setError("SuperClaw server unavailable. Check the URL and token.");
              updateWorkspaceConnectionState(id, {
                status: "error",
                message: "SuperClaw server unavailable. Check the URL and token.",
              });
              return false;
            }

            resolvedBaseUrl = resolved.opencodeBaseUrl;
            resolvedDirectory = resolved.directory;
            workspaceInfo = resolved.workspace;
            resolvedAuth = resolved.auth;
            if (trace) {
              uiLogInfo("runtime.owt.health", "Workspace health check completed", {
                requestId: trace.requestId,
                workspaceId: id,
                attempt: trace.attempt,
                status: "succeeded",
                elapsedMs: Date.now() - activateStart,
                tokenCreatedAt: trace.tokenCreatedAt,
                tokenScope: trace.tokenScope,
                tokenRevision: trace.tokenRevision,
              });
            }
          } catch (error) {
            // If the workspace-level token caused a rejection, retry with the global token.
            if (canRetryWithGlobal) {
              try {
                const resolved = await resolveOpenworkHost({
                  hostUrl,
                  token: fallbackToken,
                  workspaceId: next.openworkWorkspaceId ?? null,
                  directoryHint: next.directory ?? null,
                });
                if (resolved.kind === "openwork") {
                  resolvedBaseUrl = resolved.opencodeBaseUrl;
                  resolvedDirectory = resolved.directory;
                  workspaceInfo = resolved.workspace;
                  resolvedAuth = resolved.auth;
                  // Fall through to continue with resolved values
                } else {
                  options.setError("SuperClaw server unavailable. Check the URL and token.");
                  updateWorkspaceConnectionState(id, {
                    status: "error",
                    message: "SuperClaw server unavailable. Check the URL and token.",
                  });
                  return false;
                }
              } catch (retryError) {
                const classified = classifyWorkspaceError(retryError);
                uiLogWarn("workspace.health", "Workspace health check failed", {
                  requestId: trace?.requestId ?? makeRunId(),
                  workspaceId: id,
                  attempt: trace?.attempt ?? 1,
                  status: "failed",
                  errorCode: classified.code,
                  elapsedMs: Date.now() - activateStart,
                  tokenCreatedAt: trace?.tokenCreatedAt ?? "",
                  tokenScope: trace?.tokenScope ?? "",
                  tokenRevision: trace?.tokenRevision ?? null,
                });
                options.setError(addOpencodeCacheHint(classified.message));
                updateWorkspaceConnectionState(id, { status: "error", message: classified.message });
                return false;
              }
            } else {
              const classified = classifyWorkspaceError(error);
              uiLogWarn("workspace.health", "Workspace health check failed", {
                requestId: trace?.requestId ?? makeRunId(),
                workspaceId: id,
                attempt: trace?.attempt ?? 1,
                status: "failed",
                errorCode: classified.code,
                elapsedMs: Date.now() - activateStart,
                tokenCreatedAt: trace?.tokenCreatedAt ?? "",
                tokenScope: trace?.tokenScope ?? "",
                tokenRevision: trace?.tokenRevision ?? null,
              });
              options.setError(addOpencodeCacheHint(classified.message));
              updateWorkspaceConnectionState(id, { status: "error", message: classified.message });
              return false;
            }
          }

          if (!resolvedBaseUrl) {
            options.setError(t("app.error.remote_base_url_required", currentLocale()));
            updateWorkspaceConnectionState(id, {
              status: "error",
              message: "Remote base URL is required.",
            });
            return false;
          }

          const ok = await connectToServer(
            resolvedBaseUrl,
            resolvedDirectory || undefined,
            {
              workspaceId: next.id,
              workspaceType: next.workspaceType,
              targetRoot: resolvedDirectory ?? "",
              reason: "workspace-switch-openwork",
            },
            resolvedAuth,
            { navigate: false },
          );

          if (!ok) {
            updateWorkspaceConnectionState(id, {
              status: "error",
              message: "Failed to connect to worker.",
            });
            return false;
          }

          if (isTauriRuntime()) {
            try {
              const ws = await workspaceUpdateRemote({
                workspaceId: next.id,
                remoteType: "openwork",
                baseUrl: resolvedBaseUrl,
                directory: resolvedDirectory || null,
                openworkHostUrl: hostUrl,
                openworkToken: token ? token : null,
                openworkWorkspaceId: workspaceInfo?.id ?? next.openworkWorkspaceId ?? null,
                openworkWorkspaceName: workspaceInfo?.name ?? next.openworkWorkspaceName ?? null,
              });
              setWorkspaces(ws.workspaces);
              syncActiveWorkspaceId(ws.activeId);
            } catch {
              // ignore
            }
          } else {
            // In web mode, we still need to persist the resolved OpenWork connection
            // details onto the workspace entry so that the sidebar can list sessions
            // for multiple remotes at once (without relying on global server settings).
            const resolvedToken = token.trim();
            setWorkspaces((prev) =>
              prev.map((ws) => {
                if (ws.id !== next.id) return ws;
                return {
                  ...ws,
                  remoteType: "openwork",
                  baseUrl: resolvedBaseUrl.replace(/\/+$/, ""),
                  directory: resolvedDirectory || null,
                  openworkHostUrl: hostUrl,
                  openworkToken: resolvedToken || null,
                  openworkWorkspaceId: workspaceInfo?.id ?? ws.openworkWorkspaceId ?? null,
                  openworkWorkspaceName: workspaceInfo?.name ?? ws.openworkWorkspaceName ?? null,
                };
              }),
            );
          }

          syncActiveWorkspaceId(id);
          setProjectDir(resolvedDirectory || "");
          setWorkspaceConfig(null);
          setWorkspaceConfigLoaded(true);
          setAuthorizedDirs([]);

          if (isTauriRuntime()) {
            try {
              await workspaceSetActive(id);
            } catch {
              // ignore
            }
          }

          updateWorkspaceConnectionState(id, { status: "connected", message: null });
          emitProjectOpened();
          return true;
        }

        if (!baseUrl) {
          options.setError(t("app.error.remote_base_url_required", currentLocale()));
          updateWorkspaceConnectionState(id, {
            status: "error",
            message: "Remote base URL is required.",
          });
          return false;
        }

        const ok = await connectToServer(
          baseUrl,
          next.directory?.trim() || undefined,
          {
            workspaceId: next.id,
            workspaceType: next.workspaceType,
            targetRoot: next.directory?.trim() ?? "",
            reason: "workspace-switch-direct",
          },
          undefined,
          { navigate: false },
        );

        if (!ok) {
          updateWorkspaceConnectionState(id, {
            status: "error",
            message: "Failed to connect to worker.",
          });
          return false;
        }

        syncActiveWorkspaceId(id);
        setProjectDir(next.directory?.trim() ?? "");
        setWorkspaceConfig(null);
        setWorkspaceConfigLoaded(true);
        setAuthorizedDirs([]);

        if (isTauriRuntime()) {
          try {
            await workspaceSetActive(id);
          } catch {
            // ignore
          }
        }

        updateWorkspaceConnectionState(id, { status: "connected", message: null });
        wsDebug("activate:remote:done", { id, ms: Date.now() - activateStart });
        emitProjectOpened();
        return true;
      }

    const wasLocalConnection = options.startupPreference() === "local" && options.client();
    options.setStartupPreference("local");
    const nextRoot = next.path;
    const oldWorkspacePath = projectDir();
    const workspaceChanged = oldWorkspacePath !== nextRoot;

    wsDebug("activate:local:prep", {
      id,
      nextRoot,
      workspaceChanged,
      wasLocalConnection: Boolean(wasLocalConnection),
      prevProjectDir: oldWorkspacePath,
    });

    syncActiveWorkspaceId(id);
    setProjectDir(nextRoot);

    if (isTauriRuntime()) {
      setWorkspaceConfigLoaded(false);
      try {
        const cfg = await workspaceOpenworkRead({ workspacePath: next.path });
        setWorkspaceConfig(cfg);
        setWorkspaceConfigLoaded(true);

        const roots = Array.isArray(cfg.authorizedRoots) ? cfg.authorizedRoots : [];
        if (roots.length) {
          setAuthorizedDirs(roots);
        } else {
          setAuthorizedDirs([next.path]);
        }
      } catch {
        setWorkspaceConfig(null);
        setWorkspaceConfigLoaded(true);
        setAuthorizedDirs([next.path]);
      }

      try {
        await workspaceSetActive(id);
      } catch {
        // ignore
      }
    } else if (!isRemote) {
      if (!authorizedDirs().includes(next.path)) {
        const merged = authorizedDirs().length ? authorizedDirs().slice() : [];
        if (!merged.includes(next.path)) merged.push(next.path);
        setAuthorizedDirs(merged);
      }
    }

    // If we were previously connected to a remote engine, switching back to a local workspace
    // requires starting (or reconnecting) the local host engine.
    //
    // Without this, we end up keeping the remote client while `startupPreference` flips to
    // "local", and subsequent session/file actions behave inconsistently.
    if (!isRemote && options.client() && !wasLocalConnection) {
      wsDebug("activate:remote->local:reconnect", {
        id,
        nextPath: next.path,
        engine: engine()?.baseUrl ?? null,
        engineRunning: Boolean(engine()?.running),
      });
      options.setSelectedSessionId(null);
      options.setMessages([]);
      options.setTodos([]);
      options.setPendingPermissions([]);
      options.setSessionStatusById({});

      // If a local host engine is already running (common when bouncing between remote/local),
      // reuse it instead of restarting to keep switching snappy.
      let connectedToLocalHost = false;
      const existingEngine = engine();
      const runtime = existingEngine?.runtime ?? resolveEngineRuntime();
      const canReuseHost =
        isTauriRuntime() &&
        Boolean(existingEngine?.running && existingEngine.baseUrl);

      wsDebug("activate:remote->local:hostReuse", {
        canReuseHost,
        runtime,
        existingEngineBaseUrl: existingEngine?.baseUrl ?? null,
        existingEngineProjectDir: existingEngine?.projectDir ?? null,
      });

      if (canReuseHost && runtime === "openwork-orchestrator") {
        try {
          const reuseStart = Date.now();
          await orchestratorWorkspaceActivate({
            workspacePath: next.path,
            name: next.displayName?.trim() || next.name?.trim() || null,
          });
          await activateOpenworkHostWorkspace(next.path);

          const nextInfo = await engineInfo();
          setEngine(nextInfo);

          const username = nextInfo.opencodeUsername?.trim() ?? "";
          const password = nextInfo.opencodePassword?.trim() ?? "";
          const auth = username && password ? { username, password } : undefined;
          setEngineAuth(auth ?? null);

          if (nextInfo.baseUrl) {
            connectedToLocalHost = await connectToServer(
              nextInfo.baseUrl,
              nextInfo.projectDir ?? undefined,
              { reason: "workspace-attach-local" },
              auth,
              { navigate: false },
            );
          }
          wsDebug("activate:remote->local:reuseHost:done", {
            ok: connectedToLocalHost,
            ms: Date.now() - reuseStart,
          });
        } catch {
          connectedToLocalHost = false;
          wsDebug("activate:remote->local:reuseHost:error");
        }
      }

      if (!connectedToLocalHost) {
        const startHostAt = Date.now();
        const ok = await startHost({ workspacePath: next.path, navigate: false });
        wsDebug("activate:remote->local:startHost:done", { ok, ms: Date.now() - startHostAt });
        if (!ok) {
          updateWorkspaceConnectionState(id, {
            status: "error",
            message: "Failed to start local engine.",
          });
          return false;
        }
      }
    }

    // When running locally, restart the engine when workspace changes
    if (!isRemote && wasLocalConnection && workspaceChanged) {
      wsDebug("activate:local->local:restartEngine", { id, nextPath: next.path });
      options.setError(null);
      options.setBusy(true);
      options.setBusyLabel("status.restarting_engine");
      options.setBusyStartedAt(Date.now());

      try {
        const runtime = resolveEngineRuntime();
        if (runtime === "openwork-orchestrator") {
          await orchestratorWorkspaceActivate({
            workspacePath: next.path,
            name: next.displayName?.trim() || next.name?.trim() || null,
          });
          await activateOpenworkHostWorkspace(next.path);

          const newInfo = await engineInfo();
          setEngine(newInfo);

          const username = newInfo.opencodeUsername?.trim() ?? "";
          const password = newInfo.opencodePassword?.trim() ?? "";
          const auth = username && password ? { username, password } : undefined;
          setEngineAuth(auth ?? null);

            if (newInfo.baseUrl) {
              const ok = await connectToServer(
                newInfo.baseUrl,
                newInfo.projectDir ?? undefined,
                { reason: "workspace-orchestrator-switch" },
                auth,
                { navigate: false },
              );
              if (!ok) {
                options.setError("Failed to reconnect after worker switch");
              }
            }
        } else {
          // Stop the current engine
          const info = await engineStop();
          setEngine(info);

          // Start engine with new workspace directory
          const newInfo = await engineStart(next.path, {
            preferSidecar: options.engineSource() === "sidecar",
            opencodeBinPath:
              options.engineSource() === "custom" ? options.engineCustomBinPath?.().trim() || null : null,
            runtime,
            workspacePaths: resolveWorkspacePaths(),
          });
          setEngine(newInfo);

          const username = newInfo.opencodeUsername?.trim() ?? "";
          const password = newInfo.opencodePassword?.trim() ?? "";
          const auth = username && password ? { username, password } : undefined;
          setEngineAuth(auth ?? null);

          // Reconnect to server
            if (newInfo.baseUrl) {
              const ok = await connectToServer(
                newInfo.baseUrl,
                newInfo.projectDir ?? undefined,
                { reason: "workspace-restart" },
                auth,
                { navigate: false },
              );
              if (!ok) {
                options.setError("Failed to reconnect after worker switch");
              }
            }
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : safeStringify(e);
        options.setError(addOpencodeCacheHint(message));
      } finally {
        options.setBusy(false);
        options.setBusyLabel(null);
        options.setBusyStartedAt(null);
      }
    }

      options.refreshSkills({ force: true }).catch(() => undefined);
      options.refreshPlugins().catch(() => undefined);
      updateWorkspaceConnectionState(id, { status: "connected", message: null });
      wsDebug("activate:local:done", { id, ms: Date.now() - activateStart });
      emitProjectOpened();
      return true;
    } finally {
      setConnectingWorkspaceId(null);
      wsDebug("activate:finally", { id, ms: Date.now() - activateStart });
    }
  }

  return { activateWorkspace };
}
