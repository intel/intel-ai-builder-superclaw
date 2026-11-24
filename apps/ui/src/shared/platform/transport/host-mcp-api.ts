/**
 * The one frontend entry to the host MCP gateway's management API (`/mcp-host/v1/*`): the servers
 * the user runs outside the sandbox, their approvals and the host browser.
 *
 * The app reaches these routes through ServiceHub's `/mcp-host` forwarding with the hub token, never
 * through openwork-server: registering a host command or deciding an approval must not pass through a
 * sandbox tier. Every answer is parsed with the contract's schemas; only this file names the paths.
 */
import { createMemo, type Accessor } from "solid-js";
import {
  HOST_MCP_APPROVALS_MAX_WAIT_MS,
  HOST_MCP_ERRORS,
  HostBrowserConfigRequestSchema,
  HostBrowserViewSchema,
  HostMcpApprovalDecisionRequestSchema,
  HostMcpApprovalDecisionResultSchema,
  HostMcpErrorCodeSchema,
  HostMcpOkSchema,
  HostMcpPendingApprovalListSchema,
  HostMcpServerListSchema,
  HostMcpServerRegisterRequestSchema,
  HostMcpServerRegistrationSchema,
  HostMcpStatusSchema,
  HostMcpStopAllResultSchema,
  type HostBrowserConfigRequest,
  type HostBrowserView,
  type HostMcpApprovalDecision,
  type HostMcpApprovalDecisionResult,
  type HostMcpErrorCode,
  type HostMcpGrantScope,
  type HostMcpPendingApproval,
  type HostMcpServer,
  type HostMcpServerRegisterRequest,
  type HostMcpServerRegistration,
  type HostMcpStatus,
  type HostMcpStopAllResult,
} from "@different-ai/openwork-contracts/host-mcp-api";
import { McpServerNameSchema } from "@different-ai/openwork-contracts/mcp";

import {
  requestServiceHubJson,
  ServiceHubHttpError,
  ServiceHubResponseError,
  type ServiceHubRequestOptions,
  type ServiceHubSettings,
} from "./servicehub";

/** Service name as it appears in `GET /app/services/catalog`. */
export const HOST_MCP_SERVICE_NAME = "mcp_host_manager";

const V1 = "/mcp-host/v1";
const TIMEOUT_MS = 10_000;
/** The gateway is `on_demand`: a request that starts it waits out ServiceHub's 30 s `ready_timeout_s`. */
const COLD_TIMEOUT_MS = 45_000;
/** A held list answers within its wait; this is ServiceHub's time to forward it. */
const HELD_LIST_MARGIN_MS = 5_000;

/**
 * Why a call failed. A gateway code is the contract's; the rest are this adapter's:
 * `service_absent` is a build that does not register the gateway, `service_start_failed` and
 * `service_unavailable` are ServiceHub answering for a gateway that is not running.
 */
export type HostMcpFailureCode =
  | HostMcpErrorCode
  | "service_absent"
  | "service_start_failed"
  | "service_unavailable"
  | "refused"
  | "unreachable"
  | "unreadable";

/**
 * What the user reads when a call fails without a gateway code. A gateway code shows its contract
 * sentence, whatever words the body carried; never a status line or a raw transport message.
 */
export const HOST_MCP_FAILURES = {
  service_absent: "This version of SuperClaw cannot run tools on your computer.",
  service_start_failed: "The service that runs tools on your computer could not be started.",
  service_unavailable: "The service that runs tools on your computer is not running.",
  refused: "The host service did not accept the request.",
  unreachable: "The host service could not be reached.",
  unreadable: "The host service answered with something this app does not understand.",
} as const satisfies Record<Exclude<HostMcpFailureCode, HostMcpErrorCode>, string>;

export class HostMcpApiError extends Error {
  readonly code: HostMcpFailureCode;
  /** The HTTP status, or null when no answer arrived. */
  readonly status: number | null;

  constructor(code: HostMcpFailureCode, status: number | null) {
    super(isGatewayCode(code) ? HOST_MCP_ERRORS[code].message : HOST_MCP_FAILURES[code]);
    this.name = "HostMcpApiError";
    this.code = code;
    this.status = status;
  }
}

