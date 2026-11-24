import {
  McpServerAuthRemoveResponseSchema,
  McpServerAuthStartResponseSchema,
  McpServerAuthCallbackResponseSchema,
  McpServerListResponseSchema,
  McpServerMutationResponseSchema,
  McpToolListResponseSchema,
  McpToolPolicyResponseSchema,
  type McpServerAddRequest,
  type McpServerAuthRemoveResponse,
  type McpServerAuthStartResponse,
  type McpServerAuthCallbackResponse,
  type McpServerListResponse,
  type McpServerMutationResponse,
  type McpServerUpdateRequest,
  type McpToolListResponse,
  type McpToolPolicyResponse,
  type McpToolPolicyUpdateRequest,
} from "@different-ai/openwork-contracts/mcp";
import { MCP_ACTION_REQUEST_TIMEOUT_MS, MCP_STATUS_REQUEST_TIMEOUT_MS } from "~/shared/platform/mcp-timing";
import { requestInstanceJson } from "~/shared/platform/transport/instance-api.transport";

export type McpServersTarget = {
  baseUrl: string;
  workspaceId: string;
  token?: string;
  hostToken?: string;
};

type Parser<T> = { parse: (input: unknown) => T };

/** Typed calls to the instance API's MCP resource; every response is contract-parsed. */
export function createMcpServersClient(target: McpServersTarget) {
  const root = `/v1/workspaces/${encodeURIComponent(target.workspaceId)}/mcp`;
  const serverPath = (name: string) => `${root}/${encodeURIComponent(name)}`;

  async function call<T>(
    parser: Parser<T>,
    path: string,
    init: { method?: string; body?: unknown; timeoutMs: number },
  ): Promise<T> {
    const raw = await requestInstanceJson<unknown>(target.baseUrl, path, {
      token: target.token,
      hostToken: target.hostToken,
      ...init,
    });
    return parser.parse(raw);
  }

  return {
    list: (): Promise<McpServerListResponse> =>
      call(McpServerListResponseSchema, root, { timeoutMs: MCP_STATUS_REQUEST_TIMEOUT_MS }),
    add: (request: McpServerAddRequest): Promise<McpServerMutationResponse> =>
      call(McpServerMutationResponseSchema, root, {
        method: "POST",
        body: request,
        timeoutMs: MCP_ACTION_REQUEST_TIMEOUT_MS,
      }),
    update: (name: string, request: McpServerUpdateRequest): Promise<McpServerMutationResponse> =>
      call(McpServerMutationResponseSchema, serverPath(name), {
        method: "PATCH",
        body: request,
        timeoutMs: MCP_ACTION_REQUEST_TIMEOUT_MS,
      }),
    remove: (name: string): Promise<McpServerMutationResponse> =>
      call(McpServerMutationResponseSchema, serverPath(name), {
        method: "DELETE",
        timeoutMs: MCP_ACTION_REQUEST_TIMEOUT_MS,
      }),
    removeAuth: (name: string): Promise<McpServerAuthRemoveResponse> =>
      call(McpServerAuthRemoveResponseSchema, `${serverPath(name)}/auth`, {
        method: "DELETE",
        timeoutMs: MCP_ACTION_REQUEST_TIMEOUT_MS,
      }),
    startAuth: (name: string): Promise<McpServerAuthStartResponse> =>
      call(McpServerAuthStartResponseSchema, `${serverPath(name)}/auth/start`, {
        method: "POST",
        timeoutMs: MCP_ACTION_REQUEST_TIMEOUT_MS,
      }),
    completeAuth: (name: string, code: string): Promise<McpServerAuthCallbackResponse> =>
      call(McpServerAuthCallbackResponseSchema, `${serverPath(name)}/auth/callback`, {
        method: "POST",
        body: { code },
        timeoutMs: MCP_ACTION_REQUEST_TIMEOUT_MS,
      }),
    listTools: (name: string): Promise<McpToolListResponse> =>
      call(McpToolListResponseSchema, `${serverPath(name)}/tools`, { timeoutMs: MCP_STATUS_REQUEST_TIMEOUT_MS }),
    setToolPolicy: (name: string, request: McpToolPolicyUpdateRequest): Promise<McpToolPolicyResponse> =>
      call(McpToolPolicyResponseSchema, `${serverPath(name)}/policy`, {
        method: "PUT",
        body: request,
        timeoutMs: MCP_ACTION_REQUEST_TIMEOUT_MS,
      }),
  };
}

export type McpServersClient = ReturnType<typeof createMcpServersClient>;
