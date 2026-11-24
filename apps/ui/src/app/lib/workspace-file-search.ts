import fuzzysort from "fuzzysort";

import type { OpenworkInboxList } from "~/shared/platform/transport/openwork-server.types";

// opencode's `/find/file` index never takes in files created after startup,
// so `@` search also matches against the server's live workspace listing —
// the same one the Files panel shows.

const LISTED_FILES_TTL_MS = 5_000;
/** How long the first search of a workspace waits for its listing before answering without it. */
const LISTED_FILES_FIRST_WAIT_MS = 1_500;
/** How long a search with a stale listing waits for the refresh. The open picker only re-searches on the next keystroke. */
const LISTED_FILES_STALE_WAIT_MS = 300;
const LISTED_MATCH_LIMIT = 50;

export const listedFilePaths = (list: OpenworkInboxList): string[] =>
  (list.items ?? [])
    .filter((item) => item.kind !== "dir")
    .map((item) => item.path ?? "")
    .filter(Boolean);

const preparedTargets = new WeakMap<string[], ReturnType<typeof fuzzysort.prepare>[]>();

/** Prepares each listing once, so a keystroke on a large workspace only scores. */
export const matchListedFiles = (paths: string[], query: string, limit = LISTED_MATCH_LIMIT): string[] => {
  let targets = preparedTargets.get(paths);
  if (!targets) {
    targets = paths.map((path) => fuzzysort.prepare(path));
    preparedTargets.set(paths, targets);
  }
  return fuzzysort.go(query, targets, { limit }).map((result) => result.target);
};

const pathKey = (path: string) => path.replace(/\\/g, "/");

const presenceKey = (path: string) => pathKey(path.trim()).replace(/^\.\//, "").replace(/\/+$/, "").toLowerCase();

/** Every path the listing proves exists: its files, its empty folders, and each folder above them. */
export const listedPresence = (list: OpenworkInboxList): Set<string> => {
  const known = new Set<string>();
  for (const item of list.items ?? []) {
    let key = presenceKey(item.path ?? "");
    while (key && !known.has(key)) {
      known.add(key);
      key = key.slice(0, Math.max(0, key.lastIndexOf("/")));
    }
  }
  return known;
};

/**
 * Paths the server listing never includes, so their absence from it proves
 * nothing. The server strips a leading `workspace/` from every listed path, so
 * a real top-level `workspace` folder is listed without it.
 */
const outsideListing = (key: string) =>
  /^(?:[a-z]:\/|\/|~|workspace(?:\/|$))/.test(key) ||
  key.split("/").some((part) => part.startsWith(".") || part === "opencode.jsonc");

/** opencode's results minus files the listing shows were deleted, then listed matches it missed. */
export const mergeFileSearchResults = (
  found: string[],
  listed: string[],
  isGone: (path: string) => boolean = () => false,
): string[] => {
  const present = found.filter((path) => !isGone(path));
  const seen = new Set(present.map(pathKey));
  const extra = listed.filter((path) => {
    const key = pathKey(path);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return [...present, ...extra];
};

type ListingClient = { listProjects: (workspaceId: string) => Promise<OpenworkInboxList> };

type ListedFilesEntry = {
  workspaceId: string;
  /** The server client that produced the listing; workspace IDs are path hashes, so two hosts can share one. */
  source: unknown;
  paths: string[] | null;
  known: Set<string> | null;
  loadedAt: number;
  /** The listing request in flight, shared by `@` search and the Files panel so one walk serves both. */
  pending: Promise<OpenworkInboxList> | null;
  /** Bumped when a write is observed; a listing requested before the bump cannot prove a deletion. */
  generation: number;
};

const within = async (pending: Promise<string[]>, ms: number, fallback: string[]): Promise<string[]> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<string[]>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([pending, timeout]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Caches one workspace's file listing. A stale listing is refreshed, and is
 * served if the refresh takes longer than a short wait, so typing never waits
 * on a full workspace walk.
 */
export const createListedFilesCache = (options: {
  now?: () => number;
  ttlMs?: number;
  firstWaitMs?: number;
  staleWaitMs?: number;
} = {}) => {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? LISTED_FILES_TTL_MS;
  const firstWaitMs = options.firstWaitMs ?? LISTED_FILES_FIRST_WAIT_MS;
  const staleWaitMs = options.staleWaitMs ?? LISTED_FILES_STALE_WAIT_MS;
  let entry: ListedFilesEntry | null = null;

  const entryFor = (workspaceId: string, source: unknown): ListedFilesEntry => {
    if (entry === null || entry.workspaceId !== workspaceId || entry.source !== source) {
      entry = { workspaceId, source, paths: null, known: null, loadedAt: 0, pending: null, generation: 0 };
    }
    return entry;
  };

  /** Rejects when the load fails, after marking the listing unable to prove deletions. */
  const fetchList = (current: ListedFilesEntry, load: () => Promise<OpenworkInboxList>) => {
    current.pending ??= (async () => {
      const generation = current.generation;
      try {
        const list = await load();
        current.paths = listedFilePaths(list);
        if (current.generation === generation) {
          current.known = listedPresence(list);
          current.loadedAt = now();
        }
        return list;
      } catch (error) {
        current.known = null;
        throw error;
      } finally {
        current.pending = null;
      }
    })();
    return current.pending;
  };

  const refresh = async (current: ListedFilesEntry, load: () => Promise<OpenworkInboxList>): Promise<string[]> => {
    try {
      await fetchList(current, load);
    } catch {
      // Keep serving the last listing; `fetchList` already stopped it proving deletions.
    }
    return current.paths ?? [];
  };

  const get = async (
    workspaceId: string,
    load: () => Promise<OpenworkInboxList>,
    source?: unknown,
  ): Promise<string[]> => {
    const current = entryFor(workspaceId, source);
    if (current.paths && now() - current.loadedAt < ttlMs) return current.paths;
    const waitMs = current.paths ? staleWaitMs : firstWaitMs;
    return within(refresh(current, load), waitMs, current.paths ?? []);
  };

  /** Listed files matching `query`; empty without a server connection. Never rejects. */
  const search = async (
    server: ListingClient | null | undefined,
    workspaceId: string | null | undefined,
    query: string,
  ): Promise<string[]> => {
    const id = workspaceId?.trim();
    if (!server || !id) {
      entry = null;
      return [];
    }
    return matchListedFiles(await get(id, () => server.listProjects(id), server), query);
  };

  /**
   * The full listing for the Files panel, fetched through the cache so the
   * panel's poll keeps `@` search fresh and the two never walk the workspace
   * twice at once. Rejects like `server.listProjects`.
   */
  const listProjects = (server: ListingClient, workspaceId: string): Promise<OpenworkInboxList> => {
    const id = workspaceId.trim();
    return fetchList(entryFor(id, server), () => server.listProjects(id));
  };

  /**
   * True when the last searched workspace's listing shows `path` no longer
   * exists. False whenever it cannot tell: no listing yet, a write observed
   * since it loaded, a failed refresh, or a path the listing never covers.
   */
  const isGone = (path: string): boolean => {
    const known = entry?.known;
    if (!known) return false;
    const key = presenceKey(path);
    return Boolean(key) && !outsideListing(key) && !known.has(key);
  };

  /** Files changed since the listing loaded: stop trusting it for deletions, and refresh on the next search. */
  const invalidate = () => {
    if (!entry) return;
    entry.generation += 1;
    entry.known = null;
    entry.loadedAt = 0;
  };

  return { get, search, listProjects, isGone, invalidate };
};

/** The app's one `@` search cache. */
export const listedWorkspaceFiles = createListedFilesCache();
