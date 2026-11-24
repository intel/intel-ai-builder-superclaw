/**
 * The approval grant (EG1-7, design section 6.3): what the Sandbox Manager signs when an operator
 * approves a held request, and what the party that held it checks before it lets the request go.
 *
 * Flow: the Connector holds a `connector.fetch_result` for a URL outside the session's list and lists
 * it on its admin endpoint; the Sandbox Manager long-polls that list, the operator decides, and the
 * Sandbox Manager delivers either a signed grant or an unsigned denial. A grant is the only thing that
 * releases a held request. The Sandbox Manager generates an Ed25519 key per start, keeps the private
 * half in memory and seals the public half, a `boot_id` and an admin secret into the Connector's
 * `connector-provider.json`.
 *
 * This version carries one action, `connector.fetch_result`, once or for the rest of its chat
 * (`all_for_chat`, which the Connector keeps in memory). The design names four more, and
 * each joins as an added member together with its digest rule and its vector: a digest rule nobody
 * implemented is one nobody tested. A verifier refuses an action it does not know.
 *
 * Host-side only. It uses `node:crypto` to sign and verify, so the frontend never imports it.
 */
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { z } from "zod";

import { CONNECTOR_IPC_MAX_URL_CHARS, canonicalJson } from "./connector-ipc.js";
import { CorrelationIdSchema } from "./correlation-id.js";
import {
  EGRESS_APPROVAL_SESSION_REF_LABEL,
  EgressApprovalActionSchema,
  EgressApprovalAudienceSchema,
  EgressApprovalCallerSchema,
  EgressApprovalGrantScopeSchema,
  EgressApprovalSessionRefSchema,
} from "./sandbox-manager-host-api.js";

export const EGRESS_APPROVAL_GRANT_CONTRACT_VERSION = 1 as const;

/**
 * What a verifier or a sender needs and a JSON Schema cannot say, published for the Python side.
 *
 * `verifier_checks` is the order a verifier works in. The first four are what
 * `decodeEgressApprovalGrantToken` does, in its order; the rest are the verifier's own, because only
 * it knows its name, its boot, its clock and the request it holds. `approval_id` names the held
 * request and is the lookup key; `request_digest` is then compared with that request's. Looking the
 * request up by digest would let a grant for one approval release another that holds the same URL.
 * `scope` refuses a scope the held request was not offered. `once_unused` comes last because it
 * consumes the grant: nothing refused earlier may use it up.
 *
 * `verifier` states the rules as values, so a verifier in another language reads them instead of
 * inferring them from this file's comments. The one that is easy to get wrong:
 * `canonical_form_compares: "validated_model"`. Re-serialize the grant after it has passed the
 * schema, strictly, and compare it with the received bytes. Canonicalizing the raw parse instead
 * would accept `1800000000000.0`, which a lax integer coercion turns into an integer.
 *
 * A grant is usable while `issued_at_ms <= now_ms < expires_at_ms` on the one host clock both
 * sides read: there is no skew allowance, because there is one clock.
 *
 * `admin_target_max_chars` is 4097 because a request URL is at most 4096 characters and
 * `normalized_url` adds a `/` to an empty path. The bound counts UTF-16 units in Zod and code points
 * in the generated Pydantic, as `sandbox-manager-host-api.ts` explains for display text; the
 * Connector counts as Zod does.
 */
export const EGRESS_APPROVAL_GRANT_RULES = {
  signing_label: "superclaw-approval-grant-v1\n",
  max_lifetime_ms: 120_000,
  max_token_chars: 2048,
  signature_chars: 86,
  public_key_chars: 43,
  admin_secret_chars: 43,
  admin_secret_header: "X-SuperClaw-Admin-Secret",
  admin_max_request_bytes: 4096,
  admin_max_wait_ms: 20_000,
  admin_max_pending: 64,
  admin_target_max_chars: CONNECTOR_IPC_MAX_URL_CHARS + 1,
  decode_failure_reasons: ["malformed_token", "bad_signature", "invalid_grant", "not_canonical"],
  verifier_checks: [
    "token_form",
    "signature",
    "schema",
    "canonical_form",
    "audience",
    "boot_id",
    "time_window",
    "approval_id",
    "request_digest",
    "scope",
    "once_unused",
  ],
  verifier: {
    canonical_json: { sort_keys: true, separators: [",", ":"], ensure_ascii: false },
    canonical_form_compares: "validated_model",
    integer_fields_strict: true,
    base64url: { padding: false, reencode_and_compare: true },
    time_window: { issued_at_inclusive: true, expires_at_exclusive: true, skew_ms: 0 },
    approval_id_is_lookup_key: true,
    request_digest_equals_held_request: true,
    once_set_retained_until: "expires_at_ms",
    admin_authenticates_before_parsing_body: true,
  },
} as const;

