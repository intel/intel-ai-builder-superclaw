/**
 * Workspace-scoped routes that let the UI review what the protected pipeline masked
 * and mask extra user-supplied words before the file reaches a cloud model.
 *
 * Thin proxy to the data_protection sidecar: the sidecar owns the registry and the
 * masked file, and the PRIVACY_API_KEY stays on this side. Entity values travel only
 * sidecar -> this server -> the local UI, never through model context.
 */

import { ApiError } from "./errors.js";
import type { AuthMode, RequestContext, Route } from "./server.js";
import type { ServerConfig, TokenScope, WorkspaceInfo } from "./types.js";

export interface MaskedReviewRouteDeps {
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

const REVIEW_PATH = "/v1/file/protect/review";
const EXTRA_TERMS_PATH = "/v1/file/protect/extra-terms";
const MAX_TERMS = 50;

export function resolveDataProtectionUrl(path: string): string {
  const host = process.env.DATA_PROTECTION_HOST?.trim() || "127.0.0.1";
  const port = process.env.DATA_PROTECTION_PORT?.trim() || "18826";
  return `http://${host}:${port}${path}`;
}

function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim() || value.length > 256) {
    throw new ApiError(400, "invalid_payload", `${key} is required`);
  }
  return value;
}

async function callDataProtection(path: string, payload: Record<string, unknown>): Promise<Response> {
  const apiKey = process.env.PRIVACY_API_KEY?.trim();
  if (!apiKey) {
    throw new ApiError(503, "privacy_unavailable", "The privacy service credential is unavailable.");
  }
  try {
    // egress-surface: data_protection_file_pipeline
    return await fetch(resolveDataProtectionUrl(path), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new ApiError(502, "privacy_unreachable", "The privacy service could not be reached.");
  }
}

async function relay(
  response: Response,
  jsonResponse: MaskedReviewRouteDeps["jsonResponse"],
): Promise<Response> {
  const data = (await response.json().catch(() => ({}))) as { detail?: { message?: unknown } };
  if (!response.ok) {
    const message = typeof data.detail?.message === "string" ? data.detail.message : "Masking review failed.";
    throw new ApiError(response.status === 404 || response.status === 415 ? response.status : 502, "masking_review_failed", message);
  }
  return jsonResponse(data);
}

export function registerMaskedReviewRoutes(
  routes: Route[],
  config: ServerConfig,
  deps: MaskedReviewRouteDeps,
): void {
  const { addRoute, ensureWritable, jsonResponse, readJsonBody, requireClientScope, resolveWorkspace } = deps;

  addRoute(routes, "POST", "/workspace/:id/privacy/masked-review", "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const response = await callDataProtection(REVIEW_PATH, {
      session_id: requireString(body, "sessionId"),
      operation_id: requireString(body, "operationId"),
    });
    return relay(response, jsonResponse);
  });

  addRoute(routes, "POST", "/workspace/:id/privacy/masked-extra-terms", "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    ensureWritable(config);
    await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const terms = Array.isArray(body.terms)
      ? body.terms.filter((t): t is string => typeof t === "string")
      : [];
    if (terms.length === 0) throw new ApiError(400, "invalid_payload", "terms is required");
    if (terms.length > MAX_TERMS) {
      throw new ApiError(400, "invalid_payload", `At most ${MAX_TERMS} words can be masked at once.`);
    }
    const response = await callDataProtection(EXTRA_TERMS_PATH, {
      session_id: requireString(body, "sessionId"),
      operation_id: requireString(body, "operationId"),
      terms,
    });
    return relay(response, jsonResponse);
  });
}
