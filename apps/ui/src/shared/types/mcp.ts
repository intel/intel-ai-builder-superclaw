import type { McpServerExecution, McpServerSource } from "@different-ai/openwork-contracts/mcp";

export type McpServerConfig = {
  type: "remote" | "local";
  url?: string;
  command?: string[];
  enabled?: boolean;
  headers?: Record<string, string>;
  environment?: Record<string, string>;
  oauth?: Record<string, string> | false;
  timeout?: number;
};

export type McpServerEntry = {
  name: string;
  config: McpServerConfig;
  source?: McpServerSource;
  /** `host` runs on this computer, outside the sandbox, through the host MCP gateway. */
  execution?: McpServerExecution;
};

export type McpStatus =
  /** `onDemand`: a host server that is not running now; it starts on its first call. */
  | { status: "connected"; onDemand?: true }
  | { status: "disabled" }
  | { status: "failed"; error: string; code?: string }
  | { status: "needs_auth" }
  | { status: "needs_client_registration"; error: string };

export type McpStatusMap = Record<string, McpStatus>;
