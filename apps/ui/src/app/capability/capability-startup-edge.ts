/**
 * Pure decisions for a committed Edge Bundle at startup (#3531).
 *
 * The Edge `connect` prepare runs discovery and two probes against a remote server,
 * serially and with a 10 s timeout each, so it must not own the startup screen. The
 * resolver waits EDGE_CONNECT_REVEAL_GRACE_MS for it, then opens the app degraded and
 * keeps polling. A connectivity or auth failure, or a server that no longer serves the
 * committed Bundle, becomes the in-app Edge banner instead of the blocking startup
 * overlay. Any other failure keeps the overlay while it is still on screen.
 */
import type {
  ModelBindingActivationOperation,
  PrimaryBundleCapability,
  PrimaryBundlePrepareReasonCode,
} from "@different-ai/openwork-contracts/capability";
import type { EdgeDegraded } from "~/shared/platform/capability/edge-degraded-signal";

/** How long startup waits for a committed Edge Bundle to connect before opening the app. */
export const EDGE_CONNECT_REVEAL_GRACE_MS = 2500;

/** Banner cause when a Retry settled without starting an Edge connection. */
export const EDGE_RETRY_NOT_STARTED = "SuperClaw couldn't start the Edge connection";

/** Reasons the user fixes on the server or in Edge settings, not by restarting. */
const DEGRADING_REASONS: ReadonlySet<PrimaryBundlePrepareReasonCode> = new Set([
  "url_unreachable",
  "invalid_api_key",
  "model_not_found",
  "bundle_incomplete",
]);

/** Whether the activation target is an Edge Bundle, read from its row's backend. */
export function isEdgeTarget(capability: PrimaryBundleCapability, bundleId: string): boolean {
  const row = capability.supported_bundles.find((bundle) => bundle.bundle_id === bundleId);
  if (row) return row.backend === "edge";
  return capability.primary_bundle?.bundle_id === bundleId && capability.primary_bundle.backend === "edge";
}

/** The target's chat model name; a stale committed Bundle may have no row any more. */
export function edgeModelLabel(capability: PrimaryBundleCapability, bundleId: string): string | null {
  const row = capability.supported_bundles.find((bundle) => bundle.bundle_id === bundleId);
  if (row) return row.chat_model_label;
  return capability.primary_bundle?.bundle_id === bundleId ? capability.primary_bundle.chat_model_id : null;
}

export function edgeConnecting(bundleId: string): EdgeDegraded {
  return { state: "connecting", bundleId, reasonCode: null, message: null };
}

/**
 * The degraded state a failed Edge activation leaves, or null to keep today's
 * blocking overlay. Once the app is revealed the overlay is gone, so any Edge
 * failure goes to the banner.
 */
export function edgeActivationFailure(
  op: ModelBindingActivationOperation,
  edgeTargetBundleId: string | null,
  revealed: boolean,
  modelLabel: string | null = null,
): EdgeDegraded | null {
  if (edgeTargetBundleId === null || op.status !== "failed") return null;
  const reasonCode = op.error.code === "safe_error" ? op.error.reason_code ?? null : null;
  if (!revealed && (reasonCode === null || !DEGRADING_REASONS.has(reasonCode))) return null;
  const degraded: EdgeDegraded = { state: "unreachable", bundleId: edgeTargetBundleId, reasonCode, message: op.error.message };
  return modelLabel ? { ...degraded, modelLabel } : degraded;
}

/**
 * A request error while already degraded (a poll or a Retry could not reach
 * ServiceHub): show it on the banner, since the overlay is gone. Null otherwise.
 */
export function edgeRequestFailure(current: EdgeDegraded | null, message: string): EdgeDegraded | null {
  // Not a Profile-read failure any more, so Retry must go back through the activation.
  return current ? { state: "unreachable", bundleId: current.bundleId, reasonCode: null, message } : null;
}
