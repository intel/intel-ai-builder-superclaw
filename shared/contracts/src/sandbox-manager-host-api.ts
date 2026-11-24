/**
 * The Sandbox Manager's host API for egress approvals, the Tavily key and the channel credentials
 * (#16, #12, EG2-6).
 *
 * fwu chose option A on #82: these endpoints live in the Sandbox Manager's `api/v1/`, behind
 * ServiceHub's `/sandbox-manager` forwarding, and the frontend calls them through one adapter.
 * They are out of openwork-server because that runs in the file and tool tier, the account the
 * agent's shell runs as, and an approval the agent could grant itself is not an approval. This is
 * still the exception to AGENTS.md section 5a recorded in #45: when the instance API takes these
 * over, the adapter moves and nothing else does.
 *
 * Every body on this wire is here, including the one error envelope. ServiceHub's
 * `normalize_upstream_error` passes `{error: {code, message}}` through and rewrites any other
 * error body to `upstream_error`, so a code outside that envelope never reaches the frontend.
 *
 * Browser-safe: the adapter parses with these schemas, so nothing here may import a node builtin.
 */
import { z } from "zod";

import { CorrelationIdSchema } from "./correlation-id.js";
import { IsolationInstantSchema } from "./isolation-reporting.js";

/** The component an approval is asked of, which acts once it is granted. Design section 6.3. */
export const EgressApprovalAudienceSchema = z.enum(["connector", "egress_proxy", "router"]);
export type EgressApprovalAudience = z.infer<typeof EgressApprovalAudienceSchema>;

/** What a granted approval lets its audience do, as design section 6.3 names each action. */
export const EgressApprovalActionSchema = z.enum([
  "connector.fetch_result",
  "connector.mcp_call",
  "connector.gmail_send",
  "proxy.connect_domain",
  "proxy.connect_unlisted",
  "router.send_new_target",
]);
export type EgressApprovalAction = z.infer<typeof EgressApprovalActionSchema>;

/**
 * How long an approved decision lasts (EG2-4b). `once` releases the one held request.
 * `all_for_chat` releases it too, and the verifier that held it then admits the rest of that chat's
 * requests for the same action from its own memory, until it restarts. Only an approval that lists
 * `grant_scopes` offers more than `once`: the Connector, for a `connector.fetch_result` from a chat
 * whose root session it knows, and the egress proxy, for a shell command whose chat it can name. The
 * router offers `once` alone.
 */
export const EGRESS_APPROVAL_GRANT_SCOPES = ["once", "all_for_chat"] as const;
export const EgressApprovalGrantScopeSchema = z.enum(EGRESS_APPROVAL_GRANT_SCOPES);
export type EgressApprovalGrantScope = z.infer<typeof EgressApprovalGrantScopeSchema>;

/**
 * How a verifier names a chat without its session id: `sref_` and the first 16 hex characters of
 * sha256(this label + the root session id), over UTF-8. The egress proxy uses the same label, so
 * the two name one chat alike. Here, not in `egress-approval-grant.ts`, because the app hashes root
 * session ids with it to say which chat an approval is for, and that module uses `node:crypto`.
 */
export const EGRESS_APPROVAL_SESSION_REF_LABEL = "superclaw-egress-proxy-session-ref-v1\n";
export const EgressApprovalSessionRefSchema = z.string().regex(/^sref_[0-9a-f]{16}$/);

/**
 * Where the request came from. `shell` and `channel` are the egress proxy's callers, which design
 * section 6.4 classifies by the port they connected to; `agent` is the agent's own tool call, the
 * Connector's only caller. The router's callers join this list when they are named, as new members.
 */
export const EgressApprovalCallerSchema = z.enum(["shell", "channel", "agent"]);
export type EgressApprovalCaller = z.infer<typeof EgressApprovalCallerSchema>;

