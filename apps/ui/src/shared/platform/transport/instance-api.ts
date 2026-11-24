/**
 * The one frontend entry to the Sandbox Manager host API (#16, #12).
 *
 * The app reaches these routes through ServiceHub's `/sandbox-manager` forwarding with the hub
 * token, never through openwork-server: an approval must not pass through a sandbox tier, or the
 * agent could grant itself one, and neither may the Tavily key. Only this file names their paths
 * (`instance-api.guard.test.ts`), so moving them behind the instance API later changes one place;
 * the exception to AGENTS.md §5a is recorded in #45.
 */
import { createMemo, type Accessor } from "solid-js";
import {
  EGRESS_APPROVALS_MAX_WAIT_MS,
  ChannelEnabledResultSchema,
  ChannelIdentityResultSchema,
  EgressApprovalDecisionResultSchema,
  EgressChatGrantStatusSchema,
  EgressPendingApprovalListSchema,
  SANDBOX_MANAGER_HOST_API_ERRORS,
  SlackInstallCompleteResultSchema,
  SlackInstallStartResultSchema,
  SlackInstallStatusSchema,
  TavilyApiKeyStatusSchema,
  type ChannelEnabledResult,
  type ChannelIdentityResult,
  type ChannelName,
  type EgressApprovalDecision,
  type EgressApprovalDecisionResult,
  type EgressApprovalGrantScope,
  type EgressPendingApproval,
  type SlackInstallCompleteResult,
  type SlackInstallStartResult,
  type SlackInstallStatus,
} from "@different-ai/openwork-contracts/sandbox-manager-host-api";
import {
  ChannelBindingResultSchema,
  ChannelSendResultSchema,
  SlackSendersResultSchema,
  type ChannelBindingResult,
  type ChannelSendResult,
  type SlackSendersResult,
} from "@different-ai/openwork-contracts/sandbox-manager-channel-messaging";

import {
  requestServiceHubJson,
  ServiceHubHttpError,
  ServiceHubResponseError,
  type ServiceHubRequestOptions,
  type ServiceHubSettings,
} from "./servicehub";

const EGRESS_APPROVALS_PATH = "/sandbox-manager/v1/egress/approvals";
const EGRESS_CHAT_GRANTS_PATH = "/sandbox-manager/v1/egress/chat-grants";
const TAVILY_API_KEY_PATH = "/sandbox-manager/v1/secrets/tavily-api-key";
const CHANNELS_PATH = "/sandbox-manager/v1/channels";
/** The alphabet Telegram pairing codes are drawn from: no 0, 1, I, L or O to misread. */
const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PAIRING_CODE_LENGTH = 8;
const TIMEOUT_MS = 10_000;
/** Saving a Slack identity waits for the router to ask Slack, which is two requests of up to 15 s in all. */
const CHANNEL_TIMEOUT_MS = 30_000;
/** A held list answers within its wait; this is ServiceHub's time to forward it. */
const HELD_LIST_MARGIN_MS = 5_000;

/** `available: false` means this backend has no approvals, not that a request failed. */
export type PendingApprovals =
  | { available: true; approvals: EgressPendingApproval[] }
  | { available: false };

/** `available: false` means this backend has no chat grants, not that a request failed. */
export type ChatGrantAvailability = { available: true; allowed: boolean } | { available: false };

/**
 * `available: false` means this mode keeps no key store, not that a request failed. `enabled: false` is a key the
 * user paused from Connections: it is kept, but search does not use it.
 */
export type TavilyApiKeyAvailability =
  | { available: true; configured: boolean; enabled: boolean }
  | { available: false };

/** Who the Slack bot answers, in the spelling the Connections panel reads. */
export type SlackSenders = {
  /** `env` entries come from SLACK_ALLOWED_USERS and cannot be removed from the app. */
  allowed: Array<{ userId: string; source: "app" | "env" }>;
  pending: Array<{ userId: string; identityId: string; firstSeenAt: number; lastSeenAt: number; attempts: number }>;
};

