import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";

const LEFT_SIDEBAR_WIDTH_KEY = "openwork.workspace-shell.left-width.v1";
const RIGHT_SIDEBAR_EXPANDED_KEY = "openwork.workspace-shell.right-expanded.v1";
const RIGHT_SIDEBAR_WIDTH_KEY = "openwork.workspace-shell.right-width.v1";

// Module-level shared signals so all instances of createWorkspaceShellLayout
// stay in sync within the same window (storage events don't fire same-window).
let _sharedLeftWidth: ReturnType<typeof createSignal<number>> | null = null;
let _sharedRightExpanded: ReturnType<typeof createSignal<boolean>> | null = null;
let _sharedRightWidth: ReturnType<typeof createSignal<number>> | null = null;

function getSharedLeftWidth(defaultVal: number): ReturnType<typeof createSignal<number>> {
  if (!_sharedLeftWidth) _sharedLeftWidth = createSignal(defaultVal);
  return _sharedLeftWidth;
}

function getSharedRightExpanded(defaultVal: boolean): ReturnType<typeof createSignal<boolean>> {
  if (!_sharedRightExpanded) _sharedRightExpanded = createSignal(defaultVal);
  return _sharedRightExpanded;
}

function getSharedRightWidth(defaultVal: number): ReturnType<typeof createSignal<number>> {
  if (!_sharedRightWidth) _sharedRightWidth = createSignal(defaultVal);
  return _sharedRightWidth;
}

// Persistence effects run once — the first call to createWorkspaceShellLayout
// registers them. Subsequent calls (dashboard.tsx, etc.) skip to avoid
// duplicate effects firing on every signal change.
let _persistenceRegistered = false;

export const DEFAULT_WORKSPACE_LEFT_SIDEBAR_WIDTH = 260;
export const MIN_WORKSPACE_LEFT_SIDEBAR_WIDTH = 220;
export const MAX_WORKSPACE_LEFT_SIDEBAR_WIDTH = 420;
export const DEFAULT_WORKSPACE_RIGHT_SIDEBAR_COLLAPSED_WIDTH = 72;
export const DEFAULT_WORKSPACE_RIGHT_SIDEBAR_WIDTH = 280;
export const MIN_WORKSPACE_RIGHT_SIDEBAR_WIDTH = 240;
export const MAX_WORKSPACE_RIGHT_SIDEBAR_WIDTH = 540;

type WorkspaceShellLayoutOptions = {
  defaultLeftWidth?: number;
  minLeftWidth?: number;
  maxLeftWidth?: number;
  defaultRightWidth?: number;
  minRightWidth?: number;
  maxRightWidth?: number;
  collapsedRightWidth?: number;
  expandedRightWidth: number;
};

function readStorage(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // ignore persistence failures
  }
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function getResponsiveRightMaxWidth(minRightWidth: number, configuredMaxRightWidth: number) {
  if (typeof window === "undefined") return configuredMaxRightWidth;
  const viewportBound = Math.floor(window.innerWidth * 0.45);
  return Math.max(minRightWidth, Math.min(configuredMaxRightWidth, viewportBound));
}

// The right sidebar is hidden when the viewport is too narrow to show it alongside the
// main content. The threshold is: sidebar minimum + 600px for the chat area.
function canFitResponsiveRightSidebar(minRightWidth: number, viewportWidth: number) {
  return viewportWidth >= minRightWidth + 600;
}

