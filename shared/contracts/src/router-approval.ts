/**
 * The router's side of the approval chain (EG2-7, design sections 6.3 and 6.5).
 *
 * The router's control API has two bearers. The ADMIN token stays with the Sandbox Manager. The
 * SCOPED token goes to file_tool, where openwork-server and the agent's tools run: it may read the
 * router's status and send, and nothing else. A scoped send to the conversation the request came
 * from, or to a conversation the router has bound to the workspace, needs no approval. Any other
 * target is held as a `router.send_new_target` approval, listed on the router's admin endpoint,
 * decided in the desktop app and released by a grant the Sandbox Manager signs.
 *
 * The router's admin endpoint speaks the Connector's wire (`GET /v1/admin/approvals`,
 * `POST /v1/admin/grants`, `POST /v1/admin/decisions`, the Connector's admin error table), so the
 * grant, decision, accepted and error schemas are `egress-approval-grant.ts`'s. Only what differs
 * is here: the pending entry, the digest, the sealed config and the scoped token's route table.
 *
 * The caller of a held send is `agent`: the agent's own `opencode_router_send` tool. A send from the
 * desktop app uses the admin token through the Sandbox Manager and is never held.
 *
 * Host-side only: it uses `node:crypto` through `egress-approval-grant.ts`.
 */
import { createHash } from "node:crypto";
import { z } from "zod";

import { canonicalJson } from "./connector-ipc.js";
import {
  ConnectorApprovalProviderConfigSchema,
  EGRESS_APPROVAL_GRANT_RULES,
  approvalGrantSchemaFor,
} from "./egress-approval-grant.js";
import { CorrelationIdSchema } from "./correlation-id.js";
import {
  EgressApprovalActionSchema,
  EgressApprovalAudienceSchema,
  EgressApprovalCallerSchema,
} from "./sandbox-manager-host-api.js";

export const ROUTER_APPROVAL_CHANNELS = ["slack", "telegram"] as const;
export const RouterApprovalChannelSchema = z.enum(ROUTER_APPROVAL_CHANNELS);

/**
 * What a router and a signer need that a JSON Schema cannot say. `conversation_id_max_chars` is the
 * bound on the target's conversation id; `target_max_chars` is `channel:conversation_id`.
 * `scoped_routes` is the whole of what the scoped token may call (`GET /health` takes no token); a route not listed is refused 403
 * with `scoped_token_forbidden`. `scoped_send_rejects` are `POST /send` body fields refused for the
 * scoped token whatever their value: `autoBind` writes a binding.
 */
export const ROUTER_APPROVAL_RULES = {
  conversation_id_max_chars: 256,
  target_max_chars: 265,
  digest_input_keys: ["channel", "conversation_id"],
  scoped_routes: [
    { method: "GET", path: "/bindings" },
    { method: "GET", path: "/identities/slack" },
    { method: "GET", path: "/identities/telegram" },
    { method: "POST", path: "/send" },
  ],
  scoped_send_rejects: ["autoBind"],
  no_approval_reasons: ["current_conversation", "bound_conversation"],
} as const;

/**
 * The digest of a `router.send_new_target` request: the lowercase sha256 of the UTF-8 bytes of the
 * canonical JSON (sorted keys, no whitespace) of `{channel, conversation_id}`. The router computes it
 * when it holds the send; the Sandbox Manager copies it into the grant and never computes one. The
 * Slack identity is not part of it: the operator approves a conversation, not a bot.
 */
export function routerSendRequestDigest(channel: string, conversationId: string): string {
  return createHash("sha256")
    .update(canonicalJson({ channel, conversation_id: conversationId }), "utf8")
    .digest("hex");
}

/** The router's grant: the Connector's fields for the `router` audience and its one action. */
export const RouterApprovalGrantSchema = approvalGrantSchemaFor(
  EgressApprovalAudienceSchema.extract(["router"]),
  EgressApprovalActionSchema.extract(["router.send_new_target"]),
  z.literal("once")
);
export type RouterApprovalGrant = z.infer<typeof RouterApprovalGrantSchema>;

/** The router's pending entry: the Connector's, for a `router.send_new_target`. */
export const RouterAdminPendingApprovalSchema = z
  .object({
    approval_id: CorrelationIdSchema,
    audience: EgressApprovalAudienceSchema.extract(["router"]),
    action: EgressApprovalActionSchema.extract(["router.send_new_target"]),
    caller: EgressApprovalCallerSchema.extract(["agent"]),
    target: z.string().min(3).max(ROUTER_APPROVAL_RULES.target_max_chars),
    request_digest: z.string().regex(/^[0-9a-f]{64}$/),
    requested_at_ms: z.number().int().positive(),
    expires_at_ms: z.number().int().positive(),
  })
  .strict();

export const RouterAdminPendingListSchema = z
  .object({
    approvals: z.array(RouterAdminPendingApprovalSchema).max(EGRESS_APPROVAL_GRANT_RULES.admin_max_pending),
  })
  .strict();

/** The approval section of the router's config, written at each start; the same shape as the Connector's. */
export const RouterApprovalConfigSchema = ConnectorApprovalProviderConfigSchema;
export type RouterApprovalConfig = z.infer<typeof RouterApprovalConfigSchema>;

