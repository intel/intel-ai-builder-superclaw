import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import {
  AppReadinessSchema,
  type AppReadiness,
} from "@different-ai/openwork-contracts/capability";

import { uiLogError } from "~/shared/platform/log/log";
import { isTauriRuntime } from "~/shared/platform/runtime-env";

export type ServiceHubSettings = {
  baseUrl: string;
  token: string;
};

export type ServiceHubHealthService = {
  name: string;
  proxy_prefix: string;
  port: number;
  state: string;
  healthy: boolean;
  failure_count: number;
  restart_attempts: number;
  instance_id: string | null;
};

export type ServiceHubHealth = {
  healthy: boolean;
  services: ServiceHubHealthService[];
};

export type ServiceHubStatusService = {
  name: string;
  proxy_prefix: string;
  port: number;
  state: string;
  status_supported: boolean;
  status: Record<string, unknown> | null;
  error: { code: string; message: string } | null;
};

export type ServiceHubStatus = {
  ok: boolean;
  services: ServiceHubStatusService[];
};

/**
 * `GET /sandbox-manager/v1/optional-packages/{id}` and `POST …/install`. A
 * running install is reported first, with its `operation_id`. `can_install`
 * comes with `not_installed` and says whether winget is on this machine.
 */
export type OptionalPackageStatus = {
  package_id: string;
  installed: boolean;
  state?: "ready" | "installing" | "not_installed";
  operation_id?: string;
  can_install?: boolean;
};

/** The operation row served by `GET /app/operations/{id}` (sandbox-manager `sm:` ids). */
export type ServiceHubOperation = {
  operation_id: string;
  kind: string;
  state: "pending" | "running" | "done" | "error" | "cancelled";
  pct: number;
  message?: string;
  /** UTC, to the second: `2026-10-26T23:01:06Z`. */
  started_at?: string;
  last_error_message?: string;
  metadata?: { error_code?: string };
};

export type OptionalPackageInstallPhase = "downloading" | "installing";

export type OptionalPackageInstallFailureCode =
  | "winget_unavailable"
  | "install_failed"
  | "already_installed_elsewhere";

export type OptionalPackageInstallStatus =
  | { state: "running"; phase?: OptionalPackageInstallPhase; startedAt?: number }
  | { state: "done" }
  | { state: "failed"; code: OptionalPackageInstallFailureCode };

/**
 * The one place that knows where an install operation keeps its phase and its
 * stable failure code: sandbox_manager puts the phase in `message` while the
 * install runs and the code in `last_error_message`. `metadata.error_code` is
 * also read. Any other failure is `install_failed`. `startedAt` is when the
 * operation began, in epoch milliseconds, so the time elapsed does not depend
 * on who is looking.
 */
export function toInstallStatus(operation: ServiceHubOperation): OptionalPackageInstallStatus {
  if (operation.state === "done") return { state: "done" };
  if (operation.state === "error" || operation.state === "cancelled") {
    const code = operation.metadata?.error_code ?? operation.last_error_message ?? "";
    return {
      state: "failed",
      code: code === "winget_unavailable" || code === "already_installed_elsewhere" ? code : "install_failed",
    };
  }
  const phase = operation.message ?? "";
  const startedAt = Date.parse(operation.started_at ?? "");
  return {
    state: "running",
    phase: phase === "downloading" || phase === "installing" ? phase : undefined,
    startedAt: Number.isNaN(startedAt) ? undefined : startedAt,
  };
}

export type NativeRecoveryReason = "native_hdr_restart_budget_exhausted";

export type NativeRecoveryPresentation = {
  title: string;
  message: string;
};

export const NATIVE_RECOVERY_PRESENTATIONS: Record<
  NativeRecoveryReason,
  NativeRecoveryPresentation
> = {
  native_hdr_restart_budget_exhausted: {
    title: "Restart SuperClaw",
    message: "The native backend stopped after repeated restart attempts.",
  },
};

const DEFAULT_TIMEOUT_MS = 10_000;

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export const resolveServiceHubFetch = (): FetchLike =>
  (isTauriRuntime() ? (tauriFetch as unknown as FetchLike) : globalThis.fetch);

export type ServiceHubRequestOptions = {
  method?: string;
  body?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
};

