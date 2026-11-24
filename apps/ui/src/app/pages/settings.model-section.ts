import { createSignal } from "solid-js";

/**
 * Which part of Settings → Model to scroll to when it opens. The pencil on a
 * chat model picker row sets it, and the Settings page scrolls there and
 * clears it. It lives outside both, because the chat page is gone by the time
 * Settings mounts.
 */
export type SettingsModelSection = "local" | "cloud";

const [pendingModelSection, setPendingModelSection] = createSignal<SettingsModelSection | null>(null);

export { pendingModelSection, setPendingModelSection };

const VISIBLE_WAIT_FRAMES = 60;
const SETTLE_MS = 1500;
const USER_SCROLL_EVENTS = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

/**
 * Put `target` at the top of its scroll container at once, with no animation.
 * The page can still be hidden when this is called (the chat page is leaving),
 * so it waits for `target` to be on screen. Cards above it grow as their data
 * arrives, so it keeps `target` at the top until that settles or the user
 * scrolls. Returns a function that stops it early.
 */
export function pinSectionToTop(target: HTMLElement): () => void {
  let frame = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let observer: ResizeObserver | undefined;
  let stopped = false;

  const pin = () => target.scrollIntoView({ block: "start", behavior: "instant" });
  const stop = () => {
    stopped = true;
    cancelAnimationFrame(frame);
    clearTimeout(timer);
    observer?.disconnect();
    for (const name of USER_SCROLL_EVENTS) window.removeEventListener(name, stop, true);
  };

  const waitUntilVisible = (framesLeft: number) => {
    if (stopped) return;
    if (target.getClientRects().length === 0) {
      if (framesLeft > 0) frame = requestAnimationFrame(() => waitUntilVisible(framesLeft - 1));
      return;
    }
    pin();
    if (typeof ResizeObserver !== "undefined" && target.parentElement) {
      observer = new ResizeObserver(pin);
      observer.observe(target.parentElement);
    }
    for (const name of USER_SCROLL_EVENTS) window.addEventListener(name, stop, true);
    timer = setTimeout(stop, SETTLE_MS);
  };

  waitUntilVisible(VISIBLE_WAIT_FRAMES);
  return stop;
}
