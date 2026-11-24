// Control-plane handlers for chat-to-directory bindings: list, set, clear.
//
// Setting or clearing a binding always drops the session too: the session holds
// the old directory, so leaving it in place would keep answering from the
// directory the user just moved away from.

import type { ChannelName } from "./config.js";
import type { BridgeStore } from "./db.js";
import { isTelegramPeerId } from "./telegram.js";

export type BindingsDeps = {
  store: BridgeStore;
  normalizeIdentityId: (value: string | undefined) => string;
  resolveScopedDirectory: (input: string) => { ok: true; directory: string } | { ok: false; error: string };
  ensureEventSubscription: (directory: string) => void;
  invalidTelegramPeerIdError: () => Error;
};

/** Only these two channels can be bound; anything else is a client error. */
export const parseChannel = (raw: string): ChannelName => {
  const channel = raw.trim().toLowerCase();
  if (channel !== "telegram" && channel !== "slack") {
    const error = new Error("Invalid channel") as Error & { status?: number };
    error.status = 400;
    throw error;
  }
  return channel;
};

export const createBindingHandlers = (deps: BindingsDeps) => {
  const listBindings = async (filters?: { channel?: string; identityId?: string }) => {
    const channelRaw = filters?.channel?.trim().toLowerCase();
    const identityIdRaw = filters?.identityId?.trim();
    // A blank filter means "every channel"; only a non-blank one is validated.
    const channel = channelRaw ? parseChannel(channelRaw) : undefined;
    const identityId = identityIdRaw ? deps.normalizeIdentityId(identityIdRaw) : undefined;
    const bindings = deps.store.listBindings({
      ...(channel ? { channel } : {}),
      ...(identityId ? { identityId } : {}),
    });
    return {
      items: bindings.map((entry) => ({
        channel: entry.channel,
        identityId: entry.identity_id,
        peerId: entry.peer_id,
        directory: entry.directory,
        updatedAt: entry.updated_at,
      })),
    };
  };

  const setBinding = async (input: {
    channel: string;
    identityId?: string;
    peerId: string;
    directory: string;
  }) => {
    const channel = parseChannel(input.channel);
    const identityId = deps.normalizeIdentityId(input.identityId);
    const peerKey = input.peerId.trim();
    const directory = input.directory.trim();
    if (!peerKey || !directory) {
      throw new Error("peerId and directory are required");
    }
    if (channel === "telegram" && !isTelegramPeerId(peerKey)) {
      throw deps.invalidTelegramPeerIdError();
    }
    const scoped = deps.resolveScopedDirectory(directory);
    if (!scoped.ok) {
      const error = new Error(scoped.error) as Error & { status?: number };
      error.status = 400;
      throw error;
    }
    const normalizedDir = scoped.directory;
    deps.store.upsertBinding(channel, identityId, peerKey, normalizedDir);
    deps.store.deleteSession(channel, identityId, peerKey);
    deps.ensureEventSubscription(normalizedDir);
  };

  const clearBinding = async (input: { channel: string; identityId?: string; peerId: string }) => {
    const channel = parseChannel(input.channel);
    const identityId = deps.normalizeIdentityId(input.identityId);
    const peerKey = input.peerId.trim();
    if (!peerKey) {
      throw new Error("peerId is required");
    }
    deps.store.deleteBinding(channel, identityId, peerKey);
    deps.store.deleteSession(channel, identityId, peerKey);
  };

  return { listBindings, setBinding, clearBinding };
};
