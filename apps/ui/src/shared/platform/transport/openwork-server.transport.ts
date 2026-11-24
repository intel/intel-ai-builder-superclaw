import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { isTauriRuntime } from "~/shared/platform/runtime-env";
import type { RawJsonResponse } from "./openwork-server.types";

/** Dispatched on `window` when the OpenWork Server rejects a request with 401 (expired/invalid owtToken). */
export const OWT_EXPIRED_EVENT = "superclaw:owt-expired" as const;

export class OpenworkServerError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * Turns a non-OK response into an `OpenworkServerError`.
 *
 * The parse is best-effort on purpose: an error body is not always the JSON
 * envelope the server promises — a proxy or gateway in front of it answers
 * with an HTML page — and letting `JSON.parse` throw would replace the status,
 * the code, and the 401 handling below with an opaque `SyntaxError`.
 */
function failWithServerError(response: Response, text: string): never {
  // Detect OWS 401 (expired/invalid owtToken) and notify listeners.
  if (response.status === 401 && typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(OWT_EXPIRED_EVENT));
  }

  let payload: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = text ? JSON.parse(text) : null;
    payload = parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    payload = null;
  }

  const code = typeof payload?.code === "string" ? payload.code : "request_failed";
  const message =
    typeof payload?.message === "string"
      ? payload.message
      : response.statusText || `HTTP ${response.status}`;
  throw new OpenworkServerError(response.status, code, message, payload?.details);
}

function buildHeaders(
  token?: string,
  hostToken?: string,
  extra?: Record<string, string>,
) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (hostToken) {
    headers["X-OpenWork-Host-Token"] = hostToken;
  }
  if (extra) {
    Object.assign(headers, extra);
  }
  return headers;
}

function buildAuthHeaders(token?: string, hostToken?: string, extra?: Record<string, string>) {
  const headers: Record<string, string> = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (hostToken) {
    headers["X-OpenWork-Host-Token"] = hostToken;
  }
  if (extra) {
    Object.assign(headers, extra);
  }
  return headers;
}

// Use Tauri's fetch when running in the desktop app to avoid CORS issues
const resolveFetch = () => (isTauriRuntime() ? tauriFetch : globalThis.fetch);

const DEFAULT_OPENWORK_SERVER_TIMEOUT_MS = 10_000;

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

async function fetchWithTimeout(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return fetchImpl(url, init);
  }

  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const signal = controller?.signal;
  const initWithSignal = signal && !init.signal ? { ...init, signal } : init;

  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      try {
        controller?.abort();
      } catch {
        // ignore
      }
      reject(new Error("Request timed out."));
    }, timeoutMs);
  });

  try {
    return await Promise.race([fetchImpl(url, initWithSignal), timeoutPromise]);
  } catch (error) {
    const name = (error && typeof error === "object" && "name" in error ? (error as any).name : "") as string;
    if (name === "AbortError") {
      throw new Error("Request timed out.");
    }
    throw error;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export async function requestJson<T>(
  baseUrl: string,
  path: string,
  options: { method?: string; token?: string; hostToken?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<T> {
  const url = `${baseUrl}${path}`;
  const fetchImpl = resolveFetch();
  const response = await fetchWithTimeout(
    fetchImpl,
    url,
    {
      method: options.method ?? "GET",
      headers: buildHeaders(options.token, options.hostToken),
      body: options.body ? JSON.stringify(options.body) : undefined,
    },
    options.timeoutMs ?? DEFAULT_OPENWORK_SERVER_TIMEOUT_MS,
  );

  const text = await response.text();
  if (!response.ok) {
    failWithServerError(response, text);
  }

  return (text ? JSON.parse(text) : null) as T;
}

export async function requestBinaryJson<T>(
  baseUrl: string,
  path: string,
  bytes: Uint8Array,
  options: { method: string; token?: string; hostToken?: string; headers?: Record<string, string>; timeoutMs?: number },
): Promise<T> {
  const body = bytes.slice().buffer as ArrayBuffer;
  const response = await fetchWithTimeout(
    resolveFetch(),
    `${baseUrl}${path}`,
    {
      method: options.method,
      headers: buildAuthHeaders(options.token, options.hostToken, {
        "Content-Type": "application/octet-stream",
        ...options.headers,
      }),
      body,
    },
    options.timeoutMs ?? DEFAULT_OPENWORK_SERVER_TIMEOUT_MS,
  );
  const text = await response.text();
  if (!response.ok) {
    failWithServerError(response, text);
  }
  return (text ? JSON.parse(text) : null) as T;
}

export async function requestJsonRaw<T>(
  baseUrl: string,
  path: string,
  options: { method?: string; token?: string; hostToken?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<RawJsonResponse<T>> {
  const url = `${baseUrl}${path}`;
  const fetchImpl = resolveFetch();
  const response = await fetchWithTimeout(
    fetchImpl,
    url,
    {
      method: options.method ?? "GET",
      headers: buildHeaders(options.token, options.hostToken),
      body: options.body ? JSON.stringify(options.body) : undefined,
    },
    options.timeoutMs ?? DEFAULT_OPENWORK_SERVER_TIMEOUT_MS,
  );

  const text = await response.text();
  let json: T | null = null;
  try {
    json = text ? (JSON.parse(text) as T) : null;
  } catch {
    json = null;
  }

  return { ok: response.ok, status: response.status, json };
}

export async function requestMultipartRaw(
  baseUrl: string,
  path: string,
  options: { method?: string; token?: string; hostToken?: string; body?: FormData; timeoutMs?: number } = {},
): Promise<{ ok: boolean; status: number; text: string }> {
  const url = `${baseUrl}${path}`;
  const fetchImpl = resolveFetch();
  const response = await fetchWithTimeout(
    fetchImpl,
    url,
    {
      method: options.method ?? "POST",
      headers: buildAuthHeaders(options.token, options.hostToken),
      body: options.body,
    },
    options.timeoutMs ?? DEFAULT_OPENWORK_SERVER_TIMEOUT_MS,
  );
  const text = await response.text();
  return { ok: response.ok, status: response.status, text };
}

export async function requestBinary(
  baseUrl: string,
  path: string,
  options: { method?: string; token?: string; hostToken?: string; timeoutMs?: number } = {},
): Promise<{ data: ArrayBuffer; contentType: string | null; filename: string | null }> {
  const url = `${baseUrl}${path}`;
  const fetchImpl = resolveFetch();
  const response = await fetchWithTimeout(
    fetchImpl,
    url,
    {
      method: options.method ?? "GET",
      headers: buildAuthHeaders(options.token, options.hostToken),
    },
    options.timeoutMs ?? DEFAULT_OPENWORK_SERVER_TIMEOUT_MS,
  );

  if (!response.ok) {
    const text = await response.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    const code = typeof json?.code === "string" ? json.code : "request_failed";
    const message = typeof json?.message === "string" ? json.message : response.statusText;
    throw new OpenworkServerError(response.status, code, message, json?.details);
  }

  const contentType = response.headers.get("content-type");
  const disposition = response.headers.get("content-disposition") ?? "";
  const filenameMatch = disposition.match(/filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i);
  const filenameRaw = filenameMatch?.[1] ?? filenameMatch?.[2] ?? null;
  const filename = filenameRaw ? decodeURIComponent(filenameRaw) : null;
  const data = await response.arrayBuffer();
  return { data, contentType, filename };
}
