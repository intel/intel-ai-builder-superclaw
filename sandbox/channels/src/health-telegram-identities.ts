// Control-plane handlers for Telegram bot identities: list, upsert, delete.
//
// Each write has to keep three things in step - the config file on disk, the
// live `config.telegramBots` runtime list, and the running adapter - and an
// upsert that updated only some of them would leave the bridge serving a bot it
// no longer has credentials for. Extracted from the health-server wiring in
// startBridge so that ordering can be tested without a Telegram token.

import type { Logger } from "pino";

import type { Adapter, AdapterStartResult } from "./adapter.js";
import { stopAdapterBounded } from "./adapter.js";
import { createAdapterSlotQueue } from "./adapter-slot.js";
import type { Config, OpenCodeRouterConfigFile, TelegramIdentity } from "./config.js";
import { readConfigFile, writeConfigFile } from "./config.js";

import type { MediaStore } from "./media-store.js";
import type { InboundMessage } from "./telegram.js";

export type TelegramIdentityDeps = {
  config: Config;
  adapters: Map<string, Adapter>;
  adapterKey: (channel: "telegram", identityId: string) => string;
  normalizeIdentityId: (value: string | undefined) => string;
  normalizeTelegramAccess: (value: unknown) => "public" | "private";
  normalizePairingCodeHash: (value: unknown) => string;
  startAdapterBounded: (
    adapter: Adapter,
    options: { timeoutMs: number; onError?: (error: unknown) => void },
  ) => Promise<AdapterStartResult>;
  /** Injected alongside startAdapterBounded so the start/stop sequence is testable without a real bot. */
  createAdapter: (
    identity: TelegramIdentity,
    config: Config,
    logger: Logger,
    handleInbound: (inbound: InboundMessage) => Promise<void>,
    mediaStore: MediaStore,
  ) => Omit<Adapter, "key">;
  handleInbound: (inbound: InboundMessage) => Promise<void>;
  mediaStore: MediaStore;
  logger: Logger;
};

export type UpsertTelegramIdentityInput = {
  id?: string;
  token: string;
  enabled?: boolean;
  directory?: string;
  access?: "public" | "private";
  pairingCodeHash?: string;
};

/** Telegram's adapter start budget: long enough to connect, short enough that the UI is not left hanging. */
const START_TIMEOUT_MS = 2_500;
/** The matching stop budget: the slot queue waits on this, so it cannot be unbounded. */
const STOP_TIMEOUT_MS = 2_500;

