/**
 * Which Slack users the bridge answers. Fail-closed: a sender is admitted only
 * once they are approved, either from the app (stored in the router's own
 * database) or by an operator through SLACK_ALLOWED_USERS. Refused senders are
 * kept as pending requests, in memory only, so the owner can approve them under
 * Settings → Connections → Slack.
 */

import type { BridgeStore } from "./db.js";

export const SLACK_ALLOWED_USERS_ENV = "SLACK_ALLOWED_USERS";

const SLACK_USER_ID = /^[UW][A-Z0-9]+$/;
const MAX_PENDING = 100;

export type SlackSenderEntry = { userId: string; source: "app" | "env" };

export type PendingSlackSender = {
  userId: string;
  identityId: string;
  firstSeenAt: number;
  lastSeenAt: number;
  attempts: number;
};

export type SlackSendersSnapshot = { allowed: SlackSenderEntry[]; pending: PendingSlackSender[] };

export type SlackSenderAccess = {
  isAllowed(userId: string | null | undefined): boolean;
  /** Records a refused sender. True when they should be told, which is once unless the notice fails. */
  recordBlocked(identityId: string, userId: string): boolean;
  /** The notice did not reach them, so the next refusal tells them again. */
  noticeFailed(userId: string): void;
  list(): SlackSendersSnapshot;
  allow(userId: string): void;
  revoke(userId: string): void;
};

/** Splits on commas and whitespace. `*` is an ordinary id, not a wildcard. */
export function parseAllowedUsers(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function statusError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

/**
 * Approvals are kept in the router's database rather than opencode-router.json: the
 * openwork server also rewrites that file, and its read-modify-write could put back a
 * sender who was just removed. Only the router opens the database.
 */
export function createStoredSlackSenderAccess(
  store: Pick<BridgeStore, "listSlackAllowedSenders" | "replaceSlackAllowedSenders">,
  envUserIds: readonly string[],
): SlackSenderAccess {
  return createSlackSenderAccess({
    env: envUserIds,
    saved: store.listSlackAllowedSenders(),
    persist: (userIds) => store.replaceSlackAllowedSenders(userIds),
  });
}

export function createSlackSenderAccess(input: {
  env: readonly string[];
  saved: readonly string[];
  persist: (userIds: string[]) => void;
  now?: () => number;
}): SlackSenderAccess {
  const now = input.now ?? Date.now;
  const fromEnv = new Set(input.env);
  const fromApp = new Set(input.saved);
  const pending = new Map<string, PendingSlackSender & { notified: boolean }>();

  return {
    isAllowed: (userId) => typeof userId === "string" && (fromApp.has(userId) || fromEnv.has(userId)),

    recordBlocked: (identityId, userId) => {
      const at = now();
      const existing = pending.get(userId);
      if (existing) {
        existing.identityId = identityId;
        existing.lastSeenAt = at;
        existing.attempts += 1;
        if (existing.notified) return false;
        existing.notified = true;
        return true;
      }
      if (pending.size >= MAX_PENDING) {
        const oldest = [...pending.values()].reduce((a, b) => (a.lastSeenAt <= b.lastSeenAt ? a : b));
        pending.delete(oldest.userId);
      }
      pending.set(userId, { userId, identityId, firstSeenAt: at, lastSeenAt: at, attempts: 1, notified: true });
      return true;
    },

    noticeFailed: (userId) => {
      const entry = pending.get(userId);
      if (entry) entry.notified = false;
    },

    list: () => ({
      // An id the environment approves cannot be removed from the app, so it is reported as `env`.
      allowed: [
        ...[...fromEnv].map((userId) => ({ userId, source: "env" as const })),
        ...[...fromApp].filter((userId) => !fromEnv.has(userId)).map((userId) => ({ userId, source: "app" as const })),
      ].sort((a, b) => a.userId.localeCompare(b.userId)),
      pending: [...pending.values()]
        .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
        .map(({ userId, identityId, firstSeenAt, lastSeenAt, attempts }) => ({ userId, identityId, firstSeenAt, lastSeenAt, attempts })),
    }),

    // Both writes save first and change memory only once the save succeeds, so a failed save
    // leaves memory and disk agreeing and a retry writes again.
    allow: (userId) => {
      if (!SLACK_USER_ID.test(userId)) throw statusError(400, "userId must be a Slack user id (U… or W…)");
      if (!fromApp.has(userId) && !fromEnv.has(userId)) {
        input.persist([...fromApp, userId]);
        fromApp.add(userId);
      }
      pending.delete(userId);
    },

    revoke: (userId) => {
      if (fromEnv.has(userId)) {
        throw statusError(409, `${userId} is approved by ${SLACK_ALLOWED_USERS_ENV}; remove it there`);
      }
      if (!fromApp.has(userId)) return;
      input.persist([...fromApp].filter((id) => id !== userId));
      fromApp.delete(userId);
    },
  };
}