function toSlackSenders(result: SlackSendersResult): SlackSenders {
  return {
    allowed: result.allowed.map((entry) => ({ userId: entry.user_id, source: entry.source })),
    pending: result.pending.map((entry) => ({
      userId: entry.user_id,
      identityId: entry.identity_id,
      firstSeenAt: entry.first_seen_at,
      lastSeenAt: entry.last_seen_at,
      attempts: entry.attempts,
    })),
  };
}

export function createInstanceApiClient(settings: ServiceHubSettings) {
  const baseUrl = settings.baseUrl.replace(/\/+$/, "");
  const token = settings.token.trim();
  const request = (path: string, options: ServiceHubRequestOptions) =>
    requestServiceHubJson<unknown>(baseUrl, path, token, options);
  const channelRequest = async <T>(
    path: string,
    method: "GET" | "PUT" | "DELETE" | "POST",
    schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } },
    body?: unknown,
  ): Promise<T> => {
    let answer: unknown;
    try {
      answer = await request(`${CHANNELS_PATH}${path}`, { method, body, timeoutMs: CHANNEL_TIMEOUT_MS });
    } catch (error) {
      throw hostApiFailure(error);
    }
    const parsed = schema.safeParse(answer);
    if (!parsed.success) throw new Error(HOST_API_FAILURES.unreadable);
    return parsed.data;
  };
  const identityPath = (channel: ChannelName, identityId: string) =>
    `/${channel}/identities/${encodeURIComponent(identityId)}`;
  const tavilyApiKey = (method: "GET" | "PUT" | "DELETE", body?: { api_key: string }) =>
    readTavilyApiKey(() => request(TAVILY_API_KEY_PATH, { method, body, timeoutMs: TIMEOUT_MS }), method);
  const setTavilyApiKeyEnabled = (enabled: boolean) =>
    readTavilyApiKey(
      () => request(`${TAVILY_API_KEY_PATH}/enabled`, { method: "PUT", body: { enabled }, timeoutMs: TIMEOUT_MS }),
      "PUT",
    );

  return {
    /** Holds the request up to `waitMs`, capped by the contract, until something is waiting. */
    listPendingApprovals: async (options: {
      waitMs: number;
      signal?: AbortSignal;
    }): Promise<PendingApprovals> => {
      const waitMs = Math.min(Math.max(Math.floor(options.waitMs), 0), EGRESS_APPROVALS_MAX_WAIT_MS);
      let answer: unknown;
      try {
        answer = await request(`${EGRESS_APPROVALS_PATH}?wait_ms=${waitMs}`, {
          timeoutMs: waitMs + HELD_LIST_MARGIN_MS,
          signal: options.signal,
        });
      } catch (error) {
        if (error instanceof ServiceHubHttpError && error.code === "egress_approvals_unavailable") {
          return { available: false };
        }
        throw hostApiFailure(error);
      }
      const parsed = EgressPendingApprovalListSchema.safeParse(answer);
      if (!parsed.success) throw new Error(HOST_API_FAILURES.unreadable);
      return { available: true, approvals: parsed.data.approvals };
    },
    decideApproval: async (
      approvalId: string,
      decision: EgressApprovalDecision,
      grantScope?: EgressApprovalGrantScope,
    ): Promise<EgressApprovalDecisionResult> => {
      let answer: unknown;
      try {
        answer = await request(`${EGRESS_APPROVALS_PATH}/${encodeURIComponent(approvalId)}/decision`, {
          method: "POST",
          body: grantScope === undefined ? { decision } : { decision, grant_scope: grantScope },
          timeoutMs: TIMEOUT_MS,
        });
      } catch (error) {
        throw hostApiFailure(error);
      }
      const parsed = EgressApprovalDecisionResultSchema.safeParse(answer);
      if (!parsed.success) throw new Error(HOST_API_FAILURES.unreadable);
      return parsed.data;
    },
    /** Whether "Allow for this session" is on for the chat whose root session this is. */
    getChatGrant: async (rootSessionId: string): Promise<ChatGrantAvailability> => {
      try {
        const allowed = await readChatGrant(
          rootSessionId,
          request(chatGrantPath(rootSessionId), { timeoutMs: TIMEOUT_MS }),
        );
        return { available: true, allowed };
      } catch (error) {
        if (error instanceof ServiceHubHttpError && error.code === "egress_approvals_unavailable") {
          return { available: false };
        }
        throw error;
      }
    },
    /** A switch that did not happen throws, with the contract's sentence when it has one. */
    setChatGrant: async (rootSessionId: string, allow: boolean): Promise<{ allowed: boolean }> => ({
      allowed: await readChatGrant(
        rootSessionId,
        request(chatGrantPath(rootSessionId), { method: "PUT", body: { allow }, timeoutMs: TIMEOUT_MS }),
      ),
    }),
    tavilyApiKey: () => tavilyApiKey("GET"),
    saveTavilyApiKey: (apiKey: string) => tavilyApiKey("PUT", { api_key: apiKey.trim() }),
    clearTavilyApiKey: () => tavilyApiKey("DELETE"),
    /** Pause or resume the saved key without forgetting it. */
    setTavilyApiKeyEnabled,
    /**
     * The Slack and Telegram credentials go to the host, never through openwork-server: that runs as the tier
     * the agent runs as. The router verifies a Slack pair against Slack before the host keeps it, so a call can
     * take as long as two Slack requests.
     */
    saveSlackIdentity: (
      identityId: string,
      input: { botToken: string; appToken: string; enabled?: boolean; directory?: string },
    ): Promise<ChannelIdentityResult> =>
      channelRequest(identityPath("slack", identityId), "PUT", ChannelIdentityResultSchema, {
        bot_token: input.botToken.trim(),
        app_token: input.appToken.trim(),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        ...(input.directory ? { directory: input.directory } : {}),
      }),
    /**
     * Connect Slack through SuperClaw's app manifest (#3787): the host creates the app in the user's workspace
     * with their configuration token and waits for the browser install. The bot token comes back to the host,
     * never to this app; the user still pastes the app-level token, which completes the install.
     */
    startSlackInstall: (identityId: string, configurationToken: string): Promise<SlackInstallStartResult> =>
      channelRequest("/slack/install", "POST", SlackInstallStartResultSchema, {
        identity_id: identityId,
        configuration_token: configurationToken.trim(),
      }),
    slackInstallStatus: (): Promise<SlackInstallStatus> =>
      channelRequest("/slack/install", "GET", SlackInstallStatusSchema),
    completeSlackInstall: (input: {
      appToken: string;
      enabled?: boolean;
      directory?: string;
    }): Promise<SlackInstallCompleteResult> =>
      channelRequest("/slack/install/complete", "POST", SlackInstallCompleteResultSchema, {
        app_token: input.appToken.trim(),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        ...(input.directory ? { directory: input.directory } : {}),
      }),
    cancelSlackInstall: (): Promise<SlackInstallStatus> =>
      channelRequest("/slack/install", "DELETE", SlackInstallStatusSchema),
    /** Switch a saved Slack bot off or back on; its tokens stay with the host, so no setup is repeated. */
    setSlackIdentityEnabled: (identityId: string, enabled: boolean): Promise<ChannelIdentityResult> =>
      channelRequest(`${identityPath("slack", identityId)}/enabled`, "PUT", ChannelIdentityResultSchema, { enabled }),
    /**
     * A private identity is paired with a code. The code is made here and only its hash is sent, so the host
     * never holds it; it is handed back once for the user to read out.
     */
    saveTelegramIdentity: async (
      identityId: string,
      input: { token: string; enabled?: boolean; access: "public" | "private"; pairingCode?: string; directory?: string },
    ): Promise<{ result: ChannelIdentityResult; pairingCode: string | null }> => {
      const pairingCode =
        input.access === "private"
          ? normalizePairingCode(input.pairingCode ?? "") || generatePairingCode()
          : null;
      const result = await channelRequest(identityPath("telegram", identityId), "PUT", ChannelIdentityResultSchema, {
        token: input.token.trim(),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        access: input.access,
        ...(pairingCode === null ? {} : { pairing_code_hash: await sha256Hex(pairingCode) }),
        ...(input.directory ? { directory: input.directory } : {}),
      });
      return { result, pairingCode };
    },
    /** Switch a saved Telegram bot off or back on; its token and pairing code stay with the host. */
    setTelegramIdentityEnabled: (identityId: string, enabled: boolean): Promise<ChannelIdentityResult> =>
      channelRequest(`${identityPath("telegram", identityId)}/enabled`, "PUT", ChannelIdentityResultSchema, {
        enabled,
      }),
    deleteChannelIdentity: (channel: ChannelName, identityId: string): Promise<ChannelIdentityResult> =>
      channelRequest(identityPath(channel, identityId), "DELETE", ChannelIdentityResultSchema),
    /**
     * The operator's own send, with the router's admin token held by the host: never held for approval, which is
     * the agent's. A send to many bound conversations can take as long as the channel is slow, so it waits as long
     * as a Slack verification does.
     */
    sendChannelMessage: (
      channel: ChannelName,
      input: { text: string; identityId?: string; directory?: string; peerId?: string; autoBind?: boolean },
    ): Promise<ChannelSendResult> =>
      channelRequest(`/${channel}/send`, "POST", ChannelSendResultSchema, {
        text: input.text,
        ...(input.identityId?.trim() ? { identity_id: input.identityId.trim() } : {}),
        ...(input.directory?.trim() ? { directory: input.directory.trim() } : {}),
        ...(input.peerId?.trim() ? { peer_id: input.peerId.trim() } : {}),
        ...(input.autoBind ? { auto_bind: true } : {}),
      }),
    /** Binds a conversation to a workspace directory; without a directory it unbinds. Only the host writes bindings. */
    setChannelBinding: (
      channel: ChannelName,
      input: { peerId: string; identityId?: string; directory?: string },
    ): Promise<ChannelBindingResult> =>
      channelRequest(`/${channel}/bindings`, "PUT", ChannelBindingResultSchema, {
        peer_id: input.peerId.trim(),
        ...(input.identityId?.trim() ? { identity_id: input.identityId.trim() } : {}),
        ...(input.directory?.trim() ? { directory: input.directory.trim() } : {}),
      }),
    /** Who the Slack bot answers (#3539). The host holds the router's control token; this app never does. */
    slackSenders: async (): Promise<SlackSenders> =>
      toSlackSenders(await channelRequest("/slack/senders", "GET", SlackSendersResultSchema)),
    /** Approves (`allowed`) or removes a Slack member; the host answers the list as it now stands. */
    setSlackSender: async (userId: string, allowed: boolean): Promise<SlackSenders> =>
      toSlackSenders(
        await channelRequest(
          `/slack/senders/${encodeURIComponent(userId.trim())}`,
          "PUT",
          SlackSendersResultSchema,
          { allowed },
        ),
      ),
    setChannelEnabled: (
      channel: ChannelName,
      enabled: boolean,
      options?: { clearToken?: boolean },
    ): Promise<ChannelEnabledResult> =>
      channelRequest(`/${channel}/enabled`, "PUT", ChannelEnabledResultSchema, {
        enabled,
        ...(options?.clearToken ? { clear_token: true } : {}),
      }),
  };
}

