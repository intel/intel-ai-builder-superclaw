import { setTimeout as delay } from "node:timers/promises";

import { isAbsolute, join, resolve } from "node:path";

import type { Logger } from "pino";

import type { Config, ChannelName, OpenCodeRouterConfigFile } from "./config.js";
import { readConfigFile, writeConfigFile } from "./config.js";
import { BridgeStore } from "./db.js";
import { startHealthServer, type HealthSnapshot } from "./health.js";
import { decideIntentGate, mapClassifierAgentToRuntimeAgent, type ClassifyResult } from "./intent-gate.js";
import { classifyIntent } from "./intent-classifier-client.js";
import { resolveUnderlyingModel } from "./lrm-usage.js";
import { type InboundMessagePart, type OutboundMessage, type OutboundMessagePart, summarizeInboundPartsForPrompt, summarizeInboundPartsForReporter, textFromInboundParts } from "./media.js";
import { MediaStore } from "./media-store.js";
import { isWithinRoot } from "./workspace-scope.js";
import { DEFAULT_MESSAGING_AGENT_INSTRUCTIONS, createMessagingAgentConfigLoader, toHealthAgentSnapshot } from "./messaging-agent-config.js";
import { createOutboundDelivery, type OutboundKind } from "./outbound-delivery.js";
import { createCommandHandler } from "./commands.js";
import { createEventSubscriber } from "./event-stream.js";
import { createSessionLifecycle } from "./session-lifecycle.js";
import type { Adapter, AdapterStartResult } from "./adapter.js";
import { createTelegramIdentityHandlers } from "./health-telegram-identities.js";
import { createSlackIdentityHandlers } from "./health-slack-identities.js";
import { createBindingHandlers } from "./health-bindings.js";
import { createSlackSenderHandlers, warnWhenNoSlackSenderApproved } from "./health-slack-senders.js";
import { createStoredSlackSenderAccess, parseAllowedUsers, SLACK_ALLOWED_USERS_ENV } from "./slack-senders.js";
import { createSendMessageHandler } from "./health-send-message.js";
import { createScopedSend } from "./scoped-send.js";
import { SendApprovalHold } from "./send-approvals.js";
import { getUserModel } from "./model-preferences.js";
import type { RunState } from "./run-state.js";
import { createRunStatus } from "./run-status.js";
import { createClient, getPromptErrorDetails, isMissingSessionPromptError } from "./opencode.js";
import {
  McpToolGateError,
  MCP_TOOL_GATE_ERROR_MESSAGE,
  engineWorkspaceFiles,
  resolveChannelMcpToolGate,
} from "./mcp-tool-gate.js";
import { resolveModelPrefix, stripModelPrefix, truncateText } from "./text.js";
import { createSlackAdapter, parseSlackPeerId, verifySlackCredentials } from "./slack.js";
import { markdownToBlocks } from "./slack-blocks.js";
import { createTelegramAdapter } from "./telegram.js";
import { createTelegramPairingGate } from "./telegram-pairing.js";


async function startAdapterBounded(
  adapter: Adapter,
  options: { timeoutMs: number; onError?: (error: unknown) => void },
): Promise<AdapterStartResult> {
  const outcome = adapter
    .start()
    .then(() => ({ ok: true as const }))
    .catch((error) => ({ ok: false as const, error }));

  if (options.onError) {
    void outcome.then((result) => {
      if (!result.ok) {
        options.onError?.(result.error);
      }
    });
  }

  const timeoutAbort = new AbortController();
  const winner = await Promise.race([
    outcome.then((result) => ({ kind: "outcome" as const, result })),
    delay(options.timeoutMs, undefined, { signal: timeoutAbort.signal })
      .then(() => ({ kind: "timeout" as const }))
      .catch(() => ({ kind: "timeout" as const })),
  ]);
  timeoutAbort.abort();

  if (winner.kind === "timeout") return { status: "timeout" };
  if (winner.result.ok) return { status: "started" };
  return { status: "error", error: winner.result.error };
}


type BridgeDeps = {
  client?: ReturnType<typeof createClient>;
  clientFactory?: (directory: string) => ReturnType<typeof createClient>;
  store?: BridgeStore;
  adapters?: Map<string, Adapter>;
  disableEventStream?: boolean;
  disableHealthServer?: boolean;
};

export type BridgeReporter = {
  onStatus?: (message: string) => void;
  onInbound?: (message: {
    channel: ChannelName;
    identityId: string;
    peerId: string;
    text: string;
    fromMe?: boolean;
  }) => void;
  onOutbound?: (message: {
    channel: ChannelName;
    identityId: string;
    peerId: string;
    text: string;
    kind: OutboundKind;
  }) => void;
};

type InboundMessage = {
  channel: ChannelName;
  identityId: string;
  peerId: string;
  text: string;
  parts?: InboundMessagePart[];
  raw: unknown;
  fromMe?: boolean;
};

type ModelRef = {
  providerID: string;
  modelID: string;
};

type AgentDescriptor = {
  name?: string;
  hidden?: boolean;
  mode?: string;
};

// Router aliases resolve to a concrete model at request time. Alias set ported
// from `resolveAutoModelID` in apps/ui, plus the explicit `llmrouter`+`auto` pair.
function isAliasModel(model?: ModelRef): boolean {
  if (!model) return false;
  const modelID = model.modelID.trim();
  if (modelID === "auto" || modelID === "local-model" || modelID === "cloud-model") return true;
  return false;
}

function llmPromptLoggingEnabled(): boolean {
  return (process.env.SUPERCLAW_DEBUG_OBSERVABILITY ?? "").trim() === "1";
}

const BUILTIN_AGENT_NAMES = new Set([
  "superclaw-default",
  "local-deep-research",
  "local-dr-math",
  "local-file-agent",
  "websearch-agent",
  "email-agent",
  "protected-pipeline-agent",
  "protected-file-agent",
  "build",
  "hybrid-deep-research",
  // Hidden from the agent picker but explicitly invocable via @plan; must be
  // treated as built-in so the mention isn't misclassified as a custom agent.
  "plan",
]);

const CHANNEL_LABELS: Record<ChannelName, string> = {
  telegram: "Telegram",
  slack: "Slack",
};

const TYPING_INTERVAL_MS = 6000;

// Agent model pins — force specific agents to always use their configured model
// regardless of what the user has selected in the messaging channel.
// Configure via env var: AGENT_MODEL_PINS={"local_agent":"llmrouter/qwen3-coder-30b"}
function parseAgentModelPinsForBridge(): Map<string, ModelRef> {
  const pins = new Map<string, ModelRef>();
  const raw = process.env.AGENT_MODEL_PINS?.trim();
  if (!raw) return pins;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const [agent, model] of Object.entries(parsed)) {
      if (typeof model !== "string") continue;
      const idx = model.indexOf("/");
      if (idx > 0) pins.set(agent, { providerID: model.slice(0, idx), modelID: model.slice(idx + 1) });
    }
  } catch {
    // ignore parse errors
  }
  return pins;
}
const BRIDGE_AGENT_MODEL_PINS = parseAgentModelPinsForBridge();

// ── Intent Classifier integration ───────────────────────────────────────────
// When INTENT_CLASSIFIER_URL is set, the bridge calls the classifier on the
// first message of each thread/peer. Subsequent messages reuse the cached agent.
const INTENT_CLASSIFIER_URL = process.env.INTENT_CLASSIFIER_URL?.trim() || "";

// Per-thread cached agent (channel:identityId:peerKey → agent name)
const threadAgentCache = new Map<string, string>();
// Threads that just received a canned clarification/greeting. Lets the user's
// next message escape the classifier gate instead of being re-classified into
// another canned card — the recovery that prevents the ambiguous-loop trap (#682).
const clarifiedThreads = new Set<string>();
const leadingMentionBoundaryPattern = /[\s,.:;!?)}\]]/;

function threadCacheKey(channel: ChannelName, identityId: string, peerKey: string): string {
  return `${channel}:${identityId}:${peerKey}`;
}

function shouldUseInheritForCustomMention(channel: ChannelName, explicitAgent: string | null): boolean {
  if (channel !== "slack") return false;
  if (!explicitAgent) return false;
  return !BUILTIN_AGENT_NAMES.has(explicitAgent);
}

function parsePermissionMode(
  value: string | null | undefined,
): Config["permissionMode"] | undefined {
  if (value === "allow" || value === "deny" || value === "inherit") return value;
  return undefined;
}

function extractLeadingMentionCandidate(text: string): string | null {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("@")) return null;
  const match = trimmed.match(/^@([^\s,.:;!?)}\]]+)/);
  return match?.[1]?.trim() || null;
}

// Clear ALL per-thread classifier-gate state at once. Both caches must be reset
// together on /reset and /dir so a rebound thread starts from a clean slate;
// keeping it in one place stops the two from drifting apart (a stale
// `clarifiedThreads` entry would otherwise make the first post-reset message
// skip classification — #686 review).
function clearThreadGateState(channel: ChannelName, identityId: string, peerKey: string): void {
  const key = threadCacheKey(channel, identityId, peerKey);
  threadAgentCache.delete(key);
  clarifiedThreads.delete(key);
}

