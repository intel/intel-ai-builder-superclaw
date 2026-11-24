export const SESSION_PIN_STORAGE_KEY = "superclaw.session-pins.v1";

export function getSessionPinStorage(): Storage | undefined {
  if (typeof window === "undefined") return undefined;

  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function getPinnedSessionIds(
  storage: Storage | null | undefined = getSessionPinStorage(),
): Set<string> {
  const target = storage ?? null;
  if (!target) return new Set();

  try {
    const raw = target.getItem(SESSION_PIN_STORAGE_KEY);
    if (!raw) return new Set();

    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return new Set();

    return new Set(
      Object.entries(parsed)
        .filter(([, enabled]) => enabled === true)
        .map(([id]) => id.trim())
        .filter((id) => id.length > 0),
    );
  } catch {
    return new Set();
  }
}

export function writePinnedSessionIds(
  storage: Storage | null | undefined,
  pinnedIds: Iterable<string>,
) {
  const target = storage ?? null;
  if (!target) return;

  const normalized = new Set<string>();
  for (const id of pinnedIds) {
    const nextId = id.trim();
    if (nextId) normalized.add(nextId);
  }

  const value: Record<string, true> = {};
  for (const id of [...normalized].sort()) {
    value[id] = true;
  }

  try {
    target.setItem(SESSION_PIN_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Storage can be unavailable or quota-limited in an embedded webview.
  }
}

export function togglePinnedSessionId(
  storage: Storage | null | undefined,
  sessionId: string,
): boolean {
  const trimmed = sessionId.trim();
  if (!trimmed) return false;

  const pinned = getPinnedSessionIds(storage);
  const next = new Set(pinned);
  const isPinned = next.has(trimmed);

  if (isPinned) next.delete(trimmed);
  else next.add(trimmed);

  writePinnedSessionIds(storage, next);
  return !isPinned;
}

export function splitPinnedSessions<T extends {
  id: string;
  time?: {
    updated?: number | null;
    created?: number | null;
  } | null;
}>(
  sessions: T[],
  pinnedIds: Set<string>,
): { pinned: T[]; unpinned: T[] } {
  const sortByActivity = (items: T[]) =>
    [...items].sort((a, b) => {
      const aUpdated = a.time?.updated ?? a.time?.created ?? 0;
      const bUpdated = b.time?.updated ?? b.time?.created ?? 0;
      const delta = bUpdated - aUpdated;
      if (delta !== 0) return delta;
      return a.id.localeCompare(b.id);
    });

  const pinned: T[] = [];
  const unpinned: T[] = [];

  for (const session of sortByActivity(sessions)) {
    if (pinnedIds.has(session.id)) pinned.push(session);
    else unpinned.push(session);
  }

  return { pinned, unpinned };
}
