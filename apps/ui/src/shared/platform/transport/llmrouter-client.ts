import { createServiceHubClient, requestServiceHubJson, type ServiceHubSettings } from "./servicehub";
import type { PrimaryBundleCapability, AppCapabilityProfile } from "@different-ai/openwork-contracts/capability";

export const GITHUB_COPILOT_PROVIDER_ID = "github_copilot";

export type LlmRouterCatalogProvider = {
  id: string;
  display_name: string;
};

export type LlmRouterConfiguredProvider = {
  id: string;
  api_key_set: boolean;
};

export type LlmRouterOauthSession = {
  provider: string;
  expires_at?: number;
  scope?: string;
  account_hint?: string | null;
  stored_at?: number;
  flow_metadata?: Record<string, unknown>;
};

export type LlmRouterOauthLoginResponse = {
  // PKCE flow (openai): browser redirect + localhost callback.
  authorize_url?: string;
  state?: string;
  callback_port?: number;
  expires_at: number;
  // Device flow (github_copilot, RFC 8628): user types user_code at verification_uri.
  flow_kind?: "pkce" | "device";
  user_code?: string;
  verification_uri?: string;
  interval?: number;
};

export type LlmRouterOauthStatus = {
  status:
    | "not_started"
    | "awaiting_callback"
    | "awaiting_authorization"
    | "exchanging"
    | "complete"
    | "cancelled"
    | "error";
  expires_at?: number;
  account_hint?: string | null;
  scope?: string;
  error?: { code: string; message: string; details?: Record<string, unknown> };
};

export type LlmRouterCloudModel = {
  provider: string;
  model: string;
  auth_mode: "api_key" | "oauth";
  max_tokens: number;
  context_limit: number;
};

export type LlmRouterProviderModel = {
  id: string;
  name: string;
  release_date: string;
};

export type LlmRouterCloudHealth = {
  provider: string;
  model: string;
  status: string;
  latency_ms?: number;
  error?: string;
  detail?: string;
  note?: string;
  http_status?: number;
};

export type LlmRouterEdgeConfig = {
  configured: boolean;
  base_url?: string;
  model_name?: string;
  embedding_model_name?: string;
  edge_model_selection_fingerprint?: string;
  /** Whether the corporate proxy is bypassed for this edge host (default true). */
  bypass_proxy?: boolean;
};

export type LlmRouterEdgeTestResult = {
  status: string;
  latency_ms?: number;
  error?: string;
  detail?: string;
  note?: string;
  http_status?: number;
  models?: string[];
};

/** The two local backends selectable via `/model-selections/local-provider`. */
export type LlmRouterLocalProvider = "llamacpp" | "edge";

/** GET /model-selections/local-provider — offerable backends + current choice. */
export type LlmRouterLocalProviderInfo = {
  /** `edge` always present; `llamacpp` only when the host is eligible. */
  available_providers: string[];
  /** Persisted choice, or `null` when local is not yet configured. */
  local_provider: LlmRouterLocalProvider | null;
};

/** GET /model-selections/tier — hardware-gated chat-tier menu + selection. */
export type LlmRouterTierSelection = {
  /** Eligible tiers, most-demanding first; empty on an ineligible host. */
  available_tiers: Array<{ id: string; name: string }>;
  /** Persisted chat choice (defaults to the biggest eligible tier). */
  selected_tier: string | null;
};

/** GET /models — one entry per model discovered on disk. */
export type LlmRouterLocalModel = {
  id: string;
  role: string;
  downloaded: boolean;
  active: boolean;
};

/** EnsureReady shape returned by PUT /tier and POST /inference-servers/provisions. */
export type LlmRouterEnsureReady = {
  /** `ready` = already up (operation_id null); `running` = poll the op; `skipped` = ineligible. */
  state: "ready" | "running" | "skipped";
  operation_id: string | null;
  reason?: string;
};

/** One file in a long-running download's per-file manifest (op metadata). */
export type LlmRouterOperationFile = {
  id: string;
  label?: string;
  role?: string;
  done: number;
  total: number;
  state: "pending" | "running" | "downloading" | "complete" | "error" | (string & {});
  error_code?: string;
  error_detail?: string;
};

/** GET /operations/{id} — progress DTO for a long-running orchestration. */
export type LlmRouterOperation = {
  operation_id: string;
  kind: string;
  state: "pending" | "running" | "done" | "error" | "cancelled";
  pct: number;
  message: string | null;
  last_error_message?: string | null;
  metadata?: {
    files?: LlmRouterOperationFile[];
    [key: string]: unknown;
  };
};

