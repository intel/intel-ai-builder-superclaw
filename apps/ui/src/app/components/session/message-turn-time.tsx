import { createMemo, createSignal, onCleanup, Show } from "solid-js";
import { Tooltip } from "~/shared/ui/tooltip";
import { formatElapsedMs } from "./message-list.format";
import {
  formatAbsoluteTurnTime,
  formatTurnRelativeLabel,
  formatTurnTimeTooltip,
  messageTurnStamp,
} from "./message-turn-clock";

const TURN_CLOCK_MS = 30_000;
const DEBUG_ELAPSED_CLASS = [
  "inline-flex align-middle leading-normal transition-opacity",
  "md:pointer-events-none md:opacity-0",
  "md:group-hover:pointer-events-auto md:group-hover:opacity-100",
  "md:group-focus-within:pointer-events-auto md:group-focus-within:opacity-100",
].join(" ");
const [turnNow, setTurnNow] = createSignal(Date.now());
let turnClockSubscribers = 0;
let turnClockTimer: number | undefined;

function useTurnClock() {
  turnClockSubscribers += 1;
  if (turnClockSubscribers === 1) {
    setTurnNow(Date.now());
    turnClockTimer = window.setInterval(() => setTurnNow(Date.now()), TURN_CLOCK_MS);
  }
  onCleanup(() => {
    turnClockSubscribers -= 1;
    if (turnClockSubscribers <= 0) {
      turnClockSubscribers = 0;
      if (turnClockTimer !== undefined) {
        window.clearInterval(turnClockTimer);
        turnClockTimer = undefined;
      }
    }
  });
  return turnNow;
}

function finiteElapsed(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Relative wall-clock label for a chat turn, with absolute time and duration on hover. */
export function MessageTurnTime(props: {
  info: unknown;
  /** When each user message's turn began, by id, so a reply is timed from its prompt. */
  turnStartById?: ReadonlyMap<string, number>;
  /** Debug observability's client run timer, shown as its own chip. */
  elapsedMs?: number;
}) {
  const now = useTurnClock();
  const stamp = createMemo(() => messageTurnStamp(props.info, props.turnStartById), null, {
    equals: (a, b) => a?.at === b?.at && a?.durationMs === b?.durationMs,
  });
  const elapsedLabel = () => {
    const elapsed = finiteElapsed(props.elapsedMs);
    return elapsed === null ? null : formatElapsedMs(elapsed);
  };
  const tooltip = createMemo(() => {
    const current = stamp();
    if (!current) return "";
    return formatTurnTimeTooltip(
      formatAbsoluteTurnTime(current.at),
      current.durationMs === null ? null : formatElapsedMs(current.durationMs),
    );
  });

  return (
    <Show when={stamp() || elapsedLabel()}>
      <span class="inline-flex items-center gap-2">
        <Show when={elapsedLabel()}>
          {(label) => (
            <Tooltip
              content="Run elapsed time"
              placement="bottom"
              maxWidthClass="max-w-[140px]"
              class={DEBUG_ELAPSED_CLASS}
            >
              <span
                class="text-label text-dls-secondary tabular-nums"
                aria-label="Run elapsed time"
              >
                {label()}
              </span>
            </Tooltip>
          )}
        </Show>
        <Show when={stamp()}>
          {(value) => (
            <Tooltip
              content={tooltip()}
              placement="top"
              maxWidthClass="max-w-[240px]"
              focusable
            >
              <time
                dateTime={new Date(value().at).toISOString()}
                class="text-label text-dls-secondary tabular-nums"
                data-testid="turn-time"
              >
                {formatTurnRelativeLabel(value().at, now())}
              </time>
            </Tooltip>
          )}
        </Show>
      </span>
    </Show>
  );
}
