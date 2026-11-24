import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

import { isTauriRuntime } from "~/shared/platform/runtime-env";
import {
  MCP_ACTION_REQUEST_TIMEOUT_MS,
  MCP_AUTH_REQUEST_TIMEOUT_MS,
  MCP_STATUS_REQUEST_TIMEOUT_MS,
} from "~/shared/platform/mcp-timing";

type FieldsResult<T> =
  | ({ data: T; error?: undefined } & { request: Request; response: Response })
  | ({ data?: undefined; error: unknown } & { request: Request; response?: Response });

export class OpencodeRequestError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "OpencodeRequestError";
    this.status = status;
    this.code = code;
  }
}

export type OpencodeReadinessPhase = "global.health" | "path.ready";

export class OpencodeReadinessError extends Error {
  readonly phase: OpencodeReadinessPhase;
  readonly attempts: number;
  readonly elapsedMs: number;
  readonly status?: number;
  readonly code?: string;

  constructor(input: {
    phase: OpencodeReadinessPhase;
    message: string;
    attempts: number;
    elapsedMs: number;
    status?: number;
    code?: string;
  }) {
    super(input.message);
    this.name = "OpencodeReadinessError";
    this.phase = input.phase;
    this.attempts = input.attempts;
    this.elapsedMs = input.elapsedMs;
    this.status = input.status;
    this.code = input.code;
  }
}

export type OpencodeAuth = {
  username?: string;
  password?: string;
  token?: string;
  mode?: "basic" | "openwork";
};

const DEFAULT_OPENCODE_REQUEST_TIMEOUT_MS = 10_000;
const SESSION_ACTION_REQUEST_TIMEOUT_MS = 5 * 60_000;
const OAUTH_OPENCODE_REQUEST_TIMEOUT_MS = 5 * 60_000;

function getRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (typeof Request !== "undefined" && input instanceof Request) return input.url;
  return String(input);
}