export function createWorkspaceShellLayout(options: WorkspaceShellLayoutOptions) {
  const minLeftWidth = Math.max(180, options.minLeftWidth ?? MIN_WORKSPACE_LEFT_SIDEBAR_WIDTH);
  const maxLeftWidth = Math.max(minLeftWidth, options.maxLeftWidth ?? MAX_WORKSPACE_LEFT_SIDEBAR_WIDTH);
  const defaultLeftWidth = clampNumber(
    options.defaultLeftWidth ?? DEFAULT_WORKSPACE_LEFT_SIDEBAR_WIDTH,
    minLeftWidth,
    maxLeftWidth,
  );
  const collapsedRightWidth = Math.max(
    0,
    options.collapsedRightWidth ?? DEFAULT_WORKSPACE_RIGHT_SIDEBAR_COLLAPSED_WIDTH,
  );
  const minRightWidth = Math.max(collapsedRightWidth, options.minRightWidth ?? MIN_WORKSPACE_RIGHT_SIDEBAR_WIDTH);
  const maxRightWidth = Math.max(minRightWidth, options.maxRightWidth ?? MAX_WORKSPACE_RIGHT_SIDEBAR_WIDTH);
  const defaultRightWidth = clampNumber(
    options.defaultRightWidth ?? options.expandedRightWidth ?? DEFAULT_WORKSPACE_RIGHT_SIDEBAR_WIDTH,
    minRightWidth,
    maxRightWidth,
  );

  const clampRightSidebarWidth = (value: number) =>
    clampNumber(value, minRightWidth, getResponsiveRightMaxWidth(minRightWidth, maxRightWidth));

  const readLeftSidebarWidth = () => {
    const raw = readStorage(LEFT_SIDEBAR_WIDTH_KEY);
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return defaultLeftWidth;
    return clampNumber(parsed, minLeftWidth, maxLeftWidth);
  };

  const readRightSidebarWidth = () => {
    const raw = readStorage(RIGHT_SIDEBAR_WIDTH_KEY);
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return defaultRightWidth;
    return clampRightSidebarWidth(parsed);
  };

  const readRightSidebarExpanded = () => readStorage(RIGHT_SIDEBAR_EXPANDED_KEY) !== "0";

  const [leftSidebarWidth, setLeftSidebarWidth] = getSharedLeftWidth(readLeftSidebarWidth());
  const [rightSidebarExpanded, setRightSidebarExpanded] = getSharedRightExpanded(readRightSidebarExpanded());
  const [rightSidebarExpandedWidth, setRightSidebarExpandedWidth] = getSharedRightWidth(readRightSidebarWidth());
  const [viewportWidth, setViewportWidth] = createSignal(
    typeof window === "undefined" ? Number.POSITIVE_INFINITY : window.innerWidth,
  );

  if (!_persistenceRegistered) {
    _persistenceRegistered = true;
    createEffect(() => {
      writeStorage(LEFT_SIDEBAR_WIDTH_KEY, String(clampNumber(leftSidebarWidth(), minLeftWidth, maxLeftWidth)));
    });
    createEffect(() => {
      writeStorage(RIGHT_SIDEBAR_WIDTH_KEY, String(clampRightSidebarWidth(rightSidebarExpandedWidth())));
    });
    createEffect(() => {
      writeStorage(RIGHT_SIDEBAR_EXPANDED_KEY, rightSidebarExpanded() ? "1" : "0");
    });
  }

  // Track whether we auto-collapsed the sidebar due to a narrow window so we
  // can restore it when the window grows wide enough again.
  let autoCollapsedByResize = false;

  if (typeof window !== "undefined") {
    const handleWindowResize = () => {
      const vw = window.innerWidth;
      setViewportWidth(vw);

      const canFit = canFitResponsiveRightSidebar(minRightWidth, vw);
      if (!canFit && rightSidebarExpanded()) {
        // Window shrank below limit — auto-collapse and remember we did so.
        autoCollapsedByResize = true;
        setRightSidebarExpanded(false);
      } else if (canFit && autoCollapsedByResize) {
        // Window grew back — restore the sidebar to expanded.
        autoCollapsedByResize = false;
        setRightSidebarExpanded(true);
      }
    };
    handleWindowResize();
    window.addEventListener("resize", handleWindowResize);
    onCleanup(() => {
      window.removeEventListener("resize", handleWindowResize);
    });
  }

  const rightSidebarVisible = createMemo(() =>
    canFitResponsiveRightSidebar(minRightWidth, viewportWidth()),
  );

  const rightSidebarWidth = createMemo(() =>
    rightSidebarExpanded() ? clampRightSidebarWidth(rightSidebarExpandedWidth()) : collapsedRightWidth,
  );

  let dragCleanup: (() => void) | null = null;

  const stopSidebarResize = () => {
    dragCleanup?.();
    dragCleanup = null;
    if (typeof document === "undefined") return;
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
  };

  const startLeftSidebarResize = (event: PointerEvent) => {
    if (event.button !== 0 || typeof window === "undefined") return;

    stopSidebarResize();
    const initialX = event.clientX;
    const initialWidth = leftSidebarWidth();

    const handleMove = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientX - initialX;
      setLeftSidebarWidth(clampNumber(initialWidth + delta, minLeftWidth, maxLeftWidth));
    };

    const handleStop = () => {
      stopSidebarResize();
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleStop);
    window.addEventListener("pointercancel", handleStop);
    dragCleanup = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleStop);
      window.removeEventListener("pointercancel", handleStop);
    };

    if (typeof document !== "undefined") {
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    }

    event.preventDefault();
  };

  const startRightSidebarResize = (event: PointerEvent) => {
    if (event.button !== 0 || typeof window === "undefined" || !rightSidebarExpanded()) return;

    stopSidebarResize();
    const initialX = event.clientX;
    const initialWidth = rightSidebarExpandedWidth();

    const handleMove = (moveEvent: PointerEvent) => {
      const delta = initialX - moveEvent.clientX;
      setRightSidebarExpandedWidth(clampRightSidebarWidth(initialWidth + delta));
    };

    const handleStop = () => {
      stopSidebarResize();
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleStop);
    window.addEventListener("pointercancel", handleStop);
    dragCleanup = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleStop);
      window.removeEventListener("pointercancel", handleStop);
    };

    if (typeof document !== "undefined") {
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    }

    event.preventDefault();
  };

  const toggleRightSidebar = () => {
    setRightSidebarExpanded((current) => !current);
  };

  onCleanup(() => {
    stopSidebarResize();
  });

  return {
    leftSidebarWidth,
    rightSidebarExpanded,
    rightSidebarVisible,
    rightSidebarWidth,
    rightSidebarExpandedWidth,
    setRightSidebarExpanded,
    startLeftSidebarResize,
    startRightSidebarResize,
    toggleRightSidebar,
  };
}