const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);
const EpochMsSchema = z.number().int().positive();

/**
 * One grant shape per audience: the same fields, a different audience, action and scope kinds. Each
 * audience has its own schema, so a grant for one audience is not valid as another's (EG2-7 adds the
 * router's in `router-approval.ts`).
 */
export function approvalGrantSchemaFor<
  Audience extends z.ZodType<string>,
  Action extends z.ZodType<string>,
  ScopeKind extends z.ZodType<string>,
>(audience: Audience, action: Action, scopeKind: ScopeKind) {
  return z
    .object({
      contract_version: z.literal(EGRESS_APPROVAL_GRANT_CONTRACT_VERSION),
      grant_id: CorrelationIdSchema,
      approval_id: CorrelationIdSchema,
      audience,
      boot_id: CorrelationIdSchema,
      action,
      request_digest: Sha256HexSchema,
      scope: z.object({ kind: scopeKind }).strict(),
      issued_at_ms: EpochMsSchema,
      expires_at_ms: EpochMsSchema,
    })
    .strict()
    .refine(
      (grant) =>
        grant.expires_at_ms > grant.issued_at_ms &&
        grant.expires_at_ms - grant.issued_at_ms <= EGRESS_APPROVAL_GRANT_RULES.max_lifetime_ms,
      `a grant lives 1 to ${EGRESS_APPROVAL_GRANT_RULES.max_lifetime_ms} ms; a JSON Schema cannot say this`
    );
}

export const EgressApprovalGrantSchema = approvalGrantSchemaFor(
  EgressApprovalAudienceSchema.extract(["connector"]),
  EgressApprovalActionSchema.extract(["connector.fetch_result"]),
  EgressApprovalGrantScopeSchema
);
export type EgressApprovalGrant = z.infer<typeof EgressApprovalGrantSchema>;

/** `base64url(payload).base64url(signature)`, unpadded; the signature is 64 bytes, so 86 characters. */
export const EgressApprovalGrantTokenSchema = z
  .string()
  .max(EGRESS_APPROVAL_GRANT_RULES.max_token_chars)
  .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{86}$/);

/** 32 bytes as 43 unpadded base64url characters: the last character's two spare bits are zero. */
export const Base64Url32Schema = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);

/** The approval part of the Connector's sealed `connector-provider.json`, written at each start. */
export const ConnectorApprovalProviderConfigSchema = z
  .object({
    approval_public_key: Base64Url32Schema,
    boot_id: CorrelationIdSchema,
    admin_secret: Base64Url32Schema,
  })
  .strict();
export type ConnectorApprovalProviderConfig = z.infer<typeof ConnectorApprovalProviderConfigSchema>;

/**
 * The digest of a `connector.fetch_result` request: the lowercase sha256 of the UTF-8 bytes of the
 * normalized URL, as `connector_fetch.normalized_url` produces it. The Connector computes it when it
 * holds the request and lists it; the Sandbox Manager copies it into the grant and never computes one.
 */
export function fetchResultRequestDigest(normalizedUrl: string): string {
  return createHash("sha256").update(normalizedUrl, "utf8").digest("hex");
}

export function canonicalGrantJson(grant: EgressApprovalGrant): string {
  return canonicalJson(grant);
}

const SPKI_ED25519_PREFIX_HEX = "302a300506032b6570032100";
const PKCS8_ED25519_PREFIX_HEX = "302e020100300506032b657004220420";