export function resolveRequestTimeoutMs(input: RequestInfo | URL, fallbackMs: number, method?: string): number {
  const url = getRequestUrl(input);
  if (/\/session\/[^/?#]+\/(?:command|summarize)(?:[?#]|$)/.test(url)) {
    return Math.max(fallbackMs, SESSION_ACTION_REQUEST_TIMEOUT_MS);
  }
  if (/\/provider\/oauth\//.test(url) || /\/mcp\/auth\/callback\b/.test(url)) {
    return Math.max(fallbackMs, OAUTH_OPENCODE_REQUEST_TIMEOUT_MS);
  }
  if (/\/mcp\/.*auth\b/.test(url)) {
    return Math.max(fallbackMs, MCP_AUTH_REQUEST_TIMEOUT_MS);
  }
  if (/\/mcp(?:[/?#]|$)/.test(url) && method && method.toUpperCase() !== "GET") {
    return Math.max(fallbackMs, MCP_ACTION_REQUEST_TIMEOUT_MS);
  }
  if (/\/mcp(?:[/?#]|$)/.test(url)) {
    return Math.max(fallbackMs, MCP_STATUS_REQUEST_TIMEOUT_MS);
  }
  return fallbackMs;
}

export async function fetchWithTimeout(
  fetchImpl: typeof globalThis.fetch,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  timeoutMs: number,
) {
  const requestMethod = init?.method ?? (
    typeof Request !== "undefined" && input instanceof Request ? input.method : undefined
  );
  const effectiveTimeoutMs = resolveRequestTimeoutMs(input, timeoutMs, requestMethod);
  if (!Number.isFinite(effectiveTimeoutMs) || effectiveTimeoutMs <= 0) {
    return fetchImpl(input, init);
  }

  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  // The caller's signal is forwarded rather than used directly, so the timeout
  // still aborts requests that arrive with a signal of their own.
  const callerSignal = init?.signal ?? undefined;
  const forwardCallerAbort = () => controller?.abort();
  if (callerSignal?.aborted) forwardCallerAbort();
  else callerSignal?.addEventListener("abort", forwardCallerAbort, { once: true });
  const initWithSignal = controller ? { ...(init ?? {}), signal: controller.signal } : init;

  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      try {
        controller?.abort();
      } catch {
        // ignore
      }
      reject(new Error("Request timed out."));
    }, effectiveTimeoutMs);
  });

  try {
    return await Promise.race([fetchImpl(input, initWithSignal), timeoutPromise]);
  } catch (error) {
    let name = "";
    if (error instanceof Error) {
      name = error.name;
    } else if (typeof error === "object" && error !== null && "name" in error) {
      const candidate = (error as { name: unknown }).name;
      if (typeof candidate === "string") name = candidate;
    }
    if (name === "AbortError" && !callerSignal?.aborted) {
      throw new Error("Request timed out.");
    }
    throw error;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    callerSignal?.removeEventListener("abort", forwardCallerAbort);
  }
}

const encodeBasicAuth = (auth?: OpencodeAuth) => {
  if (!auth?.username || !auth?.password) return null;
  const token = `${auth.username}:${auth.password}`;
  if (typeof btoa === "function") return btoa(token);
  const buffer = (globalThis as { Buffer?: { from: (input: string, encoding: string) => { toString: (encoding: string) => string } } })
    .Buffer;
  return buffer ? buffer.from(token, "utf8").toString("base64") : null;
};

const resolveAuthHeader = (auth?: OpencodeAuth) => {
  if (auth?.mode === "openwork" && auth.token) {
    return `Bearer ${auth.token}`;
  }
  const encoded = encodeBasicAuth(auth);
  return encoded ? `Basic ${encoded}` : null;
};

const createTauriFetch = (auth?: OpencodeAuth) => {
  const authHeader = resolveAuthHeader(auth);
  const addAuth = (headers: Headers) => {
    if (!authHeader || headers.has("Authorization")) return;
    headers.set("Authorization", authHeader);
  };

  return (input: RequestInfo | URL, init?: RequestInit) => {
    if (input instanceof Request) {
      const headers = new Headers(input.headers);
      addAuth(headers);
      const request = new Request(input, { headers });
      return fetchWithTimeout(
        tauriFetch as unknown as typeof globalThis.fetch,
        request,
        undefined,
        DEFAULT_OPENCODE_REQUEST_TIMEOUT_MS,
      );
    }

    const headers = new Headers(init?.headers);
    addAuth(headers);
    return fetchWithTimeout(
      tauriFetch as unknown as typeof globalThis.fetch,
      input,
      {
        ...init,
        headers,
      },
      DEFAULT_OPENCODE_REQUEST_TIMEOUT_MS,
    );
  };
};

export function unwrap<T>(result: FieldsResult<T>): NonNullable<T> {
  if (result.data !== undefined) {
    return result.data as NonNullable<T>;
  }
  const message =
    result.error instanceof Error
      ? result.error.message
      : typeof result.error === "string"
        ? result.error
        : JSON.stringify(result.error);
  const code =
    result.error && typeof result.error === "object" && "code" in result.error && typeof result.error.code === "string"
      ? result.error.code
      : undefined;
  throw new OpencodeRequestError(
    message || "Unknown error",
    result.response?.status ?? 0,
    code ?? (result.response ? undefined : "transport_error"),
  );
}

export function createClient(baseUrl: string, directory?: string, auth?: OpencodeAuth) {
  const headers: Record<string, string> = {};
  if (!isTauriRuntime()) {
    const authHeader = resolveAuthHeader(auth);
    if (authHeader) {
      headers.Authorization = authHeader;
    }
  }

  const fetchImpl = isTauriRuntime()
    ? createTauriFetch(auth)
    : (input: RequestInfo | URL, init?: RequestInit) =>
        fetchWithTimeout(globalThis.fetch, input, init, DEFAULT_OPENCODE_REQUEST_TIMEOUT_MS);
  return Object.assign(
    createOpencodeClient({
      baseUrl,
      directory,
      headers: Object.keys(headers).length ? headers : undefined,
      fetch: fetchImpl,
    }),
    { searchSessions: (input: SessionSearchInput) => searchSessions(baseUrl, directory, auth, input) },
  );
}

/** One hit from the runtime's `GET /session/search`. */
export type SessionSearchHit = {
  id: string;
  title: string;
  time: { created: number; updated: number };
  project?: { id: string; name?: string; worktree: string } | null;
  match: {
    title: boolean;
    /** `sessionID` is a subagent session under the hit when the match came from one. */
    message?: { id: string; sessionID: string; snippet: string; time: number };
  };
};

export type SessionSearchInput = { query: string; roots?: boolean; limit?: number; signal?: AbortSignal };

/** Server-side search over every session the runtime knows about. Not on the
 *  generated SDK yet, so `createClient` exposes it with its own base URL,
 *  directory and auth. */
async function searchSessions(
  baseUrl: string,
  directory: string | undefined,
  auth: OpencodeAuth | undefined,
  input: SessionSearchInput,
): Promise<SessionSearchHit[]> {
  const url = new URL(`${baseUrl.replace(/\/+$/, "")}/session/search`);
  url.searchParams.set("q", input.query);
  if (directory) url.searchParams.set("directory", directory);
  if (input.roots) url.searchParams.set("roots", "true");
  if (input.limit !== undefined) url.searchParams.set("limit", String(input.limit));

  const headers = new Headers();
  const authHeader = resolveAuthHeader(auth);
  if (authHeader) headers.set("Authorization", authHeader);

  const fetchImpl = isTauriRuntime()
    ? (tauriFetch as unknown as typeof globalThis.fetch)
    : globalThis.fetch;

  const response = await fetchWithTimeout(
    fetchImpl,
    url.toString(),
    { method: "GET", headers, signal: input.signal },
    DEFAULT_OPENCODE_REQUEST_TIMEOUT_MS,
  );
  if (!response.ok) {
    throw new OpencodeRequestError(
      `Session search failed (${response.status})`,
      response.status,
    );
  }
  return (await response.json()) as SessionSearchHit[];
}

export async function waitForHealthy(
  client: ReturnType<typeof createClient>,
  options?: {
    timeoutMs?: number;
    pollMs?: number;
    probeOpencodeReady?: boolean;
    probeAttemptTimeoutMs?: number;
  },
) {
  const timeoutMs = options?.timeoutMs ?? 10_000;
  const pollMs = options?.pollMs ?? 250;
  const probeOpencodeReady = options?.probeOpencodeReady ?? true;
  const probeAttemptTimeoutMs = options?.probeAttemptTimeoutMs ?? 2_000;

  const start = Date.now();
  let lastError: string | null = null;
  let lastStatus: number | undefined;
  let lastCode: string | undefined;
  let healthAttempts = 0;
  let pathAttempts = 0;
  let health: NonNullable<Awaited<ReturnType<typeof client.global.health>>["data"]> | null = null;

  // Phase 1: wait for the proxy/server to report healthy.
  while (Date.now() - start < timeoutMs) {
    healthAttempts += 1;
    try {
      const candidate = unwrap(await client.global.health());
      if (candidate.healthy) {
        health = candidate;
        break;
      }
      lastError = "Server reported unhealthy";
      lastStatus = undefined;
      lastCode = undefined;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Unknown error";
      lastStatus = error instanceof OpencodeRequestError ? error.status : undefined;
      lastCode = error instanceof OpencodeRequestError ? error.code : undefined;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  if (!health) {
    throw new OpencodeReadinessError({
      phase: "global.health",
      message: lastError ?? "Timed out waiting for server health",
      attempts: healthAttempts,
      elapsedMs: Date.now() - start,
      status: lastStatus,
      code: lastCode,
    });
  }

  if (!probeOpencodeReady) {
    return health;
  }

  // Phase 2: openwork-server's /health only proves the proxy is up. The
  // upstream opencode subprocess may still be initializing (loading session
  // storage, indexes, etc.), in which case the first session.list() call
  // would hit the 10s default request timeout. Probe a cheap opencode-backed
  // endpoint until it responds, so callers can rely on "healthy" meaning
  // "opencode is actually ready to serve requests".
  //
  // Each individual probe is bounded by `probeAttemptTimeoutMs` so a single
  // hanging request can't consume the entire `timeoutMs` budget.
  while (Date.now() - start < timeoutMs) {
    pathAttempts += 1;
    const attempt = client.path.get().then(unwrap);
    let attemptTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const attemptTimer = new Promise<never>((_, reject) => {
      attemptTimeoutHandle = setTimeout(() => {
        attempt.catch(() => undefined);
        reject(new Error("opencode probe attempt timed out"));
      }, probeAttemptTimeoutMs);
    });
    try {
      await Promise.race([attempt, attemptTimer]);
      return health;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Unknown error";
      lastStatus = error instanceof OpencodeRequestError ? error.status : undefined;
      lastCode = error instanceof OpencodeRequestError ? error.code : undefined;
    } finally {
      if (attemptTimeoutHandle !== undefined) {
        clearTimeout(attemptTimeoutHandle);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  throw new OpencodeReadinessError({
    phase: "path.ready",
    message: lastError ?? "Timed out waiting for opencode readiness",
    attempts: pathAttempts,
    elapsedMs: Date.now() - start,
    status: lastStatus,
    code: lastCode,
  });
}

/** Declared here rather than in shared/types because it is derived from
 *  createClient above. app/types re-exports it for existing importers. */
export type Client = ReturnType<typeof createClient>;
