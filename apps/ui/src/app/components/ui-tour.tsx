import {
  Show,
  createSignal,
  createMemo,
  createEffect,
  onMount,
  onCleanup,
  on,
  type JSX,
} from "solid-js";
import { X, ChevronRight, ChevronLeft } from "lucide-solid";
import { UI_TOUR_PREF_KEY } from "../constants";
import { t } from "../../i18n";
import { isCloudOnlySessionProfile } from "~/shared/platform/capability/session-route-policy";
import type { ActiveAppCapabilityProfile } from "@different-ai/openwork-contracts/capability";

// Types
export type TourStep = {
  targetId: string;
  title: string;
  body: string;
  placement?: "top" | "bottom" | "left" | "right" | "auto";
  tooltipOffset?: number;
};

type ResolvedPlacement = "top" | "bottom" | "left" | "right";

type Rect = { top: number; left: number; width: number; height: number };

// Tour step definitions
export function getTourSteps(profile?: ActiveAppCapabilityProfile | null): TourStep[] {
  const isCloudOnly = isCloudOnlySessionProfile(profile);
  
  return [
    {
      targetId: "sidebar-sessions-area",
      title: t("tour.sessions.title"),
      body: t("tour.sessions.body"),
      placement: "right",
    },
    {
      targetId: "composer-agent",
      title: t("tour.choose_agent.title"),
      body: t("tour.choose_agent.body"),
      placement: "top",
    },
    {
      targetId: "composer-model",
      title: t("tour.model_selection.title"),
      body: isCloudOnly
        ? t("tour.model_selection.cloud_only.body")
        : t("tour.model_selection.body"),
      placement: "top",
    },
    {
      // Right after the model step, while the user is still looking at the
      // composer's control row where the microphone sits.
      targetId: "composer-voice",
      title: t("tour.voice_input.title"),
      body: t("tour.voice_input.body"),
      placement: "top",
    },
    {
      targetId: "workspace-files-panel",
      title: t("tour.attach_files.title"),
      body: t("tour.attach_files.body"),
      placement: "left",
    },
    {
      targetId: "sidebar-data",
      title: t("tour.data_usage.title"),
      body: t("tour.data_usage.body"),
      placement: "top",
    },
    {
      targetId: "sidebar-advanced",
      title: t("tour.advanced_config.title"),
      body: t("tour.advanced_config.body"),
      placement: "top",
    },
  ];
}



// Persistence 
export function isTourDone(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(UI_TOUR_PREF_KEY) === "done";
  } catch {
    return true;
  }
}

export function markTourDone(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(UI_TOUR_PREF_KEY, "done");
  } catch {
  }
}

// Positioning  
const TOOLTIP_GAP = 12;   
const TOOLTIP_W   = 420;  
const TOOLTIP_H   = 200;  
const SCREEN_PAD  = 8;   
const SPOTLIGHT_GLOW = 6; 

function pickPlacement(rect: Rect, preferred: TourStep["placement"]): ResolvedPlacement {
  if (preferred && preferred !== "auto") return preferred;

  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const space: Record<ResolvedPlacement, number> = {
    top:    rect.top,
    bottom: vh - (rect.top + rect.height),
    left:   rect.left,
    right:  vw - (rect.left + rect.width),
  };

  return (Object.keys(space) as ResolvedPlacement[]).reduce((best, side) =>
    space[side] > space[best] ? side : best,
  );
}

function calcTooltipPosition(rect: Rect, placement: ResolvedPlacement, extraOffset = 0, tooltipH = TOOLTIP_H): JSX.CSSProperties {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const gap = TOOLTIP_GAP + extraOffset;

  const clampX = (x: number) => Math.max(SCREEN_PAD, Math.min(x, vw - TOOLTIP_W - SCREEN_PAD));
  const clampY = (y: number) => Math.max(SCREEN_PAD, Math.min(y, vh - tooltipH - SCREEN_PAD));

  const centeredX = rect.left + rect.width  / 2 - TOOLTIP_W / 2;
  const centeredY = rect.top  + rect.height / 2 - tooltipH / 2;

  switch (placement) {
    case "bottom": return { top: `${clampY(rect.top + rect.height + gap)}px`, left: `${clampX(centeredX)}px` };
    case "top":    return { top: `${clampY(rect.top - tooltipH - gap)}px`,    left: `${clampX(centeredX)}px` };
    case "right":  return { top: `${clampY(centeredY)}px`, left: `${clampX(rect.left + rect.width + gap)}px` };
    case "left":   return { top: `${clampY(centeredY)}px`, left: `${clampX(rect.left - TOOLTIP_W - gap)}px` };
    default:       return { top: "50%", left: "50%", transform: "translate(-50%,-50%)" };
  }
}

