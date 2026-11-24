import { createRoot, createSignal } from "solid-js";
import { afterEach, describe, expect, test } from "vitest";

import { persistToLocalStorage } from "./persist-to-local-storage";

/** Lets Solid drain the effect queue. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const KEY = "openwork.testPref";
const disposers: Array<() => void> = [];

function mount(run: () => void) {
  createRoot((dispose) => {
    disposers.push(dispose);
    run();
  });
}

/** Swaps in a `window.localStorage` that fails, and restores it afterwards. */
function withBrokenStorage(get: () => Storage, run: () => Promise<void>) {
  const real = Object.getOwnPropertyDescriptor(window, "localStorage");
  Object.defineProperty(window, "localStorage", { configurable: true, get });
  return run().finally(() => {
    if (real) Object.defineProperty(window, "localStorage", real);
    else delete (window as { localStorage?: unknown }).localStorage;
  });
}

afterEach(() => {
  while (disposers.length) disposers.pop()?.();
  window.localStorage.clear();
});

describe("persistToLocalStorage", () => {
  test("writes the current value when the effect first runs", async () => {
    mount(() => persistToLocalStorage(KEY, () => "initial"));
    await flush();

    expect(window.localStorage.getItem(KEY)).toBe("initial");
  });

  test("rewrites the key when the signal changes", async () => {
    const [value, setValue] = createSignal("first");
    mount(() => persistToLocalStorage(KEY, value));
    await flush();
    expect(window.localStorage.getItem(KEY)).toBe("first");

    setValue("second");
    await flush();
    expect(window.localStorage.getItem(KEY)).toBe("second");
  });

  test("removes the key once the accessor yields null", async () => {
    const [value, setValue] = createSignal<string | null>("set");
    mount(() => persistToLocalStorage(KEY, value));
    await flush();
    expect(window.localStorage.getItem(KEY)).toBe("set");

    setValue(null);
    await flush();
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  test("stores the empty string rather than dropping the key", async () => {
    mount(() => persistToLocalStorage(KEY, () => ""));
    await flush();

    expect(window.localStorage.getItem(KEY)).toBe("");
  });

  test("survives a write that fails, as an exhausted quota does", async () => {
    const quotaExceeded = {
      setItem() {
        throw new Error("quota exceeded");
      },
      removeItem() {
        throw new Error("quota exceeded");
      },
    } as unknown as Storage;

    await withBrokenStorage(
      () => quotaExceeded,
      async () => {
        const [value, setValue] = createSignal<string | null>("x");
        expect(() =>
          mount(() => persistToLocalStorage(KEY, value)),
        ).not.toThrow();
        await flush();

        setValue(null);
        await flush();
      },
    );
  });

  test("survives an accessor that throws", async () => {
    expect(() =>
      mount(() =>
        persistToLocalStorage(KEY, () => {
          throw new Error("accessor blew up");
        }),
      ),
    ).not.toThrow();
    await flush();

    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  test("survives a webview that blocks storage, and leaves the effect unsubscribed", async () => {
    let reads = 0;
    const [value, setValue] = createSignal("a");
    const counted = () => {
      reads += 1;
      return value();
    };

    await withBrokenStorage(
      () => {
        throw new Error("access to storage is not allowed from this context");
      },
      async () => {
        expect(() =>
          mount(() => persistToLocalStorage(KEY, counted)),
        ).not.toThrow();
        await flush();
        // The store threw before the accessor was reached, so the effect never
        // subscribed and later changes cannot re-enter it.
        expect(reads).toBe(0);

        setValue("b");
        await flush();
        expect(reads).toBe(0);
      },
    );
  });
});
