/**
 * Server-side proxy for the intent-classifier sidecar.
 *
 * Lives outside server.ts because the sidecar is Product Profile-conditional:
 * on Profiles that do not declare it, nothing listens on CLASSIFIER_PORT and
 * this proxy's only job is to fail quickly instead of holding the request.
 */

import { ApiError, throwIfIntentClassifierCredentialRejected } from "./errors.js";
import { recordSidecarAvailabilityFromProxyResponse } from "./runtime-telemetry.js";

/**
 * Upper bound on one classifier proxy request.
 *
 * Generous on purpose: the sidecar's own httpx calls are capped at 30 s each and
 * a single /classify can chain two of them (classify, then intake
 * continuation), so this never truncates legitimate work. It exists so a missing
 * or wedged sidecar cannot park a server request indefinitely — an unreachable
 * classifier was observed holding the proxy for over two minutes, long after the
 * UI had abandoned the request at its own 60 s timeout.
 */
export const INTENT_CLASSIFIER_PROXY_TIMEOUT_MS = 90_000;

export function intentClassifierRequestHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  const classifierToken = process.env.INTENT_CLASSIFIER_TOKEN?.trim();
  if (classifierToken) headers.Authorization = `Bearer ${classifierToken}`;
  return headers;
}

export function intentClassifierBaseUrl(): string {
  return `http://localhost:${process.env.CLASSIFIER_PORT?.trim() || "18791"}`;
}

export async function proxyIntentClassifierRequest(
  request: Request,
  restPath: string,
): Promise<Response> {
  const baseUrl = intentClassifierBaseUrl();

  const method = request.method.toUpperCase();
  const body = method === "GET" || method === "HEAD" ? undefined : await request.text();
  const pathname = new URL(request.url).pathname;
  const search = new URL(request.url).search;
  const upstreamUrl = `${baseUrl}${restPath}${search}`;

  const headers = intentClassifierRequestHeaders({ "Content-Type": "application/json" });

  try {
    // egress-surface: openwork_proxy_intent_classifier
    const response = await fetch(upstreamUrl, {
      method,
      headers,
      body: body || undefined,
      signal: AbortSignal.timeout(INTENT_CLASSIFIER_PROXY_TIMEOUT_MS),
    });
    recordSidecarAvailabilityFromProxyResponse({ sidecarName: "intent_classifier", pathname, response });
    throwIfIntentClassifierCredentialRejected(response, restPath);
    const text = await response.text();
    return new Response(text, {
      status: response.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    recordSidecarAvailabilityFromProxyResponse({ sidecarName: "intent_classifier", pathname, error });
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    throw new ApiError(
      503,
      "intent_classifier_unreachable",
      timedOut
        ? `Intent classifier did not respond within ${INTENT_CLASSIFIER_PROXY_TIMEOUT_MS}ms`
        : "Intent classifier is not reachable",
      { error: error instanceof Error ? error.message : String(error) },
    );
  }
}
