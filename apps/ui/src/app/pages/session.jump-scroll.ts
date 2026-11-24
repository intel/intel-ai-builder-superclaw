import { perfNow } from "../lib/perf-log";
import {
  JUMP_SCROLL_MAX_DURATION_MS,
  JUMP_SCROLL_MIN_DURATION_MS,
  JUMP_SCROLL_PX_PER_MS,
} from "./session.view-tuning";

type JumpScrollAnimator = {
  cancel: () => void;
  // With retargetActive, a run already animating the same container is
  // retargeted rather than restarted, so the motion never reverses direction.
  animateTo: (
    container: HTMLElement,
    targetTop: number,
    onArrive?: () => void,
    retargetActive?: boolean,
  ) => void;
  scheduleMeasure: (measure: () => void) => void;
  /** True while a measurement or animation frame is pending. */
  isBusy: () => boolean;
};

export function createJumpScrollAnimator(): JumpScrollAnimator {
  let measureFrame: number | undefined;
  let frame: number | undefined;
  let activeContainer: HTMLElement | null = null;
  let activeTargetTop = 0;
  let pendingArrive: (() => void) | undefined;

  const cancel = () => {
    if (measureFrame !== undefined) {
      window.cancelAnimationFrame(measureFrame);
      measureFrame = undefined;
    }
    if (frame !== undefined) {
      window.cancelAnimationFrame(frame);
      frame = undefined;
    }
    activeContainer = null;
    pendingArrive = undefined;
  };

  const animateTo = (
    container: HTMLElement,
    targetTop: number,
    onArrive?: () => void,
    retargetActive = false,
  ) => {
    const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
    const to = Math.min(Math.max(targetTop, 0), maxTop);
    if (retargetActive && frame !== undefined && activeContainer === container) {
      activeTargetTop =
        activeTargetTop < container.scrollTop
          ? Math.min(activeTargetTop, to)
          : Math.max(activeTargetTop, to);
      pendingArrive = onArrive;
      return;
    }
    cancel();
    const from = container.scrollTop;
    const distance = to - from;
    if (Math.abs(distance) < 2) {
      container.scrollTop = to;
      onArrive?.();
      return;
    }
    const duration = Math.min(
      JUMP_SCROLL_MAX_DURATION_MS,
      Math.max(
        JUMP_SCROLL_MIN_DURATION_MS,
        Math.abs(distance) / JUMP_SCROLL_PX_PER_MS,
      ),
    );
    const startedAt = perfNow();
    let previousEased = 0;
    activeContainer = container;
    activeTargetTop = to;
    pendingArrive = onArrive;
    const step = () => {
      const progress = Math.min(1, (perfNow() - startedAt) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      const remainingProgress = 1 - previousEased;
      const frameProgress =
        remainingProgress > 0 ? (eased - previousEased) / remainingProgress : 1;
      container.scrollTop +=
        (activeTargetTop - container.scrollTop) * frameProgress;
      previousEased = eased;
      if (progress < 1) {
        frame = window.requestAnimationFrame(step);
        return;
      }
      frame = undefined;
      activeContainer = null;
      const arrive = pendingArrive;
      pendingArrive = undefined;
      arrive?.();
    };
    frame = window.requestAnimationFrame(step);
  };

  const scheduleMeasure = (measure: () => void) => {
    if (measureFrame !== undefined) {
      window.cancelAnimationFrame(measureFrame);
    }
    measureFrame = requestAnimationFrame(() => {
      measureFrame = undefined;
      measure();
    });
  };

  const isBusy = () => measureFrame !== undefined || frame !== undefined;

  return { cancel, animateTo, scheduleMeasure, isBusy };
}
