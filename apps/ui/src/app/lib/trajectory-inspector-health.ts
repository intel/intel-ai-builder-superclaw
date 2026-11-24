import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

import { isTauriRuntime } from "../utils";

/**
 * Readiness probe + diagnostics for the host-side Trajectory Inspector (:7778).
 *
 * Why an out-of-band probe instead of the iframe's own `onerror`: a cross-origin
 * iframe whose TCP connection is refused still fires `onload` in Chromium/WebView2,
 * so the element gives us no signal at all - the user just gets the engine's
 * "127.0.0.1 refused to connect" page (#2546). We ask `/health` directly instead.
 *
 * Extracted into lib/ (rather than living in dev-tools-modal.tsx) for the same
 * reason as lib/auto-router-health.ts: importing the component pulls in
 * solid-js/lucide-solid, whose module-load side effects throw under the test runner.
 *
 * No new Tauri capability or CSP entry is needed - `http:default` already allows
 * `http://127.0.0.1:*` and the app CSP already lists it in `connect-src`.
 */

export const DEFAULT_TRAJECTORY_PORT = 7778;
export const TRAJECTORY_HEALTH_TIMEOUT_MS = 1500;

export const TRAJECTORY_INSPECTOR_LOG_PATH =
  "%LOCALAPPDATA%\\SuperClaw\\sandbox_manager\\logs\\trajectory-inspector.log";
export const SANDBOX_MANAGER_LOG_GLOB =
  "%LOCALAPPDATA%\\SuperClaw\\sandbox_manager\\logs\\manager\\sbms-*.log";
export const TRAJECTORY_EXE_PATH =
  "%LOCALAPPDATA%\\SuperClaw\\sandbox_manager\\resources\\superclaw-trajectory.exe";

/** Mirrors the tri-state union in lib/debug-traces.ts, plus a loading state. */
export type TrajectoryHealthState =
  /** Probe in flight; nothing decided yet. */
  | { kind: "probing" }
  /** 200 + authReady:true - the inspector has scraped the owner token. */
  | { kind: "ready" }
  /** 200 + authReady:false - up, but not attached to the sandbox yet. */
  | { kind: "starting" }
  /** Refused / timed out / non-200 - this is the #2546 symptom. */
  | { kind: "unreachable"; error: string };

export function trajectoryPortFrom(raw: unknown): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return DEFAULT_TRAJECTORY_PORT;
  }
  return port;
}

/**
 * The inspector always serves on the loopback host, so hardcode 127.0.0.1 - NOT
 * window.location.hostname, which is `tauri.localhost` in the packaged/Debug
 * webview and makes the iframe load `http://tauri.localhost:7778` (blocked by
 * Tauri's protocol handler). Regressed in #864; only worked under `pnpm dev`.
 */
export function trajectoryOriginFor(port: number): string {
  return `http://127.0.0.1:${port}`;
}

export function trajectoryEmbedUrl(
  origin: string,
  sessionId: string | null | undefined,
): string {
  return `${origin}?session=${encodeURIComponent(sessionId ?? "")}&embed=1`;
}

export function parseTrajectoryHealth(
  status: number,
  body: unknown,
): TrajectoryHealthState {
  if (status !== 200) return { kind: "unreachable", error: `HTTP ${status}` };
  // Tolerate payload skew: a listening inspector is strictly better news than a
  // refused connection, so anything we cannot parse degrades to "starting".
  const authReady =
    body && typeof body === "object"
      ? (body as { authReady?: unknown }).authReady === true
      : false;
  return authReady ? { kind: "ready" } : { kind: "starting" };
}

export function shouldRenderTrajectoryFrame(state: TrajectoryHealthState): boolean {
  return state.kind === "ready" || state.kind === "starting";
}

export async function probeTrajectoryHealth(opts: {
  origin: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<TrajectoryHealthState> {
  const { origin, signal } = opts;
  const timeoutMs = opts.timeoutMs ?? TRAJECTORY_HEALTH_TIMEOUT_MS;
  const fetchImpl = isTauriRuntime() ? tauriFetch : globalThis.fetch;

  const controller =
    typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => controller.abort(), timeoutMs)
    : undefined;
  const onExternalAbort = () => controller?.abort();
  if (signal && controller) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onExternalAbort);
  }

  try {
    const response = await fetchImpl(`${origin}/health`, {
      method: "GET",
      headers: { Accept: "application/json" },
      ...(controller ? { signal: controller.signal } : {}),
    });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null; // handled by parseTrajectoryHealth's skew tolerance
    }
    return parseTrajectoryHealth(response.status, body);
  } catch (error) {
    const name = (error as { name?: string } | null)?.name;
    if (name === "AbortError" || name === "TimeoutError") {
      return { kind: "unreachable", error: `timeout after ${timeoutMs}ms` };
    }
    const message =
      error instanceof Error ? error.message : String(error ?? "unknown error");
    return { kind: "unreachable", error: message };
  } finally {
    clearTimeout(timer);
    if (signal && controller) signal.removeEventListener("abort", onExternalAbort);
  }
}

/**
 * Operator-facing copy for the failure panel. Lives here, not in the TSX, so a
 * test can pin that the log paths #2546 asks for are actually surfaced.
 */
export function trajectoryDiagnostics(
  state: TrajectoryHealthState,
  origin: string,
): { headline: string; detail: string; steps: string[] } {
  const error = state.kind === "unreachable" ? state.error : "unknown error";
  return {
    headline: "Trajectory Inspector isn't reachable",
    detail:
      `Nothing answered GET ${origin}/health (${error}). The inspector is a ` +
      "separate host process (superclaw-trajectory.exe) that sandbox-manager " +
      "starts once the backend runtime deployment reaches Ready.",
    steps: [
      "Check the Status tab: the runtime must reach Ready before sandbox-manager starts the inspector.",
      `Inspector log: ${TRAJECTORY_INSPECTOR_LOG_PATH}`,
      `Manager log - search for [trajectory]: ${SANDBOX_MANAGER_LOG_GLOB}`,
      `Binary missing? Check ${TRAJECTORY_EXE_PATH}, then re-stage it with: packaging\\installer\\build-superclaw.ps1 -Configuration Debug`,
      "Debug builds only: the sandbox-manager process needs SUPERCLAW_DEBUG_OBSERVABILITY=1.",
    ],
  };
}
