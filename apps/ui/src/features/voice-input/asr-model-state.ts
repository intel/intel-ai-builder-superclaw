/**
 * Pure mapping from an `asr_manager` download snapshot to what the Settings →
 * Voice input page (and the microphone button) shows. Kept separate from the
 * client so the state machine is testable without a transport.
 */
import type { AsrDownloadSnapshot } from "./asr-client";

export type VoiceModelState =
  /** No snapshot yet (service not probed, or the probe failed). */
  | "unknown"
  /** Weights absent from disk — the 630 MB consent dialog is the next step. */
  | "not_downloaded"
  /** Fetching or verifying the weights. */
  | "downloading"
  /** Weights present, being loaded into RAM. */
  | "loading"
  /** Usable right now. */
  | "ready"
  /** A download/verify/load failed; `snapshot.error` says why. Retryable. */
  | "error";

/**
 * Snapshot → page state.
 *
 * Order matters and follows the contract's table, with one product decision
 * spelled out: **weights on disk with the service idle counts as `ready`.**
 * The model is not resident, but the user's next microphone press loads it
 * on demand, so reporting anything else would describe an internal lifecycle
 * rather than what the user can do.
 */
export function voiceModelStateFromSnapshot(
  snapshot: AsrDownloadSnapshot | null,
): VoiceModelState {
  if (!snapshot) return "unknown";
  if (snapshot.state === "error") return "error";
  if (snapshot.state === "downloading" || snapshot.state === "verifying") {
    return "downloading";
  }
  if (snapshot.state === "loading") return "loading";
  if (snapshot.state === "ready" || snapshot.model_loaded) return "ready";
  return snapshot.weights_present ? "ready" : "not_downloaded";
}

/**
 * Download progress as a 0–100 percentage, or null while the total is unknown.
 *
 * Null rather than 0: a progress bar pinned at 0 % reads as a stalled transfer,
 * which is exactly what the byte totals cannot tell us before the first sample
 * lands.
 */
export function downloadPercent(snapshot: AsrDownloadSnapshot | null): number | null {
  if (!snapshot || snapshot.total_bytes <= 0) return null;
  const pct = (snapshot.done_bytes / snapshot.total_bytes) * 100;
  return Math.max(0, Math.min(100, pct));
}

/** True while polling should continue (work is in flight on the service). */
export function isVoiceModelSettling(state: VoiceModelState): boolean {
  return state === "downloading" || state === "loading";
}
