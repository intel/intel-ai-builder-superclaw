import { invoke } from "@tauri-apps/api/core";

import { isTauriRuntime } from "../utils";
import { isSuppressedFrontendCrash } from "./crash-suppression";
import { appBuildInfo } from "~/shared/platform/tauri/tauri.engine";

const MAX_ERROR_CHARS = 280;
const MAX_STACK_CHARS = 1600;

export type FrontendCrashEvent = {
  event_name: "crash_reported";
  source: "frontend";
  runtime: "frontend";
  outcome: "failed";
  app_version: string;
  channel: "stable" | "beta" | "dev";
  error_class: string;
  error: string;
  stack?: string;
};

export type FrontendUsageEvent =
  | {
      event_name: "project_opened";
      workspace_type: "local" | "remote" | "unknown";
    }
  | {
      event_name: "feedback_submitted";
      feedback_mode: "mailto" | "github_issue" | "ingest" | "unknown";
      outcome: "success" | "error" | "unknown";
    }
  | {
      event_name: "sandbox_ready";
      outcome: StartupOutcome;
      error_class: SandboxReadyErrorClass;
    };

export type SandboxReadyErrorClass =
  | "unknown"
  | "servicehub_unavailable"
  | "sandbox_start_failed"
  | "owt_unavailable"
  | "deadline_exceeded"
  | "cancelled_by_user";

// Set from the Tauri backend's `release_channel()` (single source of truth for
// debug vs. release builds); falls back to the Vite build mode until that
// resolves, or when running outside Tauri (e.g. unit tests).
let backendReleaseChannel: "stable" | "beta" | "dev" | null = null;

function releaseChannelFromViteMode(): "stable" | "beta" | "dev" {
  const mode = (import.meta.env.MODE ?? "").toLowerCase();
  if (mode === "production") return "stable";
  if (mode === "test") return "beta";
  return "dev";
}

if (isTauriRuntime()) {
  void appBuildInfo()
    .then((info) => {
      if (info.channel === "stable" || info.channel === "beta" || info.channel === "dev") {
        backendReleaseChannel = info.channel;
      }
    })
    .catch(() => {});
}

export function normalizeReleaseChannel(): "stable" | "beta" | "dev" {
  return backendReleaseChannel ?? releaseChannelFromViteMode();
}

export function scrubCrashText(input: unknown, maxChars: number): string {
  const raw = String(input ?? "").trim();
  if (!raw) return "unknown";

  // Strip URL query/hash fragments and obvious local filesystem paths.
  const withoutQuery = raw.replace(/https?:\/\/[^\s)]+/gi, (value) => {
    try {
      const parsed = new URL(value);
      return `${parsed.origin}${parsed.pathname}`;
    } catch {
      return value.replace(/[?#].*$/, "");
    }
  });

  const withoutPaths = withoutQuery
    .replace(/[A-Za-z]:\\Users\\[^\\\s]+/g, "~")
    .replace(/\/(Users|home)\/[^\s\n)]+/g, "~");

  return withoutPaths.length > maxChars
    ? `${withoutPaths.slice(0, maxChars - 3)}...`
    : withoutPaths;
}

export function buildFrontendCrashEvent(input: {
  appVersion?: string | null;
  errorClass: string;
  error: unknown;
  stack?: unknown;
  channel?: "stable" | "beta" | "dev";
}): FrontendCrashEvent {
  const stack = scrubCrashText(input.stack, MAX_STACK_CHARS);
  const event: FrontendCrashEvent = {
    event_name: "crash_reported",
    source: "frontend",
    runtime: "frontend",
    outcome: "failed",
    app_version: (input.appVersion ?? "unknown").trim() || "unknown",
    channel: input.channel ?? normalizeReleaseChannel(),
    error_class: scrubCrashText(input.errorClass, 120),
    error: scrubCrashText(input.error, MAX_ERROR_CHARS),
  };

  if (stack !== "unknown") {
    event.stack = stack;
  }

  return event;
}

export async function emitTelemetryEvent(event: Record<string, unknown>): Promise<boolean> {
  if (!isTauriRuntime()) return false;

  try {
    return await invoke<boolean>("emit_telemetry", { event });
  } catch {
    return false;
  }
}

export function buildProjectOpenedEvent(
  workspaceType: "local" | "remote" | "unknown",
): FrontendUsageEvent {
  return {
    event_name: "project_opened",
    workspace_type: workspaceType,
  };
}

