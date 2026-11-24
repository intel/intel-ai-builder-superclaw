/** Cross-session search: metadata (title / worker / slug) plus message text when loaded. */

import {
  OpencodeRequestError,
  type SessionSearchHit,
  type SessionSearchInput,
} from "~/shared/platform/transport/opencode";
import type { MessageWithParts } from "../types";
import {
  collectSearchHits,
  messageIdFromInfo,
  messageTextForSearch,
} from "./session.message-search";
import {
  type CommandPaletteSessionOption,
} from "./session.command-palette";

export const MAX_GLOBAL_SEARCH_RESULTS = 80;
/** Title-only rows (e.g. other workers) kept when merging with message hits. */
export const MAX_GLOBAL_SEARCH_TITLE_SLOTS = 40;
export const GLOBAL_CONTENT_SCAN_CONCURRENCY = 4;
/** Pages of older messages to pull per task during content search. */
export const MAX_GLOBAL_CONTENT_SEARCH_MESSAGE_PAGES = 8;

export type GlobalSessionSearchMatchKind = "title" | "content";

export type GlobalSessionSearchResult = {
  workspaceId: string;
  sessionId: string;
  title: string;
  workspaceTitle: string;
  updatedAt: number;
  matchKind: GlobalSessionSearchMatchKind;
  messageId?: string;
  snippet?: string;
};

export type GlobalSessionSearchOutcome = {
  results: GlobalSessionSearchResult[];
  metadataTruncated: boolean;
  contentSearchIncomplete: boolean;
  contentSessionsScanned: number;
};

/** Server-side search over the active worker's runtime. Absent, or rejecting,
 *  on runtimes that predate `GET /session/search`. */
export type GlobalSessionSearchBackend = (input: SessionSearchInput) => Promise<SessionSearchHit[]>;

export const tokenizeGlobalSearchQuery = (query: string) =>
  [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])];

const matchesAllTerms = (text: string, terms: string[]) => {
  const normalized = text.toLowerCase();
  return terms.every((term) => normalized.includes(term));
};

export function snippetAroundMatch(
  haystack: string,
  query: string,
  maxLen = 140,
): string {
  const needle = query.trim().toLowerCase();
  if (!needle) return haystack.slice(0, maxLen).trim();
  const lower = haystack.toLowerCase();
  const index = lower.indexOf(needle);
  if (index === -1) {
    const compact = haystack.replace(/\s+/g, " ").trim();
    return compact.length > maxLen ? `${compact.slice(0, maxLen - 1)}…` : compact;
  }
  const radius = Math.max(20, Math.floor((maxLen - needle.length) / 2));
  const start = Math.max(0, index - radius);
  const end = Math.min(haystack.length, index + needle.length + radius);
  let snippet = haystack.slice(start, end).replace(/\s+/g, " ").trim();
  if (start > 0) snippet = `…${snippet}`;
  if (end < haystack.length) snippet = `${snippet}…`;
  if (snippet.length > maxLen) snippet = `${snippet.slice(0, maxLen - 1)}…`;
  return snippet;
}

export function metadataSearchResults(
  options: CommandPaletteSessionOption[],
  query: string,
): { results: GlobalSessionSearchResult[]; truncated: boolean } {
  const terms = tokenizeGlobalSearchQuery(query);
  if (!terms.length) return { results: [], truncated: false };

  const filtered = options.filter((item) => matchesAllTerms(item.searchText, terms));
  const truncated = filtered.length >= MAX_GLOBAL_SEARCH_RESULTS;
  const results = filtered.slice(0, MAX_GLOBAL_SEARCH_RESULTS).map((item) => ({
    workspaceId: item.workspaceId,
    sessionId: item.sessionId,
    title: item.title,
    workspaceTitle: item.workspaceTitle,
    updatedAt: item.updatedAt,
    matchKind: "title" as const,
  }));
  return { results, truncated };
}

