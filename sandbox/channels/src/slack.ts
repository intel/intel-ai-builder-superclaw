import * as http from "node:http";
import * as https from "node:https";
import * as tls from "node:tls";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { URL } from "node:url";

import type { Logger } from "pino";

import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";

import type { Config, SlackIdentity } from "./config.js";
import { classifyDeliveryError, withDeliveryRetry } from "./delivery.js";
import { INBOUND_MEDIA_DOWNLOAD_TIMEOUT_MS, type InboundMessagePart, type MediaKind, type MessageDeliveryResult, type OutboundMessage } from "./media.js";
import type { MediaStore } from "./media-store.js";
import { markdownToBlocks } from "./slack-blocks.js";

/**
 * HTTPS-over-HTTP tunnel agent.
 *
 * When an HTTPS_PROXY / HTTP_PROXY env var is set, the Slack Socket Mode
 * WebSocket and Web API calls need to go through a CONNECT tunnel because
 * neither Bun's native WebSocket nor the `ws` library honour proxy env vars
 * automatically.
 *
 * This lightweight agent opens an HTTP CONNECT tunnel to the proxy, then
 * upgrades the raw TCP socket to TLS so that `wss://` and `https://`
 * traffic is transparently proxied.
 *
 * Limitations:
 * - Only supports HTTP proxy addresses (e.g. `http://proxy:port`).
 *   HTTPS-to-proxy (`https://proxy:port`) is **not** supported because the
 *   initial CONNECT request is sent over plain HTTP via `http.request()`;
 *   `resolveProxyAgent` connects directly instead of using such a proxy.
 * - NO_PROXY / no_proxy env vars are not evaluated; the proxy is always used
 *   when configured. This is acceptable for Slack (always external).
 */
class HttpsProxyAgent extends https.Agent {
  private proxy: URL;
  constructor(proxyUrl: string) {
    super({ keepAlive: true });
    this.proxy = new URL(proxyUrl);
  }
  override createConnection(options: any, callback: any): any {
    const targetHost = options.host ?? options.hostname;
    const targetPort = options.port ?? 443;

    // Proxy authentication (http://user:pass@proxy:port)
    const headers: Record<string, string> = {};
    if (this.proxy.username || this.proxy.password) {
      const credentials = `${decodeURIComponent(this.proxy.username)}:${decodeURIComponent(this.proxy.password)}`;
      headers["Proxy-Authorization"] = `Basic ${Buffer.from(credentials).toString("base64")}`;
    }

    // egress-surface: opencode_router_slack_proxy_connect
    const proxyReq = http.request({
      host: this.proxy.hostname,
      port: Number(this.proxy.port) || 80,
      method: "CONNECT",
      path: `${targetHost}:${targetPort}`,
      headers,
    });
    proxyReq.on("connect", (_res, socket) => {
      if (_res.statusCode !== 200) {
        socket.destroy();
        callback(new Error(`Proxy CONNECT failed with status ${_res.statusCode}`));
        return;
      }
      const tlsSocket = tls.connect({
        socket,
        servername: targetHost,
        // Honour NODE_TLS_REJECT_UNAUTHORIZED
        rejectUnauthorized: process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0",
      });
      callback(null, tlsSocket);
    });
    proxyReq.on("error", (err: Error) => callback(err));
    proxyReq.end();
  }
}

function configuredProxyUrl(): string | undefined {
  return (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy
  );
}

/**
 * Return an HTTPS proxy agent if an `http://` proxy env var is set, otherwise undefined.
 *
 * In the native router this is the egress proxy's channel port, `http://127.0.0.1:<port>`, and every
 * outside client of the router (Slack, Telegram) takes its agent from here.
 */
