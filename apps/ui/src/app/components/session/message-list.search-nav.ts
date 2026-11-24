export const SEARCH_MATCH_SELECTOR = 'mark[data-search-highlight="true"]';
export const SEARCH_MATCH_ACTIVE_ATTR = "data-search-highlight-active";
export const SEARCH_MATCH_ACTIVE_CLASS = "search-highlight-active";

export type SearchNavState = {
  activeIndex: number;
  total: number;
  scanning?: boolean;
  truncated?: boolean;
};

export const wrapMatchIndex = (rawIndex: number, size: number): number =>
  size <= 0 ? 0 : ((rawIndex % size) + size) % size;

export const collectSearchMatches = (root: ParentNode): HTMLElement[] =>
  Array.from(root.querySelectorAll(SEARCH_MATCH_SELECTOR));

export const applyActiveMatch = (
  matches: HTMLElement[],
  activeIndex: number,
): HTMLElement | null => {
  matches.forEach((mark) => {
    mark.removeAttribute(SEARCH_MATCH_ACTIVE_ATTR);
    mark.classList.remove(SEARCH_MATCH_ACTIVE_CLASS);
  });
  const target = matches[activeIndex] ?? null;
  if (target) {
    target.setAttribute(SEARCH_MATCH_ACTIVE_ATTR, "true");
    target.classList.add(SEARCH_MATCH_ACTIVE_CLASS);
  }
  return target;
};

export const searchPositionLabel = (total: number, activeIndex: number): string =>
  total > 0 ? `${wrapMatchIndex(activeIndex, total) + 1} of ${total}` : "No matches";

export type SearchMatchControllerOptions = {
  getRoot: () => HTMLElement | null;
  onChange: (state: SearchNavState) => void;
  scrollIntoView?: (element: HTMLElement) => void;
};

export type SearchMatchController = {
  attach: () => void;
  requestNav: (offset: number) => void;
  reset: () => void;
  dispose: () => void;
};

/**
 * DOM is the only source of truth: this observes real `mark` mutations
 * and recomputes the active match and total purely from what mounted.
 * Streaming repaints update the count without moving the scroll position;
 * only an explicit `requestNav`/`reset` call scrolls.
 */
export const createSearchMatchController = (
  options: SearchMatchControllerOptions,
): SearchMatchController => {
  let activeIndex = 0;
  let pendingScroll = false;
  let observer: MutationObserver | null = null;
  let observedRoot: HTMLElement | null = null;
  let frame: ReturnType<typeof setTimeout> | number | null = null;

  const settle = () => {
    const root = options.getRoot();
    const matches = root ? collectSearchMatches(root) : [];
    activeIndex = wrapMatchIndex(activeIndex, matches.length);
    const target = applyActiveMatch(matches, activeIndex);
    options.onChange({ activeIndex, total: matches.length });
    if (pendingScroll && target) {
      pendingScroll = false;
      options.scrollIntoView?.(target);
    }
  };

  const scheduleSettle = () => {
    if (frame !== null) return;
    const raf: (cb: () => void) => ReturnType<typeof setTimeout> | number =
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame
        : (cb) => setTimeout(cb, 16);
    frame = raf(() => {
      frame = null;
      settle();
    });
  };

  const ensureObserver = () => {
    const root = options.getRoot();
    if (!root || observedRoot === root) return;
    observer?.disconnect();
    observedRoot = root;
    observer = new MutationObserver(scheduleSettle);
    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  };

  return {
    attach: () => {
      ensureObserver();
      settle();
    },
    requestNav: (offset) => {
      ensureObserver();
      activeIndex += offset;
      pendingScroll = true;
      settle();
    },
    reset: () => {
      ensureObserver();
      activeIndex = 0;
      pendingScroll = true;
      scheduleSettle();
    },
    dispose: () => {
      if (frame !== null) {
        if (typeof cancelAnimationFrame === "function" && typeof frame === "number") {
          cancelAnimationFrame(frame);
        } else {
          clearTimeout(frame as ReturnType<typeof setTimeout>);
        }
        frame = null;
      }
      observer?.disconnect();
      observer = null;
      observedRoot = null;
    },
  };
};
