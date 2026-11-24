import { invoke } from "@tauri-apps/api/core";

/**
 * Set window decorations (titlebar) visibility.
 * When `decorations` is false, the native titlebar is hidden.
 * Useful for tiling window managers on Linux (e.g., Hyprland, i3, sway).
 */
export async function setWindowDecorations(decorations: boolean): Promise<void> {
  return invoke<void>("set_window_decorations", { decorations });
}

/**
 * Default window dimensions matching `tauri.conf.json`.
 * Defined here to avoid duplicating magic numbers across the frontend.
 */
export const DEFAULT_WINDOW_WIDTH = 1280;

export const DEFAULT_WINDOW_HEIGHT = 820;

/**
 * Set (or clear) the minimum inner size of the main window.
 * Pass width/height > 0 to enforce a minimum; pass exactly 0/0 to clear it.
 * Any other combination (e.g. one dimension zero, negative values) is rejected.
 */
export async function setWindowMinSize(width: number, height: number): Promise<void> {
  return invoke<void>("set_window_min_size", { width, height });
}

/**
 * Set the inner size of the main window.
 * Both width and height must be positive.
 */
export async function setWindowSize(width: number, height: number): Promise<void> {
  return invoke<void>("set_window_size", { width, height });
}

// ── App preferences ─────────────────────────────────────────────────────────
//
// Persisted to <app_config_dir>/app_prefs.json so the Rust shutdown handler
// can read them synchronously even when the webview is gone.

export type AppPrefs = {
  /**
   * When true, the app exit handler leaves backend-manager, llama-server,
   * and the sandbox services alive so the next launch can reconnect via
   * the existing REUSE handshake (faster cold start). Default false.
   */
  keepBackendOnExit: boolean;
  /**
   * Full telemetry consent gate (opt-in crash reports). Default false.
   */
  fullTelemetryEnabled: boolean;
  /** Baseline install/runtime telemetry gate (opt-out). Default true; */
  baselineTelemetryEnabled: boolean;
  /**
   * Pseudonymous install UUIDv4. Null until baseline or telemetry is first on.
   * Rust-managed: the frontend must never author this. `write_app_prefs`
   * preserves it across a round-trip, so passing null/stale here is safe.
   */
  installId: string | null;
  /**
   * Epoch millis of the last active_install heartbeat (dedupe cursor).
   * Rust-managed; same preservation semantics as `installId`.
   */
  lastHeartbeatAt: number | null;
  /** Per-install telemetry consent completed (read-only in UI; Rust sets on first launch). */
  installTelemetryConsentCompleted: boolean;
  /** Last installer consent revision applied by Rust; read-only in UI. */
  installTelemetryConsentRevision: string | null;
};

/**
 * The subset of `AppPrefs` the Settings UI may change. Rust-managed fields
 * (`installTelemetryConsentCompleted`, `installTelemetryConsentRevision`, `installId`,
 * `lastHeartbeatAt`) are excluded.
 */
export type AppPrefsUserPatch = Partial<
  Pick<AppPrefs, "keepBackendOnExit" | "fullTelemetryEnabled" | "baselineTelemetryEnabled">
>;

export async function readAppPrefs(): Promise<AppPrefs> {
  return invoke<AppPrefs>("read_app_prefs");
}

export async function writeAppPrefs(prefs: AppPrefs): Promise<void> {
  return invoke<void>("write_app_prefs", { prefs });
}

/**
 * Regenerate the anonymous install ID (the GDPR "reset your identifier"
 * control). Returns the new UUID.
 */
export async function resetInstallId(): Promise<string> {
  return invoke<string>("reset_install_id");
}

/**
 * Report the bundle ID a capability switch is targeting, before it commits.
 * Host telemetry uses this as a low-confidence fallback for `active_install`
 * when no bundle has committed yet (e.g. heartbeat fires mid-download).
 */
export async function cacheTargetBundleId(bundleId: string): Promise<void> {
  return invoke<void>("cache_target_bundle_id", { bundleId });
}

export async function readEnvVar(name: string): Promise<string | null> {
  return invoke<string | null>("read_env_var", { name });
}

// ── Feedback ingest ──
//
// `submit_feedback` is the host AWS ingest path when the UI enables it (debug
// Tauri today; shipping when `FEEDBACK_AWS_INGEST_SHIPPING_ENABLED` is true).
// The webview never talks to the ingest endpoint directly. `status: "no_endpoint"`
// means ingest is disabled or OTLP is unwired — fall back to GitHub/mailto.
// `status: "quota_exceeded"` is surfaced in the feedback modal via
// `submitFeedbackToIngestHost` (`feedback-ingest-host.ts`).

import type { FeedbackIngestCategory } from "@different-ai/openwork-contracts/feedback-ingest";

export type FeedbackCategory = FeedbackIngestCategory;

export type FeedbackSubmission = {
  message: string;
  category: FeedbackCategory;
  appVersion: string;
  installId: string | null;
  os: string;
  channel: string;
  optionalDebugReport?: string | null;
  idempotencyKey?: string | null;
};

export type FeedbackSubmitResult = {
  status: "accepted" | "no_endpoint" | "quota_exceeded" | string;
  feedbackId: string | null;
};

export async function submitFeedback(
  submission: FeedbackSubmission,
): Promise<FeedbackSubmitResult> {
  return invoke<FeedbackSubmitResult>("submit_feedback", { submission });
}

export type FeedbackIssueRepoSlug = {
  slug: string;
  publicSlug: string;
  /** True only when `slug` is the baked corp-network repository. */
  internal: boolean;
  email: string;
};

/** GitHub repo for feedback / bug-report prefills. */
export async function feedbackIssueRepoSlug(): Promise<FeedbackIssueRepoSlug> {
  return invoke<FeedbackIssueRepoSlug>("feedback_issue_repo_slug");
}
