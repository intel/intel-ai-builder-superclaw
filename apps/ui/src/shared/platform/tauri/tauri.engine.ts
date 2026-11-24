import { invoke } from "@tauri-apps/api/core";
import type { ExecResult } from "./tauri.skills";
import type { WorkspaceOpenworkConfig } from "~/shared/types/workspace";

export type EngineInfo = {
  running: boolean;
  runtime: "direct" | "openwork-orchestrator";
  baseUrl: string | null;
  projectDir: string | null;
  hostname: string | null;
  port: number | null;
  opencodeUsername: string | null;
  opencodePassword: string | null;
  pid: number | null;
  lastStdout: string | null;
  lastStderr: string | null;
};

export type OpenworkServerInfo = {
  running: boolean;
  host: string | null;
  port: number | null;
  baseUrl: string | null;
  connectUrl: string | null;
  mdnsUrl: string | null;
  lanUrl: string | null;
  clientToken: string | null;
  ownerToken: string | null;
  hostToken: string | null;
  pid: number | null;
  lastStdout: string | null;
  lastStderr: string | null;
};

export type OrchestratorWorkspace = {
  id: string;
  name: string;
  path: string;
  workspaceType: string;
  baseUrl?: string | null;
  directory?: string | null;
  createdAt?: number | null;
  lastUsedAt?: number | null;
};

export type EngineDoctorResult = {
  found: boolean;
  inPath: boolean;
  resolvedPath: string | null;
  version: string | null;
  supportsServe: boolean;
  notes: string[];
  serveHelpStatus: number | null;
  serveHelpStdout: string | null;
  serveHelpStderr: string | null;
};

export type WorkspaceInfo = {
  id: string;
  name: string;
  path: string;
  preset: string;
  workspaceType: "local" | "remote";
  remoteType?: "openwork" | "opencode" | null;
  baseUrl?: string | null;
  directory?: string | null;
  displayName?: string | null;
  openworkHostUrl?: string | null;
  openworkToken?: string | null;
  openworkWorkspaceId?: string | null;
  openworkWorkspaceName?: string | null;

  // Sandbox lifecycle metadata (desktop-managed)
  sandboxBackend?: "servicehub" | null;

  /**
   * Container-side mount path for this workspace (e.g. `/workspace`).
   *
   * For local workspaces using the sandbox runtime, this is what
   * opencode/openwork-server should treat as the project root — NOT the
   * host-side `path` field, which on Windows is a `C:\...` string that
   * doesn't exist inside the Linux container.
   *
   * Source of truth: sandbox_manager's `GET /sandbox-manager/v1/agent/sandbox/config` (via ServiceHub).
   * Source on the wire: Tauri Rust populates this on workspace creation
   * and during v4→v5 state migration.
   *
   * `null`/absent for remote workspaces (where `directory` covers the role)
   * and on legacy state files that haven't been migrated yet.
   *
   * Introduced 2026-04-30 as part of the windows-path-leak fix; see
   * `docs/fixes/2026-04-30-windows-path-leak/`.
   */
  containerPath?: string | null;
};

export type WorkspaceList = {
  activeId: string;
  workspaces: WorkspaceInfo[];
};

export type WorkspaceExportSummary = {
  outputPath: string;
  included: number;
  excluded: string[];
};

export async function engineStart(
  projectDir: string,
  options?: {
    preferSidecar?: boolean;
    runtime?: "direct" | "openwork-orchestrator";
    workspacePaths?: string[];
    opencodeBinPath?: string | null;
  },
): Promise<EngineInfo> {
  return invoke<EngineInfo>("engine_start", {
    projectDir,
    preferSidecar: options?.preferSidecar ?? false,
    opencodeBinPath: options?.opencodeBinPath ?? null,
    runtime: options?.runtime ?? null,
    workspacePaths: options?.workspacePaths ?? null,
  });
}

export async function workspaceBootstrap(): Promise<WorkspaceList> {
  return invoke<WorkspaceList>("workspace_bootstrap");
}

export async function workspaceSetActive(workspaceId: string): Promise<WorkspaceList> {
  return invoke<WorkspaceList>("workspace_set_active", { workspaceId });
}

export async function workspaceCreate(input: {
  folderPath: string;
  name: string;
  preset: string;
}): Promise<WorkspaceList> {
  return invoke<WorkspaceList>("workspace_create", {
    folderPath: input.folderPath,
    name: input.name,
    preset: input.preset,
  });
}

export async function workspaceCreateRemote(input: {
  baseUrl: string;
  directory?: string | null;
  displayName?: string | null;
  remoteType?: "openwork" | "opencode" | null;
  openworkHostUrl?: string | null;
  openworkToken?: string | null;
  openworkWorkspaceId?: string | null;
  openworkWorkspaceName?: string | null;

  // Sandbox lifecycle metadata (desktop-managed)
  sandboxBackend?: "servicehub" | null;
}): Promise<WorkspaceList> {
  return invoke<WorkspaceList>("workspace_create_remote", {
    baseUrl: input.baseUrl,
    directory: input.directory ?? null,
    displayName: input.displayName ?? null,
    remoteType: input.remoteType ?? null,
    openworkHostUrl: input.openworkHostUrl ?? null,
    openworkToken: input.openworkToken ?? null,
    openworkWorkspaceId: input.openworkWorkspaceId ?? null,
    openworkWorkspaceName: input.openworkWorkspaceName ?? null,
    sandboxBackend: input.sandboxBackend ?? null,
  });
}