export function buildFeedbackSubmittedEvent(input: {
  feedbackMode: "mailto" | "github_issue" | "ingest" | "unknown";
  outcome: "success" | "error" | "unknown";
}): FrontendUsageEvent {
  return {
    event_name: "feedback_submitted",
    feedback_mode: input.feedbackMode,
    outcome: input.outcome,
  };
}

export function buildSandboxReadyEvent(
  outcome: StartupOutcome,
  errorClass: SandboxReadyErrorClass,
): FrontendUsageEvent {
  return {
    event_name: "sandbox_ready",
    outcome,
    error_class: errorClass,
  };
}

export type StartupPhase =
  | "servicehub_boot"
  | "sandbox_provision"
  | "model_download"
  | "container_start"
  | "ready";

export type StartupOutcome = "success" | "failed" | "timeout" | "cancelled";

/**
 * Emit a `startup_phase` telemetry event from the frontend.
 *
 * Used for phases that are only observable in the UI (model download, container
 * start, etc.) and are invisible to the Rust boot thread. The Rust side already
 * emits `servicehub_boot`; this covers the remaining five phase values.
 *
 * No-ops outside a Tauri runtime or when telemetry is unavailable.
 */
export async function emitStartupPhase(
  phase: StartupPhase,
  outcome: StartupOutcome = "success",
  errorClass = "unknown",
  error?: string,
): Promise<boolean> {
  const event: Record<string, unknown> = {
    event_name: "startup_phase",
    phase,
    outcome,
    error_class: errorClass,
  };
  if (error) {
    event.error = error;
  }
  return emitTelemetryEvent(event);
}

export async function emitSandboxReady(
  outcome: StartupOutcome,
  errorClass: SandboxReadyErrorClass,
): Promise<boolean> {
  return await emitTelemetryEvent(buildSandboxReadyEvent(outcome, errorClass));
}

export function createSandboxReadyReporter(
  emit: typeof emitSandboxReady = emitSandboxReady,
): (outcome: StartupOutcome, errorClass: SandboxReadyErrorClass) => boolean {
  let finished = false;
  return (outcome, errorClass) => {
    if (finished) return false;
    finished = true;
    void emit(outcome, errorClass);
    return true;
  };
}

export async function trackProjectOpened(
  workspaceType: "local" | "remote" | "unknown",
): Promise<boolean> {
  return await emitTelemetryEvent(buildProjectOpenedEvent(workspaceType));
}

export async function trackFeedbackSubmitted(input: {
  feedbackMode: "mailto" | "github_issue" | "ingest" | "unknown";
  outcome: "success" | "error" | "unknown";
}): Promise<boolean> {
  return await emitTelemetryEvent(buildFeedbackSubmittedEvent(input));
}

export function installFrontendCrashHandlers(options: {
  fullTelemetryEnabled: () => boolean;
  appVersion: () => string | null;
  channel?: "stable" | "beta" | "dev";
}): () => void {
  if (typeof window === "undefined") return () => undefined;

  const onError = (event: Event) => {
    if (!options.fullTelemetryEnabled()) return;

    const errorEvent = event as ErrorEvent;
    if (isTauriRuntime() && isSuppressedFrontendCrash(errorEvent.error ?? errorEvent.message)) {
      errorEvent.preventDefault();
      return;
    }

    const payload = buildFrontendCrashEvent({
      appVersion: options.appVersion(),
      channel: options.channel,
      errorClass: errorEvent.error?.name || "Error",
      error: errorEvent.message || errorEvent.error?.message || "unknown",
      stack: errorEvent.error?.stack,
    });
    void emitTelemetryEvent(payload);
  };

  const onUnhandledRejection = (event: Event) => {
    if (!options.fullTelemetryEnabled()) return;

    const rejection = event as PromiseRejectionEvent;
    const reason = rejection.reason;
    if (isTauriRuntime() && isSuppressedFrontendCrash(reason)) {
      rejection.preventDefault();
      return;
    }

    const payload = buildFrontendCrashEvent({
      appVersion: options.appVersion(),
      channel: options.channel,
      errorClass: reason?.name || "UnhandledRejection",
      error: reason?.message || reason,
      stack: reason?.stack,
    });
    void emitTelemetryEvent(payload);
  };

  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onUnhandledRejection);

  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onUnhandledRejection);
  };
}
