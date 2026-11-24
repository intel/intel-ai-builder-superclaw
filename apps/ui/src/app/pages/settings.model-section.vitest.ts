/**
 * The pencil on a chat model picker row opens Settings → Model with the Local
 * or Cloud heading at the top. These pin the jump: instant, only once the page
 * is on screen, held while cards above grow, and given up when the user scrolls.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { pinSectionToTop } from "./settings.model-section";

let resizeCallbacks: Array<() => void> = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  resizeCallbacks = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(cb: () => void) {
        resizeCallbacks.push(cb);
      }
      observe() {}
      disconnect() {
        resizeCallbacks = [];
      }
    },
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

function section(visible: () => boolean) {
  const parent = document.createElement("div");
  const target = document.createElement("div");
  parent.append(target);
  document.body.append(parent);
  const scrollIntoView = vi.fn();
  target.scrollIntoView = scrollIntoView;
  target.getClientRects = () => (visible() ? [{}] : []) as unknown as DOMRectList;
  return { target, scrollIntoView };
}

describe("pinSectionToTop", () => {
  test("jumps at once, with no smooth scroll", () => {
    const { target, scrollIntoView } = section(() => true);
    pinSectionToTop(target);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start", behavior: "instant" });
  });

  test("waits until the Settings page is on screen", () => {
    let visible = false;
    const { target, scrollIntoView } = section(() => visible);
    pinSectionToTop(target);
    vi.advanceTimersByTime(100);
    expect(scrollIntoView).not.toHaveBeenCalled();

    visible = true;
    vi.advanceTimersByTime(16);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  test("keeps the heading at the top while cards above it grow, then lets go", () => {
    const { target, scrollIntoView } = section(() => true);
    pinSectionToTop(target);
    resizeCallbacks.forEach((cb) => cb());
    expect(scrollIntoView).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(1500);
    expect(resizeCallbacks).toHaveLength(0);
  });

  test("stops as soon as the user scrolls", () => {
    const { target, scrollIntoView } = section(() => true);
    pinSectionToTop(target);
    window.dispatchEvent(new Event("wheel"));
    resizeCallbacks.forEach((cb) => cb());
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });
});
