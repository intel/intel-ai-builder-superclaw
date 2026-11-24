import { timingSafeEqual } from "node:crypto";

import { ApiError } from "./errors.js";
import type { Actor, ServerConfig } from "./types.js";
import type { TokenService } from "./tokens.js";
import { hashToken } from "./utils.js";

export async function requireClient(
  request: Request,
  _config: ServerConfig,
  tokens: TokenService,
): Promise<Actor> {
  const token = bearerToken(request);
  if (!token) throw new ApiError(401, "unauthorized", "Invalid bearer token");
  const scope = await tokens.scopeForToken(token);
  if (!scope || scope === "telemetry") throw new ApiError(401, "unauthorized", "Invalid bearer token");
  const clientId = request.headers.get("x-openwork-client-id") ?? undefined;
  return { type: "remote", clientId, tokenHash: hashToken(token), scope };
}

export async function requireHost(
  request: Request,
  config: ServerConfig,
  tokens: TokenService,
): Promise<Actor> {
  const hostToken = request.headers.get("x-openwork-host-token");
  const expectedHash = config.hostTokenHash ?? (config.hostToken ? hashToken(config.hostToken) : "");
  const suppliedHash = hostToken ? hashToken(hostToken) : "";
  if (suppliedHash && safeHashEqual(suppliedHash, expectedHash)) {
    return { type: "host", tokenHash: suppliedHash, scope: "owner" };
  }

  const bearer = bearerToken(request);
  if (!bearer) throw new ApiError(401, "unauthorized", "Invalid host token");
  const scope = await tokens.scopeForToken(bearer);
  if (scope !== "owner") throw new ApiError(401, "unauthorized", "Invalid host token");
  const clientId = request.headers.get("x-openwork-client-id") ?? undefined;
  return { type: "remote", clientId, tokenHash: hashToken(bearer), scope };
}

export async function requireTelemetry(request: Request, tokens: TokenService): Promise<Actor> {
  const bearer = bearerToken(request);
  if (!bearer || await tokens.scopeForToken(bearer) !== "telemetry") {
    throw new ApiError(401, "unauthorized", "Invalid telemetry token");
  }
  return { type: "remote", tokenHash: hashToken(bearer), scope: "telemetry" };
}

function bearerToken(request: Request): string | undefined {
  return request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
}

function safeHashEqual(actual: string, expected: string): boolean {
  return actual.length === expected.length
    && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}
