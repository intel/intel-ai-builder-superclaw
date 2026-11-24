import { invoke } from "@tauri-apps/api/core";
import type { McpOperationOutcome as OpenworkMcpOperationOutcome } from "@different-ai/openwork-contracts/mcp";

export type McpDiagnosticEvent = {
  operation: "connect" | "reconnect" | "remove" | "logout" | "health-check" | "authorize";
  step: "launch" | "request" | "persist" | "register" | "connect" | "disconnect" | "auth-remove" | "status" | "probe" | "start" | "callback" | "listener" | "open-url" | "reload";
  source: "desktop-ui" | "health-monitor" | "openwork" | "opencode" | "tauri";
  target?: "openwork" | "opencode" | "instance-runtime" | "workspace-config" | "project-config" | "windows-loopback" | "oauth-listener" | "external-browser";
  mcp?: string;
  method?: "GET" | "POST" | "DELETE";
  path?: string;
  transport?: "local" | "remote";
  command?: string;
  endpoint?: string;
  host?: string;
  port?: number;
  result?: "success" | "failed";
  status?: string;
  durationMs?: number;
  reason?: string;
  error?: unknown;
};

const OPENWORK_MCP_OPERATIONS = new Set(["connect", "remove", "logout"]);
const OPENWORK_MCP_STEPS = new Set(["persist", "reload", "connect", "disconnect", "auth-remove"]);
const OPENWORK_MCP_TARGETS = new Set(["instance-runtime", "workspace-config"]);
const OPENWORK_MCP_METHODS = new Set(["GET", "POST", "DELETE"]);
const OPENWORK_MCP_TRANSPORTS = new Set(["local", "remote"]);

function isOpenworkMcpOperationOutcome(value: unknown): value is OpenworkMcpOperationOutcome {
  if (!value || typeof value !== "object") return false;
  const outcome = value as Record<string, unknown>;
  return typeof outcome.operation === "string" && OPENWORK_MCP_OPERATIONS.has(outcome.operation)
    && typeof outcome.step === "string" && OPENWORK_MCP_STEPS.has(outcome.step)
    && typeof outcome.target === "string" && OPENWORK_MCP_TARGETS.has(outcome.target)
    && (outcome.method === undefined || (typeof outcome.method === "string" && OPENWORK_MCP_METHODS.has(outcome.method)))
    && (outcome.path === undefined || typeof outcome.path === "string")
    && (outcome.transport === undefined || (typeof outcome.transport === "string" && OPENWORK_MCP_TRANSPORTS.has(outcome.transport)))
    && (outcome.command === undefined || typeof outcome.command === "string")
    && (outcome.host === undefined || typeof outcome.host === "string")
    && (outcome.result === "success" || outcome.result === "failed")
    && typeof outcome.durationMs === "number" && Number.isFinite(outcome.durationMs) && outcome.durationMs >= 0
    && (outcome.errorCode === undefined || typeof outcome.errorCode === "string")
    && (outcome.errorMessage === undefined || typeof outcome.errorMessage === "string")
    && (outcome.httpStatus === undefined || (typeof outcome.httpStatus === "number" && Number.isInteger(outcome.httpStatus)));
}

export function openworkMcpOperationOutcomesFromError(error: unknown): OpenworkMcpOperationOutcome[] {
  if (!error || typeof error !== "object") return [];
  const details = (error as { details?: unknown }).details;
  if (!details || typeof details !== "object") return [];
  const operations = (details as { operations?: unknown }).operations;
  return Array.isArray(operations) ? operations.filter(isOpenworkMcpOperationOutcome) : [];
}

export function mcpDiagnosticEventFromOpenworkOutcome(
  mcp: string,
  outcome: OpenworkMcpOperationOutcome,
): McpDiagnosticEvent {
  const reason = outcome.errorCode
    ? `${outcome.errorCode}${outcome.httpStatus === undefined ? "" : ` (HTTP ${outcome.httpStatus})`}`
    : outcome.httpStatus === undefined ? undefined : `HTTP ${outcome.httpStatus}`;
  return {
    operation: outcome.operation,
    step: outcome.step,
    source: "openwork",
    target: outcome.target,
    mcp,
    method: outcome.method,
    path: outcome.path,
    transport: outcome.transport,
    command: outcome.command,
    host: outcome.host,
    result: outcome.result,
    durationMs: outcome.durationMs,
    reason,
    error: outcome.errorMessage,
  };
}

export async function recordOpenworkMcpOperationOutcomes(
  mcp: string,
  operations: OpenworkMcpOperationOutcome[] | undefined,
): Promise<void> {
  if (!operations) return;
  for (const outcome of operations) {
    await recordMcpDiagnostic(mcpDiagnosticEventFromOpenworkOutcome(mcp, outcome));
  }
}

const SIMPLE_VALUE = /^[A-Za-z0-9._~:/?%=&+-]+$/;

function diagnosticErrorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function formatDiagnosticValue(value: string | number): string {
  if (typeof value === "number") return String(value);
  return SIMPLE_VALUE.test(value) ? value : JSON.stringify(value);
}

export function formatMcpDiagnosticEvent(event: McpDiagnosticEvent): string {
  const outcome = event.result ?? event.status;
  const request = event.method || event.path
    ? [event.method, event.path].filter(Boolean).join(" ")
    : undefined;
  const endpoint = event.endpoint ?? (event.host && event.port !== undefined
    ? `${event.host}:${event.port}`
    : event.host ?? event.port);
  const fields: Array<[string, string | number | undefined]> = [
    ["server", event.mcp],
    ["source", event.source],
    ["target", event.target],
    ["transport", event.transport],
    ["command", event.command],
    ["request", request],
    ["endpoint", endpoint],
    ["elapsed", event.durationMs === undefined ? undefined : `${(event.durationMs / 1_000).toFixed(3)}s`],
    ["reason", event.reason],
    ["error", event.error === undefined ? undefined : diagnosticErrorText(event.error)],
  ];

  return [`[${event.operation}/${event.step}]`, outcome ? `[${outcome}]` : null, ...fields
    .filter((field): field is [string, string | number] => field[1] !== undefined)
    .map(([key, value]) => `${key}=${formatDiagnosticValue(value)}`)]
    .filter((part): part is string => part !== null)
    .join(" ");
}

export function formatMcpDiagnosticTimestamp(now: Date): string {
  const hour = now.getHours() % 12 || 12;
  const time = [hour, now.getMinutes(), now.getSeconds()]
    .map((part, index) => index === 0 ? String(part) : String(part).padStart(2, "0"))
    .join(".");
  return `${time}${now.getHours() >= 12 ? "pm" : "am"} ${now.getDate()}/${now.getMonth() + 1}/${now.getFullYear()}`;
}

export async function recordMcpDiagnostic(event: McpDiagnosticEvent): Promise<string | undefined> {
  const now = new Date();
  const timestamp = formatMcpDiagnosticTimestamp(now);
  const date = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");

  const line = `${timestamp} ${formatMcpDiagnosticEvent(event)}`;
  try {
    return await invoke<string>("mcp_diagnostic_line", { date, line });
  } catch (error) {
    console.warn("MCP diagnostic write failed", { line, error: diagnosticErrorText(error) });
    return undefined;
  }
}