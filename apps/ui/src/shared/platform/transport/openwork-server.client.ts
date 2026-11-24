import { createCoreApi } from "./openwork-server.api-core";
import { createRouterApi } from "./openwork-server.api-router";
import { createCatalogApi } from "./openwork-server.api-catalog";
import { createFilesApi } from "./openwork-server.api-files";
import { createArtifactsApi } from "./openwork-server.api-artifacts";
import { createAutomationsApi } from "./openwork-server.api-automations";
import { createPrivacyApi } from "./openwork-server.api-privacy";
import { createApprovalsApi } from "./openwork-server.api-approvals";
import { CLIENT_TIMEOUTS, type OpenworkClientContext } from "./openwork-server.client-context";

export function createOpenworkServerClient(options: { baseUrl: string; token?: string; hostToken?: string }) {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const token = options.token;
  const hostToken = options.hostToken;


  const ctx: OpenworkClientContext = { baseUrl, token, hostToken, timeouts: CLIENT_TIMEOUTS };

  return {
    baseUrl,
    token,
    ...createCoreApi(ctx),
    ...createRouterApi(ctx),
    ...createCatalogApi(ctx),
    ...createFilesApi(ctx),
    ...createArtifactsApi(ctx),
    ...createAutomationsApi(ctx),
    ...createPrivacyApi(ctx),
    ...createApprovalsApi(ctx),
  };
}

export type OpenworkServerClient = ReturnType<typeof createOpenworkServerClient>;
