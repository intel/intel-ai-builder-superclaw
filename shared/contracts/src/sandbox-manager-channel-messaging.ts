/**
 * What the desktop app asks the Sandbox Manager to do on the channels' behalf (EG2-7, design 6.5):
 * send a message, and bind or unbind a conversation to a workspace directory.
 *
 * Both used to go through openwork-server, which runs as the file_tool tier - the tier the agent runs
 * as - holding the router's one control token. That token was therefore reachable from the agent.
 * They are served here instead, with the router's ADMIN token, which only the Sandbox Manager holds.
 * An operator's own send from the app is not held for approval: the approval is the agent's, for a send
 * it makes to a conversation it was not asked to answer (`router-approval.ts`).
 *
 * The routes are `POST /sandbox-manager/v1/channels/{channel}/send` and
 * `PUT /sandbox-manager/v1/channels/{channel}/bindings`, reached through ServiceHub like the others in
 * `sandbox-manager-host-api.ts`, whose error envelope they use.
 */
import { z } from "zod";

import {
  ChannelDirectorySchema,
  ChannelIdentityIdSchema,
  ChannelNameSchema,
} from "./sandbox-manager-host-api.js";

/** A peer: a Slack channel or thread id, or a Telegram chat id. No control or format character. */
export const ChannelPeerIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\p{Cc}\p{Cf}\s]+$/u);

export const CHANNEL_SEND_TEXT_MAX_CHARS = 20_000;

/**
 * `POST .../channels/{channel}/send`. A send names a conversation (`peer_id`), or every conversation
 * bound to a directory (`directory`), or both; the route refuses one with neither. `auto_bind` binds
 * `peer_id` to `directory` as it sends, which only the operator may ask for.
 */
export const ChannelSendRequestSchema = z
  .object({
    text: z.string().min(1).max(CHANNEL_SEND_TEXT_MAX_CHARS),
    identity_id: ChannelIdentityIdSchema.optional(),
    directory: ChannelDirectorySchema.optional(),
    peer_id: ChannelPeerIdSchema.optional(),
    auto_bind: z.boolean().optional(),
  })
  .strict();
export type ChannelSendRequest = z.infer<typeof ChannelSendRequestSchema>;

export const ChannelSendFailureSchema = z
  .object({ identity_id: z.string().max(48), peer_id: z.string().max(256), error: z.string().max(512) })
  .strict();

/** What the send answers: what the router attempted and delivered, per target. */
export const ChannelSendResultSchema = z
  .object({
    channel: ChannelNameSchema,
    directory: z.string().max(1024),
    identity_id: z.string().max(48).optional(),
    peer_id: z.string().max(256).optional(),
    attempted: z.number().int().min(0),
    sent: z.number().int().min(0),
    failures: z.array(ChannelSendFailureSchema).max(256).optional(),
    reason: z.string().max(512).optional(),
  })
  .strict();
export type ChannelSendResult = z.infer<typeof ChannelSendResultSchema>;

/** `PUT .../channels/{channel}/bindings`. Without a `directory` the conversation is unbound. */
export const ChannelBindingRequestSchema = z
  .object({
    peer_id: ChannelPeerIdSchema,
    identity_id: ChannelIdentityIdSchema.optional(),
    directory: ChannelDirectorySchema.optional(),
  })
  .strict();
export type ChannelBindingRequest = z.infer<typeof ChannelBindingRequestSchema>;

export const ChannelBindingResultSchema = z
  .object({ channel: ChannelNameSchema, peer_id: ChannelPeerIdSchema, bound: z.boolean() })
  .strict();
export type ChannelBindingResult = z.infer<typeof ChannelBindingResultSchema>;

/**
 * Which Slack members the bot answers (#3539). The approvals live in the router's own database and are
 * read and changed with its control token, so the app goes through the Sandbox Manager for them exactly as
 * it does for a send: `GET /sandbox-manager/v1/channels/slack/senders` lists them and
 * `PUT /sandbox-manager/v1/channels/slack/senders/{user_id}` approves (`allowed: true`) or removes
 * (`allowed: false`) one, each answering the whole list. There is no implicit allow: with no router attached
 * or none answering, both are refused with the codes of `sandbox-manager-host-api.ts`.
 */
export const SlackSenderUserIdSchema = z.string().regex(/^[UW][A-Z0-9]{1,63}$/);

export const SlackSenderDecisionRequestSchema = z.object({ allowed: z.boolean() }).strict();
export type SlackSenderDecisionRequest = z.infer<typeof SlackSenderDecisionRequestSchema>;

// Listed ids are the router's, and an operator's SLACK_ALLOWED_USERS may hold any word, so they are not
// held to the Slack id pattern the path takes.
const SlackListedUserIdSchema = z.string().min(1).max(256);

/** `env` entries come from SLACK_ALLOWED_USERS and cannot be removed from the app. */
export const SlackSenderEntrySchema = z
  .object({ user_id: SlackListedUserIdSchema, source: z.enum(["app", "env"]) })
  .strict();

export const SlackPendingSenderSchema = z
  .object({
    user_id: SlackListedUserIdSchema,
    identity_id: z.string().max(256),
    first_seen_at: z.number().int().min(0),
    last_seen_at: z.number().int().min(0),
    attempts: z.number().int().min(0),
  })
  .strict();

export const SlackSendersResultSchema = z
  .object({
    allowed: z.array(SlackSenderEntrySchema).max(4096),
    pending: z.array(SlackPendingSenderSchema).max(256),
  })
  .strict();
export type SlackSendersResult = z.infer<typeof SlackSendersResultSchema>;
