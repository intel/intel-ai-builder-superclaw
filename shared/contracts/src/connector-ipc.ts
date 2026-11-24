import { createHash } from "node:crypto";
import { z } from "zod";

import { CorrelationIdSchema } from "./correlation-id.js";

export const CONNECTOR_IPC_CONTRACT_VERSION = 2 as const;
export const CONNECTOR_IPC_MAX_REQUEST_BYTES = 16 * 1024;
export const CONNECTOR_IPC_MAX_RESPONSE_BYTES = 128 * 1024;
export const CONNECTOR_IPC_MAX_QUERY_CHARS = 400;
export const CONNECTOR_IPC_MAX_RESULTS = 8;
export const CONNECTOR_IPC_MAX_URL_CHARS = 4096;

/**
 * What the Connector enforces that a JSON Schema cannot say, published for its Python side.
 *
 * `search_query_url_pattern` is the one grammar for a search query that carries a URL, which
 * the Connector answers with `search_query_carries_url`. It is lexical and ASCII-only; the
 * edges it decides on purpose are in test-fixtures/connector-search-query-cases.json.
 */
export const CONNECTOR_IPC_RULES = {
  fetch_allowed_ports: [80, 443],
  fetch_max_redirects: 5,
  fetch_session_result_ttl_ms: 60 * 60 * 1000,
  fetch_session_results_max: 500,
  approval_hold_ms: 90_000,
  search_query_url_pattern:
    "://|(?:^|[^A-Za-z0-9.-])(?:[A-Za-z0-9-]+\\.)+[A-Za-z][A-Za-z0-9-]*(?::[0-9]+)?/",
} as const;

const KeyIdSchema = z.string().regex(/^(?:caller|response)_[a-z0-9]{16}$/);
const NonceSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const AuthTagSchema = z.string().regex(/^[0-9a-f]{64}$/);
const DeadlineSchema = z.number().int().positive();

export const ConnectorOperationSchema = z.enum([
  "search",
  "health",
  "status",
  "cancel",
  "fetch_result",
]);
export type ConnectorOperation = z.infer<typeof ConnectorOperationSchema>;

export const ConnectorErrorCodeSchema = z.enum([
  "connector_unavailable",
  "connector_timeout",
  "connector_cancelled",
  "provider_unreachable",
  "proxy_configuration_error",
  "response_too_large",
  "invalid_request",
  "authentication_failed",
  "replay_detected",
  "search_query_carries_url",
  "destination_refused",
  "destination_unreachable",
  "destination_http_error",
  "redirect_limit_exceeded",
  "unsupported_content_type",
]);
export type ConnectorErrorCode = z.infer<typeof ConnectorErrorCodeSchema>;

export const ConnectorErrorSchema = z
  .object({
    code: ConnectorErrorCodeSchema,
    retryable: z.boolean(),
  })
  .strict();

/** How a fetch that needed approval ended without the page. Not an error code. */
export const ConnectorApprovalOutcomeSchema = z.enum([
  "approval_required",
  "approval_denied",
  "approval_expired",
]);
export type ConnectorApprovalOutcome = z.infer<typeof ConnectorApprovalOutcomeSchema>;

export const ConnectorApprovalErrorSchema = z
  .object({
    code: ConnectorApprovalOutcomeSchema,
    retryable: z.literal(false),
    approval_id: CorrelationIdSchema,
  })
  .strict();

/** An absolute http or https URL. Which of them the Connector fetches is its decision. */
const ConnectorUrlSchema = z.string().max(CONNECTOR_IPC_MAX_URL_CHARS).regex(/^https?:\/\/\S+$/);

export const ConnectorSearchRequestBodySchema = z
  .object({
    query: z.string().trim().min(1).max(CONNECTOR_IPC_MAX_QUERY_CHARS),
    max_results: z.number().int().min(1).max(CONNECTOR_IPC_MAX_RESULTS),
    // Routes only the DuckDuckGo fallback; omitted by callers that keep keyword routing.
    category: z.enum(["text", "news"]).optional(),
  })
  .strict();

export const ConnectorSearchResultSchema = z
  .object({
    title: z.string().max(512),
    url: z.url().max(4096),
    content: z.string().max(20_000),
    score_percent: z.number().int().min(0).max(100).nullable(),
    source_type: z.string().max(512).nullable(),
  })
  .strict();

const ConnectorSearchDisplaySchema = z
  .object({
    query: z.string().max(CONNECTOR_IPC_MAX_QUERY_CHARS),
    original_query: z.string().max(CONNECTOR_IPC_MAX_QUERY_CHARS),
    as_of: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    query_normalized: z.boolean(),
    failure_message: z.string().max(4096).nullable(),
  })
  .strict();