export type LlmRouterUsageEvent = {
  event_id: string;
  occurred_at: number;
  session_id: string | null;
  message_id: string | null;
  source: string;
  provider: string | null;
  underlying_model: string;
  alias: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  reasoning_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  cost_usd: number;
  trace_id: string | null;
  /** Ids of the tool calls this completion emitted; absent from older routers. */
  tool_call_ids?: string[];
};

export type LlmRouterUsageEventsResponse = {
  events: LlmRouterUsageEvent[];
  next_since_ms?: number;
};

export type LlmRouterUsageTotals = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  reasoning_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  cost_usd: number;
  request_count: number;
  first_seen_at: number | null;
  last_updated_at: number | null;
};

export type LlmRouterUsageGroup = LlmRouterUsageTotals & {
  underlying_model?: string;
  provider?: string;
  source?: string;
  /** Present only for `group_by=alias`; "unaliased" when the call named none. */
  alias?: string;
};

export type LlmRouterUsageAggregateResponse = {
  total: LlmRouterUsageTotals;
  groups?: LlmRouterUsageGroup[];
};

/** GET /system/hardware-eligibility — strict local-LLM gate verdict. */
export type LlmRouterHardwareEligibility = {
  eligible: boolean;
  reason: string;
};

export type LlmRouterProviderOption = {
  id: string;
  name: string;
  /** True when EITHER an api_key OR an oauth session is stored for this provider. */
  configured: boolean;
  apiKeySet: boolean;
  /** True when an OAuth session is stored for this provider (openai only). */
  oauthSet: boolean;
};

type RequestOptions = {
  method?: string;
  body?: unknown;
  timeoutMs?: number;
};

async function requestJson<T>(
  settings: ServiceHubSettings,
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const client = createServiceHubClient(settings);
  return requestServiceHubJson<T>(client.baseUrl, path, client.token, options);
}

export async function loadLlmRouterProviderOptions(settings: ServiceHubSettings): Promise<LlmRouterProviderOption[]> {
  const [catalog, configured, oauthConfigured] = await Promise.all([
    requestJson<LlmRouterCatalogProvider[]>(settings, "/llm-router/v1/cloud/catalog"),
    requestJson<LlmRouterConfiguredProvider[]>(settings, "/llm-router/v1/cloud/providers"),
    // OAuth is a superset over api-key: a provider is "connected" if either
    // credential is present. Tolerate 4xx/5xx on the oauth listing (older LRM
    // builds without the endpoint) by falling back to an empty list so the
    // api-key path still works.
    requestJson<LlmRouterOauthSession[]>(settings, "/llm-router/v1/oauth/providers").catch(() => []),
  ]);

  const configuredById = new Map(configured.map((item) => [item.id, item]));
  const oauthById = new Set(oauthConfigured.map((item) => item.provider));
  const options = catalog.map((entry) => {
    const current = configuredById.get(entry.id);
    const oauthSet = oauthById.has(entry.id);
    return {
      id: entry.id,
      name: entry.display_name || entry.id,
      configured: Boolean(current) || oauthSet,
      apiKeySet: current?.api_key_set ?? false,
      oauthSet,
    };
  });

  // github_copilot is OAuth-only (device flow) and is not in the api-key
  // catalog, so surface it as a synthetic option gated purely on its oauth
  // session. Keeps the catalog decoupled from OAuth-only providers.
  if (!options.some((option) => option.id === GITHUB_COPILOT_PROVIDER_ID)) {
    const oauthSet = oauthById.has(GITHUB_COPILOT_PROVIDER_ID);
    options.push({
      id: GITHUB_COPILOT_PROVIDER_ID,
      name: "GitHub Copilot",
      configured: oauthSet,
      apiKeySet: false,
      oauthSet,
    });
  }
  return options;
}