export function resolveProxyAgent(): https.Agent | undefined {
  const proxyUrl = configuredProxyUrl();
  if (!proxyUrl || !/^http:\/\//i.test(proxyUrl.trim())) return undefined;
  // egress-surface: opencode_router_egress_proxy
  return new HttpsProxyAgent(proxyUrl);
}

export type InboundMessage = {
  channel: "slack";
  identityId: string;
  peerId: string;
  text: string;
  parts?: InboundMessagePart[];
  raw: unknown;
};

export type MessageHandler = (message: InboundMessage) => Promise<void> | void;

export type SlackAdapter = {
  name: "slack";
  identityId: string;
  maxTextLength: number;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendMessage(peerId: string, message: OutboundMessage): Promise<MessageDeliveryResult>;
  sendText(peerId: string, text: string): Promise<void>;
  updateMessage(
    peerId: string,
    ts: string,
    message: { text?: string; blocks?: object[] },
  ): Promise<{ ts: string }>;
  setStatus(peerId: string, threadTs: string, status: string): Promise<{ ok: boolean; error?: string }>;
  clearStatus(peerId: string, threadTs: string): Promise<{ ok: boolean; error?: string }>;
};

export type SlackDeps = {
  WebClient: typeof WebClient;
  SocketModeClient: typeof SocketModeClient;
};

/**
 * Outcome of verifying a Slack credential pair against Slack's API.
 *
 * `reason` separates the two failure modes the caller must treat differently:
 *
 * * `"invalid"` — Slack answered and rejected the credential. The token is
 *   genuinely wrong, so saving it would persist something known-broken.
 * * `"unreachable"` — Slack could not be reached at all (offline sandbox,
 *   proxy failure, DNS). Verification is *unknown*, not negative.
 *
 * Both currently block the save, but they are kept apart so the user gets an
 * actionable message ("token rejected" vs "cannot reach Slack") instead of one
 * ambiguous error, and so a future offline-tolerant policy can distinguish them
 * without re-deriving the difference.
 */
export type SlackVerifyResult =
  | { ok: true; teamName?: string; teamId?: string; botUserId?: string }
  | { ok: false; reason: "invalid" | "unreachable"; scope: "bot" | "app"; error: string };

/** Cap credential verification so an unresponsive network cannot hang a save. */
const VERIFY_TIMEOUT_MS = 10_000;
const REQUIRED_BOT_SCOPES = ["chat:write", "app_mentions:read", "im:history"] as const;

/**
 * Distinguish "Slack said no" from "we never reached Slack".
 *
 * A `WebAPIPlatformError` (or any error carrying Slack's `data.error` payload)
 * proves Slack processed the request and rejected it. Anything else — DNS
 * failure, TLS error, proxy refusal, timeout — means the verdict is unknown.
 */
function classifySlackVerifyError(error: unknown): "invalid" | "unreachable" {
  const data = (error as { data?: { error?: unknown } } | null)?.data;
  if (data && typeof data.error === "string" && data.error.trim()) return "invalid";
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "slack_webapi_platform_error") return "invalid";
  return "unreachable";
}

function slackErrorMessage(error: unknown): string {
  const data = (error as { data?: { error?: unknown } } | null)?.data;
  if (data && typeof data.error === "string" && data.error.trim()) return data.error.trim();
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  return String(error);
}

/**
 * Verify a Slack credential pair BEFORE it is persisted.
 *
 * Both tokens must be checked, because they authorize different things and one
 * cannot stand in for the other:
 *
 * * `botToken` (`xoxb-`) via `auth.test` — proves the Web API calls used to
 *   *send* messages will work, and yields the workspace/bot identity we show
 *   back to the user as visible confirmation.
 * * `appToken` (`xapp-`) via `apps.connections.open` — proves Socket Mode can
 *   *receive* events. A valid bot token with a bad app token yields a channel
 *   that looks connected but never hears anything, which is precisely the
 *   failure this verification exists to prevent.
 *
 * Never throws: every failure is returned as a typed result so the caller can
 * decide the policy (here: refuse to save) and surface the reason verbatim.
 */
