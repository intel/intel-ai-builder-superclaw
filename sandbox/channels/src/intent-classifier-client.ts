import type { ClassifyResult } from "./intent-gate.js";

export const INTENT_CLASSIFIER_CLASSIFY_TIMEOUT_MS = 5000;

export type IntentClassifierLogger = {
  warn: (payload: Record<string, unknown>, message: string) => void;
};

export type ClassifyIntentOptions = {
  url?: string;
  token?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

const defaultUrl = process.env.INTENT_CLASSIFIER_URL?.trim() || "";
const defaultToken = process.env.INTENT_CLASSIFIER_TOKEN?.trim() || "";

export async function classifyIntent(
  text: string,
  sessionId: string,
  logger: IntentClassifierLogger,
  options: ClassifyIntentOptions = {},
): Promise<ClassifyResult | null> {
  const url = options.url ?? defaultUrl;
  if (!url) return null;
  const token = options.token ?? defaultToken;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? INTENT_CLASSIFIER_CLASSIFY_TIMEOUT_MS;

  try {
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    // egress-surface: opencode_router_intent_classifier
    const res = await fetchImpl(`${url}/classify`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text, session_id: sessionId }),
      signal: controller.signal,
    });
    globalThis.clearTimeout(timeout);
    if (res.status === 401) {
      let code: unknown;
      try {
        code = (await res.json() as { code?: unknown }).code;
      } catch {
        code = undefined;
      }
      logger.warn({ status: 401, code }, "intent classifier rejected the bridge credential");
      return null;
    }
    if (!res.ok) {
      logger.warn({ status: res.status }, "intent classifier returned non-OK");
      return null;
    }
    return await res.json() as ClassifyResult;
  } catch (error) {
    logger.warn({ error: error instanceof Error ? error.message : String(error) }, "intent classifier unreachable");
    return null;
  }
}