export function firstContentMatchInSession(
  messages: MessageWithParts[],
  query: string,
): { messageId: string; snippet: string } | null {
  const terms = tokenizeGlobalSearchQuery(query);
  if (!terms.length) return null;

  for (const message of messages) {
    const messageId = messageIdFromInfo(message);
    if (!messageId) continue;
    const haystack = messageTextForSearch(message);
    if (!matchesAllTerms(haystack, terms)) continue;
    const hasEveryVisibleTerm = terms.every((term) =>
      collectSearchHits([message], term).hits.length > 0,
    );
    if (!hasEveryVisibleTerm) continue;
    return {
      messageId,
      snippet: snippetAroundMatch(haystack, terms[0]),
    };
  }
  return null;
}

export function mergeGlobalSessionSearchResults(
  metadata: GlobalSessionSearchResult[],
  content: GlobalSessionSearchResult[],
): GlobalSessionSearchResult[] {
  const bySession = new Map<string, GlobalSessionSearchResult>();
  for (const item of metadata) {
    bySession.set(item.sessionId, item);
  }
  for (const item of content) {
    const existing = bySession.get(item.sessionId);
    if (!existing || existing.matchKind === "title") {
      bySession.set(item.sessionId, item);
    }
  }

  const merged = [...bySession.values()];
  const titleOnly = merged
    .filter((item) => item.matchKind === "title")
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const contentHits = merged
    .filter((item) => item.matchKind === "content")
    .sort((a, b) => b.updatedAt - a.updatedAt);

  const out: GlobalSessionSearchResult[] = [];
  const seen = new Set<string>();

  for (const item of titleOnly) {
    if (out.length >= MAX_GLOBAL_SEARCH_TITLE_SLOTS) break;
    out.push(item);
    seen.add(item.sessionId);
  }
  for (const item of contentHits) {
    if (out.length >= MAX_GLOBAL_SEARCH_RESULTS) break;
    out.push(item);
    seen.add(item.sessionId);
  }
  for (const item of titleOnly) {
    if (out.length >= MAX_GLOBAL_SEARCH_RESULTS) break;
    if (seen.has(item.sessionId)) continue;
    out.push(item);
  }

  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function orderContentScanSessionOptions(
  options: CommandPaletteSessionOption[],
  metaResults: GlobalSessionSearchResult[],
  workspaceScope?: string,
): CommandPaletteSessionOption[] {
  const scope = workspaceScope?.trim();
  const scoped = options.filter(
    (option) => !scope || option.workspaceId === scope,
  );
  const bySessionId = new Map(
    scoped.map((option) => [option.sessionId, option] as const),
  );
  const metaIds = new Set(metaResults.map((item) => item.sessionId));

  const prioritized: CommandPaletteSessionOption[] = [];
  for (const meta of metaResults) {
    const option = bySessionId.get(meta.sessionId);
    if (option) prioritized.push(option);
  }

  const rest = scoped
    .filter((option) => !metaIds.has(option.sessionId))
    .sort((a, b) => a.updatedAt - b.updatedAt);

  return [...prioritized, ...rest];
}

async function findContentMatchForSession(input: {
  sessionId: string;
  query: string;
  getMessagesBySessionId: (sessionId: string) => MessageWithParts[];
  ensureSessionLoaded: (sessionId: string) => Promise<void> | void;
  loadEarlierMessages?: (sessionId: string) => Promise<void> | void;
  isMessageHistoryComplete?: (sessionId: string) => boolean;
  stopOnNoProgress?: boolean;
  signal?: AbortSignal;
}): Promise<{
  match: { messageId: string; snippet: string } | null;
  incomplete: boolean;
}> {
  await Promise.resolve(input.ensureSessionLoaded(input.sessionId));
  if (input.signal?.aborted) return { match: null, incomplete: false };

  for (let page = 0; page <= MAX_GLOBAL_CONTENT_SEARCH_MESSAGE_PAGES; page += 1) {
    if (input.signal?.aborted) return { match: null, incomplete: false };
    const messages = input.getMessagesBySessionId(input.sessionId);
    const hit = firstContentMatchInSession(messages, input.query);
    if (hit) return { match: hit, incomplete: false };

    const historyComplete = input.isMessageHistoryComplete?.(input.sessionId) ?? true;
    if (historyComplete) return { match: null, incomplete: false };
    if (page === MAX_GLOBAL_CONTENT_SEARCH_MESSAGE_PAGES || !input.loadEarlierMessages) {
      return { match: null, incomplete: true };
    }
    const previousMessageIds = input.stopOnNoProgress
      ? new Set(messages.map(messageIdFromInfo).filter((id): id is string => Boolean(id)))
      : undefined;
    await Promise.resolve(input.loadEarlierMessages(input.sessionId));
    if (previousMessageIds) {
      const currentMessages = input.getMessagesBySessionId(input.sessionId);
      const loadedMore = currentMessages.some((message) => {
        const id = messageIdFromInfo(message);
        return id !== null && !previousMessageIds.has(id);
      });
      const historyCompleteAfterLoad = input.isMessageHistoryComplete?.(input.sessionId) ?? true;
      if (!loadedMore && !historyCompleteAfterLoad) {
        return { match: null, incomplete: true };
      }
    }
  }

  return { match: null, incomplete: false };
}

/**
 * Pages older history until `messageId` is loaded, so a search hit older than the
 * newest page can be scrolled to. Stops when history is complete, when a page adds
 * nothing (the loader skips while another load for the session is running), or
 * after `maxPages`: each page re-fetches the whole loaded prefix, so an unbounded
 * walk to a very old hit costs quadratic transfer while the dialog waits.
 */
export async function loadMessagesUntilPresent(input: {
  sessionId: string;
  messageId: string;
  getMessagesBySessionId: (sessionId: string) => MessageWithParts[];
  loadEarlierMessages: (sessionId: string) => Promise<void> | void;
  isMessageHistoryComplete: (sessionId: string) => boolean;
  maxPages?: number;
}): Promise<boolean> {
  const loaded = () => input.getMessagesBySessionId(input.sessionId);
  const present = () => loaded().some((message) => messageIdFromInfo(message) === input.messageId);
  const maxPages = input.maxPages ?? MAX_GLOBAL_CONTENT_SEARCH_MESSAGE_PAGES;

  for (let page = 0; !present(); page += 1) {
    if (page >= maxPages || input.isMessageHistoryComplete(input.sessionId)) return false;
    const before = loaded().length;
    await Promise.resolve(input.loadEarlierMessages(input.sessionId));
    if (loaded().length <= before) return present();
  }
  return true;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  if (!items.length) return [];
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      if (signal?.aborted) return;
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}

async function scanContentSessions(input: {
  options: CommandPaletteSessionOption[];
  metaResults: GlobalSessionSearchResult[];
  query: string;
  workspaceScope?: string;
  getMessagesBySessionId: (sessionId: string) => MessageWithParts[];
  ensureSessionLoaded: (sessionId: string) => Promise<void> | void;
  loadEarlierMessages?: (sessionId: string) => Promise<void> | void;
  isMessageHistoryComplete?: (sessionId: string) => boolean;
  signal?: AbortSignal;
}): Promise<{ results: GlobalSessionSearchResult[]; scanned: number; incomplete: boolean }> {
  const toScan = orderContentScanSessionOptions(
    input.options,
    input.metaResults,
    input.workspaceScope,
  );
  const scanResults = await mapWithConcurrency(
    toScan,
    GLOBAL_CONTENT_SCAN_CONCURRENCY,
    async (option): Promise<{ result: GlobalSessionSearchResult | null; incomplete: boolean }> => {
      if (input.signal?.aborted) return { result: null, incomplete: false };
      const hit = await findContentMatchForSession({
        sessionId: option.sessionId,
        query: input.query,
        getMessagesBySessionId: input.getMessagesBySessionId,
        ensureSessionLoaded: input.ensureSessionLoaded,
        loadEarlierMessages: input.loadEarlierMessages,
        isMessageHistoryComplete: input.isMessageHistoryComplete,
        signal: input.signal,
      });
      return {
        result: hit.match
          ? {
              workspaceId: option.workspaceId,
              sessionId: option.sessionId,
              title: option.title,
              workspaceTitle: option.workspaceTitle,
              updatedAt: option.updatedAt,
              matchKind: "content",
              messageId: hit.match.messageId,
              snippet: hit.match.snippet,
            }
          : null,
        incomplete: hit.incomplete,
      };
    },
    input.signal,
  );
  return {
    results: scanResults.flatMap((item) => item.result ? [item.result] : []),
    scanned: toScan.length,
    incomplete: scanResults.some((item) => item.incomplete),
  };
}

/**
 * Older runtimes route `/session/search` to `/session/:sessionID`, which rejects
 * "search" as a session ID (400) or finds no such session (404).
 */
function isSearchEndpointMissing(error: unknown): boolean {
  return error instanceof OpencodeRequestError && [400, 404, 405, 501].includes(error.status);
}

function backendSearchResults(
  hits: SessionSearchHit[],
  options: CommandPaletteSessionOption[],
  workspaceId: string,
  query: string,
): GlobalSessionSearchResult[] {
  const bySessionId = new Map(
    options.map((option) => [option.sessionId, option] as const),
  );
  const workspaceTitle =
    options.find((option) => option.workspaceId === workspaceId)
      ?.workspaceTitle ?? "";

  const matched = hits.map((hit) => ({
    workspaceId,
    sessionId: hit.id,
    title: hit.title,
    workspaceTitle: bySessionId.get(hit.id)?.workspaceTitle ?? workspaceTitle,
    updatedAt: hit.time.updated,
    matchKind: (hit.match.message ? "content" : "title") as GlobalSessionSearchMatchKind,
    // A match inside a subagent session has no message to scroll to in this chat.
    messageId: hit.match.message?.sessionID === hit.id ? hit.match.message.id : undefined,
    snippet: hit.match.message?.snippet,
  }));

  // The endpoint only covers the active worker's runtime, so other workers keep
  // the title-only matches they had before.
  const seen = new Set(matched.map((item) => item.sessionId));
  const elsewhere = metadataSearchResults(
    options.filter((option) => option.workspaceId !== workspaceId),
    query,
  ).results.filter((item) => !seen.has(item.sessionId));

  return [...matched, ...elsewhere].sort((a, b) => b.updatedAt - a.updatedAt);
}

function combineBackendSearchHits(
  hitsByTerm: SessionSearchHit[][],
): SessionSearchHit[] {
  if (!hitsByTerm.length) return [];

  const [first, ...rest] = hitsByTerm;
  return first.flatMap((hit) => {
    const message = hit.match.message;
    const messageHits = message
      ? hitsByTerm.map((hits) =>
          hits.find(
            (candidate) =>
              candidate.id === hit.id &&
              candidate.match.message?.id === message.id &&
              candidate.match.message.sessionID === message.sessionID,
          ),
        )
      : [];
    const contentMatchesAllTerms =
      Boolean(message) && messageHits.length === hitsByTerm.length && messageHits.every(Boolean);
    if (contentMatchesAllTerms && message) {
      const snippets = messageHits
        .map((candidate) => candidate?.match.message?.snippet)
        .filter((snippet): snippet is string => Boolean(snippet));
      return [{
        ...hit,
        match: {
          ...hit.match,
          message: { ...message, snippet: [...new Set(snippets)].join(" … ") },
        },
      }];
    }

    const titleMatchesAllTerms = hit.match.title && rest.every((hits) =>
      hits.some((candidate) => candidate.id === hit.id && candidate.match.title),
    );
    if (!titleMatchesAllTerms) return [];
    return [{
      ...hit,
      match: { title: hit.match.title },
    }];
  });
}

function backendContentCandidates(hitsByTerm: SessionSearchHit[][]): SessionSearchHit[] {
  if (!hitsByTerm.length) return [];

  const [first, ...rest] = hitsByTerm;
  return first.flatMap((hit) => {
    if (!rest.every((hits) => hits.some((candidate) => candidate.id === hit.id))) return [];
    return hitsByTerm
      .flatMap((hits) => hits.filter((candidate) => candidate.id === hit.id && candidate.match.message))
      .slice(0, 1);
  });
}

async function validateBackendContentCandidates(input: {
  hitsByTerm: SessionSearchHit[][];
  query: string;
  getMessagesBySessionId: (sessionId: string) => MessageWithParts[];
  ensureSessionLoaded: (sessionId: string) => Promise<void> | void;
  loadEarlierMessages?: (sessionId: string) => Promise<void> | void;
  isMessageHistoryComplete?: (sessionId: string) => boolean;
  signal?: AbortSignal;
}): Promise<{ hits: SessionSearchHit[]; incomplete: boolean }> {
  const hits = combineBackendSearchHits(input.hitsByTerm);
  const completeContentSessionIds = new Set(
    hits.filter((hit) => hit.match.message).map((hit) => hit.id),
  );
  const candidates = backendContentCandidates(input.hitsByTerm).filter(
    (hit) => !completeContentSessionIds.has(hit.id),
  );
  const validated = await mapWithConcurrency(
    candidates,
    GLOBAL_CONTENT_SCAN_CONCURRENCY,
    async (candidate): Promise<{ hit: SessionSearchHit | null; incomplete: boolean }> => {
      let incomplete = false;
      const representativeMessages = input.hitsByTerm
        .flat()
        .flatMap((hit) =>
          hit.id === candidate.id && hit.match.message ? [hit.match.message] : [],
        );
      const candidateSessionIds = [
        ...new Set([candidate.id, ...representativeMessages.map((message) => message.sessionID)]),
      ];

      for (const sessionId of candidateSessionIds) {
        const contentScan = await findContentMatchForSession({
          sessionId,
          query: input.query,
          getMessagesBySessionId: input.getMessagesBySessionId,
          ensureSessionLoaded: input.ensureSessionLoaded,
          loadEarlierMessages: input.loadEarlierMessages,
          isMessageHistoryComplete: input.isMessageHistoryComplete,
          stopOnNoProgress: true,
          signal: input.signal,
        });
        incomplete ||= contentScan.incomplete;
        if (!contentScan.match) continue;

        const representativeMessage = representativeMessages.find(
          (message) => message.sessionID === sessionId,
        );
        return {
          hit: {
            ...candidate,
            match: {
              title: false,
              message: {
                id: contentScan.match.messageId,
                sessionID: sessionId,
                snippet: contentScan.match.snippet,
                time: representativeMessage?.time ?? candidate.time.updated,
              },
            },
          },
          incomplete: false,
        };
      }
      return { hit: null, incomplete };
    },
    input.signal,
  );
  return {
    hits: validated.flatMap((item) => item.hit ? [item.hit] : []),
    incomplete: validated.some((item) => item.incomplete),
  };
}

export async function runGlobalSessionSearch(input: {
  options: CommandPaletteSessionOption[];
  query: string;
  /** Preferred path. Falls back to the client-side scan when absent or failing. */
  searchBackend?: GlobalSessionSearchBackend;
  getMessagesBySessionId: (sessionId: string) => MessageWithParts[];
  ensureSessionLoaded: (sessionId: string) => Promise<void> | void;
  loadEarlierMessages?: (sessionId: string) => Promise<void> | void;
  isMessageHistoryComplete?: (sessionId: string) => boolean;
  /** Message fetch uses the active OpenCode client; limit content scan to this worker. */
  contentScanWorkspaceId?: string;
  signal?: AbortSignal;
}): Promise<GlobalSessionSearchOutcome> {
  const query = input.query.trim();
  const terms = tokenizeGlobalSearchQuery(query);
  if (!terms.length) {
    return {
      results: [],
      metadataTruncated: false,
      contentSearchIncomplete: false,
      contentSessionsScanned: 0,
    };
  }

  const workspaceScope = input.contentScanWorkspaceId?.trim();
  const searchBackend = input.searchBackend;

  if (searchBackend && workspaceScope) {
    try {
      const hitsByTerm = await Promise.all(
        terms.map((term) =>
          searchBackend({
            query: term,
            roots: true,
            limit: MAX_GLOBAL_SEARCH_RESULTS,
            signal: input.signal,
          }),
        ),
      );
      if (terms.length > 1 && hitsByTerm.some((hits) => hits.length >= MAX_GLOBAL_SEARCH_RESULTS)) {
        const { results: metaResults, truncated: metadataTruncated } =
          metadataSearchResults(input.options, query);
        const content = await scanContentSessions({
          options: input.options,
          metaResults,
          query,
          workspaceScope,
          getMessagesBySessionId: input.getMessagesBySessionId,
          ensureSessionLoaded: input.ensureSessionLoaded,
          loadEarlierMessages: input.loadEarlierMessages,
          isMessageHistoryComplete: input.isMessageHistoryComplete,
          signal: input.signal,
        });
        const hits = combineBackendSearchHits(hitsByTerm);
        const validatedContent = await validateBackendContentCandidates({
          hitsByTerm,
          query,
          getMessagesBySessionId: input.getMessagesBySessionId,
          ensureSessionLoaded: input.ensureSessionLoaded,
          loadEarlierMessages: input.loadEarlierMessages,
          isMessageHistoryComplete: input.isMessageHistoryComplete,
          signal: input.signal,
        });
        const backendResults = backendSearchResults(
          [...hits, ...validatedContent.hits],
          input.options,
          workspaceScope,
          query,
        );
        return {
          results: mergeGlobalSessionSearchResults(
            [...metaResults, ...backendResults],
            content.results,
          ),
          metadataTruncated,
          contentSearchIncomplete: content.incomplete || validatedContent.incomplete,
          contentSessionsScanned: content.scanned,
        };
      }

      const hits = combineBackendSearchHits(hitsByTerm);
      const validatedContent = await validateBackendContentCandidates({
        hitsByTerm,
        query,
        getMessagesBySessionId: input.getMessagesBySessionId,
        ensureSessionLoaded: input.ensureSessionLoaded,
        loadEarlierMessages: input.loadEarlierMessages,
        isMessageHistoryComplete: input.isMessageHistoryComplete,
        signal: input.signal,
      });
      const hitsBySessionId = new Map(hits.map((hit) => [hit.id, hit] as const));
      for (const hit of validatedContent.hits) {
        hitsBySessionId.set(hit.id, hit);
      }
      return {
        results: backendSearchResults(
          [...hitsBySessionId.values()],
          input.options,
          workspaceScope,
          query,
        ),
        metadataTruncated: false,
        contentSearchIncomplete: validatedContent.incomplete,
        contentSessionsScanned: hits.length,
      };
    } catch (error) {
      if (input.signal?.aborted) {
        return {
          results: [],
          metadataTruncated: false,
          contentSearchIncomplete: false,
          contentSessionsScanned: 0,
        };
      }
      // Only a runtime without /session/search falls back to the scan; any other
      // failure surfaces as "search failed" rather than starting a slow scan.
      if (!isSearchEndpointMissing(error)) throw error;
    }
  }

  const { results: metaResults, truncated: metadataTruncated } =
    metadataSearchResults(input.options, query);

  const content = await scanContentSessions({
    options: input.options,
    metaResults,
    query,
    workspaceScope,
    getMessagesBySessionId: input.getMessagesBySessionId,
    ensureSessionLoaded: input.ensureSessionLoaded,
    loadEarlierMessages: input.loadEarlierMessages,
    isMessageHistoryComplete: input.isMessageHistoryComplete,
    signal: input.signal,
  });

  return {
    results: mergeGlobalSessionSearchResults(metaResults, content.results),
    metadataTruncated,
    contentSearchIncomplete: content.incomplete,
    contentSessionsScanned: content.scanned,
  };
}