export type InstanceApiClient = ReturnType<typeof createInstanceApiClient>;

/** A client for the current ServiceHub settings, rebuilt when they change; null while there are none. */
export const useInstanceApiClient = (settings: Accessor<ServiceHubSettings | null>) =>
  createMemo(() => {
    const current = settings();
    return current ? createInstanceApiClient(current) : null;
  });

/**
 * What the user reads when a call fails. A code the host API publishes shows its contract
 * sentence, whatever words the body carried; anything else shows one of these fixed sentences,
 * never a status line or a raw transport message.
 */
export const HOST_API_FAILURES = {
  refused: "The host service did not accept the request.",
  unreachable: "The host service could not be reached.",
  unreadable: "The host service answered with something this app does not understand.",
} as const;

function hostApiFailure(error: unknown): Error {
  // A caller's own abort is not a failure to explain: the poller stops its held list this way.
  if (error instanceof Error && error.name === "AbortError") return error;
  if (error instanceof ServiceHubHttpError) {
    const published = Object.hasOwn(SANDBOX_MANAGER_HOST_API_ERRORS, error.code ?? "")
      ? SANDBOX_MANAGER_HOST_API_ERRORS[error.code as keyof typeof SANDBOX_MANAGER_HOST_API_ERRORS]
      : undefined;
    return new ServiceHubHttpError(
      published?.message ?? HOST_API_FAILURES.refused,
      error.status,
      error.code,
      error.retryAfterMs,
      published ? error.details : undefined,
    );
  }
  return new Error(
    error instanceof ServiceHubResponseError ? HOST_API_FAILURES.unreadable : HOST_API_FAILURES.unreachable,
  );
}