/**
 * The longest operator-facing text, in UTF-16 code units, which is how the frontend counts.
 *
 * The generated Pydantic model counts code points, so it accepts up to this many astral characters,
 * twice as many units as the frontend will parse. The Sandbox Manager therefore cuts at UTF-16 code
 * units, reading this bound from the published rules, rather than relying on its own model.
 */
export const EGRESS_APPROVAL_TEXT_MAX_UTF16_UNITS = 512;

/**
 * Text an operator reads before deciding, such as the target of a request.
 *
 * No control or format character: a bidirectional override can make one domain read as another,
 * and this is the text an approval is decided on. The Sandbox Manager removes them and truncates
 * before it sends; this schema is the check that its cleaning did not miss one.
 *
 * Not excluded: U+2028 and U+2029, which are line separators, not controls; and lone surrogates,
 * which JSON cannot carry. The pattern uses `\p{Cc}`, which JavaScript and Pydantic's regex engine
 * read and Python's `re` and `jsonschema` do not: Python consumers use the generated model, and
 * the JSON Schema's pattern is for JavaScript.
 */
export const EgressApprovalTextSchema = z
  .string()
  .min(1)
  .max(EGRESS_APPROVAL_TEXT_MAX_UTF16_UNITS)
  // Zod 4.6 counts code points; keep the wire's existing UTF-16 limit as well.
  .refine((value) => value.length <= EGRESS_APPROVAL_TEXT_MAX_UTF16_UNITS)
  .regex(/^[^\p{Cc}\p{Cf}]+$/u);

/** One request waiting for an operator's decision. */
export const EgressPendingApprovalSchema = z
  .object({
    approval_id: CorrelationIdSchema,
    audience: EgressApprovalAudienceSchema,
    action: EgressApprovalActionSchema,
    caller: EgressApprovalCallerSchema,
    target: EgressApprovalTextSchema,
    requested_at: IsolationInstantSchema,
    expires_at: IsolationInstantSchema,
    /** The scopes the operator may choose from; absent means `once` alone. */
    grant_scopes: z.array(EgressApprovalGrantScopeSchema).min(1).max(3).optional(),
    /** The chat the request belongs to; absent when its verifier does not know it. */
    session_ref: EgressApprovalSessionRefSchema.optional(),
  })
  .strict();
export type EgressPendingApproval = z.infer<typeof EgressPendingApprovalSchema>;

/**
 * The longest `GET .../egress/approvals?wait_ms=` holds the request open. A larger `wait_ms`
 * waits this long, which keeps every response inside ServiceHub's 30 s read timeout.
 */
export const EGRESS_APPROVALS_MAX_WAIT_MS = 20_000;
export const EGRESS_PENDING_APPROVALS_MAX = 64;

/** `GET /sandbox-manager/v1/egress/approvals`: the requests waiting, oldest first. */
export const EgressPendingApprovalListSchema = z
  .object({
    approvals: z.array(EgressPendingApprovalSchema).max(EGRESS_PENDING_APPROVALS_MAX),
  })
  .strict();
export type EgressPendingApprovalList = z.infer<typeof EgressPendingApprovalListSchema>;

export const EgressApprovalDecisionSchema = z.enum(["approve", "deny"]);
export type EgressApprovalDecision = z.infer<typeof EgressApprovalDecisionSchema>;

/** `POST /sandbox-manager/v1/egress/approvals/{approval_id}/decision`. */
export const EgressApprovalDecisionRequestSchema = z
  .object({ decision: EgressApprovalDecisionSchema, grant_scope: EgressApprovalGrantScopeSchema.optional() })
  .strict()
  .refine((request) => request.grant_scope === undefined || request.decision === "approve", {
    message: "a denial has no grant scope",
  });
export type EgressApprovalDecisionRequest = z.infer<typeof EgressApprovalDecisionRequestSchema>;

/**
 * What a decision did. An approval that could not be decided is a 409, not a `denied`.
 *
 * `outcome` follows from `decision`, so the pair is two shapes rather than two free fields: a
 * result that says `approve` and `denied` is not one this API ever sends, and the generated
 * JSON Schema and Pydantic refuse it too.
 */