const GATEWAY_CODES: ReadonlySet<string> = new Set(HostMcpErrorCodeSchema.options);
const isGatewayCode = (code: string): code is HostMcpErrorCode => GATEWAY_CODES.has(code);

const SERVICE_CODES: Readonly<Record<string, HostMcpFailureCode>> = {
  service_not_found: "service_absent",
  service_start_failed: "service_start_failed",
  service_dormant: "service_unavailable",
  service_unavailable: "service_unavailable",
};

/** A ServiceHub or transport failure as a `HostMcpApiError`; a caller's own abort passes through. */
function hostMcpFailure(error: unknown): Error {
  if (error instanceof Error && error.name === "AbortError") return error;
  if (error instanceof HostMcpApiError) return error;
  if (error instanceof ServiceHubHttpError) {
    const code = error.code ?? "";
    if (isGatewayCode(code)) return new HostMcpApiError(code, error.status);
    return new HostMcpApiError(SERVICE_CODES[code] ?? "refused", error.status);
  }
  if (error instanceof ServiceHubResponseError) return new HostMcpApiError("unreadable", null);
  return new HostMcpApiError("unreachable", null);
}

type Parser<T> = { safeParse: (input: unknown) => { success: true; data: T } | { success: false } };

type CatalogResponse = { services?: Array<{ name?: unknown }> };

