import { requestJson, requestJsonRaw } from "./openwork-server.transport";
import type { OpenworkOpenCodeRouterBindingsResult, OpenworkOpenCodeRouterHealthSnapshot, OpenworkOpenCodeRouterSlackIdentitiesResult, OpenworkOpenCodeRouterTelegramIdentitiesResult } from "./openwork-server.types";
import type { OpenworkClientContext } from "./openwork-server.client-context";

export function createRouterApi(ctx: OpenworkClientContext) {
  const { baseUrl, token, hostToken, timeouts } = ctx;
  return {
    opencodeRouterHealth: () =>
      requestJsonRaw<OpenworkOpenCodeRouterHealthSnapshot>(baseUrl, "/opencode-router/health", { token, hostToken, timeoutMs: timeouts.opencodeRouter }),
    opencodeRouterBindings: (filters?: { channel?: string; identityId?: string }) => {
      const channel = filters?.channel?.trim() ?? "";
      const identityId = filters?.identityId?.trim() ?? "";
      const search = new URLSearchParams();
      if (channel) search.set("channel", channel);
      if (identityId) search.set("identityId", identityId);
      const suffix = search.toString();
      const path = suffix ? `/opencode-router/bindings?${suffix}` : "/opencode-router/bindings";
      return requestJsonRaw<OpenworkOpenCodeRouterBindingsResult>(baseUrl, path, { token, hostToken, timeoutMs: timeouts.opencodeRouter });
    },
    opencodeRouterTelegramIdentities: () =>
      requestJsonRaw<OpenworkOpenCodeRouterTelegramIdentitiesResult>(baseUrl, "/opencode-router/identities/telegram", { token, hostToken, timeoutMs: timeouts.opencodeRouter }),
    opencodeRouterSlackIdentities: () =>
      requestJsonRaw<OpenworkOpenCodeRouterSlackIdentitiesResult>(baseUrl, "/opencode-router/identities/slack", { token, hostToken, timeoutMs: timeouts.opencodeRouter }),
    getOpenCodeRouterTelegramIdentities: (workspaceId: string, options?: { healthPort?: number | null }) => {
      const query = typeof options?.healthPort === "number" ? `?healthPort=${encodeURIComponent(String(options.healthPort))}` : "";
      return requestJson<OpenworkOpenCodeRouterTelegramIdentitiesResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/opencode-router/identities/telegram${query}`,
        { token, hostToken, timeoutMs: timeouts.opencodeRouter },
      );
    },
    getOpenCodeRouterSlackIdentities: (workspaceId: string, options?: { healthPort?: number | null }) => {
      const query = typeof options?.healthPort === "number" ? `?healthPort=${encodeURIComponent(String(options.healthPort))}` : "";
      return requestJson<OpenworkOpenCodeRouterSlackIdentitiesResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/opencode-router/identities/slack${query}`,
        { token, hostToken },
      );
    },
    getOpenCodeRouterBindings: (
      workspaceId: string,
      filters?: { channel?: string; identityId?: string; healthPort?: number | null },
    ) => {
      const queryFilters = filters ?? {};
      const search = new URLSearchParams();

      if (queryFilters.channel?.trim()) {
        search.set("channel", queryFilters.channel.trim());
      }

      if (queryFilters.identityId?.trim()) {
        search.set("identityId", queryFilters.identityId.trim());
      }

      if (typeof queryFilters.healthPort === "number") {
        search.set("healthPort", String(queryFilters.healthPort));
      }

      const suffix = search.toString();
      return requestJson<OpenworkOpenCodeRouterBindingsResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/opencode-router/bindings${suffix ? `?${suffix}` : ""}`,
        { token, hostToken },
      );
    },
  };
}
