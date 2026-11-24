/**
 * The startup resolver's Edge state (#3531), kept out of the resolver for its size limit.
 *
 * Owns the reveal grace timer, the degraded-Edge signal transitions, and the banner's
 * Retry. The resolver reports what its activation does (target, polls, failures,
 * request errors); the pure decisions live in `capability-startup-edge.ts`.
 * Create it inside the resolver component: it registers an effect and cleanups.
 */
import { createEffect, onCleanup, untrack } from "solid-js";
import type { ModelBindingActivationOperation, PrimaryBundleCapability } from "@different-ai/openwork-contracts/capability";
import { edgeDegraded, registerEdgeRetry, setEdgeDegraded } from "~/shared/platform/capability/edge-degraded-signal";
import type { AppCapabilityContextValue } from "~/shared/platform/capability/app-capability-provider";
import { uiLogWarn } from "../lib/log";
import {
  EDGE_CONNECT_REVEAL_GRACE_MS,
  EDGE_RETRY_NOT_STARTED,
  edgeActivationFailure,
  edgeConnecting,
  edgeModelLabel,
  edgeRequestFailure,
  isEdgeTarget,
} from "./capability-startup-edge";

export type EdgeStartupControllerDeps = {
  cap: Pick<AppCapabilityContextValue, "state" | "refresh">;
  revealed: () => boolean;
  cancelled: () => boolean;
  setOperationPending: (pending: boolean) => void;
  switchError: () => string | null;
  setSwitchError: (error: string | null) => void;
  /** Drop the resolver's poll and retry bookkeeping before a banner Retry. */
  resetForRetry: () => void;
  runActivation: () => Promise<void>;
};

export function createEdgeStartupController(deps: EdgeStartupControllerDeps) {
  const status = () => deps.cap.state().status;
  let targetBundleId: string | null = null;
  let targetModelLabel: string | null = null;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  let pollsStarted = 0;
  // The current activation was observed succeeded: only then is a failed Profile read the
  // whole problem, and Retry may just read the Profile again.
  let activationSucceeded = false;

  const clearGrace = () => {
    if (graceTimer) clearTimeout(graceTimer);
    graceTimer = null;
  };

  // An Edge connect still running after the grace period opens the app degraded; the
  // operation keeps polling and its outcome updates the banner.
  const armGrace = () => {
    clearGrace();
    const bundleId = targetBundleId;
    if (bundleId === null || edgeDegraded() !== null) return;
    graceTimer = setTimeout(() => {
      graceTimer = null;
      if (!deps.cancelled() && edgeDegraded() === null && status() !== "active") setEdgeDegraded(edgeConnecting(bundleId));
    }, EDGE_CONNECT_REVEAL_GRACE_MS);
  };

  /** Show a request error on the banner when already degraded; true when it did. */
  const absorbRequestError = (message: string): boolean => {
    clearGrace();
    const degraded = edgeRequestFailure(edgeDegraded(), message);
    if (degraded) setEdgeDegraded(degraded);
    return degraded !== null;
  };

  // A committed Profile ends the degraded Edge state, whichever path committed it.
  createEffect(() => {
    if (status() !== "active") return;
    clearGrace();
    setEdgeDegraded(null);
  });
  onCleanup(clearGrace);

  // The Profile read after a succeeded activation failed. The provider retries only 503s,
  // and the degraded reveal outranks its transport_error hold, so the banner must say it
  // and offer Retry. Before success the operation poll still owns the outcome.
  createEffect(() => {
    const state = deps.cap.state();
    if (state.status !== "transport_error" || !activationSucceeded) return;
    const current = untrack(edgeDegraded);
    if (current?.state !== "connecting") return;
    setEdgeDegraded({ ...current, state: "unreachable", reasonCode: null, message: state.error.message, profileLoadFailed: true });
  });

  // The banner's Retry re-runs the activation without an app restart. A Settings
  // reconnect already in flight is adopted (409 in runActivation), not raced.
  onCleanup(registerEdgeRetry(() => {
    const current = edgeDegraded();
    if (!current || current.state === "connecting") return;
    setEdgeDegraded(edgeConnecting(current.bundleId));
    // Only the Profile read failed: read it again. Active clears the banner; another
    // transport_error brings the failure back through the effect above.
    if (current.profileLoadFailed && activationSucceeded) {
      void deps.cap.refresh();
      return;
    }
    deps.resetForRetry();
    deps.setSwitchError(null);
    // runActivation can settle without polling (a null request, an unsupported
    // Bundle, a busy gate); its error is invisible after reveal, so show it here.
    const polls = pollsStarted;
    void deps.runActivation().finally(() => {
      if (pollsStarted !== polls || edgeDegraded()?.state !== "connecting") return;
      setEdgeDegraded(edgeRequestFailure(edgeDegraded(), deps.switchError() ?? EDGE_RETRY_NOT_STARTED));
    });
  }));

  return {
    /** The reveal policy's `edgeDegraded` input. */
    state: () => edgeDegraded()?.state ?? null,
    isTarget: () => targetBundleId !== null,
    /** Re-arm the grace before resuming a poll; a no-op unless the target is Edge. */
    armGrace,
    /** The activation is about to start for `bundleId`: arm the grace when it is Edge. */
    setTarget(capability: PrimaryBundleCapability, bundleId: string): void {
      targetBundleId = isEdgeTarget(capability, bundleId) ? bundleId : null;
      targetModelLabel = targetBundleId ? edgeModelLabel(capability, targetBundleId) : null;
      activationSucceeded = false;
      armGrace();
    },
    /** The operation poll saw `succeeded`; the Profile refresh follows. */
    succeeded(): void {
      clearGrace();
      activationSucceeded = true;
    },
    pollStarted(): void {
      pollsStarted += 1;
    },
    /**
     * A failed operation: true when the Edge banner took it, so the overlay must not.
     * `beforeHandoff` is the resolver's `surface-error` case (Phase C not started).
     */
    routeFailure(op: ModelBindingActivationOperation, beforeHandoff: boolean): boolean {
      clearGrace();
      const degraded = beforeHandoff ? edgeActivationFailure(op, targetBundleId, deps.revealed(), targetModelLabel) : null;
      setEdgeDegraded(degraded);
      if (!degraded) return false;
      deps.setOperationPending(false);
      uiLogWarn("capability.edge", "Edge activation failed; showing the in-app banner", {
        bundleId: degraded.bundleId,
        reasonCode: degraded.reasonCode,
      });
      return true;
    },
    absorbRequestError,
    /** A request error the overlay shows; also routed to the banner when degraded. */
    relayRequestError(message: string): string {
      absorbRequestError(message);
      return message;
    },
  };
}
