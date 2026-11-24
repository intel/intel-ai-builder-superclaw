import type { McpServerStatus } from "@different-ai/openwork-contracts/mcp";
import { ApiError } from "../errors.js";

export type McpOperationOutcome = {
  operation: "connect" | "remove" | "logout";
  step: "persist" | "reload" | "connect" | "disconnect" | "auth-remove";
  target: "instance-runtime" | "workspace-config";
  method?: "GET" | "POST" | "DELETE";
  path?: string;
  transport?: "local" | "remote";
  command?: string;
  host?: string;
  result: "success" | "failed";
  durationMs: number;
  errorCode?: string;
  errorMessage?: string;
  httpStatus?: number;
};

export type McpOperationDescriptor = Omit<
  McpOperationOutcome,
  "result" | "durationMs" | "errorCode" | "errorMessage" | "httpStatus"
>;

export type McpOperationCapture<T> =
  | { ok: true; outcome: McpOperationOutcome; value: T }
  | { ok: false; outcome: McpOperationOutcome; error: unknown };

export type McpConnectTarget = Pick<McpOperationOutcome, "transport" | "command" | "host">;

const FAILED_CONNECT_STATUSES = new Set<McpServerStatus["status"]>([
  "failed",
  "needs_auth",
  "needs_client_registration",
]);

/** Environment, headers, OAuth settings and URL userinfo, path or query never leave the config. */
export function describeConnectTarget(config: Record<string, unknown> | undefined): McpConnectTarget {
  if (config?.type === "local") {
    const parts = Array.isArray(config.command)
      ? config.command.filter((part): part is string => typeof part === "string")
      : [];
    return parts.length > 0 ? { transport: "local", command: parts.join(" ") } : { transport: "local" };
  }
  if (config?.type === "remote") {
    try {
      return { transport: "remote", host: new URL(String(config.url)).host };
    } catch (_error: unknown) {
      return { transport: "remote" };
    }
  }
  return {};
}

export function connectOutcomeFromStatus(
  outcome: McpOperationOutcome,
  status: McpServerStatus | undefined,
): McpOperationOutcome {
  if (!status || !FAILED_CONNECT_STATUSES.has(status.status)) return outcome;
  return { ...outcome, result: "failed", errorMessage: status.error || status.status };
}

export function mcpOperationApiError(
  error: unknown,
  operations: McpOperationOutcome[],
): ApiError {
  if (error instanceof ApiError) {
    return new ApiError(error.status, error.code, error.message, { operations });
  }
  return new ApiError(500, "internal_error", "Unexpected server error", { operations });
}

function apiErrorHttpStatus(error: ApiError): number | undefined {
  if (!error.details || typeof error.details !== "object") return undefined;
  const status = (error.details as { status?: unknown }).status;
  return typeof status === "number" && Number.isInteger(status) ? status : undefined;
}

export async function captureMcpOperation<T>(
  descriptor: McpOperationDescriptor,
  run: () => Promise<T>,
): Promise<McpOperationCapture<T>> {
  const startedAt = performance.now();
  try {
    const value = await run();
    return {
      ok: true,
      value,
      outcome: {
        ...descriptor,
        result: "success",
        durationMs: Math.round(performance.now() - startedAt),
      },
    };
  } catch (error) {
    const safeError = error instanceof ApiError
      ? {
        errorCode: error.code,
        errorMessage: error.message,
        httpStatus: apiErrorHttpStatus(error),
      }
      : {
        errorCode: "internal_error",
        errorMessage: "Unexpected MCP operation failure",
      };
    return {
      ok: false,
      error,
      outcome: {
        ...descriptor,
        result: "failed",
        durationMs: Math.round(performance.now() - startedAt),
        ...safeError,
      },
    };
  }
}