// Plain `Uint8Array`s throughout: the `Buffer` and `Uint8Array` declarations of @types/node 20 and this
// TypeScript disagree, so a `Buffer` does not type-check as an argument to the crypto calls.
const fromBase64Url = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "base64url"));
const toBase64Url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

function signingInput(payload: Uint8Array): Uint8Array {
  const label = new TextEncoder().encode(EGRESS_APPROVAL_GRANT_RULES.signing_label);
  const input = new Uint8Array(label.length + payload.length);
  input.set(label, 0);
  input.set(payload, label.length);
  return input;
}

/** Signs a grant with an Ed25519 private key given as its 32-byte seed in hex. */
export function encodeEgressApprovalGrantToken(grant: EgressApprovalGrant, seedHex: string): string;
export function encodeEgressApprovalGrantToken<S extends AnyGrantSchema>(
  grant: z.input<S>,
  seedHex: string,
  schema: S
): string;
export function encodeEgressApprovalGrantToken(
  grant: unknown,
  seedHex: string,
  schema: AnyGrantSchema = EgressApprovalGrantSchema
): string {
  const payload = new TextEncoder().encode(canonicalJson(schema.parse(grant)));
  const key = createPrivateKey({
    key: Buffer.from(PKCS8_ED25519_PREFIX_HEX + seedHex, "hex"),
    format: "der",
    type: "pkcs8",
  });
  const signature = new Uint8Array(sign(null, signingInput(payload), key));
  return `${toBase64Url(payload)}.${toBase64Url(signature)}`;
}

export type EgressApprovalGrantDecodeFailure = (typeof EGRESS_APPROVAL_GRANT_RULES.decode_failure_reasons)[number];

export type EgressApprovalGrantDecoded<G = EgressApprovalGrant> =
  | { ok: true; grant: G }
  | { ok: false; reason: EgressApprovalGrantDecodeFailure };

const failure = (
  reason: EgressApprovalGrantDecodeFailure
): { ok: false; reason: EgressApprovalGrantDecodeFailure } => ({ ok: false, reason });

/** A grant schema of any audience, as `approvalGrantSchemaFor` builds it. */
type AnyGrantSchema = ReturnType<typeof approvalGrantSchemaFor>;

/**
 * The structural half of a verifier: signature, then schema, then canonical form. Never throws on
 * a token; the reason it gives is for the verifier's own log, and the Connector answers every
 * failure with the one `grant_rejected`.
 *
 * The signature is checked over the payload bytes as received, before they are parsed. A grant that
 * parses but is not in canonical form is refused, so one grant has exactly one valid encoding.
 *
 * `schema` is the audience's grant schema; it defaults to the Connector's.
 */
export function decodeEgressApprovalGrantToken(token: string, publicKey: string): EgressApprovalGrantDecoded;
export function decodeEgressApprovalGrantToken<S extends AnyGrantSchema>(
  token: string,
  publicKey: string,
  schema: S
): EgressApprovalGrantDecoded<z.infer<S>>;
export function decodeEgressApprovalGrantToken(
  token: string,
  publicKey: string,
  schema: AnyGrantSchema = EgressApprovalGrantSchema
): EgressApprovalGrantDecoded<unknown> {
  if (!EgressApprovalGrantTokenSchema.safeParse(token).success) return failure("malformed_token");
  const [payloadPart, signaturePart] = token.split(".") as [string, string];
  const payload = fromBase64Url(payloadPart);
  const signature = fromBase64Url(signaturePart);
  // Node accepts base64url with stray trailing bits; a token that is not exactly what encode emits is not one.
  if (toBase64Url(payload) !== payloadPart || toBase64Url(signature) !== signaturePart) {
    return failure("malformed_token");
  }
  const key = createPublicKey({
    key: Buffer.from(SPKI_ED25519_PREFIX_HEX + Buffer.from(publicKey, "base64url").toString("hex"), "hex"),
    format: "der",
    type: "spki",
  });
  if (!verify(null, signingInput(payload), key, signature)) return failure("bad_signature");
  let text: string;
  let parsed: unknown;
  try {
    // `ignoreBOM: true` keeps a leading byte order mark in the text, where JSON.parse refuses it. By
    // default the decoder drops it, and bytes with a BOM would then decode as a second encoding of
    // the same grant that a Python verifier (`json.loads`) rejects.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(payload);
    parsed = JSON.parse(text);
  } catch {
    return failure("invalid_grant");
  }
  const grant = schema.safeParse(parsed);
  if (!grant.success) return failure("invalid_grant");
  if (canonicalJson(grant.data) !== text) return failure("not_canonical");
  return { ok: true, grant: grant.data };
}

