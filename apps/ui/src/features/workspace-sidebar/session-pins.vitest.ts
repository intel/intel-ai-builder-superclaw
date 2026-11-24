// @vitest-environment happy-dom
import { describe, expect, test } from "vitest"
import type { SidebarSessionItem } from "~/shared/types/session"
import {
  SESSION_PIN_STORAGE_KEY,
  getPinnedSessionIds,
  getSessionPinStorage,
  splitPinnedSessions,
  togglePinnedSessionId,
} from "./session-pins";

const session = (id: string, updated: number): SidebarSessionItem => ({
  id,
  title: id,
  time: { updated, created: updated },
});

describe("session pin helpers", () => {
  test("treats unavailable browser storage as empty", () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get: () => {
        throw new Error("storage unavailable");
      },
    });

    try {
      expect(getSessionPinStorage()).toBeUndefined();
      expect(getPinnedSessionIds()).toEqual(new Set());
    } finally {
      if (descriptor) Object.defineProperty(window, "localStorage", descriptor);
    }
  });

  test("persist pin state by session id", () => {
    const storage = createMemoryStorage();

    expect(getPinnedSessionIds(storage).size).toBe(0);
    expect(togglePinnedSessionId(storage, "session-1")).toBe(true);
    expect(JSON.parse(storage.getItem(SESSION_PIN_STORAGE_KEY) ?? "{}")).toEqual({
      "session-1": true,
    });
    expect(getPinnedSessionIds(storage).has("session-1")).toBe(true);

    expect(togglePinnedSessionId(storage, "session-1")).toBe(false);
    expect(JSON.parse(storage.getItem(SESSION_PIN_STORAGE_KEY) ?? "{}")).toEqual({});
    expect(getPinnedSessionIds(storage).has("session-1")).toBe(false);
  });

  test("separate pinned sessions from unpinned ones without changing recency order inside each group", () => {
    const sessions: SidebarSessionItem[] = [
      session("oldest", 100),
      session("pinned-older", 300),
      session("latest", 500),
      session("pinned-newer", 700),
    ];

    const result = splitPinnedSessions(sessions, new Set(["pinned-newer", "pinned-older"]));

    expect(result.pinned.map((item: SidebarSessionItem) => item.id)).toEqual(["pinned-newer", "pinned-older"]);
    expect(result.unpinned.map((item: SidebarSessionItem) => item.id)).toEqual(["latest", "oldest"]);
  });
});

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => {
      values.set(key, String(value));
    },
  } as Storage;
}