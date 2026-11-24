// Control-plane handlers for Slack app identities: list, upsert, delete.
//
// Unlike the Telegram handlers these do not write the config file: Slack
// credentials are persisted separately (see channel-secrets.ts), so these only
// update the runtime `config.slackApps` list and the running adapter.

import type { Logger } from "pino";

import type { Adapter, AdapterStartResult } from "./adapter.js";
import { stopAdapterBounded } from "./adapter.js";
import { createAdapterSlotQueue } from "./adapter-slot.js";
import type { Config, SlackIdentity } from "./config.js";
import type { MediaStore } from "./media-store.js";
import type { MessageHandler } from "./slack.js";

export type SlackTeamFields = {
  teamName?: string;
  teamId?: string;
  botUserId?: string;
};

export type SlackIdentityDeps = {
  config: Config;
  adapters: Map<string, Adapter>;
  adapterKey: (channel: "slack", identityId: string) => string;
  normalizeIdentityId: (value: string | undefined) => string;
  /** Rejects before anything is mutated, so a bad token cannot leave a half-applied identity. */
  verifySlackIdentity: (input: { botToken: string; appToken: string }) => Promise<SlackTeamFields>;
  createAdapter: (
    identity: SlackIdentity,
    config: Config,
    logger: Logger,
    onMessage: MessageHandler,
    // Always undefined here, so createSlackAdapter falls back to the real
    // WebClient/SocketModeClient; the slot exists only to reach mediaStore.
    slackDeps: undefined,
    mediaStore: MediaStore,
  ) => Omit<Adapter, "key">;
  startAdapterBounded: (
    adapter: Adapter,
    options: { timeoutMs: number; onError?: (error: unknown) => void },
  ) => Promise<AdapterStartResult>;
  handleInbound: MessageHandler;
  mediaStore: MediaStore;
  logger: Logger;
};

export type UpsertSlackIdentityInput = {
  id?: string;
  botToken: string;
  appToken: string;
  enabled?: boolean;
  directory?: string;
};

/** Slack's adapter start budget: long enough to connect, short enough that the UI is not left hanging. */
const START_TIMEOUT_MS = 2_500;
/** The matching stop budget: the slot queue waits on this, so it cannot be unbounded. */
const STOP_TIMEOUT_MS = 2_500;

export const createSlackIdentityHandlers = (deps: SlackIdentityDeps) => {
  const { config, adapters, adapterKey, normalizeIdentityId, logger } = deps;

  const slots = createAdapterSlotQueue();

  const stopAndForget = async (key: string, id: string, reason: string) => {
    const existing = adapters.get(key);
    if (!existing) return;
    const result = await stopAdapterBounded(existing, STOP_TIMEOUT_MS);
    if (result.status === "error") {
      logger.warn({ error: result.error, channel: "slack", identityId: id }, reason);
    } else if (result.status === "timeout") {
      // Dropped from the map regardless: holding the slot for a wedged
      // disconnect would block every later write for this identity.
      logger.warn({ channel: "slack", identityId: id, timeoutMs: STOP_TIMEOUT_MS }, "adapter stop timed out; abandoning it");
    }
    adapters.delete(key);
  };

  const listSlackIdentities = async () => ({
    items: config.slackApps.map((app) => ({
      id: app.id,
      enabled: app.enabled !== false,
      running: adapters.has(adapterKey("slack", app.id)),
    })),
  });

  const upsertSlackIdentity = async (input: UpsertSlackIdentityInput) =>
    slots.withSlot(adapterKey("slack", normalizeIdentityId(input.id)), () => applySlackUpsert(input));

  const applySlackUpsert = async (input: UpsertSlackIdentityInput) => {
    const botToken = input.botToken?.trim() ?? "";
    const appToken = input.appToken?.trim() ?? "";
    if (!botToken || !appToken) throw new Error("botToken and appToken are required");
    const id = normalizeIdentityId(input.id);
    if (id === "env") throw new Error("identity id 'env' is reserved");
    const enabled = input.enabled !== false;
    const directoryInput = typeof input.directory === "string" ? input.directory.trim() : "";

    // Switching a bot off must work even when Slack is unreachable or has revoked the token, so only an
    // identity that will run is checked.
    const slackTeamFields = enabled ? await deps.verifySlackIdentity({ botToken, appToken }) : {};

    const existingIdx = config.slackApps.findIndex((app) => app.id === id);
    // Resolved once and reused below for both the runtime list entry and the
    // adapter construction, so an omitted `directory` cannot be preserved in one
    // and dropped from the other (#2961 item 1).
    let resolvedDirectory: string | undefined;
    if (existingIdx >= 0) {
      const prev = config.slackApps[existingIdx] as { directory?: unknown } | undefined;
      resolvedDirectory =
        directoryInput || (typeof prev?.directory === "string" ? prev.directory.trim() : "") || undefined;
      config.slackApps[existingIdx] = {
        id,
        botToken,
        appToken,
        enabled,
        ...(resolvedDirectory ? { directory: resolvedDirectory } : {}),
      };
    } else {
      resolvedDirectory = directoryInput || undefined;
      config.slackApps.push({
        id,
        botToken,
        appToken,
        enabled,
        ...(resolvedDirectory ? { directory: resolvedDirectory } : {}),
      });
    }

    const key = adapterKey("slack", id);
    if (!enabled) {
      await stopAndForget(key, id, "failed to stop slack adapter");
      return { id, enabled: false, applied: true, ...slackTeamFields };
    }

    await stopAndForget(key, id, "failed to stop existing slack adapter");
    const base = deps.createAdapter(
      {
        id,
        botToken,
        appToken,
        enabled,
        ...(resolvedDirectory ? { directory: resolvedDirectory } : {}),
      },
      config,
      logger,
      deps.handleInbound,
      undefined,
      deps.mediaStore,
    );
    const adapter = { ...base, key };
    adapters.set(key, adapter);

    const startResult = await deps.startAdapterBounded(adapter, {
      timeoutMs: START_TIMEOUT_MS,
      onError: (error) => {
        logger.error({ error, channel: "slack", identityId: id }, "slack adapter start failed");
        // A start that failed after its bounded wait expired may land long
        // after a later upsert installed a replacement; only retract our own
        // adapter (#2961 item 4).
        if (adapters.get(key) === adapter) adapters.delete(key);
      },
    });

    if (startResult.status === "timeout") {
      return { id, enabled: true, applied: false, starting: true, ...slackTeamFields };
    }
    if (startResult.status === "error") {
      return { id, enabled: true, applied: false, error: String(startResult.error), ...slackTeamFields };
    }
    return { id, enabled: true, applied: true, ...slackTeamFields };
  };

  const deleteSlackIdentity = async (rawId: string) =>
    slots.withSlot(adapterKey("slack", normalizeIdentityId(rawId)), () => applySlackDelete(rawId));

  const applySlackDelete = async (rawId: string) => {
    const id = normalizeIdentityId(rawId);
    if (id === "env") throw new Error("env identity cannot be deleted");

    const deleted = config.slackApps.some((app) => app.id === id);
    config.slackApps.splice(0, config.slackApps.length, ...config.slackApps.filter((app) => app.id !== id));

    await stopAndForget(adapterKey("slack", id), id, "failed to stop slack adapter");
    return { id, deleted };
  };

  return { listSlackIdentities, upsertSlackIdentity, deleteSlackIdentity };
};
