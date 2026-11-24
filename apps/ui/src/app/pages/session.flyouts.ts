import { createEffect, createSignal } from "solid-js";

type Rect = { top: number; left: number; width: number; height: number };

export type Flyout = {
  id: string;
  rect: Rect;
  targetRect: Rect;
  label: string;
  icon: "file" | "check" | "folder";
};

/** How long a flyout stays mounted before it is dropped. */
const FLYOUT_LIFETIME_MS = 1000;

type FlyoutsDeps = {
  /** Suppresses flyouts while the session's first render settles. */
  isInitialLoad: () => boolean;
  todoCount: () => number;
  workingFileCount: () => number;
  /** The row a flyout animates away from, or null when none is mounted. */
  lastAssistantElement: () => Element | null;
};

type FlyoutsController = {
  flyouts: () => Flyout[];
};

const toRect = (el: Element): Rect => {
  const { top, left, width, height } = el.getBoundingClientRect();
  return { top, left, width, height };
};

/**
 * The short "New Task" / "File Modified" animations that fly from the latest
 * assistant row to the sidebar. Each one self-expires, so nothing accumulates
 * if the user navigates away mid-flight.
 */
export function createFlyouts(deps: FlyoutsDeps): FlyoutsController {
  const [flyouts, setFlyouts] = createSignal<Flyout[]>([]);
  const [previousTodoCount, setPreviousTodoCount] = createSignal(0);
  const [previousFileCount, setPreviousFileCount] = createSignal(0);

  const trigger = (
    sourceEl: Element | null,
    targetId: string,
    label: string,
    icon: Flyout["icon"],
  ) => {
    if (deps.isInitialLoad() || !sourceEl) return;
    const targetEl = document.getElementById(targetId);
    if (!targetEl) return;

    const id = Math.random().toString(36);
    setFlyouts((previous) => [
      ...previous,
      { id, rect: toRect(sourceEl), targetRect: toRect(targetEl), label, icon },
    ]);

    setTimeout(() => {
      setFlyouts((previous) => previous.filter((f) => f.id !== id));
    }, FLYOUT_LIFETIME_MS);
  };

  // Both effects skip the very first observed count, so loading a session with
  // existing todos/files does not fire a burst of animations.
  createEffect(() => {
    const count = deps.todoCount();
    const previous = previousTodoCount();
    if (count > previous && previous > 0) {
      trigger(
        deps.lastAssistantElement(),
        "sidebar-progress",
        "New Task",
        "check",
      );
    }
    setPreviousTodoCount(count);
  });

  createEffect(() => {
    const count = deps.workingFileCount();
    const previous = previousFileCount();
    if (count > previous && previous > 0) {
      trigger(
        deps.lastAssistantElement(),
        "sidebar-context",
        "File Modified",
        "folder",
      );
    }
    setPreviousFileCount(count);
  });

  return { flyouts };
}
