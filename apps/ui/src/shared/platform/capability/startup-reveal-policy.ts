/**
 * Whether the startup resolver may reveal the runtime app.
 *
 * Reveal unmounts the whole startup fallback subtree — the boot overlay, the hardware
 * requirements dialog, and the download dialog — so it must not fire while any of
 * those still owns the decision. The hardware dialog was already guarded; the
 * download dialog was not, which let the app mount while a consent prompt was
 * unanswered or a multi-GB transfer was still running (issue 1661, defect 1).
 *
 * Extracted as a pure rule because the failure is invisible to a type check and was
 * only caught by comparing wall-clock logs: the app mounted 9.7 s before the first
 * asset finished downloading, and 17.5 s before the second.
 */

/** Capability profile status, narrowed to what the reveal decision needs. */
export type RevealProfileStatus = "loading" | "initializing" | "active" | "recovery" | "transport_error";

/** Download-dialog phases that still owe the user an outcome. */
export type RevealPromptPhase = "consent" | "downloading" | "ready" | null;

export type RevealInputs = {
  status: RevealProfileStatus;
  /** Minimum overlay dwell has elapsed. */
  minElapsed: boolean;
  dataPlaneReady: boolean;
  dataPlaneTimedOut: boolean;
  /** A first-install operation still needs a terminal success observation. */
  operationPending: boolean;
  /** The active Profile's committed local Bundle has not passed its cache check. */
  primaryBundleCheckPending: boolean;
  /** A blocking hardware preflight failure is on screen. */
  hardwareBlocked: boolean;
  /** Phase of the download dialog, or null when it is closed. */
  promptPhase: RevealPromptPhase;
  /**
   * The consent sequence is running, covering the gap before the download dialog.
   *
   * `promptPhase` is null until `setDownloadPrompt` runs. The separate latch keeps
    * reveal from unmounting the startup fallback during that setup interval.
   */
  consentFlowActive: boolean;
  /**
   * The committed Edge server is still connecting past its grace period, or is
   * unreachable (#3531). The app opens without a Profile and says why in a banner,
   * instead of holding the overlay on a probe that may never answer.
   */
  edgeDegraded: "connecting" | "unreachable" | null;
};

export type RevealDecision = "reveal-gated" | "reveal-passthrough" | "hold";
export type ActivationErrorSurface = "download-dialog" | "startup-overlay";

/** Keep post-consent failures on the dialog that currently owns the screen. */
export function resolveActivationErrorSurface(
  downloadIntent: boolean,
  promptPhase: RevealPromptPhase,
): ActivationErrorSurface {
  return downloadIntent && promptPhase !== null
    ? "download-dialog"
    : "startup-overlay";
}

/**
 * `consent` and `downloading` are unresolved: the user has not chosen, or bytes are
 * still moving. `ready` does not owe a decision — but it is still on screen, which is a
 * separate question the reveal has to respect (see `dialogHoldsScreen`).
 */
export function promptOwesUserAnOutcome(phase: RevealPromptPhase): boolean {
  return phase === "consent" || phase === "downloading";
}

/**
 * Whether the download dialog is still on screen and must not be yanked away.
 *
 * Wider than `promptOwesUserAnOutcome` because it includes `ready`. That phase exists
 * precisely so the finished state is perceivable — it is held for a bounded ~1.6 s and
 * then closes itself. Letting the reveal fire during it unmounts the dialog within a
 * frame, which is exactly the "never saw it reach ready" report: once a boot-time
 * resume has already fetched the assets, verification hits its record fast path
 * (measured: prepare to commit in 0.19 s with no hashing) and the data plane is long
 * settled, so `ready` and the reveal land together every time.
 */
export function dialogHoldsScreen(phase: RevealPromptPhase): boolean {
  return phase !== null;
}

export function resolveReveal(input: RevealInputs): RevealDecision {
  // A blocked machine must stay behind the requirements dialog until the user exits.
  if (input.hardwareBlocked) return "hold";

  // Any startup dialog still awaiting the user owns the screen. Revealing unmounts it
  // without resolving it, which skips the download flow entirely rather than merely
  // hiding it. `consentFlowActive` covers the setup tick before the prompt exists.
  if (input.consentFlowActive) return "hold";
  if (dialogHoldsScreen(input.promptPhase)) return "hold";
  // A degraded Edge opens the app with no Profile: the Edge operation keeps polling
  // in the background, and no data plane starts until a Profile commits.
  if (input.edgeDegraded !== null) return input.minElapsed ? "reveal-gated" : "hold";
  if (input.operationPending) return "hold";
  if (input.primaryBundleCheckPending) return "hold";

  // Gating OFF: when no startup dialog owns the screen, app.tsx's own V1.1 overlay
  // stays in charge. A transient transport failure must not unmount an active dialog.
  if (input.status === "transport_error") return "reveal-passthrough";

  const dataPlaneSettled = input.dataPlaneReady || input.dataPlaneTimedOut;
  return input.status === "active" && input.minElapsed && dataPlaneSettled
    ? "reveal-gated"
    : "hold";
}