/**
 * One request waiting in the Connector, as `GET /v1/admin/approvals` lists it.
 *
 * `target` is the normalized URL, not cleaned for display: the Sandbox Manager removes control and
 * format characters and cuts it before an operator sees it (`EgressApprovalTextSchema` is the check
 * on that output). `request_digest` is the Connector's own, copied into the grant unchanged.
 *
 * `grant_scopes` are the scopes the Connector accepts a grant for: `once` always, `all_for_chat` only
 * when the caller named the chat's root session. `session_ref` names the chat it is held for: the
 * root session's, else the request's own session's.
 */
export const ConnectorAdminPendingApprovalSchema = z
  .object({
    approval_id: CorrelationIdSchema,
    audience: EgressApprovalAudienceSchema.extract(["connector"]),
    action: EgressApprovalActionSchema.extract(["connector.fetch_result"]),
    caller: EgressApprovalCallerSchema.extract(["agent"]),
    target: z.string().min(1).max(EGRESS_APPROVAL_GRANT_RULES.admin_target_max_chars),
    request_digest: Sha256HexSchema,
    requested_at_ms: EpochMsSchema,
    expires_at_ms: EpochMsSchema,
    grant_scopes: z.array(EgressApprovalGrantScopeSchema).min(1).max(3),
    session_ref: EgressApprovalSessionRefSchema,
  })
  .strict()
  .refine((entry) => entry.grant_scopes.includes("once"), { message: "once is always offered" });

/** Oldest first. Never carries a grant or the admin secret. */
export const ConnectorAdminPendingListSchema = z
  .object({
    approvals: z.array(ConnectorAdminPendingApprovalSchema).max(EGRESS_APPROVAL_GRANT_RULES.admin_max_pending),
  })
  .strict();

/** `POST /v1/admin/grants`. */
export const ConnectorAdminGrantRequestSchema = z
  .object({ grant: EgressApprovalGrantTokenSchema })
  .strict();

/**
 * `POST /v1/admin/decisions`. A denial is unsigned: it only removes authority, so the admin secret
 * is enough. Whoever holds the secret can deny an approval, never grant one.
 */
export const ConnectorAdminDecisionRequestSchema = z
  .object({ approval_id: CorrelationIdSchema, decision: z.literal("denied") })
  .strict();

/**
 * `POST /v1/admin/chat-grants/forget`: the user switched "Allowed for this chat" off. Unsigned, as a
 * denial is: forgetting the chat only removes authority, and its next page outside the search results
 * is held again. Accepted whether or not the Connector knew the chat.
 */
export const ConnectorAdminChatForgetRequestSchema = z
  .object({ session_ref: EgressApprovalSessionRefSchema })
  .strict();

/** The 200 body of every `POST` route. */
export const ConnectorAdminAcceptedSchema = z.object({ accepted: z.literal(true) }).strict();

export const ConnectorAdminErrorCodeSchema = z.enum([
  "admin_authentication_failed",
  "invalid_request",
  "grant_rejected",
  "approval_not_pending",
  "grant_superseded",
]);
export type ConnectorAdminErrorCode = z.infer<typeof ConnectorAdminErrorCodeSchema>;

/**
 * Status and the one fixed sentence per code. `grant_rejected` gives no reason, so that a probe
 * learns nothing about which check it failed; the Connector's audit line and diag carry the reason.
 * `grant_superseded` is a grant naming an approval id that a chat forget retired: the Connector held
 * the chat's waiting requests again under new ids, so nothing is admitted and the user decides again.
 */