function measureElement(targetId: string): Rect | null {
  const el = document.querySelector<HTMLElement>(`[data-tour-id="${targetId}"]`);
  if (!el) return null;
  const { top, left, width, height } = el.getBoundingClientRect();
  return { top, left, width, height };
}


// Component
export type UiTourProps = {
  steps?: TourStep[];
  /** Passed to getTourSteps() when steps are not provided directly. */
  profile?: ActiveAppCapabilityProfile | null;
  onDone?: () => void;
  // Called when user closes via X or Esc (no localStorage write — session-only dismiss).
  onDismiss?: () => void;
};

export default function UiTour(props: UiTourProps) {
  const steps = createMemo(() => props.steps ?? getTourSteps(props.profile));

  const [stepIndex, setStepIndex] = createSignal(0);
  const [targetRect, setTargetRect] = createSignal<Rect | null>(null);
  let tooltipEl: HTMLDivElement | undefined;
  const [tooltipHeight, setTooltipHeight] = createSignal(TOOLTIP_H);
  const [tooltipVisible, setTooltipVisible] = createSignal(false);

  const currentStep = createMemo(() => steps()[stepIndex()]);
  const isFirst     = createMemo(() => stepIndex() === 0);
  const isLast      = createMemo(() => stepIndex() === steps().length - 1);

  // Derived positioning, recalculated only when rect or step changes
  const placement = createMemo<ResolvedPlacement>(() => {
    const rect = targetRect();
    const step = currentStep();
    if (!rect || !step) return "bottom";
    return pickPlacement(rect, step.placement);
  });

  const tooltipStyle = createMemo((): JSX.CSSProperties => {
    const rect = targetRect();
    const step = currentStep();
    if (!rect || !step) return { top: "50%", left: "50%", transform: "translate(-50%,-50%)" };
    return calcTooltipPosition(rect, placement(), step.tooltipOffset ?? 0, tooltipHeight());
  });

  const spotlightStyle = createMemo((): JSX.CSSProperties => {
    const rect = targetRect();
    if (!rect) return {};
    return {
      position:      "fixed",
      top:           `${rect.top  - SPOTLIGHT_GLOW}px`,
      left:          `${rect.left - SPOTLIGHT_GLOW}px`,
      width:         `${rect.width  + SPOTLIGHT_GLOW * 2}px`,
      height:        `${rect.height + SPOTLIGHT_GLOW * 2}px`,
      "border-radius":  "var(--radius-inset)",
      "box-shadow":     "var(--dls-tour-spotlight-shadow)",
      "pointer-events": "none",
      "z-index":        "9998",
    };
  });

  // Measure target and commit spotlight + tooltip in a single rAF so layout has settled.
  createEffect(
    on(stepIndex, () => {
      const step = currentStep();
      if (!step) return;

      setTooltipVisible(false); // hide tooltip before moving spotlight

      const raf = requestAnimationFrame(() => {
        const el = document.querySelector<HTMLElement>(`[data-tour-id="${step.targetId}"]`);
        el?.scrollIntoView({ behavior: "smooth", block: "nearest" });
        if (tooltipEl) setTooltipHeight(tooltipEl.offsetHeight || TOOLTIP_H);
        const rect = measureElement(step.targetId);
        if (!rect) {
          // Target anchor missing -> skip step
          if (!isLast()) {
            setStepIndex((i) => i + 1);
          } else {
            dismissSilently();
          }
          return;
        }
        setTargetRect(rect);      // move spotlight to new target
        setTooltipVisible(true);  // reveal tooltip at its final position
      });

      onCleanup(() => cancelAnimationFrame(raf));
    }),
  );

  // Remeasure on resize so the spotlight tracks correctly after window maximize/restore
  onMount(() => {
    const onResize = () => {
      const step = currentStep();
      if (step) {
        if (tooltipEl) setTooltipHeight(tooltipEl.offsetHeight || TOOLTIP_H);
        setTargetRect(measureElement(step.targetId));
      }
    };
    window.addEventListener("resize", onResize, { passive: true });
    onCleanup(() => window.removeEventListener("resize", onResize));

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        props.onDismiss?.();
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        goNext();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        goPrev();
      }
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    onCleanup(() => window.removeEventListener("keydown", onKeyDown, { capture: true }));
  });

  //called only by explicit user action
  const finishByUser = () => {
    markTourDone();
    props.onDone?.();
  };

    // Called when tour must close without marking completion.
    // Prefer the session-dismiss path so auto-start stays suppressed for the
    // rest of the current app session when a target is missing.
  const dismissSilently = () => {
      if (props.onDismiss) props.onDismiss();
      else props.onDone?.();
  };

  const goNext = () => (isLast() ? finishByUser() : setStepIndex((i) => i + 1));
  const goPrev = () => { if (!isFirst()) setStepIndex((i) => i - 1); };

  return (
    <Show when={currentStep()}>
      {/* Click capture backdrop to prevent interacting with the underlying UI while the tour is open */}
      <div
        data-testid="ui-tour-backdrop"
        style={{ position: "fixed", top: "0", left: "0", right: "0", bottom: "0", "z-index": "9997", background: "transparent" }}
        aria-hidden="true"
        onPointerDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
      />
      {/* Spotlight, only renders when a rect is measured */}
      <Show when={targetRect()}>
        <div style={spotlightStyle()} aria-hidden="true" />
      </Show>

      {/* Tooltip card */}
      <div
        ref={tooltipEl}
        data-testid="ui-tour-tooltip"
        style={{
          position: "fixed",
          width:    `${TOOLTIP_W}px`,
          "z-index": "9999",
          "font-family": "inherit",
          visibility: tooltipVisible() ? "visible" : "hidden",
          ...tooltipStyle(),
        }}
        role="dialog"
        aria-modal="true"
        aria-label={currentStep()!.title}
      >
        <div class="overflow-hidden rounded-card border border-dls-border bg-dls-surface-solid font-sans shadow-[var(--dls-card-shadow)] [font-family:inherit] [&_button]:font-sans [&_button]:[font-family:inherit]">
          {/* Progress bar */}
          <div class="h-1 bg-dls-surface-tint">
            <div
              class="h-full bg-dls-accent transition-all duration-300"
              style={{ width: `${((stepIndex() + 1) / steps().length) * 100}%` }}
            />
          </div>

          {/* Header */}
          <div class="flex items-start justify-between gap-2 px-6 pt-6 pb-4">
            <div class="flex items-center gap-2.5">
              <span class="inline-flex items-center rounded-pill bg-dls-accent/10 px-2.5 py-0.5 text-label font-semibold text-dls-accent tabular-nums tracking-wide">
                {stepIndex() + 1} / {steps().length}
              </span>
              <h3 class="text-heading font-semibold leading-snug tracking-tight text-dls-text">
                {currentStep()!.title}
              </h3>
            </div>
            <button
              type="button"
              onClick={() => props.onDismiss?.()}
              aria-label={t("tour.nav.close")}
              class="shrink-0 rounded-control p-1 text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text"
            >
              <X size={14} />
            </button>
          </div>

          {/* Body */}
          <p class="px-6 pb-5 text-title leading-relaxed text-dls-secondary">
            {currentStep()!.body}
          </p>

          {/* Footer */}
          <div class="flex items-center justify-between gap-2 border-t border-dls-border px-6 py-4">
            <button
              type="button"
              onClick={finishByUser}
              data-testid="skip-tour-btn"
              class="shrink-0 text-body-lg font-medium text-dls-secondary transition-colors hover:text-dls-text"
            >
              {t("tour.nav.skip")}
            </button>

            <div class="flex items-center gap-2 shrink-0">
              <Show when={!isFirst()}>
                <button
                  type="button"
                  onClick={goPrev}
                  class="flex items-center gap-1.5 rounded-dialog border border-dls-border bg-dls-surface px-4 py-2.5 text-body-lg font-medium text-dls-secondary shadow-[var(--dls-card-shadow)] transition-colors hover:bg-dls-hover hover:text-dls-text"
                >
                  <ChevronLeft size={13} />
                  {t("tour.nav.back")}
                </button>
              </Show>

              <button
                type="button"
                onClick={goNext}
                class="flex items-center gap-1.5 rounded-dialog bg-dls-accent px-4.5 py-2.5 text-body-lg font-medium text-white transition-colors hover:bg-dls-accent-hover"
              >
                {isLast() ? t("tour.nav.done") : t("tour.nav.next")}
                <Show when={!isLast()}>
                  <ChevronRight size={13} />
                </Show>
              </button>
            </div>
          </div>
        </div>
      </div>
    </Show>
  );
}

