/**
 * Workspace-scoped routes for the GitHub CLI credential.
 *
 * Split out of server.ts, which is already ~8,000 lines. The plumbing these need
 * is private to that file, so it arrives as `deps`: a runtime import back into
 * server.ts would be a cycle, and exporting the plumbing would widen its surface
 * for one caller.
 *
 * No route returns the token — the UI only sees the login name and scopes.
 * Device-flow state rides along on the status response so a pending login needs
 * one poll, not two.
 */

import { recordAudit } from "./audit.js";
import { ApiError } from "./errors.js";
import {
  githubConfigDir,
  githubLogoutTargets,
  loginWithToken,
  logoutGithub,
  readGithubAuthStatus,
  setGithubEnabled,
} from "./github-auth.js";
import {
  cancelGithubDeviceLogin,
  githubDeviceLoginState,
  startGithubDeviceLogin,
} from "./github-device-flow.js";
import type { AuthMode, RequestContext, Route } from "./server.js";
import type { ApprovalRequest, ServerConfig, TokenScope, WorkspaceInfo } from "./types.js";
import { shortId } from "./utils.js";

export interface GithubRouteDeps {
  addRoute: (
    routes: Route[],
    method: string,
    path: string,
    auth: AuthMode,
    handler: Route["handler"],
  ) => void;
  ensureWritable: (config: ServerConfig) => void;
  jsonResponse: (data: unknown, status?: number) => Response;
  readJsonBody: (request: Request) => Promise<Record<string, unknown>>;
  requireApproval: (
    ctx: RequestContext,
    input: Omit<ApprovalRequest, "id" | "createdAt" | "actor">,
  ) => Promise<void>;
  requireClientScope: (ctx: RequestContext, required: TokenScope) => void;
  resolveWorkspace: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
}

export function registerGithubRoutes(
  routes: Route[],
  config: ServerConfig,
  deps: GithubRouteDeps,
): void {
  const {
    addRoute,
    ensureWritable,
    jsonResponse,
    readJsonBody,
    requireApproval,
    requireClientScope,
    resolveWorkspace,
  } = deps;

  addRoute(routes, "GET", "/workspace/:id/github/status", "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    await resolveWorkspace(config, ctx.params.id);
    const status = await readGithubAuthStatus();
    return jsonResponse({ ...status, deviceFlow: githubDeviceLoginState() });
  });

  addRoute(routes, "POST", "/workspace/:id/github/token", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const token = typeof body.token === "string" ? body.token.trim() : "";
    if (!token) {
      throw new ApiError(400, "invalid_payload", "token is required");
    }

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "github.auth.token",
      summary: "Store a GitHub token for the gh CLI",
      paths: [githubConfigDir()],
    });

    const status = await loginWithToken(token);

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "github.auth.token",
      target: githubConfigDir(),
      summary: `Connected GitHub account ${status.login ?? "(unknown login)"} via token`,
      timestamp: Date.now(),
    });

    return jsonResponse({ ...status, deviceFlow: githubDeviceLoginState() });
  });

  addRoute(routes, "POST", "/workspace/:id/github/device", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "github.auth.device",
      summary: "Sign in to GitHub in the browser",
      paths: [githubConfigDir()],
    });

    const deviceFlow = await startGithubDeviceLogin();

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "github.auth.device",
      target: githubConfigDir(),
      summary: "Started GitHub browser sign-in",
      timestamp: Date.now(),
    });

    return jsonResponse({ deviceFlow });
  });

  addRoute(routes, "DELETE", "/workspace/:id/github/device", "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    await resolveWorkspace(config, ctx.params.id);
    cancelGithubDeviceLogin();
    return jsonResponse({ deviceFlow: githubDeviceLoginState() });
  });

  addRoute(routes, "PUT", "/workspace/:id/github/enabled", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    if (typeof body.enabled !== "boolean") {
      throw new ApiError(400, "invalid_payload", "enabled must be true or false");
    }
    const enabled = body.enabled;

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "github.auth.enabled",
      summary: enabled ? "Resume the paused GitHub account for the gh CLI" : "Pause the GitHub account for the gh CLI",
      paths: [githubConfigDir()],
    });

    const status = await setGithubEnabled(enabled);

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "github.auth.enabled",
      target: githubConfigDir(),
      summary: enabled ? "Resumed the GitHub account" : "Paused the GitHub account",
      timestamp: Date.now(),
    });

    return jsonResponse({ ...status, deviceFlow: githubDeviceLoginState() });
  });

  addRoute(routes, "DELETE", "/workspace/:id/github/auth", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    // Read before the sign-out: it removes the legacy store, which then drops out of the list.
    const targets = githubLogoutTargets();

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "github.auth.logout",
      summary: "Disconnect the GitHub account from the gh CLI",
      paths: targets,
    });

    cancelGithubDeviceLogin();
    await logoutGithub();

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "github.auth.logout",
      target: targets.join(", "),
      summary: "Disconnected the GitHub account",
      timestamp: Date.now(),
    });

    const status = await readGithubAuthStatus();
    return jsonResponse({ ...status, deviceFlow: githubDeviceLoginState() });
  });
}
