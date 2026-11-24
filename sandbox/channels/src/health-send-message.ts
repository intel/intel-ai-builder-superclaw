// The control-plane send handler: deliver a message to one explicit peer, or to
// every conversation bound to a directory.
//
// It reports per-target and per-part results rather than throwing, because a
// fan-out send to five bound conversations can partly succeed and the caller
// needs to know which ones did not.

import type { Adapter } from "./adapter.js";
import type { BridgeStore } from "./db.js";
import type { ChannelName } from "./config.js";
import { parseChannel } from "./health-bindings.js";
import type { MessageDeliveryResult, OutboundMessagePart } from "./media.js";
import { isTelegramPeerId } from "./telegram.js";

export type SendTargetDelivery = {
  identityId: string;
  peerId: string;
  attemptedParts: number;
  sentParts: number;
  partResults: MessageDeliveryResult["partResults"];
};

export type SendMessageInput = {
  channel: string;
  identityId?: string;
  directory?: string;
  peerId?: string;
  text?: string;
  parts?: OutboundMessagePart[];
  autoBind?: boolean;
};

export type SendMessageDeps = {
  store: BridgeStore;
  adapters: Map<string, Adapter>;
  adapterKey: (channel: ChannelName, identityId: string) => string;
  normalizeIdentityId: (value: string | undefined) => string;
  normalizeDirectory: (input: string) => string;
  resolveScopedDirectory: (input: string) => { ok: true; directory: string } | { ok: false; error: string };
  listIdentityConfigs: (channel: ChannelName) => Array<{ id: string; directory: string }>;
  resolveOutboundParts: (
    directory: string,
    input: { text?: string; parts?: OutboundMessagePart[] },
  ) => Promise<OutboundMessagePart[]>;
  deliverParts: (
    channel: ChannelName,
    identityId: string,
    peerId: string,
    parts: OutboundMessagePart[],
    options: { kind: "system"; display: boolean },
  ) => Promise<MessageDeliveryResult>;
  ensureEventSubscription: (directory: string) => void;
  invalidTelegramPeerIdError: () => Error;
  workspaceRoot: string;
  workspaceRootNormalized: string;
};

const INVALID_TELEGRAM_BINDING = "Invalid Telegram peerId binding removed (expected numeric chat_id)";

const deliveryFailed = (delivery: MessageDeliveryResult) =>
  delivery.attemptedParts > 0 && delivery.sentParts < delivery.attemptedParts;

const primaryFailureMessage = (delivery: MessageDeliveryResult) =>
  delivery.partResults.find((part) => !part.sent)?.error || "Delivery failed";