function adapterKey(channel: ChannelName, identityId: string): string {
  return `${channel}:${identityId}`;
}

function invalidTelegramPeerIdError(): Error & { status?: number } {
  const error = new Error(
    "Telegram requires a numeric chat_id for direct targets. Usernames like @name cannot be used as peerId.",
  ) as Error & { status?: number };
  error.status = 400;
  return error;
}

const PAIRING_CODE_HASH_PATTERN = /^[a-f0-9]{64}$/;

function normalizeTelegramAccess(value: unknown): "public" | "private" {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  return raw === "private" ? "private" : "public";
}

function normalizePairingCodeHash(value: unknown): string {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!PAIRING_CODE_HASH_PATTERN.test(raw)) return "";
  return raw;
}

function normalizeIdentityId(value: string | undefined): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return "default";
  const safe = trimmed.replace(/[^a-zA-Z0-9_.-]+/g, "-");
  const cleaned = safe.replace(/^-+|-+$/g, "").slice(0, 48);
  return cleaned || "default";
}

export async function startBridge(config: Config, logger: Logger, reporter?: BridgeReporter, deps: BridgeDeps = {}) {
  const reportStatus = reporter?.onStatus;
  const clients = new Map<string, ReturnType<typeof createClient>>();

  const defaultDirectory = config.opencodeDirectory;
  const workspaceRoot = resolve(defaultDirectory || process.cwd());
  const mediaDir = config.mediaDir ? resolve(config.mediaDir) : join(workspaceRoot, ".opencode-router", "media");
  if (config.mediaDir) {
    logger.info({ mediaDir }, "Using custom media directory");
  }
  const mediaStore = new MediaStore(mediaDir);
  await mediaStore.ensureReady();
  const messagingAgentConfig = createMessagingAgentConfigLoader({
    workspaceRoot,
    agentFile: config.agentFile ? resolve(config.agentFile) : undefined,
    logger,
  });

  const isDangerousRootDirectory = (dir: string) => {
    const normalized = dir.trim();
    if (!normalized) return true;
    if (process.platform !== "win32") {
      return normalized === "/";
    }
    // Windows roots like C:, C:/, C:\
    return /^[a-zA-Z]:\/?$/.test(normalized.replace(/\\/g, "/"));
  };

  const resolveIdentityDirectory = (channel: ChannelName, identityId: string): string => {
    const id = identityId.trim();
    if (!id) return "";
    if (channel === "telegram") {
      const bot = config.telegramBots.find((entry) => entry.id === id);
      return typeof (bot as any)?.directory === "string" ? String((bot as any).directory).trim() : "";
    }
    const app = config.slackApps.find((entry) => entry.id === id);
    return typeof (app as any)?.directory === "string" ? String((app as any).directory).trim() : "";
  };

  const resolveTelegramIdentityAccess = (
    identityId: string,
  ): { access: "public" | "private"; pairingCodeHash: string } => {
    const id = identityId.trim();
    if (!id) {
      return { access: "public", pairingCodeHash: "" };
    }
    const bot = config.telegramBots.find((entry) => entry.id === id);
    if (!bot) {
      return { access: "public", pairingCodeHash: "" };
    }
    const access = normalizeTelegramAccess((bot as any).access);
    const pairingCodeHash = normalizePairingCodeHash((bot as any).pairingCodeHash);
    if (access !== "private") {
      return { access: "public", pairingCodeHash: "" };
    }
    return { access: "private", pairingCodeHash };
  };

  const listIdentityConfigs = (channel: ChannelName): Array<{ id: string; directory: string }> => {
    if (channel === "telegram") {
      return config.telegramBots.map((bot) => ({ id: bot.id, directory: (bot.directory ?? "").trim() }));
    }
    return config.slackApps.map((app) => ({ id: app.id, directory: (app.directory ?? "").trim() }));
  };

  const getClient = (directory?: string | null) => {
    const resolved = (directory ?? "").trim() || defaultDirectory;
    if (deps.client && resolved === defaultDirectory) {
      return deps.client;
    }
    const existing = clients.get(resolved);
    if (existing) return existing;
    const next = deps.clientFactory ? deps.clientFactory(resolved) : createClient(config, resolved);
    clients.set(resolved, next);
    return next;
  };

  const visibleAgentNamesByDirectory = new Map<string, Promise<Set<string>>>();

  const loadVisibleAgentNames = async (directory: string): Promise<Set<string>> => {
    const resolved = (directory || defaultDirectory).trim() || defaultDirectory;
    const cached = visibleAgentNamesByDirectory.get(resolved);
    if (cached) return cached;

    const pending = (async () => {
      const client = getClient(resolved) as ReturnType<typeof createClient> & {
        app?: { agents?: () => Promise<unknown> };
      };
      if (typeof client.app?.agents !== "function") {
        return new Set<string>();
      }
      try {
        const raw = await client.app.agents();
        const list = Array.isArray(raw)
          ? raw
          : Array.isArray((raw as { data?: unknown[] } | null | undefined)?.data)
            ? ((raw as { data?: unknown[] }).data ?? [])
            : [];
        return new Set(
          list
            .filter((item): item is AgentDescriptor => Boolean(item && typeof item === "object"))
            .filter((agent) => !agent.hidden && agent.mode !== "subagent" && typeof agent.name === "string")
            .map((agent) => agent.name.trim())
            .filter(Boolean),
        );
      } catch (error) {
        logger.warn({ error, directory: resolved }, "failed to load visible agent list for messaging bridge");
        return new Set<string>();
      }
    })();

    visibleAgentNamesByDirectory.set(resolved, pending);
    return pending;
  };

  const resolveLeadingMentionAgent = async (text: string, directory: string): Promise<string | null> => {
    const candidate = extractLeadingMentionCandidate(text);
    if (!candidate) return null;
    const visibleAgents = await loadVisibleAgentNames(directory);
    if (visibleAgents.size === 0) return null;
    const normalized = candidate.toLowerCase();
    const canonicalName = Array.from(visibleAgents).find((n) => n.toLowerCase() === normalized);
    if (!canonicalName) return null;

    const trimmed = text.trimStart();
    const prefix = `@${candidate}`;
    const boundary = trimmed[prefix.length];
    if (boundary && !leadingMentionBoundaryPattern.test(boundary)) return null;
    return canonicalName;
  };

  const rootClient = getClient(defaultDirectory);
  const store = deps.store ?? new BridgeStore(config.dbPath);
  const slackSenders = config.slackSenders ?? createStoredSlackSenderAccess(store, parseAllowedUsers(process.env[SLACK_ALLOWED_USERS_ENV]));
  config.slackSenders = slackSenders;

  logger.debug(
    {
      configPath: config.configPath,
      opencodeUrl: config.opencodeUrl,
      opencodeDirectory: config.opencodeDirectory,
      telegramBots: config.telegramBots.map((bot) => ({ id: bot.id, enabled: bot.enabled !== false })),
      slackApps: config.slackApps.map((app) => ({ id: app.id, enabled: app.enabled !== false })),
      groupsEnabled: config.groupsEnabled,
      permissionMode: config.permissionMode,
      toolUpdatesEnabled: config.toolUpdatesEnabled,
    },
    "bridge config",
  );

  const adapters = deps.adapters ?? new Map<string, Adapter>();
  const usingInjectedAdapters = Boolean(deps.adapters);

  if (!usingInjectedAdapters) {
    const enabledTelegram = config.telegramBots.filter((bot) => bot.enabled !== false);
    if (enabledTelegram.length === 0) {
      logger.info("telegram adapters disabled");
      reportStatus?.("Telegram adapters disabled.");
    }
    for (const bot of enabledTelegram) {
      const key = adapterKey("telegram", bot.id);
      logger.debug({ identityId: bot.id }, "telegram adapter enabled");
      const base = createTelegramAdapter(bot, config, logger, handleInbound, mediaStore);
      adapters.set(key, { ...base, key });
    }

    const enabledSlack = config.slackApps.filter((app) => app.enabled !== false);
    if (enabledSlack.length === 0) {
      logger.info("slack adapters disabled");
      reportStatus?.("Slack adapters disabled.");
    } else {
      warnWhenNoSlackSenderApproved(slackSenders, logger, reportStatus);
    }
    for (const app of enabledSlack) {
      const key = adapterKey("slack", app.id);
      logger.debug({ identityId: app.id }, "slack adapter enabled");
      const base = createSlackAdapter(app, config, logger, handleInbound, undefined, mediaStore);
      adapters.set(key, { ...base, key });
    }
  }

  const keyForSession = (directory: string, sessionID: string) => `${directory}::${sessionID}`;

  const sessionQueue = new Map<string, Promise<void>>();
  // Keeping resolved migrations so handlers holding an older store snapshot still reuse the replacement.
  const legacySessionMigrations = new Map<string, Promise<string>>();
  const sessionWildcardAllowChecks = new Map<string, Promise<boolean>>();
  const activeRuns = new Map<string, RunState>();
  const sessionModels = new Map<string, ModelRef>();
  // Out-of-band model provenance cursor, keyed like `sessionModels`: the host
  // `occurred_at` of the last LRM usage event already attributed to this
  // session, so the next lookup only sees the current turn. Holding host millis
  // (never a container clock) also keeps it correct across `recreateSession` —
  // the replacement session's events are strictly newer than the old cursor.
  const sessionUsageCursor = new Map<string, number>();
  const typingLoops = new Map<string, NodeJS.Timeout>();
  const activeStatusMessages = new Map<string, { ts: string; channelId: string; finalized: boolean }>();
  const lastStatusUpdateMs = new Map<string, number>();
  // Track sessions created by opencode-router (for Telegram/Slack).
  // Only auto-approve permissions for these sessions; frontend sessions should wait for user interaction.
  const routerManagedSessions = new Set<string>();
  const sessionsWithoutWildcardAllow = new Set<string>();
  const sessionPermissionModes = new Map<string, Config["permissionMode"]>();

  const formatPeer = (_channel: ChannelName, peerId: string) => peerId;

  const normalizeDirectory = (input: string) => {
    const trimmed = input.trim();
    if (!trimmed) return "";
    const unified = trimmed.replace(/\\/g, "/");
    const withoutTrailing = unified.replace(/\/+$/, "");
    const normalized = withoutTrailing || "/";
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };

  const workspaceRootNormalized = normalizeDirectory(workspaceRoot);

  const isWithinWorkspaceRoot = (candidate: string) => isWithinRoot(workspaceRoot, candidate);

  const resolveScopedDirectory = (input: string): { ok: true; directory: string } | { ok: false; error: string } => {
    const trimmed = input.trim();
    if (!trimmed) return { ok: false, error: "Directory is required." };
    const resolved = resolve(isAbsolute(trimmed) ? trimmed : join(workspaceRoot, trimmed));
    if (!isWithinWorkspaceRoot(resolved)) {
      return {
        ok: false,
        error: `Directory must stay within workspace root: ${workspaceRootNormalized}`,
      };
    }
    return { ok: true, directory: normalizeDirectory(resolved) };
  };

  const formatModelLabel = (model?: ModelRef) =>
    model ? `${model.providerID}/${model.modelID}` : null;

  const buildFinalSlackBlocks = (text: string, model?: string): object[] | undefined => {
    let blocks: object[] | null = null;
    try {
      blocks = markdownToBlocks(text);
    } catch {
      return undefined;
    }
    if (!blocks || blocks.length === 0) return undefined;
    const modelLabel = model?.trim();
    if (!modelLabel) return blocks;
    return [...blocks, { type: "context", elements: [{ type: "mrkdwn", text: `Model: *${modelLabel}*` }] }];
  };


  let opencodeHealthy = false;
  let opencodeVersion: string | undefined;

  const HEALTH_SLOW_INTERVAL_MS = 30_000;
  const HEALTH_FAST_INTERVAL_MS = 1_000;
  let healthIntervalMs = HEALTH_FAST_INTERVAL_MS;
  let healthTimer: NodeJS.Timeout | null = null;

  async function refreshHealth() {
    try {
      const health = await rootClient.global.health();
      opencodeHealthy = Boolean((health as { healthy?: boolean }).healthy);
      opencodeVersion = (health as { version?: string }).version;
    } catch (error) {
      logger.warn({ error }, "failed to reach opencode health");
      opencodeHealthy = false;
    }

    // After initial startup, switch to a slower poll once OpenCode is healthy.
    if (opencodeHealthy && healthIntervalMs !== HEALTH_SLOW_INTERVAL_MS) {
      healthIntervalMs = HEALTH_SLOW_INTERVAL_MS;
      if (healthTimer) {
        clearInterval(healthTimer);
      }
      healthTimer = setInterval(refreshHealth, healthIntervalMs);
    }
  }

  await refreshHealth();
  if (!healthTimer) {
    healthTimer = setInterval(refreshHealth, healthIntervalMs);
  }

  // Mutable runtime state for groups (persisted to config file)
  let groupsEnabled = config.groupsEnabled;

  const startOfToday = (now: number) => {
    const day = new Date(now);
    day.setHours(0, 0, 0, 0);
    return day.getTime();
  };

  let activityDayStart = startOfToday(Date.now());
  let inboundToday = 0;
  let outboundToday = 0;
  let lastInboundAt: number | undefined;
  let lastOutboundAt: number | undefined;

  const ensureActivityDay = (now: number) => {
    const nextDayStart = startOfToday(now);
    if (nextDayStart === activityDayStart) return;
    activityDayStart = nextDayStart;
    inboundToday = 0;
    outboundToday = 0;
  };

  const recordInboundActivity = (now: number) => {
    ensureActivityDay(now);
    inboundToday += 1;
    lastInboundAt = now;
  };

  const recordOutboundActivity = (now: number) => {
    ensureActivityDay(now);
    outboundToday += 1;
    lastOutboundAt = now;
  };

  await messagingAgentConfig.load();

  const outboundMediaMaxBytesRaw = Number.parseInt(process.env.OPENCODE_ROUTER_MAX_MEDIA_BYTES ?? "", 10);
  const outboundMediaMaxBytes =
    Number.isFinite(outboundMediaMaxBytesRaw) && outboundMediaMaxBytesRaw > 0
      ? outboundMediaMaxBytesRaw
      : 50 * 1024 * 1024;

  const { resolveOutboundParts, deliverParts } = createOutboundDelivery({
    resolveAdapter: (channel, identityId) => adapters.get(adapterKey(channel, identityId)),
    ...(reporter?.onOutbound ? { reportOutbound: reporter.onOutbound } : {}),
    recordOutboundActivity,
    mediaStore,
    workspaceRoot,
    outboundRoot: config.outboxDir ? resolve(config.outboxDir) : undefined,
    outboundMediaMaxBytes,
  });

  const { beginStatus, emitStatus, clearNativeStatus, reportThinking, reportDone, startTyping, stopTyping } =
    createRunStatus({
      adapters,
      logger,
      deliverParts,
      activeStatusMessages,
      lastStatusUpdateMs,
      typingLoops,
      modelLabelForRun: (run) => formatModelLabel(sessionModels.get(run.key)),
      formatPeer,
      ...(reportStatus ? { reportStatus } : {}),
      channelLabels: CHANNEL_LABELS,
      typingIntervalMs: TYPING_INTERVAL_MS,
    });

  let stopHealthServer: (() => void) | null = null;
  if (!deps.disableHealthServer && config.healthPort) {
    const verifySlackIdentity = async (input: { botToken: string; appToken: string }) => {
      const botToken = input.botToken.trim();
      const appToken = input.appToken.trim();
      const verification = await verifySlackCredentials(botToken, appToken);
      if (!verification.ok) {
        const scopeLabel = verification.scope === "bot" ? "bot token" : "app token";
        const message =
          verification.reason === "unreachable"
            ? `Could not reach Slack to verify the ${scopeLabel}: ${verification.error}. Check the network connection and try again.`
            : `Slack rejected the ${scopeLabel}: ${verification.error}.`;
        logger.warn(
          {
            channel: "slack",
            scope: verification.scope,
            reason: verification.reason,
            error: verification.error,
          },
          "slack credential verification failed; refusing to save",
        );
        // `scope` and `reason` travel as structured fields, not just inside the
        // message. The UI has to place "Invalid bot token" under the specific
        // field that is wrong, and an offline notice somewhere else entirely;
        // deriving that by parsing English prose would break on the first
        // wording change or translation.
        throw Object.assign(new Error(message), {
          status: verification.reason === "unreachable" ? 503 : 400,
          slackScope: verification.scope,
          slackReason: verification.reason,
          slackError: verification.error,
        });
      }
      logger.info(
        {
          channel: "slack",
          teamName: verification.teamName,
          teamId: verification.teamId,
        },
        "slack credentials verified",
      );

      return {
        ...(verification.teamName ? { teamName: verification.teamName } : {}),
        ...(verification.teamId ? { teamId: verification.teamId } : {}),
        ...(verification.botUserId ? { botUserId: verification.botUserId } : {}),
      };
    };

    const telegramIdentityHandlers = createTelegramIdentityHandlers({
      config,
      adapters,
      adapterKey,
      normalizeIdentityId,
      normalizeTelegramAccess,
      normalizePairingCodeHash,
      startAdapterBounded,
      createAdapter: createTelegramAdapter,
      handleInbound,
      mediaStore,
      logger,
    });

    const slackIdentityHandlers = createSlackIdentityHandlers({
      config,
      adapters,
      adapterKey,
      normalizeIdentityId,
      verifySlackIdentity,
      createAdapter: createSlackAdapter,
      startAdapterBounded,
      handleInbound,
      mediaStore,
      logger,
    });

    const sendMessage = createSendMessageHandler({
      store,
      adapters,
      adapterKey,
      normalizeIdentityId,
      normalizeDirectory,
      resolveScopedDirectory,
      listIdentityConfigs,
      resolveOutboundParts,
      deliverParts,
      // Wrapped: both are declared below the health server, so reading them at
      // factory-construction time would be a temporal dead zone error.
      ensureEventSubscription: (directory) => ensureEventSubscription(directory),
      invalidTelegramPeerIdError,
      workspaceRoot,
      workspaceRootNormalized,
    });

    const sendApprovals = new SendApprovalHold({
      config: config.approval,
      onEvent: (event) => logger.info(event, "router send approval"),
    });
    const scopedSendMessage = createScopedSend({
      store,
      hold: sendApprovals,
      send: sendMessage,
      normalizeDirectory,
      resolveScopedDirectory,
      workspaceRootNormalized,
      audit: (entry) => logger.info(entry, "router scoped send"),
    });

    const bindingHandlers = createBindingHandlers({
      store,
      normalizeIdentityId,
      resolveScopedDirectory,
      // Wrapped rather than passed by reference: ensureEventSubscription is
      // declared below the health server, so reading it here would be a TDZ error.
      ensureEventSubscription: (directory) => ensureEventSubscription(directory),
      invalidTelegramPeerIdError,
    });

    stopHealthServer = await startHealthServer(
      config.healthPort,
      (): HealthSnapshot => ({
        ok: opencodeHealthy,
        opencode: {
          url: config.opencodeUrl,
          healthy: opencodeHealthy,
          version: opencodeVersion,
        },
        channels: {
          telegram: Array.from(adapters.keys()).some((key) => key.startsWith("telegram:")),
          // WhatsApp removed; keep field for backward compatibility.
          whatsapp: false,
          slack: Array.from(adapters.keys()).some((key) => key.startsWith("slack:")),
        },
        config: {
          groupsEnabled,
        },
        activity: {
          dayStart: activityDayStart,
          inboundToday,
          outboundToday,
          ...(typeof lastInboundAt === "number" ? { lastInboundAt } : {}),
          ...(typeof lastOutboundAt === "number" ? { lastOutboundAt } : {}),
          ...(typeof lastInboundAt === "number" || typeof lastOutboundAt === "number"
            ? { lastMessageAt: Math.max(lastInboundAt ?? 0, lastOutboundAt ?? 0) }
            : {}),
        },
        agent: toHealthAgentSnapshot(messagingAgentConfig.latest()),
      }),
      logger,
      {
        getGroupsEnabled: () => groupsEnabled,
        setGroupsEnabled: async (enabled: boolean) => {
          groupsEnabled = enabled;
          // Also update config so adapters see the change
          (config as any).groupsEnabled = enabled;
          
          // Persist to config file
          const { config: current } = readConfigFile(config.configPath);
          const next: OpenCodeRouterConfigFile = {
            ...current,
            groupsEnabled: enabled,
          };
          next.version = next.version ?? 1;
          writeConfigFile(config.configPath, next);
          config.configFile = next;
          
          logger.info({ groupsEnabled: enabled }, "groups config updated");
          return { groupsEnabled: enabled };
        },

        ...telegramIdentityHandlers,

        verifySlackIdentity,
        ...slackIdentityHandlers,
        ...bindingHandlers,
        ...createSlackSenderHandlers({ slackSenders, logger }),

        sendMessage,
        scopedSendMessage,
      },
      config.controlToken,
      {
        ...(config.scopedToken ? { token: config.scopedToken } : {}),
        ...(config.approval ? { approvals: { hold: sendApprovals, adminSecret: config.approval.admin_secret } } : {}),
      },
    );
  }

  const eventSubscriptions = new Map<string, AbortController>();

  const ensureEventSubscription = createEventSubscriber({
    ...(deps.disableEventStream !== undefined ? { disableEventStream: deps.disableEventStream } : {}),
    defaultDirectory,
    eventSubscriptions,
    getClient,
    status: { emitStatus, reportThinking, reportDone, startTyping, stopTyping },
    activeRuns,
    sessionModels,
    keyForSession,
    sendText,
    routerManagedSessions,
    sessionPermissionModes,
    logger,
    toolOutputLimit: config.toolOutputLimit,
    permissionMode: config.permissionMode,
  });


  ensureEventSubscription(defaultDirectory);

  async function sendText(
    channel: ChannelName,
    identityId: string,
    peerId: string,
    text: string,
    options: { kind?: OutboundKind; display?: boolean; model?: string } = {},
  ) {
    const parts: OutboundMessagePart[] =
      text.startsWith("FILE:") && text.substring(5).trim()
        ? [{ type: "file", filePath: text.substring(5).trim() }]
        : [{ type: "text", text }];
    const meta = options.model ? { model: options.model } : undefined;
    const delivery = await deliverParts(channel, identityId, peerId, parts, options, meta);
    if (delivery.sentParts < delivery.attemptedParts) {
      const message = delivery.partResults.find((part) => !part.sent)?.error || "Failed to send message";
      throw new Error(message);
    }
  }

  const handleTelegramPairingGate = createTelegramPairingGate({
    sendText,
    resolveTelegramIdentityAccess,
    resolveIdentityDirectory,
    resolveScopedDirectory,
    isDangerousRootDirectory,
    ensureEventSubscription,
    store,
    defaultDirectory,
    logger,
  });

  const handleCommand = createCommandHandler({
    sendText,
    store,
    logger,
    clearThreadGateState,
    handleTelegramPairingGate,
    resolveScopedDirectory,
    ensureEventSubscription,
    loadMessagingAgentConfig: () => messagingAgentConfig.load(),
    ...(config.model ? { defaultModel: config.model } : {}),
    defaultDirectory,
  });

  async function handleInbound(message: InboundMessage) {
    const adapter = adapters.get(adapterKey(message.channel, message.identityId));
    if (!adapter) return;
    recordInboundActivity(Date.now());
    const normalizedParts: InboundMessagePart[] =
      Array.isArray(message.parts) && message.parts.length
        ? message.parts
        : message.text.trim()
          ? [{ type: "text", text: message.text }]
          : [];
    const inboundText = textFromInboundParts(normalizedParts, message.text).trim();
    let inbound: InboundMessage = {
      ...message,
      text: inboundText,
      ...(normalizedParts.length ? { parts: normalizedParts } : {}),
    };

    if (inbound.fromMe) {
      logger.debug(
        {
          channel: inbound.channel,
          identityId: inbound.identityId,
          peerId: inbound.peerId,
        },
        "inbound ignored (self-authored)",
      );
      return;
    }

    const reporterInboundText =
      inbound.text || summarizeInboundPartsForReporter(inbound.parts) || "[empty message]";
    logger.debug(
      {
        channel: inbound.channel,
        identityId: inbound.identityId,
        peerId: inbound.peerId,
        fromMe: inbound.fromMe,
        length: reporterInboundText.length,
        ...(llmPromptLoggingEnabled() ? { preview: truncateText(reporterInboundText.trim(), 120) } : {}),
      },
      "inbound received",
    );
    logger.info(
      { channel: inbound.channel, identityId: inbound.identityId, peerId: inbound.peerId, length: reporterInboundText.length },
      "received message",
    );
    const peerKey = inbound.peerId;
    const trimmedText = inbound.text.trim();
    let binding = store.getBinding(inbound.channel, inbound.identityId, peerKey);
    let session = store.getSession(inbound.channel, inbound.identityId, peerKey);

    if (inbound.channel === "telegram") {
      const pairingGate = await handleTelegramPairingGate({
        identityId: inbound.identityId,
        peerKey,
        peerId: inbound.peerId,
        text: trimmedText,
        ...(binding?.directory?.trim() ? { bindingDirectory: binding.directory } : {}),
        ...(session?.directory?.trim() ? { sessionDirectory: session.directory ?? undefined } : {}),
      });
      if (pairingGate === "handled") return;
      binding = store.getBinding(inbound.channel, inbound.identityId, peerKey);
      session = store.getSession(inbound.channel, inbound.identityId, peerKey);
    }

    // Handle bot commands
    if (trimmedText.startsWith("/")) {
      const commandHandled = await handleCommand(
        inbound.channel,
        inbound.identityId,
        peerKey,
        inbound.peerId,
        trimmedText,
      );
      if (commandHandled) return;
    }

    reporter?.onInbound?.({
      channel: inbound.channel,
      identityId: inbound.identityId,
      peerId: inbound.peerId,
      text: reporterInboundText,
      fromMe: inbound.fromMe,
    });

    const identityDirectory = resolveIdentityDirectory(inbound.channel, inbound.identityId);

    const boundDirectoryCandidate =
      binding?.directory?.trim() || session?.directory?.trim() || identityDirectory || defaultDirectory;

    const hasExplicitBinding = Boolean(binding?.directory?.trim() || session?.directory?.trim() || identityDirectory);
    if (!boundDirectoryCandidate || (!hasExplicitBinding && isDangerousRootDirectory(boundDirectoryCandidate))) {
      await sendText(
        inbound.channel,
        inbound.identityId,
        inbound.peerId,
        "No workspace directory configured for this identity. Ask your OpenWork host to set it, or reply with /dir <path>.",
        { kind: "system" },
      );
      return;
    }

    const scopedBound = resolveScopedDirectory(boundDirectoryCandidate);
    if (!scopedBound.ok) {
      await sendText(inbound.channel, inbound.identityId, inbound.peerId, scopedBound.error, { kind: "system" });
      return;
    }
    const boundDirectory = scopedBound.directory;

    const shouldAutoBind = !(
      inbound.channel === "telegram" && resolveTelegramIdentityAccess(inbound.identityId).access === "private"
    );
    if (shouldAutoBind && !binding?.directory?.trim()) {
      store.upsertBinding(inbound.channel, inbound.identityId, peerKey, boundDirectory);
    }

    ensureEventSubscription(boundDirectory);

    const incomingText = inbound.text || "(no text; user sent media)";
    const explicitAgent = await resolveLeadingMentionAgent(incomingText, boundDirectory);

    const existingSessionID =
      session?.session_id && normalizeDirectory(session?.directory ?? "") === normalizeDirectory(boundDirectory)
        ? session.session_id
        : undefined;
    const inMemorySessionMode = existingSessionID ? sessionPermissionModes.get(existingSessionID) : undefined;
    const existingSessionMode = inMemorySessionMode ?? parsePermissionMode(session?.permission_mode);
    const storedModeIsUnknown =
      Boolean(existingSessionID) && inMemorySessionMode === undefined && session?.permission_mode == null;
    if (existingSessionID && existingSessionMode) {
      sessionPermissionModes.set(existingSessionID, existingSessionMode);
    }
    const mentionForcesInherit = shouldUseInheritForCustomMention(inbound.channel, explicitAgent);
    const permissionModeForNewSession = mentionForcesInherit ? "inherit" : config.permissionMode;
    let hasLegacyWildcardAllow = false;
    if (
      existingSessionID &&
      !sessionsWithoutWildcardAllow.has(existingSessionID) &&
      existingSessionMode === "inherit"
    ) {
      try {
        hasLegacyWildcardAllow = await sessionHasWildcardAllow(boundDirectory, existingSessionID);
        if (!hasLegacyWildcardAllow) sessionsWithoutWildcardAllow.add(existingSessionID);
      } catch (error) {
        if (isMissingSessionPromptError(error)) {
          hasLegacyWildcardAllow = true;
        } else {
          logger.error({ error, sessionID: existingSessionID }, "could not inspect reused session permission, turn refused");
          await sendText(
            inbound.channel,
            inbound.identityId,
            inbound.peerId,
            "This conversation's safety settings could not be verified, so the message was not run. Please try again.",
            { kind: "system" },
          );
          return;
        }
      }
    }
    const mustMigrateLegacyAllow =
      Boolean(existingSessionID) &&
      permissionModeForNewSession !== "allow" &&
      (existingSessionMode === "allow" || storedModeIsUnknown || hasLegacyWildcardAllow);

    // A custom-agent mention on an existing non-inherit session must switch that
    // session to inherit so the agent's OWN permission block (its allow/deny in
    // agent.md) governs instead of the session-level allow-all override. Do this
    // IN PLACE (session.update) rather than recreating the session, so the
    // conversation history is preserved.
    const mustSwitchToInherit =
      Boolean(existingSessionID) &&
      !mustMigrateLegacyAllow &&
      mentionForcesInherit &&
      existingSessionMode !== "inherit";

    // When switching for a mention, the mention's intent must win — otherwise the
    // `existingSessionMode ??` branch short-circuits and we'd keep the old mode.
    const desiredPermissionMode = mustMigrateLegacyAllow
      ? permissionModeForNewSession
      : mustSwitchToInherit
        ? "inherit"
        : (existingSessionMode ?? permissionModeForNewSession);

    const migrationKey = existingSessionID ? keyForSession(boundDirectory, existingSessionID) : undefined;
    const pendingMigration = migrationKey ? legacySessionMigrations.get(migrationKey) : undefined;
    const migratedLegacyAllow = Boolean(mustMigrateLegacyAllow || pendingMigration);
    if (mustMigrateLegacyAllow && migrationKey && !pendingMigration) {
      await drainSessionQueue(migrationKey);
    }
    let sessionID: string;
    if (pendingMigration) {
      sessionID = await pendingMigration;
    } else if (mustMigrateLegacyAllow && existingSessionID && migrationKey) {
      sessionID = await migrateLegacySession(migrationKey, existingSessionID, {
        channel: inbound.channel,
        identityId: inbound.identityId,
        peerId: inbound.peerId,
        peerKey,
        directory: boundDirectory,
        announce: false,
        permissionMode: desiredPermissionMode,
      });
    } else if (existingSessionID) {
      sessionID = existingSessionID;
    } else {
      sessionID = await createSession({
        channel: inbound.channel,
        identityId: inbound.identityId,
        peerId: inbound.peerId,
        peerKey,
        directory: boundDirectory,
        permissionMode: desiredPermissionMode,
      });
    }

    if (mustSwitchToInherit && existingSessionID) {
      await switchSessionPermissionMode(boundDirectory, existingSessionID, "inherit", {
        channel: inbound.channel,
        identityId: inbound.identityId,
        peerKey,
      });
    }
    if (existingSessionID && !migratedLegacyAllow) {
      try {
        await ensureChannelDenies(boundDirectory, existingSessionID);
        routerManagedSessions.add(existingSessionID);
      } catch (error) {
        // A session deleted in OpenCode cannot run anything; the prompt's missing-session
        // recovery recreates it, and createSession applies the denies.
        if (!isMissingSessionPromptError(error)) {
          logger.error({ error, sessionID: existingSessionID }, "could not re-apply channel tool denies; turn refused");
          await sendText(
            inbound.channel,
            inbound.identityId,
            inbound.peerId,
            "This conversation's safety settings could not be updated, so the message was not run. Please try again.",
            { kind: "system" },
          );
          return;
        }
        logger.warn({ sessionID: existingSessionID }, "reused session is gone; the prompt will recreate it");
      }
    }
    const key = keyForSession(boundDirectory, sessionID);
    logger.debug(
      {
        sessionID,
        channel: inbound.channel,
        peerId: inbound.peerId,
        reused: Boolean(existingSessionID && !migratedLegacyAllow),
        migratedLegacyAllow,
        switchedToInherit: mustSwitchToInherit,
        permissionMode: sessionPermissionModes.get(sessionID) ?? desiredPermissionMode,
        mentionForcesInherit,
        explicitAgent,
      },
      "session resolved",
    );

    enqueue(key, async () => {
      const runState: RunState = {
        key,
        directory: boundDirectory,
        sessionID,
        channel: inbound.channel,
        identityId: inbound.identityId,
        adapterKey: adapterKey(inbound.channel, inbound.identityId),
        peerId: inbound.peerId,
        peerKey,
        toolUpdatesEnabled: config.toolUpdatesEnabled,
        seenToolStates: new Map(),
        nativeStatusEligible:
          inbound.channel === "slack" &&
          (() => {
            const peer = parseSlackPeerId(inbound.peerId);
            return Boolean(peer.threadTs);
          })(),
      };
      activeRuns.set(key, runState);
      reportThinking(runState);
      startTyping(runState);

      // Shared by every McpToolGateError catch site below: the prompt that
      // failed the gate must never be sent, and the user gets one short,
      // specific explanation instead of a generic failure message.
      const postMcpGateErrorMessage = async () => {
        await clearNativeStatus(runState);
        const statusEntry = activeStatusMessages.get(inbound.peerId);
        const replyAdapter = adapters.get(runState.adapterKey);
        if (statusEntry && !statusEntry.finalized && replyAdapter?.updateMessage) {
          statusEntry.finalized = true;
          try {
            await replyAdapter.updateMessage(inbound.peerId, statusEntry.ts, { text: MCP_TOOL_GATE_ERROR_MESSAGE });
            activeStatusMessages.delete(inbound.peerId);
            lastStatusUpdateMs.delete(inbound.peerId);
            return;
          } catch (finalizeError) {
            logger.warn({ finalizeError }, "status error-finalize failed; posting new message");
          }
        }
        await sendText(inbound.channel, inbound.identityId, inbound.peerId, MCP_TOOL_GATE_ERROR_MESSAGE, {
          kind: "system",
        });
      };

      type PromptPart = {
        type?: string;
        text?: string;
        ignored?: boolean;
        // Subset of @opencode-ai/sdk ToolPart fields we read for failure detection.
        tool?: string;
        state?: { status?: string; error?: string; input?: unknown };
      };

      // The single choke point every actual session.prompt call for this run
      // goes through: it re-reads the workspace MCP policy and the session's
      // ACTUAL current permission on every invocation (never once per inbound
      // message) and adds `tools` only when there is something to project. A
      // missing-session error surfacing here (the permission read can
      // discover it before the prompt does) propagates unchanged so
      // runPromptRecoveringMissingSession's recovery still applies.
      const gatedPrompt = async (input: {
        sessionID: string;
        parts: Array<{ type: "text"; text: string }>;
        system?: string;
        model?: ModelRef;
        agent?: string;
      }): Promise<{ parts?: PromptPart[] }> => {
        const client = getClient(boundDirectory);
        const tools = await resolveChannelMcpToolGate({
          workspaceRoot,
          sessionID: input.sessionID,
          client,
          files: engineWorkspaceFiles(client, workspaceRoot),
        });
        return (await client.session.prompt({
          sessionID: input.sessionID,
          ...(input.system ? { system: input.system } : {}),
          parts: input.parts,
          ...(input.model ? { model: input.model } : {}),
          ...(input.agent ? { agent: input.agent } : {}),
          ...(tools ? { tools } : {}),
        })) as { parts?: PromptPart[] };
      };

      try {
        await beginStatus(runState, "🤔 Working on it…");

        const effectiveModel = getUserModel(inbound.channel, inbound.identityId, peerKey, config.model);
            const messagingAgent = await messagingAgentConfig.load();
        const attachmentSummary = summarizeInboundPartsForPrompt(inbound.parts);
        const userPromptText = incomingText;

        // Only the actual user message (+ attachments) becomes the prompt text.
        const promptText = [
          userPromptText,
          ...(attachmentSummary.length ? ["", "Attachments:", ...attachmentSummary] : []),
        ].join("\n");
        // Re-read the session from the store: an earlier queued task for the
        // same peer may have already silently recreated the session, so the
        // sessionID captured before enqueue() can be stale.
        const latestSession = store.getSession(inbound.channel, inbound.identityId, peerKey);
        let currentSessionID =
          latestSession?.session_id &&
          normalizeDirectory(latestSession.directory ?? "") === normalizeDirectory(boundDirectory)
            ? latestSession.session_id
            : sessionID;
        runState.sessionID = currentSessionID;
        logger.debug(
          {
            sessionID: currentSessionID,
            length: inbound.text.length,
            model: effectiveModel,
            agent: explicitAgent ?? messagingAgent.selectedAgent,
          },
          "prompt start",
        );

        // ── Intent Classifier gate ──────────────────────────────────
        // If INTENT_CLASSIFIER_URL is configured, classify the first message
        // of each thread. Subsequent messages use the cached agent.
        let classifiedAgent: string | undefined;
        if (INTENT_CLASSIFIER_URL && !explicitAgent) {
          const cacheKey = threadCacheKey(inbound.channel, inbound.identityId, peerKey);
          const cachedAgent = threadAgentCache.get(cacheKey);
          const alreadyClarified = clarifiedThreads.has(cacheKey);
          // Only spend a classifier call when the thread is fresh — a cached agent
          // or a just-issued clarification already determines the action.
          const classified =
            cachedAgent || alreadyClarified
              ? null
              : await classifyIntent(inbound.text, currentSessionID, logger);
          const decision = decideIntentGate({ cachedAgent, alreadyClarified }, classified);
          switch (decision.action) {
            case "use-cached-agent":
              classifiedAgent = decision.agent;
              logger.debug({ cachedAgent: decision.agent, peerKey }, "intent classifier: using cached agent");
              break;
            case "send-canned":
              // Canned response (greeting, ambiguous) — reply directly, skip agent.
              // Mark the thread so the user's NEXT message escapes the gate instead
              // of being re-classified into another canned card (#682).
              await sendText(inbound.channel, inbound.identityId, inbound.peerId, decision.text, { kind: "reply" });
              clarifiedThreads.add(cacheKey);
              logger.info({ category: classified?.category, peerKey }, "intent classifier: canned response sent");
              return;
            case "resolve-agent":
              classifiedAgent = mapClassifierAgentToRuntimeAgent(decision.agent);
              threadAgentCache.set(cacheKey, classifiedAgent);
              logger.info({ agent: classifiedAgent, category: classified?.category, peerKey }, "intent classifier: resolved agent");
              if (decision.notice) {
                // Routing notification (e.g. "Routing to Hybrid Coding...")
                await sendText(inbound.channel, inbound.identityId, inbound.peerId, decision.notice, { kind: "system" });
              }
              break;
            case "fall-through":
              if (decision.reason === "post-clarification-recovery") {
                // The user already saw a clarification; let this message reach the
                // default agent so they can steer the conversation back (#682).
                clarifiedThreads.delete(cacheKey);
                logger.info({ peerKey }, "intent classifier: post-clarification recovery, using default agent");
              }
              // classifier unreachable / null / no actionable verdict → default agent
              break;
          }
        }

        const extractReply = (parts: PromptPart[]) =>
          parts
            .filter((part) => part.type === "text" && !part.ignored)
            .map((part) => part.text ?? "")
            .join("\n")
            .trim();

        // Detect a failed tool call. opencode surfaces malformed tool args two ways:
        //   1. ToolPart with `tool === "invalid"` (the model emitted unparseable
        //      tool_call JSON — e.g. truncated by llama-server's --n-predict cap).
        //   2. ToolPart with `state.status === "error"` (tool ran but failed).
        // Returns the error message for the recovery prompt, or null if all
        // tool parts succeeded.
        const findFailedToolPart = (parts: PromptPart[]): string | null => {
          for (const part of parts) {
            if (part.type !== "tool") continue;
            if (part.tool === "invalid") {
              const inputErr =
                part.state?.input && typeof part.state.input === "object"
                  ? (part.state.input as { error?: unknown }).error
                  : undefined;
              return (
                (typeof inputErr === "string" && inputErr) ||
                part.state?.error ||
                "invalid tool call arguments"
              );
            }
            if (part.state?.status === "error") {
              return part.state.error || `tool ${part.tool ?? "unknown"} failed`;
            }
          }
          return null;
        };

        const logPromptResponse = (attempt: "initial" | "retry" | "recovered", parts: PromptPart[]) => {
          const textParts = parts.filter((part) => part.type === "text" && !part.ignored);
          logger.debug(
            {
              sessionID: currentSessionID,
              attempt,
              partCount: parts.length,
              textCount: textParts.length,
              partTypes: parts.map((p) => p.type),
              ignoredCount: parts.filter((p) => p.ignored).length,
            },
            "prompt response",
          );
        };

        // Effective agent: classifier result takes priority over .md file agent
        const effectiveAgent = explicitAgent ?? classifiedAgent ?? messagingAgent.selectedAgent;

        // Preserve authored agent system prompts whenever an agent is explicitly/effectively selected.
        // Only inject bridge guidance for fallback runs with no selected agent.
        const bridgeSystemPrompt = effectiveAgent
          ? undefined
          : [
              "You are handling a Slack/Telegram message via SuperClaw.",
              `Workspace agent file: ${messagingAgent.filePath}`,
              "Follow these workspace messaging instructions:",
              [messagingAgent.instructions, DEFAULT_MESSAGING_AGENT_INSTRUCTIONS]
                .map((value) => value.trim())
                .filter(Boolean)
                .join("\n\n"),
            ].join("\n");

        // By default, auto-routing overrides any model specified in the agent's .md file.
        // The pinned model can be used to override the model selected by auto-routing for a specific agent.
        const pinnedModel = effectiveAgent
          ? BRIDGE_AGENT_MODEL_PINS.get(effectiveAgent)
          : undefined;
        const resolvedModel = pinnedModel ?? effectiveModel;
        if (pinnedModel && effectiveAgent) {
          logger.info(
            { agent: effectiveAgent, pinnedModel: `${pinnedModel.providerID}/${pinnedModel.modelID}` },
            "[AgentModelPin] messaging channel model overridden by agent pin",
          );
        }

        const recreateSession = async (reason: string) => {
          const previousSessionID = currentSessionID;
          store.deleteSession(inbound.channel, inbound.identityId, peerKey);
          currentSessionID = await createSession({
            channel: inbound.channel,
            identityId: inbound.identityId,
            peerId: inbound.peerId,
            peerKey,
            directory: boundDirectory,
            announce: false,
            // This turn's resolved mode, NOT the global default: a custom-agent
            // mention (or any other per-turn override) must survive a recreate,
            // or the replacement session silently reverts to the router's
            // configured default permission mode.
            permissionMode: desiredPermissionMode,
          });
          runState.sessionID = currentSessionID;
          logger.warn(
            { previousSessionID, sessionID: currentSessionID, reason },
            "recreated session for prompt retry",
          );
          return currentSessionID;
        };

        const runPrompt = async (overrideText?: string): Promise<PromptPart[]> => {
          const response = await gatedPrompt({
            sessionID: currentSessionID,
            ...(bridgeSystemPrompt ? { system: bridgeSystemPrompt } : {}),
            parts: [{ type: "text", text: overrideText ?? promptText }],
            ...(resolvedModel ? { model: resolvedModel } : {}),
            ...(effectiveAgent ? { agent: effectiveAgent } : {}),
          });
          return response.parts ?? [];
        };
        const runPromptRecoveringMissingSession = async (
          overrideText?: string,
        ): Promise<PromptPart[]> => {
          try {
            return await runPrompt(overrideText);
          } catch (error) {
            if (!isMissingSessionPromptError(error)) throw error;
            await recreateSession("missing session");
            return await runPrompt(overrideText);
          }
        };

        let parts = await runPromptRecoveringMissingSession();
        logPromptResponse("initial", parts);
        let reply = extractReply(parts);

        // Recover from malformed / failed tool calls (e.g. llama-server
        // truncated the tool_call JSON at --n-predict, producing a
        // `tool: "invalid"` part with status:"completed" — this slips past
        // the no-text retry below because a tool part *is* present).
        // Send a follow-up nudging the model to retry with valid JSON and,
        // if the payload is large, split it across multiple tool calls.
        if (!reply) {
          const toolError = findFailedToolPart(parts);
          if (toolError) {
            logger.warn(
              { sessionID: currentSessionID, toolError: toolError.slice(0, 240) },
              "prompt produced a failed tool call; retrying with recovery hint",
            );
            const recoveryPrompt =
              `Your previous tool call failed: ${toolError}\n\n` +
              `Please retry. If the tool arguments are large (e.g. a long ` +
              `\`write\` payload), split the work across multiple smaller ` +
              `tool calls (write a stub first, then use \`edit\` / ` +
              `\`apply_patch\` to append the rest in chunks) so the JSON ` +
              `arguments stay well under the per-response token cap.`;
            parts = await runPromptRecoveringMissingSession(recoveryPrompt);
            logPromptResponse("retry", parts);
            reply = extractReply(parts);
          }
        }

        if (!reply && !parts.some((part) => part.type === "tool")) {
          logger.warn({ sessionID: currentSessionID }, "prompt returned no visible text; retrying once");
          parts = await runPromptRecoveringMissingSession();
          logPromptResponse("retry", parts);
          reply = extractReply(parts);
        }

        if (!reply && !parts.some((part) => part.type === "tool")) {
          await recreateSession("no visible prompt response");
          parts = await runPrompt();
          logPromptResponse("recovered", parts);
          reply = extractReply(parts);
        }

        if (reply) {
          logger.debug({ sessionID: currentSessionID, replyLength: reply.length }, "reply built");
          const sanitizedReply = stripModelPrefix(reply);
          const sessionModel = sessionModels.get(key);
          let model = formatModelLabel(sessionModel) ?? undefined;
          if (isAliasModel(sessionModel)) {
            // An alias is not a model name, so resolve what it dispatched to.
            // Out of band (LRM usage event) is the source of truth; the reply
            // prefix only still resolves when SUPERCLAW_LRM_MODEL_PREFIX opted
            // injection back in, and is off by default.
            //
            // `sessionModel.modelID` is the alias LRM recorded for this turn —
            // opencode reports it on the user message after resolving
            // `explicit model > agent.model > session default`. Passing it lets
            // the lookup ignore same-session dispatches made under a different
            // alias, notably the HDR sidecar's `local-model` `fill` calls, which
            // keep landing after the reply is posted.
            const lookup = await resolveUnderlyingModel(
              currentSessionID,
              sessionUsageCursor.get(key) ?? 0,
              sessionModel?.modelID ?? null,
            );
            sessionUsageCursor.set(key, lookup.cursorMs);
            const concrete = lookup.model ?? resolveModelPrefix(reply);
            if (concrete) model = concrete;
            logger.debug(
              {
                sessionID: currentSessionID,
                alias: formatModelLabel(sessionModel),
                resolved: concrete,
                provenance: lookup.model ? "usage-event" : concrete ? "reply-prefix" : "unresolved",
              },
              "alias model provenance",
            );
          }
          const statusEntry = activeStatusMessages.get(inbound.peerId);
          const replyAdapter = adapters.get(runState.adapterKey);
          if (statusEntry && !statusEntry.finalized && replyAdapter?.updateMessage) {
            statusEntry.finalized = true;
            try {
              await replyAdapter.updateMessage(inbound.peerId, statusEntry.ts, {
                text: sanitizedReply,
                blocks: buildFinalSlackBlocks(sanitizedReply, model),
              });
              activeStatusMessages.delete(inbound.peerId);
              lastStatusUpdateMs.delete(inbound.peerId);
            } catch (finalizeError) {
              logger.warn({ finalizeError }, "status message finalize failed; falling back to new message");
              await sendText(inbound.channel, inbound.identityId, inbound.peerId, sanitizedReply, {
                kind: "reply",
                model,
              });
            }
          } else {
            await sendText(inbound.channel, inbound.identityId, inbound.peerId, sanitizedReply, {
              kind: "reply",
              model,
            });
          }
        } else {
          logger.warn(
            {
              sessionID: currentSessionID,
              partTypes: parts.map((part) => part.type),
              ignoredCount: parts.filter((part) => part.ignored).length,
            },
            "prompt returned no visible text; clearing session",
          );
          store.deleteSession(inbound.channel, inbound.identityId, peerKey);
          await clearNativeStatus(runState);
          const recoveryText =
            "No visible response was generated. I reset this chat session in case stale state was blocking replies. Send your message again.";
          const statusEntry = activeStatusMessages.get(inbound.peerId);
          const replyAdapter = adapters.get(runState.adapterKey);
          if (statusEntry && !statusEntry.finalized && replyAdapter?.updateMessage) {
            statusEntry.finalized = true;
            try {
              await replyAdapter.updateMessage(inbound.peerId, statusEntry.ts, { text: recoveryText });
              activeStatusMessages.delete(inbound.peerId);
              lastStatusUpdateMs.delete(inbound.peerId);
            } catch (finalizeError) {
              logger.warn({ finalizeError }, "status recovery update failed; falling back to new message");
              await sendText(inbound.channel, inbound.identityId, inbound.peerId, recoveryText, { kind: "system" });
            }
          } else {
            await sendText(inbound.channel, inbound.identityId, inbound.peerId, recoveryText, { kind: "system" });
          }
        }
      } catch (error) {
        // Checked first so a policy/config/permission-resolution failure can
        // never be mistaken for a timeout or a missing-session prompt error:
        // both of those trigger retries that would resend a prompt whose MCP
        // tool gate could not be resolved.
        if (error instanceof McpToolGateError) {
          logger.error(
            { error: error.cause ?? error, sessionID: runState.sessionID },
            "MCP tool gate failed; prompt not sent",
          );
          await postMcpGateErrorMessage();
          return;
        }

        const {
          name: promptErrorName,
          message: promptErrorMessage,
          status: promptErrorStatus,
        } = getPromptErrorDetails(error);
        // Log full error details for debugging
        const errorDetails = {
          message: promptErrorMessage || (error instanceof Error ? error.message : String(error)),
          name: promptErrorName ?? (error instanceof Error ? error.name : undefined),
          stack: error instanceof Error ? error.stack?.split("\n").slice(0, 3).join("\n") : undefined,
          cause: error instanceof Error ? (error as any).cause : undefined,
          status: promptErrorStatus ?? (error as any)?.status ?? (error as any)?.statusCode ?? undefined,
        };
        logger.error({ error: errorDetails, sessionID: runState.sessionID }, "prompt failed");

        // Timeout recovery: when the upstream call times out (e.g. a long
        // tool turn exceeded the SDK's read deadline), the agent's partial
        // work is already in the session. Re-prompt the same session asking
        // it to continue from where it stopped, instead of dropping the
        // turn and surfacing an opaque "TimeoutError" to the user.
        const errMsgLower = (errorDetails.message || "").toLowerCase();
        const isTimeoutError =
          errorDetails.name === "TimeoutError" ||
          errorDetails.name === "AbortError" ||
          errorDetails.status === 408 ||
          errorDetails.status === 504 ||
          errMsgLower.includes("timed out") ||
          errMsgLower.includes("timeout");
        if (isTimeoutError && runState.sessionID) {
          try {
            logger.warn(
              { sessionID: runState.sessionID, errorName: errorDetails.name },
              "prompt timed out; asking agent to continue from previous step",
            );
            const continueText =
              "Your previous step timed out before completing. " +
              "Continue the task from where you stopped — do not restart from scratch, " +
              "do not re-run tools that already succeeded, and pick up at the next step.";
            const continueResponse = await gatedPrompt({
              sessionID: runState.sessionID,
              parts: [{ type: "text", text: continueText }],
            });
            const continueParts =
              ((continueResponse as { parts?: Array<{ type?: string; text?: string; ignored?: boolean }> }).parts) ?? [];
            const continueReply = continueParts
              .filter((part) => part.type === "text" && !part.ignored)
              .map((part) => part.text ?? "")
              .join("\n")
              .trim();
            if (continueReply) {
              await sendText(inbound.channel, inbound.identityId, inbound.peerId, continueReply, { kind: "reply" });
              return;
            }
            logger.warn(
              { sessionID: runState.sessionID },
              "continue-after-timeout produced no visible reply; falling through to error message",
            );
          } catch (continueError) {
            if (continueError instanceof McpToolGateError) {
              logger.error(
                { error: continueError.cause ?? continueError, sessionID: runState.sessionID },
                "MCP tool gate failed during timeout continuation; prompt not sent",
              );
              await postMcpGateErrorMessage();
              return;
            }
            logger.warn(
              { error: continueError, sessionID: runState.sessionID },
              "continue-after-timeout failed; falling through to error message",
            );
          }
        }

        // Extract meaningful error details
        let errorMessage = "Error: failed to reach OpenCode.";
        const msg = errorDetails.message || "";
        // Check for common error patterns
        if (msg.includes("401") || msg.includes("Unauthorized")) {
          errorMessage = "Error: OpenCode authentication failed (401). Check credentials.";
        } else if (msg.includes("403") || msg.includes("Forbidden")) {
          errorMessage = "Error: OpenCode access forbidden (403).";
        } else if (msg.includes("404") || msg.includes("Not Found")) {
          errorMessage = "Error: OpenCode endpoint not found (404).";
        } else if (msg.includes("429") || msg.includes("rate limit")) {
          errorMessage = "Error: Rate limited. Please wait and try again.";
        } else if (msg.includes("500") || msg.includes("Internal Server")) {
          errorMessage = "Error: OpenCode server error (500).";
        } else if (msg.includes("model") || msg.includes("provider")) {
          errorMessage = `Error: Model/provider issue - ${msg.slice(0, 100)}`;
        } else if (msg.includes("ECONNREFUSED") || msg.includes("connection")) {
          errorMessage = "Error: Cannot connect to OpenCode. Is it running?";
        } else if (msg.trim()) {
          // Include the actual error message (truncated)
          errorMessage = `Error: ${msg.slice(0, 150)}`;
        }
        
        await clearNativeStatus(runState);
        const errorStatusEntry = activeStatusMessages.get(inbound.peerId);
        const errorReplyAdapter = adapters.get(runState.adapterKey);
        if (errorStatusEntry && !errorStatusEntry.finalized && errorReplyAdapter?.updateMessage) {
          errorStatusEntry.finalized = true;
          try {
            await errorReplyAdapter.updateMessage(inbound.peerId, errorStatusEntry.ts, { text: errorMessage });
            activeStatusMessages.delete(inbound.peerId);
            lastStatusUpdateMs.delete(inbound.peerId);
          } catch (finalizeError) {
            logger.warn({ finalizeError }, "status error-finalize failed; posting new message");
            await sendText(inbound.channel, inbound.identityId, inbound.peerId, errorMessage, { kind: "system" });
          }
        } else {
          await sendText(inbound.channel, inbound.identityId, inbound.peerId, errorMessage, {
            kind: "system",
          });
        }
       } finally {
         runState.completed = true;
         stopTyping(key);
        reportDone(runState);
        activeRuns.delete(key);
        // Authoritatively clear the native status on every completion path. The SSE
        // event stream is async, so a late "busy"/tool event (common when the agent/
        // task sub-agent resumes the main session) can re-issue setStatus AFTER the
        // answer was posted, resurrecting the shimmer. Deleting the run above makes
        // late events no-ops; this guarantees the shimmer clears without relying on
        // Slack's post-reply auto-clear. Idempotent: no-op if already cleared.
        await clearNativeStatus(runState);
        activeStatusMessages.delete(inbound.peerId);
        lastStatusUpdateMs.delete(inbound.peerId);
      }
    });
  }


  const { createSession, switchSessionPermissionMode, ensureChannelDenies } = createSessionLifecycle({
    getClient,
    store,
    logger,
    routerManagedSessions,
    sessionsWithoutWildcardAllow,
    sessionPermissionModes,
    sendText,
    formatPeer,
    channelLabels: CHANNEL_LABELS,
    ...(reportStatus ? { reportStatus } : {}),
    defaultPermissionMode: config.permissionMode,
  });

  const migrateLegacySession = (
    migrationKey: string,
    previousSessionID: string,
    input: Parameters<typeof createSession>[0],
  ): Promise<string> => {
    const existing = legacySessionMigrations.get(migrationKey);
    if (existing) return existing;

    const migration = createSession(input).then(async (sessionID) => {
      logger.warn(
        { previousSessionID, sessionID, permissionMode: input.permissionMode },
        "replaced legacy session with a session using the configured permission mode",
      );
      try {
        await sendText(
          input.channel,
          input.identityId,
          input.peerId,
          "For security, this conversation is continuing in a new session with updated permissions. The previous history remains in your session list but is no longer used by this channel.",
          { kind: "system" },
        );
      } catch (error) {
        logger.warn({ error, previousSessionID, sessionID }, "could not send legacy session migration notice");
      }
      return sessionID;
    });
    legacySessionMigrations.set(migrationKey, migration);
    void migration.catch(() => {
      if (legacySessionMigrations.get(migrationKey) === migration) {
        legacySessionMigrations.delete(migrationKey);
      }
    });
    return migration;
  };

  const sessionHasWildcardAllow = (directory: string, sessionID: string): Promise<boolean> => {
    const inspectionKey = keyForSession(directory, sessionID);
    const existing = sessionWildcardAllowChecks.get(inspectionKey);
    if (existing) return existing;

    const inspection = (async () => {
      const session = await getClient(directory).session.get({ sessionID });
      const permission = (session as { permission?: unknown } | null | undefined)?.permission;
      if (permission === undefined) return false;
      if (!Array.isArray(permission)) throw new Error("OpenCode returned an invalid session permission ruleset");
      const wildcardRules = permission.filter(
        (rule): rule is { permission: string; pattern: string; action: string } =>
          Boolean(rule && typeof rule === "object") &&
          (rule as { permission?: unknown }).permission === "*" &&
          (rule as { pattern?: unknown }).pattern === "*" &&
          typeof (rule as { action?: unknown }).action === "string",
      );
      return wildcardRules.at(-1)?.action === "allow";
    })();
    sessionWildcardAllowChecks.set(inspectionKey, inspection);
    void inspection.catch(() => {
      if (sessionWildcardAllowChecks.get(inspectionKey) === inspection) {
        sessionWildcardAllowChecks.delete(inspectionKey);
      }
    });
    return inspection;
  };


  function enqueue(key: string, task: () => Promise<void>) {
    const previous = sessionQueue.get(key) ?? Promise.resolve();
    const next = previous
      .then(task)
      .catch((error) => {
        logger.error({ error }, "session task failed");
      })
      .finally(() => {
        if (sessionQueue.get(key) === next) {
          sessionQueue.delete(key);
        }
      });
    sessionQueue.set(key, next);
  }

  async function drainSessionQueue(key: string): Promise<void> {
    while (true) {
      const pending = sessionQueue.get(key);
      if (!pending) return;
      await pending;
    }
  }

  for (const adapter of Array.from(adapters.values())) {
    const startResult = await startAdapterBounded(adapter, {
      timeoutMs: 8_000,
      onError: (error) => {
        logger.error({ error, channel: adapter.name, identityId: adapter.identityId }, "adapter start failed");
        // The bounded wait may have expired long before this lands, by which
        // time an identity upsert can have installed a replacement in this
        // slot; only retract our own adapter (#2961 item 4).
        if (adapters.get(adapter.key) === adapter) adapters.delete(adapter.key);
      },
    });

    if (startResult.status === "timeout") {
      logger.warn({ channel: adapter.name, identityId: adapter.identityId, timeoutMs: 8_000 }, "adapter start timed out");
      reportStatus?.(`${CHANNEL_LABELS[adapter.name]}/${adapter.identityId} adapter starting...`);
      continue;
    }

    if (startResult.status === "error") {
      reportStatus?.(`${CHANNEL_LABELS[adapter.name]}/${adapter.identityId} adapter failed to start.`);
      continue;
    }

    reportStatus?.(`${CHANNEL_LABELS[adapter.name]}/${adapter.identityId} adapter started.`);
  }

  logger.info({ channels: Array.from(adapters.keys()) }, "bridge started");
  reportStatus?.(`Bridge running. Logs: ${config.logFile}`);

  return {
    async stop() {
      if (healthTimer) {
        clearInterval(healthTimer);
        healthTimer = null;
      }
      if (stopHealthServer) stopHealthServer();
      for (const abort of eventSubscriptions.values()) {
        abort.abort();
      }
      eventSubscriptions.clear();
      for (const timer of typingLoops.values()) {
        clearInterval(timer);
      }
      typingLoops.clear();
      for (const adapter of adapters.values()) {
        await adapter.stop();
      }
      store.close();
      await delay(50);
    },
    async dispatchInbound(message: {
      channel: ChannelName;
      identityId?: string;
      peerId: string;
      text?: string;
      parts?: InboundMessagePart[];
      raw?: unknown;
      fromMe?: boolean;
    }) {
      const identityId = (message.identityId ?? "default").trim() || "default";
      await handleInbound({
        channel: message.channel,
        identityId,
        peerId: message.peerId,
        text: message.text ?? "",
        ...(Array.isArray(message.parts) ? { parts: message.parts } : {}),
        raw: message.raw ?? null,
        fromMe: message.fromMe,
      });

      // For tests and programmatic callers: wait for the session queue to drain.
      const peerKey = message.peerId;
      const session = store.getSession(message.channel, identityId, peerKey);
      const sessionID = session?.session_id;
      const directory =
        session?.directory?.trim() || store.getBinding(message.channel, identityId, peerKey)?.directory?.trim() || defaultDirectory;
      const pending = sessionID && directory ? sessionQueue.get(keyForSession(directory, sessionID)) : null;
      if (pending) {
        await pending;
      }
    },
  };
}
