// Per-user model overrides and the preset shortcuts that set them.
//
// The override map is module-level, as it was in bridge.ts: it is deliberately
// process-wide rather than per-bridge, so a user's /opus survives a bridge
// restart within the same process. It lives here so bridge.ts and commands.ts
// can both reach it without importing each other.

import type { ChannelName, ModelRef } from "./config.js";

/** Model presets for quick switching. */
export const MODEL_PRESETS: Record<string, ModelRef> = {
  opus: { providerID: "anthropic", modelID: "claude-opus-4-5-20251101" },
  codex: { providerID: "openai", modelID: "gpt-5.2-codex" },
};

const userModelOverrides = new Map<string, ModelRef>();

// These take a `peerKey`, not a `peerId`. Every caller passes the peerKey, and
// today the two always hold the same value because each peerKey is assigned
// straight from a peer id. The parameters are named for the key rather than the
// id so that stays true: a caller that passed a real peerId once the two
// diverge would open a second, silently empty override namespace for that chat.
function getUserModelKey(channel: ChannelName, identityId: string, peerKey: string): string {
  return `${channel}:${identityId}:${peerKey}`;
}

export function getUserModel(
  channel: ChannelName,
  identityId: string,
  peerKey: string,
  defaultModel?: ModelRef,
): ModelRef | undefined {
  const key = getUserModelKey(channel, identityId, peerKey);
  return userModelOverrides.get(key) ?? defaultModel;
}

export function setUserModel(
  channel: ChannelName,
  identityId: string,
  peerKey: string,
  model: ModelRef | undefined,
): void {
  const key = getUserModelKey(channel, identityId, peerKey);
  if (model) {
    userModelOverrides.set(key, model);
  } else {
    userModelOverrides.delete(key);
  }
}