const chatGrantPath = (rootSessionId: string) =>
  `${EGRESS_CHAT_GRANTS_PATH}/${encodeURIComponent(rootSessionId)}`;

/** The answer's `allowed`, if it is about the chat that was asked about. */
async function readChatGrant(rootSessionId: string, sent: Promise<unknown>): Promise<boolean> {
  let answer: unknown;
  try {
    answer = await sent;
  } catch (error) {
    throw hostApiFailure(error);
  }
  const parsed = EgressChatGrantStatusSchema.safeParse(answer);
  if (!parsed.success || parsed.data.root_session_id !== rootSessionId) {
    throw new Error(HOST_API_FAILURES.unreadable);
  }
  return parsed.data.allowed;
}

async function readTavilyApiKey(
  send: () => Promise<unknown>,
  method: "GET" | "PUT" | "DELETE",
): Promise<TavilyApiKeyAvailability> {
  let answer: unknown;
  try {
    answer = await send();
  } catch (error) {
    // Only a read can treat "no store in this mode" as a state. A save or clear that gets it
    // did not happen, and must not look like it did.
    if (
      method === "GET" &&
      error instanceof ServiceHubHttpError &&
      error.code === "tavily_api_key_store_unavailable"
    ) {
      return { available: false };
    }
    throw hostApiFailure(error);
  }
  const parsed = TavilyApiKeyStatusSchema.safeParse(answer);
  if (!parsed.success) throw new Error(HOST_API_FAILURES.unreadable);
  return { available: true, configured: parsed.data.configured, enabled: parsed.data.enabled };
}

/**
 * The id a workspace's channel identity goes by: the workspace id in the router's own spelling, so the app, the
 * host and the router agree on it without a lookup. Mirrors the router's `normalizeIdentityId`.
 */
export function channelIdentityIdForWorkspace(workspaceId: string): string {
  const trimmed = workspaceId.trim();
  if (!trimmed) return "default";
  const cleaned = trimmed
    .replace(/[^a-zA-Z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return cleaned || "default";
}

function normalizePairingCode(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function generatePairingCode(): string {
  const random = crypto.getRandomValues(new Uint32Array(PAIRING_CODE_LENGTH));
  return Array.from(random, (value) => PAIRING_CODE_ALPHABET[value % PAIRING_CODE_ALPHABET.length]).join("");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}