import { Show, createSignal } from "solid-js";
import type { Accessor, JSX } from "solid-js";
import { AlertCircle, AlertTriangle, Loader2, RotateCcw, X } from "lucide-solid";

import { shouldBannerShow } from "../lib/status-view";
import type { SandboxStatusView, SeverityLevel } from "../lib/status-view";
import type { NativeRecoveryPresentation } from "~/shared/platform/transport/servicehub";
import Button from "./button";

/**
 * Persistent banner shown above the three-column session shell when the
 * sandbox status is `degraded` or `down`. Pure presentation - takes the already
 * computed `SandboxStatusView` and renders summary + a "Details" affordance.
 *
 * Severity, summary text, and the visibility predicate all come from
 * `sandbox-status-view.ts` so this component never duplicates that logic.
 */
export interface SandboxStatusBannerProps {
  view: Accessor<SandboxStatusView>;
  /** Called when the user clicks "Details". Wire to opening the Sandbox panel. */
  onOpenDetails: () => void;
  /** Optional override: hide the banner entirely (e.g. on the onboarding page). */
  hidden?: Accessor<boolean>;
}

type Tone = {
  container: string;
  icon: (props: { class?: string }) => JSX.Element;
  iconClass: string;
  label: string;
};

function toneFor(severity: SeverityLevel): Tone {
  if (severity === "down") {
    return {
      container:
        "bg-dls-danger-bg border-dls-danger-border text-dls-danger-text",
      icon: AlertCircle,
      iconClass: "text-dls-danger-text",
      label: "Host services down",
    };
  }
  // Treat anything else surfaced by `shouldBannerShow` as degraded styling.
  return {
    container:
      "bg-dls-warning-bg border-dls-warning-border text-dls-warning-text",
    icon: AlertTriangle,
    iconClass: "text-dls-warning-text",
      label: "Host services degraded",
  };
}

export function SandboxStatusBanner(props: SandboxStatusBannerProps): JSX.Element {
  // Track which severity the user dismissed. Banner re-appears only when
  // severity escalates to a different level (e.g. degraded → down).
  const [dismissedSeverity, setDismissedSeverity] = createSignal<SeverityLevel | null>(null);

  const visible = () => {
    if (props.hidden?.()) return false;
    const severity = props.view().severity;
    if (!shouldBannerShow(severity)) return false;
    return dismissedSeverity() !== severity;
  };

  const handleDismiss = () => setDismissedSeverity(props.view().severity);

  return (
    <Show when={visible()}>
      {(() => {
        const tone = toneFor(props.view().severity);
        const Icon = tone.icon;
        return (
          <div
            role="status"
            aria-live="polite"
            class={`flex items-center gap-2 px-4 py-2 border-b text-body-lg ${tone.container}`}
          >
            <Icon class={`h-4 w-4 shrink-0 ${tone.iconClass}`} />
            <span class="sr-only">{tone.label}: </span>
            <span class="min-w-0 flex-1 truncate">
              {props.view().summary}
            </span>
            <Button
              variant="outline"
              class="shrink-0 px-3 py-1 text-caption"
              onClick={() => props.onOpenDetails()}
              aria-label="Open Sandbox panel for details"
            >
              Details
            </Button>
            <button
              type="button"
              class="shrink-0 ml-1 rounded-compact p-1 hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
              onClick={handleDismiss}
              aria-label="Dismiss banner"
            >
              <X class="h-4 w-4" />
            </button>
          </div>
        );
      })()}
    </Show>
  );
}

export function NativeRecoveryBanner(props: {
  recovery: NativeRecoveryPresentation;
  recoveryBusy: boolean;
  recoveryError: string | null;
  onRestart: () => void;
}): JSX.Element {
  return (
    <div
      role="alert"
      class="flex items-center gap-3 border-b border-dls-danger-border bg-dls-danger-bg px-4 py-3 text-dls-danger-text"
    >
      <AlertCircle class="h-5 w-5 shrink-0 text-dls-danger-text" />
      <div class="min-w-0 flex-1">
        <div class="text-body-lg font-semibold">{props.recovery.title}</div>
        <div class="mt-0.5 text-body-lg text-dls-secondary">{props.recovery.message}</div>
        <Show when={props.recoveryError}>
          {(error) => <div class="mt-1 text-caption text-dls-danger-text">{error()}</div>}
        </Show>
      </div>
      <Button
        variant="primary"
        class="shrink-0 px-3 py-1 text-caption"
        disabled={props.recoveryBusy}
        onClick={() => props.onRestart()}
      >
        <Show
          when={props.recoveryBusy}
          fallback={<RotateCcw size={12} class="mr-1" />}
        >
          <Loader2 size={12} class="mr-1 animate-spin" />
        </Show>
        Restart SuperClaw
      </Button>
    </div>
  );
}

export default SandboxStatusBanner;