export const createSendMessageHandler = (deps: SendMessageDeps) => async (input: SendMessageInput) => {
  const channel = parseChannel(input.channel);
  const identityId = input.identityId?.trim() ? deps.normalizeIdentityId(input.identityId) : undefined;
  const directoryInput = (input.directory ?? "").trim();
  const peerId = (input.peerId ?? "").trim();
  const autoBind = input.autoBind === true;

  if (!directoryInput && !peerId) {
    throw new Error("directory or peerId is required");
  }
  if (channel === "telegram" && peerId && !isTelegramPeerId(peerId)) {
    throw deps.invalidTelegramPeerIdError();
  }

  let normalizedDir = "";
  if (directoryInput) {
    const scoped = deps.resolveScopedDirectory(directoryInput);
    if (!scoped.ok) {
      const error = new Error(scoped.error) as Error & { status?: number };
      error.status = 400;
      throw error;
    }
    normalizedDir = scoped.directory;
  }

  const baseDirectory = normalizedDir || deps.workspaceRoot;
  const outboundParts = await deps.resolveOutboundParts(baseDirectory, {
    ...(input.text !== undefined ? { text: input.text } : {}),
    ...(input.parts !== undefined ? { parts: input.parts } : {}),
  });

  // A target that was never attempted still reports one failed result per part,
  // so the caller sees the same shape whether delivery failed or never started.
  const makeTargetError = (
    targetIdentityId: string,
    targetPeerId: string,
    errorMessage: string,
    errorCode = "not_found",
  ): SendTargetDelivery => ({
    identityId: targetIdentityId,
    peerId: targetPeerId,
    attemptedParts: outboundParts.length,
    sentParts: 0,
    partResults: outboundParts.map((part, index) => ({
      index,
      type: part.type,
      sent: false,
      error: errorMessage,
      code: errorCode,
      retryable: false,
    })),
  });

  const toTarget = (
    targetIdentityId: string,
    targetPeerId: string,
    delivery: MessageDeliveryResult,
  ): SendTargetDelivery => ({
    identityId: targetIdentityId,
    peerId: targetPeerId,
    attemptedParts: delivery.attemptedParts,
    sentParts: delivery.sentParts,
    partResults: delivery.partResults,
  });

  // With no explicit identity: prefer one configured for this directory and
  // actually running, otherwise any running adapter on the channel.
  const resolveSendIdentityId = () => {
    if (identityId) return identityId;
    if (normalizedDir) {
      const configured = deps.listIdentityConfigs(channel).find((entry) => {
        if (!entry.directory) return false;
        if (!deps.adapters.has(deps.adapterKey(channel, entry.id))) return false;
        return deps.normalizeDirectory(entry.directory) === normalizedDir;
      });
      if (configured?.id) return configured.id;
    }
    const active = Array.from(deps.adapters.values()).find((adapter) => adapter.name === channel);
    return active?.identityId;
  };

  const targetIdentityId = resolveSendIdentityId();
  if (peerId && !targetIdentityId) {
    return {
      channel,
      directory: normalizedDir || deps.workspaceRootNormalized,
      peerId,
      attempted: 0,
      sent: 0,
      reason: `No ${channel} adapter is running for direct send`,
      targets: [],
    };
  }

  if (peerId && targetIdentityId) {
    const adapter = deps.adapters.get(deps.adapterKey(channel, targetIdentityId));
    if (!adapter) {
      return {
        channel,
        directory: normalizedDir || deps.workspaceRootNormalized,
        identityId: targetIdentityId,
        peerId,
        attempted: 1,
        sent: 0,
        failures: [{ identityId: targetIdentityId, peerId, error: "Adapter not running" }],
        targets: [makeTargetError(targetIdentityId, peerId, "Adapter not running")],
      };
    }

    if (autoBind && normalizedDir) {
      deps.store.upsertBinding(channel, targetIdentityId, peerId, normalizedDir);
      deps.store.deleteSession(channel, targetIdentityId, peerId);
      deps.ensureEventSubscription(normalizedDir);
    }

    const delivery = await deps.deliverParts(channel, targetIdentityId, peerId, outboundParts, {
      kind: "system",
      display: false,
    });
    const failed = deliveryFailed(delivery);
    return {
      channel,
      directory: normalizedDir || deps.workspaceRootNormalized,
      identityId: targetIdentityId,
      peerId,
      attempted: 1,
      sent: failed ? 0 : 1,
      ...(failed
        ? { failures: [{ identityId: targetIdentityId, peerId, error: primaryFailureMessage(delivery) }] }
        : {}),
      targets: [toTarget(targetIdentityId, peerId, delivery)],
    };
  }

  const bindings = deps.store.listBindings({
    channel,
    ...(identityId ? { identityId } : {}),
    directory: normalizedDir,
  });
  if (bindings.length === 0) {
    return {
      channel,
      directory: normalizedDir,
      ...(identityId ? { identityId } : {}),
      attempted: 0,
      sent: 0,
      reason: `No bound conversations for ${channel}${identityId ? `/${identityId}` : ""} at directory ${normalizedDir}`,
      targets: [],
    };
  }

  const failures: Array<{ identityId: string; peerId: string; error: string }> = [];
  const targets: SendTargetDelivery[] = [];
  let attempted = 0;
  let sent = 0;
  for (const binding of bindings) {
    attempted += 1;
    const fail = (error: string, code?: string) => {
      targets.push(makeTargetError(binding.identity_id, binding.peer_id, error, code));
      failures.push({ identityId: binding.identity_id, peerId: binding.peer_id, error });
    };
    // A binding that can never be delivered to is removed rather than retried
    // forever; its session goes with it, since it holds the same dead peer.
    if (channel === "telegram" && !isTelegramPeerId(binding.peer_id)) {
      deps.store.deleteBinding(channel, binding.identity_id, binding.peer_id);
      deps.store.deleteSession(channel, binding.identity_id, binding.peer_id);
      fail(INVALID_TELEGRAM_BINDING, "invalid_target");
      continue;
    }
    if (!deps.adapters.has(deps.adapterKey(channel, binding.identity_id))) {
      fail("Adapter not running");
      continue;
    }
    const delivery = await deps.deliverParts(
      channel,
      binding.identity_id,
      binding.peer_id,
      outboundParts,
      { kind: "system", display: false },
    );
    targets.push(toTarget(binding.identity_id, binding.peer_id, delivery));
    if (deliveryFailed(delivery)) {
      failures.push({
        identityId: binding.identity_id,
        peerId: binding.peer_id,
        error: primaryFailureMessage(delivery),
      });
    } else {
      sent += 1;
    }
  }

  return {
    channel,
    directory: normalizedDir,
    ...(identityId ? { identityId } : {}),
    attempted,
    sent,
    ...(failures.length ? { failures } : {}),
    targets,
  };
};
