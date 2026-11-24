import { Buffer } from "node:buffer";

import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";

import type { Config } from "./config.js";

type Client = ReturnType<typeof createOpencodeClient>;

export type PromptErrorRecord = {
  name?: unknown;
  message?: unknown;
  data?: { message?: unknown; statusCode?: unknown };
  status?: unknown;
  statusCode?: unknown;
};

export function getPromptErrorDetails(error: unknown) {
  if (error instanceof Error) {
    const record = error as Error & PromptErrorRecord;
    return {
      name: error.name,
      message: error.message ?? "",
      status:
        typeof record.status === "number"
          ? record.status
          : typeof record.statusCode === "number"
            ? record.statusCode
            : undefined,
    };
  }
  const record = (error ?? null) as PromptErrorRecord | null;
  return {
    name: typeof record?.name === "string" ? record.name : undefined,
    message:
      typeof record?.message === "string"
        ? record.message
        : typeof record?.data?.message === "string"
          ? record.data.message
          : typeof error === "string"
            ? error
            : "",
    status:
      typeof record?.status === "number"
        ? record.status
        : typeof record?.statusCode === "number"
          ? record.statusCode
          : typeof record?.data?.statusCode === "number"
            ? record.data.statusCode
            : undefined,
  };
}

// The SDK throws parsed JSON bodies directly, rather than Error instances.
export function isMissingSessionPromptError(error: unknown): boolean {
  const { name, message } = getPromptErrorDetails(error);
  const lower = message.toLowerCase();
  return name === "NotFoundError" || (lower.includes("session") && lower.includes("not found"));
}

export function createClient(config: Config, directory?: string): Client {
  const headers: Record<string, string> = {};
  if (config.opencodeUsername && config.opencodePassword) {
    const token = Buffer.from(`${config.opencodeUsername}:${config.opencodePassword}`).toString("base64");
    headers.Authorization = `Basic ${token}`;
  }

  // egress-surface: opencode_router_opencode
  return createOpencodeClient({
    baseUrl: config.opencodeUrl,
    directory: directory ?? config.opencodeDirectory,
    headers: Object.keys(headers).length ? headers : undefined,
    responseStyle: "data",
    throwOnError: true,
  });
}

// Built-in OpenCode tools that reach the network outside the Connector (SSRF screen,
// egress approval). Every profile denies them; channel sessions must never re-grant them.
export const CHANNEL_DENIED_TOOLS = ["webfetch", "websearch"] as const;

export function isChannelDeniedTool(permission: string | undefined): boolean {
  return permission !== undefined && (CHANNEL_DENIED_TOOLS as readonly string[]).includes(permission);
}

export function channelDenyRules() {
  return CHANNEL_DENIED_TOOLS.map((permission) => ({
    permission,
    pattern: "*",
    action: "deny" as const,
  }));
}

export function buildPermissionRules(mode: Config["permissionMode"]) {
  // Inherit lets the agent's own block govern every other tool; the web-tool denies
  // still ride on the session so a custom agent cannot re-grant them.
  if (mode === "inherit") {
    return channelDenyRules();
  }

  if (mode === "deny") {
    return [
      {
        permission: "*",
        pattern: "*",
        action: "deny" as const,
      },
    ];
  }

  // OpenCode merges agent rules then session rules and the LAST match wins, so the
  // denies must follow the blanket allow to keep the profile's deny in force.
  return [
    {
      permission: "*",
      pattern: "*",
      action: "allow" as const,
    },
    ...channelDenyRules(),
  ];
}
