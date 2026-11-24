import { Match, Show, Switch, createMemo, createSignal, onCleanup } from "solid-js";
import { ArrowDown, CircleArrowDown, CircleArrowUp, CircleCheck, LoaderCircle, RefreshCcw, ShieldCheck } from "lucide-solid";

import { otaButtonTooltip, otaRingPct, type OtaButtonView } from "../lib/ota-update-state";
import { otaUpdateStore } from "../lib/ota-update-store";

const BUSY_KINDS: ReadonlySet<OtaButtonView["kind"]> = new Set([
  "checking",
  "downloading",
  "verifying",
  "launching",
]);

const CHECK_KINDS: ReadonlySet<OtaButtonView["kind"]> = new Set(["idle", "upToDate", "checkFailed"]);

// A check that fails offline settles within milliseconds, too fast for the spin to be seen.
const MIN_CHECK_SPIN_MS = 950;

const RING_RADIUS = 7.5;
const RING_WIDTH = 1.75;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const RING_MIN_PCT = 4;

/** A thin donut that fills with the download, with the step's glyph in its middle. */
function ProgressRing(props: { pct: number; verifying: boolean }) {
  const shown = () => Math.max(RING_MIN_PCT, props.pct);
  return (
    <span class="relative inline-flex h-[18px] w-[18px] items-center justify-center">
      <svg class="absolute inset-0" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
        <circle cx="9" cy="9" r={RING_RADIUS} fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width={RING_WIDTH} />
        <circle
          cx="9"
          cy="9"
          r={RING_RADIUS}
          fill="none"
          stroke="var(--dls-accent)"
          stroke-width={RING_WIDTH}
          stroke-linecap="round"
          stroke-dasharray={`${RING_CIRCUMFERENCE}`}
          stroke-dashoffset={`${RING_CIRCUMFERENCE * (1 - shown() / 100)}`}
          transform="rotate(-90 9 9)"
          style={{ transition: "stroke-dashoffset 200ms linear" }}
        />
      </svg>
      <Show when={props.verifying} fallback={<ArrowDown size={10} strokeWidth={2.5} />}>
        <ShieldCheck size={10} strokeWidth={2.5} class="text-dls-accent" />
      </Show>
    </span>
  );
}

function Dot(props: { class: string }) {
  return (
    <span class={`absolute right-1.5 top-1 h-2 w-2 rounded-pill ${props.class}`} aria-hidden="true" />
  );
}

/**
 * Icon-only update button beside the sidebar version label (#2568). Tooltip only, no text, no popover;
 * clicking checks, or installs when an update is already offered. Renders nothing when hidden.
 */
export default function UpdateAvailablePill() {
  const ota = otaUpdateStore();
  const view = ota.view;
  const [minSpin, setMinSpin] = createSignal(false);
  let minSpinTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(minSpinTimer));

  const checkSpinning = createMemo(
    () => view().kind === "checking" || (minSpin() && CHECK_KINDS.has(view().kind)),
  );
  const tooltip = createMemo(() =>
    checkSpinning() ? otaButtonTooltip({ kind: "checking" }) ?? "" : otaButtonTooltip(view()) ?? "",
  );
  const clickable = createMemo(() => !BUSY_KINDS.has(view().kind) && !checkSpinning());
  const ringPct = createMemo(() => otaRingPct(view()));

  const onActivate = () => {
    if (!clickable()) return;
    if (CHECK_KINDS.has(view().kind)) {
      clearTimeout(minSpinTimer);
      setMinSpin(true);
      minSpinTimer = setTimeout(() => setMinSpin(false), MIN_CHECK_SPIN_MS);
    }
    ota.activate();
  };

  return (
    <Show when={view().kind !== "hidden"}>
      <button
        type="button"
        data-testid="ota-update-button"
        data-state={checkSpinning() ? "checking" : view().kind}
        class={`relative inline-flex h-6 w-7 items-center justify-center rounded-control transition-colors text-dls-secondary focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--dls-accent-rgb)/0.35)] ${clickable() ? "hover:bg-dls-surface-muted hover:text-dls-text" : "cursor-default"}`}
        title={tooltip()}
        aria-label={tooltip()}
        aria-disabled={!clickable()}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onActivate();
        }}
      >
        <Switch>
          {/* One persistent Match for idle/checking/checkFailed: all three render the same
              RefreshCcw node, so the icon survives the state change instead of unmounting
              mid-spin. Unmounting a live `animate-spin` layer was what made the stop look
              like a slow ease-back instead of an instant one. */}
          <Match when={view().kind === "idle" || checkSpinning() || view().kind === "checkFailed"}>
            <RefreshCcw size={14} class={checkSpinning() ? "animate-spin" : ""} />
            <Show when={view().kind === "checkFailed" && !checkSpinning()}>
              <Dot class="bg-dls-danger-dot" />
            </Show>
          </Match>
          <Match when={ringPct() !== null}>
            <ProgressRing pct={ringPct() ?? 0} verifying={view().kind === "verifying"} />
          </Match>
          <Match when={view().kind === "failed"}>
            <CircleArrowDown size={14} />
            <Dot class="bg-dls-danger-dot" />
          </Match>
          <Match when={view().kind === "ready"}>
            <CircleArrowUp size={14} class="text-dls-success-text" />
          </Match>
          <Match when={view().kind === "launching"}>
            <LoaderCircle size={14} class="animate-spin text-dls-success-text" />
          </Match>
          <Match when={view().kind === "available"}>
            <CircleArrowDown size={14} class="text-dls-accent" />
          </Match>
          <Match when={view().kind === "upToDate"}>
            <CircleCheck size={14} />
          </Match>
        </Switch>
      </button>
    </Show>
  );
}
