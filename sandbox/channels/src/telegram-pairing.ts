// Telegram private-bot pairing: the `/pair <code>` handshake that has to bind a
// chat to a workspace directory before the bridge will accept any prompt from it.
//
// Extracted from `startBridge` so the code normalization and the gate's decision
// order can be unit-tested without standing up a Telegram adapter.

import { createHash } from "node:crypto";

import type { Logger } from "pino";

import type { ChannelName } from "./config.js";
import type { BridgeStore } from "./db.js";

/**
 * Codes are compared case-insensitively and ignoring punctuation, so a user can
 * retype one with dashes or spaces and still pair.
 */
export const normalizePairingCodeValue = (value: string): string =>
  value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");

export const hashPairingCode = (value: string): string =>
  createHash("sha256").update(normalizePairingCodeValue(value)).digest("hex");

/** Pulls the code out of `/pair <code>`, tolerating Telegram's `@botname` suffix. */
export const extractPairingCodeFromCommand = (text: string): string => {
  const trimmed = text.trim();
  const match = trimmed.match(/^\/pair(?:@[A-Za-z0-9_]+)?\s+(.+)$/i);
  if (!match?.[1]) return "";
  return normalizePairingCodeValue(match[1]);
};

export type TelegramPairingGateDeps = {
  /** The bridge's text sender, narrowed to the system notices the gate emits. */
  sendText: (
    channel: ChannelName,
    identityId: string,
    peerId: string,
    text: string,
    options: { kind: "system" },
  ) => Promise<void>;
  resolveTelegramIdentityAccess: (identityId: string) => { access: "public" | "private"; pairingCodeHash: string };
  resolveIdentityDirectory: (channel: ChannelName, identityId: string) => string;
  resolveScopedDirectory: (input: string) => { ok: true; directory: string } | { ok: false; error: string };
  isDangerousRootDirectory: (dir: string) => boolean;
  ensureEventSubscription: (directory: string) => void;
  store: BridgeStore;
  defaultDirectory: string;
  logger: Logger;
};

export type TelegramPairingGateInput = {
  identityId: string;
  peerKey: string;
  peerId: string;
  text: string;
  bindingDirectory?: string;
  sessionDirectory?: string;
};

/**
 * Returns the gate. `"continue"` means the message may proceed to the agent;
 * `"handled"` means the gate already answered the user and the caller must stop.
 *
 * A public bot, or a chat that already has a binding, is never gated — only an
 * unbound chat on a private bot has to present a code.
 */
export const createTelegramPairingGate =
  (deps: TelegramPairingGateDeps) =>
  async (input: TelegramPairingGateInput): Promise<"continue" | "handled"> => {
    const access = deps.resolveTelegramIdentityAccess(input.identityId);
    if (access.access !== "private") {
      return "continue";
    }

    const hasKnownBinding = Boolean(input.bindingDirectory?.trim() || input.sessionDirectory?.trim());
    if (hasKnownBinding) {
      return "continue";
    }

    const pairingCode = extractPairingCodeFromCommand(input.text);
    if (!pairingCode) {
      await deps.sendText(
        "telegram",
        input.identityId,
        input.peerId,
        "This Telegram bot is private. Ask your OpenWork host for the pairing code, then send /pair <code>.",
        { kind: "system" },
      );
      return "handled";
    }

    if (!access.pairingCodeHash) {
      await deps.sendText(
        "telegram",
        input.identityId,
        input.peerId,
        "This Telegram bot is private but missing a pairing code. Ask your OpenWork host to reconnect it.",
        { kind: "system" },
      );
      return "handled";
    }

    if (hashPairingCode(pairingCode) !== access.pairingCodeHash) {
      await deps.sendText("telegram", input.identityId, input.peerId, "Invalid pairing code. Try again with /pair <code>.", {
        kind: "system",
      });
      return "handled";
    }

    const identityDirectory = deps.resolveIdentityDirectory("telegram", input.identityId);
    const boundDirectoryCandidate = identityDirectory || deps.defaultDirectory;
    const hasExplicitBinding = Boolean(identityDirectory);
    if (!boundDirectoryCandidate || (!hasExplicitBinding && deps.isDangerousRootDirectory(boundDirectoryCandidate))) {
      await deps.sendText(
        "telegram",
        input.identityId,
        input.peerId,
        "No workspace directory configured for this identity. Ask your OpenWork host to set it, or reply with /dir <path>.",
        { kind: "system" },
      );
      return "handled";
    }

    const scopedBound = deps.resolveScopedDirectory(boundDirectoryCandidate);
    if (!scopedBound.ok) {
      await deps.sendText("telegram", input.identityId, input.peerId, scopedBound.error, { kind: "system" });
      return "handled";
    }

    const boundDirectory = scopedBound.directory;
    deps.store.upsertBinding("telegram", input.identityId, input.peerKey, boundDirectory);
    deps.store.deleteSession("telegram", input.identityId, input.peerKey);
    deps.ensureEventSubscription(boundDirectory);
    deps.logger.info(
      { channel: "telegram", identityId: input.identityId, peerId: input.peerKey, directory: boundDirectory },
      "telegram private identity paired",
    );
    await deps.sendText(
      "telegram",
      input.identityId,
      input.peerId,
      "Pairing successful. This chat is now linked to your worker.",
      { kind: "system" },
    );
    return "handled";
  };
