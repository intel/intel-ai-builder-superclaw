import type { BootStep } from "../components/backend-boot-overlay";
import type { DownloadAsset } from "../components/download-confirm-dialog";
import type {
  ModelBindingActivationStage,
  PrimaryBundleCapability,
  RecoveryAppCapabilityProfile,
} from "@different-ai/openwork-contracts/capability";
import { Rocket } from "lucide-solid";
import { HardDriveDownload } from "lucide-solid";
import { Cpu } from "lucide-solid";
import { Container } from "lucide-solid";
import { CheckCircle2 } from "lucide-solid";
import { isTauriRuntime } from "../utils";
import { provisionFailureReasonIn, provisionFailureText } from "~/shared/platform/capability/activation-error-text";

/** Exit the desktop app (used when the user declines the model download). */
export function exitApp(): void {
  if (isTauriRuntime()) {
    import("@tauri-apps/plugin-process")
      .then((mod) => mod.exit(0))
      .catch(() => window.close());
  } else {
    window.close();
  }
}

/** One asset row in the first-launch download dialog (consent + live progress). */
export type PromptAsset = DownloadAsset;

/** Data + live state backing the first-launch download dialog. */
export type DownloadPrompt = {
  /**
   * consent → waiting for Confirm/Cancel; downloading → progress view;
   * ready → every asset settled, held briefly so the completion is perceivable.
   */
  phase: "consent" | "downloading" | "ready";
  modelName: string;
  assets: PromptAsset[];
  totalBytes: number;
  error: string | null;
  /** Resolve `true` to proceed with the download, `false` to cancel. */
  resolve: (confirmed: boolean) => void;
};

/** Steady cadence of the data-plane token poll, once the state it observes has held. */
export const OWT_POLL_MS = 1000;

export const OPERATION_POLL_MS = 1500;

/** Per-asset download progress poll cadence against LRM operations. */
export const DOWNLOAD_POLL_MS = 1000;

/**
 * How long the dialog holds on the all-complete state before closing.
 *
 * Without it the dialog vanished the instant the last asset flipped to
 * `complete`, so the finished state was never perceivable: the assets settle in
 * size order, and a 506 MB embedding verifies ~30x faster than a 20 GB chat
 * model, so its "ready" tick and the close could land inside the same 1 s poll
 * tick. Observed as the embedding row "flashing by" with no visible ready state.
 *
 * Only paths that actually show the dialog pay this: a cached bundle resolves to
 * `intent: "connect"` and skips the prompt entirely, so the ~2 s warm start is
 * unaffected. Against a first-launch verify (~15 s) or a real multi-GB download
 * this is noise, and it gives both a legible "models are ready" beat.
 */
export const READY_DWELL_MS = 1600;

/**
 * v1.2 clean-startup stepper — reflects the real capability activation flow
 * (NOT the V1.1 backend-manager stage taxonomy in backend-boot-policy.ts).
 *
 *   prepare   → Phase A/B kickoff: hardware detect, capability profile, ceiling
 *   init      → LRM up, profile check, switch kickoff
 *   download  → preparing: model weights download (shows live pct)
 *   activate  → activating: commit the selected bundle
 *   sandbox   → Phase C: waiting for the sandbox container to come up (owt 503)
 *   connect   → Phase C: container up, obtaining the workspace token (owt 404 → ready)
 *
 * The bands are re-weighted so the longest real waits (download + bringing the
 * sandbox up) own most of the bar, and the instant backend steps (activate)
 * only get a thin slice. This matches where time is actually spent instead of
 * parking at 90% during the container wait.
 */
export type StartupStepId = "init" | "download" | "activate" | "sandbox" | "connect";

export const STARTUP_STEPS: readonly BootStep[] = [
  { id: "init", label: "Init", icon: Rocket },
  { id: "download", label: "Download", icon: HardDriveDownload },
  { id: "activate", label: "Activate", icon: Cpu },
  { id: "sandbox", label: "Sandbox", icon: Container },
  { id: "connect", label: "Connect", icon: CheckCircle2 },
];

// Each step owns a fixed slice of the overall 0–100 progress bar. The bar is
// driven by these bands (never by a raw child-operation pct directly), so it
// advances monotonically across the whole startup instead of resetting per
// phase. The two real waits — `download` (first launch) and `sandbox` (the
// ~60s container bring-up) — get the widest bands so the bar keeps visibly
// moving through them. `activate` is an instant backend step (thin slice).
// The `connect` band tops out BELOW 100 while obtaining the workspace token;
// 100% is reserved for the moment the data plane is actually ready.
export const STEP_BAND: Record<StartupStepId, { start: number; end: number }> = {
  init: { start: 2, end: 12 },
  download: { start: 12, end: 55 },
  activate: { start: 55, end: 62 },
  sandbox: { start: 62, end: 85 }, // waiting for the container to start
  connect: { start: 85, end: 97 }, // container up, obtaining OWT token — stays <100
};

