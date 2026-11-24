// Turning an error the server reported into text a user can act on, plus the
// classification of the ones that are not really errors (a recoverable
// compaction signal) or need friendlier copy (a not-configured route). Pure;
// extracted from `session.ts` unchanged. Deciding what to do with the
// result — appending a turn, flipping status to idle, deduping — stays with the
// store.

import type { Part } from "@opencode-ai/sdk/v2/client";

import type { SessionErrorTurn } from "~/shared/types/session";
import { t } from "../../i18n";

// `state` rather than `any`: this is read-only shape probing on a tool part, and
// the fields below are all re-checked with `typeof` before use.
const toolErrorText = (part: Part) => {
  if (part.type !== "tool") return "";
  const record = part as Part & { state?: unknown };
  const state = (record.state ?? {}) as Record<string, unknown>;
  const title = typeof state.title === "string" ? state.title : "";
  const error = typeof state.error === "string" ? state.error : "";
  const detail = typeof state.detail === "string" ? state.detail : "";
  return [title, error, detail].filter(Boolean).join("\n");
};

export const isInvalidToolError = (part: Part) => {
  if (part.type !== "tool") return false;
  const haystack = toolErrorText(part).toLowerCase();
  if (!haystack) return false;
  return (
    haystack.includes("invalid tool") ||
    haystack.includes("model tried to call") ||
    haystack.includes("unavailable tool") ||
    haystack.includes("unknown tool") ||
    haystack.includes("tool not found")
  );
};

export const invalidToolNextStepHint = () => {
  return "Try again, or switch to an agent/prompt that only uses available tools in this worker.";
};