export const EgressApprovalDecisionResultSchema = z.union([
  z
    .object({
      approval_id: CorrelationIdSchema,
      decision: z.literal("approve"),
      outcome: z.literal("granted"),
      grant_scope: EgressApprovalGrantScopeSchema.optional(),
    })
    .strict(),
  z
    .object({
      approval_id: CorrelationIdSchema,
      decision: z.literal("deny"),
      outcome: z.literal("denied"),
    })
    .strict(),
]);
export type EgressApprovalDecisionResult = z.infer<typeof EgressApprovalDecisionResultSchema>;

/**
 * `PUT /sandbox-manager/v1/egress/chat-grants/{root_session_id}`: "Allow for this session" on or off.
 *
 * On, the Sandbox Manager answers the chat's held `connector.fetch_result` requests that offer
 * `all_for_chat` with that scope itself, as if the user had chosen it in the dialog. The choice is
 * saved and survives Sandbox Manager, Connector and app restarts, with no time limit; it ends when
 * the chat is switched off or deleted. Off, it stops, and tells the Connector to forget the chat, so
 * the chat's next page outside its search results is asked about again. The path names the chat's root session in
 * the session id grammar; the Sandbox Manager computes its `session_ref` and records only that.
 */
export const EgressChatGrantRequestSchema = z.object({ allow: z.boolean() }).strict();
export type EgressChatGrantRequest = z.infer<typeof EgressChatGrantRequestSchema>;

/** `GET` and `PUT` on `.../egress/chat-grants/{root_session_id}` both answer this. */
export const EgressChatGrantStatusSchema = z
  .object({
    root_session_id: CorrelationIdSchema,
    session_ref: EgressApprovalSessionRefSchema,
    allowed: z.boolean(),
  })
  .strict();
export type EgressChatGrantStatus = z.infer<typeof EgressChatGrantStatusSchema>;

/**
 * A Tavily key as the Sandbox Manager stores it: 1 to 256 printable ASCII characters, none of
 * them a space. The adapter trims surrounding whitespace before it sends; the server checks the
 * value it received against this and trims nothing, so a valid key has one definition.
 *
 * The 1 to 256 printable ASCII rule is ours: the design sets no Tavily key format. Python
 * consumers validate with the generated `TavilyApiKeySaveRequest` model, not this pattern: a
 * `re.match` with this `$` lets a key with a trailing newline through, where Pydantic does not.
 */
export const TAVILY_API_KEY_PATTERN = /^[\x21-\x7e]{1,256}$/;

/**
 * Every `/sandbox-manager/v1/secrets/tavily-api-key` route answers this. `enabled: false` is a key the
 * user paused: it stays saved, and the Connector is given none until it is switched back on.
 */
export const TavilyApiKeyStatusSchema = z.object({ configured: z.boolean(), enabled: z.boolean() }).strict();
export type TavilyApiKeyStatus = z.infer<typeof TavilyApiKeyStatusSchema>;

/** `PUT /sandbox-manager/v1/secrets/tavily-api-key/enabled`: pause or resume the saved key. */
export const TavilyApiKeyEnabledRequestSchema = z.object({ enabled: z.boolean() }).strict();
export type TavilyApiKeyEnabledRequest = z.infer<typeof TavilyApiKeyEnabledRequestSchema>;

/** `PUT /sandbox-manager/v1/secrets/tavily-api-key`. No response ever repeats the key. */
export const TavilyApiKeySaveRequestSchema = z
  .object({ api_key: z.string().regex(TAVILY_API_KEY_PATTERN) })
  .strict();
export type TavilyApiKeySaveRequest = z.infer<typeof TavilyApiKeySaveRequestSchema>;

/** The chat channels the router carries. */
export const ChannelNameSchema = z.enum(["slack", "telegram"]);
export type ChannelName = z.infer<typeof ChannelNameSchema>;