export const READY_PCT = 100; // only when data plane is confirmed ready

export type StepInfo = { step: StartupStepId; title: string; description: string };

export type PayloadStartup = { kind: "preparing"; info: StepInfo } | { kind: "failed"; error: string };

/**
 * The startup overlay for a sandbox-token refusal about the installed payload, or null for any
 * other code. `payload_preparing` is the sandbox step, timed from `preparingSinceMs`, when this
 * start first saw that code; `payload_in_use` stays on the sandbox step showing its remedy while
 * polling continues; `payload_failed` is terminal and its message carries the remedy.
 */
export function payloadStartup(
  refusal: { code: string; message: string },
  version: string | null,
  preparingSinceMs: number,
  nowMs: number,
): PayloadStartup | null {
  if (refusal.code === "payload_failed") {
    return { kind: "failed", error: refusal.message || "SuperClaw could not prepare its backend. Repair or reinstall SuperClaw." };
  }
  if (refusal.code === "payload_in_use") {
    return {
      kind: "preparing",
      info: {
        step: "sandbox",
        title: "Waiting for the previous backend to stop",
        description: refusal.message || "The previous SuperClaw backend is still running. Quit SuperClaw, wait a few seconds, then start it again.",
      },
    };
  }
  if (refusal.code !== "payload_preparing") return null;
  const elapsedSec = Math.max(0, Math.round((nowMs - preparingSinceMs) / 1000));
  return {
    kind: "preparing",
    info: {
      step: "sandbox",
      title: version ? `Preparing SuperClaw ${version}` : "Preparing SuperClaw",
      description: `Unpacking the new version (${elapsedSec}s)…`,
    },
  };
}

/** A startup failure to show, and whether Retry can change its outcome. */
export type StartupBlock = { message: string; retry: boolean };

/**
 * How long to keep re-reading capability while LRM re-probes an incomplete hardware
 * reading. Longer than LRM's longest re-probe backoff (15 s) plus one probe budget
 * (15 s), so each read window starts at least one new probe.
 */
export const HARDWARE_REPROBE_WINDOW_MS = 35_000;
export const HARDWARE_REPROBE_POLL_MS = 2_000;

/** LRM's hardware reading is incomplete (WMI timed out or failed); a later probe may fix it. */
export function hardwareProbeFailed(capability: PrimaryBundleCapability): boolean {
  return capability.hardware.detection_errors.length > 0;
}

/**
 * Re-read capability while the hardware reading stays incomplete, for at most
 * HARDWARE_REPROBE_WINDOW_MS. LRM re-probes in the background and never makes a
 * capability read wait for it, so one read cannot see the result.
 */
export async function readUntilHardwareKnown(
  first: PrimaryBundleCapability,
  read: () => Promise<PrimaryBundleCapability>,
  wait: (ms: number) => Promise<void>,
  now: () => number = Date.now,
): Promise<PrimaryBundleCapability> {
  const deadline = now() + HARDWARE_REPROBE_WINDOW_MS;
  let current = first;
  while (hardwareProbeFailed(current) && now() < deadline) {
    await wait(HARDWARE_REPROBE_POLL_MS);
    current = await read();
  }
  return current;
}

/** The committed local Bundle is not supported on this device and LRM recommends no other. */
export function unsupportedBundleBlock(capability: PrimaryBundleCapability, bundleId: string): StartupBlock {
  if (hardwareProbeFailed(capability)) {
    return {
      message: `SuperClaw couldn't read this device's hardware, so it can't confirm that the saved model "${bundleId}" runs here. Retry to check the hardware again.`,
      retry: true,
    };
  }
  if (capability.cloud_only_product_profile_id === "lite") {
    return {
      message: `The saved local model "${bundleId}" no longer runs on this device's hardware, so SuperClaw can't open your workspace with it.`,
      retry: false,
    };
  }
  return {
    message: `SuperClaw isn't supported on this device: the saved model "${bundleId}" doesn't run on its hardware, and no other local model does either.`,
    retry: false,
  };
}

/**
 * LRM's reading is complete and admits Lite or a local Bundle, so a `hardware_unsupported`
 * Profile read before the reading recovered is stale.
 */