/** Typed HTTP error for any non-2xx ServiceHub response. Always carries `status`. */
export class ServiceHubHttpError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly retryAfterMs?: number;
  /** What an error envelope carried besides its `code` and `message`, such as which Slack token failed. */
  readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    status: number,
    code?: string,
    retryAfterMs?: number,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ServiceHubHttpError";
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
    this.details = details;
  }
}

/** Thrown when a 2xx response body cannot be treated as a JSON payload. */
export class ServiceHubResponseError extends Error {
  readonly kind: "empty_json" | "malformed_json";

  constructor(kind: "empty_json" | "malformed_json", message: string) {
    super(message);
    this.name = "ServiceHubResponseError";
    this.kind = kind;
  }
}

export function isTransientHubError(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status;
  return (
    status === undefined || status === 502 || status === 503 || status === 504
  );
}

function createAbortError(): Error {
  if (typeof DOMException !== "undefined") {
    return new DOMException("The operation was aborted.", "AbortError");
  }
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

/**
 * Parses an HTTP `Retry-After` header value (delta-seconds or HTTP-date) into
 * milliseconds. Returns `undefined` for anything malformed; never throws.
 */
export function parseRetryAfterMs(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds)) return undefined;
    return Math.max(0, seconds) * 1000;
  }

  // Only accept the RFC 7231 HTTP-date format (e.g. what `Date#toUTCString()`
  // produces). `Date.parse` is far more lenient than the HTTP spec and will
  // happily "succeed" on garbage like "-5" or "1.5" — validate the shape
  // first instead of trusting engine-specific loose parsing.
  const HTTP_DATE_PATTERN = /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/;
  if (!HTTP_DATE_PATTERN.test(trimmed)) return undefined;

  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return undefined;
  return Math.max(0, dateMs - Date.now());
}

/**
 * Fetches with a timeout while correctly composing an optional caller
 * `AbortSignal`. The caller's abort is always forwarded to (and never
 * swallowed by) the underlying request; a timeout aborts independently and
 * surfaces as a plain "Request timed out." error instead.
 */
async function fetchWithTimeout(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  callerSignal?: AbortSignal,
): Promise<Response> {
  if (callerSignal?.aborted) {
    throw createAbortError();
  }

  const controller = new AbortController();
  let timedOut = false;

  const onCallerAbort = () => controller.abort();
  callerSignal?.addEventListener("abort", onCallerAbort);

  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (callerSignal?.aborted) throw createAbortError();
    if (timedOut) throw new Error("Request timed out.");
    throw error;
  } finally {
    clearTimeout(timeoutId);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }
}

