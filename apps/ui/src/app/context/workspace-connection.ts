/**
 * Workspace connection state, remote connection testing and openwork token
 * sync, lifted out of `createWorkspaceStore`.
 *
 * Every dependency is a function (a signal accessor, a signal setter, or the
 * settings thunk), so nothing here can capture a stale value.
 */
import type { Accessor, Setter } from "solid-js";

import type { WorkspaceConnectionState } from "../types";
import { isTauriRuntime, safeStringify } from "../utils";
import { uiLogError, uiLogInfo, uiLogWarn } from "../lib/log";
import { createClient, waitForHealthy } from "../lib/opencode";
import { type OpenworkServerSettings } from "../lib/openwork-server";
import { workspaceUpdateRemote, type WorkspaceInfo } from "../lib/tauri";
import { classifyWorkspaceError } from "./workspace-policy";
import { makeRunId } from "./workspace-store-helpers";
import type { OwtTrace } from "./workspace-types";
import { resolveOpenworkHost } from "./workspace-openwork-host";

export const normalizeRemoteType = (value?: WorkspaceInfo["remoteType"] | null) =>
  value === "openwork" ? "openwork" : "opencode";

export type WorkspaceConnectionDeps = {
  workspaces: Accessor<WorkspaceInfo[]>;
  setWorkspaces: Setter<WorkspaceInfo[]>;
  setWorkspaceConnectionStateById: Setter<Record<string, WorkspaceConnectionState>>;
  openworkServerSettings: () => OpenworkServerSettings;
};

