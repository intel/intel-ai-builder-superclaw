/**
 * Workspace configuration export/import, OpenCode migration repair and
 * workspace recovery, lifted out of `createWorkspaceStore`.
 */
import type { Accessor, Setter } from "solid-js";

import { downloadDir } from "@tauri-apps/api/path";

import { currentLocale, t } from "../../i18n";
import { addOpencodeCacheHint, isTauriRuntime, safeStringify } from "../utils";
import {
  engineStop,
  opencodeDbMigrate,
  pickDirectory,
  pickFile,
  saveFile,
  workspaceExportConfig,
  workspaceImportConfig,
  type EngineInfo,
  type WorkspaceInfo,
} from "../lib/tauri";
import {
  formatExecOutput,
  isDbMigrateUnsupported,
  markOnboardingComplete,
  resolveWorkspacePath,
} from "./workspace-store-helpers";
import type {
  MigrationRepairResult,
  OwtTrace,
  StartHost,
  UpdateWorkspaceConnectionState,
  WorkspaceStoreOptions,
} from "./workspace-types";

export type WorkspaceConfigIoDeps = {
  options: WorkspaceStoreOptions;
  workspaces: Accessor<WorkspaceInfo[]>;
  setWorkspaces: Setter<WorkspaceInfo[]>;
  activeWorkspaceId: Accessor<string>;
  activeWorkspaceInfo: Accessor<WorkspaceInfo | null>;
  activeWorkspacePath: Accessor<string>;
  syncActiveWorkspaceId: (id: string) => void;
  engine: Accessor<EngineInfo | null>;
  setEngine: Setter<EngineInfo | null>;
  exportingWorkspaceConfig: Accessor<boolean>;
  setExportingWorkspaceConfig: Setter<boolean>;
  importingWorkspaceConfig: Accessor<boolean>;
  setImportingWorkspaceConfig: Setter<boolean>;
  migrationRepairBusy: Accessor<boolean>;
  setMigrationRepairBusy: Setter<boolean>;
  setMigrationRepairResult: Setter<MigrationRepairResult | null>;
  connectingWorkspaceId: Accessor<string | null>;
  setConnectingWorkspaceId: Setter<string | null>;
  setCreateWorkspaceOpen: Setter<boolean>;
  setCreateRemoteWorkspaceOpen: Setter<boolean>;
  activateFreshLocalWorkspace: (
    workspaceId: string | null,
    workspacePath: string,
  ) => Promise<boolean>;
  activateWorkspace: (workspaceId: string, trace?: OwtTrace) => Promise<boolean>;
  startHost: StartHost;
  testWorkspaceConnection: (workspaceId: string) => Promise<boolean>;
  updateWorkspaceConnectionState: UpdateWorkspaceConnectionState;
};

