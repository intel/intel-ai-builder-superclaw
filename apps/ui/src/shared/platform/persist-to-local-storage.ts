import { createEffect } from "solid-js";

/**
 * Mirrors a reactive value into a raw `localStorage` key: writes on every
 * change, and removes the key when the accessor yields `null`.
 *
 * The store is read before the accessor and inside the `try`, so a webview that
 * blocks storage throws before the signal is ever touched and leaves this
 * effect unsubscribed instead of retrying on every later change.
 *
 * Deliberately not `persisted()` from `./persist`, which routes through the
 * platform store and JSON-encodes its payload. These keys are read back as bare
 * strings, so switching would relocate and reformat preferences users already
 * have on disk.
 */
export function persistToLocalStorage(
  key: string,
  value: () => string | null,
): void {
  createEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const storage = window.localStorage;
      const next = value();
      if (next === null) storage.removeItem(key);
      else storage.setItem(key, next);
    } catch {
      // ignore
    }
  });
}

/** Drops a key outright, for a setting whose UI has been removed. */
export function forgetPreference(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // ignore
  }
}