export function createWorkspaceConnection(deps: WorkspaceConnectionDeps) {
  const {
    workspaces,
    setWorkspaces,
    setWorkspaceConnectionStateById,
    openworkServerSettings,
  } = deps;

  const updateWorkspaceConnectionState = (
    workspaceId: string,
    next: Partial<WorkspaceConnectionState>,
  ) => {
    const id = workspaceId.trim();
    if (!id) return;
    setWorkspaceConnectionStateById((prev) => {
      const current = prev[id] ?? { status: "idle", message: null, checkedAt: null };
      return {
        ...prev,
        [id]: {
          ...current,
          ...next,
          checkedAt: Date.now(),
        },
      };
    });
  };

  async function testWorkspaceConnection(workspaceId: string) {
    const id = workspaceId.trim();
    if (!id) return false;
    const workspace = workspaces().find((item) => item.id === id) ?? null;
    if (!workspace) return false;

    updateWorkspaceConnectionState(id, { status: "connecting", message: null });

    if (workspace.workspaceType !== "remote") {
      updateWorkspaceConnectionState(id, { status: "connected", message: null });
      return true;
    }

    const remoteType = normalizeRemoteType(workspace.remoteType);

    if (remoteType === "openwork") {
      const hostUrl =
        workspace.openworkHostUrl?.trim() || workspace.baseUrl?.trim() || workspace.path?.trim() || "";
      if (!hostUrl) {
        updateWorkspaceConnectionState(id, {
          status: "error",
          message: "SuperClaw server URL is required.",
        });
        return false;
      }

      const workspaceToken = workspace.openworkToken?.trim() || undefined;
      const globalToken = openworkServerSettings().token?.trim() || undefined;
      const token = workspaceToken || globalToken;
      const canRetryWithGlobal = globalToken && workspaceToken && globalToken !== workspaceToken;
      try {
        let resolved = await resolveOpenworkHost({
          hostUrl,
          token,
          workspaceId: workspace.openworkWorkspaceId ?? null,
        });
        // If the workspace-level token is stale, retry with the global settings token.
        if (resolved.kind !== "openwork" && canRetryWithGlobal) {
          resolved = await resolveOpenworkHost({
            hostUrl,
            token: globalToken,
            workspaceId: workspace.openworkWorkspaceId ?? null,
          });
        }
        if (resolved.kind !== "openwork") {
          updateWorkspaceConnectionState(id, {
            status: "error",
            message: "SuperClaw server unavailable. Check the URL and token.",
          });
          return false;
        }
        updateWorkspaceConnectionState(id, { status: "connected", message: null });
        return true;
      } catch (error) {
        // If the workspace-level token caused a rejection, retry with the global token.
        if (canRetryWithGlobal) {
          try {
            const resolved = await resolveOpenworkHost({
              hostUrl,
              token: globalToken,
              workspaceId: workspace.openworkWorkspaceId ?? null,
            });
            if (resolved.kind === "openwork") {
              updateWorkspaceConnectionState(id, { status: "connected", message: null });
              return true;
            }
          } catch {
            // fall through to original error
          }
        }
        const message = error instanceof Error ? error.message : safeStringify(error);
        updateWorkspaceConnectionState(id, { status: "error", message });
        return false;
      }
    }

    const baseUrl = workspace.baseUrl?.trim() || "";
    if (!baseUrl) {
      updateWorkspaceConnectionState(id, {
        status: "error",
        message: "Remote base URL is required.",
      });
      return false;
    }

    try {
      const client = createClient(baseUrl, workspace.directory?.trim() || undefined);
      await waitForHealthy(client, { timeoutMs: 8_000 });
      updateWorkspaceConnectionState(id, { status: "connected", message: null });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : safeStringify(error);
      updateWorkspaceConnectionState(id, { status: "error", message });
      return false;
    }
  }

  /**
   * Sync a token onto all persisted openwork workspaces whose token differs.
   * If `explicitToken` is provided, it takes precedence over the global
   * settings token. This is required during backend-ready handling because a
   * reactive effect in app.tsx may temporarily revert the global settings
   * token to the previous workspace token before workspaces are patched.
   * Updates both the in-memory signal and the Tauri backend storage. Returns
   * the number of workspaces patched.
   */
  async function syncOpenworkTokens(explicitToken?: string, trace?: OwtTrace): Promise<number> {
    const globalToken =
      explicitToken?.trim() || openworkServerSettings().token?.trim();
    if (!globalToken) {
      if (trace) {
        uiLogWarn("runtime.owt.sync", "Workspace sync skipped because no token is available", {
          requestId: trace.requestId,
          attempt: trace.attempt,
          errorCode: "token_unavailable",
          elapsedMs: 0,
          tokenCreatedAt: trace.tokenCreatedAt,
          tokenScope: trace.tokenScope,
          tokenRevision: trace.tokenRevision,
        });
      }
      return 0;
    }

    const stale = workspaces().filter(
      (w) =>
        w.workspaceType === "remote" &&
        normalizeRemoteType(w.remoteType) === "openwork" &&
        w.openworkToken?.trim() &&
        w.openworkToken.trim() !== globalToken,
    );
    if (stale.length === 0) {
      if (trace) {
        uiLogInfo("runtime.owt.sync", "Workspace token sync completed", {
          requestId: trace.requestId,
          attempt: trace.attempt,
          status: "succeeded",
          workspaceCount: 0,
          elapsedMs: 0,
          tokenCreatedAt: trace.tokenCreatedAt,
          tokenScope: trace.tokenScope,
          tokenRevision: trace.tokenRevision,
        });
      }
      return 0;
    }

    const startedAt = Date.now();
    setWorkspaces((prev) =>
      prev.map((w) =>
        stale.some((s) => s.id === w.id) ? { ...w, openworkToken: globalToken } : w,
      ),
    );

    if (isTauriRuntime()) {
      for (const w of stale) {
        try {
          await workspaceUpdateRemote({ workspaceId: w.id, openworkToken: globalToken });
          if (trace) {
            uiLogInfo("runtime.owt.persist", "Workspace token persisted", {
              requestId: trace.requestId,
              workspaceId: w.id,
              attempt: trace.attempt,
              status: "succeeded",
              elapsedMs: Date.now() - startedAt,
              tokenCreatedAt: trace.tokenCreatedAt,
              tokenScope: trace.tokenScope,
              tokenRevision: trace.tokenRevision,
            });
          }
        } catch (error) {
          const classified = classifyWorkspaceError(error);
          uiLogError("runtime.owt.persist", "Workspace token persistence failed", {
            requestId: trace?.requestId ?? makeRunId(),
            workspaceId: w.id,
            attempt: trace?.attempt ?? 1,
            status: "failed",
            errorCode: "workspace_persistence_failed",
            causeCode: classified.code,
            elapsedMs: Date.now() - startedAt,
            tokenCreatedAt: trace?.tokenCreatedAt ?? "",
            tokenScope: trace?.tokenScope ?? "",
            tokenRevision: trace?.tokenRevision ?? null,
          });
        }
      }
    }
    if (trace) {
      uiLogInfo("runtime.owt.sync", "Workspace token sync completed", {
        requestId: trace.requestId,
        attempt: trace.attempt,
        status: "succeeded",
        workspaceCount: stale.length,
        elapsedMs: Date.now() - startedAt,
        tokenCreatedAt: trace.tokenCreatedAt,
        tokenScope: trace.tokenScope,
        tokenRevision: trace.tokenRevision,
      });
    }
    return stale.length;
  }

  return {
    updateWorkspaceConnectionState,
    testWorkspaceConnection,
    syncOpenworkTokens,
  };
}