/**
 * A channel identity's id: the router's own normalised form, 1 to 48 of letters, digits, `_`, `.` and
 * `-`. `env` matches the pattern and is refused by the server, because a pattern the generated
 * Pydantic model can read has no lookahead to exclude it with.
 */
export const CHANNEL_IDENTITY_ID_PATTERN = /^[A-Za-z0-9_.-]{1,48}$/;
export const ChannelIdentityIdSchema = z.string().regex(CHANNEL_IDENTITY_ID_PATTERN);

/**
 * A channel credential as the route accepts it: 1 to 512 printable ASCII characters, none of them a
 * space. Whether it is a token Slack or Telegram honours is the channel's to say, and the Sandbox
 * Manager asks the router rather than guessing a format.
 */
export const CHANNEL_TOKEN_PATTERN = /^[\x21-\x7e]{1,512}$/;
export const ChannelTokenSchema = z.string().regex(CHANNEL_TOKEN_PATTERN);

/** The workspace directory an identity answers in. No control or format character, as for approval text. */
export const ChannelDirectorySchema = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[^\p{Cc}\p{Cf}]+$/u);

/** `PUT /sandbox-manager/v1/channels/slack/identities/{identity_id}`. No response ever repeats a token. */
export const SlackIdentitySaveRequestSchema = z
  .object({
    bot_token: ChannelTokenSchema,
    app_token: ChannelTokenSchema,
    enabled: z.boolean().optional(),
    directory: ChannelDirectorySchema.optional(),
  })
  .strict();
export type SlackIdentitySaveRequest = z.infer<typeof SlackIdentitySaveRequestSchema>;

/**
 * What the Slack app SuperClaw creates in the user's workspace asks for (#3787): the bot scopes and
 * events the router uses. The router refuses a bot token without its own required scopes
 * (`REQUIRED_BOT_SCOPES` in `sandbox/channels/src/slack.ts`), so this list includes all of them.
 */
export const SLACK_APP_BOT_SCOPES = [
  "chat:write",
  "app_mentions:read",
  "im:history",
  "im:read",
  "im:write",
  "files:read",
  "files:write",
] as const;
export const SLACK_APP_BOT_EVENTS = ["message.im", "app_mention"] as const;

/** A Slack app id, as `apps.manifest.create` answers it. Not a secret. */
export const SlackAppIdSchema = z.string().regex(/^A[A-Z0-9]{2,31}$/);

/**
 * `POST /sandbox-manager/v1/channels/slack/install` (#3787). The Sandbox Manager creates a Slack app from
 * SuperClaw's manifest with the user's app configuration token, then waits on a loopback redirect for the
 * user to install it. The configuration token is held in memory for this install only; no response
 * repeats it, the new app's client secret, or the bot token the install yields.
 */
export const SlackInstallStartRequestSchema = z
  .object({ identity_id: ChannelIdentityIdSchema, configuration_token: ChannelTokenSchema })
  .strict();
export type SlackInstallStartRequest = z.infer<typeof SlackInstallStartRequestSchema>;

/** Slack's install page for the app, with this install's `state`. */
export const SlackAuthorizeUrlSchema = z.string().max(2048).startsWith("https://slack.com/oauth/v2/authorize?");

/** Where the user installs the app. The app opens it in the browser. */
export const SlackInstallStartResultSchema = z
  .object({
    app_id: SlackAppIdSchema,
    authorize_url: SlackAuthorizeUrlSchema,
    expires_at: IsolationInstantSchema,
  })
  .strict();
export type SlackInstallStartResult = z.infer<typeof SlackInstallStartResultSchema>;

/**
 * Where an install stands. `awaiting_app_token` means Slack redirected and the bot token is held; the
 * user still pastes the app-level token, which no Slack API creates.
 */
export const SlackInstallStateSchema = z.enum(["none", "awaiting_authorization", "awaiting_app_token", "failed"]);
export type SlackInstallState = z.infer<typeof SlackInstallStateSchema>;