export const CONNECTOR_ADMIN_ERRORS: {
  readonly [C in ConnectorAdminErrorCode]: { readonly status: number; readonly message: string };
} = {
  admin_authentication_failed: { status: 401, message: "The admin secret is missing or wrong." },
  invalid_request: { status: 400, message: "The request is not one this endpoint accepts." },
  grant_rejected: { status: 400, message: "The grant was not accepted." },
  approval_not_pending: { status: 404, message: "No pending approval has that id." },
  grant_superseded: {
    status: 409,
    message: "The chat was switched off while this grant was handled; decide again.",
  },
};

export const ConnectorAdminErrorSchema = z
  .object({
    error: z
      .object({ code: ConnectorAdminErrorCodeSchema, message: z.string() })
      .strict()
      .refine(
        (error) => error.message === CONNECTOR_ADMIN_ERRORS[error.code].message,
        "the message is the code's fixed sentence"
      ),
  })
  .strict();

/**
 * The fixed test vector, for the TypeScript test here and for the Python verifier's. The key is a
 * test key: its seed is the bytes 0 to 31 and no build uses it. The grant is the one the Connector
 * would hold for `digest_rows[0]`. Ed25519 signs deterministically, so the token is reproducible.
 *
 * `digest_rows` were produced by `connector_fetch.normalized_url`, not by this module: a row with a
 * `null` normalized form is a URL the Connector refuses, which has no digest.
 */
export const EGRESS_APPROVAL_GRANT_VECTOR = {
  test_only: true,
  note: "A test key: its seed is the bytes 0 to 31, it is public, and no build signs or trusts anything with it.",
  test_private_key_seed_hex: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  public_key: "A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg",
  grant: {
    contract_version: 1,
    grant_id: "grant-golden-0001",
    approval_id: "approval-golden-0001",
    audience: "connector",
    boot_id: "sm-boot-golden-0001",
    action: "connector.fetch_result",
    request_digest: "dc692518116ebd48a870570c53df2aac07f559f8c8f7c6517ee181bc9052edbf",
    scope: { kind: "once" },
    issued_at_ms: 1_800_000_000_000,
    expires_at_ms: 1_800_000_090_000,
  },
  canonical_payload:
    '{"action":"connector.fetch_result","approval_id":"approval-golden-0001","audience":"connector","boot_id":"sm-boot-golden-0001","contract_version":1,"expires_at_ms":1800000090000,"grant_id":"grant-golden-0001","issued_at_ms":1800000000000,"request_digest":"dc692518116ebd48a870570c53df2aac07f559f8c8f7c6517ee181bc9052edbf","scope":{"kind":"once"}}',
  token:
    "eyJhY3Rpb24iOiJjb25uZWN0b3IuZmV0Y2hfcmVzdWx0IiwiYXBwcm92YWxfaWQiOiJhcHByb3ZhbC1nb2xkZW4tMDAwMSIsImF1ZGllbmNlIjoiY29ubmVjdG9yIiwiYm9vdF9pZCI6InNtLWJvb3QtZ29sZGVuLTAwMDEiLCJjb250cmFjdF92ZXJzaW9uIjoxLCJleHBpcmVzX2F0X21zIjoxODAwMDAwMDkwMDAwLCJncmFudF9pZCI6ImdyYW50LWdvbGRlbi0wMDAxIiwiaXNzdWVkX2F0X21zIjoxODAwMDAwMDAwMDAwLCJyZXF1ZXN0X2RpZ2VzdCI6ImRjNjkyNTE4MTE2ZWJkNDhhODcwNTcwYzUzZGYyYWFjMDdmNTU5ZjhjOGY3YzY1MTdlZTE4MWJjOTA1MmVkYmYiLCJzY29wZSI6eyJraW5kIjoib25jZSJ9fQ.-ceQ0hGiTtcAtChyfGlgw-QZ-e8SlzwQWoFoV9o9k_3DmIyF24wM1aKYg0wlXF56p8Rjkdv3ot14WpOzGLyHAQ",
  digest_rows: [
    {
      url: "https://Example.COM:443/Docs/Page?q=1#frag",
      normalized: "https://example.com/Docs/Page?q=1",
      digest: "dc692518116ebd48a870570c53df2aac07f559f8c8f7c6517ee181bc9052edbf",
    },
    {
      url: "http://example.com:80/",
      normalized: "http://example.com/",
      digest: "2a1b402420ef46577471cdc7409b0fa2c6a204db316e59ade2d805435489a067",
    },
    {
      url: "https://example.com:8443/a%20b?x=%2F&y=é",
      normalized: "https://example.com:8443/a%20b?x=%2F&y=é",
      digest: "79cf60efb22f228935a0b8b139acc9169d7ac5bb17c8816c7ed05cbec3b6959b",
    },
    {
      url: "HTTP://Example.com",
      normalized: "http://example.com/",
      digest: "2a1b402420ef46577471cdc7409b0fa2c6a204db316e59ade2d805435489a067",
    },
    { url: "ftp://example.com/file", normalized: null, digest: null },
    { url: "https://", normalized: null, digest: null },
  ],
} as const satisfies {
  test_only: true;
  note: string;
  test_private_key_seed_hex: string;
  public_key: string;
  grant: EgressApprovalGrant;
  canonical_payload: string;
  token: string;
  digest_rows: readonly { url: string; normalized: string | null; digest: string | null }[];
};