export const truncateErrorField = (value: unknown, max = 500) => {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3))}...`;
};

const inferHttpStatus = (value: string | null) => {
  if (!value) return null;
  const match =
    value.match(/\b(?:status|code|http)\s*(?:=|:)?\s*(401|403|413|429)\b/i) ||
    value.match(/\b(401|403|413|429)\b/);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
};

const getNestedRecords = (source: Record<string, unknown>) => {
  const records: Record<string, unknown>[] = [source];
  const data = source.data;
  if (data && typeof data === "object")
    records.push(data as Record<string, unknown>);
  const cause = source.cause;
  if (cause && typeof cause === "object") {
    const causeRecord = cause as Record<string, unknown>;
    records.push(causeRecord);
    const causeData = causeRecord.data;
    if (causeData && typeof causeData === "object")
      records.push(causeData as Record<string, unknown>);
  }
  return records;
};

const firstStringField = (
  records: Record<string, unknown>[],
  keys: string[],
) => {
  for (const record of records) {
    for (const key of keys) {
      const value = truncateErrorField(record[key], 800);
      if (value) return value;
    }
  }
  return null;
};

const firstNumberField = (
  records: Record<string, unknown>[],
  keys: string[],
) => {
  for (const record of records) {
    for (const key of keys) {
      const value = record[key];
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      return value;
    }
  }
  return null;
};

const firstBooleanField = (
  records: Record<string, unknown>[],
  keys: string[],
) => {
  for (const record of records) {
    for (const key of keys) {
      const value = record[key];
      if (typeof value !== "boolean") continue;
      return value;
    }
  }
  return null;
};

// The llmrouter returns a synthetic `context_length_exceeded` 400 whose message
// is authored as "... Compact and retry." (proxy._compact_locally_response) when
// a local request exceeds the derived context cap. opencode catches it, runs its
// compaction agent, and retries to success — so it is a recoverable control
// signal, NOT a user-facing failure. We match the router's distinctive phrase
// (and the proxy's error class) so a GENUINE hard overflow (llama.cpp
// `exceed_context_size_error` / "... try increasing it") still surfaces.
const errorBlob = (errorObj: Record<string, unknown>): string => {
  try {
    return JSON.stringify(errorObj);
  } catch {
    return String(errorObj);
  }
};

export const isPreventiveLocalCompaction = (
  errorObj: Record<string, unknown>,
): boolean => {
  const blob = errorBlob(errorObj);
  return (
    blob.includes("Compact and retry") ||
    blob.includes("ContextOverflowCompactLocally")
  );
};

// A TERMINAL context overflow, i.e. the counterpart of the recoverable signal
// above: either the router's own `context_overflow_unrecoverable` 400
// (proxy._context_overflow_response) or a raw llama.cpp
// `exceed_context_size_error` that reached us in-band on a stream. Neither
// carries a usable `name`, so without this they render as "Unknown Error"
// followed by a JSON dump. The router's message already says what to do, so
// this only supplies a readable heading.
const isTerminalContextOverflow = (
  errorObj: Record<string, unknown>,
): boolean => {
  const blob = errorBlob(errorObj);
  return (
    blob.includes("context_overflow_unrecoverable") ||
    blob.includes("exceed_context_size_error")
  );
};

// The router's `edge_model_not_served` (proxy._upstream_error_object): the Edge
// server answered 404 for the saved model, e.g. after a server upgrade. Like the
// overflow above, the router's message already says what to do; this only
// replaces the "Unknown Error" heading.
const isEdgeModelNotServed = (errorObj: Record<string, unknown>): boolean =>
  errorBlob(errorObj).includes("edge_model_not_served");

// The router's 424 config-error code, read from the structured envelope
// (`responseBody.error.code`, authored by proxy._resolve_alias via error_response).
// A raw `code`/`errorCode` field is a fallback for callers that lift it out.
const notConfiguredCode = (
  errorObj: Record<string, unknown>,
): string | null => {
  const records = getNestedRecords(errorObj);
  const body = firstStringField(records, ["responseBody", "body", "response"]);
  if (body) {
    try {
      const parsed = JSON.parse(body) as { error?: { code?: unknown } };
      const code = parsed?.error?.code;
      if (typeof code === "string") return code;
    } catch {
      // responseBody was not the router's JSON envelope; fall through.
    }
  }
  return firstStringField(records, ["code", "errorCode"]);
};

// Map that code to the friendly not-configured kind. Reproducing opencode's own
// health-check copy (session.tsx's pre-send gate) here covers failures that
// never went through that gate, e.g. scheduler runs and reloaded sessions.
// Scheduler jobs default to `llmrouter/auto`, so `auto_route_not_configured`
// (LLMRouter's proxy._resolve_alias fires it whenever either slot is missing,
// without saying which) is the common case; it gets its own generic copy
// rather than reusing the cloud message, since the missing slot could be
// local, cloud, or both.
export const notConfiguredKind = (
  errorObj: Record<string, unknown>,
): SessionErrorTurn["kind"] => {
  switch (notConfiguredCode(errorObj)) {
    case "local_model_not_configured":
      return "local-not-configured";
    case "no_provider_available":
      return "cloud-not-configured";
    case "auto_route_not_configured":
      return "auto-not-configured";
    default:
      return undefined;
  }
};

export const formatSessionError = (errorObj: Record<string, unknown>) => {
  const notConfigured = notConfiguredKind(errorObj);
  if (notConfigured) {
    const title =
      notConfigured === "local-not-configured"
        ? t("session.local_model_not_configured_title")
        : notConfigured === "auto-not-configured"
          ? t("session.auto_route_not_configured_title")
          : t("session.cloud_model_not_configured_title");
    const message =
      notConfigured === "local-not-configured"
        ? t("session.local_model_not_configured_message")
        : notConfigured === "auto-not-configured"
          ? t("session.auto_route_not_configured_message")
          : t("session.cloud_model_not_configured_message");
    return `${title}\n${message}`;
  }

  const records = getNestedRecords(errorObj);
  const errorName =
    typeof errorObj.name === "string" ? errorObj.name : "UnknownError";
  const rawMessage = firstStringField(records, ["message", "detail", "reason"]);
  const responseBody = firstStringField(records, [
    "responseBody",
    "body",
    "response",
  ]);
  const providerID = firstStringField(records, [
    "providerID",
    "providerId",
    "provider",
  ]);
  const code = firstStringField(records, ["code", "errorCode"]);
  const statusCode = firstNumberField(records, ["statusCode", "status"]);
  const inferred = inferHttpStatus(rawMessage) ?? inferHttpStatus(responseBody);
  const effectiveStatus = statusCode ?? inferred;
  const isRetryable = firstBooleanField(records, ["isRetryable", "retryable"]);

  const heading = (() => {
    if (isTerminalContextOverflow(errorObj)) return "Context too large";
    if (isEdgeModelNotServed(errorObj)) return "Edge model not available";
    if (errorName === "ProviderAuthError")
      return `Provider auth error${providerID ? ` (${providerID})` : ""}`;
    if (errorName === "APIError") {
      if (effectiveStatus === 401 || effectiveStatus === 403)
        return "Authentication failed";
      if (effectiveStatus === 413) return "Context too large";
      if (effectiveStatus === 429) return "Rate limit exceeded";
      return `API error${effectiveStatus ? ` (${effectiveStatus})` : ""}`;
    }
    if (effectiveStatus === 401 || effectiveStatus === 403)
      return "Authentication failed";
    if (effectiveStatus === 413) return "Context too large";
    if (effectiveStatus === 429) return "Rate limit exceeded";
    if (errorName === "MessageOutputLengthError")
      return "Output length limit exceeded";
    return errorName.replace(/([a-z])([A-Z])/g, "$1 $2");
  })();

  const lines = [heading];
  if (rawMessage && rawMessage !== heading) lines.push(rawMessage);
  if (effectiveStatus === 413) {
    lines.push(
      "Tip: Try compacting the session, or start a new session if the issue persists.",
    );
  }
  if (providerID && errorName !== "ProviderAuthError")
    lines.push(`Provider: ${providerID}`);
  if (effectiveStatus && errorName !== "APIError")
    lines.push(`Status: ${effectiveStatus}`);
  if (code) lines.push(`Code: ${code}`);
  if (isRetryable !== null)
    lines.push(`Retryable: ${isRetryable ? "yes" : "no"}`);
  if (responseBody) lines.push(`Response: ${responseBody}`);
  return lines.join("\n");
};