export function createWorkspaceConfigIo(deps: WorkspaceConfigIoDeps) {
  const {
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
  } = deps;

  async function recoverWorkspace(workspaceId: string) {
    const id = workspaceId.trim();
    if (!id) return false;
    if (connectingWorkspaceId() === id) return false;

    const workspace = workspaces().find((item) => item.id === id) ?? null;
    if (!workspace) return false;

    const reconnect = async () => {
      if (activeWorkspaceId() === id) {
        return await activateWorkspace(id);
      }
      return await testWorkspaceConnection(id);
    };

    setConnectingWorkspaceId(id);
    options.setError(null);

    try {
      updateWorkspaceConnectionState(id, { status: "connecting", message: null });
      return Boolean(await reconnect());
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      const hint = addOpencodeCacheHint(message);
      options.setError(hint);
      updateWorkspaceConnectionState(id, { status: "error", message: hint });
      return false;
    } finally {
      setConnectingWorkspaceId((current) => (current === id ? null : current));
    }
  }

  async function exportWorkspaceConfig(workspaceId?: string) {
    if (exportingWorkspaceConfig()) return;
    if (!isTauriRuntime()) {
      options.setError(t("app.error.tauri_required", currentLocale()));
      return;
    }

    const targetId = workspaceId?.trim() || activeWorkspaceInfo()?.id || "";
    if (!targetId) {
      options.setError("Select a worker to export");
      return;
    }
    const target = workspaces().find((ws) => ws.id === targetId) ?? null;
    if (!target) {
      options.setError("Unknown worker");
      return;
    }
    if (target.workspaceType === "remote") {
      options.setError("Export is only supported for local workers");
      return;
    }

    setExportingWorkspaceConfig(true);
    options.setError(null);

    try {
      const nameBase = (target.displayName || target.name || "worker")
        .toLowerCase()
        .replace(/[^a-z0-9-_]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60);
      const dateStamp = new Date().toISOString().slice(0, 10);
      const fileName = `openwork-${nameBase || "worker"}-${dateStamp}.openwork-workspace`;
      const downloads = await downloadDir().catch(() => null);
      const defaultPath = downloads ? `${downloads}/${fileName}` : fileName;

      const outputPath = await saveFile({
        title: "Export worker config",
        defaultPath,
        filters: [{ name: "OpenWork Worker", extensions: ["openwork-workspace", "zip"] }],
      });

      if (!outputPath) {
        return;
      }

      await workspaceExportConfig({
        workspaceId: target.id,
        outputPath,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      options.setError(addOpencodeCacheHint(message));
    } finally {
      setExportingWorkspaceConfig(false);
    }
  }

  async function importWorkspaceConfig() {
    if (importingWorkspaceConfig()) return;
    if (!isTauriRuntime()) {
      options.setError(t("app.error.tauri_required", currentLocale()));
      return;
    }

    setImportingWorkspaceConfig(true);
    options.setError(null);

    try {
      const selection = await pickFile({
        title: "Import worker config",
        filters: [{ name: "OpenWork Worker", extensions: ["openwork-workspace", "zip"] }],
      });
      const filePath =
        typeof selection === "string" ? selection : Array.isArray(selection) ? selection[0] : null;
      if (!filePath) return;

      const target = await pickDirectory({
        title: "Choose a worker folder",
      });
      const folder =
        typeof target === "string" ? target : Array.isArray(target) ? target[0] : null;
      if (!folder) return;

      const resolvedFolder = await resolveWorkspacePath(folder);
      if (!resolvedFolder) {
        options.setError(t("app.error.choose_folder", currentLocale()));
        return;
      }

      const ws = await workspaceImportConfig({
        archivePath: filePath,
        targetDir: resolvedFolder,
      });

      setWorkspaces(ws.workspaces);
      syncActiveWorkspaceId(ws.activeId);
      setCreateWorkspaceOpen(false);
      setCreateRemoteWorkspaceOpen(false);
      markOnboardingComplete();

      const opened = await activateFreshLocalWorkspace(ws.activeId ?? null, resolvedFolder);
      if (!opened) {
        return;
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      options.setError(addOpencodeCacheHint(message));
    } finally {
      setImportingWorkspaceConfig(false);
    }
  }

  async function repairOpencodeMigration(optionsOverride?: { navigate?: boolean }) {
    if (!isTauriRuntime()) {
      const message = t("app.migration.desktop_required", currentLocale());
      setMigrationRepairResult({ ok: false, message });
      options.setError(message);
      return false;
    }

    if (migrationRepairBusy()) return false;

    const workspace = activeWorkspaceInfo();
    if (!workspace || workspace.workspaceType !== "local") {
      const message = t("app.migration.local_only", currentLocale());
      setMigrationRepairResult({ ok: false, message });
      options.setError(message);
      return false;
    }

    const root = activeWorkspacePath().trim();
    if (!root) {
      const message = t("app.migration.workspace_required", currentLocale());
      setMigrationRepairResult({ ok: false, message });
      options.setError(message);
      return false;
    }

    setMigrationRepairBusy(true);
    setMigrationRepairResult(null);
    options.setError(null);
    options.setBusy(true);
    options.setBusyLabel("status.repairing_migration");
    options.setBusyStartedAt(Date.now());

    try {
      if (engine()?.running) {
        const info = await engineStop();
        setEngine(info);
      }

      const source = options.engineSource();
      const result = await opencodeDbMigrate({
        projectDir: root,
        preferSidecar: source === "sidecar",
        opencodeBinPath: source === "custom" ? options.engineCustomBinPath?.().trim() || null : null,
      });

      if (!result.ok) {
        const output = formatExecOutput(result);
        if (isDbMigrateUnsupported(output)) {
          const message = t("app.migration.unsupported", currentLocale());
          setMigrationRepairResult({ ok: false, message });
          options.setError(message);
          return false;
        }

        const fallback = t("app.migration.failed", currentLocale());
        const message = output ? `${fallback}\n\n${output}` : fallback;
        setMigrationRepairResult({ ok: false, message });
        options.setError(addOpencodeCacheHint(message));
        return false;
      }

      const started = await startHost({
        workspacePath: root,
        navigate: optionsOverride?.navigate ?? false,
      });
      if (!started) {
        const message = t("app.migration.restart_failed", currentLocale());
        setMigrationRepairResult({ ok: false, message });
        return false;
      }

      setMigrationRepairResult({ ok: true, message: t("app.migration.success", currentLocale()) });
      return true;
    } catch (error) {
      const message = addOpencodeCacheHint(error instanceof Error ? error.message : safeStringify(error));
      setMigrationRepairResult({ ok: false, message });
      options.setError(message);
      return false;
    } finally {
      setMigrationRepairBusy(false);
      options.setBusy(false);
      options.setBusyLabel(null);
      options.setBusyStartedAt(null);
    }
  }

  return {
    recoverWorkspace,
    exportWorkspaceConfig,
    importWorkspaceConfig,
    repairOpencodeMigration,
  };
}