export async function verifySlackCredentials(
  botToken: string,
  appToken: string,
  deps: Pick<SlackDeps, "WebClient"> = { WebClient },
  options: { timeoutMs?: number } = {},
): Promise<SlackVerifyResult> {
  if (!botToken.startsWith("xoxb-") && !botToken.startsWith("xoxe.xoxb-")) {
    return { ok: false, reason: "invalid", scope: "bot", error: "not_allowed_token_type" };
  }
  if (!appToken.startsWith("xapp-")) {
    return { ok: false, reason: "invalid", scope: "app", error: "not_allowed_token_type" };
  }

  const timeout = options.timeoutMs ?? VERIFY_TIMEOUT_MS;
  const proxyAgent = resolveProxyAgent();
  const clientOptions = {
    ...(proxyAgent ? { agent: proxyAgent } : {}),
    timeout,
    retryConfig: { retries: 0 },
  };

  // 1. Bot token — also the source of the workspace identity we echo back.
  let teamName: string | undefined;
  let teamId: string | undefined;
  let botUserId: string | undefined;
  let botAppId: string | undefined;
  try {
    // egress-surface: opencode_router_slack_web_api
    const auth = await new deps.WebClient(botToken, clientOptions).auth.test();
    teamName = typeof auth.team === "string" ? auth.team : undefined;
    teamId = typeof auth.team_id === "string" ? auth.team_id : undefined;
    botUserId = typeof auth.user_id === "string" ? auth.user_id : undefined;
    botAppId = typeof auth.app_id === "string" ? auth.app_id : undefined;
    const botId = typeof auth.bot_id === "string" ? auth.bot_id : undefined;
    if (!teamId || !botUserId || !botId) {
      return { ok: false, reason: "invalid", scope: "bot", error: "invalid_bot_identity" };
    }
    const grantedScopes = auth.response_metadata?.scopes;
    if (grantedScopes) {
      const grantedScopeSet = new Set(grantedScopes);
      const missingScopes = REQUIRED_BOT_SCOPES.filter((scope) => !grantedScopeSet.has(scope));
      if (missingScopes.length > 0) {
        return {
          ok: false,
          reason: "invalid",
          scope: "bot",
          error: `missing_scope:${missingScopes.join(",")}`,
        };
      }
    }
  } catch (error) {
    return {
      ok: false,
      reason: classifySlackVerifyError(error),
      scope: "bot",
      error: slackErrorMessage(error),
    };
  }

  // 2. App-level token — Socket Mode's own credential. Slack documents the
  // WebSocket URL as the success contract; app_id is optional compatibility
  // metadata, so compare it only when both responses provide it.
  try {
    // egress-surface: opencode_router_slack_web_api
    const appClient = new deps.WebClient(appToken, clientOptions);
    const connection = await appClient.apiCall("apps.connections.open");
    const socketUrlValue: unknown = Reflect.get(connection, "url");
    const socketUrl = typeof socketUrlValue === "string" ? socketUrlValue : "";
    if (!socketUrl) {
      return { ok: false, reason: "invalid", scope: "app", error: "invalid_app_identity" };
    }
    let appAppId = "";
    try {
      appAppId = new URL(socketUrl).searchParams.get("app_id")?.trim() ?? "";
    } catch {
      return { ok: false, reason: "invalid", scope: "app", error: "invalid_app_identity" };
    }
    if (botAppId && appAppId && appAppId !== botAppId) {
      return { ok: false, reason: "invalid", scope: "app", error: "token_app_mismatch" };
    }
  } catch (error) {
    return {
      ok: false,
      reason: classifySlackVerifyError(error),
      scope: "app",
      error: slackErrorMessage(error),
    };
  }

  return {
    ok: true,
    ...(teamName ? { teamName } : {}),
    ...(teamId ? { teamId } : {}),
    ...(botUserId ? { botUserId } : {}),
  };
}

export type SlackPeer = {
  channelId: string;
  threadTs?: string;
};

// `peerId` encoding:
// - DMs:   D12345678
// - Threads in channels: C12345678|1700000000.000100
// Using `|` avoids clashing with ALLOW_FROM's channel:peer parsing.
export function formatSlackPeerId(peer: SlackPeer): string {
  if (!peer.threadTs) return peer.channelId;
  return `${peer.channelId}|${peer.threadTs}`;
}

