/**
 * PII statistics and category configuration.
 */
import { requestJson } from "./openwork-server.transport";
import type { MaskedExtraTermsResult, MaskedReview, PiiCategories } from "./openwork-server.types";
import type { OpenworkClientContext } from "./openwork-server.client-context";

export function createPrivacyApi(ctx: OpenworkClientContext) {
  const { baseUrl, token, hostToken } = ctx;
  return {
    // PII tally for session sidebar indicator
    getPiiStats: (workspaceId: string, sessionId: string) =>
      requestJson<{ total: number; types: Record<string, number> }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/pii/stats?sessionId=${encodeURIComponent(sessionId)}`,
        { token, hostToken, timeoutMs: 5_000 },
      ),
    // Aggregate PII tally across all sessions (for the cross-session view)
    getAllPiiStats: (workspaceId: string) =>
      requestJson<{ total: number; types: Record<string, number> }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/pii/stats`,
        { token, hostToken, timeoutMs: 5_000 },
      ),
    // Tell the openwork server to drop the cached PII tally for a deleted
    // session so workspace-wide aggregates stop counting it. Used after
    // deleting a session via the opencode SDK.
    clearPiiStats: (workspaceId: string, sessionId: string) =>
      requestJson<{ ok: boolean; removed: boolean }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/pii/stats?sessionId=${encodeURIComponent(sessionId)}`,
        { token, hostToken, method: "DELETE", timeoutMs: 5_000 },
      ),
    getPiiCategories: (workspaceId: string) =>
      requestJson<PiiCategories>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/pii/categories`,
        { token, hostToken, timeoutMs: 5_000 },
      ),
    // What a protect operation masked, for the pre-analysis review dialog.
    getMaskedReview: (workspaceId: string, sessionId: string, operationId: string) =>
      requestJson<MaskedReview>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/privacy/masked-review`,
        { token, hostToken, method: "POST", body: { sessionId, operationId }, timeoutMs: 15_000 },
      ),
    // Mask additional user-supplied words in an already-masked file.
    maskExtraTerms: (workspaceId: string, sessionId: string, operationId: string, terms: string[]) =>
      requestJson<MaskedExtraTermsResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/privacy/masked-extra-terms`,
        { token, hostToken, method: "POST", body: { sessionId, operationId, terms }, timeoutMs: 30_000 },
      ),
  };
}