export function createLlmRouterClient(settings: ServiceHubSettings) {
  return {
    catalog: () => requestJson<LlmRouterCatalogProvider[]>(settings, "/llm-router/v1/cloud/catalog"),
    listProviders: () => requestJson<LlmRouterConfiguredProvider[]>(settings, "/llm-router/v1/cloud/providers"),
    getProvider: (providerId: string) =>
      requestJson<LlmRouterConfiguredProvider>(settings, `/llm-router/v1/cloud/providers/${encodeURIComponent(providerId)}`),
    putProvider: (providerId: string, body: { api_key: string }) =>
      requestJson<{ ok: boolean }>(settings, `/llm-router/v1/cloud/providers/${encodeURIComponent(providerId)}`, {
        method: "PUT",
        body,
        timeoutMs: 20_000,
      }),
    deleteProvider: (providerId: string) =>
      requestJson<{ ok: boolean }>(settings, `/llm-router/v1/cloud/providers/${encodeURIComponent(providerId)}`, {
        method: "DELETE",
      }),
    testProvider: (providerId: string, body?: { api_key?: string; model?: string }) =>
      requestJson<LlmRouterEdgeTestResult>(settings, `/llm-router/v1/cloud/providers/${encodeURIComponent(providerId)}/test`, {
        method: "POST",
        body,
        timeoutMs: 20_000,
      }),
    listProviderModels: (providerId: string) =>
      requestJson<{ provider?: string; source?: string; data?: LlmRouterProviderModel[] }>(
        settings,
        `/llm-router/v1/cloud/providers/${encodeURIComponent(providerId)}/models`,
        { timeoutMs: 20_000 },
      ),
    getCloudModel: () => requestJson<LlmRouterCloudModel>(settings, "/llm-router/v1/cloud/model"),
    putCloudModel: (body: {
      provider: string;
      model: string;
      auth_mode?: "api_key" | "oauth";
      max_tokens?: number;
      context_limit?: number;
    }) => requestJson<{ ok: boolean }>(settings, "/llm-router/v1/cloud/model", { method: "PUT", body }),
    deleteCloudModel: () =>
      requestJson<{ ok: boolean }>(settings, "/llm-router/v1/cloud/model", { method: "DELETE" }),
    getCloudModelHealth: () => requestJson<LlmRouterCloudHealth>(settings, "/llm-router/v1/cloud/model/health", { timeoutMs: 20_000 }),
    getEdge: () => requestJson<LlmRouterEdgeConfig>(settings, "/llm-router/v1/edge"),
    putEdge: (
      body: {
        base_url: string;
        api_key?: string;
        model_name?: string;
        embedding_model_name?: string;
        bypass_proxy?: boolean;
      },
      options?: { probe?: boolean },
    ) => {
      const path =
        options?.probe === false ? "/llm-router/v1/edge?probe=false" : "/llm-router/v1/edge";
      return requestJson<{ ok: boolean; edge_model_selection_fingerprint: string }>(
        settings,
        path,
        { method: "PUT", body, timeoutMs: 20_000 },
      );
    },
    deleteEdge: () => requestJson<{ ok: boolean }>(settings, "/llm-router/v1/edge", { method: "DELETE" }),
    testEdge: (body?: { base_url?: string; api_key?: string; model_name?: string; bypass_proxy?: boolean }) =>
      requestJson<LlmRouterEdgeTestResult>(settings, "/llm-router/v1/edge/test", {
        method: "POST",
        body,
        timeoutMs: 20_000,
      }),
    listEdgeModels: () => requestJson<{ object?: string; data?: Array<{ id: string }>; models?: string[] }>(settings, "/llm-router/v1/edge/models", { timeoutMs: 20_000 }),

    // --- OAuth (OpenAI subscription auth) -----------------------

    startOauthLogin: (providerId: string) =>
      requestJson<LlmRouterOauthLoginResponse>(
        settings,
        `/llm-router/v1/oauth/providers/${encodeURIComponent(providerId)}/login`,
        { method: "POST", body: {}, timeoutMs: 15_000 },
      ),
    pollOauthStatus: (providerId: string) =>
      requestJson<LlmRouterOauthStatus>(
        settings,
        `/llm-router/v1/oauth/providers/${encodeURIComponent(providerId)}/status`,
        { timeoutMs: 10_000 },
      ),
    cancelOauthLogin: (providerId: string) =>
      requestJson<{ ok: boolean }>(
        settings,
        `/llm-router/v1/oauth/providers/${encodeURIComponent(providerId)}/cancel`,
        { method: "POST" },
      ),
    deleteOauthSession: (providerId: string) =>
      requestJson<{ ok: boolean }>(
        settings,
        `/llm-router/v1/oauth/providers/${encodeURIComponent(providerId)}`,
        { method: "DELETE" },
      ),

    health: () => requestJson<Record<string, unknown>>(settings, "/llm-router/v1/health"),
    status: () => requestJson<Record<string, unknown>>(settings, "/llm-router/v1/status"),

    // ── Local (on-device llama.cpp) control plane ──
    getHardwareEligibility: () =>
      requestJson<LlmRouterHardwareEligibility>(settings, "/llm-router/v1/system/hardware-eligibility"),
    /**
     * GET the v1.2 primary-bundle capability projection (hardware ceiling +
     * supported bundles + committed primary bundle). This is the authoritative
     * source for "which local bundle is the ceiling" and "which backend is
     * currently committed" — preferred over the tier menu for v1.2 UI.
     */
    getPrimaryBundleCapability: () =>
      requestJson<PrimaryBundleCapability>(settings, "/llm-router/v1/capability/primary-bundle"),
    /**
     * GET the ServiceHub-owned App capability profile (the committed, authoritative
     * projection). This is the SAME source the main gating (agent buttons, etc.)
     * uses — preferred over the LRM `getPrimaryBundleCapability()` for "is the
     * local model ready" checks, because the LRM view can briefly report a null
     * primary_bundle during startup/switch windows while ServiceHub's committed
     * profile is already active (the intermittent "Local model: Not Configured"
     * false-report).
     */
    getAppCapabilityProfile: () =>
      requestJson<AppCapabilityProfile>(settings, "/app/capability-profile"),
    getLocalProvider: () =>
      requestJson<LlmRouterLocalProviderInfo>(settings, "/llm-router/v1/model-selections/local-provider"),
    setLocalProvider: (provider: LlmRouterLocalProvider) =>
      requestJson<{ success: boolean; local_provider: string }>(settings, "/llm-router/v1/model-selections/local-provider", {
        method: "PUT",
        body: { provider },
      }),
    getTierSelection: () =>
      requestJson<LlmRouterTierSelection>(settings, "/llm-router/v1/model-selections/tier"),
    setTier: (tier: string) =>
      requestJson<LlmRouterEnsureReady>(settings, "/llm-router/v1/model-selections/tier", {
        method: "PUT",
        body: { tier },
        timeoutMs: 30_000,
      }),
    deleteTier: () =>
      requestJson<{ success: boolean; role: string; model_id: string | null; stopped: boolean }>(
        settings,
        "/llm-router/v1/model-selections/tier",
        { method: "DELETE", timeoutMs: 30_000 },
      ),
    listLocalModels: () =>
      requestJson<{ models: LlmRouterLocalModel[]; count: number }>(settings, "/llm-router/v1/models"),
    deleteLocalModel: (id: string) =>
      requestJson<{ success: boolean; id: string }>(settings, `/llm-router/v1/models/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
    provisionLocal: () =>
      requestJson<LlmRouterEnsureReady>(settings, "/llm-router/v1/inference-servers/provisions", {
        method: "POST",
        timeoutMs: 30_000,
      }),
    listInferenceServers: () =>
      requestJson<
        Array<{
          role: string;
          state: string;
          model_id: string | null;
          port: number | null;
          pid: number | null;
          uptime_seconds: number | null;
        }>
      >(settings, "/llm-router/v1/inference-servers"),
    probeInferenceServer: (role: string) =>
      requestJson<{ role: string; healthy: boolean; status: string }>(
        settings,
        `/llm-router/v1/inference-servers/${encodeURIComponent(role)}/probes`,
        { timeoutMs: 20_000 },
      ),
    getOperation: (id: string, options?: { timeoutMs?: number }) =>
      requestJson<LlmRouterOperation>(settings, `/llm-router/v1/operations/${encodeURIComponent(id)}`, options),
    cancelOperation: (id: string) =>
      requestJson<LlmRouterOperation>(settings, `/llm-router/v1/operations/${encodeURIComponent(id)}/cancellations`, {
        method: "POST",
      }),
    // `alias` groups by the routing alias a call asked for ("dictation-refine",
    // "cloud-model", ...). Unlike the other dimensions its rows are summed from
    // the capped event trail, so they can total less than `total` — see
    // UsageStore.query_aggregate.
    getUsage: (groupBy: "none" | "model" | "provider" | "source" | "alias" = "none") =>
      requestJson<LlmRouterUsageAggregateResponse>(settings, `/llm-router/v1/usage?group_by=${encodeURIComponent(groupBy)}`),
    getUsageEvents: (params: { sessionId: string; sinceMs?: number; limit?: number }) => {
      const query = new URLSearchParams({
        session_id: params.sessionId,
        limit: String(params.limit ?? 1000),
      });
      if (params.sinceMs !== undefined) query.set("since_ms", String(params.sinceMs));
      return requestJson<LlmRouterUsageEventsResponse>(settings, `/llm-router/v1/usage/events?${query.toString()}`);
    },
    clearUsage: () => requestJson<{ cleared: boolean }>(settings, "/llm-router/v1/usage", { method: "DELETE" }),
  };
}

/** The concrete client object returned by {@link createLlmRouterClient}. */
export type LlmRouterClient = ReturnType<typeof createLlmRouterClient>;