export const RouterScopedErrorCodeSchema = z.enum([
  "scoped_token_forbidden",
  "approval_denied",
  "approval_expired",
  "approval_unavailable",
  "approval_queue_full",
]);
export type RouterScopedErrorCode = z.infer<typeof RouterScopedErrorCodeSchema>;

/**
 * The status and the one fixed sentence the router answers a scoped send or call with, as
 * `{ ok: false, code, error }`. The agent's tool shows the sentence, so each says where the operator
 * acts.
 */
export const ROUTER_SCOPED_ERRORS: {
  readonly [C in RouterScopedErrorCode]: { readonly status: number; readonly message: string };
} = {
  scoped_token_forbidden: { status: 403, message: "This credential may only read status and send messages." },
  approval_denied: {
    status: 403,
    message: "The message was not sent: the approval in the SuperClaw desktop app was denied.",
  },
  approval_expired: {
    status: 408,
    message:
      "The message was not sent: sending to a new conversation needs approval in the SuperClaw desktop app, and it was not approved in time.",
  },
  approval_unavailable: {
    status: 503,
    message: "The message was not sent: approvals are not available, so this conversation cannot be approved.",
  },
  approval_queue_full: {
    status: 429,
    message: "The message was not sent: too many approvals are waiting in the SuperClaw desktop app.",
  },
};

/**
 * The router's fixed test vector, signed with the key of `EGRESS_APPROVAL_GRANT_VECTOR` (a test key
 * with seed bytes 0 to 31) for the TypeScript tests here and in the router and for the Python ones.
 * `grant` is the grant the router would hold for `digest_rows[0]`.
 */
export const ROUTER_APPROVAL_VECTOR = {
  test_only: true,
  grant: {
    contract_version: 1,
    grant_id: "grant-golden-0002",
    approval_id: "approval-golden-0002",
    audience: "router",
    boot_id: "sm-boot-golden-0001",
    action: "router.send_new_target",
    request_digest: "247ec9111de407eca7cb38a79f2e2fb112e5328391b6418b3f47a199ce96f954",
    scope: { kind: "once" },
    issued_at_ms: 1_800_000_000_000,
    expires_at_ms: 1_800_000_090_000,
  },
  canonical_payload:
    '{"action":"router.send_new_target","approval_id":"approval-golden-0002","audience":"router","boot_id":"sm-boot-golden-0001","contract_version":1,"expires_at_ms":1800000090000,"grant_id":"grant-golden-0002","issued_at_ms":1800000000000,"request_digest":"247ec9111de407eca7cb38a79f2e2fb112e5328391b6418b3f47a199ce96f954","scope":{"kind":"once"}}',
  token:
    "eyJhY3Rpb24iOiJyb3V0ZXIuc2VuZF9uZXdfdGFyZ2V0IiwiYXBwcm92YWxfaWQiOiJhcHByb3ZhbC1nb2xkZW4tMDAwMiIsImF1ZGllbmNlIjoicm91dGVyIiwiYm9vdF9pZCI6InNtLWJvb3QtZ29sZGVuLTAwMDEiLCJjb250cmFjdF92ZXJzaW9uIjoxLCJleHBpcmVzX2F0X21zIjoxODAwMDAwMDkwMDAwLCJncmFudF9pZCI6ImdyYW50LWdvbGRlbi0wMDAyIiwiaXNzdWVkX2F0X21zIjoxODAwMDAwMDAwMDAwLCJyZXF1ZXN0X2RpZ2VzdCI6IjI0N2VjOTExMWRlNDA3ZWNhN2NiMzhhNzlmMmUyZmIxMTJlNTMyODM5MWI2NDE4YjNmNDdhMTk5Y2U5NmY5NTQiLCJzY29wZSI6eyJraW5kIjoib25jZSJ9fQ.LCqCJutjuIbiqz-877be8zb--EiD6Uada3czMVkOrY29RXwMa35obBstAjDt6H1I_yJkebXsO59Uta-5YgDZCg",
  digest_rows: [
    {
      channel: "slack",
      conversation_id: "C0123456789",
      canonical_input: '{"channel":"slack","conversation_id":"C0123456789"}',
      digest: "247ec9111de407eca7cb38a79f2e2fb112e5328391b6418b3f47a199ce96f954",
    },
    {
      channel: "telegram",
      conversation_id: "-1001234567890",
      canonical_input: '{"channel":"telegram","conversation_id":"-1001234567890"}',
      digest: "603228ff0948edceda621d5140340636119cd961f650596aa3358cab8f4445b2",
    },
    {
      channel: "slack",
      conversation_id: "C0123456789/1700000000.000100",
      canonical_input: '{"channel":"slack","conversation_id":"C0123456789/1700000000.000100"}',
      digest: "90f9cf5cd3751fb3273282b4c6b10c3204782aab525ba68940d9c096d58d1a9e",
    },
  ],
} as const satisfies {
  test_only: true;
  grant: z.input<typeof RouterApprovalGrantSchema>;
  canonical_payload: string;
  token: string;
  digest_rows: readonly { channel: string; conversation_id: string; canonical_input: string; digest: string }[];
};
