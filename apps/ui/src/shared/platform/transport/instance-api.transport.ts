import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { isTauriRuntime } from "~/shared/platform/runtime-env";

export class InstanceApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const resolveFetch = (): FetchLike => (isTauriRuntime() ? tauriFetch : globalThis.fetch);

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await resolveFetch()(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Request timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function requestInstanceJson<T>(
  baseUrl: string,
  path: string,
  options: {
    method?: string;
    token?: string;
    hostToken?: string;
    body?: unknown;
    timeoutMs: number;
  },
): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.token) headers.Authorization = "Bearer " + options.token;
  if (options.hostToken) headers["X-OpenWork-Host-Token"] = options.hostToken;
  const response = await fetchWithTimeout(
    `${baseUrl}${path}`,
    {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    },
    options.timeoutMs,
  );
  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      if (response.ok) throw new Error("Instance API returned invalid JSON.");
    }
  }
  if (!response.ok) {
    const error =
      payload !== null && typeof payload === "object"
        ? (payload as Record<string, unknown>)
        : {};
    throw new InstanceApiError(
      response.status,
      typeof error.code === "string" ? error.code : "request_failed",
      typeof error.message === "string"
        ? error.message
        : response.statusText || `HTTP ${response.status}`,
      error.details,
    );
  }
  return payload as T;
}