export function parseSlackPeerId(peerId: string): SlackPeer {
  const trimmed = peerId.trim();
  if (!trimmed) return { channelId: "" };
  const [channelId, threadTs] = trimmed.split("|");
  if (channelId && threadTs) return { channelId, threadTs };
  return { channelId: channelId || trimmed };
}

export function stripSlackMention(text: string, botUserId: string | null): string {
  const raw = text ?? "";
  if (!botUserId) return raw.trim();
  const token = `<@${botUserId}>`;
  // Removing the token is always right: its literal form should never reach the
  // model. Stripping the punctuation after it is not — that only cleans up what
  // a *leading* mention left behind (`@bot: hi`, `@bot, hi`, `@bot - hi`).
  // The DM path calls this on every message (#2956 item 1), so applying it to
  // text that did not start with a mention turned `- /reset` into the /reset
  // command, dropping the session, and `-42` into `42`.
  const stripped = raw.split(token).join(" ");
  if (!raw.trimStart().startsWith(token)) return stripped.trim();
  // A dash glued to the next token (`@bot -42`) is the user's text. Only a dash
  // that stands alone, the way a leading mention's separator does, is leftover.
  return stripped.replace(/^\s*(?:[:,]+|-+(?=\s))\s*/, "").trim();
}

const MAX_TEXT_LENGTH = 39_000;

type SlackEvent = {
  type?: unknown;
  channel?: unknown;
  text?: unknown;
  user?: unknown;
  bot_id?: unknown;
  subtype?: unknown;
  thread_ts?: unknown;
  ts?: unknown;
  files?: unknown;
};

type SlackFileCandidate = {
  id: string;
  url: string;
  filename?: string;
  mimeType?: string;
  sizeBytes?: number;
  kind: MediaKind;
};

/**
 * Build a PartDeliveryResult for a successfully posted Slack text message.
 * When the Slack API does not return a `ts` value (unexpected shape), logs a
 * warning and omits `providerMessageId` — the message was still delivered.
 */
function buildSlackTextPartResult(
  index: number,
  type: "text" | MediaKind,
  posted: { ts?: unknown; channel?: unknown },
  log: Logger,
): { index: number; type: "text" | MediaKind; sent: true; providerMessageId?: string; providerChannelId?: string } {
  if (typeof posted.ts !== "string") {
    log.warn({ posted }, "slack postMessage succeeded but returned no ts; thread tracking unavailable");
  }
  return {
    index,
    type,
    sent: true,
    ...(typeof posted.ts === "string" ? { providerMessageId: posted.ts } : {}),
    ...(typeof posted.channel === "string" ? { providerChannelId: posted.channel } : {}),
  };
}

