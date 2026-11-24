/**
 * Degraded-Edge startup state (#3531): the committed Edge server has not connected,
 * so the app opened without an active Profile.
 *
 * `connecting`: the Edge activation outlived its reveal grace period and is still
 * running in the background. `unreachable`: it failed because the server could not be
 * reached or rejected the key. The startup resolver sets and clears it, and registers
 * the Retry the session banner calls. Retry re-runs the resolver's activation, which
 * adopts an operation that is already in flight instead of racing it.
 *
 * A module signal for the same reason as `capability-startup-signal.ts`: the resolver
 * and the runtime tree are siblings under different providers.
 */
import { createSignal } from "solid-js";
import type { PrimaryBundlePrepareReasonCode } from "@different-ai/openwork-contracts/capability";

export type EdgeDegradedState = "connecting" | "unreachable";

export type EdgeDegraded = {
  state: EdgeDegradedState;
  bundleId: string;
  /** ServiceHub's public failure reason; null while connecting or when it gave none. */
  reasonCode: PrimaryBundlePrepareReasonCode | null;
  /** ServiceHub's secret-free failure message; null while connecting. */
  message: string | null;
  /** Edge connected, but the Profile read after it failed: Retry reads the Profile again. */
  profileLoadFailed?: boolean;
  /** The target Bundle's chat model, so the banner can name it. */
  modelLabel?: string;
};

const [edgeDegraded, setEdgeDegradedSignal] = createSignal<EdgeDegraded | null>(null);

export { edgeDegraded };

export function setEdgeDegraded(next: EdgeDegraded | null): void {
  setEdgeDegradedSignal(next);
}

let retryHandler: (() => void) | null = null;

/** Register the resolver's Retry. Returns the matching unregister. */
export function registerEdgeRetry(handler: () => void): () => void {
  retryHandler = handler;
  return () => {
    if (retryHandler === handler) retryHandler = null;
  };
}

/** Retry the Edge connection without restarting the app. */
export function retryEdgeConnection(): void {
  retryHandler?.();
}