const ConnectorSearchSuccessResponseBodySchema = z
  .object({
    provider: z.enum(["tavily", "ddgs"]),
    results: z.array(ConnectorSearchResultSchema).max(CONNECTOR_IPC_MAX_RESULTS),
    display: ConnectorSearchDisplaySchema,
    error: z.null(),
  })
  .strict();

const ConnectorSearchFailureResponseBodySchema = z
  .object({
    provider: z.null(),
    results: z.array(z.never()).max(0),
    display: ConnectorSearchDisplaySchema,
    error: ConnectorErrorSchema,
  })
  .strict();

export const ConnectorSearchResponseBodySchema = z.union([
  ConnectorSearchSuccessResponseBodySchema,
  ConnectorSearchFailureResponseBodySchema,
]);

export const ConnectorHealthResponseBodySchema = z
  .object({
    process_ready: z.boolean(),
    network_ready: z.boolean(),
  })
  .strict();

export const ConnectorStatusResponseBodySchema = z
  .object({
    state: z.enum(["starting", "ready", "degraded", "stopping"]),
    active_requests: z.number().int().min(0).max(64),
    last_error: ConnectorErrorCodeSchema.nullable(),
  })
  .strict();

export const ConnectorCancelRequestBodySchema = z
  .object({
    target_request_id: CorrelationIdSchema,
  })
  .strict();

export const ConnectorCancelResponseBodySchema = z
  .object({
    cancelled: z.boolean(),
  })
  .strict();

export const ConnectorFetchResultRequestBodySchema = z
  .object({
    url: ConnectorUrlSchema,
    // Absent: a person may be asked to approve a URL outside the session's list, and the request is
    // held for them. "none": the session has no interactive approver (a Slack or Telegram thread), so
    // the Connector answers `approval_required` at once. A caller can only declare this to be refused
    // sooner, so the field never widens what a request may read.
    approver: z.literal("none").optional(),
    // The root session of the chat this request belongs to, in the envelope's session id grammar. It
    // only names which chat it is: an operator's `all_for_chat` grant for that chat is what lets the
    // Connector admit more, so the field never widens what one request may read by itself.
    root_session_id: CorrelationIdSchema.optional(),
  })
  .strict();

const ConnectorFetchResultSuccessResponseBodySchema = z
  .object({
    url: ConnectorUrlSchema,
    content_type: z.string().min(1).max(255).nullable(),
    // A cheap upper bound in characters, not bytes. The byte limit is on the whole response
    // message (see `responseSchema`); cutting the text to fit it is the Connector's job, and
    // `truncated` says it did.
    text: z.string().max(CONNECTOR_IPC_MAX_RESPONSE_BYTES),
    truncated: z.boolean(),
    redirects: z.number().int().min(0).max(CONNECTOR_IPC_RULES.fetch_max_redirects),
    error: z.null(),
  })
  .strict();

// `http_status` is set exactly when the code is `destination_http_error`. It is two shapes rather
// than a refinement so that the generated JSON Schema and Pydantic enforce it too.
const ConnectorFetchResultHttpErrorResponseBodySchema = z
  .object({
    error: z
      .object({
        code: z.literal("destination_http_error"),
        retryable: z.boolean(),
      })
      .strict(),
    http_status: z.number().int().min(100).max(599),
  })
  .strict();

const ConnectorFetchResultOtherFailureResponseBodySchema = z
  .object({
    error: z.union([
      z
        .object({
          code: ConnectorErrorCodeSchema.exclude(["destination_http_error"]),
          retryable: z.boolean(),
        })
        .strict(),
      ConnectorApprovalErrorSchema,
    ]),
    http_status: z.null(),
  })
  .strict();

export const ConnectorFetchResultResponseBodySchema = z.union([
  ConnectorFetchResultSuccessResponseBodySchema,
  ConnectorFetchResultHttpErrorResponseBodySchema,
  ConnectorFetchResultOtherFailureResponseBodySchema,
]);

const RequestEnvelopeShape = {
  contract_version: z.literal(CONNECTOR_IPC_CONTRACT_VERSION),
  direction: z.literal("request"),
  caller_key_id: KeyIdSchema,
  boot_id: CorrelationIdSchema,
  session_id: CorrelationIdSchema,
  request_id: CorrelationIdSchema,
  nonce: NonceSchema,
  deadline_ms: DeadlineSchema,
  auth_tag: AuthTagSchema,
};

const ResponseEnvelopeShape = {
  contract_version: z.literal(CONNECTOR_IPC_CONTRACT_VERSION),
  direction: z.literal("response"),
  caller_key_id: KeyIdSchema,
  response_key_id: KeyIdSchema,
  boot_id: CorrelationIdSchema,
  session_id: CorrelationIdSchema,
  request_id: CorrelationIdSchema,
  nonce: NonceSchema,
  deadline_ms: DeadlineSchema,
  auth_tag: AuthTagSchema,
};

