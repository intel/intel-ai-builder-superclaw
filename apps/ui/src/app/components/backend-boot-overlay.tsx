import { Show, createMemo, For, createEffect, onMount, onCleanup, createSignal } from "solid-js";
import {
  AlertCircle,
  RefreshCw,
  Rocket,
  PackageOpen,
  HardDriveDownload,
  Container,
  Brain,
  CheckCircle2,
  Loader2,
  Minus,
  Square,
  X,
  type LucideProps,
} from "lucide-solid";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauriRuntime } from "../utils";

import Button from "./button";
import { describeBackendBootStage } from "../backend-boot-policy";

/**
 * A single stepper node. When callers supply their own `steps` + `activeStepId`
 * (e.g. the v1.2 capability startup flow), the overlay renders this custom
 * stepper instead of the built-in V1.1 `PHASES`. Icons are optional; a caller
 * can pass any lucide icon component.
 */
export type BootStep = {
  id: string;
  label: string;
  icon?: (props: LucideProps) => any;
};

export type BackendBootOverlayProps = {
  stage: string | null;
  message: string | null;
  pct: number | null;
  error: string | null;
  ready: boolean;
  onRetry?: () => void;
  onCancel?: () => void;
  retryDisabled?: boolean;
  debugObservabilityAvailable?: boolean;
  /**
   * Optional explicit title/description. When provided, these override the
   * V1.1 `describeBackendBootStage(stage)` lookup — used by the v1.2 startup
   * flow which owns its own phase taxonomy and does not map onto the legacy
   * backend-manager stage strings.
   */
  title?: string;
  description?: string;
  /**
   * Optional custom stepper. When provided together with `activeStepId`, the
   * overlay renders these steps instead of the built-in `PHASES`. Lets the
   * v1.2 capability startup flow show its own step sequence without touching
   * the shared V1.1 `backend-boot-policy` taxonomy (dark-safe).
   */
  steps?: readonly BootStep[];
  activeStepId?: string;
  /**
   * How to interpret `pct`. The legacy V1.1 path passes a 0–1 fraction
   * (`setBackendBootPct(1)` at ready). Callers with a 0–100 percentage (e.g.
   * the switch-operation `pct`) set this to true so the bar renders correctly.
   * Defaults to false (0–1 fraction) for backward compatibility.
   */
  pctIsPercent?: boolean;
};

// ── Phase model ────────────────────────────────────────────────────────────
//
// The backend-manager boot pipeline emits a series of stages (see
// `host/backend-manager/.../runs.py` KIND_* constants and the Rust
// `emit_progress` calls). We collapse them into 5 user-facing phases so the
// overlay can show a stepper plus a friendly title/description for the
// current step.

type PhaseId = "init" | "install" | "container" | "models" | "ready";

type PhaseDef = {
  id: PhaseId;
  label: string;
  icon: (props: LucideProps) => any;
};

const PHASES: PhaseDef[] = [
  { id: "init", label: "Initialize", icon: Rocket },
  { id: "install", label: "Install", icon: PackageOpen },
  { id: "container", label: "Container", icon: Container },
  { id: "models", label: "Models", icon: Brain },
  { id: "ready", label: "Ready", icon: CheckCircle2 },
];

type StageInfo = {
  phase: PhaseId;
  title: string;
  description: string;
};

/**
 * Map a raw stage string emitted by the Rust backend-manager bridge or set
 * by the frontend into a friendly title/description + which phase it
 * belongs to. Falls back to a generic "starting" message.
 */
function describeStage(stage: string | null): StageInfo {
  return describeBackendBootStage(stage) as StageInfo;
}

function phaseIndex(id: PhaseId): number {
  return PHASES.findIndex((p) => p.id === id);
}

/**
 * Full-screen overlay shown while the backend-manager boots.
 * Visible when `stage` is non-null and `ready` is false.
 */
