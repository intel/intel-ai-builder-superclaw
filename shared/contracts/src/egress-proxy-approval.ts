/**
 * The egress proxy's side of the approval chain (EG2-4b, design sections 6.3 and 6.4).
 *
 * In `enforce` mode the proxy refuses a destination its allowlist does not list. For the shell listener
 * (Runtime's commands and openwork-server) that refusal becomes a question to the user: the proxy holds
 * the request, lists it on its admin endpoint, and the Sandbox Manager's approval broker polls it, asks
 * the desktop app, and signs a grant the proxy checks before it lets the request go. The channel
 * listener never asks: a destination it does not list is refused.
 *
 * Contract: `Sandbox` / `OperationRun` egress wiring. The wire is the Connector's (`egress-approval-grant.ts`):
 * the same admin routes, header, signing label and verifier checks, for the `egress_proxy` audience and
 * the one action `proxy.connect_unlisted`. What differs is the scope a grant carries:
 * `once | all_for_chat` (`EgressApprovalGrantScopeSchema`).
 *
 * "This chat" is the ROOT session of the conversation: a sub-agent session rolls up to its root. A
 * command's chat is told to the proxy in the proxy credential the agent plugin puts in `HTTPS_PROXY`:
 * `sc1.<flavor>.<root session id>` with a MAC under a key the shell cannot read (`session_key`, derived
 * from the Connector's caller key, which is never in the shell's environment). A request without a valid
 * credential is an unknown chat: it can be approved once and gets no chat-scoped grant. A channel-owned
 * root session (Slack, Telegram) has no interactive approver and is refused at once.
 *
 * A chat-scoped grant is a UX scope, not a security boundary, the same as the Connector's web-read grants
 * (#3562). Every chat's commands run as one account in one Job, and code in one chat
 * can drive another chat through the runtime's own server, so the root session id names the chat that
 * asked; it does not keep that chat's grant from code in another. The dialog therefore tells the user the
 * grant covers commands from every chat until SuperClaw restarts, while the proxy still records it per
 * chat. What does hold is the screen: no grant
 * reaches loopback, link-local, host or private addresses. Unlike the web-read grants, which the Sandbox
 * Manager's broker saves, a proxy grant lives only in the proxy's memory and ends when it restarts.
 *
 * Host-side only; the agent plugin restates the credential rules (a deployed Profile carries no package),
 * and the vector below is what keeps the two in step.
 */
import { createHash, createHmac } from "node:crypto";
import { z } from "zod";

import { canonicalJson } from "./connector-ipc.js";
import { CorrelationIdSchema } from "./correlation-id.js";
import {
  ConnectorApprovalProviderConfigSchema,
  EGRESS_APPROVAL_GRANT_RULES,
  EGRESS_APPROVAL_GRANT_VECTOR,
  approvalGrantSchemaFor,
} from "./egress-approval-grant.js";
import {
  EGRESS_APPROVAL_GRANT_SCOPES,
  EGRESS_APPROVAL_SESSION_REF_LABEL,
  EgressApprovalActionSchema,
  EgressApprovalAudienceSchema,
  EgressApprovalCallerSchema,
  EgressApprovalGrantScopeSchema,
  EgressApprovalSessionRefSchema,
} from "./sandbox-manager-host-api.js";

/** The proxy credential's flavours: a desktop chat can be asked, a channel-owned one cannot. */
export const EGRESS_PROXY_SESSION_FLAVORS = { desktop: "d", channel: "c" } as const;

/**
 * Rules a proxy and a plugin share and a JSON Schema cannot say.
 *
 * `session_key` = HMAC-SHA256(caller_key, key_label), unpadded base64url. `username` =
 * `sc1.<flavor>.<root session id>`; `password` = unpadded base64url HMAC-SHA256(session_key,
 * mac_label + username). `session_ref` = `sref_` + the first 16 hex of sha256(ref_label + session id): the
 * only form of a session id that reaches an audit line, a digest or the desktop app.
 * `unknown_session_ref` stands for a request with no valid credential. A refusal reason is the audit
 * line's and the 403 body's.
 */
