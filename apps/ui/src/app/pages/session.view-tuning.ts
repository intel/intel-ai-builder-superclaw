/** Scroll/stream/search tuning constants and the persisted run-elapsed bookkeeping for the Session view. Pure - unit-testable. */

export const INITIAL_MESSAGE_WINDOW = 140;

export const MESSAGE_WINDOW_LOAD_CHUNK = 120;

export const MAX_SEARCH_MESSAGE_CHARS = 4_000;

export const MAX_SEARCH_HITS = 2_000;

export const MAX_PROMPT_NAVIGATION_LABEL_CHARS = 160;

export const STREAM_SCROLL_MIN_INTERVAL_MS = 90;

export const SMOOTH_SCROLL_GUARD_MS = 500;

export const JUMP_SCROLL_MIN_DURATION_MS = 280;

export const JUMP_SCROLL_MAX_DURATION_MS = 700;

export const JUMP_SCROLL_PX_PER_MS = 2.5;

export const PINNED_USER_MESSAGE_TOP_GAP_PX = 10;

/**
 * Dead zone for the pinned-prompt scrollTop snap-back in `syncPinnedSpacerToFit`.
 * `getBoundingClientRect()` reports sub-pixel float offsets while `scrollTop`
 * is device-pixel snapped, so under a fractional OS display scale (125%,
 * 150%, ...) the two never agree exactly even when nothing real changed. A
 * 1px tolerance was inside that noise band, so any layout pass that nudged
 * the measured offset by a fraction of a pixel (e.g. the run-elapsed label
 * re-rendering every `RUN_TICK_INTERVAL_MS`) re-triggered a hard scrollTop
 * write, visible as a viewport shake for as long as the pin held. Widened
 * well past sub-pixel noise; real corrections (spacer/run-indicator height
 * changes) are an order of magnitude larger than this.
 */
export const PINNED_SCROLL_SNAP_EPSILON_PX = 10;

/**
 * Motion for the automatic pin on send. `auto` is one `scrollTo` in the
 * measure frame with no animation, so the spacer/scrollTop correctors never
 * have to yield to an in-flight scroll. Smooth motion is kept for the
 * user-initiated paths (prompt navigation, edit-and-resend, jump pills).
 */
export function automaticPromptPinMotion(): { behavior: "auto" | "smooth" } {
  return { behavior: "auto" };
}

export function pinnedSpacerDuringLayout(input: {
  isGenerating: boolean;
  currentSpacerPx: number;
  requiredSpacerPx: number;
  minimumSpacerPx?: number;
}): number {
  return Math.max(
    input.requiredSpacerPx,
    input.minimumSpacerPx ?? 0,
  );
}

export function minimumSpacerToPreserveScrollTop(input: {
  scrollTop: number;
  scrollHeightWithoutSpacer: number;
  clientHeight: number;
}): number {
  const maxScrollTopWithoutSpacer = Math.max(
    0,
    input.scrollHeightWithoutSpacer - input.clientHeight,
  );
  return Math.max(
    0,
    Math.ceil(input.scrollTop - maxScrollTopWithoutSpacer),
  );
}

/**
 * Scroll offset that puts `target` under the viewport's top gap, plus how much
 * bottom spacer the container needs for that offset to be reachable at all.
 * `currentSpacerPx` is subtracted out so the measurement describes the content
 * alone and does not compound the reservation already in place.
 */