/**
 * Why an install failed. `expired` covers a workspace that holds the install for admin approval: Slack
 * then never redirects, so the wait runs out rather than reporting a state of its own. A redirect whose
 * `state` does not match is refused without ending the install: a stale tab must not cancel a live one.
 */
export const SlackInstallFailureSchema = z.enum(["denied", "expired", "exchange_failed"]);
export type SlackInstallFailure = z.infer<typeof SlackInstallFailureSchema>;

/** A Slack workspace id, as `oauth.v2.access` answers it. Not a secret. */
export const SlackTeamIdSchema = z.string().regex(/^T[A-Z0-9]{2,31}$/);

/**
 * `GET` and `DELETE /sandbox-manager/v1/channels/slack/install` answer this. `authorize_url` is repeated while
 * the install waits for approval, so the app can offer it again after a reload. `team_id` is the workspace the
 * install went to, once Slack has redirected; with `app_id` it addresses the app's settings pages.
 */
export const SlackInstallStatusSchema = z
  .object({
    state: SlackInstallStateSchema,
    app_id: SlackAppIdSchema.optional(),
    authorize_url: SlackAuthorizeUrlSchema.optional(),
    team_id: SlackTeamIdSchema.optional(),
    expires_at: IsolationInstantSchema.optional(),
    failure: SlackInstallFailureSchema.optional(),
  })
  .strict()
  .refine((status) => (status.state === "failed") === (status.failure !== undefined), {
    message: "a failure is named exactly when the install failed",
  })
  .refine((status) => status.authorize_url === undefined || status.state === "awaiting_authorization", {
    message: "the install link is offered only while the install waits for approval",
  });
export type SlackInstallStatus = z.infer<typeof SlackInstallStatusSchema>;

/**
 * `POST /sandbox-manager/v1/channels/slack/install/complete`: the app-level token, saved with the held bot
 * token through the same identity save as `PUT .../slack/identities/{identity_id}`. The app is created with
 * Socket Mode off and no events, so that switching Socket Mode on in Slack offers the token with its scope;
 * this call first adds both (`slack_app_not_finished` when Slack will not).
 */
export const SlackInstallCompleteRequestSchema = z
  .object({
    app_token: ChannelTokenSchema,
    enabled: z.boolean().optional(),
    directory: ChannelDirectorySchema.optional(),
  })
  .strict();
export type SlackInstallCompleteRequest = z.infer<typeof SlackInstallCompleteRequestSchema>;

export const TelegramAccessModeSchema = z.enum(["public", "private"]);
export type TelegramAccessMode = z.infer<typeof TelegramAccessModeSchema>;

/**
 * `PUT /sandbox-manager/v1/channels/telegram/identities/{identity_id}`.
 *
 * A private identity carries the SHA-256 of its normalised pairing code, never the code: the caller
 * that shows the code to the user is the one that hashes it.
 */
export const TelegramIdentitySaveRequestSchema = z
  .object({
    token: ChannelTokenSchema,
    enabled: z.boolean().optional(),
    directory: ChannelDirectorySchema.optional(),
    access: TelegramAccessModeSchema.optional(),
    pairing_code_hash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  })
  .strict();
export type TelegramIdentitySaveRequest = z.infer<typeof TelegramIdentitySaveRequestSchema>;

/**
 * `PUT /sandbox-manager/v1/channels/{channel}/enabled`: the channel-wide switch the router reads when it
 * starts. `clear_token` drops the legacy single-bot Telegram token while switching off, and is refused
 * for Slack, which has none.
 */
export const ChannelEnabledRequestSchema = z
  .object({ enabled: z.boolean(), clear_token: z.boolean().optional() })
  .strict();
export type ChannelEnabledRequest = z.infer<typeof ChannelEnabledRequestSchema>;

/**
 * `PUT /sandbox-manager/v1/channels/slack/identities/{identity_id}/enabled`: switch one saved bot off or
 * back on with the tokens already kept, so turning it back on does not repeat the setup. Switching on
 * checks the tokens with Slack first; switching off does not. Answers `ChannelIdentityResult`.
 */