export function hardwareUsable(capability: PrimaryBundleCapability): boolean {
  return (
    !hardwareProbeFailed(capability) &&
    (capability.cloud_only_product_profile_id === "lite" || capability.hardware_capability_ceiling !== undefined)
  );
}

/** Whether an "unsupported" verdict may come from an incomplete reading; a failed read (null) is unknown. */
export function hardwareReadIncompleteAfter(capability: PrimaryBundleCapability | null): boolean {
  return capability === null || hardwareProbeFailed(capability);
}

/**
 * Single-flight guard for first-launch activation that a hardware recovery can supersede.
 * An attempt started on the old reading must not publish its outcome, and the attempt the
 * recovery asked for runs once the old one settles instead of being dropped. A duplicate
 * start during a current attempt is ignored, as before.
 */
export function createActivationGate() {
  let generation = 0;
  let inFlight: number | null = null;
  let rerunOwed = false;
  return {
    /** Start an attempt; null while one is in flight (a superseded one then owes a re-run). */
    begin(): number | null {
      if (inFlight !== null) {
        if (inFlight !== generation) rerunOwed = true;
        return null;
      }
      inFlight = generation;
      return generation;
    },
    superseded(attempt: number): boolean {
      return attempt !== generation;
    },
    /** The hardware reading recovered: attempts started before now are stale. */
    invalidate(): void {
      generation += 1;
    },
    /** Settle an attempt; true when the caller must start the attempt it superseded. */
    end(attempt: number): boolean {
      if (inFlight === attempt) inFlight = null;
      const owed = rerunOwed;
      rerunOwed = false;
      return owed;
    },
  };
}

/** How Retry recovers a recovery state: re-arm the runtime, or read the Profile again. */
export type RecoveryRetryAction = "converge" | "refresh";

/** Phase B (first-launch activation) starts once per start, when ServiceHub reports no active Profile. */
export function phaseBShouldStart(status: string, started: boolean): boolean {
  return status === "initializing" && !started;
}

/**
 * Whether a recovery Retry hands Phase B back. A hardware Retry can return to `initializing`
 * on a local-model device, where only Phase B submits the activation; ServiceHub relaunches a
 * failed Lite runtime itself.
 */
export function recoveryRetryRearmsPhaseB(action: RecoveryRetryAction): boolean {
  return action === "refresh";
}

/**
 * Plain-language copy for the recovery states startup can explain; null keeps the existing
 * presentation. `hardwareReadIncomplete` is LRM's own reading (`hardwareProbeFailed`): the
 * recovery projection carries no detection errors, and a partial probe failure (memory speed
 * read as 0 with trusted CPU evidence) reaches `hardware_unsupported`, not `hardware_capability_unknown`.
 */
export function capabilityRecoveryBlock(
  recovery: RecoveryAppCapabilityProfile,
  hardwareReadIncomplete = false,
): (StartupBlock & { action: RecoveryRetryAction | null }) | null {
  if (recovery.recovery_code === "saga_recovery_required" && recovery.reasons.includes("native_runtime_unavailable")) {
    const provisionReason = provisionFailureReasonIn(recovery.reasons);
    return {
      message: provisionReason
        ? provisionFailureText(provisionReason)
        : "SuperClaw's cloud-only (Lite) workspace failed to start. Retry to start it again.",
      retry: true,
      action: "converge",
    };
  }
  if (
    recovery.recovery_code === "hardware_capability_unknown" ||
    (recovery.recovery_code === "hardware_unsupported" && hardwareReadIncomplete)
  ) {
    return {
      message: "SuperClaw couldn't read this device's hardware, so it can't tell which models run here. Retry to check the hardware again.",
      retry: true,
      action: "refresh",
    };
  }
  if (recovery.recovery_code === "hardware_unsupported") {
    return {
      message: "SuperClaw isn't supported on this device: none of its local models run on this hardware.",
      retry: false,
      action: null,
    };
  }
  return null;
}

/**
 * Map a public switch stage to the v1.2 startup step + friendly copy. An Edge Bundle
 * downloads nothing: its `preparing` stage is the connection to the Edge server.
 */
export function stageToStep(stage: ModelBindingActivationStage, edgeTarget = false): StepInfo {
  switch (stage) {
    case "preparing":
      if (edgeTarget) {
        return { step: "activate", title: "Connecting to Edge server", description: "Checking the Edge server and its models…" };
      }
      return { step: "download", title: "Downloading model", description: "Fetching model weights — this can take a few minutes on first launch…" };
    case "activating":
      return { step: "activate", title: "Activating model", description: "Applying the model profile…" };
    case "aligning_runtime":
      return { step: "sandbox", title: "Starting sandbox", description: "Starting the sandbox runtime…" };
  }
}
