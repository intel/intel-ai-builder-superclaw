import { invoke } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { isTauriRuntime } from "~/shared/platform/runtime-env";
import { validateMcpServerName } from "~/shared/util/mcp-server-name";
import type { ExecResult, ScheduledJob } from "./tauri.skills";

export async function schedulerListJobs(scopeRoot?: string): Promise<ScheduledJob[]> {
  return invoke<ScheduledJob[]>("scheduler_list_jobs", { scopeRoot });
}

export async function schedulerDeleteJob(name: string, scopeRoot?: string): Promise<ScheduledJob> {
  return invoke<ScheduledJob>("scheduler_delete_job", { name, scopeRoot });
}

// OpenCodeRouter types
export type OpenCodeRouterIdentityItem = {
  id: string;
  enabled: boolean;
  running?: boolean;
};

export type OpenCodeRouterChannelStatus = {
  items: OpenCodeRouterIdentityItem[];
};

export type OpenCodeRouterStatus = {
  running: boolean;
  config: string;
  healthPort?: number | null;
  telegram: OpenCodeRouterChannelStatus;
  slack: OpenCodeRouterChannelStatus;
  opencode: { url: string; directory?: string };
};

export type OpenCodeRouterStatusResult =
  | { ok: true; status: OpenCodeRouterStatus }
  | { ok: false; error: string };

export type OpenCodeRouterInfo = {
  running: boolean;
  version: string | null;
  workspacePath: string | null;
  opencodeUrl: string | null;
  healthPort: number | null;
  pid: number | null;
  lastStdout: string | null;
  lastStderr: string | null;
};

// OpenCodeRouter functions - call Tauri commands that wrap opencodeRouter CLI
export async function getOpenCodeRouterStatus(): Promise<OpenCodeRouterStatus | null> {
  try {
    return await invoke<OpenCodeRouterStatus>("opencodeRouter_status");
  } catch {
    return null;
  }
}

export async function getOpenCodeRouterStatusDetailed(): Promise<OpenCodeRouterStatusResult> {
  try {
    const status = await invoke<OpenCodeRouterStatus>("opencodeRouter_status");
    return { ok: true, status };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

export async function getOpenCodeRouterGroupsEnabled(): Promise<boolean | null> {
  try {
    const status = await getOpenCodeRouterStatus();
    const healthPort = status?.healthPort ?? 3005;
    const response = await (isTauriRuntime() ? tauriFetch : fetch)(`http://127.0.0.1:${healthPort}/config/groups`, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });
    if (!response.ok) {
      return null;
    }
    const data = await response.json();
    return data?.groupsEnabled ?? null;
  } catch {
    return null;
  }
}

export async function setOpenCodeRouterGroupsEnabled(enabled: boolean): Promise<ExecResult> {
  try {
    const status = await getOpenCodeRouterStatus();
    const healthPort = status?.healthPort ?? 3005;
    const response = await (isTauriRuntime() ? tauriFetch : fetch)(`http://127.0.0.1:${healthPort}/config/groups`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    if (!response.ok) {
      const message = await response.text();
      return { ok: false, status: response.status, stdout: "", stderr: message };
    }
    return { ok: true, status: 0, stdout: "", stderr: "" };
  } catch (e) {
    return { ok: false, status: 1, stdout: "", stderr: String(e) };
  }
}

export async function opencodeDbMigrate(input: {
  projectDir: string;
  preferSidecar?: boolean;
  opencodeBinPath?: string | null;
}): Promise<ExecResult> {
  const safeProjectDir = input.projectDir.trim();
  if (!safeProjectDir) {
    throw new Error("project_dir is required");
  }

  return invoke<ExecResult>("opencode_db_migrate", {
    projectDir: safeProjectDir,
    preferSidecar: input.preferSidecar ?? false,
    opencodeBinPath: input.opencodeBinPath ?? null,
  });
}

export async function opencodeMcpAuth(
  projectDir: string,
  serverName: string,
): Promise<ExecResult> {
  const safeProjectDir = projectDir.trim();
  if (!safeProjectDir) {
    throw new Error("project_dir is required");
  }

  const safeServerName = validateMcpServerName(serverName);

  return invoke<ExecResult>("opencode_mcp_auth", {
    projectDir: safeProjectDir,
    serverName: safeServerName,
  });
}

export async function startMcpOauthListener(options: {
  port: number;
  callbackPath: string;
  timeoutSecs: number;
}): Promise<void> {
  return invoke("start_mcp_oauth_listener", options);
}

export async function stopMcpOauthListener(): Promise<void> {
  return invoke("stop_mcp_oauth_listener");
}

// --- Debug-only "Report a Bug" log collection + GitHub issue filing ---
// These are only invoked from debug builds (gated behind `__BUILD_DEBUG__`)
// and rely on the developer's locally authenticated `gh` CLI.

export type CollectedLog = {
  path: string;
  relativePath: string;
  sizeBytes: number;
  modifiedMs: number;
  content: string;
  truncated: boolean;
};

export type ReportBugFile = {
  name: string;
  content: string;
};

/** Newest ≤2 non-empty `.log` files per leaf log folder under %LOCALAPPDATA%\SuperClaw. */
export async function collectRecentLogs(): Promise<CollectedLog[]> {
  return invoke<CollectedLog[]>("collect_recent_logs");
}

/** Whether an authenticated GitHub CLI (`gh`) is available on this machine. */
export async function ghAvailable(): Promise<boolean> {
  return invoke<boolean>("gh_available");
}

/** Absolute %LOCALAPPDATA%\SuperClaw log root, for the file picker's defaultPath. */
export async function superclawLogRoot(): Promise<string | null> {
  return invoke<string | null>("superclaw_log_root");
}

/** Read one user-picked log file into the CollectedLog shape (tailed, sized). */
export async function readLogFile(path: string): Promise<CollectedLog> {
  return invoke<CollectedLog>("read_log_file", { path });
}

/** Upload logs as a secret gist. Returns the gist URL (or null if no files). */
export async function createBugGist(files: ReportBugFile[]): Promise<string | null> {
  return invoke<string | null>("create_bug_gist", { files });
}

export async function opencodeRouterStart(options: {
  workspacePath: string;
  opencodeUrl?: string;
  opencodeUsername?: string;
  opencodePassword?: string;
  healthPort?: number;
}): Promise<OpenCodeRouterInfo> {
  return invoke<OpenCodeRouterInfo>("opencodeRouter_start", {
    workspacePath: options.workspacePath,
    opencodeUrl: options.opencodeUrl ?? null,
    opencodeUsername: options.opencodeUsername ?? null,
    opencodePassword: options.opencodePassword ?? null,
    healthPort: options.healthPort ?? null,
  });
}

// ── Backend Manager ─────────────────────────────────────────────────────────