const requestSchema = <TOperation extends ConnectorOperation, TBody extends z.ZodType>(
  operation: TOperation,
  body: TBody,
) =>
  z
    .object({
      ...RequestEnvelopeShape,
      operation: z.literal(operation),
      body,
    })
    .strict();

// The Connector refuses a response whose canonical JSON is over the limit, counted in UTF-8 bytes
// of the whole message, so the schema refuses it too. A JSON Schema cannot say this; the
// generated Pydantic does not, and the Connector's own check is the enforcement there.
const responseSchema = <TOperation extends ConnectorOperation, TBody extends z.ZodType>(
  operation: TOperation,
  body: TBody,
) =>
  z
    .object({
      ...ResponseEnvelopeShape,
      operation: z.literal(operation),
      body,
    })
    .strict()
    .refine(
      (message) => canonicalByteLength(message) <= CONNECTOR_IPC_MAX_RESPONSE_BYTES,
      `a response is at most ${CONNECTOR_IPC_MAX_RESPONSE_BYTES} bytes of canonical JSON`,
    );

const EmptyBodySchema = z.object({}).strict();

export const ConnectorRequestSchema = z.union([
  requestSchema("search", ConnectorSearchRequestBodySchema),
  requestSchema("health", EmptyBodySchema),
  requestSchema("status", EmptyBodySchema),
  requestSchema("cancel", ConnectorCancelRequestBodySchema),
  requestSchema("fetch_result", ConnectorFetchResultRequestBodySchema),
]);
export type ConnectorRequest = z.infer<typeof ConnectorRequestSchema>;

export const ConnectorResponseSchema = z.union([
  responseSchema("search", ConnectorSearchResponseBodySchema),
  responseSchema("health", ConnectorHealthResponseBodySchema),
  responseSchema("status", ConnectorStatusResponseBodySchema),
  responseSchema("cancel", ConnectorCancelResponseBodySchema),
  responseSchema("fetch_result", ConnectorFetchResultResponseBodySchema),
]);
export type ConnectorResponse = z.infer<typeof ConnectorResponseSchema>;

export const ConnectorMessageSchema = z.union([ConnectorRequestSchema, ConnectorResponseSchema]);
export type ConnectorMessage = z.infer<typeof ConnectorMessageSchema>;

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function lengthPrefixed(bytes: Uint8Array): Uint8Array {
  const output = new Uint8Array(4 + bytes.length);
  new DataView(output.buffer).setUint32(0, bytes.length, false);
  output.set(bytes, 4);
  return output;
}

function fixedU64(value: number): Uint8Array {
  const output = new Uint8Array(8);
  new DataView(output.buffer).setBigUint64(0, BigInt(value), false);
  return output;
}

export function connectorBodySha256(body: unknown): Uint8Array {
  return new Uint8Array(createHash("sha256").update(canonicalJson(body), "utf8").digest());
}

export function connectorMacPayload(message: ConnectorMessage): Uint8Array {
  const parsed = ConnectorMessageSchema.parse(message);
  const encoder = new TextEncoder();
  const fields = [
    encoder.encode(String(parsed.contract_version)),
    encoder.encode(parsed.operation),
    encoder.encode(parsed.direction),
    encoder.encode(parsed.caller_key_id),
    encoder.encode(parsed.boot_id),
    encoder.encode(parsed.session_id),
    encoder.encode(parsed.request_id),
    encoder.encode(parsed.nonce),
    encoder.encode(parsed.direction === "response" ? parsed.response_key_id : ""),
  ];
  const bodyDigest = connectorBodySha256(parsed.body);
  const total = fields.reduce((size, field) => size + 4 + field.length, 8 + bodyDigest.length);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const field of fields) {
    const framed = lengthPrefixed(field);
    output.set(framed, offset);
    offset += framed.length;
  }
  output.set(fixedU64(parsed.deadline_ms), offset);
  offset += 8;
  output.set(bodyDigest, offset);
  return output;
}

function canonicalByteLength(value: unknown): number {
  return new TextEncoder().encode(canonicalJson(value)).length;
}

export function connectorMessageSize(message: ConnectorMessage): number {
  return canonicalByteLength(message);
}

const SEARCH_QUERY_URL = new RegExp(CONNECTOR_IPC_RULES.search_query_url_pattern);

/** Whether the Connector refuses this search query as carrying a URL. */
export function connectorSearchQueryCarriesUrl(query: string): boolean {
  return SEARCH_QUERY_URL.test(query);
}