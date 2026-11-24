/**
 * Engine lifecycle - refresh, stop, reload and install -
 * lifted out of `createWorkspaceStore`.
 *
 * `lastEngineReconnectAt` and `reconnectingEngine` move here with the slice:
 * `refreshEngine` is their only reader and writer, so the state is not split.
 */
import type { Accessor, Setter } from "solid-js";

import { currentLocale, t } from "../../i18n";
import type { EngineRuntime, WorkspaceDisplay } from "../types";
import { addOpencodeCacheHint, isTauriRuntime, safeStringify } from "../utils";
import type { OpencodeAuth } from "../lib/opencode";
import {
  engineInfo,
  engineInstall,
  engineStart,
  engineStop,
  orchestratorInstanceDispose,
  orchestratorWorkspaceActivate,
  type EngineInfo,
  type WorkspaceInfo,
} from "../lib/tauri";
import type {
  ConnectToServer,
  WorkspaceStoreOptions,
} from "./workspace-types";

export type WorkspaceEngineDeps = {
  options: WorkspaceStoreOptions;
  engine: Accessor<EngineInfo | null>;
  setEngine: Setter<EngineInfo | null>;
  setEngineAuth: Setter<OpencodeAuth | null>;
  setEngineInstallLogs: Setter<string | null>;
  setProjectDir: Setter<string>;
  activeWorkspaceInfo: Accessor<WorkspaceInfo | null>;
  activeWorkspaceDisplay: Accessor<WorkspaceDisplay>;
  activeWorkspacePath: Accessor<string>;
  resolveEngineRuntime: () => EngineRuntime;
  resolveWorkspacePaths: () => string[];
  refreshEngineDoctor: () => Promise<void>;
  connectToServer: ConnectToServer;
};

export function createWorkspaceEngine(deps: WorkspaceEngineDeps) {
  const {
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
  } = deps;

  let lastEngineReconnectAt = 0;
  let reconnectingEngine = false;

  async function refreshEngine() {
    if (!isTauriRuntime()) return;

    try {
      const info = await engineInfo();
      setEngine(info);

      const isRemoteWorkspace = activeWorkspaceInfo()?.workspaceType === "remote";
      const syncLocalState = !isRemoteWorkspace;

      const username = info.opencodeUsername?.trim() ?? "";
      const password = info.opencodePassword?.trim() ?? "";
      const auth = username && password ? { username, password } : null;
      setEngineAuth(auth);

      if (info.projectDir && syncLocalState) {
        setProjectDir(info.projectDir);
      }
      if (info.baseUrl && syncLocalState) {
        options.setBaseUrl(info.baseUrl);
      }

      if (
        syncLocalState &&
        info.running &&
        info.baseUrl &&
        !options.client() &&
        !reconnectingEngine
      ) {
        const now = Date.now();
        if (now - lastEngineReconnectAt > 10_000) {
          lastEngineReconnectAt = now;
          reconnectingEngine = true;
          connectToServer(
            info.baseUrl,
            info.projectDir ?? undefined,
            { reason: "engine-refresh" },
            auth ?? undefined,
            { quiet: true, navigate: false },
          )
            .catch(() => undefined)
            .finally(() => {
              reconnectingEngine = false;
            });
        }
      }
    } catch {
      // ignore
    }
  }

  async function stopHost() {
    options.setError(null);
    options.setBusy(true);
    options.setBusyLabel("status.disconnecting");
    options.setBusyStartedAt(Date.now());

    try {
      if (isTauriRuntime()) {
        const info = await engineStop();
        setEngine(info);
      }

      setEngineAuth(null);

      options.setClient(null);
      options.setConnectedVersion(null);
      options.setSelectedSessionId(null);
      options.setMessages([]);
      options.setTodos([]);
      options.setPendingPermissions([]);
      options.setSessionStatusById({});
      options.setSseConnected(false);

      options.setStartupPreference(null);
      options.setOnboardingStep("welcome");

      options.setView("session");
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      options.setError(addOpencodeCacheHint(message));
    } finally {
      options.setBusy(false);
      options.setBusyLabel(null);
      options.setBusyStartedAt(null);
    }
  }

  async function reloadWorkspaceEngine() {
    if (!isTauriRuntime()) {
      options.setError("Reloading the engine requires the desktop app.");
      return false;
    }

    if (activeWorkspaceDisplay().workspaceType !== "local") {
      options.setError("Reload is only available for local workers.");
      return false;
    }

    const root = activeWorkspacePath().trim();
    if (!root) {
      options.setError("Pick a worker folder first.");
      return false;
    }

    options.setError(null);
    options.setBusy(true);
    options.setBusyLabel("status.reloading_engine");
    options.setBusyStartedAt(Date.now());

    try {
      const runtime = engine()?.runtime ?? resolveEngineRuntime();
      if (runtime === "openwork-orchestrator") {
        await orchestratorInstanceDispose(root);
        await orchestratorWorkspaceActivate({
          workspacePath: root,
          name: activeWorkspaceInfo()?.displayName?.trim() || activeWorkspaceInfo()?.name?.trim() || null,
        });

        const nextInfo = await engineInfo();
        setEngine(nextInfo);

        const username = nextInfo.opencodeUsername?.trim() ?? "";
        const password = nextInfo.opencodePassword?.trim() ?? "";
        const auth = username && password ? { username, password } : undefined;
        setEngineAuth(auth ?? null);

        if (nextInfo.baseUrl) {
          const ok = await connectToServer(
            nextInfo.baseUrl,
            nextInfo.projectDir ?? undefined,
            { reason: "engine-reload-orchestrator" },
            auth,
          );
          if (!ok) {
            options.setError("Failed to reconnect after reload");
            return false;
          }
        }

        return true;
      }

      const info = await engineStop();
      setEngine(info);

      const nextInfo = await engineStart(root, {
        preferSidecar: options.engineSource() === "sidecar",
        opencodeBinPath:
          options.engineSource() === "custom" ? options.engineCustomBinPath?.().trim() || null : null,
        runtime,
        workspacePaths: resolveWorkspacePaths(),
      });
      setEngine(nextInfo);

      const username = nextInfo.opencodeUsername?.trim() ?? "";
      const password = nextInfo.opencodePassword?.trim() ?? "";
      const auth = username && password ? { username, password } : undefined;
      setEngineAuth(auth ?? null);

      if (nextInfo.baseUrl) {
        const ok = await connectToServer(
          nextInfo.baseUrl,
          nextInfo.projectDir ?? undefined,
          { reason: "engine-reload" },
          auth,
        );
        if (!ok) {
          options.setError("Failed to reconnect after reload");
          return false;
        }
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

  async function onInstallEngine() {
    options.setError(null);
    setEngineInstallLogs(null);
    options.setBusy(true);
    options.setBusyLabel("status.installing_opencode");
    options.setBusyStartedAt(Date.now());

    try {
      const result = await engineInstall();
      const combined = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`.trim();
      setEngineInstallLogs(combined || null);

      if (!result.ok) {
        options.setError(result.stderr.trim() || t("app.error.install_failed", currentLocale()));
      }

      await refreshEngineDoctor();
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      options.setError(addOpencodeCacheHint(message));
    } finally {
      options.setBusy(false);
      options.setBusyLabel(null);
      options.setBusyStartedAt(null);
    }
  }

  return {
    refreshEngine,
    stopHost,
    reloadWorkspaceEngine,
    onInstallEngine,
  };
}
