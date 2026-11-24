import { invoke } from "@tauri-apps/api/core";

export type BackendManagerInfo = {
  running: boolean;
  port: number | null;
  sandboxPhase: string | null;
  inferenceState: string | null;
  owtToken: string | null;
  pid: number | null;
  lastStdout: string | null;
  lastStderr: string | null;
};

// ── Backend boot snapshot ───────────────────────────────────────────────────
// Durable state that survives missed events. Frontend can poll this on mount
// to recover if the BACKEND_READY_EVENT was emitted before listeners were up.

// ── ServiceHub boot snapshot ────────────────────────────────────────────────

export type ServiceHubReadyPayload = {
  hubUrl: string;
  hubToken: string;
  openworkUrl?: string | null;
  owtToken?: string | null;
};

export type ServiceHubStageStatus = "ok" | "fail";

/** One entry in the ServiceHub boot timeline (2026-07-22 boot-timeline
 *  follow-up): a stage, its relative elapsed time, ok/fail status and a short
 *  message. Lets the UI render a "startup flow at a glance" summary. */
export type ServiceHubStageEntry = {
  stage: string;
  elapsedMs: number;
  status: ServiceHubStageStatus;
  message: string;
};

export type ServiceHubBootSnapshot = {
  ready: boolean;
  stage: string | null;
  message: string | null;
  pct: number | null;
  error: string | null;
  readyPayload: ServiceHubReadyPayload | null;
  /** Launch correlation key (2026-07-21 startup-logging unification); may be
   *  absent on older hosts. Used to stamp the UI log timeline with the same
   *  boot_id as tauri.log / servicehub.log. */
  bootId?: string | null;
  /** Ordered boot timeline; may be absent on older hosts. */
  timeline?: ServiceHubStageEntry[];
  /** Milliseconds since boot start at snapshot time; may be absent. */
  totalElapsedMs?: number | null;
};

export async function getServiceHubBootSnapshot(): Promise<ServiceHubBootSnapshot> {
  return invoke<ServiceHubBootSnapshot>("get_servicehub_boot_snapshot");
}

export type ServiceHubInfo = {
  running: boolean;
  hubPort: number | null;
  pid: number | null;
  lastStdout: string | null;
  lastStderr: string | null;
};

export async function getServiceHubStatus(): Promise<ServiceHubInfo> {
  return invoke<ServiceHubInfo>("get_servicehub_status");
}

export async function retryServiceHubBoot(): Promise<ServiceHubInfo> {
  return invoke<ServiceHubInfo>("retry_servicehub_boot");
}

// Force-kills ServiceHub, including the primary kept-alive Hub reaped by its
// servicehub.lock PID (not just this process's own child). Needed before a
// consent-driven relaunch: keepBackendOnExit otherwise leaves ServiceHub
// alive, and the relaunched app just REUSEs it (stale telemetry env).
export async function stopServiceHub(): Promise<ServiceHubInfo> {
  return invoke<ServiceHubInfo>("stop_servicehub");
}

export async function getBackendSystemStatus(): Promise<unknown> {
  return invoke<unknown>("get_backend_system_status");
}

export async function getDebugBuildCommit(): Promise<string> {
  return invoke<string>("get_debug_build_commit");
}

export async function runWorkspaceCleanupNow(): Promise<unknown> {
  return invoke<unknown>("run_workspace_cleanup_now");
}

export async function previewWorkspaceCleanup(retentionDays?: number): Promise<unknown> {
  return invoke<unknown>("preview_workspace_cleanup", { retentionDays: retentionDays ?? null });
}

export type WorkspaceCleanupSettings = {
  enabled: boolean;
  retentionDays: number;
};

export async function getWorkspaceCleanupSettings(): Promise<WorkspaceCleanupSettings> {
  return invoke<WorkspaceCleanupSettings>("get_workspace_cleanup_settings");
}

export async function setWorkspaceCleanupSettings(
  patch: { enabled?: boolean; retentionDays?: number },
): Promise<WorkspaceCleanupSettings> {
  return invoke<WorkspaceCleanupSettings>("set_workspace_cleanup_settings", workspaceCleanupSettingsArgs(patch));
}

export function workspaceCleanupSettingsArgs(
  patch: { enabled?: boolean; retentionDays?: number },
): { enabled: boolean | null; retentionDays: number | null } {
  return {
    enabled: patch.enabled ?? null,
    retentionDays: patch.retentionDays ?? null,
  };
}

export type WorkspaceCleanupStatus = {
  last_run_at: number | null;
  last_cleaned_at: number | null;
  last_emergency_cleanup_at: number | null;
  next_run_at: number | null;
  warn_bytes: number;
  critical_bytes: number;
  intermediate_bytes: number;
  reclaimable_bytes: number;
  disk_level: "ok" | "warn" | "critical";
};

export async function getWorkspaceCleanupStatus(enabled?: boolean): Promise<WorkspaceCleanupStatus> {
  return invoke<WorkspaceCleanupStatus>("get_workspace_cleanup_status", { enabled: enabled ?? null });
}

export type WorkspaceCleanupPolicy = {
  patterns: { pattern: string; type: string; description: string }[];
  max_session_age_days: number;
  warn_bytes: number;
  critical_bytes: number;
};

export async function getWorkspaceCleanupPolicy(): Promise<WorkspaceCleanupPolicy> {
  return invoke<WorkspaceCleanupPolicy>("get_workspace_cleanup_policy");
}