export function createSlackAdapter(
  identity: SlackIdentity,
  config: Config,
  logger: Logger,
  onMessage: MessageHandler,
  deps: SlackDeps = { WebClient, SocketModeClient },
  mediaStore?: MediaStore,
): SlackAdapter {
  const botToken = identity.botToken?.trim() ?? "";
  const appToken = identity.appToken?.trim() ?? "";
  if (!botToken) {
    throw new Error("Slack bot token is required for Slack adapter");
  }
  if (!appToken) {
    throw new Error("Slack app token is required for Slack adapter");
  }

  const log = logger.child({ channel: "slack", identityId: identity.id });
  const proxyAgent = resolveProxyAgent();
  if (proxyAgent) {
    log.info("using HTTPS proxy agent for Slack connections");
  } else if (configuredProxyUrl()) {
    log.warn("the configured proxy is not an http:// proxy, which the Slack proxy agent cannot use; connecting to Slack directly");
  }
  // egress-surface: opencode_router_slack_web_api
  const web = new deps.WebClient(botToken, proxyAgent ? { agent: proxyAgent } : {});
  // egress-surface: opencode_router_slack_socket_mode
  const socket = new deps.SocketModeClient({
    appToken,
    ...(proxyAgent ? { clientOptions: { agent: proxyAgent } } : {}),
  });

  let botUserId: string | null = null;
  let started = false;
  let starting = false;
  // stop() can arrive while start() is still inside socket.start(), which is
  // apps.connections.open plus the websocket handshake and can outlast the
  // 2.5s budget. `started` is false for that whole stretch, so stop() would
  // otherwise return without disconnecting and the late success would leave a
  // live socket the bridge no longer holds.
  let stopRequested = false;

  const parseSlackFiles = (value: unknown): SlackFileCandidate[] => {
    if (!Array.isArray(value)) return [];
    const files: SlackFileCandidate[] = [];
    for (const item of value) {
      if (!item || typeof item !== "object") continue;
      const record = item as {
        id?: unknown;
        url_private_download?: unknown;
        url_private?: unknown;
        name?: unknown;
        mimetype?: unknown;
        size?: unknown;
      };
      const id = typeof record.id === "string" ? record.id : "";
      const url =
        typeof record.url_private_download === "string"
          ? record.url_private_download
          : typeof record.url_private === "string"
            ? record.url_private
            : "";
      if (!id || !url) continue;
      const mimeType = typeof record.mimetype === "string" ? record.mimetype : undefined;
      const kind: MediaKind =
        typeof mimeType === "string" && mimeType.startsWith("image/")
          ? "image"
          : typeof mimeType === "string" && mimeType.startsWith("audio/")
            ? "audio"
            : "file";
      files.push({
        id,
        url,
        kind,
        ...(typeof record.name === "string" ? { filename: record.name } : {}),
        ...(mimeType ? { mimeType } : {}),
        ...(typeof record.size === "number" ? { sizeBytes: record.size } : {}),
      });
    }
    return files;
  };

  const downloadSlackFile = async (peerId: string, candidate: SlackFileCandidate): Promise<InboundMessagePart> => {
    if (!mediaStore) {
      return {
        type: "media",
        media: {
          id: candidate.id,
          kind: candidate.kind,
          source: "slack",
          status: "failed",
          ...(candidate.filename ? { filename: candidate.filename } : {}),
          ...(candidate.mimeType ? { mimeType: candidate.mimeType } : {}),
          ...(typeof candidate.sizeBytes === "number" ? { sizeBytes: candidate.sizeBytes } : {}),
          providerFileId: candidate.id,
          providerUrl: candidate.url,
          error: "media store unavailable",
        },
      };
    }

    try {
      const stored = await withDeliveryRetry(
        "slack.download",
        (signal) =>
          mediaStore.downloadInbound({
            channel: "slack",
            identityId: identity.id,
            peerId,
            kind: candidate.kind,
            url: candidate.url,
            signal,
            headers: {
              Authorization: `Bearer ${botToken}`,
            },
            ...(candidate.filename ? { filename: candidate.filename } : {}),
            ...(candidate.mimeType ? { mimeType: candidate.mimeType } : {}),
          }),
        { logger: log, totalTimeoutMs: INBOUND_MEDIA_DOWNLOAD_TIMEOUT_MS },
      );

      return {
        type: "media",
        media: {
          id: candidate.id,
          kind: candidate.kind,
          source: "slack",
          status: "ready",
          filePath: stored.filePath,
          filename: stored.filename,
          ...(stored.mimeType ? { mimeType: stored.mimeType } : {}),
          sizeBytes: stored.sizeBytes,
          providerFileId: candidate.id,
          providerUrl: candidate.url,
        },
      };
    } catch (error) {
      const classified = classifyDeliveryError(error);
      return {
        type: "media",
        media: {
          id: candidate.id,
          kind: candidate.kind,
          source: "slack",
          status: "failed",
          ...(candidate.filename ? { filename: candidate.filename } : {}),
          ...(candidate.mimeType ? { mimeType: candidate.mimeType } : {}),
          ...(typeof candidate.sizeBytes === "number" ? { sizeBytes: candidate.sizeBytes } : {}),
          providerFileId: candidate.id,
          providerUrl: candidate.url,
          error: `${classified.code}: ${classified.message}`,
        },
      };
    }
  };

  const safeAck = async (ack: unknown) => {
    if (typeof ack !== "function") return;
    try {
      await ack();
    } catch (error) {
      log.warn({ error }, "slack ack failed");
    }
  };

  const shouldIgnore = (
    event: SlackEvent,
  ):
    | { ok: true }
    | {
        ok: false;
        channelId: string;
        textRaw: string;
        userId: string | null;
        files: SlackFileCandidate[];
        threadTs: string | null;
        ts: string | null;
      } => {
    const channelId = typeof event.channel === "string" ? event.channel : "";
    const textRaw = typeof event.text === "string" ? event.text : "";
    const userId = typeof event.user === "string" ? event.user : null;
    const botId = typeof event.bot_id === "string" ? event.bot_id : null;
    const subtype = typeof event.subtype === "string" ? event.subtype : null;
    const files = parseSlackFiles(event.files);
    const hasFiles = files.length > 0;
    const threadTs = typeof event.thread_ts === "string" ? event.thread_ts : null;
    const ts = typeof event.ts === "string" ? event.ts : null;

    // Avoid loops / non-user messages.
    if (botId) return { ok: true };
    if (subtype && subtype !== "" && subtype !== "file_share") return { ok: true };
    if (userId && botUserId && userId === botUserId) return { ok: true };
    if (!channelId || (!textRaw.trim() && !hasFiles)) return { ok: true };

    return { ok: false, channelId, textRaw, userId, files, threadTs, ts };
  };

  // Runs once a message is addressed to the bot, before any file download or session work, so
  // an unapproved sender costs nothing. They are told once where the owner can approve them.
  const admitSender = (userId: string | null, channelId: string, rootThread: string | null): boolean => {
    if (config.slackSenders?.isAllowed(userId)) return true;
    log.warn({ channelId, userId }, "slack message held (sender not approved)");
    if (userId && config.slackSenders?.recordBlocked(identity.id, userId)) {
      const peerId = formatSlackPeerId({ channelId, ...(rootThread ? { threadTs: rootThread } : {}) });
      void sendNotApprovedNotice(peerId, userId);
    }
    return false;
  };

  // Delivery failures come back as `sentParts: 0`, not as a rejection, so both are checked.
  const sendNotApprovedNotice = async (peerId: string, userId: string) => {
    const text = `You're not approved to use this SuperClaw bot yet. Ask its owner to approve \`${userId}\` in SuperClaw → Settings → Connections → Slack.`;
    try {
      const result = await sendMessageInternal(peerId, { parts: [{ type: "text", text }] });
      if (result.sentParts > 0) return;
      log.warn({ userId, error: result.partResults[0]?.error }, "slack not-approved notice not delivered; retrying on their next message");
    } catch (error) {
      log.warn({ error, userId }, "slack not-approved notice not delivered; retrying on their next message");
    }
    config.slackSenders?.noticeFailed(userId);
  };

  socket.on("message", async (args: unknown) => {
    // stop() clears `started` before disconnect returns, and a start that lost
    // the race never sets it. Returning before ack lets the replacement
    // connection take the event instead of this socket consuming it.
    if (!started) return;
    const ack = (args as { ack?: unknown })?.ack;
    await safeAck(ack);

    const event = (args as { event?: unknown })?.event as SlackEvent | undefined;
    if (!event || typeof event !== "object") return;
    const filtered = shouldIgnore(event);
    if (filtered.ok) return;

    // Only respond to direct messages by default.
    const isDm = filtered.channelId.startsWith("D");
    if (!isDm) return;

    const rootThread = filtered.threadTs || filtered.ts;
    if (!admitSender(filtered.userId, filtered.channelId, rootThread)) return;
    const peerId = formatSlackPeerId({ channelId: filtered.channelId, ...(rootThread ? { threadTs: rootThread } : {}) });
    // Strip a leading `@bot` mention so `@bot /help` in a DM dispatches as a slash command,
    // matching the app_mention path below (#2956 item 1).
    const dmText = stripSlackMention(filtered.textRaw, botUserId);
    const parts: InboundMessagePart[] = [];
    if (dmText) {
      parts.push({ type: "text", text: dmText });
    }
    for (const file of filtered.files) {
      parts.push(await downloadSlackFile(peerId, file));
    }
    if (parts.length === 0) return;
    const text = parts
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();

    try {
      await onMessage({
        channel: "slack",
        identityId: identity.id,
        peerId,
        text,
        parts,
        raw: event,
      });
    } catch (error) {
      log.error({ error, peerId }, "slack inbound handler failed");
    }
  });

  socket.on("app_mention", async (args: unknown) => {
    if (!started) return;
    const ack = (args as { ack?: unknown })?.ack;
    await safeAck(ack);

    const event = (args as { event?: unknown })?.event as SlackEvent | undefined;
    if (!event || typeof event !== "object") return;
    const filtered = shouldIgnore(event);
    if (filtered.ok) return;

    const rootThread = filtered.threadTs || filtered.ts;
    if (!admitSender(filtered.userId, filtered.channelId, rootThread)) return;
    const peerId = formatSlackPeerId({ channelId: filtered.channelId, ...(rootThread ? { threadTs: rootThread } : {}) });
    const text = stripSlackMention(filtered.textRaw, botUserId);
    const parts: InboundMessagePart[] = [];
    if (text) {
      parts.push({ type: "text", text });
    }
    for (const file of filtered.files) {
      parts.push(await downloadSlackFile(peerId, file));
    }
    if (parts.length === 0) return;
    const promptText = parts
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();

    try {
      await onMessage({
        channel: "slack",
        identityId: identity.id,
        peerId,
        text: promptText,
        parts,
        raw: event,
      });
    } catch (error) {
      log.error({ error, peerId }, "slack inbound handler failed");
    }
  });

  const sendMessageInternal = async (
    peerId: string,
    message: OutboundMessage,
  ): Promise<MessageDeliveryResult> => {
    const peer = parseSlackPeerId(peerId);
    if (!peer.channelId) {
      const error = new Error("Invalid Slack peerId") as Error & { status?: number };
      error.status = 400;
      throw error;
    }

    const partResults: MessageDeliveryResult["partResults"] = [];
    let sentParts = 0;

    for (let index = 0; index < message.parts.length; index += 1) {
      const part = message.parts[index];
      try {
        if (part.type === "text") {
          let blocks: object[] | null = null;
          try {
            blocks = markdownToBlocks(part.text);
          } catch {
            // silent — fall back to text-only
          }

          // Built into `blocks` so the retry-without-blocks fallback drops it too.
          if (blocks && blocks.length > 0 && message.meta?.model) {
            const model = message.meta.model.trim();
            if (model) {
              blocks = [...blocks, { type: "context", elements: [{ type: "mrkdwn", text: `Model: *${model}*` }] }];
            }
          }

          try {
            const posted = await withDeliveryRetry(
              "slack.postMessage",
              () =>
                web.chat.postMessage({
                  channel: peer.channelId,
                  text: part.text,
                  ...(blocks ? { blocks } : {}),
                  ...(peer.threadTs ? { thread_ts: peer.threadTs } : {}),
                } as any),
              { logger: log },
            );
            partResults.push(buildSlackTextPartResult(index, part.type, posted, log));
            sentParts += 1;
            continue;
          } catch (error) {
            // If blocks caused the failure, retry without blocks
            if (blocks) {
              log.warn({ error }, "slack postMessage with blocks failed, retrying without blocks");
              const posted = await withDeliveryRetry(
                "slack.postMessage",
                () =>
                  web.chat.postMessage({
                    channel: peer.channelId,
                    text: part.text,
                    ...(peer.threadTs ? { thread_ts: peer.threadTs } : {}),
                } as any),
                { logger: log },
              );
              partResults.push(buildSlackTextPartResult(index, part.type, posted, log));
              sentParts += 1;
              continue;
            } else {
              throw error;
            }
          }
        } else {
          const fileData = part.data ?? await readFile(part.filePath);
          const filename = part.filename || basename(part.filePath);
          await withDeliveryRetry(
            "slack.uploadFile",
            () =>
              (web as any).files.uploadV2({
                channel_id: peer.channelId,
                file: fileData,
                filename,
                ...(peer.threadTs ? { thread_ts: peer.threadTs } : {}),
                ...(part.caption?.trim() ? { initial_comment: part.caption.trim() } : {}),
              }),
            { logger: log },
          );
        }

        sentParts += 1;
        partResults.push({ index, type: part.type, sent: true });
      } catch (error) {
        const classified = classifyDeliveryError(error);
        partResults.push({
          index,
          type: part.type,
          sent: false,
          error: classified.message,
          code: classified.code,
          retryable: classified.retryable,
        });
      }
    }

    return {
      attemptedParts: message.parts.length,
      sentParts,
      partResults,
    };
  };

  // Never throws: returns { ok:false } on error so callers fall back to chat.update.
  const setStatus = async (
    peerId: string,
    threadTs: string,
    status: string,
  ): Promise<{ ok: boolean; error?: string }> => {
    const peer = parseSlackPeerId(peerId);
    if (!peer.channelId) return { ok: false, error: "invalid_peer" };
    // Collapse newlines and cap length so no caller can trip Slack's arg validation
    // (assistant.threads.setStatus expects a short single-line phrase). Empty stays
    // empty so clearStatus semantics are preserved.
    const safeStatus = status.replace(/\s*\n+\s*/g, " ").trim().slice(0, 250);
    try {
      const result = await withDeliveryRetry(
        "slack.setStatus",
        () =>
          web.assistant.threads.setStatus({
            channel_id: peer.channelId,
            thread_ts: threadTs,
            status: safeStatus,
            ...(safeStatus ? { loading_messages: [safeStatus] } : {}),
          }),
        { logger: log },
      );
      if (result.ok === false) {
        const err = result.error;
        return { ok: false, error: typeof err === "string" ? err : "unknown" };
      }
      return { ok: true };
    } catch (error) {
      const classified = classifyDeliveryError(error);
      return { ok: false, error: classified.code ?? classified.message };
    }
  };

  const clearStatus = (peerId: string, threadTs: string) => setStatus(peerId, threadTs, "");

  return {
    name: "slack",
    identityId: identity.id,
    maxTextLength: MAX_TEXT_LENGTH,
    setStatus,
    clearStatus,
    async start() {
      if (started || starting) return;
      starting = true;
      stopRequested = false;
      try {
        log.debug("slack adapter starting");
        const auth = await web.auth.test();
        if (stopRequested) return;
        botUserId = typeof (auth as any)?.user_id === "string" ? (auth as any).user_id : null;
        await socket.start();
        if (stopRequested) {
          try {
            await socket.disconnect();
          } catch (error) {
            log.warn({ error }, "slack adapter stop failed");
          }
          return;
        }
        started = true;
        log.info({ botUserId }, "slack adapter started");
      } finally {
        starting = false;
      }
    },
    async stop() {
      stopRequested = true;
      if (!started) return;
      started = false;
      try {
        // socket-mode client uses a websocket; disconnect when stopping.
        await socket.disconnect();
      } catch (error) {
        log.warn({ error }, "slack adapter stop failed");
      }
      log.info("slack adapter stopped");
    },
    async sendMessage(peerId: string, message: OutboundMessage) {
      return sendMessageInternal(peerId, message);
    },
    async sendText(peerId: string, text: string) {
      const result = await sendMessageInternal(peerId, {
        parts: [{ type: "text", text }],
      });
      if (result.sentParts === 0) {
        const firstError = result.partResults.find((part) => !part.sent)?.error;
        throw new Error(firstError || "Failed to deliver Slack text message");
      }
    },
    async updateMessage(peerId: string, ts: string, message: { text?: string; blocks?: object[] }) {
      const peer = parseSlackPeerId(peerId);
      if (!peer.channelId) {
        throw new Error("Invalid Slack peerId for updateMessage");
      }
      const result = await withDeliveryRetry(
        "slack.updateMessage",
        () =>
          web.chat.update({
            channel: peer.channelId,
            ts,
            ...(message.text !== undefined ? { text: message.text } : {}),
            ...(message.blocks ? { blocks: message.blocks } : {}),
          } as any),
        { logger: log },
      );
      const resultTs = typeof (result as any)?.ts === "string" ? (result as any).ts : ts;
      return { ts: resultTs };
    },
  };
}
