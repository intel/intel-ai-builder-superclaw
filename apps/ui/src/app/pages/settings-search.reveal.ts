/**
 * Brings a picked Settings search result into view (#3836): scrolls its anchor
 * to the middle of the pane, moves focus there and flashes it.
 *
 * Several sections draw their cards only once a read returns (cleanup
 * settings, the Connections server, the routing balance), so the anchor is
 * looked for on each frame until it appears. Past the wait the card is used
 * instead of the control inside it, and with neither the section simply stays
 * at the top it opened at.
 */
const HIGHLIGHT_CLASS = "settings-search-highlight";
const HIGHLIGHT_MS = 2400;
const WAIT_MS = 2000;

// A disabled control cannot take focus (Run Now while cleanup settings load),
// so it counts as not there yet.
const findAnchor = (root: HTMLElement, anchor: string) =>
  root.querySelector<HTMLElement>(`[data-settings-anchor="${anchor}"]:not(:disabled)`);

function reveal(el: HTMLElement): () => void {
  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  el.scrollIntoView({ block: "center", behavior: reduceMotion ? "auto" : "smooth" });
  if (!el.hasAttribute("tabindex") && !el.matches("button, input, select, textarea, [href]")) {
    el.setAttribute("tabindex", "-1");
  }
  el.focus({ preventScroll: true });
  el.classList.remove(HIGHLIGHT_CLASS);
  void el.offsetWidth; // restart the animation when the same setting is picked twice
  el.classList.add(HIGHLIGHT_CLASS);
  const timer = window.setTimeout(() => el.classList.remove(HIGHLIGHT_CLASS), HIGHLIGHT_MS);
  return () => {
    window.clearTimeout(timer);
    el.classList.remove(HIGHLIGHT_CLASS);
  };
}

/** Reveals the first of `anchors` found under `root`; returns a cancel for a pending or running reveal. */
export function revealSettingsAnchor(root: HTMLElement, anchors: readonly string[]): () => void {
  if (anchors.length === 0) return () => {};
  const started = performance.now();
  let frame = 0;
  let stopHighlight: (() => void) | undefined;
  const tick = () => {
    const exact = findAnchor(root, anchors[0]);
    const waited = performance.now() - started >= WAIT_MS;
    const target = exact ?? (waited ? anchors.slice(1).map((a) => findAnchor(root, a)).find(Boolean) : null);
    if (target) {
      stopHighlight = reveal(target);
      return;
    }
    if (!waited) frame = requestAnimationFrame(tick);
  };
  tick();
  return () => {
    cancelAnimationFrame(frame);
    stopHighlight?.();
  };
}