export async function workspaceUpdateRemote(input: {
  workspaceId: string;
  baseUrl?: string | null;
  directory?: string | null;
  displayName?: string | null;
  remoteType?: "openwork" | "opencode" | null;
  openworkHostUrl?: string | null;
  openworkToken?: string | null;
  openworkWorkspaceId?: string | null;
  openworkWorkspaceName?: string | null;

  // Sandbox lifecycle metadata (desktop-managed)
  sandboxBackend?: "servicehub" | null;
}): Promise<WorkspaceList> {
  return invoke<WorkspaceList>("workspace_update_remote", {
    workspaceId: input.workspaceId,
    baseUrl: input.baseUrl ?? null,
    directory: input.directory ?? null,
    displayName: input.displayName ?? null,
    remoteType: input.remoteType ?? null,
    openworkHostUrl: input.openworkHostUrl ?? null,
    openworkToken: input.openworkToken ?? null,
    openworkWorkspaceId: input.openworkWorkspaceId ?? null,
    openworkWorkspaceName: input.openworkWorkspaceName ?? null,
    sandboxBackend: input.sandboxBackend ?? null,
  });
}

export async function workspaceUpdateDisplayName(input: {
  workspaceId: string;
  displayName?: string | null;
}): Promise<WorkspaceList> {
  return invoke<WorkspaceList>("workspace_update_display_name", {
    workspaceId: input.workspaceId,
    displayName: input.displayName ?? null,
  });
}

export async function workspaceForget(workspaceId: string): Promise<WorkspaceList> {
  return invoke<WorkspaceList>("workspace_forget", { workspaceId });
}

export async function workspaceAddAuthorizedRoot(input: {
  workspacePath: string;
  folderPath: string;
}): Promise<ExecResult> {
  return invoke<ExecResult>("workspace_add_authorized_root", {
    workspacePath: input.workspacePath,
    folderPath: input.folderPath,
  });
}

export async function workspaceExportConfig(input: {
  workspaceId: string;
  outputPath: string;
}): Promise<WorkspaceExportSummary> {
  return invoke<WorkspaceExportSummary>("workspace_export_config", {
    workspaceId: input.workspaceId,
    outputPath: input.outputPath,
  });
}

export async function workspaceImportConfig(input: {
  archivePath: string;
  targetDir: string;
  name?: string | null;
}): Promise<WorkspaceList> {
  return invoke<WorkspaceList>("workspace_import_config", {
    archivePath: input.archivePath,
    targetDir: input.targetDir,
    name: input.name ?? null,
  });
}

export type OpencodeCommandDraft = {
  name: string;
  description?: string;
  template: string;
  agent?: string;
  model?: string;
  subtask?: boolean;
};

// The payload of the `workspace_openwork_*` commands is the same shape the
// config consumers read, so it is declared once in `shared/` and re-exported
// here rather than restated. Two declarations would drift silently: they are
// structurally identical, so nothing would fail to compile.
export type { WorkspaceOpenworkConfig };

export async function workspaceOpenworkRead(input: {
  workspacePath: string;
}): Promise<WorkspaceOpenworkConfig> {
  return invoke<WorkspaceOpenworkConfig>("workspace_openwork_read", {
    workspacePath: input.workspacePath,
  });
}

export async function workspaceOpenworkWrite(input: {
  workspacePath: string;
  config: WorkspaceOpenworkConfig;
}): Promise<ExecResult> {
  return invoke<ExecResult>("workspace_openwork_write", {
    workspacePath: input.workspacePath,
    config: input.config,
  });
}

export async function opencodeCommandList(input: {
  scope: "workspace" | "global";
  projectDir: string;
}): Promise<string[]> {
  return invoke<string[]>("opencode_command_list", {
    scope: input.scope,
    projectDir: input.projectDir,
  });
}

export async function opencodeCommandWrite(input: {
  scope: "workspace" | "global";
  projectDir: string;
  command: OpencodeCommandDraft;
}): Promise<ExecResult> {
  return invoke<ExecResult>("opencode_command_write", {
    scope: input.scope,
    projectDir: input.projectDir,
    command: input.command,
  });
}

export async function opencodeCommandDelete(input: {
  scope: "workspace" | "global";
  projectDir: string;
  name: string;
}): Promise<ExecResult> {
  return invoke<ExecResult>("opencode_command_delete", {
    scope: input.scope,
    projectDir: input.projectDir,
    name: input.name,
  });
}

export async function engineStop(): Promise<EngineInfo> {
  return invoke<EngineInfo>("engine_stop");
}

export async function orchestratorWorkspaceActivate(input: {
  workspacePath: string;
  name?: string | null;
}): Promise<OrchestratorWorkspace> {
  return invoke<OrchestratorWorkspace>("orchestrator_workspace_activate", {
    workspacePath: input.workspacePath,
    name: input.name ?? null,
  });
}

export async function orchestratorInstanceDispose(workspacePath: string): Promise<boolean> {
  return invoke<boolean>("orchestrator_instance_dispose", { workspacePath });
}

export type AppBuildInfo = {
  version: string;
  gitSha?: string | null;
  buildEpoch?: string | null;
  openworkDevMode?: boolean;
  channel?: "stable" | "beta" | "dev";
};

export async function appBuildInfo(): Promise<AppBuildInfo> {
  return invoke<AppBuildInfo>("app_build_info");
}