export default function BackendBootOverlay(props: BackendBootOverlayProps) {
  const visible = createMemo(
    () => props.stage !== null && !props.ready,
  );

  const hasError = createMemo(() => Boolean(props.error));

  const isTauri = isTauriRuntime();
  const [isMaximized, setIsMaximized] = createSignal(false);

  onMount(() => {
    if (!isTauri) return;
    const win = getCurrentWindow();
    win.isMaximized().then(setIsMaximized).catch(() => { });
    let unlisten: (() => void) | undefined;
    win.onResized(() => {
      win.isMaximized().then(setIsMaximized).catch(() => { });
    }).then(fn => { unlisten = fn; }).catch(() => { });
    onCleanup(() => { if (unlisten) unlisten(); });
  });

  const handleMinimize = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    void getCurrentWindow().minimize().catch(() => { });
  };

  const handleMaximize = async (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const win = getCurrentWindow();
    await win.toggleMaximize();
    setIsMaximized(await win.isMaximized());
  };

  const handleClose = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    void getCurrentWindow().close().catch(() => { });
  };

  const pctWidth = createMemo(() => {
    const p = props.pct;
    if (p == null || p <= 0) return 0;
    // Legacy V1.1 passes a 0–1 fraction; v1.2 callers pass 0–100 and set
    // `pctIsPercent`. Normalize both to a 0–100 bar width.
    const asPercent = props.pctIsPercent ? p : p * 100;
    return Math.min(Math.round(asPercent), 100);
  });

  const info = createMemo<StageInfo>(() => {
    // v1.2 callers own their phase taxonomy: when they pass explicit
    // title/description we use those verbatim instead of the V1.1 stage lookup.
    if (props.title != null || props.description != null) {
      return {
        phase: "init",
        title: props.title ?? "",
        description: props.description ?? "",
      };
    }
    return describeStage(props.stage);
  });
  // Stepper source: custom `steps` (v1.2) when supplied, else the built-in
  // V1.1 PHASES. Both are rendered by the same markup below.
  const stepper = createMemo<readonly { id: string; label: string; icon?: (p: LucideProps) => any }[]>(
    () => (props.steps && props.steps.length > 0 ? props.steps : PHASES),
  );

  // Stepper only moves forward — prevent flickering when interleaved
  // operations (e.g. sandbox.ensure_ready + model_server.ensure_ready)
  // cause the phase to jump back and forth.
  let maxPhaseIdx = 0;
  const activeIdx = createMemo(() => {
    const steps = stepper();
    let cur: number;
    if (props.steps && props.steps.length > 0) {
      // Custom v1.2 stepper: locate by explicit activeStepId.
      cur = steps.findIndex((s) => s.id === props.activeStepId);
      if (cur < 0) cur = 0;
    } else {
      cur = phaseIndex(info().phase);
    }
    if (cur > maxPhaseIdx) maxPhaseIdx = cur;
    return maxPhaseIdx;
  });

  const [showDetails, setShowDetails] = createSignal(false);

  const shortError = createMemo(() => {
    const e = props.error;
    if (!e) return null;
    const firstLine = (e.split(/\r?\n/)[0] ?? "").trim();
    if (!firstLine) return null;
    return firstLine.length > 140 ? `${firstLine.slice(0, 137)}...` : firstLine;
  });

  return (
    <Show when={visible()}>
      <div
        data-testid="backend-boot-overlay"
        class="fixed inset-0 z-[70] overflow-hidden bg-dls-surface-solid text-dls-text motion-safe:animate-in motion-safe:fade-in motion-safe:duration-300"
      >
        {/* Window controls — top-right corner, only in Tauri */}
        <Show when={isTauri}>
          <div
            data-tauri-drag-region
            class="absolute top-0 left-0 right-[132px] h-10 z-30 cursor-default select-none"
          />
          <div class="absolute top-0 right-0 z-20 flex items-center h-10">
            <button
              class="inline-flex h-10 w-11 items-center justify-center transition-colors hover:bg-dls-hover/60 text-dls-muted hover:text-dls-text"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={handleMinimize}
              title="Minimize"
            >
              <Minus size={15} />
            </button>
            <button
              class="inline-flex h-10 w-11 items-center justify-center transition-colors hover:bg-dls-hover/60 text-dls-muted hover:text-dls-text"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={handleMaximize}
              title={isMaximized() ? "Restore" : "Maximize"}
            >
              <Show when={isMaximized()} fallback={<Square size={13} />}>
                <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.2">
                  <rect x="2.5" y="4.5" width="7" height="7" rx="1" />
                  <path d="M4.5 4.5V2.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-2" />
                </svg>
              </Show>
            </button>
            <button
              class="inline-flex h-10 w-11 items-center justify-center transition-colors text-dls-muted hover:bg-dls-danger-border-solid hover:text-white"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={handleClose}
              title="Close"
            >
              <X size={15} />
            </button>
          </div>
        </Show>
        {/* Background decoration – matches WorkspaceSwitchOverlay */}
        <div class="absolute inset-0">
          <div class="absolute inset-0 bg-[radial-gradient(circle_at_top,_var(--tw-gradient-stops))] from-dls-surface-raised via-dls-surface-solid to-dls-surface-solid opacity-80" />
          <div
            class="absolute -top-24 right-[-4rem] h-72 w-72 rounded-pill bg-dls-info/15 blur-3xl motion-safe:animate-pulse motion-reduce:opacity-40"
            style={{ "animation-duration": "6s" }}
          />
          <div
            class="absolute -bottom-28 left-[-5rem] h-80 w-80 rounded-pill bg-dls-info/10 blur-3xl motion-safe:animate-pulse motion-reduce:opacity-40"
            style={{ "animation-duration": "8s" }}
          />
          <div class="absolute inset-x-0 bottom-0 h-48 bg-gradient-to-t from-dls-surface-solid via-dls-surface-solid/40 to-transparent" />
        </div>

        {/* Content */}
        <div class="relative z-10 flex min-h-screen flex-col items-center justify-center px-6 py-10 text-center">
          <div class="flex flex-col items-center gap-7 w-full max-w-md">
            {/* Logo */}
            <div class="relative h-20 w-20 flex items-center justify-center">
              <img
                src="/icon.png"
                alt="SuperClaw"
                width={44}
                height={44}
                class="drop-shadow-sm select-none pointer-events-none"
              />
            </div>

            {/* Stage title + description */}
            <div class="space-y-2 min-h-[4.5rem]">
              <Show
                when={!hasError()}
                fallback={
                  <>
                    <h2 class="text-display font-semibold tracking-tight text-dls-danger-text">
                      SuperClaw Failed to Start
                    </h2>
                    <p class="text-body-lg text-dls-secondary max-w-sm mx-auto">
                      {props.error}
                    </p>
                  </>
                }
              >
                <h2 class="text-display font-semibold tracking-tight">
                  {info().title}
                </h2>
                <p class="text-body-lg text-dls-secondary max-w-sm mx-auto">
                  {info().description}
                </p>
              </Show>
            </div>

            {/* Phase stepper */}
            <Show when={!hasError()}>
              <div class="flex items-center justify-center gap-1.5 w-full">
                <For each={stepper()}>
                  {(phase, i) => {
                    const idx = i();
                    const active = createMemo(() => idx === activeIdx());
                    const done = createMemo(() => idx < activeIdx());
                    const Icon = phase.icon ?? Loader2;
                    return (
                      <>
                        <Show when={idx > 0}>
                          <div
                            class="h-[2px] flex-1 rounded-pill transition-colors duration-300"
                            classList={{
                              "bg-dls-info/60": done(),
                              "bg-dls-surface-muted/50": !done(),
                            }}
                          />
                        </Show>
                        <div
                          class="flex flex-col items-center gap-1.5"
                          title={phase.label}
                        >
                          <div
                            class="flex h-7 w-7 items-center justify-center rounded-pill border transition-all duration-300"
                            classList={{
                              "border-dls-info/70 bg-dls-info/15 text-dls-info":
                                active(),
                              "border-dls-info/40 bg-dls-info/10 text-dls-info/80":
                                done(),
                              "border-dls-border-muted bg-dls-surface-tint/40 text-dls-muted":
                                !active() && !done(),
                            }}
                          >
                            <Show
                              when={active()}
                              fallback={<Icon size={14} />}
                            >
                              <Icon
                                size={14}
                                class="motion-safe:animate-pulse"
                              />
                            </Show>
                          </div>
                          <span
                            class="text-tiny font-medium tracking-wide uppercase transition-colors"
                            classList={{
                              "text-dls-text": active(),
                              "text-dls-secondary": done(),
                              "text-dls-subtle": !active() && !done(),
                            }}
                          >
                            {phase.label}
                          </span>
                        </div>
                      </>
                    );
                  }}
                </For>
              </div>
            </Show>

            {/* Live status line + progress bar */}
            <Show when={!hasError()}>
              <div class="flex flex-col items-center gap-3 w-full">
                <div class="flex items-center gap-2 text-caption text-dls-secondary min-h-[1.25rem]">
                  <span class="relative flex h-2 w-2">
                    <span
                      class="absolute inline-flex h-full w-full rounded-pill bg-dls-info/40 motion-safe:animate-ping motion-reduce:opacity-40"
                      style={{ "animation-duration": "2.6s" }}
                    />
                    <span class="relative inline-flex h-2 w-2 rounded-pill bg-dls-info/70" />
                  </span>
                  <span class="max-w-xs truncate text-dls-text/80">
                    {props.message ?? "Working…"}
                  </span>
                </div>

                {/* Progress bar */}
                <div class="h-1 w-full overflow-hidden rounded-pill bg-dls-surface-muted/50">
                  <Show
                    when={pctWidth() > 0}
                    fallback={
                      <div class="h-full w-1/2 rounded-pill bg-gradient-to-r from-transparent via-dls-info/50 to-transparent animate-progress-shimmer" />
                    }
                  >
                    <div
                      class="h-full rounded-pill bg-dls-info/60 transition-[width] duration-500 ease-out"
                      style={{ width: `${pctWidth()}%` }}
                    />
                  </Show>
                </div>

                <div class="flex items-center justify-between w-full text-tiny font-mono text-dls-secondary">
                  <span class="truncate max-w-[14rem]">{props.debugObservabilityAvailable ? props.stage : ""}</span>
                  <Show when={pctWidth() > 0}>
                    <span>{pctWidth()}%</span>
                  </Show>
                </div>
              </div>
            </Show>

            {/* Error row */}
            <Show when={hasError()}>
              <div class="flex flex-col items-center gap-2">
                <div class="flex items-center gap-2 text-body-lg text-dls-danger-text">
                  <AlertCircle size={16} />
                  <span class="font-semibold text-body-lg text-dls-danger-text">{info().title}</span>
                </div>
                <div class="text-body-lg text-dls-secondary max-w-[20rem] text-center">
                  {info().description}
                  <Show when={shortError()}>
                    <div class="mt-1 text-caption text-dls-secondary">{shortError()}</div>
                  </Show>
                </div>

                <div class="flex items-center gap-2">
                  <Show when={props.debugObservabilityAvailable}>
                    <span class="font-mono text-label text-dls-muted truncate max-w-[20rem]">
                      {props.stage}
                    </span>
                  </Show>

                  <Show when={props.debugObservabilityAvailable}>
                    <button
                      class="text-caption text-dls-secondary underline-offset-2 hover:underline"
                      onClick={() => setShowDetails((v) => !v)}
                      aria-expanded={showDetails()}
                    >
                      {showDetails() ? "Hide details" : "Details"}
                    </button>
                  </Show>
                </div>

                <Show when={showDetails() && props.debugObservabilityAvailable}>
                  <pre class="text-caption font-mono text-dls-muted whitespace-pre-wrap max-w-[24rem] text-left">
                    {`Stage: ${props.stage ?? "(unknown)"}\nError: ${props.error ?? "(no details)"}`}
                  </pre>
                </Show>
              </div>
            </Show>

            {/* Retry / Cancel buttons on error */}
            <Show when={hasError() && (props.onRetry || props.onCancel)}>
              <div class="mt-2 flex items-center gap-2">
                <Show when={props.onCancel}>
                  <Button
                    variant="outline"
                    class="flex items-center gap-2 rounded-pill px-4 py-2 text-body-lg border-dls-danger-border text-dls-danger-text hover:bg-dls-danger-bg"
                    onClick={() => props.onCancel?.()}
                  >
                    Cancel
                  </Button>
                </Show>
                <Show when={props.onRetry && !props.retryDisabled}>
                  <Button
                    variant="secondary"
                    class="flex items-center gap-2 rounded-pill px-4 py-2 text-body-lg"
                    onClick={() => props.onRetry?.()}
                  >
                    <RefreshCw size={14} />
                    Retry
                  </Button>
                </Show>
              </div>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
}
