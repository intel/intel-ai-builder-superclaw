/**
 * The Connections toggle for Gmail: pause or resume the authorization without removing it.
 *
 * Kept out of server.ts, which is past the file-size limit; the plumbing arrives as
 * `deps` for the reason github-routes.ts gives. The other Gmail routes still live there.
 */

import { recordAudit } from "./audit.js";
import { ApiError } from "./errors.js";
import { gmailDataDir, gmailPaused, setGmailEnabled } from "./gmail.js";
import type { AuthMode, RequestContext, Route } from "./server.js";
import type { ServerConfig, TokenScope, WorkspaceInfo } from "./types.js";
import { shortId } from "./utils.js";

export interface GmailRouteDeps {
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
  requireClientScope: (ctx: RequestContext, required: TokenScope) => void;
  resolveWorkspace: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
}

export function registerGmailEnabledRoute(routes: Route[], config: ServerConfig, deps: GmailRouteDeps): void {
  const { addRoute, ensureWritable, jsonResponse, readJsonBody, requireClientScope, resolveWorkspace } = deps;

  addRoute(routes, "PUT", "/workspace/:id/gmail/enabled", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    if (typeof body.enabled !== "boolean") {
      throw new ApiError(400, "invalid_payload", "enabled must be true or false");
    }
    const enabled = body.enabled;
    const gmailDir = gmailDataDir(workspace.path);
    if (!(await setGmailEnabled(gmailDir, enabled))) {
      throw new ApiError(409, "gmail_not_authorized", "Gmail is not authorized yet, so there is nothing to switch.");
    }

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "gmail.enabled",
      target: gmailDir,
      summary: enabled ? "Resumed Gmail" : "Paused Gmail; its authorization is kept",
      timestamp: Date.now(),
    });

    return jsonResponse({ paused: gmailPaused(gmailDir) });
  });
}