export const EGRESS_PROXY_APPROVAL_RULES = {
  key_label: "superclaw-egress-proxy-session-key-v1",
  mac_label: "superclaw-egress-proxy-session-v1\n",
  ref_label: EGRESS_APPROVAL_SESSION_REF_LABEL,
  username_prefix: "sc1",
  session_id_pattern: "^[A-Za-z0-9_-]{1,128}$",
  unknown_session_ref: "sref_unknown",
  state_path: "/v1/approvals/state",
  hold_ms: EGRESS_APPROVAL_GRANT_RULES.max_lifetime_ms,
  target_max_chars: 265,
  refusal_reasons: [
    "no_interactive_approver",
    "approval_denied",
    "approval_expired",
    "approval_unavailable",
    "approval_queue_full",
  ],
  // The scopes offered for a chat the proxy can name, and for one it cannot.
  scopes_known_chat: EGRESS_APPROVAL_GRANT_SCOPES,
  scopes_unknown_chat: ["once"],
  // What `all_for_chat` never covers: the screen's classes stay refused whatever a user approved.
  never_covered_classes: ["loopback", "link_local", "host_self", "private", "other_non_public"],
} as const;

const SessionIdSchema = z.string().regex(new RegExp(EGRESS_PROXY_APPROVAL_RULES.session_id_pattern));

export function egressProxySessionKey(callerKey: Uint8Array): string {
  return createHmac("sha256", callerKey).update(EGRESS_PROXY_APPROVAL_RULES.key_label, "utf8").digest("base64url");
}

export function egressProxyCredential(
  sessionKey: string,
  flavor: keyof typeof EGRESS_PROXY_SESSION_FLAVORS,
  rootSessionId: string
): { username: string; password: string } {
  const username = `${EGRESS_PROXY_APPROVAL_RULES.username_prefix}.${EGRESS_PROXY_SESSION_FLAVORS[flavor]}.${SessionIdSchema.parse(rootSessionId)}`;
  const password = createHmac("sha256", new Uint8Array(Buffer.from(sessionKey, "base64url")))
    .update(EGRESS_PROXY_APPROVAL_RULES.mac_label + username, "utf8")
    .digest("base64url");
  return { username, password };
}

export function egressProxySessionRef(sessionId: string): string {
  const hex = createHash("sha256").update(EGRESS_PROXY_APPROVAL_RULES.ref_label + sessionId, "utf8").digest("hex");
  return `sref_${hex.slice(0, 16)}`;
}

/**
 * The digest of a `proxy.connect_unlisted` request: the lowercase sha256 of the canonical JSON of
 * `{host, port, session_ref}`. The proxy computes it when it holds the request; the Sandbox Manager
 * copies it into the grant and never computes one. `host` is the canonical lowercase name.
 */
export function proxyConnectRequestDigest(host: string, port: number, sessionRef: string): string {
  return createHash("sha256")
    .update(canonicalJson({ host, port, session_ref: sessionRef }), "utf8")
    .digest("hex");
}

export const EgressProxyApprovalGrantSchema = approvalGrantSchemaFor(
  EgressApprovalAudienceSchema.extract(["egress_proxy"]),
  EgressApprovalActionSchema.extract(["proxy.connect_unlisted"]),
  EgressApprovalGrantScopeSchema
);
export type EgressProxyApprovalGrant = z.infer<typeof EgressProxyApprovalGrantSchema>;

/**
 * The proxy's pending entry: the Connector's shape, with the scopes the user may choose from. `session_ref`
 * names the chat the command is held for; a command whose chat could not be told names none.
 */
export const EgressProxyAdminPendingApprovalSchema = z
  .object({
    approval_id: CorrelationIdSchema,
    audience: EgressApprovalAudienceSchema.extract(["egress_proxy"]),
    action: EgressApprovalActionSchema.extract(["proxy.connect_unlisted"]),
    caller: EgressApprovalCallerSchema.extract(["shell"]),
    target: z.string().min(3).max(EGRESS_PROXY_APPROVAL_RULES.target_max_chars),
    request_digest: z.string().regex(/^[0-9a-f]{64}$/),
    requested_at_ms: z.number().int().positive(),
    expires_at_ms: z.number().int().positive(),
    grant_scopes: z.array(EgressApprovalGrantScopeSchema).min(1).max(3),
    session_ref: EgressApprovalSessionRefSchema.optional(),
  })
  .strict()
  .refine((entry) => entry.grant_scopes.includes("once"), { message: "once is always offered" });

export const EgressProxyAdminPendingListSchema = z
  .object({
    approvals: z.array(EgressProxyAdminPendingApprovalSchema).max(EGRESS_APPROVAL_GRANT_RULES.admin_max_pending),
  })
  .strict();

/** The approval section of the proxy's sealed config: the Connector's three values, one more verifier. */
export const EgressProxyApprovalConfigSchema = ConnectorApprovalProviderConfigSchema;