export function createHostMcpApiClient(settings: ServiceHubSettings) {
  const baseUrl = settings.baseUrl.replace(/\/+$/, "");
  const token = settings.token.trim();

  async function call<T>(parser: Parser<T>, path: string, options: ServiceHubRequestOptions): Promise<T> {
    let answer: unknown;
    try {
      answer = await requestServiceHubJson<unknown>(baseUrl, path, token, options);
    } catch (error) {
      throw hostMcpFailure(error);
    }
    const parsed = parser.safeParse(answer);
    if (!parsed.success) throw new HostMcpApiError("unreadable", null);
    return parsed.data;
  }

  const serverPath = (name: string) => {
    if (!McpServerNameSchema.safeParse(name).success) throw new HostMcpApiError("invalid_request", null);
    return `${V1}/servers/${encodeURIComponent(name)}`;
  };

  return {
    /** Whether this build registers the gateway at all. Reading the catalog never starts it. */
    hasService: async (): Promise<boolean> => {
      let catalog: CatalogResponse;
      try {
        catalog = await requestServiceHubJson<CatalogResponse>(baseUrl, "/app/services/catalog", token, {
          timeoutMs: TIMEOUT_MS,
        });
      } catch (error) {
        throw hostMcpFailure(error);
      }
      return catalog.services?.some((service) => service.name === HOST_MCP_SERVICE_NAME) ?? false;
    },
    /** `cold` gives the request time to start the on_demand gateway. */
    listServers: async (options: { cold?: boolean } = {}): Promise<HostMcpServer[]> =>
      (
        await call(HostMcpServerListSchema, `${V1}/servers`, {
          timeoutMs: options.cold ? COLD_TIMEOUT_MS : TIMEOUT_MS,
        })
      ).servers,
    /** A second registration of the same name replaces it whole. */
    registerServer: async (
      name: string,
      request: HostMcpServerRegisterRequest,
    ): Promise<HostMcpServerRegistration> => {
      const body = HostMcpServerRegisterRequestSchema.safeParse(request);
      if (!body.success) throw new HostMcpApiError("invalid_request", null);
      const registration = await call(HostMcpServerRegistrationSchema, serverPath(name), {
        method: "PUT",
        body: body.data,
        timeoutMs: COLD_TIMEOUT_MS,
      });
      if (registration.server.name !== name) throw new HostMcpApiError("unreadable", null);
      return registration;
    },
    removeServer: async (name: string): Promise<void> => {
      await call(HostMcpOkSchema, serverPath(name), { method: "DELETE", timeoutMs: TIMEOUT_MS });
    },
    clearGrants: async (name: string): Promise<void> => {
      await call(HostMcpOkSchema, `${serverPath(name)}/grants`, { method: "DELETE", timeoutMs: TIMEOUT_MS });
    },
    /** Holds the request up to `waitMs`, capped by the contract, until something is waiting. */
    listApprovals: async (options: { waitMs: number; signal?: AbortSignal }): Promise<HostMcpPendingApproval[]> => {
      const waitMs = Math.min(Math.max(Math.floor(options.waitMs), 0), HOST_MCP_APPROVALS_MAX_WAIT_MS);
      return (
        await call(HostMcpPendingApprovalListSchema, `${V1}/approvals?wait_ms=${waitMs}`, {
          timeoutMs: Math.max(waitMs + HELD_LIST_MARGIN_MS, COLD_TIMEOUT_MS),
          signal: options.signal,
        })
      ).approvals;
    },
    decideApproval: async (
      approvalId: string,
      decision: HostMcpApprovalDecision,
      grantScope?: HostMcpGrantScope,
    ): Promise<HostMcpApprovalDecisionResult> => {
      const body = HostMcpApprovalDecisionRequestSchema.safeParse(
        grantScope === undefined ? { decision } : { decision, grant_scope: grantScope },
      );
      if (!body.success) throw new HostMcpApiError("invalid_request", null);
      const result = await call(
        HostMcpApprovalDecisionResultSchema,
        `${V1}/approvals/${encodeURIComponent(approvalId)}/decision`,
        { method: "POST", body: body.data, timeoutMs: TIMEOUT_MS },
      );
      if (result.approval_id !== approvalId || result.decision !== decision) {
        throw new HostMcpApiError("unreadable", null);
      }
      return result;
    },
    status: (): Promise<HostMcpStatus> => call(HostMcpStatusSchema, `${V1}/status`, { timeoutMs: TIMEOUT_MS }),
    stopAll: (): Promise<HostMcpStopAllResult> =>
      call(HostMcpStopAllResultSchema, `${V1}/stop-all`, { method: "POST", timeoutMs: TIMEOUT_MS }),
    /** Ends the pause Stop all leaves behind, so the agent's next call may start host servers again. */
    resume: async (): Promise<void> => {
      await call(HostMcpOkSchema, `${V1}/resume`, { method: "POST", timeoutMs: TIMEOUT_MS });
    },
    /** Cancels one call listed in `status().active_calls`; one already finished is `host_mcp_call_not_found`. */
    cancelCall: async (callId: string): Promise<void> => {
      await call(HostMcpOkSchema, `${V1}/calls/${encodeURIComponent(callId)}/cancel`, {
        method: "POST",
        timeoutMs: TIMEOUT_MS,
      });
    },
    browser: (): Promise<HostBrowserView> => call(HostBrowserViewSchema, `${V1}/browser`, { timeoutMs: TIMEOUT_MS }),
    /** An empty request keeps the gateway's defaults. The answer carries the stable `cdp_endpoint`. */
    configureBrowser: async (request: HostBrowserConfigRequest = {}): Promise<HostBrowserView> => {
      const body = HostBrowserConfigRequestSchema.safeParse(request);
      if (!body.success) throw new HostMcpApiError("invalid_request", null);
      return call(HostBrowserViewSchema, `${V1}/browser`, {
        method: "PUT",
        body: body.data,
        timeoutMs: COLD_TIMEOUT_MS,
      });
    },
    removeBrowser: (): Promise<HostBrowserView> =>
      call(HostBrowserViewSchema, `${V1}/browser`, { method: "DELETE", timeoutMs: TIMEOUT_MS }),
    stopBrowser: (): Promise<HostBrowserView> =>
      call(HostBrowserViewSchema, `${V1}/browser/stop`, { method: "POST", timeoutMs: TIMEOUT_MS }),
  };
}

export type HostMcpApiClient = ReturnType<typeof createHostMcpApiClient>;

/** A client for the current ServiceHub settings, rebuilt when they change; null while there are none. */
export const useHostMcpApiClient = (settings: Accessor<ServiceHubSettings | null>) =>
  createMemo(() => {
    const current = settings();
    return current ? createHostMcpApiClient(current) : null;
  });
