// Pure decision helpers used by createWorkspaceStore: error classification, the
// openwork settings/workspace lookups, and the openwork resolve retry policy.
// Moved verbatim out of context/workspace.ts — no behaviour change. They read no
// signals and touch no IPC, which is what makes them unit-testable on their own.

import type { WorkspaceDisplay } from "../types";
import { safeStringify } from "../utils";
import {
  normalizeOpenworkServerUrl,
  OpenworkServerError,
  type OpenworkServerSettings,
} from "../lib/openwork-server";
import type { WorkspaceInfo } from "../lib/tauri";

// Pure — classifies an error thrown from a workspace connect/health/token-sync
// call into a stable code + user-facing message. Exported (moved out of
// createWorkspaceStore, no behavior change) so it's unit-testable without
// instantiating the whole store.
export function classifyWorkspaceError(error: unknown): { code: string; message: string } {
  if (error instanceof OpenworkServerError) {
    if (error.status === 401) return { code: "token_stale", message: "Workspace token expired. Refreshing it may resolve this." };
    if (error.status === 503) return { code: "sandbox_starting", message: "Sandbox is still starting." };
    if (error.status === 504) return { code: "servicehub_upstream_timeout", message: "ServiceHub timed out waiting for the sandbox." };
    return { code: error.code || `http_${error.status}`, message: error.message };
  }
  const message = error instanceof Error ? error.message : safeStringify(error);
  if (/timed out/i.test(message)) {
    return { code: "servicehub_upstream_timeout", message: "Connection timed out while waiting for the service." };
  }
  return { code: "network_unreachable", message: "Cannot reach the workspace runtime." };
}

// Pure — decides whether the global openwork server settings (URL/token)
// should be updated to mirror a given workspace's own cached openwork
// URL/token, and if so, returns the merged settings object. Returns null when
// no update is needed (not an openwork-remote workspace, no host URL, or
// settings already match). Extracted from the app.tsx reactive effect that
// syncs settings on workspace switch, so it's unit-testable without Solid/DOM
// test infra.
export function nextOpenworkServerSettingsForWorkspace(
  workspace: Pick<WorkspaceDisplay, "workspaceType" | "remoteType" | "openworkHostUrl" | "openworkToken">,
  settings: OpenworkServerSettings,
): OpenworkServerSettings | null {
  if (workspace.workspaceType !== "remote" || workspace.remoteType !== "openwork") return null;
  const hostUrl = workspace.openworkHostUrl?.trim() ?? "";
  if (!hostUrl) return null;
  const token = workspace.openworkToken?.trim() ?? "";
  if (settings.urlOverride?.trim() === hostUrl && (!token || settings.token?.trim() === token)) {
    return null;
  }
  return { ...settings, urlOverride: hostUrl, token: token || settings.token };
}

// Pure — mirrors onBackendTokenRefresh's "reuse, don't duplicate" lookup: prefer
// the currently active workspace if it's already the openwork-remote one;
// otherwise fall back to any existing workspace whose openworkHostUrl matches
// the refreshed URL. Returns null only when neither matches, which is the
// legitimate "no existing openwork workspace, create one" case.
//
// Without the URL fallback, a boot-order race (activeWorkspaceId not yet
// pointing at the openwork-remote workspace when this runs, e.g. because
// `workspaceBootstrap()` hasn't resolved yet) falls through to the create-new
// path, which resolves the OpenWork workspace id independently (no
// workspaceId hint) and can compute a different stable id than the
// already-persisted entry — producing a duplicate sidebar entry instead of
// reusing the existing one.
export function findOpenworkRemoteWorkspaceForTokenRefresh(
  workspaces: WorkspaceInfo[],
  activeWorkspaceId: string,
  newUrl: string,
): WorkspaceInfo | null {
  const isOpenworkRemote = (w: WorkspaceInfo) =>
    w.workspaceType === "remote" && (w.remoteType === "openwork" ? "openwork" : "opencode") === "openwork";
  const normalizedNewUrl = normalizeOpenworkServerUrl(newUrl) ?? "";
  const candidate =
    workspaces.find((w) => w.id === activeWorkspaceId) ??
    (normalizedNewUrl
      ? workspaces.find(
          (w) => isOpenworkRemote(w) && (normalizeOpenworkServerUrl(w.openworkHostUrl ?? "") ?? "") === normalizedNewUrl,
        )
      : undefined) ??
    null;
  return candidate && isOpenworkRemote(candidate) ? candidate : null;
}

// Classifies a resolveOpenworkHost outcome for retry purposes:
//   - "resolved":  a usable openwork workspace was returned — done, no retry.
//   - "transient": the host/workspace is not usable YET but likely will be
//                  shortly (health probe failed / returned not-ok, or the
//                  server has no worker registered yet). This is the boot-time
//                  race: a freshly-ready sandbox container reports healthy a
//                  few hundred ms before its openwork workspace is listable.
//   - "fatal":     a permanent failure (e.g. 401/403 token rejection). Never
//                  retry — retrying a bad token just wastes the whole window.
export type OpenworkResolveOutcome = "resolved" | "transient" | "fatal";

// Pure — decides whether to retry a transient resolveOpenworkHost failure and
// how long to back off before the next attempt. Extracted so the boot-race
// retry policy is unit-testable without Solid/DOM/timer infra.
//
// Short, capped exponential backoff (500ms, 1s, 2s, 4s, 8s, then held at 8s),
// bounded by a total wall-clock budget. The budget is intentionally short (see
// caller): it covers the common fast-start race, and the disconnected
// auto-heal path is the backstop for slow (~45s) cold-container starts.
export const OPENWORK_RESOLVE_RETRY_BUDGET_MS = 45_000;

export function openworkResolveRetryDecision(
  outcome: OpenworkResolveOutcome,
  attempt: number,
  elapsedMs: number,
  budgetMs = OPENWORK_RESOLVE_RETRY_BUDGET_MS,
): { retry: boolean; delayMs: number } {
  if (outcome !== "transient") return { retry: false, delayMs: 0 };
  // attempt is 1-based (the attempt that just failed). Back off before the next.
  const backoff = Math.min(500 * 2 ** Math.max(0, attempt - 1), 8_000);
  // Don't schedule a retry that would start after the budget is already spent.
  if (elapsedMs + backoff >= budgetMs) return { retry: false, delayMs: 0 };
  return { retry: true, delayMs: backoff };
}

// Pure - whether createRemoteWorkspaceFlow may fall back to the sandbox's
// host-level OpenCode URL when resolveOpenworkHost could not resolve a
// workspace. Only the desktop-managed ServiceHub runtime qualifies: it
// legitimately answers /health before listWorkspaces is serving. A
// user-supplied remote server must still surface "server unavailable" instead
// of silently connecting to a host that never advertised a workspace.
export function canFallBackToSandboxHost(
  sandboxBackend: "servicehub" | null | undefined,
): boolean {
  return sandboxBackend === "servicehub";
}
