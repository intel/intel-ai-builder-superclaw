export type OpencodeEvent = {
  type: string;
  properties?: unknown;
};

export type ReloadReason = "plugins" | "skills" | "mcp" | "config" | "agents" | "commands";

export type OpencodeConnectStatus = {
  at: number;
  baseUrl: string;
  directory?: string | null;
  reason?: string | null;
  status: "connecting" | "connected" | "error";
  error?: string | null;
  metrics?: {
    healthyMs?: number;
    loadSessionsMs?: number;
    pendingPermissionsMs?: number;
    providersMs?: number;
    totalMs?: number;
  };
};

export type ReloadTrigger = {
  type: "skill" | "plugin" | "config" | "mcp" | "agent" | "command";
  name?: string;
  action?: "added" | "removed" | "updated";
  path?: string;
};