export const ChannelIdentityEnabledRequestSchema = z.object({ enabled: z.boolean() }).strict();
export type ChannelIdentityEnabledRequest = z.infer<typeof ChannelIdentityEnabledRequestSchema>;

/**
 * Why a saved or deleted identity is not yet live in the running router. The change is on disk either
 * way, so the next router start applies it.
 */
export const ChannelApplyErrorSchema = z.enum(["router_unreachable", "router_rejected"]);
export type ChannelApplyError = z.infer<typeof ChannelApplyErrorSchema>;

/** What `PUT` and `DELETE .../channels/{channel}/identities/{identity_id}` answer. */
export const ChannelIdentityResultSchema = z
  .object({
    channel: ChannelNameSchema,
    identity_id: ChannelIdentityIdSchema,
    persisted: z.boolean(),
    applied: z.boolean(),
    deleted: z.boolean().optional(),
    apply_error: ChannelApplyErrorSchema.optional(),
  })
  .strict();
export type ChannelIdentityResult = z.infer<typeof ChannelIdentityResultSchema>;

/** What `PUT .../channels/{channel}/enabled` answers. The router reads the switch at its next start. */
export const ChannelEnabledResultSchema = z
  .object({ channel: ChannelNameSchema, enabled: z.boolean(), persisted: z.literal(true) })
  .strict();
export type ChannelEnabledResult = z.infer<typeof ChannelEnabledResultSchema>;

/**
 * What `POST .../slack/install/complete` answers. A reconnect creates a new app and then deletes the one
 * the last install made, since Slack hands an app's client secret out only once, at creation.
 * `previous_app` is `pending` when there is an earlier app to delete: the delete runs after this answer, so
 * it cannot push the answer past the UI's wait, and one Slack refuses is retried on the next connect.
 */
export const SlackInstallCompleteResultSchema = z
  .object({
    identity: ChannelIdentityResultSchema,
    app_id: SlackAppIdSchema,
    previous_app: z.enum(["none", "pending"]),
  })
  .strict();
export type SlackInstallCompleteResult = z.infer<typeof SlackInstallCompleteResultSchema>;

/**
 * Every error these endpoints answer with. A malformed request is 400, never FastAPI's 422.
 * `servicehub_forwarding_required` is the middleware's answer to a request that did not come
 * through ServiceHub; see `servicehub-forwarding.ts`.
 */
export const SandboxManagerHostApiErrorCodeSchema = z.enum([
  "invalid_request",
  "invalid_tavily_api_key",
  "tavily_api_key_store_unavailable",
  "servicehub_forwarding_required",
  "approval_not_found",
  "approval_not_pending",
  "egress_approvals_unavailable",
  "approval_delivery_failed",
  "invalid_channel_identity",
  "invalid_channel_token",
  "channel_credentials_unavailable",
  "channel_config_unreadable",
  "channel_legacy_slack_config",
  "slack_credentials_rejected",
  "slack_verification_unavailable",
  "channel_router_unreachable",
  "channel_router_rejected",
  "slack_sender_env_managed",
  "slack_configuration_token_rejected",
  "slack_app_not_created",
  "slack_unreachable",
  "slack_install_port_unavailable",
  "slack_install_not_ready",
  "channel_identity_not_found",
  "slack_app_not_finished",
]);
export type SandboxManagerHostApiErrorCode = z.infer<typeof SandboxManagerHostApiErrorCodeSchema>;

/**
 * The status and the one fixed sentence each code goes out with.
 *
 * Fixed so that no message is ever built from the request: an error body that echoed its input
 * would repeat a key the caller mistyped. The frontend branches on `code` and only shows `message`.
 */
