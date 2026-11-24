/// <reference path="../../global.d.ts" />

/**
 * In-app feedback submit routing (see `feedback-modal.tsx`).
 *
 * | Runtime | `__BUILD_DEBUG__` | `FEEDBACK_AWS_INGEST_SHIPPING_ENABLED` | Primary path |
 * |---------|-------------------|----------------------------------------|--------------|
 * | Web | — | — | GitHub → mailto |
 * | Tauri shipping | false | false (now) | GitHub → mailto |
 * | Tauri debug / dev | true | — | AWS `{OTEL}/feedback` → GitHub → mailto |
 * | Tauri shipping (future) | false | true | AWS → GitHub → mailto |
 *
 * Host POST: `feedback_ingest.rs` (`submit_feedback`) enforces the same gate (`debug_assertions`
 * or shipping flag) and returns `no_endpoint` before HTTP when blocked. Release MSI UI builds
 * strip `BUILD_DEBUG` in `tauri-before-build.mjs`, matching Rust release (`debug_assertions` off).
 */

import type { FeedbackCategory, FeedbackSubmitResult } from "./tauri";
import { readAppPrefs, submitFeedback } from "./tauri";
import { isTauriRuntime } from "../utils";
import { resolveFeedbackIngestOs } from "./feedback-ingest-os";
import { normalizeReleaseChannel } from "./telemetry";

export type FeedbackIngestHostOutcome =
  | { status: "accepted"; feedbackId: string | null }
  | { status: "no_endpoint" }
  | { status: "quota_exceeded" }
  | { status: "error"; message: string };

/**
 * Flip to `true` in a future release (and the matching const in `feedback_ingest.rs`) to POST
 * shipping desktop feedback to AWS (`{OTEL}/feedback`) before GitHub/mailto fallbacks.
 */
export const FEEDBACK_AWS_INGEST_SHIPPING_ENABLED = false;

/** Pure selector — unit-tested; mirrors debug vs shipping UI bundles. */
export function feedbackAwsIngestEnabledForBuild(
  isTauri: boolean,
  buildDebug: boolean,
  shippingIngestEnabled: boolean = FEEDBACK_AWS_INGEST_SHIPPING_ENABLED,
): boolean {
  if (!isTauri) return false;
  if (buildDebug) return true;
  return shippingIngestEnabled;
}

function isBuildDebugBundle(): boolean {
  const fromGlobal = (globalThis as typeof globalThis & { __BUILD_DEBUG__?: boolean })
    .__BUILD_DEBUG__;
  if (typeof fromGlobal === "boolean") {
    return fromGlobal;
  }
  try {
    return __BUILD_DEBUG__;
  } catch {
    // Bun unit tests without Vite `define` → shipping (GitHub default).
    return false;
  }
}

/** Unit tests and modal gate (Bun may pass explicit `buildDebug`). */
export function shouldSubmitFeedbackViaAwsIngestForBuild(
  isTauri: boolean,
  buildDebug: boolean,
  shippingIngestEnabled: boolean = FEEDBACK_AWS_INGEST_SHIPPING_ENABLED,
): boolean {
  return feedbackAwsIngestEnabledForBuild(isTauri, buildDebug, shippingIngestEnabled);
}

/** Whether the feedback modal should call the host AWS ingest path before GitHub. */
export function shouldSubmitFeedbackViaAwsIngest(): boolean {
  return shouldSubmitFeedbackViaAwsIngestForBuild(
    isTauriRuntime(),
    isBuildDebugBundle(),
  );
}

/**
 * Canonical snapshot of fields the modal controls for AWS ingest idempotency.
 * When this changes between attempts, the client must use a new idempotency key.
 */
export function feedbackIngestIdempotencyBodyKey(input: {
  message: string;
  category: FeedbackCategory;
  appVersion: string;
  optionalDebugReport: string | null;
}): string {
  return JSON.stringify({
    message: input.message,
    category: input.category,
    appVersion: input.appVersion,
    optionalDebugReport: input.optionalDebugReport,
  });
}

/** Maps the Tauri command result into UI-friendly outcomes (unit-tested). */
export function mapFeedbackIngestHostResult(
  result: FeedbackSubmitResult,
): FeedbackIngestHostOutcome {
  if (result.status === "accepted") {
    return { status: "accepted", feedbackId: result.feedbackId };
  }
  if (result.status === "no_endpoint") {
    return { status: "no_endpoint" };
  }
  if (result.status === "quota_exceeded") {
    return { status: "quota_exceeded" };
  }
  return { status: "error", message: result.status.trim() || "unknown" };
}

/** POST feedback through the host ingest path when OTLP/feedback edge is configured. */
export async function submitFeedbackToIngestHost(input: {
  message: string;
  category: FeedbackCategory;
  appVersion: string;
  optionalDebugReport?: string | null;
  idempotencyKey?: string;
}): Promise<FeedbackIngestHostOutcome> {
  if (!shouldSubmitFeedbackViaAwsIngest()) {
    // Product gate: shipping/web use GitHub from the modal without calling the host.
    return { status: "no_endpoint" };
  }
  try {
    const prefs = await readAppPrefs();
    const result = await submitFeedback({
      message: input.message,
      category: input.category,
      appVersion: input.appVersion,
      installId: prefs.installId ?? null,
      os: resolveFeedbackIngestOs(),
      channel: normalizeReleaseChannel(),
      optionalDebugReport: input.optionalDebugReport ?? null,
      idempotencyKey: input.idempotencyKey?.trim() || null,
    });
    return mapFeedbackIngestHostResult(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: "error", message };
  }
}