/** What the proxy answers `GET /v1/approvals/state` with, on the shell listener and without a secret. */
export const EgressProxyApprovalStateSchema = z.object({ approvals: z.boolean() }).strict();

/** Fixed vector, signed with the shared test key (seed bytes 0 to 31); the plugin's tests read it too.
 * Each credential's `mac` is the Basic-auth password the proxy expects (the session MAC). */
export const EGRESS_PROXY_APPROVAL_VECTOR = {
  test_only: true,
  caller_key_b64: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
  session_key: "OtbVGW05EgNIw_RHJgIu1ZGFAuXkmhrg02UAy3hrviM",
  credentials: [
    {
      flavor: "desktop",
      session_id: "ses_golden0001",
      username: "sc1.d.ses_golden0001",
      mac: "vH1m-G2FpqPsNCPo1iTNE1MY4o21AGjecvK1Lt68W-w",
      session_ref: "sref_9a59ec8361e9787f",
    },
    {
      flavor: "channel",
      session_id: "ses_golden0002",
      username: "sc1.c.ses_golden0002",
      mac: "bi5ZOj7wdV_HeTuiqSLzGfqZ8uCPl1-b3a-SuORmqok",
      session_ref: "sref_d3a09b0fc6037f79",
    },
  ],
  digest_rows: [
    {
      host: "example.com",
      port: 443,
      session_ref: "sref_9a59ec8361e9787f",
      digest: "0bb8d9d3c97e726f3fc17d04522428177f323d9f837914aded13fb8ba9d49cfd",
    },
    {
      host: "files.example.org",
      port: 8443,
      session_ref: "sref_d3a09b0fc6037f79",
      digest: "11926dbbc896098a25478a3c946561c560e0f4ae2827a6f6be2ff79427d62b1f",
    },
    {
      host: "example.com",
      port: 443,
      session_ref: "sref_unknown",
      digest: "7371923a3a3a3352bd22f845d491b67e240c2c04c8293263cf9f1ab3317bbeb6",
    },
  ],
  grant: {
    contract_version: 1,
    grant_id: "grant-golden-0003",
    approval_id: "approval-golden-0003",
    audience: "egress_proxy",
    boot_id: "sm-boot-golden-0001",
    action: "proxy.connect_unlisted",
    request_digest: "0bb8d9d3c97e726f3fc17d04522428177f323d9f837914aded13fb8ba9d49cfd",
    scope: { kind: "all_for_chat" },
    issued_at_ms: 1_800_000_000_000,
    expires_at_ms: 1_800_000_090_000,
  },
  canonical_payload:
    '{"action":"proxy.connect_unlisted","approval_id":"approval-golden-0003","audience":"egress_proxy","boot_id":"sm-boot-golden-0001","contract_version":1,"expires_at_ms":1800000090000,"grant_id":"grant-golden-0003","issued_at_ms":1800000000000,"request_digest":"0bb8d9d3c97e726f3fc17d04522428177f323d9f837914aded13fb8ba9d49cfd","scope":{"kind":"all_for_chat"}}',
  token:
    "eyJhY3Rpb24iOiJwcm94eS5jb25uZWN0X3VubGlzdGVkIiwiYXBwcm92YWxfaWQiOiJhcHByb3ZhbC1nb2xkZW4tMDAwMyIsImF1ZGllbmNlIjoiZWdyZXNzX3Byb3h5IiwiYm9vdF9pZCI6InNtLWJvb3QtZ29sZGVuLTAwMDEiLCJjb250cmFjdF92ZXJzaW9uIjoxLCJleHBpcmVzX2F0X21zIjoxODAwMDAwMDkwMDAwLCJncmFudF9pZCI6ImdyYW50LWdvbGRlbi0wMDAzIiwiaXNzdWVkX2F0X21zIjoxODAwMDAwMDAwMDAwLCJyZXF1ZXN0X2RpZ2VzdCI6IjBiYjhkOWQzYzk3ZTcyNmYzZmMxN2QwNDUyMjQyODE3N2YzMjNkOWY4Mzc5MTRhZGVkMTNmYjhiYTlkNDljZmQiLCJzY29wZSI6eyJraW5kIjoiYWxsX2Zvcl9jaGF0In19.SEtWtX68YnniduWFxRveaoHjnkby-d9U394RJ1Mjkv9c5I-0R1qdBqUBAZICthJuFQ1IRni1MLDbkiG36vFxDg",
  public_key: EGRESS_APPROVAL_GRANT_VECTOR.public_key,
} as const;
