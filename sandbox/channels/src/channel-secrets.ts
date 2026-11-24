import type { SlackIdentity } from "./config.js";
import { readConfigFile } from "./config.js";

type LegacySlackIdentity = {
  id?: unknown;
  botToken?: unknown;
  appToken?: unknown;
  botTokenRef?: unknown;
  appTokenRef?: unknown;
  enabled?: unknown;
  directory?: unknown;
};

type SecretClientOptions = {
  baseUrl: string;
  token: string;
};

class ChannelSecretRequestError extends Error {
  constructor(readonly status: number) {
    super(`Channel secret adapter returned HTTP ${status}`);
  }
}

function optionsFromEnv(env: NodeJS.ProcessEnv): SecretClientOptions | null {
  const baseUrl = env.SC_CHANNEL_SECRET_API_URL?.trim().replace(/\/$/, "") ?? "";
  const token = env.SC_CHANNEL_SECRET_RESOLVE_TOKEN?.trim() ?? "";
  return baseUrl && token ? { baseUrl, token } : null;
}

function managementOptionsFromEnv(env: NodeJS.ProcessEnv): SecretClientOptions | null {
  const baseUrl = env.SC_CHANNEL_SECRET_API_URL?.trim().replace(/\/$/, "") ?? "";
  const token = env.SC_CHANNEL_SECRET_MANAGEMENT_TOKEN?.trim() ?? "";
  return baseUrl && token ? { baseUrl, token } : null;
}

async function requestJson(
  options: SecretClientOptions,
  pathname: string,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  let response: Response;
  try {
    // egress-surface: opencode_router_channel_secret_adapter
    response = await fetch(`${options.baseUrl}${pathname}`, {
      ...init,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.token}`,
        ...init.headers,
      },
    });
  } catch {
    throw new Error("Channel secret adapter is unavailable");
  } finally {
    clearTimeout(timeout);
  }
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new ChannelSecretRequestError(response.status);
  return payload;
}

export async function storeSlackSecrets(
  identityId: string,
  botToken: string,
  appToken: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ botTokenRef: string; appTokenRef: string }> {
  const options = managementOptionsFromEnv(env);
  if (!options) throw new Error("Channel secret adapter is unavailable");
  const payload = await requestJson(
    options,
    `/v1/channel-secrets/slack/${encodeURIComponent(identityId)}`,
    { method: "PUT", body: JSON.stringify({ botToken, appToken }) },
  );
  if (typeof payload.botTokenRef !== "string" || typeof payload.appTokenRef !== "string") {
    throw new Error("Channel secret adapter returned invalid references");
  }
  return { botTokenRef: payload.botTokenRef, appTokenRef: payload.appTokenRef };
}

export async function deleteSlackSecrets(
  identityId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const options = managementOptionsFromEnv(env);
  if (!options) throw new Error("Channel secret adapter is unavailable");
  const payload = await requestJson(
    options,
    `/v1/channel-secrets/slack/${encodeURIComponent(identityId)}`,
    { method: "DELETE" },
  );
  return payload.deleted === true;
}

export async function deleteSlackSecretReferences(
  references: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (references.length === 0) return false;
  const options = managementOptionsFromEnv(env);
  if (!options) throw new Error("Channel secret adapter is unavailable");
  const payload = await requestJson(options, "/v1/channel-secrets/deletions", {
    method: "POST",
    body: JSON.stringify({ refs: references }),
  });
  return payload.deleted === true;
}

async function resolveSlackRefs(
  botTokenRef: string,
  appTokenRef: string,
  env: NodeJS.ProcessEnv,
): Promise<{ botToken: string; appToken: string }> {
  const options = optionsFromEnv(env);
  if (!options) throw new Error("Channel secret adapter is unavailable");
  const payload = await requestJson(options, "/v1/channel-secrets/resolve", {
    method: "POST",
    body: JSON.stringify({ refs: [botTokenRef, appTokenRef] }),
  });
  const values = payload.values;
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    throw new Error("Channel secret adapter returned invalid values");
  }
  const record = values as Record<string, unknown>;
  const botToken = record[botTokenRef];
  const appToken = record[appTokenRef];
  if (typeof botToken !== "string" || typeof appToken !== "string") {
    throw new Error("Channel secret adapter did not resolve both Slack tokens");
  }
  return { botToken, appToken };
}

export async function prepareSlackIdentities(
  configPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SlackIdentity[]> {
  const { config } = readConfigFile(configPath);
  const slack = config.channels?.slack;
  const rawApps = Array.isArray(slack?.apps) ? slack.apps as LegacySlackIdentity[] : [];
  const legacyApps = rawApps.length > 0
    ? rawApps
    : slack?.botToken && slack?.appToken
      ? [{ id: "default", botToken: slack.botToken, appToken: slack.appToken, enabled: true }]
      : [];
  if (legacyApps.some((entry) => {
    const hasPlaintext = typeof entry.botToken === "string" && typeof entry.appToken === "string";
    const hasRefs = typeof entry.botTokenRef === "string" && typeof entry.appTokenRef === "string";
    return !hasPlaintext && !hasRefs;
  })) {
    throw new Error("Slack identity configuration contains incomplete credentials");
  }
  const runtime: SlackIdentity[] = [];
  for (const entry of legacyApps) {
    const id = typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : "default";
    const enabled = entry.enabled === undefined ? true : entry.enabled === true;
    const directory = typeof entry.directory === "string" ? entry.directory.trim() : "";
    const botToken = typeof entry.botToken === "string" ? entry.botToken.trim() : "";
    const appToken = typeof entry.appToken === "string" ? entry.appToken.trim() : "";
    const botTokenRef = typeof entry.botTokenRef === "string" ? entry.botTokenRef.trim() : "";
    const appTokenRef = typeof entry.appTokenRef === "string" ? entry.appTokenRef.trim() : "";
    const credentials = botToken && appToken
      ? { botToken, appToken }
      : await resolveSlackRefs(botTokenRef, appTokenRef, env);
    runtime.push({ id, ...credentials, enabled, ...(directory ? { directory } : {}) });
  }
  return runtime;
}