export const SANDBOX_MANAGER_HOST_API_ERRORS: {
  readonly [C in SandboxManagerHostApiErrorCode]: {
    readonly status: number;
    readonly message: string;
  };
} = {
  invalid_request: { status: 400, message: "The request is not one this endpoint accepts." },
  invalid_tavily_api_key: {
    status: 400,
    message: "A Tavily API key is 1 to 256 printable ASCII characters with no spaces.",
  },
  tavily_api_key_store_unavailable: {
    status: 501,
    message: "The Tavily API key cannot be stored on this backend.",
  },
  servicehub_forwarding_required: {
    status: 401,
    message: "This endpoint is reached only through ServiceHub.",
  },
  approval_not_found: { status: 404, message: "No approval has that id." },
  approval_not_pending: {
    status: 409,
    message: "That approval has already been decided or has expired.",
  },
  egress_approvals_unavailable: {
    status: 501,
    message: "Egress approvals are not available on this backend.",
  },
  // Not `egress_approvals_unavailable`: that one means there is nothing to decide, so the app takes
  // the dialog away. Here the approval is still pending, the dialog stays, and pressing again retries.
  approval_delivery_failed: {
    status: 502,
    message: "The decision could not be delivered. Try again.",
  },
  invalid_channel_identity: {
    status: 400,
    message: "A channel identity id is 1 to 48 letters, digits, dots, dashes or underscores, and is not env.",
  },
  invalid_channel_token: {
    status: 400,
    message: "A channel token is 1 to 512 printable ASCII characters with no spaces.",
  },
  channel_credentials_unavailable: {
    status: 503,
    message: "Channel settings can be saved only while the backend is running.",
  },
  channel_config_unreadable: {
    status: 500,
    message: "The channel configuration could not be read.",
  },
  channel_legacy_slack_config: {
    status: 409,
    message: "Update the legacy default Slack identity first.",
  },
  slack_credentials_rejected: {
    status: 400,
    message: "Slack rejected the credentials.",
  },
  slack_verification_unavailable: {
    status: 503,
    message: "Slack credential verification is unavailable.",
  },
  channel_router_unreachable: {
    status: 502,
    message: "The channel router could not be reached. Try again.",
  },
  channel_router_rejected: {
    status: 400,
    message: "The channel router refused the request.",
  },
  slack_sender_env_managed: {
    status: 409,
    message: "That Slack member is approved by SLACK_ALLOWED_USERS; remove it there.",
  },
  slack_configuration_token_rejected: {
    status: 400,
    message: "Slack rejected the app configuration token. Generate a new one and try again.",
  },
  slack_app_not_created: {
    status: 400,
    message: "Slack would not create the app in this workspace.",
  },
  slack_unreachable: {
    status: 503,
    message: "Slack could not be reached. Check the network connection and try again.",
  },
  slack_install_port_unavailable: {
    status: 503,
    message: "No local port was free for Slack's install redirect.",
  },
  slack_install_not_ready: {
    status: 409,
    message: "The Slack install has not been approved in the browser yet.",
  },
  channel_identity_not_found: {
    status: 404,
    message: "There is no saved connection to switch. Set it up again.",
  },
  slack_app_not_finished: {
    status: 502,
    message: "Slack did not finish setting up the app. Paste the app-level token again to retry.",
  },
};

/** The error envelope, the one ServiceHub forwards unchanged. */
export const SandboxManagerHostApiErrorSchema = z
  .object({
    error: z
      .object({
        code: SandboxManagerHostApiErrorCodeSchema,
        message: z.string(),
        // Which Slack token failed and why, on the two Slack verification codes, so the form can mark
        // the offending field. `slack_error` is Slack's own error name, never anything the caller sent.
        scope: z.enum(["bot", "app"]).optional(),
        reason: z.enum(["invalid", "unreachable"]).optional(),
        slack_error: z.string().regex(/^[a-z_]{1,64}$/).optional(),
      })
      .strict()
      .refine(
        (error) => error.message === SANDBOX_MANAGER_HOST_API_ERRORS[error.code].message,
        "the message is the code's fixed sentence"
      ),
  })
  .strict();
export type SandboxManagerHostApiError = z.infer<typeof SandboxManagerHostApiErrorSchema>;