export function requiredPinnedSpacer(input: {
  container: Pick<
    HTMLElement,
    "scrollTop" | "scrollHeight" | "clientHeight" | "getBoundingClientRect"
  >;
  target: Pick<HTMLElement, "getBoundingClientRect">;
  currentSpacerPx: number;
}): {
  targetScrollTop: number;
  spacerPx: number;
  minimumViewportSpacerPx: number;
} {
  const { container, target, currentSpacerPx } = input;
  const containerRect = container.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const targetScrollTop = Math.max(
    0,
    container.scrollTop +
      targetRect.top -
      containerRect.top -
      PINNED_USER_MESSAGE_TOP_GAP_PX,
  );
  const scrollHeightWithoutSpacer = Math.max(
    0,
    container.scrollHeight - currentSpacerPx,
  );
  const maxScrollWithoutSpacer =
    scrollHeightWithoutSpacer - container.clientHeight;
  return {
    targetScrollTop,
    spacerPx: Math.max(0, Math.ceil(targetScrollTop - maxScrollWithoutSpacer)),
    minimumViewportSpacerPx: minimumSpacerToPreserveScrollTop({
      scrollTop: container.scrollTop,
      scrollHeightWithoutSpacer,
      clientHeight: container.clientHeight,
    }),
  };
}

export const MANUAL_SCROLL_INTENT_WINDOW_MS = 400;

export const PROMPT_NAVIGATION_SCROLL_GUARD_MS = 2000;

export const MANUAL_SCROLL_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  " ",
]);

export const STREAM_RENDER_BATCH_MS = 48;

export const MAIN_THREAD_LAG_INTERVAL_MS = 200;

export const MAIN_THREAD_LAG_WARN_MS = 180;

export const TAVILY_WARNING_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How often to advance the run-elapsed timer and stall-detection memos during
 * an active agent run.  50 ms was the original value but it fired 20× per
 * second, causing 5+ memo recomputations and a forced-layout `scrollHeight`
 * read on every tick — measurably blocking keystroke handling in the composer.
 * 500 ms (2×/s) is sufficient: the elapsed-time display is decorative, stall
 * thresholds are 8 s+, and content-change-driven effects already handle most
 * scroll-to-bottom needs.
 */
export const RUN_TICK_INTERVAL_MS = 500;

export const RUN_ELAPSED_KEY_PREFIX = "openwork.runElapsed.";

export const RUN_ELAPSED_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Parse a stored run-elapsed entry.
 * Timestamped format: `{ d: Record<string, number>, t: number }`.
 * Legacy format (pre-cleanup): plain `Record<string, number>`.
 */
export function parseRunElapsedEntry(raw: string): {
  data: Record<string, number>;
  updatedAt: number | null;
} {
  const parsed: unknown = JSON.parse(raw);
  // updatedAt 0 is older than the cleanup cutoff, so the corrupt key is
  // removed on the next sweep. Callers read data only.
  if (Array.isArray(parsed)) return { data: {}, updatedAt: 0 };
  if (!parsed || typeof parsed !== "object") {
    return { data: {}, updatedAt: null };
  }
  const record = parsed as { t?: unknown; d?: unknown };
  if (typeof record.t === "number" && record.d !== undefined) {
    if (
      record.d !== null &&
      typeof record.d === "object" &&
      !Array.isArray(record.d)
    ) {
      return {
        data: record.d as Record<string, number>,
        updatedAt: record.t,
      };
    }
    if (Array.isArray(record.d)) return { data: {}, updatedAt: 0 };
  }
  return { data: record as Record<string, number>, updatedAt: null };
}

/**
 * Remove `openwork.runElapsed.*` entries older than 30 days.
 * Legacy entries (no timestamp) are skipped — they receive a timestamp on next write
 * and become eligible for cleanup after 30 days from that point.
 * Corrupted entries are removed immediately.
 */
export function cleanupStaleRunElapsed(): void {
  try {
    const cutoff = Date.now() - RUN_ELAPSED_MAX_AGE_MS;
    const keysToRemove: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (!key?.startsWith(RUN_ELAPSED_KEY_PREFIX)) continue;
      try {
        const raw = window.localStorage.getItem(key);
        if (!raw) {
          keysToRemove.push(key);
          continue;
        }
        const { updatedAt } = parseRunElapsedEntry(raw);
        if (updatedAt !== null && updatedAt < cutoff) {
          keysToRemove.push(key);
        }
      } catch {
        keysToRemove.push(key);
      }
    }
    for (const key of keysToRemove) {
      window.localStorage.removeItem(key);
    }
  } catch {
    /* ignore */
  }
}