export async function requestServiceHubJson<T>(
  baseUrl: string,
  path: string,
  token: string,
  options: ServiceHubRequestOptions = {},
): Promise<T> {
  const fetchImpl = resolveServiceHubFetch();
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${token.trim()}`,
  };
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetchWithTimeout(
    fetchImpl,
    `${baseUrl.replace(/\/+$/, "")}${path}`,
    {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    },
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    options.signal,
  );

  const text = await response.text();

  if (!response.ok) {
    const retryAfterMs = parseRetryAfterMs(response.headers.get("Retry-After"));
    let code: string | undefined;
    let details: Record<string, unknown> | undefined;
    let message = `${response.status} ${response.statusText}`.trim();
    if (text) {
      try {
        const envelope = JSON.parse(text) as {
          error?: { message?: string; code?: string };
          detail?: { error?: { message?: string; code?: string } };
          message?: string;
        } | null;
        const error = envelope?.error ?? envelope?.detail?.error;
        if (typeof error?.message === "string") message = error.message;
        else if (typeof envelope?.message === "string") message = envelope.message;
        if (typeof error?.code === "string") code = error.code;
        if (error && typeof error === "object") {
          const { code: _code, message: _message, ...rest } = error as Record<string, unknown>;
          if (Object.keys(rest).length > 0) details = rest;
        }
      } catch {
        // Malformed error body — keep the status-derived message. Do not
        // misreport this as a JSON parse failure; `status` is still correct.
      }
    }
    throw new ServiceHubHttpError(message, response.status, code, retryAfterMs, details);
  }

  if (!text) {
    throw new ServiceHubResponseError("empty_json", "Expected a JSON response body but received an empty body.");
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ServiceHubResponseError("malformed_json", "Failed to parse response body as JSON.");
  }
}

/**
 * Like {@link requestServiceHubJson} but returns the raw response bytes plus the
 * response headers. Used for TTS synthesis, which returns `audio/wav` (not JSON)
 * along with `X-RTF` / `X-Synth-Seconds` / `X-Audio-Seconds` diagnostics.
 *
 * Routes through {@link resolveServiceHubFetch} (Tauri `plugin-http` in the
 * desktop webview — bypasses CORS and reaches `127.0.0.1:<hub>`) with the hub
 * Bearer. On a non-2xx it drains the body and throws a {@link ServiceHubHttpError}
 * carrying any JSON error envelope, mirroring the JSON helper.
 */
export async function requestServiceHubBinary(
  baseUrl: string,
  path: string,
  token: string,
  options: ServiceHubRequestOptions = {},
): Promise<{ data: ArrayBuffer; headers: Headers }> {
  const fetchImpl = resolveServiceHubFetch();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token.trim()}`,
  };
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetchWithTimeout(
    fetchImpl,
    `${baseUrl.replace(/\/+$/, "")}${path}`,
    {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    },
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    options.signal,
  );

  if (!response.ok) {
    const retryAfterMs = parseRetryAfterMs(response.headers.get("Retry-After"));
    const text = await response.text();
    let code: string | undefined;
    let details: Record<string, unknown> | undefined;
    let message = `${response.status} ${response.statusText}`.trim();
    if (text) {
      try {
        const envelope = JSON.parse(text) as
          | { error?: { message?: string; code?: string }; message?: string }
          | null;
        if (typeof envelope?.error?.message === "string") message = envelope.error.message;
        else if (typeof envelope?.message === "string") message = envelope.message;
        if (typeof envelope?.error?.code === "string") code = envelope.error.code;
      } catch {
        // Non-JSON error body — keep the status-derived message.
      }
    }
    throw new ServiceHubHttpError(message, response.status, code, retryAfterMs);
  }

  const data = await response.arrayBuffer();
  return { data, headers: response.headers };
}

export type OwtTokenResponse = {
  token: string;
  scope: string;
  created_at: string;
};

/** Error shape returned by sandbox_manager when the token is unavailable. */
export type OwtTokenError = {
  code: string;
  message: string;
  details?: { reason?: unknown };
};

export type OwtTokenResult =
  | { ok: true; token: string; scope: string; createdAt: string; revision: string | null }
  | {
      ok: false;
      code: string;
      message: string;
      status: number | null;
      retryable: boolean;
      /** The closed refusal word, when `code` is `runtime_provision_failed`. */
      reason?: string;
    };

function parseOwtErrorEnvelope(bodyText: string): { code: string; message: string; reason?: string } {
  let code = "unknown";
  let message = "";
  let reason: string | undefined;
  if (!bodyText.trim()) {
    return { code, message };
  }
  try {
    const body = JSON.parse(bodyText) as {
      error?: OwtTokenError;
      detail?: { error?: OwtTokenError };
    };
    const error = body.error ?? body.detail?.error;
    if (error?.code) code = error.code;
    if (error?.message) message = error.message;
    if (typeof error?.details?.reason === "string") reason = error.details.reason;
  } catch {
    // Non-JSON error body — caller supplies status-derived defaults.
  }
  return { code, message, reason };
}

function normalizeOwtRetryCode(status: number, code: string): string {
  if (status === 503 && code === "sandbox_not_ready") {
    return "sandbox_starting";
  }
  if (code === "restricted_lifecycle_required" || code === "runtime_deployment_required") {
    return "sandbox_starting";
  }
  return code;
}

/** True while the sandbox/container is still coming up (not "token pending on a live runtime"). */
export function isOwtSandboxProvisioningCode(code: string): boolean {
  return (
    code === "sandbox_starting" ||
    code === "sandbox_not_ready" ||
    code === "http_503" ||
    code === "sandbox_manager_unavailable" ||
    code === "network_unreachable" ||
    code === "restricted_lifecycle_required" ||
    code === "runtime_deployment_required"
  );
}