/**
 * The `all_for_chat` counterpart of the vector above: the same key, the same held request, another
 * approval. (`grant-golden-0003` is the egress proxy's, in #3547.)
 */
export const EGRESS_APPROVAL_GRANT_CHAT_VECTOR = {
  grant: {
    contract_version: 1,
    grant_id: "grant-golden-0004",
    approval_id: "approval-golden-0004",
    audience: "connector",
    boot_id: "sm-boot-golden-0001",
    action: "connector.fetch_result",
    request_digest: "dc692518116ebd48a870570c53df2aac07f559f8c8f7c6517ee181bc9052edbf",
    scope: { kind: "all_for_chat" },
    issued_at_ms: 1_800_000_000_000,
    expires_at_ms: 1_800_000_090_000,
  },
  canonical_payload:
    '{"action":"connector.fetch_result","approval_id":"approval-golden-0004","audience":"connector","boot_id":"sm-boot-golden-0001","contract_version":1,"expires_at_ms":1800000090000,"grant_id":"grant-golden-0004","issued_at_ms":1800000000000,"request_digest":"dc692518116ebd48a870570c53df2aac07f559f8c8f7c6517ee181bc9052edbf","scope":{"kind":"all_for_chat"}}',
  token:
    "eyJhY3Rpb24iOiJjb25uZWN0b3IuZmV0Y2hfcmVzdWx0IiwiYXBwcm92YWxfaWQiOiJhcHByb3ZhbC1nb2xkZW4tMDAwNCIsImF1ZGllbmNlIjoiY29ubmVjdG9yIiwiYm9vdF9pZCI6InNtLWJvb3QtZ29sZGVuLTAwMDEiLCJjb250cmFjdF92ZXJzaW9uIjoxLCJleHBpcmVzX2F0X21zIjoxODAwMDAwMDkwMDAwLCJncmFudF9pZCI6ImdyYW50LWdvbGRlbi0wMDA0IiwiaXNzdWVkX2F0X21zIjoxODAwMDAwMDAwMDAwLCJyZXF1ZXN0X2RpZ2VzdCI6ImRjNjkyNTE4MTE2ZWJkNDhhODcwNTcwYzUzZGYyYWFjMDdmNTU5ZjhjOGY3YzY1MTdlZTE4MWJjOTA1MmVkYmYiLCJzY29wZSI6eyJraW5kIjoiYWxsX2Zvcl9jaGF0In19.2qhx9ApYIvW3ssU36UEmeLwmZLC2AUFhYmmqZI9GYdgQsKHGE_m3cWA6hJ5OIwmRi10Q6vgIxoW1oRK-EWFzAg",
} as const satisfies { grant: EgressApprovalGrant; canonical_payload: string; token: string };

/**
 * The chat key's label, published for the Python side, and its golden vector: `session_ref` is `sref_`
 * and the first 16 hex characters of sha256(label + session_id) over UTF-8.
 */
export const EGRESS_APPROVAL_SESSION_REF = {
  label: EGRESS_APPROVAL_SESSION_REF_LABEL,
  vector: { session_id: "ses_golden0001", session_ref: "sref_9a59ec8361e9787f" },
} as const;