export const createTelegramIdentityHandlers = (deps: TelegramIdentityDeps) => {
  const {
    config,
    adapters,
    adapterKey,
    normalizeIdentityId,
    normalizeTelegramAccess,
    normalizePairingCodeHash,
    logger,
  } = deps;

  const slots = createAdapterSlotQueue();

  const stopAndForget = async (key: string, id: string, reason: string) => {
    const existing = adapters.get(key);
    if (!existing) return;
    const result = await stopAdapterBounded(existing, STOP_TIMEOUT_MS);
    if (result.status === "error") {
      logger.warn({ error: result.error, channel: "telegram", identityId: id }, reason);
    } else if (result.status === "timeout") {
      // Dropped from the map regardless: holding the slot for a wedged stop
      // would block every later write for this identity.
      logger.warn(
        { channel: "telegram", identityId: id, timeoutMs: STOP_TIMEOUT_MS },
        "adapter stop timed out; abandoning it",
      );
    }
    adapters.delete(key);
  };

  // The bot an adapter started as is what the app shows beside a saved token; the app cannot ask Telegram
  // itself, and the host that saves the token does not hold the adapter.
  const listTelegramIdentities = async () => ({
    items: config.telegramBots.map((bot) => {
      const info = adapters.get(adapterKey("telegram", bot.id))?.botInfo?.() ?? null;
      return {
        id: bot.id,
        enabled: bot.enabled !== false,
        running: adapters.has(adapterKey("telegram", bot.id)),
        access: normalizeTelegramAccess((bot as { access?: unknown }).access),
        pairingRequired: normalizeTelegramAccess((bot as { access?: unknown }).access) === "private",
        ...(info ? { bot: info } : {}),
      };
    }),
  });

  const upsertTelegramIdentity = async (input: UpsertTelegramIdentityInput) =>
    slots.withSlot(adapterKey("telegram", normalizeIdentityId(input.id)), () => applyTelegramUpsert(input));

  const applyTelegramUpsert = async (input: UpsertTelegramIdentityInput) => {
    const token = input.token?.trim() ?? "";
    if (!token) throw new Error("token is required");
    const id = normalizeIdentityId(input.id);
    if (id === "env") throw new Error("identity id 'env' is reserved");
    const enabled = input.enabled !== false;
    const directoryInput = typeof input.directory === "string" ? input.directory.trim() : "";
    const requestedAccess =
      typeof input.access === "string" && input.access.trim() ? normalizeTelegramAccess(input.access) : undefined;
    const requestedPairingCodeHash = normalizePairingCodeHash(input.pairingCodeHash);

    // One identity for the file, the runtime list and the adapter. The file and
    // the runtime list are allowed to disagree at rest (#2961 item 2); an upsert
    // that omitted a field used to keep the file's value on disk and the runtime
    // list's value in the live adapter, so the workspace changed at the next
    // restart. The runtime entry wins when this bot is already loaded, because
    // that is what is serving traffic. Otherwise the file is the only record.
    // Validation runs before either is written, so a rejection leaves both as
    // they were.
    const { config: current } = readConfigFile(config.configPath);
    const telegram = current.channels?.telegram as { bots?: unknown } | undefined;
    const bots = Array.isArray(telegram?.bots) ? ((telegram.bots as unknown[]) ?? []) : [];
    let fileRecord: { directory?: unknown; access?: unknown; pairingCodeHash?: unknown } | undefined;
    for (const entry of bots) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      const entryId = normalizeIdentityId(typeof record.id === "string" ? record.id : "default");
      if (entryId === id) {
        fileRecord = record;
        break;
      }
    }
    const existingIdx = config.telegramBots.findIndex((bot) => bot.id === id);
    const prev =
      existingIdx >= 0
        ? (config.telegramBots[existingIdx] as {
            directory?: unknown;
            access?: unknown;
            pairingCodeHash?: unknown;
          })
        : undefined;
    const carried = prev ?? fileRecord;
    const carriedDirectory = typeof carried?.directory === "string" ? carried.directory.trim() : "";
    const directory = directoryInput || carriedDirectory || undefined;
    const access = requestedAccess ?? (carried ? normalizeTelegramAccess(carried.access) : "public");
    const pairingCodeHash =
      access === "private"
        ? requestedPairingCodeHash || (carried ? normalizePairingCodeHash(carried.pairingCodeHash) : "")
        : "";
    if (access === "private" && !pairingCodeHash) {
      throw new Error("pairingCodeHash is required when Telegram access is private");
    }
    const identity: TelegramIdentity = {
      id,
      token,
      enabled,
      ...(directory ? { directory } : {}),
      access,
      ...(access === "private" ? { pairingCodeHash } : {}),
    };

    // Entries we are not touching round-trip straight back out of the config file,
    // so they are already identities even though the file is read as unknown.
    const nextBots: TelegramIdentity[] = [];
    let found = false;
    for (const entry of bots) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      const entryId = normalizeIdentityId(typeof record.id === "string" ? record.id : "default");
      if (entryId !== id) {
        nextBots.push(record as unknown as TelegramIdentity);
        continue;
      }
      found = true;
      nextBots.push(identity);
    }
    if (!found) nextBots.push(identity);

    const next: OpenCodeRouterConfigFile = {
      ...current,
      channels: {
        ...current.channels,
        telegram: {
          ...(current.channels?.telegram ?? {}),
          enabled: true,
          bots: nextBots,
        },
      },
    };
    if (id === "default") {
      delete next.channels?.slack?.botToken;
      delete next.channels?.slack?.appToken;
    }
    next.version = next.version ?? 1;

    writeConfigFile(config.configPath, next);
    config.configFile = next;

    if (existingIdx >= 0) {
      config.telegramBots[existingIdx] = identity;
    } else {
      config.telegramBots.push(identity);
    }

    // Start/stop adapter.
    const key = adapterKey("telegram", id);
    if (!enabled) {
      await stopAndForget(key, id, "failed to stop telegram adapter");
      return {
        id,
        enabled: false,
        access,
        pairingRequired: access === "private",
        applied: true,
      };
    }

    await stopAndForget(key, id, "failed to stop existing telegram adapter");
    const base = deps.createAdapter(
      identity,
      config,
      logger,
      deps.handleInbound,
      deps.mediaStore,
    );
    const adapter = { ...base, key };
    adapters.set(key, adapter);

    const startResult = await deps.startAdapterBounded(adapter, {
      timeoutMs: START_TIMEOUT_MS,
      onError: (error) => {
        logger.error({ error, channel: "telegram", identityId: id }, "telegram adapter start failed");
        // A start that failed after its bounded wait expired may land long
        // after a later upsert installed a replacement; only retract our own
        // adapter (#2961 item 4).
        if (adapters.get(key) === adapter) adapters.delete(key);
      },
    });

    if (startResult.status === "timeout") {
      return {
        id,
        enabled: true,
        access,
        pairingRequired: access === "private",
        applied: false,
        starting: true,
      };
    }
    if (startResult.status === "error") {
      return {
        id,
        enabled: true,
        access,
        pairingRequired: access === "private",
        applied: false,
        error: String(startResult.error),
      };
    }
    return {
      id,
      enabled: true,
      access,
      pairingRequired: access === "private",
      applied: true,
    };
  };

  const deleteTelegramIdentity = async (rawId: string) =>
    slots.withSlot(adapterKey("telegram", normalizeIdentityId(rawId)), () => applyTelegramDelete(rawId));

  const applyTelegramDelete = async (rawId: string) => {
    const id = normalizeIdentityId(rawId);
    if (id === "env") throw new Error("env identity cannot be deleted");

    const { config: current } = readConfigFile(config.configPath);
    const telegram = current.channels?.telegram as { bots?: unknown } | undefined;
    const bots = Array.isArray(telegram?.bots) ? ((telegram.bots as unknown[]) ?? []) : [];
    // Entries we are not touching round-trip straight back out of the config file,
    // so they are already identities even though the file is read as unknown.
    const nextBots: TelegramIdentity[] = [];
    let deleted = false;
    for (const entry of bots) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      const entryId = normalizeIdentityId(typeof record.id === "string" ? record.id : "default");
      if (entryId === id) {
        deleted = true;
        continue;
      }
      nextBots.push(record as unknown as TelegramIdentity);
    }
    const next: OpenCodeRouterConfigFile = {
      ...current,
      channels: {
        ...current.channels,
        telegram: {
          ...(current.channels?.telegram ?? {}),
          bots: nextBots,
        },
      },
    };
    next.version = next.version ?? 1;
    writeConfigFile(config.configPath, next);
    config.configFile = next;

    config.telegramBots.splice(
      0,
      config.telegramBots.length,
      ...config.telegramBots.filter((bot) => bot.id !== id),
    );

    await stopAndForget(adapterKey("telegram", id), id, "failed to stop telegram adapter");
    return { id, deleted };
  };

  return { listTelegramIdentities, upsertTelegramIdentity, deleteTelegramIdentity };
};