/**
 * Fetch the current OWT token from the ServiceHub-owned broker.
 *
 * Returns `{ ok: true, token }` on success, or `{ ok: false, code, retryable }`
 * when the sandbox/container is not ready yet.
 */
export async function fetchOwtToken(
  hubBaseUrl: string,
  hubToken: string,
): Promise<OwtTokenResult> {
  const fetchImpl = resolveServiceHubFetch();
  const url = `${hubBaseUrl.replace(/\/+$/, "")}/app/runtime/sandbox-token`;

  let response: Response;
  try {
    response = await fetchWithTimeout(
      fetchImpl,
      url,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${hubToken}`,
        },
      },
      8_000,
    );
  } catch (error) {
    return {
      ok: false,
      code: "network_unreachable",
      message: error instanceof Error ? error.message : "Network request failed.",
      status: null,
      retryable: true,
    };
  }

  const bodyText = await response.text();

  if (response.ok) {
    try {
      const body = JSON.parse(bodyText) as OwtTokenResponse;
      if (body.token) {
        return {
          ok: true,
          token: body.token,
          scope: body.scope,
          createdAt: body.created_at,
          // OWT does not expose a revision today. Keep the event shape explicit
          // rather than deriving an unsafe token fingerprint.
          revision: null,
        };
      }
    } catch {
      return {
        ok: false,
        code: "malformed_token_response",
        message: "Sandbox returned an invalid workspace token payload.",
        status: response.status,
        retryable: true,
      };
    }
    return {
      ok: false,
      code: "empty_token",
      message: "Sandbox returned an empty workspace token.",
      status: response.status,
      retryable: true,
    };
  }

  const parsed = parseOwtErrorEnvelope(bodyText);
  let code = parsed.code === "unknown" ? `http_${response.status}` : parsed.code;
  const message =
    parsed.message || response.statusText || "Sandbox is not ready.";
  code = normalizeOwtRetryCode(response.status, code);

  // The sandbox refused its provision (a declined UAC prompt, say). Waiting never clears it.
  if (code === "runtime_provision_failed") {
    return { ok: false, code, message, status: response.status, retryable: false, reason: parsed.reason };
  }

  // 503/404/409 during boot are retryable; parse the real error code from the body.
  if (response.status === 503 || response.status === 404 || response.status === 409) {
    return {
      ok: false,
      code,
      message,
      status: response.status,
      retryable: true,
    };
  }

  // Any other error is non-retryable
  return {
    ok: false,
    code,
    message,
    status: response.status,
    retryable: false,
  };
}

/**
 * Ask ServiceHub to converge the durable Runtime Deployment (idempotent). `rearm` is the user's Retry
 * after a refused provision: SandboxManager asks again instead of reporting the failed deployment.
 */
export async function requestRuntimeConverge(
  hubBaseUrl: string,
  hubToken: string,
  options: { rearm?: boolean } = {},
): Promise<void> {
  await requestServiceHubJson(
    hubBaseUrl,
    options.rearm ? "/app/runtime/converge?rearm=true" : "/app/runtime/converge",
    hubToken,
    { method: "POST", timeoutMs: 30_000 },
  );
}

/**
 * Record the user's Deny of `confirm_file_protection` so `local_sensitive_read` may read the file on
 * the host for this session. Only ServiceHub can open the grant; the sandbox cannot (#3665).
 */
export async function openLocalReadGrant(hubBaseUrl: string, hubToken: string, sessionId: string): Promise<void> {
  await requestServiceHubJson(hubBaseUrl, "/data-protection/v1/file/local-read/grant", hubToken, {
    method: "POST",
    body: { session_id: sessionId },
    timeoutMs: 5_000,
  });
}

export function createServiceHubClient(settings: ServiceHubSettings) {
  const baseUrl = settings.baseUrl.replace(/\/+$/, "");
  const token = settings.token.trim();

  return {
    baseUrl,
    token,
    servicesHealth: () => requestServiceHubJson<ServiceHubHealth>(baseUrl, "/app/services/health", token, { timeoutMs: 5_000 }),
    appReadiness: () => requestServiceHubJson<AppReadiness>(
      baseUrl,
      "/app/readiness",
      token,
      { timeoutMs: 5_000 },
    ),
    servicesStatus: () => requestServiceHubJson<ServiceHubStatus>(baseUrl, "/app/services/status", token, { timeoutMs: 8_000 }),
    optionalPackage: (packageId: string) =>
      requestServiceHubJson<OptionalPackageStatus>(
        baseUrl,
        `/sandbox-manager/v1/optional-packages/${encodeURIComponent(packageId)}`,
        token,
        { timeoutMs: 5_000 },
      ),
    installOptionalPackage: (packageId: string) =>
      requestServiceHubJson<OptionalPackageStatus>(
        baseUrl,
        `/sandbox-manager/v1/optional-packages/${encodeURIComponent(packageId)}/install`,
        token,
        { method: "POST", timeoutMs: 10_000 },
      ),
    operation: (operationId: string) =>
      requestServiceHubJson<ServiceHubOperation>(
        baseUrl,
        `/app/operations/${encodeURIComponent(operationId)}`,
        token,
        { timeoutMs: 10_000 },
      ),
    fetchOwtToken: () => fetchOwtToken(baseUrl, token),
  };
}

export type NativeRecoveryClassification =
  | { status: "available"; reason: NativeRecoveryReason | null }
  | { status: "unavailable" };

export function classifyNativeRecovery(
  readiness: AppReadiness,
): NativeRecoveryClassification {
  const sandbox = readiness.components.find(
    (component) =>
      component.name === "sandbox_container" &&
      component.startup === "required",
  );
  if (!sandbox || sandbox.state === "unknown" || sandbox.state === "dormant") {
    return { status: "unavailable" };
  }
  const reason =
    readiness.state === "failed" &&
      sandbox.state === "failed" &&
      sandbox.reason_code === "native_hdr_restart_budget_exhausted"
      ? sandbox.reason_code
      : null;
  return { status: "available", reason };
}

type ReadinessFailureLogger = (error: unknown) => void;
const READINESS_FAILURE_LOG_INTERVAL_MS = 60_000;
const readinessFailureLoggedAt = new WeakMap<ReadinessFailureLogger, number>();

const logReadinessFailure: ReadinessFailureLogger = (error) => {
  uiLogError("runtime.readiness", "Failed to read valid App readiness for recovery", {
    error: error instanceof Error ? error.message : String(error),
  });
};

export async function fetchAppReadinessBestEffort(
  hubBaseUrl: string,
  hubToken: string,
  logFailure: ReadinessFailureLogger = logReadinessFailure,
): Promise<AppReadiness | null> {
  try {
    const readiness = AppReadinessSchema.parse(
      await createServiceHubClient({ baseUrl: hubBaseUrl, token: hubToken }).appReadiness(),
    );
    readinessFailureLoggedAt.delete(logFailure);
    return readiness;
  } catch (error) {
    const now = Date.now();
    const lastLoggedAt = readinessFailureLoggedAt.get(logFailure);
    if (
      lastLoggedAt === undefined ||
      now - lastLoggedAt >= READINESS_FAILURE_LOG_INTERVAL_MS
    ) {
      readinessFailureLoggedAt.set(logFailure, now);
      logFailure(error);
    }
    return null;
  }
}

/**
 * Required components that are not `ready`, rendered for logs and telemetry.
 *
 * Pure so both the status dashboard and the startup resolver derive the same
 * strings without either owning the format.
 */
export function readinessBlockers(readiness: AppReadiness): string[] {
  return readiness.components
    .filter((component) => component.startup === "required" && component.state !== "ready")
    .map((component) =>
      component.reason_code
        ? `${component.name}=${component.state}/${component.reason_code}`
        : `${component.name}=${component.state}`,
    );
}

/**
 * Best-effort read of what is blocking readiness. Never throws, never rejects.
 *
 * Used only on failure paths to turn an opaque "data-plane wait timed out" into a
 * named component. Returning `[]` on any error is deliberate: a diagnostic must
 * not become a second failure while the first one is being reported.
 */
export async function fetchReadinessBlockers(hubBaseUrl: string, hubToken: string): Promise<string[]> {
  try {
    const hub = createServiceHubClient({ baseUrl: hubBaseUrl, token: hubToken });
    return readinessBlockers(await hub.appReadiness());
  } catch {
    return [];
  }
}
