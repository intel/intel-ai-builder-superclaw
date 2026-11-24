// Control-plane handlers for the Slack sender allowlist: list approved and
// pending senders, approve or remove one. Changes reach running adapters at
// once, because every adapter reads the same `config.slackSenders`.

import type { Logger } from "pino";

import { SLACK_ALLOWED_USERS_ENV, type SlackSenderAccess, type SlackSendersSnapshot } from "./slack-senders.js";

export type SlackSenderDeps = {
  slackSenders: SlackSenderAccess;
  logger: Logger;
};

export const createSlackSenderHandlers = ({ slackSenders, logger }: SlackSenderDeps) => ({
  listSlackSenders: async (): Promise<SlackSendersSnapshot> => slackSenders.list(),
  updateSlackSender: async (input: { userId: string; allowed: boolean }): Promise<SlackSendersSnapshot> => {
    if (input.allowed) slackSenders.allow(input.userId);
    else slackSenders.revoke(input.userId);
    logger.info({ channel: "slack", userId: input.userId }, input.allowed ? "slack sender approved" : "slack sender removed");
    return slackSenders.list();
  },
});

/** Startup notice for a Slack app that nobody can talk to yet. */
export function warnWhenNoSlackSenderApproved(
  slackSenders: SlackSenderAccess,
  logger: Logger,
  reportStatus?: (message: string) => void,
) {
  if (slackSenders.list().allowed.length > 0) return;
  const message = `Slack has no approved senders yet: approve them under Settings → Connections → Slack, or set ${SLACK_ALLOWED_USERS_ENV}.`;
  logger.warn(message);
  reportStatus?.(message);
}
